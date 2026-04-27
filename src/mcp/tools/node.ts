import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const NODE_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_node',
    description:
      'Get detailed information about a specific code symbol. Use includeCode=true only when you need the full source code - otherwise just get location and signature to minimize context usage.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to get details for',
        },
        includeCode: {
          type: 'boolean',
          description: 'Include full source code (default: false to minimize context)',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  handlerKey: 'handleNode',
};
