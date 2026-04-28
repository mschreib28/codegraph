/**
 * LCOV parser — minimal, line-oriented. Only the records we need:
 * `SF:` (source file), `DA:line,hits` (line execution count),
 * `BRDA:line,block,branch,taken` (branch outcome). Other records
 * (`FN:`, `FNDA:`, `BRF:`, `BRH:`, `LF:`, `LH:`) are ignored — we
 * recompute totals from `DA`/`BRDA` ourselves so the parser stays
 * tolerant of inconsistent or missing summary lines.
 *
 * Istanbul's "non-executable line" sentinel `DA:N,-1` is dropped
 * rather than recorded as uncovered: a non-executable line should
 * not count against coverage.
 */

export interface FileCoverage {
  filePath: string;
  /** Line number → execution count. */
  lineHits: Map<number, number>;
  /** Line number → branch rollup for that line. */
  branches: Map<number, { taken: number; total: number }>;
}

export interface SpanSummary {
  totalLines: number;
  coveredLines: number;
  totalBranches: number;
  coveredBranches: number;
}

export function parseLcov(body: string): FileCoverage[] {
  const records: FileCoverage[] = [];
  let current: FileCoverage | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('SF:')) {
      current = {
        filePath: line.slice(3),
        lineHits: new Map(),
        branches: new Map(),
      };
      records.push(current);
      continue;
    }

    // Records before the first SF: have no owning file — drop them.
    if (!current) continue;

    if (line === 'end_of_record') {
      current = null;
      continue;
    }

    if (line.startsWith('DA:')) {
      const parts = line.slice(3).split(',');
      if (parts.length < 2) continue;
      const lineNum = parseInt(parts[0]!, 10);
      const hits = parseInt(parts[1]!, 10);
      if (!Number.isFinite(lineNum) || !Number.isFinite(hits)) continue;
      if (hits < 0) continue;
      current.lineHits.set(lineNum, hits);
      continue;
    }

    if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',');
      if (parts.length < 4) continue;
      const lineNum = parseInt(parts[0]!, 10);
      if (!Number.isFinite(lineNum)) continue;
      const takenStr = parts[3]!;
      // `-` means the branch was never reached at all (counted in
      // total, but not as taken). Numeric 0 means reached but not
      // taken on this side — same effect for our rollup.
      const taken = takenStr === '-' ? 0 : parseInt(takenStr, 10);
      if (!Number.isFinite(taken)) continue;
      const existing = current.branches.get(lineNum) ?? { taken: 0, total: 0 };
      existing.total += 1;
      if (taken > 0) existing.taken += 1;
      current.branches.set(lineNum, existing);
      continue;
    }
  }

  return records;
}

/**
 * Roll up a file's coverage into a single symbol's [startLine, endLine]
 * span. Lines outside the span are ignored entirely — a non-executable
 * line outside the span doesn't drag a symbol's denominator down, and
 * a heavily-hit line outside doesn't inflate it.
 */
export function summariseSpan(
  fc: FileCoverage,
  startLine: number,
  endLine: number,
): SpanSummary {
  let totalLines = 0;
  let coveredLines = 0;
  let totalBranches = 0;
  let coveredBranches = 0;

  for (const [line, hits] of fc.lineHits) {
    if (line < startLine || line > endLine) continue;
    totalLines += 1;
    if (hits > 0) coveredLines += 1;
  }

  for (const [line, br] of fc.branches) {
    if (line < startLine || line > endLine) continue;
    totalBranches += br.total;
    coveredBranches += br.taken;
  }

  return { totalLines, coveredLines, totalBranches, coveredBranches };
}
