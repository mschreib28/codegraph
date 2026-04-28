import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const ASK_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_ask',
    description:
      'Ask a natural-language question about the codebase. Hybrid-retrieves the top-K most relevant symbols (lexical + semantic match over LLM summaries), then asks the configured chat model. Use this for "how does X work?" questions; use codegraph_search for "what is the symbol named X" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Natural-language question (e.g. "how does the file watcher decide when to sync?")',
        },
        retrieveK: {
          type: 'number',
          description: 'Number of candidate symbols to feed the model as context (default 12)',
        },
        projectPath: projectPathProperty,
      },
      required: ['question'],
    },
  },
  handlerKey: 'handleAsk',
};
