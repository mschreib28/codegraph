/**
 * JSX — reuses the JavaScript extractor (the JS grammar handles JSX
 * via the same `tree-sitter-javascript.wasm` file).
 */
import { javascriptExtractor } from './javascript';
import type { LanguageDef } from './types';

export const JSX_DEF: LanguageDef = {
  name: 'jsx',
  displayName: 'JSX',
  extensions: ['.jsx'],
  includeGlobs: ['**/*.jsx'],
  grammar: { wasmFile: 'tree-sitter-javascript.wasm', extractor: javascriptExtractor },
};
