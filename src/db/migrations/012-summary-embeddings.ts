import type { MigrationModule } from './types';

export const MIGRATION: MigrationModule = {
  description: 'Add embedding BLOB + embedding_model columns on symbol_summaries for semantic search',
  up: (db) => {
    const cols = db.prepare(`PRAGMA table_info(symbol_summaries);`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'embedding')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN embedding BLOB;`);
    }
    if (!cols.some((c) => c.name === 'embedding_model')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN embedding_model TEXT;`);
    }
  },
};
