/**
 * Tests-edges index hook — adds convention-based `tests` edges from
 * test files to their subject files (e.g. foo.test.ts → foo.ts).
 * Full rebuild on indexAll; incremental rebuild for changed test
 * files on sync.
 */

import type { IndexHook, IndexHookContext } from './registry';
import type { SyncResult } from '../extraction';
import type { Edge } from '../types';
import { isTestFile, findTestSubjects } from '../tests-edges';
import { logDebug } from '../errors';

function insertEdgesFor(
  ctx: IndexHookContext,
  testFilePaths: string[],
  allFilePaths: Set<string>
): void {
  const edges: Edge[] = [];
  for (const tf of testFilePaths) {
    const subjects = findTestSubjects(tf, allFilePaths);
    for (const subject of subjects) {
      edges.push({ source: `file:${tf}`, target: `file:${subject}`, kind: 'tests' });
    }
  }
  if (edges.length > 0) ctx.queries.insertEdges(edges);
}

export const HOOK: IndexHook = {
  name: 'tests-edges',
  afterIndexAll(ctx) {
    try {
      const allFiles = ctx.queries.getAllFiles();
      const allFilePaths = new Set(allFiles.map((f) => f.path));
      const testPaths = allFiles.map((f) => f.path).filter(isTestFile);
      ctx.queries.deleteAllEdgesByKind('tests');
      insertEdgesFor(ctx, testPaths, allFilePaths);
    } catch (err) {
      logDebug(`tests-edges hook (indexAll) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  afterSync(ctx, result: SyncResult) {
    try {
      if (result.changedFilePaths) {
        const stillTracked = new Set(ctx.queries.getAllFiles().map((f) => f.path));
        const changedTests = result.changedFilePaths
          .filter(isTestFile)
          .filter((p) => stillTracked.has(p));
        if (changedTests.length === 0) return;
        for (const tf of changedTests) {
          ctx.queries.deleteEdgesBySourceAndKind(`file:${tf}`, 'tests');
        }
        insertEdgesFor(ctx, changedTests, stillTracked);
      } else if (result.filesAdded > 0 || result.filesModified > 0) {
        // No git fast path — full rebuild.
        const allFiles = ctx.queries.getAllFiles();
        const allFilePaths = new Set(allFiles.map((f) => f.path));
        const testPaths = allFiles.map((f) => f.path).filter(isTestFile);
        ctx.queries.deleteAllEdgesByKind('tests');
        insertEdgesFor(ctx, testPaths, allFilePaths);
      }
    } catch (err) {
      logDebug(`tests-edges hook (sync) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
