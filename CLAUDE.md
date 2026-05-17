# roster — CLI Contributor Guide

This repo builds and ships **`@firatcand/roster`**, an npm CLI that installs/scaffolds the agent-team pattern across Claude Code, Codex CLI, and Gemini. See `README.md` for the user-facing pitch; this file is for contributors working on the CLI itself.

## Repo layout

```
src/        CLI source (TypeScript, ESM, Node ^22.18 || >=24)
  bin/      roster.ts — argv parsing, subcommand dispatch
  commands/ init.ts, (doctor.ts coming Phase 2)
  lib/      tools.ts (detection + install), paths.ts (ROSTER_ROOT, getPackageVersion)
bin/        Build output — bin/roster.js is the executable entry. Gitignored.
lib/        Build output for library exports. Gitignored.
templates/  Files copied into a user's workspace by `roster init`.
  scaffold/ Directory tree mirrored verbatim into the user's CWD.
  CLAUDE.project.template.md, env.example, gitignore-defaults.txt
skills/     Skills shipped to AI tools by `roster install`. One dir per skill.
agents/     Agent .md files shipped alongside skills (Claude Code only).
test/       Node test runner specs + smoke.sh integration test.
docs/       Public docs — HOWTO.md, ARCHITECTURE.md, API.md, roadmap.md, retros.
spec/       Local-only PRD/SPEC/CONTEXT (gitignored, forge planning workflow).
plans/      Local-only phases.yaml (gitignored, forge planning workflow).
.dogfood/   Active dogfood instance of the agent-team workspace. Not shipped.
```

**Shipped to npm** (verified via `npm pack --dry-run`): `bin/`, `lib/`, `skills/`, `agents/`, `templates/`, `README.md`, `LICENSE`. Allowlist is in `package.json` under `files`.

## Build & verify

```bash
pnpm install         # node 22+
pnpm typecheck       # tsc --noEmit
pnpm build           # tsdown → bin/roster.js with shebang
pnpm test            # node --test on test/**/*.test.ts
pnpm smoke           # bash test/smoke.sh — pack, install, init end-to-end
pnpm e2e             # bash test/e2e-sdr.sh — init + SDR-contract gate (pass --keep to preserve the workspace for the manual Claude Code gate)
pnpm perf            # bash test/perf.sh — measure install/init/doctor + tarball against SPEC budgets (dev-machine only)
pnpm test:dogfood-scripts  # bash test/new-agent-slash-only.sh — covers .dogfood/scripts/ (unshipped)
npm pack --dry-run   # confirm tarball stays clean (~64 kB, ~80 files at v0.1.0)
```

The Phase gate command (run before opening a PR): `pnpm typecheck && pnpm build && pnpm test`. When the diff touches `.dogfood/scripts/`, also run `pnpm test:dogfood-scripts`.

## Where things live in the CLI

- **Subcommand entry**: `src/bin/roster.ts` — hand-rolled argv parsing; subcommands `install`, `init`, `doctor`. `--help`, `--version`, exit codes (0/1/2/3).
- **Tool detection**: `src/lib/tools.ts` — `detectTools()` checks `~/.claude/`, `~/.codex/`, `~/.gemini/`. Each `Tool` has `key`, `name`, `skillsTarget`, `agentsTarget`. Override via `ROSTER_CLAUDE_HOME` etc. for tests.
- **Install logic**: `installToTool()` in `src/lib/tools.ts` — copies `skills/*` and `agents/*.md` into the tool's config dir. Idempotent. Handles symlinks (prompts before clobber). Handles EACCES with a sudo hint.
- **Scaffold logic**: `src/commands/init.ts` — copies `templates/scaffold/**` into CWD, substitutes `{{PROJECT_NAME}}` in `CLAUDE.project.template.md`, appends gitignore-defaults idempotently.

## Adding a new AI-tool target

1. Add the tool's config-dir constant to `src/lib/tools.ts` (e.g., `~/.somewhere/skills/`).
2. Add a `Tool` entry to `detectTools()` returning the key + name + targets.
3. Extend `installToTool()` to handle that tool's layout (skills-only vs skills+agents).
4. Add a test case in `test/install.test.ts` exercising the new target.
5. Update `README.md` install matrix.

## Phase status

Phase 1 — Foundations: **complete** (closed 2026-05-12; retro at `docs/retros/phase-1.md`).
Phase 2 — Core Features: **complete** (closed 2026-05-14; retro at `docs/retros/phase-2.md`).
Phase 2.5 — Scheduling primitives: **active**. Goals: subscription-safe scheduling for Claude Code + Codex CLI via native local schedulers, `CONTEXT.md` symlink architecture, `roster-orchestrator` skill, `roster schedule install/validate`, HITL queue. See `docs/adr/0001-scheduling-architecture.md` and `docs/roadmap.md`.
Phase 3 — Polish and Launch: **75% (in flight)**. Publish v0.1.0 to npm (`ROS-27`, Urgent) is decoupled from 2.5 — v0.1.0 ships install/init/doctor only; scheduling lands in v0.2.5+.
Phase 4 — Guided Agent Authoring: **in flight**. ROS-49 (mode-branched `create-agent.yaml`) and ROS-50 (guided-dialogue contract in `skills/chief-of-staff/SKILL.md`) landed 2026-05-17; ROS-51 next. Still gated on Phase 3 publish (`ROS-27`) for v0.4.0 release.

Local planning (PRD/SPEC/phases.yaml) lives in `spec/` and `plans/` and is gitignored — public roadmap in `docs/roadmap.md`, work items tracked in Linear (ROS-*).

## Conventions

- TypeScript, ESM, strict mode. No CommonJS.
- File names: lowercase kebab-case.
- Prefer hand-rolled argv parsing over commander/yargs to keep tarball small.
- No comments unless behavior is non-obvious. No docstrings.
- Conventional commits: `feat(scope):`, `fix(scope):`, `chore(scope):`, `docs(scope):`. Include Linear ID (`ROS-N`) when applicable.
- Never auto-commit. Show the diff, then ask.

## Working on the dogfood

If you're invoking `/sdr`, `/chief-of-staff`, or `/dreamer`, you're working on the **dogfood instance**, not the CLI. `cd .dogfood/` and Claude Code will load that directory's `CLAUDE.md` and `.claude/commands/`. Framework conventions live in `.dogfood/conventions.md`.

## When in doubt

Read this file end-to-end, then check `README.md` and `docs/HOWTO.md`. If a CLI convention isn't clear, ask before guessing — this is going on npm and inconsistent UX propagates to everyone who installs it.
