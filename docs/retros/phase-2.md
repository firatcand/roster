# Phase 2 — Core Features — Retrospective

**Phase milestone:** Phase 2 — Core Features
**Status at gate:** all 7 gate criteria green (Claude Code `/sdr` end-to-end run validated by `test/e2e-sdr.sh` against the structural contract; the live Claude Code invocation is a manual gate, per ROS-20)
**Closed:** 2026-05-14
**Linear:** [Phase 2 milestone](https://linear.app/firatdogan/project/roster)

Every supported AI tool — Claude Code, Codex CLI, Gemini — installs cleanly with the right per-tool layout (dir-per-skill for Claude / Gemini, flat `.md` for Codex). `roster init` produces the full workspace tree (`gtm/`, `product/`, `design/`, `ops/`, `chief-of-staff/`, `dreamer/`, `projects/_demo/`, `scripts/`, `conventions.md`) and is non-destructive on re-run, with a forge-aware overwrite prompt. `roster doctor` audits the installed surface and exits 1 on drift. `pnpm e2e` asserts the SDR contract structurally so CI can detect breakage of the `/sdr run cold-outreach for _demo` path even though the live Claude Code invocation stays manual. README documents the migration from `~/repos/agent-team` end-to-end.

## Tasks shipped

| # | Ticket | Title | PR |
|---|---|---|---|
| 1 | ROS-9 | Port dreamer and sdr skills + subagents | [#7](https://github.com/firatcand/roster/pull/7) |
| 2 | ROS-12 | Port EXPERT.md files for gtm/product/design/ops | [#11](https://github.com/firatcand/roster/pull/11) |
| 3 | ROS-13 + ROS-15 | Codex CLI + Gemini install targets | [#4](https://github.com/firatcand/roster/pull/4) |
| 4 | ROS-16 | `install --all` and `install --tool` non-interactive flags | [#8](https://github.com/firatcand/roster/pull/8) |
| 5 | ROS-17 | Full workspace scaffold templates | [#5](https://github.com/firatcand/roster/pull/5) |
| 6 | ROS-18 | Extend `init` to copy full scaffold (non-destructive + forge-aware) | [#6](https://github.com/firatcand/roster/pull/6) |
| 7 | ROS-19 | `roster doctor` (audit installed skills + agents per AI tool) | [#10](https://github.com/firatcand/roster/pull/10) |
| 8 | ROS-20 | e2e SDR contract gate (`pnpm e2e` + `test/e2e-sdr.sh`) | [#9](https://github.com/firatcand/roster/pull/9) |
| 9 | ROS-21 | README migration + Getting started sections | [#14](https://github.com/firatcand/roster/pull/14) |
| — | ROS-14 | Descope Cursor from Phase 2 | [#2](https://github.com/firatcand/roster/pull/2) |
| — | ROS-29 | Unit tests — absorbed; suite extended in-flight across ROS-9/13/15/16/18/19/20 | — |

**Numbers:** 11 PRs merged (12 once #14 lands) · bundle 27.82 kB (gzip 7.79 kB) · 93 unit tests across 8 spec files (Phase 1 closed with 14) · 3 AI tools supported with verified per-tool install paths.

## Gate criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `pnpm typecheck && pnpm test && pnpm build` all exit 0 | OK (93/93 tests, 0 type errors, 27.82 kB bundle) |
| 2 | `roster install` writes to correct per-tool paths for all three supported AI tools | OK (Claude `~/.claude/skills/<skill>/`, Codex `~/.codex/prompts/<skill>.md`, Gemini `~/.gemini/extensions/<skill>/`) |
| 3 | `roster doctor` exits 0 on fresh install, exits 1 when a skill is manually deleted | OK (`audit.test.ts`, `cli-doctor.test.ts`) |
| 4 | `roster init` produces the full workspace tree | OK (`init.test.ts` asserts `gtm/`, `dreamer/`, `chief-of-staff/`, `conventions.md`, …) |
| 5 | After install + init, `/sdr run cold-outreach for _demo` writes a run log in Claude Code | Structurally validated by `test/e2e-sdr.sh`; live Claude Code run is a documented manual gate |
| 6 | README contains migration steps for replacing `~/repos/agent-team` | OK (added in PR #14, ROS-21) |
| 7 | Re-running `install` and `init` are both idempotent | OK (`install.test.ts` idempotency cases per tool; `init.test.ts` re-run preserves edits) |

## Decisions made (and why)

1. **Cursor descoped to "out of scope" rather than Phase 3.** Cursor's `.cursor/rules/*.mdc` injects static markdown into every chat — there's no first-class skill invocation, no subagents, no slash commands as workflow entry points. Shipping there would only bloat conversations without delivering the workflow value. Documented in `docs/roadmap.md` and the README Tool support table. (ROS-14 / PR #2.)
2. **Per-tool install strategy split landed in ROS-13/15 (PR #4), not as a separate refactor.** Codex's flat-file layout forced the abstraction earlier than expected — instead of duplicating the Claude path, `installToTool` dispatches on `skillsLayout: 'dir' | 'file'` and per-tool `skillsFileExt`. Phase 1's "lift the strategy split early" follow-up was honored.
3. **`docs/learnings/` is local-only, not checked in.** Mid-phase, removed the entire directory from the public repo (PR #12, PR #13) and gitignored it. Personal lessons are valuable but they aren't a public-facing artifact — they belong in the dreamer reinforcement loop locally. Future phases capture learnings in the retro instead.
4. **CI workflow moved up from Phase 3.** GitHub Actions CI (typecheck + test on PRs) landed in PR #3, well before its planned Phase 3 ticket. Catching regressions on every PR was worth the early investment given the per-tool install variants. ROS-22 in Phase 3 will extend it rather than bootstrap it.
5. **e2e SDR gate is structural, not live.** `test/e2e-sdr.sh` runs `roster init` in a tmp dir and asserts the SDR agent contract is intact (required files, plan paths, `projects/_demo/config/default.yaml`), then prints the manual Claude Code checklist. The live `/sdr run` is treated as a documented manual gate because Claude Code can't be driven from CI. (ROS-20 / PR #9.)
6. **Forge marker detection in `roster init`.** When `BRIEF.md`, `spec/PRD.md`, or `plans/phases.yaml` are present, init prompts with a forge-aware message before scaffolding (and warns when the marker exists but `CLAUDE.md` doesn't). Keeps roster and forge complementary without forcing a hard either-or. (ROS-18 / PR #6.)
7. **Codex review caught two verbatim-port drifts.** Once during ROS-9 (skill bodies diverged from source) and once during ROS-13/15 (briefs missed details only visible in the upstream skill). Both fixed before merge. Worth keeping codex review in the loop for content-port tickets — the local CLAUDE conventions reviewer can't reliably check against an external source-of-truth.

## Scope changes vs original phases.yaml

- **ROS-29 (Node unit tests for core lib) absorbed into in-flight work.** Phase 1's retro already flagged this: the suite was bootstrapped in P1, and Phase 2 extended it organically as each ticket landed (audit tests with ROS-19, install-args tests with ROS-16, init-args tests with ROS-18, codex/gemini coverage with ROS-13/15). No standalone ROS-29 commit; the dedicated ticket can close as "satisfied by aggregate."
- **`roster install` flag set expanded beyond the original spec.** Original Phase 2 spec was checkbox-only multi-tool prompt. ROS-16 added `--all` and `--tool <name>` for non-interactive use after the TTY audit (no-TTY environments hung the prompt). Required by `test/e2e-sdr.sh` and any future CI / scripted migration.
- **`roster doctor` gained `--json` output.** Not in the original ROS-19 description, but the contract gate needed machine-readable output to assert correctness without parsing prose. Cheap to add, useful for any future automation.
- **EXPERT.md content lives in `templates/scaffold/`, not in `agents/`.** EXPERT files are workspace substrate, not agent definitions — they describe what an expert function shapes, not what an agent produces. Distinction matters for the substrate-vs-artifacts model. (ROS-12 / PR #11.)
- **`docs/learnings/` ripped out of the public repo mid-phase.** Pre-Phase-2 convention had been to commit learnings publicly; reversed once it became clear they're inherently personal-context and noise to anyone else reading the repo.

## Learnings to harvest

Candidates for the dreamer reinforcement loop — captured here locally, not in `playbook/`.

1. **Non-interactive CLI flags need a TTY audit before they ship.** `roster install` originally always prompted; piping into a script or running in CI hung indefinitely. The fix landed in ROS-16 (`--all`, `--tool`, `--silent`), but the lesson is broader: any prompt path needs `process.stdin.isTTY` introspection + a non-interactive escape hatch from day one.
2. **`gitignore` and the npm `files` allowlist solve different problems and can diverge.** A file can be tracked in git but excluded from the published tarball (or vice versa). When in doubt, `npm pack --dry-run` is the ground truth for what ships. Caught during ROS-17 when scaffold templates were tracked but missing from the tarball.
3. **Contract tests must mirror the document's form.** ROS-20's first cut asserted parsed YAML; the real `/sdr` agent.md uses markdown sections referencing relative paths, so the contract test had to parse the markdown sections (not the implied YAML). Lesson: a contract test that infers structure the document doesn't have is testing the test author, not the document.
4. **Per-tool symlink handling needs explicit accept/decline branches per layout.** Claude (dir target), Codex (file target), and Gemini (dir target) all hit the symlink case differently. The `ConfirmFn` injection pattern from Phase 1 scaled cleanly — but each layout needed its own "decline-preserve" and "accept-overwrite" branch + test. Don't assume symmetric handling across tools.
5. **Codex review pairs well with content-port tickets.** It surfaces drift between source and ported content that a self-review tends to miss. Less useful on pure-mechanical PRs (CI config, gitignore tweaks) where there's no external source-of-truth to compare against.
6. **The forge-aware `init` prompt is a one-liner with outsized UX value.** Two product layers (forge for product code, roster for agent teams) coexist in the same repos often enough that a single "detected forge markers — proceed?" prompt prevents a class of "did I just overwrite my brief?" panics. Worth replicating any time two related tools touch the same filesystem.

## What to do differently in Phase 3

1. **Publish runbook should ship before the publish workflow runs.** ROS-27 plans to write the runbook as a comment in the workflow file — better to draft it as a separate `docs/publish-runbook.md` first, dry-run it against `npm pack` locally, then wire the workflow second. Easier to iterate on the prose without retriggering CI.
2. **`pnpm smoke` and `pnpm e2e` both belong in the PR workflow.** Phase 2's gate command is `typecheck && test && build`; the smoke + e2e scripts only ran locally. ROS-22 should add them — they exercise codepaths (tarball install, init+contract) that the unit tests can't reach.
3. **npm provenance gated on tag push.** Don't make publishing a manual step. ROS-23 wires the publish workflow to `v*` tag pushes — keep that contract; manual `npm publish` is too easy to skip provenance on.
4. **Security audit (ROS-26) should land before the publish workflow, not after.** Phase 2 had no postinstall and no telemetry by convention; Phase 3 should make it gate-enforced before v0.1.0 ships, not as a post-publish patch.
5. **Migration check after v0.1.0 publish.** ROS-28 plans to migrate Firat's own `~/repos/agent-team`. Treat that as the real acceptance test for the entire migration flow — if it doesn't work end-to-end on the maintainer's own data, the README docs aren't ready.
6. **Re-evaluate the `npx @firatcand/roster` story.** Until v0.1.0 publishes, every README and Getting-started doc references `npx` flows that don't actually work. Phase 3 should publish first, then refresh docs second, to avoid a fresh round of "wait, why doesn't this install?" friction.
