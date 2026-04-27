import type { MigrationModule } from './types';

export const MIGRATION: MigrationModule = {
  description:
    'Dedup edges and enforce UNIQUE(source, target, kind, line, col) so INSERT OR IGNORE actually dedupes',
  up: (db) => {
    // Without a UNIQUE constraint the existing `INSERT OR IGNORE INTO
    // edges` was a no-op for dedup purposes (the only candidate key
    // was the AUTOINCREMENT id, which never conflicts). Collapse
    // accumulated duplicates first, then add the UNIQUE index that
    // future inserts will conflict against. COALESCE keeps two NULL
    // line/col values comparable (SQLite treats raw NULLs in a UNIQUE
    // index as distinct).
    db.exec(`
      DELETE FROM edges
      WHERE id NOT IN (
        SELECT MIN(id) FROM edges
        GROUP BY source, target, kind, COALESCE(line, -1), COALESCE(col, -1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
        ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));
    `);
  },
};
