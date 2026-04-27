/**
 * Co-change index hook — mines git history for file pairs that
 * change together. Persists pair counts + per-file commit counts.
 * Incremental on sync via `last_mined_cochange_head` metadata; full
 * rescan with force-push recovery on indexAll.
 */

import type { IndexHook, IndexHookContext } from './registry';
import { mineCoChanges, LAST_MINED_HEAD_KEY } from '../cochange';
import { logDebug } from '../errors';

function applyResults(
  ctx: IndexHookContext,
  result: { pairs: Map<string, number>; fileCommits: Map<string, number> }
): void {
  const pairDeltas: Array<[string, string, number]> = [];
  for (const [key, count] of result.pairs) {
    const [a, b] = key.split('\0');
    if (a && b) pairDeltas.push([a, b, count]);
  }
  const fileCommitDeltas: Array<[string, number]> = [...result.fileCommits.entries()];
  ctx.queries.applyCoChangeDeltas(pairDeltas, fileCommitDeltas);
}

function refresh(ctx: IndexHookContext, options: { fullRescan: boolean }): void {
  if (ctx.config.enableCoChange === false) return;
  try {
    const indexedFiles = new Set(ctx.queries.getAllFiles().map((f) => f.path));
    if (indexedFiles.size === 0) return;
    const sinceSha = options.fullRescan
      ? null
      : ctx.queries.getMetadata(LAST_MINED_HEAD_KEY);
    const result = mineCoChanges(ctx.projectRoot, indexedFiles, sinceSha);
    if (!result.currentHead) return;

    if (result.needsFullRescan) {
      ctx.queries.clearCoChanges();
      const fresh = mineCoChanges(ctx.projectRoot, indexedFiles, null);
      if (fresh.pairs.size > 0 || fresh.fileCommits.size > 0) {
        applyResults(ctx, fresh);
      }
      if (fresh.currentHead) ctx.queries.setMetadata(LAST_MINED_HEAD_KEY, fresh.currentHead);
      return;
    }

    if (options.fullRescan) ctx.queries.clearCoChanges();

    if (result.pairs.size > 0 || result.fileCommits.size > 0) {
      applyResults(ctx, result);
    }
    ctx.queries.setMetadata(LAST_MINED_HEAD_KEY, result.currentHead);
  } catch (err) {
    logDebug(`cochange hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'cochange',
  afterIndexAll(ctx) { refresh(ctx, { fullRescan: true }); },
  afterSync(ctx) { refresh(ctx, { fullRescan: false }); },
};
