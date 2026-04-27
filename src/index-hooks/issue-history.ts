/**
 * Issue-history index hook — mines `Fixes/Closes/Resolves #N`
 * commits and attributes them to symbols touched by each commit's
 * hunks. Incremental on sync via `last_mined_issues_head` in
 * project_metadata; full re-mine on indexAll. See
 * `src/issue-history/` for the miner.
 */

import type { IndexHook, IndexHookContext } from './registry';
import { mineIssueHistory, LAST_MINED_ISSUES_HEAD_KEY } from '../issue-history';
import { logDebug } from '../errors';

function refresh(ctx: IndexHookContext, options: { fullRescan: boolean }): void {
  if (ctx.config.enableIssueHistory === false) return;
  try {
    // Resolver closure with a per-pass file-level cache. Without it,
    // every (filePath, name) lookup would re-fetch all nodes for the
    // file.
    const fileNodesCache = new Map<string, Map<string, string>>();
    const resolveSymbol = (filePath: string, name: string): string | null => {
      let nameToId = fileNodesCache.get(filePath);
      if (!nameToId) {
        nameToId = new Map();
        for (const n of ctx.queries.getNodesByFile(filePath)) {
          if (!nameToId.has(n.name)) nameToId.set(n.name, n.id);
        }
        fileNodesCache.set(filePath, nameToId);
      }
      return nameToId.get(name) ?? null;
    };

    const sinceSha = options.fullRescan
      ? null
      : ctx.queries.getMetadata(LAST_MINED_ISSUES_HEAD_KEY);

    const mined = mineIssueHistory(ctx.projectRoot, resolveSymbol, sinceSha);
    if (mined.currentHead === null) return; // not in a git repo

    if (mined.needsFullRescan) {
      ctx.queries.clearIssueAttributions();
      const remined = mineIssueHistory(ctx.projectRoot, resolveSymbol, null);
      ctx.queries.applyIssueAttributions(remined.attributions);
      ctx.queries.setMetadata(LAST_MINED_ISSUES_HEAD_KEY, remined.currentHead ?? '');
    } else {
      if (options.fullRescan) ctx.queries.clearIssueAttributions();
      ctx.queries.applyIssueAttributions(mined.attributions);
      ctx.queries.setMetadata(LAST_MINED_ISSUES_HEAD_KEY, mined.currentHead);
    }
  } catch (err) {
    logDebug(`issue-history hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'issue-history',
  afterIndexAll(ctx) { refresh(ctx, { fullRescan: true }); },
  afterSync(ctx) { refresh(ctx, { fullRescan: false }); },
};
