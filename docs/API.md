# API Reference

Lean-but-complete reference to every public surface in roster. For design rationale, see [ARCHITECTURE.md](ARCHITECTURE.md). For task recipes, see [HOWTO.md](HOWTO.md).

---

## Slash commands

All slash commands live at `.claude/commands/<name>.md` and are invoked via `/<name> <args>`. They route to an agent's `agent.md` + a named plan.

Roster ships only the framework slash commands listed below (`/chief-of-staff`, `/dreamer`). Domain agents (e.g. an SDR for cold outreach, a content writer, a graphic designer) are *not* preinstalled — you scaffold them with `/chief-of-staff create-agent <function> <agent>`, which generates the agent contract, plans, subagents, and a matching `/<agent>` slash command. The example below shows the shape of a domain slash command you'd get back.

### `/<agent>` (scaffolded — example shape)

After `/chief-of-staff create-agent gtm sdr` you'd have a `/sdr` command at `.claude/commands/sdr.md` that routes to `gtm/sdr/agent.md`. The invocation shape is the same for any agent you scaffold.

**Usage:**
- `/<agent> run <plan>` — execute a named plan
- `/<agent>` — list available plans, prompt for choice

**Plans available:** whatever is under `<function>/<agent>/plans/`.

### `/chief-of-staff`

Repo maintenance. Operates on the repo itself, not on business workflows.

**Usage:**
- `/chief-of-staff <plan-name> <args...>` — execute a named plan
- `/chief-of-staff <plan-name>` — show inputs the plan needs
- `/chief-of-staff` — list available plans

**Plans available:** `create-project`, `create-agent`, `create-function`, `add-agent-to-project`, `remove-agent-from-project`, `archive-project`, `unarchive-project`, `rename-project`, `audit-project`, `audit-agent`, `audit-repo`.

Destructive plans (`archive-project`, `unarchive-project`, `rename-project`, `remove-agent-from-project`) always confirm before executing.

### `/dreamer`

Cross-cutting reinforcement. Reads runs and feedback, drafts and promotes lessons.

**Usage:**
- `/dreamer run nightly-reflection` — run the reflection plan
- `/dreamer run since <ISO timestamp>` — re-process from an earlier cutoff
- `/dreamer` — show available plans

**Plans available:** `nightly-reflection`.

### Custom slash commands

When you create a new agent via `bash scripts/new-agent.sh <fn> <agent>`, a slash command file is auto-scaffolded at `.claude/commands/<agent>.md`. Edit the description; the routing logic is generic.

---

## Plans

Plans are YAML files at `<function>/<role>/plans/<plan-name>.yaml`.

### Schema

```yaml
plan: <plan-name>                # required, kebab-case, matches filename
description: |
  Multi-line description.

inputs:
  <field>:
    required: true | false
    default: <value>             # optional
    description: <one-liner>

outputs:
  <field>: <type>                # integer | string | list | etc.

steps:
  - id: <step-id>                # required, unique within plan
    subagent: <name>             # one of subagent | agent | tool
    agent: <function>/<role>     # cross-agent invocation
    plan: <plan-name>            # used with agent: for cross-plan
    tool: <tool-name>            # direct tool call
    description: <one-liner>     # required
    args:
      <key>: <value>
      <key>: ${tools.X.Y}        # reference instance tool bindings
      <key>: ${inputs.X}         # reference plan inputs
      <key>: ${config.X}         # reference instance config
      input_from: <prior-step>   # chain step outputs
    approval: session            # optional per-step HITL gate

approval_channel: auto | session | slack | none

caps:
  <field>: <value>
```

### Reference variables

- `${inputs.<field>}` — input passed to the plan invocation
- `${config.<path>}` — value from the instance's `config/default.yaml`
- `${tools.<tool>.<binding>}` — value from the instance's `tools:` config block
- `input_from: <step-id>` — output of a prior step

### Step types

- **Subagent call:** `subagent: <name>` — invokes `<function>/<agent>/subagents/<name>.md`
- **Direct tool call:** `tool: <name>` — invokes a registered MCP tool
- **Cross-agent call:** `agent: <function>/<role>` + `plan: <plan-name>` — invokes another agent's plan

A step can have at most one of `subagent`, `tool`, `agent`.

### Approval channels

- `auto` — in-session if interactive caller, Slack channel if not
- `session` — always in-session (fails if no session)
- `slack` — always Slack
- `none` — no HITL gate

Channel name resolution: function agents → `SLACK_HITL_CHANNEL_<FUNCTION>` (e.g., `SLACK_HITL_CHANNEL_GTM`). Cross-cutting agents (dreamer, chief-of-staff) → `SLACK_HITL_CHANNEL_ADMIN`.

---

## agent.md

Required sections for any agent.md (validated by `audit-agent.sh`):

- `## Purpose` — what the agent does, why it exists
- `## Inputs` — what the orchestrator expects + files read at runtime
- `## Plans` — list of named plans in `<function>/<agent>/plans/`
- `## Subagents` — list with one-liners
- `## Tools and bindings` — per-project tool bindings as a YAML block
- `## Outputs` — schema of run output + per-plan output reference
- `## Approval` — HITL routing
- `## Lessons protocol` — what gets logged as candidate lessons

Note: `## Steps` is NOT a required section anymore — workflow logic lives in plans, not agent.md.

---

## subagents/<name>.md

Required sections for any subagent file:

- `## Role` — narrow job, single responsibility
- `## Inputs` — what the orchestrator passes in
- `## Output` — structured output the orchestrator can parse
- `## Tools` — named tools this subagent uses
- `## Boundaries` — what this subagent does NOT do
- `## Quality bar` — specific criteria for acceptable output

---

## Tool bindings schema

Declared in agent.md under `## Tools and bindings`. Example:

```yaml
gmail:
  send_as:
    required: true
    description: "Email alias to send from (e.g., you@example.com)"
  apply_label:
    required: false
    description: "Gmail label applied to outbound emails"
attio:
  list_id:
    required: true
    description: "Attio list ID for prospect records"
```

Per-instance values land in `<function>/<agent>/projects/<project>/config/default.yaml` under a `tools:` key. `required: true` bindings cause the agent to error at runtime if left as TODO. `required: false` are optional.

When you scaffold an instance via `new-agent-instance.sh`, the script reads this schema and prompts interactively. Press Enter or type `skip` to leave as `# TODO:`.

---

## Lesson schema

Lesson files live at `<function>/<agent>/playbook/L-...md` (global) or `<function>/<agent>/projects/<project>/playbook/L-...md` (project-scoped).

### Frontmatter

```yaml
---
id: L-YYYY-MM-DD-NNN             # required
source: human | dreamer          # required
scope: global | project          # required; folder location must agree
project: <slug>                  # required if scope=project; "—" if global
agent: <name>                    # required
created: YYYY-MM-DD              # required
last_observed: YYYY-MM-DD        # required
status: observing | candidate | validated | retired   # required
validated_in: [<projects>]       # optional
extends: <lesson-id>             # optional
contradicts: <lesson-id>         # optional
promoted_to_global: true | false # optional, marks origin
voice_ref: <path>                # optional, links to relevant guideline
icps_ref: <path>                 # optional
do_and_dont_ref: <path>          # optional
compliance_ref: <path>           # optional
---
```

### Body sections

- `## Pattern observed` — the recurring signal (with evidence pointers)
- `## Recommendation` — what the agent should do next time
- `## Why this might be project-specific` — when generalizes, when not
- `## Retirement criteria` — what evidence would invalidate this

---

## Run log schema

Path: `<function>/<agent>/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

### Frontmatter

```yaml
---
agent: <name>
project: <slug>
trigger: cron | session | manual
session_id: <if session>
started: <ISO timestamp>
finished: <ISO timestamp>
status: success | partial | failed
plan: <plan-name>
---
```

### Body sections

- `## Inputs` — what the agent received
- `## Steps executed` — chronological list with status per step
- `## Outputs` — per the plan's `outputs:` schema
- `## Candidate lessons` — patterns observed during the run (dreamer reads these)
- `## Errors / partial state` — anything that failed or was skipped

---

## Feedback log schema

Path: `<function>/<agent>/projects/<project>/log/feedback/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

Mirrors the run filename exactly so they pair.

### Frontmatter

```yaml
---
run: <run-filename>
reviewed_by: <user>
reviewed_at: <ISO timestamp>
verdict: ship | edit | reject
---
```

### Body sections

- `## What worked` — keep doing this
- `## What didn't` — stop doing this
- `## Specific edits` — diffs or callouts
- `## Lesson candidates` — patterns the reviewer noticed (the dreamer also reads these)

---

## Functions registry

`.config/functions.yaml`:

```yaml
functions:
  - slug: gtm
    description: Go-to-market — outbound, content, partnerships
    has_expert: true
  - slug: product
    description: Product strategy and management
    has_expert: true
  - slug: design
    description: Visual and UX design
    has_expert: true
  - slug: ops
    description: Operations and process
    has_expert: false
```

Used by:
- `new-agent.sh` to validate the function exists
- `new-agent-instance.sh` to validate
- `audit-repo.sh` to enumerate functions
- `audit-agent.sh` to validate function membership

Add new functions via `scripts/create-function.sh <slug>` or `/chief-of-staff create-function <slug>`.

---

## Scripts

All scripts in `scripts/` are bash, syntax-checked, and POSIX-portable where possible. Run with `bash scripts/<name>.sh [args]`.

### `new-project.sh <slug>`

Scaffolds `projects/<slug>/` with template files (CLAUDE.md, state.md, GUIDANCE.md, guidelines/voice.md, guidelines/icps/_persona-template.md, guidelines/{do-and-dont,compliance,competitors,messaging,brand-book,asset-links,design,design-tokens}.md).

Validates slug is lowercase kebab-case starting with a letter. Aborts on collision.

### `new-agent.sh <function> <agent>`

Scaffolds a new global agent under a function. Creates:
- `<function>/<agent>/agent.md` (template)
- `<function>/<agent>/README.md`
- `<function>/<agent>/.mcp.json` (empty stub)
- `<function>/<agent>/.claude/settings.json`
- `<function>/<agent>/subagents/_template.md`
- `<function>/<agent>/projects/_template/`
- `<function>/<agent>/plans/.gitkeep`
- `.claude/commands/<agent>.md` (slash command router)

Runs an interactive tool-definition prompt (skipped under `AGENT_TEAM_NO_CONFIRM=1` or non-interactive stdin).

### `new-agent-instance.sh <project> <function> <agent>`

Scaffolds an agent instance at `<function>/<agent>/projects/<project>/`. Creates `config/default.yaml`, `asset-references.md`, and empty `log/runs/`, `log/feedback/`, `playbook/` dirs.

Reads the agent's `## Tools and bindings` schema and prompts interactively for each binding. Press Enter or type `skip` to leave as `# TODO:`.

### `create-function.sh <slug> [--description "..."] [--with-expert]`

Adds a function to `.config/functions.yaml`. Scaffolds `<slug>/` directory with README and (if `--with-expert`) `EXPERT.md` stub.

### `archive-project.sh <slug> [reason]`

Moves project root and all instance folders to `_archive/`. Adds an `ARCHIVED.md` file with the reason. Date-suffixes the archive (`-YYYY-MM-DD`); disambiguates with `-2`, `-3` if same-day.

### `unarchive-project.sh <slug> [archive-suffix]`

Restores from `_archive/` back to live tree.

### `rename-project.sh <old> <new>`

Renames folders + replaces project name in CLAUDE.md, GUIDANCE.md, configs, and asset-references. Does NOT auto-update lesson, run, or feedback bodies.

### `remove-agent-from-project.sh <project> <function> <agent>`

Archives the instance to `_archive/<function>/<agent>/projects/<project>-<date>/`.

### `rename-agent.sh <function> <old> <new>`

Renames an agent everywhere it appears (folder, instance configs, slash command, repo-wide references). Excludes archive, logs, runs, feedback, playbook.

### `audit-project.sh <slug>`

Validates project completeness. Writes report to `chief-of-staff/logs/<YYYY-MM>/audit-<slug>-<timestamp>.md`. Exit code 0 on pass/warn, 1 on failure.

### `audit-agent.sh <function> <agent>`

Validates agent structure: agent.md required sections, plans/, slash command, README, .mcp.json, subagents, projects/_template/, per-instance configs.

### `audit-repo.sh`

Aggregator. Runs project audits and agent audits. Adds repo-level checks (universal `.mcp.json`, root files, orphaned instances).

### Scheduling

Schedules are installed via the `roster schedule install` CLI subcommand, not a scaffold script. Each fire spawns a fresh CLI session that loads `CONTEXT.md` and invokes the `roster-orchestrator` skill. See [SCHEDULING.md](SCHEDULING.md) for the platform × tool matrix and [ADR-0001](adr/0001-scheduling-architecture.md) for the rationale.

---

## HITL routing

When an agent needs human approval, the channel is determined by `approval_channel` in the plan + the caller context:

| approval_channel | Interactive caller | No interactive caller |
|---|---|---|
| `auto` | in-session | Slack `#<function>` (or `#admin` for cross-cutting) |
| `session` | in-session | error (cannot run unattended) |
| `slack` | Slack | Slack |
| `none` | no gate | no gate |

Slack channel resolution: `SLACK_HITL_CHANNEL_<FUNCTION>` env var (uppercase). For cross-cutting agents (dreamer, chief-of-staff), `SLACK_HITL_CHANNEL_ADMIN`.

TTL: function plans default to 24h. Dreamer defaults to 7 days. After TTL, items marked stale.

---

## Configuration files

### `.env`

Credentials and runtime config. **Not committed.** Copy from `.env.example` and fill in. Required for any agent that uses external tools.

### `.mcp.json` (universal at repo root)

Universal MCP server config. Inherited by all agent contexts via Claude Code's discovery walk. Use for tools every agent needs (Slack, Google Drive).

### `<function>/<agent>/.mcp.json`

Agent-scoped MCPs. Available when working in this agent's tree. Add tools specific to this agent (Apollo, HeyReach, Attio, etc.).

### `.claude/settings.json` (universal)

Claude Code settings inherited everywhere.

### `<agent>/.claude/settings.json`

Agent-scoped Claude Code settings.

### `conventions.md`

Canonical structure schema. Read when in doubt about file naming, lesson schema, run format, etc.

### `CLAUDE.md` (root)

Behavioral rules loaded at every Claude Code session in this repo. Defines reading order, lesson conflict resolution, HITL routing, etc.

### `projects/<project>/CLAUDE.md`

Project-level rules — identity, active agent instances, project-specific overrides.

### `<agent>/CLAUDE.md` (optional)

Agent-level rules — usually not needed; agent.md is the contract.

---

## Environment variables

Read from `.env`:

| Var | Required | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | usually managed by Claude Code | direct API calls |
| `SLACK_BOT_TOKEN` | yes (if using Slack HITL) | Slack MCP |
| `SLACK_HITL_CHANNEL_<FUNCTION>` | yes (per function) | HITL routing |
| `SLACK_HITL_CHANNEL_ADMIN` | yes | dreamer + chief-of-staff HITL |
| `AGENT_TEAM_ROOT` | optional | scripts that need an absolute path |
| `AGENT_TEAM_NO_CONFIRM` | optional | suppress interactive prompts in `new-agent.sh` |

Tool-specific (uncomment what you need): `APOLLO_API_KEY`, `HEYREACH_API_KEY`, `ATTIO_API_KEY`, `NOTION_TOKEN`, `LINKEDIN_SESSION_COOKIE`, `GMAIL_OAUTH_REFRESH`, `GOOGLE_CALENDAR_OAUTH_REFRESH`, X (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`).

---

## File naming conventions

- All filenames lowercase, kebab-case (`sdr`, `cv-tailor`, `cold-outreach.yaml`)
- Lesson IDs: `L-YYYY-MM-DD-NNN` (3-digit counter)
- Run files: `YYYY-MM-DD-HHMM.md` (24-hour, local time)
- Feedback files mirror run filenames exactly so they pair
- Configs: `<purpose>.yaml` (typically `default.yaml`)
- Plan files: `<plan-name>.yaml` (matches the `plan:` field inside)
- Slash commands: `<agent>.md` (matches the `name:` field in frontmatter)
