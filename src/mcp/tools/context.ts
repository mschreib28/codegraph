import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const CONTEXT_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_context',
    description:
      'PRIMARY TOOL: Build comprehensive context for a task. Returns entry points, related symbols, and key code - often enough to understand the codebase without additional tool calls. NOTE: This provides CODE context, not product requirements. For new features, still clarify UX/behavior questions with the user before implementing.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task, bug, or feature to build context for',
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum symbols to include (default: 20)',
          default: 20,
        },
        includeCode: {
          type: 'boolean',
          description: 'Include code snippets for key symbols (default: true)',
          default: true,
        },
        projectPath: projectPathProperty,
      },
      required: ['task'],
    },
  },
  handlerKey: 'handleContext',
};
