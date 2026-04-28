/**
 * Tier 1 #3, Tier 2 #4/#5, Tier 3 #7/#8: directory summaries, role
 * classifier, change-intent, dead-code judge, naming drift.
 *
 * Same in-process fake-Ollama pattern as llm.test.ts. The fake's
 * chat handler returns deterministic JSON for the prompts that
 * expect it (classifier, dead-code, naming) so we can assert ordering
 * and parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { AddressInfo } from 'net';
import { CodeGraph } from '../src';

interface FakeServer {
  url: string;
  chatCalls: number;
  /** Lets a test override the next chat response. */
  nextChatText: string | null;
  close: () => Promise<void>;
}

async function startFake(): Promise<FakeServer> {
  const state: { chatCalls: number; nextChatText: string | null } = {
    chatCalls: 0,
    nextChatText: null,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/models') || req.url === '/models') {
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }] }));
        return;
      }
      if (req.url?.endsWith('/chat/completions')) {
        state.chatCalls++;
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        const userText = parsed.messages?.[0]?.content || '';
        let text: string;
        if (state.nextChatText !== null) {
          text = state.nextChatText;
          state.nextChatText = null;
        } else if (userText.includes('Reply with EXACTLY one JSON object')) {
          // Could be classifier-style or judge-style; default to a
          // benign verdict object that satisfies dead-code parsing.
          if (userText.includes('"verdict"')) {
            text = '{"verdict": "uncertain", "confidence": 0.5, "reason": "test stub"}';
          } else if (userText.includes('"consistent"')) {
            text = '{"consistent": true, "suggestion": "", "reason": "test stub"}';
          } else {
            text = 'unknown';
          }
        } else if (userText.includes('Classify the following code symbol')) {
          text = 'business_logic';
        } else if (userText.includes('Module summary:')) {
          text = 'Coordinates a small module that does test things.';
        } else {
          text = 'Test stub summary line.';
        }
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: text } }],
          })
        );
        return;
      }
      if (req.url?.endsWith('/embeddings')) {
        const parsed = JSON.parse(body) as { input: string[] };
        const fake = (s: string): number[] => {
          const v = new Array(8).fill(0);
          for (let i = 0; i < s.length; i++) v[i % 8] += s.charCodeAt(i) % 11;
          return v;
        };
        res.end(
          JSON.stringify({ data: parsed.input.map((s) => ({ embedding: fake(s) })) })
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
    set nextChatText(v: string | null) {
      state.nextChatText = v;
    },
    get nextChatText() {
      return state.nextChatText;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe('Tier extensions', () => {
  let tempDir: string;
  let fake: FakeServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tiers-'));
    fake = await startFake();
    // Two files in two different dirs to give the directory summarizer
    // and naming-drift checker enough siblings to be meaningful.
    fs.mkdirSync(path.join(tempDir, 'src', 'auth'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'util'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'auth', 'token.ts'),
      `export function createToken(user: string): string {
  const payload = { user };
  const sig = 'fake';
  return JSON.stringify(payload) + sig;
}

export function verifyToken(token: string): boolean {
  const valid = token.length > 0;
  const checked = true;
  return valid && checked;
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
      path.join(tempDir, 'src', 'util', 'helpers.ts'),
      `export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth();
  return y + '-' + m;
}

export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
`
    );
  });

  afterEach(async () => {
    await fake.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('directory summary text round-trips correctly (column-order regression)', async () => {
    // The fake server returns "Coordinates a small module..." for the
    // dir-summarizer prompt. If the SQL bind order is wrong we'd see a
    // hex content_hash come back instead of that paragraph.
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      const all = cg.getAllDirectorySummaries();
      expect(all.length).toBeGreaterThan(0);
      for (const { summary } of all) {
        // Summaries must be prose, not 32-char hex (which would be
        // a content_hash bleeding into the wrong column).
        expect(summary).not.toMatch(/^[0-9a-f]{32}$/);
        expect(summary.length).toBeGreaterThan(20);
      }
    } finally {
      cg.close();
    }
  });

  it('background pass writes directory summaries and role labels', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: {
          endpoint: fake.url,
          chatModel: 'qwen2.5-coder:7b',
          embeddingModel: 'fake-embed',
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      // Directory summaries: at least one of the two source dirs
      // should have one (3+ symbol threshold).
      const dirs = cg.getAllDirectorySummaries();
      expect(dirs.length).toBeGreaterThan(0);

      // Role classification: every summarised symbol should have a
      // role assigned (classifier returns "business_logic" for our
      // fake responses).
      const counts = cg.getRoleCounts();
      expect([...counts.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

      // findNodesByRole returns the matching nodes
      const businessLogic = cg.findNodesByRole('business_logic', 100);
      expect(businessLogic.length).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('summarizeChange honors before-only and after-only modes', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: { llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' } },
    });
    try {
      const added = await cg.summarizeChange(
        'newFn',
        'function',
        '',
        'function newFn() { return 1; }'
      );
      expect(added.intent.length).toBeGreaterThan(0);

      const removed = await cg.summarizeChange(
        'oldFn',
        'function',
        'function oldFn() { return 1; }',
        ''
      );
      expect(removed.intent.length).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('findDeadCodeCandidates returns parsed verdicts', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: { llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' } },
    });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.findDeadCodeCandidates({ maxCandidates: 5 });
      // Real assertions: judged ≤ candidates, no errors on the fake
      // server, and every verdict carries a parsed confidence in
      // [0, 1] from one of the three known labels.
      expect(result.candidates).toBeGreaterThanOrEqual(result.judged);
      expect(result.errors).toBe(0);
      for (const r of result.results) {
        expect(['dead', 'live', 'uncertain']).toContain(r.verdict);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    } finally {
      cg.close();
    }
  });

  it('parseRole accepts canonical, fenced, multi-word, and trailing-punct inputs', async () => {
    const { parseRole } = await import('../src/llm/classifier');
    // Canonical
    expect(parseRole('business_logic')).toBe('business_logic');
    // Trailing punctuation
    expect(parseRole('business_logic.')).toBe('business_logic');
    // Fenced + quotes
    expect(parseRole('`business_logic`')).toBe('business_logic');
    // Title-cased multi-word — the case the reviewer flagged.
    expect(parseRole('Business Logic')).toBe('business_logic');
    expect(parseRole('Api Endpoint')).toBe('api_endpoint');
    // Garbage falls through to "unknown" (advisory degrade).
    expect(parseRole('I think this is a util maybe')).toBe('unknown');
  });

  it('agent bridge: pendingSummariesBatch + saveAgentSummaries round-trip without LLM', async () => {
    // No config.llm — exercises the path users without Ollama would take.
    const cg = await CodeGraph.init(tempDir);
    try {
      await cg.indexAll({ summarize: false });

      const batch = cg.pendingSummariesBatch({ limit: 5, modelHint: 'claude-test' });
      expect(batch.items.length).toBeGreaterThan(0);
      expect(batch.total).toBeGreaterThanOrEqual(batch.items.length);
      // Each item should have a non-empty body and a content_hash.
      for (const it of batch.items) {
        expect(it.body.length).toBeGreaterThan(0);
        expect(it.contentHash.length).toBe(32);
      }

      // Pretend the agent answered each one with a fake summary.
      const saved = cg.saveAgentSummaries(
        batch.items.map((it) => ({
          nodeId: it.nodeId,
          contentHash: it.contentHash,
          summary: `Agent-summarised ${it.name}`,
        })),
        'claude-test'
      );
      expect(saved.saved).toBe(batch.items.length);
      expect(saved.skipped).toBe(0);

      // Coverage now reflects the writes.
      const cov = cg.getSummaryCoverage();
      expect(cov.summarised).toBeGreaterThanOrEqual(batch.items.length);

      // Re-issuing the batch with the same modelHint should NOT return
      // the same items again (cache short-circuit).
      const batch2 = cg.pendingSummariesBatch({ limit: 5, modelHint: 'claude-test' });
      const overlap = batch2.items.filter((b) =>
        batch.items.some((a) => a.nodeId === b.nodeId)
      );
      expect(overlap.length).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('agent bridge: stale content_hash is rejected with a clear error', async () => {
    const cg = await CodeGraph.init(tempDir);
    try {
      await cg.indexAll({ summarize: false });
      const batch = cg.pendingSummariesBatch({ limit: 1 });
      const item = batch.items[0]!;
      const result = cg.saveAgentSummaries(
        [
          {
            nodeId: item.nodeId,
            contentHash: 'cccccccccccccccccccccccccccccccc', // stale
            summary: 'wrong cache key',
          },
        ],
        'claude-test'
      );
      expect(result.saved).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]).toMatch(/content_hash drifted/);
    } finally {
      cg.close();
    }
  });

  it('checkNamingDrift returns advisory consistent/suggestion shape', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: { llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' } },
    });
    try {
      await cg.indexAll({ summarize: false });
      // Override response so we can assert parsing of an inconsistent verdict
      fake.nextChatText =
        '{"consistent": false, "suggestion": "createSession", "reason": "siblings use create* prefix"}';

      const verdict = await cg.checkNamingDrift({
        name: 'makeSession',
        kind: 'function',
        filePath: 'src/auth/new.ts',
      });
      expect(verdict.consistent).toBe(false);
      expect(verdict.suggestion).toBe('createSession');
    } finally {
      cg.close();
    }
  });
});
