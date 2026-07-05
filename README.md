![banner](https://raw.githubusercontent.com/firatcand/roster/7095215fd4224709f47d69270f35201b1c3206ce/roster-banner%402x.png)


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@firatcand/roster.svg)](https://www.npmjs.com/package/@firatcand/roster)

# Roster

> **A subscription-safe operator agent framework.** Roster scaffolds role-based agents — GTM, product, design, ops — into the Claude Code or Codex CLI subscription you already pay for, then runs them on schedules with human approval before anything ships.

```
  ● 7am Monday. Three agents have already run while you slept.
  │
  ●  gtm/sdr        X market-watch scanned · 5 cold outbound drafts queued
  ●  product/pm     3 competitor changelogs summarized · LinkedIn post drafted
  ●  design/critic  yesterday's PR screenshots audited · 2 contrast issues flagged
  │
  ✓ All parked in your approval queue. You approve, edit, or reject over coffee.
```

| Pillar | What it means |
|---|---|
| **Lightweight** | One npm install. No servers, no SaaS layer, no proprietary DSL — your workspace is just markdown and YAML you own and can hand-edit. The base product needs zero infrastructure; the one optional add-on is `roster brain`, a bring-your-own-Postgres knowledge store you turn on only if you want it. |
| **Subscription-safe** | Runs on the flat-rate [Claude Code](https://claude.com/code) or [Codex CLI](https://github.com/openai/codex) subscription you already pay for. No per-token API bills, no third-party agent platform. |
| **Operator-first** | Built by someone running a real business. GTM, product, design, and ops are first-class roles — not a chatbot wrapped in marketing copy. |
| **Schedule-native** | Agents run on cron-like schedules through your host tool's native scheduler. Daily morning runs, weekly competitor sweeps, PR-triggered design QA. |
| **HITL by default** | Risky outputs (emails, PR comments, social posts) land in `pending/` queues. Nothing ships until you say so. |

---

## Quick install

```bash
npx @firatcand/roster install
```

Interactive — prompts for which AI tools to set up (Claude Code, Codex CLI, Gemini) and which scope (workspace-local vs. user home). Run inside a `roster init` workspace to get the project-local default; run from anywhere else for user-scope. macOS, Linux, and Windows. For non-interactive contexts (CI / scripts), add `--yes` plus `--tool <name>` and `--scope <project|user>` to skip prompts.

## For AI agents

If you are Claude Code or Codex and the user asks you to install Roster, your goal is to create a roster workspace, install the framework skills locally, verify the install, and stop before creating business agents unless the user asks for one.

Use [install.md](install.md) as the canonical runbook. The default flow for a new workspace is:

```bash
node --version
mkdir -p <target> && cd <target>
npx --yes @firatcand/roster init
npx --yes @firatcand/roster install --yes --scope project
npx @firatcand/roster doctor
```

Copy-paste prompt for an agent:

```
Set up https://github.com/firatcand/roster for me. Read README.md first, then
read install.md and follow it exactly. Scaffold a roster workspace in this
directory, install Roster for Claude Code or Codex, run roster doctor, and stop
if Node is below 22.18, no supported AI tool is installed, or doctor fails.
```

Prefer project scope for the first install. It keeps skills and agents inside the workspace (`.claude/`, `.agents/`, `.codex/`, `.gemini/`) so the setup is reproducible and does not pollute other projects. Use user scope only when the user explicitly wants Roster available across every project on the machine.

To understand what you just scaffolded — the function/agent/plan tree, where guidelines and HITL queues live, the shape of an agent folder — read the [Workspace anatomy](#workspace-anatomy) section below before creating any agents.

---

## Getting Started

```bash
mkdir my-team && cd my-team
npx @firatcand/roster init my-team   # scaffold workspace (config/, guidelines/, function dirs)
npx @firatcand/roster install        # NOW install — defaults to project scope inside a workspace
$EDITOR config/project.yaml          # fill workspace identity (stage, audience, motion)
$EDITOR guidelines/voice.md          # plus messaging.md, brand-book.md, icps/<persona>.md
cp templates/env.example .env        # then chmod 600 .env and fill secrets
claude                                # or `codex`, or open Cursor
/chief-of-staff create-agent gtm sdr
```

Using 1Password or Infisical? Compose them with the `.env` model via the recipes in [docs/SECRETS.md](docs/SECRETS.md) — no native integration needed.

`roster install` lands skills + agents under `<workspace>/.claude/`, `<workspace>/.codex/`, and/or `<workspace>/.gemini/` — workspace-local, self-contained, no cross-project pollution. The guided dialogue then reads your `config/project.yaml` + `guidelines/` and interviews you for the gaps a stub can't fill — subagents, tools, plan names, failure modes — then writes a populated `agent.md`. Worked example in [docs/HOWTO.md](docs/HOWTO.md).

### Common commands

| Command | What it does |
|---|---|
| `roster install` | Install skills + agents into detected AI tools (idempotent) |
| `roster init` | Scaffold an agent-team workspace in CWD |
| `roster update` | **One-shot workspace refresh**: install + hooks install + upgrade, in one step |
| `roster upgrade` | Refresh scaffold files to the installed roster; edits become `<file>.new`, never clobbered |
| `roster doctor` | Audit installation; exits non-zero on drift |
| `roster skills sync` | Install [founder-skills](https://github.com/firatcand/founder-skills) declared in `founder-skills.yaml` (project-local, ref-pinned) |
| `roster skills update [--latest]` | Re-sync declared skills from the manifest (the lockfile records the result); `--latest` bumps pinned refs to the newest **git tag** on the source repo |
| `roster schedule validate` | Validate every `roster/<function>/schedules.yaml` |
| `roster schedule install` | Install a schedule into your host tool's native scheduler |
| `roster review [function]` | Review unread decisions (HITL): `--json` lists; `--approve`/`--reject <id\|path>` apply headlessly; bare TTY = interactive walker. `/inbox` is the chat front door. |
| `roster second-opinion [files…]` | Send any artifact to a different AI CLI (`codex`, `gemini`, `claude`) and get a structured verdict with severity-ranked findings; fail-closed preflight refuses before spawning if API-key auth is detected. |
| `roster task setup` | Map your own tracker board (Notion v1) onto canonical task states → `roster/tracker.yaml` |
| `roster task list` / `status` | Claimable pool + your in-flight tasks; `status` adds the stage digest + needs-your-attention call-out |
| `roster task claim/start/submit/done…` | Drive a task through its lifecycle on your board (also `block --reason`, `unblock`, `revise`, `cancel`). `/tasks` is the chat front door. |
| `roster hooks install` | Wire SessionStart banners so chat sessions surface unread-decision counts |
| `roster brain <verb>` | **Opt-in** append-only Postgres knowledge store — `init`, `save`/`get`/`query`, `mount`, `export`/`import`, `gc` (bring-your-own Neon; connection in Infisical, never `.env`) |
| `roster migrate <target>` | Migrate a legacy `agent-team` workspace (`from-agent-team`) or legacy Codex skills into `.agents/skills` (`codex-skills`) |
| `roster pending sync` | Synthesize HITL items from failed-fire signals (`.exit` + STALE) — run automatically by the SessionStart banner |

Full subcommand reference in [docs/HOWTO.md](docs/HOWTO.md). Scheduling rules, UI hand-off, and platform matrix in [docs/SCHEDULING.md](docs/SCHEDULING.md).

### Keeping a workspace up to date

The fast path — bump the CLI, then refresh the workspace in one command:

```bash
npm i -g @firatcand/roster@latest   # update the CLI itself (a command can't replace its own package)
cd your-workspace && roster update   # install + hooks install + upgrade, in one step
```

`roster update` is an umbrella over the layers below. A workspace has four, and they can also be updated independently:

| Layer | What it is | How `roster update` refreshes it |
|---|---|---|
| The CLI | the `@firatcand/roster` npm package | **not** by `update` — `npm i -g @firatcand/roster@latest` |
| roster's skills + agents | `chief-of-staff`, `dreamer`, `inbox`… in `.claude/skills/`, `.agents/` | runs `roster install` (project-local) |
| founder-skills | `pricing`/`design`/… from [founder-skills](https://github.com/firatcand/founder-skills) | syncs if `founder-skills.yaml` present (`roster skills sync`) |
| SessionStart banner | the `/inbox` hook | runs `roster hooks install` |
| Scaffold files | `EXPERT.md`, `conventions.md`, function dirs | runs **`roster upgrade`** |

`roster init` is intentionally skip-if-exists (your scaffold is yours to customize), so it never overwrites an existing `EXPERT.md`. **`roster upgrade`** is how scaffold improvements reach an existing workspace: it auto-updates files you haven't touched, and for files you've edited it writes a `<file>.new` beside yours to review and merge — your file is never clobbered. Run `roster upgrade --dry-run` first to preview.

`guidelines/` (your voice, messaging, brand, and ICPs) is **excluded by default** — it's content you author, not roster's to refresh. Skip more paths with `--exclude <glob>` (e.g. `roster upgrade --exclude dreamer --exclude '*.md'`).

---

## How it works

Roster scaffolds an opinionated **function → agent → plan** tree. Functions are top-level domains (`gtm/`, `product/`, `design/`, `ops/`). Each function holds named agents (`gtm/sdr/`, `design/critic/`). Each agent has named YAML **plans** — the schedulable, auditable workflow recipes.

The opinion that keeps it useful at week 12 is **substrate vs artifacts**: long-lived context (voice, ICPs, messaging, brand) lives at the workspace root in `guidelines/`. Daily tactical output (emails, posts, PR comments) lands in `<function>/<agent>/logs/runs/`; anything that needs human approval first lands in `<agent>/pending/`. Experts shape substrate. Agents produce artifacts. Don't conflate them.

A nightly **reinforcement** pass (the `dreamer` skill) reads runs + feedback, detects recurring patterns, and proposes lessons to the agent that produced them. You approve before anything is written. Quality compounds.

### The brain — optional shared memory

By default the memory layer is just files in Git: run logs, playbook lessons, guidelines. When a workspace outgrows that, opt into **`roster brain`** — a workspace-scoped, append-only Postgres knowledge store (bring-your-own [Neon](https://neon.tech); connection string lives in Infisical, never `.env`). The team reads and writes it through structured verbs — `save` (entities + provenance-stamped facts), `event`, `link` (typed graph edges), `get`, `query` (hybrid semantic + keyword + graph search), `mount` (ingest a file as searchable chunks) — instead of scattering facts across markdown. It is **append-only and versioned**: the restricted runtime role physically cannot `UPDATE`, `DELETE`, or `DROP`, so corrections supersede and history stays. Turn it on with `roster brain init`; skip it entirely and nothing else changes. Full model in [docs/HOWTO.md](docs/HOWTO.md) and `brain/RESOLVER.md` inside your workspace.

### Second opinion — cross-model review

Any artifact — a diff, a set of files, or piped content — can be sent to a **different** AI CLI for a structured verdict:

```bash
roster second-opinion --diff HEAD~1                                              # review changes since previous commit (codex by default)
roster second-opinion messaging.md --host gemini --message "Is this positioning sharp?"
```

Each host runs a **fail-closed preflight**: if the call would incur API charges rather than draw from a subscription, `roster second-opinion` exits with `HOST_NOT_SUBSCRIPTION` before spawning anything. Pick a different `--host`, or switch to subscription auth. The verdict is a structured JSON envelope (`summary`, `findings[]` with severity, location, and confidence, `host`, `structured`) — or plain text without `--json`. The `/second-opinion` skill is the chat front door.

---

## Workspace anatomy

`roster init` scaffolds an opinionated tree. The philosophy: **one workspace = one product**, identity in `config/`, long-lived context in `guidelines/`, and agents as the unit of reuse. Nothing is a black box — every file below is markdown or YAML you can read and hand-edit.

### What `roster init` gives you

```
my-team/                          # your workspace (= one product)
├── CLAUDE.md                     # behavioral rules + identity, loaded at session start
├── conventions.md                # the long-form structure reference (the full schema)
├── config/
│   └── project.yaml              # machine-readable identity (name, stage, motion, audience)
├── guidelines/                   # cross-agent substrate — every agent reads these
│   ├── voice.md                  # tone, vocabulary, sentence patterns
│   ├── messaging.md              # value props, headlines, anti-claims
│   ├── brand-book.md             # visual identity, logo usage
│   ├── asset-links.md            # local paths + URLs to brand assets
│   └── icps/_persona-template.md # one file per ICP/persona
├── gtm/  product/  design/  ops/ # functions — top-level domains (see .config/functions.yaml)
│   └── EXPERT.md                 # function-level advisor prompt (shapes substrate, not artifacts)
├── chief-of-staff/               # built-in agent: scaffolds + audits the workspace itself
│   ├── agent.md
│   └── plans/{create-agent,create-function,audit-agent,audit-repo}.yaml
├── dreamer/                      # built-in agent: nightly reinforcement (drafts lessons → HITL)
│   ├── agent.md
│   ├── plans/nightly-reflection.yaml
│   └── subagents/{lesson-drafter,pattern-detector}.md
├── brain/
│   └── RESOLVER.md               # how the team writes to the optional Postgres brain
├── scripts/                      # scaffolding helpers (new-agent, audit-*, save-state, rename-agent)
├── logs/cron/                    # cron stdout/stderr + .exit / .events.jsonl for failure observability
├── .config/functions.yaml        # registry of function categories (single source of truth)
├── founder-skills.yaml.example   # rename → founder-skills.yaml to pin founder-skills
├── .env.example                  # copy → .env, chmod 600, fill secrets (workspace-wide)
├── .gitignore                    # roster defaults appended idempotently
└── .claude/  .agents/  .gemini/  # skills + agents (written by `roster install`)
```

Fresh function folders (`gtm/`, `product/`, `design/`, `ops/`) start empty except for their `EXPERT.md`. You add agents into them with `/chief-of-staff create-agent <function> <agent>` (or `bash scripts/new-agent.sh <function> <agent>`). The scheduler runtime tree — `roster/<function>/` with `schedules.yaml`, a `state.md` fire log, and a `pending/` queue — is created the first time you run `roster schedule install`.

### The shape of an agent

Every agent scaffolds at `<function>/<agent>/` — flat, no per-project nesting. This is the unit of reuse: copy the folder to another workspace and the agent comes with it.

```
gtm/sdr/                          # <function>/<agent>
├── agent.md                      # behavioral prompt + tool-bindings schema (Purpose, Inputs,
│                                 #   Plans, Subagents, Tools, Outputs, Approval, Lessons)
├── config.yaml                   # guideline refs + tool bindings (workspace-root-relative paths)
├── plans/<plan>.yaml             # named, schedulable workflow recipes (ordered steps + I/O contract)
├── subagents/<name>.md           # narrow, single-responsibility helpers the plans dispatch
├── playbook/<lesson>.md          # validated lessons (dreamer- or human-authored)
├── pending/<item>.md             # HITL items awaiting your approval (dreamer drafts land here)
├── logs/runs/<YYYY-MM>/          # one file per invocation (inputs, steps, outputs, candidate lessons)
├── logs/feedback/<YYYY-MM>/      # your feedback, mirroring run filenames
├── .env                          # agent-scoped secret overrides (optional, 0600) — inherits root /.env
└── .mcp.json                     # agent-scoped MCP servers (optional)
```

### The pieces, in one line each

| Piece | What it is |
|---|---|
| **Functions** (`gtm/`, `product/`, `design/`, `ops/`) | Top-level domains, registered in `.config/functions.yaml`. Add one with `create-function` only when 2–3 agents will live there within ~90 days. |
| **Experts** (`<function>/EXPERT.md`) | Function-level advisors that shape substrate (`guidelines/`) — judgment, not tactical output. Invoke ad-hoc: *"Use the GTM expert to critique guidelines/icps/."* |
| **Agents** (`<function>/<agent>/`) | The doers. Run named **plans**, produce artifacts, log every run. The unit of reuse. |
| **Plans** (`<agent>/plans/<plan>.yaml`) | Deterministic, repeatable, schedulable workflow recipes. No default plan — invoking an agent without one asks which to run. |
| **Subagents** (`<agent>/subagents/<name>.md`) | Narrow single-responsibility helpers a plan's steps dispatch. |
| **Guidelines** (`guidelines/`) | Cross-agent substrate: voice, ICPs, messaging, brand, assets. Read by every agent; **excluded from `roster upgrade`** so your content is never overwritten. |
| **Playbook + pending** (`<agent>/playbook/`, `<agent>/pending/`) | Validated lessons vs. HITL items awaiting approval. The dreamer drafts to `pending/`; on approval a lesson moves to `playbook/`. |
| **Chief of Staff** (`chief-of-staff/`) | Built-in maintenance agent — scaffolds and audits the workspace. Never runs business workflows. |
| **Dreamer** (`dreamer/`) | Built-in reinforcement agent — reads runs + feedback nightly, proposes lessons through HITL. |
| **Scheduler runtime** (`roster/<function>/`) | `schedules.yaml` entries, a `state.md` fire log, and a `pending/` queue surfaced on session start. |
| **Scripts** (`scripts/`) | Bash helpers backing the chief-of-staff plans (`new-agent.sh`, `audit-agent.sh`, `audit-repo.sh`, …). |
| **Brain** (`brain/RESOLVER.md`) | Router for the optional Postgres knowledge store — read before writing so knowledge doesn't fragment. |

The full schema — plan step types, tool bindings, lesson lifecycle, run/feedback file formats, HITL routing — lives in `conventions.md` inside your workspace and in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Founder skills

A workspace can declare which skills from [`firatcand/founder-skills`](https://github.com/firatcand/founder-skills) it depends on, and roster keeps them installed **project-local** and reproducible. Drop a `founder-skills.yaml` at the workspace root (rename the scaffolded `founder-skills.yaml.example`):

```yaml
source: github:firatcand/founder-skills
ref: v1.0.0                 # pinned ref for every skill
skills:
  - pricing
  - sales-skill
  - name: seo
    ref: v0.9.0            # per-skill override
```

`roster skills sync` (also run automatically by `roster install` at project scope) installs each declared skill into `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex) — **never globally** — pinned to its exact ref and materialized with `--copy`. A `founder-skills.lock` records the resolved ref + content hash so re-syncs are reproducible. The manifest is the source of truth: drop a skill and the next sync **prunes** it (roster only ever removes skills it installed). `roster skills update --latest` resolves the newest **git tag** on the source repo (via `git ls-remote --tags`) and rewrites every pinned ref to it — [`firatcand/founder-skills`](https://github.com/firatcand/founder-skills) publishes semver tags (`v1.0.0`+). Branch-pinned manifests (e.g. `ref: main`) keep syncing fine, but `--latest` requires the source repo to have tags and fails loud when there are none. `roster doctor` flags any manifest ↔ lock ↔ installed drift and exits non-zero. No manifest → roster installs zero founder skills.

> roster wraps the existing `npx skills` installer — it does not fetch or vendor skills itself, and never bundles them into its own npm tarball. Gemini is deferred for v1 (Claude + Codex supported). Codex skills land in `.agents/skills/` per the `skills` CLI and Codex-native discovery.

---

## Tool support

| Tool | Status | Project-scope skills | User-scope skills |
|---|---|---|---|
| Claude Code | Supported | `<workspace>/.claude/skills/<skill>/` | `~/.claude/skills/<skill>/` |
| Codex CLI | Supported | `<workspace>/.agents/skills/<skill>/` | `~/.agents/skills/<skill>/` |
| Gemini CLI | Supported | `<workspace>/.gemini/extensions/<skill>/` | `~/.gemini/extensions/<skill>/` |
| Cursor | On the roadmap | — | — |

Agents land in the host-specific agent directory for each tool (`.claude/agents`, `.codex/agents`, `.gemini/agents`) — including the delegated subagents roster ships (`lesson-drafter`, `pattern-detector`, and the `brain-organizer` that the `brain` skill dispatches for its on-demand corpus pass). On Codex each renders to a `<name>.toml` + `<name>.persona.md`; on Claude and Gemini it is a verbatim `.md`. Project scope (default inside a roster workspace) keeps everything self-contained; user scope writes to your home directory and is visible to every project on the machine. `roster doctor` warns when the same skill name exists at both scopes — the user-scope copy wins, silently shadowing the workspace one. Existing Codex installs under `.codex/skills` are legacy; run `roster migrate codex-skills` from a workspace to copy them into `.agents/skills` without deleting the legacy copy.

Detection is presence-only — roster considers a tool installed if its config root exists. Override via `ROSTER_CLAUDE_HOME` / `ROSTER_CODEX_HOME` / `ROSTER_GEMINI_HOME` (used by the test suite).

---

## Security

- **No `preinstall` / `install` / `postinstall` scripts.** `npm install -g @firatcand/roster` writes files and stops. Asserted in `test/security.test.ts`.
- **No telemetry.** Nothing is collected — no analytics, no error reporting, no usage pings. Any future telemetry will be opt-in, gated behind a flag, and disclosed here before the release that introduces it.
- **npm provenance.** Releases are signed via `npm publish --provenance` from GitHub Actions on tag push. Verify with `npm info @firatcand/roster dist.integrity` or the provenance badge on the npm page.
- **Path-traversal guards** on `install` / `init` audited under ROS-30 — regression suite in `test/security.test.ts`.

---

## Documentation

- [docs/HOWTO.md](docs/HOWTO.md) — install, init, create-agent, run a plan, audit
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — substrate-vs-artifacts, lessons protocol, reinforcement loop
- [docs/SCHEDULING.md](docs/SCHEDULING.md) — schedule install/validate, UI hand-off, Codex subagent workaround, subscription-billing rules
- [docs/API.md](docs/API.md) — every script, config schema, convention
- [docs/roadmap.md](docs/roadmap.md) — what's shipped, what's next

---

## Contributing

Bug reports, fixes, and docs improvements welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, PR process, release pipeline, and the CI gates a PR has to clear. Contributors working on the CLI itself should also read [CLAUDE.md](CLAUDE.md) for build/test/layout conventions.

---

## License

MIT. See [LICENSE](LICENSE).

Built on top of [Claude Code](https://claude.com/code), [Codex CLI](https://github.com/openai/codex), and the broader AI-coding-tool ecosystem.
