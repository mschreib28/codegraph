import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const CALLEES_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_callees',
    description:
      'Find all functions/methods that a specific symbol calls. Useful for understanding dependencies and code flow.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  handlerKey: 'handleCallees',
};
