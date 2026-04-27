/**
 * Migration registry types.
 *
 * Each migration ships its own self-contained file
 * (`./NNN-description.ts`) exporting a `MIGRATION:
 * MigrationModule`. The version number is derived from the
 * leading 3-digit prefix on the filename, NOT from a field in the
 * module — this guarantees no two PRs can claim the same version
 * silently (filenames collide on the filesystem; SQL migrations
 * never silently no-op).
 */

import type { SqliteDatabase } from '../sqlite-adapter';

export interface MigrationModule {
  /** One-line description for `schema_versions` table + diagnostics. */
  readonly description: string;
  /** The actual schema-mutation function. Wrapped in a transaction. */
  readonly up: (db: SqliteDatabase) => void;
}

export interface Migration extends MigrationModule {
  /** Version derived from filename's leading NNN prefix. */
  readonly version: number;
}
