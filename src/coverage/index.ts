/**
 * Coverage ingestion orchestrator. Parses an external CI report
 * (lcov today; cobertura/jacoco TBD), maps each report file onto
 * an indexed file in the graph, then rolls coverage up into each
 * symbol's [start_line, end_line] span and upserts into
 * `node_coverage`.
 *
 * Path matching is two-tier: exact match against the indexed path
 * first, then longest-suffix match for monorepo cases where the
 * report's path includes a workspace prefix the project doesn't
 * (e.g. report says `packages/api/src/foo.ts`, indexed path is
 * `src/foo.ts`).
 */

import * as fs from 'fs';
import type { QueryBuilder } from '../db/queries';
import { parseLcov, summariseSpan } from './lcov';

export interface IngestResult {
  /** Files in the report that mapped onto an indexed file. */
  filesMatched: number;
  /** Files in the report with no indexed counterpart. */
  filesUnmatched: number;
  /** Symbols that received a `node_coverage` row this run. */
  symbolsUpdated: number;
  /** Symbols whose span had no executable lines in the report. */
  symbolsEmpty: number;
  /** Wall-clock duration of the ingestion in milliseconds. */
  durationMs: number;
}

export interface IngestOptions {
  format?: 'lcov';
  /** Source key written into `node_coverage.source`. Defaults to `'lcov'`. */
  source?: string;
  /** Drop every existing row for this source before ingesting. */
  clearSource?: boolean;
}

export async function ingestCoverage(
  queries: QueryBuilder,
  // projectRoot accepted for forward compatibility (absolute-path
  // relativisation in cobertura/jacoco reports). Unused by the lcov
  // path because suffix-match already handles longer report paths.
  _projectRoot: string,
  reportPath: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const start = Date.now();
  const source = options.source ?? 'lcov';

  if (options.clearSource) {
    queries.clearCoverageSource(source);
  }

  const body = fs.readFileSync(reportPath, 'utf8');
  const fileCoverages = parseLcov(body);

  const indexedPaths = queries.getAllFilePaths().map(normalisePath);
  const indexedSet = new Set(indexedPaths);

  let filesMatched = 0;
  let filesUnmatched = 0;
  let symbolsUpdated = 0;
  let symbolsEmpty = 0;
  const ingestedAt = Date.now();

  for (const fc of fileCoverages) {
    const matchedPath = matchIndexedPath(normalisePath(fc.filePath), indexedSet, indexedPaths);
    if (!matchedPath) {
      filesUnmatched += 1;
      continue;
    }
    filesMatched += 1;

    const nodes = queries.getNodesByFile(matchedPath);
    for (const node of nodes) {
      const startLine = node.startLine;
      const endLine = node.endLine;
      if (!startLine || !endLine) continue;

      const span = summariseSpan(fc, startLine, endLine);
      if (span.totalLines === 0) {
        symbolsEmpty += 1;
        continue;
      }

      queries.upsertNodeCoverage(
        node.id,
        source,
        span.coveredLines,
        span.totalLines,
        span.totalBranches > 0 ? span.coveredBranches : null,
        span.totalBranches > 0 ? span.totalBranches : null,
        ingestedAt,
      );
      symbolsUpdated += 1;
    }
  }

  return {
    filesMatched,
    filesUnmatched,
    symbolsUpdated,
    symbolsEmpty,
    durationMs: Date.now() - start,
  };
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a report path to one of the indexed paths. Exact match
 * wins; otherwise the longest indexed path that the report path
 * ends with (preceded by `/`) wins. Returns `null` when nothing
 * matches.
 */
function matchIndexedPath(
  reportPath: string,
  indexedSet: ReadonlySet<string>,
  indexedPaths: readonly string[],
): string | null {
  if (indexedSet.has(reportPath)) return reportPath;

  let best: string | null = null;
  for (const ip of indexedPaths) {
    if (reportPath.endsWith('/' + ip)) {
      if (!best || ip.length > best.length) best = ip;
    }
  }
  return best;
}
