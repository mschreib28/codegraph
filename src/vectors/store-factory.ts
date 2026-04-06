/**
 * Vector Store Factory
 *
 * Creates the appropriate vector store backend based on configuration.
 */

import { SqliteDatabase } from '../db/sqlite-adapter';
import { SqliteVectorStore } from './sqlite-store';
import { VectorStore } from './store';
import { EMBEDDING_DIMENSION } from './embedder';

/**
 * Configuration for the vector store backend
 */
export interface VectorStoreConfig {
  /** Backend type: 'sqlite' (default) or 'pgvector' */
  backend: 'sqlite' | 'pgvector';

  /** PostgreSQL connection string (pgvector only). Can also use CODEGRAPH_PG_URL env var. */
  connectionString?: string;

  /** Index type for pgvector: 'hnsw' (default), 'ivfflat', or 'none' */
  indexType?: 'hnsw' | 'ivfflat' | 'none';

  /** Distance metric for pgvector: 'cosine' (default), 'l2', or 'inner_product' */
  distanceMetric?: 'cosine' | 'l2' | 'inner_product';

  /** Connection pool size for pgvector (default: 5) */
  poolSize?: number;

  /** Table name prefix for pgvector (default: 'codegraph_') */
  tablePrefix?: string;
}

/** Default vector store config (SQLite) */
export const DEFAULT_VECTOR_STORE_CONFIG: VectorStoreConfig = {
  backend: 'sqlite',
};

/**
 * Create the appropriate vector store based on configuration.
 *
 * For pgvector, the `pg` module is dynamically imported so it's only
 * loaded when actually needed.
 */
export async function createVectorStore(
  config: VectorStoreConfig = DEFAULT_VECTOR_STORE_CONFIG,
  sqliteDb?: SqliteDatabase,
  dimension: number = EMBEDDING_DIMENSION
): Promise<VectorStore> {
  if (config.backend === 'pgvector') {
    const connectionString = config.connectionString || process.env.CODEGRAPH_PG_URL;
    if (!connectionString) {
      throw new Error(
        'PostgreSQL connection string required for pgvector backend. ' +
        'Set "vectorStore.connectionString" in .codegraph/config.json or set the CODEGRAPH_PG_URL environment variable.'
      );
    }

    // Dynamic import so `pg` is only loaded when pgvector is configured
    const { PgVectorStore } = await import('./pg-store');
    return new PgVectorStore({
      connectionString,
      dimension,
      indexType: config.indexType,
      distanceMetric: config.distanceMetric,
      poolSize: config.poolSize,
      tablePrefix: config.tablePrefix,
    });
  }

  // Default: SQLite
  if (!sqliteDb) {
    throw new Error('SQLite database instance required for sqlite vector backend.');
  }
  return new SqliteVectorStore(sqliteDb, dimension);
}
