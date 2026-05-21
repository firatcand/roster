# Chief of Staff Agent

Operates on the agent-team workspace itself. Scaffolds empty structure for new agents and functions, audits.

This agent is the empty-structure scaffolder. It produces folders and template files in their default placeholder state. Filling content (voice, ICPs, brand) is a separate concern handled outside this agent.

## Why this is one agent at top level

Cross-cutting infrastructure — operates on every function and every agent. Lives at the same level as `dreamer/` for the same reason.

## Files

- `agent.md` — orchestrator contract: operations, steps, confirmation gates
- `playbook/` — global lessons about scaffolding (one file per lesson)
- `logs/` — operation logs and audit reports

## Invocation

From the workspace root, in an interactive Claude Code session:

```bash
cd /path/to/agent-team
claude
```

Then ask the agent to perform an operation:

- "Create a new gtm/sdr agent"
- "Create a new function called ops"
- "Audit the gtm/sdr agent"
- "Audit the whole repo"

The agent will:
1. Confirm cwd is the workspace root
2. Parse intent, restate parameters back to you
3. Show the paths it plans to create or modify
4. Execute by invoking the appropriate `scripts/*.sh`
5. Report what changed
6. Never auto-commit (you commit manually)

## Operations supported

- `create-agent`, `create-function`
- `audit-agent`, `audit-repo`

See `agent.md` for the full contract and confirmation rules.

## Where things land

| Operation | Backing script | Result location |
|---|---|---|
| create-agent | `scripts/new-agent.sh` | `<function>/<agent>/` |
| create-function | `scripts/create-function.sh` | `<function>/` |
| audit-agent | `scripts/audit-agent.sh` | report at `chief-of-staff/logs/<YYYY-MM>/audit-*.md` |
| audit-repo | `scripts/audit-repo.sh` | report at `chief-of-staff/logs/<YYYY-MM>/audit-repo-*.md` |

Operation logs (mutations): `chief-of-staff/logs/<YYYY-MM>/operations-<YYYY-MM-DD>.md` (append-only).

## Why no subagents

The work is mostly script invocation and structural validation. Subagents would add complexity without adding capability.

## Why this never auto-commits

You manually sync to GitHub. The chief-of-staff agent surfaces what changed; you decide what's worth committing.

## Direct script use

All operations have backing scripts that work standalone:

```bash
bash scripts/new-agent.sh gtm sdr
bash scripts/create-function.sh ops
bash scripts/audit-agent.sh gtm sdr
bash scripts/audit-repo.sh
```

The chief-of-staff agent wraps these with intent-parsing, validation, and confirmations. Scripts are the source of truth for what each operation actually does.
