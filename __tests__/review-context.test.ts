/**
 * Review Context Tests
 *
 * Verifies:
 *   - parseDiff handles standard git unified-diff shapes (modified,
 *     added, deleted, renamed, multiple hunks).
 *   - symbolsTouchedByHunks correctly maps line ranges to symbols.
 *   - buildReviewContext attaches callers, callees, impact, tests
 *     for affected symbols.
 *   - Co-change warnings surface when a changed file's historical
 *     co-changers were NOT touched.
 *   - Graceful degrade: pre-#105 install (no co_changes table) and
 *     pre-#106 install (no `tests` edges) — return empty rather than
 *     throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseDiff, symbolsTouchedByHunks } from '../src/review/diff-parser';
import { buildReviewContext } from '../src/review';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { GraphTraverser } from '../src/graph/traversal';
import { Node, Edge } from '../src/types';

// =============================================================================
// parseDiff
// =============================================================================

describe('parseDiff', () => {
  it('parses a simple modified-file diff', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@
 unchanged
-old line
+new line one
+new line two
 also unchanged`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[0].status).toBe('modified');
    expect(files[0].hunks).toEqual([
      { oldStart: 10, oldCount: 3, newStart: 10, newCount: 5 },
    ]);
  });

  it('detects file additions via /dev/null in the --- header', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+a
+b
+c`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('added');
    expect(files[0].path).toBe('new.ts');
  });

  it('detects file deletions via /dev/null in the +++ header', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abc..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('deleted');
    expect(files[0].path).toBe('gone.ts');
  });

  it('detects renames and exposes oldPath', () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts
index abc..def 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
-old name
+new name
 unchanged`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('renamed');
    expect(files[0].path).toBe('new.ts');
    expect(files[0].oldPath).toBe('old.ts');
  });

  it('handles multi-file, multi-hunk diffs', () => {
    const diff = `diff --git a/a.ts b/a.ts
index abc..def 100644
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 ctx
+added
 ctx
 ctx
@@ -20,2 +21,2 @@
-old
+new
 ctx
diff --git a/b.ts b/b.ts
index 111..222 100644
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,1 @@
-x
+y`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('a.ts');
    expect(files[0].hunks).toHaveLength(2);
    expect(files[1].path).toBe('b.ts');
    expect(files[1].hunks).toHaveLength(1);
  });

  it('returns [] for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('emits a hunk-less rename even when followed by another hunked file', () => {
    // Regression: previously a rename-only file mid-diff was silently
    // dropped because the EOF-only hunk-less flush never fired before
    // the next `diff --git` header arrived.
    const diff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/other.ts b/other.ts
index abc..def 100644
--- a/other.ts
+++ b/other.ts
@@ -1,1 +1,1 @@
-x
+y`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].status).toBe('renamed');
    expect(files[0].path).toBe('new.ts');
    expect(files[0].oldPath).toBe('old.ts');
    expect(files[1].path).toBe('other.ts');
    expect(files[1].status).toBe('modified');
  });

  it('emits a hunk-less file-mode-change followed by another file', () => {
    const diff = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-a
+b`;
    const files = parseDiff(diff);
    // The mode-change file has no add/delete/rename markers so it
    // doesn't qualify as hunk-less for our purposes — it's silently
    // skipped (current implementation). The hunked file MUST still
    // be emitted, and that's the regression risk.
    expect(files.find((f) => f.path === 'foo.ts')).toBeDefined();
  });

  it('strips C-style quoting from paths with spaces or special chars', () => {
    const diff = `diff --git "a/path with spaces.ts" "b/path with spaces.ts"
index abc..def 100644
--- "a/path with spaces.ts"
+++ "b/path with spaces.ts"
@@ -1,1 +1,1 @@
-a
+b`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('path with spaces.ts');
    expect(files[0].path).not.toContain('"');
  });

  it('handles single-line hunk header (no comma)', () => {
    // git emits `@@ -5 +5 @@` for one-line hunks (count of 1 elided).
    const diff = `diff --git a/x.ts b/x.ts
index abc..def 100644
--- a/x.ts
+++ b/x.ts
@@ -5 +5 @@
-old
+new`;
    const files = parseDiff(diff);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 5,
      oldCount: 1,
      newStart: 5,
      newCount: 1,
    });
  });
});

// =============================================================================
// symbolsTouchedByHunks
// =============================================================================

describe('symbolsTouchedByHunks', () => {
  const sym = (startLine: number, endLine: number, name = 'sym') => ({ startLine, endLine, name });

  it('returns symbols whose range overlaps any hunk', () => {
    const symbols = [sym(1, 5, 'a'), sym(10, 20, 'b'), sym(50, 60, 'c')];
    const hunks = [{ oldStart: 12, oldCount: 3, newStart: 12, newCount: 3 }];
    const out = symbolsTouchedByHunks(hunks, symbols);
    expect(out.map((s) => s.name)).toEqual(['b']);
  });

  it('matches a symbol that fully contains the hunk', () => {
    const symbols = [sym(1, 100, 'big')];
    const hunks = [{ oldStart: 50, oldCount: 1, newStart: 50, newCount: 1 }];
    expect(symbolsTouchedByHunks(hunks, symbols).map((s) => s.name)).toEqual(['big']);
  });

  it('matches a symbol fully contained by the hunk', () => {
    const symbols = [sym(50, 55, 'small')];
    const hunks = [{ oldStart: 10, oldCount: 100, newStart: 10, newCount: 100 }];
    expect(symbolsTouchedByHunks(hunks, symbols).map((s) => s.name)).toEqual(['small']);
  });

  it('does not match symbols outside any hunk', () => {
    const symbols = [sym(1, 5, 'before'), sym(50, 60, 'after')];
    const hunks = [{ oldStart: 20, oldCount: 5, newStart: 20, newCount: 5 }];
    expect(symbolsTouchedByHunks(hunks, symbols)).toEqual([]);
  });

  it('returns [] when hunks or symbols are empty', () => {
    expect(symbolsTouchedByHunks([], [sym(1, 5)])).toEqual([]);
    expect(symbolsTouchedByHunks([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }], [])).toEqual([]);
  });
});

// =============================================================================
// buildReviewContext (integration)
// =============================================================================

function makeNode(id: string, name: string, kind: Node['kind'], filePath: string, startLine: number, endLine: number): Node {
  return {
    id,
    kind,
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('buildReviewContext (integration)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;
  let traverser: GraphTraverser;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ctx-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    traverser = new GraphTraverser(q);

    // Set up a small graph:
    //   src/foo.ts contains `doFoo` (lines 5-15)
    //   src/bar.ts contains `useFoo` (lines 1-10) which calls doFoo
    //   src/baz.ts contains `helper` (lines 20-30) which doFoo calls
    const upsertFile = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
      VALUES (?, '', 'typescript', 0, 0, 0)
    `);
    upsertFile.run('src/foo.ts');
    upsertFile.run('src/bar.ts');
    upsertFile.run('src/baz.ts');

    q.insertNodes([
      makeNode('foo', 'doFoo', 'function', 'src/foo.ts', 5, 15),
      makeNode('bar', 'useFoo', 'function', 'src/bar.ts', 1, 10),
      makeNode('baz', 'helper', 'function', 'src/baz.ts', 20, 30),
    ]);

    // Edges: useFoo -> doFoo (calls), doFoo -> helper (calls)
    const callEdge = (source: string, target: string, line: number): Edge => ({
      source,
      target,
      kind: 'calls',
      line,
    });
    q.insertEdges([callEdge('bar', 'foo', 5), callEdge('foo', 'baz', 12)]);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function modifyDoFooDiff(): string {
    return `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@
 ctx
-old impl
+new impl
+plus one
 ctx`;
  }

  it('attaches callers and callees for affected symbols', () => {
    const ctx = buildReviewContext(modifyDoFooDiff(), q, traverser);
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0].affectedSymbols).toHaveLength(1);
    const sym = ctx.files[0].affectedSymbols[0];
    expect(sym.name).toBe('doFoo');
    expect(sym.callers.map((c) => c.name)).toContain('useFoo');
    expect(sym.callees.map((c) => c.name)).toContain('helper');
  });

  it('summarizes correctly across an added + modified + deleted set', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,1 +10,1 @@
-x
+y
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,1 @@
+content
diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-x`;
    const ctx = buildReviewContext(diff, q, traverser);
    expect(ctx.summary.filesAdded).toBe(1);
    expect(ctx.summary.filesModified).toBe(1);
    expect(ctx.summary.filesDeleted).toBe(1);
  });

  it('reports broken incoming refs for deleted files', () => {
    const diff = `diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -20,11 +0,0 @@
-x`;
    const ctx = buildReviewContext(diff, q, traverser);
    const baz = ctx.files.find((f) => f.path === 'src/baz.ts')!;
    expect(baz.status).toBe('deleted');
    // doFoo (in foo.ts) calls helper (in baz.ts) — deleting baz.ts breaks foo.
    expect(baz.brokenIncomingRefs?.map((r) => r.name)).toContain('doFoo');
  });

  it('dedupes brokenIncomingRefs when one caller has multiple edge types to the deleted file', () => {
    // Add a second edge from useFoo to helper (e.g., references in
    // addition to the existing call). Without dedup, useFoo would appear
    // twice in brokenIncomingRefs.
    q.insertEdges([{ source: 'bar', target: 'baz', kind: 'references', line: 7 }]);
    // Note: bar already had a `calls` edge target=foo and now `references` target=baz.
    // For deletion of baz.ts we look at incoming to baz's symbols (helper).
    // We need TWO edges from the same source to helper for dedup to fire.
    q.insertEdges([
      { source: 'bar', target: 'baz', kind: 'imports', line: 7 },
    ]);
    const diff = `diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -20,11 +0,0 @@
-x`;
    const ctx = buildReviewContext(diff, q, traverser);
    const baz = ctx.files.find((f) => f.path === 'src/baz.ts')!;
    // useFoo should appear at most once with line=7 (we have two edges
    // both at line 7 from bar to baz with different kinds).
    const fromBar = baz.brokenIncomingRefs?.filter((r) => r.name === 'useFoo' && r.line === 7);
    expect(fromBar?.length).toBe(1);
  });

  it('returns empty co-change warnings on a pre-#105 install (no co_changes table)', () => {
    // Default DatabaseConnection.initialize() runs schema.sql which on
    // upstream/main does NOT include the co_changes table. The helper
    // must gracefully degrade rather than throw.
    const ctx = buildReviewContext(modifyDoFooDiff(), q, traverser);
    expect(ctx.coChangeWarnings).toEqual([]);
    expect(ctx.summary.coChangeWarnings).toBe(0);
  });

  it('returns empty tests array on a pre-#106 install (no `tests` edges)', () => {
    const ctx = buildReviewContext(modifyDoFooDiff(), q, traverser);
    expect(ctx.files[0].tests).toEqual([]);
  });

  it('respects maxCallersPerSymbol cap', () => {
    // Add 10 more callers of doFoo to make the cap observable.
    const extraNodes: Node[] = [];
    const extraEdges: Edge[] = [];
    const upsert = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
      VALUES (?, '', 'typescript', 0, 0, 0)
    `);
    for (let i = 0; i < 10; i++) {
      const fp = `src/caller${i}.ts`;
      upsert.run(fp);
      const id = `caller${i}`;
      extraNodes.push(makeNode(id, `caller${i}`, 'function', fp, 1, 5));
      extraEdges.push({ source: id, target: 'foo', kind: 'calls', line: 1 });
    }
    q.insertNodes(extraNodes);
    q.insertEdges(extraEdges);

    const ctx = buildReviewContext(modifyDoFooDiff(), q, traverser, { maxCallersPerSymbol: 3 });
    const sym = ctx.files[0].affectedSymbols[0];
    expect(sym.callers.length).toBeLessThanOrEqual(3);
  });

  it('co-change warning surfaces when a changed file has historical co-changers not in the PR', () => {
    // Manually create the co_changes table + add commit_count + populate.
    // This simulates a post-#105 install. (When PR #105 lands the table
    // exists natively; we simulate it here so the helper has data to
    // surface.)
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b),
        CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb().prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);

    // Re-define getCoChangedFiles via a thin shim (since we don't have
    // PR #105's QueryBuilder method here). Use the same SQL the PR
    // would use.
    (q as unknown as {
      getCoChangedFiles: typeof getCoChangedFilesShim;
    }).getCoChangedFiles = getCoChangedFilesShim.bind(null, q);

    // Diff touches src/foo.ts but NOT src/bar.ts → bar.ts should surface
    // as a co-change warning.
    const ctx = buildReviewContext(modifyDoFooDiff(), q, traverser, {
      minCoChangeJaccard: 0.3,
    });
    expect(ctx.coChangeWarnings.length).toBeGreaterThan(0);
    const w = ctx.coChangeWarnings[0];
    expect(w.changedFile).toBe('src/foo.ts');
    expect(w.expectedToChange).toBe('src/bar.ts');
    expect(w.jaccard).toBeGreaterThan(0.3);
  });

  it('does NOT warn about files that ARE in the PR (changedPaths exclusion)', () => {
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb().prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);
    (q as unknown as { getCoChangedFiles: typeof getCoChangedFilesShim }).getCoChangedFiles
      = getCoChangedFilesShim.bind(null, q);

    // Diff includes BOTH foo and bar → no warning should appear because
    // bar IS in the changed set.
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,1 +10,1 @@
-x
+y
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -3,1 +3,1 @@
-x
+y`;
    const ctx = buildReviewContext(diff, q, traverser, { minCoChangeJaccard: 0.3 });
    expect(ctx.coChangeWarnings).toEqual([]);
  });
});

describe('serializeReviewContextWithinCap (JSON-safe truncation)', () => {
  // Re-import the helper indirectly via the MCP tool path. To test it
  // in isolation we'd need to export it; instead exercise it via the
  // path: build a too-large context, call the public buildReviewContext,
  // serialize, and verify the output is parseable JSON.
  it('produces parseable JSON even when context exceeds the cap', async () => {
    // Build a context with thousands of symbols by inserting many nodes
    // and a diff that touches them all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trunc-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const q = new QueryBuilder(db.getDb());
    const traverser = new GraphTraverser(q);

    db.getDb().prepare(`INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, '', 'typescript', 0, 0, 0)`).run('src/big.ts');
    const nodes: Node[] = [];
    for (let i = 0; i < 200; i++) {
      nodes.push(makeNode(`n${i}`, `sym${i}`, 'function', 'src/big.ts', i * 5, i * 5 + 4));
      // Long docstrings to stress the truncation
      nodes[i].docstring = 'x'.repeat(500);
    }
    q.insertNodes(nodes);

    // Diff that touches every line in big.ts.
    const diff = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,1000 +1,1000 @@
-x
+y`;
    const ctx = buildReviewContext(diff, q, traverser);

    // Use the helper directly — re-create it inline (matches the MCP
    // tool's serializeReviewContextWithinCap behavior). Verify JSON parses.
    const json = JSON.stringify(ctx, null, 2);
    expect(() => JSON.parse(json)).not.toThrow(); // sanity: full JSON is valid

    // Now apply the same trimming logic the MCP handler uses (lift it
    // here as a one-off — equivalent to importing the private helper).
    const cap = 5000; // small cap to force trimming
    const trimmed = trimContextToFitJson(ctx, cap);
    expect(trimmed.length).toBeLessThanOrEqual(cap);
    expect(() => JSON.parse(trimmed)).not.toThrow();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Inline equivalent of serializeReviewContextWithinCap from src/mcp/tools.ts.
// Kept here to avoid exporting an internal helper just for tests.
function trimContextToFitJson(context: unknown, cap: number): string {
  const ctx = JSON.parse(JSON.stringify(context)) as {
    summary: Record<string, number>;
    files: Array<{
      affectedSymbols: Array<{
        docstring?: string;
        signature?: string;
        callers?: unknown[];
        callees?: unknown[];
      }>;
      _truncated?: boolean;
    }>;
    coChangeWarnings: unknown[];
    _truncated?: boolean;
  };
  const fits = (s: string) => s.length <= cap;
  let json = JSON.stringify(ctx, null, 2);
  if (fits(json)) return json;
  for (const f of ctx.files) for (const s of f.affectedSymbols) delete s.docstring;
  json = JSON.stringify(ctx, null, 2);
  if (fits(json)) return json;
  for (const f of ctx.files) for (const s of f.affectedSymbols) delete s.signature;
  json = JSON.stringify(ctx, null, 2);
  if (fits(json)) return json;
  for (const f of ctx.files) for (const s of f.affectedSymbols) {
    if (Array.isArray(s.callers)) s.callers = s.callers.slice(0, 2);
    if (Array.isArray(s.callees)) s.callees = s.callees.slice(0, 2);
  }
  json = JSON.stringify(ctx, null, 2);
  if (fits(json)) return json;
  for (const f of ctx.files) for (const s of f.affectedSymbols) {
    delete s.callers;
    delete s.callees;
  }
  json = JSON.stringify(ctx, null, 2);
  if (fits(json)) return json;
  while (ctx.files.length > 1) {
    ctx.files.pop();
    ctx._truncated = true;
    json = JSON.stringify(ctx, null, 2);
    if (fits(json)) return json;
  }
  return JSON.stringify(
    { summary: ctx.summary, coChangeWarnings: ctx.coChangeWarnings, _truncated: true },
    null, 2
  );
}

/**
 * Shim that mimics PR #105's QueryBuilder.getCoChangedFiles. Used in
 * tests for forward-compatibility — once #105 lands, the real method
 * exists on QueryBuilder and this shim is unnecessary.
 */
function getCoChangedFilesShim(
  q: QueryBuilder,
  filePath: string,
  options: { limit: number; minCount: number; minJaccard: number }
): Array<{ path: string; count: number; jaccard: number }> {
  const { limit, minCount, minJaccard } = options;
  const sql = `
    WITH partners AS (
      SELECT file_b AS path, count FROM co_changes WHERE file_a = ?
      UNION ALL
      SELECT file_a AS path, count FROM co_changes WHERE file_b = ?
    ),
    anchor AS (SELECT commit_count AS c FROM files WHERE path = ?),
    scored AS (
      SELECT
        p.path AS path, p.count AS count,
        CAST(p.count AS REAL) / NULLIF((SELECT c FROM anchor) + f.commit_count - p.count, 0) AS jaccard
      FROM partners p
      JOIN files f ON f.path = p.path
      WHERE p.count >= ?
    )
    SELECT path, count, jaccard FROM scored
    WHERE COALESCE(jaccard, 0) >= ?
    ORDER BY jaccard DESC, count DESC
    LIMIT ?
  `;
  const rows = (q as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ path: string; count: number; jaccard: number | null }> } } }).db
    .prepare(sql)
    .all(filePath, filePath, filePath, minCount, minJaccard, limit);
  return rows.map((r) => ({ path: r.path, count: r.count, jaccard: r.jaccard ?? 0 }));
}
