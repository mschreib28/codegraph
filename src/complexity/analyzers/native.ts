/**
 * Native cyclomatic-complexity analyzer.
 *
 * Walks the tree-sitter ASTs that codegraph already produces during indexing
 * and counts decision points per function. No external tool required, so it
 * works for every language with a tree-sitter grammar — including Angular and
 * other TypeScript projects where the previous ESLint-based path silently
 * produced zero metrics on flat-config v9.
 *
 * Cyclomatic complexity = 1 + sum of decision points inside the function body,
 * stopping at nested function boundaries (so nested closures get their own
 * count rather than inflating the outer function's number).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node as TSNode } from 'web-tree-sitter';
import { Language } from '../../types';
import { getParser, initGrammars, loadGrammarsForLanguages, detectLanguage } from '../../extraction/grammars';
import { AnalyzerContext, ComplexityRecord, LanguageAnalyzer } from '../types';

interface LanguageRule {
  /** Node types whose subtree is one cyclomatic-complexity unit. */
  functionNodes: Set<string>;
  /** Node types that add +1 to the enclosing function's CC. */
  decisionNodes: Set<string>;
  /**
   * Node types whose `operator` field text counts as a decision when it
   * matches one of these strings. Covers `&&`, `||`, `??`, etc.
   */
  binaryOps: { nodeTypes: Set<string>; operators: Set<string> };
  /**
   * Field on a function node that holds its name. `null` for languages where
   * we want to keep the symbol anonymous everywhere (rare).
   */
  nameField: string | null;
}

const LANGUAGE_RULES: Partial<Record<Language, LanguageRule>> = {
  // tree-sitter-javascript / tree-sitter-typescript share most node names.
  typescript: jsLikeRules(),
  tsx: jsLikeRules(),
  javascript: jsLikeRules(),
  jsx: jsLikeRules(),

  python: {
    functionNodes: new Set(['function_definition', 'lambda']),
    decisionNodes: new Set([
      'if_statement',
      'elif_clause',
      'for_statement',
      'while_statement',
      'except_clause',
      'case_clause',
      'conditional_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['boolean_operator']),
      operators: new Set(['and', 'or']),
    },
    nameField: 'name',
  },

  go: {
    functionNodes: new Set(['function_declaration', 'method_declaration', 'func_literal']),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'expression_case',
      'default_case',
      'type_case',
      'communication_case',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'name',
  },

  rust: {
    functionNodes: new Set(['function_item', 'closure_expression']),
    decisionNodes: new Set([
      'if_expression',
      'match_arm',
      'while_expression',
      'for_expression',
      'loop_expression',
      'try_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'name',
  },

  java: {
    functionNodes: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'enhanced_for_statement',
      'while_statement',
      'do_statement',
      'switch_block_statement_group',
      'catch_clause',
      'ternary_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'name',
  },

  c: cLikeRules(),
  cpp: {
    ...cLikeRules(),
    functionNodes: new Set(['function_definition', 'lambda_expression']),
  },

  csharp: {
    functionNodes: new Set([
      'method_declaration',
      'constructor_declaration',
      'local_function_statement',
      'lambda_expression',
      'anonymous_method_expression',
    ]),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'for_each_statement',
      'while_statement',
      'do_statement',
      'switch_section',
      'catch_clause',
      'conditional_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||', '??']),
    },
    nameField: 'name',
  },

  php: {
    functionNodes: new Set([
      'function_definition',
      'method_declaration',
      'arrow_function',
      'anonymous_function',
      'anonymous_function_creation_expression',
    ]),
    decisionNodes: new Set([
      'if_statement',
      'else_if_clause',
      'for_statement',
      'foreach_statement',
      'while_statement',
      'do_statement',
      'case_statement',
      'catch_clause',
      'conditional_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||', 'and', 'or', 'xor', '??']),
    },
    nameField: 'name',
  },

  ruby: {
    functionNodes: new Set(['method', 'singleton_method', 'lambda', 'block', 'do_block']),
    decisionNodes: new Set([
      'if',
      'elsif',
      'unless',
      'while',
      'until',
      'for',
      'when',
      'rescue',
      'conditional',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary']),
      operators: new Set(['&&', '||', 'and', 'or']),
    },
    nameField: 'name',
  },

  swift: {
    functionNodes: new Set(['function_declaration', 'init_declaration', 'lambda_literal']),
    decisionNodes: new Set([
      'if_statement',
      'guard_statement',
      'for_statement',
      'while_statement',
      'repeat_while_statement',
      'switch_entry',
      'catch_clause',
    ]),
    binaryOps: {
      nodeTypes: new Set(['conjunction_expression', 'disjunction_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'name',
  },

  kotlin: {
    functionNodes: new Set(['function_declaration', 'anonymous_function', 'lambda_literal']),
    decisionNodes: new Set([
      'if_expression',
      'when_entry',
      'for_statement',
      'while_statement',
      'do_while_statement',
      'catch_block',
    ]),
    binaryOps: {
      nodeTypes: new Set(['conjunction_expression', 'disjunction_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'name',
  },

  dart: {
    functionNodes: new Set([
      'function_signature',
      'method_signature',
      'function_expression',
      'function_declaration',
    ]),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'while_statement',
      'do_statement',
      'switch_case',
      'switch_default',
      'catch_clause',
      'conditional_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression', 'logical_and_expression', 'logical_or_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'name',
  },

  pascal: {
    functionNodes: new Set([
      'function_declaration',
      'procedure_declaration',
      'method_implementation',
      'function',
      'procedure',
    ]),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'while_statement',
      'repeat_statement',
      'case_item',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['and', 'or']),
    },
    nameField: 'name',
  },
};

function jsLikeRules(): LanguageRule {
  return {
    functionNodes: new Set([
      'function_declaration',
      'function_expression',
      'arrow_function',
      'method_definition',
      'generator_function_declaration',
      'generator_function',
      'function',
    ]),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'for_in_statement',
      'while_statement',
      'do_statement',
      'switch_case',
      'catch_clause',
      'ternary_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||', '??']),
    },
    nameField: 'name',
  };
}

function cLikeRules(): LanguageRule {
  return {
    functionNodes: new Set(['function_definition']),
    decisionNodes: new Set([
      'if_statement',
      'for_statement',
      'while_statement',
      'do_statement',
      'case_statement',
      'conditional_expression',
    ]),
    binaryOps: {
      nodeTypes: new Set(['binary_expression']),
      operators: new Set(['&&', '||']),
    },
    nameField: 'declarator',
  };
}

const SUPPORTED_LANGUAGES: Language[] = Object.keys(LANGUAGE_RULES) as Language[];

interface FunctionEntry {
  node: TSNode;
  rule: LanguageRule;
  count: number;
}

function getFunctionName(node: TSNode, rule: LanguageRule): string | null {
  if (!rule.nameField) return null;
  const named = node.childForFieldName(rule.nameField);
  if (!named) return null;
  // C/C++ name lives nested inside the declarator subtree — descend until we hit
  // an identifier, otherwise return the whole declarator text as a fallback.
  if (rule.nameField === 'declarator') {
    const ident = findFirstIdentifier(named);
    if (ident) return ident.text;
    return named.text || null;
  }
  return named.text || null;
}

function findFirstIdentifier(node: TSNode): TSNode | null {
  if (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier') {
    return node;
  }
  for (const child of node.namedChildren) {
    if (!child) continue;
    const found = findFirstIdentifier(child);
    if (found) return found;
  }
  return null;
}

function analyzeFile(
  filePath: string,
  content: string,
  language: Language,
  computedAt: number
): ComplexityRecord[] {
  const rule = LANGUAGE_RULES[language];
  if (!rule) return [];

  const parser = getParser(language);
  if (!parser) return [];

  const tree = parser.parse(content);
  if (!tree) return [];

  const records: ComplexityRecord[] = [];
  const stack: FunctionEntry[] = [];

  function walk(node: TSNode): void {
    const isFunction = rule!.functionNodes.has(node.type);

    if (isFunction) {
      stack.push({ node, rule: rule!, count: 1 });
    } else if (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (rule!.decisionNodes.has(node.type)) {
        top.count += 1;
      } else if (rule!.binaryOps.nodeTypes.has(node.type)) {
        const opNode = node.childForFieldName('operator');
        const op = opNode?.text;
        if (op && rule!.binaryOps.operators.has(op)) {
          top.count += 1;
        }
      }
    }

    for (const child of node.namedChildren) {
      if (!child) continue;
      walk(child);
    }

    if (isFunction) {
      const entry = stack.pop()!;
      records.push({
        filePath,
        symbolName: getFunctionName(entry.node, entry.rule),
        startLine: entry.node.startPosition.row + 1,
        language,
        tool: 'native',
        metric: 'cyclomatic',
        value: entry.count,
        computedAt,
      });
    }
  }

  walk(tree.rootNode);
  return records;
}

export function createNativeAnalyzer(): LanguageAnalyzer {
  return {
    languages: SUPPORTED_LANGUAGES,
    tool: 'native',
    available: true,
    async analyze(ctx: AnalyzerContext): Promise<ComplexityRecord[]> {
      if (ctx.files.length === 0) return [];

      // Parsers are loaded lazily per language. Initialize the WASM runtime
      // and load only the grammars we actually need for this batch.
      await initGrammars();
      const filesByLanguage = new Map<Language, string[]>();
      for (const file of ctx.files) {
        const lang = detectLanguage(file);
        if (!LANGUAGE_RULES[lang]) continue;
        let bucket = filesByLanguage.get(lang);
        if (!bucket) { bucket = []; filesByLanguage.set(lang, bucket); }
        bucket.push(file);
      }
      await loadGrammarsForLanguages([...filesByLanguage.keys()]);

      const records: ComplexityRecord[] = [];
      for (const [language, files] of filesByLanguage) {
        for (const relPath of files) {
          const fullPath = path.isAbsolute(relPath)
            ? relPath
            : path.join(ctx.projectRoot, relPath);
          let content: string;
          try {
            content = fs.readFileSync(fullPath, 'utf-8');
          } catch {
            continue;
          }
          try {
            records.push(...analyzeFile(relPath, content, language, ctx.computedAt));
          } catch {
            // A single pathological file shouldn't kill the whole run.
            continue;
          }
        }
      }
      return records;
    },
  };
}
