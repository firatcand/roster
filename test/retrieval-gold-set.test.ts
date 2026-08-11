import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The lint's own false-NEGATIVE suite. Each case writes an adversarial artifact
// into a throwaway root shaped like the real scan scope, so the real fixtures
// stay untouched.
function adversarialRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-gold-lint-'));
  mkdirSync(join(root, 'test', 'fixtures', 'retrieval-gold'), { recursive: true });
  mkdirSync(join(root, 'docs', 'evals', 'retrieval-quality'), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    writeFileSync(join(root, relative), contents);
  }
  return root;
}

test('the lint fails a digest parked at an undeclared JSON position', () => {
  const digest = 'a'.repeat(64);
  const root = adversarialRoot({
    'test/fixtures/retrieval-gold/corpus.json': JSON.stringify({
      sources: [{ revisions: [{ rawSha256: digest, body: `leaked ${digest} here` }] }],
    }),
  });
  const findings = lintRetrievalGoldArtifacts(root);
  const rules = findings.map((entry) => entry.rule);
  // The declared `rawSha256` position is exempt; the same value inside a body is
  // not — the exemption is POINTER-scoped, never shape-only, inside JSON.
  assert.equal(rules.includes('unexpected-digest'), true, JSON.stringify(findings));
  assert.equal(findings.filter((entry) => entry.rule === 'unexpected-digest').length, 1);
});

test('the lint fails a real object id copied into a generated manifest field', () => {
  const root = adversarialRoot({
    'docs/evals/retrieval-quality/2020-01-01.json': JSON.stringify({
      git: { commit: 'b'.repeat(40) },
      fixture: { sha256: `sha256:${'c'.repeat(64)}` },
      note: `copied sha256:${'d'.repeat(64)} from a live workspace`,
    }),
  });
  const findings = lintRetrievalGoldArtifacts(root);
  assert.deepEqual(
    findings.map((entry) => entry.rule),
    ['unexpected-digest'],
    JSON.stringify(findings),
  );
});

test('the bare-host rule catches an unlisted-looking private host and documents its boundary', () => {
  const root = adversarialRoot({
    'docs/evals/retrieval-quality/2020-01-01.md': [
      'internal.example.xyz is a private host on a listed TLD',
      'http://internal.corp.local/path is a private host under a URL',
      'ops@internal.acme.systems is a private address',
    ].join('\n'),
  });
  const findings = lintRetrievalGoldArtifacts(root);
  const details = findings.map((entry) => `${entry.rule}:${entry.detail}`);
  assert.equal(details.includes('non-synthetic-host:internal.example.xyz'), true, JSON.stringify(findings));
  // Any scheme, any TLD: the URL rule is TLD-independent, so a host the closed
  // bare-host list cannot name is still caught when it appears as a URL.
  assert.equal(details.includes('non-synthetic-host:internal.corp.local'), true, JSON.stringify(findings));
  assert.equal(
    details.includes('non-synthetic-email:ops@internal.acme.systems'),
    true,
    JSON.stringify(findings),
  );
});

test('the bare-host contract boundary is a CLOSED TLD list, pinned honestly', () => {
  const root = adversarialRoot({
    'docs/evals/retrieval-quality/2020-01-01.md': 'bare internal.corp.local mentioned without a scheme\n',
  });
  // Documented limitation, not an accident: the artifacts legitimately contain
  // `context-retrieval.ts`, `corpus.json` and `brain.edges`, which a general
  // "dotted token ending in letters" rule cannot tell apart from a hostname.
  // Both READMEs state this, and the URL and email rules stay TLD-independent.
  assert.deepEqual(lintRetrievalGoldArtifacts(root), []);
});

test('the lint still passes the schema vocabulary and validated digests it must not flag', () => {
  const root = adversarialRoot({
    'test/fixtures/retrieval-gold/corpus.json': JSON.stringify({
      sources: [{
        revisions: [{
          rawSha256: 'e'.repeat(64),
          expectedChunkContentSha256s: ['f'.repeat(64)],
          body: 'The expectedChunkContentSha256s field name must not trip the entropy rule.',
        }],
      }],
    }),
    'docs/evals/retrieval-quality/README.md': 'Fields: expectedChunkContentSha256s, expectLabelScopeEligible.\n',
  });
  assert.deepEqual(lintRetrievalGoldArtifacts(root), []);
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
