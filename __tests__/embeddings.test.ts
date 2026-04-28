/**
 * Embedding pipeline + hybrid search + cross-language matching.
 *
 * Reuses the in-process fake-Ollama pattern from llm.test.ts so the
 * tests stay hermetic. The fake server returns deterministic vectors
 * derived from the input text so we can assert ordering by hand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { AddressInfo } from 'net';
import { CodeGraph } from '../src';
import {
  vectorToBytes,
  bytesToVector,
  cosineNormalised,
  reciprocalRankFusion,
  topKByCosine,
  topKByCosineMatrix,
  EmbeddingCache,
} from '../src/llm/embeddings';

const EMBED_DIM = 8;

function l2(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** Deterministic 8-dim vector keyed off character codes. */
function fakeEmbed(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % EMBED_DIM] += text.charCodeAt(i) % 17;
  }
  return v;
}

interface FakeServer {
  url: string;
  chatCalls: number;
  embedCalls: number;
  close: () => Promise<void>;
}

async function startFake(): Promise<FakeServer> {
  const state = { chatCalls: 0, embedCalls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/models') || req.url === '/models') {
        res.end(
          JSON.stringify({
            data: [{ id: 'qwen2.5-coder:7b' }, { id: 'nomic-embed-text' }],
          })
        );
        return;
      }
      if (req.url?.endsWith('/chat/completions')) {
        state.chatCalls++;
        // Look for the symbol body in the user message and echo a
        // deterministic summary so the cache key is stable.
        const parsed = JSON.parse(body) as {
          messages: Array<{ content: string }>;
        };
        const userText = parsed.messages?.[0]?.content || '';
        const last = userText.slice(-200);
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Summary of: ' + last.replace(/\s+/g, ' ').slice(0, 80),
                },
              },
            ],
          })
        );
        return;
      }
      if (req.url?.endsWith('/embeddings')) {
        state.embedCalls++;
        const parsed = JSON.parse(body) as { input: string[] };
        res.end(
          JSON.stringify({
            data: parsed.input.map((text) => ({ embedding: fakeEmbed(text) })),
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    get chatCalls() {
      return state.chatCalls;
    },
    get embedCalls() {
      return state.embedCalls;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe('embedding helpers', () => {
  it('vectorToBytes round-trips through bytesToVector', () => {
    const v = l2(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const b = vectorToBytes(v);
    const v2 = bytesToVector(b);
    for (let i = 0; i < v.length; i++) {
      expect(v2[i]).toBeCloseTo(v[i]!, 6);
    }
  });

  it('cosineNormalised gives 1.0 for the same vector', () => {
    const v = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    expect(cosineNormalised(v, v)).toBeCloseTo(1, 6);
  });

  it('cosineNormalised gives 0 for orthogonal vectors', () => {
    const a = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const b = l2(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]));
    expect(cosineNormalised(a, b)).toBeCloseTo(0, 6);
  });

  it('topKByCosine returns the highest-scoring node ids', () => {
    const query = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const candidates = [
      { nodeId: 'a', embedding: vectorToBytes(l2(Float32Array.from([0.9, 0.1, 0, 0, 0, 0, 0, 0]))) },
      { nodeId: 'b', embedding: vectorToBytes(l2(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]))) },
      { nodeId: 'c', embedding: vectorToBytes(l2(Float32Array.from([0.5, 0.5, 0, 0, 0, 0, 0, 0]))) },
    ];
    const hits = topKByCosine(query, candidates, 2);
    expect(hits.map((h) => h.nodeId)).toEqual(['a', 'c']);
  });

  it('RRF favors items appearing high in both rankings', () => {
    const fts = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const sem = [{ id: 'y' }, { id: 'z' }, { id: 'x' }];
    const fused = reciprocalRankFusion([fts, sem]);
    // y appears at rank 2 in fts (1/62) + rank 1 in sem (1/61) = highest
    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(sorted[0]).toBe('y');
  });

  it('topKByCosineMatrix matches topKByCosine on the same data', () => {
    const query = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const vecs = [
      { id: 'a', v: l2(Float32Array.from([0.9, 0.1, 0, 0, 0, 0, 0, 0])) },
      { id: 'b', v: l2(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0])) },
      { id: 'c', v: l2(Float32Array.from([0.5, 0.5, 0, 0, 0, 0, 0, 0])) },
    ];
    const candidates = vecs.map((e) => ({ nodeId: e.id, embedding: vectorToBytes(e.v) }));
    const matrix = new Float32Array(vecs.length * EMBED_DIM);
    const ids = vecs.map((e) => e.id);
    for (let i = 0; i < vecs.length; i++) matrix.set(vecs[i]!.v, i * EMBED_DIM);

    const a = topKByCosine(query, candidates, 3).map((h) => h.nodeId);
    const b = topKByCosineMatrix(query, matrix, ids, EMBED_DIM, 3).map((h) => h.nodeId);
    expect(b).toEqual(a);
  });

  it('EmbeddingCache returns the same result on hit and miss; invalidate forces refetch', () => {
    let fetchCalls = 0;
    const v = vectorToBytes(l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])));
    const fetcher = {
      getAllEmbeddings: (_model: string) => {
        fetchCalls++;
        return [{ nodeId: 'a', embedding: v }];
      },
    };

    const cache = new EmbeddingCache();
    const r1 = cache.get(fetcher, 'm');
    const r2 = cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(1);
    expect(r1).toBe(r2);
    expect(r1.ids).toEqual(['a']);
    expect(r1.dim).toBe(EMBED_DIM);

    cache.invalidate();
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(2);

    // Switching models also forces a refetch.
    cache.get(fetcher, 'other-model');
    expect(fetchCalls).toBe(3);
  });

  it('EmbeddingCache skips rows whose dimension does not match the first row', () => {
    const v3 = vectorToBytes(l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])));
    // Different shape: 4-dim vector. Should be skipped.
    const v4 = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
    const fetcher = {
      getAllEmbeddings: (_model: string) => [
        { nodeId: 'good', embedding: v3 },
        { nodeId: 'bad', embedding: v4 },
        { nodeId: 'good2', embedding: v3 },
      ],
    };
    const cache = new EmbeddingCache();
    const r = cache.get(fetcher, 'm');
    expect(r.ids).toEqual(['good', 'good2']);
    expect(r.matrix.length).toBe(2 * EMBED_DIM);
    expect(r.dim).toBe(EMBED_DIM);
  });

  it('EmbeddingCache returns an empty result without calling the fetcher again on hit', () => {
    let fetchCalls = 0;
    const fetcher = {
      getAllEmbeddings: (_model: string) => {
        fetchCalls++;
        return [];
      },
    };
    const cache = new EmbeddingCache();
    const r = cache.get(fetcher, 'm');
    expect(r.ids).toEqual([]);
    expect(r.dim).toBe(0);
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(1);
  });
});

describe('CodeGraph hybrid search & similar', () => {
  let tempDir: string;
  let fake: FakeServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-emb-'));
    fake = await startFake();
    fs.writeFileSync(
      path.join(tempDir, 'sample.ts'),
      `export function authenticateUser(name: string): string {
  const token = 'secret';
  const claim = 'session';
  return name + token + claim;
}

export function lookupAccount(id: string): { id: string } {
  const cache = new Map<string, { id: string }>();
  cache.set(id, { id });
  return { id };
}

export class TokenStore {
  private bag: Map<string, string> = new Map();
  put(k: string, v: string): void { this.bag.set(k, v); }
  get(k: string): string | undefined { return this.bag.get(k); }
  size(): number { return this.bag.size; }
}
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'helper.py'),
      `def authenticate_user(name):
    token = 'secret'
    claim = 'session'
    return name + token + claim
`
    );
  });

  afterEach(async () => {
    await fake.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('searchHybrid falls back to FTS when no embedding model is configured', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const results = await cg.searchHybrid('authenticate', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      // No embeddings in DB → no embed calls fired
      expect(fake.embedCalls).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('background pass produces summaries AND embeddings end-to-end', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: {
          endpoint: fake.url,
          chatModel: 'qwen2.5-coder:7b',
          embeddingModel: 'nomic-embed-text',
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      const cov = cg.getSummaryCoverage();
      expect(cov.summarised).toBeGreaterThan(0);
      // Embedding pass also ran (chat calls > 0 AND embed calls > 0)
      expect(fake.chatCalls).toBeGreaterThan(0);
      expect(fake.embedCalls).toBeGreaterThan(0);

      // Re-running summarize is a cache hit; re-running embed should
      // also be a cache hit (embedding_model already set).
      const callsAfterFirst = fake.chatCalls + fake.embedCalls;
      await cg.summarizeAll();
      // chat shouldn't fire again; embed pass not invoked here directly.
      expect(fake.chatCalls + fake.embedCalls).toBe(callsAfterFirst);
    } finally {
      cg.close();
    }
  });

  it('searchHybrid returns FTS+semantic blended results once embeddings exist', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: {
          endpoint: fake.url,
          chatModel: 'qwen2.5-coder:7b',
          embeddingModel: 'nomic-embed-text',
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      const results = await cg.searchHybrid('authenticateUser', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      // Hybrid path embedded the query (one extra embed call beyond
      // the bulk-summary embeddings).
      expect(fake.embedCalls).toBeGreaterThan(1);
    } finally {
      cg.close();
    }
  });

  it('findSimilar returns related symbols and respects differentLanguage', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: {
          endpoint: fake.url,
          chatModel: 'qwen2.5-coder:7b',
          embeddingModel: 'nomic-embed-text',
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      const ts = cg.searchNodes('authenticateUser', { limit: 1 })[0];
      expect(ts).toBeDefined();

      const similar = await cg.findSimilar(ts!.node.id, { limit: 3 });
      // Should exclude the source itself
      expect(similar.find((r) => r.node.id === ts!.node.id)).toBeUndefined();

      // Cross-language filter should only return non-TS hits (or empty)
      const xLang = await cg.findSimilar(ts!.node.id, { limit: 3, differentLanguage: true });
      for (const r of xLang) {
        expect(r.node.language).not.toBe(ts!.node.language);
      }
    } finally {
      cg.close();
    }
  });
});
