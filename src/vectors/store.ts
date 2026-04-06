/**
 * Vector Store Interface
 *
 * Abstraction layer for vector storage backends.
 * Implementations: SqliteVectorStore (default), PgVectorStore (optional).
 */

import { Node } from '../types';

/**
 * Options for vector search
 */
export interface VectorSearchOptions {
  /** Maximum number of results to return */
  limit?: number;

  /** Minimum similarity score (0-1) */
  minScore?: number;

  /** Node kinds to filter results */
  nodeKinds?: Node['kind'][];
}

/**
 * Vector search result
 */
export interface VectorSearchResult {
  nodeId: string;
  score: number;
}

/**
 * Vector store backend interface
 *
 * All vector storage backends must implement this interface.
 * Methods return Promises to support both synchronous (SQLite) and
 * asynchronous (PostgreSQL) backends uniformly.
 */
export interface VectorStore {
  /** Backend identifier — used for stats reporting. Minification-safe. */
  readonly backendType: 'sqlite' | 'pgvector';

  /** Initialize the store (create tables, load extensions, connect) */
  initialize(): Promise<void>;

  /** Store a single vector */
  storeVector(nodeId: string, embedding: Float32Array, model: string): Promise<void>;

  /** Store multiple vectors in a batch (transactionally) */
  storeVectorBatch(
    entries: Array<{ nodeId: string; embedding: Float32Array }>,
    model: string
  ): Promise<void>;

  /** Retrieve a vector by node ID */
  getVector(nodeId: string): Promise<Float32Array | null>;

  /** Check if a node has a stored vector */
  hasVector(nodeId: string): Promise<boolean>;

  /** Get all node IDs that have vectors */
  getIndexedNodeIds(): Promise<string[]>;

  /** Search for similar vectors */
  search(
    queryEmbedding: Float32Array,
    options?: VectorSearchOptions
  ): Promise<VectorSearchResult[]>;

  /** Delete a vector */
  deleteVector(nodeId: string): Promise<void>;

  /** Clear all vectors */
  clear(): Promise<void>;

  /** Get count of stored vectors */
  getVectorCount(): Promise<number>;

  /** Whether the store supports approximate nearest neighbor search */
  isAnnEnabled(): boolean;

  /** Rebuild index (no-op for stores without separate index structures) */
  rebuildIndex(): Promise<void>;

  /** Release resources / close connections */
  dispose(): Promise<void>;
}
