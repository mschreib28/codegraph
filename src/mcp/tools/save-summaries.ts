import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const SAVE_SUMMARIES_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_save_summaries',
    description:
      'Persist agent-generated symbol summaries returned from codegraph_pending_summaries. Re-validates content_hash against current disk before writing — items whose body changed since the batch was issued are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description:
            'Summaries to persist. Each item must echo back the contentHash from codegraph_pending_summaries unchanged.',
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              contentHash: { type: 'string' },
              summary: {
                type: 'string',
                description: 'One line, max 200 chars. Action verb. No "This function..." preamble.',
              },
            },
            required: ['nodeId', 'contentHash', 'summary'],
          },
        },
        model: {
          type: 'string',
          description:
            'Model label to record (must match the modelHint from the pending batch for cache hits to short-circuit). Defaults to "agent-mcp".',
        },
        projectPath: projectPathProperty,
      },
      required: ['items'],
    },
  },
  handlerKey: 'handleSaveSummaries',
};
