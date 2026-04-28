/**
 * Local LLM auto-detection
 *
 * Probes the conventional Ollama endpoint to see if a usable chat model
 * is already running on the machine. When found, callers (CodeGraph)
 * synthesise an `LlmEndpointConfig` so summarisation can run with zero
 * configuration on machines where the user already has Ollama installed.
 *
 * Cheap and quiet: 500ms probe, no logging on absence — having no local
 * server is the common case and shouldn't add noise to the CLI.
 */

import { LlmClient, LlmEndpointConfig } from './client';

/** Default Ollama OpenAI-compat endpoint. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/v1';

/**
 * Models we'd rather pick first when several are available. Ordered by
 * "small enough to be background-friendly + decent at single-line
 * summaries". The list is intentionally short and non-authoritative —
 * if none of these match, we fall back to the first chat model the
 * server reports.
 */
const PREFERRED_CHAT_MODELS = [
  'qwen3:4b',
  'qwen2.5-coder:3b',
  'qwen2.5-coder:7b',
  'qwen2.5:3b',
  'qwen2.5:7b',
  'gemma3:4b',
  'gemma3:1b',
  'llama3.2:3b',
  'llama3.2:1b',
  'phi3.5',
];

/**
 * Embedding models we recognise so we can wire embedding calls without
 * extra config when a known one is already pulled.
 */
const KNOWN_EMBEDDING_MODELS = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'snowflake-arctic-embed',
];

/** Heuristics for ruling models out as chat targets. */
function isLikelyEmbedding(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('embed') ||
    lower.includes('bge') ||
    lower.includes('arctic-embed')
  );
}

function pickChatModel(available: string[]): string | undefined {
  // Prefer exact matches first, then any prefix (e.g. "qwen2.5-coder:7b-instruct-q4_K_M").
  for (const wanted of PREFERRED_CHAT_MODELS) {
    if (available.includes(wanted)) return wanted;
  }
  for (const wanted of PREFERRED_CHAT_MODELS) {
    const hit = available.find((id) => id.startsWith(wanted));
    if (hit) return hit;
  }
  // Fallback: first non-embedding model.
  return available.find((id) => !isLikelyEmbedding(id));
}

function pickEmbeddingModel(available: string[]): string | undefined {
  for (const wanted of KNOWN_EMBEDDING_MODELS) {
    const hit = available.find((id) => id === wanted || id.startsWith(wanted));
    if (hit) return hit;
  }
  // Last-ditch: anything that smells like an embedder.
  return available.find((id) => isLikelyEmbedding(id));
}

export interface DetectedLlm {
  endpoint: string;
  chatModel: string;
  embeddingModel?: string;
  /** All model ids the server reported; useful for status output. */
  availableModels: string[];
}

/**
 * Probe the default Ollama endpoint and return a config if a usable
 * chat model is available. Returns `null` when nothing is reachable or
 * no chat-capable model is installed.
 *
 * `endpoint` lets callers point detection at a non-default server (used
 * by tests and by users running on a non-standard port).
 */
export async function detectLocalLlm(
  endpoint: string = DEFAULT_OLLAMA_ENDPOINT,
  probeTimeoutMs: number = 500
): Promise<DetectedLlm | null> {
  const probe = new LlmClient({ endpoint, timeoutMs: probeTimeoutMs });
  const reachable = await probe.isReachable();
  if (!reachable) return null;

  const models = await probe.listModels();
  if (models.length === 0) return null;

  const chatModel = pickChatModel(models);
  if (!chatModel) return null;

  return {
    endpoint,
    chatModel,
    embeddingModel: pickEmbeddingModel(models),
    availableModels: models,
  };
}

/** Convert a {@link DetectedLlm} into the config shape the rest of the
 * codebase consumes. Defaults are tuned for background work — generous
 * timeout (LLMs on small CPUs can be slow) but no API key. */
export function detectionToConfig(detected: DetectedLlm): LlmEndpointConfig {
  return {
    endpoint: detected.endpoint,
    chatModel: detected.chatModel,
    embeddingModel: detected.embeddingModel,
    timeoutMs: 60_000,
  };
}
