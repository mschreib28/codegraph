import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const HOTSPOTS_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_hotspots',
    description:
      "Identify high-risk files: high PageRank centrality (many things depend on them) AND high churn (frequently changed). Use when triaging an unfamiliar codebase, hunting for refactor targets, or asking 'where do bugs hide?'. Returns ranked file list with both signals plus a combined risk score (centrality × churn). Sort options: 'risk' (default), 'centrality', 'churn'.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of files to return (default: 15)',
        },
        minCommits: {
          type: 'number',
          description:
            'Filter out files touched in fewer than N commits (default: 3 — excludes test fixtures and one-off files)',
        },
        minCentrality: {
          type: 'number',
          description:
            'Filter out files whose total node centrality (Σ PageRank of nodes in file) is below this threshold (default: 0 — no filter). Useful to drop docs/config files from the list.',
        },
        sortBy: {
          type: 'string',
          enum: ['risk', 'centrality', 'churn'],
          description:
            'Sort dimension: risk = centrality × churn (default), centrality = pure structural importance, churn = pure change frequency',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleHotspots',
};
