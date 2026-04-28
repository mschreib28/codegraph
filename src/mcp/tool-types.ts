/**
 * Shared MCP tool types.
 *
 * Lives in its own module so per-tool files in `./tools/` and
 * the legacy class wrapper in `./tools.ts` can import the same
 * type definitions without a circular dependency.
 */

export interface PropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  /** For type: 'array' — describes the items shape. */
  items?: PropertySchema | { type: string; properties?: Record<string, PropertySchema>; required?: string[] };
  /** For nested object schemas (codegraph_save_summaries items). */
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Shared `projectPath` schema property — every tool's inputSchema
 * accepts it for cross-project queries.
 */
export const projectPathProperty: PropertySchema = {
  type: 'string',
  description:
    'Path to a different project with .codegraph/ initialized. If omitted, uses current project. Use this to query other codebases.',
};
