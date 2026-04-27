import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const IMPACT_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_impact',
    description:
      'Analyze the impact radius of changing a symbol. Shows what code could be affected by modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to analyze impact for',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  handlerKey: 'handleImpact',
};
