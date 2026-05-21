# content-agent

gtm agent. See `agent.md` for the orchestrator contract.

## Files

- `agent.md` — orchestrator contract (behavioral prompt, plans list, tool bindings schema)
- `config.yaml` — guideline refs + tool bindings (workspace-root paths)
- `.env` — agent-scoped env overrides (gitignored, 0600 — optional, inherits from workspace `/.env`)
- `plans/` — named workflows (`<plan>.yaml`)
- `subagents/` — specialized roles
- `playbook/` — validated lessons (single playbook per agent)
- `pending/` — HITL items awaiting approval
- `logs/runs/`, `logs/feedback/` — run outputs + mirrored feedback
- `asset-references.md` — which workspace assets this agent uses (thin pointer)
- `.claude/` — agent-scoped Claude Code config (skills, plugins, settings)
- `.mcp.json` — agent-scoped MCPs

## Invocation

From the workspace root:

```bash
claude
> /content-agent run <plan-name>
```

Or via natural language:

```
"Run gtm/content-agent using the <plan-name> plan"
```

## Configuration

`config.yaml` (this agent) — guideline refs + tool bindings.
Workspace `/.env` (root) + optional `gtm/content-agent/.env` for agent-scoped overrides.

## Outputs

`logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md` — one file per invocation.
