/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (PR review = X then Y; refactor planning = A then B)
 *   - Anti-patterns (don't grep when codegraph_search is faster)
 *   - Tier discipline (cheap deterministic → conditional → LLM-mediated)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Aim for under ~80 lines of useful guidance.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph builds a SQLite knowledge graph of every symbol, edge, and
file in the workspace. It is a structural reference manual the agent
consults BEFORE writing or editing code, not a live linter that runs
during generation. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher.

## When to use which tool

- **"What is the symbol named X?"** → \`codegraph_search\` (fast lookup)
- **"What's the deal with this task / feature / bug?"** → \`codegraph_context\` (PRIMARY tool — composes 5+ smaller queries into one answer)
- **"What calls this function?"** → \`codegraph_callers\`
- **"What does this function call?"** → \`codegraph_callees\`
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Is this function risky to change? Is it complex / nested / large?"** → \`codegraph_biomarkers\` (PR #125, when present) — structured answer instead of reading 200 lines of source
- **"Is this function tested? What's covered?"** → \`codegraph_coverage\` (PR #124, when present) — requires a prior \`codegraph coverage <lcov>\` ingestion
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"Survey an unfamiliar topic / pattern / module."** → \`codegraph_explore\` (heavier; best when budget allows)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains (run tools in sequence)

- **Onboarding to a topic**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols you want code for.
- **PR review**: if \`codegraph_review_context\` is available (PR #110), pass the unified diff to it — returns affected symbols + their callers + impact + co-change warnings in one call.
- **Refactor planning**: \`codegraph_search\` to find the symbol; \`codegraph_biomarkers\` (mode=symbol) for its Code Health and complexity metrics; \`codegraph_coverage\` (mode=symbol) to see if tests exist; \`codegraph_callers\` for what depends on it; \`codegraph_impact\` for the full blast radius. The killer pre-refactor query is \`codegraph_biomarkers minSeverity=warning minCentrality=0.001\` — lists high-impact code with structural problems in one call.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol. If recent changes are in scope, look for hotspot tools (\`codegraph_hotspots\` if available) to identify churn × centrality risk. \`codegraph_biomarkers\` on the suspected hotspot tells you whether the function is structurally bad enough that it might be the cause.
- **"What should I test next?"**: \`codegraph_coverage\` mode=ranked with \`minCentrality\` set — returns high-impact under-covered code, ordered by importance.

## Tool tiers (start cheap, escalate when needed)

1. **Always available, deterministic, sub-millisecond**: search / context / callers / callees / impact / node / explore / files / status. Plus \`codegraph_biomarkers\` once #125 lands — analysis runs as part of every indexAll/sync. Most tasks can be answered entirely at this tier.
2. **Conditional on data availability**: \`codegraph_review_context\` needs a diff. \`codegraph_hotspots\`, \`codegraph_config\`, \`codegraph_sql\` need their respective indexed signals (git history, env-var read sites, SQL string-literals). \`codegraph_coverage\` needs a prior \`codegraph coverage <lcov>\` ingestion. All return clearly when data isn't present.
3. **LLM-mediated, opt-in**: \`codegraph_ask\` (RAG Q&A), \`codegraph_similar\` (semantic search), \`codegraph_dead_code\` (graph + LLM judge), \`codegraph_role\` / \`codegraph_module\` (LLM classifications). These require a configured local LLM endpoint or the agent-bridge tier.

## Agent-bridge tier (when no local LLM is configured)

When LLM-mediated tools aren't available but the user wants summaries:
1. Call \`codegraph_pending_summaries\` to pull a batch of symbols needing summaries (returns each symbol's body + content_hash).
2. The agent (you) generate one-line summaries for each — action-verb leading, no "This function..." preamble, ≤200 chars.
3. Call \`codegraph_save_summaries\` echoing each item's contentHash unchanged. Codegraph re-validates against current disk before persisting.

This lets agents do LLM work themselves when no separate LLM endpoint exists.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature.
- **Don't call \`codegraph_search\` then \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't use \`codegraph_explore\` for narrow questions** — it's a multi-call deep dive, expensive in tokens. Save it for genuine "I'm new here" surveys.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.

## Limitations

- Index lags file writes by ~1 second (watcher debounce + sync).
- Cross-file resolution is a best-effort name match; ambiguous calls return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
