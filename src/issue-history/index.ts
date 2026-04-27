/**
 * Issue → symbol attribution from git history
 *
 * Mines commits whose subject or body matches `Fixes #N` /
 * `Closes #N` / `Resolves #N` and attributes their hunks to the
 * symbols they touched. Result is stored in the `symbol_issues`
 * table and surfaced via `codegraph_node` so an agent inspecting
 * `runInstaller` sees "modified by issues #37, #68, #69" inline.
 *
 * Why hunk-level, not file-level: spike data (see `spike_issues.js`
 * + `spike_issues_hunk.js`) showed that file-level produced ~40
 * symbols/issue, mostly noise — every issue touches files with
 * many irrelevant symbols. Hunk-level is ~9 symbols/issue with
 * 78% noise reduction, AND uniquely enables the multi-issue-symbol
 * query (e.g. "loadGrammarsForLanguages was modified by every
 * language-add issue") which file-level cannot answer because the
 * intersection at file granularity is trivially huge.
 *
 * Convention: only `(Fixes|Closes|Resolves) #N` commits are mined.
 * Generic commit messages without an issue ref are ignored — keeps
 * signal-to-noise high.
 *
 * Known v1 limitations:
 *   - `Fixes #1, #2` only captures #1. The regex requires a verb
 *     prefix per match; `, #2` has no verb so it's skipped. Authors
 *     who care should write `Fixes #1, fixes #2`. Acceptable noise
 *     for v1; revisit if real projects show many comma-list misses.
 *   - Quoted issue references in commit bodies (e.g. "this reverts the
 *     'Fixes #99' commit from last week") produce false positives.
 *     Detection would require message-block parsing; out of scope for v1.
 */

import { execFileSync } from 'child_process';
import { logDebug } from '../errors';
import { parseCommitDiff } from './parse-diff';

/** Project-metadata key holding the HEAD SHA at the last successful mine. */
export const LAST_MINED_ISSUES_HEAD_KEY = 'last_mined_issues_head';

/**
 * Skip commits touching more than this many files. Squashed merges
 * and mass refactors otherwise produce many false-positive
 * attributions where every symbol in the commit gets credited to
 * the issue.
 */
export const MAX_FILES_PER_COMMIT = 50;

/**
 * Match `fix #N` / `fixes #N` / `closes #N` / `resolves #N` (and
 * past-tense variants), case-insensitive, allowing `:` or `-`
 * between verb and `#`. Captures the issue number.
 */
export const ISSUE_REGEX =
  /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*[:\-]?\s*#(\d+)/gi;

const MAX_GIT_BUFFER = 200 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

export interface IssueCommit {
  sha: string;
  /** Distinct issue numbers referenced, in source order. */
  issues: number[];
}

export type AttributionKind = 'modified' | 'added' | 'removed';

export interface IssueAttribution {
  nodeId: string;
  issueNumber: number;
  commitSha: string;
  kind: AttributionKind;
}

export interface IssueMineResult {
  attributions: IssueAttribution[];
  /** HEAD SHA reached by this run. null when not in a git repo. */
  currentHead: string | null;
  /** Caller's `sinceSha` was unreachable — caller clears + re-mines from scratch. */
  needsFullRescan: boolean;
  /** Debug-only counter: (file, name) lookups that didn't resolve. */
  unresolvedCount: number;
}

/** Resolver supplied by the caller: (file, name) → node_id | null. */
export type SymbolResolver = (filePath: string, symbolName: string) => string | null;

/** Get HEAD SHA, or null when not in a git repo / no commits yet. */
export function getGitHead(rootDir: string): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function isShaReachable(rootDir: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: rootDir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find commits whose message references at least one issue. Returns
 * `[]` when not in a git repo or git fails (logged via logDebug;
 * never throws to the caller).
 *
 * Format: `git log --no-merges -z --pretty=format:CGCMT-%H%n%s%n%b%n` —
 * each commit terminated by a NUL. The body line lets us match
 * trailers like `Fixes #N` that aren't in the subject.
 */
export function mineIssueCommits(rootDir: string, sinceSha: string | null): IssueCommit[] {
  const args = ['log', '--no-merges', '-z', '--pretty=format:CGCMT-%H%n%s%n%b'];
  if (sinceSha) args.push(`${sinceSha}..HEAD`);

  let raw: string;
  try {
    raw = execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    logDebug(`mineIssueCommits: git log failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const commits: IssueCommit[] = [];
  const blocks = raw.split('\0');
  const headerRe = /^CGCMT-([0-9a-f]{40})$/;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const m = headerRe.exec(lines[0] ?? '');
    if (!m) continue;
    const sha = m[1]!;
    const messageBody = lines.slice(1).join('\n');
    const issues = new Set<number>();
    let match: RegExpExecArray | null;
    ISSUE_REGEX.lastIndex = 0;
    while ((match = ISSUE_REGEX.exec(messageBody)) !== null) {
      const n = parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) issues.add(n);
    }
    if (issues.size > 0) commits.push({ sha, issues: [...issues] });
  }
  return commits;
}

/**
 * Mine issue→symbol attributions.
 *
 * @param rootDir         Project root.
 * @param resolveSymbol   (filePath, name) → nodeId | null. Closure
 *                        over the current index. Names that don't
 *                        resolve are dropped (counted as unresolved
 *                        for diagnostics).
 * @param sinceSha        null = full mine; otherwise `<sha>..HEAD`.
 *                        Unreachable shas trigger needsFullRescan.
 */
export function mineIssueHistory(
  rootDir: string,
  resolveSymbol: SymbolResolver,
  sinceSha: string | null
): IssueMineResult {
  const empty: IssueMineResult = {
    attributions: [],
    currentHead: null,
    needsFullRescan: false,
    unresolvedCount: 0,
  };

  const head = getGitHead(rootDir);
  if (!head) return empty;

  if (sinceSha && !isShaReachable(rootDir, sinceSha)) {
    return { attributions: [], currentHead: head, needsFullRescan: true, unresolvedCount: 0 };
  }
  if (sinceSha === head) {
    return { attributions: [], currentHead: head, needsFullRescan: false, unresolvedCount: 0 };
  }

  const commits = mineIssueCommits(rootDir, sinceSha);
  const attributions: IssueAttribution[] = [];
  let unresolvedCount = 0;

  for (const c of commits) {
    let perFile;
    try {
      perFile = parseCommitDiff(rootDir, c.sha);
    } catch (err) {
      logDebug(`parseCommitDiff failed for ${c.sha}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (perFile.size > MAX_FILES_PER_COMMIT) {
      // Squashed mass-refactor — the issue ref is real but the per-symbol
      // attribution would be all noise. Skip the whole commit.
      continue;
    }
    for (const [filePath, sets] of perFile) {
      const emit = (name: string, kind: AttributionKind) => {
        const nodeId = resolveSymbol(filePath, name);
        if (!nodeId) {
          unresolvedCount += 1;
          return;
        }
        for (const issue of c.issues) {
          attributions.push({ nodeId, issueNumber: issue, commitSha: c.sha, kind });
        }
      };
      // Order: modified first, then added, then removed. Stable for tests.
      for (const name of sets.modCtx) emit(name, 'modified');
      for (const name of sets.added) emit(name, 'added');
      for (const name of sets.removed) emit(name, 'removed');
    }
  }

  return { attributions, currentHead: head, needsFullRescan: false, unresolvedCount };
}
