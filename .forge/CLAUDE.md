# Forge Methodology — Building Roster

This file holds the **Forge methodology rules** for building Roster.

Forge is the meta-methodology that Roster ships (spec → PRD → SPEC → phases → tasks → review → ship). Because we use Forge to build Roster itself, the dev workflow in this repo follows Forge conventions. This separation is deliberate so the two sets of rules do not bleed into each other:

- Root `CLAUDE.md` describes **Roster the product** — what we are building, where it lives in this repo, how it ships.
- `.forge/CLAUDE.md` (this file) describes **how we build it** — planning workflow, phase gates, build conventions, Linear tracking.

> Quick patch — Forge will own its own canonical CLAUDE.md once it exists as a standalone tool. For now this lives in-repo so the rules are explicit instead of implicit. See PR #120 description for the related cleanup that removed the in-repo `.dogfood/` instance.

## Forge planning workflow

Local-only, gitignored, not shipped to npm:

- `spec/BRIEF.md`, `spec/PRD.md`, `spec/SPEC.md`, `spec/CONTEXT.md` — discovery + spec artifacts produced by `/forge`, `/draft-prd`, `/draft-spec`, `/ingest-spec`.
- `plans/phases.yaml` — dependency graph of phases/tasks with gate criteria, produced by `/decompose`.

Public roadmap lives in `docs/roadmap.md`. Work items are tracked in Linear under the `ROS-*` prefix.

**Linear is the source of truth for task status.** Never derive status from `plans/phases.yaml` or `git log` — query Linear directly.

## Phase status

- Phase 1 — Foundations: **complete** (closed 2026-05-12; retro at `docs/retros/phase-1.md`).
- Phase 2 — Core Features: **complete** (closed 2026-05-14; retro at `docs/retros/phase-2.md`).
- Phase 3 — Polish and Launch: **complete** (`ROS-27` v0.1.0 published 2026-05-17).
- Phase 4 — Guided Agent Authoring: **complete** (closed 2026-05-17 with PR #75 / `ROS-55`). Targeted for v0.4.0 release.
- Phase 2.5 — Scheduling primitives: **active**. Subscription-safe scheduling for Claude Code + Codex CLI via native local schedulers. See `docs/adr/0001-scheduling-architecture.md` and `docs/roadmap.md`.

## Build conventions

- **Phase gate** before opening a PR: `pnpm typecheck && pnpm build && pnpm test`. When the diff touches `templates/scaffold/scripts/`, also run `pnpm test:scaffold-scripts`.
- **Conventional commits**: `feat(scope):`, `fix(scope):`, `chore(scope):`, `docs(scope):`. Include the Linear ID (`ROS-N`) when applicable.
- **Never auto-commit.** Show the diff, then ask.
- **PR required for every change.** Never commit to main, never push main.
- **Worktrees required** for any non-trivial task — `.forge/worktrees/` (forge, ticket-bound) or `.claude/worktrees/` (Claude Code native). Never branch-switch in the main checkout; the user runs parallel sessions.

## Dogfooding

There is no in-repo agent-team workspace anymore — the historical `.dogfood/` fixture was removed in #120. To exercise the workspace pattern shipped by `roster init`, scaffold a workspace outside this repo with `roster init` and report regressions back here. The shipped scaffold is exercised in-CI by `pnpm smoke` (full `roster init` into a tmpdir) and `pnpm test:scaffold-scripts` (the `new-agent.sh --slash-only` regression suite).

## What lives where

- Forge methodology (this file) → `.forge/CLAUDE.md`
- Roster product / CLI contributor rules → `CLAUDE.md` (repo root)
- Public user-facing docs → `README.md`, `docs/HOWTO.md`

When in doubt about which file applies: if you're touching `src/`, `bin/`, `lib/`, `skills/`, `agents/`, or `templates/` → root `CLAUDE.md`. If you're touching `spec/`, `plans/`, `docs/retros/`, or running planning skills → this file.
