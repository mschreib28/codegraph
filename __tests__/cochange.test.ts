/**
 * Co-Change Graph Tests
 *
 * Verifies the file-level co-change miner:
 *   - parses git log output correctly
 *   - filters out merge / large refactor commits via MAX_FILES_PER_COMMIT
 *   - drops files outside the indexed set
 *   - persists per-file commit_count and per-pair count
 *   - computes Jaccard correctly at query time
 *   - updates incrementally on subsequent runs
 *   - detects unreachable previous-head and re-mines from scratch
 *   - migration v4 creates the table + column
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  mineCoChanges,
  MAX_FILES_PER_COMMIT,
  MIN_COCHANGE_COUNT,
  LAST_MINED_HEAD_KEY,
  getGitHead,
} from '../src/cochange';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { runMigrations, getCurrentVersion } from '../src/db/migrations';
import CodeGraph from '../src/index';
import { loadConfig } from '../src/config';

function tempGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // Pin the initial branch name so subsequent operations are deterministic
  // across systems with different `init.defaultBranch` settings.
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commit(dir: string, message: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
}

function rm(dir: string, ...rels: string[]) {
  for (const rel of rels) {
    fs.unlinkSync(path.join(dir, rel));
  }
}

describe('mineCoChanges (unit)', () => {
  let dir: string;

  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty result for non-git directories', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-nongit-'));
    const result = mineCoChanges(dir, new Set(['a.ts']), null);
    expect(result.currentHead).toBeNull();
    expect(result.pairs.size).toBe(0);
    expect(result.fileCommits.size).toBe(0);
  });

  it('counts pairs and per-file commits across multiple commits', () => {
    dir = tempGitRepo('cochange-basic-');
    commit(dir, 'c1', { 'a.ts': '1', 'b.ts': '1' });
    commit(dir, 'c2', { 'a.ts': '2', 'b.ts': '2' });
    commit(dir, 'c3', { 'a.ts': '3' });

    const result = mineCoChanges(dir, new Set(['a.ts', 'b.ts']), null);
    expect(result.currentHead).not.toBeNull();
    expect(result.fileCommits.get('a.ts')).toBe(3);
    expect(result.fileCommits.get('b.ts')).toBe(2);
    expect(result.pairs.get('a.ts\0b.ts')).toBe(2);
  });

  it('drops files outside the indexed set', () => {
    dir = tempGitRepo('cochange-filter-');
    commit(dir, 'c1', { 'a.ts': '1', 'README.md': 'doc', 'b.ts': '1' });
    commit(dir, 'c2', { 'a.ts': '2', 'b.ts': '2' });

    // README.md is not indexed; the pair (a, b) still counts but no
    // (a, README) or (b, README) pair is created.
    const result = mineCoChanges(dir, new Set(['a.ts', 'b.ts']), null);
    expect(result.fileCommits.has('README.md')).toBe(false);
    expect(result.pairs.get('a.ts\0b.ts')).toBe(2);
    expect([...result.pairs.keys()].length).toBe(1);
  });

  it('skips commits that touch more than MAX_FILES_PER_COMMIT indexed files', () => {
    dir = tempGitRepo('cochange-mass-');
    // First commit: massive refactor across many files (would otherwise
    // produce O(N²) spurious pairs).
    const massFiles: Record<string, string> = {};
    const indexed = new Set<string>();
    for (let i = 0; i < MAX_FILES_PER_COMMIT + 5; i++) {
      const f = `src/m${i}.ts`;
      massFiles[f] = String(i);
      indexed.add(f);
    }
    commit(dir, 'mass', massFiles);
    // Second commit: small, two files — should produce one pair.
    commit(dir, 'small', { 'src/m0.ts': 'A', 'src/m1.ts': 'B' });

    const result = mineCoChanges(dir, indexed, null);
    expect(result.pairs.get('src/m0.ts\0src/m1.ts')).toBe(1);
    // The mass-refactor commit contributes nothing.
    expect([...result.pairs.values()].every((c) => c <= 1)).toBe(true);
  });

  it('mines incrementally — only commits in <since>..HEAD', () => {
    dir = tempGitRepo('cochange-incr-');
    commit(dir, 'c1', { 'a.ts': '1', 'b.ts': '1' });
    const anchor = getGitHead(dir)!;
    commit(dir, 'c2', { 'a.ts': '2', 'b.ts': '2' });
    commit(dir, 'c3', { 'a.ts': '3', 'b.ts': '3' });

    const result = mineCoChanges(dir, new Set(['a.ts', 'b.ts']), anchor);
    // c2 + c3 only — anchor commit is excluded by the .. range
    expect(result.fileCommits.get('a.ts')).toBe(2);
    expect(result.pairs.get('a.ts\0b.ts')).toBe(2);
  });

  it('returns no-op delta when current HEAD == sinceSha', () => {
    dir = tempGitRepo('cochange-noop-');
    commit(dir, 'c1', { 'a.ts': '1' });
    const head = getGitHead(dir)!;

    const result = mineCoChanges(dir, new Set(['a.ts']), head);
    expect(result.currentHead).toBe(head);
    expect(result.pairs.size).toBe(0);
    expect(result.fileCommits.size).toBe(0);
    expect(result.needsFullRescan).toBe(false);
  });

  it('signals needsFullRescan when sinceSha is unreachable', () => {
    dir = tempGitRepo('cochange-orphan-');
    commit(dir, 'c1', { 'a.ts': '1' });
    const result = mineCoChanges(
      dir,
      new Set(['a.ts']),
      '0000000000000000000000000000000000000000'
    );
    expect(result.needsFullRescan).toBe(true);
  });

  it('correctly handles paths with spaces and unicode', () => {
    dir = tempGitRepo('cochange-special-');
    commit(dir, 'c1', { 'with space.ts': '1', 'café.ts': '1' });
    commit(dir, 'c2', { 'with space.ts': '2', 'café.ts': '2' });

    const result = mineCoChanges(
      dir,
      new Set(['with space.ts', 'café.ts']),
      null
    );
    // Either ordering (canonical sort) is fine
    const total = [...result.pairs.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
  });

  it('does not misidentify a file literally named "--" as a sentinel', () => {
    // Earlier the parser used `--` as the per-commit header; a real file
    // by that name would corrupt block boundaries. Sentinel is now NUL-
    // bracketed so it cannot collide with any POSIX-legal filename.
    dir = tempGitRepo('cochange-dashdash-');
    commit(dir, 'c1', { '--': 'literal dash file', 'b.ts': '1' });
    commit(dir, 'c2', { '--': 'changed', 'b.ts': '2' });

    const result = mineCoChanges(dir, new Set(['--', 'b.ts']), null);
    // We expect both files to be counted in both commits and one pair.
    expect(result.fileCommits.get('--')).toBe(2);
    expect(result.fileCommits.get('b.ts')).toBe(2);
    expect(result.pairs.get('--\0b.ts')).toBe(2);
  });
});

describe('QueryBuilder co-change CRUD', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-db-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    // Insert a few file rows so commit_count updates and FK semantics work.
    const upsert = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
      VALUES (?, '', 'typescript', 0, 0, 0)
    `);
    upsert.run('a.ts');
    upsert.run('b.ts');
    upsert.run('c.ts');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('canonicalises pair ordering on upsert', () => {
    q.applyCoChangeDeltas([['b.ts', 'a.ts', 3]], []);
    const row = db.getDb().prepare('SELECT * FROM co_changes').get() as any;
    expect(row.file_a).toBe('a.ts');
    expect(row.file_b).toBe('b.ts');
    expect(row.count).toBe(3);
  });

  it('accumulates counts on repeated apply', () => {
    q.applyCoChangeDeltas([['a.ts', 'b.ts', 2]], []);
    q.applyCoChangeDeltas([['a.ts', 'b.ts', 3]], []);
    const row = db.getDb().prepare('SELECT count FROM co_changes').get() as any;
    expect(row.count).toBe(5);
  });

  it('increments per-file commit_count', () => {
    q.applyCoChangeDeltas([], [['a.ts', 4]]);
    q.applyCoChangeDeltas([], [['a.ts', 1]]);
    const row = db.getDb().prepare('SELECT commit_count FROM files WHERE path = ?').get('a.ts') as any;
    expect(row.commit_count).toBe(5);
  });

  it('skips no-op self-pairs', () => {
    q.applyCoChangeDeltas([['a.ts', 'a.ts', 5]], []);
    const cnt = db.getDb().prepare('SELECT COUNT(*) AS n FROM co_changes').get() as any;
    expect(cnt.n).toBe(0);
  });

  it('clearCoChanges wipes pairs and zeroes per-file counts', () => {
    q.applyCoChangeDeltas([['a.ts', 'b.ts', 3]], [['a.ts', 5]]);
    q.clearCoChanges();
    const cnt = db.getDb().prepare('SELECT COUNT(*) AS n FROM co_changes').get() as any;
    expect(cnt.n).toBe(0);
    const row = db.getDb().prepare('SELECT commit_count FROM files WHERE path = ?').get('a.ts') as any;
    expect(row.commit_count).toBe(0);
  });
});

describe('getCoChangedFiles (Jaccard ranking)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-rank-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    const insertFile = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, commit_count)
      VALUES (?, '', 'typescript', 0, 0, 0, ?)
    `);
    // anchor.ts changed in 10 commits.
    insertFile.run('anchor.ts', 10);
    // tight.ts changed in 4 commits, all of which were with anchor.ts.
    insertFile.run('tight.ts', 4);
    // loose.ts changed in 100 commits, only 4 with anchor.ts → low Jaccard.
    insertFile.run('loose.ts', 100);
    // weak.ts changed in 5 commits, only 1 with anchor.ts → drops below minCount.
    insertFile.run('weak.ts', 5);

    q.applyCoChangeDeltas(
      [
        ['anchor.ts', 'tight.ts', 4],
        ['anchor.ts', 'loose.ts', 4],
        ['anchor.ts', 'weak.ts', 1],
      ],
      []
    );
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ranks tight coupling above loose coupling via Jaccard', () => {
    const results = q.getCoChangedFiles('anchor.ts');
    expect(results[0].path).toBe('tight.ts');
    expect(results[0].jaccard).toBeCloseTo(4 / (10 + 4 - 4), 2);
    const loose = results.find((r) => r.path === 'loose.ts')!;
    expect(loose.jaccard).toBeLessThan(results[0].jaccard);
  });

  it('drops pairs below minCount', () => {
    const results = q.getCoChangedFiles('anchor.ts', { minCount: 2 });
    expect(results.find((r) => r.path === 'weak.ts')).toBeUndefined();
  });

  it('drops pairs below minJaccard (filter is applied in SQL, before LIMIT)', () => {
    const results = q.getCoChangedFiles('anchor.ts', { minJaccard: 0.5 });
    // tight.ts has jaccard 0.4 — also dropped at this threshold.
    expect(results.length).toBe(0);
  });

  it('does not silently drop high-jaccard pairs ranked beyond an internal over-fetch', () => {
    // Insert many low-jaccard partners to push tight.ts past any in-memory
    // truncation that could happen if minJaccard were applied JS-side after
    // a small SQL LIMIT. With the SQL-side filter, a `limit: 1` request
    // with high minJaccard must still return tight.ts.
    const insertFile = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, commit_count)
      VALUES (?, '', 'typescript', 0, 0, 0, ?)
    `);
    const deltas: Array<[string, string, number]> = [];
    for (let i = 0; i < 100; i++) {
      const p = `noise${i}.ts`;
      insertFile.run(p, 1000); // huge commit_count → near-zero jaccard
      deltas.push(['anchor.ts', p, 4]);
    }
    q.applyCoChangeDeltas(deltas, []);
    const results = q.getCoChangedFiles('anchor.ts', { limit: 1, minJaccard: 0.3 });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('tight.ts');
  });

  it('returns symmetric results when queried from either side', () => {
    const fromAnchor = q.getCoChangedFiles('anchor.ts').find((r) => r.path === 'tight.ts')!;
    const fromTight = q.getCoChangedFiles('tight.ts').find((r) => r.path === 'anchor.ts')!;
    expect(fromAnchor.count).toBe(fromTight.count);
    expect(fromAnchor.jaccard).toBeCloseTo(fromTight.jaccard, 4);
  });

  it('respects the limit', () => {
    const results = q.getCoChangedFiles('anchor.ts', { limit: 1 });
    expect(results).toHaveLength(1);
  });
});

describe('CodeGraph end-to-end (mining wired into indexAll/sync)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = tempGitRepo('cochange-e2e-');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1;');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
    // A second co-change of the same pair so we cross MIN_COCHANGE_COUNT (2).
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: dir, stdio: 'pipe' });

    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('populates co_changes after indexAll on a git repo', () => {
    const partners = cg.getCoChangedFiles('a.ts');
    expect(partners.length).toBeGreaterThanOrEqual(1);
    const b = partners.find((p) => p.path === 'b.ts');
    expect(b).toBeDefined();
    expect(b!.count).toBeGreaterThanOrEqual(MIN_COCHANGE_COUNT);
  });

  it('stores the last mined HEAD in project_metadata', () => {
    // Internal-state assertion to confirm incremental sync has an anchor.
    // `queries` is private; cast to access it from the test.
    const head = (cg as unknown as { queries: QueryBuilder }).queries.getMetadata(LAST_MINED_HEAD_KEY);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('updates incrementally on sync', async () => {
    const before = cg.getCoChangedFiles('a.ts').find((p) => p.path === 'b.ts')!.count;
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 3;');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 3;');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'third'], { cwd: dir, stdio: 'pipe' });

    await cg.sync();
    const after = cg.getCoChangedFiles('a.ts').find((p) => p.path === 'b.ts')!.count;
    expect(after).toBe(before + 1);
  });

  it('respects enableCoChange: false (no mining, empty results)', async () => {
    const dir2 = tempGitRepo('cochange-disabled-');
    fs.writeFileSync(path.join(dir2, 'a.ts'), '1');
    fs.writeFileSync(path.join(dir2, 'b.ts'), '1');
    execFileSync('git', ['add', '-A'], { cwd: dir2, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'c1'], { cwd: dir2, stdio: 'pipe' });

    const cg2 = CodeGraph.initSync(dir2, {
      config: { include: ['**/*.ts'], exclude: [], enableCoChange: false },
    });
    await cg2.indexAll();
    expect(cg2.getCoChangedFiles('a.ts')).toHaveLength(0);
    cg2.destroy();
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('persists enableCoChange across config save/load round-trip', () => {
    // Regression: mergeConfig used to enumerate fields by hand and
    // silently dropped enableCoChange, so the opt-out flag could never
    // survive a reload from disk.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-cfgrt-'));
    const cg2 = CodeGraph.initSync(dir2, {
      config: { enableCoChange: false },
    });
    cg2.close();
    const reloaded = loadConfig(dir2);
    expect(reloaded.enableCoChange).toBe(false);
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});

describe('Migration v4: add commit_count column + co_changes table', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-migr-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds commit_count to files and creates co_changes', () => {
    // Build a v3-shape DB by hand.
    const Database = require('better-sqlite3');
    const dbHandle = new Database(path.join(dir, 'test.db'));
    dbHandle.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions (version, applied_at, description) VALUES (3, 0, 'v3');
      CREATE TABLE files (
        path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
        size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        node_count INTEGER DEFAULT 0, errors TEXT
      );
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
      VALUES ('x.ts', '', 'typescript', 0, 0, 0);
    `);
    expect(getCurrentVersion(dbHandle)).toBe(3);

    runMigrations(dbHandle, 3);
    expect(getCurrentVersion(dbHandle)).toBeGreaterThanOrEqual(10);

    const cols = dbHandle.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'commit_count')).toBe(true);
    const tableExists = dbHandle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='co_changes'")
      .get();
    expect(tableExists).toBeDefined();
    dbHandle.close();
  });

  it('migration is idempotent on partial-DDL re-run', () => {
    const Database = require('better-sqlite3');
    const dbHandle = new Database(path.join(dir, 'test.db'));
    dbHandle.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions (version, applied_at, description) VALUES (3, 0, 'v3');
      CREATE TABLE files (
        path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
        size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        node_count INTEGER DEFAULT 0, errors TEXT,
        commit_count INTEGER NOT NULL DEFAULT 0  -- partial pre-existing state
      );
    `);
    expect(() => runMigrations(dbHandle, 3)).not.toThrow();
    expect(getCurrentVersion(dbHandle)).toBeGreaterThanOrEqual(10);
    dbHandle.close();
  });
});
