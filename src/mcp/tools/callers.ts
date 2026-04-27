import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const CALLERS_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_callers',
    description:
      'Find all functions/methods that call a specific symbol. Useful for understanding usage patterns and impact of changes.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  handlerKey: 'handleCallers',
};
