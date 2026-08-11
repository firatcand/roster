# Runtime context quality evaluation

Dated results of the bundle-level context-quality evaluation (#371), following the
`docs/evals/retrieval-quality/` convention: this README describes the method; each
run adds a pair of dated files named `YYYY-MM-DD.json` (the schema-versioned
machine-readable manifest — the diffable ground truth) and `YYYY-MM-DD.md` (prose
and tables, **generated from that manifest**).

The gold tasks, brain seeds, and the FROZEN eager baseline live in
`test/fixtures/context-gold/` with their own README describing the task schema, the
privacy contract, the equivalence and token-measurement definitions, and the
authoring invariants. The fixture workspace is
`test/fixtures/context-gold-workspace/`.

## What this evaluation covers

`spec/CONTEXT.md`'s release gate reads: "Context quality passes required recall,
exclusion, citation, determinism, and at least 60 percent token reduction." That
sentence spans two tasks and this one owns the bundle-level half.

| Clause | Owner |
|---|---|
| recall, exclusion, citation, determinism **at the retrieval layer** | #353 (`docs/evals/retrieval-quality/`) |
| bundle-level mandatory fragment recall, explicit exclusion, citation, determinism | **#371 (here)** |
| cross-host semantic equivalence with stable explanations | **#371 (here)** |
| **≥ 60 % token reduction** vs the frozen eager-load baseline | **#371 (here)** |
| local-only vs Brain-configured comparison | **#371 (here)** |
| representative workflow execution (consumes this gate) | #360 (P2-T12) |
| final capability keep / defer / remove **decisions** | #368 |

**Failures block the representative workflow proof:** `plans/phases.yaml` makes
P2-T12 depend on P2-T11, the suite lives inside plain `pnpm test` → CI → the phase
gate, and the report's Targeted corrections section names the failing task, the
lost property, and the closed reason — never an aggregate.

## Method

One shared runner (`test/support/context-eval-runner.ts`) is called by **both** the
gold-set suite (`test/context-quality.test.ts`) and the report script
(`scripts/context-eval-report.ts`), so the execution logic exists exactly once. Per
tier it: materializes the checked-in fixture workspace per registry variant, (brain
tier) derives the Brain identity from the materialized `roster.yaml` through the
production parse and seeds a throwaway corpus keyed by fixture-stable
`(stableKey, fixtureVersionKey)` identity, then spawns
`node --experimental-strip-types src/bin/roster.ts context …` per gold task — the
production surface both hosts invoke: argument parsing, exit codes, single-line
JSON — evaluates the per-task gates, and composes the tier result.

### Two tiers

| tier | infrastructure | when |
|---|---|---|
| `local` | none — the CLI against the materialized checked-in workspace | always (inside plain `pnpm test`) |
| `brain` | throwaway PostgreSQL (`ROSTER_BRAIN_ADMIN_URL`) + the **production** `ContentAddressedBrainObjectStore` over MinIO when `ROSTER_TEST_S3_ENDPOINT` is set (CI always), the in-memory S3-semantics store otherwise — the manifest records which physical store ran | when `ROSTER_BRAIN_ADMIN_URL` is set |

The MinIO path composes the production store class under the registry's LOGICAL
AWS-default namespace with a transport that owns the physical loopback location
(`createMinioTransportStore`), so the namespace fingerprint the registry derives and
the one the database records agree while the bytes land in a test bucket. Embeddings
are never configured — the adapter registry ships empty — which IS the
embeddings-optional proof: every brain task asserts the retrieval echo surfaces the
`embedding` mode as not-`used` while every gate passes.

### Per-task gates

| gate | property |
|---|---|
| `cli-contract` | exit code, empty stderr, one-line JSON (or, for the partial-registry task, the closed fatal `BRAIN_CONFIGURATION_INCOMPLETE` envelope with nonzero exit and no bundle) |
| `recall` | every mandatory fragment present with its declared inclusion reason (`anyOf` = at least one member) |
| `exclusion` | every forbidden ref absent through its declared closed surface (structural absence / product diagnostic / retrieval prefilter) |
| `budget-accounting` | the declared budget counters exactly; local-tier exclusion map all-zero; brain-tier echo breakdown == seed-derived expectation AND `evidence_prefiltered` == its sum |
| `diagnostics` | the distinct diagnostic-code set exactly equals the declared closed set |
| `explanations` | every provenance entry carries the canonical explanation for its inclusion reason |
| `trust-separation` | every fragment kind carries its structural trust class; request provenance is `host-asserted` |
| `host-structure` | every skill-ref carries exactly `{claude, codex}` deep-equal host-native locators |
| `citation` (brain) | seven-field envelope; `sha256(content) == content_hash` re-verified per delivered candidate |
| `embedding-optional` (brain) | the echo surfaces `embedding` as not-`used` |
| `determinism` | two consecutive invocations byte-identical |
| `host-equivalence` | claude-shaped and codex-shaped environment runs byte-identical |
| `explain-toggle` (L7) | A8': identical under the declared projection (`request.explain`, every `provenance[].explanation`, the seven derived budget-size fields), with the fragment-id sets, diagnostics, exclusion map, and omission counters pinned pairwise, under asserted headroom |
| `step-hint` (L8) | the hint changes optional ordering only: fragment SET identical, ordering difference disclosed |
| `legacy-optin` (B3) | absent without the flag; floored with its trust class retained under it |
| `reduction` (L1–L6, L9, B6) | `max(budget.total_tokens, ceil(stdout/4)) ≤ 0.40 ×` the frozen baseline, evaluated only after recall/exclusion/accounting passed |

Tier gates: explanation-vocabulary closure, the per-tier reason-subset assertions
(local never observes a Brain-only reason; brain observes both selector reasons),
and the **independent rebuild** — a second full materialize(+seed)+measure cycle
from scratch (fresh database and fresh object namespace on the brain tier) must
reproduce every fixture-keyed task row exactly.

### Token-reduction definition

See `test/fixtures/context-gold/README.md` for the full definition. In one line:
the product's own `ceil(utf8_bytes/4)` estimator on both sides; the frozen
denominator is the authored instruction bytes under `functions/**` + `tools/**`
(ROSTER.md excluded as shared activation bytes — the A4 composition rule, recorded
in the baseline's own `composition` field and enforced by the hermetic recompute
test); the numerator is `max(reported total, observed stdout)` — every choice
stated with its conservative direction.

### Cross-host equivalence definition

See `test/fixtures/context-gold/README.md`. In one line: both hosts receive the
IDENTICAL bundle — no per-invocation host selector exists (pinned), host-shaped
input exists only at the workspace level with both hosts enabled, host variation is
confined to activation framing outside the bundle and the per-host locators inside
skill-ref fragments (host-native only in this fixture, asserted deep-equal), and
the empirical env-delta byte-identity gate makes it an observed fact on every task.

## Manifest schema (`schema_version: 1`)

| position | meaning |
|---|---|
| `git.commit`, `git.dirty`, `authoritative` | the code identity; a dirty tree marks the run NON-AUTHORITATIVE in its own header and the generated Markdown says so |
| `fixture.files`, `fixture.sha256` | canonical digests of tasks.json / brain-seeds.json / eager-baseline.json |
| `workspace_fixture.files`, `.sha256` | per-file and combined digests of the authored workspace tree (from the frozen baseline) |
| `harness` | per-file SHA-256 of the lint engine, the gold module, the runner, the fixture `_setup.ts`, and the report script **as read at run time** |
| `config` | the estimator, the default budget, the reduction threshold, the frozen baseline tokens, the ratio-gated task list |
| `environment` | node, os, ci/dev, PostgreSQL version, the physical object store (`in-memory` / `minio` / `none`) |
| `tiers.<tier>` | per-task rows: id, family, registry variant, exit status, bundle tokens, baseline tokens, reduction, ratio-gated flag, and every gate record — keyed by task id and fixture-stable seed keys, never minted ids |
| `timings`, `tiers.<tier>.timings` | wall-clock data |
| `comparison_exclusions` | the declared JSON-pointer list the rebuild comparison removes |

The rebuild comparison projection removes exactly `/generated_at`, `/environment`,
`/timings`, `/tiers/local/timings` and `/tiers/brain/timings`. Everything else must
compare equal.

## Reproduction

```
pnpm eval:context                                        # local tier only
ROSTER_BRAIN_ADMIN_URL=<throwaway admin url> pnpm eval:context   # + brain tier
```

Add `ROSTER_TEST_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_REGION` to back the brain tier with MinIO. The script writes both dated files,
re-runs the privacy lint over what it just wrote, and exits non-zero on a gate
failure. The same gates are asserted in CI by:

```
node --test --test-concurrency=2 --experimental-strip-types test/context-quality.test.ts
```

**Pre-PR secret scan** over all three directories (a documented step; `gitleaks` is
not a CI dependency today):

```
gitleaks detect --no-git --source test/fixtures/context-gold
gitleaks detect --no-git --source test/fixtures/context-gold-workspace
gitleaks detect --no-git --source docs/evals/context-quality
```

## Product-defect rule

Any gate failure traced to product behavior (a missing explanation, a
nondeterministic ordering, an accounting mismatch) is NOT fixed inline in this
evaluation: it is filed as its own issue, referenced from the report's Targeted
corrections section, and this suite's expectation stays written against the CORRECT
behavior so the issue remains red-flagged until fixed.
