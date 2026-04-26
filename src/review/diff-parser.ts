/**
 * Unified Diff Parser
 *
 * Minimal parser for the subset of unified-diff syntax git emits:
 * file headers (`diff --git a/x b/y`), index lines, mode lines, and
 * hunk headers (`@@ -OLD,COUNT +NEW,COUNT @@`). Body lines are not
 * preserved — callers only need file + hunk metadata to map changes
 * back to symbols via line-range overlap.
 *
 * Pure module: no DB or filesystem access. Safe to test in isolation.
 */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Hunk {
  /** Old file: starting line number (1-indexed). 0 if file was added. */
  oldStart: number;
  /** Number of lines from the old file in this hunk. 0 for added file. */
  oldCount: number;
  /** New file: starting line number (1-indexed). 0 if file was deleted. */
  newStart: number;
  /** Number of lines in the new file. 0 for deleted file. */
  newCount: number;
}

export interface DiffFile {
  /**
   * File path as it appears in the new tree (or the old tree for deletions).
   * Always normalized to forward slashes; the leading `a/` or `b/` prefix
   * git emits is stripped.
   */
  path: string;
  /** Pre-rename path (only set when status === 'renamed'). */
  oldPath?: string;
  status: FileStatus;
  hunks: Hunk[];
}

const HUNK_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Matches both unquoted (`diff --git a/x b/y`) and C-style-quoted
// (`diff --git "a/x with space" "b/y"`) git diff headers. The capture
// groups always include the `a/` / `b/` prefix or the surrounding
// quotes; both are stripped via `unquote` before use.
const DIFF_HEADER_RE = /^diff --git (?:"a\/(.+)"|a\/(\S+)) (?:"b\/(.+)"|b\/(\S+))$/;

/**
 * Parse a unified diff into a flat list of files with hunk metadata.
 *
 * Tolerates extra noise lines (binary file markers, similarity index
 * lines, etc.) by skipping anything that doesn't match a known prefix.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isAddition = false;
  let isDeletion = false;
  let isRename = false;
  let renamedFrom: string | null = null;
  let renamedTo: string | null = null;

  // Strip git's C-style quoting on paths with special characters
  // (e.g., `"path with spaces.ts"` → `path with spaces.ts`).
  const unquote = (p: string | null): string | null => {
    if (!p) return p;
    if (p.startsWith('"') && p.endsWith('"')) {
      try { return JSON.parse(p) as string; } catch { return p.slice(1, -1); }
    }
    return p;
  };

  const flushCurrent = () => {
    if (!current) return;
    files.push(current);
    current = null;
  };

  // Emit a file entry for a header that produced no hunks (pure rename,
  // mode change, or empty add/delete). Without this, such files silently
  // disappear when followed by another `diff --git` header.
  const flushHunkless = () => {
    if (current !== null) return; // a hunked file already emitted
    if (!isRename && !isAddition && !isDeletion) return;
    const status: FileStatus = isRename
      ? 'renamed'
      : isAddition
        ? 'added'
        : 'deleted';
    const path = isDeletion
      ? unquote(oldPath) ?? renamedFrom ?? '?'
      : unquote(newPath) ?? renamedTo ?? '?';
    const f: DiffFile = { path, status, hunks: [] };
    if (status === 'renamed' && renamedFrom) f.oldPath = renamedFrom;
    files.push(f);
  };

  const lines = text.split('\n');
  for (const line of lines) {
    // Start of a new file block.
    const headerMatch = DIFF_HEADER_RE.exec(line);
    if (headerMatch) {
      flushCurrent();
      flushHunkless(); // emit any hunk-less file from the previous header
      // headerMatch slots: 1=quoted-a, 2=unquoted-a, 3=quoted-b, 4=unquoted-b.
      // Whichever side matched is the path; the others are undefined.
      oldPath = headerMatch[1] ?? headerMatch[2] ?? null;
      newPath = headerMatch[3] ?? headerMatch[4] ?? null;
      isAddition = false;
      isDeletion = false;
      isRename = false;
      renamedFrom = null;
      renamedTo = null;
      continue;
    }

    if (line.startsWith('new file mode')) {
      isAddition = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      isDeletion = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      isRename = true;
      renamedFrom = line.substring('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      renamedTo = line.substring('rename to '.length).trim();
      continue;
    }

    // The old/new path lines (--- / +++) confirm paths and detect
    // /dev/null sentinels that mean add or delete.
    if (line.startsWith('--- ')) {
      const p = line.substring(4).trim();
      if (p === '/dev/null') isAddition = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.substring(4).trim();
      if (p === '/dev/null') isDeletion = true;
      continue;
    }

    // First hunk seen — finalize the file header into a DiffFile.
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      if (!current) {
        const status: FileStatus = isRename
          ? 'renamed'
          : isAddition
            ? 'added'
            : isDeletion
              ? 'deleted'
              : 'modified';

        const path = isDeletion
          ? unquote(oldPath) ?? renamedFrom ?? '?'
          : unquote(newPath) ?? renamedTo ?? '?';

        current = {
          path,
          status,
          hunks: [],
        };
        if (status === 'renamed' && renamedFrom) {
          current.oldPath = renamedFrom;
        }
        // Reset add/delete/rename flags now that they've been consumed
        // into `current.status`. Otherwise they leak into the next header
        // and trigger a phantom hunk-less file emit.
        isAddition = false;
        isDeletion = false;
        isRename = false;
      }
      current.hunks.push({
        oldStart: parseInt(hunkMatch[1] ?? '0', 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3] ?? '0', 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
      });
      continue;
    }

    // Pure-rename or pure-mode-change blocks have no hunks. They get
    // emitted via flushHunkless on the next header transition, or here
    // at EOF.
  }

  flushCurrent();
  flushHunkless();

  return files;
}

/**
 * Convert a DiffFile + the file's symbol nodes (with start/end line
 * ranges) into the subset of symbols whose lines overlap any hunk.
 *
 * For added/deleted files there are no meaningful pre-existing symbols
 * to intersect — caller should treat the entire file as affected.
 */
export function symbolsTouchedByHunks<T extends { startLine: number; endLine: number }>(
  hunks: Hunk[],
  symbols: T[]
): T[] {
  if (hunks.length === 0 || symbols.length === 0) return [];
  const out: T[] = [];
  for (const s of symbols) {
    for (const h of hunks) {
      // Overlap is checked against the new-file line range. A hunk that
      // adds 5 lines starting at newStart=10 occupies lines [10, 14].
      const hunkEnd = h.newStart + Math.max(h.newCount - 1, 0);
      if (s.startLine <= hunkEnd && s.endLine >= h.newStart) {
        out.push(s);
        break;
      }
    }
  }
  return out;
}
