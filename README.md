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
| **Lightweight** | One npm install. No servers, no databases, no SaaS layer. Tiny tarball, no proprietary DSL — your workspace is just markdown and YAML you own and can hand-edit. |
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

Prefer project scope for the first install. It keeps skills and agents inside the workspace (`.claude/` or `.codex/`) so the setup is reproducible and does not pollute other projects. Use user scope only when the user explicitly wants Roster available across every project on the machine.

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
| `roster skills update [--latest]` | Re-sync to the lockfile, or bump pinned refs to newest tags |
| `roster schedule validate` | Validate every `roster/<function>/schedules.yaml` |
| `roster schedule install` | Install a schedule into your host tool's native scheduler |
| `roster review [function]` | Review unread decisions (HITL): `--json` lists; `--approve`/`--reject <id\|path>` apply headlessly; bare TTY = interactive walker. `/inbox` is the chat front door. |
| `roster hooks install` | Wire SessionStart banners so chat sessions surface unread-decision counts |

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

`roster skills sync` (also run automatically by `roster install` at project scope) installs each declared skill into `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex) — **never globally** — pinned to its exact ref and materialized with `--copy`. A `founder-skills.lock` records the resolved ref + content hash so re-syncs are reproducible. The manifest is the source of truth: drop a skill and the next sync **prunes** it (roster only ever removes skills it installed). `roster skills update --latest` bumps refs to newest tags; `roster doctor` flags any manifest ↔ lock ↔ installed drift and exits non-zero. No manifest → roster installs zero founder skills.

> roster wraps the existing `npx skills` installer — it does not fetch or vendor skills itself, and never bundles them into its own npm tarball. Gemini is deferred for v1 (Claude + Codex supported). Codex skills land in `.agents/skills/` per the `skills` CLI and Codex-native discovery.

---

## Tool support

| Tool | Status | Project-scope skills | User-scope skills |
|---|---|---|---|
| Claude Code | Supported | `<workspace>/.claude/skills/<skill>/` | `~/.claude/skills/<skill>/` |
| Codex CLI | Supported | `<workspace>/.agents/skills/<skill>/` | `~/.agents/skills/<skill>/` |
| Gemini CLI | Supported | `<workspace>/.gemini/extensions/<skill>/` | `~/.gemini/extensions/<skill>/` |
| Cursor | On the roadmap | — | — |

Agents land in the host-specific agent directory for each tool (`.claude/agents`, `.codex/agents`, `.gemini/agents`). Project scope (default inside a roster workspace) keeps everything self-contained; user scope writes to your home directory and is visible to every project on the machine. `roster doctor` warns when the same skill name exists at both scopes — the user-scope copy wins, silently shadowing the workspace one. Existing Codex installs under `.codex/skills` are legacy; run `roster migrate codex-skills` from a workspace to copy them into `.agents/skills` without deleting the legacy copy.

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
