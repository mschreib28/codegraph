import type { MigrationModule } from './types';

export const MIGRATION: MigrationModule = {
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
};
