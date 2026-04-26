/**
 * Agent-as-LLM bridge.
 *
 * When no local LLM is available, the agent currently in the user's
 * session (Claude via Claude Code, or any MCP-speaking agent) can
 * fill the summary cache directly. Two MCP tools form the contract:
 *
 *   1. codegraph_pending_summaries  → returns a batch of un-summarised
 *      symbols with bodies + content_hash for the agent to summarise.
 *
 *   2. codegraph_save_summaries     → takes the agent's results and
 *      persists them with the same content_hash invalidation as the
 *      local-LLM path.
 *
 * No HTTP, no embedding model required, no install friction. The
 * agent's tokens replace the local model. Quality is typically
 * higher (Claude vs. a 32B local model) at the cost of agent budget.
 *
 * Same SUMMARIZABLE_KINDS / MIN_BODY_LINES filters as the local pass
 * so both paths produce comparable cache entries.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { Node } from '../types';
import { QueryBuilder } from '../db/queries';
import { validatePathWithinRoot } from '../utils';
import { SUMMARIZABLE_KINDS } from './summarizer';

/** Same threshold the local-LLM summariser uses. */
const MIN_BODY_LINES = 3;
const MAX_BODY_CHARS = 4000;

export interface PendingSummaryItem {
  nodeId: string;
  name: string;
  kind: string;
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  body: string;
  contentHash: string;
}

export interface PendingBatch {
  items: PendingSummaryItem[];
  /** How many additional candidates remain after this batch. */
  remaining: number;
  /** Total summarisable candidates (stable per index state). */
  total: number;
  /** Echo back to MCP callers so they know what label to save under. */
  modelHint: string;
}

export interface SaveSummaryItem {
  nodeId: string;
  contentHash: string;
  summary: string;
}

export interface SaveResult {
  saved: number;
  skipped: number;
  errors: string[];
}

/** Compute the same content_hash the local summariser uses, so the
 *  cache key is interchangeable between paths. */
export function contentHashFor(sym: Pick<Node, 'signature'>, body: string): string {
  const h = crypto.createHash('sha256');
  h.update(sym.signature ?? '');
  h.update('\0');
  h.update(body);
  return h.digest('hex').slice(0, 32);
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

/**
 * Pull the next batch of un-summarised symbols. Returns bodies inline
 * so the agent has everything it needs in one MCP round-trip.
 *
 * `modelHint` defaults to "agent-mcp" — callers can override (e.g. the
 * actual model id of the calling agent) to keep cache provenance
 * accurate.
 */
export function pendingSummariesBatch(
  projectRoot: string,
  queries: QueryBuilder,
  options: { limit?: number; kinds?: ReadonlySet<string>; modelHint?: string } = {}
): PendingBatch {
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const kinds = options.kinds ?? SUMMARIZABLE_KINDS;
  const modelHint = options.modelHint ?? 'agent-mcp';

  // Reuse the same docstring threshold the local pass uses for parity.
  const candidates = queries.getSummarizableNodes(kinds, MIN_BODY_LINES, 30);
  const total = candidates.length;
  const items: PendingSummaryItem[] = [];

  for (const node of candidates) {
    if (items.length >= limit) break;
    const body = readBodySafe(projectRoot, node);
    if (!body) continue; // Skip files we can't read; they're surfaced
    // again on the next call once readable.
    const hash = contentHashFor(node, body);

    // Don't ship a candidate whose content_hash already matches a
    // cached summary from THIS model (effectively a cache hit) —
    // that would waste agent tokens.
    const existing = queries.getSymbolSummary(node.id);
    if (existing && existing.contentHash === hash && existing.model === modelHint) continue;

    items.push({
      nodeId: node.id,
      name: node.name,
      kind: node.kind,
      language: node.language,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      signature: node.signature ?? null,
      body,
      contentHash: hash,
    });
  }

  return {
    items,
    remaining: Math.max(0, total - items.length),
    total,
    modelHint,
  };
}

/**
 * Persist a batch of agent-generated summaries. Idempotent: a stale
 * content_hash is silently skipped (with a logged reason in `errors`)
 * because by the time the agent answered, the symbol body may have
 * changed under it.
 */
export function saveAgentSummaries(
  projectRoot: string,
  queries: QueryBuilder,
  items: ReadonlyArray<SaveSummaryItem>,
  modelLabel: string
): SaveResult {
  let saved = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of items) {
    const node = queries.getNodeById(item.nodeId);
    if (!node) {
      skipped++;
      errors.push(`${item.nodeId}: node no longer exists`);
      continue;
    }
    // Re-derive the hash from current disk content; if it doesn't
    // match what the agent saw, the body changed under them.
    const body = readBodySafe(projectRoot, node);
    if (!body) {
      skipped++;
      errors.push(`${item.nodeId}: body unreadable`);
      continue;
    }
    const currentHash = contentHashFor(node, body);
    if (currentHash !== item.contentHash) {
      skipped++;
      errors.push(`${item.nodeId}: content_hash drifted (${item.contentHash} → ${currentHash})`);
      continue;
    }
    const trimmed = item.summary.trim().split('\n')[0]?.trim() ?? '';
    if (!trimmed) {
      skipped++;
      errors.push(`${item.nodeId}: empty summary`);
      continue;
    }
    queries.upsertSymbolSummary(item.nodeId, currentHash, trimmed.slice(0, 200), modelLabel);
    saved++;
  }

  return { saved, skipped, errors };
}
