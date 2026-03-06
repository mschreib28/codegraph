/**
 * Template for Cursor's rules file
 *
 * This template is written to .cursor/rules/codegraph.md (local only).
 * It instructs Cursor Agent on when and how to use CodeGraph MCP tools.
 *
 * Unlike Claude Code, Cursor uses a dedicated file per rule in the .cursor/rules/ directory,
 * so no section markers are needed - the entire file is our template.
 *
 * Note: MCP tools are only available in Cursor's Agent mode, not Composer.
 */

export const CURSOR_TEMPLATE = `## CodeGraph

CodeGraph builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If \`.codegraph/\` exists in the project

**Use MCP codegraph tools for faster exploration.** These tools provide instant lookups via the code graph instead of scanning files:

| MCP Tool | Use For |
|----------|---------|
| \`codegraph_search\` | Find symbols by name (functions, classes, types) |
| \`codegraph_context\` | Get relevant code context for a task |
| \`codegraph_callers\` | Find what calls a function |
| \`codegraph_callees\` | Find what a function calls |
| \`codegraph_impact\` | See what's affected by changing a symbol |
| \`codegraph_node\` | Get details + source code for a symbol |

**Usage in Agent mode:**
- Use \`codegraph_search\` instead of grep/find for locating symbols
- Use \`codegraph_callers\`/\`codegraph_callees\` to trace code flow
- Use \`codegraph_impact\` before making changes to see dependencies
- Use \`codegraph_context\` to get relevant code for implementing features

**Important:**
- CodeGraph provides **code context**, not product requirements
- For new features, still ask the user about UX, edge cases, and acceptance criteria
- MCP tools are only available in Agent mode (not Composer)

### If \`.codegraph/\` does NOT exist

At the start of a session, suggest initializing CodeGraph:

"I notice this project doesn't have CodeGraph initialized. Would you like me to run \`codegraph init -i\` to build a code knowledge graph for faster exploration?"`;
