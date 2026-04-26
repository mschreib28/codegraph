/**
 * Natural-language Q&A over the indexed codebase (RAG).
 *
 * Tier-1 enrichment: hybrid-retrieve top-K relevant symbols, hand
 * the LLM a curated context (summaries + bodies for the most
 * promising ones), let it synthesise an answer that cites symbol
 * names and file paths.
 *
 * The retrieval already weights by lexical AND semantic match (PR
 * #112), so the model doesn't have to do its own retrieval — we just
 * hand it a tight, well-formed prompt.
 */

import * as fs from 'fs';
import { LlmClient } from './client';
import { Node, SearchResult } from '../types';
import { QueryBuilder } from '../db/queries';
import { validatePathWithinRoot } from '../utils';
import { logDebug } from '../errors';

/** Max bodies we include verbatim. Beyond this, we just list names + summaries. */
const MAX_FULL_BODIES = 4;
/** Per-body char cap. Long bodies blow the prompt budget for nothing. */
const MAX_BODY_CHARS = 1800;

export interface AskOptions {
  /** Max retrieved candidates to consider (deeper = better recall, slower prompt). */
  retrieveK?: number;
  /** Override the default chat model temperature (default 0.2 — stays grounded). */
  temperature?: number;
  /** Cap on response tokens. */
  maxTokens?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface AskResult {
  answer: string;
  /** Symbols the LLM was given as context — useful for citing/UI. */
  citations: Array<{ node: Node; summary?: string }>;
  /** Wall time of the chat call only. */
  chatMs: number;
  /** Wall time of retrieval only. */
  retrieveMs: number;
}

function readBodySafe(projectRoot: string, node: Node): string {
  const safe = validatePathWithinRoot(projectRoot, node.filePath);
  if (!safe) return '';
  try {
    const lines = fs.readFileSync(safe, 'utf-8').split('\n');
    const slice = lines.slice(Math.max(0, node.startLine - 1), node.endLine).join('\n');
    return slice.length > MAX_BODY_CHARS
      ? slice.slice(0, MAX_BODY_CHARS) + '\n// ... (truncated)'
      : slice;
  } catch {
    return '';
  }
}

function buildPrompt(
  question: string,
  full: Array<{ node: Node; summary?: string; body: string }>,
  list: Array<{ node: Node; summary?: string }>
): string {
  const parts: string[] = [
    'You are a senior engineer helping a teammate understand an unfamiliar codebase.',
    'Answer the question below using only the symbols provided. Cite specific symbol',
    'names and file paths in your answer (e.g. "see `FileWatcher.start` in src/sync/watcher.ts").',
    'If the provided context is insufficient, say so plainly — do not invent details.',
    '',
    `Question: ${question}`,
    '',
    '## Most relevant symbols (full bodies)',
    '',
  ];
  for (const { node, summary, body } of full) {
    parts.push(`### ${node.name} (${node.kind}) — ${node.filePath}:${node.startLine}`);
    if (summary) parts.push(`*Summary*: ${summary}`);
    if (node.signature) parts.push(`*Signature*: \`${node.signature}\``);
    parts.push('```' + (node.language || ''));
    parts.push(body);
    parts.push('```');
    parts.push('');
  }
  if (list.length > 0) {
    parts.push('## Other relevant symbols (names + summaries only)');
    parts.push('');
    for (const { node, summary } of list) {
      parts.push(
        `- **${node.name}** (${node.kind}) — ${node.filePath}:${node.startLine}` +
          (summary ? ` — ${summary}` : '')
      );
    }
    parts.push('');
  }
  parts.push('## Answer');
  return parts.join('\n');
}

/**
 * Run a one-shot Q&A pass. Caller is responsible for supplying the
 * pre-retrieved candidates (so the same code path serves the MCP tool,
 * the CLI, and any direct-API caller without each having to know about
 * the embedding model).
 */
export async function askWithCandidates(
  projectRoot: string,
  question: string,
  candidates: SearchResult[],
  queries: QueryBuilder,
  client: LlmClient,
  chatModel: string,
  options: AskOptions = {}
): Promise<AskResult> {
  const tRetrieve = Date.now();
  const ids = candidates.map((c) => c.node.id);
  const summaryMap = queries.getSymbolSummaries(ids);

  // Top MAX_FULL_BODIES → include verbatim. The rest → name + summary line.
  const enriched = candidates.map((c) => ({
    node: c.node,
    summary: summaryMap.get(c.node.id),
  }));
  const fullSlice = enriched.slice(0, MAX_FULL_BODIES);
  const listSlice = enriched.slice(MAX_FULL_BODIES);

  const full = fullSlice.map((e) => ({
    ...e,
    body: readBodySafe(projectRoot, e.node),
  }));
  const retrieveMs = Date.now() - tRetrieve;

  const prompt = buildPrompt(question, full, listSlice);
  logDebug('ask: prompt size', { chars: prompt.length });

  const tChat = Date.now();
  const result = await client.chat(
    [{ role: 'user', content: prompt }],
    {
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 800,
    }
  );
  const chatMs = Date.now() - tChat;

  void chatModel; // model id is set on the client; here for future telemetry

  return {
    answer: result.text.trim(),
    citations: enriched,
    chatMs,
    retrieveMs,
  };
}
