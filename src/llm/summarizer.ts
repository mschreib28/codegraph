/**
 * Symbol Summarizer
 *
 * Generates one-line LLM descriptions of source-code symbols that lack
 * meaningful docstrings. Cached per symbol with a content_hash so the
 * summary stays in sync with the body — change the body, the next pass
 * regenerates only that symbol.
 *
 * Designed to run as a background job after `indexAll` / `sync` so the
 * CLI returns immediately. The user can query codegraph while summaries
 * arrive incrementally.
 *
 * Pure data layer + driver — the LLM HTTP work lives in `LlmClient`.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { Node } from '../types';
import { QueryBuilder } from '../db/queries';
import { LlmClient, LlmEndpointError } from './client';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot } from '../utils';

/** Symbol kinds worth summarising. Skip parameters/imports/literals. */
export const SUMMARIZABLE_KINDS: ReadonlySet<string> = new Set([
  'class', 'function', 'method', 'interface', 'struct',
  'trait', 'protocol', 'enum', 'type_alias', 'component', 'route',
]);

/** Min body lines to bother summarising. Skip 1-line getters. */
const MIN_BODY_LINES = 3;

/** Truncate symbol bodies to this many chars to control prompt size. */
const MAX_BODY_CHARS = 4000;

/** Concurrent summarisation requests in flight. Ollama serializes
 * internally; >1 buys little but keeps the network pipeline warm. */
const DEFAULT_CONCURRENCY = 2;

/** Max chars in the produced summary. Anything longer gets truncated. */
const MAX_SUMMARY_CHARS = 200;

export interface SummarizerOptions {
  /** Skip symbols whose existing docstring already exceeds this length. */
  existingDocstringCharThreshold?: number;
  /** Concurrency. Default 2. */
  concurrency?: number;
  /** Optional progress callback. */
  onProgress?: (done: number, total: number) => void;
  /** AbortSignal — used to cancel in-flight summarisation when the
   * project is closed or a new sync starts. */
  signal?: AbortSignal;
}

export interface SummarizerResult {
  /** Symbols evaluated as candidates. */
  candidates: number;
  /** Summaries generated this run (cache-misses + body changes). */
  generated: number;
  /** Summaries skipped because the cached one is still valid. */
  cacheHits: number;
  /** Failures (timeout, network, server error). */
  errors: number;
  /** Total wall time in ms. */
  durationMs: number;
}

/**
 * Strict prompt — single line, action verb, no fluff. We've benched
 * this template against codegraph itself; quality is consistent across
 * function/class/interface kinds.
 */
function buildPrompt(sym: Node, body: string): string {
  return [
    'You are a senior code reviewer documenting an unfamiliar codebase.',
    '',
    `Write a SINGLE LINE summary (max ${MAX_SUMMARY_CHARS} chars) of what this ${sym.kind} does.`,
    'Start with an action verb. No "This function...", no fluff, no markdown. Just the summary.',
    '',
    '```',
    body,
    '```',
    '',
    'Summary:',
  ].join('\n');
}

/** Stable content hash so we know when to regenerate. */
export function contentHashFor(sym: Node, body: string): string {
  const h = crypto.createHash('sha256');
  h.update(sym.signature ?? '');
  h.update('\0');
  h.update(body);
  return h.digest('hex').slice(0, 32);
}

/**
 * Run a full summarisation pass over every summarisable symbol that
 * doesn't yet have a fresh cached summary. Safe to call repeatedly:
 * cache hits are O(1) per symbol and require no LLM call.
 */
export async function summarizeAll(
  projectRoot: string,
  queries: QueryBuilder,
  client: LlmClient,
  modelLabel: string,
  options: SummarizerOptions = {}
): Promise<SummarizerResult> {
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const docThreshold = options.existingDocstringCharThreshold ?? 30;

  const candidates = queries.getSummarizableNodes(SUMMARIZABLE_KINDS, MIN_BODY_LINES, docThreshold);
  const total = candidates.length;
  let done = 0;
  let generated = 0;
  let cacheHits = 0;
  let errors = 0;

  // Read body from disk lazily (per symbol) to avoid loading every file
  // upfront. Cache file content by path while iterating so multiple
  // symbols in one file hit the cache.
  const fileContentCache = new Map<string, string[] | null>();
  const readBodyLines = (sym: Node): string => {
    let lines = fileContentCache.get(sym.filePath);
    if (lines === undefined) {
      // Defense-in-depth path-traversal guard. node.filePath comes
      // from the indexer, which already filters its inputs, but a
      // belt-and-suspenders check matches what context/extraction do
      // and protects against malformed nodes from older schemas.
      const safePath = validatePathWithinRoot(projectRoot, sym.filePath);
      if (!safePath) {
        lines = null;
      } else {
        try {
          const full = fs.readFileSync(safePath, 'utf-8');
          lines = full.split('\n');
        } catch {
          lines = null;
        }
      }
      fileContentCache.set(sym.filePath, lines);
    }
    if (!lines) return '';
    const slice = lines.slice(Math.max(0, sym.startLine - 1), sym.endLine);
    const joined = slice.join('\n');
    return joined.length > MAX_BODY_CHARS
      ? joined.slice(0, MAX_BODY_CHARS) + '\n// ... (truncated)'
      : joined;
  };

  // Worker that pulls from a shared index pointer.
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      if (options.signal?.aborted) return;
      const i = next++;
      const sym = candidates[i];
      if (!sym) break;
      try {
        const body = readBodyLines(sym);
        if (!body) {
          errors++;
          continue;
        }
        const hash = contentHashFor(sym, body);

        const existing = queries.getSymbolSummary(sym.id);
        if (existing && existing.contentHash === hash && existing.model === modelLabel) {
          cacheHits++;
          done++;
          options.onProgress?.(done, total);
          continue;
        }

        const result = await client.chat(
          [{ role: 'user', content: buildPrompt(sym, body) }],
          { temperature: 0, maxTokens: 80 }
        );
        let summary = result.text.trim().split('\n')[0]?.trim() ?? '';
        if (summary.length === 0) {
          errors++;
        } else {
          if (summary.length > MAX_SUMMARY_CHARS) {
            summary = summary.slice(0, MAX_SUMMARY_CHARS - 1) + '…';
          }
          queries.upsertSymbolSummary(sym.id, hash, summary, modelLabel);
          generated++;
        }
      } catch (err) {
        errors++;
        if (err instanceof LlmEndpointError) {
          logDebug('Summarizer: endpoint error', { node: sym.id, error: err.message });
        } else {
          logWarn('Summarizer: unexpected error', { node: sym.id, error: String(err) });
        }
      } finally {
        done++;
        options.onProgress?.(done, total);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    candidates: total,
    generated,
    cacheHits,
    errors,
    durationMs: Date.now() - t0,
  };
}
