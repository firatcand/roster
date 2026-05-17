# content-agent

gtm agent. See `agent.md` for the orchestrator contract.

## Files

- `agent.md` — orchestrator contract (purpose, inputs, steps, subagents, tools, outputs, approval, lessons, failure modes)
- `subagents/` — per-subagent contracts (one file per name listed in `agent.md ## Subagents`)
- `plans/` — workflow recipes (one yaml per plan)
- `playbook/` — global lessons (dreamer-promoted or hand-flagged)
- `logs/` — agent-level operational logs
- `.claude/` — agent-scoped skills and plugins
- `.mcp.json` — agent-scoped MCPs
- `projects/` — per-project instances (config, project-scoped lessons, run/feedback logs)

## Invocation

Use the `/content-agent` slash command, or invoke via natural language ("Run gtm/content-agent on <project> using <plan>").

## Outputs

Per run: `projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`.
