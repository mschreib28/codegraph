/**
 * Grammar Loading and Caching
 *
 * Uses web-tree-sitter (WASM) for universal cross-platform support.
 * Grammars are loaded lazily — only languages actually present in the project
 * are compiled, keeping V8 WASM memory pressure low on large codebases.
 *
 * As of the language-registry refactor, all per-language metadata
 * (WASM filenames, file extensions, display names, vendored flag)
 * lives in `./languages/<name>.ts` and is auto-collected by
 * `./languages/registry.ts`. The constants exported here
 * (`EXTENSION_MAP`, `getSupportedLanguages`, `getLanguageDisplayName`)
 * remain for backward compat but are derived from the registry.
 */

import * as path from 'path';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { Language } from '../types';
import { getLanguageDefs, getLanguageDefByExtension, getLanguageDefByName } from './languages/registry';

export type GrammarLanguage = Exclude<Language, 'svelte' | 'liquid' | 'unknown'>;

/**
 * File extension → Language mapping, computed lazily on first read.
 *
 * Cannot be a top-level IIFE: the registry transitively pulls in
 * `tree-sitter.ts` (via custom-extractor language defs), which
 * imports this file — building the map at module load would TDZ
 * against `ALL_DEFS` in the registry. Use the `getExtensionMap()`
 * function for an explicit lazy entry point, or read
 * `EXTENSION_MAP` (a Proxy that materialises on first property
 * access).
 */
let _extensionMapCache: Record<string, Language> | null = null;
export function getExtensionMap(): Record<string, Language> {
  if (_extensionMapCache) return _extensionMapCache;
  const out: Record<string, Language> = {};
  for (const def of getLanguageDefs()) {
    for (const ext of def.extensions) {
      out[ext.toLowerCase()] = def.name as Language;
    }
  }
  _extensionMapCache = out;
  return out;
}

/**
 * Backward-compat: a Proxy that lazy-builds the extension map on
 * first property access. Existing callers can keep doing
 * `EXTENSION_MAP['.ts']` without changes.
 */
export const EXTENSION_MAP: Record<string, Language> = new Proxy({} as Record<string, Language>, {
  get(_t, key: string) { return getExtensionMap()[key]; },
  has(_t, key: string) { return key in getExtensionMap(); },
  ownKeys() { return Object.keys(getExtensionMap()); },
  getOwnPropertyDescriptor(_t, key: string) {
    const map = getExtensionMap();
    if (key in map) {
      return { configurable: true, enumerable: true, writable: false, value: map[key] };
    }
    return undefined;
  },
});

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

let parserInitialized = false;

/**
 * Initialize the tree-sitter WASM runtime. Must be called before loading grammars.
 * Does NOT load any grammar WASM files — use loadGrammarsForLanguages() for that.
 * Idempotent — safe to call multiple times.
 */
export async function initGrammars(): Promise<void> {
  if (parserInitialized) return;

  await Parser.init();

  parserInitialized = true;
}

/**
 * Load grammar WASM files for specific languages only.
 * Skips languages that are already loaded or have no WASM grammar.
 * Must be called after initGrammars().
 */
export async function loadGrammarsForLanguages(languages: Language[]): Promise<void> {
  if (!parserInitialized) {
    await initGrammars();
  }

  // Deduplicate; filter to languages that have a tree-sitter grammar
  // (registry's `def.grammar` field) and aren't already loaded.
  const seen = new Set<Language>();
  const toLoad: Array<{ lang: Language; wasmFile: string; vendored: boolean }> = [];
  for (const lang of languages) {
    if (seen.has(lang)) continue;
    seen.add(lang);
    if (languageCache.has(lang) || unavailableGrammarErrors.has(lang)) continue;
    const def = getLanguageDefByName(lang);
    if (!def?.grammar) continue;
    toLoad.push({
      lang,
      wasmFile: def.grammar.wasmFile,
      vendored: def.grammar.vendored === true,
    });
  }

  // Load grammars sequentially to avoid web-tree-sitter WASM race condition on Node 20+
  // See: https://github.com/tree-sitter/tree-sitter/issues/2338
  for (const { lang, wasmFile, vendored } of toLoad) {
    try {
      const wasmPath = vendored
        ? path.join(__dirname, 'wasm', wasmFile)
        : require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
      const language = await WasmLanguage.load(wasmPath);
      languageCache.set(lang, language);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodeGraph] Failed to load ${lang} grammar — parsing will be unavailable: ${message}`);
      unavailableGrammarErrors.set(lang, message);
    }
  }
}

/**
 * Load ALL grammar WASM files. Convenience function for tests and
 * backward compatibility. Prefer loadGrammarsForLanguages() in production.
 */
export async function loadAllGrammars(): Promise<void> {
  const allLanguages = getLanguageDefs()
    .filter((d) => d.grammar)
    .map((d) => d.name as Language);
  await loadGrammarsForLanguages(allLanguages);
}

/**
 * Check if grammars have been initialized
 */
export function isGrammarsInitialized(): boolean {
  return parserInitialized;
}

/**
 * Get a parser for the specified language.
 * Returns synchronously from pre-loaded cache.
 */
export function getParser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  const lang = languageCache.get(language);
  if (!lang) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string, source?: string): Language {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const def = getLanguageDefByExtension(ext);
  const lang = (def?.name as Language) ?? 'unknown';

  // .h files could be C or C++ — check source content for C++ features
  if (lang === 'c' && ext === '.h' && source) {
    if (looksLikeCpp(source)) return 'cpp';
  }

  return lang;
}

/**
 * Heuristic: does a .h file contain C++ constructs?
 * Checks the first ~8KB for patterns that are unique to C++ and never valid C.
 */
function looksLikeCpp(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /\bnamespace\b|\bclass\s+\w+\s*[:{]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=)/.test(sample);
}

/**
 * Check if a language is supported (has a grammar or custom extractor).
 * Returns true if a registry entry exists, even if its grammar isn't loaded.
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'unknown') return false;
  return getLanguageDefByName(language) !== undefined;
}

/**
 * Check if a grammar has been loaded and is ready for parsing.
 * Custom-extractor languages (no `grammar` field) are always "ready".
 */
export function isGrammarLoaded(language: Language): boolean {
  const def = getLanguageDefByName(language);
  if (!def) return false;
  if (!def.grammar) return true; // custom extractor — always available
  return languageCache.has(language);
}

/**
 * Get all supported languages from the registry.
 */
export function getSupportedLanguages(): Language[] {
  return getLanguageDefs().map((d) => d.name as Language);
}

/**
 * Reset the cached parser for a language to reclaim WASM heap memory.
 * The tree-sitter WASM runtime accumulates fragmented memory over thousands
 * of parses. Deleting and recreating the Parser instance forces the WASM
 * heap to reset, preventing "memory access out of bounds" crashes in
 * large repos.
 */
export function resetParser(language: Language): void {
  const old = parserCache.get(language);
  if (old) {
    old.delete();
    parserCache.delete(language);
  }
}

/**
 * Clear parser cache (useful for testing).
 *
 * Note: `languageCache` is intentionally NOT cleared — the WASM
 * `Language` modules are expensive to load and stay cached so a
 * subsequent `getParser` call can rebuild a fresh `Parser` instance
 * without re-reading the .wasm file. To fully re-init, set
 * `parserInitialized = false` and call `initGrammars()` again.
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    try { parser.delete(); } catch { /* ignore */ }
  }
  parserCache.clear();
  unavailableGrammarErrors.clear();
}

/**
 * Get unavailable grammar errors (for diagnostics)
 */
export function getUnavailableGrammarErrors(): Record<string, string> {
  return Object.fromEntries(unavailableGrammarErrors);
}

/**
 * Human-readable display name (e.g. "TypeScript", "Pascal / Delphi").
 * Returns the canonical name unchanged if no display name is registered.
 */
export function getLanguageDisplayName(language: Language): string {
  return getLanguageDefByName(language)?.displayName ?? language;
}
