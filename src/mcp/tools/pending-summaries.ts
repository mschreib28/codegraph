import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const PENDING_SUMMARIES_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_pending_summaries',
    description:
      "Pull a batch of code symbols that need a one-line summary. Returns each symbol's body and content_hash. Designed for cases when no local LLM is available — the calling agent (you) can summarise each item and persist results via codegraph_save_summaries. Cache shape is identical to the local-LLM path, so the two coexist.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max symbols per batch (default 20, max 200)',
        },
        modelHint: {
          type: 'string',
          description:
            'Label to record alongside saved summaries (default "agent-mcp"). Use your model id when known so cache provenance stays clear.',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handlePendingSummaries',
};
