/**
 * Dead-code judge.
 *
 * Tier-3 enrichment: combine the deterministic graph signal
 * ("0 incoming `calls` edges + not exported + not a test fixture")
 * with an LLM judge that knows about entry points the graph can't see
 * (CLI commands, MCP tool handlers, framework hooks called by name).
 *
 * Output is a confidence-tagged candidate list, NOT a delete list —
 * the user always decides.
 */

import { LlmClient, LlmEndpointError } from './client';
import { Node } from '../types';
import { QueryBuilder } from '../db/queries';
import { logDebug, logWarn } from '../errors';

/** Kinds we'd flag as potentially dead. Skip data shapes (interfaces,
 *  types, enums) — those are usually used via type-positions the
 *  reference resolver doesn't track. */
const SUSPECT_KINDS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'class',
  'component',
]);

/** File-path patterns that exempt a symbol from suspicion. */
const EXEMPT_PATH_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /(^|\/)scripts?\//,
  /(^|\/)bench\//,
  /(^|\/)benchmarks?\//,
];

const DEFAULT_CONCURRENCY = 2;

export interface DeadCodeOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Max candidates to judge in one pass (cap for very large repos). */
  maxCandidates?: number;
}

export interface DeadCodeCandidate {
  node: Node;
  /** "dead" | "live" | "uncertain" — model's verdict. */
  verdict: 'dead' | 'live' | 'uncertain';
  /** 0..1 — model's stated confidence. Heuristic, not calibrated. */
  confidence: number;
  /** One-line justification. */
  reason: string;
}

export interface DeadCodeResult {
  candidates: number;
  judged: number;
  errors: number;
  results: DeadCodeCandidate[];
  durationMs: number;
}

/**
 * Find graph-level "looks dead" candidates BEFORE asking the LLM.
 * Cheap pre-filter so we don't burn tokens on obviously-live symbols.
 */
function findGraphCandidates(queries: QueryBuilder, max: number): Node[] {
  const candidates = queries.findOrphanedSymbols(max * 2); // overshoot, we'll filter
  const out: Node[] = [];
  for (const node of candidates) {
    if (!SUSPECT_KINDS.has(node.kind)) continue;
    if (EXEMPT_PATH_PATTERNS.some((p) => p.test(node.filePath))) continue;
    out.push(node);
    if (out.length >= max) break;
  }
  return out;
}

interface JudgeResponse {
  verdict: 'dead' | 'live' | 'uncertain';
  confidence: number;
  reason: string;
}

function parseJudgeResponse(text: string): JudgeResponse {
  // Expected format: a single JSON object on one line. Be lenient with
  // markdown fencing — strip ```json/``` markers and any stray
  // backticks the model might leave behind on multi-line outputs.
  const cleaned = text
    .trim()
    .replace(/```(?:json)?/g, '')
    .replace(/`/g, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    const v = String(obj.verdict || '').toLowerCase();
    const verdict: JudgeResponse['verdict'] =
      v === 'dead' || v === 'live' || v === 'uncertain' ? v : 'uncertain';
    const conf = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '';
    return { verdict, confidence: conf, reason };
  } catch {
    // Fall through — return a low-confidence uncertain
    return { verdict: 'uncertain', confidence: 0.3, reason: 'unparseable judge response' };
  }
}

function buildPrompt(node: Node, summary: string | null): string {
  return [
    'You are reviewing whether a symbol is dead code.',
    'Inputs: a symbol with NO incoming "calls" edges in the static',
    'reference graph, and is NOT marked as exported. The graph misses:',
    '  - dynamic dispatch (method called by string name)',
    '  - framework hooks (e.g. Express middleware, CLI commands,',
    '    MCP tool handlers, React component used in JSX from another file)',
    '  - test fixtures used implicitly',
    '  - public API consumed by external projects',
    '',
    `Symbol: ${node.name} (${node.kind}) at ${node.filePath}:${node.startLine}`,
    summary ? `Summary: ${summary}` : 'Summary: (none)',
    '',
    'Reply with EXACTLY one JSON object on one line:',
    '{"verdict": "dead" | "live" | "uncertain", "confidence": 0.0-1.0, "reason": "one short sentence"}',
    'No markdown, no prose outside the JSON.',
  ].join('\n');
}

export async function judgeDeadCode(
  queries: QueryBuilder,
  client: LlmClient,
  options: DeadCodeOptions = {}
): Promise<DeadCodeResult> {
  const t0 = Date.now();
  const max = options.maxCandidates ?? 200;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const graphCandidates = findGraphCandidates(queries, max);
  const total = graphCandidates.length;
  let done = 0;
  let judged = 0;
  let errors = 0;
  const results: DeadCodeCandidate[] = [];

  const summaries = queries.getSymbolSummaries(graphCandidates.map((n) => n.id));

  let next = 0;
  async function worker(): Promise<void> {
    while (next < graphCandidates.length) {
      if (options.signal?.aborted) return;
      const i = next++;
      const node = graphCandidates[i]!;
      try {
        const result = await client.chat(
          [{ role: 'user', content: buildPrompt(node, summaries.get(node.id) ?? null) }],
          { temperature: 0, maxTokens: 120 }
        );
        if (options.signal?.aborted) return;
        const parsed = parseJudgeResponse(result.text);
        results.push({ node, ...parsed });
        judged++;
      } catch (err) {
        errors++;
        if (err instanceof LlmEndpointError) {
          logDebug('DeadCode: endpoint error', { node: node.id, error: err.message });
        } else {
          logWarn('DeadCode: unexpected error', { node: node.id, error: String(err) });
        }
      } finally {
        done++;
        options.onProgress?.(done, total);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Surface "dead" verdicts first, then uncertain, then live (which
  // the user probably wants to know they DON'T need to clean up).
  results.sort((a, b) => {
    const order = { dead: 0, uncertain: 1, live: 2 } as const;
    if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
    return b.confidence - a.confidence;
  });

  return {
    candidates: total,
    judged,
    errors,
    results,
    durationMs: Date.now() - t0,
  };
}
