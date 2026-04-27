/**
 * Language registry — central import + collection of every per-language
 * `LanguageDef`. Adding a new language is:
 *
 *   1. Create `src/extraction/languages/<name>.ts` exporting an
 *      `<NAME>_DEF: LanguageDef` constant.
 *   2. Add **one** import line and **one** array entry to this file.
 *
 * **That is the complete change list.** All consumers
 * (`grammars.ts`, `tree-sitter.ts`'s extractor lookup,
 * `default-config.ts`'s include globs, the legacy `EXTRACTORS`
 * barrel in `./index.ts`) all read from this registry — there is
 * no parallel list to keep in sync.
 *
 * This file is the only place a "central list" of languages lives,
 * so adjacent-line conflicts between PRs adding different languages
 * are limited to whichever alphabetical neighborhood they target.
 *
 * Note: an earlier draft used `fs.readdirSync` auto-discovery which
 * eliminated even this file, but `require()` of extensionless paths
 * doesn't work under vitest's vite-node loader for `.ts` source. A
 * generated-barrel build step would restore zero-list-edits and is
 * tracked as a follow-up.
 */

import type { LanguageDef } from './types';

// =====================================================================
// Imports — one per language, alphabetical by name
// =====================================================================
import { C_DEF, CPP_DEF } from './c-cpp';
import { CSHARP_DEF } from './csharp';
import { DART_DEF } from './dart';
import { GO_DEF } from './go';
import { HCL_DEF } from './hcl';
import { JAVA_DEF } from './java';
import { JAVASCRIPT_DEF } from './javascript';
import { JSX_DEF } from './jsx';
import { KOTLIN_DEF } from './kotlin';
import { LIQUID_DEF } from './liquid';
import { PASCAL_DEF } from './pascal';
import { PHP_DEF } from './php';
import { PYTHON_DEF } from './python';
import { R_DEF } from './r';
import { RESCRIPT_DEF } from './rescript';
import { RUBY_DEF } from './ruby';
import { RUST_DEF } from './rust';
import { SCALA_DEF } from './scala';
import { SQL_DEF } from './sql';
import { SVELTE_DEF } from './svelte';
import { SWIFT_DEF } from './swift';
import { TSX_DEF } from './tsx';
import { TYPESCRIPT_DEF } from './typescript';

// =====================================================================
// Registry — alphabetical by name
// =====================================================================
const ALL_DEFS: readonly LanguageDef[] = [
  C_DEF,
  CPP_DEF,
  CSHARP_DEF,
  DART_DEF,
  GO_DEF,
  HCL_DEF,
  JAVA_DEF,
  JAVASCRIPT_DEF,
  JSX_DEF,
  KOTLIN_DEF,
  LIQUID_DEF,
  PASCAL_DEF,
  PHP_DEF,
  PYTHON_DEF,
  R_DEF,
  RESCRIPT_DEF,
  RUBY_DEF,
  RUST_DEF,
  SCALA_DEF,
  SQL_DEF,
  SVELTE_DEF,
  SWIFT_DEF,
  TSX_DEF,
  TYPESCRIPT_DEF,
];

let byName: Map<string, LanguageDef> | null = null;
let byExtension: Map<string, LanguageDef> | null = null;

function ensureIndexes(): void {
  if (byName && byExtension) return;
  byName = new Map();
  byExtension = new Map();
  for (const def of ALL_DEFS) {
    byName.set(def.name, def);
    for (const ext of def.extensions) {
      byExtension.set(ext.toLowerCase(), def);
    }
  }
}

export function getLanguageDefs(): readonly LanguageDef[] {
  return ALL_DEFS;
}

export function getLanguageDefByName(name: string): LanguageDef | undefined {
  ensureIndexes();
  return byName!.get(name);
}

export function getLanguageDefByExtension(ext: string): LanguageDef | undefined {
  ensureIndexes();
  return byExtension!.get(ext.toLowerCase());
}

/** Reset cached indexes. Used by tests; no-op in production paths. */
export function _resetRegistryCacheForTests(): void {
  byName = null;
  byExtension = null;
}
