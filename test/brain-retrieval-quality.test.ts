import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB } from './brain-helpers.ts';
import { HAS_TEST_S3, S3_SKIP_REASON } from './support/minio-brain-object-store.ts';
import { GATE_FAMILIES, loadGoldSet, validateGoldSet } from './support/retrieval-gold.ts';
import {
  LATENCY_BUDGET_MS,
  composeManifest,
  manifestComparisonProjection,
  runRetrievalEvaluation,
  type EvaluationOutcome,
  type ResultManifest,
  type TierResult,
} from './support/retrieval-eval-runner.ts';

const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 600_000 };
const s3Options = {
  skip: HAS_DB ? (HAS_TEST_S3 ? false : S3_SKIP_REASON) : 'ROSTER_BRAIN_ADMIN_URL not set',
  timeout: 600_000,
};

const gold = loadGoldSet();

let memoryCycleOne: ResultManifest | null = null;
let minioCycleOne: ResultManifest | null = null;

function manifestOf(outcome: EvaluationOutcome): ResultManifest {
  return composeManifest({
    gold,
    tiers: [outcome.result],
    postgresVersion: outcome.versions.postgres,
    pgvectorVersion: outcome.versions.pgvector,
    generatedAt: new Date().toISOString(),
  });
}

function report(t: { diagnostic: (message: string) => void }, result: TierResult): void {
  for (const family of result.families) {
    t.diagnostic(
      `${result.tier}/${family.family}: queries=${family.queries} `
      + `recall@8=${family.recall_at['8']} recall@64=${family.recall_at['64']} `
      + `joint@64=${family.joint_recall_at['64']} precision@8=${family.precision_at['8']} `
      + `mrr=${family.mrr} ndcg@10=${family.ndcg_at_10} headroom@8=${family.headroom_at['8']}`,
    );
  }
  for (const row of result.alias_oracle) {
    t.diagnostic(
      `${result.tier}/alias-oracle ${row.query} (${row.miss_class}): `
      + `baseline=${row.baseline_joint_recall_at_64} oracle=${row.oracle_joint_recall_at_64} `
      + `delta=${row.delta} recovered=${row.recovered}`,
    );
  }
  for (const row of result.multi_record) {
    t.diagnostic(`${result.tier}/one-hop-gap ${row.query}: anchor=${row.anchor_recall_at_64} joint=${row.joint_recall_at_64}`);
  }
  t.diagnostic(`${result.tier}/embedding-mechanics ${JSON.stringify(result.embedding_mechanics)}`);
  t.diagnostic(`${result.tier}/timings ${JSON.stringify(result.timings.per_family_max_of_five_ms)}`);
}

function assertTierGates(result: TierResult): void {
  assert.deepEqual(validateGoldSet(gold), []);
  const failures = result.gates.filter((entry) => !entry.ok);
  assert.deepEqual(
    failures.map((entry) => `${entry.name}: ${entry.detail}`),
    [],
  );

  assert.equal(result.citations.completeness, 1);
  assert.equal(result.citations.delivered > 0, true);
  assert.equal(result.citations.text_byte_reslices > 0, true, 'the @bytes re-slice proof must run');
  assert.equal(result.citations.structured_object_proofs > 0, true, 'the @object proof must run');
  assert.equal(result.privacy.secret_candidates, 0);
  assert.equal(result.privacy.legacy_unverified_without_optin, 0);
  // Graph availability is EVIDENCE, never a gate: asserting unavailability
  // would make a future citable graph arm fail this suite, which acceptance
  // criterion 5 forbids. Only the envelope's closed reason pair is gated, and
  // only for queries that reported the capability unavailable.
  assert.equal(result.graph_evidence.queries, gold.queries.length);
  assert.equal(
    result.graph_evidence.unavailable + result.graph_evidence.available,
    gold.queries.length,
  );

  const baseline = result.families.find((entry) => entry.family === 'baseline')!;
  assert.equal(baseline.recall_at['64'], 1, 'baseline Recall@64 must be 1.0');

  for (const measurement of result.queries) {
    assert.equal(measurement.deterministic, true, `${measurement.id} must be deterministic`);
    if (!GATE_FAMILIES.includes(measurement.family)) continue;
    assert.equal(measurement.exclusion_correct, true, `${measurement.id} exclusion accounting`);
    assert.deepEqual(measurement.contract_violations, [], measurement.id);
  }

  // The ordering families' headroom bound is a valid common ceiling only while
  // nothing was truncated: embedding scores fuse before the 64-candidate cap.
  for (const family of ['ordering', 'paraphrase-ordering'] as const) {
    const row = result.families.find((entry) => entry.family === family)!;
    assert.equal(row.max_truncated, 0, `${family} must deliver its whole pool`);
  }

  const allSix = result.queries.find((entry) => entry.id === 'exclusion-all-six-reasons')!;
  assert.deepEqual(allSix.filtered, {
    superseded: 1,
    tombstoned: 1,
    'scope-ineligible': 1,
    'privacy-incompatible': 1,
    'legacy-unverified': 1,
    'extractor-inactive': 1,
  });

  // A dual-arm dual-selector chunk that is FILTERED is counted exactly once —
  // the accounting-side UNION dedup proof.
  const filteredOnce = result.queries.find((entry) => entry.id === 'precedence-dual-arm-filtered-once')!;
  assert.equal(filteredOnce.filtered.tombstoned, 1);
  assert.equal(filteredOnce.returned, 0);

  // A dual-arm dual-selector chunk that is DELIVERED is one candidate carrying
  // the sorted selector union and no filtered entry at all.
  const deliveredOnce = result.queries.find((entry) => entry.id === 'precedence-dual-arm-delivered')!;
  assert.equal(deliveredOnce.returned, 1);
  assert.equal(deliveredOnce.delivered_versions, 1);
  assert.deepEqual(deliveredOnce.filtered, {
    superseded: 0,
    tombstoned: 0,
    'scope-ineligible': 0,
    'privacy-incompatible': 0,
    'legacy-unverified': 0,
    'extractor-inactive': 0,
  });

  const latency = Object.values(result.timings.per_family_max_of_five_ms);
  assert.equal(latency.every((value) => value < LATENCY_BUDGET_MS), true, JSON.stringify(latency));
}

test('memory tier — gold-set retrieval evaluation', options, async (t) => {
  const outcome = await runRetrievalEvaluation({ tier: 'memory', gold });
  report(t, outcome.result);
  assertTierGates(outcome.result);

  // The embedding arm is ORDERING-ONLY: it carries no selector claim, so with
  // nothing truncated it cannot change which chunks are delivered.
  if (outcome.result.embedding_mechanics.status === 'measured') {
    assert.equal(outcome.result.embedding_mechanics.truncated, 0);
    assert.equal(outcome.result.embedding_mechanics.delivered_set_changed, false);
    assert.equal(outcome.result.embedding_mechanics.embedding_arm_rows > 0, true);
  }

  memoryCycleOne = manifestOf(outcome);
});

test('memory tier — an independent rebuild reproduces the manifest', options, async (t) => {
  assert.notEqual(memoryCycleOne, null, 'the first memory-tier cycle must have run');
  const outcome = await runRetrievalEvaluation({ tier: 'memory', gold });
  assertTierGates(outcome.result);
  const second = manifestOf(outcome);
  assert.deepEqual(
    manifestComparisonProjection(second),
    manifestComparisonProjection(memoryCycleOne!),
  );
  t.diagnostic('memory tier rebuilt from scratch with an identical result manifest');
});

test('minio tier — gold-set retrieval evaluation against a real object service', s3Options, async (t) => {
  const outcome = await runRetrievalEvaluation({ tier: 'minio', gold });
  report(t, outcome.result);
  assertTierGates(outcome.result);
  minioCycleOne = manifestOf(outcome);
});

test('minio tier — an independent rebuild reproduces the manifest', s3Options, async (t) => {
  assert.notEqual(minioCycleOne, null, 'the first MinIO-tier cycle must have run');
  const outcome = await runRetrievalEvaluation({ tier: 'minio', gold });
  assertTierGates(outcome.result);
  const second = manifestOf(outcome);
  assert.deepEqual(
    manifestComparisonProjection(second),
    manifestComparisonProjection(minioCycleOne!),
  );
  t.diagnostic('MinIO tier rebuilt into a fresh bucket with an identical result manifest');
});
