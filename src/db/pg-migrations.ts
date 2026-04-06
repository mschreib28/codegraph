/**
 * PostgreSQL Database Migrations
 *
 * Async migration runner for the PostgreSQL backend.
 * Follows the same versioning scheme as migrations.ts (SQLite).
 */

import { DbAdapter } from './adapter';

/**
 * Current PostgreSQL schema version
 */
export const CURRENT_PG_SCHEMA_VERSION = 3;

/**
 * PostgreSQL migration definition
 */
interface PgMigration {
  version: number;
  description: string;
  up: (adapter: DbAdapter) => Promise<void>;
}

/**
 * All PostgreSQL migrations in order.
 *
 * Version 1 is the initial schema (pg-schema.sql).
 * Future migrations go here.
 */
const pgMigrations: PgMigration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: async (adapter) => {
      // These are already in pg-schema.sql for fresh installs.
      // This migration handles upgrades from v1.
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
      // ALTER TABLE ADD COLUMN IF NOT EXISTS is PostgreSQL 9.6+
      await adapter.exec(`
        ALTER TABLE unresolved_refs ADD COLUMN IF NOT EXISTS file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN IF NOT EXISTS provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(LOWER(name));
      `);
    },
  },
];

/**
 * Get the current schema version from the PostgreSQL database
 */
export async function getCurrentPgVersion(adapter: DbAdapter): Promise<number> {
  try {
    const stmt = adapter.prepare('SELECT MAX(version) as version FROM schema_versions');
    const row = await stmt.get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
async function recordPgMigration(adapter: DbAdapter, version: number, description: string): Promise<void> {
  const stmt = adapter.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES ($1, $2, $3)'
  );
  await stmt.run(version, Date.now(), description);
}

/**
 * Run all pending PostgreSQL migrations
 */
export async function runPgMigrations(adapter: DbAdapter, fromVersion: number): Promise<void> {
  const pending = pgMigrations
    .filter((m) => m.version > fromVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return;
  }

  // Run each migration in a transaction
  for (const migration of pending) {
    await adapter.transaction(async () => {
      await migration.up(adapter);
      await recordPgMigration(adapter, migration.version, migration.description);
    });
  }
}

/**
 * Check if the PostgreSQL database needs migration
 */
export async function needsPgMigration(adapter: DbAdapter): Promise<boolean> {
  const current = await getCurrentPgVersion(adapter);
  return current < CURRENT_PG_SCHEMA_VERSION;
}
