# Architecture

The design rationale for roster. Read this if you want to understand *why* the structure looks the way it does, before deciding whether (or how) to change it.

## Why this exists

Most multi-agent systems fall apart at scale for one of three reasons:

1. **Context loss across sessions.** Each conversation re-derives what voice, audience, and constraints look like. The system never compounds.
2. **No clear separation between strategy and execution.** Strategy gets re-litigated inside every tactical run, or strategic decisions silently get made by tactical agents.
3. **No reinforcement loop.** Agents don't get better. Mistakes recur. The user becomes the memory.

Roster is a discipline for keeping multi-agent systems coherent across projects, contributors, and time. It makes a few opinionated decisions that, taken together, prevent those three failure modes.

## The two-tier agent model

Three layers of structure, each with one job:

```
Function (gtm/, product/, design/, ops/)
  └── Agent (gtm/sdr/, design/graphic-designer/)
       └── Per-project instance (gtm/sdr/projects/_demo/)
```

- **Functions** group related work. They mirror the way humans organize teams. They host one EXPERT.md (substrate-shaping advisor) and zero or more agents.
- **Agents** are role-based execution units. They have a contract (`agent.md`), one or more named plans (`plans/`), reusable subagents, and per-project instances.
- **Per-project instances** are how an agent applies to a specific project. Instances hold config, tool bindings, runs, feedback, and project-scoped lessons.

The reason for this three-tier shape: it lets the same agent run across many projects without copy-paste, while letting each project tune behavior without forking the agent.

## Substrate vs artifacts

This is the load-bearing distinction in the whole system. Misusing it makes everything brittle.

**Substrate** is the slow-changing strategic context for a project: brand voice, ICPs, messaging frames, brand book, do-and-dont rules, compliance constraints. It changes weeks or months at a time. It lives in `projects/<project>/guidelines/`.

**Artifacts** are the daily tactical output: cold emails, LinkedIn posts, components, design files, content drafts. They change every run. They live in `<function>/<agent>/projects/<project>/log/runs/`.

Substrate informs every artifact. Artifacts never modify substrate.

This split is enforced by which thing produces which: experts produce/refine substrate. Agents produce artifacts. The slash command surface (`/<agent>` for artifacts, "use the X expert" for substrate) reinforces it.

If you find yourself wanting an agent to "redefine the voice as we go", you've actually wanted an expert. If you find yourself wanting an expert to "send tomorrow's outreach", you've wanted an agent.

## Experts

Each function MAY have an `EXPERT.md` at `<function>/EXPERT.md`. An expert is a system prompt that defines a function-level advisor. It's invoked conversationally, judgment-heavy, ad-hoc.

Experts:
- Read existing project context first (CLAUDE.md, guidelines, state.md)
- Identify gaps and ask only about those
- Produce or refine files in `projects/<project>/guidelines/`

Experts do NOT:
- Run scheduled workflows
- Produce tactical artifacts (one-off emails, posts, components)
- Have subagents, plans, runs, or feedback loops

If you need a strategic critique, ICP definition, or messaging framework, it's expert work. If you need this week's outbound list, it's agent work.

The included experts (`gtm/EXPERT.md`, `product/EXPERT.md`, `design/EXPERT.md`) are opinionated — they reflect one founder's judgment about which thinkers, frameworks, and skills matter. They're banner-marked as such. Replace freely.

## Agents and plans

Agents run via named plans. A plan is a YAML file at `<function>/<role>/plans/<plan-name>.yaml` that defines a workflow recipe — ordered steps using subagents and tools, with input/output contracts.

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
      <key>: ${tools.X.Y}      # references instance bindings
      <key>: ${inputs.X}       # references plan inputs
      <key>: ${config.X}       # references instance config
      input_from: <prior-step>
approval_channel: auto | session | slack | none
caps:
  <field>: <value>
```

Why plans (instead of putting workflows in agent.md as numbered steps):

- **Multiple workflows per agent.** One agent might run `cold-outreach`, `reply-handler`, `meeting-followup` — three plans, one agent.
- **Cron-friendly.** A plan name is a stable target for scheduling. `/sdr run cold-outreach for _demo` is something you can put in a scheduled task.
- **Auditable.** Plans are declarative. You can read them without running them.
- **Reusable.** A plan can call another agent's plan via the `agent:` step type.

There is no default plan. Invoking an agent without a named plan triggers an interactive "which plan?" prompt. This is intentional — explicit is better than implicit.

## Subagents

Subagents are reusable building blocks within an agent. They live at `<function>/<agent>/subagents/<name>.md`. Each subagent has a narrow job: prospector finds prospects, enricher fills missing fields, writer drafts copy, critic reviews drafts.

A subagent has its own contract: Role, Inputs, Output, Tools, Boundaries, Quality bar. Plans invoke them in sequence (or with branching).

Subagents are the place to put complexity that's specific to the agent but shared across its plans. They are NOT the place to put cross-agent logic — if two different agents would benefit from the same subagent, the right move is usually a separate cross-agent invocation, not duplication.

## The lesson protocol

Lessons are how the system learns. Every lesson is a markdown file at one of two locations:

- **Project-scoped:** `<function>/<agent>/projects/<project>/playbook/L-YYYY-MM-DD-NNN.md`
- **Global:** `<function>/<agent>/playbook/L-YYYY-MM-DD-NNN.md`

Each lesson has frontmatter:

```yaml
id: L-YYYY-MM-DD-NNN
source: human | dreamer
scope: project | global
project: <slug>          # required if scope=project; "—" if global
agent: <name>
created: YYYY-MM-DD
last_observed: YYYY-MM-DD
status: observing | candidate | validated | retired
validated_in: [<projects>]
extends: <lesson-id>     # optional
contradicts: <lesson-id> # optional
```

Body sections:
- **Pattern observed** — what's the recurring signal?
- **Recommendation** — what should the agent do next time?
- **Why this might be project-specific** — when does this generalize, when not?
- **Retirement criteria** — what evidence would invalidate this?

Lessons are consumed when an agent runs: the orchestrator reads the relevant playbook directories and treats validated lessons as soft rules.

## The dreamer reinforcement loop

The dreamer is a cross-cutting agent that runs nightly (or on demand). It:

1. Reads all runs and feedback since the last cutoff
2. Detects patterns (repeated user edits, recurring failure modes, signal/no-signal anchors)
3. Drafts lesson candidates
4. Routes them to Slack `#admin` for HITL approval
5. Writes approved lessons to the right scope (project vs global)
6. Updates state with the new cutoff

The dreamer is the only agent allowed to write to playbook files (apart from a human writing by hand with `source: human`). This prevents lesson churn from runtime-mutating agents and keeps lesson promotion deliberate.

A pattern observed in 2+ projects becomes a candidate for promotion to global scope. The dreamer makes the decision, but a human approves it. Mistakes are reversible — lessons can be retired by setting `status: retired`.

The dreamer respects human-written lessons (`source: human`). It doesn't modify or supersede them without explicit HITL approval.

## The chief-of-staff

The chief-of-staff is a cross-cutting agent that operates ON the repo itself, not on business workflows. Its plans wrap the backing scripts in `scripts/`: create-project, create-agent, create-function, archive-project, rename-project, audit-project, audit-agent, audit-repo, etc.

It exists because:
- Manual scaffolding is error-prone (forgotten directories, mismatched config schemas)
- Audit can't be ad-hoc (you need a definition of "complete" to check against)
- Destructive operations need consistent confirmation gates

Chief-of-staff plans always confirm before destructive changes (archive, unarchive, rename, remove). They never auto-commit.

## HITL routing

Human-in-the-loop approval routes to one of two places:

1. **In-session** — when an interactive caller invoked the agent. Faster, lower-friction.
2. **Slack** — when there's no interactive caller (cron, /schedule). Routes to the function's channel (`#gtm`, `#product`, `#design`, `#ops`) for function agents, or `#admin` for cross-cutting agents (dreamer, chief-of-staff).

The Slack channel name comes from per-function env vars: `SLACK_HITL_CHANNEL_<FUNCTION>` (e.g., `SLACK_HITL_CHANNEL_GTM`). `SLACK_HITL_CHANNEL_ADMIN` is the cross-cutting fallback.

`approval_channel: auto` enables this routing automatically. `approval_channel: session` forces in-session (fails if none). `approval_channel: slack` forces async.

## Tool bindings

Per-project tool bindings live at the agent-instance level: `<function>/<agent>/projects/<project>/config/default.yaml` under a `tools:` key. The schema is declared in the agent's `## Tools and bindings` section.

`required: true` bindings cause the agent to error at runtime if left as TODO. `required: false` are optional — the agent skips the related capability when absent.

When you scaffold a new agent instance via `new-agent-instance.sh`, the script reads the agent's bindings schema and prompts you for each value interactively. Press Enter to leave as TODO; required TODOs will error on the first run, prompting you to fill them then.

This pattern keeps secrets out of agent.md (which is committed) and into per-project config (which is also committed but contains references like Apollo list IDs, not actual API keys — secrets stay in `.env`).

## Scheduling

Scheduling is a layer above plans, not part of them. Plans don't have a `schedule` field.

Schedules fire from each AI tool's **native local desktop scheduler** — Claude Desktop Scheduled Tasks, Codex Automations, or `codex exec --via cron`. Roster installs schedule entries via `roster schedule install`; each fire spawns a fresh CLI session in the workspace, loads `CONTEXT.md`, invokes the `roster-orchestrator` skill, and dispatches the agent's subagent in isolated context. All model usage bills against the user's interactive Claude Pro/Max or ChatGPT Plus/Pro plan — `claude -p`, the Anthropic Agent SDK, and any programmatic API key path are banned and enforced by `roster doctor`.

Why this split: scheduling concerns (when, retry policy, dependencies) are different from workflow concerns (what to do). Keeping them separate means you can change the cadence without touching the plan, and you can run the same plan ad-hoc without a scheduler.

See [SCHEDULING.md](SCHEDULING.md) for the platform × tool matrix and install flows, and [ADR-0001](adr/0001-scheduling-architecture.md) for the rationale and rejected alternatives (notably the rejected `claude -p` cron and custom in-session scheduler daemon that earlier drafts of this section described).

## Why these opinions

Each opinion was driven by a specific constraint:

- **Functions, not arbitrary categories** → so org structure mirrors team mental models
- **Substrate vs artifacts** → so strategic context doesn't get rewritten by tactical runs
- **Plans, not in-prose workflows** → so workflows are testable, schedulable, auditable
- **Lesson schema with promotion rules** → so learning compounds without churn
- **Dreamer is the only writer to playbooks** → so lesson promotion is deliberate
- **HITL is mandatory for external actions** → so unattended runs can't go off the rails
- **Auto-mode + interactive prompts** → so power users move fast and beginners get scaffolding
- **No multi-tenant config storage** → because YAGNI for solo-founder use; if you grow into it, the right move is a separate system

## What this is not

- **Not a hosted SaaS.** You run it locally connected to your own Claude Code.
- **Not LLM-agnostic.** It depends on Claude Code and Codex CLI primitives — slash commands, native desktop scheduled tasks (Claude Scheduled Tasks / Codex Automations), the `Task` tool / Codex agents, and `CLAUDE.md` / `AGENTS.md` context discovery. Porting to another CLI is non-trivial and out of scope.
- **Not a goal-directed agent framework.** The goals come from you and live in plans and project guidelines. The framework just orchestrates execution.
- **Not multi-tenant.** It's optimized for one or a small team of contributors. Scaling beyond that is a separate problem.
- **Not a replacement for thinking.** It's structure for organizing your thinking and your agents' execution.

## Future work / open questions

- **Cross-agent plan invocation.** The schema supports `agent:` steps, but the runtime convention isn't fully exercised. Patterns emerge as projects use it.
- **Plan composition.** Could plans inherit or compose? Currently they don't — each plan is independent. Worth revisiting after enough plans accumulate.
- **Lesson contradiction resolution.** When two lessons conflict (especially across projects), the current rule is "human decides". A more automated arbitration story might emerge from dreamer evolution.
- **Function expert promotion.** Some patterns observed by experts (across projects) might warrant promotion to a higher-level expert. Not currently modeled.
- **Agent observability.** Run logs are markdown today. A structured format (JSONL?) would make analytics easier — but markdown is more readable and forkable. Current preference: stay markdown until a real query need emerges.

If any of these matter to you, see [CONTRIBUTING.md](../CONTRIBUTING.md).
