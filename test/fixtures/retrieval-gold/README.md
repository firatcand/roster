# Retrieval gold set

Distributable data fixtures for the Brain retrieval-quality evaluation (#353). Two JSON
files — `corpus.json` (what is ingested) and `queries.json` (what is asked and what must
come back) — plus this schema description. No code lives here; the loader, the privacy
lint and the metric functions are in `test/support/retrieval-gold.ts`, and the shared
evaluation runner both the PG-gated suite and the report script call is
`test/support/retrieval-eval-runner.ts`.

## Privacy contract

**All content is synthetic**, composed for this fixture in a fictional GTM/social
workflow domain. No real workspace is a source; nothing is copied from any live Brain,
any live workspace, or any customer artefact. This authoring rule is a signed-off property
of every revision of this corpus.

Workspace identity comes from an **explicit allowlist of synthetic identities** declared in
the lint module (`SYNTHETIC_WORKSPACE_IDS` in `test/support/retrieval-gold.ts`), not in this
fixture — an identity that leaked into the corpus must not be able to bless itself by
appearing in the corpus's own declaration. The single allowlisted identity is
`retrieval-gold-workspace`; `validateGoldSet` asserts the fixture's declared set is a subset
of the module's constant.

A **hermetic privacy lint** (`lintRetrievalGoldArtifacts`, no database required) scans every
byte of this directory **and every generated artifact in `docs/evals/retrieval-quality/`** —
manifests and generated Markdown are exactly where private content would leak on a careless
re-run against a real workspace. Rules: denylisted literals, non-synthetic hostnames and
URLs (only `localhost`, `127.0.0.1`, `example.com` and the `.example` / `.invalid` / `.test`
suffixes pass), userinfo URLs, connection strings carrying userinfo, absolute home paths in
POSIX, Windows and UNC form, emails outside the synthetic domains, credential-shaped strings,
workspace-shaped identifiers outside the allowlist, and high-entropy tokens.

**Schema-aware digest exemptions.** The fixtures and manifests legitimately contain SHA-256
values (`rawSha256`, `expectedChunkContentSha256s`, the fixture and harness digests) and a
git commit id. The lint parses JSON structurally and exempts a value only when its JSON
pointer is a KNOWN digest-typed position **and** its exact shape validates (64 lowercase hex,
optionally `sha256:`-prefixed; 7–40 hex for a commit id). Every other string still runs the
full rule set, so a credential parked in a digest field fails like any other.

**Self-match scoping.** The denylist literals live inside the lint module, and the lint's
scan scope is exactly this directory plus `docs/evals/retrieval-quality/` — never the lint
module itself, and never the wider test tree, which legitimately contains absolute home
paths in unrelated fixtures.

**Honesty statement.** A denylist cannot *prove* synthetic provenance; it can only catch
known-shaped leaks. The control is the conjunction of four things: the authoring rule (no
copying from any real workspace), the allowlisted synthetic identities, the hermetic lint
over the fixtures *and* the generated artifacts, and the repository `gitleaks` secret scan
run over both directories before the PR (a documented pre-PR step — `gitleaks` is not a CI
dependency today).

## What this fixture does and does not discharge

`spec/CONTEXT.md`'s release gate reads: "Context quality passes required recall, exclusion,
citation, determinism, and at least 60 percent token reduction." That sentence spans two
tasks.

- **#353 (this fixture)** discharges recall, exclusion, citation completeness and
  determinism **at the retrieval layer**, plus retrieval latency, cost proxies and privacy.
- **#371 (P2-T11)** discharges the bundle-level repeats — mandatory plan/policy/lesson/tool
  fragment recall, cross-host semantic equivalence, local-only versus Brain-configured
  comparison — and the **≥ 60 % token reduction**, which is a criterion of that task alone.
  Nothing here measures token reduction.

## `corpus.json`

```
{ schemaVersion: 1,
  identities: { workspaceIds: [...] },          // asserted against the lint's allowlist
  target: { functionId, agentId, planId },      // the retrieval request's target
  planClosureQualifiedIds: [...],               // the request's plan closure
  sources: [
    { sourceStableKey,
      revisions: [                              // ingested in order; >1 revision ⇒ earlier ones superseded
        { fixtureVersionKey,
          kind: "text" | "structured",
          body                                  // text revisions: the exact ingested bytes
          record: { kind, identity, body },     // structured revisions: the #352 §10 record shape
          rawSha256,                            // must equal the resolved object_id sans 'sha256:'
          expectedChunkContentSha256s: [...],   // per-chunk content digests, verified hermetically
          labels: [{ workspace, function?, agent?, plan? }],
          privacy: "public" | "internal" | "secret",
          trust: "brain-extract-untrusted" | "legacy-unverified",
          inactiveExtraction?: { extractorVersion, content } } ],
      finalDisposition: "current" | "tombstoned" } ],
  aliases: [ { entityKind, canonicalSlug, canonicalTitle, aliases: [...] } ],
  selectorEntities: { "<selector>": ["<entityKind>/<canonicalSlug>", ...] } }
```

### Immutable-version identity discipline

Source-version ids are minted per hermetic database, so the fixture never records one.
Instead the fixture records the **raw body**, and the harness asserts at ingest time that
the resolved version's `object_id` equals `'sha256:' + rawSha256` — raw-body identity via
content addressing (`brain.source_objects`, `data/brain/schema/011_source_lifecycle.sql:10-27`).

**Chunk content hashes are a different object.** A citation's `content_hash` covers the
*extracted chunk content* (`brain.source_chunks.content_sha256`, DB-enforced by the trigger
at `data/brain/schema/012_extraction_indexing.sql:156`), which for a structured record is a
rendered projection and legitimately differs from any raw-body slice.
`expectedChunkContentSha256s` pins those, and the citation gate independently re-verifies
`sha256(candidate.content) == content_hash` at delivery time, so the pins are a
fixture-integrity aid and not the proof.

**Supersession needs multiple versions per logical source**, which is why
`fixtureVersionKey ≠ sourceStableKey`: one logical source carries an ordered list of
revisions, each with its own key, so a query can reference the *superseded* revision
explicitly as an expected exclusion.

### `inactiveExtraction` — the extractor-inactive construction

Bumping `brain_meta.active_extractors.active_version` does NOT work: the activation registry
check refuses a mismatched compiled registry before filter accounting ever runs. The fixture
instead seeds a **complete** extraction carrying a version the registry does not activate,
inserted beside the real one with the compiled registry untouched. That chunk is invisible to
`brain.current_source_chunks` and is classified `extractor-inactive` by the accounting, with
activation unaffected.

## `queries.json`

```
{ schemaVersion: 1,
  queries: [
    { id, family,
      selectors: [{ selector, descriptions: [...], required }],
      query, stepHint?,
      relevant: [ { fixtureVersionKey,
                    expectSelectorClaim: true, expectedSelectors, expectedArms,
                    expectLabelScopeEligible: true, expectedLabelKeys?, expectedScope?,
                    expectPolicyEligible: true, grade? } ],
      membershipMisses?: [ { fixtureVersionKey,
                    expectSelectorClaim: false,
                    expectLabelScopeEligible: true, expectedLabelKeys,
                    expectPolicyEligible: true, missClass } ],
      excluded?: [ { fixtureVersionKey, expectPolicyEligible: false, reason } ],
      includeLegacyUnverified?, notes } ] }
```

### Three orthogonal eligibility expectations

Every referenced item carries three independent expectations, so a scope or privacy exclusion
can never masquerade as a membership gap:

| | `expectSelectorClaim` | `expectLabelScopeEligible` | `expectPolicyEligible` |
|---|---|---|---|
| relevant | true (+ selectors, arms) | true (+ label keys, scope) | true |
| deliberate membership miss | **false** | true (+ label keys) | true |
| policy-filtered | — | — | **false** (+ exact reason) |

A membership miss is verified to be membership-**only** by DIRECT item-keyed assertions
against the admin pool. Bucket absence proves nothing here: `FILTER_ACCOUNTING_SQL` selects
membership-REACHABLE chunks before it applies any reason
(`src/lib/brain/context-retrieval.ts:509`), so an unreachable chunk contributes to no bucket
regardless of its eligibility. The harness therefore mirrors the engine's eligibility
predicates **without** the membership predicate and proves, per chunk, that its labels
satisfy the request's allowlist, its privacy class is compatible, its version is current
(not superseded, not tombstoned), its trust class is admissible under the request's opt-in,
and its extraction is active — 'active' mirroring `brain.current_source_chunks`'s own
definition: registry version match AND `status = 'complete'`.

### Families

| family | queries | role |
|---|---|---|
| `baseline` | 12 | **GATE.** Vocabulary-overlapping text and structured evidence; Recall@64 = 1.0. |
| `exclusion` | 9 | **GATE.** All six closed filter reasons, individually and in one sweeping request; exact accounting. |
| `precedence` | 5 | **GATE.** Dual-arm dedup (delivered and filtered), exact selectors/label keys/scope, the structured `@object:` citation proof. |
| `alias-variant` | 10 | Measured. Feeds #329: canonical form admitted, variant form an eligible-but-unclaimed miss, plus the alias-expansion oracle. |
| `multi-record` | 8 | Measured. Feeds #330/#332: the linked record is reachable only by following an identity reference. **One hop only.** |
| `ordering` | 6 | Measured. Feeds #331/#333: membership guaranteed, ranking stressed by query wording. |
| `paraphrase-ordering` | 5 | Measured. As above with no query term present in the documents at all. |

Only the gate families gate. Gating a measured family would convert an optional capability
into a launch requirement.

### Authoring invariants the harness enforces

1. **Cluster-exclusive anchors.** Each cluster owns a rare anchor word that appears nowhere
   else in the corpus, so a selector's two-word description can only reach that cluster.
   `websearch_to_tsquery` ANDs the words of one segment and ORs across segments, so
   membership is fully determined by the descriptions.
2. **Per-arm bound.** Every selector's corpus-wide lexical and structured membership counts
   must each stay within `PER_SELECTOR_ARM_LIMIT` (8), checked by query against the ingested
   corpus — never by trusting the author. Without it, in-arm truncation would confound a
   gate.
3. **Reachability, both directions.** Every relevant item must be arm-reachable and every
   deliberate miss must be arm-unreachable.

## Reproduction

```
ROSTER_BRAIN_ADMIN_URL=<throwaway admin connection string> \
  node --test --test-concurrency=2 --experimental-strip-types test/brain-retrieval-quality.test.ts
```

Adding `ROSTER_TEST_S3_ENDPOINT` (plus `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`) runs the MinIO proof tier as well; without it that section skips with
`ROSTER_TEST_S3_ENDPOINT not set`. CI always provides both.

The hermetic half needs nothing:

```
node --test --experimental-strip-types test/retrieval-gold-set.test.ts
```

To regenerate the durable report:

```
ROSTER_BRAIN_ADMIN_URL=<throwaway admin connection string> pnpm eval:retrieval
```

**Pre-PR secret scan** (documented step, not a CI job):

```
gitleaks detect --no-git --source test/fixtures/retrieval-gold
gitleaks detect --no-git --source docs/evals/retrieval-quality
```

### Editing the fixture

`rawSha256` and `expectedChunkContentSha256s` are **verified, not trusted**: the hermetic
test recomputes both from the recorded body and reports the correct value on a mismatch.
Edit a body, run `test/retrieval-gold-set.test.ts`, and copy the reported digests back.
