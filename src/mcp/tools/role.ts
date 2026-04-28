import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const ROLE_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_role',
    description:
      'List symbols matching an LLM-assigned role (api_endpoint | business_logic | data_model | util | framework_glue | test_helper). Useful for "show me the API surface" or "list all data models". Requires the role classifier pass to have run.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Role label to filter by',
          enum: ['api_endpoint', 'business_logic', 'data_model', 'util', 'framework_glue', 'test_helper', 'unknown'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 50)',
        },
        projectPath: projectPathProperty,
      },
      required: ['role'],
    },
  },
  handlerKey: 'handleRole',
};
