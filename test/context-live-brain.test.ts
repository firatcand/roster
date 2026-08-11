import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { parseWorkspaceRegistry } from '../src/lib/workspace-record.ts';
import { HAS_DB } from './brain-helpers.ts';
import {
  createRetrievalCorpus,
  ingestCorpusSource,
  runtimeUrlFor,
  type RetrievalCorpus,
} from './support/brain-retrieval-corpus.ts';
import { buildSocialManagerContextFixture } from './fixtures/social-manager-context/_setup.ts';

// #355 W1. No test on `origin/main` joined a live Brain database to the context
// resolver: `test/brain-context-retrieval.test.ts` builds its
// `ContextRetrievalRequest` objects BY HAND, never from a `roster.yaml` on disk.
// So two correctness properties held only by coincidence of independently
// written code, and this file converts both into observed facts:
//
//   1. Namespace fingerprint agreement — the registry parse DEFAULTS
//      `force_path_style` to false while the retrieval corpus previously
//      DECLARED it. The checked-in fixture registry declares neither
//      `force_path_style` nor `endpoint`, so it exercises both defaults through
//      `canonicalBrainNamespace`.
//   2. Selector/label agreement — the plan's authored `brain_selectors` must
//      reach the SQL through the eligible-label allowlist.
//
// The test drives the CLI rather than the read capability on purpose (D5):
// `test/static-boundaries.test.ts` pins the capability's importer set to
// exactly two test files, and spawning `roster context` is strictly stronger
// anyway — it covers argument parsing, exit codes, and single-line JSON.

const BIN = resolve('src/bin/roster.ts');
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 240_000 };

const TARGET = 'gtm/social-manager#opportunity-discovery';
const QUERY = 'Find timely conversations about reliable AI-assisted company operations.';
const EVIDENCE_TEXT = 'Reliable operations evidence about strong examples and steady company positioning.';
// The lexical membership predicate is built from the AUTHORED selector id plus
// its authored descriptions (`opportunity-discovery.yaml`), and
// `websearch_to_tsquery` ANDs the words within each segment. A body only enters
// the pre-candidate set — and therefore the accounting — if it satisfies that
// predicate, so every seeded source carries the authored phrase verbatim.
const REQUIRED_SELECTOR_PHRASE = 'Previously successful replies and their source posts.';

type CliResult = { status: number; stdout: string; stderr: string };

function runContext(
  root: string,
  brainUrl: string,
  args: readonly string[] = [],
): CliResult {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      BIN,
      'context',
      TARGET,
      '--query',
      QUERY,
      '--json',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ROSTER_BRAIN_URL: brainUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function contextJson(result: CliResult): Record<string, unknown> {
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout.trimEnd().split('\n').length,
    1,
    `stdout was not one line: ${result.stdout}`,
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

type LiveWorkspace = Readonly<{
  root: string;
  corpus: RetrievalCorpus;
  brainUrl: string;
  cleanup: () => Promise<void>;
}>;

// The identity is DERIVED from the workspace on disk through the production
// parse, never restated by the test. That is the whole point: if the registry
// parse and the authority derivation ever disagree about a defaulted field,
// bootstrap and retrieval land on different namespace fingerprints and every
// assertion below fails loudly.
async function liveWorkspace(): Promise<LiveWorkspace> {
  const fixture = buildSocialManagerContextFixture();
  const registry = parseWorkspaceRegistry(readFileSync(join(fixture.root, 'roster.yaml'), 'utf8'));
  assert.equal(registry.workspace_id, 'social-manager-context');
  assert.notEqual(registry.brain, undefined);
  assert.equal(registry.brain!.storage.force_path_style, false);
  assert.equal(Object.hasOwn(registry.brain!.storage, 'endpoint'), false);

  const corpus = await createRetrievalCorpus({
    workspaceId: registry.workspace_id,
    brainConfig: registry.brain!,
  });
  return Object.freeze({
    root: fixture.root,
    corpus,
    brainUrl: runtimeUrlFor(corpus),
    cleanup: async () => {
      await corpus.close();
      fixture.cleanup();
    },
  });
}

function planScopeLabels(): readonly { workspace: string; function: string; agent: string; plan: string }[] {
  return [{
    workspace: 'social-manager-context',
    function: 'gtm',
    agent: 'social-manager',
    plan: 'opportunity-discovery',
  }];
}

async function seedEligible(live: LiveWorkspace): Promise<{ sourceVersionId: string; sourceId: string }> {
  const required = await ingestCorpusSource(live.corpus, {
    stableKey: 'live-strong-examples',
    // The authored selector `strong-examples` is REQUIRED in the fixture plan,
    // and its authored description is what the membership predicate is built
    // from. This body has to satisfy that predicate through the real catalog.
    body: `${REQUIRED_SELECTOR_PHRASE} ${EVIDENCE_TEXT}`,
    labels: [...planScopeLabels()],
  });
  await ingestCorpusSource(live.corpus, {
    stableKey: 'live-company-positioning',
    body: `Current company positioning and target audience for reliable operations. ${EVIDENCE_TEXT}`,
    labels: [...planScopeLabels()],
  });
  return { sourceVersionId: required.sourceVersionId, sourceId: required.sourceId };
}

test('live Brain retrieval reaches the CLI bundle with a complete citation envelope', options, async (t) => {
  const live = await liveWorkspace();
  try {
    const eligible = await seedEligible(live);

    await t.test('the bundle carries cited, untrusted Brain evidence', () => {
      const context = contextJson(runContext(live.root, live.brainUrl));
      const evidence = context['brain_evidence'] as readonly Record<string, unknown>[];
      assert.equal(evidence.length > 0, true, 'live retrieval returned no evidence');
      for (const entry of evidence) {
        assert.equal(entry['trust'], 'brain-extract-untrusted');
        assert.deepEqual(Object.keys(entry['citation'] as Record<string, unknown>), [
          'logical_source_id',
          'source_version_id',
          'object_id',
          'extractor_id',
          'extractor_version',
          'locator',
          'content_hash',
        ]);
      }
      assert.equal(
        evidence.some((entry) => (
          (entry['citation'] as Record<string, unknown>)['source_version_id'] === eligible.sourceVersionId
        )),
        true,
      );
      assert.equal((context['workspace'] as Record<string, unknown>)['brain_configured'], true);
    });

    await t.test('the required authored selector is matched and fully covered', () => {
      const context = contextJson(runContext(live.root, live.brainUrl));
      const evidence = context['brain_evidence'] as readonly Record<string, unknown>[];
      assert.equal(
        evidence.some((entry) => entry['retrieval_reason'] === 'required-selector-match'),
        true,
        'the authored required selector never reached the SQL',
      );
      const budget = context['budget'] as Record<string, unknown>;
      assert.equal(budget['required_selectors_unmatched'], 0);
      assert.equal(budget['required_selectors_truncated'], 0);
    });

    await t.test('two consecutive invocations are byte-identical', () => {
      const first = runContext(live.root, live.brainUrl);
      const second = runContext(live.root, live.brainUrl);
      assert.equal(first.status, 0);
      assert.equal(first.stdout, second.stdout);
    });
  } finally {
    await live.cleanup();
  }
});

test('live retrieval accounts every pre-candidate exclusion exactly', options, async () => {
  const live = await liveWorkspace();
  try {
    await seedEligible(live);

    // One source per filter reason the corpus can construct locally. The
    // accounting assertion below is EXACT by contract (D8), not by corpus
    // smallness: the union counts each matching chunk once, whichever arm or
    // selector reached it.
    const tombstoned = await ingestCorpusSource(live.corpus, {
      stableKey: 'live-tombstoned',
      body: `${REQUIRED_SELECTOR_PHRASE} Later withdrawn. ${EVIDENCE_TEXT}`,
      labels: [...planScopeLabels()],
    });
    const { tombstoneBrainSource } = await import('../src/lib/brain/source-lifecycle.ts');
    await tombstoneBrainSource(live.corpus.adminPool, {
      sourceId: tombstoned.sourceId,
      requestKey: 'live-tombstone',
      actor: { actorId: 'retrieval-corpus', assurance: 'host-attested', host: 'codex', sessionId: 'live' },
      reason: 'fixture tombstone',
      provenance: { fixture: 'context-live-brain' },
    });

    const superseded = await ingestCorpusSource(live.corpus, {
      stableKey: 'live-superseded',
      body: `${REQUIRED_SELECTOR_PHRASE} First revision. ${EVIDENCE_TEXT}`,
      labels: [...planScopeLabels()],
    });
    await ingestCorpusSource(live.corpus, {
      stableKey: 'live-superseded',
      body: `${REQUIRED_SELECTOR_PHRASE} Second revision. ${EVIDENCE_TEXT}`,
      labels: [...planScopeLabels()],
    });

    const secret = await ingestCorpusSource(live.corpus, {
      stableKey: 'live-secret',
      body: `${REQUIRED_SELECTOR_PHRASE} Held at secret privacy. ${EVIDENCE_TEXT}`,
      labels: [...planScopeLabels()],
      privacy: 'secret',
    });

    const expected = tombstoned.chunkIds.length
      + superseded.chunkIds.length
      + secret.chunkIds.length;

    const context = contextJson(runContext(live.root, live.brainUrl));
    const evidence = context['brain_evidence'] as readonly Record<string, unknown>[];
    const versions = new Set(evidence.map((entry) => (
      (entry['citation'] as Record<string, unknown>)['source_version_id']
    )));
    assert.equal(versions.has(tombstoned.sourceVersionId), false);
    assert.equal(versions.has(superseded.sourceVersionId), false);
    assert.equal(versions.has(secret.sourceVersionId), false);

    const budget = context['budget'] as Record<string, unknown>;
    // The echo was admitted, so the per-reason breakdown is present AND the
    // aggregate is authoritative — asserted together, since scalar #5 is what
    // discloses a withheld breakdown.
    assert.equal(budget['retrieval_report_omitted'], 0);
    assert.equal(budget['evidence_prefiltered'], expected);

    const diagnostics = context['diagnostics'] as readonly Record<string, unknown>[];
    const echo = diagnostics.find((entry) => entry['code'] === 'CONTEXT_EVIDENCE_FILTERED');
    assert.notEqual(echo, undefined);
    const filtered = (echo!['details'] as Record<string, unknown>)['filtered'] as Record<string, number>;
    assert.equal(filtered['tombstoned'], tombstoned.chunkIds.length);
    assert.equal(filtered['superseded'], superseded.chunkIds.length);
    assert.equal(filtered['privacy-incompatible'], secret.chunkIds.length);
    assert.equal(
      Object.values(filtered).reduce((total, count) => total + count, 0),
      budget['evidence_prefiltered'],
    );
  } finally {
    await live.cleanup();
  }
});

test('legacy-unverified evidence returns only under the opt-in and never gains authority', options, async () => {
  const live = await liveWorkspace();
  try {
    await seedEligible(live);
    // Synthesized here rather than depending on #384's backfill, which is what
    // makes legacy rows exist in a real workspace.
    const legacy = await ingestCorpusSource(live.corpus, {
      stableKey: 'live-legacy',
      body: `${REQUIRED_SELECTOR_PHRASE} Imported from a legacy archive. ${EVIDENCE_TEXT}`,
      labels: [...planScopeLabels()],
      trust: 'legacy-unverified',
    });

    const withoutFlag = contextJson(runContext(live.root, live.brainUrl));
    const withoutEntries = withoutFlag['brain_evidence'] as readonly Record<string, unknown>[];
    assert.equal(
      withoutEntries.some((entry) => (
        (entry['citation'] as Record<string, unknown>)['source_version_id'] === legacy.sourceVersionId
      )),
      false,
    );

    const withFlag = contextJson(runContext(live.root, live.brainUrl, ['--include-legacy-unverified']));
    const entries = withFlag['brain_evidence'] as readonly Record<string, unknown>[];
    const index = entries.findIndex((entry) => (
      (entry['citation'] as Record<string, unknown>)['source_version_id'] === legacy.sourceVersionId
    ));
    assert.equal(index >= 0, true, 'the opt-in did not return the legacy row');
    // It RETAINS its trust class — the opt-in requests it, it never promotes it
    // (spec/SPEC.md:559).
    assert.equal(entries[index]!['trust'], 'legacy-unverified');
    // ...and it is floored below every non-legacy candidate.
    assert.equal(
      entries.slice(0, index).every((entry) => entry['trust'] !== 'legacy-unverified'),
      true,
    );
    assert.equal(
      entries.slice(index).every((entry) => entry['trust'] === 'legacy-unverified'),
      true,
    );
  } finally {
    await live.cleanup();
  }
});

// Both mismatches are the fail-closed-but-NONFATAL contract of spec/SPEC.md:557:
// retrieval refuses, the local bundle still returns, and the refusal is
// disclosed by a mandatory warning. Each is asserted as the D3 #4 PAIRING —
// `evidence_prefiltered === 0` AND the mandatory diagnostic — never the zero
// alone, because a bare zero is exactly what would be indistinguishable from a
// measured "nothing was filtered".
test('a namespace mismatch stops retrieval without failing the bundle', options, async () => {
  const live = await liveWorkspace();
  try {
    await seedEligible(live);
    const registryPath = join(live.root, 'roster.yaml');
    const registry = YAML.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    const brain = registry['brain'] as Record<string, unknown>;
    // Same workspace identity, DIFFERENT namespace fingerprint.
    brain['storage'] = { ...(brain['storage'] as Record<string, unknown>), bucket: 'other-vault' };
    writeFileSync(registryPath, YAML.stringify(registry));

    const context = contextJson(runContext(live.root, live.brainUrl));
    assert.deepEqual(context['brain_evidence'], []);
    const diagnostics = context['diagnostics'] as readonly Record<string, unknown>[];
    const unavailable = diagnostics.find((entry) => entry['code'] === 'CONTEXT_EVIDENCE_UNAVAILABLE');
    assert.notEqual(unavailable, undefined, JSON.stringify(diagnostics));
    assert.equal(unavailable!['severity'], 'warning');
    assert.equal((unavailable!['details'] as Record<string, unknown>)['reason'], 'namespace-mismatch');
    assert.equal((context['budget'] as Record<string, unknown>)['evidence_prefiltered'], 0);
    // The local bundle is intact — a refused Brain is not a failed context.
    assert.equal((context['plan'] as Record<string, unknown>)['root_id'], 'gtm/social-manager#opportunity-discovery');
  } finally {
    await live.cleanup();
  }
});

test('an identity mismatch stops retrieval without failing the bundle', options, async () => {
  const live = await liveWorkspace();
  try {
    await seedEligible(live);
    const registryPath = join(live.root, 'roster.yaml');
    const registry = YAML.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    // The protected database identity keeps the ORIGINAL workspace id.
    registry['workspace_id'] = 'other-workspace-identity';
    writeFileSync(registryPath, YAML.stringify(registry));

    const context = contextJson(runContext(live.root, live.brainUrl));
    assert.deepEqual(context['brain_evidence'], []);
    const diagnostics = context['diagnostics'] as readonly Record<string, unknown>[];
    const unavailable = diagnostics.find((entry) => entry['code'] === 'CONTEXT_EVIDENCE_UNAVAILABLE');
    assert.notEqual(unavailable, undefined, JSON.stringify(diagnostics));
    assert.equal((unavailable!['details'] as Record<string, unknown>)['reason'], 'identity-mismatch');
    assert.equal((context['budget'] as Record<string, unknown>)['evidence_prefiltered'], 0);
  } finally {
    await live.cleanup();
  }
});
