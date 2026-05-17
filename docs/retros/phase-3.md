# Phase 3 — Polish and Launch — Retrospective

**Phase milestone:** Phase 3 — Polish and Launch
**Status at gate:** all 10 gate criteria green (`v0.1.0` live on npm with provenance; `npm pack` tarball ~64 kB, well under the 1 MB budget; cold `npx`, warm `install`, and `init` p95 inside SPEC budgets per `test/perf.sh`)
**Closed:** 2026-05-17
**Linear:** [Phase 3 milestone](https://linear.app/firatdogan/issue/ROS-27)

`@firatcand/roster@0.1.0` is published to npm with provenance, signed via the publish workflow on `v*` tag push. GitHub Actions runs typecheck + test + smoke + e2e on every PR, with `production` environment gating manual `workflow_dispatch` releases. The security audit (path traversal guard, no postinstall hooks, files allowlist excludes `spec/`/`src/`) ships as a regression test. README, CHANGELOG, and HOWTO match the published surface. Phase 3 was originally written as "blocked on 2.5" but **decoupled mid-phase** once ADR-0001 made it clear scheduling would be a v0.2.5+ concern — install/init/doctor were always shippable on their own.

## Tasks shipped

| # | Ticket | Title | PR |
|---|---|---|---|
| 1 | ROS-22 | GitHub Actions PR workflow (typecheck + test + smoke + e2e) | [#15](https://github.com/firatcand/roster/pull/15) |
| 2 | ROS-23 | GitHub Actions publish workflow (npm provenance + GitHub Release) | [#35](https://github.com/firatcand/roster/pull/35) |
| 3 | ROS-30 | Security audit — path traversal + supply-chain guards + regression suite | [#17](https://github.com/firatcand/roster/pull/17) |
| 4 | ROS-24 | Perf budgets — `test/perf.sh` SPEC gate | [#34](https://github.com/firatcand/roster/pull/34) |
| 5 | ROS-25 | Structured error UX with `--debug` | [#16](https://github.com/firatcand/roster/pull/16) |
| 6 | ROS-26 | README v0.1 polish — install sample, skills/agents tables, Security, v0.2 roadmap | [#38](https://github.com/firatcand/roster/pull/38) |
| 7 | ROS-27 | Publish v0.1.0 to npm (+ inline runbook in `publish.yml`) | [#63](https://github.com/firatcand/roster/pull/63), [#64](https://github.com/firatcand/roster/pull/64) |
| 8 | ROS-28 | Migrate agent-team to roster init workspace | absorbed by `784dbdd` (`.dogfood/` move) — marked **Duplicate** |
| — | ROS-46 | Gate `workflow_dispatch` behind `production` environment (hardening) | [#43](https://github.com/firatcand/roster/pull/43) |
| — | ROS-47 | SHA-pin all GitHub Actions + add Dependabot | [#56](https://github.com/firatcand/roster/pull/56) |

**Numbers:** 9 PRs merged in-phase (plus 2 hardening tickets out-of-plan) · tarball 64 kB / ~80 files at v0.1.0 · npm provenance signed · cold `npx @firatcand/roster --version` ≤ 10 s p95 on stock Mac · `roster install` ≤ 2 s warm · `roster init` ≤ 3 s · zero postinstall hooks · `files` allowlist verified by `npm pack --dry-run`.

## Gate criteria

| # | Criterion | Status |
|---|---|---|
| 1 | GitHub Actions PR workflow (typecheck + test) passes on `main` | OK (ROS-22 / #15; smoke + e2e added in same PR) |
| 2 | GitHub Actions publish workflow triggers on `v*` tag and pushes to npm | OK (ROS-23 / #35; hardened by ROS-46 + ROS-47) |
| 3 | `npm info @firatcand/roster` shows v0.1.0 with provenance | OK (published 2026-05-17 16:35Z via tag push) |
| 4 | Cold `npx @firatcand/roster` p95 ≤ 10 s on stock Mac with Node 22 | OK (`test/perf.sh` enforces) |
| 5 | `roster install` p95 ≤ 2 s warm | OK |
| 6 | `roster init` p95 ≤ 3 s | OK |
| 7 | `npm pack --dry-run` tarball ≤ 1 MB | OK (~64 kB) |
| 8 | Security audit — no postinstall, path-traversal test passes, allowlist excludes `spec/`/`src/` | OK (ROS-30 / #17) |
| 9 | `roster install` + `roster init` run cleanly from the published npm package | OK (verified via fresh `npx` from registry) |
| 10 | `~/repos/agent-team` archived and replaced by roster-init'd workspace | OK (dogfood migrated to `.dogfood/`; ROS-28 closed as Duplicate) |

## Decisions made (and why)

1. **Decoupled v0.1.0 publish from Phase 2.5 scheduling work mid-phase.** The original phases.yaml had Phase 3 `blocked_by: phase-2.5`, written before ADR-0001 grew the scheduling surface. Once it was clear scheduling would be a multi-week effort with its own substrate (`CONTEXT.md`, `roster-orchestrator`, HITL queue), shipping install/init/doctor as v0.1.0 was the obvious unblock. Documented inline on ROS-27 and reflected in the public roadmap before tag push.
2. **Publish runbook inlined into `publish.yml`, not a separate doc.** The original plan was `docs/publish-runbook.md` referenced by the workflow. Switched to comment-in-workflow during ROS-27 because the runbook was short (≤ 30 lines), the file that runs the publish is the natural place for "how to run this," and a separate doc would have drifted. (ROS-27 / #63, follow-up fix in #64.)
3. **`workflow_dispatch` gated behind a `production` GitHub Environment.** ROS-46 added a manual approval gate on top of tag-triggered publish. Catches accidental clicks in the Actions UI and gives a second pair of eyes on emergency manual runs without sacrificing the tag-push happy path.
4. **All Actions SHA-pinned via Dependabot.** Out-of-plan ticket ROS-47 (#56) replaced `@v3`/`@v4` floating tags with full commit SHAs and added a Dependabot config so updates land as reviewable PRs. Supply-chain hygiene that should have been in the original ROS-22 spec — added once the publish workflow made it more material.
5. **Perf gate ships as a dev-only script, not a CI gate.** `test/perf.sh` (ROS-24 / #34) runs `roster install`, `init`, `doctor`, and `npm pack` against SPEC budgets but isn't wired into the PR workflow because CI runners are too noisy for sub-3-second wall-clock asserts. Run it locally before any release; documented in `CLAUDE.md`.
6. **Structured error UX gated behind `--debug`, not always-on.** ROS-25 / #16 introduced a typed error hierarchy with codes and remediation hints; the full stack trace only renders when `--debug` is passed. Plain runs stay scannable; debug runs stay diagnosable. Closer to `pnpm`'s ergonomics than `npm`'s wall of text.
7. **ROS-28 closed as Duplicate; dogfood migration happened via the `.dogfood/` move (`784dbdd`).** The original plan was to migrate Firat's `~/repos/agent-team` end-to-end via `roster init`. In practice the dogfood instance was relocated to `.dogfood/` inside this repo, which exercises the same migration path (init → scaffold → preserve overrides) against the maintainer's real config. Linear ticket marked Duplicate rather than rewriting the plan.

## Scope changes vs original phases.yaml

- **ROS-46 + ROS-47 added out-of-plan.** Both landed inside the Phase 3 window as supply-chain hardening (`production` env gate; SHA-pinned Actions + Dependabot). Not in the original 8-task spec; left as Linear-only rather than back-filled into phases.yaml because they're hardening on top of a delivered surface, not phase-defining work.
- **CI workflow scope expanded.** ROS-22 originally said "typecheck + test on PRs"; shipped with smoke + e2e + concurrency guards + branch-protection docs in one PR. Cheap to bundle, expensive to split.
- **Perf budgets unchanged in number but moved to a script.** SPEC's three budgets (cold `npx`, warm install, init) are enforced by `test/perf.sh`; no CI integration (see decision 5).
- **`ROS-48` (dead `file` skillsLayout branch removal) landed in Phase 3's window.** Technically Phase 2.5 cleanup — `installToTool`'s `skillsLayout: 'file'` branch was dead after Codex switched to the prompt-dir layout. Removed in #69 to keep `tools.ts` honest.

## Learnings to harvest

1. **`production` GitHub Environment for `workflow_dispatch` is one config line and prevents a real failure mode.** A second click in the Actions UI is a cheap interlock against accidental publishes and gives explicit audit trail of who triggered. Should be the default for any `workflow_dispatch`-capable publish workflow, not a follow-up patch.
2. **SHA-pin Actions from day one, not after the first publish workflow ships.** Floating `@v4` tags are a supply-chain hole that's invisible until it's exploited. Dependabot handles the noise — there is no good reason to skip this even for a tiny repo.
3. **Perf gates in CI are a trap on shared runners.** Sub-3-second wall-clock asserts flake; sub-10-second asserts flake less but still flake. Local-run scripts with documented invocation work better than green/red CI signal for perf at this scale.
4. **Decouple shippable surface from in-flight architecture early.** `Phase 3 blocked_by phase-2.5` cost two days of confusion. Once it was clear v0.1.0 didn't need scheduling, the unblock was a phases.yaml edit and a roadmap update — should have happened the moment ADR-0001 was drafted, not the day before tag push.
5. **Inline runbooks beat sidecar docs for workflow files.** The runbook lives where the workflow lives; drift is near-impossible. Sidecar docs need their own keep-fresh discipline.
6. **A "marked Duplicate" Linear ticket is fine when the work happened under a different commit.** ROS-28 closed via `.dogfood/` move — the work exists, the ticket just isn't where you'd expect. Don't rewrite Linear history; document the absorption in the retro.

## What to do differently in Phase 4 and beyond

1. **Skill-content tickets benefit from a fixture-driven test harness more than CLI tickets do.** Phase 4's golden-snapshot harness (ROS-54) was the right pattern; the Phase 3 doctor/install regression suites pre-date it. Future skill work should design the test fixtures alongside the skill body, not retrofit.
2. **Hardening tickets (SHA-pin, env gate) should be Phase 1 scaffolding, not Phase 3 cleanup.** Every future repo should land Dependabot + SHA-pinned Actions + a `production` env gate before the first feature commit. Cheap; bypassable only by being lazy.
3. **`CHANGELOG.md` should land with v0.1.0, not after.** First entry exists, but [Unreleased] for v0.4.0 was added retroactively. Make it part of the publish runbook gate — empty `## [Unreleased]` headers are fine; a missing CHANGELOG isn't.
4. **Stop saying "blocked on" in phases.yaml until the dependency is real.** Phase 4 was written as `blocked_by: phase-3` and shipped in a single day after Phase 3 closed because the blocker was nominal. If the dependency isn't a hard one, mark it `depends_on` (advisory) or drop it entirely.
