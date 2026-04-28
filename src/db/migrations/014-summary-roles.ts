import type { MigrationModule } from './types';

export const MIGRATION: MigrationModule = {
  description: 'Add role + role_model columns on symbol_summaries for LLM role classification',
  up: (db) => {
    const cols = db.prepare(`PRAGMA table_info(symbol_summaries);`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'role')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN role TEXT;`);
    }
    if (!cols.some((c) => c.name === 'role_model')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN role_model TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_role ON symbol_summaries(role);`);
  },
};
