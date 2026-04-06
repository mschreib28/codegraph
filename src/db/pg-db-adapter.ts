/**
 * PostgreSQL Database Adapter
 *
 * Implements the DbAdapter interface using the `pg` driver with connection pooling.
 * Handles SQL dialect translation from SQLite-style to PostgreSQL:
 * - @named params -> $N positional params
 * - INSERT OR REPLACE -> ON CONFLICT DO UPDATE
 * - INSERT OR IGNORE -> ON CONFLICT DO NOTHING
 * - FTS5 MATCH -> tsvector @@ to_tsquery
 */

import { DbAdapter, DbStatement, FtsSearchOptions, FtsSearchResult, RunResult, TABLE_PRIMARY_KEYS } from './adapter';

/**
 * Options for the PostgreSQL database adapter.
 */
export interface PgDbAdapterOptions {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Connection pool size (default: 10) */
  poolSize?: number;
  /** Table name prefix (default: '') */
  tablePrefix?: string;
}

// ============================================================================
// SQL Translation Utilities
// ============================================================================

/**
 * Translate @named parameters to $N positional parameters for PostgreSQL.
 *
 * Returns the rewritten SQL and an ordered list of parameter names.
 * If no named params are found, returns null for paramOrder (positional mode).
 */
function translateNamedToPositional(sql: string): { sql: string; paramOrder: string[] | null } {
  const paramOrder: string[] = [];
  const paramMap = new Map<string, number>();

  const rewritten = sql.replace(/@(\w+)/g, (_match, name: string) => {
    if (!paramMap.has(name)) {
      paramMap.set(name, paramOrder.length + 1);
      paramOrder.push(name);
    }
    return `$${paramMap.get(name)}`;
  });

  if (paramOrder.length === 0) {
    return { sql: rewritten, paramOrder: null };
  }
  return { sql: rewritten, paramOrder };
}

/**
 * Translate positional ? params to $N params for PostgreSQL.
 */
function translatePositionalParams(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

/**
 * Resolve parameters from better-sqlite3 calling conventions to a positional array.
 *
 * Handles:
 * - Named object: run({ id: '1', name: 'a' }) -> positional array via paramOrder
 * - Positional args: run('a', 'b') -> ['a', 'b']
 * - No args: run() -> []
 */
function resolveParams(params: any[], paramOrder: string[] | null): any[] {
  if (params.length === 0) return [];

  // Named object -> positional array
  if (
    paramOrder &&
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0]) &&
    !(params[0] instanceof Buffer) &&
    !(params[0] instanceof Uint8Array)
  ) {
    return paramOrder.map(name => params[0][name]);
  }

  // Already positional
  return params;
}

/**
 * Rewrite INSERT OR REPLACE to INSERT ... ON CONFLICT (pk) DO UPDATE SET ...
 */
function rewriteInsertOrReplace(sql: string): string {
  const match = sql.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
  if (!match) return sql;

  const tableName = match[1]!;
  const columns = match[2]!.split(',').map(c => c.trim());
  const pk = TABLE_PRIMARY_KEYS[tableName];

  if (!pk) {
    // Unknown table, can't determine PK -- fall back to basic insert
    return sql.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT');
  }

  // Build ON CONFLICT clause with all non-PK columns
  const updateCols = columns.filter(c => c !== pk);
  const updateSet = updateCols
    .map(col => `${col} = EXCLUDED.${col}`)
    .join(', ');

  // Replace the INSERT OR REPLACE prefix and append ON CONFLICT
  let newSql = sql.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT');
  newSql += ` ON CONFLICT(${pk}) DO UPDATE SET ${updateSet}`;

  return newSql;
}

/**
 * Rewrite INSERT OR IGNORE to INSERT ... ON CONFLICT DO NOTHING
 */
function rewriteInsertOrIgnore(sql: string): string {
  return sql.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT') + ' ON CONFLICT DO NOTHING';
}

/**
 * Full SQL translation pipeline for PostgreSQL.
 */
function translateSql(sql: string): { sql: string; paramOrder: string[] | null } {
  let translated = sql;

  // Rewrite INSERT OR REPLACE before param translation (since it modifies SQL structure)
  if (/INSERT\s+OR\s+REPLACE/i.test(translated)) {
    translated = rewriteInsertOrReplace(translated);
  } else if (/INSERT\s+OR\s+IGNORE/i.test(translated)) {
    translated = rewriteInsertOrIgnore(translated);
  }

  // Translate parameters: check for @named first, then ? positional
  if (/@\w+/.test(translated)) {
    return translateNamedToPositional(translated);
  }

  if (translated.includes('?')) {
    return { sql: translatePositionalParams(translated), paramOrder: null };
  }

  return { sql: translated, paramOrder: null };
}

// ============================================================================
// PostgreSQL Statement
// ============================================================================

/**
 * A virtual prepared statement for PostgreSQL.
 *
 * Unlike SQLite's real prepared statements, this just stores the translated SQL
 * and executes it via pool.query() on each call. PostgreSQL handles statement
 * caching at the driver/server level.
 */
class PgStatement implements DbStatement {
  private pool: any; // pg.Pool
  private sql: string;
  private paramOrder: string[] | null;

  constructor(pool: any, originalSql: string) {
    this.pool = pool;
    const { sql, paramOrder } = translateSql(originalSql);
    this.sql = sql;
    this.paramOrder = paramOrder;
  }

  async run(...params: any[]): Promise<RunResult> {
    const resolved = resolveParams(params, this.paramOrder);
    const result = await this.pool.query(this.sql, resolved.length > 0 ? resolved : undefined);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: 0, // PostgreSQL doesn't have this concept in the same way
    };
  }

  async get(...params: any[]): Promise<any> {
    const resolved = resolveParams(params, this.paramOrder);
    const result = await this.pool.query(this.sql, resolved.length > 0 ? resolved : undefined);
    return result.rows[0];
  }

  async all(...params: any[]): Promise<any[]> {
    const resolved = resolveParams(params, this.paramOrder);
    const result = await this.pool.query(this.sql, resolved.length > 0 ? resolved : undefined);
    return result.rows;
  }
}

// ============================================================================
// PostgreSQL Database Adapter
// ============================================================================

/**
 * PostgreSQL implementation of DbAdapter.
 *
 * Uses pg.Pool for connection pooling. All SQL is translated from
 * SQLite-compatible syntax at prepare time.
 */
export class PgDbAdapter implements DbAdapter {
  readonly backendType = 'postgres' as const;
  private pool: any; // pg.Pool
  private _open = false;
  private options: Required<PgDbAdapterOptions>;
  private transactionDepth = 0;
  private transactionClient: any = null;

  constructor(options: PgDbAdapterOptions) {
    this.options = {
      connectionString: options.connectionString,
      poolSize: options.poolSize ?? 10,
      tablePrefix: options.tablePrefix ?? '',
    };
  }

  get open(): boolean {
    return this._open;
  }

  /**
   * Initialize the connection pool.
   * Must be called before any other method.
   */
  async initialize(): Promise<void> {
    if (this._open) return;

    let pg: any;
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'The "pg" package is required for PostgreSQL backend. Install it with: npm install pg'
      );
    }

    const Pool = pg.default?.Pool ?? pg.Pool;
    this.pool = new Pool({
      connectionString: this.options.connectionString,
      max: this.options.poolSize,
    });

    // Test connection
    let client: any;
    try {
      client = await this.pool.connect();
      client.release();
    } catch (error: any) {
      await this.pool.end().catch(() => {});
      throw new Error(
        `Failed to connect to PostgreSQL: ${error.message}. ` +
        'Verify your connection string and ensure the database is running.'
      );
    }

    this._open = true;
  }

  prepare(sql: string): DbStatement {
    return new PgStatement(this.pool, sql);
  }

  async exec(sql: string): Promise<void> {
    // Execute raw SQL -- may contain multiple statements
    await this.pool.query(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Support nested transactions via SAVEPOINTs
    if (this.transactionDepth > 0 && this.transactionClient) {
      const savepointName = `sp_${this.transactionDepth}`;
      this.transactionDepth++;
      await this.transactionClient.query(`SAVEPOINT ${savepointName}`);
      try {
        const result = await fn();
        await this.transactionClient.query(`RELEASE SAVEPOINT ${savepointName}`);
        this.transactionDepth--;
        return result;
      } catch (error) {
        await this.transactionClient.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        this.transactionDepth--;
        throw error;
      }
    }

    // Top-level transaction
    const client = await this.pool.connect();
    const originalPool = this.pool;
    this.transactionClient = client;
    this.transactionDepth = 1;

    // Temporarily redirect queries through the transaction client
    // so that prepared statements within the transaction use the same connection
    this.pool = {
      query: (...args: any[]) => client.query(...args),
    };

    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      this.pool = originalPool;
      this.transactionClient = null;
      this.transactionDepth = 0;
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this._open = false;
  }

  /**
   * Full-text search using PostgreSQL tsvector.
   *
   * Queries the `search_vector` tsvector column on the nodes table
   * using to_tsquery() with prefix matching and ts_rank_cd() scoring.
   */
  async ftsSearch(query: string, options: FtsSearchOptions): Promise<FtsSearchResult[]> {
    const { kinds, languages, limit, offset } = options;

    // Build tsquery: each term gets :* suffix for prefix matching
    const terms = query
      .replace(/['"*():^&|!<>]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0)
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term));

    if (terms.length === 0) {
      return [];
    }

    // Use | (OR) between terms, with :* for prefix matching
    const tsQueryStr = terms.map(t => `${t}:*`).join(' | ');

    let sql = `
      SELECT nodes.*,
        ts_rank_cd(search_vector, to_tsquery('simple', $1)) as score
      FROM nodes
      WHERE search_vector @@ to_tsquery('simple', $1)
    `;

    const params: (string | number)[] = [tsQueryStr];
    let paramIdx = 2;

    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => `$${paramIdx++}`).join(',');
      sql += ` AND kind IN (${placeholders})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      const placeholders = languages.map(() => `$${paramIdx++}`).join(',');
      sql += ` AND language IN (${placeholders})`;
      params.push(...languages);
    }

    sql += ` ORDER BY score DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    try {
      const result = await this.pool.query(sql, params);
      return result.rows.map((row: any) => ({
        row,
        score: parseFloat(row.score),
      }));
    } catch {
      // Query failed, return empty
      return [];
    }
  }
}
