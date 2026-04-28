/**
 * Naming-convention drift checker.
 *
 * Tier-3 enrichment: when a new symbol is added, compare its name
 * against siblings of the same kind and ask the LLM whether it
 * follows the established convention. Surfaces as an advisory — not
 * an enforcement — because conventions in real codebases are mushy.
 *
 * Designed to be cheap: pulls a small (~30-name) sample of siblings,
 * one LLM call per check, no caching at this layer.
 */

import { LlmClient, LlmEndpointError } from './client';
import { Node } from '../types';
import { QueryBuilder } from '../db/queries';

const MAX_SIBLING_SAMPLE = 30;

export interface NamingCheckOptions {
  signal?: AbortSignal;
}

export interface NamingCheckResult {
  consistent: boolean;
  /** Optional better-named suggestion. Empty when consistent. */
  suggestion: string;
  /** One-line explanation. */
  reason: string;
  /** The sample of sibling names the model was given. Useful for UI. */
  examples: string[];
  durationMs: number;
}

function buildPrompt(name: string, kind: string, examples: string[]): string {
  return [
    `You are a code reviewer checking that a newly added ${kind} follows the`,
    `naming conventions used by the rest of the codebase.`,
    '',
    'Existing names of the same kind in this codebase:',
    ...examples.map((n) => `  - ${n}`),
    '',
    `Newly added: ${name}`,
    '',
    'Reply with EXACTLY one JSON object on one line:',
    '{"consistent": true | false, "suggestion": "alternative name or empty string", "reason": "one short sentence"}',
    'No markdown, no prose outside the JSON. If unsure, prefer consistent=true.',
  ].join('\n');
}

interface RawResponse {
  consistent?: unknown;
  suggestion?: unknown;
  reason?: unknown;
}

function parseResponse(text: string, examples: string[]): NamingCheckResult {
  const cleaned = text.trim().replace(/```(?:json)?/g, '').trim();
  let obj: RawResponse;
  try {
    obj = JSON.parse(cleaned) as RawResponse;
  } catch {
    return {
      consistent: true, // err on the side of not flagging
      suggestion: '',
      reason: 'unparseable judge response — defaulting to consistent',
      examples,
      durationMs: 0,
    };
  }
  return {
    consistent: obj.consistent !== false, // default true unless explicit false
    suggestion: typeof obj.suggestion === 'string' ? obj.suggestion.slice(0, 80) : '',
    reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '',
    examples,
    durationMs: 0,
  };
}

/**
 * Check a single name against the codebase's existing naming
 * conventions for the same kind. One LLM call.
 */
export async function checkNamingConvention(
  queries: QueryBuilder,
  client: LlmClient,
  newSymbol: { name: string; kind: string; filePath: string },
  options: NamingCheckOptions = {}
): Promise<NamingCheckResult> {
  void options.signal; // The chat call honors signal via the client itself.
  const t0 = Date.now();

  const examples = queries.sampleSiblingNames(
    newSymbol.kind,
    newSymbol.name,
    newSymbol.filePath,
    MAX_SIBLING_SAMPLE
  );

  // Need at least a handful of siblings before "convention" is a
  // meaningful concept — otherwise everything looks fine.
  if (examples.length < 5) {
    return {
      consistent: true,
      suggestion: '',
      reason: 'not enough sibling symbols of this kind to infer a convention',
      examples,
      durationMs: Date.now() - t0,
    };
  }

  try {
    const result = await client.chat(
      [{ role: 'user', content: buildPrompt(newSymbol.name, newSymbol.kind, examples) }],
      { temperature: 0, maxTokens: 120 }
    );
    const parsed = parseResponse(result.text, examples);
    parsed.durationMs = Date.now() - t0;
    return parsed;
  } catch (err) {
    // Naming check is advisory — never throw, just defer the verdict.
    return {
      consistent: true,
      suggestion: '',
      reason: `naming check failed: ${err instanceof LlmEndpointError ? err.message : String(err)}`,
      examples,
      durationMs: Date.now() - t0,
    };
  }
}

/** Batch helper — check a list of newly added symbols at once. */
export async function checkManyNames(
  queries: QueryBuilder,
  client: LlmClient,
  newSymbols: ReadonlyArray<Node>,
  options: NamingCheckOptions = {}
): Promise<Array<{ node: Node; check: NamingCheckResult }>> {
  const out: Array<{ node: Node; check: NamingCheckResult }> = [];
  for (const node of newSymbols) {
    if (options.signal?.aborted) break;
    const check = await checkNamingConvention(
      queries,
      client,
      { name: node.name, kind: node.kind, filePath: node.filePath },
      options
    );
    out.push({ node, check });
  }
  return out;
}
