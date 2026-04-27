/**
 * Review Context Builder
 *
 * Takes a unified diff and returns the structured context an LLM-driven
 * code reviewer needs to evaluate it: per-symbol callers / callees /
 * tests / impact, plus historical co-change warnings (files that
 * historically change together but were NOT both touched in this PR).
 *
 * Designed to be the substrate under PR-review tooling (Greptile,
 * CodeRabbit, custom Claude Code agents). Not a reviewer itself —
 * synthesis stays with the LLM consumer.
 */

import { Node, NodeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph/traversal';
import { parseDiff, symbolsTouchedByHunks, DiffFile, FileStatus } from './diff-parser';

export { parseDiff, type DiffFile, type Hunk, type FileStatus } from './diff-parser';

export interface ReviewContextOptions {
  /**
   * Per-symbol caller / callee fan-out cap. Reviewer only needs a handful
   * to decide "is this a hot-path function or an internal helper", not
   * every reference.
   */
  maxCallersPerSymbol?: number;
  maxCalleesPerSymbol?: number;

  /**
   * For each changed file, surface up to N co-changers that historically
   * change together but are NOT in this PR. Set 0 to disable.
   */
  maxCoChangeWarnings?: number;

  /**
   * Minimum Jaccard for a co-change warning to be reported. 0.4 catches
   * meaningfully-coupled pairs without flooding the result with weak
   * historical co-occurrence.
   */
  minCoChangeJaccard?: number;
}

interface SymbolRef {
  name: string;
  filePath: string;
  line?: number;
}

export interface AffectedSymbol {
  symbolId: string;
  name: string;
  kind: NodeKind;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  /** Direct callers (incoming `calls`/`references`/`imports` edges). */
  callers: SymbolRef[];
  /** Direct callees (outgoing `calls`/`references`/`imports` edges). */
  callees: SymbolRef[];
  /** Number of nodes in the impact radius (depth 2). */
  impactCount: number;
}

export interface ReviewedFile {
  path: string;
  status: FileStatus;
  oldPath?: string;
  /** Symbols whose line ranges overlap the diff hunks. */
  affectedSymbols: AffectedSymbol[];
  /** Test files that cover this source file (via PR #106 `tests` edges). */
  tests: string[];
  /** Note when status == 'deleted' — incoming edges to symbols that vanish. */
  brokenIncomingRefs?: SymbolRef[];
}

export interface CoChangeWarning {
  changedFile: string;
  expectedToChange: string;
  jaccard: number;
  historicalCount: number;
  note: string;
}

export interface ReviewContext {
  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    filesRenamed: number;
    symbolsAffected: number;
    coChangeWarnings: number;
  };
  files: ReviewedFile[];
  coChangeWarnings: CoChangeWarning[];
}

const DEFAULTS: Required<ReviewContextOptions> = {
  maxCallersPerSymbol: 5,
  maxCalleesPerSymbol: 5,
  maxCoChangeWarnings: 3,
  minCoChangeJaccard: 0.4,
};

/**
 * Build a review-context bundle from a unified diff. Pure data — the
 * caller (typically an LLM) decides what to do with it.
 */
export function buildReviewContext(
  diff: string,
  queries: QueryBuilder,
  traverser: GraphTraverser,
  options: ReviewContextOptions = {}
): ReviewContext {
  const opts = { ...DEFAULTS, ...options };
  const diffFiles = parseDiff(diff);
  const changedPaths = new Set(diffFiles.map((f) => f.path));

  const reviewedFiles: ReviewedFile[] = [];
  let totalSymbols = 0;

  for (const df of diffFiles) {
    const reviewed = reviewFile(df, queries, traverser, opts);
    totalSymbols += reviewed.affectedSymbols.length;
    reviewedFiles.push(reviewed);
  }

  // Co-change warnings — for each changed file, find historical
  // co-changers NOT touched in this PR. This is the genuinely novel
  // signal: catches "you changed X but didn't update Y which always
  // changes with X" (schema + migration, code + test, config + reader).
  const coChangeWarnings: CoChangeWarning[] = [];
  if (opts.maxCoChangeWarnings > 0) {
    for (const df of diffFiles) {
      // Skip pure deletions — querying their co-changers tells us nothing
      // useful about what should also have been touched in this PR.
      if (df.status === 'deleted') continue;
      const partners = safeGetCoChangedFiles(queries, df.path, {
        limit: opts.maxCoChangeWarnings * 3,
        minCount: 2,
        minJaccard: opts.minCoChangeJaccard,
      });
      const missing = partners.filter((p) => !changedPaths.has(p.path)).slice(0, opts.maxCoChangeWarnings);
      for (const m of missing) {
        coChangeWarnings.push({
          changedFile: df.path,
          expectedToChange: m.path,
          jaccard: round2(m.jaccard),
          historicalCount: m.count,
          note: 'Historically changes together with the changed file but is not included in this PR. Verify whether it should be updated.',
        });
      }
    }
  }

  const counts = reviewedFiles.reduce(
    (acc, f) => {
      if (f.status === 'added') acc.added++;
      else if (f.status === 'modified') acc.modified++;
      else if (f.status === 'deleted') acc.deleted++;
      else if (f.status === 'renamed') acc.renamed++;
      return acc;
    },
    { added: 0, modified: 0, deleted: 0, renamed: 0 }
  );

  return {
    summary: {
      filesAdded: counts.added,
      filesModified: counts.modified,
      filesDeleted: counts.deleted,
      filesRenamed: counts.renamed,
      symbolsAffected: totalSymbols,
      coChangeWarnings: coChangeWarnings.length,
    },
    files: reviewedFiles,
    coChangeWarnings,
  };
}

function reviewFile(
  df: DiffFile,
  queries: QueryBuilder,
  traverser: GraphTraverser,
  opts: Required<ReviewContextOptions>
): ReviewedFile {
  const reviewed: ReviewedFile = {
    path: df.path,
    status: df.status,
    affectedSymbols: [],
    tests: safeGetTestsForFile(queries, df.path),
  };
  if (df.oldPath) reviewed.oldPath = df.oldPath;

  const fileSymbols = queries.getNodesByFile(df.path);

  // For deleted files: list every symbol that vanishes plus every
  // distinct incoming reference to those symbols (the "what just broke"
  // picture). Dedup by (name, filePath, line) so a caller with two
  // different edge types to the same deleted file isn't double-listed.
  if (df.status === 'deleted') {
    const seen = new Set<string>();
    const broken: SymbolRef[] = [];
    for (const sym of fileSymbols) {
      const incoming = queries.getIncomingEdges(sym.id, ['calls', 'references', 'imports', 'extends', 'implements']);
      for (const edge of incoming) {
        const sourceNode = queries.getNodeById(edge.source);
        if (!sourceNode) continue;
        const key = `${sourceNode.filePath}|${sourceNode.name}|${edge.line ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        broken.push({
          name: sourceNode.name,
          filePath: sourceNode.filePath,
          line: edge.line,
        });
      }
      // Skip the per-symbol details for deleted files — affected lists
      // would all be empty since the symbol's gone.
      reviewed.affectedSymbols.push(toAffected(sym, [], [], 0));
    }
    if (broken.length > 0) reviewed.brokenIncomingRefs = broken;
    return reviewed;
  }

  // For added files: every top-level symbol is "affected" (newly created).
  // For modified files: symbols whose line range overlaps a hunk.
  const touched = df.status === 'added'
    ? fileSymbols
    : symbolsTouchedByHunks(df.hunks, fileSymbols);

  for (const sym of touched) {
    const callers = traverser
      .getCallers(sym.id, 1)
      .slice(0, opts.maxCallersPerSymbol)
      .map((r) => ({
        name: r.node.name,
        filePath: r.node.filePath,
        line: r.edge.line,
      }));

    const callees = traverser
      .getCallees(sym.id, 1)
      .slice(0, opts.maxCalleesPerSymbol)
      .map((r) => ({
        name: r.node.name,
        filePath: r.node.filePath,
        line: r.edge.line,
      }));

    const impactCount = traverser.getImpactRadius(sym.id, 2).nodes.size;
    reviewed.affectedSymbols.push(toAffected(sym, callers, callees, impactCount));
  }

  return reviewed;
}

function toAffected(
  sym: Node,
  callers: SymbolRef[],
  callees: SymbolRef[],
  impactCount: number
): AffectedSymbol {
  const out: AffectedSymbol = {
    symbolId: sym.id,
    name: sym.name,
    kind: sym.kind,
    qualifiedName: sym.qualifiedName,
    startLine: sym.startLine,
    endLine: sym.endLine,
    callers,
    callees,
    impactCount,
  };
  if (sym.signature) out.signature = sym.signature;
  if (sym.docstring) out.docstring = sym.docstring;
  return out;
}

/**
 * Co-change query — graceful degradation if PR #105's co_changes table
 * isn't present. Returns [] without throwing, so the review context
 * still works on a pre-#105 install.
 */
function safeGetCoChangedFiles(
  queries: QueryBuilder,
  filePath: string,
  options: { limit: number; minCount: number; minJaccard: number }
): Array<{ path: string; count: number; jaccard: number }> {
  const q = queries as unknown as {
    getCoChangedFiles?: (
      p: string,
      o: { limit: number; minCount: number; minJaccard: number }
    ) => Array<{ path: string; count: number; jaccard: number }>;
  };
  if (typeof q.getCoChangedFiles !== 'function') return [];
  try {
    return q.getCoChangedFiles(filePath, options);
  } catch {
    return [];
  }
}

/**
 * Tests-edges query — graceful degradation if PR #106's `tests` edges
 * aren't present. Falls back to a direct edges-table query so we don't
 * need the public API surface to exist yet.
 */
function safeGetTestsForFile(queries: QueryBuilder, filePath: string): string[] {
  try {
    const incoming = queries.getIncomingEdges(`file:${filePath}`, ['tests' as never]);
    return incoming
      .map((e) => e.source)
      .filter((id) => id.startsWith('file:'))
      .map((id) => id.slice('file:'.length));
  } catch {
    return [];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
