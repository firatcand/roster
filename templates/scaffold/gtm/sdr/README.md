# Outreach Agent

Cold outreach for any project. Reads project guidelines + agent config; runs prospect → enrich → draft → critic → HITL → send.

## Files

- `agent.md` — orchestrator contract
- `subagents/` — prospector, enricher, writer, critic
- `playbook/` — global lessons (one file per lesson, both human-flagged and dreamer-promoted)
- `logs/` — agent-level operational logs (cron stderr, etc.)
- `.claude/` — agent-scoped skills, plugins
- `.mcp.json` — agent-scoped MCPs (HeyReach, Apollo, Attio, Gmail)
- `projects/` — per-project instances (config, project-scoped lessons, run/feedback logs)

## Invocation

From a project instance session:

```bash
cd gtm/sdr/projects/_demo/
claude
"Run sdr on these 20 prospects from leads.csv"
```

Claude reads agent.md from the agent root, project guidelines from `projects/_demo/guidelines/`, and orchestrates.

For scheduled runs, register the schedule with the native desktop scheduler via `roster schedule install` — see the Phase 2.5 scheduling guide. The subscription-only ban on `claude -p` and the Anthropic Agent SDK is enforced by `roster doctor`.

## Configuration

Per-project config at `projects/<proj>/<this-agent>/config/default.yaml`. References project guidelines via relative paths.

Required project guidelines: `voice.md`, `icps/*.md` (≥1 persona). Optional but checked: `do-and-dont.md`, `compliance.md`, `competitors.md`.

## Outputs

`projects/<proj>/<this-agent>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

## Learning

Don't write to `playbook/` during runs. The dreamer agent (`dreamer/`) reads runs+feedback and drafts lessons. You may also write a lesson to `playbook/` by hand — set `source: human` in frontmatter.
