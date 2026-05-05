/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Node,
  Edge,
  NodeKind,
  EdgeKind,
  Subgraph,
  CodeBlock,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
  SearchResult,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter';
import { logDebug } from '../errors';
import { validatePathWithinRoot } from '../utils';
import { isTestFile, extractSearchTerms, scorePathRelevance, getStemVariants } from '../search/query-utils';

/**
 * Extract likely symbol names from a natural language query
 *
 * Identifies potential code symbols using patterns:
 * - CamelCase: UserService, signInWithGoogle
 * - snake_case: user_service, sign_in
 * - SCREAMING_SNAKE: MAX_RETRIES
 * - dot.notation: app.isPackaged (extracts both sides)
 * - Single words that look like identifiers (no spaces, not common English words)
 *
 * @param query - Natural language query
 * @returns Array of potential symbol names
 */
function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();

  // Extract CamelCase identifiers (2+ chars, starts with letter)
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 2) {
      symbols.add(match[1]);
    }
  }

  // Extract snake_case identifiers
  const snakeCasePattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      symbols.add(match[1]);
    }
  }

  // Extract SCREAMING_SNAKE_CASE
  const screamingPattern = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((match = screamingPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract ALL_CAPS acronyms (2+ chars, e.g., REST, HTTP, LRU, API)
  const acronymPattern = /\b([A-Z]{2,})\b/g;
  while ((match = acronymPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract dot.notation and split into parts (e.g., "app.isPackaged" -> ["app", "isPackaged"])
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      // Add both the full path and individual parts
      symbols.add(match[1]);
      const parts = match[1].split('.');
      for (const part of parts) {
        if (part.length >= 2) {
          symbols.add(part);
        }
      }
    }
  }

  // Extract plain lowercase identifiers (3+ chars, not already matched)
  // Catches symbol names like "undo", "redo", "history", "render", "parse"
  const lowercasePattern = /\b([a-z][a-z0-9]{2,})\b/g;
  while ((match = lowercasePattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Filter out common English words that aren't likely symbol names
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been',
    'will', 'would', 'could', 'should', 'does', 'done', 'make', 'made',
    'use', 'used', 'using', 'work', 'works', 'find', 'found', 'show',
    'call', 'called', 'calling', 'get', 'set', 'add', 'all', 'any',
    'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'not', 'but', 'are', 'was', 'were', 'has', 'had', 'its',
    'can', 'did', 'may', 'also', 'into', 'than', 'then', 'them',
    'each', 'other', 'some', 'such', 'only', 'same', 'about',
    'after', 'before', 'between', 'through', 'during', 'without',
    'again', 'further', 'once', 'here', 'there', 'both', 'just',
    'more', 'most', 'very', 'being', 'having', 'doing',
    'system', 'need', 'needs', 'want', 'wants', 'like', 'look',
    'change', 'changes', 'changed', 'changing',
    // Common English nouns/verbs that match thousands of unrelated code symbols
    'layer', 'handle', 'handles', 'handling', 'incoming', 'outgoing',
    'data', 'flow', 'flows', 'level', 'levels', 'request', 'requests',
    'response', 'responses', 'implement', 'implements', 'implementation',
    'interface', 'interfaces', 'class', 'classes', 'method', 'methods',
    'trigger', 'triggers', 'affected', 'affect', 'affects',
    'else', 'code', 'failing', 'failed', 'silently', 'decide', 'decides',
    'return', 'returns', 'returned', 'take', 'takes', 'taken',
    'check', 'checks', 'checked', 'create', 'creates', 'created',
    'read', 'reads', 'write', 'writes', 'written',
    'start', 'starts', 'stop', 'stops', 'run', 'runs', 'running',
  ]);

  return Array.from(symbols).filter(s => !commonWords.has(s.toLowerCase()));
}

/**
 * Default options for context building
 *
 * Tuned for minimal context usage while still providing useful results:
 * - Fewer nodes and code blocks by default
 * - Smaller code block size limit
 * - Shallower traversal
 */
const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: 20,           // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5,       // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // Reduced from 5 - fewer entry points
  traversalDepth: 1,      // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
};

/**
 * Node kinds that provide high information value in context results.
 * Imports/exports are excluded because they have near-zero information density -
 * they tell you something exists, not how it works.
 */
const HIGH_VALUE_NODE_KINDS: NodeKind[] = [
  'function', 'method', 'class', 'interface', 'type_alias', 'struct', 'trait',
  'component', 'route', 'variable', 'constant', 'enum', 'module', 'namespace',
];

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3,        // Reduced from 5
  traversalDepth: 1,     // Reduced from 2
  maxNodes: 20,          // Reduced from 50
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: HIGH_VALUE_NODE_KINDS, // Filter out imports/exports by default
};

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private projectRoot: string;
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(
    projectRoot: string,
    queries: QueryBuilder,
    traverser: GraphTraverser
  ) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }

  /**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
  async buildContext(
    input: TaskInput,
    options: BuildContextOptions = {}
  ): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

    // Parse input
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // Find relevant context (semantic search + graph expansion)
    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
    });

    // Get entry points (nodes from semantic search)
    const entryPoints = this.getEntryPoints(subgraph);

    // Extract code blocks for key nodes
    const codeBlocks = opts.includeCode
      ? await this.extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize)
      : [];

    // Get related files
    const relatedFiles = this.getRelatedFiles(subgraph);

    // Generate summary
    const summary = this.generateSummary(query, subgraph, entryPoints);

    // Calculate stats
    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const context: TaskContext = {
      query,
      subgraph,
      entryPoints,
      codeBlocks,
      relatedFiles,
      summary,
      stats,
    };

    // Return formatted output or raw context
    if (opts.format === 'markdown') {
      return formatContextAsMarkdown(context);
    } else if (opts.format === 'json') {
      return formatContextAsJson(context);
    }

    return context;
  }

  /**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options: FindRelevantContextOptions = {}
  ): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };
    if (!query || query.trim().length === 0) return { nodes: new Map(), edges: [], roots: [] };
    const symbolsFromQuery = extractSymbolsFromQuery(query);
    logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });
    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
    const exactMatches = this.findExactAndPrefixMatches(symbolsFromQuery, opts);
    const textResults = this.findByTextSearch(query, opts);
    let filteredResults = this.mergeAndRerank(exactMatches, textResults, symbolsFromQuery, query, isTestQuery, opts);
    filteredResults = this.resolveImportsToDefinitions(filteredResults);
    if (filteredResults.length > opts.searchLimit) filteredResults = filteredResults.slice(0, opts.searchLimit);
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];
    for (const result of filteredResults) { nodes.set(result.node.id, result.node); roots.push(result.node.id); }
    this.expandTypeHierarchy(filteredResults, nodes, edges, opts);
    this.expandViaBFS(filteredResults, nodes, edges, opts);
    return this.applyBudgetCaps(nodes, edges, roots, isTestQuery, opts);
  }

  private findExactAndPrefixMatches(
    symbolsFromQuery: string[],
    opts: Required<FindRelevantContextOptions>
  ): SearchResult[] {
    let exactMatches: SearchResult[] = [];
    if (symbolsFromQuery.length === 0) return exactMatches;
    try {
      exactMatches = this.queries.findNodesByExactName(symbolsFromQuery, {
        limit: Math.ceil(opts.searchLimit * 5),
        kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      });
      if (exactMatches.length > 1) {
        const fileSymbolCounts = new Map<string, Set<string>>();
        for (const r of exactMatches) {
          const names = fileSymbolCounts.get(r.node.filePath) || new Set();
          names.add(r.node.name.toLowerCase());
          fileSymbolCounts.set(r.node.filePath, names);
        }
        exactMatches = exactMatches.map(r => {
          const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size || 1;
          return { ...r, score: symbolCount > 1 ? r.score + (symbolCount - 1) * 20 : r.score };
        });
        exactMatches.sort((a, b) => b.score - a.score);
      }
      exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 2));
      logDebug('Exact symbol matches', { count: exactMatches.length });
    } catch (error) {
      logDebug('Exact symbol lookup failed', { error: String(error) });
    }
    const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait', 'protocol', 'enum', 'type_alias'];
    const expandedSymbols = new Set(symbolsFromQuery);
    for (const sym of symbolsFromQuery) {
      for (const variant of getStemVariants(sym)) expandedSymbols.add(variant);
    }
    for (const sym of expandedSymbols) {
      const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
      if (titleCased === sym) continue;
      const prefixResults = this.queries.searchNodes(titleCased, { limit: 30, kinds: definitionKinds });
      const matched: SearchResult[] = [];
      for (const r of prefixResults) {
        if (r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) {
          const brevityBonus = Math.max(0, 10 - (r.node.name.length - titleCased.length) / 3);
          matched.push({ ...r, score: r.score + 15 + brevityBonus });
        }
      }
      matched.sort((a, b) => b.score - a.score);
      for (const r of matched.slice(0, Math.ceil(opts.searchLimit))) {
        if (!exactMatches.find(e => e.node.id === r.node.id)) exactMatches.push(r);
      }
    }
    exactMatches.sort((a, b) => b.score - a.score);
    return exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
  }

  private findByTextSearch(
    query: string,
    opts: Required<FindRelevantContextOptions>
  ): SearchResult[] {
    let textResults: SearchResult[] = [];
    try {
      const searchTerms = extractSearchTerms(query);
      if (searchTerms.length > 0) {
        const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
        const searchKinds = opts.nodeKinds && opts.nodeKinds.length > 0
          ? opts.nodeKinds
          : ['file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
             'function', 'method', 'property', 'field', 'variable', 'constant',
             'enum', 'enum_member', 'type_alias', 'namespace', 'export',
             'route', 'component'] as NodeKind[];
        for (const term of searchTerms) {
          const termResults = this.queries.searchNodes(term, { limit: opts.searchLimit * 2, kinds: searchKinds });
          for (const r of termResults) {
            const existing = termResultsMap.get(r.node.id);
            if (existing) { existing.termHits++; existing.result.score = Math.max(existing.result.score, r.score); }
            else { termResultsMap.set(r.node.id, { result: r, termHits: 1 }); }
          }
        }
        textResults = Array.from(termResultsMap.values())
          .map(({ result, termHits }) => ({ ...result, score: result.score + (termHits - 1) * 5 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, opts.searchLimit * 2);
      }
      logDebug('Text search results', { count: textResults.length });
    } catch (error) {
      logDebug('Text search failed', { query, error: String(error) });
    }
    return textResults;
  }

  private mergeAndRerank(
    exactMatches: SearchResult[],
    textResults: SearchResult[],
    symbolsFromQuery: string[],
    query: string,
    isTestQuery: boolean,
    opts: Required<FindRelevantContextOptions>
  ): SearchResult[] {
    const resultById = new Map<string, SearchResult>();
    let searchResults: SearchResult[] = [];
    for (const result of exactMatches) {
      const existing = resultById.get(result.node.id);
      if (existing) { existing.score = Math.max(existing.score, result.score); }
      else { resultById.set(result.node.id, result); searchResults.push(result); }
    }
    for (const result of textResults) {
      const existing = resultById.get(result.node.id);
      if (existing) { existing.score = Math.max(existing.score, result.score); }
      else { resultById.set(result.node.id, result); searchResults.push(result); }
    }
    if (!isTestQuery) {
      for (const result of searchResults) {
        if (isTestFile(result.node.filePath)) result.score *= 0.3;
      }
    }
    const queryTermsForBoost = extractSearchTerms(query);
    if (queryTermsForBoost.length >= 2) {
      const termGroups: string[][] = [];
      const sorted = [...queryTermsForBoost].sort((a, b) => b.length - a.length);
      const assigned = new Set<string>();
      for (const term of sorted) {
        if (assigned.has(term)) continue;
        const group = [term];
        assigned.add(term);
        for (const other of sorted) {
          if (assigned.has(other)) continue;
          if (term.includes(other) || other.includes(term)) { group.push(other); assigned.add(other); }
        }
        termGroups.push(group);
      }
      const exactMatchIds = new Set(exactMatches.map(r => r.node.id));
      for (const result of searchResults) {
        const nameLower = result.node.name.toLowerCase();
        const dirSegments = path.dirname(result.node.filePath).toLowerCase().split('/');
        let matchCount = 0;
        for (const group of termGroups) {
          if (group.some(term => nameLower.includes(term) || dirSegments.some(seg => seg === term))) matchCount++;
        }
        if (matchCount >= 2) { result.score *= 1 + matchCount * 0.5; }
        else if (!exactMatchIds.has(result.node.id)) { result.score *= 0.6; }
      }
      searchResults.sort((a, b) => b.score - a.score);
    }
    if (symbolsFromQuery.length > 0) {
      const camelDefinitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait', 'protocol', 'enum', 'type_alias'];
      const camelSearchedTerms = new Set<string>();
      const searchIdSet = new Set(searchResults.map(r => r.node.id));
      const camelNodeTerms = new Map<string, { result: SearchResult; termCount: number }>();
      const maxCamelPerTerm = Math.ceil(opts.searchLimit / 2);
      for (const sym of symbolsFromQuery) {
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased.length < 3) continue;
        const termKey = titleCased.toLowerCase();
        if (camelSearchedTerms.has(termKey)) continue;
        camelSearchedTerms.add(termKey);
        const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
          limit: 200, kinds: camelDefinitionKinds, excludePrefix: true,
        });
        const termCandidates: SearchResult[] = [];
        for (const r of likeResults) {
          const name = r.node.name;
          const idx = name.indexOf(titleCased);
          if (idx <= 0) continue;
          if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
          if (searchIdSet.has(r.node.id)) continue;
          if (isTestFile(r.node.filePath) && !isTestQuery) continue;
          const pathScore = scorePathRelevance(r.node.filePath, query);
          const brevityBonus = Math.max(0, 6 - (name.length - titleCased.length) / 4);
          termCandidates.push({ node: r.node, score: 8 + brevityBonus + pathScore });
        }
        termCandidates.sort((a, b) => b.score - a.score);
        for (const r of termCandidates.slice(0, maxCamelPerTerm * 4)) {
          const existing = camelNodeTerms.get(r.node.id);
          if (existing) { existing.termCount++; }
          else { camelNodeTerms.set(r.node.id, { result: r, termCount: 1 }); }
        }
      }
      const camelResults: SearchResult[] = [];
      for (const [, info] of camelNodeTerms) {
        info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * 30;
        camelResults.push(info.result);
      }
      camelResults.sort((a, b) => b.score - a.score);
      for (const r of camelResults.slice(0, opts.searchLimit)) {
        searchResults.push(r);
        searchIdSet.add(r.node.id);
      }
      if (symbolsFromQuery.length >= 2) {
        const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
        for (const sym of symbolsFromQuery) {
          const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
          if (titleCased.length < 3) continue;
          const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
            limit: 200, kinds: camelDefinitionKinds, excludePrefix: false,
          });
          for (const r of likeResults) {
            if (searchIdSet.has(r.node.id)) continue;
            if (isTestFile(r.node.filePath) && !isTestQuery) continue;
            const entry = compoundTermMap.get(r.node.id);
            if (entry) { entry.terms.add(titleCased); }
            else { compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) }); }
          }
        }
        const compoundResults: SearchResult[] = [];
        for (const [, entry] of compoundTermMap) {
          if (entry.terms.size >= 2) {
            const pathScore = scorePathRelevance(entry.node.filePath, query);
            const brevityBonus = Math.max(0, 6 - entry.node.name.length / 8);
            compoundResults.push({ node: entry.node, score: 10 + (entry.terms.size - 1) * 20 + pathScore + brevityBonus });
          }
        }
        compoundResults.sort((a, b) => b.score - a.score);
        for (const r of compoundResults.slice(0, Math.ceil(opts.searchLimit / 2))) {
          searchResults.push(r);
          searchIdSet.add(r.node.id);
        }
      }
    }
    searchResults.sort((a, b) => b.score - a.score);
    searchResults = searchResults.slice(0, opts.searchLimit * 3);
    return searchResults.filter((r) => r.score >= opts.minScore);
  }

  private expandTypeHierarchy(
    filteredResults: SearchResult[],
    nodes: Map<string, Node>,
    edges: Edge[],
    opts: Required<FindRelevantContextOptions>
  ): void {
    const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
    const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
    let hierarchyNodesAdded = 0;
    for (const result of filteredResults) {
      if (hierarchyNodesAdded >= maxHierarchyNodes) break;
      if (!typeHierarchyKinds.has(result.node.kind)) continue;
      const hierarchy = this.traverser.getTypeHierarchy(result.node.id);
      for (const [id, node] of hierarchy.nodes) {
        if (!nodes.has(id)) { nodes.set(id, node); hierarchyNodesAdded++; }
      }
      for (const edge of hierarchy.edges) {
        if (!edges.some(e => e.source === edge.source && e.target === edge.target && e.kind === edge.kind)) {
          edges.push(edge);
        }
      }
    }
    if (hierarchyNodesAdded > 0) {
      const rootIds = new Set(filteredResults.map(r => r.node.id));
      const pass2Candidates = [...nodes.values()].filter(n => typeHierarchyKinds.has(n.kind) && !rootIds.has(n.id));
      for (const candidate of pass2Candidates) {
        if (hierarchyNodesAdded >= maxHierarchyNodes) break;
        const siblingHierarchy = this.traverser.getTypeHierarchy(candidate.id);
        for (const [id, node] of siblingHierarchy.nodes) {
          if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) { nodes.set(id, node); hierarchyNodesAdded++; }
        }
        for (const edge of siblingHierarchy.edges) {
          if (nodes.has(edge.source) && nodes.has(edge.target) &&
              !edges.some(e => e.source === edge.source && e.target === edge.target && e.kind === edge.kind)) {
            edges.push(edge);
          }
        }
      }
    }
  }

  private expandViaBFS(
    filteredResults: SearchResult[],
    nodes: Map<string, Node>,
    edges: Edge[],
    opts: Required<FindRelevantContextOptions>
  ): void {
    for (const result of filteredResults) {
      const traversalResult = this.traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
      });
      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) nodes.set(id, node);
      }
      for (const edge of traversalResult.edges) {
        if (!edges.some(e => e.source === edge.source && e.target === edge.target && e.kind === edge.kind)) {
          edges.push(edge);
        }
      }
    }
  }

  private applyBudgetCaps(
    nodes: Map<string, Node>,
    edges: Edge[],
    roots: string[],
    isTestQuery: boolean,
    opts: Required<FindRelevantContextOptions>
  ): Subgraph {
    let finalNodes = nodes;
    let finalEdges = edges;
    if (nodes.size > opts.maxNodes) {
      const priorityIds = new Set(roots);
      for (const edge of edges) {
        if (priorityIds.has(edge.source)) priorityIds.add(edge.target);
        if (priorityIds.has(edge.target)) priorityIds.add(edge.source);
      }
      finalNodes = new Map<string, Node>();
      for (const id of priorityIds) {
        const node = nodes.get(id);
        if (node && finalNodes.size < opts.maxNodes) finalNodes.set(id, node);
      }
      for (const [id, node] of nodes) {
        if (finalNodes.size >= opts.maxNodes) break;
        if (!finalNodes.has(id)) finalNodes.set(id, node);
      }
      finalEdges = edges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
    }
    const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
    const fileCounts = new Map<string, string[]>();
    for (const [id, node] of finalNodes) {
      const ids = fileCounts.get(node.filePath) || [];
      ids.push(id);
      fileCounts.set(node.filePath, ids);
    }
    const rootSet = new Set(roots);
    for (const [, nodeIds] of fileCounts) {
      if (nodeIds.length <= maxPerFile) continue;
      const kindPriority: Record<string, number> = {
        class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
        method: 1, function: 1, property: 0, field: 0, variable: 0,
      };
      nodeIds.sort((a, b) => {
        const aRoot = rootSet.has(a) ? 10 : 0;
        const bRoot = rootSet.has(b) ? 10 : 0;
        const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
        const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
        return (bRoot + bKind) - (aRoot + aKind);
      });
      for (const id of nodeIds.slice(maxPerFile)) finalNodes.delete(id);
    }
    if (!isTestQuery) {
      const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
      const nonProdIds: string[] = [];
      for (const [id, node] of finalNodes) {
        if (isTestFile(node.filePath)) nonProdIds.push(id);
      }
      if (nonProdIds.length > maxNonProd) {
        for (const id of nonProdIds.slice(maxNonProd)) {
          finalNodes.delete(id);
          const rootIdx = roots.indexOf(id);
          if (rootIdx !== -1) roots.splice(rootIdx, 1);
        }
      }
    }
    finalEdges = finalEdges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
    const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
    const recoveredEdges = this.queries.findEdgesBetweenNodes([...finalNodes.keys()], recoveryKinds);
    const existingEdgeKeys = new Set(finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`));
    for (const edge of recoveredEdges) {
      const key = `${edge.source}:${edge.target}:${edge.kind}`;
      if (!existingEdgeKeys.has(key)) { finalEdges.push(edge); existingEdgeKeys.add(key); }
    }
    return { nodes: finalNodes, edges: finalEdges, roots };
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return this.extractNodeCode(node);
  }

  /**
   * Extract code from a node's source file
   */
  private async extractNodeCode(node: Node): Promise<string | null> {
    const filePath = validatePathWithinRoot(this.projectRoot, node.filePath);

    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Extract lines (1-indexed to 0-indexed)
      const startIdx = Math.max(0, node.startLine - 1);
      const endIdx = Math.min(lines.length, node.endLine);

      return lines.slice(startIdx, endIdx).join('\n');
    } catch (error) {
      logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
      return null;
    }
  }

  /**
   * Get entry points from a subgraph (the root nodes)
   */
  private getEntryPoints(subgraph: Subgraph): Node[] {
    return subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => n !== undefined);
  }

  /**
   * Extract code blocks for key nodes in the subgraph
   */
  private async extractCodeBlocks(
    subgraph: Subgraph,
    maxBlocks: number,
    maxBlockSize: number
  ): Promise<CodeBlock[]> {
    const blocks: CodeBlock[] = [];

    // Prioritize entry points, then functions/methods
    const priorityNodes: Node[] = [];

    // First: entry points
    for (const id of subgraph.roots) {
      const node = subgraph.nodes.get(id);
      if (node) {
        priorityNodes.push(node);
      }
    }

    // Then: functions and methods
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'function' || node.kind === 'method') {
          priorityNodes.push(node);
        }
      }
    }

    // Then: classes
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'class') {
          priorityNodes.push(node);
        }
      }
    }

    // Extract code for priority nodes
    for (const node of priorityNodes) {
      if (blocks.length >= maxBlocks) break;

      const code = await this.extractNodeCode(node);
      if (code) {
        // Truncate if too long
        const truncated = code.length > maxBlockSize
          ? code.slice(0, maxBlockSize) + '\n// ... truncated ...'
          : code;

        blocks.push({
          content: truncated,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          language: node.language,
          node,
        });
      }
    }

    return blocks;
  }

  /**
   * Get unique files from a subgraph
   */
  private getRelatedFiles(subgraph: Subgraph): string[] {
    const files = new Set<string>();
    for (const node of subgraph.nodes.values()) {
      files.add(node.filePath);
    }
    return Array.from(files).sort();
  }

  /**
   * Generate a summary of the context
   */
  private generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
    const nodeCount = subgraph.nodes.size;
    const edgeCount = subgraph.edges.length;
    const files = this.getRelatedFiles(subgraph);

    const entryPointNames = entryPoints
      .slice(0, 3)
      .map((n) => n.name)
      .join(', ');

    const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

    return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
      `Key entry points: ${entryPointNames}${remaining}. ` +
      `${edgeCount} relationships identified.`;
  }

  /**
   * Resolve import/export nodes to their actual definitions
   *
   * When search returns `import { TerminalPanel }`, users want the TerminalPanel
   * class definition, not the import statement. This follows the `imports` edge
   * to find and return the actual definition instead.
   *
   * @param results - Search results that may include import/export nodes
   * @returns Results with imports resolved to definitions where possible
   */
  private resolveImportsToDefinitions(results: SearchResult[]): SearchResult[] {
    const resolved: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      const { node, score } = result;

      // If it's not an import/export, keep it as-is
      if (node.kind !== 'import' && node.kind !== 'export') {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          resolved.push(result);
        }
        continue;
      }

      // For imports/exports, try to find what they reference
      // Imports have outgoing 'imports' edges to the definition
      // Exports have outgoing 'exports' edges to the definition
      const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
      const outgoingEdges = this.queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

      let foundDefinition = false;
      for (const edge of outgoingEdges) {
        const targetNode = this.queries.getNodeById(edge.target);
        if (targetNode && !seenIds.has(targetNode.id)) {
          // Found the definition - use it instead of the import
          seenIds.add(targetNode.id);
          resolved.push({
            node: targetNode,
            score: score, // Preserve the original score
          });
          foundDefinition = true;
          logDebug('Resolved import to definition', {
            import: node.name,
            definition: targetNode.name,
            kind: targetNode.kind,
          });
        }
      }

      // If we couldn't resolve the import, skip it (it's low-value on its own)
      if (!foundDefinition) {
        logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
      }
    }

    return resolved;
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson } from './formatter';
