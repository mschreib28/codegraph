/**
 * Biomarker types — keep separate from the engine so a single import
 * doesn't drag the tree-sitter dispatch in for consumers that just
 * want to read findings out of the DB.
 */

/** Names of every biomarker the engine can emit. The DB CHECK
 *  constraint on `severity` is independent — a new biomarker only
 *  needs an entry here. */
export type BiomarkerName =
  | 'large_method'
  | 'complex_method'
  | 'nested_complexity'
  | 'complex_conditional'
  | 'brain_method'
  | 'long_parameter_list'
  | 'magic_number'
  | 'hardcoded_url'
  | 'unused_export';

export type Severity = 'info' | 'warning' | 'error';

export interface Finding {
  /** Node id from the `nodes` table the finding attaches to. */
  nodeId: string;
  biomarker: BiomarkerName;
  severity: Severity;
  /** Numeric metric the finding was raised on (LoC, max nesting,
   *  cyclomatic count, …). Lets agents reason about *how* bad. */
  metric: number;
  /** Free-form JSON-serialisable extra context. */
  detail?: unknown;
}
