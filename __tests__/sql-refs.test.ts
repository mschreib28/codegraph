/**
 * SQL call-site tests: parser unit tests + end-to-end through CodeGraph.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSqlRefs } from '../src/sql-refs';
import CodeGraph from '../src/index';

let testDir: string;
let cg: CodeGraph | null = null;

function write(rel: string, content: string) {
  const abs = path.join(testDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sql-'));
});

afterEach(() => {
  if (cg) {
    cg.destroy();
    cg = null;
  }
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Pure parser tests
// ============================================================================

describe('extractSqlRefs', () => {
  it('captures FROM <table> as a read', () => {
    write('a.ts', `db.prepare('SELECT id FROM users WHERE id = ?');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!).toMatchObject({ tableName: 'users', op: 'read' });
  });

  it('captures INSERT INTO as a write', () => {
    write('a.ts', `db.prepare('INSERT INTO logs (msg) VALUES (?)');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!).toMatchObject({ tableName: 'logs', op: 'write' });
  });

  it('captures UPDATE ... SET as a write', () => {
    write('a.ts', `db.run('UPDATE users SET name = ? WHERE id = ?', ['x', 1]);\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!).toMatchObject({ tableName: 'users', op: 'write' });
  });

  it('captures DELETE FROM as a write (and not as a read)', () => {
    write('a.ts', `db.run('DELETE FROM sessions WHERE expired_at < ?');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    // Both regexes (DELETE FROM as write, FROM as read) hit, so we expect
    // two refs for the same table but different ops.
    expect(refs.map((r) => r.op).sort()).toEqual(['read', 'write']);
    expect(new Set(refs.map((r) => r.tableName))).toEqual(new Set(['sessions']));
  });

  it('captures CREATE TABLE / ALTER / DROP as ddl', () => {
    write(
      'a.ts',
      [
        `db.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER)');`,
        `db.exec('ALTER TABLE audit ADD COLUMN ts INTEGER');`,
        `db.exec('DROP TABLE IF EXISTS audit_old');`,
      ].join('\n')
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const ddls = refs.filter((r) => r.op === 'ddl');
    expect(new Set(ddls.map((r) => r.tableName))).toEqual(new Set(['audit', 'audit_old']));
  });

  it('captures JOIN as a read', () => {
    write(
      'a.ts',
      `db.prepare('SELECT u.name, p.title FROM users u JOIN posts p ON p.user_id = u.id');\n`
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const tables = new Set(refs.map((r) => r.tableName));
    expect(tables).toEqual(new Set(['users', 'posts']));
  });

  it('handles backtick (MySQL) and double-quoted (Postgres) identifiers', () => {
    write(
      'a.ts',
      [
        "db.prepare('SELECT id FROM `mysql_table`');",
        `db.prepare('SELECT id FROM "pg_table"');`,
      ].join('\n')
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(new Set(refs.map((r) => r.tableName))).toEqual(
      new Set(['mysql_table', 'pg_table'])
    );
  });

  it('handles schema-qualified identifiers (drops the schema, keeps the table)', () => {
    write('a.ts', `db.prepare('SELECT * FROM public.users');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs[0]!.tableName).toBe('users');
  });

  it('does NOT match a JS variable named like a SQL keyword', () => {
    // Without the FROM/INTO/etc. prefix, a bare identifier `users` is
    // not caught — that's the whole point vs. plain grep.
    write('a.ts', `const users = await loadUsers();\nfor (const user of users) {}\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('skips unsupported languages (e.g. swift) without error', () => {
    write('a.swift', `let q = "SELECT id FROM users"\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.swift', language: 'swift' }], () => null);
    expect(refs).toEqual([]);
  });

  it('captures the correct 1-indexed line number', () => {
    write(
      'a.ts',
      [`// blah`, `// blah`, `db.prepare('SELECT * FROM line_three');`, `// blah`].join('\n')
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs[0]).toEqual(expect.objectContaining({ tableName: 'line_three', line: 3 }));
  });

  it('threads the resolveEnclosing closure correctly', () => {
    write('a.ts', `db.prepare('SELECT * FROM t');\n`);
    const calls: Array<[string, number]> = [];
    extractSqlRefs(
      testDir,
      [{ path: 'a.ts', language: 'typescript' }],
      (filePath, line) => {
        calls.push([filePath, line]);
        return 'fake-id';
      }
    );
    expect(calls).toEqual([['a.ts', 1]]);
  });

  it('drops reserved-word "table names" (WHERE/ON/AS/SELECT)', () => {
    // Common over-match: `JOIN ... ON x = y` would otherwise pick up
    // `ON` as the table name. The reserved set blocks that.
    write('a.ts', `db.prepare('SELECT * FROM users JOIN posts ON posts.uid = users.id');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const names = new Set(refs.map((r) => r.tableName));
    expect(names).toEqual(new Set(['users', 'posts']));
  });

  it('handles multiple SQL operations on a single line', () => {
    write(
      'a.ts',
      `db.exec('CREATE TABLE foo (id INTEGER); INSERT INTO foo VALUES (1)');\n`
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const ops = new Set(refs.map((r) => `${r.tableName}|${r.op}`));
    expect(ops).toEqual(new Set(['foo|ddl', 'foo|write']));
  });

  it('survives a missing file (skips, no throw)', () => {
    const refs = extractSqlRefs(
      testDir,
      [{ path: 'missing.ts', language: 'typescript' }],
      () => null
    );
    expect(refs).toEqual([]);
  });

  it('rejects prose comments containing a quoted SQL example', () => {
    // Reviewer-flagged regression: a comment like
    //   // example: db.prepare('SELECT name FROM the docs')
    // used to falsely match `the` as a table because the quote inside
    // the comment passed isInsideString(). The comment-stripper now
    // removes everything after `//` before the regex sees the line.
    write(
      'a.ts',
      [
        `// example: db.prepare('SELECT name FROM the docs')`,
        `// "SELECT id FROM the comment"`,
        `function ok() {`,
        `  // sample SELECT FROM users in a comment — should be ignored`,
        `  return 1;`,
        `}`,
      ].join('\n')
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('rejects same-line block comments containing a quoted SQL example', () => {
    write(
      'a.ts',
      `/* "SELECT * FROM ghost" */ const x = 1;\n`
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('still keeps a real SQL call when there is a trailing comment', () => {
    write('a.ts', `db.prepare('SELECT * FROM users'); // good doc\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs.length).toBe(1);
    expect(refs[0]!.tableName).toBe('users');
  });

  it('strips Python `#` comments', () => {
    write(
      'a.py',
      `# example: db.execute('SELECT * FROM the_docs')\nrows = db.execute('SELECT * FROM real_table')\n`
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.py', language: 'python' }], () => null);
    expect(refs.map((r) => r.tableName)).toEqual(['real_table']);
  });
});

// ============================================================================
// End-to-end through CodeGraph
// ============================================================================

describe('CodeGraph SQL refs', () => {
  it('persists call sites and resolves enclosing function', async () => {
    write(
      'src/db.ts',
      [
        `export function getUser(id: number) {`,
        `  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);`,
        `}`,
        ``,
        `export function logEvent(msg: string) {`,
        `  db.prepare('INSERT INTO events (msg) VALUES (?)').run(msg);`,
        `}`,
      ].join('\n')
    );
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const tables = cg.getSqlTables();
    expect(new Set(tables.map((t) => t.tableName))).toEqual(new Set(['users', 'events']));

    const userSites = cg.getSqlRefsByTable('users');
    expect(userSites[0]!.sourceName).toBe('getUser');

    const eventSites = cg.getSqlRefsByTable('events');
    expect(eventSites[0]!.sourceName).toBe('logEvent');
    expect(eventSites[0]!.op).toBe('write');
  });

  it('reverse view: getSqlTablesForNode returns tables touched by a function', async () => {
    write(
      'src/a.ts',
      [
        `export function multiTouch() {`,
        `  db.prepare('SELECT * FROM a').all();`,
        `  db.prepare('INSERT INTO b VALUES (?)').run(1);`,
        `}`,
      ].join('\n')
    );
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const node = cg.getNodesInFile('src/a.ts').find((n) => n.name === 'multiTouch')!;
    const touched = cg.getSqlTablesForNode(node.id);
    const summary = touched.map((r) => `${r.tableName}|${r.op}`).sort();
    expect(summary).toEqual(['a|read', 'b|write']);
  });

  it('case-insensitive table lookup', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM Users');\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(cg.getSqlRefsByTable('users').length).toBe(1);
    expect(cg.getSqlRefsByTable('USERS').length).toBe(1);
  });

  it('respects enableSqlRefs=false', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM users');\n`);
    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [], enableSqlRefs: false },
    });
    await cg.indexAll();
    expect(cg.getSqlTables()).toEqual([]);
  });

  it('incremental sync replaces refs for changed files only', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM old_table');\n`);
    write('src/b.ts', `db.prepare('SELECT * FROM stable_table');\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(new Set(cg.getSqlTables().map((t) => t.tableName))).toEqual(
      new Set(['old_table', 'stable_table'])
    );

    write('src/a.ts', `db.prepare('SELECT * FROM new_table');\n`);
    await cg.sync();

    const tables = new Set(cg.getSqlTables().map((t) => t.tableName));
    expect(tables).toContain('new_table');
    expect(tables).toContain('stable_table');
    expect(tables).not.toContain('old_table');
  });

  it('drops refs when a file is edited to remove its last SQL ref', async () => {
    // Same regression as PR C — applySqlRefs([]) shouldn't leave
    // stale rows. Pre-deleting the changed paths in runSqlRefsPass
    // is the fix.
    write('src/a.ts', `db.prepare('SELECT * FROM going_away');\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(cg.getSqlTables().some((t) => t.tableName === 'going_away')).toBe(true);

    write('src/a.ts', `// no sql here anymore\nexport const x = 1;\n`);
    await cg.sync();

    expect(cg.getSqlTables().some((t) => t.tableName === 'going_away')).toBe(false);
  });

  it('drops refs for files removed between syncs', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM gone_table');\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(cg.getSqlTables().some((t) => t.tableName === 'gone_table')).toBe(true);

    fs.unlinkSync(path.join(testDir, 'src/a.ts'));
    await cg.sync();
    expect(cg.getSqlTables().some((t) => t.tableName === 'gone_table')).toBe(false);
  });

  // (Removed: a defensive test for the v4-migration-collision bug class.
  // With file-based migrations (NNN-name.ts), two PRs claiming the same
  // version produces a filesystem-level conflict, so the silent skip the
  // defensive guard protected against can no longer happen.)
});
