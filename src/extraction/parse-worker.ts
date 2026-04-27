/**
 * Parse Worker
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 */

import { parentPort } from 'worker_threads';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, loadGrammarsForLanguages, resetParser } from './grammars';
import type { Language, ExtractionResult } from '../types';

const PARSER_RESET_INTERVAL = 5000;
const parseCounts = new Map<Language, number>();

parentPort!.on('message', async (msg: { type: string; id?: number; filePath?: string; content?: string; languages?: Language[] }) => {
  if (msg.type === 'load-grammars') {
    await loadGrammarsForLanguages(msg.languages!);
    parentPort!.postMessage({ type: 'grammars-loaded' });
  } else if (msg.type === 'parse') {
    const { id, filePath, content } = msg;
    try {
      const language = detectLanguage(filePath!, content);
      const result: ExtractionResult = extractFromSource(filePath!, content!, language);

      // Periodic parser reset to reclaim WASM heap memory
      const count = (parseCounts.get(language) ?? 0) + 1;
      parseCounts.set(language, count);
      if (count % PARSER_RESET_INTERVAL === 0) {
        resetParser(language);
      }

      parentPort!.postMessage({ type: 'parse-result', id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // WASM memory errors leave the module in a corrupted state — all
      // subsequent parses would also fail (cascading failures). Crash the
      // worker so the main thread spawns a fresh one with a clean heap.
      if (message.includes('memory access out of bounds') || message.includes('out of memory')) {
        process.exit(1);
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: `Parse worker error: ${message}`, filePath: filePath!, severity: 'error', code: 'parse_error' }],
          durationMs: 0,
        } satisfies ExtractionResult,
      });
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' });
  } else {
    // Unknown message types: when an `id` is present, surface a structured
    // error so the in-flight Promise on the main thread fails fast rather
    // than blocking until the per-file timeout. Messages without an `id`
    // have no pending promise to unblock and are silently ignored — no
    // harm done.
    const id = msg.id;
    if (typeof id === 'number') {
      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{
            message: `Parse worker received unknown message type: ${msg.type}`,
            severity: 'error',
            code: 'worker_protocol_error',
          }],
          durationMs: 0,
        } satisfies ExtractionResult,
      });
    }
  }
});
