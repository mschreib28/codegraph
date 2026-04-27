import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const REVIEW_CONTEXT_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_review_context',
    description:
      'PR REVIEW HELPER: Given a unified diff, return structured context an LLM reviewer needs. Maps each hunk to the symbols it touches and attaches per-symbol callers, callees, impact-radius count, and tests covering the file. Also surfaces co-change warnings — files that historically change together with a changed file but were NOT included in this PR (catches "you changed schema.sql but not migrations.ts" type coupling violations). Returns JSON; the caller does the synthesis.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'Unified-diff text (e.g., the output of `git diff`, `gh pr diff <n>`).',
        },
        maxCallersPerSymbol: {
          type: 'number',
          description: 'Cap callers shown per affected symbol. Default 5.',
        },
        maxCalleesPerSymbol: {
          type: 'number',
          description: 'Cap callees shown per affected symbol. Default 5.',
        },
        maxCoChangeWarnings: {
          type: 'number',
          description: 'Cap co-change warnings per changed file. 0 disables. Default 3.',
        },
        minCoChangeJaccard: {
          type: 'number',
          description: 'Minimum Jaccard for a co-change warning. Default 0.4.',
        },
        projectPath: projectPathProperty,
      },
      required: ['diff'],
    },
  },
  handlerKey: 'handleReviewContext',
};
