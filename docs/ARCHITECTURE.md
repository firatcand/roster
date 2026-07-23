# Architecture

The design rationale for Roster. Read this if you want to understand *why* the structure looks the way it does, before deciding whether (or how) to change it.

## Why this exists

Most multi-agent systems fall apart at scale for one of three reasons:

1. **Context loss across sessions.** Each conversation re-derives what voice, audience, and constraints look like. The system never compounds.
2. **No clear separation between strategy and execution.** Strategy gets re-litigated inside every tactical run, or strategic decisions silently get made by tactical agents.
3. **No reinforcement loop.** Agents don't get better. Mistakes recur. The user becomes the memory.

Roster is a discipline for keeping multi-agent systems coherent across contributors and time. It makes a few opinionated decisions that, taken together, prevent those three failure modes.

## The two-tier agent model

Two layers of structure, each with one job:

```
Function (gtm/, product/, design/, ops/)
  └── Agent (gtm/sdr/, design/graphic-designer/)
```

- **Functions** group related work. They mirror the way humans organize teams. They host one EXPERT.md (substrate-shaping advisor) and zero or more agents.
- **Agents** are role-based execution units. They have a contract (`agent.md`), one or more named plans (`plans/`), reusable subagents (`subagents/`), and a flat `<agent>/.env` for secrets that override or extend the workspace `.env`.

A Roster workspace IS the project. There's no per-project sub-tier and no `projects/` directory — every solo founder and small team Roster targets runs one product, one set of guidelines, one ICP family. Collapsing the project dimension removed seven `chief-of-staff` plans, a `promotion-arbiter` subagent, and a 3-tuple scheduling schema.

## Substrate vs artifacts

This is the load-bearing distinction in the whole system. Misusing it makes everything brittle.

**Substrate** is the slow-changing strategic context for the workspace: brand voice, ICPs, messaging frames, brand book, do-and-don't rules, compliance constraints. It changes weeks or months at a time. It lives at the workspace root:

```
config/project.yaml      # identity (name, stage, audience, motion)
guidelines/voice.md      # how this brand talks
guidelines/messaging.md  # value props, positioning lines
guidelines/brand-book.md # tone, palette, type, do/don't
guidelines/icps/*.md     # one file per persona
guidelines/asset-links.md
```

**Artifacts** are the daily tactical output: cold emails, LinkedIn posts, components, design files, content drafts. They change every run. They live under the agent:

```
<function>/<agent>/logs/runs/<YYYY-MM>/    # run log per invocation
<function>/<agent>/logs/feedback/<YYYY-MM>/ # user reactions
<function>/<agent>/pending/                # HITL approval queue
```

Substrate informs every artifact. Artifacts never modify substrate.

This split is enforced by which thing produces which: **experts produce/refine substrate. Agents produce artifacts.** The slash-command surface (`/<agent>` for artifacts, "use the X expert" for substrate) reinforces it.

If you find yourself wanting an agent to "redefine the voice as we go", you've actually wanted an expert. If you find yourself wanting an expert to "send tomorrow's outreach", you've wanted an agent.

## Experts

Each function MAY have an `EXPERT.md` at `<function>/EXPERT.md`. An expert is a system prompt that defines a function-level advisor. It's invoked conversationally, judgment-heavy, ad-hoc.

Experts:
- Read existing workspace context first (`CLAUDE.md`, `config/project.yaml`, `guidelines/`)
- Identify gaps and ask only about those
- Produce or refine files in `guidelines/`

Experts do NOT:
- Run scheduled workflows
- Produce tactical artifacts (one-off emails, posts, components)
- Have subagents, plans, runs, or feedback loops

If you need a strategic critique, ICP definition, or messaging framework, it's expert work. If you need this week's outbound list, it's agent work.

The included experts (`gtm/EXPERT.md`, `product/EXPERT.md`, `design/EXPERT.md`) are opinionated — they reflect one founder's judgment about which thinkers, frameworks, and skills matter. They're banner-marked as such. Replace freely.

## Agents and plans

Agents run via named plans. A plan is a YAML file at `<function>/<agent>/plans/<plan-name>.yaml` that defines a workflow recipe — ordered steps using subagents and tools, with input/output contracts.

The shape:

```yaml
plan: <name>
description: |
  ...
inputs:
  <field>: { required, default, description }
outputs:
  <field>: <type>
steps:
  - id: <step>
    subagent: <name>           # or tool: <name> or agent: <fn>/<role>
    description: <one-liner>
    args:
      <key>: ${tools.X.Y}      # references config.yaml tool bindings
      <key>: ${inputs.X}       # references plan inputs
      input_from: <prior-step>
approval_channel: auto | session | slack | none
caps:
  <field>: <value>
```

Why plans (instead of putting workflows in `agent.md` as numbered steps):

- **Multiple workflows per agent.** One agent might run `cold-outreach`, `reply-handler`, `meeting-followup` — three plans, one agent.
- **Cron-friendly.** A plan name is a stable target for scheduling. `/sdr run cold-outreach` is something you can put in a scheduled task.
- **Auditable.** Plans are declarative. You can read them without running them.
- **Reusable.** A plan can call another agent's plan via the `agent:` step type.

There is no default plan. Invoking an agent without a named plan triggers an interactive "which plan?" prompt. This is intentional — explicit is better than implicit.

## Subagents

Subagents are reusable building blocks within an agent. They live at `<function>/<agent>/subagents/<name>.md`. Each subagent has a narrow job: prospector finds prospects, enricher fills missing fields, writer drafts copy, critic reviews drafts.

A subagent has its own contract: Role, Inputs, Output, Tools, Boundaries, Quality bar. Plans invoke them in sequence (or with branching).

Subagents are the place to put complexity that's specific to the agent but shared across its plans. They are NOT the place to put cross-agent logic — if two different agents would benefit from the same subagent, the right move is usually a separate cross-agent invocation, not duplication.

Distinct from those workspace-local subagents, roster also ships a handful of **tool-global delegated subagents** to each host's agent directory (`lesson-drafter`, `pattern-detector`, `brain-organizer`). These are dispatched by a skill via the host's native subagent primitive, not from a plan. The `brain-organizer` (owned by the `brain` skill) takes a raw idea or corpus and organizes it into the brain — extract → dedup-before-create → link → tag, append-only — reusing only `roster brain` verbs and following `brain/RESOLVER.md`. It runs on the host's subscription like every other subagent; it never reaches for a programmatic model-billing path.

## Env resolution

Every agent dispatch runs with a merged environment dictionary. Two sources, in order of precedence:

1. **Agent `.env`** — `<function>/<agent>/.env`. Per-agent overrides. Optional.
2. **Workspace `.env`** — `/.env`. Shared default for the whole workspace.

```
gtm/sdr/.env                       # this layer wins, key by key
  └── inherits unset keys from
/.env                              # workspace defaults
```

Resolution is **per-key, not per-file**: each environment variable is resolved independently. Keys missing from the agent `.env` inherit from the workspace `.env`. Keys missing from both are unset.

**Empty-string semantics.** A key defined as empty in an agent `.env` is explicitly unset — it does NOT inherit:

```dotenv
# gtm/sdr/.env
OPENAI_API_KEY=                    # explicit: don't even inherit from workspace
APOLLO_API_KEY=sk-sdr-quota-xxx    # override workspace value
SLACK_BOT_TOKEN                    # (not present here) → inherits from /.env
```

This lets an agent opt out of an upstream key without having to delete it from the workspace.

**Loader.** `resolveAgentEnv(workspaceRoot, agentPath)` lives in `src/lib/env-merge.ts`. It uses the same dotenv parser as `roster doctor` (no second parser; no extra dependency). The loader is pure: each dispatch reads fresh from disk. There's no caching, no global mutable state, and no leakage across agent invocations — sibling agents fired from the same workspace see isolated env dicts.

**Permissions.** Both `.env` files are validated at `roster doctor` check 11 (workspace) and check 13 (agent) for `0600`. World-readable agent `.env` is a doctor error, not a warning.

**Doctor checks 14 + 15** cover misuse: check 14 warns when an agent re-declares a workspace key with the identical value (redundant — agent inherits anyway); check 15 errors when a `config.yaml` references an `env_var` that's unset in the merged dict, telling you exactly which file to fix.

## The lesson protocol

Lessons are how the system learns. Every lesson is a markdown file at one path:

```
<function>/<agent>/playbook/L-YYYY-MM-DD-NNN.md
```

There's no project-vs-global lesson scope — lessons attach to the agent that produced them. (The dreamer's old `promotion-arbiter` step was deleted with the project dimension; lessons land in the playbook directly.)

Each lesson has frontmatter:

```yaml
lesson_id: <slug>
created: YYYY-MM-DD
last_observed: YYYY-MM-DD
status: observing | candidate | accepted | retired
extends: <lesson-id>     # optional
contradicts: <lesson-id> # optional
```

Body sections:
- **Pattern observed** — what's the recurring signal?
- **Recommendation** — what should the agent do next time?
- **Retirement criteria** — what evidence would invalidate this?

Lessons are consumed when an agent runs: the orchestrator reads the agent's playbook directory and treats `accepted` lessons as soft rules. `retired` lessons are kept for history but not surfaced to the agent.

## The dreamer reinforcement loop

The dreamer is a cross-cutting agent that runs nightly (or on demand). It:

1. Reads all runs and feedback since the last cutoff
2. Detects patterns (repeated user edits, recurring failure modes, signal/no-signal anchors)
3. Drafts lesson candidates via the `lesson-drafter` subagent
4. Routes them to `<agent>/pending/` for HITL approval
5. On approval, writes the lesson to `<agent>/playbook/`
6. Updates state with the new cutoff

The dreamer is the only agent allowed to write to playbook files (apart from a human writing one by hand). This prevents lesson churn from runtime-mutating agents and keeps lesson curation deliberate.

The dreamer respects human-authored lessons. It doesn't modify or supersede them without explicit HITL approval. Mistakes are reversible — lessons can be retired by setting `status: retired`.

## The chief-of-staff

The chief-of-staff is a cross-cutting agent that operates ON the workspace itself, not on business workflows. Its plans wrap the backing scripts in `scripts/`:

- `create-agent` — scaffold a new agent under a function
- `create-function` — register a new top-level function
- `audit-agent` — check one agent for completeness
- `audit-repo` — aggregate agent reports + workspace completeness

It exists because:
- Manual scaffolding is error-prone (forgotten directories, mismatched config schemas)
- Audit can't be ad-hoc (you need a definition of "complete" to check against)

Chief-of-staff plans always confirm before destructive changes. They never auto-commit.

## HITL routing

Human-in-the-loop approval routes to one of two places:

1. **In-session** — when an interactive caller invoked the agent. Faster, lower-friction.
2. **Slack** — when there's no interactive caller (cron, `/schedule`). Routes to the function's channel (`#gtm`, `#product`, `#design`, `#ops`) for function agents, or `#admin` for cross-cutting agents (dreamer, chief-of-staff).

The Slack channel name comes from per-function env vars: `SLACK_HITL_CHANNEL_<FUNCTION>` (e.g., `SLACK_HITL_CHANNEL_GTM`). `SLACK_HITL_CHANNEL_ADMIN` is the cross-cutting fallback.

`approval_channel: auto` enables this routing automatically. `approval_channel: session` forces in-session (fails if none). `approval_channel: slack` forces async.

## Tool bindings

Per-agent tool bindings live in `<function>/<agent>/config.yaml` under a `tools:` key. The schema is declared in the agent's `## Tools and bindings` section.

```yaml
agent: gtm/sdr
plans_dir: ./plans/
guideline_refs:
  voice: /guidelines/voice.md
  icps: /guidelines/icps/
  brand_book: /guidelines/brand-book.md
tools:
  apollo:
    env_var: APOLLO_API_KEY
    required: true
  slack:
    env_var: SLACK_BOT_TOKEN
    required: false
```

`required: true` bindings cause the agent to error at runtime if the referenced env var is unset in the merged env (see [Env resolution](#env-resolution)). `required: false` is optional — the agent skips the related capability when absent.

`guideline_refs:` paths starting with `/` are **workspace-root-relative**, not absolute filesystem paths. The loader strict-rejects literal absolute paths (`/Users/...`, `/home/...`, `/etc/...`) to avoid ambiguity.

Guideline files come in two tiers. **Workspace-canonical** files are listed in the scaffold's `conventions.md` table, warned on by `audit-repo.sh` when marked Required, and — for the `voice`/`icps`/`messaging` trio — referenced by default in every agent `new-agent.sh` scaffolds. **Project-local** files are any `guidelines/<name>.md` you create and opt into per agent via `guideline_refs:`. Promotion from local to canonical is a documented manual checklist (`conventions.md` § "Adding a new guideline file") — no CLI machinery. Both tiers survive `roster upgrade`: `guidelines/` is excluded from upgrade by default (`DEFAULT_UPGRADE_EXCLUDES`), so user-authored guideline content is never touched.

This pattern keeps secrets out of `agent.md` (which is committed) and out of `config.yaml` (which is also committed but contains references like `env_var: APOLLO_API_KEY`, not the value itself). Values live in `.env` files only.

## Scheduling

Scheduling is a layer above plans, not part of them. Plans don't have a `schedule` field.

Schedules fire from each AI tool's **native local desktop scheduler** — Claude Desktop Scheduled Tasks, Codex Automations, or a hardened crontab line installed by `roster schedule install --tool codex --via cron`. Roster registers schedule entries via `roster schedule install`; each fire spawns a fresh CLI session in the workspace, loads `CONTEXT.md`, invokes the `roster-orchestrator` skill, and dispatches the agent's subagent in isolated context. All model usage bills against the user's interactive Claude Pro/Max or ChatGPT Plus/Pro plan — `claude -p`, the Anthropic Agent SDK, and any programmatic API key path are banned and enforced by `roster doctor`.

Schedule entries are 2-tuples (`agent`, `plan`) plus install metadata — there is no `project` field. Trying to install a v0.4 entry with a `project` key errors with a CHANGELOG pointer.

Why this split: scheduling concerns (when, retry policy, dependencies) are different from workflow concerns (what to do). Keeping them separate means you can change the cadence without touching the plan, and you can run the same plan ad-hoc without a scheduler.

See [SCHEDULING.md](SCHEDULING.md) for the platform × tool matrix and install flows, and [ADR-0001](adr/0001-scheduling-architecture.md) for the rationale and rejected alternatives.

## The persistence boundary (operations ledger)

Operational state — HITL requests and decisions, run events, artifacts, and the counts behind the banner/inbox — sits behind an explicit persistence boundary. Every workspace chooses its backend in `roster/persistence.yaml` (written by `roster ops setup`); higher layers depend on store interfaces (`HitlStore`, `RunStore`, `ArtifactStore`), never on Markdown paths or SQL directly. Workspaces without the file keep today's file-based behavior unchanged.

Two backends, both first-class:

- **`local`** — an append-only JSONL ledger under `.roster/ops/`. Durable (fsync + checked writes + torn-tail seal recovery), hash-chained for tamper-evidence, multi-process safe via lockfiles.
- **`postgres-s3`** — structured records in Postgres (`hitl` + `roster_ops` schemas; reuse the brain database or a dedicated one) and immutable payload bytes in a dedicated S3-compatible bucket. Remote outages spool spoolable writes to a durable local outbox that replays idempotently in order; HITL decisions never spool — they require the live store (fail closed).

**Trust model: one database, one bucket, one workspace.** Isolation is physical, not policy-based (no RLS). Setup stamps the database with the workspace UUID and claims the bucket with a root marker object; every new connection verifies the stamp, and every resolution re-verifies the marker digest against the one recorded in the database. Pointing a workspace at another workspace's database or bucket is refused before any read or write. The bound database is the trust root; the bucket marker is the cross-workspace accident tripwire.

**Admin vs runtime credentials.** Credentials are env-only — `persistence.yaml` never holds secrets. Setup uses the admin URL (`ROSTER_OPS_ADMIN_URL`, or `ROSTER_BRAIN_ADMIN_URL` when reusing the brain database) to migrate schemas, stamp the binding, claim the bucket, and grant the runtime role its least-privilege set: SELECT everywhere, INSERT only on the append tables, sequence USAGE only — no UPDATE/DELETE/TRUNCATE, no DDL, no meta writes. The runtime URL (`ROSTER_OPS_URL` / `ROSTER_BRAIN_URL`) is all the day-to-day path ever uses. Setup refuses to finalize while the runtime role holds anything stronger (the gate names each surplus privilege and the exact REVOKE). The S3 split mirrors this: runtime credentials get put/get on the data prefixes and read-only access to the marker; delete, overwrite, listing, and bucket administration stay admin-only.

**Where data lives locally.** `.roster/ops/` is gitignored machine-local state, namespaced by workspace UUID so a `--new-identity` fork starts a fresh tree and the old one stays archived:

```
.roster/ops/
  setup-journal.json                 # in-flight setup only (fixed path, removed at done)
  <workspaceId>/
    meta.json                        # identity + producer id + component versions
    <namespace>/segment-NNNN.jsonl   # hitl/ runs/ artifacts/ — append-only ledger (+ .seal sidecars)
    outbox/                          # queued remote writes (events + checkpoint.json)
    spool/<sha256>                   # content-addressed artifact bytes awaiting publication
    artifacts/<sha256>               # local-backend artifact bytes (content-addressed, beside that namespace's segments)
```

**What this is NOT.** Append-only is an API guarantee plus hash-chain tamper-*evidence*, not OS tamper-proofing — anyone with filesystem access can edit segments (edits break the chain detectably). It is also not hostile multi-tenancy: the postgres-s3 isolation model assumes each workspace brings its own database and bucket; it defends against accidents (cloned repos, swapped URLs, wrong buckets), not against a malicious co-tenant sharing your credentials.

See [ADR-0004](adr/0004-operations-ledger-contracts.md) for the full protocol reference (store contracts, binding protocol, outbox event model, setup journal, capability negotiation) and [API.md §Ops](API.md#ops-roster-ops-setup) for the command surface and permission matrices.

## Why these opinions

Each opinion was driven by a specific constraint:

- **Functions, not arbitrary categories** → so org structure mirrors team mental models
- **Substrate vs artifacts** → so strategic context doesn't get rewritten by tactical runs
- **One workspace, one project** → so the common-case Roster user doesn't pay for a multi-tenant abstraction they'll never use
- **Plans, not in-prose workflows** → so workflows are testable, schedulable, auditable
- **Lesson schema with single playbook path** → so reinforcement compounds without curation overhead
- **Dreamer is the only writer to playbooks** → so lesson curation is deliberate
- **HITL is mandatory for external actions** → so unattended runs can't go off the rails
- **Agent `.env` inherits from workspace** → so secrets are scoped where they're used without duplication
- **Subscription-only model usage** → so cost is bounded and predictable

## What this is not

- **Not a hosted SaaS.** You run it locally connected to your own Claude Code, Codex CLI, or Gemini.
- **Not LLM-agnostic.** It depends on host-CLI primitives — slash commands, native desktop scheduled tasks (Claude Scheduled Tasks / Codex Automations), the `Task` tool / Codex agents, and `CLAUDE.md` / `AGENTS.md` context discovery. Porting to another CLI is non-trivial and out of scope.
- **Not a goal-directed agent framework.** The goals come from you and live in plans and workspace guidelines. The framework just orchestrates execution.
- **Not multi-tenant.** A workspace is one project. If you need a second project, scaffold a second workspace.
- **Not a replacement for thinking.** It's structure for organizing your thinking and your agents' execution.

## Future work / open questions

- **Cross-agent plan invocation.** The schema supports `agent:` steps, but the runtime convention isn't fully exercised. Patterns emerge as workspaces use it.
- **Plan composition.** Could plans inherit or compose? Currently they don't — each plan is independent. Worth revisiting after enough plans accumulate.
- **Lesson contradiction resolution.** When two lessons conflict, the current rule is "human decides". A more automated arbitration story might emerge from dreamer evolution.
- **Agent observability.** Run logs are markdown today. A structured format (JSONL?) would make analytics easier — but markdown is more readable and forkable. Current preference: stay markdown until a real query need emerges.

If any of these matter to you, see [CONTRIBUTING.md](../CONTRIBUTING.md).
