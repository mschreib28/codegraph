/**
 * Complexity analysis types.
 */

import { Language } from '../types';

export type ComplexityTool = 'native' | 'madge';
// 'cyclomatic' is currently the only metric emitted by any analyzer. The other
// values are reserved slots for future analyzers (madge fan-in/out/circular,
// future maintainability scorer).
export type ComplexityMetric =
  | 'cyclomatic'
  | 'maintainability'
  | 'fan_in'
  | 'fan_out'
  | 'is_circular';

/**
 * One complexity measurement. file-level metrics have nodeId = null.
 */
export interface ComplexityRecord {
  filePath: string;          // project-relative
  nodeId?: string | null;    // links to nodes.id when available
  symbolName?: string | null;
  startLine?: number | null;
  language: Language;
  tool: ComplexityTool;
  metric: ComplexityMetric;
  value: number;
  computedAt: number;
}

export interface ToolAvailability {
  /** madge is the only externally-detected tool now — used for fan-in/out + circular deps. */
  madge: boolean;
}

export interface AnalyzerWarning {
  filePath: string;
  reason: string;
  tool: ComplexityTool;
}

export interface AnalyzerContext {
  projectRoot: string;
  files: string[];           // project-relative file paths
  computedAt: number;
  /** Analyzers push per-file failures here so the orchestrator can surface them. */
  warnings: AnalyzerWarning[];
}

export interface LanguageAnalyzer {
  /** Languages this analyzer handles. */
  languages: Language[];
  /** Tool name used by this analyzer (for warnings). */
  tool: ComplexityTool;
  /** True if the underlying tool was found on the system. */
  available: boolean;
  /** Run the tool and return records. Files passed in are pre-filtered to handled languages. */
  analyze(ctx: AnalyzerContext): Promise<ComplexityRecord[]>;
}

export interface ComplexityRunSummary {
  filesAnalyzed: number;
  metricsRecorded: number;
  toolsRun: ComplexityTool[];
  toolsSkipped: { tool: ComplexityTool; reason: string }[];
  /** Per-file failures (parse error, unreadable file). Empty on a clean run. */
  warnings: AnalyzerWarning[];
  durationMs: number;
}

export interface ComplexityProgress {
  phase: 'detecting' | 'analyzing' | 'storing';
  tool?: ComplexityTool;
  current: number;
  total: number;
}
