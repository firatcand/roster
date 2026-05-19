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
> pending queue, surface any HITL items, and prepare the session context. Do not
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
- Write secrets or credentials to any tracked file.

## When in doubt

Read `conventions.md`. An inconsistent convention is worse than a missing one.
<!-- roster:managed:end agent-layout -->
