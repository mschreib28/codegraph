/**
 * MCP tool registry: structural invariants.
 *
 * Guards against the failure mode where a future PR adds a
 * ToolModule but forgets to implement the matching `handle<Name>`
 * method on ToolHandler (or vice versa).
 */
import { describe, it, expect } from 'vitest';
import { getToolModules, tools as registryTools } from '../src/mcp/tools/registry';
import { ToolHandler, tools } from '../src/mcp/tools';

describe('MCP tool registry — single source of truth', () => {
  it('every tool module has a non-empty name and description', () => {
    for (const m of getToolModules()) {
      expect(m.definition.name).toMatch(/^codegraph_[a-z_]+$/);
      expect(m.definition.description.length).toBeGreaterThan(20);
    }
  });

  it('handlerKey is a string starting with "handle"', () => {
    for (const m of getToolModules()) {
      expect(m.handlerKey).toMatch(/^handle[A-Z][A-Za-z]+$/);
    }
  });

  it('every registered tool has a corresponding ToolHandler method', () => {
    const handler = new ToolHandler(null);
    for (const m of getToolModules()) {
      const fn = (handler as unknown as Record<string, unknown>)[m.handlerKey];
      expect(typeof fn).toBe('function');
    }
  });

  it('exported `tools` array exactly mirrors the registry', () => {
    const fromRegistry = registryTools.map((t) => t.name).sort();
    const fromExport = tools.map((t) => t.name).sort();
    expect(fromExport).toEqual(fromRegistry);
  });

  it('all main-line tools are registered (regression guard)', () => {
    const expected = [
      'codegraph_callees',
      'codegraph_callers',
      'codegraph_config',
      'codegraph_context',
      'codegraph_explore',
      'codegraph_files',
      'codegraph_hotspots',
      'codegraph_impact',
      'codegraph_node',
      'codegraph_search',
      'codegraph_sql',
      'codegraph_status',
    ];
    const actual = getToolModules()
      .map((m) => m.definition.name)
      .sort();
    expect(actual).toEqual(expected);
  });

  it('execute() reports unknown-tool errors', async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool/);
  });

  it('execute() actually dispatches to the registered handler (no broken `this` binding)', async () => {
    // No CodeGraph instance is bound, so handlers that call
    // `getCodeGraph()` will throw — the dispatch should catch it
    // and return an error result. The point of this test is to
    // confirm the registry lookup + `this[handlerKey](args)` chain
    // reaches an actual method body, not that the body succeeds.
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_status', {});
    expect(result.isError).toBe(true);
    // Generic tool-execution-failed envelope from execute()'s catch block.
    expect(result.content[0]?.text).toMatch(/Tool execution failed/);
    // Specifically because no CodeGraph was bound:
    expect(result.content[0]?.text).toMatch(/CodeGraph not initialized/);
  });
});
