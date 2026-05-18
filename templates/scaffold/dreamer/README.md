# Dreaming Agent

Reinforcement and consolidation. Reads runs and feedback across all agents and projects, drafts lesson candidates, routes through HITL, writes approved lessons to the right scope.

## Why this is one agent

Cross-domain pattern detection matters. A lesson observed in Twitter automation might inform outreach. One dreamer reads everything; per-domain dreamers would miss connections.

## Files

- `agent.md` — orchestrator contract
- `subagents/` — pattern-detector, lesson-drafter, promotion-arbiter
- `playbook/` — the dreamer's own lessons (lessons about how to learn)
- `logs/` — its own runs
- `state.md` — last processed cutoff
- `pending/` — unapproved lesson candidates queued for next run

## Invocation

Nightly via the native desktop scheduler. Register with `roster schedule install` — each fire spawns a fresh CLI session in the workspace, loads `CONTEXT.md`, invokes the `roster-orchestrator` skill, and dispatches the dreamer in isolated subagent context. See `conventions.md` § Schedules and [ADR-0001](../../docs/adr/0001-scheduling-architecture.md) for the model. Subscription-billed only; `claude -p` and the Anthropic Agent SDK are banned and enforced by `roster doctor`.

On-demand from a session: "Run the dreamer on the last week's outreach runs across all projects."

## Output

Run file at `dreamer/logs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`.

Lesson approvals routed to Slack `#admin` as threaded messages.

## Critical rule

The dreamer is the only agent that writes to `playbook/` files. Other agents log candidates inline in run output; the dreamer evaluates and writes. The user may also write playbook lessons by hand with `source: human`.
