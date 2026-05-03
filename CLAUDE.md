# Agent-Team Universal Context

Loaded at every Claude Code session in this repo. Defines cross-cutting behavior. Agent-scoped context lives in `<function>/<agent>/CLAUDE.md` (when present). Project context lives in `projects/<project>/CLAUDE.md`.

## Identity

You are operating inside the agent-team repo for the user. Repo organizes agents by function (`gtm/`, `product/`, `design/`, `ops/`). Each agent owns its logic, tools, and per-project instances. Project-level guidelines live separately under `projects/<project>/guidelines/`.

## Path discovery

When you start in a path like `gtm/sdr/projects/_demo/`, Claude Code's `.claude/` discovery walks UP and merges:
- `gtm/sdr/.claude/` — agent-scoped skills, plugins, settings
- `agent-team/.claude/` — universal skills, plugins, settings

`.mcp.json` is discovered the same way. Agent-scoped MCPs at the agent level. Universal MCPs at root.

## Reading order when an agent is invoked

1. `<function>/<agent>/agent.md` — orchestrator contract
2. The instance: `<function>/<agent>/projects/<project>/config/default.yaml`
3. Project context: `projects/<project>/CLAUDE.md`, `state.md`
4. Project guidelines: all files under `projects/<project>/guidelines/` referenced by agent.md or this session
5. Project-scoped lessons: `<function>/<agent>/projects/<project>/playbook/`
6. Global lessons: `<function>/<agent>/playbook/`
7. Recent runs: last ~10 in `<function>/<agent>/projects/<project>/log/runs/`

## Lesson conflict resolution

Project-scoped lessons override global on conflict.

## Session continuity

- At session start, read `projects/<project>/state.md` if present.
- When the user runs `/save-state` (or asks to save state), update `projects/<project>/state.md`. Five lines max.
- Don't auto-save. Wait for explicit instruction.

## Running an agent

- Agent's `agent.md` is the contract — inputs, steps, tools, outputs.
- Spawn subagents from `<function>/<agent>/subagents/` via Claude Code's Task tool.
- Outputs go to `<function>/<agent>/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`.
- After a run, prompt the user for feedback or note the path: `log/feedback/<YYYY-MM>/<same-filename>.md`.

## HITL routing

- Triggered in this session by a human → ask the user inline.
- Triggered by cron (no interactive caller) → post to the agent's Slack channel:
    - Function agents (anything under `<function>/<agent>/`) → `#<function>` (e.g., `#gtm`, `#design`).
    - Cross-cutting agents (`dreamer/`, `chief-of-staff/`) → `#admin`.
  The actual channel name comes from the per-function env var: `SLACK_HITL_CHANNEL_<FUNCTION>` (uppercase function name) or `SLACK_HITL_CHANNEL_ADMIN` for cross-cutting agents.
- Workflow `approval_channel: auto` enables this routing automatically.

## Lesson handling

- Never write directly to a `playbook/` folder during a normal agent run. Only the dreamer writes there.
- If you observe a candidate lesson during a run, log it inline in the run output under `## Candidate Lessons` for the dreamer to pick up later.
- The user MAY directly write a lesson to a `playbook/` folder by hand — they will mark it `source: human, scope: global` (in agent's `playbook/`) or `source: human, scope: project` (in instance's `playbook/`). Respect human-written lessons.
- See `conventions.md` § "Lesson schema".

## Subagent discipline

- Subagents have narrow jobs. If you're asking a subagent to do two unrelated things, split it.
- The orchestrator (you, with `agent.md` loaded) coordinates. Subagents execute.

## Tool calls

- Use the agent's specified tools (named in `agent.md`). If a tool isn't specified, ask before introducing one.
- For tools requiring connectors, use the configured MCPs.
- For tools requiring API keys, read from `.env` — never hardcode.

## File conventions

- All filenames lowercase, kebab-case (`sdr`, `cv-tailor`).
- Lesson files: `L-YYYY-MM-DD-NNN.md` where NNN is a 3-digit counter.
- Run files: `YYYY-MM-DD-HHMM.md` (24-hour, local time).
- Feedback files mirror run filenames exactly so they pair.
- Configs in YAML with frontmatter, prose explanation below.

## Experts vs agents

Two distinct kinds of intelligence live in this repo:

**Experts** (`<function>/EXPERT.md`) shape SUBSTRATE. They critique and generate the project guidelines that everything else reads — voice, ICPs, messaging, design principles, brand book. They're conversational, judgment-heavy, invoked when you need to think, develop, or refine the strategic context of a project. Output writes to `projects/<project>/guidelines/<file>.md`.

**Agents** (`<function>/<agent-name>/agent.md`) produce ARTIFACTS. They run workflows that read substrate and generate specific outputs — emails, posts, components, content. They have subagents, runs, feedback loops, and learn over time via the dreamer. Output writes to `<function>/<agent>/projects/<project>/log/runs/<YYYY-MM>/...md`.

The rule: **experts shape substrate; agents produce artifacts.** Don't ask experts to write a single email — that's an agent's job. Don't ask agents to redefine brand voice — that's an expert's job.

When the user asks for something:
- "Define ICPs for Acme Corp" → expert (judgment-heavy, project-shaping)
- "Run outreach on these 20 prospects" → agent (repeatable workflow)
- "Critique this email draft" → expert (one-off review)
- "Generate cold email for Alice" → agent (writer subagent inside sdr)
- "Should we go PLG or sales-led?" → expert (strategic question)

To invoke an expert, the session reads `<function>/EXPERT.md` and follows its read-first protocol (read project context first, then ask only about gaps). Experts are configured per function in `.config/functions.yaml` via the `has_expert: true` flag.

## Repo maintenance

Structural changes to the repo (creating projects, archiving, renaming, auditing) are handled by the chief-of-staff agent at `chief-of-staff/agent.md`. When a user asks for one of these in any session, load `chief-of-staff/agent.md` and follow its operations contract.

The chief-of-staff agent operates from repo root only. If asked to scaffold from inside a project or agent folder, surface this and offer to switch contexts.

## Invoking agents and experts

Two distinct invocation patterns:

**Workflows (deterministic, plan-based)** — use slash commands like `/sdr`, `/graphic-designer`. These run named plans against named projects:

```
/sdr run cold-outreach for _demo
```

The slash command loads the agent's `agent.md`, executes the plan from `<function>/<role>/plans/`, and logs the run.

**Strategic / generative work (judgment-heavy, ad-hoc)** — invoke the function-level expert:

```
"Use the GTM expert. Critique projects/_demo/guidelines/messaging.md."
```

Experts shape substrate (project guidelines). Agents produce artifacts (specific outputs). Don't conflate them.

If unsure: if the work is repeatable and deterministic, it's a plan. If it requires judgment and isn't structured the same each time, it's expert work.

## What you do NOT do

- Do not modify agent logic during a run — that's a separate, deliberate task.
- Do not call agents across projects. An agent operating on Project A cannot invoke a different project's instance.
- Do not invent tools, connectors, or capabilities. If something isn't available, say so.
- Do not write secrets, API keys, or credentials to any file under version control.

## When in doubt

Read `conventions.md` for the full reference. If the convention isn't clear, ask before guessing — this repo is shared with future contractors and an inconsistent convention is worse than a missing one.
