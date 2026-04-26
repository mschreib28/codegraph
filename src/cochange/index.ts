/**
 * Co-Change Mining
 *
 * Reads `git log` to discover which files change together, surfacing
 * coupling that static analysis can't see (sibling language extractors
 * that share patterns, tests that assert schema state, config files
 * coupled to the code that reads them, etc.).
 *
 * Storage is a separate `co_changes` table, not the main `edges` graph,
 * because co-change is symmetric and weighted (count of commits where
 * both files changed). Query layer normalizes the count into a Jaccard
 * coefficient at read time using each file's total commit_count.
 *
 * Designed for incremental update: persist `last_mined_head` in
 * project_metadata; on subsequent mines, only enumerate commits since
 * that SHA so sync stays fast even on a large history.
 */

import { execFileSync } from 'child_process';
import { normalizePath } from '../utils';
import { logDebug } from '../errors';

/**
 * Skip commits that touch more than this many indexed files. Merge
 * commits and large refactors otherwise produce O(N²) spurious pairs
 * where every file appears coupled to every other.
 */
export const MAX_FILES_PER_COMMIT = 50;

/**
 * Drop pairs with fewer than this many co-changes. Two files that
 * happened to land in the same commit once usually aren't meaningfully
 * coupled; the signal lives in repeated co-occurrence.
 */
export const MIN_COCHANGE_COUNT = 2;

/** Project-metadata key holding the HEAD SHA of the last mined commit. */
export const LAST_MINED_HEAD_KEY = 'last_mined_cochange_head';

export interface MinedCoChanges {
  /** Map of "fileA\0fileB" (canonical: fileA < fileB) -> co-change count. */
  pairs: Map<string, number>;
  /** Map of file path -> number of mined commits that touched it. */
  fileCommits: Map<string, number>;
  /** HEAD SHA reached by this mining run, or null when no commits were seen. */
  currentHead: string | null;
}

/**
 * Get the current HEAD commit SHA, or null when not in a git repo or
 * the repo has no commits yet.
 */
export function getGitHead(rootDir: string): string | null {
  try {
    return execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Mine git history for co-changes.
 *
 * @param rootDir       Project root.
 * @param indexedFiles  Set of paths we care about (typically: every file
 *                      currently tracked in the index). Files outside this
 *                      set are dropped per-commit so we don't accumulate
 *                      pair counts for files we have no other context for.
 * @param sinceSha      If provided, only mine commits in `<sha>..HEAD`.
 *                      Pass `null` for a full history scan. If the SHA is
 *                      unreachable (force-push, gc), returns
 *                      `needsFullRescan: true` so the caller can clear and
 *                      re-mine from scratch.
 */
export function mineCoChanges(
  rootDir: string,
  indexedFiles: Set<string>,
  sinceSha: string | null
): MinedCoChanges & { needsFullRescan: boolean } {
  const empty: MinedCoChanges & { needsFullRescan: boolean } = {
    pairs: new Map(),
    fileCommits: new Map(),
    currentHead: null,
    needsFullRescan: false,
  };

  // Bail early when there are no commits at all.
  const currentHead = getGitHead(rootDir);
  if (!currentHead) return empty;

  // Verify the previous mining anchor is still reachable.
  if (sinceSha) {
    try {
      execFileSync(
        'git',
        ['cat-file', '-e', `${sinceSha}^{commit}`],
        { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      logDebug('Co-change: previous head unreachable, full rescan required', { sinceSha });
      return { ...empty, currentHead, needsFullRescan: true };
    }
    // Same SHA — nothing new to mine.
    if (sinceSha === currentHead) {
      return { ...empty, currentHead };
    }
  }

  // Header sentinel: `CGCMT-<40-hex-sha>`. This pattern cannot collide
  // with any POSIX filename git would actually emit via --name-only — a
  // file literally named `CGCMT-` followed by exactly 40 hex chars is not
  // realistic to encounter. The previous draft used `--` which a real
  // file could be named.
  //
  // git log -z output structure (verified empirically):
  //   CGCMT-<sha>\0\n<file>\0<file>\0CGCMT-<sha>\0\n<file>\0...
  // Each \0 is a record terminator; the \n after the format record is a
  // git-emitted separator before the file list.
  const HEADER_RE = /^CGCMT-[0-9a-f]{40}$/;
  const range = sinceSha ? [`${sinceSha}..${currentHead}`] : [];
  let raw: string;
  try {
    raw = execFileSync(
      'git',
      ['log', '--no-merges', '--name-only', '--format=tformat:CGCMT-%H', '-z', ...range],
      {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: 60_000,
        maxBuffer: 200 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
  } catch (error) {
    logDebug('Co-change: git log failed', { error: String(error) });
    return { ...empty, currentHead };
  }

  // Split on NUL (the record terminator). Trim leading whitespace from
  // each token to peel off the inter-record `\n` git inserts before the
  // file list. Then walk: header tokens flush+start, others are files.
  const pairs = new Map<string, number>();
  const fileCommits = new Map<string, number>();

  let currentFiles: string[] = [];
  const flush = () => {
    if (currentFiles.length === 0) return;
    const filtered = [...new Set(currentFiles.filter((f) => indexedFiles.has(f)))];
    currentFiles = [];
    if (filtered.length === 0 || filtered.length > MAX_FILES_PER_COMMIT) return;

    for (const f of filtered) {
      fileCommits.set(f, (fileCommits.get(f) ?? 0) + 1);
    }
    filtered.sort();
    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const key = `${filtered[i]}\0${filtered[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  };

  for (const rawToken of raw.split('\0')) {
    const token = rawToken.replace(/^\s+/, '');
    if (token.length === 0) continue;
    if (HEADER_RE.test(token)) {
      flush();
    } else {
      currentFiles.push(normalizePath(token));
    }
  }
  flush();

  return { pairs, fileCommits, currentHead, needsFullRescan: false };
}
