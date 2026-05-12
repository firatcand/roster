# {{PROJECT_NAME}} — Agent-Team Workspace

This workspace was scaffolded by `roster init`. It hosts a structured multi-agent team —
function-level experts and role-level agents — working on **{{PROJECT_NAME}}**.

## Path discovery

Claude Code's `.claude/` discovery walks UP from your CWD, merging settings from each
parent directory. Agent-scoped config lives at `<function>/<agent>/.claude/`; universal
config at the workspace root.

## Layout

- `chief-of-staff/` — repo maintenance agent (CRUD on projects, agents, functions)
- `projects/_demo/` — placeholder project; copy + rename for real work
- `gtm/`, `product/`, `design/`, `ops/` — function-level homes (added in Phase 2)

Each `<function>/<agent>/agent.md` is the contract that defines that agent's inputs,
steps, tools, and outputs. Subagents live in `<function>/<agent>/subagents/`. Per-project
runs and feedback land under `<function>/<agent>/projects/<project>/log/`.

## Running agents

Workflows are slash-command driven (`/sdr`, `/graphic-designer`, …) once their skills are
installed via `roster install`. Each command loads its agent's `agent.md` and executes a
named plan against a named project, writing a run log on completion.

## Conventions

See `conventions.md` (added in Phase 2 by `roster init`) for the full reference: file
naming, lesson schema, run-log format, project structure. When the convention isn't
clear, ask before guessing.

## What you should NOT do

- Modify agent logic during a run — that's a separate, deliberate task.
- Call agents across projects. An agent on Project A cannot invoke a different project's
  instance of itself.
- Invent tools, connectors, or capabilities. If something isn't available, say so.
- Write secrets, API keys, or credentials to any file under version control.

## When in doubt

Read `conventions.md` once it exists, otherwise ask. This workspace is shared with
collaborators and future-you; an inconsistent convention is worse than a missing one.
