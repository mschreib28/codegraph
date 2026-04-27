/**
 * Churn index hook — mines git history for per-file commit counts,
 * first/last touched timestamps, and refreshes on-disk LOC.
 * Incremental on sync via `last_mined_churn_head` in
 * project_metadata; full re-mine on indexAll. See `src/churn/`
 * for the miner.
 */

import type { IndexHook, IndexHookContext } from './registry';
import type { SyncResult } from '../extraction';
import { mineChurn, readFileLoc, LAST_MINED_CHURN_HEAD_KEY } from '../churn';
import { logDebug } from '../errors';

function refresh(ctx: IndexHookContext, options: { fullRescan: boolean; changedFiles: string[] | null }): void {
  if (ctx.config.enableChurn === false) return;
  try {
    const indexedFiles = new Set(ctx.queries.getAllFilePaths());
    if (indexedFiles.size === 0) return;
    const sinceSha = options.fullRescan
      ? null
      : ctx.queries.getMetadata(LAST_MINED_CHURN_HEAD_KEY);
    const mined = mineChurn(ctx.projectRoot, indexedFiles, sinceSha);
    if (mined.currentHead === null) return; // not in a git repo
    if (mined.needsFullRescan) {
      ctx.queries.clearChurn();
      const remined = mineChurn(ctx.projectRoot, indexedFiles, null);
      ctx.queries.applyChurnDeltas(remined.deltas.values());
      ctx.queries.setMetadata(LAST_MINED_CHURN_HEAD_KEY, remined.currentHead ?? '');
    } else {
      if (options.fullRescan) ctx.queries.clearChurn();
      ctx.queries.applyChurnDeltas(mined.deltas.values());
      ctx.queries.setMetadata(LAST_MINED_CHURN_HEAD_KEY, mined.currentHead);
    }
    const targets = options.fullRescan
      ? [...indexedFiles]
      : (options.changedFiles ?? []).filter((p) => indexedFiles.has(p));
    if (targets.length > 0) {
      ctx.queries.applyLocUpdates(
        targets.map((p) => ({ path: p, loc: readFileLoc(ctx.projectRoot, p) }))
      );
    }
  } catch (err) {
    logDebug(`churn hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'churn',
  afterIndexAll(ctx) { refresh(ctx, { fullRescan: true, changedFiles: null }); },
  afterSync(ctx, result: SyncResult) {
    refresh(ctx, { fullRescan: false, changedFiles: result.changedFilePaths ?? null });
  },
};
