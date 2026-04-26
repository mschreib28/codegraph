/**
 * Tests-as-edges
 *
 * Convention-based test → subject file resolution. Walks every indexed
 * file, identifies test files via filename pattern, and resolves each
 * test to the source file(s) it tests. Resulting edges (kind: 'tests')
 * make `getTestsForFile(src)` and `getSubjectsOfTest(test)` one-call
 * lookups that previously required a grep through the codebase.
 *
 * Convention-only — does not look inside test bodies. Tests with no
 * obvious subject (multi-subject feature tests, project-wide harnesses)
 * are honestly left without edges rather than guessed at.
 */

import * as path from 'path';

/**
 * Source file extensions we treat as plausible test subjects.
 * Order matters: when both `foo.ts` and `foo.tsx` exist for a test
 * named `foo.test.tsx`, we prefer the matching extension first.
 */
const SOURCE_EXTS_BY_TEST_EXT: Record<string, string[]> = {
  ts: ['ts'],
  tsx: ['tsx', 'ts'],
  js: ['js'],
  jsx: ['jsx', 'js'],
  mjs: ['mjs', 'js'],
  cjs: ['cjs', 'js'],
  py: ['py'],
  rs: ['rs'],
  go: ['go'],
  rb: ['rb'],
  java: ['java'],
  kt: ['kt', 'kts'],
  cs: ['cs'],
  swift: ['swift'],
};

/**
 * Extract the "subject basename" from a test filename — i.e. the basename
 * of the source file we'd expect this test to be testing, with the
 * extension dropped. Returns null when the file isn't a test by any
 * recognized convention.
 *
 * Conventions handled:
 *   foo.test.{ts,tsx,js,jsx,mjs,cjs}        — JS/TS family (Jest, Vitest)
 *   foo.spec.{ts,tsx,js,jsx,mjs,cjs}        — same family, alt suffix
 *   test_foo.{py,rs}                        — Python pytest, Rust convention
 *   foo_test.{go,py,rs}                     — Go convention; alt for Python/Rust
 *   foo_{spec,test}.rb                      — Ruby (RSpec, Minitest)
 *   FooTest.{java,kt,cs,swift}              — xUnit
 *   FooTests.{java,kt,cs,swift}             — xUnit (plural)
 *   FooSpec.{swift,kt}                      — Quick (Swift), Spek (Kotlin)
 */
export function testSubjectBasename(filePath: string): string | null {
  const base = path.basename(filePath);

  // foo.test.ts / foo.spec.ts (JS/TS family)
  let m = base.match(/^(.+?)\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/);
  if (m) return m[1]!;

  // test_foo.py / test_foo.rs
  m = base.match(/^test_(.+?)\.(py|rs)$/);
  if (m) return m[1]!;

  // foo_test.go / foo_test.py / foo_test.rs
  m = base.match(/^(.+?)_test\.(go|py|rs)$/);
  if (m) return m[1]!;

  // foo_spec.rb / foo_test.rb
  m = base.match(/^(.+?)_(spec|test)\.rb$/);
  if (m) return m[1]!;

  // FooTest.java / FooTests.java (xUnit-style; trailing s optional)
  m = base.match(/^(.+?)Tests?\.(java|kt|cs|swift)$/);
  if (m) return m[1]!;

  // FooSpec.swift / FooSpec.kt (Quick / Spek)
  m = base.match(/^(.+?)Spec\.(swift|kt)$/);
  if (m) return m[1]!;

  return null;
}

/**
 * True when `filePath` matches any test convention we recognize.
 */
export function isTestFile(filePath: string): boolean {
  return testSubjectBasename(filePath) !== null;
}

/**
 * Resolve a test file's subject source file(s) within the project. Returns
 * an array (zero, one, or more) of paths drawn from `allFiles`.
 *
 * Strategy, applied in order; later steps run only if earlier ones miss:
 *
 *   1. Co-located: `path/foo.test.ts` → `path/foo.ts` or `path/foo/index.ts`
 *      (handles e.g. `src/sync/watcher.test.ts` next to `src/sync/watcher.ts`).
 *   2. Mirrored layout: walk up dropping `__tests__` / `tests` / `spec`,
 *      then look for the subject directly or under `<dir>/index.<ext>`
 *      (handles `__tests__/sync.test.ts` → `src/sync/index.ts`).
 *   3. Common source roots: when the test sits at project root (no
 *      mirrored target), try `src/`, `lib/`, `app/`, `packages/`.
 *   4. Anywhere by basename: if still unresolved, find files by basename
 *      match and pick the one whose directory shares the longest path
 *      prefix with the test file.
 *
 * Returns an empty array when the test has no obvious subject. We
 * deliberately do NOT guess — feature-themed tests like `security.test.ts`
 * legitimately span multiple files and shouldn't be edged to one of them.
 */
export function findTestSubjects(testFile: string, allFiles: Set<string>): string[] {
  const subject = testSubjectBasename(testFile);
  if (!subject) return [];

  const dir = path.posix.dirname(testFile);
  const testExt = path.extname(testFile).slice(1).toLowerCase();
  const sourceExts = SOURCE_EXTS_BY_TEST_EXT[testExt] ?? [testExt];
  const candidates = new Set<string>();

  // 1. Co-located.
  for (const ext of sourceExts) {
    const direct = path.posix.join(dir, `${subject}.${ext}`);
    if (allFiles.has(direct) && direct !== testFile) candidates.add(direct);
    const indexed = path.posix.join(dir, subject, `index.${ext}`);
    if (allFiles.has(indexed)) candidates.add(indexed);
  }

  // 2. Mirrored — strip __tests__ anywhere, plus a leading or interior
  //    `tests/`, `test/`, or `spec/` segment. The leading-anchored pass
  //    catches top-level test directories like `tests/test_handlers.py`
  //    that the slash-prefixed pattern alone would miss (no leading `/`).
  const mirrored = dir
    .replace(/__tests__\/?/g, '')
    .replace(/^(?:tests?|spec)(\/|$)/, '')
    .replace(/\/(?:tests?|spec)(\/|$)/g, '/')
    .replace(/\/+$/, '');

  // 3. Common source roots when the mirrored path collapsed to empty.
  const sourceRoots = mirrored ? [mirrored] : ['.', 'src', 'lib', 'app', 'packages'];
  for (const root of sourceRoots) {
    for (const ext of sourceExts) {
      const direct = path.posix.join(root, `${subject}.${ext}`);
      if (allFiles.has(direct)) candidates.add(direct);
      const indexed = path.posix.join(root, subject, `index.${ext}`);
      if (allFiles.has(indexed)) candidates.add(indexed);
    }
  }

  // 4. Anywhere by basename + closest path-prefix match.
  if (candidates.size === 0) {
    const matches: string[] = [];
    for (const f of allFiles) {
      const ext = path.extname(f).slice(1).toLowerCase();
      if (!sourceExts.includes(ext)) continue;
      const fBase = path.basename(f, path.extname(f));
      if (fBase === subject && f !== testFile) matches.push(f);
    }
    if (matches.length === 1) {
      candidates.add(matches[0]!);
    } else if (matches.length > 1) {
      const dirParts = dir.split('/');
      let best = matches[0]!;
      let bestCommon = -1;
      for (const f of matches) {
        const fParts = path.posix.dirname(f).split('/');
        let common = 0;
        for (let i = 0; i < Math.min(dirParts.length, fParts.length); i++) {
          if (dirParts[i] === fParts[i]) common++;
          else break;
        }
        if (common > bestCommon) {
          best = f;
          bestCommon = common;
        }
      }
      candidates.add(best);
    }
  }

  return [...candidates];
}
