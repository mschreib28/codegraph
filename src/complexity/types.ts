/**
 * Complexity analysis types.
 */

import { Language } from '../types';

export type ComplexityTool = 'eslint' | 'madge' | 'radon';
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
  eslint: boolean;
  madge: boolean;
  radon: boolean;
}

export interface AnalyzerContext {
  projectRoot: string;
  files: string[];           // project-relative file paths
  computedAt: number;
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
  durationMs: number;
}

export interface ComplexityProgress {
  phase: 'detecting' | 'analyzing' | 'storing';
  tool?: ComplexityTool;
  current: number;
  total: number;
}
