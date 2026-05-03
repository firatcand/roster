---
name: chief-of-staff
description: Repo maintenance — create/archive/rename/audit projects, agents, functions. Wraps the scripts in scripts/ and provides interactive confirmation gates.
---

# /chief-of-staff

You are operating the `chief-of-staff` agent. Load `chief-of-staff/agent.md` and the relevant repo state.

The user request is: $ARGUMENTS

## Routing logic

Parse the user request. Chief-of-staff plans differ from project-bound agent plans — they don't take a "for <project>" argument because they operate on the repo itself. Plans take their own positional and named arguments instead.

1. **If it matches `<plan-name> <args...>`** (e.g., `archive-project test-scaffold` or `create-project myproject with gtm/sdr`):
   - Load `chief-of-staff/plans/<plan-name>.yaml`. If it doesn't exist, list available plans and ask user to pick.
   - Parse the args from the request and map to the plan's `inputs:` schema.
   - Execute the plan steps. For destructive plans (those with `approval: session` in any step), show the plan and ask "proceed?" before invoking the backing script.
   - Surface the operation log location and any audit report references.

2. **If only a plan name is given (no args)**:
   - Show what inputs the plan needs and ask the user to provide them.

3. **If no plan name is given**:
   - List available plans from `chief-of-staff/plans/` with descriptions. Ask user to pick.

4. **For natural language inputs** (e.g., "archive the test-scaffold project"):
   - Best-effort parse: identify the plan name and inputs from prose.
   - Confirm interpretation with the user before executing destructive operations.

## Constraints

- Operate from repo root only. If cwd is not the agent-team repo root, abort with an instructive error.
- Never auto-commit to git. The user commits manually.
- Always show the plan before destructive operations and require explicit "proceed".
- Don't bypass any confirmation gates declared in the plan.
- Preserve all existing operation logs in `chief-of-staff/logs/`.

## Common natural-language mappings

- "Create a project called X" → `create-project project=X`
- "Create a project called X with gtm/sdr and design/graphic-designer" → `create-project project=X agents=[gtm/sdr, design/graphic-designer]`
- "Audit X" (where X is a project slug) → `audit-project project=X`
- "Audit the repo" / "Run a full audit" → `audit-repo`
- "Archive X" → `archive-project project=X`
- "Rename X to Y" → `rename-project old=X new=Y`
