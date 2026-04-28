/**
 * Biomarker analysis orchestrator.
 *
 * For every indexed function/method node, finds the AST node at its
 * location, computes metrics, evaluates the rule set, and writes
 * findings to `code_health_findings`. Idempotent: re-running clears
 * the previous findings for each touched node.
 *
 * Designed to run as an `IndexHook` after extraction completes. Each
 * file is parsed *once* and the resulting tree is reused for every
 * symbol in that file — re-parsing per symbol exhausts the WASM
 * tree-sitter heap on real codebases (we observed thousands of
 * "memory access out of bounds" crashes on Ollama's vendored
 * llama.cpp before this).
 */

import * as fs from 'fs';
import * as path from 'path';
import { QueryBuilder } from '../db/queries';
import type { Language } from '../types';
import { logDebug, logWarn } from '../errors';
import {
  computeMetrics,
  evaluateRules,
  findNodeInTree,
  parseSource,
} from './engine';
import { getLangMap } from './lang-map';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import type { Finding } from './types';

export type { BiomarkerName, Finding, Severity } from './types';
export {
  computeMetrics,
  evaluateRules,
  codeHealthScore,
  findNodeAt,
  findNodeInTree,
  parseSource,
} from './engine';

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

/**
 * Run one cross-file biomarker rule: clear all existing findings of
 * its kind, recompute via `produce`, and append the new set — atomic
 * so concurrent readers never see the intermediate empty window.
 *
 * Returns the count of findings emitted (for the caller's
 * findingsEmitted accumulator). Errors are caught + reported via
 * `onError` so one broken rule doesn't abort the whole pass.
 */
function runCrossFileRule(
  queries: QueryBuilder,
  kind: string,
  produce: () => Finding[],
  onError: (count: number) => void
): number {
  try {
    const findings = produce();
    queries.transaction(() => {
      queries.clearFindingsByKind(kind);
      queries.appendFindings(findings);
    });
    return findings.length;
  } catch (err) {
    onError(1);
    logDebug(`Biomarkers: cross-file rule '${kind}' failed`, { err: String(err) });
    return 0;
  }
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

    // Parse the file ONCE, reuse the tree across every symbol in it.
    // Re-parsing per symbol used to allocate WASM tree-sitter memory
    // unboundedly and crash with "memory access out of bounds" after
    // a few thousand symbols on big C/C++ files.
    let tree;
    try {
      tree = parseSource(src, language);
    } catch (err) {
      errors++;
      logDebug('Biomarkers: parse failed', { path: relPath, err: String(err) });
      filesScanned++;
      options.onProgress?.(filesScanned, total);
      continue;
    }
    if (!tree) {
      // Grammar not loaded for this language — already reported as
      // unsupportedLanguages above when the langMap is missing; for
      // other "no parser" cases just skip silently.
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
        const astNode = findNodeInTree(tree, startLine, n.startColumn);
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

  // Cross-file rules: depend on global graph state, so they run only
  // on full scans (not partial syncs). replaceFindingsForFile is now
  // configured to preserve every cross-file biomarker kind on per-file
  // replace, so the existing findings remain valid between full passes.
  if (!fileFilter) {
    findingsEmitted += runCrossFileRule(
      queries,
      'unused_export',
      () =>
        queries.findUnusedExports().map((sym) => ({
          nodeId: sym.id,
          biomarker: 'unused_export' as const,
          severity: 'warning' as const,
          metric: 0,
          detail: { kind: sym.kind, name: sym.name },
        })),
      (count) => {
        errors += count;
      }
    );

    // god_class — class-like nodes with too many member children.
    // Thresholds informed by Lanza/Marinescu and CodeScene's
    // published WMC ranges, conservative end (we'd rather under-flag
    // than spam findings on a fresh codebase).
    const T_GOD_INFO = 15;
    const T_GOD_WARN = 25;
    const T_GOD_ERR = 40;
    findingsEmitted += runCrossFileRule(
      queries,
      'god_class',
      () =>
        queries.findGodClasses(T_GOD_INFO).map((c) => {
          const sev: 'info' | 'warning' | 'error' =
            c.memberCount >= T_GOD_ERR
              ? 'error'
              : c.memberCount >= T_GOD_WARN
                ? 'warning'
                : 'info';
          return {
            nodeId: c.id,
            biomarker: 'god_class' as const,
            severity: sev,
            metric: c.memberCount,
            detail: { name: c.name },
          };
        }),
      (count) => {
        errors += count;
      }
    );

    // feature_envy — methods that call into other files at least
    // 5× and at least 2× more than into their own file. The 5×
    // floor avoids flagging tiny helper methods; the 2× ratio is
    // a robust threshold from the literature.
    const FE_MIN_EXTERNAL = 5;
    const FE_RATIO = 2;
    findingsEmitted += runCrossFileRule(
      queries,
      'feature_envy',
      () =>
        queries.findFeatureEnvy(FE_MIN_EXTERNAL, FE_RATIO).map((m) => ({
          nodeId: m.id,
          biomarker: 'feature_envy' as const,
          severity:
            m.externalCalls >= 20
              ? 'warning'
              : 'info',
          metric: m.externalCalls,
          detail: { name: m.name, sameFileCalls: m.sameFileCalls },
        })),
      (count) => {
        errors += count;
      }
    );
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
