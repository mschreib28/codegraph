/**
 * Biomarker analysis engine.
 *
 * Walks the tree-sitter AST of a single function/method and computes:
 *   - line count (LoC) — for Large Method
 *   - cyclomatic complexity — count of branching nodes + 1
 *   - maximum nesting depth — for Nested Complexity
 *   - per-conditional operand count — for Complex Conditional
 *
 * The biomarker definitions in `./biomarkers/<name>.ts` consume these
 * metrics and decide whether to emit a Finding.
 */

import type { Node as TsNode, Tree } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';
import type { Language } from '../types';
import { getLangMap, LangMap } from './lang-map';
import type { Finding, Severity } from './types';

export interface SymbolMetrics {
  /** LoC = endLine - startLine + 1 (the symbol's source span). */
  loc: number;
  /** Cyclomatic complexity: 1 + number of branching nodes inside the
   *  symbol's body. */
  cyclomatic: number;
  /** Deepest nesting count seen below the symbol's outer block. */
  maxNesting: number;
  /** Operand count of the most-complex conditional inside the symbol
   *  body. 0 if the symbol contains no conditional. */
  maxConditionalOperands: number;
  /** Number of formal parameters declared on the symbol's signature.
   *  Counted from the AST during {@link computeMetrics}. */
  paramCount: number;
  /** Count of numeric literals inside the body that are NOT part of
   *  a small allow-list (0, 1, -1, 2). Used by the magic_number rule. */
  magicNumberCount: number;
  /** Count of URL-like string literals inside the body — `http://…`,
   *  `https://…`, `ws://…`, `wss://…`. Used by the hardcoded_url rule. */
  hardcodedUrlCount: number;
}

const CYCLOMATIC_BASE = 1;

/**
 * Compute metrics for a symbol body. Walks the AST iteratively so deep
 * trees don't blow the JS stack. Returns conservative numbers when the
 * language has no LangMap entry — caller can decide whether to emit.
 */
export function computeMetrics(
  bodyNode: TsNode,
  language: Language,
  startLine: number,
  endLine: number
): SymbolMetrics {
  const map = getLangMap(language);
  const loc = Math.max(0, endLine - startLine + 1);
  if (!map) {
    return {
      loc,
      cyclomatic: CYCLOMATIC_BASE,
      maxNesting: 0,
      maxConditionalOperands: 0,
      paramCount: 0,
      magicNumberCount: 0,
      hardcodedUrlCount: 0,
    };
  }

  let cyclomatic = CYCLOMATIC_BASE;
  let maxNesting = 0;
  let maxConditionalOperands = 0;
  let magicNumberCount = 0;
  let hardcodedUrlCount = 0;

  const paramCount = countParameters(bodyNode);

  // Iterative DFS: stack of (node, depth) pairs.
  const stack: Array<{ node: TsNode; depth: number }> = [{ node: bodyNode, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const k = node.type;

    if (map.branching.has(k)) cyclomatic++;
    if (map.nesting.has(k)) {
      const newDepth = depth + 1;
      if (newDepth > maxNesting) maxNesting = newDepth;
      // Push children at the new depth.
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i);
        if (child) stack.push({ node: child, depth: newDepth });
      }
      continue;
    }
    // Conditional-operand counting: if this node is a top-level
    // conditional expression, look at its condition subtree and count
    // boolean / comparison operands.
    if (map.conditional.has(k)) {
      const ops = countConditionalOperands(node, map);
      if (ops > maxConditionalOperands) maxConditionalOperands = ops;
    }
    if (NUMBER_LITERAL_KINDS.has(k)) {
      const text = node.text;
      if (text && isMagicNumber(text)) magicNumberCount++;
    }
    if (STRING_LITERAL_KINDS.has(k)) {
      const text = node.text;
      if (text && URL_LITERAL_RE.test(text)) hardcodedUrlCount++;
    }
    // Push children at same depth.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, depth });
    }
  }

  return {
    loc,
    cyclomatic,
    maxNesting,
    maxConditionalOperands,
    paramCount,
    magicNumberCount,
    hardcodedUrlCount,
  };
}

/**
 * Tree-sitter node types that represent literal numbers across the
 * supported languages. Kept conservative — only types that are
 * unambiguously a numeric literal in expression position.
 */
const NUMBER_LITERAL_KINDS: ReadonlySet<string> = new Set([
  'number',           // typescript / javascript / tsx / jsx
  'numeric_literal',  // python / rust / php
  'integer_literal',  // rust / kotlin
  'float_literal',    // rust / go
  'int_literal',      // go
  'float_literal',    // go (duplicate but harmless in a Set)
  'integer',          // ruby
  'decimal_integer_literal', // java / kotlin
  'hex_integer_literal',     // java / kotlin
  'real_literal',     // c#
  'integer_literal',  // c#
]);

/** Tree-sitter node types that represent string literals. */
const STRING_LITERAL_KINDS: ReadonlySet<string> = new Set([
  'string',
  'string_literal',
  'raw_string_literal',
  'interpreted_string_literal',
  'template_string',
]);

/**
 * URL detection — kept tight to avoid false positives. Matches a
 * scheme + `://` + at least one path char. Schemes deliberately
 * limited to the ones that actually represent network endpoints
 * worth flagging in source code.
 */
const URL_LITERAL_RE = /\b(?:https?|wss?|ftp|s3|gs):\/\/[^\s'"`)]+/;

/**
 * "Magic number" classifier. Returns true when a numeric literal is
 * worth flagging — anything that isn't in the small allow-list of
 * truly trivial constants (0, 1, -1, 2). Hex/binary/octal literals
 * are flagged unconditionally on the same theory: a value worth
 * writing in non-decimal base is rarely incidental.
 */
function isMagicNumber(text: string): boolean {
  const trimmed = text.replace(/_/g, '').toLowerCase();
  if (trimmed === '0' || trimmed === '1' || trimmed === '-1' || trimmed === '2') return false;
  if (trimmed === '0.0' || trimmed === '1.0' || trimmed === '-1.0') return false;
  return true;
}

/**
 * Count formal parameters on a function/method declaration. Walks the
 * immediate children looking for a `formal_parameters` / `parameters`
 * / `parameter_list` node, then counts its named children.
 *
 * Returns 0 when the node has no recognisable parameter list (e.g.
 * arrow functions with a single shorthand identifier are counted as 1
 * directly).
 */
function countParameters(funcNode: TsNode): number {
  // Only DECLARATION-site parameter list kinds. `argument_list` is
  // intentionally excluded — that's a call-site node and including it
  // would make a function whose body contains a call to a 7-arg
  // function spuriously look like a 7-param function.
  const PARAM_LIST_KINDS = new Set([
    'formal_parameters',
    'parameters',
    'parameter_list',
    'parameter_declaration_list',
    'function_parameters',
  ]);
  // Single-identifier arrow function form: `x => ...`
  // tree-sitter for JS/TS gives the identifier as a direct child
  // of the arrow_function with no parameter list wrapper.
  if (funcNode.type === 'arrow_function' && funcNode.childCount > 0) {
    const first = funcNode.child(0);
    if (first?.type === 'identifier') return 1;
  }
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (!child) continue;
    if (PARAM_LIST_KINDS.has(child.type)) {
      let count = 0;
      for (let j = 0; j < child.namedChildCount; j++) {
        const p = child.namedChild(j);
        if (!p) continue;
        // Skip pure punctuation children if the grammar gives them
        // names (e.g. `comment` between params).
        if (p.type === 'comment') continue;
        count++;
      }
      return count;
    }
  }
  return 0;
}

/**
 * Count operands inside a conditional expression. The "operand" is
 * any node that contributes a truthiness check or value comparison —
 * roughly, anything that would show up in a boolean expression's
 * abstract syntax. Counts each boolean operator AND its operands so
 * a 3-clause `&&` chain returns 3, not 2.
 */
function countConditionalOperands(condNode: TsNode, map: LangMap): number {
  let count = 0;
  const stack: TsNode[] = [condNode];
  // Walk the conditional's children only — never descend into a
  // nested function body. `if (arr.find(x => x.a && x.b))` should
  // count the call/identifier operands in the outer test, not the
  // inner `&&` inside the lambda — that's a separate conditional
  // belonging to the lambda's own analysis.
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node !== condNode && FUNCTION_CONTAINER_KINDS.has(node.type)) continue;
    if (map.booleanOp.has(node.type) || map.conditionalOperand.has(node.type)) {
      if (
        node.childCount === 0 ||
        ['identifier', 'member_expression', 'attribute', 'call', 'call_expression', 'field_access', 'method_invocation', 'selector_expression'].includes(node.type)
      ) {
        count++;
        continue;
      }
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  // At least 1 — even a trivial `if (x)` has one operand.
  return Math.max(count, 1);
}

/**
 * Re-parse a file's source and find the tree-sitter node whose span
 * starts at the given line/column. Used to map a `nodes`-table row
 * (which has start_line/start_column) back to the AST node that
 * produced it.
 *
 * Returns null if the language has no parser available (e.g. WASM
 * grammar not loaded) or if no node starts at that exact position.
 */
/** Tree-sitter node kinds that count as a "function/method container"
 *  whose body we want to analyse. Cross-language; missing entries fall
 *  through to the start-position match heuristic. */
const FUNCTION_CONTAINER_KINDS = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'method',
  'function_definition',
  'function',
  'function_item',
  'method_declaration',
  'constructor_declaration',
  'generator_function_declaration',
]);

/**
 * Parse a file once. Callers analysing many symbols in the same file
 * should call this once and reuse the returned tree across
 * `findNodeInTree` invocations — re-parsing on every symbol exhausts
 * the WASM tree-sitter heap on large C/C++ files (hundreds of
 * "memory access out of bounds" crashes per indexAll on real
 * codebases).
 *
 * Returns null when the language has no loaded parser.
 */
export function parseSource(source: string, language: Language): Tree | null {
  const parser = getParser(language);
  if (!parser) return null;
  return parser.parse(source) ?? null;
}

/**
 * Locate the AST node corresponding to a symbol at `(line, column)`
 * inside a pre-parsed tree. See {@link findNodeAt} for the legacy
 * one-shot variant.
 */
export function findNodeInTree(
  tree: Tree,
  line: number,
  column: number
): TsNode | null {
  // tree-sitter rows are 0-indexed; codegraph stores 1-indexed lines.
  const row = Math.max(0, line - 1);
  const target = tree.rootNode.descendantForPosition(
    { row, column },
    { row, column }
  );
  if (!target) return null;
  // descendantForPosition returns the smallest node that contains the
  // point — often a keyword like `function`. Walk up to the nearest
  // named ancestor that's a function/method container.
  let candidate: TsNode | null = target;
  while (candidate) {
    if (FUNCTION_CONTAINER_KINDS.has(candidate.type) && candidate.isNamed) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  // Fallback: the first named ancestor whose start matches the
  // requested position. Catches custom node kinds not in the set above.
  candidate = target;
  while (candidate) {
    if (
      candidate.isNamed &&
      candidate.startPosition.row === row &&
      candidate.startPosition.column === column
    ) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  return target;
}

export function findNodeAt(
  source: string,
  language: Language,
  line: number,
  column: number
): TsNode | null {
  const tree = parseSource(source, language);
  if (!tree) return null;
  return findNodeInTree(tree, line, column);
}

// -----------------------------------------------------------------------------
// Biomarker rules
// -----------------------------------------------------------------------------

/**
 * Threshold tables. Picked from the literature (McCabe '76, Lanza &
 * Marinescu's "Object-Oriented Metrics in Practice", CodeScene's
 * published thresholds) but conservative — we'd rather under-flag
 * than spam findings on a fresh codebase.
 */
const T_LOC = { info: 50, warning: 100, error: 200 };
const T_CYC = { info: 10, warning: 15, error: 25 };
const T_NEST = { info: 3, warning: 4, error: 6 };
const T_COND = { info: 4, warning: 6, error: 8 };

function severityFor(value: number, t: { info: number; warning: number; error: number }): Severity | null {
  if (value >= t.error) return 'error';
  if (value >= t.warning) return 'warning';
  if (value >= t.info) return 'info';
  return null;
}

export interface RuleContext {
  nodeId: string;
  language: Language;
  metrics: SymbolMetrics;
}

/**
 * Run every biomarker rule over the metrics. Findings are returned
 * in priority order so callers can `findings[0]` for the dominant one.
 */
export function evaluateRules(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];

  const locSev = severityFor(ctx.metrics.loc, T_LOC);
  if (locSev) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'large_method',
      severity: locSev,
      metric: ctx.metrics.loc,
    });
  }

  const cycSev = severityFor(ctx.metrics.cyclomatic, T_CYC);
  if (cycSev) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'complex_method',
      severity: cycSev,
      metric: ctx.metrics.cyclomatic,
    });
  }

  const nestSev = severityFor(ctx.metrics.maxNesting, T_NEST);
  if (nestSev) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'nested_complexity',
      severity: nestSev,
      metric: ctx.metrics.maxNesting,
    });
  }

  const condSev = severityFor(ctx.metrics.maxConditionalOperands, T_COND);
  if (condSev) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'complex_conditional',
      severity: condSev,
      metric: ctx.metrics.maxConditionalOperands,
    });
  }

  // Brain Method: large + complex + deeply-nested all firing at >= warning.
  const isBrain =
    locSev !== null && locSev !== 'info' &&
    cycSev !== null && cycSev !== 'info' &&
    nestSev !== null && nestSev !== 'info';
  if (isBrain) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'brain_method',
      severity: 'error',
      metric: ctx.metrics.loc, // headline number
      detail: {
        loc: ctx.metrics.loc,
        cyclomatic: ctx.metrics.cyclomatic,
        maxNesting: ctx.metrics.maxNesting,
      },
    });
  }

  // Long parameter list. Threshold from the Clean Code rule of thumb:
  // 0–3 params is fine, 4 is a warning, 5+ is an error. Conservative
  // because some legitimate signatures (event handlers, ctor inj) do
  // need ≥4 args.
  const T_PARAMS = { info: 4, warning: 5, error: 7 };
  const paramSev = severityFor(ctx.metrics.paramCount, T_PARAMS);
  if (paramSev) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'long_parameter_list',
      severity: paramSev,
      metric: ctx.metrics.paramCount,
    });
  }

  // Magic numbers. Each occurrence above the trivial allow-list is a
  // signal; we only flag once per symbol but record the count. Threshold
  // is intentionally generous — a method that uses 3+ unexplained
  // numeric constants almost always benefits from named constants.
  const T_MAGIC = { info: 3, warning: 5, error: 8 };
  const magicSev = severityFor(ctx.metrics.magicNumberCount, T_MAGIC);
  if (magicSev) {
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'magic_number',
      severity: magicSev,
      metric: ctx.metrics.magicNumberCount,
    });
  }

  // Hardcoded URLs. Even one is worth surfacing — they are almost
  // never the right design. Severity scales with count to distinguish
  // a single placeholder from real proliferation.
  if (ctx.metrics.hardcodedUrlCount > 0) {
    const sev: Severity =
      ctx.metrics.hardcodedUrlCount >= 3
        ? 'error'
        : ctx.metrics.hardcodedUrlCount >= 2
          ? 'warning'
          : 'info';
    out.push({
      nodeId: ctx.nodeId,
      biomarker: 'hardcoded_url',
      severity: sev,
      metric: ctx.metrics.hardcodedUrlCount,
    });
  }

  return out;
}

/**
 * Aggregate findings into a single 1-10 Code Health score for a node
 * or a collection. Accepts any objects exposing `severity` so callers
 * can pass DB-shaped rows without re-mapping. The mapping is
 * conservative:
 *   - any error finding: -2 from baseline 10
 *   - any warning finding: -1
 *   - any info finding: -0.5
 *   - no findings: 10
 * Multiple findings of the same severity tier each subtract again,
 * with a floor of 1.
 */
export function codeHealthScore(findings: ReadonlyArray<{ severity: Severity }>): number {
  if (findings.length === 0) return 10;
  let score = 10;
  for (const f of findings) {
    if (f.severity === 'error') score -= 2;
    else if (f.severity === 'warning') score -= 1;
    else score -= 0.5;
  }
  return Math.max(1, Math.round(score * 10) / 10);
}

export const _internalForTests = { countConditionalOperands };
