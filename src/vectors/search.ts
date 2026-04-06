/**
 * Vector Search
 *
 * Re-exports from sqlite-store for backward compatibility.
 * New code should import from './store' and './sqlite-store' directly.
 *
 * @deprecated Use SqliteVectorStore from './sqlite-store' instead of VectorSearchManager
 */

import { SqliteDatabase } from '../db/sqlite-adapter';
import { SqliteVectorStore } from './sqlite-store';

// Re-export types from store.ts
export { VectorSearchOptions } from './store';

/**
 * @deprecated Use SqliteVectorStore instead
 */
export const VectorSearchManager = SqliteVectorStore;
export type VectorSearchManager = SqliteVectorStore;

/**
 * Create a vector search manager
 *
 * @deprecated Use new SqliteVectorStore(db, dimension) instead
 */
export function createVectorSearch(
  db: SqliteDatabase,
  dimension?: number
): SqliteVectorStore {
  return new SqliteVectorStore(db, dimension);
}
