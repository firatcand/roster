# Cleanup Campaign — Log (methodology + execution journal)

> **Purpose.** Two jobs in one file:
> - **Part A — Methodology** is the generalizable record of *how we built and hardened a
>   behavior-preserving cleanup driver*. It is deliberately written to be **roster-agnostic
>   where possible**, so it can later be fed into **forge development** to author a reusable,
>   tool-agnostic cleanup skill for all forge users. The roster-specific driver prompt
>   (`behavior-preserving-cleanup.prompt.md`) is the throwaway instrument; *this* is the keeper.
> - **Part B — Execution journal** is the roster-specific record of what the campaign actually
>   changed, appended per batch. It is the evidence that the methodology works.
>
> **Tracker:** Linear `ROS-116` (umbrella campaign). Durable per-batch record also lives in the
> local `spec/` plan docs. This file is **not** a forge skill and is not shipped.

---

# Part A — Methodology (generalizable → forge skill seed)

## A.1 Problem

A maturing CLI accumulates (a) dead code beyond what `tsc --noUnusedLocals/Parameters` catches,
and (b) bloated, hard-to-change hotspots. The owner wants to reduce both **without changing any
observable behavior**, with no new runtime dependencies, equal-or-better perf/security, and
fewer LOC only where provably safe. The naive approach ("ask an agent to simplify the code")
fails: agents silently change CLI output, scaffolded files, shipped prompt text, exit codes, or
package surface, and call it cleanup. The deliverable was therefore not a refactor but an
**instrument**: a driver prompt that constrains an agent to *provably* behavior-preserving work.

## A.2 How the instrument was produced (the process worth reusing)

1. **Scope before drafting (4 decisions).** We pinned: (i) the safety oracle —
   *characterization-tests-first*; (ii) the meaning of "SOTA" under a no-new-deps rule —
   *idioms/algorithms, not imports*; (iii) delivery — *standalone prompt doc first, skill
   later/never*; (iv) sequencing — *delete dead code, then simplify*. Each decision materially
   changed the doc; none were defaulted.
2. **Draft v0.** Wrote the contract, the gate, a blast-radius trace, characterization-first,
   delete-then-simplify, adversarial verification.
3. **Adversarial second opinion on the instrument itself (round 1).** Ran the project's
   configured second-opinion reviewer (Codex) **against the draft prompt**, not against code.
   It caught a **factual error in the premise**: the draft claimed a "zero runtime dependency
   posture"; the package actually ships five runtime deps. It also caught a shipped directory
   (`data/`) omitted from the blast-radius scan, a stale tarball figure, and an over-strict
   "byte-for-byte" framing.
4. **Verify the reviewer's claims before trusting them.** We did not relay the review blindly —
   we ran `node -e` against `package.json` to confirm the five deps and the `files` allowlist,
   and `npm pack --json` for the real tarball size. The reviewer was right; the fix was applied
   from verified facts, not from the review's say-so.
5. **Round 2.** A second Codex pass produced eight line-level corrections (don't hardcode exit
   codes; distinguish `src/lib` source from shipped `lib/` build output; make the scaffold suite
   unconditional; relax PR-atomicity to "no *unrelated* bundling"; add a no-ticket fallback;
   note `knip` isn't a devDep and needs network; use the repo's real docs CLI not a possibly-
   absent skill; fix a lingering stale phrase) plus one conceptual add (cite 1–3 real OSS
   implementations for non-trivial refactors). All verified and applied.
6. **Merge operational spine + safety core.** A parallel Codex-authored "master system prompt"
   contributed a strong **operational spine** (a 9-step workflow, four paste-ready task prompts,
   a severity-ordered review checklist). We merged that spine around our **safety core**
   (frozen-contract definition, blast-radius trace, characterization + negative-control,
   dependency-reuse lever, transcript-diff verification), reconciling the one conflict
   (byte-for-byte → observable-contract).

## A.3 Distilled principles (these generalize to any codebase)

1. **A refactor freezes the *observable contract*, not source bytes.** Enumerate the contract
   explicitly (CLI surface, stdout/stderr shapes, files written, error semantics, shipped
   assets, public API). Normalize known-nondeterministic fields (timestamps, temp paths, PIDs,
   ordering) when comparing — chasing byte-for-byte equality produces false alarms.
2. **Less code is a reward, never a target.** A safe 5-line win beats an unprovable 50-line win.
3. **Characterization-first, with a negative control.** Pin current behavior in tests *before*
   touching code; a characterization test is only credible if you can name the mutation that
   would make it fail.
4. **Blast-radius trace beyond source.** Dead-code tools see unused *exports*; they cannot see
   references in shipped prompt text, generated assets, string-built paths, dispatch tables, or
   package metadata. Confirm every candidate across the *full shipped surface*, not just `src/`.
5. **"SOTA" = idioms/algorithms, not imports.** Reach for the stdlib and language features, and
   **reuse dependencies already present**, before ever adding one. Adding a dependency to cut
   lines is almost always a bad trade for a published artifact. For non-trivial work, cite real
   high-quality implementations as design references — borrow the *pattern*, not the *code* or
   the *deps*.
6. **Delete then simplify.** Don't refactor code that should be deleted.
7. **One theme per change; adversarially verify each.** A change is done when a skeptic fails to
   break it (ideally a real before/after transcript+filesystem diff), not when the author
   believes it's safe.
8. **Adversarially review the *instrument*, and verify the reviewer.** The highest-leverage move
   here was second-opinion-reviewing the prompt itself and then fact-checking the reviewer. Both
   halves mattered: the review caught a false premise; the verification kept us from trusting a
   review uncritically.
9. **Establish a gate's baseline-green before trusting it.** A gate command that isn't wired into
   CI will rot silently. In batch 1, `e2e:schedule` was red *before* our change (a test still
   passing a long-removed flag). Had we trusted the gate blindly, we'd have mis-attributed the
   failure to our diff. Rule: when a required gate fails, run it on the *unchanged* baseline first;
   only a failure that is *new under your diff* is yours. (Iron Law of Investigation, applied to
   tooling.)
10. **Measure the LOC/artifact delta before committing to a refactor's *scope*.** Extracting a
    shared helper for a *single* function is frequently LOC- *and* artifact-*negative*: the helper's
    definitional overhead exceeds the savings until it's reused across the whole family. In Phase-2
    batch 1, helpers for one `render*` function added +23 LOC / +112 tarball bytes despite
    provably-identical behavior. The "tarball does not grow" gate caught it. Corollary: a
    behavior-preserving *simplification* must still *shrink* (or hold) LOC/artifact — if it grows
    them, the scope is wrong, not the idea. Bank the characterization pin (always positive) and
    re-scope the cut to where the helper amortizes.
11. **Big ≠ bloated; find duplication with a clone detector, not by eyeballing file size.** The
    obvious target (doctor.ts, 997 LOC) turned out *irreducible* — 10 genuinely-distinct render
    sections; its internal "duplication" was inline-within-lines (consolidating shortens lines,
    doesn't remove them). The *real* reducible duplication was **cross-file copy-paste of pure
    helpers** that a size scan never surfaces. `jscpd` (a clone detector) found it objectively: 22
    clones / 284 lines — e.g. `listFunctionDirs` duplicated verbatim across `schedule-list.ts` and
    `schedule-resolve.ts`. Lesson: target *duplication*, measured, not *size*, eyeballed.

## A.4 Generalizable vs roster-specific (for the future forge skill author)

| Generalizable (keep in the skill) | roster-specific (parameterize or drop) |
|---|---|
| Observable-contract framing; normalize-nondeterminism | The exact gate commands (`pnpm smoke`, `test:scaffold-scripts`, `e2e:schedule`, `perf`) |
| Characterization-first + named negative control | The five specific deps; the `~136 KB / 59 files` tarball budget |
| Blast-radius trace across the *shipped* surface | The exact shipped dirs (`templates/ skills/ agents/ data/`) and "prompt text is behavior" |
| Delete-then-simplify; one-theme PRs | `src/lib`→shipped-`lib/` build mapping; no-`exports`-field note |
| "SOTA = idioms not imports"; reuse-existing-deps lever | `ctx7` CLI, `knip` availability, `.forge/settings.yaml` reviewer routing |
| Adversarial verify; transcript+fs diff | Linear `ROS-*` branch/PR conventions; worktree rules |
| Second-opinion-on-the-instrument + verify-the-reviewer | — |

A forge skill should: detect the project's gate from `package.json`/CI; read the shipped surface
from the packager's allowlist (npm `files`, or language equivalent); read the existing
dependency set; and let the host's configured reviewer drive the adversarial pass. The *shape*
(contract → trace → pin → delete → simplify → verify) is constant; the *bindings* are per-repo.

---

# Part B — Execution journal (roster campaign — append per batch)

Format per batch: phase · PR · what was deleted/simplified · LOC delta · tarball delta · gate
result · surprises.

_(no batches yet — campaign not started. First action: run the audit-only prompt, Part V of the
driver, to produce the ranked candidate list.)_

| # | Phase | PR | Change | LOC Δ | Tarball Δ | Gate | Notes |
|---|-------|----|--------|-------|-----------|------|-------|
| 0 | setup | #210 | playbook instrument committed + ROS-116 filed | — | — | — | log seeded |
| 1 | P1 | #212 (ROS-117) | prune 62 unused exports: 7 delete + 56 de-export | −43 | **0 (byte-identical)** | typecheck/build/991 test/94 smoke/34 scaffold/knip-clean ✓ | findings below |
| 2 | P2 | #216 (ROS-119) | characterize renderSecretsSection (7 tests + export); **simplification deferred to ROS-120** | +2 (tests) | **0 (flat)** | typecheck/build/998 test ✓ | refactor reverted — grew artifact at single-fn scope (see A.3 §10) |
| 3 | P2 | — (ROS-120) | family-wide render* helper extraction — **investigated, CANCELLED** | — | — | — | doctor.ts irreducible (see A.3 §11); pivoted to clone-detector scouting |
| — | scout | — | `jscpd` src/ → 22 clones / 284 dup lines; validated `listFunctionDirs` dup across schedule-list/resolve as the next target | — | — | — | real cross-file duplication, unlike doctor.ts |
| 4 | P2 | #219 (ROS-121) | consolidate duplicated schedule-read helpers → `schedule-read.ts` (listFunctionDirs + readScheduleEntries) | **−25** | **−20 B** | typecheck/build/1007 test(+9)/94 smoke/34 scaffold/19 e2e/knip-clean ✓ | first Phase-2 cut that LANDED — clone-detector target, not eyeballed |

**Phase-2 takeaway (so far):** the eyeballed "big file" (doctor.ts) was irreducible; the clone-detector target (schedule-read dup) was the real, clean win (−25 LOC, −20 B, behavior-pinned). The `readScheduleEntries(…, warnings?)` pattern — an *optional collector param* — is the clean way to unify two functions that differ only in whether they report vs. swallow problems, without changing either caller's behavior.

| 5 | P2 | — (ROS-122) | consolidate --scope/--tool arg-parse clone — **investigated, REVERTED** | — | — | — | grew artifact at every scope (see A.3 §12); Codex-reviewed |
| 6 | P2 | #222 (ROS-123) | consolidate 3× schedules-loading loop → `loadSchedules(cwd,{sort?,filter?})` | **−66** | **+30 B** ⚠️ | typecheck/build/1012 test(+5)/94 smoke/34 scaffold/19 e2e/knip-clean ✓ | large 3→1 dedup; +30B = approved rule exception (see A.3 §13) |

13. **"No artifact growth" means no *meaningful* growth — set a threshold, don't optimize the letter against the intent.** ROS-123 was a real 3→1 dedup (−66 LOC, behavior-pinned) that grew the bundle **+30 B (0.02%)**. The strict rule (§1.2) said revert; the rule's *purpose* is preventing meaningful bloat, and 30 B isn't. Reverting a 66-line maintainability win over 30 bytes would be cargo-culting the gate. Contrast ROS-122 (−0 LOC / +165 B → correctly reverted): the test isn't "did a byte change?" but "is the artifact cost meaningful *relative to* the source/maintainability win?". Refined rule for the skill: **flag any growth; auto-pass when growth is <~0.1% AND source LOC drops materially; escalate to a human/second-opinion otherwise.** Always surface the number and make it an explicit, recorded decision (not a silent override).

12. **A detected clone's line-count is not its consolidation *savings*; small clones often can't beat inline.** `jscpd` flagged ~31 lines of `--scope` arg-parse duplication across two parsers. Two extractions — an object-union matcher (×2 sites) and a Codex-suggested generic `matchValueFlag` + tuple returns (×3 sites, incl `--tool`) — **both grew the bundle** (+126 B, then +165 B) despite provably-identical behavior. Why: the blocks are small (~15 lines) and *control-flow-entangled* (in-loop `i++` + early-return), so inline string comparisons compile more compactly than a function call + call-site adaptation + return-value allocation. The second opinion (Codex) set the exit condition — "revert if the broader matcher can't demonstrate non-growth" — and the remeasure made the call. Corollary to §10/§11: consolidate clones only when they're *large* or *self-contained* (like the schedule-read helpers, −25 LOC); for small entangled ones, leave the duplication and move on. Always remeasure after each attempt; don't trust the *prediction* that "generalizing will shrink it."

### Batch-1 findings (worth carrying into the skill / future batches)

- **Tree-shaking makes "shipped" ≠ "in source."** roster bundles everything into one
  `bin/roster.js`; `lib/` ships only a `.gitkeep`. So (a) deleting tree-shaken dead source yields
  a **byte-identical** shipped artifact — the strongest behavior-preservation proof — and (b) the
  playbook's "shipped `lib/**` is de-facto public API" caution is **moot for roster specifically**
  (nothing is deep-importable). *Generalization:* read the *packager's* real output, not the file
  allowlist, to know what actually ships.
- **"Unused export" splits three ways, and the right fix differs.** Of 62: 7 truly-dead (delete),
  55→56 used-locally-but-over-exported (drop `export`, don't delete), 0 string-referenced. A naive
  "delete what knip flags" would have destroyed 56 live symbols. The local-usage check is the
  load-bearing discriminator.
- **Deletes cascade; let `noUnusedLocals` + `knip` drive the closure.** The 7 deletes orphaned 6
  imports + 2 types + 1 more export (`ScheduleInstallCmd`) across two `knip` rounds. Loop the
  delete→typecheck→knip cycle until dry, rather than predicting the full closure up front.
- **A gate that isn't in CI rots.** `e2e:schedule` was red at baseline (`--project` removed in
  v1.0; test never updated). Filed as ROS-118. See A.3 principle 9.

---

# Campaign close-out (ROS-116)

Wound down after the productive targets were exhausted. Final tally:

| Outcome | Batches | Net |
|---|---|---|
| **Shipped** | ROS-117 (62 unused exports), ROS-118 (e2e unrot + CI), ROS-119 (secrets characterization pin), ROS-121 (schedule-read dedup), ROS-123 (loadSchedules 3→1 dedup) | **~−134 source LOC**, +21 characterization tests, 1 rotted test fixed + CI-guarded |
| **Investigated → won't-do** | ROS-120 (doctor.ts irreducible), ROS-122 (arg-clone grows artifact) | correctly *not* shipped |

Tarball net across the campaign: roughly flat (byte-identical / −20 B / +30 B across the cuts) — no meaningful bloat.

**Why we stopped:** the remaining `jscpd` clones are all small (`schedule-args` ~40 across 3 fragments, `pending-sync≈pending` ~11, `hook-install≈tools` ~8). Per §A.3 §12, small/control-flow-entangled clones reliably grow the artifact when extracted, so they're below the worthwhile threshold. The genuine wins (Phase-1 dead-code + the two *large* clone consolidations) are banked.

**The reusable distillation** for forge lives in Part A (methodology) + the 13 principles in §A.3 — that is the seed for a generic, tool-agnostic cleanup skill. The roster-specific driver prompt (`behavior-preserving-cleanup.prompt.md`) is deleted in the wind-down PR; this log persists.
