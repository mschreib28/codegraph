/**
 * Database Adapter Interface
 *
 * Provides a unified async interface over SQLite and PostgreSQL backends.
 * SQLite wraps its synchronous calls in resolved Promises; PostgreSQL
 * uses native async operations via the `pg` driver.
 */

import { NodeKind, Language } from '../types';

/**
 * Result of a write operation (INSERT, UPDATE, DELETE)
 */
export interface RunResult {
  /** Number of rows changed */
  changes: number;
  /** Last auto-increment ID (SQLite only; 0 for PostgreSQL) */
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement whose execution methods are async.
 *
 * - SQLite: wraps better-sqlite3's synchronous `.run()/.get()/.all()` in `Promise.resolve()`
 * - PostgreSQL: executes `pool.query()` on each call
 */
export interface DbStatement {
  run(...params: any[]): Promise<RunResult>;
  get(...params: any[]): Promise<any>;
  all(...params: any[]): Promise<any[]>;
}

/**
 * Options for full-text search
 */
export interface FtsSearchOptions {
  /** Filter by node kinds */
  kinds?: NodeKind[];
  /** Filter by languages */
  languages?: Language[];
  /** Maximum results */
  limit: number;
  /** Result offset */
  offset: number;
}

/**
 * A single FTS search result row
 */
export interface FtsSearchResult {
  /** Raw database row (NodeRow shape) */
  row: any;
  /** Relevance score (higher = better) */
  score: number;
}

/**
 * Unified async database adapter.
 *
 * Both SQLite and PostgreSQL implement this interface.
 * The adapter handles SQL dialect differences internally:
 * - Parameter binding (@named for SQLite, $N for PostgreSQL)
 * - INSERT OR REPLACE vs ON CONFLICT DO UPDATE
 * - FTS5 vs tsvector full-text search
 */
export interface DbAdapter {
  /** Backend identifier */
  readonly backendType: 'sqlite' | 'postgres';

  /**
   * Prepare a SQL statement for execution.
   *
   * Synchronous -- returns a statement object whose `run/get/all` methods are async.
   * The adapter translates SQL dialect differences at prepare time:
   * - PostgreSQL rewrites @named params to $N positional params
   * - PostgreSQL rewrites INSERT OR REPLACE to ON CONFLICT DO UPDATE
   * - PostgreSQL rewrites INSERT OR IGNORE to ON CONFLICT DO NOTHING
   */
  prepare(sql: string): DbStatement;

  /**
   * Execute raw SQL (DDL, multi-statement scripts, etc.)
   */
  exec(sql: string): Promise<void>;

  /**
   * Execute a function within a database transaction.
   *
   * - SQLite: uses better-sqlite3's synchronous transaction wrapper
   * - PostgreSQL: acquires a client, BEGIN/COMMIT/ROLLBACK
   *
   * Nested transactions use SAVEPOINTs on PostgreSQL.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Close the database connection and release resources.
   */
  close(): Promise<void>;

  /**
   * Whether the database connection is open.
   */
  readonly open: boolean;

  /**
   * Full-text search abstraction.
   *
   * Each backend implements its own FTS dialect:
   * - SQLite: FTS5 with MATCH and bm25() scoring
   * - PostgreSQL: tsvector with @@ and ts_rank_cd() scoring
   *
   * Returns rows from the `nodes` table with relevance scores.
   */
  ftsSearch(query: string, options: FtsSearchOptions): Promise<FtsSearchResult[]>;
}

/**
 * Primary key map for each table.
 * Used by PostgreSQL adapter to rewrite INSERT OR REPLACE to ON CONFLICT.
 */
export const TABLE_PRIMARY_KEYS: Record<string, string> = {
  nodes: 'id',
  edges: 'id',
  files: 'path',
  unresolved_refs: 'id',
  schema_versions: 'version',
  project_metadata: 'key',
  vectors: 'node_id',
};
