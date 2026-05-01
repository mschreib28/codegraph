/**
 * Graph projection for the web UI.
 *
 * Builds a file-level view of the knowledge graph for D3 force-directed
 * rendering. Aggregates symbol-level edges into file-to-file edges and
 * computes a per-edge "distance" used as the D3 link force length, where
 * structurally-similar files (more shared edges, stronger edge kinds, more
 * neighbor overlap) end up with shorter distances.
 *
 * Pure helper — no DB or HTTP knowledge. Operates on the public
 * `CodeGraph` API only.
 */

import * as path from 'path';
import { CodeGraph, Node, Edge, EdgeKind, NodeKind } from '../index';

export interface UiFileNode {
  id: string;          // file path (relative to project root)
  kind: 'file';
  name: string;        // basename
  language: string;
  symbolCount: number;
}

export interface UiSymbolNode {
  id: string;          // node id
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  isExported?: boolean;
}

export interface UiEdge {
  source: string;
  target: string;
  kinds: Partial<Record<EdgeKind, number>>; // kind -> count
  weight: number;      // total edge multiplicity
  distance: number;    // D3 link force distance (smaller = more similar)
}

export interface UiGraph {
  nodes: UiFileNode[];
  edges: UiEdge[];
  projectRoot: string;
}

export interface UiFileExpansion {
  fileId: string;
  symbols: UiSymbolNode[];
  internalEdges: Array<{ source: string; target: string; kind: EdgeKind }>;
}

export interface UiSearchHit {
  fileId: string;
  weight: number;
  matchCount: number;
  topSymbols: Array<{ id: string; name: string; kind: NodeKind; score: number }>;
}

export interface UiSearchResult {
  query: string;
  matchedFiles: UiSearchHit[];
  matchedEdges: UiEdge[];
}

// Base distance per edge kind (smaller = "more similar" / closer in layout).
// Tuned so that imports/contains pull nodes tightly together while looser
// kinds (calls, references) keep some breathing room.
const BASE_DISTANCE: Record<string, number> = {
  imports: 40,
  contains: 30,
  extends: 35,
  implements: 35,
  calls: 60,
  returns: 70,
  references: 80,
  type_of: 70,
  instantiates: 60,
  overrides: 45,
  decorates: 60,
  exports: 50,
};

const DEFAULT_DISTANCE = 80;
const MIN_DISTANCE = 20;
const MAX_DISTANCE = 200;

/**
 * Build the full file-level graph. Iterates all tracked files via the public
 * CodeGraph API, walks every node's outgoing edges, and aggregates them by
 * (sourceFile, targetFile, kind).
 */
export function buildFileGraph(cg: CodeGraph): UiGraph {
  const projectRoot = cg.getProjectRoot();
  const files = cg.getFiles();

  // nodeId -> relative file path
  const nodeToFile = new Map<string, string>();
  // file path -> {symbolCount, language}
  const fileMeta = new Map<string, { symbolCount: number; language: string }>();

  for (const file of files) {
    const rel = toRelative(projectRoot, file.path);
    fileMeta.set(rel, { symbolCount: 0, language: file.language });
    const nodes = cg.getNodesInFile(file.path);
    for (const node of nodes) {
      nodeToFile.set(node.id, rel);
    }
    fileMeta.get(rel)!.symbolCount = nodes.length;
  }

  // (src|tgt|kind) aggregation
  const edgeAgg = new Map<string, { source: string; target: string; kind: EdgeKind; count: number }>();
  // For Jaccard neighbor overlap
  const neighborSets = new Map<string, Set<string>>();

  for (const [nodeId, srcFile] of nodeToFile) {
    let outgoing: Edge[];
    try {
      outgoing = cg.getOutgoingEdges(nodeId);
    } catch {
      continue;
    }
    for (const edge of outgoing) {
      const tgtFile = nodeToFile.get(edge.target);
      if (!tgtFile || tgtFile === srcFile) continue; // skip self-loops
      const key = `${srcFile}${tgtFile}${edge.kind}`;
      const existing = edgeAgg.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        edgeAgg.set(key, { source: srcFile, target: tgtFile, kind: edge.kind, count: 1 });
      }
      addNeighbor(neighborSets, srcFile, tgtFile);
      addNeighbor(neighborSets, tgtFile, srcFile);
    }
  }

  // Collapse per-kind aggregation into a single edge per (src, tgt) with
  // a `kinds` breakdown.
  const merged = new Map<string, UiEdge>();
  for (const { source, target, kind, count } of edgeAgg.values()) {
    // Normalize direction so that A→B and B→A merge for layout purposes.
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${a}${b}`;
    let edge = merged.get(key);
    if (!edge) {
      edge = { source: a, target: b, kinds: {}, weight: 0, distance: DEFAULT_DISTANCE };
      merged.set(key, edge);
    }
    edge.kinds[kind] = (edge.kinds[kind] ?? 0) + count;
    edge.weight += count;
  }

  // Compute final distance per edge.
  for (const edge of merged.values()) {
    edge.distance = computeDistance(edge, neighborSets);
  }

  const nodes: UiFileNode[] = [];
  for (const [rel, meta] of fileMeta) {
    nodes.push({
      id: rel,
      kind: 'file',
      name: path.basename(rel),
      language: meta.language,
      symbolCount: meta.symbolCount,
    });
  }

  return { nodes, edges: Array.from(merged.values()), projectRoot };
}

/**
 * Expand a single file into its symbol-level subgraph (used when the user
 * clicks a file node in the UI). Returns the symbols inside the file plus
 * the internal containment/call edges between them.
 */
export function expandFile(cg: CodeGraph, fileId: string): UiFileExpansion {
  // The DB stores file paths as project-relative strings (see FileRecord.path).
  // The UI round-trips that same id back to us, so use it directly — do NOT
  // pre-resolve to an absolute path or `getNodesByFile` will miss everything.
  const nodes = cg.getNodesInFile(fileId);
  const idSet = new Set(nodes.map(n => n.id));

  const internalEdges: UiFileExpansion['internalEdges'] = [];
  for (const node of nodes) {
    let outgoing: Edge[];
    try {
      outgoing = cg.getOutgoingEdges(node.id);
    } catch {
      continue;
    }
    for (const edge of outgoing) {
      if (idSet.has(edge.target)) {
        internalEdges.push({ source: edge.source, target: edge.target, kind: edge.kind });
      }
    }
  }

  return {
    fileId,
    symbols: nodes.map(toUiSymbol),
    internalEdges,
  };
}

/**
 * Run an FTS5 search and aggregate per-file weights so the UI can size and
 * filter file nodes by topical relevance.
 */
export function searchAndProject(
  cg: CodeGraph,
  graph: UiGraph,
  query: string,
  limit: number = 200
): UiSearchResult {
  const projectRoot = cg.getProjectRoot();
  const results = cg.searchNodes(query, { limit });

  const perFile = new Map<string, UiSearchHit>();
  for (const result of results) {
    const rel = toRelative(projectRoot, result.node.filePath);
    let hit = perFile.get(rel);
    if (!hit) {
      hit = { fileId: rel, weight: 0, matchCount: 0, topSymbols: [] };
      perFile.set(rel, hit);
    }
    hit.weight += result.score;
    hit.matchCount += 1;
    if (hit.topSymbols.length < 5) {
      hit.topSymbols.push({
        id: result.node.id,
        name: result.node.name,
        kind: result.node.kind,
        score: result.score,
      });
    }
  }

  const matchedIds = new Set(perFile.keys());
  const matchedEdges = graph.edges.filter(e => matchedIds.has(e.source) && matchedIds.has(e.target));

  return {
    query,
    matchedFiles: Array.from(perFile.values()).sort((a, b) => b.weight - a.weight),
    matchedEdges,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNeighbor(map: Map<string, Set<string>>, from: string, to: string): void {
  let set = map.get(from);
  if (!set) {
    set = new Set();
    map.set(from, set);
  }
  set.add(to);
}

function computeDistance(edge: UiEdge, neighbors: Map<string, Set<string>>): number {
  // Pick the "tightest" base distance among the kinds present on this edge.
  let base = DEFAULT_DISTANCE;
  for (const kind of Object.keys(edge.kinds)) {
    const candidate = BASE_DISTANCE[kind] ?? DEFAULT_DISTANCE;
    if (candidate < base) base = candidate;
  }

  // Multiplicity: more edges between two files → pull them closer.
  // log scale so a few extra edges don't collapse the layout.
  const multiplicityFactor = 1 / (1 + Math.log10(1 + edge.weight));

  // Jaccard similarity of neighbor sets boosts pull when two files share
  // many of the same dependencies/dependents.
  const a = neighbors.get(edge.source);
  const b = neighbors.get(edge.target);
  let jaccard = 0;
  if (a && b && (a.size + b.size) > 0) {
    let intersection = 0;
    const [smaller, larger] = a.size < b.size ? [a, b] : [b, a];
    for (const x of smaller) if (larger.has(x)) intersection += 1;
    const union = a.size + b.size - intersection;
    jaccard = union > 0 ? intersection / union : 0;
  }
  const jaccardFactor = 1 - 0.5 * jaccard; // up to 50% pull when fully overlapping

  const distance = Math.round(base * multiplicityFactor * jaccardFactor);
  return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance));
}

function toRelative(projectRoot: string, filePath: string): string {
  // CodeGraph normally stores project-relative paths. Guard against absolute
  // paths in case a future indexer change introduces them.
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(projectRoot, filePath);
    return rel === '' ? path.basename(filePath) : rel;
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Complexity projections
// ---------------------------------------------------------------------------

export interface ComplexityFileEntry {
  filePath: string;            // project-relative
  language: string;
  cyclomaticMax: number;       // worst function in file (native AST)
  cyclomaticAvg: number;       // mean of per-function values
  cyclomaticTotal: number;     // sum (used for treemap area)
  fanIn: number;
  fanOut: number;
  isCircular: boolean;
  maintainability?: number;    // optional, no analyzer currently produces this
  symbolCount: number;         // # of measured symbols in this file
  risk: 'low' | 'medium' | 'high' | 'critical';
}

export interface ComplexityTreemapNode {
  name: string;                // segment name
  path: string;                // full path from root
  children?: ComplexityTreemapNode[];
  value?: number;              // leaf only — drives rectangle area
  language?: string;
  risk?: 'low' | 'medium' | 'high' | 'critical';
  cyclomaticMax?: number;
  fanIn?: number;
  fanOut?: number;
  isCircular?: boolean;
}

export interface ComplexityReport {
  files: ComplexityFileEntry[];
  tree: ComplexityTreemapNode;
  toolsPresent: string[];
  totals: {
    files: number;
    metrics: number;
  };
  computedAt: number;
}

const RISK_THRESHOLDS = { medium: 11, high: 21, critical: 51 } as const;

function classifyRisk(cyclomatic: number): ComplexityFileEntry['risk'] {
  if (cyclomatic >= RISK_THRESHOLDS.critical) return 'critical';
  if (cyclomatic >= RISK_THRESHOLDS.high) return 'high';
  if (cyclomatic >= RISK_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/**
 * Build a per-file aggregated view of complexity_metrics + a treemap hierarchy.
 */
export function buildComplexityReport(cg: CodeGraph): ComplexityReport {
  const rows = cg.getComplexityMetrics();
  const projectRoot = cg.getProjectRoot();

  // Group by file
  const byFile = new Map<string, ComplexityFileEntry & { _ccValues: number[] }>();
  const tools = new Set<string>();
  let computedAt = 0;
  for (const row of rows) {
    tools.add(row.tool);
    if (row.computedAt > computedAt) computedAt = row.computedAt;

    const rel = toRelative(projectRoot, row.filePath);
    let entry = byFile.get(rel);
    if (!entry) {
      entry = {
        filePath: rel,
        language: row.language,
        cyclomaticMax: 0,
        cyclomaticAvg: 0,
        cyclomaticTotal: 0,
        fanIn: 0,
        fanOut: 0,
        isCircular: false,
        symbolCount: 0,
        risk: 'low',
        _ccValues: [],
      };
      byFile.set(rel, entry);
    }

    switch (row.metric) {
      case 'cyclomatic':
        entry._ccValues.push(row.value);
        if (row.value > entry.cyclomaticMax) entry.cyclomaticMax = row.value;
        entry.cyclomaticTotal += row.value;
        entry.symbolCount += 1;
        break;
      case 'fan_in':
        entry.fanIn = row.value;
        break;
      case 'fan_out':
        entry.fanOut = row.value;
        break;
      case 'is_circular':
        entry.isCircular = row.value > 0;
        break;
      case 'maintainability':
        entry.maintainability = row.value;
        break;
    }
  }

  const files: ComplexityFileEntry[] = [];
  for (const entry of byFile.values()) {
    if (entry._ccValues.length > 0) {
      entry.cyclomaticAvg = entry.cyclomaticTotal / entry._ccValues.length;
    }
    entry.risk = classifyRisk(entry.cyclomaticMax);
    const { _ccValues, ...rest } = entry;
    void _ccValues;
    files.push(rest);
  }
  files.sort((a, b) => b.cyclomaticMax - a.cyclomaticMax);

  return {
    files,
    tree: buildTreemap(files),
    toolsPresent: Array.from(tools).sort(),
    totals: { files: files.length, metrics: rows.length },
    computedAt,
  };
}

function buildTreemap(files: ComplexityFileEntry[]): ComplexityTreemapNode {
  const root: ComplexityTreemapNode = { name: '', path: '', children: [] };
  for (const file of files) {
    const segments = file.filePath.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      acc = acc ? `${acc}/${seg}` : seg;
      const isLeaf = i === segments.length - 1;
      if (!node.children) node.children = [];
      let child = node.children.find(c => c.name === seg);
      if (!child) {
        child = isLeaf
          ? {
              name: seg,
              path: acc,
              value: Math.max(1, file.cyclomaticTotal || file.cyclomaticMax || 1),
              language: file.language,
              risk: file.risk,
              cyclomaticMax: file.cyclomaticMax,
              fanIn: file.fanIn,
              fanOut: file.fanOut,
              isCircular: file.isCircular,
            }
          : { name: seg, path: acc, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  return root;
}

function toUiSymbol(node: Node): UiSymbolNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
    docstring: node.docstring,
    isExported: node.isExported,
  };
}
