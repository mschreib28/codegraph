import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const EXPLORE_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_explore',
    description:
      'Deep exploration tool — returns comprehensive context for a topic in a SINGLE call. Groups all relevant source code by file (contiguous sections, not snippets), includes a relationship map, and uses deeper graph traversal. Designed to replace multiple codegraph_node + file Read calls. Use this instead of codegraph_context when you need thorough understanding. IMPORTANT: Use specific symbol names, file names, or short code terms in your query — NOT natural language sentences. Before calling this, use codegraph_search to discover relevant symbol names, then include those names in your query. Bad: "how are agent prompts loaded and passed to the CLI". Good: "readAgentsFromDirectory createClaudeSession chat-manager agents.ts".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). Use codegraph_search first to find relevant names.',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  handlerKey: 'handleExplore',
};
