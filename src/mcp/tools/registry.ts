/**
 * MCP tool registry.
 *
 * Adding a new MCP tool is:
 *
 *   1. Create `src/mcp/tools/<name>.ts` exporting an
 *      `<NAME>_TOOL: ToolModule` constant (definition + handlerKey).
 *   2. Add **one** import line and **one** array entry to this file.
 *   3. Add a `handle<Name>` method on `ToolHandler` in `../tools.ts`,
 *      and add the new key to `HandlerKey` in `./types.ts`.
 *
 * The third step is currently the only "shared method on a single
 * class" surface that competing PRs can collide on. Extracting
 * handler bodies into per-tool files (so step 3 also becomes a
 * single-file addition) is left as a follow-up.
 */

import type { ToolDefinition } from '../tool-types';
import type { ToolModule } from './types';

import { CALLEES_TOOL } from './callees';
import { CALLERS_TOOL } from './callers';
import { CONFIG_TOOL } from './config';
import { CONTEXT_TOOL } from './context';
import { EXPLORE_TOOL } from './explore';
import { FILES_TOOL } from './files';
import { HOTSPOTS_TOOL } from './hotspots';
import { IMPACT_TOOL } from './impact';
import { NODE_TOOL } from './node';
import { SEARCH_TOOL } from './search';
import { STATUS_TOOL } from './status';

const ALL_TOOLS: readonly ToolModule[] = [
  CALLEES_TOOL,
  CALLERS_TOOL,
  CONFIG_TOOL,
  CONTEXT_TOOL,
  EXPLORE_TOOL,
  FILES_TOOL,
  HOTSPOTS_TOOL,
  IMPACT_TOOL,
  NODE_TOOL,
  SEARCH_TOOL,
  STATUS_TOOL,
];

let byName: Map<string, ToolModule> | null = null;
function ensureIndex(): Map<string, ToolModule> {
  if (byName) return byName;
  byName = new Map();
  for (const t of ALL_TOOLS) byName.set(t.definition.name, t);
  return byName;
}

export function getToolModules(): readonly ToolModule[] {
  return ALL_TOOLS;
}

export function getToolModule(name: string): ToolModule | undefined {
  return ensureIndex().get(name);
}

/**
 * The `tools[]` array advertised in MCP `list_tools`. Derived from
 * the registry; sorted alphabetically by tool name for stable output.
 */
export const tools: readonly ToolDefinition[] = ALL_TOOLS
  .map((t) => t.definition)
  .sort((a, b) => a.name.localeCompare(b.name));
