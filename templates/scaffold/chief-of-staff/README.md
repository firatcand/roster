# Chief of Staff Agent

Operates on the agent-team repo itself. Scaffolds empty structure for new projects/agents, archives, renames, audits.

This agent is the empty-structure scaffolder. It produces folders and template files in their default placeholder state. Filling content (voice, ICPs, brand) is a separate concern handled outside this agent.

## Why this is one agent at top level

Cross-cutting infrastructure — operates on every function and every project, doesn't have its own per-project instances. Lives at the same level as `dreamer/` for the same reason.

## Files

- `agent.md` — orchestrator contract: operations, steps, confirmation gates
- `playbook/` — global lessons about scaffolding (one file per lesson)
- `logs/` — operation logs and audit reports

## Invocation

From repo root, in an interactive Claude Code session:

```bash
cd /path/to/agent-team
claude
```

Then ask the agent to perform an operation:

- "Create a new project called myproject with gtm/sdr and gtm/twitter-agent"
- "Archive the test-scaffold project"
- "Audit Acme Corp"
- "Add content-agent to _demo"
- "Rename project oldname to newname"
- "Audit the whole repo"

The agent will:
1. Confirm cwd is repo root
2. Parse intent, restate parameters back to you
3. Show a plan before destructive ops, ask "proceed?"
4. Execute by invoking the appropriate `scripts/*.sh`
5. Report what changed
6. Never auto-commit (you commit manually)

## Operations supported

- `create-project`, `create-agent`, `add-agent-to-project`
- `remove-agent-from-project`, `archive-project`, `unarchive-project`, `rename-project`
- `audit-project`, `audit-agent`, `audit-repo`

See `agent.md` for the full contract and confirmation rules.

## Where things land

| Operation | Backing script | Result location |
|---|---|---|
| create-project | `scripts/new-project.sh` | `projects/<project>/` + optional instances |
| create-agent | `scripts/new-agent.sh` | `<function>/<agent>/` |
| add-agent-to-project | `scripts/new-agent-instance.sh` | `<function>/<agent>/projects/<project>/` |
| remove-agent-from-project | `scripts/remove-agent-from-project.sh` | moved to `_archive/<function>/<agent>/projects/<project>-<date>/` |
| archive-project | `scripts/archive-project.sh` | moved to `_archive/projects/<project>-<date>/` (+ all instances) |
| unarchive-project | `scripts/unarchive-project.sh` | restored from `_archive/` |
| rename-project | `scripts/rename-project.sh` | folders + content updates everywhere |
| audit-project | `scripts/audit-project.sh` | report at `chief-of-staff/logs/<YYYY-MM>/audit-*.md` |
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
bash scripts/new-project.sh myproject
bash scripts/archive-project.sh test-scaffold "no longer needed"
bash scripts/audit-project.sh _demo
```

The chief-of-staff agent wraps these with intent-parsing, validation, confirmations, and orchestration (e.g., create-project + create-instances in one operation). Scripts are the source of truth for what each operation actually does.
