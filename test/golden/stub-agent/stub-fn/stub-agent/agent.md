# stub-agent

## Purpose

<One paragraph: what this agent does, why it exists.>

## Inputs

The orchestrator expects:

- `project`: project slug
- <other inputs>

Read at runtime:

- `agent.md` (this file)
- `projects/<project>/<this-agent>/config/default.yaml`
- `projects/<project>/CLAUDE.md`
- `projects/<project>/guidelines/voice.md`
- <other guidelines this agent uses>
- `<this-agent>/projects/<project>/playbook/` — project-scoped lessons
- `<this-agent>/playbook/` — global lessons

## Steps

1. Resolve config and context
2. <step>
3. <step>

## Subagents

- <subagent-name>.md — <one-liner>

## Tools

Agent-scoped MCPs at `<this-agent>/.mcp.json`:
- <tool/MCP> — <purpose>

Universal MCPs (Slack, Google Drive) inherited from agent-team root.

## Outputs

Run file at `projects/<project>/<this-agent>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`. See `conventions.md` § "Run file format".

## Approval

`approval_channel: auto` — in-session if interactive, Slack `#stub-fn` if cron (resolved via `SLACK_HITL_CHANNEL_STUB_FN` in `.env`).

## Lessons protocol

Log candidate lessons inline in run output under `## Candidate lessons`. Don't write to `playbook/` directly during runs — that's the dreamer's job.

## Failure modes

- <known failure mode>: <handling>
