/**
 * MCP tool registry types.
 *
 * Each tool ships its own self-contained `ToolModule` (definition
 * + handler-key reference) so adding an MCP tool is a single-file
 * addition for the metadata and dispatch entry. The actual handler
 * bodies still live as methods on the `ToolHandler` class in
 * `../tools.ts` (the helpers they call are tightly coupled and a
 * full body extraction is left as a follow-up); each tool's
 * `handlerKey` is the string name of the method to invoke.
 *
 * The registry (`./registry`) imports each module and exposes
 * `tools[]` (for `list_tools`) plus a `getModule(name)` lookup
 * used by `ToolHandler.execute`.
 */

import type { ToolDefinition, ToolResult } from '../tool-types';

/**
 * Names of methods on `ToolHandler` that can serve as tool handlers.
 * Kept as a string union (not a `keyof ToolHandler` lookup) to
 * avoid a circular import — the type list is the source of truth
 * and is checked structurally at the call site in `execute()`.
 */
export type HandlerKey =
  | 'handleSearch'
  | 'handleContext'
  | 'handleCallers'
  | 'handleCallees'
  | 'handleImpact'
  | 'handleExplore'
  | 'handleNode'
  | 'handleStatus'
  | 'handleFiles'
  | 'handleHotspots'
  | 'handleConfig';

/**
 * The minimum surface a `ToolHandler`-shaped object exposes for
 * dispatch. Extending `HandlerKey` adds a new entry here too.
 */
export type ToolHandlerLike = {
  [K in HandlerKey]: (args: Record<string, unknown>) => Promise<ToolResult>;
} & {
  errorResult(message: string): ToolResult;
};

export interface ToolModule {
  readonly definition: ToolDefinition;
  /** Method name on `ToolHandler` that runs this tool. */
  readonly handlerKey: HandlerKey;
}
