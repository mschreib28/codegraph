/**
 * TSX (TypeScript + JSX) — reuses the TypeScript extractor with a
 * dedicated grammar so JSX-specific node types parse correctly.
 */
import { typescriptExtractor } from './typescript';
import type { LanguageDef } from './types';

export const TSX_DEF: LanguageDef = {
  name: 'tsx',
  displayName: 'TSX',
  extensions: ['.tsx'],
  includeGlobs: ['**/*.tsx'],
  grammar: { wasmFile: 'tree-sitter-tsx.wasm', extractor: typescriptExtractor },
};
