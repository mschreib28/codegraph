/**
 * Complexity tests
 *
 * Covers:
 *   - tool detection (mocked execFile)
 *   - complexity_metrics schema/migration applied to fresh + legacy DBs
 *   - QueryBuilder insert / get / clear / linkComplexityToNodes
 *   - server projection: buildComplexityReport risk classification + treemap
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../src/db/migrations';
import { createDatabase } from '../src/db/sqlite-adapter';
import { buildComplexityReport } from '../src/server/graph-projection';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from 'child_process';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-complexity-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Complexity tool detection', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it('reports all tools available when probes succeed', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: any, _opts: any, cb: any) => {
      // signature: execFile(cmd, args, opts, cb)
      const callback = typeof _opts === 'function' ? _opts : cb;
      const child = { on: () => {} };
      setImmediate(() => callback(null, '1.0.0', ''));
      return child as any;
    }) as any);

    const { detectAvailableTools } = await import('../src/complexity/tool-detection');
    const result = await detectAvailableTools('/tmp');
    expect(result).toEqual({ eslint: true, madge: true, radon: true });
  });

  it('reports tool unavailable when probe errors', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: any, _opts: any, cb: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const child = { on: () => {} };
      const tool = Array.isArray(args) ? args.find((a: string) => ['eslint', 'madge'].includes(a)) ?? _cmd : _cmd;
      const fail = tool === 'eslint' || tool === 'radon';
      setImmediate(() => callback(fail ? new Error('not found') : null, '', ''));
      return child as any;
    }) as any);

    const { detectAvailableTools } = await import('../src/complexity/tool-detection');
    const result = await detectAvailableTools('/tmp');
    expect(result.eslint).toBe(false);
    expect(result.madge).toBe(true);
    expect(result.radon).toBe(false);
  });
});

describe('complexity_metrics schema', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it('creates complexity_metrics table on a fresh database', () => {
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const row = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='complexity_metrics'")
      .get();
    expect(row).toBeDefined();

    const indexes = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='complexity_metrics'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((r) => r.name);
    expect(names).toContain('idx_complexity_file');
    expect(names).toContain('idx_complexity_node');
    expect(names).toContain('idx_complexity_metric');

    expect(db.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('migrates a legacy v3 database forward to add complexity_metrics', () => {
    const dbPath = path.join(dir, 'legacy.db');
    const raw = createDatabase(dbPath);

    // Bootstrap a minimal v3 schema: schema_versions + nodes (referenced by FK).
    raw.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT,
        file_path TEXT,
        language TEXT,
        start_line INTEGER,
        end_line INTEGER,
        start_column INTEGER,
        end_column INTEGER,
        is_exported INTEGER DEFAULT 0,
        is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0,
        is_abstract INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_versions (version, applied_at, description) VALUES (3, ${Date.now()}, 'legacy');
    `);

    // Verify table doesn't exist yet
    let exists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='complexity_metrics'")
      .get();
    expect(exists).toBeUndefined();

    runMigrations(raw, 3);

    exists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='complexity_metrics'")
      .get();
    expect(exists).toBeDefined();

    const versionRow = raw
      .prepare('SELECT MAX(version) as v FROM schema_versions')
      .get() as { v: number };
    expect(versionRow.v).toBe(CURRENT_SCHEMA_VERSION);

    raw.close();
  });
});

describe('QueryBuilder complexity methods', () => {
  let dir: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = tempDir();
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it('inserts and reads complexity records', () => {
    const now = Date.now();
    queries.insertComplexityRecords([
      {
        filePath: 'src/a.ts',
        symbolName: 'foo',
        startLine: 10,
        language: 'typescript',
        tool: 'eslint',
        metric: 'cyclomatic',
        value: 7,
        computedAt: now,
      },
      {
        filePath: 'src/a.ts',
        symbolName: null,
        startLine: null,
        language: 'typescript',
        tool: 'madge',
        metric: 'fan_in',
        value: 3,
        computedAt: now,
      },
      {
        filePath: 'src/b.py',
        symbolName: 'bar',
        startLine: 1,
        language: 'python',
        tool: 'radon',
        metric: 'cyclomatic',
        value: 12,
        computedAt: now,
      },
    ]);

    const all = queries.getAllComplexityMetrics();
    expect(all).toHaveLength(3);

    const a = queries.getComplexityForFile('src/a.ts');
    expect(a).toHaveLength(2);
    // ordered by metric ASC, value DESC
    expect(a[0].metric).toBe('cyclomatic');
    expect(a[0].value).toBe(7);
    expect(a[1].metric).toBe('fan_in');
  });

  it('clearComplexityMetrics removes everything', () => {
    queries.insertComplexityRecords([
      {
        filePath: 'x.ts',
        symbolName: 'fn',
        startLine: 1,
        language: 'typescript',
        tool: 'eslint',
        metric: 'cyclomatic',
        value: 4,
        computedAt: Date.now(),
      },
    ]);
    expect(queries.getAllComplexityMetrics()).toHaveLength(1);
    queries.clearComplexityMetrics();
    expect(queries.getAllComplexityMetrics()).toHaveLength(0);
  });

  it('linkComplexityToNodes resolves node_id by file+name+line then file+name', () => {
    // Insert a graph node we can link against.
    db.getDb()
      .prepare(
        `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
           start_line, end_line, start_column, end_column,
           is_exported, is_async, is_static, is_abstract, updated_at)
         VALUES (?, 'function', 'precise', 'precise', 'src/a.ts', 'typescript',
           10, 20, 0, 0, 0, 0, 0, 0, ?)`
      )
      .run('node-precise', Date.now());
    db.getDb()
      .prepare(
        `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
           start_line, end_line, start_column, end_column,
           is_exported, is_async, is_static, is_abstract, updated_at)
         VALUES (?, 'function', 'loose', 'loose', 'src/a.ts', 'typescript',
           50, 60, 0, 0, 0, 0, 0, 0, ?)`
      )
      .run('node-loose', Date.now());

    queries.insertComplexityRecords([
      {
        filePath: 'src/a.ts',
        symbolName: 'precise',
        startLine: 10,
        language: 'typescript',
        tool: 'eslint',
        metric: 'cyclomatic',
        value: 5,
        computedAt: Date.now(),
      },
      {
        filePath: 'src/a.ts',
        symbolName: 'loose',
        startLine: 999, // line mismatch — should still link via name fallback
        language: 'typescript',
        tool: 'eslint',
        metric: 'cyclomatic',
        value: 8,
        computedAt: Date.now(),
      },
      {
        filePath: 'src/a.ts',
        symbolName: 'unknown_symbol',
        startLine: 1,
        language: 'typescript',
        tool: 'eslint',
        metric: 'cyclomatic',
        value: 2,
        computedAt: Date.now(),
      },
    ]);

    queries.linkComplexityToNodes();

    const rows = queries.getAllComplexityMetrics();
    const precise = rows.find((r) => r.symbolName === 'precise');
    const loose = rows.find((r) => r.symbolName === 'loose');
    const unknown = rows.find((r) => r.symbolName === 'unknown_symbol');
    expect(precise?.nodeId).toBe('node-precise');
    expect(loose?.nodeId).toBe('node-loose');
    expect(unknown?.nodeId).toBeNull();
  });
});

describe('buildComplexityReport projection', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    dir = tempDir();
    cg = CodeGraph.initSync(dir);
  });

  afterEach(() => {
    cg.close();
    cleanup(dir);
  });

  it('aggregates metrics into per-file entries with correct risk classification', () => {
    const dbPath = getDatabasePath(dir);
    const raw = DatabaseConnection.open(dbPath);
    const q = new QueryBuilder(raw.getDb());
    const now = Date.now();

    q.insertComplexityRecords([
      // low-risk file (max cc = 5)
      { filePath: 'src/low.ts', symbolName: 'a', startLine: 1, language: 'typescript', tool: 'eslint', metric: 'cyclomatic', value: 3, computedAt: now },
      { filePath: 'src/low.ts', symbolName: 'b', startLine: 5, language: 'typescript', tool: 'eslint', metric: 'cyclomatic', value: 5, computedAt: now },
      // critical file (max cc = 75)
      { filePath: 'src/hot.ts', symbolName: 'big', startLine: 1, language: 'typescript', tool: 'eslint', metric: 'cyclomatic', value: 75, computedAt: now },
      // file-level madge metrics
      { filePath: 'src/hot.ts', symbolName: null, startLine: null, language: 'typescript', tool: 'madge', metric: 'fan_in', value: 4, computedAt: now },
      { filePath: 'src/hot.ts', symbolName: null, startLine: null, language: 'typescript', tool: 'madge', metric: 'fan_out', value: 11, computedAt: now },
      { filePath: 'src/hot.ts', symbolName: null, startLine: null, language: 'typescript', tool: 'madge', metric: 'is_circular', value: 1, computedAt: now },
    ]);
    raw.close();

    // Re-open through CodeGraph and run the projection
    const report = buildComplexityReport(cg);
    expect(report.files.length).toBe(2);

    const hot = report.files.find((f) => f.filePath === 'src/hot.ts')!;
    expect(hot.cyclomaticMax).toBe(75);
    expect(hot.risk).toBe('critical');
    expect(hot.fanIn).toBe(4);
    expect(hot.fanOut).toBe(11);
    expect(hot.isCircular).toBe(true);

    const low = report.files.find((f) => f.filePath === 'src/low.ts')!;
    expect(low.cyclomaticMax).toBe(5);
    expect(low.risk).toBe('low');

    // tree should have a hierarchical root with at least one descendant.
    expect(report.tree).toBeDefined();
    expect(report.tree.children?.length).toBeGreaterThan(0);
    expect(report.toolsPresent).toContain('eslint');
    expect(report.toolsPresent).toContain('madge');
    expect(report.totals.files).toBe(2);
  });
});
