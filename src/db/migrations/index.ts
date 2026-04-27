/**
 * Migration registry.
 *
 * Adding a new schema migration is:
 *
 *   1. Pick the next free 3-digit prefix (`NNN`) — `git ls-files
 *      'src/db/migrations/[0-9]*.ts'` shows what's taken.
 *   2. Create `src/db/migrations/<NNN>-<short-description>.ts`
 *      exporting a `MIGRATION: MigrationModule` (just `description`
 *      and `up(db)`).
 *   3. Add **one** import line and **one** array entry to this file.
 *
 * **Why filename-derived versions instead of a field?** Two PRs
 * adding migrations independently used to collide on the
 * `migrations[]` array AND the `CURRENT_SCHEMA_VERSION` const.
 * With monolithic migrations.ts, "I claimed v4 / you claimed v4"
 * resolved as "second PR's v4 silently no-ops" — a real bug class
 * (PR #113's reviewer caught one). With filename-derived versions,
 * two PRs both creating `004-foo.ts` produce a filesystem-level
 * conflict the maintainer sees instantly.
 *
 * `CURRENT_SCHEMA_VERSION` is the max of all registered versions.
 */

import type { Migration, MigrationModule } from './types';

import { MIGRATION as MIG_002 } from './002-project-metadata';
import { MIGRATION as MIG_003 } from './003-lower-name-index';
import { MIGRATION as MIG_004 } from './004-centrality-churn';
import { MIGRATION as MIG_005 } from './005-symbol-issues';
import { MIGRATION as MIG_006 } from './006-config-refs';

interface ModuleRef {
  /**
   * Source filename. The 3-digit prefix is the source of truth for
   * the version number — `validateRegistered` parses it. Keep this
   * field in sync with the actual file on disk; the
   * filesystem-cross-check test catches drift.
   */
  filename: string;
  module: MigrationModule;
}

/**
 * Static-import list of every migration. Two PRs adding
 * migrations both add a single entry here; alphabetical ordering
 * puts adjacent additions on different lines unless the version
 * numbers themselves collide, in which case the filesystem
 * collision on `NNN-*.ts` surfaces the conflict instantly.
 */
const REGISTERED_MODULES: readonly ModuleRef[] = [
  { filename: '002-project-metadata.ts', module: MIG_002 },
  { filename: '003-lower-name-index.ts', module: MIG_003 },
  { filename: '004-centrality-churn.ts', module: MIG_004 },
  { filename: '005-symbol-issues.ts', module: MIG_005 },
  { filename: '006-config-refs.ts', module: MIG_006 },
];

/** Strict 3-digit prefix on each migration filename. */
const FILENAME_PATTERN = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;

/**
 * Validate the registered set: filenames match the strict
 * `NNN-name.ts` shape, version is parsed from the prefix (no
 * hand-typed version field that can drift), versions are unique,
 * and the result is sorted ascending. Throws loudly at module
 * load if any invariant is violated rather than silently dropping
 * a migration during `runMigrations()`.
 */
function validateRegistered(refs: readonly ModuleRef[]): readonly Migration[] {
  if (refs.length === 0) {
    throw new Error('[CodeGraph] migrations registry is empty');
  }
  const parsed = refs.map((r) => {
    const m = FILENAME_PATTERN.exec(r.filename);
    if (!m) {
      throw new Error(
        `[CodeGraph] migration filename "${r.filename}" does not match ` +
          `expected pattern NNN-kebab-name.ts (3-digit prefix, lowercase kebab-case body)`
      );
    }
    const version = parseInt(m[1]!, 10);
    return {
      version,
      filename: r.filename,
      description: r.module.description,
      up: r.module.up,
    };
  });
  const sorted = [...parsed].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.version === sorted[i - 1]!.version) {
      throw new Error(
        `[CodeGraph] duplicate migration version ${sorted[i]!.version}: ` +
          `${sorted[i - 1]!.filename} vs ${sorted[i]!.filename}`
      );
    }
  }
  return sorted.map((r) => ({
    version: r.version,
    description: r.description,
    up: r.up,
  }));
}

export const ALL_MIGRATIONS: readonly Migration[] = validateRegistered(REGISTERED_MODULES);

/**
 * Highest registered migration version. Derived from the registry
 * (no hand-maintained constant to keep in sync).
 */
export const CURRENT_SCHEMA_VERSION: number = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!.version;
