/**
 * LLM auto-detect + background summarisation tests
 *
 * Spins up a tiny in-process HTTP server that mimics the OpenAI-compat
 * surface Ollama exposes. Covers:
 *  - detectLocalLlm picks a chat model from /v1/models
 *  - LlmClient.isReachable / listModels round-trip
 *  - summarizeAll content_hash cache: re-running is a pure cache hit
 *  - CodeGraph.startBackgroundSummarization is fire-and-forget
 *  - cancellation via AbortController on close()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { AddressInfo } from 'net';
import { CodeGraph } from '../src';
import { LlmClient } from '../src/llm/client';
import { detectLocalLlm } from '../src/llm/detect';

interface FakeServerOptions {
  models?: string[];
  /** Delay before responding to /chat/completions, ms. */
  chatDelayMs?: number;
  /** Optional override for the chat completion text. */
  chatText?: string;
}

interface FakeServer {
  url: string;
  chatCalls: number;
  modelsCalls: number;
  close: () => Promise<void>;
}

async function startFakeOllama(options: FakeServerOptions = {}): Promise<FakeServer> {
  const models = options.models ?? ['qwen2.5-coder:7b'];
  const state = { chatCalls: 0, modelsCalls: 0 };

  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models' || req.url === '/models') {
      state.modelsCalls++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      state.chatCalls++;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        if (options.chatDelayMs) {
          await new Promise((r) => setTimeout(r, options.chatDelayMs));
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: options.chatText ?? 'Computes a thing and returns it',
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          })
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/v1`;

  return {
    url,
    get chatCalls() {
      return state.chatCalls;
    },
    get modelsCalls() {
      return state.modelsCalls;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('LlmClient', () => {
  it('isReachable returns true when /v1/models responds', async () => {
    const fake = await startFakeOllama();
    try {
      const client = new LlmClient({ endpoint: fake.url });
      expect(await client.isReachable()).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('isReachable returns false when nothing listens', async () => {
    // Pick an unused port deterministically by opening + immediately closing
    // a server. Race-free enough for a single test.
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const client = new LlmClient({
      endpoint: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 200,
    });
    expect(await client.isReachable()).toBe(false);
  });

  it('listModels returns ids from /v1/models', async () => {
    const fake = await startFakeOllama({ models: ['qwen2.5:7b', 'gemma3:4b', 'nomic-embed-text'] });
    try {
      const client = new LlmClient({ endpoint: fake.url });
      const ids = await client.listModels();
      expect(ids).toEqual(['qwen2.5:7b', 'gemma3:4b', 'nomic-embed-text']);
    } finally {
      await fake.close();
    }
  });
});

describe('detectLocalLlm', () => {
  it('picks a preferred chat model and skips embedding-only ids', async () => {
    const fake = await startFakeOllama({
      models: ['nomic-embed-text', 'gemma3:4b', 'qwen2.5-coder:7b'],
    });
    try {
      const detected = await detectLocalLlm(fake.url);
      expect(detected).not.toBeNull();
      expect(detected?.chatModel).toBe('qwen2.5-coder:7b');
      expect(detected?.embeddingModel).toBe('nomic-embed-text');
    } finally {
      await fake.close();
    }
  });

  it('falls back to first non-embedding model when none preferred', async () => {
    const fake = await startFakeOllama({
      models: ['custom-finetune:13b', 'bge-m3'],
    });
    try {
      const detected = await detectLocalLlm(fake.url);
      expect(detected?.chatModel).toBe('custom-finetune:13b');
    } finally {
      await fake.close();
    }
  });

  it('returns null when endpoint is unreachable', async () => {
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const detected = await detectLocalLlm(`http://127.0.0.1:${port}/v1`, 200);
    expect(detected).toBeNull();
  });
});

describe('CodeGraph background summarisation', () => {
  let tempDir: string;
  let fake: FakeServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-llm-'));
    fake = await startFakeOllama();
    // Drop one TS file so indexAll has something summarisable
    fs.writeFileSync(
      path.join(tempDir, 'sample.ts'),
      `export function greet(name: string): string {
  const greeting = 'Hello';
  const punctuation = '!';
  return \`\${greeting}, \${name}\${punctuation}\`;
}

export class Counter {
  private value: number = 0;
  increment(): number {
    this.value += 1;
    return this.value;
  }
  reset(): void {
    this.value = 0;
  }
}
`
    );
  });

  afterEach(async () => {
    await fake.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('startBackgroundSummarization populates the cache when an LLM is configured', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    try {
      // indexAll fires summarisation in the background
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      const cov = cg.getSummaryCoverage();
      expect(cov.total).toBeGreaterThan(0);
      expect(cov.summarised).toBeGreaterThan(0);
      expect(fake.chatCalls).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('re-running is a pure cache hit (no LLM calls)', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();
      const callsAfterFirstPass = fake.chatCalls;
      expect(callsAfterFirstPass).toBeGreaterThan(0);

      // Run it again — every symbol should hit the cache.
      const result = await cg.summarizeAll();
      expect(result.cacheHits).toBe(result.candidates);
      expect(result.generated).toBe(0);
      expect(fake.chatCalls).toBe(callsAfterFirstPass);
    } finally {
      cg.close();
    }
  });

  it('hasLlm + getEffectiveLlmConfig reflect explicit config', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    try {
      expect(cg.hasLlm()).toBe(true);
      const eff = await cg.getEffectiveLlmConfig();
      expect(eff?.endpoint).toBe(fake.url);
      expect(eff?.chatModel).toBe('qwen2.5-coder:7b');
    } finally {
      cg.close();
    }
  });

  it('skips background pass silently when no LLM is reachable', async () => {
    // Point at a guaranteed-closed port so the test is hermetic (host
    // may or may not have Ollama on 11434). Reachability check fails
    // and the background pass returns early without making chat calls.
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));

    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: {
          endpoint: `http://127.0.0.1:${closedPort}/v1`,
          chatModel: 'qwen2.5-coder:7b',
          timeoutMs: 200,
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();
      const cov = cg.getSummaryCoverage();
      expect(cov.summarised).toBe(0);
      expect(cg.isSummarizing()).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('close() cancels in-flight background summarisation', async () => {
    // Slow chat replies so we can observe cancellation between calls.
    await fake.close();
    fake = await startFakeOllama({ chatDelayMs: 100 });

    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    await cg.indexAll();
    // Don't await: cancel mid-flight.
    expect(cg.isSummarizing()).toBe(true);
    cg.close();
    // close() aborts the controller; awaiting here would hang on the
    // last in-flight HTTP request, so we just verify the bookkeeping
    // is consistent.
    expect(cg.isSummarizing()).toBe(false);
  });

  it('re-queues a second pass when sync fires mid-pass (dirty flag)', async () => {
    // Slow chat replies so the bg pass is still running when we kick
    // off a second startBackgroundSummarization() call.
    await fake.close();
    fake = await startFakeOllama({ chatDelayMs: 30 });

    const cg = await CodeGraph.init(tempDir, {
      config: { llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' } },
    });
    try {
      await cg.indexAll();
      // First pass is mid-flight; this second call should set the
      // dirty flag and return the existing promise rather than
      // starting a parallel pass.
      const p1 = cg.startBackgroundSummarization();
      const p2 = cg.startBackgroundSummarization();
      expect(p1).toBe(p2);
      await p1;
      // After the first pass completes, the dirty flag triggers a
      // second pass — wait for it and ensure it ran clean (cache
      // hits, no errors).
      if (cg.isSummarizing()) {
        await cg.awaitBackgroundSummarization();
      }
      expect(cg.isSummarizing()).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('getSymbolSummaries returns map keyed by node id', async () => {
    const cg = await CodeGraph.init(tempDir, {
      config: {
        llm: { endpoint: fake.url, chatModel: 'qwen2.5-coder:7b' },
      },
    });
    try {
      await cg.indexAll();
      await cg.awaitBackgroundSummarization();

      const allNodes = cg.getStats();
      expect(allNodes.nodeCount).toBeGreaterThan(0);

      const ids = cg
        .searchNodes('greet', { limit: 5 })
        .map((r) => r.node.id);
      const summaries = cg.getSymbolSummaries(ids);
      // At least one summarised symbol came back.
      expect([...summaries.values()].some((s) => s.length > 0)).toBe(true);
    } finally {
      cg.close();
    }
  });
});
