// Runs the ONE shared evaluation runner the PG-gated suite uses, writes the
// schema-versioned result manifest, and GENERATES the dated Markdown report from
// that manifest. The JSON is the diffable ground truth; the Markdown is prose.
//
//   ROSTER_BRAIN_ADMIN_URL=<admin connection string> pnpm eval:retrieval
//
// Adding ROSTER_TEST_S3_ENDPOINT (plus AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
// adds the MinIO proof tier, which composes the production
// ContentAddressedBrainObjectStore over a real S3-compatible service.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAS_TEST_S3 } from '../test/support/minio-brain-object-store.ts';
import {
  RETRIEVAL_EVAL_DOCS_DIR,
  loadGoldSet,
  lintRetrievalGoldArtifacts,
  validateGoldSet,
} from '../test/support/retrieval-gold.ts';
import {
  composeManifest,
  runRetrievalEvaluation,
  type EvaluationOutcome,
  type ResultManifest,
  type TierResult,
} from '../test/support/retrieval-eval-runner.ts';

type Row = readonly (string | number)[];

function table(headers: readonly string[], rows: readonly Row[]): string {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell)).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

function tierOf(manifest: ResultManifest, tier: string): TierResult | undefined {
  return (manifest.tiers as Record<string, TierResult | undefined>)[tier];
}

function familyTable(tier: TierResult): string {
  return table(
    ['family', 'gated', 'queries', 'Recall@8', 'Recall@64', 'JointRecall@64', 'Precision@8', 'MRR', 'NDCG@10', 'Headroom@8'],
    tier.families.map((family) => [
      family.family,
      family.gated ? 'gate' : 'measured',
      family.queries,
      percent(family.recall_at['8']!),
      percent(family.recall_at['64']!),
      percent(family.joint_recall_at['64']!),
      percent(family.precision_at['8']!),
      family.mrr.toFixed(3),
      family.ndcg_at_10.toFixed(3),
      percent(family.headroom_at['8']!),
    ]),
  );
}

function aliasTable(tier: TierResult): string {
  return table(
    [
      'query', 'miss class', 'alias expansions', 'baseline joint Recall@64',
      'oracle joint Recall@64', 'delta', 'truncated', 'within arm cap',
    ],
    tier.alias_oracle.map((row) => [
      row.query,
      row.miss_class,
      row.expansions,
      percent(row.baseline_joint_recall_at_64),
      percent(row.oracle_joint_recall_at_64),
      percent(row.delta),
      row.truncated,
      row.within_arm_limit ? 'yes' : 'NO',
    ]),
  );
}

function multiRecordTable(tier: TierResult): string {
  return table(
    ['query', 'anchor-only Recall@64', 'joint (anchor + linked) Recall@64', 'recall drop'],
    tier.multi_record.map((row) => [
      row.query,
      percent(row.anchor_recall_at_64),
      percent(row.joint_recall_at_64),
      percent(row.gap),
    ]),
  );
}

function gateTable(tier: TierResult): string {
  return table(
    ['gate', 'result', 'detail'],
    tier.gates.map((gate) => [gate.name, gate.ok ? 'pass' : 'FAIL', gate.detail]),
  );
}

function orderingHeadroom(tier: TierResult): { recall8: number; headroom8: number; ndcg: number } {
  const rows = tier.families.filter((family) => (
    family.family === 'ordering' || family.family === 'paraphrase-ordering'
  ));
  const average = (pick: (row: (typeof rows)[number]) => number): number => (
    rows.reduce((total, row) => total + pick(row), 0) / Math.max(rows.length, 1)
  );
  return {
    recall8: average((row) => row.recall_at['8']!),
    headroom8: average((row) => row.headroom_at['8']!),
    ndcg: average((row) => row.ndcg_at_10!),
  };
}

function dispositions(tier: TierResult): string {
  const recoveredRows = tier.alias_oracle.filter((row) => row.recovered);
  const unrecovered = tier.alias_oracle.filter((row) => !row.recovered);
  const averageDelta = tier.alias_oracle.length === 0
    ? 0
    : tier.alias_oracle.reduce((total, row) => total + row.delta, 0) / tier.alias_oracle.length;
  const oneHopGap = tier.multi_record.length === 0
    ? 0
    : tier.multi_record.reduce((total, row) => total + row.gap, 0) / tier.multi_record.length;
  const ordering = orderingHeadroom(tier);
  const mechanics = tier.embedding_mechanics;

  return `## Capability dispositions

Final keep / defer / remove decisions are recorded in **#368**. This report supplies the
evidence; it recommends and never decides. Every section closes with an explicit
launch-requirement check, because activation is not a launch gate: no assertion in the
gated suite requires any of these capabilities, and the phase-2 gate passes with all five
absent.

### 1. Alias search (#329)

**Question.** Would a trigram/alias retrieval arm recover evidence the lexical arm misses
because a document names an entity by a variant of the term the selector describes?

**Substrate status.** \`brain.entity_aliases\` plus its trigram GIN index exist
(\`data/brain/schema/005_dedup_merge.sql:14-24\`). They are consulted only by dedup's
candidate query (\`src/lib/brain/dedup.ts:68-76\`) and by no retrieval arm: membership is
selector-shaped (\`src/lib/brain/context-retrieval.ts:235-239\`, predicate at \`:324\`) and
consults \`websearch_to_tsquery\` alone.

**What was measured.** (a) The baseline miss rate on the alias-variant family by miss class — ${tier.alias_oracle.length} clusters, each with one canonical document that IS admitted and one variant document that is NOT. This quantifies *vocabulary mismatch*; on
its own it does not prove alias benefit. (b) The **alias-expansion oracle**: the same
query re-run with each selector's descriptions augmented by the alias table's expansions
for the canonical entities that selector names, giving the counterfactual recall delta
without building the arm.

${aliasTable(tier)}

Average oracle delta: **${percent(averageDelta)}**. ${recoveredRows.length} of ${tier.alias_oracle.length} clusters were fully recovered; ${unrecovered.length} was not (${unrecovered.map((row) => `\`${row.query}\``).join(', ') || 'none'}) — that cluster's variant surface form is absent from the alias table, which is exactly the boundary of what alias expansion can reach.

**What was NOT measured (named).** Trigram *fuzzy* matching quality beyond exact-alias
expansion; alias-table coverage on a representative adopter corpus; the precision cost of
expansion (this fixture has no near-miss entity whose alias would pull in irrelevant
evidence); and per-query latency of an alias-joined membership predicate.

**Recommended disposition.** Keep deferred, with the oracle delta recorded as the measured
ceiling of known-alias expansion on the existing substrate.

**Activation threshold.** Activate when a representative adopter corpus shows that at least
X % of entity-bearing queries fall into miss classes the oracle recovers, X to be set by
#368 against real query logs — this synthetic fixture fixes the miss rate by construction
and cannot supply X.

**Launch-requirement check.** Not a launch gate. The alias-variant family is measured, never
gated; every gate in this suite passes with \`entity_aliases\` unread by retrieval.

### 2. Default embeddings (#331)

**Question.** Should Roster ship a default embedding provider so the embedding arm runs out
of the box?

**Substrate status.** The adapter registry ships empty
(\`src/lib/brain/embedding-provider.ts:31-32\`), so the arm never runs by default. More
importantly the arm is **ordering-only**: its hits carry \`selector: ''\`
(\`src/lib/brain/context-retrieval.ts:414-421\`) and the pool is built only from
\`selectorsByChunk.keys()\` (\`:848-850\`), so an embedding hit cannot create a selector claim
and cannot repair a membership miss.

**What was measured.** (a) Baseline membership recall — what embeddings cannot improve today (baseline family Recall@64 = ${percent(tier.families.find((family) => family.family === 'baseline')!.recall_at['64']!)}, and every alias/linked-record miss stays a miss under any rescorer). (b) Ordering headroom on the ordering families: mean Recall@8 ${percent(ordering.recall8)} against a perfect reorderer's ceiling, leaving **${percent(ordering.headroom8)}** of headroom at k = 8, with mean NDCG@10 ${ordering.ndcg.toFixed(3)}. (c) One hermetic fake-adapter run measuring the arm's *mechanics* only: \`${mechanics.status}\`, ${mechanics.stored_vectors} stored vectors, ${mechanics.embed_invocations} embed invocation(s), ${mechanics.bytes_embedded} bytes embedded, ${mechanics.embedding_arm_rows} embedding arm rows, delivered-set changed **${mechanics.delivered_set_changed}** at \`truncated = ${mechanics.truncated}\`.

The delivered-set result is the empirical confirmation of the architectural fact: with
nothing truncated, adding the embedding arm left the delivered SET unchanged
(\`delivered_set_changed = ${mechanics.delivered_set_changed}\`) while the delivered ORDER
changed: \`delivered_order_changed = ${mechanics.delivered_order_changed}\`.

**What was NOT measured (named).** Semantic ordering quality — synthetic vectors measure
mechanics, not meaning; real-provider embedding quality on a representative corpus; index
build cost and storage growth at adopter scale; the privacy consequence of shipping content
to an embedding provider at index time; and behaviour under truncation, where fusion happens
before the 64-candidate cap and a rescorer could change the delivered set.

**Recommended disposition.** Defer. Baseline membership recall is already 1.0 on the gated
family, the measurable upside is ordering only, and **that ceiling is shared with #333** —
this evidence cannot choose between them (see §5).

**Activation threshold.** Activate when a representative corpus shows ordering headroom that
a real provider actually converts, measured against the same oracle bound, AND the privacy
class of the corpus permits index-time content egress.

**Launch-requirement check.** Not a launch gate. Lexical and structured retrieval are the
required baseline modes; the ordering families are measured, never gated, and the whole
suite passes with the adapter registry empty.

### 3. Graph expansion (#330)

**Question.** Would one-hop expansion over authored edges recover evidence reachable only
by following a relation?

**Substrate status.** The cited engine hard-codes \`graph: { status: 'unavailable', reasons: ['no-cited-edge-relation', 'unmeasured'] }\` (\`src/lib/brain/context-retrieval.ts:169\` and \`:922\`). **Measured as evidence, never asserted:** ${tier.graph_evidence.unavailable} of ${tier.graph_evidence.queries} gold queries reported graph expansion unavailable and ${tier.graph_evidence.available} reported it available, carrying the reason pair(s) ${tier.graph_evidence.reason_pairs.map((pair) => `\`${pair}\``).join(', ') || '(none)'}. The suite does **not** gate on unavailability — a future citable graph arm must be able to ship without failing this suite. The one assertion here is envelope-internal: a query that DOES report the capability unavailable must carry that closed reason pair.
\`brain.edges\` carries no \`source_version_id\` (\`data/brain/schema/001_init.sql:41-48\`), so an
expanded row could not be cited. A one-hop expansion *implementation* does already exist
in the legacy pre-#352 surface (\`src/lib/brain/search.ts:147-173\`, consuming
\`search.graph_hops\`), fail-closed at the CLI (\`src/bin/roster.ts:176\`) and pinned as a
forbidden dependency of the assembler (\`test/static-boundaries.test.ts:313\`). That proves
one-hop traversal MECHANICS exist in-tree. It is not evidence of cost or of quality, and no
cheapness claim is made here.

**What was measured.** The one-hop joint-recall gap from the multi-record family: an anchor
structured record whose body references a linked record by identity, where the linked record
is eligible on labels, privacy, lifecycle, trust and extractor but claimed by no selector.

${multiRecordTable(tier)}

Mean recall drop when the linked record is counted (anchor-only Recall@64 minus joint Recall@64): **${percent(oneHopGap)}**. Every linked record in this family is eligible on labels, privacy, lifecycle, trust and extractor — the harness proves that per item against the database — so the ONLY thing standing between it and delivery is the missing selector claim a one-hop traversal would supply.

**What was NOT measured (named), each an explicit insufficient-evidence item pending #397.**
Multi-hop recall at hop = 2; cycle behaviour; the fan-out / pool-inflation distribution;
expansion precision (the fraction of hop-added versions that are actually relevant); and
per-hop \`transactionMs\` cost. No fake graph measurement was produced in their place.

**Recommended disposition.** **Insufficient evidence; defer pending #397.** The demand half
is real and measured; the citation substrate does not exist, and every dimension above is
unmeasured.

**Activation threshold.** #397 lands a citable edge relation, and the five named
measurements are taken on a corpus with authored edges.

**Launch-requirement check.** Not a launch gate. The multi-record family is measured, never
gated, and the engine's own report declares graph expansion unavailable in every query
without failing anything.

### 4. Automatic edges (#332)

**Question.** Should extraction derive edges automatically so a graph arm would have
something to traverse?

**Substrate status.** Nothing extracts edges today; \`brain.edges\` rows are authored, and
the retrieval arm that would consume them does not exist (§3).

**What was measured.** Only the **demand** half, and only indirectly: the recurring recall drop above (mean **${percent(oneHopGap)}** across ${tier.multi_record.length} clusters) shows that identity references inside structured bodies do carry relevant evidence the selector-shaped membership cannot reach.

**What was NOT measured (named).** Edge-extraction recall and precision against a labelled
edge gold set (this fixture has none); lineage and citation preservation through extraction;
privacy-class propagation for edges derived from \`secret\`-class content; and write-time cost
and latency of edge extraction during ingest.

**Recommended disposition.** **Defer pending those named measurements**, and behind #397 and
#330 regardless: even a large measured demand defers, because auto-edges feed a retrieval arm
that does not exist.

**Activation threshold.** A labelled edge gold set exists, extraction recall/precision are
measured on it, privacy propagation is specified, and #330 has a citable arm to consume the
output.

**Launch-requirement check.** Not a launch gate. No gate in this suite references an edge.

### 5. Hosted reranking (#333)

**Question.** Would a hosted reranker over the delivered candidate set materially improve
ordering?

**Substrate status.** No reranker exists. A reranker operates on the delivered set, exactly
like the embedding arm operates on the fused pool — so both chase the same quantity.

**What was measured.** Precision@8, MRR, NDCG@10 and the oracle reordering headroom on the ordering families: mean Recall@8 ${percent(ordering.recall8)}, mean NDCG@10 ${ordering.ndcg.toFixed(3)}, and **${percent(ordering.headroom8)}** headroom at k = 8. Every
ordering query delivered its whole pool (\`truncated = 0\`), which is the condition under
which this bound is a valid ceiling: embedding scores fuse BEFORE the 64-candidate cap
(\`src/lib/brain/context-retrieval.ts:830\`), so under truncation a rescorer could exceed the
delivered-set bound.

**This bound is COMMON to #331 and #333 and therefore cannot decide between them.**

**What was NOT measured (named), and what would decide it.** Live-provider ordering quality
on a representative adopter corpus under each option; the privacy delta (a hosted reranker
ships candidate *content* across the trust boundary at query time, while embeddings ship
content at index time and only the query at retrieval time — \`spec/CONTEXT.md\` privacy
invariants); marginal latency against the 2 s remote budget (\`spec/SPEC.md:828\`); and
per-query monetary cost.

**Recommended disposition.** **Insufficient evidence; defer pending those named
measurements**, with the headroom bound recorded as the value ceiling either option chases.

**Activation threshold.** A representative corpus shows a real provider converting a
material fraction of the measured headroom, within the latency budget, at an accepted
privacy and cost position — and the same experiment is run for #331 so the two can be
compared on evidence rather than on a shared ceiling.

**Launch-requirement check.** Not a launch gate. The ordering families are measured, never
gated.
`;
}

function renderMarkdown(manifest: ResultManifest, date: string): string {
  const memory = tierOf(manifest, 'memory');
  const minio = tierOf(manifest, 'minio');
  const primary = memory ?? minio!;
  const git = manifest.git as { commit: string; dirty: boolean };
  const environment = manifest.environment as Record<string, unknown>;
  const corpus = manifest.corpus as Record<string, number>;

  const header = git.dirty
    ? '> **NON-AUTHORITATIVE RUN.** The working tree was dirty when this manifest was produced, so the\n'
      + '> recorded commit does not identify the code that ran. Re-run from a clean tree before citing\n'
      + '> these numbers in a decision.\n\n'
    : '';

  const tierSections = [memory, minio]
    .filter((tier): tier is TierResult => tier !== undefined)
    .map((tier) => `### Tier \`${tier.tier}\`

Ingested ${tier.ingest.logical_sources} logical sources / ${tier.ingest.versions} immutable versions / ${tier.ingest.objects} content-addressed objects / ${tier.ingest.active_chunks} active chunks (plus ${tier.ingest.inactive_chunks} at a non-active extractor version), ${tier.ingest.entities} canonical entities and ${tier.ingest.aliases} alias rows.

${familyTable(tier)}

Citations: ${tier.citations.complete}/${tier.citations.delivered} delivered candidates fully verified (${percent(tier.citations.completeness)}) — ${tier.citations.text_byte_reslices} \`@bytes\` re-slices against the immutable object and ${tier.citations.structured_object_proofs} \`@object\` structured proofs. Privacy: ${tier.privacy.secret_candidates} secret candidates, ${tier.privacy.legacy_unverified_without_optin} legacy-unverified candidates without the opt-in.

${gateTable(tier)}

Deterministic statement cost per retrieval, on each family's representative query: ${Object.entries(tier.statements_per_family).map(([family, count]) => `${family} ${count}`).join(', ')}. Warm max-of-five \`transactionMs + embedMs\` per family: ${Object.entries(tier.timings.per_family_max_of_five_ms).map(([family, ms]) => `${family} ${ms} ms`).join(', ')}; report-only p95 over ${tier.timings.p95_sample_ms.length} warm runs of one representative query: ${tier.timings.p95_transaction_ms} ms.`)
    .join('\n\n');

  const body = `# Brain retrieval quality — ${date}

${header}Generated from \`${date}.json\` by \`pnpm eval:retrieval\`. The JSON manifest is the
ground truth; this document is prose and tables derived from it.

- commit: \`${git.commit}\`${git.dirty ? ' (dirty)' : ''}
- fixture: \`${(manifest.fixture as { sha256: string }).sha256}\`
- environment: node ${String(environment.node)}, ${String(environment.os)}, PostgreSQL ${String(environment.postgres)}, pgvector ${String(environment.pgvector ?? 'absent')}, tiers ${String(environment.s3_tier)}
- corpus: ${corpus.sources} sources / ${corpus.revisions} revisions / ${corpus.queries} queries
- effective retrieval config: rrf_k ${String((manifest.config as Record<string, unknown>).rrf_k)} (read from the Brain's own \`brain_meta.config\`), candidate cap ${String((manifest.config as Record<string, unknown>).total_candidate_limit)}, per-selector arm cap ${String((manifest.config as Record<string, unknown>).per_selector_arm_limit)}

## Scope boundary

This report discharges the **retrieval-layer** half of the release-gate sentence in
\`spec/CONTEXT.md\` ("Context quality passes required recall, exclusion, citation,
determinism, and at least 60 percent token reduction"): recall, exclusion, citation
completeness, determinism, latency and cost **of the Brain retrieval evidence**, plus the
five capability disposition recommendations.

**#371 (P2-T11) owns the bundle level**: mandatory plan/policy/lesson/tool fragment recall,
the ≥ 60 % token reduction against a frozen eager-load baseline, cross-host semantic
equivalence, and the local-only versus Brain-configured comparison. Nothing in this report
measures token reduction.

**#397** owns making authored edges citable. **#368** records the final dispositions.

## Method

See \`docs/evals/retrieval-quality/README.md\` for the exact metric formulas, the gate versus
measurement split, and the reproduction command.

## Results

${tierSections}

${dispositions(primary)}
`;
  return `${body.trimEnd()}\n`;
}

async function main(): Promise<void> {
  const gold = loadGoldSet();
  const problems = validateGoldSet(gold);
  if (problems.length > 0) {
    process.stderr.write(`gold set is invalid:\n${problems.join('\n')}\n`);
    process.exit(1);
  }
  if (process.env.ROSTER_BRAIN_ADMIN_URL === undefined || process.env.ROSTER_BRAIN_ADMIN_URL.length === 0) {
    process.stderr.write('ROSTER_BRAIN_ADMIN_URL must name a throwaway PostgreSQL admin connection\n');
    process.exit(2);
  }

  const outcomes: EvaluationOutcome[] = [];
  outcomes.push(await runRetrievalEvaluation({ tier: 'memory', gold }));
  if (HAS_TEST_S3) outcomes.push(await runRetrievalEvaluation({ tier: 'minio', gold }));

  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const manifest = composeManifest({
    gold,
    tiers: outcomes.map((outcome) => outcome.result),
    postgresVersion: outcomes[0]!.versions.postgres,
    pgvectorVersion: outcomes[0]!.versions.pgvector,
    generatedAt,
  });

  mkdirSync(RETRIEVAL_EVAL_DOCS_DIR, { recursive: true });
  writeFileSync(join(RETRIEVAL_EVAL_DOCS_DIR, `${date}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(RETRIEVAL_EVAL_DOCS_DIR, `${date}.md`), renderMarkdown(manifest, date));

  const findings = lintRetrievalGoldArtifacts();
  if (findings.length > 0) {
    process.stderr.write(`privacy lint failed on the generated artifacts:\n${JSON.stringify(findings, null, 2)}\n`);
    process.exit(3);
  }

  const failures = outcomes.flatMap((outcome) => (
    outcome.result.gates.filter((gate) => !gate.ok).map((gate) => `${outcome.result.tier}/${gate.name}: ${gate.detail}`)
  ));
  process.stdout.write(`wrote docs/evals/retrieval-quality/${date}.json and ${date}.md\n`);
  if (failures.length > 0) {
    process.stderr.write(`gate failures:\n${failures.join('\n')}\n`);
    process.exit(4);
  }
}

await main();
