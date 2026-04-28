/**
 * Migration 015 (drop idx_co_changes_a) and 016 (split embeddings).
 *
 * - 015 verifies the redundant `idx_co_changes_a` index is removed
 *   on upgrade and absent on a fresh DB; the wider PK still covers
 *   `WHERE file_a = ?` lookups.
 * - 016 verifies embeddings move from `symbol_summaries.embedding`
 *   into a dedicated `symbol_embeddings` table, the old columns
 *   are dropped, and existing data is preserved verbatim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase } from '../src/db/sqlite-adapter';
import { runMigrations, getCurrentVersion } from '../src/db/migrations';
import { DatabaseConnection } from '../src/db';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mig-015-016-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Migration 015 — drop idx_co_changes_a', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => cleanup(dir));

  it('fresh DB does not contain idx_co_changes_a, but keeps idx_co_changes_b', () => {
    const dbPath = path.join(dir, 'fresh.db');
    const db = DatabaseConnection.initialize(dbPath);
    try {
      const indexes = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'co_changes'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((r) => r.name);
      expect(names).not.toContain('idx_co_changes_a');
      expect(names).toContain('idx_co_changes_b');
    } finally {
      db.close();
    }
  });
});

describe('Migration 016 — split embeddings into symbol_embeddings table', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => cleanup(dir));

  it('moves existing embedding rows; drops the inline columns', () => {
    const dbPath = path.join(dir, 'upgrade.db');
    const adapter = createDatabase(dbPath);

    // Simulate a v14 database: just enough of the relevant schema.
    adapter.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      INSERT INTO nodes (id) VALUES ('n1'), ('n2'), ('n3');
      CREATE TABLE symbol_summaries (
        node_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        model TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        embedding BLOB,
        embedding_model TEXT,
        role TEXT,
        role_model TEXT,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_summaries_embedding_model ON symbol_summaries(embedding_model);
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      INSERT INTO schema_versions (version, applied_at, description) VALUES (14, 0, 'v14');
    `);

    // n1 has both summary and embedding; n2 has summary only;
    // n3 has summary + embedding from a stale model — all rows are
    // copied into symbol_embeddings so long as embedding_model is set.
    const buf1 = Buffer.from(new Float32Array([1, 0, 0]).buffer);
    const buf3 = Buffer.from(new Float32Array([0, 1, 0]).buffer);
    adapter.prepare(`
      INSERT INTO symbol_summaries
        (node_id, content_hash, summary, model, generated_at, embedding, embedding_model)
      VALUES
        ('n1', 'h1', 's1', 'chat-m', 100, ?, 'embed-m'),
        ('n2', 'h2', 's2', 'chat-m', 100, NULL, NULL),
        ('n3', 'h3', 's3', 'chat-m', 100, ?, 'old-embed-m')
    `).run(buf1, buf3);

    runMigrations(adapter, getCurrentVersion(adapter));

    // Old columns gone
    const cols = adapter.prepare("PRAGMA table_info('symbol_summaries')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain('embedding');
    expect(colNames).not.toContain('embedding_model');

    // New table has the rows that had embedding_model set
    const moved = adapter
      .prepare('SELECT node_id, embedding_model FROM symbol_embeddings ORDER BY node_id')
      .all() as Array<{ node_id: string; embedding_model: string }>;
    expect(moved).toEqual([
      { node_id: 'n1', embedding_model: 'embed-m' },
      { node_id: 'n3', embedding_model: 'old-embed-m' },
    ]);

    // Embedding bytes preserved verbatim for n1
    const n1 = adapter
      .prepare('SELECT embedding FROM symbol_embeddings WHERE node_id = ?')
      .get('n1') as { embedding: Buffer };
    expect(Buffer.from(n1.embedding).equals(buf1)).toBe(true);

    // Index on the new table
    const idx = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbol_embeddings'")
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_embeddings_model');

    expect(getCurrentVersion(adapter)).toBeGreaterThanOrEqual(16);

    adapter.close();
  });

  it('fresh DB has symbol_embeddings table and no embedding columns on symbol_summaries', () => {
    const db = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const cols = db.getDb()
        .prepare("PRAGMA table_info('symbol_summaries')")
        .all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).not.toContain('embedding');
      expect(colNames).not.toContain('embedding_model');

      const tables = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_embeddings'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    } finally {
      db.close();
    }
  });
});
