import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const COVERAGE_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_coverage',
    description:
      "Per-symbol code coverage from external CI artifacts (lcov/cobertura). Use to answer 'is this function tested?', 'what high-impact code has zero coverage?', and 'should I write a test before refactoring this?'. Coverage rows are joined to the graph so you can mix coverage filters with centrality, role, churn. Modes: 'symbol' (single node by id or qualified name), 'ranked' (lowest-coverage-first across the project, optionally filtered by minCentrality / kinds / source), 'stats' (project-wide rollup). Returns coverage_pct, covered_lines/total_lines, and the source name (e.g. 'lcov', 'unit', 'e2e'). If no rows exist, run `codegraph coverage <lcov-path>` first to ingest a report.",
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['symbol', 'ranked', 'stats'],
          description:
            "Query mode. 'symbol' looks up one node; 'ranked' returns worst-coverage-first across the project; 'stats' returns project-wide rollup. Defaults to 'ranked'.",
        },
        symbol: {
          type: 'string',
          description:
            "For mode='symbol': node id, qualified name, or plain name. Plain names that match multiple symbols return the first hit; pass a qualified name to disambiguate.",
        },
        minCentrality: {
          type: 'number',
          description:
            "For mode='ranked': only include symbols with centrality >= this. The killer query is `mode: 'ranked', minCentrality: 0.001, maxPct: 0.5` — high-impact under-tested code.",
        },
        maxPct: {
          type: 'number',
          description:
            "For mode='ranked': only include symbols with coverage_pct <= this (0-1). Default no filter.",
        },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description:
            "For mode='ranked': filter by node kind (e.g. ['function', 'method']). Default all symbol-bearing kinds.",
        },
        source: {
          type: 'string',
          description:
            "Coverage source key (the value passed to `codegraph coverage --source <name>` at ingestion). Default: don't filter by source — picks the highest-coverage row per symbol.",
        },
        limit: {
          type: 'number',
          description: "For mode='ranked': max rows (default 30).",
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleCoverage',
};
