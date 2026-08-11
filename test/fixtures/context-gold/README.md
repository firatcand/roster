# Context-quality gold set (#371)

Sanitized, synthetic gold tasks for the **bundle-level** runtime context quality
evaluation. The retrieval-layer gold sets live in `test/fixtures/retrieval-gold/`
(#353); this directory owns the fixtures for the FULL `roster context` bundle: the
seventeen gold tasks (`tasks.json`), the brain-tier corpus seeds
(`brain-seeds.json`), and the FROZEN eager-load baseline (`eager-baseline.json`).
The workspace the tasks run against is the checked-in
`test/fixtures/context-gold-workspace/`.

Loaded, validated, and linted by `test/support/context-gold.ts`; executed by the one
shared runner `test/support/context-eval-runner.ts` (used by both
`test/context-quality.test.ts` and `scripts/context-eval-report.ts`). The hermetic
structural suite is `test/context-gold-set.test.ts`.

## The fixture workspace

`context-gold-workspace` is a synthetic company ("Vantmoor Analytics", fictional)
with two functions and three agents:

- `gtm/social-manager` — the representative bounded target. The closure of
  `gtm/social-manager#opportunity-discovery` (root plan + nested `scan-linkedin` +
  `scan-web`, two guidelines, four closure-eligible lessons, two tool-uses with
  distinct host-native skill refs) is what a correct bundle contains. Its sibling
  plans (`sibling-review`, `weekly-recap`, `competitor-watch`, `listening-report`),
  sibling-scoped lessons, a body-identical duplicate lesson pair, and its
  non-default non-referenced guidelines are eager volume a correct bundle excludes.
- `gtm/content-writer` — the intra-function distractor agent (and the sparse
  empty-vendor-projection target via `#draft-posts`).
- `ops/vendor-support` — a whole second function of pure distractor volume, and the
  brain-tier missing-required-selector target via `#ticket-triage`.

Registry variants: `roster.yaml` (no `brain` block — the local tier) and
`roster.brain.yaml` (byte-wise the same registry plus a complete `brain` block that
exercises the registry defaults: no `endpoint`, defaulted `force_path_style`). The
`partial` variant is DERIVED by `_setup.ts` from `roster.brain.yaml` by dropping the
`storage` block — the half-declared Brain whose closed
`BRAIN_CONFIGURATION_INCOMPLETE` failure envelope task L10 pins. A hermetic test
proves the two checked-in registries parse identically except `brain`.

## Task schema (`tasks.json`, `schemaVersion: 1`)

```
{ schemaVersion, workspaceFixture, identities: { workspaceIds },
  tasks: [ { id, tier: local|brain,
             family: recall|exclusion|budget|coverage|contract,
             target: "<fn>/<agent>" | "<fn>/<agent>#<plan>",
             query, stepHint?, budgetTokens?,        // default 12000
             explain?,                               // default true
             includeLegacyUnverified?,
             registryVariant?: local|brain|partial,  // defaults from tier
             mandatory: [ { kind, ref | anyOf: [...], inclusionReason } ],
             forbidden:  [ { kind, ref, rationale, expect } ],
             budgetExpect?, diagnosticsExpect?, notes } ] }
```

**Mandatory refs** are fixture-stable: qualified ids for local kinds; the effective
tool id for `tool-use` (matched on the `tool-use:<id>:` prefix — the semantic hash
is derived, never authored); the canonical `skill_ref` for `skill-ref`; the seed
`stableKey` for `brain-evidence`. A mandatory entry carries EXACTLY ONE of `ref` or
`anyOf`; `anyOf` means at least one member present with the declared inclusion
reason (task L11 exercises the semantic under a budget that admits exactly one
member, and matcher unit tests pin one-present/none-present/both-present).

**Forbidden rationales are the evaluator's own closed vocabulary**, kept explicitly
separate from product explanations:

| rationale | expect | who explains |
|---|---|---|
| `outside-closure` | `"not-selectable"` | the EVALUATOR asserts structural absence; Roster emits no diagnostic for never-selectable artifacts and none is invented |
| `product-diagnostic` | `{ diagnostic, reason }` | the product's closed surfaces (`CONTEXT_LESSON_EXCLUDED` with `scope-ineligible`/`duplicate`, `CONTEXT_EVIDENCE_EXCLUDED` with a closed exclusion reason) |
| `prefiltered` | `{ filtered: reason }` | the product's `CONTEXT_EVIDENCE_FILTERED` echo + the `evidence_prefiltered` counter, reason ∈ the closed retrieval-filter vocabulary |

Product explanations exist for every INCLUSION (the closed thirteen-entry
explanations table, pinned verbatim by the runner) and every product-SURFACED
exclusion. Structural non-selectability and unnamed budget-omitted lessons
(`lessons_budget_exhausted` is a counter, not a list) are evaluator-documented —
the report labels the two provenances distinctly.

## Brain seeds (`brain-seeds.json`)

Two-level identity, exactly like the retrieval gold set: each seed's `stableKey`
names the logical source and every revision carries a REQUIRED `fixtureVersionKey`.
The runner records `(stableKey, fixtureVersionKey) → {sourceVersionId, chunkIds}` at
ingest and keys every assertion and manifest row on the fixture-stable keys, never
on minted ids — which is what makes the independent-rebuild comparison exact with no
id-exclusion projection. Ingestion happens in fixture order; `finalDisposition:
tombstoned` applies a tombstone after the last revision; ordered `revisions` imply
supersession.

Seed bodies carry the authored selector description phrases VERBATIM (the #355
membership-predicate discipline): retrieval's membership predicate is built from the
authored selector and its descriptions, so a body enters the pre-candidate pool —
and therefore the accounting — only by satisfying it through the real catalog. The
`gold-bulk-archive` seed is deliberately large and deliberately last in the
deterministic candidate ordering (zero query-term overlap), so the B4 budget window
can exclude it while every diagnostic still fits.

Expected filter accounting is DERIVED from the seeds, never restated: non-final
revisions are `superseded`; a tombstoned final revision is `tombstoned`; a
secret-privacy final revision is `privacy-incompatible`; a legacy-unverified final
revision without the opt-in is `legacy-unverified`; counts are the recorded chunk
counts. The runner asserts the echo breakdown equals the derivation exactly AND
`evidence_prefiltered` equals the breakdown sum (the #355 pairing rule).

## The frozen eager baseline (`eager-baseline.json`)

**Unit:** the product's own estimator, `ceil(utf8_bytes / 4)`
(`CONTEXT_ESTIMATOR = utf8-bytes-ceil-div-4/context-canonical-json-v1`). It is a
pure byte function of checked-in UTF-8 content — no tokenizer version, no platform
variance — and it is the unit the release criterion's budget block already reports.
The bundle side is measured over canonical-JSON-escaped content; escaping inflates
the bundle and never the baseline, so the gate is conservative.

**Composition rule (A4):** the denominator is exactly the authored instruction bytes
under `functions/**` and `tools/**` (playbooks included) — nothing else. `ROSTER.md`
is shared activation bytes both the eager and the bounded host read, so it cancels
and appears on neither side. `roster.yaml`/`roster.brain.yaml` are registry
configuration and `_setup.ts` is harness code; excluding them SHRINKS the baseline,
hardening the gate. The rule is recorded in the file's own `composition` field and
enforced by the hermetic recompute test, so the reviewed rule — not authoring
discretion — defines the denominator. `totals.tokens` uses ceil-of-sum
(≤ sum-of-ceils — again conservative).

**Freeze mechanism:** the hermetic suite recomputes the ENTIRE structure from the
checked-in fixture and asserts deep-equality, reporting the recomputed totals on a
mismatch. The baseline never drifts silently; an intentional fixture edit is a
reviewed two-file change (edit the fixture, run `test/context-gold-set.test.ts`,
regenerate via `computeEagerBaseline`).

**Per-task gate (never aggregate):** for every ratio-gated task whose
recall/exclusion/accounting gates passed,
`max(budget.total_tokens, ceil(stdout_bytes/4)) ≤ 0.40 × totals.tokens`. Reduction
is computed only after recall passes, so "without required-context loss" is
structural: a task that lost required context fails before its ratio is read. Ratio
gates apply to L1–L6, L9 and B6 only; B1–B5 keep recall/exclusion/citation/
accounting gates without ratio gates (evidence volume and authored-tree volume must
not be conflated). Brain-tier B6 gates against the SAME frozen baseline: an eager
loader injects the authored tree, and evidence is additional bundle weight the
bounded bundle must still beat.

**On gaming:** the fixture and the baseline are co-authored — any synthetic
benchmark is. The defenses are the reviewed composition rule, the per-task margin
reporting in the manifest, and the recall gate: the bundle cannot be starved to
inflate reduction, because starving it loses a mandatory fragment first. The
representativeness argument is structural, not padding: two functions and three
agents of comparable authored weight, where exactly one closure loads (PRD.md's
"large eager instruction trees" shape).

## Cross-host semantic equivalence (the definition, verbatim)

Claude Code and Codex receive semantically equivalent bundles because they receive
the IDENTICAL bundle. `roster context` admits **no per-invocation current-host
selector** (no `--host` flag — pinned by a test asserting `parseContextArgs`
rejects `--host` specifically, not by freezing the whole flag vocabulary);
host-shaped input exists only at the workspace level (`roster.yaml#hosts`), and the
fixture pins BOTH hosts enabled, so every bundle is composed under dual-host
configuration. Host variation is confined to (i) activation framing outside the
bundle and (ii) the per-host locator entries inside each `skill-ref` fragment,
generated from ONE canonical `skill_ref`. Three proofs:

1. **Structural (hermetic):** for every skill-ref fragment in every gold bundle,
   `content.hosts` has exactly the keys `{claude, codex}` and the two locators are
   deep-equal `host-native` entries. The fixture uses host-native skill refs ONLY:
   project-materialized locators carry per-host independently-reviewed
   `content_hash` values and NO cross-host equality is claimed for them — their
   cross-host semantics are a #368-adjacent policy question, not a #371 gate.
2. **Empirical (both tiers):** every gold task runs under host-shaped environment
   deltas (`CLAUDECODE=1, TZ=UTC, LANG=C` vs `CODEX_HOME=<tmp>, TZ=Asia/Tokyo,
   LANG=en_US.UTF-8`; `ROSTER_*` held constant) — stdout byte-identical, alongside
   the same-environment double-invocation determinism gate.
3. **Activation parity (hermetic):** the Claude and Codex project-instruction
   bodies parse (via `parseGeneratedMarkdown`) to one bootstrap body modulo the
   host display name; the Codex skill shares that body with its frontmatter
   surfacing as the parse's `prefix`, asserted separately and excluded from body
   parity. All route the host to the ONE generated `ROSTER.md`.

Explanation stability is asserted PER TIER against one canonical mapping table for
every inclusion reason observed in that tier; local-tier reasons are a strict subset
(`selector-match`/`required-selector-match` are Brain-only), the brain tier asserts
both appear, and cross-tier SET identity is deliberately not asserted.

## Privacy contract

Everything here is synthetic: fictional company, fictional vendors, fictional
domains.

### Invented-name audit

Round-1 review found that an earlier vendor name (`ledgerdesk`) collided with a
real software/services business, falsifying the synthetic-only claim. Every
invented proper name in the fixture was then audited against the live web and
replaced where any real-world business or claimed product surfaced — including
near-collisions and crowded namespaces. The verdicts:

| name | role | audit verdict |
|---|---|---|
| `Vantmoor Analytics` | the fictional company | no real-world match found (replaced `Harborlight Analytics`, a near-collision with a real analytics consultancy and several "Harbor Light" technology businesses) |
| `finchglass` (`finchglass:search`) | search vendor | no real-world match found (replaced `harborline`, a real lending platform / PE firm / trading business) |
| `spilloak` (`spilloak:queue`) | staging-queue vendor | no real-world match found (replaced `beacon-post`, a real UK delivery business) |
| `quartzharbor-desk` (`quartzharbor-desk:tickets`) | ticket-archive vendor | no real-world match found (replaced `ledgerdesk`, a real software/services business) |
| `wrenlatch-crawl` (`wrenlatch-crawl:extract`) | catalog-only crawler vendor | no real-world match found (replaced `atlas-crawl`; no exact match existed, but the Atlas namespace is crowded with real crawler products — the tool id also renamed to the descriptive `site-crawl`) |

Candidate names that DID surface anywhere were rejected during the audit (for
example `mothgrid`, which belongs to a published fictional universe). Any future
invented name added to this fixture carries the same obligation: search first,
record the verdict here, and prefer improbable compounds over plausible ones.
The audit is point-in-time; a collision that emerges later is treated like any
other privacy finding — rename, regenerate the baseline, and update this table. The only workspace-shaped identifier is `context-gold-workspace`,
allowlisted in `test/support/context-gold.ts` (the allowlist lives with the harness,
not in the fixture, so a leaked identity cannot bless itself). No real hostnames,
emails, filesystem paths, or credentials anywhere.

The hermetic privacy lint (`lintContextGoldArtifacts`) runs the #353 rule engine —
extracted behavior-preserving into `test/support/privacy-lint.ts` — over exactly
three directories: this one, `test/fixtures/context-gold-workspace/`, and
`docs/evals/context-quality/`. Four-layer honesty statement: (1) the rules are
deterministic and closed, (2) inside JSON the digest exemption is POINTER-scoped —
a digest-shaped token at an undeclared position is reported, (3) outside JSON there
is no schema position to key an exemption on, so a shape-valid digest is exempted by
SHAPE alone (the one place the exemption is weaker), and (4) bare-hostname detection
uses a CLOSED TLD list because the scanned artifacts legitimately contain file paths
and identifiers a general dotted-token rule cannot tell apart from hostnames — the
URL and email rules stay TLD-independent. The boundaries are pinned by tests in
`test/context-gold-set.test.ts` and `test/retrieval-gold-set.test.ts`.

**Pre-PR secret scan** (documented step, not a CI job):

```
gitleaks detect --no-git --source test/fixtures/context-gold
gitleaks detect --no-git --source test/fixtures/context-gold-workspace
gitleaks detect --no-git --source docs/evals/context-quality
```

## Ownership boundary

| concern | owner |
|---|---|
| retrieval-layer recall/exclusion/citation/determinism, capability dispositions | #353 (`docs/evals/retrieval-quality/`) |
| bundle-level recall, exclusion, citation, determinism, cross-host equivalence, ≥ 60 % reduction | **#371 (here)** |
| local assembly latency (500 ms) | `test/context.benchmark.ts` (#355) |
| representative workflow execution (consumes this gate) | #360 / P2-T12 |
| final capability keep/defer/remove decisions | #368 |

## Reproduction

```
pnpm test                        # hermetic suite + local tier
ROSTER_BRAIN_ADMIN_URL=<throwaway admin url> pnpm test   # + brain tier
pnpm eval:context                # dated report (add the env for the brain tier)
```

### Editing the fixture

The eager baseline and the per-task budget expectations are **verified, not
trusted**: edit the workspace or the tasks, run `test/context-gold-set.test.ts` and
`test/context-quality.test.ts`, and copy the reported recomputed values back. The
L6/L11/B4 budgets are authored against the measured admission boundaries and fail
loudly (with observed values in the failure detail) when a fixture edit moves them.
