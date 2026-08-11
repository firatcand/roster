import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBrainSourceBytes } from '../src/lib/brain/extractors.ts';
import { CONTEXT_RETRIEVAL_FILTER_REASONS } from '../src/lib/workspace-context.ts';
import {
  GATE_FAMILIES,
  GOLD_MISS_CLASSES,
  GOLD_QUERY_FAMILIES,
  SYNTHETIC_WORKSPACE_IDS,
  collapseToVersions,
  goldMediaType,
  goldRawBody,
  goldRevisions,
  lintRetrievalGoldArtifacts,
  loadGoldSet,
  macroAverage,
  ndcgAt,
  oracleHeadroomAt,
  precisionAt,
  privacyLintScope,
  recallAt,
  reciprocalRank,
  validateGoldSet,
} from './support/retrieval-gold.ts';

const gold = loadGoldSet();

test('the gold set parses and satisfies its structural contract', () => {
  assert.deepEqual(validateGoldSet(gold), []);
  assert.equal(gold.corpus.sources.length >= 90, true, 'the corpus must reach the planned scale');
  assert.equal(gold.queries.length >= 45, true, 'the query set must reach the planned scale');
  assert.deepEqual([...gold.corpus.identities.workspaceIds], [...SYNTHETIC_WORKSPACE_IDS]);
});

test('every revision body reproduces its recorded raw and chunk digests', () => {
  for (const source of gold.corpus.sources) {
    for (const revision of source.revisions) {
      const raw = goldRawBody(revision);
      const outcome = extractBrainSourceBytes(goldMediaType(revision), Buffer.from(raw, 'utf8'));
      assert.equal(outcome.status, 'complete', `${revision.fixtureVersionKey} must extract`);
      if (outcome.status !== 'complete') continue;
      assert.deepEqual(
        outcome.chunks.map((chunk) => chunk.contentSha256),
        [...revision.expectedChunkContentSha256s],
        `${revision.fixtureVersionKey} chunk digests`,
      );
    }
  }
});

test('the fixture discriminates every closed reason, miss class and family', () => {
  const reasons = new Set(gold.queries.flatMap((query) => (query.excluded ?? []).map((item) => item.reason)));
  assert.deepEqual([...reasons].sort(), [...CONTEXT_RETRIEVAL_FILTER_REASONS].sort());

  const missClasses = new Set(
    gold.queries.flatMap((query) => (query.membershipMisses ?? []).map((item) => item.missClass)),
  );
  assert.deepEqual([...missClasses].sort(), [...GOLD_MISS_CLASSES].sort());

  const families = new Set(gold.queries.map((query) => query.family));
  assert.deepEqual([...families].sort(), [...GOLD_QUERY_FAMILIES].sort());

  // Only the gate families may carry `excluded` contracts; a measured family
  // that gated an optional capability would turn it into a launch requirement.
  for (const query of gold.queries) {
    if (GATE_FAMILIES.includes(query.family)) continue;
    assert.deepEqual(query.excluded ?? [], [], `${query.id} is measured and must assert no exclusion`);
  }

  // Exactly one alias cluster is deliberately unrecoverable by alias expansion,
  // so the oracle delta can never be mistaken for a ceiling of 1.0.
  const aliasSurfaces = new Set(gold.corpus.aliases.flatMap((entry) => entry.aliases.map((alias) => alias.toLowerCase())));
  const revisions = goldRevisions(gold);
  const unrecoverable = gold.queries
    .filter((query) => query.family === 'alias-variant')
    .filter((query) => (query.membershipMisses ?? []).every((item) => {
      const body = goldRawBody(revisions.get(item.fixtureVersionKey)!.revision).toLowerCase();
      return ![...aliasSurfaces].some((alias) => body.includes(alias));
    }));
  assert.equal(unrecoverable.length, 1, 'exactly one alias cluster must sit outside the alias table');
});

test('the privacy lint passes over the fixtures and generated evaluation artifacts', () => {
  const findings = lintRetrievalGoldArtifacts();
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  // Scope is structural: the lint never reads its own module (whose denylist
  // literals would match themselves) nor the wider test tree.
  const scope = privacyLintScope();
  assert.equal(scope.length, 2);
  assert.equal(scope.some((entry) => entry.includes('retrieval-gold')), true);
  assert.equal(scope.some((entry) => entry.endsWith('retrieval-quality')), true);
  assert.equal(scope.some((entry) => entry.includes('support')), false);
});

test('the collapse rule keeps first occurrence per source version', () => {
  const collapsed = collapseToVersions([
    { sourceVersionId: 'v1' },
    { sourceVersionId: 'v2' },
    { sourceVersionId: 'v1' },
    { sourceVersionId: 'v3' },
  ]);
  assert.deepEqual(collapsed, ['v1', 'v2', 'v3']);
});

test('ranking metrics agree with hand-computed values', () => {
  const collapsed = ['a', 'b', 'c', 'd'];
  const relevant = new Set(['a', 'd', 'e']);

  assert.equal(recallAt(collapsed, relevant, 2), 1 / 3);
  assert.equal(recallAt(collapsed, relevant, 4), 2 / 3);
  assert.equal(recallAt([], relevant, 4), 0);
  assert.equal(recallAt([], new Set<string>(), 4), 1);

  assert.equal(precisionAt(collapsed, relevant, 2), 1 / 2);
  assert.equal(precisionAt(collapsed, relevant, 10), 2 / 4);
  // Empty delivery is precision 0, never a vacuous 1.
  assert.equal(precisionAt([], relevant, 10), 0);

  assert.equal(reciprocalRank(collapsed, relevant), 1);
  assert.equal(reciprocalRank(['x', 'b', 'd'], relevant), 1 / 3);
  assert.equal(reciprocalRank(['x', 'y'], relevant), 0);

  const grades = new Map([['a', 2], ['d', 1], ['e', 2]]);
  const dcg = 2 / Math.log2(2) + 1 / Math.log2(5);
  const idcg = 2 / Math.log2(2) + 2 / Math.log2(3) + 1 / Math.log2(4);
  assert.equal(ndcgAt(collapsed, grades, 10), dcg / idcg);
  assert.equal(ndcgAt(['x'], grades, 10), 0);

  // Capacity term = min(relevant anywhere in the delivered set, k) / |R|.
  assert.equal(oracleHeadroomAt(collapsed, relevant, 4), 2 / 3 - 2 / 3);
  assert.equal(oracleHeadroomAt(['x', 'y', 'a', 'd'], relevant, 2), 2 / 3 - 0);
  assert.equal(oracleHeadroomAt(['x', 'y', 'a', 'd'], relevant, 1), 1 / 3 - 0);
  assert.equal(oracleHeadroomAt(collapsed, new Set<string>(), 4), 0);

  assert.equal(macroAverage([1, 0, 0.5]), 0.5);
  assert.equal(macroAverage([]), 0);
});

test('every gate-family relevant item pins its selectors and arms', () => {
  for (const query of gold.queries) {
    if (!GATE_FAMILIES.includes(query.family)) continue;
    for (const item of query.relevant) {
      assert.equal(item.expectedSelectors.length > 0, true, `${query.id}/${item.fixtureVersionKey}`);
      assert.equal(item.expectedArms.length > 0, true, `${query.id}/${item.fixtureVersionKey}`);
    }
  }
});
