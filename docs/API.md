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

**Plans available:** `create-agent`, `create-function`, `audit-agent`, `audit-repo`.

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
- `${config.<path>}` — value from the agent's `config.yaml`
- `${tools.<tool>.<binding>}` — value from the agent's `config.yaml` `tools:` block (resolved against the merged env)
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

Note: `## Steps` is not emitted in generated `agent.md` — workflow logic lives in plans, not agent.md.

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

Per-agent values land in `<function>/<agent>/config.yaml` under a `tools:` key. `required: true` bindings cause the agent to error at runtime if the referenced `env_var` is unset in the merged env (see [ARCHITECTURE.md §Env resolution](ARCHITECTURE.md#env-resolution)). `required: false` are optional.

Tool bindings use `env_var:` references — the value lives in `<agent>/.env` (overrides) or `/.env` (workspace default), never in `config.yaml`.

---

## Lesson schema

Lesson files live at one path: `<function>/<agent>/playbook/L-YYYY-MM-DD-NNN.md`. Lessons attach to the agent that produced them; there is no project-vs-global scope.

### Frontmatter

```yaml
---
lesson_id: L-YYYY-MM-DD-NNN              # required
source: human | dreamer                  # required
agent: <name>                            # required
created: YYYY-MM-DD                      # required
last_observed: YYYY-MM-DD                # required
status: observing | candidate | accepted | retired   # required
extends: <lesson-id>                     # optional
contradicts: <lesson-id>                 # optional
voice_ref: <path>                        # optional, workspace-rooted path
icps_ref: <path>                         # optional
do_and_dont_ref: <path>                  # optional
compliance_ref: <path>                   # optional
---
```

### Body sections

- `## Pattern observed` — the recurring signal (with evidence pointers)
- `## Recommendation` — what the agent should do next time
- `## Retirement criteria` — what evidence would invalidate this

---

## Run log schema

Path: `<function>/<agent>/logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

### Frontmatter

```yaml
---
agent: <name>
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

Path: `<function>/<agent>/logs/feedback/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

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
- `audit-repo.sh` to enumerate functions
- `audit-agent.sh` to validate function membership

Add new functions via `scripts/create-function.sh <slug>` or `/chief-of-staff create-function <slug>`.

---

## Scripts

All scripts in `scripts/` are bash, syntax-checked, and POSIX-portable where possible. Run with `bash scripts/<name>.sh [args]`.

### `new-agent.sh <function> <agent>`

Scaffolds a new agent under a function. Creates:
- `<function>/<agent>/agent.md` (template)
- `<function>/<agent>/config.yaml` (tool bindings + guideline refs)
- `<function>/<agent>/README.md`
- `<function>/<agent>/.mcp.json` (empty stub)
- `<function>/<agent>/.claude/settings.json`
- `<function>/<agent>/subagents/_template.md`
- `<function>/<agent>/plans/.gitkeep`
- `.claude/commands/<agent>.md` (slash command router)

Runs an interactive tool-definition prompt (skipped under `AGENT_TEAM_NO_CONFIRM=1` or non-interactive stdin).

### `create-function.sh <slug> [--description "..."] [--with-expert]`

Adds a function to `.config/functions.yaml`. Scaffolds `<slug>/` directory with README and (if `--with-expert`) `EXPERT.md` stub.

### `rename-agent.sh <function> <old> <new>`

Renames an agent everywhere it appears (folder, slash command, repo-wide references). Excludes archive, logs, feedback, playbook.

### `audit-agent.sh <function> <agent>`

Validates agent structure: `agent.md` required sections, `config.yaml` schema, `plans/`, slash command, README, `.mcp.json`, subagents. Also warns — never fails — when a `config.yaml` `guideline_refs:` entry points at a file that doesn't exist, escapes the workspace root, or uses a literal absolute path the runtime loader would reject (mirrors `agent-config-schema` semantics). Requires PyYAML; without it the audit reports "guideline_refs not checked" explicitly.

### `audit-repo.sh`

Aggregator. Runs agent audits across every `<function>/<agent>/` plus workspace-level checks (universal `.mcp.json`, root files, `config/project.yaml`, `guidelines/` presence). Its required `guidelines/` file list mirrors the "Required: Yes" rows of the scaffold's `conventions.md` table — extend it at the `# promoted guideline files: append here` marker per the promotion checklist in `conventions.md` § "Adding a new guideline file".

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

Workspace secrets. **Not committed** (matched by `/.env` in `.gitignore`). Copy from `templates/env.example` and fill in. Required for any agent that uses external tools. Permissions enforced at `0600` (`roster doctor` check 11). Each agent may override or opt out of individual keys with its own `<function>/<agent>/.env` — see [ARCHITECTURE.md §Env resolution](ARCHITECTURE.md#env-resolution).

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

### `config/project.yaml`

Workspace identity. Fields: `name`, `display_name`, `stage`, `audience`, `motion`, `created`. Filled by `roster init` (name/display_name) and the user (rest). Schema validated by `src/lib/project-schema.ts`.

### `<function>/<agent>/config.yaml`

Per-agent configuration: `plans_dir`, `guideline_refs` (workspace-rooted paths), and `tools:` bindings (each with `env_var` and `required:`). Schema validated by `src/lib/agent-config-schema.ts`.

### `founder-skills.yaml`

Optional workspace manifest of [founder-skills](https://github.com/firatcand/founder-skills) (`source`, `ref`, `skills:`), installed project-local by `roster skills sync` and pinned in `founder-skills.lock`. `roster doctor` runs two sections against it:

| Doctor section | Semantics |
|---|---|
| **Founder skills** | Manifest ↔ lock ↔ installed drift. Fail-loud — any finding flips the exit code. |
| **Expert routes** | `<function>/EXPERT.md` skill routes not covered by the manifest (built-ins like `frontend-design` excepted). **Warnings only — never affects the exit code**; `expert_routes` in `--json`. Not-applicable when the manifest is absent or invalid (an invalid manifest is reported by Founder skills alone). |

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
- Workspace config: `config/project.yaml`. Per-agent config: `<function>/<agent>/config.yaml`.
- Plan files: `<plan-name>.yaml` (matches the `plan:` field inside)
- Slash commands: `<agent>.md` (matches the `name:` field in frontmatter)

---

## Brain (`roster brain <verb>`)

The brain is a workspace-scoped, append-only Postgres knowledge store (bring-your-own
Neon; connection in Infisical, never `.env`). All verbs accept `--json`.

| Verb | Purpose |
|------|---------|
| `brain init` | Provision schema + restricted runtime role (admin URL); prints the runtime connection string once. |
| `brain doctor` | Audit append-only safety + report pending migrations. |
| `brain save --kind <k> --slug <s> [--title t] [--field key=value …] [--data '{json}']` | Upsert an entity + append facts. |
| `brain get --kind <k> --slug <s>` | Entity truth (latest facts) + timeline (events, edges). |
| `brain event --kind <event-kind> [--slug <entity-slug>] --data '{json}'` | Append an event (metric snapshot, note, correction); `--slug` optionally attaches it to an entity. |
| `brain link <src-slug> <rel> <dst-slug>` | Create a typed edge between two entities. |
| `brain merge <from-slug> <into-slug>` | Resolve a duplicate (append-only merge; from-slug becomes an alias). |
| `brain query "<text>" [--kind k] [--limit n]` | Hybrid search: vector (pgvector) + keyword (tsvector) + 1-hop graph, RRF-fused. |
| `brain table list` · `brain table create <name> --col name:type …` | List / create a custom table via the brokered DDL path (types: text, int, bigint, numeric, boolean, timestamptz, jsonb, uuid). |
| `brain sql "SELECT …"` | Read-only SQL (SELECT only; rejects mutations). |
| `brain mount <file>` | Ingest a file as append-only, searchable document chunks. |
| `brain config get [key]` · `brain config set <key> <value>` | Read/write non-secret settings (`embeddings.enabled\|provider\|model`, `search.rrf_k\|graph_hops`). |
| `brain reindex [--all\|--since <ts>] [--model m] [--yes]` | Backfill embeddings for active chunks with missing/stale vectors (admin; previews the count and requires `--yes` to spend; batched + resumable). |
| `brain export [--out <dir>] [--format jsonl\|sql]` · `brain import <dir>` | Portable backup / restore into a fresh brain. |

Semantic-search embeddings are **off** by default (no paid API calls); enable with
`roster brain config set embeddings.enabled true` (requires `OPENAI_API_KEY`). Exit
codes: `0` ok, `1` error. See [HOWTO.md](HOWTO.md) §11 to set one up.

## Tasks (`roster task <verb>`)

Interactive task state machine on the user's own tracker board (Notion v1) —
`ready → claimed → active → review → done` with `blocked`/`cancelled` branches; unmapped
optional stages collapse. Requires `roster/tracker.yaml` (written by `task setup`) and
`NOTION_TOKEN`. `/tasks` is the chat front door (see `skills/tasks/SKILL.md`).

| Verb | Purpose |
|------|---------|
| `task setup --data-source <id> [--map state=Status,…] [--yes]` | Introspect the board, map statuses onto canonical states, write `roster/tracker.yaml`. |
| `task list` | Claimable pool (unassigned Ready) + your in-flight tasks. `--json` is the **stable flat shape**: `{ok, pool, in_flight, self}`. |
| `task status` | Stage digest. `--json` adds `groups` (`claimed`/`active`/`blocked`/`review`) and `attention` (rows with a `why`) alongside the flat keys. |
| `task status <sel>` | One task's stage (`canonical`) + board status; `--json` includes `assignees` and a `mine` boolean. |
| `task claim <sel>` | Self-assign (+ claimed status when mapped). Idempotent. |
| `task start <sel>` · `submit <sel>` · `done <sel>` · `revise <sel>` | Advance the lifecycle; illegal transitions error with the allowed verbs. |
| `task block <sel> --reason "<why>"` · `unblock <sel>` | Reason lands as a board comment BEFORE any status write; unmapped Blocked degrades to comment-only. |
| `task cancel <sel>` | → cancelled when mapped; guided no-op otherwise. |

Selectors: unique id (`TASK-12`), raw page id, or fuzzy title (ambiguity lists
candidates). All verbs take `--json` and `--cwd`. Exit codes: `0` ok, `1` error. See
[HOWTO.md](HOWTO.md) §13 to connect a board.

## Migrate (`roster migrate from-agent-team <dir>`)

Copies a legacy agent-team workspace into an initialized roster workspace and records
every copy in `.roster/migration-manifests/agent-team-<sourceHash>.json`, so re-runs are
idempotent (`--force-resync` re-copies changed sources; `--dry-run` previews without
writing anything — no files, no manifest, no lock).

Live runs hold a `<manifest>.lock` file for the duration of the manifest read → write
window, so two concurrent migrates against the same source→dest pair cannot silently
overwrite each other's manifest. A second run always refuses — locks are never broken
automatically. Under 15 minutes old, the refusal names the holder's pid and age and says
to wait; past 15 minutes (a messaging threshold, nothing more) it says the run likely
crashed and to verify no `roster migrate` is running, then delete the lock file and
retry. Release is owner-token-guarded: a finishing run only removes a lock it wrote, so
it can never delete a successor's lock after manual intervention. See the [HOWTO
Troubleshooting table](HOWTO.md#troubleshooting) for the refusal messages.
