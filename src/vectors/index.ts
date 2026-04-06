/**
 * Vectors Module
 *
 * Provides text embedding and vector similarity search for semantic code search.
 * Supports SQLite (default) and PostgreSQL (pgvector) backends.
 */

export {
  TextEmbedder,
  createEmbedder,
  DEFAULT_MODEL,
  EMBEDDING_DIMENSION,
  EmbedderOptions,
  EmbeddingResult,
  BatchEmbeddingResult,
} from './embedder';

export {
  VectorStore,
  VectorSearchOptions,
  VectorSearchResult,
} from './store';

export { SqliteVectorStore } from './sqlite-store';

export {
  VectorStoreConfig,
  DEFAULT_VECTOR_STORE_CONFIG,
  createVectorStore,
} from './store-factory';

// Backward-compatible re-exports
export {
  VectorSearchManager,
  createVectorSearch,
} from './search';

export {
  VectorManager,
  createVectorManager,
  VectorManagerOptions,
  EmbeddingProgress,
} from './manager';
