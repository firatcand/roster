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

Cross-cutting reinforcement. Reads the recorded runs and feedback for one occasion, drafts a cited lesson candidate, and applies the human's decision.

**Usage:**
- `/dreamer` — reflect on the current occasion (the host normally invokes this itself while `roster dream status` reports `due`)
- `/dreamer <scope>` — reflect at a narrower scope, e.g. an agent

There is no reflection plan and no cutoff argument: `roster dream status` owns the durable watermark, and `roster dream candidates list --readiness-key <key>` says whether this occasion has already been drafted.

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

The brain is a workspace-scoped, append-only Postgres + object-storage knowledge
store (bring-your-own). Both halves are indivisible: a workspace that declares only
one fails closed with `BRAIN_CONFIGURATION_INCOMPLETE` and contacts neither store.
Every verb runs through verified workspace authority. All verbs accept `--json`.

| Verb | Purpose |
|------|---------|
| `brain init` | Provision schema + the derived restricted runtime role (admin URL). Prints the non-secret role name and the tracked secret path — never a connection string. |
| `brain doctor` | Audit append-only safety + report pending migrations. Reads protected metadata only: it never reads company content and never contacts object storage. |
| `brain ingest (--manifest <json> \| --manifest-file <ws path>) [--bytes-file <ws path>]` | Mint an immutable source version + its extraction (admin URL, object storage live). The manifest is a JSON object shaped like the source-ingest contract minus `bytes`; `--bytes-file` may be omitted only when `source.kind` is `workspace-file`. |
| `brain save --kind <k> --slug <s> [--title t] [--field key=value …] [--data '{json}']` | Upsert an entity + append facts. |
| `brain get --kind <k> --slug <s>` | Entity truth (latest facts) + timeline (events, edges). |
| `brain event --kind <event-kind> [--slug <entity-slug>] --data '{json}'` | Append an event (metric snapshot, note, correction); `--slug` optionally attaches it to an entity. |
| `brain link <src-slug> <rel> <dst-slug>` | Create a typed edge between two entities. Recorded **uncited** — edge citation ships in #397, and every output says so (`"cited": false`). |
| `brain merge <from-slug> <into-slug>` | Resolve a duplicate (append-only merge; from-slug becomes an alias). |
| `brain fs put --kind <k> --slug <s> [--filename <name>] [--actor <a>] <file>` | Upload a file into the tracked `brain.storage` namespace + append a ledger row. |
| `brain fs get --kind <k> --slug <s> <filename> [--out <path>]` | Download the file bytes (verifies the stored hash). A ledger row under a namespace the workspace no longer declares is refused with `BRAIN_FS_FOREIGN_BUCKET`. |
| `brain fs ls [--kind <k> [--slug <s>]]` | List current (non-tombstoned) files; `--slug` requires `--kind`. Ledger only — no object-storage access. |
| `brain fs rm --kind <k> --slug <s> <filename>` | Tombstone the file in the ledger + delete the object; history is retained. |
| `brain record run\|artifact\|feedback\|decision (--payload <json> \| --file <ws path>)` | Append portable work evidence. |
| `brain query "<text>"` | **Fails closed** with `BRAIN_RETRIEVAL_NOT_READY` until cited retrieval ships (#352). Use `roster context <function>/<agent> --query "…"` for cited evidence. |
| `brain mount` · `table` · `sql` · `config` · `reindex` · `gc` · `export` · `import` | **Recognized but fail closed** with `BRAIN_LEGACY_COMMAND_DISABLED`. These spellings predate workspace-verified Brain authority; removal is #363's. |

Object-storage bucket, region, endpoint, and prefix are tracked non-secret
configuration in `roster.yaml` under `brain.storage`; only credentials are
ambient. Roster never prints a bucket name, endpoint, object key, or `s3://` URI —
the namespace fingerprint is the addressable identity. Exit
codes: `0` ok, `1` error. See [HOWTO.md](HOWTO.md) §11 to set one up.

File bytes for `brain fs` and every ingested source live in the object-storage
namespace declared by `roster.yaml` `brain.storage` (`bucket`, `region`, optional
`endpoint` + `force_path_style` for R2, B2, or MinIO, optional `root_prefix`).
Credentials are **ambient-only** (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`),
never tracked and never stored in the brain. Every dial of that namespace goes
through the same exact-origin network boundary: HTTPS only, no userinfo, no
region redirects, and a guarded DNS lookup that refuses a non-global or rebinding
answer. Changing `brain.storage` changes the workspace namespace fingerprint that
the protected database identity pins, so a repoint is a verified operation rather
than a silent one. Portable backup is a provider-native dump until the reviewed
workspace-migration path ships (#363) — see [HOWTO.md](HOWTO.md) §12.

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

## Ops (`roster ops setup`)

Configures the workspace operations backend — where HITL requests/decisions, run
events, and artifacts persist. Writes `roster/persistence.yaml` (credential-free
by construction) and ensures `/.roster/ops/` is gitignored as its first side
effect. Non-interactive: missing required flags error with the exact list, never
a prompt hang. Design rationale: [ARCHITECTURE.md §The persistence
boundary](ARCHITECTURE.md#the-persistence-boundary-operations-ledger); full
protocol: [ADR-0004](adr/0004-operations-ledger-contracts.md).

| Flag | Purpose |
|------|---------|
| `--backend local\|postgres-s3` | Backend to configure (required on first setup). |
| `--database brain\|dedicated` | Which Postgres hosts the ops schemas (postgres-s3; required). `brain` reuses the brain database (separate `hitl`/`roster_ops` schemas); `dedicated` uses its own. |
| `--bucket <name>` | Dedicated S3 bucket for this workspace (postgres-s3; required). One bucket = one workspace, never shared. |
| `--region <region>` · `--endpoint <url>` · `--force-path-style` | Object-store addressing (optional; endpoint for MinIO/R2 etc. — http(s) only, credentials in the URL are rejected). |
| `--name <label>` | Workspace display name (default: directory name). |
| `--new-identity` | Fork a fresh workspace UUID. Refuses if the current identity has stamped a database/bucket unless `--yes` (prints what it will orphan; nothing is ever deleted or unclaimed). |
| `--json` | Machine-readable output. |
| `--yes`, `-y` | Confirm orphaning the previous identity. |
| `--cwd <dir>` | Operate on another workspace root. |

Re-running with a completed config validates it (flags must match or be
omitted); re-running after a crash resumes the setup journal and rolls forward.
Exit codes: `0` ok, `1` error (config errors are always `1`, never `2`).

**Bootstrap states.** A workspace is in exactly one of three states:

| State | Meaning |
|-------|---------|
| *legacy-implicit* | No `persistence.yaml`. Everything behaves exactly as before — review/pending/banner flows untouched. |
| *configured-local* | `backend: local`. Append-only JSONL ledger active under `.roster/ops/<workspaceId>/`. |
| *postgres-s3* | `backend: postgres-s3` + env URLs resolvable. Postgres records + dedicated-bucket objects, with a durable local outbox for outages. |

**Optional config.** Beyond the fields setup writes, `persistence.yaml` accepts
one optional block — `hitl.expiry` (HITL request TTL policy; see [HITL state
machine](#hitl-state-machine-ops-backend)). It is not a credential and is not
prompted for: hand-edit it when the 24h default does not fit. Everything else in
the file is written by setup.

**Environment variables** (credentials are env-only; `persistence.yaml` never
holds secrets):

| Var | When | Purpose |
|-----|------|---------|
| `ROSTER_OPS_URL` | `--database dedicated` | Runtime connection string; its user is the runtime role. |
| `ROSTER_OPS_ADMIN_URL` | `--database dedicated`, setup/validate only | Admin connection string (migrations, binding stamp, grants, role gate). |
| `ROSTER_BRAIN_URL` / `ROSTER_BRAIN_ADMIN_URL` | `--database brain` | Brain reuse needs nothing new — the existing brain vars are used as-is; the ops grant set extends `roster_brain_rw`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`) | postgres-s3 | **Restricted runtime** object-store credentials — day-to-day reads/writes by exact key + version. |
| `ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID` / `ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY` (+ `ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN`) | postgres-s3 setup + `run doctor`/`run repair` | **Distinct admin/read** object-store credentials — bucket claim + versioning check at setup, and `ListBucketVersions`/`GetObjectVersion` for repair/doctor. Falls back to the standard `AWS_*` pair only for single-identity dev; production separates the two identities. |

Dedicated mode **never mints, prints, or journals a credential**: setup requires
both URLs up front, verifies the runtime role exists (role absent ⇒ the error
prints the exact `CREATE ROLE` SQL for the operator), and applies the grant set
to it. (Contrast `brain init`, which mints the runtime role and prints its
connection string once.)

**`--json` shape:** `{ok, status: created|resumed|validated|forked, state,
workspace: {id, name}, backend, configPath, gitignore: appended|present,
backendInfo: {backend, components: {roster_ops|hitl|objects: {version,
capabilities}}}, roleInvariants: {ok, violations[]} | null, orphaned | null}`.

**Minimum Postgres permissions:**

| Role | Needs |
|------|-------|
| Admin (setup only) | Create the `hitl`/`roster_ops` schemas + tables, write their `meta` rows, `GRANT`/`REVOKE` on them. |
| Runtime | `USAGE` on both schemas; `SELECT` on all tables; `INSERT` **only** on the append tables (`hitl.requests`, `hitl.decisions`, `roster_ops.run_events`, `roster_ops.artifacts`, `roster_ops.delivery_ledger`) — never `meta`/`schema_migrations`; sequence `USAGE` (nextval) only; **no UPDATE/DELETE/TRUNCATE/DDL**, no ownership, no unsafe role attributes (SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS). |

Setup enforces the runtime row via a mandatory pre-finalization gate (direct
**and inherited** privileges, PUBLIC grants, default ACLs) and refuses to
finalize until violations are fixed — the error names each surplus privilege
and the exact `REVOKE`/`ALTER ROLE` to run.

**Minimum S3 IAM:**

| Principal | Allow |
|-----------|-------|
| Runtime (`AWS_*`) | `s3:PutObject` + `s3:GetObject` + **`s3:GetObjectVersion`** on the four data prefixes (`hitl/*`, `runs/*`, `artifacts/*`, `outbox/*`), plus `s3:GetObject` on the exact marker key `roster-workspace.json`. `GetObjectVersion` is required for exact-version artifact reads (the ledger records each blob's immutable `object_version_id` and reads that version, not "latest"). **No `s3:ListBucket`/`s3:ListBucketVersions`** (runtime reads are by exact key + version from the Postgres index), no `s3:DeleteObject*`, no retention bypass, no bucket admin, no root-key writes. |
| Admin / repair (`ROSTER_OPS_ADMIN_AWS_*`) | The runtime set plus `s3:PutObject` on the marker key, `s3:GetBucketVersioning`, `s3:GetBucketObjectLockConfiguration`, and — for `run doctor`/`run repair` — **`s3:ListBucketVersions`** (enumerate the `artifacts/` prefix with version ids) and **`s3:GetObjectVersion`** (hash-verify a candidate version before blessing it). This is a **distinct identity** from the runtime creds — a restricted runtime can never list the bucket. |

**Bucket requirements:** versioning must be **enabled** (setup verifies with
admin creds and errors with the exact `aws s3api put-bucket-versioning` command
otherwise); Object Lock is detected and recorded as a negotiated capability —
its absence is fine (MinIO/R2 without lock still work).

**Outage semantics (summary):** writes are tri-state — every append returns
`committed` or `queued` (durably spooled to the local outbox, replayed
idempotently in per-producer order), never a silent success. Reads and counts
require the live store (`BackendUnavailable` when down; queued items are
overlaid and explicitly marked). **HITL decisions fail closed** — they are
never spooled; a down backend refuses the decision with an actionable error.
See ADR-0004 for the full model (backlog barrier, poison parking,
conflict-advance, overlay union).

## Run + artifact ledger (`roster run <verb>`)

Records runs and their declared outputs into the configured ops backend (see
`roster ops setup`), so a run is queryable and reconstructable from any machine
sharing the workspace backend. Opt-in: without `persistence.yaml` every verb
errors `not configured` (exit 1) and legacy workspaces are untouched. Full
protocol: [ADR-0004](adr/0004-operations-ledger-contracts.md).

| Verb | Purpose |
|------|---------|
| `run start <run>` | Record a `run-start` lifecycle event (**source=cli**). Flags: `--agent`, `--skill`, `--trigger`, `--parent-run`, `--origin-task`. |
| `run end <run>` | Record a `run-end` lifecycle event (source=cli). Duration is derived at read (`ended_at − started_at`), never stored. |
| `run event --run <id> --kind <k> --correlation-id <c>` | Record a **generic** event. `--kind` accepts only `error` \| `retry` \| `resumed` \| `approval-ref` (lifecycle / `tool-*` / `report` / `artifact-declared` are refused — they come from dedicated verbs or the #322 hook). `--correlation-id` is required (deterministic dedupe). `--data <json>` optional. |
| `run report --run <id> (--file <p> \| --stdin)` | Store the agent's final report (**source=agent**, always unverified prose). `--file`/`--stdin` mutually exclusive; **128 KiB (131072 bytes) raw cap**, enforced by the read itself (an over-cap file is refused from its stat; an over-cap pipe is abandoned one byte past the cap — the input is never buffered whole just to be rejected). 128 KiB is the *portable* limit: the local JSONL backend applies a 1 MiB limit to the ENTIRE serialized record, so the raw cap reserves room for worst-case JSON escaping (6× for control bytes), the sanitized index projection, and the sealed envelope — a report at exactly the advertised cap is storable on every backend, for any byte sequence. Larger output belongs in `declare-artifact`. The text is run through the sanitizer at write — only the redacted projection is indexed. |
| `run declare-artifact --run <id> --agent <a> …` | Declare a produced/used artifact (`--role produced\|used`, default produced). **Internal:** `--digest <sha256> --file <p>` (or `--stdin`) uploads bytes create-only + writes a declaration; the digest must match the bytes. **External:** `--external provider:id [--url <u>]` writes a declaration-only row (no bytes). `--type`, `--media-type`, `--text` optional. |
| `run show <run>` | Reconstruct + print the run (`composeRun`): lifecycle + status, unverified report + sanitized projection, tool calls (host-attested success only), artifacts (`resolved`/`pending`/`external`), errors/retries, derived duration. |
| `run list [--task <id>] [--agent <a>] [--limit <n>]` | List runs (default limit 100). Filtering by `--task`/`--agent` filters **before** the limit — it pages through runs (bounded) until `--limit` matches are collected, so a match beyond the first page is not dropped. |
| `run doctor` | Diagnose ledger drift (postgres-s3 only; capability-gated on `run-ledger` + objects `version-id`/`list-prefix` **before** admin credentials are resolved — a v1 backend gets a `VersionSkewError`, never a raw SQL error): declaration-without-blob, orphan blob (via admin `listPrefix`), digest mismatch (bounded deep re-hash), object-version mismatch, run-end-without-start, dangling `parent_run_id`, missing object version, and a residual `declaration-version-unverified` (a declaration still `unverified` although its blob records an immutable version — an offline artifact now derives `verified` on drain, so anything left is repairable residue). Read-only. Exit 1 when findings exist, 0 when clean. |
| `run repair --fill-version-ids` | Admin-only mutation, capability-gated exactly like `run doctor` (refused with `VersionSkewError` on a v1 backend before any admin pool is opened). For each blob missing its `object_version_id` **or** whose internal declarations are still `unverified`: read the candidate object version's bytes, **verify `sha256 == digest`** (a mismatch is never blessed), then in **one transaction** set `object_version_id` + flip the declarations' `version_state` to `verified`. The **sole** updater of those columns — needs `ROSTER_OPS_ADMIN_URL` (Postgres UPDATE) and the admin AWS creds (`ROSTER_OPS_ADMIN_AWS_*`, for `ListBucketVersions`/`GetObjectVersion`); the runtime role holds no UPDATE grant. |

**Global flags:** `--cwd <dir>`, `--json`, `--allow-partial` (degraded reads serve
the queued outbox overlay, marked partial). Writes are tri-state — `committed` or
`queued` (run events ARE spoolable during an outage, unlike HITL decisions) —
reported in the outcome.

**Trust levels** (a `source` LEVEL set by the write path, never a caller claim):
`host-attested` (#322 hook only — a true external-action attestation),
`cli` (a lifecycle event from `roster run` in the trusted process),
`agent` (report prose — always unverified), `unverified` (legacy/unknown).
`run show` promotes a lifecycle fact from `cli`/`host-attested`, but a
"successful external action" only from a `host-attested` correlated tool result.

**`--json` shapes:** writes → `{ok, verb, runId, outcome, id, …}`; `run show` →
`{ok, run: <ComposedRun>}`; `run list` → `{ok, runs: [{runId, agent, originTaskId,
status, events, startedAt, lastEventAt, queued}], partial}`; `run doctor` →
`{ok, findings: [{kind, ref, detail}], counts, deep}`; `run repair` →
`{ok, verb, filled, skippedNoObject, skippedNoVersion}`. A store error surfaces
as `{ok:false, error, message}` with exit 1.

**Sanitized index policy.** The run + artifact ledger produces safe **index
inputs** only: reports/declaration text are redacted at write time (secret shapes
— env/key-token/bearer/URL-creds/JWT/PEM/GitHub/Slack/AWS) and the `run_index` /
`artifact_index` views expose ONLY validated identifiers + those sanitized
columns (never raw payload/provenance/digest/full URL). Semantic-search retrieval
over that index (embedding + brain wiring) is a **deferred** follow-up.

**Exit codes:** `0` ok, `1` error / not-configured / doctor findings.

## HITL state machine (ops backend)

The approval half of the ops backend (`hitl` schema v2 / local ledger v2). #319
ships the schema, the shared state machine, and both store implementations —
**there are no `roster hitl` CLI verbs yet**; they land in #320, hook-side
approval enforcement in #322. This section documents the model those verbs will
expose. Full protocol: [ADR-0004](adr/0004-operations-ledger-contracts.md).

**Identity.** A request is keyed by the *group* it belongs to, not by its
content: `request_key = sha256(functionName, action, target)` and
`request_id = sha256(workspaceId, request_key)`. Within a group, `generation` and
`version` are allocated by the store under a per-group lock. A revision is a new
**version** of the open generation; a fresh ask after a decision is a new
**generation**. `(request_id, generation, version)` is what a decision names.

| Status | Terminal | Actionable | Meaning |
|---|---|---|---|
| `awaiting` | no | yes | No decision yet, not past its expiry. |
| `deferred` | no | yes | Explicitly postponed — **stays in the queue**. |
| `approved` | yes | no | The only status that can authorize execution. |
| `changes-requested` | yes | no | Terminal on this version; continuation is a new version/generation. |
| `rejected` | yes | no | |
| `expired` | yes | no | Past `expires_at` with no decision. Reported by the projection whether or not the sweep has written the durable row. |
| `cancelled` | yes | no | |

**Sealing vs authority.** A generation is *sealed* by any terminal decision — a
later same-key submission opens the next generation instead of reopening it. That
governs allocation only: an **approved head is terminal and still authoritative**
(the normal approve-then-execute path). A decision authorizes execution only when
it is the current version of the **highest** generation, not superseded, not
expired, and its packet still matches exactly (action, action kind, target,
packet hash, canonicalization version, stored expiry). Authority never falls back
to an older generation, and a legacy row whose content hash was never verified
(`canonicalization_version = 0`) can never authorize anything.

**Packet identity.** The approval packet's hash covers every field a human sees —
action, action kind, target (+ its hash), content (inline hash or the immutable
object reference), expiry, canonicalization version, **title**, summary,
warnings, side effects, choices, and the attribution shown beside the ask
(**origin run id, origin task id, requesting agent**). Editing *any* of them
produces a new version; an existing approval is never silently reused for changed
content or changed attribution. Audit-only observations (created_at, seq, the
allocated generation/version) are excluded, so a true replay hashes identically.

**Optimistic concurrency.** Every submission states the head it observed:
`expectedHead: null` means "this key has no history at all", and an object means
"exactly this head" — `{generation, version, packetHash, sealed}`. `sealed` is
part of the fingerprint because an approval changes nothing else about a head, so
without it a submission composed against an open request would silently open the
next generation behind a decision the caller never saw. The store re-reads the
head under the per-group lock and refuses a mismatch with a synchronous
`ConflictError`. A `null` expectation is also honored idempotently when the head
turns out to be an open, byte-identical packet — that is an at-least-once retry
of the same ask, and it can never cross a terminal boundary.

**A replaced group is closed.** `replaces` records the supersession on the
*destination* row, so being replaced leaves the source head's fingerprint
completely unchanged — same generation, same version, same packet hash, same
`sealed`. An `expectedHead` read before the replace therefore still matches
afterwards, so the store re-checks the supersession itself under the lock: any
submission that would WRITE against a superseded head — a revision, or a new
generation on a sealed one — is a `ConflictError`, and so is a second `replaces`
against a source another group already superseded. Re-read and target the group
that replaced it; there is no reopen intent. A byte-identical packet against an
open head remains idempotent, because it writes nothing — but a `replaces` still
owes its supersession link, so such a destination plan is upgraded to a real
revision when the head does not already record that link, and the closure check
is applied to that FINAL plan (otherwise `A→B`, `B→C`, `X→B` with B's own
fingerprint and packet would resurrect B). A superseded head is
also out of the default actionable queue (an explicit `status` filter still
returns it — that is history, not the queue) and is never swept for expiry. On
postgres the same closure — plus the legal `(generation, version)` next step, the
"supersede only the current head" rule, and the refusal to revise an already
expired head in place — is enforced by the requests trigger under the per-group
lock, so it holds against a raw runtime `INSERT` too. Like the decisions trigger,
it lock-then-reads, so it also refuses to run above `READ COMMITTED`, where its
snapshot would predate the lock; the store opens every HITL transaction at that
level explicitly.

**Action taxonomy.** A closed allowlist of `editorial` actions —
`approve-draft`, `approve-lesson`, `select-candidate`, `acknowledge-error` —
chooses or blesses content. **Every other action, including one this CLI does not
know, is `execution`** (fail-safe). Execution requests must carry an expiry;
editorial ones may be open-ended. An editorial approval can never satisfy an
execution request.

**Queue reads.** Listing without a `status` filter returns the actionable set
(`awaiting` + `deferred`); a supplied status selects exactly that effective
status. Filtering by `functionName` matches the **normalized** identity: a stored
value that is not a non-empty string — absent, empty, or not a string at all,
which is only reachable through migrated pre-#319 history — is the `unknown`
sentinel on both backends, and that is also what the envelope reports, so a
request is always reachable through the name it answers to. Pagination is
anchored on the request GROUP's creation position, so a revision landing while
you page never moves a request out of (or twice into) an in-flight traversal;
requests created after the first page are simply not part of it.

**Expiry policy** — optional block in `roster/persistence.yaml`:

```yaml
hitl:
  expiry:
    default_ttl_ms: 86400000   # 24h — applied when a request supplies no expiry
    min_ttl_ms: 3600000        # 1h
    max_ttl_ms: 604800000      # 7d
```

All three are positive integer milliseconds; `min ≤ default ≤ max` is validated
at load. A per-request expiry outside the bounds is **clamped with a warning**
(returned on the write outcome), never refused — the request still has to reach a
human. On a `postgres-s3` workspace the policy is resolved against the
**database** clock (read under the group lock, with the packet re-sealed around
the result), because that is the clock every expiry consumer uses — otherwise an
application clock running behind the database mints a request that is already
expired, and one running ahead mints an expiry past `max_ttl_ms`. Expiry itself
does not depend on any background job: a request past its deadline drops out of
the actionable queue and out of authority immediately, and a throttled sweep
later records the durable `expired` decision for history. An expired head is also
frozen until that decision exists: no revision may be allocated over it (which
would hide it from the sweep forever) and the next generation opens only once the
expiry is durable — which every store write path materializes in the same
transaction, so a caller never has to do it by hand.

**Fail-closed posture.** HITL never spools to the outage outbox (contrast run
events, which do):

| Situation | Behavior |
|---|---|
| `postgres-s3` workspace, database unreachable | Every HITL write **and read** throws `BackendUnavailableError`. Nothing is queued; the caller retries. |
| Direct `outbox.enqueue` into the `hitl` namespace | Throws — the whole namespace is non-spoolable at the boundary, not by convention. |
| `--allow-partial` on a degraded backend | Ignored for HITL. There is no queued HITL overlay, and reporting "nothing awaiting" from a partial view is worse than refusing to answer. |
| Workspace with `backend: local` | The JSONL ledger **is** the live store: writes are synchronous to disk and either commit or throw. |
| Stale submission (the head moved) | Synchronous `ConflictError` — re-read the head and re-plan. |
| Second decision on a decided version | `ConflictError` (one terminal decision per version, enforced by the database). |

**Upgrading an existing workspace.** `roster ops setup` re-run applies the `hitl`
v2 migration (postgres-s3) or converts the local ledger in place, both
idempotent and roll-forward. A legacy history that cannot be partitioned
unambiguously — duplicate terminal decisions, orphan decisions, a decision
stamped before its request, a same-key request created before the previous one's
decision landed — **refuses the upgrade with a per-row report** rather than
guessing an approval scope.

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
retry. Release is owner-token-guarded: a finishing run only removes a lock whose content still
matches the token it wrote, which protects a successor's lock in every scenario the
documented remedy can produce (the token check reads then unlinks, so it is not atomic —
but the window is only reachable by deleting and replacing the lock while the original
run is still live, outside the remedy). See the [HOWTO
Troubleshooting table](HOWTO.md#troubleshooting) for the refusal messages.
