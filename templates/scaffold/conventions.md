# Conventions

Full reference. CLAUDE.md is the short behavioral guide loaded at session start; this is the long reference.

## Repo philosophy

1. **Agents are the unit of reuse.** An agent's logic lives once. Per-project differences live as instances under that agent.
2. **Project guidelines are cross-agent.** Voice, ICPs, design, do-and-don't, compliance, competitors are project-level — every agent that operates on the project reads them. They live under `projects/<project>/guidelines/`.
3. **Tooling is scoped where it belongs.** Universal MCPs/skills/plugins at root. Agent-scoped at the agent. No per-project tooling — projects share the agent's tools.
4. **Files are the memory layer.** No vector DB, no embedding store. Markdown + YAML + Git.
5. **Project-scoped lessons override global on conflict.** Local always wins at runtime.
6. **Schedules are stateless.** A native local scheduler (Claude Desktop Scheduled Tasks, Codex app Automations, or a Codex cron entry installed via `roster schedule install --via cron`) fires a fresh CLI session that loads `CONTEXT.md` and invokes the `roster-orchestrator` skill. All model usage draws from the user's interactive subscription — no Agent SDK, no headless API keys.
7. **The dreamer learns; agents act.** Reinforcement is a separate, deliberate process. Live agents don't update playbooks.

## Directory map

```
agent-team/
├── .claude/                                # universal Claude Code config
├── .mcp.json                               # universal MCPs
│
├── <function>/                             # gtm | product | design | ops | (others — see .config/functions.yaml)
│   ├── EXPERT.md                          # function-level expert prompt (optional, see has_expert in registry)
│   └── <agent>/
│       ├── agent.md
│       ├── README.md
│       ├── playbook/                       # GLOBAL lessons for this agent
│       ├── logs/                           # agent-level operational logs
│       ├── subagents/
│       ├── .claude/                        # agent-scoped tools
│       ├── .mcp.json                       # agent-scoped MCPs
│       └── projects/
│           ├── _template/
│           └── <project>/
│               ├── config/default.yaml
│               ├── playbook/               # PROJECT-scoped lessons for this agent
│               ├── log/runs/<YYYY-MM>/
│               ├── log/feedback/<YYYY-MM>/
│               └── asset-references.md     # which project assets this agent uses
│
├── dreamer/                               # cross-cutting reinforcement agent
│   └── <same shape>
│
├── chief-of-staff/                            # cross-cutting maintenance agent (operates on repo)
│   ├── agent.md
│   ├── README.md
│   ├── playbook/
│   └── logs/                               # operation logs + audit reports
│
├── projects/                               # PROJECT-LEVEL — cross-agent
│   ├── _template/
│   └── <project>/
│       ├── CLAUDE.md
│       ├── GUIDANCE.md
│       ├── state.md
│       ├── guidelines/
│       │   ├── voice.md
│       │   ├── icps/<persona-slug>.md      # multiple personas, one file each
│       │   ├── design.md
│       │   ├── design-tokens.md
│       │   ├── brand-book.md
│       │   ├── messaging.md
│       │   ├── do-and-dont.md              # may be empty stub
│       │   ├── compliance.md               # may be empty stub
│       │   ├── competitors.md              # may be empty stub
│       │   └── asset-links.md              # local paths + URLs to external assets
│       └── assets/                         # local files (gitignored if large)
│
├── scripts/                                # scaffolding + cron
└── logs/cron/                              # cron stdout/stderr
```

## Function categories

The set of function categories is defined in `.config/functions.yaml`. The four initial functions are `gtm/`, `product/`, `design/`, `ops/`. Cross-cutting infrastructure agents `dreamer/` and `chief-of-staff/` are NOT functions — they're peers, not under any function.

To add a new function, use `bash scripts/create-function.sh <slug>` or via chief-of-staff: "create function <slug>".

Add a new function only when at least 2-3 agents will live there within ~90 days. Otherwise put the agent in the closest existing one.

## Tool bindings

Each agent that uses external tools declares a `## Tools and bindings` section in its `agent.md`. This is a YAML code block that names tools, expected per-project bindings, a `required` flag, and a description.

```yaml
gmail:
  send_as:
    required: true
    description: "Email alias to send from"
  apply_label:
    required: false
    description: "Gmail label applied to outbound"
```

When chief-of-staff scaffolds a new agent-instance via `create-project` or `add-agent-to-project`, it parses this block and prompts the user for each binding. Values land in the agent-instance's `config/default.yaml` under `tools:`.

### Runtime read order

When invoked, an agent reads:

1. Its `agent.md` (logic + bindings schema)
2. The instance's `config/default.yaml` (behavior params + tool bindings under `tools:`)
3. Its tools' bindings from `tools:`, validating that required bindings are not TODO placeholders

If a required binding is unfilled, the agent aborts before doing tool work, with a clear message naming the missing binding.

### Skipping during scaffolding

User can press Enter or type `skip` at any prompt. Skipped bindings land as `# TODO: <description>` placeholders. Optional bindings with TODO are silently skipped at runtime; required bindings with TODO cause a runtime error.

### Editing later

Tool bindings can be edited directly in `config/default.yaml` at any time. No re-scaffolding needed.

### Project-level vs agent-level bindings

This convention scopes bindings at the agent-instance level. Bindings genuinely shared across multiple agents in a project are duplicated across configs by design — chosen for simplicity at current scale. If shared bindings ever multiply, refactor to project-level `tool-bindings.yaml`; the schema is forward-compatible.

### Defining the schema during agent creation

When a new agent is created via `bash scripts/new-agent.sh <fn> <agent>` (or via chief-of-staff `create-agent`), the script asks whether to define tools now. If yes, the user provides a comma-separated list of tool names. The script scaffolds a `## Tools and bindings` section with stub blocks per tool. The user then fills in actual bindings (with `required` flags and descriptions) by editing `agent.md` directly.

If skipped, the section is absent and can be added manually later. Agents without a `## Tools and bindings` section don't trigger the binding prompt during instance scaffolding — `new-agent-instance.sh` checks for the section and skips silently if missing.

## Plans and slash commands

Agents execute named plans. A plan is a YAML file at `<function>/<role>/plans/<plan-name>.yaml` that defines a workflow recipe — ordered steps using subagents and tools, with input/output contracts.

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
      <key>: ${tools.X.Y}         # reference instance tool bindings
      <key>: ${inputs.X}          # reference plan inputs
      <key>: ${config.X}          # reference instance config
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

Each agent has a project-level slash command at `.claude/commands/<role>.md`. The slash command is a thin router that:

1. Loads the agent's `agent.md`
2. Parses the user's request for `run <plan-name> for <project>`
3. If a plan is named: loads the plan, validates bindings, executes, logs the run
4. If only a project is named: lists available plans, asks the user
5. If neither: lists projects and plans

Slash commands are auto-scaffolded by `scripts/new-agent.sh`. Naming: `/sdr`, `/graphic-designer`, `/ux-designer` — match the agent's role-based name.

### Invocation patterns

```
/sdr run cold-outreach for _demo
/sdr for _demo                          # asks which plan
/graphic-designer run logo-design for _demo
```

Or in natural language (slash command not strictly required):

```
"Run gtm/sdr on _demo using cold-outreach plan"
```

### Plans vs experts (key distinction)

Agents run plans (deterministic, repeatable, scheduled-friendly). Experts at the function level (`<function>/EXPERT.md`) handle goal-directed work (judgment-heavy, ad-hoc). When a user wants strategic exploration or substrate generation, the expert is the right invocation. When they want a known workflow executed, the agent + plan is the right invocation.

If you find yourself wanting "one-off" agent runs, you're probably looking for expert invocation, not agent invocation.

### No default plans

Agents do NOT have a default plan. Invoking an agent without a named plan triggers an interactive "which plan?" prompt. This is intentional — explicit is better than implicit, and it prevents accidental runs of the wrong workflow.

### Scheduling

Plan invocations integrate with Claude Code's native `/schedule` feature. To schedule a plan: use Claude Desktop's scheduled tasks with the prompt `/sdr run cold-outreach for _demo` (or equivalent). Plans don't have a `schedule` field — scheduling is a layer above the plan, not part of it.

## Experts

Each function MAY have an `EXPERT.md` at `<function>/EXPERT.md`. An expert is a system prompt that defines a function-level advisor — used for shaping substrate (project guidelines), not producing tactical artifacts.

Whether a function has an expert is tracked in `.config/functions.yaml` via the `has_expert` flag.

### What experts produce

Experts write to `projects/<project>/guidelines/<file>.md` — voice, ICPs, messaging, brand-book, design principles, design tokens, do-and-dont, compliance, competitors, asset-links. The exact subset depends on the function.

Experts do NOT write tactical artifacts (specific emails, single posts, individual component code). Those belong to agents.

### Read-first protocol

When invoked, an expert reads in this order:

1. `projects/<project>/CLAUDE.md` — project identity
2. Existing `projects/<project>/guidelines/*.md` files relevant to the task
3. `projects/<project>/state.md` — current focus

Then identifies gaps and asks only about gaps. Never re-asks what's already in substrate.

### Invocation

To invoke an expert from any session in the repo:

> "Use the [function] expert. Generate [file] for [project]."
> "Use the GTM expert to critique projects/_demo/guidelines/icps/."

The session reads the function's EXPERT.md and follows its protocol.

### Expert vs agent: the rule

Experts shape substrate. Agents produce artifacts. See root `CLAUDE.md` § "Experts vs agents" for the full distinction with examples.

## File naming

- All lowercase, kebab-case: `sdr`, `cv-tailor`, `trend-scanner`.
- Lesson IDs: `L-YYYY-MM-DD-NNN`.
- Run files: `YYYY-MM-DD-HHMM.md` (24-hour, local time).
- Feedback files mirror run filenames exactly.
- Configs: `<purpose>.yaml` (typically `default.yaml`).

## Agent contract (agent.md)

Required sections:

```markdown
# <Agent Name>

## Purpose
What this agent does, why it exists.

## Inputs
What the orchestrator expects from the caller (plan name, project, per-plan inputs).
Files read at runtime (config path, guidelines paths, playbook paths).

## Plans
List of named plans this agent runs (files in `<function>/<role>/plans/<plan>.yaml`).
One-line description per plan. No default plan — invocation without a plan triggers an interactive prompt.

## Subagents
List with one-line descriptions.

## Tools and bindings
Per-project tool bindings declared as a YAML block. See § "Tool bindings".

## Outputs
Schema of the run output file. Per-plan output schemas live in the plan's `outputs:` block.

## Approval
HITL routing. Default: `auto`.

## Lessons protocol
What gets logged as candidate lessons during a run.
```

`## Steps` is no longer part of the agent contract — workflow logic lives in plans (see § "Plans and slash commands").

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

## Config schema (config/default.yaml)

```yaml
---
agent: sdr
project: _demo
created: 2026-04-26
last_modified: 2026-04-26
---

# Project-specific parameters
# Use prose comments to explain "why" alongside "what"

target_personas: [founding-team-hiring-manager, vp-eng-series-b]
channels:
  primary: linkedin
  fallback: email
weekly_cap: 10
approval_channel: auto

# Reference files (project-level)
voice_ref: ../../../../../projects/_demo/guidelines/voice.md
icps_ref: ../../../../../projects/_demo/guidelines/icps/
do_and_dont_ref: ../../../../../projects/_demo/guidelines/do-and-dont.md
compliance_ref: ../../../../../projects/_demo/guidelines/compliance.md
```

Agents resolve referenced files at runtime. Paths are relative from the config file location.

## Lesson schema

One file per lesson. Same schema everywhere — at agent level (global) or instance level (project).

```markdown
---
id: L-2026-04-26-001
source: human                    # human | dreamer
scope: global                    # global | project
project: _demo                 # required if scope=project; "—" if scope=global
agent: sdr
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
validated_in: [_demo]
promoted_to_global: false
---

# <Lesson title>

## Pattern observed
...

## Recommendation
...

## Why this might be project-specific
...

## Retirement criteria
...
```

### Lesson lifecycle

- **observing**: pattern detected, evidence below threshold. Not applied to runs yet.
- **candidate**: evidence above threshold, awaiting HITL approval.
- **validated**: HITL approved. Applied to runs.
- **retired**: no longer applies. Kept inline with reason.

### Source field

- **human**: you wrote this lesson by hand. Could be at agent level (global) or instance level (project). The dreamer respects human lessons — won't override, only extend with HITL approval.
- **dreamer**: the dreamer agent drafted this from runs+feedback. Started as `observing`, may have been promoted through HITL.

### Promotion rule (project → global)

A `validated` project lesson may be promoted to `global` when:

1. Same pattern validated in 2+ projects independently
2. Dreamer's promotion-arbiter flags it as a candidate
3. HITL approves via Slack

Conflicting validated lessons across projects do NOT merge. They stay project-scoped, with `conflicts_with` pointers, and the global playbook records "this is project-dependent — see [list]."

### Where lessons live

- `<function>/<agent>/playbook/L-...md` — `scope: global`
- `<function>/<agent>/projects/<project>/playbook/L-...md` — `scope: project`

Same schema everywhere. The folder location and the `scope` field must agree.

## Run file format

`<function>/<agent>/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

```markdown
---
agent: sdr
project: _demo
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

Mirrors run filename exactly. `log/feedback/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

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

`projects/<project>/state.md` — written by `/save-state`. Five lines max.

```markdown
---
updated: 2026-04-26T19:00:00+03:00
---

Last task: drafted Q3 positioning hypothesis
Active artifacts: gtm/positioning/q3-draft.md
Open questions: ICP narrowing — fintech only or include b2b SaaS?
Next session: review draft with brand voice agent
Notes: dreamer flagged 2 candidate lessons in Slack — review before next outreach run
```

## Project guidelines

Files under `projects/<project>/guidelines/`. Read by every agent operating on the project (where relevant per agent.md).

| File | Purpose | Required? |
|---|---|---|
| `voice.md` | Tone, vocabulary, sentence patterns, energy | Yes |
| `icps/<slug>.md` | Persona/ICP definitions — multiple files for multiple personas | Yes (≥1) |
| `design.md` | Design principles | Yes |
| `design-tokens.md` | Colors, typography, spacing as tokens | Yes |
| `brand-book.md` | Visual identity overview, logo usage | Yes |
| `messaging.md` | Value props, headlines, taglines, anti-claims | Yes |
| `do-and-dont.md` | Explicit project-specific operating rules | Stub, fill when needed |
| `compliance.md` | Legal/regulatory constraints | Stub, fill when needed |
| `competitors.md` | Competitive context, how to position | Stub, fill when needed |
| `asset-links.md` | Local paths + URLs to brand assets (logos, fonts, mood) | Yes |

ICPs note: each persona is a separate file under `icps/`. Buying signals, intent triggers, qualification criteria all live inside the relevant ICP file (not in a separate signals.md).

## Asset references

Two sides:

**Project-level** (`projects/<project>/guidelines/asset-links.md`): the source of truth. Where every asset for the project actually lives. Mix of local paths (`~/Design/...`) and URLs (Google Drive, Figma, Framer).

**Agent-instance level** (`<function>/<agent>/projects/<project>/asset-references.md`): a thin file listing which subset of project assets this agent uses, by name (referencing the project asset-links). This makes it explicit and cheap to audit "what does sdr need from Acme Corp's assets?"

Example agent-level `asset-references.md`:

```markdown
# Asset references — sdr / _demo

This agent uses these assets from `projects/_demo/guidelines/asset-links.md`:

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
2. Adding the env var to `.env` (e.g., `SLACK_HITL_CHANNEL_SYSTEM_ARCHITECT=#system-architect`)

The `create-function` operation prints a reminder when scaffolding a new function.

Approval expires after 24h by default. Workflows specify own TTL if different.

## Schedules

Schedules fire from a native local desktop scheduler. Each fire spawns a fresh CLI session in the workspace that loads `CONTEXT.md` and invokes the `roster-orchestrator` skill; the orchestrator dispatches the agent's subagent via the tool's native primitive (Claude `Task` tool or Codex agent invocation). No `claude -p`, no Anthropic Agent SDK, no programmatic API keys — all model usage draws from the user's interactive Claude Pro/Max or ChatGPT Plus/Pro subscription. `roster doctor` enforces this.

Canonical entry point:

```sh
roster schedule install <function>/<agent> <plan> \
  --cron "<expr>" --tool claude|codex [--via cron]
```

The first two positional arguments are `<function>/<agent>` (e.g., `gtm/sdr`) and the plan path within that agent. `--cron` and `--tool` are required; `--via` defaults to `ui-handoff`, `--name` defaults to `<agent>-<plan>`, `--project` defaults to `_demo`. The command writes one entry per schedule to `roster/<function>/schedules.yaml` and renders a tool-specific install artifact:

- `--tool claude` — emits `.roster/schedule-specs/<name>.claude.fields.md` for paste-in to Claude Code's Desktop Scheduled Tasks UI. Programmatic install is tracked upstream at [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364); until it lands, hand-off is markdown, not JSON.
- `--tool codex` (default `--via ui-handoff`) — emits `.roster/schedule-specs/<name>.codex.fields.md` for paste-in to the Codex desktop Automations UI.
- `--tool codex --via cron` — installs a hardened crontab line directly (wrapped by `env -i` for environment scrubbing, with a subscription-attestation preflight). Codex-only; refused on Windows.

Each run:

1. Loads `CONTEXT.md` (via the `CLAUDE.md` or `AGENTS.md` symlink)
2. Invokes the `roster-orchestrator` skill
3. Orchestrator dispatches the agent subagent in isolated context (nested subagents allowed)
4. Run output → the agent's instance `log/runs/` as normal
5. HITL items → `roster/<function>/pending/` — chat sessions surface a banner on next start
6. Exits

### Failure observability

Two complementary signals catch the cases where a fire doesn't complete cleanly:

- **`roster/<function>/state.md`** — orchestrator skill appends one line per fire (`<utc-iso> | <function>/<agent>/<plan>/<project> | success|failed`). This is the *agent-level* signal: it requires the orchestrator to actually run to completion.
- **`logs/cron/<name>.exit`** — for codex `--via cron` schedules, the wrapper records the process exit code (1-3 byte ASCII integer) independently of the agent. Non-zero here means cron fired but the codex process exited with an error.

`roster doctor` (the `Scheduling fires` section) cross-references both. `roster pending sync` synthesizes `roster/<function>/pending/error-<id>.md` items from any non-zero `.exit` or STALE detection (last run older than expected next-fire + 2h grace). The SessionStart hook runs `pending sync` automatically before counting items, so a failed fire surfaces in the very next chat session — no manual step required.

Optional: add `capture_events: true` to a codex via-cron entry to also capture the `codex exec --json` event stream at `logs/cron/<name>.events.jsonl` (stdout split from log).

See [ADR-0001: Scheduling architecture](https://github.com/firatcand/roster/blob/main/docs/adr/0001-scheduling-architecture.md) for the rationale and rejected alternatives.

## External-action gates

Any agent that takes external action (post, send, message, write to CRM) must:

1. Specify HITL approval (default `auto`)
2. Implement daily/weekly cap from config
3. Implement auto-reject TTL for unapproved actions
4. Log all actions to `log/runs/` regardless of outcome (sent, rejected, expired)

Applies to: sdr, twitter-automation, job-application, anything writing externally.

## What we're not building (and triggers to revisit)

| Not built | Trigger to revisit |
|---|---|
| Vector memory layer | A single playbook file exceeds context window OR fuzzy retrieval becomes a felt need. |
| Long-running harness | A workflow with validated <5min latency requirement that cron polling at 2-min interval cannot serve. Fake on cron first. |
| Multi-agent framework (LangGraph etc.) | Claude Code subagents prove insufficient for a real coordination need. |
| Cross-project agent calls | A specific co-marketing or shared-asset use case emerges. Until then, lessons promote globally; agents do not call across. |
| Per-project tool scoping | An agent needs different tools for different projects (e.g., outreach uses HeyReach for one project, Outreach.io for another). Today, agent-level tooling assumes consistent toolset across all projects. |
| Hermes / multi-runtime | Persistent state across days with autonomous resumption AND Claude Code session model is shown to fail. Both required. |
| Multi-tenant config storage | An agent needs to support a second user beyond the original owner. |
| Per-domain dreamers | Cross-domain pattern detection turns out to be unhelpful. |

## When the convention isn't clear

Ask before guessing. Inconsistent conventions are worse than missing ones. Write the convention into this file once decided, with a date.

---

Last updated: 2026-04-27.
