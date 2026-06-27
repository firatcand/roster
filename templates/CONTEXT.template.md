# {{PROJECT_NAME}} — Project Context

This is the canonical project context for **{{PROJECT_NAME}}**. Both `CLAUDE.md`
and `AGENTS.md` are symlinks (POSIX) or copies (Windows) pointing here; every new
session loads this file automatically.

<!-- roster:managed:start orchestrator -->
## Orchestrator directive

On every new conversation in this workspace — including after `/clear` — invoke the
`roster-orchestrator` skill immediately before doing anything else:

> **You are operating inside a roster-managed workspace.** At the start of every
> conversation, activate the `roster-orchestrator` skill. The skill will inspect the
> decision queue, surface any unread decisions (`/inbox`), and prepare the session context. Do not
> proceed with user requests until the orchestrator bootstrap completes.

This directive applies to both scheduled fires and interactive chat sessions.
<!-- roster:managed:end orchestrator -->

<!-- roster:user:start workspace -->
## Workspace: {{PROJECT_NAME}}

[Replace this section with project-specific context: domain, goals, constraints.]
<!-- roster:user:end workspace -->

<!-- roster:managed:start agent-layout -->
## Agent team layout

- `chief-of-staff/` — repo maintenance and project wiring
- `dreamer/` — reflection; promotes lessons to playbooks
- `gtm/`, `product/`, `design/`, `ops/` — function dirs with an `EXPERT.md`; populate with agents via `/chief-of-staff create-agent <function> <agent>`
- `<function>/<agent>/agent.md` — contract for each agent (inputs, steps, tools, outputs)

## Key files

- `conventions.md` — naming, schema, run-log format
- `roster/<function>/pending/` — HITL queue (read on session start)
- `roster/<function>/schedules.yaml` — schedule registry mirror

## What you must NOT do

- Modify agent contracts during a run (that is a deliberate, separate task).
- Invoke agents across project boundaries.
- Invent tools, MCP servers, or capabilities that are not installed.
- Commit secrets or credentials to git. Tool API keys your agents need (Apollo, HeyReach, Slack, Linear, etc.) belong in `.env`, which is gitignored.

## When in doubt

Read `conventions.md`. An inconsistent convention is worse than a missing one.
<!-- roster:managed:end agent-layout -->

<!-- roster:managed:start brain -->
## The brain (shared team memory)

If this workspace has a brain configured (the runtime connection `ROSTER_BRAIN_URL` is
set in the environment), it is the team's **source of truth** for persistent
knowledge: competitors, posts, metrics, accounts, people, and strategy. Treat it that
way:

- **Consult it** before answering from memory or the open web on those topics —
  `roster brain query "<question>"`. The team may already know.
- **Write back** durable facts you learn (`roster brain save` / `event` / `link`) so the
  next session benefits. `brain/RESOLVER.md` says where each thing goes.
- **Correct** the brain the moment you find it wrong — a new write supersedes; the brain
  is append-only and nothing is deleted.
- **Check `roster brain table list` + `brain/RESOLVER.md`** before creating a new table;
  prefer entities + facts.

The `brain` skill (`/brain`) is the front door. If no brain is configured, ignore this
section and use normal files.
<!-- roster:managed:end brain -->
