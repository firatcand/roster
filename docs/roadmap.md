# Roster Roadmap

Public view of what's shipped, what's deferred, and what's next. Detailed task tracking lives in Linear under project `roster` (issues `ROS-*`); planning artifacts (`spec/`, `plans/phases.yaml`) are local-only and not in the repo.

## Released

### v1.8.0 — brain file system — 2026-07-08

The append-only brain learns to hold files. **`roster brain fs put|get|ls|rm`** attaches files to entities and keeps the bytes in an S3 bucket you own — AWS S3, Cloudflare R2, Backblaze B2, or MinIO (`files.endpoint` + `files.force_path_style`) — while a new append-only `brain.files` ledger in Postgres records every event. Text and markdown are chunk-indexed on upload so `brain query` finds them; binaries are stored pointer-only. Deletes are tombstones — `fs rm` drops the S3 object but the ledger keeps the history — and `roster brain doctor` gains an `s3-file-drift` check (missing object, out-of-band ETag change, or an object orphaned after `rm`; skip-safe on an unconfigured brain). Credentials stay env-only (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), never in the brain; bucket config (`files.bucket`/`region`/`endpoint`/`prefix`/`force_path_style`) is non-secret. Backups carry file pointers, not bytes — enable S3 bucket versioning for byte-level durability. Tracked under the ROS-156 epic (ledger + S3 port + fs verbs + doctor drift). Full changelog: [CHANGELOG.md](../CHANGELOG.md#180--2026-07-08).

### v1.7.0 — second opinion — 2026-07-06

Cross-model structured review: `roster second-opinion` sends any artifact (files, `--stdin`, `--diff [ref]`) to a different AI CLI (`codex`, `gemini`, or `claude`) and returns a structured verdict with severity-ranked findings (`major`/`minor`/`nit`/`praise`). A fail-closed preflight (`HOST_NOT_SUBSCRIPTION`) refuses before spawning if the call would incur per-token API charges. The `/second-opinion` skill is the chat front door for all three hosts. ADR-0002 (`docs/adr/0002-second-opinion-claude-adapter.md`) documents the scoped `claude -p` exception; the global ban in `roster doctor` is unchanged. Shipped in PR [#301](https://github.com/firatcand/roster/pull/301). Full changelog: [CHANGELOG.md](../CHANGELOG.md#170--2026-07-06).


### v1.6.0 — brain hardening — 2026-07-02

The append-only brain gets its one sanctioned deleter and a clean first-run story. **`roster brain gc`** (admin-only, preview-by-default) prunes superseded fact versions and re-mounted chunks once both the version and its replacement are older than the retention window (default 2y, `gc.retention` config key) — current versions and read-time results are invariant by construction; events/edges are never touched. `brain init` now strips the PG16+/managed-Postgres creator auto-grant so **fresh Neon brains pass `brain doctor` out of the box** (existing brains self-heal on the next init). Rolls up `roster skills update --latest` (founder-skills semver tags), the doctor expert-route drift guard, and the `migrate` manifest file lock. Tracked under ROS-153, ROS-154, ROS-126, ROS-129, ROS-63, ROS-144. Full changelog: [CHANGELOG.md](../CHANGELOG.md#160--2026-07-02). Retro: [v1.6-brain-hardening.md](retros/v1.6-brain-hardening.md).

### v1.5.0 — roster tasks — 2026-07-02

Interactive, tracker-agnostic **task state machine** on the user's own issue board — Notion v1 behind a generic `TrackerAdapter`. A canonical lifecycle (`ready → claimed → active → review → done`, `blocked`/`cancelled` branches) maps onto your status names via `roster task setup` → `roster/tracker.yaml`; unmapped optional stages collapse. Verbs (`claim`/`start`/`submit`/`done`/`revise`/`block --reason`/`unblock`/`cancel`) + `list`/`status` reports with a needs-your-attention digest, and the `/tasks` chat skill as the cross-tool front door. Multi-user: one shared board, per-user identity from each user's own token. Interactive only — no autonomous pickup. Tracked under ROS-147 (148–152). Full changelog: [CHANGELOG.md](../CHANGELOG.md#150--2026-07-02). Retro: [v1.5-tasks.md](retros/v1.5-tasks.md).

### v1.4.0 — roster brain — 2026-06-30

Workspace-scoped, append-only **Postgres knowledge brain** the agent team reads and writes instead of scattering knowledge across markdown. Bring-your-own Neon connection (stored in Infisical, never `.env`); a restricted runtime role enforces append-only at the database level. Verbs: `save`/`get`/`event`/`link`/`merge` (entities, facts, events, typed edges, dedup), `table`/`sql` (brokered custom tables + read-only SQL), `mount` (file ingest), `query` (hybrid pgvector + keyword + graph search), `config`, `reindex` (embeddings backfill), and `export`/`import` (portable backup). Scaffolded workspaces get `brain/RESOLVER.md` + a `/brain` skill and treat the brain as the team's source of truth. Tracked under ROS-134 (135–142). Full changelog: [CHANGELOG.md](../CHANGELOG.md#140--2026-06-30). Retros: [v1.4-brain-phase-1.md](retros/v1.4-brain-phase-1.md), [v1.4-brain-phase-2.md](retros/v1.4-brain-phase-2.md).

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

- [ROS-57](https://linear.app/firatdogan/issue/ROS-57) — periodic re-check of the `claude://` URL scheme for a schedule-creation deep-link (passive watch on Claude Desktop releases; spike already filed in [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)). Recurring by design — never closes; last probed 2026-07-02.

## Out of scope

- **Cursor** — its rule-file model (`.cursor/rules/*.mdc`) injects static markdown into every chat. That doesn't fit roster's skill/agent/subagent semantics: no first-class skill invocation, no subagents, no slash commands as workflow entry points. Shipping there would only bloat Cursor conversations without delivering the workflow value. Cursor users can still get value from `roster init` (the workspace pattern + conventions) without `install`.
- PRD/SPEC/phases lifecycle — see [forge](https://github.com/firatcand/forge). Roster is complementary; the two don't bundle.
- Hosted SaaS — roster runs locally.
- Agent SDK / `claude -p` for scheduled firing — every fire must be subscription-billed (see [ADR-0001](adr/0001-scheduling-architecture.md)).
- Substrate-vs-artifacts model changes — core opinion, not up for redesign in this repo.
