/**
 * Coverage ingestion tests: lcov parser + symbol-span rollup +
 * QueryBuilder upsert/read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { parseLcov, summariseSpan } from '../src/coverage/lcov';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-coverage-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('lcov parser', () => {
  it('parses a minimal record', () => {
    const body = [
      'TN:',
      'SF:src/foo.ts',
      'DA:1,5',
      'DA:2,5',
      'DA:3,0',
      'end_of_record',
    ].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe('src/foo.ts');
    expect(out[0]!.lineHits.get(1)).toBe(5);
    expect(out[0]!.lineHits.get(3)).toBe(0);
  });

  it('parses multiple records and branch data', () => {
    const body = [
      'SF:a.ts',
      'DA:1,1',
      'BRDA:1,0,0,2',
      'BRDA:1,0,1,-',
      'end_of_record',
      'SF:b.ts',
      'DA:5,3',
      'end_of_record',
    ].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(2);
    expect(out[0]!.branches.get(1)).toEqual({ taken: 1, total: 2 });
    expect(out[1]!.lineHits.get(5)).toBe(3);
  });

  it('tolerates a missing trailing end_of_record', () => {
    const body = [
      'SF:c.ts',
      'DA:10,7',
    ].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.lineHits.get(10)).toBe(7);
  });

  it('skips DA records with negative hit counts (Istanbul excluded-line sentinel)', () => {
    const body = ['SF:x.ts', 'DA:1,5', 'DA:2,-1', 'DA:3,0', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    // Line 2 (hits=-1) should NOT appear in lineHits — treated as
    // non-executable rather than uncovered.
    expect(out[0]!.lineHits.has(1)).toBe(true);
    expect(out[0]!.lineHits.has(2)).toBe(false);
    expect(out[0]!.lineHits.has(3)).toBe(true);
  });

  it('skips records before the first SF: line', () => {
    const body = [
      'TN:something',
      'DA:1,5',
      'SF:real.ts',
      'DA:2,2',
      'end_of_record',
    ].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe('real.ts');
  });
});

describe('summariseSpan', () => {
  it('counts only lines inside the span', () => {
    const fc = parseLcov(
      ['SF:x.ts', 'DA:1,1', 'DA:5,0', 'DA:8,2', 'DA:20,0', 'end_of_record'].join('\n')
    )[0]!;
    // Span 1..10 includes lines 1, 5, 8 — line 20 is outside.
    const s = summariseSpan(fc, 1, 10);
    expect(s.totalLines).toBe(3);
    expect(s.coveredLines).toBe(2); // lines 1 and 8 hit
  });

  it('reports 0/0 when the span has no executable lines', () => {
    const fc = parseLcov(['SF:x.ts', 'DA:50,1', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, 1, 10);
    expect(s.totalLines).toBe(0);
    expect(s.coveredLines).toBe(0);
  });

  it('rolls up branch data inside the span', () => {
    const fc = parseLcov(
      [
        'SF:x.ts',
        'DA:5,1',
        'BRDA:5,0,0,1',
        'BRDA:5,0,1,-',
        'end_of_record',
      ].join('\n')
    )[0]!;
    const s = summariseSpan(fc, 1, 10);
    expect(s.totalBranches).toBe(2);
    expect(s.coveredBranches).toBe(1);
  });
});

describe('end-to-end ingestion through CodeGraph', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('ingests an lcov report and exposes coverage on the joined graph', async () => {
    // Project: a single file with two functions on different lines.
    const src = `export function alpha(): number {
  return 1;
}

export function beta(x: number): number {
  if (x > 0) {
    return x;
  }
  return -x;
}
`;
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'sample.ts'), src);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cov-test', version: '0.0.0' })
    );

    // alpha (lines 1-3) fully covered; beta (lines 5-10) partially:
    // line 6 if-test taken; line 7 (return x) hit; line 9 (return -x) not hit.
    const lcov = [
      'SF:src/sample.ts',
      'DA:1,1',
      'DA:2,1',
      'DA:5,1',
      'DA:6,1',
      'DA:7,1',
      'DA:9,0',
      'BRDA:6,0,0,1',
      'BRDA:6,0,1,-',
      'end_of_record',
    ].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      const idx = await cg.indexAll({ summarize: false });
      expect(idx.success).toBe(true);

      const result = await cg.ingestCoverage(lcovPath);
      expect(result.filesMatched).toBe(1);
      expect(result.filesUnmatched).toBe(0);
      expect(result.symbolsUpdated).toBeGreaterThanOrEqual(2);

      const ranked = cg.getCoverageRanked({ kinds: ['function'], limit: 10 });
      const byName = new Map(ranked.map((r) => [r.name, r]));
      const alpha = byName.get('alpha');
      const beta = byName.get('beta');
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      // alpha: 2/2 covered; beta: 3/4 covered (line 9 missed).
      expect(alpha!.pct).toBe(1);
      expect(beta!.pct).toBeLessThan(1);
      expect(beta!.coveredLines).toBe(3);
      expect(beta!.totalLines).toBe(4);

      const stats = cg.getCoverageStats();
      expect(stats.symbolsWithCoverage).toBeGreaterThanOrEqual(2);
      expect(stats.weightedPct).toBeGreaterThan(0.5);
      expect(stats.weightedPct).toBeLessThan(1);
    } finally {
      cg.destroy();
    }
  });

  it('is idempotent under the same source key', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function f(): number { return 1; }\n`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cov-idem', version: '0.0.0' })
    );
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const r1 = await cg.ingestCoverage(lcovPath);
      const r2 = await cg.ingestCoverage(lcovPath);
      expect(r1.symbolsUpdated).toBe(r2.symbolsUpdated);
      const stats = cg.getCoverageStats();
      // Re-running same source overwrites — count unchanged.
      expect(stats.symbolsWithCoverage).toBe(r1.symbolsUpdated);
    } finally {
      cg.destroy();
    }
  });

  it('matches monorepo-style paths via suffix lookup', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function f(): number { return 1; }\n`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cov-monorepo', version: '0.0.0' })
    );
    // Report uses `packages/api/src/a.ts` but project is rooted at
    // `packages/api`, so the indexed path is `src/a.ts`.
    const lcov = ['SF:packages/api/src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.ingestCoverage(lcovPath);
      expect(result.filesMatched).toBe(1);
      expect(result.filesUnmatched).toBe(0);
    } finally {
      cg.destroy();
    }
  });

  it('clearSource drops stale rows from prior ingestions', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function f(): number { return 1; }\nexport function g(): number { return 2; }\n`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cov-clear', version: '0.0.0' })
    );

    // First report covers both functions.
    const fullLcov = [
      'SF:src/a.ts',
      'DA:1,1',
      'DA:2,1',
      'end_of_record',
    ].join('\n');
    // Second report only covers the first function (file was excluded
    // from the run from line 2 onward) — simulates a scope narrowing.
    const partialLcov = [
      'SF:src/a.ts',
      'DA:1,1',
      'end_of_record',
    ].join('\n');
    const fullPath = path.join(dir, 'full.info');
    const partialPath = path.join(dir, 'partial.info');
    fs.writeFileSync(fullPath, fullLcov);
    fs.writeFileSync(partialPath, partialLcov);

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(fullPath);
      const beforeStats = cg.getCoverageStats();
      const beforeCount = beforeStats.symbolsWithCoverage;
      expect(beforeCount).toBeGreaterThanOrEqual(2);

      // Second ingestion WITHOUT clearSource: stale row for second
      // function persists.
      await cg.ingestCoverage(partialPath);
      const afterStats = cg.getCoverageStats();
      expect(afterStats.symbolsWithCoverage).toBe(beforeCount);

      // With clearSource: stale rows dropped.
      await cg.ingestCoverage(partialPath, { clearSource: true });
      const clearedStats = cg.getCoverageStats();
      expect(clearedStats.symbolsWithCoverage).toBeLessThan(beforeCount);
    } finally {
      cg.destroy();
    }
  });

  it('keeps independent rows for different source keys', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function f(): number { return 1; }\n`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cov-multi', version: '0.0.0' })
    );
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath, { source: 'unit' });
      await cg.ingestCoverage(lcovPath, { source: 'e2e' });
      const stats = cg.getCoverageStats();
      expect(stats.sources.sort()).toEqual(['e2e', 'unit']);
    } finally {
      cg.destroy();
    }
  });
});
