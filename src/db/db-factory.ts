/**
 * Database Adapter Factory
 *
 * Creates the appropriate database adapter based on configuration.
 * Follows the same pattern as vectors/store-factory.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DbAdapter } from './adapter';

/**
 * Configuration for the database backend
 */
export interface DbBackendConfig {
  /** Backend type: 'sqlite' (default) or 'postgres' */
  backend: 'sqlite' | 'postgres';

  /** PostgreSQL connection string. Can also use CODEGRAPH_PG_URL env var. */
  connectionString?: string;

  /** Connection pool size for PostgreSQL (default: 10) */
  poolSize?: number;

  /** Table name prefix for PostgreSQL (default: '') */
  tablePrefix?: string;
}

/** Default database config (SQLite) */
export const DEFAULT_DB_CONFIG: DbBackendConfig = {
  backend: 'sqlite',
};

/**
 * Create the appropriate database adapter based on configuration.
 *
 * For PostgreSQL, the `pg` module is dynamically imported so it's only
 * loaded when actually needed.
 *
 * @param config - Database backend configuration
 * @param sqliteDbPath - Path to SQLite database file (required for sqlite backend)
 * @returns Initialized DbAdapter ready for use
 */
export async function createDbAdapter(
  config: DbBackendConfig = DEFAULT_DB_CONFIG,
  sqliteDbPath?: string,
): Promise<DbAdapter> {
  if (config.backend === 'postgres') {
    const connectionString = config.connectionString || process.env.CODEGRAPH_PG_URL;
    if (!connectionString) {
      throw new Error(
        'PostgreSQL connection string required for postgres backend. ' +
        'Set "database.connectionString" in .codegraph/config.json or set the CODEGRAPH_PG_URL environment variable.'
      );
    }

    // Dynamic import so `pg` is only loaded when postgres is configured
    const { PgDbAdapter } = await import('./pg-db-adapter');
    const adapter = new PgDbAdapter({
      connectionString,
      poolSize: config.poolSize,
      tablePrefix: config.tablePrefix,
    });

    // Initialize connection pool
    await adapter.initialize();

    // Run schema if this is a fresh database
    const schemaFile = path.join(__dirname, 'pg-schema.sql');
    if (fs.existsSync(schemaFile)) {
      const schema = fs.readFileSync(schemaFile, 'utf-8');
      await adapter.exec(schema);
    }

    // Run pending migrations
    const { getCurrentPgVersion, runPgMigrations } = await import('./pg-migrations');
    const currentVersion = await getCurrentPgVersion(adapter);
    await runPgMigrations(adapter, currentVersion);

    return adapter;
  }

  // Default: SQLite
  if (!sqliteDbPath) {
    throw new Error('SQLite database path required for sqlite backend.');
  }

  // Use existing DatabaseConnection infrastructure for SQLite
  const { DatabaseConnection } = await import('./index');
  const { SqliteDbAdapter } = await import('./sqlite-db-adapter');

  // Check if database already exists
  const dbExists = fs.existsSync(sqliteDbPath);
  const dbConn = dbExists
    ? DatabaseConnection.open(sqliteDbPath)
    : DatabaseConnection.initialize(sqliteDbPath);

  return new SqliteDbAdapter(dbConn.getDb());
}
