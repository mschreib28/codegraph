import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const STATUS_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_status',
    description:
      "Get the status of the CodeGraph index: project root + how it was selected (default vs `projectPath`), file/node/edge counts, languages, plus any other projects the MCP server has open. Call this FIRST in a session when you don't know which project the MCP server's default points at — its `Project root` field tells you whether to start passing `projectPath` on subsequent calls.",
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleStatus',
};
