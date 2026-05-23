![banner](https://raw.githubusercontent.com/firatcand/roster/7095215fd4224709f47d69270f35201b1c3206ce/roster-banner%402x.png)


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@firatcand/roster.svg)](https://www.npmjs.com/package/@firatcand/roster)

# Roster

> **A lightweight operator agent framework.** A CLI that scaffolds role-based agents — GTM, product, design, ops — into your existing AI coding tool, and runs them on schedules with human approval before anything ships.

```
  ● 7am Monday. Three agents have already run while you slept.
  │
  ●  gtm/sdr        last night's signups triaged · 5 personalized intros queued
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

## Quick Install

```bash
npx @firatcand/roster install
```

Interactive — prompts for which AI tools to set up (Claude Code, Codex CLI, Gemini) and which scope (workspace-local vs. user home). Run inside a `roster init` workspace to get the project-local default; run from anywhere else for user-scope. macOS, Linux, and Windows. For non-interactive contexts (CI / scripts), add `--yes` plus `--tool <name>` and `--scope <project|user>` to skip prompts.

## Setup prompt

Want the agent to do the install for you? Paste this into Claude Code, Codex, or Cursor:

```
Set up https://github.com/firatcand/roster for me. Read install.md and follow
the steps to install roster and scaffold a workspace in this directory.
```

The agent reads [install.md](install.md), runs the install, scaffolds your workspace, verifies with `roster doctor`, and tells you the next command.

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

`roster install` lands skills + agents under `<workspace>/.claude/`, `<workspace>/.codex/`, and/or `<workspace>/.gemini/` — workspace-local, self-contained, no cross-project pollution. The guided dialogue then reads your `config/project.yaml` + `guidelines/` and interviews you for the gaps a stub can't fill — subagents, tools, plan names, failure modes — then writes a populated `agent.md`. Worked example in [docs/HOWTO.md](docs/HOWTO.md).

### Common commands

| Command | What it does |
|---|---|
| `roster install` | Install skills + agents into detected AI tools (idempotent) |
| `roster init` | Scaffold an agent-team workspace in CWD |
| `roster doctor` | Audit installation; exits non-zero on drift |
| `roster schedule validate` | Validate every `roster/<function>/schedules.yaml` |
| `roster schedule install` | Install a schedule into your host tool's native scheduler |
| `roster review [function]` | Walk pending HITL items interactively (approve / reject / defer) |
| `roster hooks install` | Wire SessionStart banners so chat sessions surface pending counts |

Full subcommand reference in [docs/HOWTO.md](docs/HOWTO.md). Scheduling rules, UI hand-off, and platform matrix in [docs/SCHEDULING.md](docs/SCHEDULING.md).

---

## How it works

Roster scaffolds an opinionated **function → agent → plan** tree. Functions are top-level domains (`gtm/`, `product/`, `design/`, `ops/`). Each function holds named agents (`gtm/sdr/`, `design/critic/`). Each agent has named YAML **plans** — the schedulable, auditable workflow recipes.

The opinion that keeps it useful at week 12 is **substrate vs artifacts**: long-lived context (voice, ICPs, messaging, brand) lives at the workspace root in `guidelines/`. Daily tactical output (emails, posts, PR comments) lands in `<function>/<agent>/logs/runs/`; anything that needs human approval first lands in `<agent>/pending/`. Experts shape substrate. Agents produce artifacts. Don't conflate them.

A nightly **reinforcement** pass (the `dreamer` skill) reads runs + feedback, detects recurring patterns, and proposes lessons to the agent that produced them. You approve before anything is written. Quality compounds.

---

## Tool support

| Tool | Status | Project-scope skills | User-scope skills |
|---|---|---|---|
| Claude Code | Supported | `<workspace>/.claude/skills/<skill>/` | `~/.claude/skills/<skill>/` |
| Codex CLI | Supported | `<workspace>/.codex/skills/<skill>/` | `~/.codex/skills/<skill>/` |
| Gemini CLI | Supported | `<workspace>/.gemini/extensions/<skill>/` | `~/.gemini/extensions/<skill>/` |
| Cursor | On the roadmap | — | — |

Agents land in the matching `agents/` sibling of the skills dir for each tool. Project scope (default inside a roster workspace) keeps everything self-contained; user scope writes to your home directory and is visible to every project on the machine. `roster doctor` warns when the same skill name exists at both scopes — the user-scope copy wins, silently shadowing the workspace one.

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
