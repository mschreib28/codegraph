/**
 * Config-reference extraction
 *
 * Scans indexed source files for known config-read patterns
 * (`process.env.X`, `os.getenv("X")`, etc.) and records each read
 * site as a row in `config_refs`. Each row links to its enclosing
 * function via a line-range lookup against the existing nodes table,
 * so an agent asking "what reads OBSIDIAN_PORT?" gets a list of real
 * functions, not a grep wall.
 *
 * Why a separate table, not graph nodes/edges: env vars don't have a
 * single source-of-truth file (they're a global namespace), so giving
 * them a synthetic file_path would pollute the main graph. The table
 * is queried via a dedicated MCP tool (`codegraph_config`) and via
 * augmented `codegraph_node` output (per-function "reads:" line).
 *
 * Spike validation (mcp-obsidian-extended): 71 reads, 19 distinct
 * keys; 8× OBSIDIAN_PORT, 8× TOOL_PRESET surface as central
 * config knobs. Codegraph-itself is sparse (4 reads) — this feature
 * shines on service-style codebases.
 *
 * V1 scope: env-only, regex-based per-language. YAML key reads,
 * LaunchDarkly flags, etc. are deliberately out of scope; the schema
 * already supports them via `config_kind` so adding them later is a
 * pattern addition, not a redesign.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

export type ConfigKind = 'env';

export interface ConfigRef {
  configKind: ConfigKind;
  configKey: string;
  /** Indexed-symbol id for the enclosing function/method. NULL = top-level. */
  sourceNodeId: string | null;
  filePath: string;
  line: number;
}

interface PatternDef {
  /** Languages this pattern applies to (matches `Language` in types.ts). */
  languages: string[];
  /** Regex with capture group 1 = config key. */
  re: RegExp;
}

/**
 * Per-language read-pattern catalogue.
 *
 * Patterns intentionally err on the side of including only
 * UPPER_CASE_KEYS — the convention every framework follows for env
 * vars. This avoids false positives like `process.env.foo` (a Node
 * variable) or `os.getenv(some_var)` (dynamic).
 */
const PATTERNS: PatternDef[] = [
  // process.env.FOO  /  process.env["FOO"]  (TS, JS, TSX, JSX)
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  },
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  // os.getenv("FOO")  /  os.environ.get("FOO")  /  os.environ["FOO"]
  {
    languages: ['python'],
    re: /\bos\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  {
    languages: ['python'],
    re: /\bos\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  {
    languages: ['python'],
    re: /\bos\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  // Bare getenv("FOO") (Python convention with `from os import getenv`)
  {
    languages: ['python'],
    re: /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  // os.Getenv("FOO")  /  os.LookupEnv("FOO")  (Go)
  {
    languages: ['go'],
    re: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
  // System.getenv("FOO") (Java/Kotlin)
  {
    languages: ['java', 'kotlin'],
    re: /\bSystem\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
  // ENV["FOO"] / ENV.fetch("FOO") (Ruby)
  {
    languages: ['ruby'],
    re: /\bENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  {
    languages: ['ruby'],
    re: /\bENV\.fetch\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  // Rust: env!("FOO") / std::env::var("FOO")
  {
    languages: ['rust'],
    re: /\benv!\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
  {
    languages: ['rust'],
    re: /\bstd::env::var\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
];

/** A file's languages-of-interest. Skip everything not in PATTERNS. */
const SUPPORTED_LANGUAGES = new Set<string>(
  PATTERNS.flatMap((p) => p.languages)
);

/**
 * Resolver supplied by caller: (filePath, line) → enclosing nodeId
 * (function/method/class). Returns null when the read is at the file's
 * top level — the row still gets persisted with NULL source_node_id.
 */
export type EnclosingNodeResolver = (filePath: string, line: number) => string | null;

export interface FileTarget {
  path: string;
  language: string;
}

/**
 * Scan a list of (path, language) targets and return all read sites.
 * Pure I/O + regex; the caller owns DB writes via `applyConfigRefs`.
 *
 * Files we can't read (deleted, permission, binary) are silently
 * skipped — extraction has already validated readability for the rest.
 */
export function extractConfigRefs(
  rootDir: string,
  targets: Iterable<FileTarget>,
  resolveEnclosing: EnclosingNodeResolver
): ConfigRef[] {
  const refs: ConfigRef[] = [];
  for (const t of targets) {
    if (!SUPPORTED_LANGUAGES.has(t.language)) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(rootDir, t.path), 'utf8');
    } catch (err) {
      logDebug(`extractConfigRefs: read failed for ${t.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // Iterate lines so we can attribute each match to a 1-indexed line.
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Cheap pre-filter to skip the 99% of lines that obviously
      // contain no env reference. Cuts per-file cost dramatically on
      // big repos.
      if (
        !line.includes('env') &&
        !line.includes('Env') &&
        !line.includes('ENV')
      ) {
        continue;
      }
      for (const pat of PATTERNS) {
        if (!pat.languages.includes(t.language)) continue;
        pat.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pat.re.exec(line)) !== null) {
          const key = m[1]!;
          const lineNo = i + 1;
          refs.push({
            configKind: 'env',
            configKey: key,
            sourceNodeId: resolveEnclosing(t.path, lineNo),
            filePath: t.path,
            line: lineNo,
          });
        }
      }
    }
  }
  return refs;
}
