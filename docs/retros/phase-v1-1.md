# Phase v1-1 — Workspace shape — Retrospective

**Phase milestone:** Phase v1-1 — Workspace shape
**Status at gate:** all 7 gate criteria green; `pnpm typecheck && pnpm build && pnpm test && pnpm smoke && pnpm test:scaffold-scripts` exits 0 on `main` @ `c199638`
**Closed:** 2026-05-21 (started 2026-05-20, ~21 hours wall-clock from PR #150 → #157)
**Linear:** [Phase v1-1 milestone](https://linear.app/firatdogan/project/roster-49d64a75-2e07/milestone/ea6ccc23-e6ae-44e4-ab73-ba1db4588632)

Templates restructured for the v1.0 single-project workspace: `templates/scaffold/projects/` removed entirely, agent templates flattened to `<function>/<agent>/`, identity moved to `config/project.yaml`, cross-agent substrate consolidated under `guidelines/`, `.gitignore` defaults extended for agent-scoped `.env` files, 7 project-management chief-of-staff plans + scripts deleted, remaining 4 plans + 6 scripts reshaped to drop project-dimension handling, `conventions.md` rewritten end-to-end for the v1 model, and `test/smoke.sh` extended with 19 positive v1 assertions (including a recursive `find . -type d -name projects` that locks in the single-project invariant against nested regressions).

## Tasks shipped

| # | Ticket | Title | PR |
|---|---|---|---|
| 1 | ROS-72 (P1-T01) | Remove `projects/` tree and flatten agent templates | [#150](https://github.com/firatcand/roster/pull/150) |
| 2 | ROS-75 (P1-T04) | Update scaffold `.gitignore` defaults (`/.env`, `**/.env`) | [#151](https://github.com/firatcand/roster/pull/151) |
| 3 | ROS-73 (P1-T02) | Add `config/project.yaml` + `guidelines/` seed templates | [#152](https://github.com/firatcand/roster/pull/152) |
| 4 | ROS-76 (P1-T05) | Delete 7 project-management chief-of-staff plans + 7 scripts | [#153](https://github.com/firatcand/roster/pull/153) |
| 5 | ROS-74 (P1-T03) | Rewrite scaffold `conventions.md` for v1 + unit-test cleanup | [#154](https://github.com/firatcand/roster/pull/154) |
| 6 | ROS-77 (P1-T06) | Reshape remaining 4 chief-of-staff plans for v1 flat shape | [#155](https://github.com/firatcand/roster/pull/155) |
| 7 | ROS-78 (P1-T07) | Reshape 6 scaffold scripts (drop project dimension) | [#156](https://github.com/firatcand/roster/pull/156) |
| 8 | ROS-79 (P1-T08) | Smoke + scaffold-scripts v1 positive assertions | [#157](https://github.com/firatcand/roster/pull/157) |

**Numbers:** 8 PRs merged in ~21 hours wall-clock across two parallel `claude` sessions. `pnpm smoke` grew from 65/65 → 88/88 (added 19 positive v1 assertions; Codex review added 4 more). `pnpm test:scaffold-scripts` unchanged at 34/34 (already exercised post-ROS-78 behavior). Unit tests: 815/815. Tarball impact: deferred to Phase v1-4 (`npm pack --dry-run` measured then).

## Gate criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `pnpm smoke` green against a fresh `roster init` | OK (88/88) |
| 2 | `pnpm test:scaffold-scripts` green | OK (34/34) |
| 3 | Zero `projects/` entries anywhere in `templates/scaffold/` | OK (`find templates/scaffold -name projects` → no matches) |
| 4 | `templates/scaffold/chief-of-staff/plans/` contains exactly 4 files | OK (audit-agent, audit-repo, create-agent, create-function) |
| 5 | `templates/scaffold/scripts/` contains zero files matching `*project*` | OK (`ls \| grep -i project` → no matches) |
| 6 | `config/project.yaml` seed exists with `{{PROJECT_NAME}}` placeholder | OK |
| 7 | `guidelines/` seed files present (voice, messaging, brand-book, asset-links, icps/_persona-template) | OK (5/5) |

## Decisions made (and why)

1. **Workspace env at `/.env` (dotenv), not `config/env.yaml`.** BRIEF proposed YAML. Existing `src/lib/doctor-secrets-audit.ts` (checks 11–12) already standardizes on dotenv at workspace root; switching would have rewritten working code for zero user benefit. SPEC §Refinements locks this. Touches Phase v1-2 not v1-1, but the decision shaped the templates: `templates/env.example` unchanged; `templates/scaffold/.gitignore` adds `/.env` + `**/.env`.
2. **`config/` holds only `project.yaml` (identity).** Env is at workspace root next to `CLAUDE.md` (decision 1). `config/project.yaml` is machine-readable, gitignored data; `CLAUDE.md` is the human-facing identity prose. Two files, one role each, no overlap.
3. **Clean break / no migration code.** v0.4 → v1.0 is a semver major. `roster init` in v1.0 hard-rejects on detecting a `projects/` dir (Phase v1-2 / ROS-81). No auto-strip, no warning-only mode. The single known v0.4 install (maintainer's) stays on `0.4.x` until manual re-scaffold. Cheaper to enforce than to support both shapes.
4. **`promotion-arbiter` subagent deleted; `scope:` field removed from lesson frontmatter.** Single playbook per agent (`<agent>/playbook/`). No global-vs-project decision; no arbiter. Implementation lands in Phase v1-3 (ROS-91) but the decision is encoded in `conventions.md` (ROS-74) ahead of the skill rewrite.
5. **Empty string in agent `.env` = explicit unset.** `OPENAI_API_KEY=` in `<agent>/.env` means "do not inherit"; key absent inherits from `/.env`. Distinct semantics for two visually-similar states. SPEC §Flow 2; tested in Phase v1-2 ROS-88.
6. **Workspace-root-relative refs use `/` prefix in `<agent>/config.yaml`.** `/guidelines/voice.md` means "resolve from workspace root", not "literal absolute fs path". The loader strict-rejects refs matching real fs roots (`/Users/`, `/home/`, `/etc/`, `/var/`, `/tmp/`, `/opt/`). Documented in the v1 `conventions.md` (ROS-74); enforced in Phase v1-2 ROS-83.
7. **Subscription-attestation invariant preserved across the schedule schema collapse.** ROS-80 (Phase v1-2) will drop the `project` field from `scheduleEntrySchema` but leaves `subscriptionAttestationSchema` intact — ADR-0001 invariant. No code path in v1 invokes Agent SDK or `claude -p`. v1-1 doesn't change `src/`; the decision is locked in CONTEXT.md §Constraints.
8. **Recursive `find` instead of literal `! -e` for absence assertions in smoke.** Codex review on ROS-79's PR #157 flagged that `! -e projects` only catches the root-level case and misses nested regressions like `gtm/sdr/projects/`. Replaced with `find . -type d -name projects` at workspace root and under the new-agent.sh subtree. Stricter against future regressions.

## Scope changes vs original phases.yaml

- **ROS-76 cleanup gap → bundled fixes in ROS-74 and ROS-79 PRs.** ROS-76 deleted 7 chief-of-staff scripts but did not update the tests that depended on them. Main went red on CI the moment ROS-76 merged (12:59Z). ROS-74's PR #154 picked up the unit-test cleanup (`test/new-project.test.ts` deleted + one stale entry in `test/init.test.ts:105`). ROS-79's PR #157 picked up the smoke cleanup (stripped assertions for 8 deleted scripts; removed the `bash scripts/new-project.sh` end-to-end block). Net: two follow-up commits across two unrelated PRs, with explicit "ROS-76 follow-up" markers in commit messages. Bypassed the alternative of opening a dedicated hotfix ticket because the cleanup was mechanical and tied directly to the v1 surface.
- **ROS-79 grew by 4 assertions after Codex review.** Initial diff was +22 lines. Codex (`/second-opinion`) flagged five gaps: recursive `find` (acted), persona-template seed assertion (acted), post-`--force` re-check (acted), recursive `find` under agent (acted), and `config/project.yaml` content/substitution check (deferred — substitution lands in ROS-81). Final diff +32 lines. Net change to gate state: smoke jumped from 84/84 → 88/88; new assertions ratchet the v1 invariant tighter without churning existing tests.
- **`templates/scaffold/scripts/lib/bindings-prompt.sh` still has a `projects/<inst>/` comment.** ROS-78's grep acceptance was `templates/scaffold/scripts/*.sh`; the `lib/` subdir wasn't in scope. Comment-only, no behavioral impact. Not addressed in v1-1; tracked as a soft followup for Phase v1-4 docs sweep.

## Learnings to harvest

1. **A deletion ticket must own the test cleanup for whatever it deletes.** ROS-76 deleted 7 scripts and a smoke-test that exercised them; the test wasn't in the ticket's acceptance criteria, so it stayed in. Main's CI went red and stayed red until ROS-74 and ROS-79 bundled the fix. Going forward, any ticket whose acceptance includes "delete X" should also include "and update or delete tests in `test/*` that reference X". Cheap to add to the ticket; expensive to discover after merge.
2. **Codex second-opinion is high-leverage on assertion design.** The initial `! -e projects` looked right and passed; Codex caught that it wouldn't catch nested regressions. For test-design questions specifically (recursive vs literal, "absence of empty dir" vs "absence of dir entirely"), the external reviewer flags patterns that look fine to the author. Pattern to keep: run `/second-opinion` on PRs whose primary diff is assertions.
3. **Pre-decomposed phases collapse in hours, not days.** Phase v1-1 had 8 tickets with 1–2 point estimates and concrete acceptance criteria written upfront by `/decompose`. Two parallel sessions ran the work without coordination overhead — the only contention point was test infrastructure shared by ROS-76 and ROS-79, surfaced as the CI-red issue above. Sequential-vs-parallel decomposition is a property of the spec, not the tooling.
4. **`scripts/lib/` is its own audit surface, distinct from `scripts/`.** ROS-78's grep was `scripts/*.sh` (one level). For "no `projects/` anywhere", the assertion needs `scripts/**/*.sh` or two greps. Worth lifting into the standard "v0.4-residue audit" checklist for future cleanup work.

## What to do differently in phase-v1-2

- **Sequence ROS-83 (agent-config-schema) before ROS-87 (doctor check 15).** Phase v1-2 task graph has check 15 (referenced-but-unset across agents) ready to land. If it lands before `<agent>/config.yaml` is reshaped, every existing test agent without a v1 config produces noise. The `phases.yaml` already encodes this dependency; the lesson is to honor it during pickup rather than picking by ID order.
- **Sequence ROS-81 (init substitution) before any smoke assertion that checks `config/project.yaml` content.** ROS-79 deferred the content-substitution check because ROS-81 isn't done. Once ROS-81 ships, smoke needs a follow-up commit to assert the substituted name AND the absence of `{{PROJECT_NAME}}` tokens — mirroring the existing `CLAUDE.md` checks.
- **Don't bundle test-suite cleanup into unrelated tickets again.** ROS-74 and ROS-79 absorbed ROS-76's cleanup gap in-flight. For Phase v1-2, if a similar ROS-76-style deletion-without-test-update happens, open a dedicated hotfix ticket immediately rather than smuggling the fix into the next available PR. The current pattern works but leaves audit confusion: PR #154's diff includes test changes whose Linear ID (ROS-74) doesn't actually own them.
- **Two parallel sessions is the v1-2 model.** ROS-84 is already in flight in the parallel session as Phase v1-1 closes. Phase v1-2 has 9 tickets (ROS-80 through 88) with a denser dependency graph than v1-1; expect ROS-83 → 87 sequencing to matter more than v1-1's near-independence. Keep two sessions, but check `phases.yaml` dependencies before picking the second ticket each cycle.
