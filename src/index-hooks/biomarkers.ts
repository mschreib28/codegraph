/**
 * Biomarker analysis hook — runs after every indexAll/sync to keep
 * `code_health_findings` in step with the source.
 *
 * Cheap on sync (only re-analyses files the sync touched). Capped
 * to a few seconds even on large indexAll runs by re-using the
 * cached tree-sitter parsers from the extraction pass.
 */

import type { IndexHook } from './types';
import type { SyncResult } from '../extraction';
import { analyseProject } from '../biomarkers';
import { logDebug } from '../errors';

export const HOOK: IndexHook = {
  name: 'biomarkers',
  async afterIndexAll(ctx) {
    if (ctx.config.enableBiomarkers === false) return;
    const result = await analyseProject(ctx.queries, ctx.projectRoot);
    logDebug('Biomarkers: indexAll', {
      files: result.filesScanned,
      symbols: result.symbolsAnalysed,
      findings: result.findingsEmitted,
      unsupportedLanguages: result.unsupportedLanguages,
      durationMs: result.durationMs,
    });
  },
  async afterSync(ctx, result: SyncResult) {
    if (ctx.config.enableBiomarkers === false) return;
    // Only re-analyse the files the sync actually touched; falling
    // back to a full scan if the sync didn't supply a list.
    const filePaths = result.changedFilePaths;
    const r = await analyseProject(ctx.queries, ctx.projectRoot, { filePaths });
    logDebug('Biomarkers: sync', {
      files: r.filesScanned,
      symbols: r.symbolsAnalysed,
      findings: r.findingsEmitted,
      durationMs: r.durationMs,
    });
  },
};
