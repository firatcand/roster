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
| `create-agent` | Create a new global agent under a function (interactive dialogue by default — see § "Guided agent creation"; `mode=stub` for headless) | no |
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

## Guided agent creation

The `create-agent` plan runs in one of two modes (see `chief-of-staff/plans/create-agent.yaml`):

- **stub** — byte-identical to `bash scripts/new-agent.sh`. Drops placeholder files (`<one paragraph...>`, plan stubs, empty `## Tools and bindings`, etc.) and exits. Used in CI, headless contexts, and as the legacy escape hatch.
- **guided** — runs the 5-phase dialogue defined below to produce a filled-in `agent.md` from prose intake plus targeted follow-ups. Same on-disk layout as stub mode, but with real content instead of placeholders.

Mode selection priority (first match wins): `${inputs.mode}` → `AGENT_TEAM_NO_CONFIRM=1` (→ `stub`) → TTY detection (TTY → `guided`, no TTY → `stub`).

### Anti-fabrication invariant

> The skill MUST NOT write a Step, Subagent, Tool, Plan body, or Failure mode unless that content was supplied by the user (in prose or follow-up) or comes from documented convention. If the skill catches itself about to invent content, it stops and asks instead.

This invariant is load-bearing. Guided mode is **not a content generator** — it is a structured interviewer that organizes what the user said into the canonical `agent.md` shape. Every non-boilerplate line in the generated agent.md must be traceable to either (a) the prose intake, (b) a follow-up answer, or (c) a documented convention in `conventions.md` / `_template/`. Never fill in plausible-looking defaults to make the output feel complete — gaps stay gaps, surfaced explicitly as follow-up questions.

### EXPERT.md auto-load

At the start of the dialogue, the skill checks `<function>/EXPERT.md` for the function the agent is being created under.

- **Present:** read it for shape reference. Use it to seed function-typical suggestions in Phase 2 (e.g., a `gtm/` agent typically reads `messaging.md` and ICPs; a `design/` agent typically reads `brand-book.md`). These suggestions are still subject to the anti-fabrication invariant — they become Phase 3 questions, not silent fills.
- **Missing:** the dialogue proceeds without function-shaped suggestions. The skill discloses the gap **once** at the start of Phase 3:

  > No `<function>/EXPERT.md` found — proceeding without function-level shape suggestions. You may still register an expert later via `chief-of-staff create-function`.

### Phase 1 — Prose intake

Open with a single open-ended prompt:

> Describe what this agent does in 1–3 sentences. What does one run produce, on what input, for whom?

Accept the answer as-is — no structure required. Capture it verbatim; it seeds the Phase 2 classification.

### Phase 2 — Classify fields as boilerplate / grounded / uncertain

Partition every required `agent.md` field into one of three buckets:

- **boilerplate** — filled silently from `conventions.md` / `_template/`. Examples: standard "Read at runtime" file paths, the lessons-protocol paragraph, the `approval_channel: auto` default, the canonical "Confirmation gate denied" failure mode wording.
- **grounded** — drafted directly from the prose intake. Examples: the `Purpose` paragraph, the `Outputs` description, the agent's headline role.
- **uncertain** — content the prose did not specify and convention cannot fill. Examples: which subagents exist, which tools/MCPs are needed, project-specific failure modes, plan names.

Boilerplate is written without asking. Grounded is drafted but explicitly flagged in the Phase 4 preview ("drafted from your prose — review before accepting"). Uncertain becomes the queue for Phase 3.

### Phase 3 — Targeted follow-up Q&A

For each item in the uncertain queue, ask one question. Constraints:

- **One fact per question.** Don't bundle ("what subagents does this need, and what tools, and what's its failure mode?").
- **Surface the gap explicitly.** Tell the user *why* you're asking. Example: "Your prose mentioned reviewing CVs but didn't name a model. Which LLM — Claude, GPT, something else?"
- **Batch by topic when natural.** Subagent-related questions can come in a short cluster; don't context-switch every turn.
- **Track answered facts.** Never re-ask something the user already said in prose or a previous follow-up. If the user contradicts a prior answer, ask which to keep.
- **Push back on scope creep.** If the user starts describing a second agent's responsibilities mid-dialogue, redirect: "That sounds like a separate agent. Want to finish this one first and create that one after?"
- **No invention shortcuts.** When tempted to skip a follow-up by guessing a sensible default, stop and ask instead (anti-fabrication invariant).

Continue until the uncertain bucket is empty.

### Phase 4 — Consolidated preview

Render the full draft tree to the user. Show:

- Every file path that will be written, with a one-line description.
- The full `agent.md` content (purpose, inputs, steps, subagents, tools, outputs, approval, lessons, failure modes).
- The slash-command description that will land in `.claude/commands/<agent>.md` (replacing the stub's `TODO: fill in description` placeholder).
- The `plans/` directory (empty `.gitkeep` + a stub for the first plan if one was named during Phase 3).

Offer three controls:

- **`y`** → proceed to Phase 5 (atomic write).
- **`revise <section>`** → re-enter Phase 3 for that section only, then re-render the preview. Valid sections: `purpose`, `inputs`, `steps`, `subagents`, `tools`, `outputs`, `approval`, `failure-modes`, `plans`, `slash-command`. After collecting the revised answers, the skill re-renders the **full** preview (not just the changed section) so the user sees the final state in one place.
- **`cancel`** → abort with no writes. Print: `Cancelled. No files written.`

Loop on `revise` until the user types `y` or `cancel`. There is no implicit "looks good enough" — explicit acceptance is required.

### Phase 5 — Atomic write

See P4-T04 for the per-file content contracts and the atomic-write transaction. Summary: stage all files in a temp tree, validate the tree against `conventions.md`, then move into place in a single transaction. On any validation failure, the temp tree is discarded and no partial state is written to the workspace.

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
