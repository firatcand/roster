# Behavior-Preserving Cleanup — Driver Prompt (roster)

> **What this is.** A paste-ready instruction set for driving Claude Code **or** Codex
> through a dead-code-removal + simplification pass on this repo **without changing any
> observable behavior**. Paste the whole file as your first message, then point the agent at
> one unit of work at a time. Tool-agnostic: Claude Code reads `CLAUDE.md`, Codex reads
> `AGENTS.md`, but this prompt is self-contained and assumes neither.
>
> **Status.** v1 — merged from two drafts and reviewed twice by a Codex second opinion (which
> caught a false "zero runtime deps" premise: the package ships five deps, so the invariant is
> *no new deps*, not *no deps*). **Ephemeral / roster-specific.** This file is a working
> instrument for one cleanup campaign; it is **deleted when the campaign ends**. The durable
> record of what the campaign changes lives in Linear + the local `spec/` plan docs
> (BRIEF/PRD/SPEC). Do **not** turn this file into a skill — it is too roster-specific; a
> separate generalized log is kept for that purpose.
>
> **How to read it.** Part I is the contract you must not break. Part II is the workflow you
> run. Part III is the rules each workflow step relies on. Parts IV–VI are checklists, ready
> task prompts, and guardrails. When in doubt, the contract (Part I) wins over everything.

---

# PART I — The contract (what must not change)

## 0. Mission, stated as a contract

You are performing a **refactor**, which has exactly one definition:

> **Behavior in == behavior out.** The program's observable contract is frozen. You may only
> change *how* the code is written, never *what* it does.

The goal is: **same features, same-or-better performance, same-or-better security, fewer lines
of code — where, and only where, it can be done provably safely.** Less code is a *reward*,
never a *target*. A 0-line-saved change you cannot prove is safe is a **failure**; a
5-line-saved change you can prove is safe is a **success**. If you ever find yourself trading
correctness, clarity, or a frozen behavior for a smaller line count, **stop** — that is the
anti-goal.

### The frozen contract — observable behavior, not source bytes

Freeze the program's **observable contract**, not the source text. These are observable;
changing any as a side effect of "cleanup" is a behavior change, out of scope for this pass:

- **CLI surface** — subcommand names, flags, flag aliases, argument shapes, `--help` text, and
  all existing exit codes and exit-code categories (read the current set from the code; don't
  assume it's fixed).
- **stdout/stderr** — wording, ordering, formatting, color, and the machine-readable shapes
  (`--json` output, any parsed line).
- **Files written** — paths, names, contents, atomicity, permissions of anything the CLI
  creates (scaffold tree, schedule specs, YAML upserts, `.env` handling).
- **Shipped template/prompt text** — everything under `templates/`, `skills/`, `agents/`,
  `data/` ships in the npm tarball and is read by downstream agents. Prompt text *is* behavior.
- **Shipped `lib/` symbols** — the package ships the **built** `lib/` (gitignored build output
  of `src/lib/**` — you edit `src/lib/`, the tarball carries `lib/`) with **no `exports` field**
  in `package.json`, so every `lib/**` subpath is a *de-facto* public deep import. Treat
  removing/renaming any `src/lib/` symbol that survives into shipped `lib/` as a breaking
  change.
- **Error semantics** — which inputs throw vs. warn vs. pass, and the error/exit category.

> **Not "byte-for-byte."** Do *not* read "frozen" as byte-for-byte-identical output — that
> produces false alarms on legitimately non-deterministic fields (timestamps, temp paths, PIDs,
> filesystem-read ordering, generated IDs). When comparing old vs new output (§6), **normalize
> those fields** and compare the rest. The contract is *meaning*, not *bytes*.

If a simplification *would* change anything above, it is not in scope. Record it as a follow-up
and move on (§9).

## 1. Non-negotiable invariants (the acceptance gate)

Every change must satisfy **all** of these before commit. This is the literal gate — *run it*,
do not assert it. Whole-repo cleanup, so the scaffold suite is **not** gated behind a path
check:

```bash
pnpm typecheck             # tsc --noEmit, with noUnusedLocals/noUnusedParameters already on
pnpm build                 # tsdown → bin/roster.js
pnpm test                  # node --test, full suite — must stay green AND count must not drop
pnpm smoke                 # bash test/smoke.sh — pack/install/init end-to-end
pnpm test:scaffold-scripts # scaffold-script regression — always run for whole-repo work
npm pack --dry-run         # tarball file count + size must NOT increase
```

Two more are conditional during iteration but **mandatory in the final pre-merge gate**:

```bash
pnpm e2e:schedule   # required when the diff touches schedule-*/codex-*/cron/pending-sync —
                    #   central CLI surface the unit suite + smoke don't fully exercise
pnpm perf           # required when the diff plausibly affects startup/IO; vs SPEC budgets
```

Hard rules on top of the gate:

1. **No *new* runtime dependency; no dependency growth.** The `dependencies` block in
   `package.json` does not grow. It currently holds **five** deps — `@inquirer/prompts`,
   `chalk`, `fs-extra`, `yaml`, `zod` — so this is **not** a zero-dependency package; the
   invariant is *don't add more*, not *have none*. (Dev-deps for detection/verification — e.g.
   `knip` — are allowed, local-only, and must not ship.) Two corollaries:
   - **"SOTA" means idioms and algorithms, not imports** — reach for the modern `node:` stdlib
     and language features, not a new package (see §5).
   - **Prefer the deps already present over hand-rolled equivalents.** `yaml`, `zod`,
     `fs-extra`, `chalk`, and `@inquirer/prompts` are already paid for. Swapping a hand-rolled
     YAML/validation/fs/format snippet for the existing dep is a *legitimate* simplification
     that cuts LOC at **zero** new-dep cost — provided behavior is identical.
2. **Tarball does not grow.** Capture a fresh baseline *before* the change
   (`npm pack --json --dry-run` → record `entryCount` + `size`) and compare *after*. File count
   and bytes hold flat or shrink, never inflate. Do **not** trust a hardcoded number — both
   this playbook's drafts and `CLAUDE.md` have carried stale figures (actual at time of writing:
   **59 files / ~136 KB** packed). The shipped surface is whatever `package.json` `files` lists:
   `bin/ lib/ skills/ agents/ templates/ data/ README.md LICENSE` — note `data/` and `README.md`
   ship (part of the §2 blast radius).
3. **Test count does not drop.** You may add tests; you may not delete one to make a refactor
   "pass." Deleting a test that covered now-deleted dead code is allowed *only* when the
   production code it covered is gone in the same change, you say so, and no still-live path
   loses coverage.
4. **One theme per PR; no unrelated bundling.** Don't mix *unrelated* deletion and
   simplification, or two unrelated simplifications, in one PR. Mechanical deletion a refactor
   *directly causes* (the old code the new code replaces) may ride along — listed separately in
   the PR description. Each PR stays independently revertable.
5. **Branch + PR discipline.** Work in a git worktree on a feature branch; never on `main`; open
   a PR, never auto-merge. With a tracker issue, use `feat/ROS-<id>-<slug>` + a conventional-
   commit subject carrying the `ROS-<id>`. **If no ticket exists**, ask once whether to file one
   — or run **audit-only** (Part II step 1 / Part V prompt 1) with no branch/PR assumptions.

---

# PART II — The workflow (what you run)

Run these in order. Each step leans on a rule in Part III; the `→ §n` pointers say where.

1. **Read project context.** `CLAUDE.md`, `AGENTS.md`, `.forge/CONTEXT.md`, `package.json`,
   `tsconfig.json`, test config, `CRITICAL.md`. Restate the repo's constraints in your own
   words before touching anything. *(→ Part I)*
2. **Build the behavioral-surface map.** Enumerate CLI entrypoints, commands, flags, exit
   codes, stdout/stderr shapes, generated files, shipped templates/prompts (`templates/`,
   `skills/`, `agents/`, `data/`), shipped `lib/` symbols, and test fixtures. Mark which are
   compatibility-sensitive. *(→ §0, §2)*
3. **Find candidates (no editing yet).** Dead exports/imports, duplicate helpers, unreachable
   branches, single-use over-general abstractions, repeated parse/validate logic, avoidable
   filesystem work, security-sensitive shell/path/file handling, tests implying obsolete
   behavior, template code duplicating runtime logic. *(→ §4, §5)*
4. **Rank candidates.** Score each on: confidence it's dead/bloated · compatibility risk · test-
   coverage quality · LOC reduction · perf/security upside · blast radius. Do the high-confidence
   / low-risk / high-payoff ones first. *(→ §2)*
5. **Pin behavior first.** For anything public, generated, or under-tested, write
   characterization tests **before** changing it — and pass the negative-control check. *(→ §3)*
6. **Refactor in thematic batches.** Phase 1 (delete) before Phase 2 (simplify). One theme per
   batch; smallest reversible steps; public behavior unchanged. *(→ §4, §5)*
7. **Verify continuously.** Focused tests after each risky batch; the **full gate** (§1) before
   final. *(→ §1)*
8. **Review as if hostile.** Adversarially diff old vs new behavior, including a real transcript
   diff for CLI-facing changes. *(→ §6)*
9. **Finalize.** Concise report: what was simplified, what was deleted, behavior preserved, tests
   added/updated, verification commands + results, residual risk / what you intentionally left
   alone. *(→ Part IV)*

---

# PART III — The rules (what each step relies on)

## 2. The blast-radius trace (the "ballistic surface" rule)

Before you delete or change **any** symbol, map its full blast radius across the *entire* repo —
not just `src/`. roster has non-obvious consumers a naive "find references" misses.

```bash
# 1. Code references (imports, calls, types) across source AND tests
rg -n --type ts '\b<symbol>\b' src test

# 2. String references across the FULL shipped + doc surface. Prompt text and assets reference
#    code by NAME and by PATH. Shipped dirs per package.json `files`:
#    templates/ skills/ agents/ data/ + README.md (plus bin/ lib/ build output).
rg -n '<symbol-or-path>' templates skills agents data docs README.md *.json *.md

# 2b. Test fixtures, golden files, and shell scripts reference symbols/paths too.
rg -n '<symbol-or-path>' test scripts

# 3. Dynamic / indirect use — dispatch tables, string-keyed maps, argv switch arms,
#    re-exports from the package entry. Grep the bin dispatcher and any index/barrel.
rg -n '<symbol>' src/bin

# 4. The npm files allowlist + metadata that names files (bin, lifecycle scripts).
node -e "const p=require('./package.json');console.log({files:p.files,bin:p.bin,scripts:p.scripts})"
```

Decision rule:
- **Zero references anywhere** (code + string + dynamic) → genuine dead code, eligible for
  deletion in Phase 1.
- **Referenced only by tests** → maybe test-only scaffolding; consider routing the test through
  the public surface instead. Do **not** auto-delete.
- **Referenced by `templates/`/`skills/`/`agents/`/`data/` text** → shipped behavior. Not dead.
- **Any symbol that ends up in shipped `lib/`** → de-facto public API (no `exports` field). Out
  of scope; flag as a separate versioning decision.

`rg` is necessary but not sufficient: it cannot see command names assembled from fragments,
paths built by string concatenation, `lib/**` subpaths imported by downstream consumers, or
package metadata (`bin`, lifecycle scripts) that names files. If a symbol is reachable by any of
those, it is **live**. When in doubt, it is not dead — leave it and move on.

`knip` produces the *candidate* list; this trace *confirms* each. Never delete on knip's word
alone — it can't see string/prompt references and false-positives on public API and test-only
exports.

## 3. Safety protocol — characterization-first (mandatory)

You may not refactor a unit whose current behavior is not pinned by a test. This is the core of
"introduce no bug." For each target:

1. **Measure.** Is the unit's behavior covered? If no test would *fail* when it returns the wrong
   thing, coverage is **absent**.
2. **Pin (separate commit).** Where coverage is absent/thin, write **characterization tests**
   asserting the *current, actual* output for representative + edge inputs (empty, malformed,
   permission-denied, symlink, non-TTY). Run against the **unmodified** code; confirm they pass.
   They encode "what it does today," bugs and all. Commit **before** any refactor, in their own
   commit/PR. They have standalone value.
   - **Negative control (mandatory).** A characterization test is credible only if you can *name
     the behavior change that would make it fail* — state it (e.g. "if this returned `ok` instead
     of `fail` for an unset required var, this breaks"). If you can't name such a mutation, the
     test pins nothing; rewrite it until you can.
3. **Refactor (separate commit).** Change the implementation; the characterization tests + full
   suite are your oracle. If a characterization test now fails, you changed behavior — revert and
   rethink. Do **not** "update the test to match."
4. **Prove.** Run the full §1 gate, then the adversarial pass (§6).

Golden/snapshot tests already exist for some rendered output (`test:update-golden`). For those,
the golden file *is* the characterization test — never regenerate a golden to make a refactor
pass; a golden diff is a behavior change.

## 4. Phase 1 — Delete dead code (first)

Shrink the surface before improving what remains; don't lovingly simplify code that should not
exist.

1. Generate candidates: `npx knip` (unused exports, exported types, files, deps). **`knip` is not
   in `devDependencies`** — `npx` fetches it over the network. Do **not** add it to
   `package.json` without approval; if unavailable (offline/sandboxed), fall back to `rg` import-
   tracing + `tsc` (the `noUnusedLocals`/`noUnusedParameters` gate) and proceed — you lose the
   unused-*export* signal but keep everything else.
2. For **each** candidate, run the §2 blast-radius trace. Keep only true zero-reference ones.
3. Delete in small batches grouped by module. Each batch: removes the symbol + any now-orphaned
   test that *only* covered it (say so); leaves public surface and all template/prompt references
   untouched; passes the full §1 gate.
4. One PR per coherent batch: `chore(cleanup): remove dead <thing> (ROS-<id>)`.
5. Re-run `knip` after each batch — deletions cascade. Loop until dry for that area.

Forbidden in Phase 1: any logic change, any rename of a kept symbol, any "while I'm here" edit.
Deletion only.

## 5. Phase 2 — Simplify what remains (dependency-free)

Only after the area is dead-code-free. Target genuine complexity hotspots (largest / most-branchy
files; confirm with a fresh measure — don't trust a stale list).

1. **Understand before touching.** Read the unit + its tests. State its contract in one paragraph:
   inputs, outputs, side effects, error modes. Can't? You can't safely simplify it.
2. **Diagnose the actual complexity.** Name the smell — duplication, deep nesting, parallel
   arrays that want one struct, a long switch that wants a table, repeated parse/validate logic,
   dead branches. "It's long" is not a diagnosis; 997 lines of 15 genuinely-distinct checks may be
   *irreducible*. Be wary of "rewrite this loop as `map`/`reduce`" — a higher-order rewrite can
   change early-exit, allocation, async ordering, and error order; do it only when it's *clearer*,
   not merely shorter or more fashionable. Only touch what is provably reducible.
3. **SOTA comparison — idioms, not imports.** Look up how this problem is solved well (stdlib
   APIs, the canonical algorithm, a cleaner data model) and reimplement leaner **in-repo, with
   zero new runtime deps**. Prefer the platform: modern `node:` stdlib, `Array`/`Map`/`Set`/
   iterator methods, `structuredClone`, `URL`, `node:path`, `node:fs` promises — zero tarball
   cost. **Also reuse the five deps already shipped** (`yaml`, `zod`, `fs-extra`, `chalk`,
   `@inquirer/prompts`): swapping a hand-rolled equivalent for one cuts LOC with no *new* dep. If
   the cleanest known solution is a *new* library, do **not** add it; record it as a trade-off the
   human decides (§9). Use the **`ctx7` CLI** (`npx ctx7@latest`) to confirm current stdlib/dep
   signatures rather than trusting memory.
   - **For non-trivial Phase-2 refactors, cite 1–3 comparable implementations** from high-quality
     open-source codebases or established security/performance practice. For each: summarize the
     pattern, say why it applies *here*, and state what you deliberately did **not** copy (its
     extra deps, its broader scope). This is the "compare against SOTA" step — borrow the *design*,
     never paste the *code*, never inherit the *deps*.
4. **Make it characterization-safe.** Apply §3 (pin first if not already pinned).
5. **Refactor in the smallest reversible steps.** Each step keeps the gate green. Don't rewrite a
   file; transform it incrementally so each commit is reviewable and bisectable.
6. **Equal-or-better, prove it.**
   - *Quality:* fewer branches / lower nesting, names unchanged-or-clearer, no new public surface.
     The reviewer should find it easier to read, not just shorter.
   - *Performance:* if the unit is hot (startup, large-tree walks, IO loops), run `pnpm perf`
     before/after and show no regression. No accidental O(n²), no extra filesystem passes, no sync
     IO where async existed.
   - *Security:* never weaken input validation, path-containment, shell-escaping, env scoping, or
     atomic-write guarantees for brevity — load-bearing in a CLI that writes files and renders
     cron lines. A CRITICAL.md-path simplification **requires** a second-opinion review (§6).
7. **Adversarial verify (§6), then PR:** `refactor(<area>): simplify <unit> — <-N LOC, behavior
   unchanged> (ROS-<id>)`.

## 6. Adversarial verification (every change)

A change is done when a skeptic fails to break it, not when you believe it's safe. Before opening
each PR, run a pass whose explicit job is to **disprove** behavior-equivalence:

- **Diff real transcripts, not just re-derived contracts (any CLI-facing change).** Build the
  binary before and after; run a fixed corpus of commands in fresh temp dirs, varying args, `cwd`,
  env overrides, stdin, and TTY/color; capture stdout, stderr, exit code, and the created
  filesystem tree; **normalize known-nondeterministic fields** (timestamps, temp paths, PIDs,
  ordering) and diff. A clean diff is the *proof*; re-reading the code is only the *hypothesis*.
- Re-derive the unit's contract from the *new* code and diff against the *old*. Any divergence in
  inputs handled, outputs produced, errors thrown, files written, or ordering is a behavior change
  — even if every test passes (the test may not cover it).
- Hunt what tests don't see: error wording, exit-code category, output ordering, whitespace in
  rendered files, off-by-one on edge inputs, lost handling of empty/missing/symlinked cases.
- For roster, route through the configured second-opinion reviewer (`/second-opinion`, Codex/Gemini
  per `.forge/settings.yaml`) for anything on a CRITICAL.md path, and ideally for every Phase-2 PR.
  The reviewer reads the working tree, so it sees surrounding production code too.

If the skeptic finds a gap, add a characterization test capturing it, confirm it fails on new /
passes on old, then fix the code so both pass.

---

# PART IV — Checklists

## 7. Definition of Done (per PR)

- [ ] Blast-radius trace done; no kept consumer (code, test, template, prompt, `data/`, public
      `lib/`, metadata) broken.
- [ ] Characterization/golden coverage exists for every changed unit, is green, and each test has
      a named negative control.
- [ ] Full gate green: typecheck, build, test (count not dropped), smoke, scaffold-scripts, pack-
      dry-run (size not grown); `e2e:schedule` if scheduling/cron/codex; `perf` if hot-path.
- [ ] No *new* runtime deps; `dependencies` unchanged (existing five may be reused).
- [ ] Package metadata unchanged unless intended: `bin`, `files`, `engines`, and the built
      `bin/roster.js` shebang + exec permission.
- [ ] No frozen-contract change (CLI, output, files, prompts, shipped `lib/`, error modes).
- [ ] One theme; refactor-caused deletion listed separately; independently revertable.
- [ ] Platform-sensitive code (Linux/macOS/Windows, cron vs Desktop branches) reasoned about;
      local-green ≠ all-platform-green — note any branch you could not exercise.
- [ ] Adversarial pass clean (or gaps it found are now tested + fixed).
- [ ] LOC delta reported; quality/perf/security stated as equal-or-better with evidence.

## Review checklist (the hostile-review pass, ordered by what breaks worst first)

**Compatibility** — CLI commands/flags/aliases/defaults/exit-codes/stdout/stderr/file-outputs
unchanged · shipped `lib/` surface unchanged · scaffolded + template output unchanged (modulo
normalized nondeterministic fields) · generated scripts still run.
**Correctness** — removed code has zero remaining code/runtime/template/`data`/metadata/doc
references · refactored logic has equivalent tests · edge cases covered *before* the change ·
error handling no weaker · no user-authored region reverted.
**Security** — path handling still safe · no shell-injection introduced · no unsafe temp-file
behavior · no new secret/env assumptions · file permissions still intentional.
**Performance** — no new repeated filesystem scans · no sync work added to hot paths unless
already idiomatic here · dependency graph not enlarged · smoke/scaffold not slower without reason.
**Maintainability** — LOC reduction *improves* clarity · abstractions justified by repeated
behavior · no compat shims for removed *internal* code · comments only for non-obvious behavior ·
follows existing repo conventions.

---

# PART V — Paste-ready task prompts

**1 · Audit (no editing).**
> Audit this repo for dead code and bloated implementation. Do **not** edit. Produce: (1)
> behavioral-surface map; (2) compatibility-sensitive files; (3) dead-code candidates with
> evidence from the §2 blast-radius trace; (4) simplification candidates ranked by confidence ×
> risk × payoff; (5) tests needed before refactoring; (6) recommended first batch.

**2 · Implement one batch.**
> Implement the first batch. Constraints: preserve the observable CLI contract (§0; normalize
> nondeterministic fields, not byte-for-byte); add characterization tests *first* for any under-
> tested public behavior, each with a named negative control; keep the batch one theme; delete
> dead code only when the §2 trace is conclusive; run focused tests after editing and the full §1
> gate before final.

**3 · Regression-hunt a diff.**
> Review this diff as a regression hunter. Prioritize, severity-ordered, with file:line refs: (1)
> public CLI drift; (2) scaffold/template/`data` output drift; (3) shipped `lib/` breakage; (4)
> missing characterization tests / weak negative controls; (5) security regressions; (6)
> performance regressions; (7) over-abstraction or misleading LOC reduction. Findings first.

**4 · SOTA compare (no rewrite).**
> Compare this implementation against high-quality open-source patterns and secure/performant
> practice. Do **not** rewrite. Return: (1) current-design summary; (2) 1–3 comparable patterns
> from strong projects or established practice; (3) where ours is simpler/better; (4) where ours
> is riskier/bloated; (5) specific refactor opportunities (in-repo, no new deps); (6) compatibility
> risks; (7) a test plan to run before any change.

---

# PART VI — Guardrails

## 8. Anti-patterns — stop if you catch yourself

- Deleting a symbol because `knip` flagged it, without the §2 string/prompt/`data`/metadata trace.
- "Updating the test to match" after a refactor — editing the oracle to hide a behavior change.
- Regenerating a golden file to make a diff pass.
- Adding a dependency to cut lines (or adding `knip` to `package.json` without approval).
- Rewriting a whole file in one commit ("it's cleaner now") — unreviewable, unbisectable.
- Bundling *unrelated* deletion + simplification, or two unrelated simplifications, in one PR.
- Touching a CRITICAL.md path without a second-opinion review.
- Treating a test pass as proof when the public behavior isn't actually covered.
- Changing error text, exit codes, or output ordering as "incidental cleanup."
- Chasing byte-for-byte equality on nondeterministic fields (timestamps, temp paths, ordering).
- Collapsing error handling in a way that changes diagnostics.
- Replacing explicit code with clever abstractions that are harder to audit.
- Optimizing readability of code that is actually dead (do Phase 1 first).
- Claiming a perf or security win without measurement / a named risk reduced.
- Assuming undocumented or platform-specific behavior is unused.
- Reporting "done/verified" without having *run* the gate.

## 9. When to stop and ask the human

- A simplification can only be done by changing the frozen contract (flag as a product decision).
- A "dead" symbol is actually shipped `lib/` / public API (removing it is a breaking change → its
  own versioning decision).
- The cleanest known implementation requires a *new* runtime dependency (human decides the trade-
  off against the no-new-runtime-dependency posture).
- A hotspot's size is *irreducible* (N genuinely-distinct responsibilities) — say so and leave it;
  don't fake a smaller line count by hiding complexity behind indirection.
- Characterization is infeasible for a unit (non-deterministic, environment-bound) — pinning may
  need a test-seam first, which is its own change.
- No tracker issue exists and the work isn't audit-only — ask once whether to file one.

## 10. Suggested first session (smallest viable loop)

1. Run **Part V prompt 1** (audit-only) → ranked candidate list.
2. Pick the **smallest** module with candidates. Run §2 trace on each; delete the confirmed ones;
   gate; open one `chore(cleanup):` PR. Re-run knip until that module is dry.
3. Repeat across modules until Phase 1 is exhausted.
4. Re-measure hotspots (size + branchiness). Pick **one**; run the §5 loop on a single function
   inside it — not the whole file. Open one `refactor():` PR.
5. Review the two PRs together to calibrate the bar, then scale the cadence.

Small, proven, reversible beats a big clever sweep. The win is a codebase that stays the same
product while getting smaller and clearer — measured, not asserted.
