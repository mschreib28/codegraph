import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const goExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [], // Go doesn't have classes
  methodTypes: ['method_declaration'],
  interfaceTypes: [],  // Handled via type_spec → resolveTypeAliasKind
  structTypes: [],     // Handled via type_spec → resolveTypeAliasKind
  enumTypes: [],
  typeAliasTypes: ['type_spec'], // Go type declarations
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['var_declaration', 'short_var_declaration', 'const_declaration'],
  methodsAreTopLevel: true,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'result',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const result = getChildByField(node, 'result');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (result) {
      sig += ' ' + getNodeText(result, source);
    }
    return sig;
  },
  resolveTypeAliasKind: (node, _source) => {
    // Go type_spec: `type Foo struct { ... }` or `type Bar interface { ... }`
    // The inner type is in the 'type' field of the type_spec node
    const typeChild = getChildByField(node, 'type');
    if (!typeChild) return undefined;
    if (typeChild.type === 'struct_type') return 'struct';
    if (typeChild.type === 'interface_type') return 'interface';
    return undefined;
  },
  extractVariables: (node, source) => {
    const results = [];

    const isConstDecl = node.type === 'const_declaration';
    const specs = node.namedChildren.filter(c => c.type === 'var_spec' || c.type === 'const_spec');
    for (const spec of specs) {
      const nameNode = spec.namedChild(0);
      if (!nameNode || nameNode.type !== 'identifier') continue;
      const name = getNodeText(nameNode, source);
      const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
      const initValue = valueNode ? getNodeText(valueNode, source).slice(0, 100) : undefined;
      const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
      results.push({ name, kind: isConstDecl ? 'constant' : 'variable', signature: initSignature, positionNode: spec } as const);
    }

    if (node.type === 'short_var_declaration') {
      const left = getChildByField(node, 'left');
      const right = getChildByField(node, 'right');
      if (left) {
        const identifiers = left.type === 'expression_list'
          ? left.namedChildren.filter(c => c.type === 'identifier')
          : [left];
        for (const id of identifiers) {
          const name = getNodeText(id, source);
          const initValue = right ? getNodeText(right, source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
          results.push({ name, kind: 'variable' as const, signature: initSignature });
        }
      }
    }

    return results;
  },
  getReceiverType: (node, source) => {
    // Go method_declaration has a "receiver" field: func (sl *scrapeLoop) run(...)
    // The receiver is a parameter_list containing a parameter_declaration
    // with a type that may be a pointer_type (*scrapeLoop) or plain type (scrapeLoop)
    const receiver = getChildByField(node, 'receiver');
    if (!receiver) return undefined;
    // Find the type identifier inside the receiver
    const text = getNodeText(receiver, source);
    // Extract type name from patterns like "(sl *Type)", "(sl Type)", "(*Type)", "(Type)"
    const match = text.match(/\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    return match?.[1];
  },
};
