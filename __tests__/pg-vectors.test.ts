/**
 * PostgreSQL Vector Store (pgvector) Integration Tests
 *
 * These tests require a running PostgreSQL instance with pgvector extension.
 * Set CODEGRAPH_TEST_PG_URL to enable these tests.
 *
 * Example:
 *   CODEGRAPH_TEST_PG_URL="postgresql://user:pass@localhost:5432/codegraph_test" npm test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const PG_URL = process.env.CODEGRAPH_TEST_PG_URL;

describe.skipIf(!PG_URL)('PgVectorStore', () => {
  let PgVectorStore: any;
  let store: any;
  const TEST_DIMENSION = 3;
  const testPrefix = `codegraph_test_${Date.now()}_`;

  beforeEach(async () => {
    const mod = await import('../src/vectors/pg-store');
    PgVectorStore = mod.PgVectorStore;

    store = new PgVectorStore({
      connectionString: PG_URL!,
      dimension: TEST_DIMENSION,
      indexType: 'none', // Skip index creation for tests with small vectors
      tablePrefix: testPrefix,
    });
    await store.initialize();
  });

  afterEach(async () => {
    if (store) {
      // Clean up test table
      try {
        await store.clear();
      } catch { /* ignore */ }
      await store.dispose();
    }
  });

  it('should store and retrieve vectors', async () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    await store.storeVector('node1', embedding, 'test-model');

    const retrieved = await store.getVector('node1');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.length).toBe(3);
    expect(retrieved?.[0]).toBeCloseTo(0.1, 4);
  });

  it('should return null for non-existent vectors', async () => {
    const retrieved = await store.getVector('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should check if vector exists', async () => {
    await store.storeVector('node1', new Float32Array([0.1, 0.2, 0.3]), 'test');

    expect(await store.hasVector('node1')).toBe(true);
    expect(await store.hasVector('node2')).toBe(false);
  });

  it('should delete vectors', async () => {
    await store.storeVector('node1', new Float32Array([0.1, 0.2, 0.3]), 'test');
    expect(await store.hasVector('node1')).toBe(true);

    await store.deleteVector('node1');
    expect(await store.hasVector('node1')).toBe(false);
  });

  it('should count vectors', async () => {
    expect(await store.getVectorCount()).toBe(0);

    await store.storeVector('node1', new Float32Array([0.1, 0.2, 0.3]), 'test');
    await store.storeVector('node2', new Float32Array([0.4, 0.5, 0.6]), 'test');

    expect(await store.getVectorCount()).toBe(2);
  });

  it('should clear all vectors', async () => {
    await store.storeVector('node1', new Float32Array([0.1, 0.2, 0.3]), 'test');
    await store.storeVector('node2', new Float32Array([0.4, 0.5, 0.6]), 'test');

    expect(await store.getVectorCount()).toBe(2);

    await store.clear();

    expect(await store.getVectorCount()).toBe(0);
  });

  it('should store vectors in batch', async () => {
    const entries = [
      { nodeId: 'node1', embedding: new Float32Array([1.0, 0.0, 0.0]) },
      { nodeId: 'node2', embedding: new Float32Array([0.0, 1.0, 0.0]) },
      { nodeId: 'node3', embedding: new Float32Array([0.0, 0.0, 1.0]) },
    ];

    await store.storeVectorBatch(entries, 'test-model');

    expect(await store.getVectorCount()).toBe(3);
    expect(await store.hasVector('node1')).toBe(true);
    expect(await store.hasVector('node2')).toBe(true);
    expect(await store.hasVector('node3')).toBe(true);
  });

  it('should get indexed node IDs', async () => {
    await store.storeVector('node1', new Float32Array([0.1, 0.2, 0.3]), 'test');
    await store.storeVector('node2', new Float32Array([0.4, 0.5, 0.6]), 'test');

    const ids = await store.getIndexedNodeIds();

    expect(ids).toContain('node1');
    expect(ids).toContain('node2');
    expect(ids.length).toBe(2);
  });

  it('should perform cosine similarity search', async () => {
    await store.storeVector('node1', new Float32Array([1, 0, 0]), 'test');
    await store.storeVector('node2', new Float32Array([0.9, 0.1, 0]), 'test');
    await store.storeVector('node3', new Float32Array([0, 1, 0]), 'test');

    const query = new Float32Array([1, 0, 0]);
    const results = await store.search(query, { limit: 3 });

    expect(results.length).toBe(3);
    expect(results[0].nodeId).toBe('node1');
    expect(results[0].score).toBeCloseTo(1.0, 3);
    expect(results[1].nodeId).toBe('node2');
  });

  it('should respect minScore in search', async () => {
    await store.storeVector('node1', new Float32Array([1, 0, 0]), 'test');
    await store.storeVector('node2', new Float32Array([0, 1, 0]), 'test');

    const query = new Float32Array([1, 0, 0]);
    const results = await store.search(query, { limit: 10, minScore: 0.5 });

    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe('node1');
  });

  it('should upsert on conflict', async () => {
    await store.storeVector('node1', new Float32Array([0.1, 0.2, 0.3]), 'test');
    await store.storeVector('node1', new Float32Array([0.4, 0.5, 0.6]), 'test');

    expect(await store.getVectorCount()).toBe(1);

    const retrieved = await store.getVector('node1');
    expect(retrieved?.[0]).toBeCloseTo(0.4, 4);
  });

  it('should report ANN disabled when indexType is none', () => {
    expect(store.isAnnEnabled()).toBe(false);
  });
});

describe.skipIf(!PG_URL)('PgVectorStore with HNSW', () => {
  let PgVectorStore: any;
  let store: any;
  const TEST_DIMENSION = 3;
  const testPrefix = `codegraph_hnsw_${Date.now()}_`;

  beforeEach(async () => {
    const mod = await import('../src/vectors/pg-store');
    PgVectorStore = mod.PgVectorStore;

    store = new PgVectorStore({
      connectionString: PG_URL!,
      dimension: TEST_DIMENSION,
      indexType: 'hnsw',
      distanceMetric: 'cosine',
      tablePrefix: testPrefix,
    });
    await store.initialize();
  });

  afterEach(async () => {
    if (store) {
      try { await store.clear(); } catch { /* ignore */ }
      await store.dispose();
    }
  });

  it('should report ANN enabled with HNSW index', () => {
    expect(store.isAnnEnabled()).toBe(true);
  });

  it('should search with HNSW index', async () => {
    await store.storeVector('node1', new Float32Array([1, 0, 0]), 'test');
    await store.storeVector('node2', new Float32Array([0, 1, 0]), 'test');

    const results = await store.search(new Float32Array([1, 0, 0]), { limit: 2 });

    expect(results.length).toBe(2);
    expect(results[0].nodeId).toBe('node1');
  });

  it('should rebuild index', async () => {
    await store.storeVector('node1', new Float32Array([1, 0, 0]), 'test');

    // Should not throw
    await store.rebuildIndex();

    const results = await store.search(new Float32Array([1, 0, 0]), { limit: 1 });
    expect(results.length).toBe(1);
  });
});
