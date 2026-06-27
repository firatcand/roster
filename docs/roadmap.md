# Roster Roadmap

Public view of what's shipped, what's deferred, and what's next. Detailed task tracking lives in Linear under project `roster` (issues `ROS-*`); planning artifacts (`spec/`, `plans/phases.yaml`) are local-only and not in the repo.

## Released

### v1.4.0 — roster brain (in progress)

Workspace-scoped, append-only **Postgres knowledge brain** the agent team reads and writes instead of scattering knowledge across markdown. Bring-your-own Neon connection (stored in Infisical, never `.env`); a restricted runtime role enforces append-only at the database level. Verbs: `save`/`get`/`event`/`link`/`merge` (entities, facts, events, typed edges, dedup), `table`/`sql` (brokered custom tables + read-only SQL), `mount` (file ingest), `query` (hybrid pgvector + keyword + graph search), `config`, and `export`/`import` (portable backup). Scaffolded workspaces get `brain/RESOLVER.md` + a `/brain` skill and treat the brain as the team's source of truth. Tracked under ROS-134 (135–142).

### v1.0.2 — 2026-06-05

Second patch on the v1.0 line. Three correctness fixes from the post-1.0.1 code audit — chiefly a fail-open in the `roster doctor` secrets check (check 15 silently skipped top-level agents, so a `dreamer` with a required-but-unset secret returned green), plus removal of dead `projects/<project>/` path references from shipped agent prompts and a dead-code sweep with `noUnusedLocals`/`noUnusedParameters` now enforced. No behavior changes to install/init/schedule. Full changelog: [CHANGELOG.md](../CHANGELOG.md#102--2026-06-05).

### v1.0.1 — 2026-05-24

First patch on top of v1.0.0. Headlined by an install-scope change: `roster install` now defaults to **workspace-local** install when run inside a roster workspace (`<workspace>/.claude/skills/`, etc.) instead of the home directory. Workspaces become self-contained; cross-project pollution and the slash-command shadow class of bug go away. Non-TTY contexts and `--yes` keep working with safe context-aware defaults. Plus four polish fixes from v1.0 dogfooding. Full changelog: [CHANGELOG.md](../CHANGELOG.md#101--2026-05-24).

What this means for users:

- **Workspace-local install by default** — `roster install` run from a roster workspace lands skills + agents under `<workspace>/.claude/`, `<workspace>/.codex/`, and/or `<workspace>/.gemini/`. Use `--scope user` to install to your home directory instead (e.g., to make `/chief-of-staff` available in every Claude Code project).
- **Interactive picker** — `roster install` from a TTY prompts for tools (multi-select, all detected pre-checked) then scope (project vs user). `--yes`, `--tool <name[,name...]>`, and `--scope <project|user>` skip the prompts.
- **Doctor catches shadows** — when the same skill name exists at both project and user scope, `roster doctor` warns. The user-scope copy wins and silently shadows the workspace one.
- **Generated `agent.md` is current-tense** — the stale "Until the Phase 2 env-merge loader ships" workaround paragraph is gone.
- **Clearer `roster init` output** — output text makes it explicit that the scaffold lands in CWD, not a subdirectory.
- **First release with npm provenance attestation since v0.4.0** — the `publish.yml` workflow handles tag-pushes end-to-end after the `NPM_TOKEN` rotation under ROS-108.

### v1.0.0 — 2026-05-22

The single-project workspace refactor. v1.0.0 drops `projects/<slug>/`, adds `config/` + `guidelines/` for shared brand/voice substrate, and introduces agent-level `.env` inheritance. Breaking — existing v0.4 workspaces require a re-scaffold. Full changelog: [CHANGELOG.md](../CHANGELOG.md#100--2026-05-22).

> Note: v1.0.0 shipped without npm provenance (manual `npm publish` due to an expired CI token). Permanent for that version. v1.0.1 ships with provenance via the `publish.yml` workflow.

Retro: [retros/v1.0.md](retros/v1.0.md).

What this means for users:

- **Single-project default** — `roster init <name>` produces a workspace, not a multi-tenant container. The `projects/<slug>/` shape is gone; one repo, one product.
- **Shared substrate** — `config/project.yaml` (identity) and `guidelines/*.md` (voice, messaging, brand book, asset links, ICP personas) live at workspace root and are referenced by every agent.
- **Env inheritance** — each agent gets its own `.env` that inherits from the workspace, with agent-level overrides and explicit removal via empty string.
- **Slimmer skills** — `chief-of-staff` shrinks from 11 plans to 4; `dreamer` consolidates around a single playbook (no `promotion-arbiter` subagent).
- **Migration is manual** — re-scaffold into a fresh directory and copy your `.env` + state files over. See [CHANGELOG § Migration](../CHANGELOG.md#migration).

### v0.4.0 — 2026-05-19

First feature-complete release. Rolls up Phases 2, 2.5, and 4 — all of which landed on `main` after v0.1.0 but were never published as separate npm releases. Full changelog: [CHANGELOG.md](../CHANGELOG.md#040--2026-05-19).

Phase summary:

| Phase | Theme | Closed | Retro |
|---|---|---|---|
| 1 | Foundations | 2026-05-12 | [phase-1.md](retros/phase-1.md) |
| 2 | Core Features | 2026-05-14 | [phase-2.md](retros/phase-2.md) |
| 3 | Polish and Launch | 2026-05-17 | [phase-3.md](retros/phase-3.md) |
| 4 | Guided Agent Authoring | 2026-05-17 | [phase-4.md](retros/phase-4.md) |
| 2.5 | Scheduling Primitives | 2026-05-18 | [phase-2.5.md](retros/phase-2.5.md) |

What this means for users:

- **Install** — `npm i -g @firatcand/roster`; `roster install` writes skills + agents into Claude Code, Codex CLI, or Gemini (use `--all` or `--tool <name>`).
- **Scaffold** — `roster init <name>` lays down the full agent-team workspace (`gtm/`, `product/`, `design/`, `ops/`, `chief-of-staff/`, `dreamer/`, `projects/_demo/`, `CONTEXT.md`, `conventions.md`). Non-destructive on re-run, forge-aware.
- **Schedule** — `roster schedule install --tool <claude|codex>` produces a UI hand-off spec (Claude Desktop / Codex Automations) or, with `--via cron` on Codex, writes a hardened crontab line. All firing is subscription-billed — no Agent SDK, no `claude -p`. See [SCHEDULING.md](SCHEDULING.md) and [ADR-0001](adr/0001-scheduling-architecture.md).
- **Maintain** — `roster doctor [--fix]` audits skills, scheduling, subscription-safety, and `.env` secrets; the SessionStart banner surfaces unread decisions (HITL), reviewed in chat via `/inbox` (or `roster review` in a terminal).
- **Author** — `/chief-of-staff create-agent` runs a guided five-phase dialogue in TTY contexts (anti-fabrication, atomic write with rollback). Stub mode preserved via `AGENT_TEAM_NO_CONFIRM=1` and non-TTY contexts.

### v0.1.0 — 2026-05-17

Initial public release. Retro: [phase-1.md](retros/phase-1.md). Tool detection limited to `~/.claude/`; the `chief-of-staff` skill and `lesson-drafter` agent only. Superseded by v0.4.0.

## Deferred

Currently in the Linear backlog, both Low priority and not pickup-eligible under the "defer internal hardening pre-launch" rule. Will be reconsidered after the v0.4.0 launch settles.

- [ROS-63](https://linear.app/firatdogan/issue/ROS-63) — `migrate`: file-lock or CAS for manifest writes (TOCTOU window, only matters if two `roster migrate` runs race against each other on the same workspace).
- [ROS-57](https://linear.app/firatdogan/issue/ROS-57) — periodic re-check of the `claude://` URL scheme for a schedule-creation deep-link (passive watch on Claude Desktop releases; spike already filed in [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)).

## Out of scope

- **Cursor** — its rule-file model (`.cursor/rules/*.mdc`) injects static markdown into every chat. That doesn't fit roster's skill/agent/subagent semantics: no first-class skill invocation, no subagents, no slash commands as workflow entry points. Shipping there would only bloat Cursor conversations without delivering the workflow value. Cursor users can still get value from `roster init` (the workspace pattern + conventions) without `install`.
- PRD/SPEC/phases lifecycle — see [forge](https://github.com/firatcand/forge). Roster is complementary; the two don't bundle.
- Hosted SaaS — roster runs locally.
- Agent SDK / `claude -p` for scheduled firing — every fire must be subscription-billed (see [ADR-0001](adr/0001-scheduling-architecture.md)).
- Substrate-vs-artifacts model changes — core opinion, not up for redesign in this repo.
