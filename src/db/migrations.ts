/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 7;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description: 'Add symbol_summaries table for LLM-generated one-line descriptions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_summaries (
          node_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          summary TEXT NOT NULL,
          model TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_summaries_model ON symbol_summaries(model);
      `);
    },
  },
  {
    version: 5,
    description:
      'Add embedding BLOB and embedding_model columns on symbol_summaries for semantic search',
    up: (db) => {
      db.exec(`
        ALTER TABLE symbol_summaries ADD COLUMN embedding BLOB;
        ALTER TABLE symbol_summaries ADD COLUMN embedding_model TEXT;
      `);
    },
  },
  {
    version: 6,
    description:
      'Add directory_summaries table for module-level LLM-generated descriptions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS directory_summaries (
          dir_path TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          generated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dir_summaries_model ON directory_summaries(model);
      `);
    },
  },
  {
    version: 7,
    description:
      'Add role + role_model columns on symbol_summaries for LLM role classification',
    up: (db) => {
      db.exec(`
        ALTER TABLE symbol_summaries ADD COLUMN role TEXT;
        ALTER TABLE symbol_summaries ADD COLUMN role_model TEXT;
        CREATE INDEX IF NOT EXISTS idx_summaries_role ON symbol_summaries(role);
      `);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
