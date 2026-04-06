/**
 * SQLite Database Adapter
 *
 * Wraps the existing SqliteDatabase (better-sqlite3 or WASM) into the
 * async DbAdapter interface. Synchronous calls are wrapped in resolved Promises.
 */

import { DbAdapter, DbStatement, FtsSearchOptions, FtsSearchResult, RunResult } from './adapter';
import { SqliteDatabase } from './sqlite-adapter';

/**
 * Wrap a synchronous SqliteStatement into an async DbStatement.
 */
function wrapStatement(syncStmt: ReturnType<SqliteDatabase['prepare']>): DbStatement {
  return {
    async run(...params: any[]): Promise<RunResult> {
      const result = syncStmt.run(...params);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    async get(...params: any[]): Promise<any> {
      return syncStmt.get(...params);
    },
    async all(...params: any[]): Promise<any[]> {
      return syncStmt.all(...params);
    },
  };
}

/**
 * SQLite implementation of DbAdapter.
 *
 * Wraps the existing SqliteDatabase (better-sqlite3 native or WASM fallback)
 * in the unified async interface. All async methods resolve immediately since
 * SQLite operations are synchronous.
 */
export class SqliteDbAdapter implements DbAdapter {
  readonly backendType = 'sqlite' as const;
  private db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  get open(): boolean {
    return this.db.open;
  }

  /**
   * Get the underlying SqliteDatabase for direct access.
   * Used during migration from the old API.
   */
  getDb(): SqliteDatabase {
    return this.db;
  }

  prepare(sql: string): DbStatement {
    const stmt = this.db.prepare(sql);
    return wrapStatement(stmt);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // better-sqlite3's transaction() expects a synchronous function.
    // Since the SQLite adapter wraps sync calls in Promise.resolve(),
    // the callback will only contain resolved promises internally.
    // We execute synchronously via the existing transaction mechanism
    // and collect the result.
    //
    // For the SQLite backend, we manually manage BEGIN/COMMIT/ROLLBACK
    // to support async callbacks (even though they resolve immediately).
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Execute a SQLite pragma.
   * This is SQLite-specific and not part of the DbAdapter interface.
   */
  pragma(str: string): any {
    return this.db.pragma(str);
  }

  /**
   * FTS5 full-text search.
   *
   * Executes FTS5 MATCH query with bm25() scoring against the nodes_fts
   * virtual table, joined with the nodes table for full row data.
   */
  async ftsSearch(query: string, options: FtsSearchOptions): Promise<FtsSearchResult[]> {
    const { kinds, languages, limit, offset } = options;

    // Build FTS5 query: escape special chars and add prefix wildcards
    const ftsQuery = query
      .replace(/['"*():^]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0)
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `"${term}"*`)
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    let sql = `
      SELECT nodes.*, bm25(nodes_fts) as score
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
    params.push(limit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(row => ({
        row,
        score: Math.abs(row.score), // bm25 returns negative scores
      }));
    } catch {
      // FTS query failed (e.g., invalid query syntax), return empty
      return [];
    }
  }
}
