import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const DEAD_CODE_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_dead_code',
    description:
      'Find potentially-dead symbols. Combines the graph signal (no incoming calls, not exported, not in test/script paths) with an LLM judge that knows about framework hooks, dynamic dispatch, and public APIs the static graph misses. Returns a CANDIDATE list with confidence — not a delete list.',
    inputSchema: {
      type: 'object',
      properties: {
        maxCandidates: {
          type: 'number',
          description: 'Cap on graph candidates the LLM judges (default 50)',
        },
        verdict: {
          type: 'string',
          description: 'Filter results by verdict (default shows all, dead-first)',
          enum: ['dead', 'live', 'uncertain', 'all'],
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleDeadCode',
};
