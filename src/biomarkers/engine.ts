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

import type { Node as TsNode } from 'web-tree-sitter';
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
    return { loc, cyclomatic: CYCLOMATIC_BASE, maxNesting: 0, maxConditionalOperands: 0 };
  }

  let cyclomatic = CYCLOMATIC_BASE;
  let maxNesting = 0;
  let maxConditionalOperands = 0;

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
    // Push children at same depth.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, depth });
    }
  }

  return { loc, cyclomatic, maxNesting, maxConditionalOperands };
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

export function findNodeAt(
  source: string,
  language: Language,
  line: number,
  column: number
): TsNode | null {
  const parser = getParser(language);
  if (!parser) return null;
  const tree = parser.parse(source);
  if (!tree) return null;
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
