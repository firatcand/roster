# Changelog

All notable changes to `@firatcand/roster` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

Per-phase retrospectives live in [`docs/retros/`](docs/retros/) and carry the long-form rationale; this file is the short, user-facing version.

## [Unreleased]

_(empty — staging area for post-1.6.0 work)_

## [1.6.0] — 2026-07-02

Brain hardening + housekeeping release: the append-only brain gains its one sanctioned deleter (**`roster brain gc`**) and passes `brain doctor` on Neon out of the box, `roster skills update --latest` lights up, and `roster doctor` learns to flag expert-route drift. No breaking changes.

### Added

- **`roster brain gc` — admin-only prune of superseded versions.** The append-only brain accumulates replaced fact versions and re-mounted file chunks forever; `gc` prunes a superseded **version** once *both it and its immediate replacement* are older than the retention window (default 2 years; `--older-than <N>d|<N>mo|<N>y` per run, or persist via the new `gc.retention` config key — flag > config > default). The current version of everything survives at any age, and read-time results (`current_facts`, `resolved_current_facts`, `current_documents`, `canonical_id()`) are provably identical before and after. Events and edges are never touched — they're visible history, not versions. Preview by default, `--yes` to delete; batched, resumable, serialized by an advisory lock; refuses a runtime-role URL, partial DELETE privileges, or a stale schema. (ROS-153)
- **`roster skills update --latest`** — founder-skills now publishes semver tags (`v1.0.0`), so `--latest` resolves the newest tag and re-syncs the whole chain: manifest ref, both tool targets, lockfile refs + hashes. The git-ref resolver also gains a 30s timeout with a clear error. (ROS-126)
- **Doctor: expert-route drift guard** — `roster doctor` warns when a workspace `EXPERT.md` route isn't covered by the `founder-skills.yaml` catalog (`expert_routes` in `--json`). Warning-only; never flips the exit code. (ROS-129)

### Fixed

- **Fresh Neon brains pass `brain doctor` out of the box.** PG16+/managed Postgres auto-grants a newly created role back to its creator, tripping the `no-inbound-members` isolation invariant on every fresh Neon brain. `brain init` now strips the creator's membership on both the create and re-init paths (existing brains self-heal on the next `init`) and **verifies** the revoke — on stock PG16 the auto-grant is bootstrap-granted and unrevocable by the creator, so init reports it honestly with the exact superuser remedial SQL instead of pretending. (ROS-154)
- **`roster migrate` manifest writes take a file lock**, closing the TOCTOU window when two migrate runs race on the same workspace. (ROS-63)
- Doctor sanitizes workspace directory names embedded in expert-route warnings. (ROS-129)

### Docs

- Canonical process for adding workspace guideline files, aligned with the audit scripts. (ROS-144)

## [1.5.0] — 2026-07-02

Introduces **`roster task`** — an interactive, tracker-agnostic task state machine that drives discrete tasks to done on **your own issue board** (Notion v1). Interactive only: every claim is human-initiated; autonomous runs stay in schedules. No breaking changes. (ROS-147)

### Added

- **Canonical task state machine** — a pure, tracker-agnostic transition table (`ready → claimed → active → review → done`, with `blocked`/`cancelled` branches). Only `ready`/`active`/`done` must exist on your board; unmapped optional stages **collapse** (e.g. no Review status → `done` completes directly from Active, `submit` becomes a guided no-op). (ROS-148)
- **Notion adapter behind a generic `TrackerAdapter` interface** — the only layer that touches Notion; Linear/GitHub can slot in later. Notion is the sole source of truth: every operation reads live state, computes the transition, writes back. Your identity derives from your own `NOTION_TOKEN` at runtime — never stored. (ROS-149)
- **`roster task setup`** — introspects your board's status property and writes `roster/tracker.yaml`, mapping your status names onto the canonical lifecycle (`--map` to adjust, `--yes` to write, optional project filter for multi-project boards). (ROS-150)
- **Task verbs** — `claim` (self-assign, idempotent), `start`, `submit`, `done`, `revise`, `block --reason` (reason posted as a board comment *before* any status write), `unblock`, `cancel`. Selectors: unique id (`TASK-12`), page id, or fuzzy title (ambiguity lists candidates). Illegal transitions error with the allowed verbs. (ROS-151)
- **Status report + `/tasks` skill** — `roster task list` (claimable pool + your in-flight tasks; stable flat `--json`), `roster task status` (stage-grouped digest with a ⚠ needs-your-attention call-out), and the `/tasks` chat skill for Claude Code/Codex/Gemini: "what's ready?", "work on N", "I'm blocked", "send it for review", "mark it done" — all routed through the CLI state machine, never writing the board directly. (ROS-152)

### Fixed

- Codex `/roster-orchestrator` no longer false-aborts on a fresh workspace — the workspace-root guard is mode-aware during first-run init. (ROS-143)

## [1.4.0] — 2026-06-30

Introduces **`roster brain`** — a workspace-scoped, append-only Postgres knowledge store the agent team reads and writes instead of scattering knowledge across markdown. Opt-in; bring-your-own Neon connection. No breaking changes. (ROS-134)

### Added

- **`roster brain` — a Neon-backed workspace knowledge brain.** A bring-your-own-Postgres store (connection string in Infisical, never `.env`) the agent team treats as its source of truth. The store is **append-only and versioned**: no UPDATE/DELETE/DROP, with a `current_facts` view giving latest-wins reads. Append-only is enforced at the database level — a restricted `roster_brain_rw` runtime role holds SELECT + column-scoped INSERT only, so the agent runtime physically cannot mutate or drop data; the admin/owner role handles schema and restore. Opt in per workspace with `roster brain init`, which provisions the schema, both roles, and hands off the runtime credential once. (ROS-135)
- **Structured verbs** — `save` (entities + provenance-stamped facts), `event` (timeline), `link` (typed graph edges), `get` (entity + current facts + edges), plus `table` and `sql` for power users: `table create` routes through a `SECURITY DEFINER` broker so agents get custom tables without owning DDL, and `sql` runs read-only queries. `entities` are unique per `(kind, slug)`. (ROS-136)
- **File mount + keyword index** — `roster brain mount <file>` performs one-way, heading-aware markdown ingest into searchable chunks; re-mounting an edited file supersedes its old chunks with no orphans. (ROS-137)
- **Entity dedup + merge** — `merge` collapses duplicate entities by writing an append-only merge-map row resolved at read time via `brain.canonical_id()`; nothing is deleted. Guarded against merge cycles (full reachability walk) and concurrent races (`pg_advisory_xact_lock`). (ROS-140)
- **Hybrid semantic search** — `roster brain query` blends pgvector similarity, keyword match, and graph proximity into one ranked result set. Embeddings are cost-gated and opt-in (OpenAI `text-embedding-3-small` by default); when embeddings are unconfigured, query **degrades gracefully** to keyword + graph instead of failing. (ROS-138)
- **`roster brain reindex`** — backfills embeddings for content stored before semantic search was enabled (or after switching providers), so existing brains become searchable without a re-mount. (ROS-142)
- **Backup, export & import** — `roster brain export` emits self-generated, tool-restorable **JSONL** (the canonical, verified form) plus an optional standalone `--format sql` psql artifact. `roster brain import` reconstructs a brain id-for-id (`OVERRIDING SYSTEM VALUE`, sequence resets), hard-refuses a non-empty target, and requires an exact schema-version match. (ROS-141)
- **Scaffold wiring, docs & packaging** — `roster init` workspaces now ship `brain/RESOLVER.md` and a cross-tool `/brain` skill, and instruct the agent team to consult the brain first. The `roster brain` command tree, `roster doctor` brain checks, and accompanying docs round out the surface. (ROS-139)

## [1.3.0] — 2026-06-20

Adds the **`roster update`** umbrella — one command to bring an existing workspace current. No breaking changes.

### Added

- **`roster update` — one command to bring a workspace current.** Typing `roster update` used to error (`unknown command`); now it's the umbrella that refreshes an existing workspace to the installed roster, running three steps in order with a single aggregated report: `roster install` (roster's skills + agents, project-local, incl. `/inbox`; plus founder-skills sync if a `founder-skills.yaml` is present), `roster hooks install` (the SessionStart banner), and `roster upgrade` (scaffold files — `.new` on edits, `guidelines/` excluded). It then reminds you the CLI itself updates via npm (`npm i -g @firatcand/roster@latest`), since a running command can't replace its own global package. Requires a workspace; supports `--cwd`, `--json`, and `--exclude <glob>` (passed through to the upgrade step). Pure orchestration — it changes none of the underlying commands' behavior. (ROS-133)

## [1.2.0] — 2026-06-20

Second minor on the v1 line. Headlined by **`/inbox`** — a chat-native way to review HITL "decisions" — plus the `roster upgrade` exclude controls. No breaking changes.

### Added

- **`/inbox` — review unread decisions conversationally in chat.** Session start now reads `⚠ You have N unread decision(s) awaiting — run /inbox` (was `⚠ N pending HITL items — run roster review`). `/inbox` ships as a cross-tool skill (Claude Code + Codex) that lists your pending HITL items, shows each in chat, and applies your approve/reject/defer replies — no terminal TUI required. It's backed by new headless verbs on `roster review`: `--json` now carries a stable per-item `id` (`sha1(function/filename)`), and `roster review --approve <id|path>` / `--reject <id|path>` apply a single decision non-interactively (same path-safety as the interactive walker — a bad `target_on_approve` leaves the file untouched). "Unread" is a rebrand of the existing pending count, not a new read/seen state. Existing workspaces get `/inbox` + the new banner by re-running `roster install` (+ `roster hooks install`). (ROS-132)

### Changed

- **`roster upgrade` excludes `guidelines/` by default, and gains `--exclude <glob>`.** `guidelines/` is user-authored substrate (voice, messaging, brand-book, asset-links, ICPs) — roster's starter content there is meant to be replaced, not refreshed — so `roster upgrade` no longer writes `guidelines/*.new`. The new `--exclude <glob>` flag (repeatable, comma-splittable) skips additional paths; patterns match by exact path, directory subtree (`dreamer` → `dreamer/agent.md`), or `*`/`**` glob. Excluded files are skipped entirely and keep their manifest baseline, so nothing is lost if the exclude is later dropped. (ROS-131)

## [1.1.0] — 2026-06-18

First minor release on the v1 line. Two new command surfaces — opt-in **founder-skills** sync and **`roster upgrade`** for keeping a scaffolded workspace current — plus a scaffold expert-route fix. No breaking changes; existing workspaces are unaffected until they opt in.

### Added

- **Opt-in founder-skills manifest + project-local sync.** A workspace can declare which skills from [`firatcand/founder-skills`](https://github.com/firatcand/founder-skills) it depends on in a `founder-skills.yaml` at the workspace root; with no manifest, roster installs zero founder skills (clean opt-in). `roster skills sync` (also run automatically by `roster install` at project scope) installs each declared skill **project-local** — Claude Code into `.claude/skills/`, Codex into `.agents/skills/` — never globally, by wrapping the existing `npx skills` installer. Skills are pinned to an exact git ref via a per-skill `tree/<ref>/<skill>` GitHub URL and materialized with `--copy`; a `founder-skills.lock` records the resolved ref + content hash for reproducible re-syncs. Sync is a **full reconcile**: a skill dropped from the manifest is pruned from each tool target (roster only ever deletes skills it previously installed, tracked via the lockfile). `roster skills update --latest` bumps pinned refs to the newest tags and rewrites the manifest. `roster doctor` gains a fail-loud drift check (manifest ↔ lock ↔ installed: missing, orphaned, ref/hash mismatch, malformed frontmatter, source mismatch) that exits non-zero on a real gap. Gemini is deferred for v1. (ROS-125)
- **`roster upgrade` — refresh a scaffolded workspace to the installed roster's templates.** Closes the gap where `roster init` is skip-if-exists, so scaffold improvements never reached existing workspaces. `init` now records a baseline at `.roster/scaffold-manifest.json` (a per-file hash of the rendered template content); `roster upgrade` compares the installed templates against it: files you haven't touched are **auto-updated**, files you've **edited** get a `<file>.new` sibling (like `.dpkg-dist`) and are never clobbered, missing files are recreated, and templates that were dropped upstream are left in place. Workspaces with no manifest (anything scaffolded before this release) run a **degraded safe mode** — every changed file becomes a `.new` and a baseline is seeded for next time. `--dry-run` previews; `--json` for scripts. Whole-file only (no line merge); does not touch roster's own skills/agents (`roster install`) or founder-skills (`roster skills sync`). (ROS-130)

### Changed

- **Scaffolded experts route to the current founder-skills catalog.** After founder-skills consolidated `ui-design` + `ux-design` + `graphic-design` into a single `design` skill (and dropped `prompt-architect`/`prompt-engineering-patterns`), the scaffolded `EXPERT.md` files routed to skill names that no longer resolve. Updated `templates/scaffold/{design,product}/EXPERT.md` to route to `design`, removed a phantom `ui-ux-pro-max` route, and labeled `frontend-design` as a Claude built-in (not a founder-skill). Each expert now notes its skill routes resolve to founder-skills declared in `founder-skills.yaml` + synced via `roster skills sync`, and `founder-skills.yaml.example` was expanded to the full set the experts route to (trim to taste). (ROS-128)

## [1.0.2] — 2026-06-05

Second patch on the v1.0 line. Three correctness fixes surfaced by the post-1.0.1 code audit — headlined by a fail-open in the `roster doctor` secrets check — plus a dead-code sweep. No behavior changes to the install/init/schedule surface.

### Fixed

- **`roster doctor` no longer passes green when a top-level agent has a required secret unbound.** Doctor check 15 (`auditAgentEnvRefs`) silently skipped top-level agents (`dreamer`, `chief-of-staff`): its path matcher required a two-segment `<function>/<agent>` shape, so a top-level `dreamer/config.yaml` declaring a **required** tool env var (e.g. `SLACK_BOT_TOKEN`) with that var unset returned **ok** — a fail-open in a secrets check. The identical config at `gtm/sdr` correctly failed. The matcher now accepts a single kebab segment **or** `<fn>/<agent>`, and the in-root path guard anchors on the path separator (an in-root dir named e.g. `..foo` is no longer false-rejected). The check had zero tests before; added top-level-fail regression + depth-2 retention + loader cases. (ROS-112)
- **Shipped agent prompts no longer point at nonexistent `projects/<project>/` paths.** Four `EXPERT.md` files and `dreamer/agent.md` still told agents to read/write `projects/<project>/guidelines/`, `…/CLAUDE.md`, `…/state.md`, and `<fn>/<agent>/projects/<project>/log/runs/` — paths that don't exist in the v1.0 flat workspace shape. Since `templates/` ships in the tarball, agents following those prompts were sent to dead paths. Remapped to `guidelines/`, `config/project.yaml`, `state.md`, and `<fn>/<agent>/logs/runs/`; `smoke.sh` now asserts no literal `projects/<project>/` survives an init. (ROS-113)

### Internal

- Removed five dead symbols flagged by `tsc --noUnusedLocals --noUnusedParameters` (`tildify`, an unused `EXIT_ERROR` import, `STUB_DATE`, an unused `prompt` param + call-site arg, an unused `existsSync` import) and enabled both flags in `tsconfig.json`, so `pnpm typecheck` now fails on any new unused local/param/import — the class can't silently reaccumulate. (ROS-114)
- Migrated the repo's own build methodology onto Forge 0.3.0: `.forge/.env`-scoped secrets, `.envrc`/direnv auto-load, canonical forge-managed CLAUDE.md banner. Internal-only — `.forge/` is not in the npm tarball, so this changes nothing for installed users. (#197–#200)

## [1.0.1] — 2026-05-24

First patch on top of v1.0.0. Headlined by a behavior change to `roster install` (now workspace-local by default), plus four polish fixes surfaced during v1.0 dogfooding and the release retro.

### Changed (behavior)

- **`roster install` is now interactive and defaults to workspace-local scope.** Running `roster install` from a TTY prompts for tools (multi-select, all detected tools pre-checked) and scope (project vs user). From inside a roster workspace, project scope is the default and skills land in `<workspace>/.claude/skills/`, `<workspace>/.codex/skills/`, `<workspace>/.gemini/extensions/` — not in your home directory. Workspaces are now self-contained: clone, `roster init`, `roster install`, and slash commands work without extra global state. Non-TTY contexts (CI, pipes) and `--yes` skip prompts using safe defaults (project scope inside a workspace, user scope outside; all detected tools). New `--scope <project|user>` flag overrides; `--tool` accepts comma-separated values (`--tool claude,codex`). Strict semver would call this a major bump — keeping it as a patch because v1.0.0 was a same-day release with effectively zero users. (ROS-109)
- **`roster doctor` autodetects install scope and warns on shadow collisions.** In a workspace, doctor audits `<workspace>/.<tool>/`; outside, it audits user-scope. New `--scope <project|user>` flag overrides. When the same skill name exists at both scopes, doctor emits a shadow-collision warning (user-scope wins; workspace skill is silently ignored) — the bug class ROS-107 originally tracked. (ROS-109)
- **Generated `agent.md` no longer carries the stale "Until the Phase 2 env-merge loader ships" copy.** The loader shipped in v1.0 (ROS-84); the workaround paragraph it once recommended has been removed from `chief-of-staff create-agent`. New agents get current-tense tool-binding instructions. (ROS-105)
- **`roster init` output clarifies that the scaffold lands in CWD, not a subdirectory.** The previous `✓ Initialized <name> in <cwd>` line read as if `<name>/` had been created; new copy makes the in-place install explicit. (ROS-106)

### Internal

- Hygiene sweep across `// Pinned to skills/.../SKILL.md lines X-Y` comments for SKILL ↔ code drift after the v1.0 SKILL rewrites. Pins now reference section headings instead of line ranges so future SKILL renumbering does not silently invalidate them. (ROS-104)

### Migration

If you ran v1.0.0's `roster install`, you have skills at `~/.<tool>/skills/`. They're not removed automatically — `roster install` for v1.0.1 from inside a workspace writes to `<workspace>/.<tool>/`, and `roster doctor` will warn about the shadow collision. To clean up the user-scope copy:

```bash
rm -rf ~/.claude/skills/chief-of-staff ~/.claude/skills/dreamer ~/.claude/skills/roster-orchestrator
rm -rf ~/.codex/skills/chief-of-staff ~/.codex/skills/dreamer ~/.codex/skills/roster-orchestrator
rm -rf ~/.gemini/extensions/chief-of-staff ~/.gemini/extensions/dreamer ~/.gemini/extensions/roster-orchestrator
```

If you prefer user-scope install (e.g., you want `/chief-of-staff` available in every Claude Code project on the machine), re-run `roster install --scope user`. Both scopes are first-class; project is just the default inside a workspace.

### Resolved by ROS-109

- **ROS-107** (chief-of-staff create-agent: detect global slash-command name collisions) was closed as resolved-by-ROS-109. The new doctor shadow warning catches the case at audit time; scaffold-time pre-detection is no longer load-bearing once project-scope install is the default.

## [1.0.0] — 2026-05-22

The single-project workspace refactor. v1.0.0 replaces the `projects/<slug>/` multi-tenant layout with a single root-level workspace, introduces shared brand/voice substrate under `config/` + `guidelines/`, and adds agent-level `.env` inheritance. **This is a breaking release — existing v0.4 workspaces require a re-scaffold (see Migration below).**

> Note: v1.0.0 was published via manual `npm publish` (the `publish.yml` workflow's `NPM_TOKEN` had silently expired). As a result, **v1.0.0 has no npm provenance attestation** — this is permanent for that version (npm forbids republishing the same version). v1.0.1 ships with `--provenance` via the workflow path.

Per-phase retro: [docs/retros/v1.0.md](docs/retros/v1.0.md) — rolls up phases v1-1..v1-4.

### Removed

- **`projects/` directory dropped from `roster init` scaffolds.** The multi-tenant `projects/<slug>/` shape — including the `projects/_demo/` example workspace and the `project` field carried through scheduler entries and slash-command arguments — is gone. Roster is now opinionated single-project per workspace. (ROS-72, ROS-75)
- **`promotion-arbiter` subagent removed from `dreamer`.** Single-project workspaces collapse `dreamer`'s validated vs global-promotion decision tree into a single playbook scope. (ROS-91)
- **In-repo `.dogfood/` instance removed.** (Already on main pre-1.0.) The 102-file agent-team workspace fixture at `.dogfood/` is gone; `templates/scaffold/scripts/` is now the single canonical source for scaffold shell scripts. Promoted from `.dogfood/scripts/`: `rename-agent.sh` and `save-state.sh`. Deliberately not promoted: the old `cron/` wrappers and `new-cron.sh` — both invoked `claude -p` (the headless flag, paid API), which the doctor's subscription-safety check correctly rejects in shipped code. Scheduling is the job of `roster schedule install` (Phase 2.5); ad-hoc cron is not a shipped pattern. Dropped: `test/scripts-parity.sh` (no second tree to drift against), the `pnpm test:dogfood-scripts` script (renamed to `pnpm test:scaffold-scripts` and now runs `new-agent-slash-only.sh` alone), and the `.dogfood/...` ignore rules in `.gitignore`. The shipped surface is unchanged. Dogfooding now happens via `roster init` in a separate workspace.
- **SDR worked example removed from the shipped surface.** (Already on main pre-1.0.) `roster install` no longer copies an `sdr` skill or its `critic` / `enricher` / `prospector` / `writer` subagents; `roster init` no longer scaffolds `gtm/sdr/`. SDR was always a worked example, not a framework primitive — users now get an empty `gtm/` function dir (matching `product/` / `design/` / `ops/`) and scaffold their own agents via `/chief-of-staff create-agent <function> <agent>`. Dropped: `pnpm e2e` script and `test/e2e-sdr.sh` (CI no longer asserts an SDR-specific contract). Cuts ~20 files / ~30 KB from the npm tarball.

### Added

- **`config/` + `guidelines/` cross-agent substrate.** Fresh scaffolds ship `config/project.yaml` (project identity: name, stage, audience, motion, created) and `guidelines/{voice,messaging,brand-book,asset-links}.md` + `guidelines/icps/_persona-template.md`. Single shared source of truth for every agent in the workspace. (ROS-73)
- **Agent-level `.env` inheritance.** Each agent dir gets its own `.env` that inherits from the workspace `.env`, with agent values overriding workspace values. Empty strings remove a key inherited from the workspace. Doctor checks 13/14/15 audit the merged shape. (ROS-83, ROS-85, ROS-86, ROS-101)

### Changed

- **Schedule schema collapsed.** `roster/<function>/schedules.yaml` entries no longer carry a `project` field. The v0.4 3-tuple `function/agent/project` lookup is rejected with an explicit error; v1 entries use 2-tuple `function/agent` lookup. (ROS-80)
- **Slash-command syntax dropped the `for <project>` suffix.** `/sdr run cold-outreach for _demo` becomes `/sdr run cold-outreach`. Slash-command frontmatter no longer parses or substitutes a project arg. (ROS-89, ROS-92)
- **`chief-of-staff` plan inventory trimmed from 11 plans to 4.** The 7 project-management plans (create / archive / rename and their audits) are removed. Kept: `create-agent`, `create-function`, `audit-agent`, `audit-repo`. (ROS-90)
- **`dreamer` skill rewritten** as a single-playbook orchestrator without the `promotion-arbiter` subagent. (ROS-91)

### Migration

There is no automatic migration tool. To move from v0.4 to v1.0:

1. Scaffold a fresh workspace in a new directory: `roster init <name>`.
2. Copy your `.env`, `gtm/<agent>/state.md`, and any custom plans from the old workspace into the new one. There is no `projects/` directory in v1 — drop the `projects/<slug>/` path prefix when porting files.
3. Update any `roster/<function>/schedules.yaml` you'd written by hand: remove the `project:` field from every entry.
4. Update any custom slash-command invocations you'd embedded in scripts or cron: drop the trailing `for <project>` argument.
5. If you had a custom `dreamer` playbook that relied on the removed subagent, fold its logic into the single playbook (see [ROS-91](https://linear.app/firatdogan/issue/ROS-91) discussion).

The v0.4 → v1.0 cut is intentional: the multi-project layout shipped before we had real users, and the conceptual savings of a single-project model dwarf the cost of a one-time re-scaffold.

### Fixed

- Doctor check 12 no longer walks the dead v0.4 layout — now audits v1 `<function>/<agent>/.env` references correctly. (ROS-99)
- Doctor checks 12 + 15 no longer skip top-level infra agents (`dreamer`, `chief-of-staff`). (ROS-101)

## [0.4.0] — 2026-05-19

This release rolls up Phases 2 (Core Features), 2.5 (Scheduling Primitives), and 4 (Guided Agent Authoring) — all of which landed on `main` after v0.1.0 but never shipped as separate npm releases. v0.4.0 is roster's first feature-complete release: full multi-tool install, the complete skill set, scheduling, doctor, migrate, and guided agent authoring.

Per-phase retros: [phase-2](docs/retros/phase-2.md), [phase-2.5](docs/retros/phase-2.5.md), [phase-4](docs/retros/phase-4.md). Scheduling architecture: [ADR-0001](docs/adr/0001-scheduling-architecture.md).

### Added

**Core surface — Phase 2 (closed 2026-05-14)**

- Multi-tool install — Codex CLI and Gemini CLI join Claude Code. `roster install --all` and `--tool <name>` for non-interactive flows. Codex uses flat `.md` files in `~/.codex/prompts/`; Claude and Gemini use dir-per-skill. (ROS-13, ROS-15, ROS-16)
- Full skill set — `dreamer`, `sdr`, and `chief-of-staff` skills with companion agents; `gtm/`, `product/`, `design/`, `ops/` `EXPERT.md` documents. (ROS-9, ROS-12)
- Full workspace scaffold — `roster init` lays down `gtm/`, `product/`, `design/`, `ops/`, `chief-of-staff/`, `dreamer/`, `projects/_demo/`, `scripts/`, `conventions.md`. Non-destructive on re-run, forge-aware (detects `BRIEF.md` / `spec/PRD.md` / `plans/phases.yaml`). (ROS-17, ROS-18)
- `roster doctor` — audits installed skills and agents per tool, exits 1 on drift. (ROS-19)
- `pnpm e2e` SDR contract gate — `test/e2e-sdr.sh` asserts the `/sdr` agent contract structurally so CI catches regressions of the `/sdr run cold-outreach for _demo` path. (ROS-20)
- Structured error UX with `--debug`, path-traversal security audit, GitHub Actions CI gates (smoke + e2e).

**Scheduling — Phase 2.5 (closed 2026-05-18)**

- `CONTEXT.md` architecture — `roster init` writes `CONTEXT.md` and symlinks `CLAUDE.md` / `AGENTS.md` to it on macOS/Linux (dual-write on Windows). One workspace opens cleanly in both Claude Code and Codex CLI. (ROS-31)
- `roster-orchestrator` skill — bootstrapped on every fresh CLI session from `CONTEXT.md`; dispatches subagents in isolated context. Installed into both Claude and Codex with per-tool body. (ROS-32, ROS-33)
- `roster schedule install --tool <claude|codex>` — Claude Code gets a UI hand-off spec for Desktop Scheduled Tasks (no JSON-import API; tracked under [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)). Codex CLI gets an Automation hand-off by default, plus opt-in `--via cron` programmatic path that writes a hardened crontab line wrapped by `env -i` with a `subscription_attestation` block. (ROS-34, ROS-35)
- `roster schedule list / remove / status / run / validate / estimate-usage` — full lifecycle commands. `--dry-run` is uniform across `schedule install/run/remove` and `doctor`. `estimate-usage --json` rows are a strict superset of `list --json` (adds `install_mode`, `status`, `last_run`, `last_status`, `next_due_at`; nullable keys present as JSON `null`, not omitted). (ROS-36, ROS-41, ROS-44, ROS-45, ROS-71)
- HITL pending queue — filesystem queue at `roster/<function>/pending/`; `roster review` surfaces items; `roster hooks install` wires a SessionStart banner so pending items show in any chat session. (ROS-37)
- Failure observability — cron exit codes captured in sibling `.exit` / `.events.jsonl` files; `roster pending sync` synthesizes `error-<id>.md` items from non-zero exits and stale fires (idempotent via 8-char hash); `roster doctor` cross-references stale fires. (ROS-42)
- `roster doctor` extensions — scheduling drift (`schedules.yaml` ↔ crontab), subscription-safety (refuses installed skills that import the Anthropic SDK or call `claude -p`), secrets (`.env` 0600), Codex Windows TOML workaround, alt-skill-path detection. `--fix` mode repairs symlinks and `.env` permissions. (ROS-38, ROS-65)
- `roster migrate from-agent-team` — ports the original `~/repos/agent-team` layout to a fresh roster workspace; manifest-tracked, rerun-safe. (ROS-43)
- `docs/SCHEDULING.md` — canonical reference for the platform × tool matrix, Linux Claude gap, Codex Windows caveat, UI hand-off flow. (ROS-39)
- Scheduling tests — unit + e2e shell + manual macOS gate. (ROS-40)

**Guided Agent Authoring — Phase 4 (closed 2026-05-17)**

- Guided dialogue mode for `/chief-of-staff create-agent`. TTY invocations run a five-phase interview (prose intake → classify → targeted follow-ups → consolidated preview → atomic write) that produces a fully populated `agent.md`, real `subagents/<name>.md` files, an optional starter `plans/<plan>.yaml`, and a ≤ 80-character slash-command description. The dialogue obeys an anti-fabrication invariant: gaps surface as questions, never as plausible-looking defaults. (ROS-49, ROS-50, ROS-51)
- Atomic write contract with rollback. Phase 5 enumerates every directory and file the transaction creates, writes `agent.md` last so any contract-aware reader observes either no agent or a complete one, and on failure (or SIGINT during Steps 4–5) walks the rollback list in reverse to leave the workspace clean. Residual paths are surfaced explicitly when cleanup is incomplete. (ROS-52)
- `scripts/new-agent.sh --slash-only <function> <agent>` recovery flag for the rare case where the agent tree write succeeds but `.claude/commands/<agent>.md` doesn't (e.g., permission error on the commands dir). Writes only the slash command; refuses to clobber an existing file. (ROS-53)
- Fixture-driven golden-snapshot test harness under `test/fixtures/create-agent/` so the dialogue mode is regression-testable without invoking an LLM in CI. (ROS-54, ROS-55)

### Changed

- **Breaking — TTY users see an extra prompt the first time they run `/chief-of-staff create-agent`.** The skill asks *"Empty scaffold, or design this agent together?"* before any write. Set `AGENT_TEAM_NO_CONFIRM=1` to skip the prompt and force stub mode — same behavior as v0.1. Non-TTY contexts (CI, piped stdin, scripts) get stub mode automatically and require no changes.
- Tool detection expanded from Claude-only (v0.1.0) to Claude + Codex + Gemini.
- Tarball footprint grew from 13 kB / 11 files (v0.1.0) to 154 kB / 96 files (v0.4.0); well under the 1 MB SPEC budget. Bundle: 257 kB / 62 kB gzipped.
- 822 tests on `main` at release, up from 14 at v0.1.0.

### Fixed

- `migrate`: harden wrapper path resolution + shell-escape rendered commands. (ROS-64)
- `migrate`: sanitize newlines in install-script TODO comments. (ROS-68)
- `create-agent`: quote slash command description for YAML-safe emission. (ROS-62)
- `create-agent`: parse slash frontmatter as YAML before placeholder scan. (ROS-59)
- `cli`: scope `--tool` enum per subcommand in `--help`. (ROS-70)
- `scripts`: enforce slug shape in `is_valid_function` / `read_functions`. (ROS-69)

### Docs

- `docs/SCHEDULING.md` — canonical scheduling reference (ROS-39).
- `docs/adr/0001-scheduling-architecture.md` — subscription-safe scheduling model.
- `docs/retros/phase-2.md`, `phase-2.5.md`, `phase-3.md`, `phase-4.md` — per-phase retrospectives.
- `templates/scaffold/conventions.md` rewritten per ADR-0001 (ROS-66) and swept of legacy `scripts/cron/wrappers/` references (ROS-67).

## [0.1.0] — 2026-05-17

Initial public release. Phase 1 retrospective: [`docs/retros/phase-1.md`](docs/retros/phase-1.md).

### Added

- `roster install` — copies the `chief-of-staff` skill and `lesson-drafter` agent into `~/.claude/skills/` and `~/.claude/agents/`. Idempotent. Handles symlinks and `EACCES`.
- `roster init <name>` — writes the minimal workspace (`CLAUDE.md` with `{{PROJECT_NAME}}` substituted, `projects/_demo/` placeholder, gitignore-defaults appended idempotently).
- `roster --help` / `roster --version`, exit codes 0/1/2/3.
- Tool detection limited to `~/.claude/` in this release; Codex CLI and Gemini CLI targets land in v0.2.0.

[Unreleased]: https://github.com/firatcand/roster/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/firatcand/roster/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/firatcand/roster/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/firatcand/roster/releases/tag/v0.1.0
