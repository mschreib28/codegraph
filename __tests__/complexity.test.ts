/**
 * Complexity tests
 *
 * Covers:
 *   - tool detection (only madge is externally probed now)
 *   - native AST cyclomatic-complexity analyzer (the primary analyzer)
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

  it('reports madge available when its probe succeeds', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: any, _opts: any, cb: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const child = { on: () => {} };
      setImmediate(() => callback(null, '6.1.0', ''));
      return child as any;
    }) as any);

    const { detectAvailableTools } = await import('../src/complexity/tool-detection');
    const result = await detectAvailableTools('/tmp');
    expect(result.madge).toBe(true);
  });

  it('reports madge unavailable when probe errors', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: any, _opts: any, cb: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const child = { on: () => {} };
      setImmediate(() => callback(new Error('not found'), '', ''));
      return child as any;
    }) as any);

    const { detectAvailableTools } = await import('../src/complexity/tool-detection');
    const result = await detectAvailableTools('/tmp');
    expect(result.madge).toBe(false);
  });
});

describe('Native AST analyzer', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  async function runOn(relPath: string, content: string) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
    const { createNativeAnalyzer } = await import('../src/complexity/analyzers/native');
    const analyzer = createNativeAnalyzer();
    return analyzer.analyze({ projectRoot: dir, files: [relPath], computedAt: 12345 });
  }

  it('reports CC=1 for a function with no decisions', async () => {
    const records = await runOn('a.ts', `
      function plain() { return 42; }
    `);
    const plain = records.find((r) => r.symbolName === 'plain');
    expect(plain).toBeDefined();
    expect(plain!.value).toBe(1);
    expect(plain!.tool).toBe('native');
    expect(plain!.metric).toBe('cyclomatic');
    expect(plain!.language).toBe('typescript');
  });

  it('counts a single if as +1 (CC=2)', async () => {
    const records = await runOn('b.ts', `
      function branchy(x: number) { if (x > 0) return 1; return 2; }
    `);
    const fn = records.find((r) => r.symbolName === 'branchy');
    expect(fn?.value).toBe(2);
  });

  it('counts && and || as decisions', async () => {
    const records = await runOn('c.ts', `
      function combo(a: boolean, b: boolean, c: boolean) {
        if (a && b || c) return 1;
        return 0;
      }
    `);
    // 1 (base) + 1 (if) + 1 (&&) + 1 (||) = 4
    const fn = records.find((r) => r.symbolName === 'combo');
    expect(fn?.value).toBe(4);
  });

  it('counts each switch case', async () => {
    const records = await runOn('d.ts', `
      function pick(n: number) {
        switch (n) {
          case 1: return 'a';
          case 2: return 'b';
          case 3: return 'c';
          default: return 'z';
        }
      }
    `);
    // tree-sitter-typescript emits `switch_case` for `case` and `switch_default`
    // for `default`. We follow ESLint/McCabe and only count `case` clauses, since
    // `default` is the fallthrough path rather than a true decision point.
    // 1 (base) + 3 (cases) = 4.
    const fn = records.find((r) => r.symbolName === 'pick');
    expect(fn?.value).toBe(4);
  });

  it('does not inflate outer CC with nested function decisions', async () => {
    const records = await runOn('e.ts', `
      function outer() {
        function inner(x: number) {
          if (x) return 1;
          if (x > 1) return 2;
          return 0;
        }
        return inner(0);
      }
    `);
    const outer = records.find((r) => r.symbolName === 'outer');
    const inner = records.find((r) => r.symbolName === 'inner');
    expect(outer?.value).toBe(1);
    expect(inner?.value).toBe(3);
  });

  it('emits a record with null name for anonymous arrow functions', async () => {
    const records = await runOn('f.ts', `
      const fn = (x: number) => x > 0 ? 1 : -1;
    `);
    // arrow_function — anonymous, no name field
    const arrow = records.find((r) => r.symbolName === null && r.value === 2);
    expect(arrow).toBeDefined();
  });

  it('handles Python: if/elif/and produces expected CC', async () => {
    const records = await runOn('g.py', [
      'def check(x, y):',
      '    if x and y:',
      '        return 1',
      '    elif x or y:',
      '        return 2',
      '    return 0',
    ].join('\n'));
    // 1 (base) + 1 (if) + 1 (and) + 1 (elif) + 1 (or) = 5
    const fn = records.find((r) => r.symbolName === 'check');
    expect(fn?.language).toBe('python');
    expect(fn?.value).toBe(5);
  });

  it('skips files in unsupported languages without throwing', async () => {
    const records = await runOn('readme.txt', 'plain text');
    expect(records).toEqual([]);
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
        tool: 'native',
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
        tool: 'native',
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
        tool: 'native',
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
        tool: 'native',
        metric: 'cyclomatic',
        value: 5,
        computedAt: Date.now(),
      },
      {
        filePath: 'src/a.ts',
        symbolName: 'loose',
        startLine: 999, // line mismatch — should still link via name fallback
        language: 'typescript',
        tool: 'native',
        metric: 'cyclomatic',
        value: 8,
        computedAt: Date.now(),
      },
      {
        filePath: 'src/a.ts',
        symbolName: 'unknown_symbol',
        startLine: 1,
        language: 'typescript',
        tool: 'native',
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
      { filePath: 'src/low.ts', symbolName: 'a', startLine: 1, language: 'typescript', tool: 'native', metric: 'cyclomatic', value: 3, computedAt: now },
      { filePath: 'src/low.ts', symbolName: 'b', startLine: 5, language: 'typescript', tool: 'native', metric: 'cyclomatic', value: 5, computedAt: now },
      // critical file (max cc = 75)
      { filePath: 'src/hot.ts', symbolName: 'big', startLine: 1, language: 'typescript', tool: 'native', metric: 'cyclomatic', value: 75, computedAt: now },
      // file-level madge metrics
      { filePath: 'src/hot.ts', symbolName: null, startLine: null, language: 'typescript', tool: 'madge', metric: 'fan_in', value: 4, computedAt: now },
      { filePath: 'src/hot.ts', symbolName: null, startLine: null, language: 'typescript', tool: 'madge', metric: 'fan_out', value: 11, computedAt: now },
      { filePath: 'src/hot.ts', symbolName: null, startLine: null, language: 'typescript', tool: 'madge', metric: 'is_circular', value: 1, computedAt: now },
    ]);
    raw.close();

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

    expect(report.tree).toBeDefined();
    expect(report.tree.children?.length).toBeGreaterThan(0);
    expect(report.toolsPresent).toContain('native');
    expect(report.toolsPresent).toContain('madge');
    expect(report.totals.files).toBe(2);
  });
});
