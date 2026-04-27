import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const SEARCH_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_search',
    description:
      'Quick symbol search by name. Returns locations only (no code). Use codegraph_context instead for comprehensive task context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  handlerKey: 'handleSearch',
};
