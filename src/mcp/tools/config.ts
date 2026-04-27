import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const CONFIG_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_config',
    description:
      "Surface environment-variable read sites across the codebase. Use to answer 'what reads OBSIDIAN_PORT?' or 'what config does this codebase read?'. Returns either (a) all distinct keys with read counts (no `key`), or (b) the precise read sites and their enclosing functions for a specific key. Beats grep because it skips comments/docs/tests-of-tests and attributes each hit to its enclosing function.",
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Specific env var to look up (e.g. "OBSIDIAN_PORT"). If omitted, returns the top-N keys with read counts.',
        },
        limit: {
          type: 'number',
          description: 'Max keys to return when no `key` is specified (default: 30).',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleConfig',
};
