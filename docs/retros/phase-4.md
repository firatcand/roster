# Phase 4 — Guided Agent Authoring — Retrospective

**Phase milestone:** Phase 4 — Guided Agent Authoring
**Status at gate:** all 8 gate criteria green (golden-snapshot harness asserts the dialogue mode regression-free without invoking an LLM in CI; atomic-write rollback test simulates mid-pass failure and asserts zero residual files; SDR contract e2e passes unmodified)
**Closed:** 2026-05-17 (single-day phase)
**Linear:** [Phase 4 milestone](https://linear.app/firatdogan/issue/ROS-49)

`/chief-of-staff create-agent` now runs a guided five-phase dialogue in TTY contexts (prose intake → classify boilerplate/grounded/uncertain → targeted follow-up Q&A → consolidated preview with `y/revise/cancel` → atomic write) that populates `agent.md`, real `subagents/<name>.md` files, an optional starter `plans/<plan>.yaml`, and a ≤ 80-character slash-command description. Non-TTY runs (CI, piped stdin, `AGENT_TEAM_NO_CONFIRM=1`) keep the v0.1/v0.2/v0.3 stub behavior **byte-for-byte** so `pnpm e2e` and power-user scripts continue to work. The skill obeys an explicit anti-fabrication invariant: every populated field is sourced from prose, follow-up Q&A, or `<function>/EXPERT.md` — uncertain gaps surface as questions, never as plausible-looking defaults. Write is atomic with rollback on failure.

## Tasks shipped

| # | Ticket | Title | PR |
|---|---|---|---|
| 1 | ROS-49 | Mode-branched `create-agent.yaml` (TTY-aware: stub vs guided) | [#57](https://github.com/firatcand/roster/pull/57) |
| 2 | ROS-50 | Guided Agent Creation contract in `chief-of-staff/SKILL.md` | [#59](https://github.com/firatcand/roster/pull/59) |
| 3 | ROS-51 | Per-file content contracts + cross-file invariants | [#60](https://github.com/firatcand/roster/pull/60) |
| 4 | ROS-52 | Atomic write contract + rollback semantics | [#65](https://github.com/firatcand/roster/pull/65) |
| 5 | ROS-53 | `scripts/new-agent.sh --slash-only` recovery flag | [#66](https://github.com/firatcand/roster/pull/66) |
| 6 | ROS-54 | Fixture-driven golden-snapshot test harness | [#72](https://github.com/firatcand/roster/pull/72) |
| 7 | ROS-55 | Stub regression + invariant unit + atomic rollback tests | [#75](https://github.com/firatcand/roster/pull/75) |
| 8 | ROS-56 | HOWTO + README + CHANGELOG dialogue-mode docs | [#70](https://github.com/firatcand/roster/pull/70) |
| — | ROS-58 | Ship 10 `chief-of-staff` scripts in `templates/scaffold/scripts/` | [#71](https://github.com/firatcand/roster/pull/71) |

**Numbers:** 8 in-plan PRs + 1 adjacent (ROS-58) merged in a single calendar day (2026-05-17, 13:39Z → 21:41Z, ~8 hours wall-clock) · 3 new test files (`create-agent.stub.test.ts`, `create-agent.invariants.test.ts`, `create-agent.atomic.test.ts`) · golden-snapshot fixture under `test/fixtures/create-agent/` · stub-mode output remains byte-identical to `bash scripts/new-agent.sh` · `pnpm e2e` SDR contract gate passes without modification.

## Gate criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Non-TTY `/chief-of-staff create-agent` produces byte-identical output to `bash scripts/new-agent.sh` | OK (ROS-55 / `create-agent.stub.test.ts` asserts byte-equality) |
| 2 | `AGENT_TEAM_NO_CONFIRM=1` forces stub mode in TTY context | OK (ROS-49) |
| 3 | TTY guided run on the canonical fixture generates a tree matching the committed golden snapshot | OK (ROS-54 harness) |
| 4 | Atomic-write rollback test passes (simulated mid-pass failure leaves zero files on disk) | OK (ROS-55 / `create-agent.atomic.test.ts`) |
| 5 | All 5 cross-file invariants enforced before write | OK (ROS-51 + ROS-55 / `create-agent.invariants.test.ts`) |
| 6 | `pnpm e2e` SDR contract passes without modification | OK (verified post-merge) |
| 7 | `skills/chief-of-staff/SKILL.md` documents the Guided Agent Creation contract | OK (ROS-50) |
| 8 | `docs/HOWTO.md` and `README.md` describe the dialogue mode | OK (ROS-56) |

## Decisions made (and why)

1. **TTY-aware mode branch instead of a flag.** `create-agent.yaml` checks `process.stdin.isTTY` and `AGENT_TEAM_NO_CONFIRM` at plan-load time and dispatches to either the stub block or the five-phase dialogue block. No new flag, no breaking change for scripts. The cost is one branch in a YAML plan; the benefit is invisible upgrade for power-user automations. (ROS-49 / #57.)
2. **Stub mode is the floor, not a fallback.** The skill body and the plan both treat stub-mode output as a contract — the dialogue is a strict superset that must produce the same file tree (plus populated content) and pass the same invariants. Anything the dialogue produces, stub mode produces too (just with placeholder strings). Means the `create-agent.stub.test.ts` golden never has to fork.
3. **Anti-fabrication invariant stated verbatim in the skill body.** ROS-50 / #59 lifted the rule into `SKILL.md`: "If a field cannot be grounded in prose, follow-up Q&A, or documented convention, ASK; do not invent." Without that text, the dialogue would degrade into plausible defaults the user has to scrub by hand — the exact problem the phase was supposed to solve.
4. **Per-file contracts + cross-file invariants are tested separately.** Each invariant (subagents declared in `agent.md` have files; steps in `agent.md` appear in `plans/<plan>.yaml`; every tool has a bindings block; no literal `<placeholder>` strings; slash desc ≤ 80 chars and contains no `<` or `TODO:`) gets its own test in `create-agent.invariants.test.ts`. Five invariants, five tests, one assertion per test. Easy to debug, easy to extend. (ROS-51 + ROS-55.)
5. **Atomic write writes `agent.md` last.** The transaction enumerates every dir/file it creates, writes leaf content first, and writes `agent.md` last so any contract-aware reader observes either no agent or a complete one. On failure (or SIGINT during Steps 4–5), the skill walks the rollback list in reverse and reports residuals explicitly. No "half an agent" state. (ROS-52 / #65.)
6. **`--slash-only` recovery flag for the partial-failure case.** The most likely write failure is a permission error on `.claude/commands/` — agent tree lands, slash command doesn't. `scripts/new-agent.sh --slash-only <function> <agent>` writes only the slash command and refuses to clobber an existing file. Optimizes for the "user has to recover by hand" path. (ROS-53 / #66.)
7. **Golden-snapshot harness is fixture-driven, not LLM-driven.** `test/fixtures/create-agent/` carries canned dialogue transcripts and the expected file tree. Tests assert the rendered tree byte-matches the snapshot. CI never invokes an LLM. Regression-testable. Cheap to run on every PR. (ROS-54 / #72.)
8. **`docs/HOWTO.md` describes the dialogue from the user's perspective, not the skill author's.** ROS-56 / #70 wrote the docs in terms of what the TTY user sees and types, with the `AGENT_TEAM_NO_CONFIRM=1` escape hatch called out before the dialogue walkthrough. Skill-author detail (invariants, rollback semantics) stays in `SKILL.md` and the retro.

## Scope changes vs original phases.yaml

- **ROS-58 landed adjacent to Phase 4 but isn't a P4 task.** Shipping the 10 `chief-of-staff` scripts (`new-agent.sh`, `refine-agent.sh`, etc.) in `templates/scaffold/scripts/` belongs to the v0.4.0 surface but is workspace-substrate rather than skill-authoring. Merged inside the same day (#71) without being back-filled into phases.yaml.
- **CHANGELOG `[Unreleased]` section added.** Original ROS-56 description was README + HOWTO only. Added a `## [Unreleased] — v0.4.0` block in CHANGELOG.md inline because the dialogue mode is a (soft) breaking change for TTY users — the first time they run `/chief-of-staff create-agent` they see a new prompt. Documented as Changed/Breaking in the changelog.
- **Single-day phase.** Original plan had Phase 4 `blocked_by: phase-3` with no time estimate. In practice all 8 tickets opened, implemented, reviewed, and merged on 2026-05-17, ~8 hours wall-clock from the first PR merge (#57 at 13:39Z) to the last (#75 at 21:41Z). Possible because the dialogue contract was already drafted in the brainstorm before the tickets were cut.

## Learnings to harvest

1. **Pre-drafting the contract makes single-day phases possible.** The five-phase dialogue, anti-fabrication rule, atomic-write semantics, and cross-file invariants were specified end-to-end before ROS-49 was opened. Each ticket then encoded one specified piece. Without the up-front specification, the tickets would have rediscovered the design serially over days.
2. **TTY detection + a `NO_CONFIRM` env var is the cheapest non-breaking upgrade pattern.** No flags, no new APIs, no migration. Old scripts work because non-TTY is the floor; new TTY users get the upgrade because TTY is the ceiling. Use this pattern any time you're adding an interactive layer to a previously non-interactive surface.
3. **Anti-fabrication has to be stated in the skill body, not the retro.** LLMs (and humans) default to plausible completion. The rule needs to live where the dialogue runs, in language the skill reads on every fire. ROS-50 lifted the wording verbatim into `SKILL.md` — once the rule was in the prompt the dialogue stopped inventing.
4. **Golden-snapshot fixtures for LLM-mediated flows.** The dialogue is LLM-driven; the test isn't. Canned transcripts in `test/fixtures/create-agent/` + asserting byte-match on the rendered tree gives a regression test that runs in milliseconds and catches drift without needing an API key in CI. Generalize to any skill that produces file output from prose.
5. **Atomic writes must enumerate the transaction up-front.** "Write everything, hope it works, rm -rf if it doesn't" is wrong because the partial state on disk during the write is observable by other tools (Claude Code's CLI, file watchers, the user's IDE). The right pattern is: enumerate, write leaves first, write the "anchor" file (`agent.md`) last, walk the list in reverse on failure. (ROS-52.)
6. **Recovery flags pay off when the failure mode is asymmetric.** Agent tree writes succeed >99% of the time; slash-command writes fail more often (permission errors on `.claude/commands/`). `--slash-only` exists for the asymmetric case. Generalizable: any multi-target write should have a per-target recovery flag, not just an "everything" flag.
7. **Single-day phases are a planning signal, not a stretch goal.** If 8 tickets can land in a day, the design was over-specified at ticket cut and under-specified would have meant more tickets. Both ends are useful — the lesson is that "phase duration" is a downstream consequence of contract clarity, not an estimate to defend.

## What to do differently in Phase 5 (and v0.5+)

1. **`refine-agent.yaml` should reuse the dialogue contract, not fork it.** v0.5+'s "refine an existing agent via dialogue" plan should load the same five-phase dialogue from `SKILL.md` and dispatch on `mode: create | refine` rather than copying the prose. The contract is the asset; the plan is just glue.
2. **Project-instance content generation deserves the same dialogue treatment.** Per-project config (`projects/<name>/config/default.yaml`, brief, etc.) is the next natural place for guided dialogue. Same anti-fabrication invariant, different fixture set. Should be tracked as Phase 5 if it stays a goal.
3. **Multi-agent batch creation is out of scope for v0.5 too.** One agent per invocation is correct — batching tempts the operator to skip the per-agent dialogue, which destroys the value proposition. Keep the constraint.
4. **Treat "single-day phase" as a contract clarity test going forward.** If a phase looks like it'll take a single day, double-check the design is over-specified, not the scope under-specified. Conversely, if a phase keeps slipping, ask whether the contract is clear before adding tickets.
5. **CHANGELOG `[Unreleased]` block should open the day a phase starts.** Phase 4 backfilled the entry; Phase 2.5 and beyond should treat "open `[Unreleased]`" as the first commit of the phase, with entries added as tickets merge. Reduces ship-day documentation panic.
