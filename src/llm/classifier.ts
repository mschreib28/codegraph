/**
 * Role classifier — assigns each summarised symbol a coarse role from
 * a fixed label set. Lets callers filter "show me all api_endpoints"
 * or "list the data_models" without crawling the graph by hand.
 *
 * Tier-2 enrichment: cheap (one short call per symbol, deterministic
 * single-token output), cached on symbol_summaries.role.
 */

import { LlmClient, LlmEndpointError } from './client';
import { QueryBuilder } from '../db/queries';
import { logDebug, logWarn } from '../errors';

/** Closed label set. The model is asked to pick exactly one. */
export const ROLE_LABELS = [
  'api_endpoint',
  'business_logic',
  'data_model',
  'util',
  'framework_glue',
  'test_helper',
  'unknown',
] as const;

export type RoleLabel = (typeof ROLE_LABELS)[number];

const ROLE_SET: ReadonlySet<string> = new Set(ROLE_LABELS);

const DEFAULT_CONCURRENCY = 2;

export interface ClassifierOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ClassifierResult {
  candidates: number;
  classified: number;
  cacheHits: number;
  errors: number;
  durationMs: number;
}

function buildPrompt(name: string, kind: string, signature: string | null, summary: string): string {
  const sig = signature ? `\nSignature: ${signature}` : '';
  return [
    'Classify the following code symbol into EXACTLY ONE of these roles:',
    '',
    '- api_endpoint: HTTP/RPC handler, route, public-facing entry point.',
    '- business_logic: domain operation, workflow, decision-making.',
    '- data_model: type, struct, schema, DTO, persistence record.',
    '- util: pure helper, formatter, parser, generic utility.',
    '- framework_glue: middleware, adapter, config wiring, lifecycle hook.',
    '- test_helper: fixture, mock builder, assertion helper.',
    '- unknown: cannot determine from the description.',
    '',
    `Symbol: ${name} (${kind})${sig}`,
    `Description: ${summary}`,
    '',
    'Reply with JUST the role name on a single line. No prose, no quotes.',
  ].join('\n');
}

/** Strip markdown/quotes/whitespace, return the matched role or "unknown".
 *  Tries two normalisations: (1) first whitespace-delimited token (handles
 *  `business_logic.` and `\`business_logic\``), (2) all tokens joined with
 *  underscores (handles `Business Logic`-style multi-word responses some
 *  instruction-tuned models emit). Exported for direct testing. */
export function parseRole(text: string): RoleLabel {
  const lower = text.toLowerCase().trim().replace(/^[`'"\s]+|[`'"\s]+$/g, '');
  const firstToken = lower.split(/\s+/)[0]?.replace(/[^a-z_]/g, '') ?? '';
  if (firstToken && ROLE_SET.has(firstToken)) return firstToken as RoleLabel;
  // Fallback: snake_case the whole response in case the model used spaces.
  const joined = lower.replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).join('_');
  if (joined && ROLE_SET.has(joined)) return joined as RoleLabel;
  return 'unknown';
}

/**
 * Run the classifier over every summarised symbol that doesn't yet
 * have a role from the active model. Idempotent.
 */
export async function classifyAllRoles(
  queries: QueryBuilder,
  client: LlmClient,
  modelLabel: string,
  options: ClassifierOptions = {}
): Promise<ClassifierResult> {
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const candidates = queries.getClassifiableSummaries(modelLabel);
  const total = candidates.length;
  let done = 0;
  let classified = 0;
  let errors = 0;

  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      if (options.signal?.aborted) return;
      const i = next++;
      const c = candidates[i]!;
      try {
        const result = await client.chat(
          [
            {
              role: 'user',
              content: buildPrompt(c.name, c.kind, c.signature, c.summary),
            },
          ],
          { temperature: 0, maxTokens: 12 }
        );
        // Don't persist if we were cancelled mid-call.
        if (options.signal?.aborted) return;
        const label = parseRole(result.text);
        queries.upsertSymbolRole(c.nodeId, label, modelLabel);
        classified++;
      } catch (err) {
        errors++;
        if (err instanceof LlmEndpointError) {
          logDebug('Classifier: endpoint error', { node: c.nodeId, error: err.message });
        } else {
          logWarn('Classifier: unexpected error', { node: c.nodeId, error: String(err) });
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
    classified,
    cacheHits: 0,
    errors,
    durationMs: Date.now() - t0,
  };
}
