/**
 * SQL call-site extraction
 *
 * Scans indexed source files for SQL string-literal patterns (FROM,
 * JOIN, INTO, UPDATE, DELETE FROM, CREATE TABLE) and records each
 * (table, op) pair as a row in `sql_refs`. Each row links to its
 * enclosing function via line-range lookup against the existing
 * nodes table, so an agent asking "what code touches the users
 * table?" gets a list of real functions, not a grep wall.
 *
 * Why a separate table, not graph nodes/edges: tables aren't
 * declared in code that the existing extractors parse — they live
 * in `.sql` migration files. Once #95 (SQL language extractor)
 * merges, `table_name` can be joined against indexed SQL DDL nodes
 * for cross-language navigation. This PR ships the call-site
 * detection now so the agent-useful queries already work; full
 * graph integration follows when the prerequisite lands.
 *
 * Spike validation (codegraph indexing itself): 87 SQL call sites
 * across the 8 tables defined in `src/db/schema.sql`, each
 * attributed to its enclosing QueryBuilder method. Beats grep
 * because grep matches `const nodes = ...` (a JS variable named
 * `nodes`) too — this regex requires the SQL keyword prefix
 * (FROM/INTO/UPDATE/JOIN), eliminating that class of false positive.
 *
 * V1 scope: table-level only. Column extraction (`SELECT email FROM
 * users` → `users.email`) is best-effort and deferred until #95
 * provides reliable column-name DDL nodes to join against.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

export type SqlOp = 'read' | 'write' | 'ddl';

export interface SqlRef {
  tableName: string;
  op: SqlOp;
  /** Indexed-symbol id for the enclosing function/method. NULL = top-level. */
  sourceNodeId: string | null;
  filePath: string;
  line: number;
}

/**
 * Languages we scan. Anything not in this set is skipped — most
 * non-source files have no SQL to find. SQL files themselves are
 * skipped here because #95 will own DDL extraction.
 */
const SUPPORTED_LANGUAGES = new Set<string>([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'php',
  'ruby',
]);

/**
 * SQL identifier regex. Allows simple unquoted identifiers and
 * double-quoted (Postgres) or backtick-quoted (MySQL) identifiers,
 * with optional schema-qualifier prefix (`public.users`,
 * `"public"."users"`). For v1 we record only the *table* part —
 * schema goes into a future column when we have join targets.
 */
const IDENT = '(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\\w]*))';

interface PatternDef {
  /** Capture group containing the table name (1, 2, or 3 in IDENT). */
  re: RegExp;
  op: SqlOp;
}

/**
 * SQL keyword + identifier patterns. `i` flag makes them case-
 * insensitive; `g` is required for `exec` loops to advance through
 * multiple matches per line.
 *
 * Each regex captures the table name in groups 1/2/3 (backtick /
 * double-quote / unquoted) — at most one is set per match.
 */
const PATTERNS: PatternDef[] = [
  // SELECT ... FROM <table>
  // FROM appears in SELECT and DELETE statements; we tag it 'read' here
  // and let DELETE's own regex below tag it 'write'. Last write wins
  // because Map dedup is keyed by (table, op), so the DELETE one
  // produces a separate write row alongside this read row.
  { re: new RegExp(`\\bFROM\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'read' },
  { re: new RegExp(`\\bJOIN\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'read' },
  // INSERT INTO <table>
  { re: new RegExp(`\\bINSERT\\s+INTO\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'write' },
  // UPDATE <table> ... SET
  { re: new RegExp(`\\bUPDATE\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}\\s+SET\\b`, 'gi'), op: 'write' },
  // DELETE FROM <table>
  { re: new RegExp(`\\bDELETE\\s+FROM\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'write' },
  // CREATE TABLE [IF NOT EXISTS] <table>
  { re: new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'ddl' },
  // ALTER TABLE / DROP TABLE
  { re: new RegExp(`\\bALTER\\s+TABLE\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'ddl' },
  { re: new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${IDENT}`, 'gi'), op: 'ddl' },
];

/**
 * Identifier names we drop because they're SQL keywords or noise
 * that the regex over-matches on:
 *   - `WHERE` / `ON` / `GROUP` after `JOIN` (chained JOIN clauses)
 *   - `AS`/`USING` aliasing
 *   - `SELECT` / `INTO` (CTE-shaped or `SELECT ... INTO`)
 */
const RESERVED_TABLE_NAMES = new Set<string>([
  // SQL keywords (real reserved words)
  'where', 'on', 'group', 'order', 'limit', 'using', 'as',
  'select', 'into', 'values', 'set', 'and', 'or', 'not',
  'null', 'true', 'false',
  // Common English words that survive the SQL-verb pre-filter when
  // a sentence happens to contain a verb-like token. Stress test
  // caught `from the list` in a code comment slipping through because
  // "drop" appeared in "drop docs/config". These can never be real
  // table names in production code, so reject early.
  'a', 'an', 'the', 'of', 'to', 'in', 'is', 'it', 'for',
  'this', 'that', 'these', 'those', 'with', 'by', 'at',
]);

/**
 * Resolver supplied by caller: (filePath, line) → enclosing nodeId.
 * Returns null when the read is at the file's top level.
 */
export type EnclosingNodeResolver = (filePath: string, line: number) => string | null;

export interface FileTarget {
  path: string;
  language: string;
}

/**
 * Strip line and same-line block comments before SQL detection.
 *
 * Without this, a line like
 *   // example: db.prepare('SELECT name FROM the docs')
 * passes the prose-rejection (it has a quote AND a SQL verb) and
 * extracts `the` as a "table name". The comment is the actual
 * problem — strip it first.
 *
 * Naive split on `//` / `#` is acceptable: SQL syntax doesn't use
 * either as operators, so truncating SQL after a `//` inside a
 * string is implausible (SQL line comments are `--`). Block
 * comments on a single line (`/* ... *\/`) are stripped via
 * regex; multi-line block comments are a documented v1 miss.
 */
function stripComments(line: string, language: string): string {
  // Same-line block comments first (works for C-family languages).
  let stripped = line.replace(/\/\*[\s\S]*?\*\//g, '');
  if (language === 'python' || language === 'ruby') {
    const idx = stripped.indexOf('#');
    if (idx >= 0) stripped = stripped.slice(0, idx);
  } else {
    const idx = stripped.indexOf('//');
    if (idx >= 0) stripped = stripped.slice(0, idx);
  }
  return stripped;
}

/**
 * Pre-filter: line (with comments stripped) must contain a quote
 * (so it's plausibly a string literal) AND a SQL verb. Anchoring on
 * a verb is critical — without it, prose like
 *   const note = "get the value from the array";
 * pollutes results because `from the` matches our `FROM <table>`
 * regex. Requiring `SELECT|INSERT|UPDATE|...` on the same line
 * filters those out.
 */
function lineLooksLikeSql(line: string): boolean {
  if (!/['"`]/.test(line)) return false;
  return /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(line);
}

/**
 * Sanity check: the captured `FROM <table>` (or similar) should be
 * inside a string literal, not in a comment. Approximated by
 * requiring a quote (`'`, `"`, `` ` ``) somewhere before the match
 * position on the same line. Doesn't handle multi-line template
 * literals where the open-quote is on a previous line — that's a v1
 * acceptable miss.
 */
function isInsideString(line: string, matchIndex: number): boolean {
  const prefix = line.slice(0, matchIndex);
  return /['"`]/.test(prefix);
}

/**
 * Pull the table name out of a regex match. Exactly one of the
 * three identifier capture groups is set per IDENT alternation.
 */
function extractTableName(m: RegExpExecArray): string | null {
  const name = m[1] ?? m[2] ?? m[3];
  if (!name) return null;
  if (RESERVED_TABLE_NAMES.has(name.toLowerCase())) return null;
  return name;
}

/**
 * Scan a list of (path, language) targets and return all SQL refs
 * found. Pure I/O + regex; the caller owns DB writes via
 * `applySqlRefs`.
 */
export function extractSqlRefs(
  rootDir: string,
  targets: Iterable<FileTarget>,
  resolveEnclosing: EnclosingNodeResolver
): SqlRef[] {
  const refs: SqlRef[] = [];
  for (const t of targets) {
    if (!SUPPORTED_LANGUAGES.has(t.language)) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(rootDir, t.path), 'utf8');
    } catch (err) {
      logDebug(`extractSqlRefs: read failed for ${t.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const line = stripComments(rawLine, t.language);
      if (!lineLooksLikeSql(line)) continue;
      const lineNo = i + 1;
      // Per-line dedup: if the same (table, op) appears twice via
      // overlapping regex (e.g. `FROM` and `JOIN` in one line for
      // different tables, but the same table doesn't double-record).
      const seen = new Set<string>();
      for (const pat of PATTERNS) {
        pat.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pat.re.exec(line)) !== null) {
          if (!isInsideString(line, m.index)) continue;
          const name = extractTableName(m);
          if (!name) continue;
          const key = `${name.toLowerCase()}|${pat.op}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({
            tableName: name,
            op: pat.op,
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
