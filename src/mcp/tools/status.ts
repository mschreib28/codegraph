import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const STATUS_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_status',
    description:
      'Get the status of the CodeGraph index, including statistics about indexed files, nodes, and edges.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleStatus',
};
