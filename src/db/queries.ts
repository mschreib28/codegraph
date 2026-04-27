/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  Language,
  GraphStats,
  SearchOptions,
  SearchResult,
} from '../types';
import { safeJsonParse, buildNameSubwords } from '../utils';
import { kindBonus, nameMatchBonus, scorePathRelevance, filterStopwords, diversifyByFile } from '../search/query-utils';

/**
 * Database row types (snake_case from SQLite)
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  updated_at: number;
  centrality: number | null;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
  commit_count: number | null;
  loc: number | null;
  first_seen_ts: number | null;
  last_touched_ts: number | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
}

/**
 * Convert database row to Node object
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    updatedAt: row.updated_at,
    centrality: row.centrality ?? undefined,
  };
}

/**
 * Convert database row to Edge object
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

/**
 * Convert database row to FileRecord object
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
    commitCount: row.commit_count ?? 0,
    loc: row.loc ?? 0,
    firstSeenTs: row.first_seen_ts ?? null,
    lastTouchedTs: row.last_touched_ts ?? null,
  };
}

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    insertEdge?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Execute a callback inside a single SQLite transaction. Useful when a
   * caller needs several `QueryBuilder` operations to commit atomically.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, updated_at, name_subwords
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @updatedAt, @nameSubwords
        )
      `);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    // INSERT OR REPLACE may overwrite a node we have cached. Drop the
    // stale entry so the next getNodeById sees the new row, not the old
    // one (matches the cache-invalidation pattern used by updateNode and
    // deleteNode below).
    this.nodeCache.delete(node.id);

    try {
      this.stmts.insertNode.run({
        id: node.id,
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName ?? node.name,
        filePath: node.filePath,
        language: node.language,
        startLine: node.startLine ?? 0,
        endLine: node.endLine ?? 0,
        startColumn: node.startColumn ?? 0,
        endColumn: node.endColumn ?? 0,
        docstring: node.docstring ?? null,
        signature: node.signature ?? null,
        visibility: node.visibility ?? null,
        isExported: node.isExported ? 1 : 0,
        isAsync: node.isAsync ? 1 : 0,
        isStatic: node.isStatic ? 1 : 0,
        isAbstract: node.isAbstract ? 1 : 0,
        decorators: node.decorators ? JSON.stringify(node.decorators) : null,
        typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        updatedAt: node.updatedAt ?? Date.now(),
        nameSubwords: buildNameSubwords(node.name),
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    })();
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          updated_at = @updatedAt,
          name_subwords = @nameSubwords
        WHERE id = @id
      `);
    }

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    // Validate required fields
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt ?? Date.now(),
      nameSubwords: buildNameSubwords(node.name),
    });
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
   *
   * Replaces the N+1 pattern in graph traversal where every edge would
   * trigger its own `getNodeById` call. For a function with 50 callers
   * this collapses 50 point reads into one IN-list query (~10-50x
   * faster end-to-end).
   *
   * Returns a Map keyed by id so callers can preserve their own ordering
   * (typically the order edges were returned from the graph). Missing IDs
   * are simply absent from the map.
   *
   * Cache-aware: ids already in the LRU cache are served from memory and
   * the SQL query only touches the misses.
   */
  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    // Serve cache hits first; build the miss list for SQL.
    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        // LRU touch
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    // Chunk under SQLite's parameter limit (default 999, raised to 32766
    // in better-sqlite3 builds — chunk at 500 for safety across both
    // backends and to keep the query plan simple).
    const CHUNK = 500;
    for (let i = 0; i < misses.length; i += CHUNK) {
      const chunk = misses.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        out.set(node.id, node);
        this.cacheNode(node);
      }
    }
    return out;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes in the database
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
  getNodesByLowerName(lowerName: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Score results based on match quality
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0, perFileCap = 3 } = options;

    // Note on over-fetching: searchNodesFTS already over-fetches by 5x
    // internally (Math.max(limit*5, 100)) so its own rescoring pass has
    // headroom. That same headroom feeds the per-file diversification
    // below — no additional outer multiplier needed. Keeping this comment
    // here so future readers don't reintroduce a multiplier-on-multiplier.

    // First try FTS5 with prefix matching
    let results = this.searchNodesFTS(query, { kinds, languages, limit, offset });

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && query.length >= 2) {
      results = this.searchNodesLike(query, { kinds, languages, limit, offset });
    }

    // Supplement: ensure exact name matches are always candidates.
    // BM25 can bury short exact-match names (e.g. "getBean") under hundreds of
    // compound names (e.g. "getBeanDescriptor") in large codebases,
    // pushing them past the FTS fetch limit before post-hoc scoring can help.
    // Use the max BM25 score as the base so the nameMatchBonus (exact=30 vs
    // prefix=20) actually differentiates them after rescoring.
    if (results.length > 0 && query) {
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = Math.max(...results.map(r => r.score));
      const terms = query.split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE';
        const params: (string | number)[] = [term];
        if (kinds && kinds.length > 0) {
          sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        sql += ' LIMIT 20';
        const rows = this.db.prepare(sql).all(...params) as NodeRow[];
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }
    }

    // Apply multi-signal scoring
    if (results.length > 0 && query) {
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, query)
          + nameMatchBonus(r.node.name, query),
      }));
      results.sort((a, b) => b.score - a.score);
    }

    // Diversification: cap per-file results so the top-K isn't dominated
    // by the methods of a single class. Top-scoring hit per file is always
    // included; the cap only kicks in for the second-and-onward members
    // of the same file. perFileCap=0 disables.
    //
    // Guard `results.length > limit`: when results <= limit there's
    // nothing to drop, so the existing score order is already what the
    // caller will see. (`diversifyByFile` is also safe to call here and
    // would reorder within the same set, but the existing rescore order
    // is already meaningful and we don't want to perturb it without
    // benefit.)
    if (perFileCap > 0 && results.length > limit) {
      results = diversifyByFile(results, limit, perFileCap);
    } else if (results.length > limit) {
      results = results.slice(0, limit);
    }

    return results;
  }

  /**
   * FTS5 search with prefix matching
   */
  private searchNodesFTS(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    // Build the FTS query in three steps:
    //   1. Strip characters with special meaning to FTS5 and split on whitespace.
    //   2. Drop FTS5 boolean operators (AND/OR/NOT/NEAR) — prevents user input
    //      from injecting boolean structure into the OR-join below.
    //   3. Drop English stopwords for natural-language queries — words like
    //      "how" / "the" otherwise become OR'd hits against any prose-bearing
    //      docstring and crowd out the actually-relevant identifier tokens.
    const rawTerms = query
      .replace(/['"*():^]/g, '')
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .filter((term) => !/^(AND|OR|NOT|NEAR)$/i.test(term));

    const filteredTerms = filterStopwords(rawTerms);

    const ftsQuery = filteredTerms
      .map((term) => `"${term}"*`) // Prefix match each term
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1,
    // signature=2, name_subwords=10. Heavy name weight keeps exact and prefix
    // name matches above incidental mentions in long docstrings; the new
    // name_subwords column at 10× lets queries hit subword tokens like
    // `parser` against `getParser` without burying full-name matches.
    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2, 10) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;

    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(row.score), // bm25 returns negative scores
      }));
    } catch {
      // FTS query failed, return empty
      return [];
    }
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private searchNodesLike(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? THEN 0.9
          WHEN name LIKE ? THEN 0.8
          WHEN qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (
        name LIKE ? OR
        qualified_name LIKE ? OR
        name LIKE ?
      )
    `;

    // Pattern variants for better matching
    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      exactMatch,     // Exact match score
      startsWith,     // Starts with score
      contains,       // Contains score
      contains,       // Qualified name score
      contains,       // WHERE: name contains
      contains,       // WHERE: qualified_name contains
      startsWith,     // WHERE: name starts with
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, length(name) ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;

    // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
    // Pass 1: Find which files contain distinctive (rare) symbols from the query.
    // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

    // Pass 1: Find files containing each queried name, identify distinctive names
    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let sql = 'SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = ?';
      const params: (string | number)[] = [name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      sql += ' LIMIT 100';
      const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
      nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
    }

    // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    // Pass 2: Query each name with per-name limit, scoring by co-location
    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE name COLLATE NOCASE = ?
      `;
      const params: (string | number)[] = [name];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }

      // Fetch enough to find co-located results among common names
      sql += ' LIMIT ?';
      params.push(Math.max(perNameLimit * 3, 50));

      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const nameResults: SearchResult[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        // Boost results in files that also contain distinctive symbols
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: row.score + coLocationBoost });
      }

      // Sort by score (co-located first), take per-name limit
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    // Sort all results by score so co-located results bubble up
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30, excludePrefix } = options;

    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
    const params: (string | number)[] = [`%${substring}%`];

    // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
    if (excludePrefix) {
      sql += ` AND name NOT LIKE ?`;
      params.push(`${substring}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert a new edge
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    this.db.transaction(() => {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
    })();
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if ((kinds && kinds.length > 0) || provenance) {
      let sql = 'SELECT * FROM edges WHERE source = ?';
      const params: (string | number)[] = [sourceId];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (provenance) {
        sql += ' AND provenance = ?';
        params.push(provenance);
      }

      const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record.
   *
   * Churn columns (commit_count, loc, first_seen_ts, last_touched_ts)
   * are deliberately omitted from the ON CONFLICT update list — they
   * are managed exclusively by `applyChurnDeltas` / `applyLocUpdates`.
   * Adding them here would clobber mined git history on every re-index.
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      for (const ref of refs) {
        this.insertUnresolvedRef(ref);
      }
    });
    insert();
  }

  // (deleteUnresolvedByNode removed — never called; FK cascade on
  // nodes(id) → unresolved_refs.from_node_id handles cleanup automatically.)

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM unresolved_refs'
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        'SELECT * FROM unresolved_refs LIMIT ? OFFSET ?'
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
  getAllNodeNames(): string[] {
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];

    const placeholders = filePaths.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`)
      .all(...filePaths) as UnresolvedRefRow[];

    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): void {
    if (refs.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    const deleteMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
      }
    });
    deleteMany(refs);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    // Single query for all three aggregate counts
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      fileCount: counts.file_count,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  /**
   * Get a metadata value by key
   */
  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * Get all metadata as a key-value record
   */
  getAllMetadata(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Clear all data from the database
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
    })();
  }

  // ===========================================================================
  // Centrality (PageRank scores on nodes)
  // ===========================================================================

  /**
   * Apply PageRank scores to the nodes table in a single transaction.
   * Existing scores for ids not in the map are NOT cleared — call
   * `clearCentrality()` first for a from-scratch recompute.
   */
  applyCentralityScores(scores: Map<string, number>): void {
    if (scores.size === 0) return;
    const stmt = this.db.prepare('UPDATE nodes SET centrality = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const [id, score] of scores) {
        stmt.run(score, id);
      }
    })();
    // Cached node objects now have stale centrality. Drop the cache;
    // subsequent reads pull the fresh value.
    this.nodeCache.clear();
  }

  /** Reset all centrality values to NULL (fresh-recompute path). */
  clearCentrality(): void {
    this.db.exec('UPDATE nodes SET centrality = NULL');
    this.nodeCache.clear();
  }

  /**
   * Get top-N nodes by centrality, descending. Filters out NULL
   * centrality (= not yet computed). Optional `kind` filter narrows
   * to one node kind; optional `minCentrality` filters out the long
   * tail of essentially-zero ranks.
   */
  getTopNodesByCentrality(opts: {
    limit?: number;
    kind?: NodeKind;
    minCentrality?: number;
  } = {}): Node[] {
    const limit = opts.limit ?? 25;
    const minCentrality = opts.minCentrality ?? 0;
    const where: string[] = ['centrality IS NOT NULL', 'centrality >= ?'];
    const params: (string | number)[] = [minCentrality];
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    const sql = `SELECT * FROM nodes WHERE ${where.join(' AND ')}
                 ORDER BY centrality DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Compute the rank (1-based) of a single node by centrality.
   * Returns null if the node has no centrality yet.
   */
  getCentralityRank(nodeId: string): { rank: number; total: number } | null {
    const row = this.db
      .prepare('SELECT centrality FROM nodes WHERE id = ?')
      .get(nodeId) as { centrality: number | null } | undefined;
    if (!row || row.centrality === null) return null;
    const above = this.db
      .prepare('SELECT COUNT(*) AS c FROM nodes WHERE centrality > ?')
      .get(row.centrality) as { c: number };
    const total = this.db
      .prepare('SELECT COUNT(*) AS c FROM nodes WHERE centrality IS NOT NULL')
      .get() as { c: number };
    return { rank: above.c + 1, total: total.c };
  }

  // ===========================================================================
  // Per-file churn (mined from git log)
  // ===========================================================================

  /**
   * Apply churn deltas to the files table. For each delta:
   *   commit_count   += commitCountDelta
   *   last_touched_ts = MAX(existing, lastTouchedTs)
   *   first_seen_ts   = COALESCE(existing, firstSeenTs)   // sticky
   *
   * Files in the delta map but not in the files table (uncommon —
   * they'd have to be mined-but-never-indexed) are silently skipped.
   */
  applyChurnDeltas(
    deltas: Iterable<{
      path: string;
      commitCountDelta: number;
      lastTouchedTs: number;
      firstSeenTs: number;
    }>
  ): void {
    const stmt = this.db.prepare(
      `UPDATE files
         SET commit_count    = commit_count + ?,
             last_touched_ts = MAX(COALESCE(last_touched_ts, 0), ?),
             first_seen_ts   = COALESCE(first_seen_ts, ?)
       WHERE path = ?`
    );
    this.db.transaction(() => {
      for (const d of deltas) {
        stmt.run(d.commitCountDelta, d.lastTouchedTs, d.firstSeenTs, d.path);
      }
    })();
  }

  /** Reset all churn columns; used before a full re-mine. Does not touch `loc`. */
  clearChurn(): void {
    this.db.exec(
      `UPDATE files SET commit_count = 0, last_touched_ts = NULL, first_seen_ts = NULL`
    );
  }

  /** Update the on-disk LOC for a single file. Cheap; called per changed file. */
  updateFileLoc(filePath: string, loc: number): void {
    this.db.prepare('UPDATE files SET loc = ? WHERE path = ?').run(loc, filePath);
  }

  /** Bulk LOC update — used during indexAll to refresh LOC for every indexed file. */
  applyLocUpdates(entries: Iterable<{ path: string; loc: number }>): void {
    const stmt = this.db.prepare('UPDATE files SET loc = ? WHERE path = ?');
    this.db.transaction(() => {
      for (const e of entries) stmt.run(e.loc, e.path);
    })();
  }

  getTopFilesByChurn(opts: { limit?: number; minCommits?: number } = {}): FileRecord[] {
    const limit = opts.limit ?? 25;
    const minCommits = opts.minCommits ?? 1;
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE commit_count >= ?
         ORDER BY commit_count DESC LIMIT ?`
      )
      .all(minCommits, limit) as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Hotspots: files ranked by `risk = (Σ centrality of nodes in file) × commit_count`.
   *
   * Both inputs are optional in their own right; with neither computed,
   * this returns []. Sorting modes:
   *   - 'risk'        : the combined score (default; what "hotspot" means)
   *   - 'centrality'  : pure structural importance
   *   - 'churn'       : pure change frequency
   */
  getHotspots(opts: {
    limit?: number;
    minCommits?: number;
    minCentrality?: number;
    sortBy?: 'risk' | 'centrality' | 'churn';
  } = {}): Array<{
    filePath: string;
    fileCentrality: number;
    commitCount: number;
    loc: number;
    lastTouchedTs: number | null;
    riskScore: number;
  }> {
    const limit = opts.limit ?? 15;
    const minCommits = opts.minCommits ?? 0;
    const minCentrality = opts.minCentrality ?? 0;
    const sortBy = opts.sortBy ?? 'risk';

    const orderBy =
      sortBy === 'centrality'
        ? 'fileCentrality DESC'
        : sortBy === 'churn'
          ? 'commitCount DESC'
          : 'riskScore DESC';

    // Aggregate centrality at file level. LEFT JOIN so files without any
    // indexed nodes (rare — schema-only files) still surface if they have churn.
    const sql = `
      SELECT
        f.path                                     AS filePath,
        COALESCE(n_agg.fc, 0.0)                    AS fileCentrality,
        f.commit_count                             AS commitCount,
        f.loc                                      AS loc,
        f.last_touched_ts                          AS lastTouchedTs,
        COALESCE(n_agg.fc, 0.0) * f.commit_count   AS riskScore
      FROM files f
      LEFT JOIN (
        SELECT file_path, SUM(centrality) AS fc
        FROM nodes WHERE centrality IS NOT NULL
        GROUP BY file_path
      ) n_agg ON n_agg.file_path = f.path
      WHERE f.commit_count >= ? AND COALESCE(n_agg.fc, 0.0) >= ?
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(minCommits, minCentrality, limit) as Array<{
      filePath: string;
      fileCentrality: number;
      commitCount: number;
      loc: number;
      lastTouchedTs: number | null;
      riskScore: number;
    }>;
    return rows;
  }

  // ===========================================================================
  // Symbol-issue attributions (mined from git history)
  // ===========================================================================

  applyIssueAttributions(
    rows: Iterable<{
      nodeId: string;
      issueNumber: number;
      commitSha: string;
      kind: 'modified' | 'added' | 'removed';
    }>
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO symbol_issues (node_id, issue_number, commit_sha, kind)
       VALUES (?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(r.nodeId, r.issueNumber, r.commitSha, r.kind);
      }
    })();
  }

  clearIssueAttributions(): void {
    this.db.exec('DELETE FROM symbol_issues');
  }

  getIssuesForNode(nodeId: string): Array<{
    issueNumber: number;
    kind: 'modified' | 'added' | 'removed';
    commitSha: string;
  }> {
    return this.db
      .prepare(
        `SELECT issue_number AS issueNumber, kind, commit_sha AS commitSha
         FROM symbol_issues
         WHERE node_id = ?
         ORDER BY issue_number ASC, kind ASC`
      )
      .all(nodeId) as Array<{
      issueNumber: number;
      kind: 'modified' | 'added' | 'removed';
      commitSha: string;
    }>;
  }

  getNodesForIssue(issueNumber: number): Array<{
    nodeId: string;
    kind: 'modified' | 'added' | 'removed';
    commitSha: string;
  }> {
    return this.db
      .prepare(
        `SELECT node_id AS nodeId, kind, commit_sha AS commitSha
         FROM symbol_issues
         WHERE issue_number = ?
         ORDER BY node_id ASC`
      )
      .all(issueNumber) as Array<{
      nodeId: string;
      kind: 'modified' | 'added' | 'removed';
      commitSha: string;
    }>;
  }

  // ===========================================================================
  // Config references (env vars / feature flags read sites)
  // ===========================================================================

  applyConfigRefs(
    rows: Array<{
      configKind: 'env';
      configKey: string;
      sourceNodeId: string | null;
      filePath: string;
      line: number;
    }>
  ): void {
    if (rows.length === 0) return;
    const distinctFiles = new Set(rows.map((r) => r.filePath));
    const deleteStmt = this.db.prepare('DELETE FROM config_refs WHERE file_path = ?');
    const insertStmt = this.db.prepare(
      `INSERT INTO config_refs (config_kind, config_key, source_node_id, file_path, line)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const f of distinctFiles) deleteStmt.run(f);
      for (const r of rows) {
        insertStmt.run(r.configKind, r.configKey, r.sourceNodeId, r.filePath, r.line);
      }
    })();
  }

  clearConfigRefs(): void {
    this.db.exec('DELETE FROM config_refs');
  }

  deleteConfigRefsForPaths(filePaths: Iterable<string>): void {
    const stmt = this.db.prepare('DELETE FROM config_refs WHERE file_path = ?');
    this.db.transaction(() => {
      for (const p of filePaths) stmt.run(p);
    })();
  }

  pruneOrphanedConfigRefs(): void {
    this.db.exec(
      `DELETE FROM config_refs WHERE file_path NOT IN (SELECT path FROM files)`
    );
  }

  getConfigKeys(opts: { configKind?: 'env'; limit?: number } = {}): Array<{
    configKey: string;
    reads: number;
    distinctFiles: number;
  }> {
    const limit = opts.limit ?? 200;
    const where = opts.configKind ? 'WHERE config_kind = ?' : '';
    const params = opts.configKind ? [opts.configKind, limit] : [limit];
    return this.db
      .prepare(
        `SELECT config_key AS configKey,
                COUNT(*) AS reads,
                COUNT(DISTINCT file_path) AS distinctFiles
         FROM config_refs
         ${where}
         GROUP BY config_key
         ORDER BY reads DESC, config_key ASC
         LIMIT ?`
      )
      .all(...params) as Array<{ configKey: string; reads: number; distinctFiles: number }>;
  }

  getConfigRefsByKey(
    configKey: string,
    opts: { configKind?: 'env' } = {}
  ): Array<{
    filePath: string;
    line: number;
    sourceNodeId: string | null;
    sourceName: string | null;
    sourceKind: string | null;
  }> {
    const kind = opts.configKind ?? 'env';
    return this.db
      .prepare(
        `SELECT cr.file_path AS filePath,
                cr.line AS line,
                cr.source_node_id AS sourceNodeId,
                n.name AS sourceName,
                n.kind AS sourceKind
         FROM config_refs cr
         LEFT JOIN nodes n ON n.id = cr.source_node_id
         WHERE cr.config_kind = ? AND cr.config_key = ?
         ORDER BY cr.file_path ASC, cr.line ASC`
      )
      .all(kind, configKey) as Array<{
      filePath: string;
      line: number;
      sourceNodeId: string | null;
      sourceName: string | null;
      sourceKind: string | null;
    }>;
  }

  getConfigKeysForNode(nodeId: string): Array<{ configKey: string; line: number }> {
    return this.db
      .prepare(
        `SELECT config_key AS configKey, line
         FROM config_refs
         WHERE source_node_id = ?
         ORDER BY config_key ASC, line ASC`
      )
      .all(nodeId) as Array<{ configKey: string; line: number }>;
  }

  // ===========================================================================
  // SQL references (table-name string-literal refs from app code)
  // ===========================================================================

  applySqlRefs(
    rows: Array<{
      tableName: string;
      op: 'read' | 'write' | 'ddl';
      sourceNodeId: string | null;
      filePath: string;
      line: number;
    }>
  ): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO sql_refs (table_name, op, source_node_id, file_path, line)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(r.tableName, r.op, r.sourceNodeId, r.filePath, r.line);
      }
    })();
  }

  replaceAllSqlRefs(
    rows: Array<{
      tableName: string;
      op: 'read' | 'write' | 'ddl';
      sourceNodeId: string | null;
      filePath: string;
      line: number;
    }>
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO sql_refs (table_name, op, source_node_id, file_path, line)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      this.db.exec('DELETE FROM sql_refs');
      for (const r of rows) {
        insert.run(r.tableName, r.op, r.sourceNodeId, r.filePath, r.line);
      }
    })();
  }

  deleteSqlRefsForPaths(filePaths: Iterable<string>): void {
    const stmt = this.db.prepare('DELETE FROM sql_refs WHERE file_path = ?');
    this.db.transaction(() => {
      for (const p of filePaths) stmt.run(p);
    })();
  }

  clearSqlRefs(): void {
    this.db.exec('DELETE FROM sql_refs');
  }

  pruneOrphanedSqlRefs(): void {
    this.db.exec(
      `DELETE FROM sql_refs WHERE file_path NOT IN (SELECT path FROM files)`
    );
  }

  getSqlTables(opts: { limit?: number } = {}): Array<{
    tableName: string;
    reads: number;
    writes: number;
    ddl: number;
    total: number;
  }> {
    const limit = opts.limit ?? 100;
    return this.db
      .prepare(
        `SELECT lower(table_name) AS tableName,
                SUM(CASE WHEN op = 'read'  THEN 1 ELSE 0 END) AS reads,
                SUM(CASE WHEN op = 'write' THEN 1 ELSE 0 END) AS writes,
                SUM(CASE WHEN op = 'ddl'   THEN 1 ELSE 0 END) AS ddl,
                COUNT(*)                                       AS total
         FROM sql_refs
         GROUP BY lower(table_name)
         ORDER BY total DESC, tableName ASC
         LIMIT ?`
      )
      .all(limit) as Array<{
      tableName: string;
      reads: number;
      writes: number;
      ddl: number;
      total: number;
    }>;
  }

  getSqlRefsByTable(
    tableName: string,
    opts: { op?: 'read' | 'write' | 'ddl' } = {}
  ): Array<{
    op: 'read' | 'write' | 'ddl';
    filePath: string;
    line: number;
    sourceNodeId: string | null;
    sourceName: string | null;
    sourceKind: string | null;
  }> {
    const params: Array<string> = [tableName.toLowerCase()];
    let opFilter = '';
    if (opts.op) {
      opFilter = ' AND sr.op = ?';
      params.push(opts.op);
    }
    return this.db
      .prepare(
        `SELECT sr.op AS op,
                sr.file_path AS filePath,
                sr.line AS line,
                sr.source_node_id AS sourceNodeId,
                n.name AS sourceName,
                n.kind AS sourceKind
         FROM sql_refs sr
         LEFT JOIN nodes n ON n.id = sr.source_node_id
         WHERE lower(sr.table_name) = ?${opFilter}
         ORDER BY sr.file_path ASC, sr.line ASC`
      )
      .all(...params) as Array<{
      op: 'read' | 'write' | 'ddl';
      filePath: string;
      line: number;
      sourceNodeId: string | null;
      sourceName: string | null;
      sourceKind: string | null;
    }>;
  }

  getSqlTablesForNode(nodeId: string): Array<{ tableName: string; op: string }> {
    return this.db
      .prepare(
        `SELECT DISTINCT lower(table_name) AS tableName, op
         FROM sql_refs
         WHERE source_node_id = ?
         ORDER BY tableName ASC, op ASC`
      )
      .all(nodeId) as Array<{ tableName: string; op: string }>;
  }
}
