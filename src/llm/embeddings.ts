/**
 * Embedding helpers
 *
 * Tier-1 enrichment: turn the LLM-generated summaries into Float32
 * vectors so we can do semantic search by cosine similarity. The
 * embedding model is auto-detected (nomic-embed-text et al.) the same
 * way the chat model is — see `detect.ts`.
 *
 * Storage shape: 768-dim (or whatever the model emits) Float32 bytes
 * stored as a BLOB on `symbol_embeddings` (a separate table from
 * `symbol_summaries` so common-path summary scans don't drag the
 * BLOB along their page chain). L2-normalised at write time so the
 * search-side cosine similarity is a pure dot product.
 *
 * No native deps, no in-process inference. The original embeddings
 * removal in #87 was about WASM Zone OOM crashes; this design routes
 * everything through HTTP to the same out-of-process LLM server we
 * already use for chat.
 */

import { Buffer } from 'buffer';
import { LlmClient, LlmEndpointError } from './client';
import { QueryBuilder } from '../db/queries';
import { logDebug, logWarn } from '../errors';

/** Batch size for /embeddings calls. Large enough to amortise round-trip
 *  but small enough to fit in any sane HTTP payload. Ollama and
 *  llama.cpp both accept arrays here. */
const EMBED_BATCH = 32;

/** Concurrent embedding batches. The embedding model is fast so even 1
 *  is usually CPU-bound on the server; 2 keeps the pipeline warm. */
const DEFAULT_EMBED_CONCURRENCY = 2;

export interface EmbedOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EmbedResult {
  /** Symbols evaluated as candidates (have a summary, lack a fresh embedding). */
  candidates: number;
  /** Embeddings written this run. */
  generated: number;
  /** Skipped because the cached embedding is still valid. */
  cacheHits: number;
  /** Failures (timeout, network). */
  errors: number;
  durationMs: number;
}

/** Convert a Float32Array to a SQLite BLOB buffer (little-endian, no copy). */
export function vectorToBytes(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Read a SQLite BLOB back into a Float32Array view (zero-copy when aligned). */
export function bytesToVector(b: Buffer | Uint8Array): Float32Array {
  // Make sure we get a fresh, aligned ArrayBuffer regardless of how the
  // SQLite driver hands us the bytes.
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(ab);
}

/** Cosine similarity for two L2-normalised vectors == plain dot product. */
export function cosineNormalised(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * The text we feed the embedder for a symbol. Combines the summary
 * (intent) with the name + signature (lexical handle). Keeping this
 * deterministic means a content-hash-style cache key is well-defined.
 */
export function buildEmbedText(name: string, signature: string | null, summary: string): string {
  const sig = signature ? signature.trim() : '';
  return [name, sig, summary].filter((s) => s.length > 0).join('\n');
}

/**
 * Embed every summary that doesn't yet have an embedding for the
 * current model. Idempotent — second call is a pure cache check.
 */
export async function embedAllSummaries(
  queries: QueryBuilder,
  client: LlmClient,
  embeddingModel: string,
  options: EmbedOptions = {}
): Promise<EmbedResult> {
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_EMBED_CONCURRENCY);

  const candidates = queries.getEmbeddableSummaries(embeddingModel);
  const total = candidates.length;
  let done = 0;
  let generated = 0;
  let errors = 0;

  // Build batches up front so workers can pull them off a shared queue.
  const batches: Array<typeof candidates> = [];
  for (let i = 0; i < candidates.length; i += EMBED_BATCH) {
    batches.push(candidates.slice(i, i + EMBED_BATCH));
  }

  let nextBatch = 0;
  async function worker(): Promise<void> {
    while (nextBatch < batches.length) {
      if (options.signal?.aborted) return;
      const i = nextBatch++;
      const batch = batches[i]!;
      try {
        const inputs = batch.map((c) => buildEmbedText(c.name, c.signature, c.summary));
        const vecs = await client.embed(inputs);
        if (vecs.length !== batch.length) {
          throw new LlmEndpointError(
            `embedding response length mismatch: got ${vecs.length}, want ${batch.length}`
          );
        }
        for (let k = 0; k < batch.length; k++) {
          queries.upsertSymbolEmbedding(batch[k]!.nodeId, vectorToBytes(vecs[k]!), embeddingModel);
          generated++;
          done++;
        }
        options.onProgress?.(done, total);
      } catch (err) {
        errors += batch.length;
        done += batch.length;
        if (err instanceof LlmEndpointError) {
          logDebug('Embedder: endpoint error', { batch: i, error: err.message });
        } else {
          logWarn('Embedder: unexpected error', { batch: i, error: String(err) });
        }
        options.onProgress?.(done, total);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    candidates: total,
    generated,
    cacheHits: 0, // getEmbeddableSummaries already filters cache hits out
    errors,
    durationMs: Date.now() - t0,
  };
}

/**
 * Run an in-process semantic search by scanning every embedding and
 * keeping the top-K. O(N) but for codegraph-sized indexes (≤ 50K
 * symbols, ~150 MB of vectors) this is single-digit ms in practice.
 *
 * If the index ever grows past that, the right next step is the
 * `sqlite-vec` extension — but it's a native dep so we defer until
 * needed.
 */
export interface SemanticHit {
  nodeId: string;
  score: number;
}

export function topKByCosine(
  query: Float32Array,
  candidates: ReadonlyArray<{ nodeId: string; embedding: Buffer | Uint8Array }>,
  k: number
): SemanticHit[] {
  const heap: SemanticHit[] = [];
  for (const c of candidates) {
    const v = bytesToVector(c.embedding);
    const score = cosineNormalised(query, v);
    if (heap.length < k) {
      heap.push({ nodeId: c.nodeId, score });
      heap.sort((a, b) => a.score - b.score);
    } else if (score > heap[0]!.score) {
      heap[0] = { nodeId: c.nodeId, score };
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

/**
 * Top-K cosine search over a flat decoded matrix. Used by the
 * EmbeddingCache to avoid per-query SQLite fetch + Float32Array
 * decode. The matrix is `ids.length * dim` floats laid out row-major
 * (row i for `ids[i]` starts at offset `i * dim`).
 */
export function topKByCosineMatrix(
  query: Float32Array,
  matrix: Float32Array,
  ids: ReadonlyArray<string>,
  dim: number,
  k: number
): SemanticHit[] {
  const heap: SemanticHit[] = [];
  const n = ids.length;
  const qLen = Math.min(query.length, dim);
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let score = 0;
    for (let d = 0; d < qLen; d++) score += matrix[off + d]! * query[d]!;
    if (heap.length < k) {
      heap.push({ nodeId: ids[i]!, score });
      heap.sort((a, b) => a.score - b.score);
    } else if (score > heap[0]!.score) {
      heap[0] = { nodeId: ids[i]!, score };
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

/**
 * In-memory cache of every embedding for a given model, decoded once
 * into a flat `Float32Array` matrix. Avoids re-fetching from SQLite
 * and re-decoding `Float32Array` views on every similarity query.
 *
 * Lifetime: instance-scoped (one per CodeGraph). Invalidated by:
 *   - `indexAll` and `sync` finishing (new embeddings may exist).
 *   - `clear()` / `clearCoChanges()` (the table was emptied).
 *   - `embedAllSummaries()` finishing inside the same process.
 *
 * This is a best-effort cache: a stale cache costs at most one
 * iteration of "ranked by mostly-fresh-but-missing-the-newest
 * embeddings" — never wrong, just a bit out of date until the next
 * invalidation.
 */
export interface CachedEmbeddings {
  matrix: Float32Array;
  ids: string[];
  dim: number;
  model: string;
}

export interface EmbeddingFetcher {
  getAllEmbeddings(model: string): Array<{ nodeId: string; embedding: Buffer | Uint8Array }>;
}

export class EmbeddingCache {
  private cached: CachedEmbeddings | null = null;

  /**
   * Return the cached matrix for `model`, rebuilding from `fetcher`
   * on miss. The returned matrix is owned by the cache — callers
   * must not mutate it.
   */
  get(fetcher: EmbeddingFetcher, model: string): CachedEmbeddings {
    if (this.cached && this.cached.model === model) {
      return this.cached;
    }
    const rows = fetcher.getAllEmbeddings(model);
    if (rows.length === 0) {
      this.cached = { matrix: new Float32Array(0), ids: [], dim: 0, model };
      return this.cached;
    }
    const firstVec = bytesToVector(rows[0]!.embedding);
    const dim = firstVec.length;
    // Skip mismatched-dim rows (a model upgrade in flight could leave
    // some old vectors). Build a packed matrix of only the kept rows
    // so `ids[i]` always lines up with row `i` in the matrix.
    const ids: string[] = [];
    const buf = new Float32Array(rows.length * dim);
    let written = 0;
    for (const row of rows) {
      const v = bytesToVector(row.embedding);
      if (v.length !== dim) continue;
      buf.set(v, written * dim);
      ids.push(row.nodeId);
      written++;
    }
    const matrix = written === rows.length ? buf : buf.slice(0, written * dim);
    this.cached = { matrix, ids, dim, model };
    return this.cached;
  }

  /** Drop the cache. Next `get()` rebuilds from SQLite. */
  invalidate(): void {
    this.cached = null;
  }
}

/**
 * Reciprocal Rank Fusion: combine FTS (lexical) and semantic rankings
 * into one score. Proven robust default for hybrid search.
 *
 * For each result that appears in either ranking, score is sum over
 * lists of `1 / (k + rank)`. k=60 is the canonical constant.
 */
export function reciprocalRankFusion<T extends { id: string }>(
  rankings: ReadonlyArray<ReadonlyArray<T>>,
  k = 60
): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of rankings) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!.id;
      out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return out;
}
