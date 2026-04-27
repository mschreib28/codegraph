/**
 * HCL / Terraform — custom extractor that runs on top of the
 * tree-sitter-hcl WASM grammar. The block-shape of HCL doesn't fit
 * the universal function/class extractor, so HclExtractor handles it
 * directly.
 */
import { HclExtractor } from '../hcl-extractor';
import type { LanguageDef } from './types';

export const HCL_DEF: LanguageDef = {
  name: 'hcl',
  displayName: 'HCL / Terraform',
  extensions: ['.tf', '.tfvars', '.hcl'],
  includeGlobs: ['**/*.tf', '**/*.tfvars', '**/*.hcl'],
  // HCL needs both a tree-sitter parser (vendored WASM, not on
  // tree-sitter-wasms) AND a custom extractor — the parse tree is
  // standard but the extraction logic is bespoke.
  grammar: {
    wasmFile: 'tree-sitter-hcl.wasm',
    vendored: true,
    // Universal extractor is unused (custom path takes over) but
    // the type requires it; supply a no-op skeleton.
    extractor: {
      functionTypes: [],
      classTypes: [],
      methodTypes: [],
      interfaceTypes: [],
      structTypes: [],
      enumTypes: [],
      typeAliasTypes: [],
      importTypes: [],
      callTypes: [],
      variableTypes: [],
      nameField: 'name',
      bodyField: 'body',
      paramsField: 'parameters',
    },
  },
  customExtractor: (filePath, source) => new HclExtractor(filePath, source).extract(),
};
