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
    deleteEdgesBySourceAndKind?: SqliteStatement;
    deleteAllEdgesByKind?: SqliteStatement;
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
    upsertNodeCoverage?: SqliteStatement;
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
   * Find class-like nodes whose `contains` subtree has at least
   * `minMembers` method/property children. Backs the `god_class`
   * biomarker — a class with dozens of members is almost always
   * a candidate for splitting. Sorted by memberCount desc so the
   * worst offenders surface first.
   *
   * Includes interfaces and structs (Go's `interface`/`struct`
   * with attached methods can grow just as unwieldy as a Java class).
   */
  findGodClasses(
    minMembers: number
  ): Array<{ id: string; name: string; filePath: string; memberCount: number }> {
    const sql = `
      SELECT n.id, n.name, n.file_path AS filePath, COUNT(child.id) AS memberCount
      FROM nodes n
      JOIN edges e ON e.source = n.id AND e.kind = 'contains'
      JOIN nodes child ON e.target = child.id
      WHERE n.kind IN ('class', 'struct', 'interface', 'trait', 'protocol')
        AND child.kind IN ('method', 'function', 'property', 'field')
      GROUP BY n.id, n.name, n.file_path
      HAVING memberCount >= ?
      ORDER BY memberCount DESC
    `;
    return this.db.prepare(sql).all(minMembers) as Array<{
      id: string;
      name: string;
      filePath: string;
      memberCount: number;
    }>;
  }

  /**
   * Find methods showing "feature envy" — they call into another
   * file's API at least `minExternalCalls` times AND at least
   * `externalRatio`× as often as into their own file. Backs the
   * `feature_envy` biomarker.
   *
   * "Same class" is approximated by "same file" — a more accurate
   * implementation would walk the `contains` chain to find the
   * enclosing class, but file-grouping is correct in practice for
   * any reasonable codebase (one class per file is the dominant
   * style across our supported languages).
   */
  findFeatureEnvy(
    minExternalCalls: number,
    externalRatio: number
  ): Array<{
    id: string;
    name: string;
    filePath: string;
    externalCalls: number;
    sameFileCalls: number;
  }> {
    const sql = `
      WITH outbound AS (
        SELECT src.id AS srcId, src.name AS srcName, src.file_path AS srcFile,
               tgt.file_path AS tgtFile
        FROM edges e
        JOIN nodes src ON e.source = src.id
        JOIN nodes tgt ON e.target = tgt.id
        WHERE e.kind = 'calls' AND src.kind IN ('method', 'function')
      )
      SELECT srcId AS id, srcName AS name, srcFile AS filePath,
             SUM(CASE WHEN tgtFile != srcFile THEN 1 ELSE 0 END) AS externalCalls,
             SUM(CASE WHEN tgtFile  = srcFile THEN 1 ELSE 0 END) AS sameFileCalls
      FROM outbound
      GROUP BY srcId, srcName, srcFile
      HAVING externalCalls >= ?
        AND externalCalls >= sameFileCalls * ?
      ORDER BY externalCalls DESC
    `;
    return this.db.prepare(sql).all(minExternalCalls, externalRatio) as Array<{
      id: string;
      name: string;
      filePath: string;
      externalCalls: number;
      sameFileCalls: number;
    }>;
  }

  /**
   * Find exported nodes that have no incoming graph edge from outside
   * their own file. Used by the `unused_export` biomarker to flag
   * dead public API after refactors.
   *
   * Excluded as "not real use":
   *   - `contains`: structural; every method is contained by its class
   *   - `exports`:  re-export barrels (`export { foo } from './a'`)
   *                 forward the symbol but don't consume it. Without
   *                 excluding this kind a re-export chain would mark
   *                 every dead-but-re-exported symbol as "used".
   *   - `imports`:  the import statement itself isn't a use; it just
   *                 brings the name into scope. Real use shows up as
   *                 `calls`/`references`/`instantiates`/`extends`/etc.
   *   - `tests`:    convention-derived test→subject edges aren't a
   *                 semantic call into the symbol's API.
   *
   * Also excludes node kinds that are never meaningful targets of the
   * rule: file/import/parameter/enum_member/field.
   */
  findUnusedExports(): Array<{ id: string; name: string; filePath: string; kind: string }> {
    const sql = `
      SELECT n.id, n.name, n.file_path AS filePath, n.kind
      FROM nodes n
      WHERE n.is_exported = 1
        AND n.kind NOT IN ('file', 'import', 'parameter', 'enum_member', 'field')
        AND NOT EXISTS (
          SELECT 1 FROM edges e
          JOIN nodes src ON e.source = src.id
          WHERE e.target = n.id
            AND src.file_path != n.file_path
            AND e.kind NOT IN ('contains', 'exports', 'imports', 'tests')
        )
    `;
    return this.db.prepare(sql).all() as Array<{
      id: string;
      name: string;
      filePath: string;
      kind: string;
    }>;
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
   * Delete all edges of a given kind from a single source node. Used by
   * the tests-edges rebuild path to refresh `tests` edges for a single
   * test file without disturbing its other outgoing edges.
   */
  deleteEdgesBySourceAndKind(sourceId: string, kind: EdgeKind): void {
    if (!this.stmts.deleteEdgesBySourceAndKind) {
      this.stmts.deleteEdgesBySourceAndKind = this.db.prepare(
        'DELETE FROM edges WHERE source = ? AND kind = ?'
      );
    }
    this.stmts.deleteEdgesBySourceAndKind.run(sourceId, kind);
  }

  /**
   * Delete every edge of a given kind across the whole graph. Used to
   * fully rebuild a derived edge layer (e.g. `tests`) before re-inserting
   * the current set.
   */
  deleteAllEdgesByKind(kind: EdgeKind): void {
    if (!this.stmts.deleteAllEdgesByKind) {
      this.stmts.deleteAllEdgesByKind = this.db.prepare(
        'DELETE FROM edges WHERE kind = ?'
      );
    }
    this.stmts.deleteAllEdgesByKind.run(kind);
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
      this.db.exec('DELETE FROM co_changes');
      this.db.exec('DELETE FROM symbol_embeddings');
      this.db.exec('DELETE FROM symbol_summaries');
      this.db.exec('DELETE FROM directory_summaries');
      this.db.exec('DELETE FROM node_coverage');
      this.db.exec('DELETE FROM code_health_findings');
    })();
  }

  // ===========================================================================
  // Centrality (PageRank scores on nodes)
  // ===========================================================================

  applyCentralityScores(scores: Map<string, number>): void {
    if (scores.size === 0) return;
    const stmt = this.db.prepare('UPDATE nodes SET centrality = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const [id, score] of scores) {
        stmt.run(score, id);
      }
    })();
    this.nodeCache.clear();
  }

  clearCentrality(): void {
    this.db.exec('UPDATE nodes SET centrality = NULL');
    this.nodeCache.clear();
  }

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
  // Co-Change (file-level coupling derived from git history)
  // ===========================================================================

  applyCoChangeDeltas(
    pairDeltas: Iterable<[string, string, number]>,
    fileCommitDeltas: Iterable<[string, number]>
  ): void {
    const upsertPair = this.db.prepare(`
      INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)
      ON CONFLICT(file_a, file_b) DO UPDATE SET count = count + excluded.count
    `);
    const incFileCommit = this.db.prepare(`
      UPDATE files SET commit_count = commit_count + ? WHERE path = ?
    `);
    this.db.transaction(() => {
      for (const [a, b, delta] of pairDeltas) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        if (lo === hi) continue;
        upsertPair.run(lo, hi, delta);
      }
      for (const [path, delta] of fileCommitDeltas) {
        incFileCommit.run(delta, path);
      }
    })();
  }

  // ===========================================================================
  // Per-file churn (mined from git log)
  // ===========================================================================

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

  // ===========================================================================
  // Co-Change reads
  // ===========================================================================

  clearCoChanges(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM co_changes');
      this.db.exec('DELETE FROM symbol_embeddings');
      this.db.exec('DELETE FROM symbol_summaries');
      this.db.exec('DELETE FROM directory_summaries');
      this.db.exec('UPDATE files SET commit_count = 0');
    })();
  }

  getCoChangedFiles(
    filePath: string,
    options: { limit?: number; minCount?: number; minJaccard?: number } = {}
  ): Array<{ path: string; count: number; jaccard: number }> {
    const limit = options.limit ?? 10;
    const minCount = options.minCount ?? 2;
    const minJaccard = options.minJaccard ?? 0;
    const sql = `
      WITH partners AS (
        SELECT file_b AS path, count FROM co_changes WHERE file_a = ?
        UNION ALL
        SELECT file_a AS path, count FROM co_changes WHERE file_b = ?
      ),
      anchor AS (SELECT commit_count AS c FROM files WHERE path = ?),
      scored AS (
        SELECT
          p.path AS path,
          p.count AS count,
          CAST(p.count AS REAL) / NULLIF((SELECT c FROM anchor) + f.commit_count - p.count, 0) AS jaccard
        FROM partners p
        JOIN files f ON f.path = p.path
        WHERE p.count >= ?
      )
      SELECT path, count, jaccard FROM scored
      WHERE COALESCE(jaccard, 0) >= ?
      ORDER BY jaccard DESC, count DESC
      LIMIT ?
    `;
    const rows = this.db
      .prepare(sql)
      .all(filePath, filePath, filePath, minCount, minJaccard, limit) as Array<{
        path: string;
        count: number;
        jaccard: number | null;
      }>;
    return rows.map((r) => ({ path: r.path, count: r.count, jaccard: r.jaccard ?? 0 }));
  }


  // ==========================================================================
  // Symbol Summaries (LLM-generated one-liners; populated by background pass)
  // ==========================================================================

  /**
   * Get every symbol whose body is meaningful enough to summarise and
   * whose existing docstring (if any) is shorter than `docThreshold`
   * chars. Sorted by file_path so callers iterating in order can warm
   * the file-content cache.
   */
  getSummarizableNodes(
    kinds: ReadonlySet<string>,
    minBodyLines: number,
    docCharThreshold: number
  ): Node[] {
    if (kinds.size === 0) return [];
    const placeholders = [...kinds].map(() => '?').join(',');
    const sql = `
      SELECT * FROM nodes
      WHERE kind IN (${placeholders})
        AND (end_line - start_line) >= ?
        AND (docstring IS NULL OR length(docstring) < ?)
      ORDER BY file_path, start_line
    `;
    const params: (string | number)[] = [...kinds, minBodyLines, docCharThreshold];
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Read a single symbol's cached summary, or null if none exists.
   */
  getSymbolSummary(nodeId: string): { summary: string; contentHash: string; model: string } | null {
    const row = this.db
      .prepare('SELECT summary, content_hash, model FROM symbol_summaries WHERE node_id = ?')
      .get(nodeId) as { summary: string; content_hash: string; model: string } | undefined;
    if (!row) return null;
    return { summary: row.summary, contentHash: row.content_hash, model: row.model };
  }

  /**
   * Bulk fetch summaries for a set of node IDs. Returns a Map keyed by id;
   * absent entries are nodes without a cached summary.
   */
  getSymbolSummaries(nodeIds: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (nodeIds.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < nodeIds.length; i += CHUNK) {
      const chunk = nodeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT node_id, summary FROM symbol_summaries WHERE node_id IN (${placeholders})`)
        .all(...chunk) as Array<{ node_id: string; summary: string }>;
      for (const r of rows) out.set(r.node_id, r.summary);
    }
    return out;
  }

  /**
   * Insert or replace a summary. The unique key is `node_id`; the
   * content_hash is the consistency anchor that lets the next pass
   * detect a stale entry and regenerate.
   */
  upsertSymbolSummary(nodeId: string, contentHash: string, summary: string, model: string): void {
    this.db
      .prepare(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          summary = excluded.summary,
          model = excluded.model,
          generated_at = excluded.generated_at
      `)
      .run(nodeId, contentHash, summary, model, Date.now());
  }

  /**
   * Summaries that are missing an embedding for the given embedding
   * model (or have one keyed to a different model). These are the
   * candidates the embedder should run on.
   *
   * Joins to nodes only to surface name/signature, which we feed into
   * the embedding text so search hits match by name + intent.
   */
  getEmbeddableSummaries(
    embeddingModel: string
  ): Array<{ nodeId: string; name: string; signature: string | null; summary: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.node_id AS node_id, n.name AS name, n.signature AS signature, s.summary AS summary
         FROM symbol_summaries s
         JOIN nodes n ON n.id = s.node_id
         LEFT JOIN symbol_embeddings e ON e.node_id = s.node_id
         WHERE e.embedding_model IS NULL
            OR e.embedding_model != ?`
      )
      .all(embeddingModel) as Array<{
      node_id: string;
      name: string;
      signature: string | null;
      summary: string;
    }>;
    return rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      signature: r.signature,
      summary: r.summary,
    }));
  }

  /**
   * Bulk fetch every summary's embedding for the active model. Used by
   * the in-process semantic search scan. Cheap because BLOBs are
   * already byte-aligned in SQLite.
   */
  getAllEmbeddings(
    embeddingModel: string
  ): Array<{ nodeId: string; embedding: Buffer }> {
    const rows = this.db
      .prepare(
        `SELECT node_id, embedding FROM symbol_embeddings
         WHERE embedding_model = ?`
      )
      .all(embeddingModel) as Array<{ node_id: string; embedding: Buffer }>;
    return rows.map((r) => ({ nodeId: r.node_id, embedding: r.embedding }));
  }

  /**
   * Persist an embedding for a previously-summarised symbol. The
   * caller passes raw Float32 bytes (already L2-normalised).
   */
  upsertSymbolEmbedding(nodeId: string, embedding: Buffer | Uint8Array, model: string): void {
    this.db
      .prepare(
        `INSERT INTO symbol_embeddings (node_id, embedding, embedding_model)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           embedding = excluded.embedding,
           embedding_model = excluded.embedding_model`
      )
      .run(nodeId, embedding, model);
  }

  // ==========================================================================
  // Per-symbol Coverage (from external CI artifacts)
  // ==========================================================================

  /**
   * Upsert one (node_id, source) row in `node_coverage`. Idempotent
   * on the (node_id, source) PK.
   *
   * **Stale-row caveat**: re-running ingestion under the same source
   * key only touches symbols present in the new report. If a file is
   * excluded from a later run (renamed, scope narrowed), the previous
   * row stays in the table until the symbol is deleted. To force a
   * full refresh, either DELETE FROM node_coverage WHERE source = ?
   * before ingestion, or pass a fresh source key per run.
   */
  upsertNodeCoverage(
    nodeId: string,
    source: string,
    coveredLines: number,
    totalLines: number,
    coveredBranches: number | null,
    totalBranches: number | null,
    ingestedAt: number
  ): void {
    if (!this.stmts.upsertNodeCoverage) {
      this.stmts.upsertNodeCoverage = this.db.prepare(
        `INSERT INTO node_coverage
           (node_id, source, covered_lines, total_lines,
            covered_branches, total_branches, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id, source) DO UPDATE SET
           covered_lines    = excluded.covered_lines,
           total_lines      = excluded.total_lines,
           covered_branches = excluded.covered_branches,
           total_branches   = excluded.total_branches,
           ingested_at      = excluded.ingested_at`
      );
    }
    this.stmts.upsertNodeCoverage.run(
      nodeId, source, coveredLines, totalLines, coveredBranches, totalBranches, ingestedAt
    );
  }

  /**
   * Drop every `node_coverage` row for a given source. Used when a
   * caller wants to force a full refresh under the same source key
   * (e.g., the report scope changed and stale rows would mislead).
   */
  clearCoverageSource(source: string): number {
    const result = this.db
      .prepare('DELETE FROM node_coverage WHERE source = ?')
      .run(source);
    return result.changes;
  }

  /**
   * Coverage rollup for a single symbol. Returns the highest-coverage
   * row across all sources (so a function covered 100% by unit tests
   * and 50% by e2e returns the 100% row). Useful when an agent just
   * wants "is this tested at all?" without caring which suite.
   */
  getNodeCoverage(nodeId: string): {
    source: string;
    coveredLines: number;
    totalLines: number;
    coveredBranches: number | null;
    totalBranches: number | null;
    ingestedAt: number;
  } | null {
    const row = this.db
      .prepare(
        `SELECT source, covered_lines, total_lines, covered_branches,
                total_branches, ingested_at
         FROM node_coverage
         WHERE node_id = ?
         ORDER BY (CAST(covered_lines AS REAL) / NULLIF(total_lines, 0)) DESC
         LIMIT 1`
      )
      .get(nodeId) as
      | {
          source: string;
          covered_lines: number;
          total_lines: number;
          covered_branches: number | null;
          total_branches: number | null;
          ingested_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      source: row.source,
      coveredLines: row.covered_lines,
      totalLines: row.total_lines,
      coveredBranches: row.covered_branches,
      totalBranches: row.total_branches,
      ingestedAt: row.ingested_at,
    };
  }

  /**
   * Symbols covered for at least one source ordered by *worst*
   * coverage first. The killer agent query: pair this with a
   * centrality filter to surface "high-impact untested code."
   */
  getCoverageRanked(options: {
    minCentrality?: number;
    maxPct?: number;
    kinds?: ReadonlyArray<string>;
    limit?: number;
    source?: string;
  } = {}): Array<{
    nodeId: string;
    name: string;
    kind: string;
    filePath: string;
    pct: number;
    coveredLines: number;
    totalLines: number;
    centrality: number | null;
  }> {
    const limit = options.limit ?? 50;
    const params: Record<string, unknown> = { limit };
    const where: string[] = [];

    if (options.source !== undefined) {
      where.push('c.source = @source');
      params.source = options.source;
    }
    if (options.maxPct !== undefined) {
      where.push('(CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0)) <= @maxPct');
      params.maxPct = options.maxPct;
    }
    if (options.minCentrality !== undefined) {
      where.push('n.centrality >= @minCentrality');
      params.minCentrality = options.minCentrality;
    }
    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map((_, i) => `@kind${i}`).join(', ');
      where.push(`n.kind IN (${placeholders})`);
      options.kinds.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
    }

    const sql = `
      SELECT n.id AS node_id, n.name, n.kind, n.file_path,
             c.covered_lines, c.total_lines, n.centrality,
             (CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0)) AS pct
      FROM nodes n
      JOIN node_coverage c ON c.node_id = n.id
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY pct ASC, n.centrality DESC NULLS LAST
      LIMIT @limit
    `;
    const rows = this.db.prepare(sql).all(params) as Array<{
      node_id: string;
      name: string;
      kind: string;
      file_path: string;
      covered_lines: number;
      total_lines: number;
      // SQLite returns NULL for the pct expression when total_lines
      // is 0 (NULLIF guards against div/0). The orchestrator filters
      // those rows out before insert, but be defensive in case rows
      // arrive via direct SQL.
      pct: number | null;
      centrality: number | null;
    }>;
    return rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      pct: r.pct ?? 0,
      coveredLines: r.covered_lines,
      totalLines: r.total_lines,
      centrality: r.centrality,
    }));
  }

  /**
   * Aggregate coverage across the whole project (or a single source).
   * Used by `codegraph_status` when surfacing project-wide health.
   */
  getCoverageStats(source?: string): {
    sources: string[];
    symbolsWithCoverage: number;
    weightedPct: number;
    coveredLines: number;
    totalLines: number;
  } {
    const where = source ? 'WHERE source = ?' : '';
    const args = source ? [source] : [];
    const sources = this.db
      .prepare(`SELECT DISTINCT source FROM node_coverage ${where}`)
      .all(...args) as Array<{ source: string }>;
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(covered_lines) AS cov,
                SUM(total_lines) AS tot
         FROM node_coverage ${where}`
      )
      .get(...args) as { n: number; cov: number | null; tot: number | null };
    const cov = agg.cov ?? 0;
    const tot = agg.tot ?? 0;
    return {
      sources: sources.map((r) => r.source),
      symbolsWithCoverage: agg.n,
      weightedPct: tot > 0 ? cov / tot : 0,
      coveredLines: cov,
      totalLines: tot,
    };
  }

  // ==========================================================================
  // Biomarker findings (Code Health)
  // ==========================================================================

  /**
   * Append findings without touching existing ones. Used by cross-file
   * rules (like `unused_export`) that compute findings AFTER the
   * per-file replace pass has already written, and so can't go through
   * `replaceFindingsForFile` without clobbering. Atomic per call.
   *
   * Caller must ensure the same finding isn't appended twice — this
   * method does no dedup. For `unused_export` that's safe because
   * each scan starts by globally clearing the kind: see
   * `clearFindingsByKind`.
   */
  appendFindings(
    findings: ReadonlyArray<{
      nodeId: string;
      biomarker: string;
      severity: 'info' | 'warning' | 'error';
      metric: number;
      detail?: unknown;
    }>
  ): void {
    if (findings.length === 0) return;
    const now = Date.now();
    const ins = this.db.prepare(
      `INSERT INTO code_health_findings
         (node_id, biomarker, severity, metric, detail, detected_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const f of findings) {
        ins.run(
          f.nodeId,
          f.biomarker,
          f.severity,
          f.metric,
          f.detail !== undefined ? JSON.stringify(f.detail) : null,
          now
        );
      }
    })();
  }

  /** Drop all findings of a single biomarker kind across the project.
   *  Used by cross-file rules before re-scanning so old hits don't
   *  linger when the underlying graph state changes. */
  clearFindingsByKind(biomarker: string): void {
    this.db.prepare('DELETE FROM code_health_findings WHERE biomarker = ?').run(biomarker);
  }

  /**
   * Replace every finding for the nodes belonging to `filePath`.
   * Atomic — readers never see a half-written file.
   *
   * The map is `node_id → findings[]`. Nodes in `filePath` not present
   * in the map have their findings cleared (turning warnings into
   * green is a real outcome; we want it reflected immediately).
   */
  replaceFindingsForFile(
    filePath: string,
    findingsByNode: ReadonlyMap<string, ReadonlyArray<{
      biomarker: string;
      severity: 'info' | 'warning' | 'error';
      metric: number;
      detail?: unknown;
    }>>
  ): void {
    const now = Date.now();
    this.db.transaction(() => {
      // Cross-file biomarkers (computed from global graph state, not
      // from this file's AST) must NOT be wiped by per-file replace,
      // or sync runs that touch a file will silently lose those
      // findings without recomputing them. Add new cross-file kinds
      // to the NOT-IN list as they're introduced.
      this.db
        .prepare(
          `DELETE FROM code_health_findings
           WHERE biomarker NOT IN ('unused_export', 'god_class', 'feature_envy')
             AND node_id IN (SELECT id FROM nodes WHERE file_path = ?)`
        )
        .run(filePath);

      const ins = this.db.prepare(
        `INSERT INTO code_health_findings
           (node_id, biomarker, severity, metric, detail, detected_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const [nodeId, findings] of findingsByNode) {
        for (const f of findings) {
          ins.run(
            nodeId,
            f.biomarker,
            f.severity,
            f.metric,
            f.detail !== undefined ? JSON.stringify(f.detail) : null,
            now
          );
        }
      }
    })();
  }

  /** All findings on a single symbol, ordered by severity then biomarker. */
  getFindingsForNode(nodeId: string): Array<{
    biomarker: string;
    severity: 'info' | 'warning' | 'error';
    metric: number;
    detail: unknown | null;
    detectedAt: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT biomarker, severity, metric, detail, detected_at
         FROM code_health_findings
         WHERE node_id = ?
         ORDER BY CASE severity
                    WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2
                  END, biomarker`
      )
      .all(nodeId) as Array<{
      biomarker: string;
      severity: 'info' | 'warning' | 'error';
      metric: number;
      detail: string | null;
      detected_at: number;
    }>;
    return rows.map((r) => ({
      biomarker: r.biomarker,
      severity: r.severity,
      metric: r.metric,
      detail: r.detail !== null ? JSON.parse(r.detail) : null,
      detectedAt: r.detected_at,
    }));
  }

  /**
   * Symbols ranked by severity of their worst finding. Joins centrality
   * so the agent can ask "what's the worst-health, highest-impact code
   * in the project?" with one query.
   */
  getFindingsRanked(options: {
    biomarker?: string;
    minSeverity?: 'info' | 'warning' | 'error';
    minCentrality?: number;
    limit?: number;
  } = {}): Array<{
    nodeId: string;
    name: string;
    kind: string;
    filePath: string;
    biomarker: string;
    severity: 'info' | 'warning' | 'error';
    metric: number;
    centrality: number | null;
  }> {
    const limit = options.limit ?? 50;
    const params: Record<string, unknown> = { limit };
    const where: string[] = [];

    if (options.biomarker !== undefined) {
      where.push('f.biomarker = @biomarker');
      params.biomarker = options.biomarker;
    }
    if (options.minSeverity !== undefined) {
      where.push(
        `CASE f.severity WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END >=
         CASE @minSev WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END`
      );
      params.minSev = options.minSeverity;
    }
    if (options.minCentrality !== undefined) {
      where.push('n.centrality >= @minCentrality');
      params.minCentrality = options.minCentrality;
    }

    const sql = `
      SELECT n.id AS node_id, n.name, n.kind, n.file_path,
             f.biomarker, f.severity, f.metric, n.centrality
      FROM code_health_findings f
      JOIN nodes n ON n.id = f.node_id
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE f.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        n.centrality DESC NULLS LAST,
        f.metric DESC
      LIMIT @limit
    `;
    const rows = this.db.prepare(sql).all(params) as Array<{
      node_id: string;
      name: string;
      kind: string;
      file_path: string;
      biomarker: string;
      severity: 'info' | 'warning' | 'error';
      metric: number;
      centrality: number | null;
    }>;
    return rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      biomarker: r.biomarker,
      severity: r.severity,
      metric: r.metric,
      centrality: r.centrality,
    }));
  }

  /** Project-wide rollup: per-biomarker counts and per-severity counts. */
  getFindingsStats(): {
    totalFindings: number;
    byBiomarker: Record<string, number>;
    bySeverity: Record<string, number>;
    nodesWithFindings: number;
  } {
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM code_health_findings`)
      .get() as { n: number };
    const byBiomarker = this.db
      .prepare(`SELECT biomarker, COUNT(*) AS n FROM code_health_findings GROUP BY biomarker`)
      .all() as Array<{ biomarker: string; n: number }>;
    const bySeverity = this.db
      .prepare(`SELECT severity, COUNT(*) AS n FROM code_health_findings GROUP BY severity`)
      .all() as Array<{ severity: string; n: number }>;
    const nodes = this.db
      .prepare(`SELECT COUNT(DISTINCT node_id) AS n FROM code_health_findings`)
      .get() as { n: number };
    return {
      totalFindings: total.n,
      byBiomarker: Object.fromEntries(byBiomarker.map((r) => [r.biomarker, r.n])),
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.n])),
      nodesWithFindings: nodes.n,
    };
  }

  // ==========================================================================
  // Role Classification (LLM-generated coarse role labels)
  // ==========================================================================

  /** Symbols that have a summary but no (or stale) role for this model. */
  getClassifiableSummaries(
    roleModel: string
  ): Array<{ nodeId: string; name: string; kind: string; signature: string | null; summary: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.node_id AS node_id, n.name AS name, n.kind AS kind,
                n.signature AS signature, s.summary AS summary
         FROM symbol_summaries s
         JOIN nodes n ON n.id = s.node_id
         WHERE s.role IS NULL OR s.role_model IS NULL OR s.role_model != ?`
      )
      .all(roleModel) as Array<{
      node_id: string;
      name: string;
      kind: string;
      signature: string | null;
      summary: string;
    }>;
    return rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      kind: r.kind,
      signature: r.signature,
      summary: r.summary,
    }));
  }

  /** Persist a role assignment for a previously-summarised symbol. */
  upsertSymbolRole(nodeId: string, role: string, roleModel: string): void {
    this.db
      .prepare(
        `UPDATE symbol_summaries SET role = ?, role_model = ? WHERE node_id = ?`
      )
      .run(role, roleModel, nodeId);
  }

  /** Bulk fetch roles for a set of node ids. */
  getSymbolRoles(nodeIds: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (nodeIds.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < nodeIds.length; i += CHUNK) {
      const chunk = nodeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT node_id, role FROM symbol_summaries
           WHERE role IS NOT NULL AND node_id IN (${placeholders})`
        )
        .all(...chunk) as Array<{ node_id: string; role: string }>;
      for (const r of rows) out.set(r.node_id, r.role);
    }
    return out;
  }

  /** Find every node currently classified with a given role. */
  findNodesByRole(role: string, limit = 100): Node[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM nodes n
         JOIN symbol_summaries s ON s.node_id = n.id
         WHERE s.role = ?
         ORDER BY n.file_path, n.start_line
         LIMIT ?`
      )
      .all(role, limit) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Sample existing sibling names for the naming-convention checker.
   * Excludes the symbol's own file (so the new symbol's own name
   * doesn't bias the convention) and prefers symbols that have
   * survived multiple sync cycles (proxy: anything in the index).
   */
  sampleSiblingNames(
    kind: string,
    excludeName: string,
    excludeFile: string,
    limit: number
  ): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT name FROM nodes
         WHERE kind = ? AND name != ? AND file_path != ?
         ORDER BY name
         LIMIT ?`
      )
      .all(kind, excludeName, excludeFile, limit) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Find symbols with zero incoming `calls` edges that are not marked
   * exported. Pre-filter for the dead-code judge — cheap, runs in
   * SQL, narrows the LLM workload to the graph-suspicious set.
   */
  findOrphanedSymbols(limit = 200): Node[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM nodes n
         WHERE n.is_exported = 0
           AND n.kind IN ('function', 'method', 'class', 'component')
           AND NOT EXISTS (
             SELECT 1 FROM edges e
             WHERE e.target = n.id AND e.kind = 'calls'
           )
         ORDER BY n.file_path, n.start_line
         LIMIT ?`
      )
      .all(limit) as NodeRow[];
    return rows.map(rowToNode);
  }

  /** Counts of classified symbols by role (for status display). */
  getRoleCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT role, COUNT(*) AS n FROM symbol_summaries
         WHERE role IS NOT NULL GROUP BY role`
      )
      .all() as Array<{ role: string; n: number }>;
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.role, r.n);
    return out;
  }

  // ==========================================================================
  // Directory Summaries (LLM-generated module-level descriptions)
  // ==========================================================================

  /** Pull every (file_path, name, kind, summary) for symbols that
   *  already have a summary — used to group by directory for the
   *  module-level synthesis pass. */
  getSummarisedSymbolsByDir(): Array<{
    filePath: string;
    name: string;
    kind: string;
    summary: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT n.file_path AS file_path, n.name AS name, n.kind AS kind, s.summary AS summary
         FROM symbol_summaries s
         JOIN nodes n ON n.id = s.node_id
         ORDER BY n.file_path`
      )
      .all() as Array<{ file_path: string; name: string; kind: string; summary: string }>;
    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind,
      summary: r.summary,
    }));
  }

  /** Read a single directory's cached summary, or null. */
  getDirectorySummary(
    dirPath: string
  ): { summary: string; contentHash: string; model: string } | null {
    const row = this.db
      .prepare(
        `SELECT summary, content_hash, model FROM directory_summaries WHERE dir_path = ?`
      )
      .get(dirPath) as { summary: string; content_hash: string; model: string } | undefined;
    if (!row) return null;
    return { summary: row.summary, contentHash: row.content_hash, model: row.model };
  }

  /** Bulk fetch directory summaries by exact dir path. */
  getDirectorySummaries(dirPaths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (dirPaths.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < dirPaths.length; i += CHUNK) {
      const chunk = dirPaths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT dir_path, summary FROM directory_summaries WHERE dir_path IN (${placeholders})`
        )
        .all(...chunk) as Array<{ dir_path: string; summary: string }>;
      for (const r of rows) out.set(r.dir_path, r.summary);
    }
    return out;
  }

  /** All directory summaries (for codegraph status / explore). */
  getAllDirectorySummaries(): Array<{ dirPath: string; summary: string }> {
    const rows = this.db
      .prepare(`SELECT dir_path, summary FROM directory_summaries ORDER BY dir_path`)
      .all() as Array<{ dir_path: string; summary: string }>;
    return rows.map((r) => ({ dirPath: r.dir_path, summary: r.summary }));
  }

  /** Insert or replace a directory summary, keyed on dir_path. */
  upsertDirectorySummary(
    dirPath: string,
    contentHash: string,
    summary: string,
    model: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO directory_summaries (dir_path, summary, content_hash, model, generated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(dir_path) DO UPDATE SET
           summary = excluded.summary,
           content_hash = excluded.content_hash,
           model = excluded.model,
           generated_at = excluded.generated_at`
      )
      .run(dirPath, summary, contentHash, model, Date.now());
  }

  /**
   * Stats for `codegraph status`: how much of the index has summaries.
   * `total` counts only nodes that are *eligible* for summarisation —
   * counting parameters/imports/files in the denominator would
   * understate coverage and confuse the user.
   */
  getSummaryCoverage(kinds?: ReadonlySet<string>): { total: number; summarised: number } {
    let total: number;
    if (kinds && kinds.size > 0) {
      const placeholders = [...kinds].map(() => '?').join(',');
      total = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE kind IN (${placeholders})`)
          .get(...kinds) as { n: number }
      ).n;
    } else {
      total = (this.db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
    }
    const summarised = (this.db.prepare('SELECT COUNT(*) AS n FROM symbol_summaries').get() as { n: number }).n;
    return { total, summarised };
  }

}
