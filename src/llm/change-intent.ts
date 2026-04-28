/**
 * Change-intent generator — given a symbol's body before and after a
 * change, produce a one-line description of what the change does
 * (vs. what the diff shows, which is the *how*).
 *
 * Designed to plug into PR-review tooling (codegraph_review_context
 * / ultrareview), but exposed standalone so any caller can use it.
 *
 * Non-cached at the API layer to keep the surface tiny. PR-review
 * callers typically want one-shot summaries against a given commit
 * range and don't benefit from a long-lived cache; if persistent
 * caching is wanted later, add a content-hash-keyed table similar to
 * symbol_summaries.
 */

import { LlmClient, LlmEndpointError } from './client';

const MAX_BODY_CHARS = 1500;

export interface ChangeIntentOptions {
  signal?: AbortSignal;
  /** Override prompt temperature; default 0.2 — stays close to evidence. */
  temperature?: number;
}

export interface ChangeIntentResult {
  intent: string;
  durationMs: number;
}

function trim(body: string): string {
  return body.length > MAX_BODY_CHARS
    ? body.slice(0, MAX_BODY_CHARS) + '\n// ... (truncated)'
    : body;
}

function buildPrompt(name: string, kind: string, beforeBody: string, afterBody: string): string {
  if (!beforeBody) {
    return [
      'You are reviewing a code change. The following symbol was ADDED.',
      `Symbol: ${name} (${kind})`,
      '',
      '## After',
      '```',
      trim(afterBody),
      '```',
      '',
      'Write ONE LINE (max 200 chars) describing what this newly added',
      'symbol does and why it likely matters in this PR. Start with a',
      'verb. No fluff. Just the line.',
    ].join('\n');
  }
  if (!afterBody) {
    return [
      'You are reviewing a code change. The following symbol was REMOVED.',
      `Symbol: ${name} (${kind})`,
      '',
      '## Before',
      '```',
      trim(beforeBody),
      '```',
      '',
      'Write ONE LINE (max 200 chars) describing what was removed and the',
      'likely impact. Start with a verb (e.g. "Removes ..."). No fluff.',
    ].join('\n');
  }
  return [
    'You are reviewing a code change. Compare the BEFORE and AFTER versions',
    `of ${name} (${kind}) and describe what changed at the *intent* level.`,
    '',
    '## Before',
    '```',
    trim(beforeBody),
    '```',
    '',
    '## After',
    '```',
    trim(afterBody),
    '```',
    '',
    'Write ONE LINE (max 200 chars) describing the behavioural change.',
    'Focus on intent, not mechanics — what does the code now do that it',
    'did not, or vice versa? Start with a verb. No "This change..." or',
    'markdown. Just the line.',
  ].join('\n');
}

/**
 * One-shot change-intent generation. Throws on endpoint failure
 * because callers (review tooling) want to surface the error rather
 * than silently produce no intent.
 */
export async function summarizeChange(
  client: LlmClient,
  name: string,
  kind: string,
  beforeBody: string,
  afterBody: string,
  options: ChangeIntentOptions = {}
): Promise<ChangeIntentResult> {
  if (!beforeBody && !afterBody) {
    throw new LlmEndpointError('summarizeChange requires either beforeBody or afterBody');
  }
  const t0 = Date.now();
  const result = await client.chat(
    [{ role: 'user', content: buildPrompt(name, kind, beforeBody, afterBody) }],
    { temperature: options.temperature ?? 0.2, maxTokens: 80 }
  );
  let intent = (result.text.split('\n')[0] || '').trim();
  if (intent.length > 200) intent = intent.slice(0, 199) + '…';
  return { intent, durationMs: Date.now() - t0 };
}
