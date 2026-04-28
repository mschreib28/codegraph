import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const BIOMARKERS_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_biomarkers',
    description:
      "Static-analysis findings on indexed symbols (Brain Method, Complex Method, Nested Complexity, Complex Conditional, Large Method) plus an aggregate Code Health score (1-10). Use to answer 'is this function risky to change?' before touching it, 'what's the most damaged code in this project?' for triage, and 'did this PR introduce new findings?' for delta review. Modes: 'symbol' (one node), 'ranked' (worst-first across project, optionally filtered by biomarker / minSeverity / minCentrality), 'stats' (project rollup). Findings are auto-refreshed on indexAll/sync; no separate command to run.",
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['symbol', 'ranked', 'stats'],
          description:
            "Query mode. 'symbol' looks up findings on one node; 'ranked' returns worst-severity-first across the project; 'stats' returns project-wide rollup with per-biomarker counts. Defaults to 'ranked'.",
        },
        symbol: {
          type: 'string',
          description:
            "For mode='symbol': node id, qualified name, or plain name.",
        },
        biomarker: {
          type: 'string',
          enum: [
            'large_method',
            'complex_method',
            'nested_complexity',
            'complex_conditional',
            'brain_method',
          ],
          description:
            "For mode='ranked': filter by biomarker. Default: any.",
        },
        minSeverity: {
          type: 'string',
          enum: ['info', 'warning', 'error'],
          description:
            "For mode='ranked': only include findings of this severity or worse. Default 'warning' to avoid spamming low-signal info-level results.",
        },
        minCentrality: {
          type: 'number',
          description:
            "For mode='ranked': only include nodes with centrality >= this. The killer query is `mode: 'ranked', minSeverity: 'warning', minCentrality: 0.001` — high-impact under-tested code with structural problems.",
        },
        limit: {
          type: 'number',
          description: "For mode='ranked': max rows (default 30).",
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleBiomarkers',
};
