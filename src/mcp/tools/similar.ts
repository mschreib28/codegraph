import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const SIMILAR_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_similar',
    description:
      'Find symbols whose summary semantics are similar to a given symbol. Useful for "show me the other implementations of this concept", including across languages in polyglot repos. Requires the source symbol to already have an embedding.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Source symbol name to find similar items for',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
        },
        sameLanguage: {
          type: 'boolean',
          description: 'Restrict to the same language as the source symbol',
        },
        differentLanguage: {
          type: 'boolean',
          description: 'Restrict to a different language from the source (cross-language matching)',
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  handlerKey: 'handleSimilar',
};
