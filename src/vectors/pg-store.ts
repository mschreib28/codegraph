/**
 * PostgreSQL Vector Store (pgvector)
 *
 * Vector storage backend using PostgreSQL with the pgvector extension.
 * Provides HNSW/IVFFlat indexes for fast approximate nearest neighbor search.
 */

import { VectorStore, VectorSearchOptions, VectorSearchResult } from './store';
import { EMBEDDING_DIMENSION } from './embedder';

/** Only allow safe SQL identifiers: letters, digits, underscores, starting with letter/underscore */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,50}$/;

/**
 * Options for the PostgreSQL vector store
 */
export interface PgVectorStoreOptions {
  /** PostgreSQL connection string */
  connectionString: string;

  /** Vector dimension (default: 768 for nomic-embed-text-v1.5) */
  dimension?: number;

  /** Index type: 'hnsw' (default), 'ivfflat', or 'none' */
  indexType?: 'hnsw' | 'ivfflat' | 'none';

  /** Distance metric: 'cosine' (default), 'l2', or 'inner_product' */
  distanceMetric?: 'cosine' | 'l2' | 'inner_product';

  /** Connection pool size (default: 5) */
  poolSize?: number;

  /** Table name prefix (default: 'codegraph_') */
  tablePrefix?: string;
}

/** pgvector operator for each distance metric */
const DISTANCE_OPERATORS: Record<string, string> = {
  cosine: '<=>',
  l2: '<->',
  inner_product: '<#>',
};

/** pgvector index ops class for each distance metric */
const INDEX_OPS: Record<string, string> = {
  cosine: 'vector_cosine_ops',
  l2: 'vector_l2_ops',
  inner_product: 'vector_ip_ops',
};

/**
 * Convert a Float32Array to pgvector string format: '[0.1,0.2,...]'
 */
function toVectorString(embedding: Float32Array): string {
  return '[' + Array.from(embedding).join(',') + ']';
}

/**
 * Convert a pgvector string back to Float32Array
 */
function fromVectorString(str: string): Float32Array {
  const values = str.slice(1, -1).split(',').map(Number);
  return new Float32Array(values);
}

/**
 * PostgreSQL vector store using pgvector extension
 *
 * Requires PostgreSQL with pgvector extension installed.
 * Provides production-grade HNSW indexes for fast ANN search.
 */
export class PgVectorStore implements VectorStore {
  readonly backendType = 'pgvector' as const;
  private pool: any; // pg.Pool
  private options: Required<PgVectorStoreOptions>;
  private tableName: string;
  private _initialized = false;

  constructor(options: PgVectorStoreOptions) {
    const prefix = options.tablePrefix ?? 'codegraph_';
    if (!SAFE_IDENTIFIER.test(prefix)) {
      throw new Error(
        `tablePrefix must be a safe SQL identifier (letters, digits, underscores, max 50 chars). Got: "${prefix}"`
      );
    }

    this.options = {
      connectionString: options.connectionString,
      dimension: options.dimension ?? EMBEDDING_DIMENSION,
      indexType: options.indexType ?? 'hnsw',
      distanceMetric: options.distanceMetric ?? 'cosine',
      poolSize: options.poolSize ?? 5,
      tablePrefix: prefix,
    };
    this.tableName = `${prefix}vectors`;
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    // Dynamically import pg
    let pg: any;
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'The "pg" package is required for pgvector backend. Install it with: npm install pg'
      );
    }

    const Pool = pg.default?.Pool ?? pg.Pool;
    const pool = new Pool({
      connectionString: this.options.connectionString,
      max: this.options.poolSize,
    });

    try {
      // Test connection
      let client: any;
      try {
        client = await pool.connect();
      } catch (error: any) {
        throw new Error(
          `Failed to connect to PostgreSQL: ${error.message}. ` +
          'Verify your connection string and ensure the database is running.'
        );
      }

      try {
        // Enable pgvector extension
        try {
          await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        } catch (error: any) {
          throw new Error(
            `pgvector extension not available: ${error.message}. ` +
            'Install pgvector on your PostgreSQL server: https://github.com/pgvector/pgvector'
          );
        }

        // Create vectors table
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.tableName} (
            node_id TEXT PRIMARY KEY,
            embedding vector(${this.options.dimension}) NOT NULL,
            model TEXT NOT NULL,
            created_at BIGINT NOT NULL
          )
        `);

        // Create index based on configured type
        await this.createIndex(client);
      } finally {
        client.release();
      }
    } catch (error) {
      // Clean up pool on any setup failure to prevent leaks
      await pool.end().catch(() => {});
      throw error;
    }

    this.pool = pool;
    this._initialized = true;
  }

  private async createIndex(client: any): Promise<void> {
    const { indexType, distanceMetric } = this.options;
    const ops = INDEX_OPS[distanceMetric];
    const indexName = `${this.tableName}_embedding_idx`;

    if (indexType === 'none') {
      return;
    }

    // Check if index already exists
    const indexCheck = await client.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [indexName]
    );
    if (indexCheck.rows.length > 0) {
      return;
    }

    if (indexType === 'hnsw') {
      await client.query(`
        CREATE INDEX ${indexName}
        ON ${this.tableName}
        USING hnsw (embedding ${ops})
        WITH (m = 16, ef_construction = 64)
      `);
    } else if (indexType === 'ivfflat') {
      const countResult = await client.query(`SELECT COUNT(*) as count FROM ${this.tableName}`);
      const count = parseInt(countResult.rows[0].count, 10);
      const lists = Math.max(1, Math.floor(Math.sqrt(count)));

      await client.query(`
        CREATE INDEX ${indexName}
        ON ${this.tableName}
        USING ivfflat (embedding ${ops})
        WITH (lists = ${lists})
      `);
    }
  }

  async storeVector(nodeId: string, embedding: Float32Array, model: string): Promise<void> {
    const vectorStr = toVectorString(embedding);
    const now = Date.now();

    await this.pool.query(
      `INSERT INTO ${this.tableName} (node_id, embedding, model, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (node_id) DO UPDATE SET embedding = $2, model = $3, created_at = $4`,
      [nodeId, vectorStr, model, now]
    );
  }

  async storeVectorBatch(
    entries: Array<{ nodeId: string; embedding: Float32Array }>,
    model: string
  ): Promise<void> {
    if (entries.length === 0) return;

    const now = Date.now();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Batch in chunks of 100 to avoid parameter limit
      const chunkSize = 100;
      for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        const values: any[] = [];
        const placeholders: string[] = [];
        let paramIdx = 1;

        for (const entry of chunk) {
          placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
          values.push(entry.nodeId, toVectorString(entry.embedding), model, now);
          paramIdx += 4;
        }

        await client.query(
          `INSERT INTO ${this.tableName} (node_id, embedding, model, created_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (node_id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             model = EXCLUDED.model,
             created_at = EXCLUDED.created_at`,
          values
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getVector(nodeId: string): Promise<Float32Array | null> {
    const result = await this.pool.query(
      `SELECT embedding::text FROM ${this.tableName} WHERE node_id = $1`,
      [nodeId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return fromVectorString(result.rows[0].embedding);
  }

  async hasVector(nodeId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tableName} WHERE node_id = $1 LIMIT 1`,
      [nodeId]
    );
    return result.rows.length > 0;
  }

  async getIndexedNodeIds(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT node_id FROM ${this.tableName}`
    );
    return result.rows.map((r: any) => r.node_id);
  }

  async search(
    queryEmbedding: Float32Array,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const { limit = 10, minScore = 0 } = options;
    const vectorStr = toVectorString(queryEmbedding);
    const operator = DISTANCE_OPERATORS[this.options.distanceMetric];

    // Compute score expression once per row via subquery.
    // All distance operators return values where lower = more similar,
    // so ORDER BY distance ASC gives the best matches first.
    let scoreExpr: string;
    if (this.options.distanceMetric === 'cosine') {
      // <=> returns cosine distance in [0,2]; similarity = 1 - distance
      scoreExpr = `1 - (embedding ${operator} $1::vector)`;
    } else if (this.options.distanceMetric === 'inner_product') {
      // <#> returns negative inner product; negate for similarity score
      scoreExpr = `-(embedding ${operator} $1::vector)`;
    } else {
      // <-> returns L2 distance; convert to similarity
      scoreExpr = `1.0 / (1.0 + (embedding ${operator} $1::vector))`;
    }

    const result = await this.pool.query(
      `SELECT node_id, score FROM (
         SELECT node_id, ${scoreExpr} AS score
         FROM ${this.tableName}
         ORDER BY embedding ${operator} $1::vector
         LIMIT $3
       ) sub
       WHERE score >= $2
       ORDER BY score DESC`,
      [vectorStr, minScore, limit]
    );

    return result.rows.map((row: any) => ({
      nodeId: row.node_id,
      score: parseFloat(row.score),
    }));
  }

  async deleteVector(nodeId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE node_id = $1`,
      [nodeId]
    );
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.tableName}`);
  }

  async getVectorCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${this.tableName}`
    );
    return parseInt(result.rows[0].count, 10);
  }

  isAnnEnabled(): boolean {
    return this.options.indexType !== 'none';
  }

  async rebuildIndex(): Promise<void> {
    const indexName = `${this.tableName}_embedding_idx`;
    const ops = INDEX_OPS[this.options.distanceMetric];

    await this.pool.query(`DROP INDEX IF EXISTS ${indexName}`);

    if (this.options.indexType === 'hnsw') {
      await this.pool.query(`
        CREATE INDEX ${indexName}
        ON ${this.tableName}
        USING hnsw (embedding ${ops})
        WITH (m = 16, ef_construction = 64)
      `);
    } else if (this.options.indexType === 'ivfflat') {
      const countResult = await this.pool.query(`SELECT COUNT(*) as count FROM ${this.tableName}`);
      const count = parseInt(countResult.rows[0].count, 10);
      const lists = Math.max(1, Math.floor(Math.sqrt(count)));

      await this.pool.query(`
        CREATE INDEX ${indexName}
        ON ${this.tableName}
        USING ivfflat (embedding ${ops})
        WITH (lists = ${lists})
      `);
    }
  }

  async dispose(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
