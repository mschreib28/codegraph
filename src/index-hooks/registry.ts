/**
 * Index-hook registry.
 *
 * Adding a new derived-signal pass:
 *
 *   1. Create `src/index-hooks/<name>.ts` exporting a
 *      `HOOK: IndexHook` constant with `afterIndexAll` and/or
 *      `afterSync` implementations.
 *   2. Add **one** import line and **one** array entry to this file.
 *
 * That's it. `CodeGraph` doesn't need a new private method or
 * call site for each pass — the runner inside `runHooks*` walks
 * every registered hook automatically.
 *
 * On main today there are NO hooks registered (this file ships
 * the framework only). PRs adding derived-signal passes
 * (centrality, churn, issue-history, config-refs, sql-refs,
 * cochange) each register their hook here.
 */

import type { IndexHook, IndexHookContext, IndexHookOutcome } from './types';
import type { SyncResult } from '../extraction';
import { logDebug } from '../errors';

import { HOOK as CENTRALITY_HOOK } from './centrality';
import { HOOK as CHURN_HOOK } from './churn';
import { HOOK as ISSUE_HISTORY_HOOK } from './issue-history';

/**
 * Static-import list of every registered hook.
 *
 * Two PRs adding hooks land their entries on different lines
 * (alphabetical neighborhoods rarely collide). When an entry is
 * unwanted at runtime, the hook itself can short-circuit on a
 * config flag inside its `afterIndexAll`/`afterSync`.
 */
const REGISTERED_HOOKS: readonly IndexHook[] = [
  CENTRALITY_HOOK,
  CHURN_HOOK,
  ISSUE_HISTORY_HOOK,
];

/**
 * Run `afterIndexAll` for every registered hook. Errors are
 * caught + logged so one broken hook never fails the whole
 * index. Returns per-hook outcomes for diagnostics.
 */
export async function runAfterIndexAll(
  ctx: IndexHookContext
): Promise<IndexHookOutcome[]> {
  const out: IndexHookOutcome[] = [];
  for (const hook of REGISTERED_HOOKS) {
    if (!hook.afterIndexAll) continue;
    const start = Date.now();
    try {
      await hook.afterIndexAll(ctx);
      out.push({ name: hook.name, phase: 'indexAll', durationMs: Date.now() - start });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logDebug(`index-hook "${hook.name}" afterIndexAll failed: ${e.message}`);
      out.push({ name: hook.name, phase: 'indexAll', durationMs: Date.now() - start, error: e });
    }
  }
  return out;
}

/** Same shape, for `afterSync`. */
export async function runAfterSync(
  ctx: IndexHookContext,
  result: SyncResult
): Promise<IndexHookOutcome[]> {
  const out: IndexHookOutcome[] = [];
  for (const hook of REGISTERED_HOOKS) {
    if (!hook.afterSync) continue;
    const start = Date.now();
    try {
      await hook.afterSync(ctx, result);
      out.push({ name: hook.name, phase: 'sync', durationMs: Date.now() - start });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logDebug(`index-hook "${hook.name}" afterSync failed: ${e.message}`);
      out.push({ name: hook.name, phase: 'sync', durationMs: Date.now() - start, error: e });
    }
  }
  return out;
}

/** Read access for tests + diagnostic tools. */
export function getRegisteredHooks(): readonly IndexHook[] {
  return REGISTERED_HOOKS;
}

// Re-export the types so consumers can import everything from one place.
export type { IndexHook, IndexHookContext, IndexHookOutcome } from './types';
