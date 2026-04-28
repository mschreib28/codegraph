/**
 * Per-language tree-sitter node-kind sets the biomarker engine
 * consults. Tree-sitter grammars don't share a vocabulary across
 * languages, so each language maps its native node names onto a
 * small, normalised vocabulary the engine reasons about:
 *
 *   - branching:   nodes that add a new branch to cyclomatic complexity
 *                  (if/case/for/while/catch).
 *   - nesting:     nodes that add a new logical-nesting level.
 *   - boolean_op:  binary boolean operators (&&, ||) and similar — used
 *                  to count operands inside a conditional.
 *   - conditional: top-level conditional nodes whose internal boolean
 *                  operands feed the Complex Conditional biomarker.
 *
 * Languages without an entry get no biomarker findings — safe default.
 * Adding TS/JS first (most common in codebases this targets); other
 * languages can drop in by adding a key here.
 */

export interface LangMap {
  branching: ReadonlySet<string>;
  nesting: ReadonlySet<string>;
  booleanOp: ReadonlySet<string>;
  conditional: ReadonlySet<string>;
  /** Node kinds that count toward "the &&/|| operands inside a
   *  conditional" — for the Complex Conditional biomarker. Includes
   *  comparison operators since `(a > b && c < d || e === f)` has
   *  three comparisons + two boolean operators = 5 operands. */
  conditionalOperand: ReadonlySet<string>;
}

const TS_JS: LangMap = {
  branching: new Set([
    // McCabe counts each decision point that adds a path. `else_clause`
    // is the *implicit default* of an `if` and is NOT counted —
    // including it would inflate every if/else pair to +2.
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'switch_default',
    'catch_clause',
    'ternary_expression',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'catch_clause',
  ]),
  booleanOp: new Set([
    'binary_expression', // && / || are binary_expression with operator field
    'logical_expression',
  ]),
  conditional: new Set([
    'if_statement',
    'ternary_expression',
    'while_statement',
    'do_statement',
    'for_statement',
    'switch_statement',
  ]),
  conditionalOperand: new Set([
    'binary_expression',
    'logical_expression',
    'unary_expression',
    'identifier',
    'member_expression',
    'call_expression',
  ]),
};

const PY: LangMap = {
  branching: new Set([
    // McCabe excludes the implicit default — keep `if`, `elif`,
    // `except`, `case` (each adds a path) but NOT `else_clause` or
    // `try_statement` (the latter is the container; `except_clause`
    // is the actual decision point that gets counted).
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'case_clause',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'with_statement',
    'match_statement',
  ]),
  booleanOp: new Set(['boolean_operator']),
  conditional: new Set(['if_statement', 'conditional_expression', 'while_statement']),
  conditionalOperand: new Set([
    'comparison_operator',
    'boolean_operator',
    'identifier',
    'attribute',
    'call',
  ]),
};

const GO: LangMap = {
  branching: new Set([
    'if_statement',
    'for_statement',
    'expression_case',
    'default_case',
    'select_statement',
    'communication_case',
  ]),
  nesting: new Set(['if_statement', 'for_statement', 'switch_statement', 'select_statement']),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'for_statement']),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_expression',
    'identifier',
    'selector_expression',
    'call_expression',
  ]),
};

const JAVA: LangMap = {
  branching: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'switch_label',
    'catch_clause',
    'ternary_expression',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'switch_expression',
    'try_statement',
  ]),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'ternary_expression', 'while_statement', 'do_statement']),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_expression',
    'identifier',
    'field_access',
    'method_invocation',
  ]),
};

/**
 * Lookup table from codegraph's language identifier to the LangMap.
 * Language identifiers come from `Language` union in `src/types.ts`.
 */
const MAPS: Record<string, LangMap> = {
  typescript: TS_JS,
  javascript: TS_JS,
  tsx: TS_JS,
  jsx: TS_JS,
  python: PY,
  go: GO,
  java: JAVA,
};

export function getLangMap(language: string): LangMap | null {
  return MAPS[language] ?? null;
}
