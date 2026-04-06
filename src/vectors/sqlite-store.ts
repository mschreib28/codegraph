/**
 * SQLite Vector Store
 *
 * Vector storage backend using SQLite with optional sqlite-vss for ANN search.
 * Falls back to brute-force cosine similarity if sqlite-vss is not available.
 */

import { SqliteDatabase } from '../db/sqlite-adapter';
import { TextEmbedder, EMBEDDING_DIMENSION } from './embedder';
import { VectorStore, VectorSearchOptions, VectorSearchResult } from './store';

/**
 * SQLite-based vector store
 *
 * Stores embeddings as BLOBs in SQLite. Optionally uses sqlite-vss
 * extension for accelerated approximate nearest neighbor search.
 */
export class SqliteVectorStore implements VectorStore {
  readonly backendType = 'sqlite' as const;
  private db: SqliteDatabase;
  private vssEnabled = false;
  private embeddingDimension: number;

  constructor(db: SqliteDatabase, dimension: number = EMBEDDING_DIMENSION) {
    this.db = db;
    this.embeddingDimension = dimension;
  }

  async initialize(): Promise<void> {
    try {
      await this.loadVssExtension();
      this.vssEnabled = true;
      console.log('sqlite-vss extension loaded successfully');
      this.createVssTable();
    } catch (error) {
      console.warn(
        'sqlite-vss extension not available, falling back to brute-force search:',
        error instanceof Error ? error.message : String(error)
      );
      this.vssEnabled = false;
    }

    this.ensureVectorsTable();
  }

  private async loadVssExtension(): Promise<void> {
    try {
      const vss = await import('sqlite-vss');
      if (typeof vss.load === 'function') {
        vss.load(this.db as any);
      } else if (typeof vss.default?.load === 'function') {
        vss.default.load(this.db as any);
      } else {
        throw new Error('sqlite-vss load function not found');
      }
    } catch (error) {
      throw new Error(`Failed to load sqlite-vss: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private createVssTable(): void {
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vss_vectors'")
      .get();

    if (!tableExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vss_vectors USING vss0(
          embedding(${this.embeddingDimension})
        );
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vss_map (
          rowid INTEGER PRIMARY KEY,
          node_id TEXT NOT NULL UNIQUE
        );
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_vss_map_node ON vss_map(node_id);
      `);
    }
  }

  private ensureVectorsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        node_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  isAnnEnabled(): boolean {
    return this.vssEnabled;
  }

  async storeVector(nodeId: string, embedding: Float32Array, model: string): Promise<void> {
    const now = Date.now();
    const blob = Buffer.from(embedding.buffer);
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO vectors (node_id, embedding, model, created_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(nodeId, blob, model, now);

    if (this.vssEnabled) {
      this.storeInVss(nodeId, embedding);
    }
  }

  private storeInVss(nodeId: string, embedding: Float32Array): void {
    try {
      const existing = this.db
        .prepare('SELECT rowid FROM vss_map WHERE node_id = ?')
        .get(nodeId) as { rowid: number } | undefined;

      if (existing) {
        const vectorJson = JSON.stringify(Array.from(embedding));
        this.db
          .prepare('UPDATE vss_vectors SET embedding = ? WHERE rowid = ?')
          .run(vectorJson, existing.rowid);
      } else {
        const maxRow = this.db
          .prepare('SELECT MAX(rowid) as max FROM vss_map')
          .get() as { max: number | null } | undefined;
        const newRowid = (maxRow?.max ?? 0) + 1;

        const vectorJson = JSON.stringify(Array.from(embedding));
        this.db
          .prepare('INSERT INTO vss_vectors (rowid, embedding) VALUES (?, ?)')
          .run(newRowid, vectorJson);

        this.db
          .prepare('INSERT INTO vss_map (rowid, node_id) VALUES (?, ?)')
          .run(newRowid, nodeId);
      }
    } catch (error) {
      console.warn(
        'VSS storage failed, using brute-force search:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async storeVectorBatch(
    entries: Array<{ nodeId: string; embedding: Float32Array }>,
    model: string
  ): Promise<void> {
    const now = Date.now();

    this.db.transaction(() => {
      for (const entry of entries) {
        const blob = Buffer.from(entry.embedding.buffer);
        this.db
          .prepare(
            `
            INSERT OR REPLACE INTO vectors (node_id, embedding, model, created_at)
            VALUES (?, ?, ?, ?)
          `
          )
          .run(entry.nodeId, blob, model, now);

        if (this.vssEnabled) {
          this.storeInVss(entry.nodeId, entry.embedding);
        }
      }
    })();
  }

  async getVector(nodeId: string): Promise<Float32Array | null> {
    const row = this.db
      .prepare('SELECT embedding FROM vectors WHERE node_id = ?')
      .get(nodeId) as { embedding: Buffer } | undefined;

    if (!row) {
      return null;
    }

    return new Float32Array(row.embedding.buffer.slice(
      row.embedding.byteOffset,
      row.embedding.byteOffset + row.embedding.byteLength
    ));
  }

  async deleteVector(nodeId: string): Promise<void> {
    this.db.prepare('DELETE FROM vectors WHERE node_id = ?').run(nodeId);

    if (this.vssEnabled) {
      const mapping = this.db
        .prepare('SELECT rowid FROM vss_map WHERE node_id = ?')
        .get(nodeId) as { rowid: number } | undefined;

      if (mapping) {
        this.db.prepare('DELETE FROM vss_vectors WHERE rowid = ?').run(mapping.rowid);
        this.db.prepare('DELETE FROM vss_map WHERE node_id = ?').run(nodeId);
      }
    }
  }

  async search(
    queryEmbedding: Float32Array,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const { limit = 10, minScore = 0 } = options;

    if (this.vssEnabled) {
      return this.searchWithVss(queryEmbedding, limit, minScore);
    } else {
      return this.searchBruteForce(queryEmbedding, limit, minScore);
    }
  }

  private searchWithVss(
    queryEmbedding: Float32Array,
    limit: number,
    minScore: number
  ): VectorSearchResult[] {
    try {
      const vectorJson = JSON.stringify(Array.from(queryEmbedding));
      const safeLimit = Math.max(1, Math.floor(limit));

      const rows = this.db
        .prepare(
          `
          SELECT m.node_id, v.distance
          FROM (
            SELECT rowid, distance
            FROM vss_vectors
            WHERE vss_search(embedding, ?)
            LIMIT ${safeLimit}
          ) v
          JOIN vss_map m ON m.rowid = v.rowid
        `
        )
        .all(vectorJson) as Array<{ node_id: string; distance: number }>;

      return rows
        .map((row) => ({
          nodeId: row.node_id,
          score: 1 / (1 + row.distance),
        }))
        .filter((r) => r.score >= minScore);
    } catch (error) {
      console.warn(
        'VSS search failed, using brute-force:',
        error instanceof Error ? error.message : String(error)
      );
      return this.searchBruteForce(queryEmbedding, limit, minScore);
    }
  }

  private searchBruteForce(
    queryEmbedding: Float32Array,
    limit: number,
    minScore: number
  ): VectorSearchResult[] {
    const rows = this.db
      .prepare('SELECT node_id, embedding FROM vectors')
      .all() as Array<{ node_id: string; embedding: Buffer }>;

    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      const embedding = new Float32Array(row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      ));

      const score = TextEmbedder.cosineSimilarity(queryEmbedding, embedding);

      if (score >= minScore) {
        results.push({ nodeId: row.node_id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getVectorCount(): Promise<number> {
    const result = this.db
      .prepare('SELECT COUNT(*) as count FROM vectors')
      .get() as { count: number };
    return result.count;
  }

  async hasVector(nodeId: string): Promise<boolean> {
    const result = this.db
      .prepare('SELECT 1 FROM vectors WHERE node_id = ? LIMIT 1')
      .get(nodeId);
    return !!result;
  }

  async getIndexedNodeIds(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT node_id FROM vectors')
      .all() as Array<{ node_id: string }>;
    return rows.map((r) => r.node_id);
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM vectors').run();

    if (this.vssEnabled) {
      this.db.prepare('DELETE FROM vss_vectors').run();
      this.db.prepare('DELETE FROM vss_map').run();
    }
  }

  async rebuildIndex(): Promise<void> {
    if (!this.vssEnabled) {
      return;
    }

    this.db.prepare('DELETE FROM vss_vectors').run();
    this.db.prepare('DELETE FROM vss_map').run();

    const rows = this.db
      .prepare('SELECT node_id, embedding FROM vectors')
      .all() as Array<{ node_id: string; embedding: Buffer }>;

    this.db.transaction(() => {
      for (const row of rows) {
        const embedding = new Float32Array(row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength
        ));
        this.storeInVss(row.node_id, embedding);
      }
    })();
  }

  async dispose(): Promise<void> {
    // No-op: SQLite connection is managed by DatabaseConnection
  }
}
