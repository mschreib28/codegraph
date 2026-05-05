# Changelog

All notable changes to this project will be documented in this file.

This package (`@mschreib28/codegraph`) is a maintained fork of
[`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph).
Upstream changes are rebased into this fork as they land on the upstream `main`
branch. Fork-specific additions are listed below under each release.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.7.4] — 2026-05-05

### Changed

- **Eliminated all 3 circular dependency cycles** (verified via `madge`):
  - Extracted `CodeGraph` class into `src/codegraph.ts`, converting
    `src/index.ts` into a pure barrel — breaks the `index ↔ mcp/index ↔
    mcp/tools` cycle.
  - Extracted `extractFromSource` dispatcher into
    `src/extraction/extract-dispatcher.ts` — breaks the `tree-sitter ↔
    svelte-extractor` cycle.
- **Reduced cyclomatic complexity** across 6 high-CC functions:
  - `mergeAndRerank` (CC 45 → ~10) — decomposed into `deduplicateAndMerge`,
    `boostTermGroupMatches`, `addCamelCaseDefinitions`,
    `addCompoundTermMatches`.
  - `applyBudgetCaps` (CC 24 → ~8) — decomposed into `capTotalNodes`,
    `capNodesPerFile`, `capNonProductionNodes`, `recoverEdgesBetweenNodes`.
  - `isBuiltInOrExternal` (CC 27 → ~5) — replaced language-specific if-chain
    with a `BUILT_IN_CHECKERS` dispatch table.
  - `indexAll` (CC 29 → ~15) — extracted `makeAbortResult` and `processFile`
    helpers.
  - `extractImport` (CC 26 → ~12) — extracted `extractPythonMultiImport`,
    `extractGoImports`, `extractPhpGroupedImport`.
  - `matchMethodCall` (CC 26 → ~10) — extracted `matchDirectClassMethod`,
    `matchCapitalizedReceiverMethod`, `matchByMethodNameSearch`.
- Improved grammar load error messages: `TreeSitterExtractor` now reports
  whether the WASM file was missing or the grammar failed to load, and the
  CLI error breakdown surfaces the root cause with a "try `npm rebuild`" hint.

### Fixed

- **Test worker OOM crash** — extraction tests loading 15+ tree-sitter WASM
  grammars would exhaust V8's Turboshaft compiler Zone memory during
  background tier-up, crashing the vitest fork after all tests passed. Fixed
  by passing `--liftoff-only` to vitest fork workers (baseline WASM compiler
  only, no Turboshaft optimization) and adding `clearParserCache()` teardown.

---

## [0.7.3] — 2026-05-05

> Forked from upstream `0.7.2` (`1cf5ccf`). All changes below are
> additions on top of the upstream baseline.

### Added

- **`codegraph complexity [path]`** — new CLI command that computes cyclomatic
  complexity for every language codegraph already parses (Python, TypeScript,
  JavaScript, Go, Rust, Java, C/C++, C#, PHP, Ruby, Swift, Kotlin, Dart,
  Pascal) using a native tree-sitter AST walk. No external tools required for
  any supported language.
- **`madge` integration** — optional fan-in / fan-out / circular-dependency
  metrics for JS/TS projects. Missing tool is auto-detected and skipped with a
  warning rather than failing the run.
- **Complexity web UI tab** — treemap and sortable-table views with language
  and risk-level filters. Risk is classified as low / medium / high / critical
  based on cyclomatic complexity thresholds.
- **`/api/complexity` and `/api/complexity/file/:path` server endpoints** —
  expose persisted complexity data for the web UI and external consumers.
- **`complexity_metrics` table** (schema v4) — stores per-function cyclomatic
  complexity with file, symbol name, language, tool, and timestamp.
- **`targetPath` option on `ComplexityAnalyzer.analyze()`** — restricts file
  scanning to a subdirectory relative to the project root. Only WASM grammars
  for languages actually present in that subtree are loaded, preventing
  unrelated parsers from being initialized (fixes WASM `Aborted()` crashes
  when running from a single-language subdirectory on Node 24).
- **Per-file analyzer warnings** — parse and read failures are collected as
  `AnalyzerWarning` objects and surfaced in the CLI summary and JSON output
  instead of being silently swallowed.
- Multi-select button group for risk-level filtering (replaces single dropdown).

### Changed

- Replaced the ESLint-based JS/TS complexity analyzer and the radon-based
  Python analyzer with a single **native AST analyzer** built on the
  tree-sitter grammars already bundled by codegraph. This removes the
  `eslint` and `radon` runtime dependencies and ensures consistent behaviour
  across all supported languages.
- `complexity` CLI: when called from a subdirectory, the target path is now
  computed relative to the project root and passed as `targetPath` to the
  analyzer, so only files within that subtree are processed.
- Rebranded package from `@colbymchenry/codegraph` to `@mschreib28/codegraph`
  in `package.json`, README, installer error messages, and uninstall script.

### Fixed

- **WASM `Aborted()` crash on Node 24** when running `codegraph complexity .`
  from a Python-only directory: the TypeScript WASM parser (2.2 MB) would
  crash the shared WASM runtime and poison all subsequent language parsers.
  Resolved by the `targetPath` scoping — only grammars for detected languages
  are loaded.
- `complexity_metrics` insert race: replaced multi-step clear + insert with an
  atomic `INSERT OR REPLACE` transaction and a `UNIQUE` constraint on
  `(file_path, symbol_name, start_line, tool, metric)`.
- Complexity file-path API endpoint: sanitized path parameter to prevent
  directory traversal; `port: 0` binding now resolves to an assigned port
  before being reported.
- Removed vulnerable transitive npm dependencies flagged by `npm audit`.

### Tests

- Full test suite for the native AST analyzer: base CC=1, if/switch/logical
  operators, nested function isolation, anonymous arrow functions, Python
  support, unsupported file types.
- Tests for atomic store, UNIQUE dedup constraint, `AnalyzerWarning`
  propagation, and path sanitization on the complexity API endpoint.

---

## [0.7.2] — upstream baseline

See the [upstream changelog](https://github.com/colbymchenry/codegraph) for
changes at and before `0.7.2`.
