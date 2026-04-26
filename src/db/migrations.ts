/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';
import { buildNameSubwords } from '../utils';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 4;

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
    description: 'Add name_subwords + Porter stemmer to FTS so natural-language and partial-identifier queries work',
    up: (db) => {
      // 1. Add the synthetic subwords column to nodes — idempotent so a
      //    re-run after a partial DDL failure (SQLite auto-commits DDL,
      //    so only some of these statements may have landed) doesn't fail
      //    with "duplicate column name".
      const cols = db.prepare(`PRAGMA table_info(nodes);`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'name_subwords')) {
        db.exec(`ALTER TABLE nodes ADD COLUMN name_subwords TEXT;`);
      }

      // 2. Drop the existing FTS table + triggers. We can't ALTER the
      //    FTS5 tokenizer in place; recreating is the supported path.
      db.exec(`
        DROP TRIGGER IF EXISTS nodes_ai;
        DROP TRIGGER IF EXISTS nodes_ad;
        DROP TRIGGER IF EXISTS nodes_au;
        DROP TABLE IF EXISTS nodes_fts;
      `);

      // 3. Recreate the FTS table — but DO NOT recreate the triggers yet.
      //    We backfill name_subwords first so the trigger isn't firing on
      //    UPDATEs against a half-populated FTS shadow table.
      db.exec(`
        CREATE VIRTUAL TABLE nodes_fts USING fts5(
          id, name, qualified_name, docstring, signature, name_subwords,
          content='nodes',
          content_rowid='rowid',
          tokenize="porter unicode61"
        );
      `);

      // 4. Backfill name_subwords. Triggers are absent so the UPDATE
      //    only writes to the nodes table — the FTS index is repopulated
      //    in one shot below via the FTS5 'rebuild' command.
      const rows = db
        .prepare('SELECT id, name FROM nodes')
        .all() as Array<{ id: string; name: string }>;
      const update = db.prepare('UPDATE nodes SET name_subwords = ? WHERE id = ?');
      for (const row of rows) {
        update.run(buildNameSubwords(row.name), row.id);
      }

      // 5. Tell the contentless FTS to rebuild its index from the content
      //    table (nodes). Reads all rows once with the new tokenizer.
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');`);

      // 6. Now safe to attach the triggers — they'll fire on subsequent
      //    application writes, not on the backfill we just performed.
      db.exec(`
        CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, name_subwords)
          VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.name_subwords);
        END;

        CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, name_subwords)
          VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.name_subwords);
        END;

        CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, name_subwords)
          VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.name_subwords);
          INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, name_subwords)
          VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.name_subwords);
        END;
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
