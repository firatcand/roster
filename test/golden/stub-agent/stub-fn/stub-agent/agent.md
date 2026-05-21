# stub-agent

## Purpose

<One paragraph: what this agent does, why it exists.>

## Inputs

The orchestrator expects per-plan inputs (declared in each plan's `inputs:` block).

Read at runtime:

- `agent.md` (this file)
- `config.yaml` (workspace-root-relative guideline refs + tool bindings)
- Workspace guidelines referenced under `config.yaml` `guideline_refs:` (e.g., `/guidelines/voice.md`, `/guidelines/icps/`, `/guidelines/messaging.md`)
- `playbook/` — validated lessons (single playbook per agent)

Env resolution: `<this-agent>/.env` overrides workspace `/.env`. Required tool env vars validated before the plan runs.

## Plans

Named plans this agent runs (files in `plans/<plan>.yaml`). One-line description per plan.
No default plan — invoking without a plan triggers an interactive "which plan?" prompt.

- <plan-name>: <one-liner>

## Subagents

- <subagent-name>.md — <one-liner>

## Outputs

Run file at `logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`. See `conventions.md` § "Run file format".
Per-plan output schemas live in each plan's `outputs:` block.

## Approval

`approval_channel: auto` — in-session if interactive, Slack `#stub-fn` if cron (resolved via `SLACK_HITL_CHANNEL_STUB_FN` in workspace `/.env`).

## Lessons protocol

Log candidate lessons inline in run output under `## Candidate lessons`. Don't write to `playbook/` directly during runs — that's the dreamer's job.

## Failure modes

- <known failure mode>: <handling>
