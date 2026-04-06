/**
 * Database Queries
 *
 * Async prepared statements for CRUD operations on the knowledge graph.
 * Works with both SQLite and PostgreSQL backends via the DbAdapter interface.
 */

import { DbAdapter, DbStatement } from './adapter';
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
import { safeJsonParse } from '../utils';
import { kindBonus, scorePathRelevance } from '../search/query-utils';

/**
 * Database row types (snake_case from database)
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
  };
}

/**
 * Convert UnresolvedRefRow to UnresolvedReference
 */
function rowToUnresolvedRef(row: UnresolvedRefRow): UnresolvedReference {
  return {
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
    filePath: row.file_path,
    language: row.language as Language,
  };
}

/**
 * Async query builder for the knowledge graph database.
 *
 * All methods are async to support both SQLite (sync wrapped in Promise.resolve)
 * and PostgreSQL (native async via pg driver) backends.
 */
export class QueryBuilder {
  private db: DbAdapter;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: DbStatement;
    updateNode?: DbStatement;
    deleteNode?: DbStatement;
    deleteNodesByFile?: DbStatement;
    getNodeById?: DbStatement;
    getNodesByFile?: DbStatement;
    getNodesByKind?: DbStatement;
    insertEdge?: DbStatement;
    upsertFile?: DbStatement;
    deleteEdgesBySource?: DbStatement;
    deleteEdgesByTarget?: DbStatement;
    getEdgesBySource?: DbStatement;
    getEdgesByTarget?: DbStatement;
    insertFile?: DbStatement;
    updateFile?: DbStatement;
    deleteFile?: DbStatement;
    getFileByPath?: DbStatement;
    getAllFiles?: DbStatement;
    insertUnresolved?: DbStatement;
    deleteUnresolvedByNode?: DbStatement;
    getUnresolvedByName?: DbStatement;
    getNodesByName?: DbStatement;
    getNodesByQualifiedNameExact?: DbStatement;
    getNodesByLowerName?: DbStatement;
    getUnresolvedCount?: DbStatement;
    getUnresolvedBatch?: DbStatement;
    getAllFilePaths?: DbStatement;
  } = {};

  constructor(db: DbAdapter) {
    this.db = db;
  }

  /**
   * Get the underlying database adapter.
   */
  getAdapter(): DbAdapter {
    return this.db;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  async insertNode(node: Node): Promise<void> {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @updatedAt
        )
      `);
    }

    // Validate required fields to prevent bind errors
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

    try {
      await this.stmts.insertNode.run({
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
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Insert multiple nodes in a transaction
   */
  async insertNodes(nodes: Node[]): Promise<void> {
    await this.db.transaction(async () => {
      for (const node of nodes) {
        await this.insertNode(node);
      }
    });
  }

  /**
   * Update an existing node
   */
  async updateNode(node: Node): Promise<void> {
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
          updated_at = @updatedAt
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

    await this.stmts.updateNode.run({
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
    });
  }

  /**
   * Delete a node by ID
   */
  async deleteNode(id: string): Promise<void> {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    await this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  async deleteNodesByFile(filePath: string): Promise<void> {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    await this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  async getNodeById(id: string): Promise<Node | null> {
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
    const row = await this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
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
  async getNodesByFile(filePath: string): Promise<Node[]> {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = await this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes of a specific kind
   */
  async getNodesByKind(kind: NodeKind): Promise<Node[]> {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = await this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes in the database
   */
  async getAllNodes(): Promise<Node[]> {
    const rows = await this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
  async getNodesByName(name: string): Promise<Node[]> {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = await this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  async getNodesByQualifiedNameExact(qualifiedName: string): Promise<Node[]> {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = await this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
  async getNodesByLowerName(lowerName: string): Promise<Node[]> {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = await this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS (FTS5 on SQLite, tsvector on PostgreSQL) for word-start matching
   * 2. If no results, try LIKE for substring matching
   * 3. Score results based on match quality
   */
  async searchNodes(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    // Delegate FTS to the adapter (handles SQLite FTS5 vs PostgreSQL tsvector)
    let results = await this.searchNodesFTS(query, { kinds, languages, limit, offset });

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && query.length >= 2) {
      results = await this.searchNodesLike(query, { kinds, languages, limit, offset });
    }

    // Apply multi-signal scoring
    if (results.length > 0 && query) {
      results = results.map(r => ({
        ...r,
        score: r.score + kindBonus(r.node.kind) + scorePathRelevance(r.node.filePath, query),
      }));
      results.sort((a, b) => b.score - a.score);
    }

    return results;
  }

  /**
   * FTS search -- delegates to the adapter's ftsSearch() method.
   * SQLite uses FTS5 MATCH + bm25, PostgreSQL uses tsvector + ts_rank_cd.
   */
  private async searchNodesFTS(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    const ftsResults = await this.db.ftsSearch(query, {
      kinds: kinds as NodeKind[],
      languages: languages as Language[],
      limit,
      offset,
    });

    return ftsResults.map(({ row, score }) => ({
      node: rowToNode(row as NodeRow),
      score,
    }));
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private async searchNodesLike(query: string, options: SearchOptions): Promise<SearchResult[]> {
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

    const rows = await this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * Find nodes by exact name match
   *
   * Uses case-insensitive matching via LOWER() for cross-database compatibility.
   */
  async findNodesByExactName(names: string[], options: SearchOptions = {}): Promise<SearchResult[]> {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;
    const lowerNames = names.map(n => n.toLowerCase());

    // Build query with exact matches (case-insensitive via LOWER)
    let sql = `
      SELECT nodes.*,
        CASE
          WHEN LOWER(name) IN (${lowerNames.map(() => '?').join(',')}) THEN 1.0
          ELSE 0.9
        END as score
      FROM nodes
      WHERE LOWER(name) IN (${lowerNames.map(() => '?').join(',')})
    `;

    // Duplicate lowerNames for both SELECT and WHERE clauses
    const params: (string | number)[] = [...lowerNames, ...lowerNames];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = await this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

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
  async insertEdge(edge: Edge): Promise<void> {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    await this.stmts.insertEdge.run({
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
  async insertEdges(edges: Edge[]): Promise<void> {
    await this.db.transaction(async () => {
      for (const edge of edges) {
        await this.insertEdge(edge);
      }
    });
  }

  /**
   * Delete all edges from a source node
   */
  async deleteEdgesBySource(sourceId: string): Promise<void> {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    await this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  async getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Promise<Edge[]> {
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

      const rows = await this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = await this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  async getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Promise<Edge[]> {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = await this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = await this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  async upsertFile(file: FileRecord): Promise<void> {
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

    await this.stmts.upsertFile.run({
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
  async deleteFile(filePath: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      await this.stmts.deleteFile.run(filePath);
    });
  }

  /**
   * Get a file record by path
   */
  async getFileByPath(filePath: string): Promise<FileRecord | null> {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = await this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  async getAllFiles(): Promise<FileRecord[]> {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = await this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  async getStaleFiles(currentHashes: Map<string, string>): Promise<FileRecord[]> {
    const files = await this.getAllFiles();
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
  async insertUnresolvedRef(ref: UnresolvedReference): Promise<void> {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    await this.stmts.insertUnresolved.run({
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
  async insertUnresolvedRefsBatch(refs: UnresolvedReference[]): Promise<void> {
    if (refs.length === 0) return;
    await this.db.transaction(async () => {
      for (const ref of refs) {
        await this.insertUnresolvedRef(ref);
      }
    });
  }

  /**
   * Delete unresolved references from a node
   */
  async deleteUnresolvedByNode(nodeId: string): Promise<void> {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    await this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  async getUnresolvedByName(name: string): Promise<UnresolvedReference[]> {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = await this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedRef);
  }

  /**
   * Get all unresolved references
   */
  async getUnresolvedReferences(): Promise<UnresolvedReference[]> {
    const rows = await this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedRef);
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  async getUnresolvedReferencesCount(): Promise<number> {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM unresolved_refs'
      );
    }
    const row = await this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  async getUnresolvedReferencesBatch(offset: number, limit: number): Promise<UnresolvedReference[]> {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        'SELECT * FROM unresolved_refs LIMIT ? OFFSET ?'
      );
    }
    const rows = await this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedRef);
  }

  /**
   * Get all tracked file paths (lightweight -- no full FileRecord objects)
   */
  async getAllFilePaths(): Promise<string[]> {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = await this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  async getUnresolvedReferencesByFiles(filePaths: string[]): Promise<UnresolvedReference[]> {
    if (filePaths.length === 0) return [];

    const placeholders = filePaths.map(() => '?').join(',');
    const rows = await this.db
      .prepare(`SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`)
      .all(...filePaths) as UnresolvedRefRow[];

    return rows.map(rowToUnresolvedRef);
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  async clearUnresolvedReferences(): Promise<void> {
    await this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Delete resolved references by their IDs
   */
  async deleteResolvedReferences(fromNodeIds: string[]): Promise<void> {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    await this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences -- only removes refs that were actually resolved.
   */
  async deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): Promise<void> {
    if (refs.length === 0) return;
    await this.db.transaction(async () => {
      const stmt = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
      );
      for (const ref of refs) {
        await stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
      }
    });
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get graph statistics
   */
  async getStats(): Promise<GraphStats> {
    // Single query for all three aggregate counts
    const counts = await this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = await this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = await this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = await this.db
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
  async getMetadata(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  async setMetadata(key: string, value: string): Promise<void> {
    await this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * Get all metadata as a key-value record
   */
  async getAllMetadata(): Promise<Record<string, string>> {
    const rows = await this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Clear all data from the database
   */
  async clear(): Promise<void> {
    this.nodeCache.clear();
    await this.db.transaction(async () => {
      await this.db.exec('DELETE FROM unresolved_refs');
      await this.db.exec('DELETE FROM vectors');
      await this.db.exec('DELETE FROM edges');
      await this.db.exec('DELETE FROM nodes');
      await this.db.exec('DELETE FROM files');
    });
  }
}
