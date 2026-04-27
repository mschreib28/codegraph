/**
 * Database Migrations — runner + backward-compat surface.
 *
 * The migration definitions themselves live in
 * `./migrations/<NNN>-<name>.ts`, one file per migration, with
 * version derived from the filename prefix. This file is the
 * runner (read schema_versions, apply pending in order) and the
 * stable API surface that the rest of the codebase imports.
 *
 * Adding a migration: see `./migrations/index.ts`.
 */

import { SqliteDatabase } from './sqlite-adapter';
import { ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION as REGISTRY_CURRENT } from './migrations/index';
import type { Migration } from './migrations/types';

/**
 * Highest registered migration version. Derived from the
 * registry; re-exported here unchanged so existing consumers
 * (`import { CURRENT_SCHEMA_VERSION } from './migrations'`) keep
 * working.
 */
export const CURRENT_SCHEMA_VERSION: number = REGISTRY_CURRENT;

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
  const pending = ALL_MIGRATIONS.filter((m) => m.version > fromVersion);
  if (pending.length === 0) return;

  // ALL_MIGRATIONS is already sorted by version, but filtering can
  // be cheap to re-confirm.
  const ordered = [...pending].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
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
 * Get list of pending migrations.
 *
 * Returned as a fresh mutable array (not the underlying readonly
 * registry) so callers that previously assigned the result to a
 * `Migration[]`-typed variable keep working unchanged.
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return ALL_MIGRATIONS.filter((m) => m.version > current).slice();
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

// Re-export the registry surface for callers that want it.
export { ALL_MIGRATIONS } from './migrations/index';
export type { Migration, MigrationModule } from './migrations/types';
