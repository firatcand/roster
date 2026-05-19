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
pnpm perf            # bash test/perf.sh — measure install/init/doctor + tarball against SPEC budgets (dev-machine only)
pnpm test:dogfood-scripts  # bash test/new-agent-slash-only.sh — covers .dogfood/scripts/ (unshipped)
npm pack --dry-run   # confirm tarball stays clean (~64 kB, ~80 files at v0.1.0)
```

The Phase gate command (run before opening a PR): `pnpm typecheck && pnpm build && pnpm test`. When the diff touches `.dogfood/scripts/`, also run `pnpm test:dogfood-scripts`.

## Where things live in the CLI

- **Subcommand entry**: `src/bin/roster.ts` — hand-rolled argv parsing; subcommands `install`, `init`, `doctor`, `schedule`. `--help`, `--version`, exit codes (0/1/2/3).
- **Tool detection**: `src/lib/tools.ts` — `detectTools()` checks `~/.claude/`, `~/.codex/`, `~/.gemini/`. Each `Tool` has `key`, `name`, `skillsTarget`, `agentsTarget`. Override via `ROSTER_CLAUDE_HOME` etc. for tests.
- **Install logic**: `installToTool()` in `src/lib/tools.ts` — copies `skills/*` and `agents/*.md` into the tool's config dir. Idempotent. Handles symlinks (prompts before clobber). Handles EACCES with a sudo hint.
- **Scaffold logic**: `src/commands/init.ts` — copies `templates/scaffold/**` into CWD, substitutes `{{PROJECT_NAME}}` in `CLAUDE.project.template.md`, appends gitignore-defaults idempotently.
- **Schedule schema**: `src/lib/schedule-schema.ts` — Zod-validated `scheduleEntrySchema` (name, agent, plan, cron, tool, install_mode, status). Required `status` enum is `pending-ui-install | installed`. `validateCronExpression()` for cron syntax.
- **Schedule install (Claude)**: `src/lib/schedule-install.ts` — `installClaudeSchedule()` renders `.roster/schedule-specs/<name>.claude.fields.md` (markdown, NOT JSON — Spike 2) and upserts `roster/<function>/schedules.yaml` atomically. UI hand-off only; tracked under [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364).
- **Schedule install (Codex)**: `src/lib/codex-install.ts` — `installCodexSchedule()` with two modes: `ui-handoff` (default; renders `<name>.codex.fields.md` for the Codex desktop app) and `via-cron` (`--via cron`; renders a hardened crontab line wrapped by `env -i`, installed via `src/lib/codex-cron.ts` marker-block upsert). All entries include a `subscription_attestation` block (auth_mode/env_policy/codex_home) verified by `src/lib/codex-preflight.ts`.
- **Shared YAML helpers**: `src/lib/schedule-yaml.ts` — `atomicWriteFile`, `readExistingSchedulesDoc`, `upsertEntryInDoc`. The upsert refuses to overwrite an existing entry with a different `tool` value to prevent silent same-name cross-tool collisions.
- **Schedule commands**: `src/commands/schedule.ts` — `executeScheduleValidate()` and `executeScheduleInstall()`. The install command preflights `--cloud-routine` (not-yet-implemented), Linux + `--tool claude` (no Desktop Scheduled Tasks on Linux), `--via cron` (codex-only; refused on Windows), `--tool codex` default mode (refused on Linux — no Codex Desktop).
- **Failure observability (ROS-42)**: `src/lib/cron-exit-log.ts` reads sibling `logs/cron/<name>.exit` / `.events.jsonl` files written by the `renderCronLine` wrap (`/bin/sh -c '...; printf %s "$?" > <EXIT>'`). `src/lib/schedule-state.ts#detectStale` answers "is the agent self-report older than expected next-fire + grace?". `src/lib/pending-sync.ts` synthesizes `roster/<fn>/pending/error-<id>.md` items from non-zero `.exit` + STALE — idempotent via `sha1(scheduleName + signalKey).slice(0,8)`. `src/commands/pending-sync.ts` is the CLI; `src/lib/doctor-scheduling-drift.ts#auditStaleFires` is the doctor cross-reference. `templates/hooks/banner.sh` v2 invokes `roster pending sync --silent` (with `timeout 5`) on SessionStart before counting items, so failures from between sessions surface in the next chat.

## Adding a new AI-tool target

1. Add the tool's config-dir constant to `src/lib/tools.ts` (e.g., `~/.somewhere/skills/`).
2. Add a `Tool` entry to `detectTools()` returning the key + name + targets.
3. Extend `installToTool()` to handle that tool's layout (skills-only vs skills+agents).
4. Add a test case in `test/install.test.ts` exercising the new target.
5. Update `README.md` install matrix.

## Phase status

Phase 1 — Foundations: **complete** (closed 2026-05-12; retro at `docs/retros/phase-1.md`).
Phase 2 — Core Features: **complete** (closed 2026-05-14; retro at `docs/retros/phase-2.md`).
Phase 3 — Polish and Launch: **complete** (`ROS-27` v0.1.0 published 2026-05-17). v0.1.0 ships install/init/doctor only; scheduling lands in v0.2.5+.
Phase 4 — Guided Agent Authoring: **complete** (closed 2026-05-17 with PR #75 / `ROS-55`). Delivered: mode-branched `create-agent.yaml` (`ROS-49`), guided-dialogue contract in `skills/chief-of-staff/SKILL.md` (`ROS-50`), per-file content contracts + cross-file invariants (`ROS-51`), atomic-write spec (`ROS-52`), `--slash-only` recovery flag (`ROS-53`), fixture-driven golden-snapshot harness (`ROS-54`), invariants + atomic-write modules + stub regression tests (`ROS-55`), dialogue-mode docs (`ROS-56`), scaffold scripts (`ROS-58`). Targeted for v0.4.0 release.
Phase 2.5 — Scheduling primitives: **active**. Goals: subscription-safe scheduling for Claude Code + Codex CLI via native local schedulers, `CONTEXT.md` symlink architecture, `roster-orchestrator` skill, `roster schedule install/validate`, HITL queue. See `docs/adr/0001-scheduling-architecture.md` and `docs/roadmap.md`.

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
