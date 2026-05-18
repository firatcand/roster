# Phase 2.5 — Scheduling Primitives — Retrospective

**Phase milestone:** Phase 2.5 — Scheduling primitives
**Status at gate:** all 10 gate criteria green (typecheck + 820 tests + build pass on main; CONTEXT.md/symlink architecture, orchestrator skill, schedule install for both Claude and Codex, scheduling tests, doctor cross-checks, docs/SCHEDULING.md, and the subscription-safety audit all in place)
**Activated:** 2026-05-15 · **Closed:** 2026-05-18 (3-day execution window, after the ADR-0001 spike phase that ran 2026-05-11 → 2026-05-15)
**Linear:** [Phase 2.5 milestone](https://linear.app/firatdogan/project/roster)

Phase 2.5 was inserted between Phase 2 (Core Features) and Phase 3 (Polish & Launch) as a side-track once it became clear scheduling primitives needed to land before any agent-team workspace could be useful on a regular cadence. The phase delivered subscription-safe scheduling for both Claude Code (UI hand-off via Desktop Scheduled Tasks) and Codex CLI (UI hand-off via app Automations + opt-in `--via cron` programmatic path), the `roster-orchestrator` skill that every fire bootstraps, a HITL pending queue surfaced via SessionStart banners, the `CONTEXT.md` symlink architecture that lets the same workspace be opened by either Claude Code or Codex CLI, and a `roster doctor` cross-tool audit that catches the misconfigurations a user is most likely to ship with. Architecture is captured in `docs/adr/0001-scheduling-architecture.md`; the canonical user-facing reference is `docs/SCHEDULING.md`.

## Tasks shipped

### In-plan (15/15)

| # | Ticket | Title | PR |
|---|---|---|---|
| 1 | ROS-31 | CONTEXT.md template + symlink/dual-write logic in `roster init` | [#39](https://github.com/firatcand/roster/pull/39) |
| 2 | ROS-32 | `roster-orchestrator` skill — canonical body + per-tool installers | [#40](https://github.com/firatcand/roster/pull/40) |
| 3 | ROS-33 | Subagent definitions installer (Claude .md + Codex .toml; Windows workaround) | [#61](https://github.com/firatcand/roster/pull/61) |
| 4 | ROS-34 | `roster schedule install` — Claude (UI hand-off) | [#76](https://github.com/firatcand/roster/pull/76) |
| 5 | ROS-35 | `roster schedule install` — Codex (Automation hand-off + `--via cron` programmatic) | [#85](https://github.com/firatcand/roster/pull/85) |
| 6 | ROS-36 | `roster schedule list/remove/status/run` | [#91](https://github.com/firatcand/roster/pull/91) |
| 7 | ROS-37 | HITL pending queue + `roster review` CLI + SessionStart hooks | [#81](https://github.com/firatcand/roster/pull/81) |
| 8 | ROS-38 | `roster doctor` — scheduling, subscription-safety, secrets checks | [#94](https://github.com/firatcand/roster/pull/94) |
| 9 | ROS-39 | `docs/SCHEDULING.md` — canonical scheduling reference | [#73](https://github.com/firatcand/roster/pull/73) |
| 10 | ROS-40 | Scheduling tests (unit + e2e shell + manual macOS gate) | [#95](https://github.com/firatcand/roster/pull/95) |
| 11 | ROS-41 | `schedules.yaml` schema validation + `roster schedule validate` | [#41](https://github.com/firatcand/roster/pull/41) |
| 12 | ROS-42 | Failure observability for scheduled fires | [#107](https://github.com/firatcand/roster/pull/107) |
| 13 | ROS-43 | Migration from `agent-team` to `roster` (moved from P3-T08) | [#88](https://github.com/firatcand/roster/pull/88) |
| 14 | ROS-44 | `roster schedule estimate-usage` command | [#108](https://github.com/firatcand/roster/pull/108) |
| 15 | ROS-45 | `--dry-run` flag uniform across `schedule install/run/remove` + `doctor` | [#92](https://github.com/firatcand/roster/pull/92) |

### Adjacent (added mid-phase, mostly codex-review follow-ups)

| Ticket | Title | PR |
|---|---|---|
| ROS-65 | `roster doctor --fix` mode (symlinks + `.env` 0600) | bundled in [#94](https://github.com/firatcand/roster/pull/94) |
| ROS-59 | Parse slash-command frontmatter as YAML before placeholder scan | [#84](https://github.com/firatcand/roster/pull/84) |
| ROS-62 | Quote `renderSlashCommand` description for YAML-safe emission | [#101](https://github.com/firatcand/roster/pull/101) |
| ROS-64 | `migrate`: harden wrapper path resolution + shell-escape rendered commands | [#100](https://github.com/firatcand/roster/pull/100) |
| ROS-66 | Rewrite `templates/scaffold/conventions.md` Schedules per ADR-0001 | [#99](https://github.com/firatcand/roster/pull/99) |
| ROS-67 | Sweep legacy `scripts/cron/wrappers/` refs in scaffold + docs | [#104](https://github.com/firatcand/roster/pull/104) |
| ROS-68 | `migrate`: sanitize newlines in install-script TODO comments | [#106](https://github.com/firatcand/roster/pull/106) |
| ROS-69 | Enforce slug shape in `is_valid_function`/`read_functions` | [#109](https://github.com/firatcand/roster/pull/109) |
| ROS-70 | Scope `--tool` enum per subcommand in `--help` | [#111](https://github.com/firatcand/roster/pull/111) |

**Numbers:** 15 in-plan tasks + 9 adjacent/follow-up PRs merged · 820 tests passing on main (up from ~520 at the start of the phase) · packed tarball 257 kB / 62 kB gzipped (well under the 500 kB SPEC budget) · zero new runtime deps (cron-next + cron-exit-log + pending-sync are all hand-rolled).

## Gate criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `pnpm typecheck && pnpm test && pnpm build` exit 0 | OK (820/820 tests on `main` post-merge) |
| 2 | `roster init` writes CONTEXT.md + CLAUDE.md/AGENTS.md symlinks (macOS/Linux) or dual-write (Windows); `roster doctor` confirms integrity | OK (ROS-31; `auditWorkspace` covers all four sub-statuses) |
| 3 | `roster install` lays down the `roster-orchestrator` skill into `~/.claude/skills/` and `~/.codex/skills/` with per-tool body | OK (ROS-32; install tests + tools.ts coverage) |
| 4 | `roster schedule install --tool codex --via cron` writes a working crontab line; running it invokes `codex exec` headlessly under subscription auth | OK (ROS-35; Spike 1 in ADR-0001 verified end-to-end on macOS) |
| 5 | `roster schedule install --tool claude` prints a valid UI-import spec + step-by-step hand-off | OK (ROS-34; markdown not JSON — Spike 2 found Claude Desktop has no JSON-import API; documented under [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)) |
| 6 | Scheduled fire runs end-to-end: fresh CLI → orchestrator → subagent → run log → HITL items | OK (ROS-37 + ROS-40 e2e + manual macOS gate documented in `docs/SCHEDULING.md`) |
| 7 | Chat sessions surface pending HITL via SessionStart hook | OK (ROS-37 `roster hooks install` + ROS-42 `banner.sh` v2 with `roster pending sync`) |
| 8 | `roster doctor` detects missing symlinks, schedules.yaml ↔ crontab drift, missing `.env` keys, Codex Windows TOML workaround | OK (ROS-38; `auditCronDrift`, `auditWorkspace`, `auditEnvPermissions`, `auditAltSkillPaths`, `computeWorkarounds`) |
| 9 | `docs/SCHEDULING.md` documents the platform × tool matrix, Linux Claude gap, Codex Windows caveat, UI hand-off flow | OK (ROS-39 + ROS-66 rewrite per ADR-0001 + ROS-67 sweep) |
| 10 | No installed skill/template invokes `claude -p` or imports the Anthropic SDK — verified by static audit in `roster doctor` | OK (ROS-38 `runSafetyAudit` with banned-patterns scan; regression test prevents `--fix` from auto-unsetting envs to dodge the check) |

## Decisions made (and why)

- **Native local schedulers over a custom daemon.** Rejected the multi-process scheduler model early in the spike phase. Reasoning in ADR-0001: a custom daemon would need heartbeat locks, takeover logic, context-management loops, and daily restarts — none of which add user value compared to the OS-provided primitives. Each scheduled fire is now a fresh CLI session; there is no long-lived "scheduler context" to manage, which deletes an entire category of bugs.
- **Subscription-only, no Agent SDK billing.** `roster doctor`'s banned-patterns audit refuses any installed skill/template that references `claude -p`, `claude api`, or the Anthropic SDK. The `--fix` mode is deliberately scoped to symlinks + `.env` permissions and a regression test prevents adding env-var unset to `--fix` (would let a tampering user silently dodge subscription-safety).
- **Markdown hand-off for Claude, not JSON.** Spike 2 (2026-05-15) confirmed Claude Desktop stores Scheduled Tasks in opaque LevelDB with no JSON-import path. Switched the install artifact to a paste-ready markdown fields doc rather than blocking on the upstream issue ([anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)).
- **Codex `--via cron` is opt-in, not default.** Default for `--tool codex` is the UI hand-off via app Automations (which works inside the Codex app's subscription session). `--via cron` is the power-user path; it installs a `env -i`-wrapped crontab line with a subscription-attestation block verified by `codex-preflight`.
- **`CONTEXT.md` as the single source of truth, with `CLAUDE.md`/`AGENTS.md` symlinks.** Lets the same workspace be opened by either tool without content divergence. Windows can't `ln -s` reliably, so falls back to dual-write with an integrity check.
- **Dual-channel failure observability (ROS-42).** Wrapper writes `.exit` independently; orchestrator writes `state.md`. `roster doctor` cross-references both; non-zero `.exit` is FAIL (flips overall ok), STALE is WARN (transient missed window). `roster pending sync` synthesizes HITL items with deterministic ids so the SessionStart hook + doctor never duplicate. See `docs/learnings/2026-Q2/detect-stale-benign-default-when-lastrun-missing.md` for why the detector refuses to claim STALE without a baseline.
- **`atomicWriteFile` + side-effects-before-YAML ordering in `installCodexSchedule`.** Codex review impl-pass on ROS-35 caught that a crontab write failure could leave `schedules.yaml` claiming `status=installed` with no live cron line; the install flow now does crontab/fields-doc first, YAML commit last.

## Scope changes vs original phases.yaml

- **ROS-43 (migrate from agent-team) was pulled forward** from P3-T08 into Phase 2.5 because the scheduling design needed to inform the migration path; would have been mis-shaped otherwise.
- **ROS-65 (doctor `--fix` mode) was added mid-phase** as a usability follow-up after the first doctor pass; bundled into the ROS-38 PR rather than billed separately.
- **9 codex-review follow-ups** (ROS-59, 62, 64, 66, 67, 68, 69, 70 + the ROS-65 bundle) landed as small fixes after their parent tickets shipped. None changed the phase contract; collectively they account for ~25% of merge volume in the phase.
- **3 follow-ups deferred to backlog** (orphan to phases.yaml, but acceptable per CLAUDE.md tracker-is-source-of-truth rule):
  - ROS-57 — Periodic re-check of `claude://` URL scheme (will reactivate if Anthropic ships a deep-link)
  - ROS-63 — File-lock/CAS for migrate manifest writes (TOCTOU window; one-shot operation makes it acceptable for now)
  - ROS-71 — `estimate-usage --json` row superset (ROS-44 codex 3rd-pass finding from today; row shape consistency)

## Learnings to harvest

Captured during the phase (under `docs/learnings/2026-Q2/`):

- `shell-quote-dance-survives-nesting.md` — wrapping an already-single-quoted command in `/bin/sh -c '...'` works correctly via `shellQuote()` recursion; documented for future ssh/sudo/here-string wrapping needs.
- `detect-stale-benign-default-when-lastrun-missing.md` — staleness detectors should refuse to fire without a baseline rather than going pessimistic; pessimistic semantics would have UX-broken every fresh `roster schedule install`.
- `vixie-cron-dom-dow-or-semantics.md` — when both day-of-month and day-of-week are restricted, Vixie cron ORs them (the only non-AND semantics in the five fields); detection rule is `!field.startsWith('*')`, not `field !== '*'`.
- `subscription-safety-must-be-symmetric-across-codex-paths.md` — preflight at install time AND run time AND doctor time; one-shot is not enough.
- `mkdir-p-hides-ancestors-from-rollback-walker.md` — atomic-write rollback must track the full path, not just the leaf.
- `two-layer-invariants-pre-render-and-pre-write-are-different-contracts.md` — different checks at different boundaries; merging them produces ambiguity.
- `codex-reads-contracts-literally-pr-toolkit-reads-code-first.md` — different reviewers find different things; multi-pass review pays off.
- `strict-parser-replacement-needs-permitted-input-probe.md` — when migrating to a stricter parser, prove the permissive case still parses before flipping the cutover.
- `tamper-tests-must-call-the-real-comparison-helper.md` — security tests that don't actually exercise the gate they claim to verify are worse than no test.

## What to do differently next

- **Resolve install-mtime anchoring early.** `detectStale` deferred the "freshly installed schedule" distinction to a caller layer that doesn't yet exist. Pick this up as a doctor-layer check (use `schedules.yaml` mtime) before any new schedule-related feature lands — currently a fresh install can sit silently for a week before any signal appears.
- **Tighten the pending-sync race.** Concurrent `roster pending sync` calls (banner + manual) both pass `existsSync` then `renameSync` over the same deterministic-id path. No corruption today (last-writer-wins on a body that only differs in `detected_at` ms), but use `O_EXCL` or a per-fn lock the next time the pending shape changes.
- **Lift schedule activity reporting out of git-log spelunking.** `/sync-status` today does ad-hoc grep against `plans/phases.yaml`; a Linear-native cycle dashboard or a `roster schedule audit` CLI would surface "what fired, what failed, what skipped" without requiring tribal git knowledge.
- **Spec the orchestrator skill's failure semantics in CONTRACTS, not just code.** State.md vs `.exit` is a load-bearing dual-channel design that lives only in code comments + ADR-0001 prose. Promote to `spec/SPEC.md §Failure observability` (or equivalent) so a future contributor doesn't merge the two without realizing what they undo.
- **Trim adjacent-PR sprawl.** 9 follow-up PRs (one per codex finding) doubled the merge volume of the phase. The Phase 4 retro had the same shape but in a single calendar day. For Phase 2.5 the spread cost concentration. Next phase: bundle related codex findings into one fix-up PR per parent ticket rather than one per finding, unless the findings are genuinely orthogonal.

---

_Phases 1, 2, 3, and 4 are also complete. Phase 2.5 was the last open phase track. There is no Phase 5 currently queued in `plans/phases.yaml`; next work should be planned via `/decompose` once the next product goal lands._
