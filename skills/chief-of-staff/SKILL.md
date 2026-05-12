---
name: chief-of-staff
description: "Repo maintenance for roster workspaces — create, archive, rename, audit projects, agents, and functions. Wraps shell scripts in scripts/ with mandatory confirmation gates for destructive operations. Triggers when the user asks to scaffold or restructure a roster workspace, or invokes the /chief-of-staff slash command."
version: "0.1.0"
trigger_conditions:
  - "User invokes the /chief-of-staff slash command"
  - "User asks to create, archive, rename, or audit a project (e.g., 'archive _demo', 'create project acme with gtm/sdr')"
  - "User asks to add or remove an agent from an existing project"
  - "User asks for a repo or project completeness audit"
---

# Chief of Staff

Structural maintenance for a roster workspace. **Operate on the workspace itself**, not on the business workflows inside it. This skill scaffolds empty structure, archives completed projects, renames things, and audits completeness. Filling content into the scaffolds is a separate concern handled by function-level experts and role-level agents.

When in doubt, defer to `conventions.md` in the workspace root for the canonical structure schema, and to the `_template/` directories for the canonical scaffold contents.

## Working directory

This skill operates from the workspace root only — the directory that contains `CLAUDE.md`, `conventions.md`, and the function dirs (`gtm/`, `product/`, etc.). If invoked from elsewhere, abort with:

> Run chief-of-staff from your roster workspace root.

## How invocation works

The user invokes via slash command or natural language. Parse intent into a plan name plus parameters. Examples:

- `/chief-of-staff create-project acme with gtm/sdr` → `plan=create-project project=acme agents=[gtm/sdr]`
- `/chief-of-staff archive-project test-scaffold` → `plan=archive-project project=test-scaffold`
- `/chief-of-staff audit-repo` → `plan=audit-repo`
- "Add content-agent to _demo" → `plan=add-agent-to-project project=_demo function=gtm agent=content-agent`

When invoked without a plan, list the available plans and ask which to run.

## Plans

| Plan | Description | Destructive? |
|---|---|---|
| `create-project` | Create a new project, optionally with agent instances | no |
| `create-agent` | Create a new global agent under a function | no |
| `create-function` | Add a new function category to the registry | no |
| `add-agent-to-project` | Add an agent instance to an existing project | no |
| `remove-agent-from-project` | Archive an agent instance (preserved in `_archive`) | yes |
| `archive-project` | Archive a project plus all its instances | yes |
| `unarchive-project` | Restore an archived project | no |
| `rename-project` | Rename a project everywhere it appears | yes |
| `audit-project` | Validate a project's completeness; reports issues with suggested fixes | no |
| `audit-agent` | Validate an agent's structure and instances | no |
| `audit-repo` | Full repo audit aggregating project + agent reports | no |

Each plan lives in `chief-of-staff/plans/<plan>.yaml` in the workspace, backed by a script in `scripts/`.

## Common preamble for every plan

1. **Confirm cwd is repo root.** Check for `CLAUDE.md`, `conventions.md`, `gtm/`, `projects/`. If not all present, abort with the message above.
2. **Parse the user's request.** Extract plan name and parameters. If ambiguous, ask before proceeding.
3. **Show the plan.** For destructive plans, summarize exactly what will happen (paths created, moved, modified) and ask `proceed?`.
4. **Execute by invoking the plan's backing script.** Scripts in `scripts/` do the work; this skill orchestrates and parses output. Do not duplicate the script logic.
5. **Report.** Summarize what changed (paths created, modified, moved). Note anything skipped or any warnings.
6. **Never auto-commit to git.** Leave commits for the user.

## Mandatory confirmation gates

Destructive plans (`archive-project`, `unarchive-project`, `rename-project`, `remove-agent-from-project`) MUST display the planned changes and ask `proceed?` before executing.

Cross-link prompts during `create-project` (which agents to instance) and `create-agent` (which projects to instance into) are also session-only — they cannot be answered headlessly. Power users skip the prompt by passing `agents=` or `add-to-projects=` inline.

## Outputs

- **Mutation plans:** Summary printed to chat (paths created, moved, modified). The backing script also appends to `chief-of-staff/logs/<YYYY-MM>/operations-<YYYY-MM-DD>.md` (one log file per day, append-only).
- **Audit plans:** A report file at `chief-of-staff/logs/<YYYY-MM>/audit-...-<YYYY-MM-DD-HHMM>.md`, plus a condensed stdout summary.

Per-plan output schemas are declared in each plan's `outputs:` block in its YAML.

## Lessons protocol

If you observe a recurring pattern during operations (e.g., users forgetting to run `create-agent` before `add-agent-to-project`), log it inline in the operation's log entry under a `## Candidate lessons` section. The dreamer picks it up on the next reflection pass.

Never write directly to `chief-of-staff/playbook/` during operations. The user may write a lesson by hand with `source: human`; those are respected.

## Failure modes

- **Cwd not workspace root** → abort with clear message
- **Invalid slug or function name** → abort with an example of valid format
- **Collision (target already exists)** → abort, tell the user the existing path
- **Missing dependency** (e.g., agent doesn't exist for `add-agent-to-project`) → abort, suggest the prerequisite plan
- **Script fails** → surface the script's stderr; do not attempt to recover by doing the work directly
- **YAML/JSON parse error in audit** → report as failure with the line number from the audit script
- **Confirmation gate denied** → abort cleanly, no changes
- **Partial failure mid-operation** → scripts handle their own rollback. If a script reports partial state, surface exactly what state the repo is in and what to do next.

## What this skill does NOT do

- Run business workflows (SDR outreach, design generation, content authoring). Those are separate role-level skills.
- Edit guidelines, ICPs, voice, or any project substrate content. That's expert-level work.
- Make git commits. Always leave commits for the user.
- Touch files outside the workspace.
