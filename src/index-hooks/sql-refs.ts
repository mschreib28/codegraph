/**
 * SQL-refs index hook — extracts SQL string-literal references to
 * tables (read/write/ddl) and persists to `sql_refs`. Incremental
 * on sync; full atomic replace on indexAll. See `src/sql-refs/`.
 */

import type { IndexHook, IndexHookContext } from './registry';
import type { SyncResult } from '../extraction';
import { extractSqlRefs } from '../sql-refs';
import { logDebug } from '../errors';

function refresh(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] }
): void {
  if (ctx.config.enableSqlRefs === false) return;
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

    if (options.scope === 'all') {
      const targets = ctx.queries.getAllFiles().map((f) => ({
        path: f.path,
        language: f.language,
      }));
      const refs = extractSqlRefs(ctx.projectRoot, targets, resolveEnclosing);
      ctx.queries.replaceAllSqlRefs(refs);
    } else {
      const records = options.files
        .map((p) => ctx.queries.getFileByPath(p))
        .filter((f): f is NonNullable<typeof f> => f != null);
      const targets = records.map((f) => ({ path: f.path, language: f.language }));
      ctx.queries.pruneOrphanedSqlRefs();
      if (targets.length > 0) {
        ctx.queries.deleteSqlRefsForPaths(targets.map((t) => t.path));
      }
      const refs = extractSqlRefs(ctx.projectRoot, targets, resolveEnclosing);
      ctx.queries.applySqlRefs(refs);
    }
  } catch (err) {
    logDebug(`sql-refs hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'sql-refs',
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
