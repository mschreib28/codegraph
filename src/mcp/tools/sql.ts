import { projectPathProperty } from '../tool-types';
import type { ToolModule } from './types';

export const SQL_TOOL: ToolModule = {
  definition: {
    name: 'codegraph_sql',
    description:
      "Surface SQL string-literal references to tables across the codebase. Use to answer 'what code touches the users table?' or 'what tables does this codebase access?'. Returns either (a) the top-N distinct tables with read/write counts (no `table`), or (b) the precise read sites and their enclosing functions for a specific table. Beats grep because it requires a SQL keyword prefix (FROM/JOIN/INTO/UPDATE/DELETE), filtering out non-SQL uses of the same identifier.",
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description:
            'Specific table to look up (e.g. "users"). Case-insensitive. If omitted, returns the top-N tables with read/write counts.',
        },
        op: {
          type: 'string',
          enum: ['read', 'write', 'ddl'],
          description:
            'Filter to one operation kind: read (SELECT/JOIN), write (INSERT/UPDATE/DELETE), or ddl (CREATE/ALTER/DROP). Only meaningful with `table`.',
        },
        limit: {
          type: 'number',
          description: 'Max tables to return when no `table` is specified (default: 30).',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  handlerKey: 'handleSql',
};
