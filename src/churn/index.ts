/**
 * Per-file churn mining
 *
 * Reads `git log` to compute four signals per indexed file:
 *   - commit_count    (how often the file gets touched)
 *   - first_seen_ts   (when it entered the codebase)
 *   - last_touched_ts (how recently it was modified)
 *   - loc             (line count of the current on-disk content)
 *
 * Combined with PageRank centrality (see ../centrality), these answer
 * "where do bugs hide?" — central files that change often are the
 * highest-expected-value review targets, validated empirically against
 * codegraph's own history (e.g. `src/extraction/tree-sitter.ts`).
 *
 * Storage strategy: scalar columns on `files` (one row already exists
 * per indexed path; adding columns avoids a JOIN on every read).
 *
 * Incremental update: persist `last_mined_churn_head` in
 * project_metadata; on subsequent mines, only enumerate commits in
 * `<sha>..HEAD`. This keeps `sync` fast on long histories. If the
 * stored sha is unreachable (force-push, gc), the caller gets
 * `needsFullRescan: true` and re-mines from scratch after `clearChurn`.
 *
 * Rename note: `git log --name-only` (without `--follow`) reports
 * post-rename paths only. The pre-rename history is therefore not
 * counted toward the new path's `commit_count`. `--follow` would fix
 * this but is documented as O(N) per file and shells out individually,
 * so v1 accepts the under-count and surfaces it in the doc-comment on
 * `commitCount` in types.ts.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

/**
 * Skip commits that touch more than this many indexed files. Merge
 * commits and mass refactors otherwise inflate every file's
 * commit_count without any real coupling signal.
 */
export const MAX_FILES_PER_COMMIT = 50;

/** Sentinel for `git log --pretty=tformat:`; cannot collide with a path. */
const COMMIT_HEADER_PREFIX = 'CGCMT-';

/** Project-metadata key holding the HEAD SHA of the last mined commit. */
export const LAST_MINED_CHURN_HEAD_KEY = 'last_mined_churn_head';

/** Hard cap on git output we'll buffer (bytes). Matches cochange. */
const MAX_GIT_BUFFER = 200 * 1024 * 1024;

/** Wall-clock cap on a single git invocation (ms). */
const GIT_TIMEOUT_MS = 60_000;

export interface FileChurnDelta {
  path: string;
  /** Commits to add to the existing commit_count. */
  commitCountDelta: number;
  /**
   * Most recent commit timestamp (unix seconds) seen in this delta.
   * Caller takes max() with the existing value.
   */
  lastTouchedTs: number;
  /**
   * Earliest commit timestamp (unix seconds) in this delta. Caller
   * applies `COALESCE(existing, this)` so the first-seen column only
   * gets written once.
   */
  firstSeenTs: number;
}

export interface ChurnMineResult {
  deltas: Map<string, FileChurnDelta>;
  /** HEAD SHA reached by this run; null when not in a git repo. */
  currentHead: string | null;
  /**
   * True when the caller's `sinceSha` was unreachable (force-push, gc).
   * Caller should `clearChurn()` and re-mine with `sinceSha=null`.
   */
  needsFullRescan: boolean;
}

/**
 * Get the current HEAD commit SHA, or null when not in a git repo or
 * the repo has no commits yet.
 */
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

/**
 * Verify that a stored SHA is still reachable from HEAD. After
 * force-push or `git gc` it can disappear, in which case incremental
 * mining would silently miss commits.
 */
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
 * Read the LOC of a file as currently on disk. Cheap; always fresh.
 *
 * Counts newline-delimited lines: a file with content `"a\nb\n"`
 * reports 2; an empty file reports 0; a file ending without a newline
 * still reports the visible-line count.
 */
export function readFileLoc(rootDir: string, relPath: string): number {
  try {
    const abs = path.join(rootDir, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    if (content.length === 0) return 0;
    let lines = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
    // Trailing chunk without final newline still counts as a line.
    if (content.charCodeAt(content.length - 1) !== 10) lines++;
    return lines;
  } catch {
    return 0;
  }
}

/**
 * Mine git log for per-file commit metrics.
 *
 * @param rootDir       Project root.
 * @param indexedFiles  Paths we care about (deltas only emitted for
 *                      these). Files outside this set are ignored
 *                      per-commit so churn doesn't accumulate for
 *                      paths the index has no other knowledge of.
 * @param sinceSha      `null` for full scan; otherwise mine only
 *                      `<sha>..HEAD`. Unreachable shas trigger
 *                      `needsFullRescan: true`.
 */
export function mineChurn(
  rootDir: string,
  indexedFiles: Set<string>,
  sinceSha: string | null
): ChurnMineResult {
  const empty: ChurnMineResult = {
    deltas: new Map(),
    currentHead: null,
    needsFullRescan: false,
  };

  const head = getGitHead(rootDir);
  if (!head) return empty;

  if (sinceSha && !isShaReachable(rootDir, sinceSha)) {
    return { deltas: new Map(), currentHead: head, needsFullRescan: true };
  }

  // No-op: nothing has happened since last mine.
  if (sinceSha === head) {
    return { deltas: new Map(), currentHead: head, needsFullRescan: false };
  }

  // tformat puts a literal trailing record-separator after each
  // commit's name list; -z then NUL-delimits within the format too,
  // so we get a clean stream of NUL-separated tokens.
  const args = [
    'log',
    '--no-merges',
    '--name-only',
    `--pretty=tformat:${COMMIT_HEADER_PREFIX}%H|%ct`,
    '-z',
  ];
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
    logDebug(`mineChurn: git log failed: ${err instanceof Error ? err.message : String(err)}`);
    return { deltas: new Map(), currentHead: head, needsFullRescan: false };
  }

  // Parse: tformat emits `CGCMT-<sha>|<ts>\0\n<path1>\0<path2>\0...
  // CGCMT-<next>|<ts>\0\n<path1>\0`. Each token between NULs is either
  // a commit header or a path; paths arrive with a leading '\n' on the
  // first one of each commit (the tformat record-separator). We walk
  // tokens linearly, switching commit context on each header.
  const tokens = raw.split('\0');
  const headerRe = /^CGCMT-([0-9a-f]{40})\|(\d+)$/;
  const deltas = new Map<string, FileChurnDelta>();

  let curTs = 0;
  let curPaths: string[] = [];
  let curActive = false;

  function flush() {
    if (!curActive) return;
    if (curPaths.length > 0 && curPaths.length <= MAX_FILES_PER_COMMIT) {
      for (const p of curPaths) {
        if (!indexedFiles.has(p)) continue;
        const cur = deltas.get(p);
        if (cur) {
          cur.commitCountDelta += 1;
          if (curTs > cur.lastTouchedTs) cur.lastTouchedTs = curTs;
          if (curTs < cur.firstSeenTs) cur.firstSeenTs = curTs;
        } else {
          deltas.set(p, {
            path: p,
            commitCountDelta: 1,
            lastTouchedTs: curTs,
            firstSeenTs: curTs,
          });
        }
      }
    }
    curPaths = [];
    curActive = false;
  }

  for (const rawTok of tokens) {
    if (rawTok === '') continue;
    // Strip a single leading \n introduced by tformat's record separator.
    const tok = rawTok.startsWith('\n') ? rawTok.slice(1) : rawTok;
    if (tok === '') continue;
    const m = headerRe.exec(tok);
    if (m) {
      flush();
      curTs = parseInt(m[2]!, 10);
      curActive = true;
    } else if (curActive) {
      curPaths.push(tok);
    }
    // Tokens before the first header (shouldn't happen) are ignored.
  }
  flush();

  return { deltas, currentHead: head, needsFullRescan: false };
}
