# Brain retrieval quality evaluation

Dated results of the Brain retrieval-quality evaluation (#353), following the `docs/probes/`
convention: this README describes the method; each run adds a pair of dated files named
`YYYY-MM-DD.json` (the schema-versioned machine-readable manifest — the diffable ground
truth) and `YYYY-MM-DD.md` (prose and tables, **generated from that manifest**).

The gold sets live in `test/fixtures/retrieval-gold/` with their own README describing the
fixture schema, the privacy contract, and the authoring invariants.

## What this evaluation covers

`spec/CONTEXT.md`'s release gate reads: "Context quality passes required recall, exclusion,
citation, determinism, and at least 60 percent token reduction." That sentence spans two
tasks and this one owns half of it.

| Clause | Owner |
|---|---|
| recall, exclusion, citation, determinism **at the retrieval layer** | #353 (here) |
| retrieval latency, cost proxies, privacy of the retrieval evidence | #353 (here) |
| the five deferred-capability disposition **recommendations** | #353 (here) |
| bundle-level mandatory fragment recall, cross-host equivalence, local-only comparison | #371 |
| **≥ 60 % token reduction** vs a frozen eager-load baseline | #371 |
| making authored Brain edges citable | #397 |
| the final keep / defer / remove **decisions** | #368 |

Nothing in this evaluation measures token reduction.

## Method

One shared runner (`test/support/retrieval-eval-runner.ts`) is called by **both** the
PG-gated suite (`test/brain-retrieval-quality.test.ts`) and the report script
(`scripts/retrieval-eval-report.ts`), so the execution logic exists exactly once. Per tier
it: builds a hermetic Brain, ingests the gold corpus in fixture order, seeds the alias
ground truth, runs the authoring self-check, executes every gold query through
`retrieveBrainContextEvidenceWithTelemetry`, computes the metrics, runs the alias-expansion
oracle and the embedding-mechanics probe, and composes the tier result.

### Two tiers

| tier | object store | when |
|---|---|---|
| `memory` | in-memory S3 *semantics* fake | always (fast) |
| `minio` | the **production** `ContentAddressedBrainObjectStore` composed with a test S3 transport, against a real S3-compatible service | when `ROSTER_TEST_S3_ENDPOINT` is set; CI always |

The MinIO tier keeps every guarantee of the production store class — content addressing,
digest verification, the `objects/xx/<sha>` key layout. What it does not compose is the
production *factory*, whose strict network boundary
(`src/lib/brain/s3-network-policy.ts:74-88`) refuses non-https endpoints and loopback
addresses and therefore can never reach a local MinIO. That boundary is not weakened; it
lives in `createBrainObjectStore`, which this path deliberately does not call.

### Gates versus measurements

**Gates** (assertions; a failure fails the suite): baseline recall, exclusion exactness,
precedence/label correctness, citation completeness, determinism, the latency bound, privacy,
the authoring self-check, the alias-oracle boundedness check, and the independent rebuild.

**Graph availability is EVIDENCE, never a gate.** The manifest records how many queries
reported graph expansion unavailable and which reason pairs they carried, and nothing
asserts unavailability — a future citable graph arm must be able to ship without failing
this suite, which is what acceptance criterion 5 requires. The single graph assertion is
envelope-internal: a query that *does* report the capability unavailable must carry the
closed reason pair `['no-cited-edge-relation', 'unmeasured']`, and that assertion is
vacuous the day the arm exists.

**Measurements** (reported numbers, never assertions): the alias-variant, multi-record,
ordering and paraphrase-ordering families, the alias-expansion oracle delta, the one-hop
recall gap, and the embedding-arm mechanics. Gating any of these would convert an optional
capability into a launch requirement.

## Metric definitions

**Unit rule.** Relevance is authored at **source-version** level; delivered candidates are
chunks. Before any ranking metric the delivered list is **collapsed to source versions by
first occurrence**: walk `D(q)` in `retrieval_rank` order, keep a candidate only if its
`citation.source_version_id` has not appeared earlier, and drop later duplicates entirely —
they are neither relevant nor irrelevant, they are the same version again. Call the collapsed
ordered list `Dv(q)` and its first `k` elements `Dv@k(q)`. `R(q)` is the fixture-resolved
relevant source-version set; the *joint* set additionally contains the deliberate membership
misses; `X(q)` is the expected-excluded set.

- **Recall@k(q)** = `|Dv@k(q) ∩ R(q)| / |R(q)|`, macro-averaged per family, k ∈ {8, 10, 64}.
  **Gate:** baseline family Recall@64 = 1.0.
- **JointRecall@k(q)** = the same over `R(q) ∪ misses(q)` — the gap measurement.
- **Precision@k(q)** = `|Dv@k(q) ∩ R(q)| / min(k, |Dv(q)|)` — the denominator is in the same
  (version) unit as the numerator, and is defined as **0 at empty delivery**, never a
  vacuous 1.
- **MRR** = mean over q of `1 / rank(first relevant in Dv(q))`, 0 if absent. Report-only.
- **NDCG@10(q)** = `DCG@10 / IDCG@10` with `DCG@10 = Σ_{i=1..10} rel(Dv_i(q)) / log2(i+1)`
  (`rel` = the authored grade of that version, 0 if not relevant) and `IDCG@10` from the
  descending-sorted grades of `R(q)`. Report-only.
- **Oracle reordering headroom@k(q)** = `min(|Dv(q) ∩ R(q)|, k) / |R(q)| − Recall@k(q)` — the
  exact gain a perfect reorderer of the *delivered* set could achieve. **Validity condition:**
  the bound is a true common ceiling only while `truncated = 0`, because embedding scores fuse
  BEFORE the 64-candidate cap (`src/lib/brain/context-retrieval.ts:830`), so under truncation
  a rescorer could pull a relevant pre-cap candidate into delivery and exceed it. The ordering
  families are authored to deliver their whole pool and the harness asserts `truncated = 0`.
- **Exclusion correctness(q)** = 1 iff no expected-excluded version appears in `Dv@64(q)` AND
  the report's `filtered[reason]` equals the constructed chunk count for that reason, exactly,
  for all six closed reasons. Accounting is chunk-denominated by contract; exclusion sets are
  version-denominated; both are stated as such. **Gate:** 1.0.
- **Citation completeness** = delivered candidates where all seven envelope fields are
  present, `sha256(content) == content_hash`, and the locator proof holds — a `@bytes`
  re-slice of the immutable object hashing to `content_hash` for `roster-text`, and for
  `roster-structured` the region `object` spanning the whole document plus a proof that the
  immutable object bytes hash to `object_id` itself — divided by `returned`. **Gate:** 1.0,
  in both tiers.
- **Determinism** = two consecutive retrievals produce **structurally deep-equal** evidence
  (`node:util` `isDeepStrictEqual`, telemetry excluded), AND the metric pipeline computed
  twice over one evidence set produces a deep-equal result. **Gate**, on every gold query.
- **Independent rebuild** = two full ingest+measure cycles from scratch (fresh database, and
  a fresh bucket in the MinIO tier) produce identical result manifests under the declared
  comparison projection. **Gate**, per tier. Strictly stronger than same-snapshot
  determinism: it proves the corpus build, the ingest ordering and the metric pipeline are
  themselves deterministic.
- **Latency** = warm max-of-five `transactionMs + embedMs` per family. **Gate:** < 2000 ms
  (`spec/SPEC.md:828`). `connectMs` is reported separately. The scaled-corpus 2 s proof is
  cited from `test/brain-context-retrieval.test.ts` acceptance 10 rather than duplicated.
- **Cost** (deterministic proxies, report-only): per-query `armRows` per mode, pre-cap pool
  size, `considered` / `returned` / `truncated`, and for the fake-adapter run the embed
  invocations, stored vectors and bytes embedded. All byte-identical across the rebuild gate.
- **Privacy** (gates): zero `secret` candidates in any delivery, zero `legacy-unverified`
  candidates without the opt-in, and the hermetic lint over the fixtures **and** these
  generated artifacts. Inside JSON the lint's digest exemption is pointer-scoped, so a
  digest-shaped token at an undeclared position is reported as `unexpected-digest`. Two
  documented boundaries: outside JSON the exemption is shape-only, and bare-hostname
  detection uses a closed TLD list (the artifacts legitimately contain file paths and SQL
  identifiers a general rule cannot tell apart from hostnames). The URL and email rules are
  TLD-independent. Both boundaries are pinned by tests in `test/retrieval-gold-set.test.ts`
  and restated in `test/fixtures/retrieval-gold/README.md`.

## Manifest schema (`schema_version: 1`)

| position | meaning |
|---|---|
| `git.commit`, `git.dirty`, `authoritative` | the code identity; a dirty tree marks the run NON-AUTHORITATIVE in its own header and the generated Markdown says so |
| `fixture.files`, `fixture.sha256` | per-file and combined digests over the canonicalised fixture JSON |
| `harness` | per-file SHA-256 of the runner, the gold/lint/metric module, the MinIO transport and the report script **as read at run time**, so uncommitted harness code is identified exactly |
| `config` | `rrf_k` **read from the Brain's own `brain_meta.config`** by the retrieval transaction (never a constant restated by the harness), `total_candidate_limit`, `per_selector_arm_limit`, the k values, the token budget, the latency budget |
| `environment` | node, os, ci/dev, PostgreSQL `server_version`, pgvector `extversion`, the tiers that ran |
| `tiers.<tier>` | per-tier ingest counts, per-query and per-family metric rows, citation and privacy counters, the alias oracle, the one-hop rows, the embedding mechanics, the self-check rows and the gate records |
| `timings`, `tiers.<tier>.timings` | wall-clock data: the per-family five-run sample **arrays**, the thirty-run array behind the p95, the connect samples, and the ingest/evaluation totals |
| `comparison_exclusions` | the declared JSON-pointer list the rebuild gate removes before comparing |

The rebuild comparison projection removes exactly `/generated_at`, `/environment`,
`/timings`, `/tiers/memory/timings` and `/tiers/minio/timings`. Everything else — including
every gate record and every cost counter — must compare equal.

## Reproduction

```
ROSTER_BRAIN_ADMIN_URL=<throwaway admin connection string> pnpm eval:retrieval
```

Add `ROSTER_TEST_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`
to include the MinIO tier. The script writes both dated files, re-runs the privacy lint over
what it just wrote, and exits non-zero on a gate failure.

The same numbers are asserted in CI by:

```
node --test --test-concurrency=2 --experimental-strip-types test/brain-retrieval-quality.test.ts
```

**Pre-PR secret scan** over both directories (a documented step; `gitleaks` is not a CI
dependency today):

```
gitleaks detect --no-git --source test/fixtures/retrieval-gold
gitleaks detect --no-git --source docs/evals/retrieval-quality
```
