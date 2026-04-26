/**
 * Directory-level summaries.
 *
 * Aggregates symbol-level summaries (PR #111) within a directory into
 * one paragraph that answers "what does this module do?". Lets the AI
 * assistant get module-level context in a single MCP call instead of
 * crawling all the symbols.
 *
 * Granularity: directory containing source files. We skip the project
 * root and skip dirs whose only contents are subdirectories — the
 * unit of meaning is the leaf module.
 *
 * Prompt-injection note: the synthesis prompt embeds LLM-generated
 * symbol summaries verbatim. A malicious repo whose source bodies
 * coerced an "ignore previous instructions" line into a summary
 * could corrupt the directory paragraph. Accepted risk: all data
 * here originates from the user's own codebase. Don't forward
 * directory_summaries text to untrusted external systems without
 * sanitisation.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { LlmClient, LlmEndpointError } from './client';
import { QueryBuilder } from '../db/queries';
import { logDebug, logWarn } from '../errors';

/** Min number of summarised symbols before a dir is worth a paragraph. */
const MIN_SYMBOLS_PER_DIR = 3;

/** Cap how many symbol summaries we feed per dir prompt — beyond ~30
 *  the marginal signal flattens and the prompt grows linearly. */
const MAX_SYMBOLS_IN_PROMPT = 30;

/** Output cap for the synth call. Tight: this is meant to be skimmed. */
const MAX_SUMMARY_CHARS = 600;

const DEFAULT_CONCURRENCY = 1; // Synthesis is large per call; serial is fine.

export interface DirSummarizerOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface DirSummarizerResult {
  candidates: number;
  generated: number;
  cacheHits: number;
  errors: number;
  durationMs: number;
}

interface DirGroup {
  dir: string;
  items: Array<{ name: string; kind: string; summary: string }>;
}

/**
 * Group symbol summaries by directory. Source of truth is the
 * symbol_summaries table; we don't summarise dirs whose symbols
 * haven't been summarised yet.
 */
function groupByDir(
  rows: ReadonlyArray<{ filePath: string; name: string; kind: string; summary: string }>
): DirGroup[] {
  const groups = new Map<string, DirGroup>();
  for (const row of rows) {
    const dir = path.posix.dirname(row.filePath.replace(/\\/g, '/'));
    if (dir === '.' || dir === '') continue;
    let g = groups.get(dir);
    if (!g) {
      g = { dir, items: [] };
      groups.set(dir, g);
    }
    g.items.push({ name: row.name, kind: row.kind, summary: row.summary });
  }
  // Drop dirs with too few symbols to be worth a paragraph.
  return [...groups.values()].filter((g) => g.items.length >= MIN_SYMBOLS_PER_DIR);
}

/** Stable hash so re-running is a cache hit when nothing changed. */
function hashDirContent(group: DirGroup): string {
  const h = crypto.createHash('sha256');
  // Sorted to be order-stable across DB row order
  const items = [...group.items].sort((a, b) =>
    `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)
  );
  for (const it of items) {
    h.update(it.kind);
    h.update('\0');
    h.update(it.name);
    h.update('\0');
    h.update(it.summary);
    h.update('\n');
  }
  return h.digest('hex').slice(0, 32);
}

function buildPrompt(group: DirGroup): string {
  const lines: string[] = [
    `You are documenting the module \`${group.dir}\` of an unfamiliar codebase.`,
    '',
    `Below are one-line descriptions of every meaningful symbol in this directory.`,
    `Write a SHORT paragraph (max ${MAX_SUMMARY_CHARS} chars) describing what this`,
    `module does as a whole — its responsibility, the main types/functions it`,
    `exposes, and how a caller would use it. No bullet lists. No headers. Just`,
    `prose.`,
    '',
    '## Symbols in this module',
  ];
  const items = group.items.slice(0, MAX_SYMBOLS_IN_PROMPT);
  for (const it of items) {
    lines.push(`- ${it.name} (${it.kind}): ${it.summary}`);
  }
  if (group.items.length > items.length) {
    lines.push(`- ... and ${group.items.length - items.length} more`);
  }
  lines.push('');
  lines.push('Module summary:');
  return lines.join('\n');
}

/**
 * Run a full directory-summarisation pass. Cheap: only directories
 * whose content_hash differs from the cached one regenerate.
 */
export async function summarizeAllDirectories(
  queries: QueryBuilder,
  client: LlmClient,
  modelLabel: string,
  options: DirSummarizerOptions = {}
): Promise<DirSummarizerResult> {
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const summarisedSymbols = queries.getSummarisedSymbolsByDir();
  const groups = groupByDir(summarisedSymbols);
  const total = groups.length;
  let done = 0;
  let generated = 0;
  let cacheHits = 0;
  let errors = 0;

  let next = 0;
  async function worker(): Promise<void> {
    while (next < groups.length) {
      if (options.signal?.aborted) return;
      const i = next++;
      const group = groups[i]!;
      try {
        const hash = hashDirContent(group);
        const existing = queries.getDirectorySummary(group.dir);
        if (existing && existing.contentHash === hash && existing.model === modelLabel) {
          // Cache hit: bookkeeping happens in the `finally` below — do
          // NOT double-increment `done` here. (The `finally` runs even
          // on `continue`.)
          cacheHits++;
          continue;
        }

        const result = await client.chat(
          [{ role: 'user', content: buildPrompt(group) }],
          { temperature: 0.2, maxTokens: 220 }
        );
        // Honor abort signals between the chat call and the DB write
        // so a close()-cancelled run doesn't persist a stale entry.
        if (options.signal?.aborted) return;
        let summary = result.text.trim();
        if (summary.length === 0) {
          errors++;
        } else {
          if (summary.length > MAX_SUMMARY_CHARS) {
            summary = summary.slice(0, MAX_SUMMARY_CHARS - 1) + '…';
          }
          queries.upsertDirectorySummary(group.dir, hash, summary, modelLabel);
          generated++;
        }
      } catch (err) {
        errors++;
        if (err instanceof LlmEndpointError) {
          logDebug('DirSummarizer: endpoint error', { dir: group.dir, error: err.message });
        } else {
          logWarn('DirSummarizer: unexpected error', { dir: group.dir, error: String(err) });
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
