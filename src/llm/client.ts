/**
 * LLM HTTP Client
 *
 * Thin wrapper around an OpenAI-compatible HTTP endpoint. Works against
 * any local server that speaks the spec — Ollama, llama.cpp's
 * llama-server, LM Studio, vLLM, mistral.rs — and against the actual
 * OpenAI / Anthropic-OpenAI-compat APIs too.
 *
 * Pure HTTP via global `fetch`. No SDK dependencies. The model itself
 * runs in a separate process, so codegraph never touches WASM or ONNX —
 * the V8 turboshaft Zone OOM that motivated the original embeddings
 * removal in #87 cannot recur by construction.
 */

export interface LlmEndpointConfig {
  /** Base URL, e.g. http://localhost:11434/v1 (Ollama) or https://api.openai.com/v1 */
  endpoint: string;
  /** Model id used for chat completions. */
  chatModel?: string;
  /** Model id used for embeddings. */
  embeddingModel?: string;
  /** Optional bearer token; most local servers leave this empty. */
  apiKey?: string;
  /** Per-request timeout in ms. Defaults to 60s — generous for local CPU. */
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Sampling temperature; 0 for deterministic single-line outputs. */
  temperature?: number;
  /** Cap output tokens. Tight default since most callers want short replies. */
  maxTokens?: number;
}

export interface ChatResult {
  text: string;
  /** Round-trip wall time in ms (includes network + inference). */
  durationMs: number;
  /** Raw token counts the server reported, when available. */
  promptTokens?: number;
  completionTokens?: number;
}

export class LlmEndpointError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'LlmEndpointError';
  }
}

/**
 * OpenAI-compatible HTTP client. Stateless; cheap to construct.
 */
export class LlmClient {
  private readonly endpoint: string;
  private readonly chatModel: string | undefined;
  private readonly embeddingModel: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: LlmEndpointConfig) {
    // Normalise: drop trailing slash so we can do `${endpoint}/chat/completions`.
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.chatModel = config.chatModel;
    this.embeddingModel = config.embeddingModel;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /**
   * One-shot chat completion. Returns the assistant's text and metadata.
   * Throws {@link LlmEndpointError} on non-2xx response or network failure.
   */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    if (!this.chatModel) {
      throw new LlmEndpointError('chatModel not configured');
    }
    const t0 = Date.now();
    const body = {
      model: this.chatModel,
      messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 256,
      stream: false,
    };
    const data = await this.post('/chat/completions', body);
    const text = data?.choices?.[0]?.message?.content ?? '';
    return {
      text: typeof text === 'string' ? text : String(text),
      durationMs: Date.now() - t0,
      promptTokens: data?.usage?.prompt_tokens,
      completionTokens: data?.usage?.completion_tokens,
    };
  }

  /**
   * Embed one or more strings. Returns one Float32Array per input,
   * already L2-normalised so callers can use a plain dot product as
   * cosine similarity.
   */
  async embed(inputs: string[]): Promise<Float32Array[]> {
    if (!this.embeddingModel) {
      throw new LlmEndpointError('embeddingModel not configured');
    }
    if (inputs.length === 0) return [];
    const data = await this.post('/embeddings', {
      model: this.embeddingModel,
      input: inputs,
    });
    if (!Array.isArray(data?.data)) {
      throw new LlmEndpointError('embeddings response missing data[]');
    }
    return data.data.map((d: { embedding: number[] }) => {
      const v = Float32Array.from(d.embedding);
      // L2 normalise in-place so cosine == dot product downstream.
      let s = 0;
      for (let i = 0; i < v.length; i++) {
        const x = v[i]!;
        s += x * x;
      }
      const norm = Math.sqrt(s) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }

  /**
   * Cheap liveness probe — does the endpoint respond? Used to gracefully
   * skip LLM-dependent features when the server isn't running, rather
   * than failing the whole indexAll.
   */
  async isReachable(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.endpoint}/models`, { method: 'GET' });
      return res.ok || res.status === 401; // 401 = endpoint exists but needs auth
    } catch {
      return false;
    }
  }

  /**
   * List model ids the endpoint advertises. Returns `[]` if the endpoint
   * doesn't expose `/models` or returns a malformed payload — callers
   * treat that as "no usable model" rather than throwing.
   */
  async listModels(): Promise<string[]> {
    try {
      const res = await this.fetchWithTimeout(`${this.endpoint}/models`, {
        method: 'GET',
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      if (!Array.isArray(data?.data)) return [];
      return data.data
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter((id) => id.length > 0);
    } catch {
      return [];
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.fetchWithTimeout(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmEndpointError(`POST ${path} → ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
    return res.json();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('aborted') || message.includes('AbortError')) {
        throw new LlmEndpointError(`request timed out after ${this.timeoutMs}ms`);
      }
      throw new LlmEndpointError(`network error: ${message}`);
    } finally {
      clearTimeout(t);
    }
  }
}
