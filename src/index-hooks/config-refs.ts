/**
 * Config-refs index hook — extracts env-var / feature-flag read
 * sites and persists to `config_refs`. Incremental on sync; full
 * rescan on indexAll. See `src/config-refs/` for the extractor.
 */

import type { IndexHook, IndexHookContext } from './registry';
import type { SyncResult } from '../extraction';
import { extractConfigRefs } from '../config-refs';
import { logDebug } from '../errors';

function refresh(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] }
): void {
  if (ctx.config.enableConfigRefs === false) return;
  try {
    const fileNodes = new Map<string, Array<{ id: string; start: number; end: number }>>();
    const resolveEnclosing = (filePath: string, line: number): string | null => {
      let nodes = fileNodes.get(filePath);
      if (!nodes) {
        nodes = ctx.queries
          .getNodesByFile(filePath)
          .filter(
            (n) =>
              n.kind === 'function' ||
              n.kind === 'method' ||
              n.kind === 'class' ||
              n.kind === 'interface'
          )
          .map((n) => ({ id: n.id, start: n.startLine, end: n.endLine }))
          .sort((a, b) => a.end - a.start - (b.end - b.start));
        fileNodes.set(filePath, nodes);
      }
      for (const n of nodes) {
        if (n.start <= line && line <= n.end) return n.id;
      }
      return null;
    };

    let targets: Array<{ path: string; language: string }>;
    if (options.scope === 'all') {
      targets = ctx.queries.getAllFiles().map((f) => ({
        path: f.path,
        language: f.language,
      }));
      ctx.queries.clearConfigRefs();
    } else {
      const records = options.files
        .map((p) => ctx.queries.getFileByPath(p))
        .filter((f): f is NonNullable<typeof f> => f != null);
      targets = records.map((f) => ({ path: f.path, language: f.language }));
      ctx.queries.pruneOrphanedConfigRefs();
      if (targets.length > 0) {
        ctx.queries.deleteConfigRefsForPaths(targets.map((t) => t.path));
      }
    }

    const refs = extractConfigRefs(ctx.projectRoot, targets, resolveEnclosing);
    ctx.queries.applyConfigRefs(refs);
  } catch (err) {
    logDebug(`config-refs hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'config-refs',
  afterIndexAll(ctx) { refresh(ctx, { scope: 'all' }); },
  afterSync(ctx, result: SyncResult) {
    if (
      (result.changedFilePaths && result.changedFilePaths.length > 0) ||
      result.filesRemoved > 0
    ) {
      refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
