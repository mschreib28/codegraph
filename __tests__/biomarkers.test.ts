/**
 * Biomarker engine + end-to-end orchestration tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import {
  computeMetrics,
  evaluateRules,
  findNodeAt,
  codeHealthScore,
} from '../src/biomarkers';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-biomarkers-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('engine: computeMetrics', () => {
  it('counts cyclomatic complexity from branches', () => {
    const src = `function f(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  for (let i = 0; i < 10; i++) {
    if (i === x) return i;
  }
  return 0;
}`;
    const node = findNodeAt(src, 'typescript', 1, 0);
    expect(node).not.toBeNull();
    const m = computeMetrics(node!, 'typescript', 1, 7);
    // Base 1 + 3 if + 1 for + 1 if-inside-for = 6. Expect close to that.
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('tracks max nesting depth', () => {
    const src = `function f(): number {
  if (true) {
    while (true) {
      for (;;) {
        if (false) {
          return 1;
        }
      }
    }
  }
  return 0;
}`;
    const node = findNodeAt(src, 'typescript', 1, 0);
    expect(node).not.toBeNull();
    const m = computeMetrics(node!, 'typescript', 1, 11);
    expect(m.maxNesting).toBeGreaterThanOrEqual(4);
  });

  it('reports loc as inclusive line span', () => {
    const src = `function tiny() { return 1; }`;
    const node = findNodeAt(src, 'typescript', 1, 0);
    expect(node).not.toBeNull();
    const m = computeMetrics(node!, 'typescript', 1, 1);
    expect(m.loc).toBe(1);
  });

  it('returns base metrics for an unsupported language', () => {
    // No real AST node — pass a stub. The function should bail before
    // touching the node when no LangMap exists.
    const stub = { type: 'fake', childCount: 0, child: () => null } as any;
    const m = computeMetrics(stub, 'unknown' as any, 1, 10);
    expect(m.loc).toBe(10);
    expect(m.cyclomatic).toBe(1);
    expect(m.maxNesting).toBe(0);
  });
});

describe('engine: evaluateRules', () => {
  it('emits no findings for healthy metrics', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: { loc: 20, cyclomatic: 3, maxNesting: 1, maxConditionalOperands: 1 },
    });
    expect(findings).toEqual([]);
  });

  it('emits Large Method when loc exceeds threshold', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: { loc: 250, cyclomatic: 3, maxNesting: 1, maxConditionalOperands: 1 },
    });
    const lm = findings.find((f) => f.biomarker === 'large_method');
    expect(lm).toBeDefined();
    expect(lm!.severity).toBe('error');
    expect(lm!.metric).toBe(250);
  });

  it('emits Brain Method when all 3 prereqs fire at warning+', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: { loc: 150, cyclomatic: 20, maxNesting: 5, maxConditionalOperands: 3 },
    });
    expect(findings.some((f) => f.biomarker === 'brain_method')).toBe(true);
    const brain = findings.find((f) => f.biomarker === 'brain_method')!;
    expect(brain.severity).toBe('error');
    const detail = brain.detail as { loc: number; cyclomatic: number; maxNesting: number };
    expect(detail.loc).toBe(150);
    expect(detail.cyclomatic).toBe(20);
  });

  it('does NOT emit Brain Method when only one prereq fires', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      // Only loc warning; cyclomatic and nesting low.
      metrics: { loc: 150, cyclomatic: 5, maxNesting: 1, maxConditionalOperands: 1 },
    });
    expect(findings.some((f) => f.biomarker === 'brain_method')).toBe(false);
  });
});

describe('codeHealthScore', () => {
  it('returns 10 for no findings', () => {
    expect(codeHealthScore([])).toBe(10);
  });

  it('drops by 2 per error', () => {
    expect(codeHealthScore([{ severity: 'error' }])).toBe(8);
    expect(codeHealthScore([{ severity: 'error' }, { severity: 'error' }])).toBe(6);
  });

  it('drops by 1 per warning, 0.5 per info', () => {
    expect(codeHealthScore([{ severity: 'warning' }])).toBe(9);
    expect(codeHealthScore([{ severity: 'info' }])).toBe(9.5);
  });

  it('floors at 1', () => {
    const many = Array(20).fill({ severity: 'error' as const });
    expect(codeHealthScore(many)).toBe(1);
  });
});

describe('end-to-end through CodeGraph', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('runs the biomarker hook on indexAll and persists findings', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    // Deliberately gnarly: long, deeply nested, branchy.
    const gnarly = [
      'export function bigUgly(x: number, y: number): number {',
      '  let result = 0;',
      ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i} && y === ${i}) result += ${i};`),
      '  if (x > 0) {',
      '    if (y > 0) {',
      '      for (let i = 0; i < 10; i++) {',
      '        if (i % 2 === 0) {',
      '          while (i < 5) {',
      '            if (result === 42) {',
      '              return i;',
      '            }',
      '            break;',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return result;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'gnarly.ts'), gnarly);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-e2e', version: '0.0.0' })
    );

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      const idx = await cg.indexAll({ summarize: false });
      expect(idx.success).toBe(true);

      const stats = cg.getFindingsStats();
      expect(stats.totalFindings).toBeGreaterThan(0);
      expect(stats.nodesWithFindings).toBeGreaterThan(0);

      const ranked = cg.getFindingsRanked({ minSeverity: 'warning', limit: 50 });
      expect(ranked.length).toBeGreaterThan(0);
      const onBigUgly = ranked.filter((r) => r.name === 'bigUgly');
      expect(onBigUgly.length).toBeGreaterThan(0);
      // Should hit at least one of: large_method, complex_method, brain_method.
      const expectedBiomarkers = new Set(['large_method', 'complex_method', 'brain_method']);
      expect(onBigUgly.some((f) => expectedBiomarkers.has(f.biomarker))).toBe(true);
    } finally {
      cg.destroy();
    }
  });

  it('clean code produces no findings', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'clean.ts'),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function double(n: number): number {
  return n * 2;
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-clean', version: '0.0.0' })
    );

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const stats = cg.getFindingsStats();
      expect(stats.totalFindings).toBe(0);
    } finally {
      cg.destroy();
    }
  });

  it('clears stale findings when a function is refactored clean', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const filePath = path.join(dir, 'src', 'fixme.ts');
    // Initial: 250-line monster that triggers Large Method.
    fs.writeFileSync(
      filePath,
      `export function ugly(x: number): number {\n${Array.from({ length: 250 }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n')}\n  return -1;\n}`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-stale', version: '0.0.0' })
    );

    const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const before = cg.getFindingsStats();
      expect(before.totalFindings).toBeGreaterThan(0);

      // Refactor the function to be clean. Re-sync.
      fs.writeFileSync(
        filePath,
        `export function ugly(x: number): number {\n  return x;\n}\n`
      );
      await cg.sync({ summarize: false });

      const after = cg.getFindingsStats();
      // The previously-flagged function is now clean: zero findings on
      // its node. (Other nodes in the same file would also have been
      // re-evaluated.)
      expect(after.totalFindings).toBeLessThanOrEqual(before.totalFindings);
      const ranked = cg.getFindingsRanked({ minSeverity: 'info', limit: 100 });
      expect(ranked.find((r) => r.name === 'ugly')).toBeUndefined();
    } finally {
      cg.destroy();
    }
  });

  it('does not inflate conditional operand count from inner callbacks', async () => {
    // The outer `if`'s condition is a single call expression. Without
    // the FUNCTION_CONTAINER_KINDS guard in countConditionalOperands,
    // the `&&` and operands inside the lambda would inflate the count.
    const src = `function f(arr: Array<{a: number; b: number}>): boolean {
  if (arr.find(x => x.a > 0 && x.b > 0 && x.a !== x.b)) {
    return true;
  }
  return false;
}`;
    const node = findNodeAt(src, 'typescript', 1, 0);
    expect(node).not.toBeNull();
    const m = computeMetrics(node!, 'typescript', 1, 6);
    // The OUTER conditional has roughly 1-2 operands (arr.find call).
    // Inner lambda has 5+. We want the outer count, not the inner.
    expect(m.maxConditionalOperands).toBeLessThan(5);
  });

  it('respects enableBiomarkers: false', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const gnarly = Array.from({ length: 250 }, (_, i) => `  if (x === ${i}) return ${i};`);
    fs.writeFileSync(
      path.join(dir, 'src', 'gnarly.ts'),
      `export function ugly(x: number): number {\n${gnarly.join('\n')}\n  return -1;\n}`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-disabled', version: '0.0.0' })
    );

    const cg = await CodeGraph.init(dir, {
      config: { llm: { endpoint: '' }, enableBiomarkers: false },
    });
    try {
      await cg.indexAll({ summarize: false });
      const stats = cg.getFindingsStats();
      expect(stats.totalFindings).toBe(0);
    } finally {
      cg.destroy();
    }
  });
});
