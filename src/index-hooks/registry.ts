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
import { logDebug, logWarn } from '../errors';

/**
 * Per-hook wall-clock budget. A hook awaiting a promise that never
 * resolves (timed-out fetch with no AbortController, mis-handled
 * worker IPC, etc.) used to hang the whole indexAll/sync forever.
 * After this budget the runner gives up on the hook, surfaces it as
 * a timeout in the outcome, and moves on so the rest of the pipeline
 * still completes. Five minutes is generous enough for legitimate
 * mining on a multi-million-LOC repo while bounding the worst case.
 */
const HOOK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Static-import list of every registered hook.
 *
 * Two PRs adding hooks land their entries on different lines
 * (alphabetical neighborhoods rarely collide). When an entry is
 * unwanted at runtime, the hook itself can short-circuit on a
 * config flag inside its `afterIndexAll`/`afterSync`.
 */
const REGISTERED_HOOKS: readonly IndexHook[] = [
  // PRs adding hooks: append your `import { HOOK as <NAME>_HOOK } from './<name>';`
  // above and your `<NAME>_HOOK` entry here, alphabetical by name.
];

/**
 * Race a hook invocation against a wall-clock budget. The timeout
 * branch only unwinds *async* hangs — fully synchronous code blocks
 * the event loop and will still run to completion. That's
 * acceptable: hooks that do heavy work typically shell out via
 * `execFileSync` with their own per-call timeout, so a sync hang is
 * bounded upstream.
 */
async function runWithTimeout(
  fn: () => Promise<void> | void,
  timeoutMs: number,
  label: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const work = Promise.resolve().then(() => fn());
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${timeoutMs}ms budget; skipping`)),
      timeoutMs
    );
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    logDebug(`index-hook "${hook.name}" afterIndexAll: starting`);
    try {
      await runWithTimeout(
        () => hook.afterIndexAll!(ctx),
        HOOK_TIMEOUT_MS,
        `index-hook "${hook.name}" afterIndexAll`
      );
      const durationMs = Date.now() - start;
      logDebug(`index-hook "${hook.name}" afterIndexAll: done in ${durationMs}ms`);
      out.push({ name: hook.name, phase: 'indexAll', durationMs });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logWarn(`index-hook "${hook.name}" afterIndexAll failed: ${e.message}`);
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
    logDebug(`index-hook "${hook.name}" afterSync: starting`);
    try {
      await runWithTimeout(
        () => hook.afterSync!(ctx, result),
        HOOK_TIMEOUT_MS,
        `index-hook "${hook.name}" afterSync`
      );
      const durationMs = Date.now() - start;
      logDebug(`index-hook "${hook.name}" afterSync: done in ${durationMs}ms`);
      out.push({ name: hook.name, phase: 'sync', durationMs });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logWarn(`index-hook "${hook.name}" afterSync failed: ${e.message}`);
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
