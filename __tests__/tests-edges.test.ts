/**
 * Tests-as-Edges Tests
 *
 * Verifies the convention-based test→subject file resolver and the
 * `tests` edges it produces:
 *   - All recognized test naming conventions (Jest/Vitest, pytest,
 *     Go, RSpec, JUnit/xUnit, Quick/Spek)
 *   - The four-step resolution strategy (co-located, mirrored,
 *     common source roots, basename-anywhere)
 *   - End-to-end via CodeGraph: indexAll populates `tests` edges,
 *     sync incrementally refreshes them, getTestsForFile and
 *     getSubjectsOfTest return the expected file records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  testSubjectBasename,
  isTestFile,
  findTestSubjects,
} from '../src/tests-edges';
import CodeGraph from '../src/index';

describe('testSubjectBasename', () => {
  it('recognizes JS/TS .test and .spec suffixes', () => {
    expect(testSubjectBasename('foo.test.ts')).toBe('foo');
    expect(testSubjectBasename('foo.spec.tsx')).toBe('foo');
    expect(testSubjectBasename('Bar.test.js')).toBe('Bar');
    expect(testSubjectBasename('a/b/foo.test.mjs')).toBe('foo');
  });

  it('recognizes Python pytest test_foo style', () => {
    expect(testSubjectBasename('test_foo.py')).toBe('foo');
    expect(testSubjectBasename('pkg/test_handlers.py')).toBe('handlers');
  });

  it('recognizes Go and Rust foo_test style', () => {
    expect(testSubjectBasename('foo_test.go')).toBe('foo');
    expect(testSubjectBasename('foo_test.rs')).toBe('foo');
  });

  it('recognizes Ruby foo_spec / foo_test style', () => {
    expect(testSubjectBasename('foo_spec.rb')).toBe('foo');
    expect(testSubjectBasename('foo_test.rb')).toBe('foo');
  });

  it('recognizes xUnit FooTest / FooTests', () => {
    expect(testSubjectBasename('FooTest.java')).toBe('Foo');
    expect(testSubjectBasename('FooTests.cs')).toBe('Foo');
    expect(testSubjectBasename('FooTest.kt')).toBe('Foo');
  });

  it('recognizes Quick/Spek FooSpec', () => {
    expect(testSubjectBasename('FooSpec.swift')).toBe('Foo');
    expect(testSubjectBasename('FooSpec.kt')).toBe('Foo');
  });

  it('returns null for non-test files', () => {
    expect(testSubjectBasename('foo.ts')).toBeNull();
    expect(testSubjectBasename('handler.py')).toBeNull();
    expect(testSubjectBasename('README.md')).toBeNull();
    // Doesn't false-positive on similar-looking names
    expect(testSubjectBasename('contest.ts')).toBeNull();
    expect(testSubjectBasename('untested.go')).toBeNull();
  });
});

describe('isTestFile', () => {
  it('agrees with testSubjectBasename', () => {
    expect(isTestFile('foo.test.ts')).toBe(true);
    expect(isTestFile('foo.ts')).toBe(false);
  });
});

describe('findTestSubjects (resolver strategies)', () => {
  it('1. co-located: foo/foo.test.ts → foo/foo.ts', () => {
    const all = new Set(['src/foo.ts', 'src/foo.test.ts']);
    expect(findTestSubjects('src/foo.test.ts', all)).toEqual(['src/foo.ts']);
  });

  it('1b. co-located: foo/bar.test.ts → foo/bar/index.ts', () => {
    const all = new Set(['src/bar/index.ts', 'src/bar.test.ts']);
    expect(findTestSubjects('src/bar.test.ts', all)).toEqual(['src/bar/index.ts']);
  });

  it('2. mirrored: foo/__tests__/bar.test.ts → foo/bar.ts', () => {
    const all = new Set(['src/bar.ts', 'src/__tests__/bar.test.ts']);
    expect(findTestSubjects('src/__tests__/bar.test.ts', all)).toEqual(['src/bar.ts']);
  });

  it('2b. mirrored to index: __tests__/sync.test.ts → src/sync/index.ts', () => {
    // Top-level __tests__ doesn't translate to a sibling source root, so
    // the resolver falls through to step 3 (common source roots).
    const all = new Set(['src/sync/index.ts', '__tests__/sync.test.ts']);
    expect(findTestSubjects('__tests__/sync.test.ts', all)).toEqual(['src/sync/index.ts']);
  });

  it('3. common source roots: __tests__/handler.test.ts → lib/handler.ts', () => {
    const all = new Set(['lib/handler.ts', '__tests__/handler.test.ts']);
    expect(findTestSubjects('__tests__/handler.test.ts', all)).toEqual(['lib/handler.ts']);
  });

  it('4. basename-anywhere with prefix-tiebreaker', () => {
    const all = new Set([
      'packages/auth/utils.ts',
      'packages/billing/utils.ts',
      'packages/auth/utils.test.ts',
    ]);
    // Co-located resolves first → utils.ts in auth wins by directory.
    expect(findTestSubjects('packages/auth/utils.test.ts', all))
      .toEqual(['packages/auth/utils.ts']);
  });

  it('returns [] for tests with no matching subject', () => {
    const all = new Set(['__tests__/integration.test.ts']);
    expect(findTestSubjects('__tests__/integration.test.ts', all)).toEqual([]);
  });

  it('returns [] for non-test files', () => {
    const all = new Set(['src/foo.ts']);
    expect(findTestSubjects('src/foo.ts', all)).toEqual([]);
  });

  it('does not edge a test file back to itself', () => {
    // Pathological: a file matching the test pattern that also happens
    // to live where its "subject" would resolve. Should never produce a
    // self-edge.
    const all = new Set(['src/foo.test.ts']);
    expect(findTestSubjects('src/foo.test.ts', all)).toEqual([]);
  });

  it('handles tsx test files preferring tsx subject before ts', () => {
    const all = new Set(['src/Component.tsx', 'src/Component.test.tsx']);
    expect(findTestSubjects('src/Component.test.tsx', all))
      .toEqual(['src/Component.tsx']);
  });

  it('matches Go _test convention to subject .go', () => {
    const all = new Set(['internal/handler.go', 'internal/handler_test.go']);
    expect(findTestSubjects('internal/handler_test.go', all))
      .toEqual(['internal/handler.go']);
  });

  it('matches Python test_ convention to subject .py', () => {
    const all = new Set(['app/handlers.py', 'tests/test_handlers.py']);
    expect(findTestSubjects('tests/test_handlers.py', all))
      .toEqual(['app/handlers.py']);
  });

  it('strips top-level tests/ prefix when computing the mirrored subject path', () => {
    // Regression: previously the mirroring regex only matched `/tests/`
    // (slash-prefixed), so a top-level `tests/` directory wasn't stripped
    // and the multi-root fallback (src/lib/app/...) never fired. With a
    // decoy `tests/handlers.py` present, the resolver would have wrongly
    // picked it via the basename-anywhere step instead of the real subject
    // under `lib/`.
    const all = new Set([
      'lib/handlers.py',
      'tests/handlers.py',         // decoy
      'tests/test_handlers.py',
    ]);
    expect(findTestSubjects('tests/test_handlers.py', all))
      .toContain('lib/handlers.py');
  });

  it('strips top-level spec/ prefix similarly', () => {
    const all = new Set(['app/order.rb', 'spec/order_spec.rb']);
    expect(findTestSubjects('spec/order_spec.rb', all))
      .toEqual(['app/order.rb']);
  });
});

describe('CodeGraph end-to-end (tests edges wired into indexAll/sync)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-edges-e2e-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'sync'));
    fs.mkdirSync(path.join(dir, '__tests__'));
    // Subject files
    fs.writeFileSync(path.join(dir, 'src', 'sync', 'index.ts'), 'export const sync = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'sync', 'watcher.ts'), 'export const watcher = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), 'export const utils = 1;');
    // Tests
    fs.writeFileSync(path.join(dir, '__tests__', 'sync.test.ts'), 'import { sync } from "../src/sync"; export {};');
    fs.writeFileSync(path.join(dir, 'src', 'sync', 'watcher.test.ts'), 'import { watcher } from "./watcher"; export {};');
    // Feature-themed test (no single subject)
    fs.writeFileSync(path.join(dir, '__tests__', 'integration.test.ts'), 'export {};');

    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexAll populates tests edges (mirrored layout: __tests__/sync.test.ts → src/sync/index.ts)', () => {
    const subjects = cg.getSubjectsOfTest('__tests__/sync.test.ts');
    const paths = subjects.map((s) => s.path);
    expect(paths).toContain('src/sync/index.ts');
  });

  it('indexAll populates tests edges (co-located: src/sync/watcher.test.ts → src/sync/watcher.ts)', () => {
    const subjects = cg.getSubjectsOfTest('src/sync/watcher.test.ts');
    expect(subjects.map((s) => s.path)).toEqual(['src/sync/watcher.ts']);
  });

  it('getTestsForFile returns the test that covers a given subject (incoming edges)', () => {
    const tests = cg.getTestsForFile('src/sync/watcher.ts');
    expect(tests.map((t) => t.path)).toContain('src/sync/watcher.test.ts');
  });

  it('returns empty array for tests with no resolvable subject (no false-positive guesses)', () => {
    const subjects = cg.getSubjectsOfTest('__tests__/integration.test.ts');
    expect(subjects).toEqual([]);
  });

  it('returns empty array for non-test files queried as tests', () => {
    expect(cg.getSubjectsOfTest('src/sync/index.ts')).toEqual([]);
  });

  it('sync refreshes a test file\'s edges when its subject convention changes', async () => {
    // Add a new subject file and a co-located test for it. After sync,
    // the new test should have a `tests` edge to the new subject.
    fs.writeFileSync(path.join(dir, 'src', 'newmod.ts'), 'export const m = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'newmod.test.ts'), 'import "./newmod";');

    await cg.sync();
    const subjects = cg.getSubjectsOfTest('src/newmod.test.ts');
    expect(subjects.map((s) => s.path)).toEqual(['src/newmod.ts']);
  });

  it('sync removes stale edges when a subject file is deleted (FK cascade)', async () => {
    // The cascade is on the file *node* (kind='file' has nodes_fts triggers
    // and FK constraints from edges). When we sync after deleting the
    // subject, edges to it should disappear.
    fs.unlinkSync(path.join(dir, 'src', 'sync', 'watcher.ts'));
    await cg.sync();
    const subjects = cg.getSubjectsOfTest('src/sync/watcher.test.ts');
    expect(subjects.map((s) => s.path)).not.toContain('src/sync/watcher.ts');
  });
});
