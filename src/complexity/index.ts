/**
 * ComplexityAnalyzer
 *
 * Orchestrates the per-language complexity analyzers (native AST + madge) and
 * persists results into the `complexity_metrics` table. Mirrors the
 * ExtractionOrchestrator pattern.
 *
 * The native analyzer covers cyclomatic complexity for every tree-sitter
 * language codegraph already parses. madge stays as an optional supplement
 * for JS/TS dependency metrics (fan-in / fan-out / circular).
 */

import { CodeGraphConfig, Language } from '../types';
import { QueryBuilder } from '../db/queries';
import { scanDirectoryAsync } from '../extraction';
import { detectLanguage } from '../extraction/grammars';
import { detectAvailableTools } from './tool-detection';
import { createNativeAnalyzer } from './analyzers/native';
import { createMadgeAnalyzer } from './analyzers/madge';
import {
  AnalyzerContext,
  ComplexityProgress,
  ComplexityRecord,
  ComplexityRunSummary,
  ComplexityTool,
  LanguageAnalyzer,
  ToolAvailability,
} from './types';

export * from './types';
export { detectAvailableTools } from './tool-detection';

export interface AnalyzeOptions {
  /** Restrict to a single language (e.g. 'python') if set. */
  language?: Language;
  onProgress?: (p: ComplexityProgress) => void;
}

export class ComplexityAnalyzer {
  constructor(
    private projectRoot: string,
    private config: CodeGraphConfig,
    private queries: QueryBuilder
  ) {}

  async analyze(options: AnalyzeOptions = {}): Promise<ComplexityRunSummary> {
    const start = Date.now();
    const onProgress = options.onProgress;

    onProgress?.({ phase: 'detecting', current: 0, total: 1 });
    const tools = await detectAvailableTools(this.projectRoot);
    onProgress?.({ phase: 'detecting', current: 1, total: 1 });

    const allFiles = await scanDirectoryAsync(this.projectRoot, this.config);
    const filesByLang = groupByLanguage(allFiles, options.language);

    const computedAt = Date.now();
    const analyzers = buildAnalyzers(tools);

    const allRecords: ComplexityRecord[] = [];
    const toolsRun: ComplexityTool[] = [];
    const toolsSkipped: { tool: ComplexityTool; reason: string }[] = [];

    onProgress?.({ phase: 'analyzing', current: 0, total: analyzers.length });

    for (let i = 0; i < analyzers.length; i++) {
      const analyzer = analyzers[i]!;
      const files = collectFilesForAnalyzer(filesByLang, analyzer);
      if (files.length === 0) {
        onProgress?.({ phase: 'analyzing', tool: analyzer.tool, current: i + 1, total: analyzers.length });
        continue;
      }
      if (!analyzer.available) {
        toolsSkipped.push({ tool: analyzer.tool, reason: missingToolReason(analyzer.tool) });
        onProgress?.({ phase: 'analyzing', tool: analyzer.tool, current: i + 1, total: analyzers.length });
        continue;
      }
      const ctx: AnalyzerContext = {
        projectRoot: this.projectRoot,
        files,
        computedAt,
      };
      try {
        const records = await analyzer.analyze(ctx);
        allRecords.push(...records);
        toolsRun.push(analyzer.tool);
      } catch (err) {
        toolsSkipped.push({
          tool: analyzer.tool,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      onProgress?.({ phase: 'analyzing', tool: analyzer.tool, current: i + 1, total: analyzers.length });
    }

    onProgress?.({ phase: 'storing', current: 0, total: allRecords.length });
    if (allRecords.length > 0) {
      // Replace any prior data so a re-run reflects current state.
      this.queries.clearComplexityMetrics();
      this.queries.insertComplexityRecords(allRecords);

      // Match records to graph nodes where possible (best-effort, doesn't block).
      this.queries.linkComplexityToNodes();
    }
    onProgress?.({ phase: 'storing', current: allRecords.length, total: allRecords.length });

    const filesAnalyzed = new Set(allRecords.map(r => r.filePath)).size;

    return {
      filesAnalyzed,
      metricsRecorded: allRecords.length,
      toolsRun,
      toolsSkipped,
      durationMs: Date.now() - start,
    };
  }
}

function buildAnalyzers(tools: ToolAvailability): LanguageAnalyzer[] {
  return [
    createNativeAnalyzer(),
    createMadgeAnalyzer(tools.madge),
  ];
}

function groupByLanguage(files: string[], filter?: Language): Map<Language, string[]> {
  const map = new Map<Language, string[]>();
  for (const file of files) {
    const lang = detectLanguage(file);
    if (lang === 'unknown') continue;
    if (filter && lang !== filter) continue;
    let bucket = map.get(lang);
    if (!bucket) { bucket = []; map.set(lang, bucket); }
    bucket.push(file);
  }
  return map;
}

function collectFilesForAnalyzer(
  byLang: Map<Language, string[]>,
  analyzer: LanguageAnalyzer
): string[] {
  const out: string[] = [];
  for (const lang of analyzer.languages) {
    const bucket = byLang.get(lang);
    if (bucket) out.push(...bucket);
  }
  return out;
}

function missingToolReason(tool: ComplexityTool): string {
  switch (tool) {
    case 'madge': return 'madge not found — install with `npm i -D madge`';
    case 'native': return 'native AST analyzer unavailable (this should not happen)';
  }
}
