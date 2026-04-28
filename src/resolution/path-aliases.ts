/**
 * Project-level import-path alias loading.
 *
 * Reads `compilerOptions.paths` from `tsconfig.json` / `jsconfig.json`
 * at the project root and converts the patterns into a form the
 * import-resolver can consult.
 *
 * This is the single biggest blocker to accurate resolution on modern
 * JS/TS codebases: aliases like `@/components/Foo` (Next, Nuxt, Nest,
 * Vite scaffolds) point into a `paths` map the resolver previously
 * ignored — every import through an alias was treated as unresolvable
 * unless it happened to match the small hard-coded fallback list.
 *
 * Scope deliberately small for v1:
 *   - reads tsconfig.json, then jsconfig.json
 *   - honours top-level `compilerOptions.baseUrl` and `compilerOptions.paths`
 *   - supports `*` wildcard (the only TS-supported wildcard)
 *   - does NOT follow `extends` chains yet (most projects don't need it)
 *   - does NOT read Vite/webpack/Rollup configs (separate follow-up)
 *
 * The file is parsed as JSON-with-comments-tolerant — tsconfigs in the
 * wild routinely contain `//` and `/* *\/` comments and trailing
 * commas, which JSON.parse rejects. We strip those before parsing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

/** A single alias pattern from `compilerOptions.paths`. */
export interface AliasPattern {
  /** The literal prefix before `*` (or the whole pattern if no `*`). */
  prefix: string;
  /** The literal suffix after `*` (almost always empty). */
  suffix: string;
  /** Whether the pattern contains a `*` wildcard. */
  hasWildcard: boolean;
  /**
   * Replacement templates. When `hasWildcard` is true, `*` in the
   * replacement is filled with the captured wildcard portion of the
   * import path. Stored relative to {@link AliasMap.baseUrl}.
   * tsconfig allows multiple targets per alias (priority order).
   */
  replacements: string[];
}

export interface AliasMap {
  /** Absolute path. The directory `compilerOptions.paths` is rooted at. */
  baseUrl: string;
  /**
   * Patterns ordered by specificity: longer prefix first, then literal-
   * before-wildcard, so the resolver tries the most-specific match.
   */
  patterns: AliasPattern[];
}

/**
 * Strip JSONC comments + trailing commas so a tsconfig with the usual
 * VS Code-style annotations parses cleanly. Naive but covers the
 * common cases — tsconfigs are not nested-string-heavy so the regex
 * approach is safe in practice.
 */
function stripJsonc(src: string): string {
  // Remove block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments (only those not inside strings — heuristic
  // good enough for tsconfig)
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // Trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return out;
}

interface RawTsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function readTsconfigLike(filePath: string): RawTsconfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonc(raw)) as RawTsconfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    logDebug('path-aliases: failed to parse', { filePath, err: String(err) });
    return null;
  }
}

function splitWildcard(pattern: string): {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
} {
  const star = pattern.indexOf('*');
  if (star === -1) return { prefix: pattern, suffix: '', hasWildcard: false };
  return {
    prefix: pattern.slice(0, star),
    suffix: pattern.slice(star + 1),
    hasWildcard: true,
  };
}

/**
 * Load aliases for `projectRoot`. Returns `null` when no tsconfig /
 * jsconfig is present or when the file has no usable `paths`.
 *
 * Cheap to call repeatedly — caching is the caller's job (the
 * resolver does it via {@link aliasCache}).
 */
export function loadProjectAliases(projectRoot: string): AliasMap | null {
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  let raw: RawTsconfig | null = null;
  let usedFile: string | null = null;
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (fs.existsSync(p)) {
      raw = readTsconfigLike(p);
      if (raw) {
        usedFile = name;
        break;
      }
    }
  }
  if (!raw) return null;

  const co = raw.compilerOptions ?? {};
  const baseUrlRel = co.baseUrl ?? '.';
  const baseUrl = path.resolve(projectRoot, baseUrlRel);

  const paths = co.paths;
  if (!paths || typeof paths !== 'object') {
    // baseUrl alone isn't an "alias" per se; with no paths we'd just
    // be redirecting the whole tree. Skip — the existing resolver
    // already handles relative imports.
    return null;
  }

  const patterns: AliasPattern[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const filtered = targets.filter((t): t is string => typeof t === 'string');
    if (filtered.length === 0) continue;
    const { prefix, suffix, hasWildcard } = splitWildcard(pattern);
    patterns.push({ prefix, suffix, hasWildcard, replacements: filtered });
  }

  if (patterns.length === 0) return null;

  // Specificity sort: longer prefix first; literal patterns before
  // wildcard patterns of the same prefix length. TypeScript itself
  // uses a similar "most specific match wins" rule.
  patterns.sort((a, b) => {
    if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
    return 0;
  });

  logDebug('path-aliases loaded', {
    file: usedFile,
    baseUrl,
    patternCount: patterns.length,
  });

  return { baseUrl, patterns };
}

/**
 * Resolve an import path through an {@link AliasMap}. Returns the list
 * of candidate filesystem paths (relative to `projectRoot`), in the
 * priority order defined by tsconfig (multiple replacements per alias
 * are tried in order). Returns `[]` when no alias matches.
 *
 * Callers still need to try each candidate with the language's
 * extension list — this function only does the alias rewrite.
 */
export function applyAliases(
  importPath: string,
  aliases: AliasMap,
  projectRoot: string
): string[] {
  for (const pat of aliases.patterns) {
    if (!importPath.startsWith(pat.prefix)) continue;
    if (pat.suffix && !importPath.endsWith(pat.suffix)) continue;

    let captured = '';
    if (pat.hasWildcard) {
      captured = importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length);
    } else if (importPath !== pat.prefix) {
      // Literal pattern must match exactly.
      continue;
    }

    const out: string[] = [];
    for (const target of pat.replacements) {
      const filled = pat.hasWildcard ? target.replace('*', captured) : target;
      // baseUrl is absolute; produce a path relative to projectRoot
      const absolute = path.resolve(aliases.baseUrl, filled);
      const relative = path.relative(projectRoot, absolute);
      // Skip if the rewrite escapes the project root (unsafe + can't
      // be looked up via the file index anyway).
      if (relative.startsWith('..')) continue;
      out.push(relative.replace(/\\/g, '/'));
    }
    return out;
  }
  return [];
}
