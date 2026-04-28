import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const MODULE_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_module',
    description:
      'Get the LLM-synthesised paragraph describing what a directory/module does. Built from the symbol summaries inside it. Cheap: pure DB lookup. Useful for "what is in src/sync/?" before drilling into specific symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: {
          type: 'string',
          description: 'Project-relative directory path (e.g. "src/sync", "src/llm").',
        },
        projectPath: projectPathProperty,
      },
      required: ['dirPath'],
    },
  },
  handlerKey: 'handleModule',
};
