# Conventions

Full reference. CLAUDE.md is the short behavioral guide loaded at session start; this is the long reference.

## Repo philosophy

1. **Workspace = project.** One install, one product. Identity lives in `config/project.yaml`; voice, ICPs, messaging, and design substrate live in `guidelines/`. There is no `projects/<name>/` dimension.
2. **Agents are the unit of reuse.** An agent's logic, plans, subagents, and tools live once at `<function>/<agent>/`. Reuse comes from copying agents across workspaces, not from a project axis within a workspace.
3. **`guidelines/` is cross-agent substrate.** Voice, ICPs, design, brand-book, messaging, do-and-don't, compliance, competitors, asset-links live at workspace root. Every agent reads them via workspace-root-relative refs.
4. **`<agent>/.env` inherits from `/.env`.** Each agent may have its own `.env`. Keys defined there override the workspace `/.env`; keys absent inherit. Empty string is an explicit unset.
5. **Tooling scoped where it belongs.** Universal MCPs/skills/plugins live at root (`.claude/`, `.mcp.json`). Agent-scoped MCPs live at `<agent>/.mcp.json`. No per-workspace tool duplication.
6. **Files are the memory layer for agent operations.** Run logs, playbook lessons, configs, and guidelines are Markdown/YAML in Git — no vector DB, no embedding store. Output artifacts (enriched data, drafts, structured results) are not memory; use whatever storage fits — a DB is fine.
7. **The dreamer learns; agents act.** Reinforcement is a separate, deliberate process. Live agents don't update playbooks. Dreamer-drafted lessons go through HITL approval before they land in `<agent>/playbook/`.
8. **Schedules are stateless and subscription-billed.** A native local scheduler (Claude Desktop Scheduled Tasks, Codex app Automations, or a Codex cron entry installed via `roster schedule install --via cron`) fires a fresh CLI session that loads `CONTEXT.md` (via `CLAUDE.md`/`AGENTS.md`) and invokes the `roster-orchestrator` skill. No Agent SDK, no `claude -p`. See ADR-0001.

## Directory map

```
agent-team/                                 # = your project workspace
├── CLAUDE.md                              # behavioral rules + identity at a glance
├── conventions.md                         # this file
├── state.md                               # last task / next session (written by /save-state)
├── .env                                   # workspace-wide secrets (gitignored, 0600)
├── .claude/                               # universal Claude Code config
├── .mcp.json                              # universal MCPs
│
├── config/
│   └── project.yaml                       # machine-readable identity (name, stage, motion, audience)
│
├── guidelines/                            # cross-agent substrate (read by every agent)
│   ├── voice.md
│   ├── messaging.md
│   ├── brand-book.md
│   ├── asset-links.md                     # local paths + URLs to brand assets
│   ├── icps/<persona-slug>.md             # one file per persona
│   ├── design.md                          # optional
│   ├── design-tokens.md                   # optional
│   ├── do-and-dont.md                     # optional
│   ├── compliance.md                      # optional
│   └── competitors.md                     # optional
│
├── <function>/                            # gtm | product | design | ops | (see .config/functions.yaml)
│   ├── EXPERT.md                          # function-level expert prompt (optional, see has_expert)
│   └── <agent>/                           # flat — no projects/ subdir
│       ├── agent.md                       # behavioral prompt + tool bindings schema
│       ├── README.md
│       ├── config.yaml                    # guideline refs + tool bindings (workspace-root paths)
│       ├── .env                           # agent-scoped overrides (gitignored, 0600, optional)
│       ├── plans/<plan>.yaml              # named workflows the agent runs
│       ├── playbook/<lesson>.md           # validated lessons (no scope field — single playbook)
│       ├── pending/<item>.md              # HITL items awaiting approval (dreamer drafts land here)
│       ├── logs/runs/<YYYY-MM>/           # one run file per invocation
│       ├── logs/feedback/<YYYY-MM>/       # mirror filenames for run feedback
│       ├── subagents/<subagent>.md
│       ├── asset-references.md            # which workspace assets this agent uses (thin pointer)
│       ├── .claude/                       # agent-scoped Claude Code config
│       └── .mcp.json                      # agent-scoped MCPs
│
├── dreamer/                               # cross-cutting reinforcement agent
│   └── <same flat shape>
│
├── chief-of-staff/                        # cross-cutting maintenance agent (operates on this workspace)
│   ├── agent.md
│   ├── plans/{create-agent,create-function,audit-agent,audit-repo}.yaml
│   ├── playbook/
│   └── logs/                              # operation logs + audit reports
│
├── roster/<function>/                     # scheduler runtime tree
│   ├── schedules.yaml                     # entries: name, agent, plan, cron, tool, install_mode
│   ├── state.md                           # one line per fire (agent-level signal)
│   └── pending/                           # HITL items surfaced on session start
│
├── scripts/                               # scaffolding helpers (new-agent, audit-agent, audit-repo, save-state, create-function, rename-agent)
└── logs/cron/                             # cron stdout/stderr/.exit/.events.jsonl
```

## Function categories

The set of function categories is defined in `.config/functions.yaml`. The four initial functions are `gtm/`, `product/`, `design/`, `ops/`. Cross-cutting infrastructure agents `dreamer/` and `chief-of-staff/` are NOT functions — they're peers, not under any function.

To add a new function, use `bash scripts/create-function.sh <slug>` or via chief-of-staff: "create function <slug>".

Add a new function only when at least 2-3 agents will live there within ~90 days. Otherwise put the agent in the closest existing one.

## Tool bindings

Each agent that uses external tools declares a `## Tools and bindings` section in its `agent.md`. This is a YAML code block that names tools, the env vars they require, a `required` flag, and a description.

```yaml
apollo:
  env_var: APOLLO_API_KEY
  required: true
  description: "B2B contact data API"
slack:
  env_var: SLACK_BOT_TOKEN
  required: false
  description: "Used only when approval_channel = slack"
```

When chief-of-staff scaffolds a new agent via `create-agent`, it parses this block and writes the bindings into the agent's `config.yaml` under `tools:`. The env vars themselves are filled in the workspace `/.env` (or overridden in `<agent>/.env`).

### Runtime read order

When invoked, an agent's slash-command router reads:

1. Its `agent.md` (logic + bindings schema)
2. Its `config.yaml` (`guideline_refs:` + `tools:`)
3. Resolves env via `resolveAgentEnv(workspaceRoot, <function>/<agent>)` — agent `.env` overrides, workspace `/.env` inherits
4. Validates that required tool env vars are set in the merged env

If a required env var is unset, the agent aborts before doing tool work, with a clear message naming the missing key and the file to set it in.

### Skipping during scaffolding

The user can press Enter or type `skip` at any prompt. Skipped bindings land as `# TODO: <description>` placeholders in `config.yaml`. Optional bindings with TODO are silently skipped at runtime; required bindings with TODO cause a runtime error.

### Editing later

Tool bindings can be edited directly in `<agent>/config.yaml` at any time. No re-scaffolding needed. To change values without touching the workspace `.env`, set them in `<agent>/.env`.

### Defining the schema during agent creation

When a new agent is created via `bash scripts/new-agent.sh <fn> <agent>` (or via chief-of-staff `create-agent`), the script asks whether to define tools now. If yes, the user provides a comma-separated list of tool names. The script scaffolds a `## Tools and bindings` section with stub blocks per tool. The user then fills in actual bindings (with `required` flags and descriptions) by editing `agent.md` directly.

If skipped, the section is absent and can be added manually later. Agents without a `## Tools and bindings` section don't trigger the binding prompt during scaffolding — `new-agent.sh` checks for the section and skips silently if missing.

## Plans and slash commands

Agents execute named plans. A plan is a YAML file at `<function>/<agent>/plans/<plan-name>.yaml` that defines a workflow recipe — ordered steps using subagents and tools, with input/output contracts.

### Plan structure

```yaml
plan: <plan-name>
description: |
  Multi-line description of what this plan does.

inputs:
  <field>:
    required: true | false
    default: <value>
    description: ...

outputs:
  <name>: <type>

steps:
  - id: <step-id>
    subagent: <subagent-name>     # optional — names a subagent to invoke
    agent: <function>/<role>      # optional — cross-agent invocation
    plan: <other-plan-name>       # optional — calling another agent's plan
    tool: <tool-name>             # optional — direct tool call (when subagent has multiple tools)
    description: <one-liner>
    args:
      <key>: <value>
      <key>: ${tools.X.env_var}   # reference agent tool bindings
      <key>: ${inputs.X}          # reference plan inputs
      <key>: ${config.X}          # reference agent config
      input_from: <prior-step-id> # chain step outputs

approval_channel: auto | session | slack | none

caps:
  <field>: <value>
```

### Step types

- **Subagent call** — `subagent: <name>` with optional `tool: <name>` when the subagent has multiple tools available
- **Direct tool call** — `tool: <name>` with `action: <action>` and `args: {...}`
- **Cross-agent call** — `agent: <function>/<role>` with `plan: <plan-name>` to invoke another agent's plan

All three step types are valid in any plan.

### Slash commands

Each agent has a slash command at `<function>/<agent>/.claude/commands/<role>.md` (or the host-tool equivalent). The slash command is a thin router that:

1. Loads the agent's `agent.md`
2. Parses the user's request for `run <plan-name>`
3. If a plan is named: loads the plan, resolves env via `resolveAgentEnv`, validates bindings, executes, logs the run
4. If no plan is named: lists available plans, asks the user

Slash commands are auto-scaffolded by `scripts/new-agent.sh`. Naming: `/sdr`, `/graphic-designer`, `/ux-designer` — match the agent's role-based name.

### Invocation patterns

```
/sdr run cold-outreach
/sdr                                # asks which plan
/graphic-designer run logo-design
```

Or in natural language (slash command not strictly required):

```
"Run gtm/sdr using the cold-outreach plan"
```

There is no `for <project>` suffix — the workspace itself is the project.

### Plans vs experts (key distinction)

Agents run plans (deterministic, repeatable, scheduled-friendly). Experts at the function level (`<function>/EXPERT.md`) handle goal-directed work (judgment-heavy, ad-hoc). When you want strategic exploration or substrate generation, the expert is the right invocation. When you want a known workflow executed, the agent + plan is the right invocation.

If you find yourself wanting "one-off" agent runs, you're probably looking for expert invocation, not agent invocation.

### No default plans

Agents do NOT have a default plan. Invoking an agent without a named plan triggers an interactive "which plan?" prompt. This is intentional — explicit is better than implicit, and it prevents accidental runs of the wrong workflow.

### Scheduling

Plan invocations integrate with the host CLI's native scheduling. To schedule a plan, install a schedule entry that fires a fresh session and runs the plan via the orchestrator skill (see § Schedules). Plans don't have a `schedule` field — scheduling is a layer above the plan, not part of it.

## Experts

Each function MAY have an `EXPERT.md` at `<function>/EXPERT.md`. An expert is a system prompt that defines a function-level advisor — used for shaping substrate (`guidelines/`), not producing tactical artifacts.

Whether a function has an expert is tracked in `.config/functions.yaml` via the `has_expert` flag.

### What experts produce

Experts write to `guidelines/<file>.md` — voice, ICPs, messaging, brand-book, design principles, design tokens, do-and-dont, compliance, competitors, asset-links. The exact subset depends on the function.

Experts do NOT write tactical artifacts (specific emails, single posts, individual component code). Those belong to agents.

### Read-first protocol

When invoked, an expert reads in this order:

1. `config/project.yaml` — project identity
2. Existing `guidelines/*.md` files relevant to the task
3. `state.md` — current focus

Then identifies gaps and asks only about gaps. Never re-asks what's already in substrate.

### Invocation

To invoke an expert from any session in the workspace:

> "Use the [function] expert. Generate [file]."
> "Use the GTM expert to critique guidelines/icps/."

The session reads the function's EXPERT.md and follows its protocol.

### Expert vs agent: the rule

Experts shape substrate. Agents produce artifacts. See root `CLAUDE.md` § "Experts vs agents" for the full distinction with examples.

## File naming

- All lowercase, kebab-case: `sdr`, `cv-tailor`, `trend-scanner`.
- Lesson IDs: `L-YYYY-MM-DD-NNN`.
- Run files: `YYYY-MM-DD-HHMM.md` (24-hour, local time).
- Feedback files mirror run filenames exactly.
- Configs: `<agent>/config.yaml` (one per agent).

## Agent contract (agent.md)

Required sections:

```markdown
# <Agent Name>

## Purpose
What this agent does, why it exists.

## Inputs
What the orchestrator expects from the caller (plan name, per-plan inputs).
Files read at runtime (config path, guideline refs, playbook paths).

## Plans
List of named plans this agent runs (files in `plans/<plan>.yaml`).
One-line description per plan. No default plan — invocation without a plan triggers an interactive prompt.

## Subagents
List with one-line descriptions.

## Tools and bindings
Tool bindings declared as a YAML block. See § "Tool bindings".

## Outputs
Schema of the run output file. Per-plan output schemas live in the plan's `outputs:` block.

## Approval
HITL routing. Default: `auto`.

## Lessons protocol
What gets logged as candidate lessons during a run.
```

`## Steps` is not part of the agent contract — workflow logic lives in plans (see § "Plans and slash commands").

## Subagent contract

Required sections:

```markdown
# <Subagent Name>

## Role
Narrow job, single responsibility.

## Inputs
What the orchestrator passes in.

## Output
Structured output the orchestrator can parse.

## Tools
Named tools this subagent uses.

## Boundaries
What this subagent does NOT do.

## Quality bar
Specific criteria for acceptable output.
```

## Agent config schema (`<agent>/config.yaml`)

```yaml
agent: gtm/sdr
plans_dir: ./plans/

guideline_refs:
  voice: /guidelines/voice.md
  icps: /guidelines/icps/
  brand_book: /guidelines/brand-book.md
  do_and_dont: /guidelines/do-and-dont.md
  compliance: /guidelines/compliance.md

tools:
  apollo:
    env_var: APOLLO_API_KEY
    required: true
  slack:
    env_var: SLACK_BOT_TOKEN
    required: false

target_personas: [founding-team-hiring-manager, vp-eng-series-b]
channels:
  primary: linkedin
  fallback: email
weekly_cap: 10
approval_channel: auto
```

Paths starting with `/` are **workspace-root-relative**, resolved by the loader. They are NOT literal absolute filesystem paths — the loader rejects refs that resemble real fs roots (`/Users/`, `/home/`, `/etc/`, `/var/`, `/tmp/`, `/opt/`).

Env vars referenced under `tools:` are resolved at dispatch via `resolveAgentEnv` — agent `.env` overrides workspace `/.env`.

## Lesson schema

One file per lesson under `<function>/<agent>/playbook/`. Single playbook per agent — no global-vs-project distinction.

```markdown
---
id: L-2026-04-26-001
source: human                    # human | dreamer
agent: gtm/sdr
created: 2026-04-26
last_observed: 2026-04-26
status: observing                # observing | candidate | validated | retired

evidence:
  observations: 12
  consistency_pct: 78
  threshold:
    observations: 20
    consistency_pct: 70
  signals: [hitl_feedback, post_hoc_analytics]

confidence: medium               # low | medium | high
applies_to: [cold-outreach, founding-roles]
conflicts_with: []
---

# <Lesson title>

## Pattern observed
...

## Recommendation
...

## Retirement criteria
...
```

### Lesson lifecycle

- **observing**: pattern detected, evidence below threshold. Not applied to runs yet.
- **candidate**: evidence above threshold, awaiting HITL approval. Lives at `<agent>/pending/lesson-<id>.md`.
- **validated**: HITL approved. Promoted to `<agent>/playbook/lesson-<id>.md`. Applied to runs.
- **retired**: no longer applies. Kept inline with reason.

### Source field

- **human**: you wrote this lesson by hand. The dreamer respects human lessons — won't override, only extend with HITL approval.
- **dreamer**: the dreamer agent drafted this from runs + feedback. Started as `observing`, may have been promoted through HITL.

### HITL flow

Dreamer drafts → `<agent>/pending/`. The user approves via `roster pending` / SessionStart banner / `/dreamer`. On approval the file moves to `<agent>/playbook/`. There is no `promotion-arbiter` subagent — lessons land directly when approved.

## Run file format

`<function>/<agent>/logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

```markdown
---
agent: gtm/sdr
trigger: cron                    # cron | session | manual
session_id: <if session>
started: 2026-04-26T14:30:00+03:00
ended: 2026-04-26T14:42:00+03:00
status: completed                # completed | partial | failed
config_version: <git-sha>
---

# Run: 2026-04-26 14:30

## Inputs
...

## Steps executed
...

## Outputs
...

## Candidate lessons
...

## Errors / partial state
...
```

## Feedback file format

Mirrors run filename exactly. `<function>/<agent>/logs/feedback/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

```markdown
---
run: 2026-04-26-1430
reviewed_by: <user>
reviewed_at: 2026-04-26T18:15:00+03:00
overall: positive                # positive | negative | mixed | neutral
---

# Feedback on run 2026-04-26-1430

## What worked
...

## What didn't
...

## Specific edits
...

## Lesson candidates
...
```

## State file format

`state.md` at the workspace root — written by `/save-state`. Five lines max.

```markdown
---
updated: 2026-04-26T19:00:00+03:00
---

Last task: drafted Q3 positioning hypothesis
Active artifacts: gtm/positioning/q3-draft.md
Open questions: ICP narrowing — fintech only or include b2b SaaS?
Next session: review draft with brand voice agent
Notes: dreamer flagged 2 candidate lessons in #admin — review before next outreach run
```

## Workspace guidelines

Files under `guidelines/` at the workspace root. Read by every agent operating in the workspace (where relevant per agent.md).

| File | Purpose | Required? |
|---|---|---|
| `voice.md` | Tone, vocabulary, sentence patterns, energy | Yes |
| `icps/<slug>.md` | Persona/ICP definitions — multiple files for multiple personas | Yes (≥1) |
| `messaging.md` | Value props, headlines, taglines, anti-claims | Yes |
| `brand-book.md` | Visual identity overview, logo usage | Yes |
| `asset-links.md` | Local paths + URLs to brand assets (logos, fonts, mood) | Yes |
| `design.md` | Design principles | Optional |
| `design-tokens.md` | Colors, typography, spacing as tokens | Optional |
| `do-and-dont.md` | Explicit operating rules | Stub, fill when needed |
| `compliance.md` | Legal/regulatory constraints | Stub, fill when needed |
| `competitors.md` | Competitive context, how to position | Stub, fill when needed |

ICPs note: each persona is a separate file under `icps/`. Buying signals, intent triggers, qualification criteria all live inside the relevant ICP file (not in a separate signals.md).

## Asset references

Two sides:

**Workspace-level** (`guidelines/asset-links.md`): the source of truth. Where every asset for the workspace actually lives. Mix of local paths (`~/Design/...`) and URLs (Google Drive, Figma, Framer).

**Agent-level** (`<function>/<agent>/asset-references.md`): a thin file listing which subset of workspace assets this agent uses, by name (referencing the workspace asset-links). This makes it explicit and cheap to audit "what does sdr need from the workspace's assets?"

Example agent-level `asset-references.md`:

```markdown
# Asset references — gtm/sdr

This agent uses these assets from `guidelines/asset-links.md`:

- Email signature image (PNG)
- Calendar booking link (URL)
- Profile photo (square, 400x400)
```

## HITL routing

Per-run via the agent's `approval_channel`:

- `auto` (default): in-session if interactive, function-channel via Slack if cron
- `session`: always wait for in-session approval (fails if no session)
- `slack`: always post via Slack (uses the agent's resolved function channel)
- `none`: no approval gate (low-risk reads only)

### Channel resolution for Slack-routed HITL

| Agent location | Channel | Env var |
|---|---|---|
| `gtm/<agent>/...` | `#gtm` | `SLACK_HITL_CHANNEL_GTM` |
| `product/<agent>/...` | `#product` | `SLACK_HITL_CHANNEL_PRODUCT` |
| `design/<agent>/...` | `#design` | `SLACK_HITL_CHANNEL_DESIGN` |
| `ops/<agent>/...` | `#ops` | `SLACK_HITL_CHANNEL_OPS` |
| Future `<function>/<agent>/...` | `#<function>` | `SLACK_HITL_CHANNEL_<FUNCTION>` |
| `dreamer/...` | `#admin` | `SLACK_HITL_CHANNEL_ADMIN` |
| `chief-of-staff/...` | `#admin` | `SLACK_HITL_CHANNEL_ADMIN` |

The function-channel rule extends automatically when new functions are added via `create-function`. The user is responsible for:

1. Creating the corresponding Slack channel (e.g., `#system-architect`)
2. Adding the env var to `/.env` (e.g., `SLACK_HITL_CHANNEL_SYSTEM_ARCHITECT=#system-architect`)

The `create-function` operation prints a reminder when scaffolding a new function.

Approval expires after 24h by default. Workflows specify own TTL if different.

## Schedules

Schedules fire from a native local desktop scheduler. Each fire spawns a fresh CLI session in the workspace that loads `CONTEXT.md` and invokes the `roster-orchestrator` skill; the orchestrator dispatches the agent's subagent via the tool's native primitive (Claude `Task` tool or Codex agent invocation).

Canonical entry point:

```sh
roster schedule install <function>/<agent> <plan> \
  --cron "<expr>" --tool claude|codex [--via cron]
```

The first two positional arguments are `<function>/<agent>` (e.g., `gtm/sdr`) and the plan path within that agent. `--cron` and `--tool` are required; `--via` defaults to `ui-handoff`, `--name` defaults to `<agent>-<plan>`. There is no `--project` flag in v1 — passing one errors with a CHANGELOG hint. The command writes one entry per schedule to `roster/<function>/schedules.yaml` and renders a tool-specific install artifact:

- `--tool claude` — emits `.roster/schedule-specs/<name>.claude.fields.md` for paste-in to Claude Code's Desktop Scheduled Tasks UI. Programmatic install is tracked upstream at [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364); until it lands, hand-off is markdown, not JSON.
- `--tool codex` (default `--via ui-handoff`) — emits `.roster/schedule-specs/<name>.codex.fields.md` for paste-in to the Codex desktop Automations UI.
- `--tool codex --via cron` — installs a hardened crontab line directly (wrapped by `env -i` for environment scrubbing, with a subscription-attestation preflight). Codex-only; refused on Windows.

`schedules.yaml` entries in v1 have no `project` field. v0.4 entries with `project` are hard-rejected by the schema; re-scaffold or strip manually.

Each run:

1. Loads `CONTEXT.md` (via the `CLAUDE.md` or `AGENTS.md` symlink)
2. Invokes the `roster-orchestrator` skill
3. Orchestrator dispatches the agent subagent in isolated context (nested subagents allowed)
4. Run output → the agent's `logs/runs/` as normal
5. HITL items → `roster/<function>/pending/` — chat sessions surface a banner on next start
6. Exits

### Failure observability

Two complementary signals catch the cases where a fire doesn't complete cleanly:

- **`roster/<function>/state.md`** — orchestrator skill appends one line per fire (`<utc-iso> | <function>/<agent>/<plan> | success|failed`). This is the *agent-level* signal: it requires the orchestrator to actually run to completion.
- **`logs/cron/<name>.exit`** — for codex `--via cron` schedules, the wrapper records the process exit code (1-3 byte ASCII integer) independently of the agent. Non-zero here means cron fired but the codex process exited with an error.

`roster doctor` (the `Scheduling fires` section) cross-references both. `roster pending sync` synthesizes `roster/<fn>/pending/error-<id>.md` items from any non-zero `.exit` or STALE detection (last run older than expected next-fire + 2h grace). The SessionStart hook runs `pending sync` automatically before counting items, so a failed fire surfaces in the very next chat session — no manual step required.

Optional: add `capture_events: true` to a codex via-cron entry to also capture the `codex exec --json` event stream at `logs/cron/<name>.events.jsonl` (stdout split from log).

See [ADR-0001: Scheduling architecture](https://github.com/firatcand/roster/blob/main/docs/adr/0001-scheduling-architecture.md) for the rationale and rejected alternatives.

## External-action gates

Any agent that takes external action (post, send, message, write to CRM) must:

1. Specify HITL approval (default `auto`)
2. Implement daily/weekly cap from config
3. Implement auto-reject TTL for unapproved actions
4. Log all actions to `logs/runs/` regardless of outcome (sent, rejected, expired)

Applies to: sdr, twitter-automation, job-application, anything writing externally.

## What we're not building (and triggers to revisit)

| Not built | Trigger to revisit |
|---|---|
| Multi-project model | A real second product appears in the same workspace AND keeping it as a sibling workspace stops working. v1 collapses the project axis on purpose — don't reintroduce it casually. |
| Vector memory layer | A single playbook file exceeds context window OR fuzzy retrieval becomes a felt need. |
| Long-running harness | A workflow with validated <5min latency requirement that cron polling at 2-min interval cannot serve. Fake on cron first. |
| Multi-agent framework (LangGraph etc.) | Claude Code subagents prove insufficient for a real coordination need. |
| Hermes / multi-runtime | Persistent state across days with autonomous resumption AND Claude Code session model is shown to fail. Both required. |
| Multi-tenant config storage | An agent needs to support a second user beyond the original owner. |
| Per-domain dreamers | Cross-domain pattern detection turns out to be unhelpful. |

## When the convention isn't clear

Ask before guessing. Inconsistent conventions are worse than missing ones. Write the convention into this file once decided, with a date.

---

Last updated: 2026-05-21.
