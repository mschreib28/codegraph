/**
 * Centrality index hook — runs PageRank over the calls+references
 * subgraph after every indexAll/sync and persists scores to
 * `nodes.centrality`. Cheap; no I/O. See `src/centrality/` for the
 * pure-compute module.
 */

import type { IndexHook, IndexHookContext } from './registry';
import { computePageRank, PR_EDGE_KINDS } from '../centrality';
import { logDebug } from '../errors';

function recompute(ctx: IndexHookContext): void {
  if (ctx.config.enableCentrality === false) return;
  try {
    const nodes = ctx.queries.getAllNodes();
    if (nodes.length === 0) return;
    const edgeRows = ctx.db
      .getDb()
      .prepare(
        `SELECT source, target FROM edges WHERE kind IN (${PR_EDGE_KINDS
          .map(() => '?')
          .join(',')})`
      )
      .all(...PR_EDGE_KINDS) as Array<{ source: string; target: string }>;
    const result = computePageRank(nodes, edgeRows);
    ctx.queries.clearCentrality();
    ctx.queries.applyCentralityScores(result.scores);
  } catch (err) {
    logDebug(`centrality hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'centrality',
  afterIndexAll(ctx) { recompute(ctx); },
  afterSync(ctx) { recompute(ctx); },
};
