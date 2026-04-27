/**
 * Default project configuration.
 *
 * Lives in its own file (separate from `types.ts`) because the
 * `include` glob list is derived from the language registry — and
 * the registry transitively imports `types.ts` via per-language
 * files, which would create an evaluation cycle if `default-config`
 * were itself imported by `types.ts` eagerly.
 *
 * **Lazy include resolution.** The `include` array is built on
 * first access via a property getter, not at module load. By the
 * time anything reads `DEFAULT_CONFIG.include`, the registry has
 * fully evaluated, so all language definitions are available.
 */

import type { CodeGraphConfig } from './types';
import { getLanguageDefs } from './extraction/languages/registry';

let _includeCache: string[] | null = null;
function buildIncludeGlobs(): string[] {
  if (_includeCache) return _includeCache;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const def of getLanguageDefs()) {
    for (const glob of def.includeGlobs) {
      if (seen.has(glob)) continue;
      seen.add(glob);
      out.push(glob);
    }
  }
  _includeCache = out;
  return out;
}

const baseConfig: CodeGraphConfig = {
  version: 1,
  rootDir: '.',
  include: [], // populated lazily via the getter below
  exclude: [
    // Version control
    '**/.git/**',

    // Dependencies
    '**/node_modules/**',
    '**/vendor/**',
    '**/Pods/**',

    // Generic build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/bin/**',
    '**/obj/**',
    '**/target/**',

    // JavaScript/TypeScript
    '**/*.min.js',
    '**/*.bundle.js',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.output/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.vite/**',
    '**/.astro/**',
    '**/.docusaurus/**',
    '**/.gatsby/**',
    '**/.webpack/**',
    '**/.nx/**',
    '**/.yarn/cache/**',
    '**/.pnpm-store/**',
    '**/storybook-static/**',

    // React Native / Expo
    '**/.expo/**',
    '**/web-build/**',
    '**/ios/Pods/**',
    '**/ios/build/**',
    '**/android/build/**',
    '**/android/.gradle/**',

    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/site-packages/**',
    '**/dist-packages/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',
    '**/.eggs/**',

    // Go
    '**/go/pkg/mod/**',

    // Rust
    '**/target/debug/**',
    '**/target/release/**',

    // Java/Kotlin/Gradle
    '**/.gradle/**',
    '**/.m2/**',
    '**/generated-sources/**',
    '**/.kotlin/**',

    // Dart/Flutter
    '**/.dart_tool/**',

    // C#/.NET
    '**/.vs/**',
    '**/.nuget/**',
    '**/artifacts/**',
    '**/publish/**',

    // C/C++
    '**/cmake-build-*/**',
    '**/CMakeFiles/**',
    '**/bazel-*/**',
    '**/vcpkg_installed/**',
    '**/.conan/**',
    '**/Debug/**',
    '**/Release/**',
    '**/x64/**',
    '**/.pio/**',  // Platform.io (IoT/embedded build artifacts and library deps)

    // Electron
    '**/release/**',
    '**/*.app/**',
    '**/*.asar',

    // Swift/iOS/Xcode
    '**/DerivedData/**',
    '**/.build/**',
    '**/.swiftpm/**',
    '**/xcuserdata/**',
    '**/Carthage/Build/**',
    '**/SourcePackages/**',

    // Delphi/Pascal
    '**/__history/**',
    '**/__recovery/**',
    '**/*.dcu',

    // PHP
    '**/.composer/**',
    '**/storage/framework/**',
    '**/bootstrap/cache/**',

    // Ruby
    '**/.bundle/**',
    '**/tmp/cache/**',
    '**/public/assets/**',
    '**/public/packs/**',
    '**/.yardoc/**',

    // Testing/Coverage
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',
    '**/test-results/**',
    '**/.coverage/**',

    // IDE/Editor
    '**/.idea/**',

    // Logs and temp
    '**/logs/**',
    '**/tmp/**',
    '**/temp/**',

    // Documentation build output
    '**/_build/**',
    '**/docs/_build/**',
    '**/site/**',
  ],
  languages: [],
  frameworks: [],
  maxFileSize: 1024 * 1024, // 1MB
  extractDocstrings: true,
  trackCallSites: true,
  enableCentrality: true,
  enableChurn: true,
  enableIssueHistory: true,
  enableConfigRefs: true,
};

Object.defineProperty(baseConfig, 'include', {
  get: () => buildIncludeGlobs(),
  enumerable: true,
  configurable: true,
});

export const DEFAULT_CONFIG: CodeGraphConfig = baseConfig;
