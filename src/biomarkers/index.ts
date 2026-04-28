/**
 * Biomarker analysis orchestrator.
 *
 * For every indexed function/method node, re-parses the source, finds
 * the AST node at its location, computes metrics, evaluates the rule
 * set, and writes findings to `code_health_findings`. Idempotent:
 * re-running clears the previous findings for each touched node.
 *
 * Designed to run as an `IndexHook` after extraction completes — the
 * heavy work is the re-parse, not the metric computation, so we
 * batch by file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { QueryBuilder } from '../db/queries';
import type { Language } from '../types';
import { logDebug, logWarn } from '../errors';
import { computeMetrics, evaluateRules, findNodeAt } from './engine';
import { getLangMap } from './lang-map';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import type { Finding } from './types';

export type { BiomarkerName, Finding, Severity } from './types';
export { computeMetrics, evaluateRules, codeHealthScore, findNodeAt } from './engine';

/** Symbol kinds the engine analyses. Skipped: import/export/variable/etc. */
const ANALYSABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

/** Skip absurdly tiny symbols — getters, one-liners aren't biomarker bait. */
const MIN_LOC = 5;

export interface AnalysisOptions {
  signal?: AbortSignal;
  /** Limit the analysis to a specific set of file paths (used by sync
   *  to avoid re-analysing the whole project for a one-file change). */
  filePaths?: ReadonlyArray<string>;
  onProgress?: (done: number, total: number) => void;
}

export interface AnalysisResult {
  filesScanned: number;
  symbolsAnalysed: number;
  findingsEmitted: number;
  unsupportedLanguages: number;
  errors: number;
  durationMs: number;
}

export async function analyseProject(
  queries: QueryBuilder,
  projectRoot: string,
  options: AnalysisOptions = {}
): Promise<AnalysisResult> {
  const t0 = Date.now();
  const fileFilter = options.filePaths ? new Set(options.filePaths) : null;

  // Pull every analysable symbol once. The DB scan is far cheaper
  // than re-parsing, so doing it in one shot is fine even on large
  // projects.
  const allFiles = queries.getAllFilePaths();
  const targetFiles = fileFilter
    ? allFiles.filter((f) => fileFilter.has(f))
    : allFiles;

  // Extraction runs in worker threads, but biomarker analysis runs
  // in the main process. Make sure the grammars we'll need are loaded
  // here, otherwise `getParser()` returns null and the engine silently
  // produces base metrics with no findings.
  const supportedLanguages = new Set<Language>();
  for (const file of targetFiles.slice(0, 200)) {
    const nodes = queries.getNodesByFile(file);
    if (nodes.length > 0) supportedLanguages.add(nodes[0]!.language as Language);
  }
  if (supportedLanguages.size > 0) {
    try {
      await loadGrammarsForLanguages([...supportedLanguages]);
    } catch (err) {
      logDebug('Biomarkers: grammar preload failed', { err: String(err) });
    }
  }

  let filesScanned = 0;
  let symbolsAnalysed = 0;
  let findingsEmitted = 0;
  let unsupportedLanguages = 0;
  let errors = 0;
  const total = targetFiles.length;

  for (const relPath of targetFiles) {
    if (options.signal?.aborted) break;

    let src: string;
    try {
      src = await fs.promises.readFile(path.join(projectRoot, relPath), 'utf-8');
    } catch (err) {
      // File deleted between index and analysis — skip silently.
      logDebug('Biomarkers: file unreadable', { path: relPath, err: String(err) });
      filesScanned++;
      options.onProgress?.(filesScanned, total);
      continue;
    }

    const nodes = queries.getNodesByFile(relPath);
    const analysable = nodes.filter((n) => ANALYSABLE_KINDS.has(n.kind));
    if (analysable.length === 0) {
      filesScanned++;
      options.onProgress?.(filesScanned, total);
      continue;
    }

    const language = analysable[0]!.language as Language;
    if (!getLangMap(language)) {
      unsupportedLanguages++;
      filesScanned++;
      options.onProgress?.(filesScanned, total);
      continue;
    }

    const findingsByNode = new Map<string, Finding[]>();
    for (const n of analysable) {
      const startLine = n.startLine;
      const endLine = n.endLine;
      const loc = endLine - startLine + 1;
      if (loc < MIN_LOC) continue;

      try {
        const astNode = findNodeAt(src, language, startLine, n.startColumn);
        if (!astNode) continue;
        const metrics = computeMetrics(astNode, language, startLine, endLine);
        const findings = evaluateRules({ nodeId: n.id, language, metrics });
        if (findings.length > 0) {
          findingsByNode.set(n.id, findings);
          findingsEmitted += findings.length;
        }
        symbolsAnalysed++;
      } catch (err) {
        errors++;
        logDebug('Biomarkers: rule evaluation failed', { node: n.id, err: String(err) });
      }
    }

    // Always call replace, even with an empty map. That way a file
    // that was previously flagged but is now clean (refactored below
    // all thresholds) has its stale findings dropped — `clean again`
    // is a real outcome the agent should see.
    try {
      queries.replaceFindingsForFile(relPath, findingsByNode);
    } catch (err) {
      errors++;
      logWarn('Biomarkers: persistence failed', { file: relPath, err: String(err) });
    }

    filesScanned++;
    options.onProgress?.(filesScanned, total);
  }

  return {
    filesScanned,
    symbolsAnalysed,
    findingsEmitted,
    unsupportedLanguages,
    errors,
    durationMs: Date.now() - t0,
  };
}
