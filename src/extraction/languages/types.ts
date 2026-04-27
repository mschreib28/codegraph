/**
 * Per-language registry types.
 *
 * Each language ships its own self-contained `LanguageDef` (file
 * extensions, default-config globs, grammar config, etc.) so that
 * adding a new language is a single-file addition rather than 6
 * coordinated edits across `types.ts`, `grammars.ts`, and the
 * `extraction/languages/index.ts` barrel. The registry
 * (`./registry`) auto-discovers definitions at module load.
 */

import type { LanguageExtractor } from '../tree-sitter-types';
import type { ExtractionResult } from '../../types';

/**
 * Custom extraction function for languages that don't fit the
 * universal tree-sitter AST shape (Liquid, Svelte, HCL, SQL,
 * Pascal DFM/FMX form files).
 */
export type CustomExtractorFn = (filePath: string, source: string) => ExtractionResult;

export interface GrammarBackedConfig {
  /**
   * WASM grammar filename. Resolved either against the
   * `tree-sitter-wasms` npm package or, if `vendored` is true,
   * against `src/extraction/wasm/`.
   */
  wasmFile: string;
  /**
   * True when the WASM is shipped under `src/extraction/wasm/`
   * because no pre-built grammar exists in `tree-sitter-wasms`.
   */
  vendored?: boolean;
  /**
   * Per-language tree-sitter extraction config consumed by
   * `TreeSitterExtractor`. The existing per-language objects
   * (e.g. `typescriptExtractor`) are passed in here unchanged.
   */
  extractor: LanguageExtractor;
}

export interface LanguageDef {
  /**
   * Canonical language name. Stored as the `language` value on
   * `Node`, `Edge`, and `FileRecord` rows. Should match an entry
   * in the `Language` union in `src/types.ts` for known
   * languages; new registry-only languages are accepted as
   * strings at runtime.
   */
  name: string;
  /** Human-readable display label (e.g. "HCL / Terraform"). */
  displayName: string;
  /**
   * File extensions, lower-cased, with leading dot. Each
   * extension uniquely maps to one language (caller should not
   * register the same extension twice).
   */
  extensions: readonly string[];
  /**
   * Default-config include glob patterns. Combined into
   * `DEFAULT_CONFIG.include` at registry load.
   */
  includeGlobs: readonly string[];
  /**
   * Tree-sitter grammar config. Absent for purely-custom
   * languages like Liquid (regex-based) and Svelte (script
   * delegation).
   */
  grammar?: GrammarBackedConfig;
  /**
   * Whole-language custom extractor. Used when `grammar` is
   * absent. If both are present, `extensionOverrides` and
   * `customExtractor` win over `grammar`.
   */
  customExtractor?: CustomExtractorFn;
  /**
   * Per-extension override. Used by Pascal where `.dfm`/`.fmx`
   * (form files) are extracted by `DfmExtractor` rather than the
   * tree-sitter Pascal grammar. Keys are lower-cased extensions
   * with the leading dot.
   */
  extensionOverrides?: Readonly<Record<string, { customExtractor: CustomExtractorFn }>>;
}
