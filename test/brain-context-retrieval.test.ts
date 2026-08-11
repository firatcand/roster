import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  BRAIN_LABEL_PROJECTION_SQL,
  BRAIN_RUNTIME_URL_ENV,
  PER_SELECTOR_ARM_LIMIT,
  TOTAL_CANDIDATE_LIMIT,
  retrieveBrainContextEvidence,
  retrieveBrainContextEvidenceWithTelemetry,
} from '../src/lib/brain/context-retrieval.ts';
import {
  assertBrainExtractionRegistry,
  assertBrainExtractionRegistryOnClient,
} from '../src/lib/brain/activation.ts';
import {
  loadBrainEmbeddingResolution,
  loadBrainEmbeddingResolutionOnClient,
  type EmbeddingAdapterRegistry,
} from '../src/lib/brain/embedding-provider.ts';
import { deriveEmbeddingSpecId, selectCurrentChunkEmbeddings } from '../src/lib/brain/embedding-index.ts';
import { setConfig } from '../src/lib/brain/config.ts';
import { mergeEntities } from '../src/lib/brain/merge.ts';
import { deriveLogicalSourceId, legacyRecordStableKey } from '../src/lib/brain/source-identity.ts';
import { tombstoneBrainSource } from '../src/lib/brain/source-lifecycle.ts';
import { VerifiedBrainPool, createVerifiedBrainPool } from '../src/lib/brain/workspace-authority.ts';
import { compareUnicodeCodePoints, type ContextRetrievalRequest } from '../src/lib/workspace-context.ts';
import { HAS_DB } from './brain-helpers.ts';
import {
  RETRIEVAL_WORKSPACE_ID,
  createRetrievalCorpus,
  ingestCorpusSource,
  runtimeUrlFor,
  structuredRecordBody,
  type RetrievalCorpus,
} from './support/brain-retrieval-corpus.ts';

const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 240_000 };

const TARGET = { functionId: 'gtm', agentId: 'social-manager', planId: 'opportunity-discovery' };
const CLOSURE = ['gtm/social-manager#opportunity-discovery'];

function request(
  corpus: RetrievalCorpus,
  overrides: Partial<ContextRetrievalRequest> = {},
): ContextRetrievalRequest {
  return {
    workspaceId: RETRIEVAL_WORKSPACE_ID,
    brainAuthority: {
      workspaceId: corpus.authority.workspaceId,
      fingerprintFormatVersion: corpus.authority.fingerprintFormatVersion,
      namespaceFingerprint: corpus.authority.namespaceFingerprint,
    },
    target: TARGET,
    planClosureQualifiedIds: CLOSURE,
    selectors: [
      { selector: 'strong-examples', origins: ['plan-selector'], required: true, descriptions: ['Successful replies.'] },
      { selector: 'company-positioning', origins: ['plan-selector'], required: false, descriptions: ['Positioning.'] },
    ],
    query: 'reliable operations evidence',
    stepHint: null,
    budgetTokens: 12_000,
    includeLegacyUnverified: false,
    ...overrides,
  };
}

function env(corpus: RetrievalCorpus): NodeJS.ProcessEnv {
  return { [BRAIN_RUNTIME_URL_ENV]: corpus.db.url };
}

const EVIDENCE_TEXT = 'Reliable operations evidence about strong examples and steady company positioning.';

async function seedEligible(corpus: RetrievalCorpus, suffix: string, overrides: {
  privacy?: 'public' | 'internal' | 'secret';
  trust?: 'brain-extract-untrusted' | 'legacy-unverified' | 'brain-structured';
  labels?: readonly { workspace: string; function?: string; agent?: string; plan?: string }[];
  body?: string;
} = {}): Promise<{ sourceId: string; sourceVersionId: string; chunkIds: readonly string[] }> {
  return await ingestCorpusSource(corpus, {
    stableKey: `evidence-${suffix}`,
    body: overrides.body ?? `${EVIDENCE_TEXT} Fixture ${suffix}.`,
    labels: overrides.labels ?? [{
      workspace: RETRIEVAL_WORKSPACE_ID,
      function: TARGET.functionId,
      agent: TARGET.agentId,
      plan: TARGET.planId,
    }],
    ...(overrides.privacy === undefined ? {} : { privacy: overrides.privacy }),
    ...(overrides.trust === undefined ? {} : { trust: overrides.trust }),
  });
}

test('acceptance 1 — retrieval returns only current, in-scope, non-secret, verified evidence', options, async (t) => {
  const corpus = await createRetrievalCorpus();
  try {
    const eligible = await seedEligible(corpus, 'eligible');
    await seedEligible(corpus, 'secret', { privacy: 'secret' });
    await seedEligible(corpus, 'legacy', { trust: 'legacy-unverified' });
    await seedEligible(corpus, 'foreign-function', {
      labels: [{ workspace: RETRIEVAL_WORKSPACE_ID, function: 'other' }],
    });
    await seedEligible(corpus, 'foreign-agent', {
      labels: [{ workspace: RETRIEVAL_WORKSPACE_ID, function: TARGET.functionId, agent: 'other-agent' }],
    });
    await seedEligible(corpus, 'out-of-closure-plan', {
      labels: [{
        workspace: RETRIEVAL_WORKSPACE_ID,
        function: TARGET.functionId,
        agent: TARGET.agentId,
        plan: 'never-selected',
      }],
    });

    await t.test('the eligible source is the only candidate', async () => {
      const evidence = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.equal(evidence.status, 'available');
      assert.deepEqual(
        evidence.candidates.map((entry) => entry.citation.source_version_id),
        [eligible.sourceVersionId],
      );
      assert.equal(evidence.candidates[0]!.trust, 'brain-extract-untrusted');
      assert.equal(evidence.candidates[0]!.privacy, 'internal');
      assert.deepEqual(evidence.candidates[0]!.label_keys, [
        `plan:${TARGET.functionId}/${TARGET.agentId}#${TARGET.planId}`,
      ]);
      assert.equal(evidence.report.unavailable_reason, null);
    });

    await t.test('a superseding version replaces the prior one', async () => {
      const next = await ingestCorpusSource(corpus, {
        stableKey: 'evidence-eligible',
        body: `${EVIDENCE_TEXT} Fixture eligible, revised.`,
        labels: [{
          workspace: RETRIEVAL_WORKSPACE_ID,
          function: TARGET.functionId,
          agent: TARGET.agentId,
          plan: TARGET.planId,
        }],
      });
      assert.notEqual(next.sourceVersionId, eligible.sourceVersionId);
      const evidence = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.deepEqual(
        evidence.candidates.map((entry) => entry.citation.source_version_id),
        [next.sourceVersionId],
      );
    });

    await t.test('a tombstone empties the bundle and an exact restore refills it', async () => {
      const tombstone = await tombstoneBrainSource(corpus.adminPool, {
        sourceId: eligible.sourceId,
        requestKey: 'tombstone-eligible',
        actor: { actorId: 'retrieval-corpus', assurance: 'host-attested', host: 'codex', sessionId: 'x' },
        reason: 'fixture tombstone',
        provenance: { fixture: 'brain-context-retrieval' },
      });
      const emptied = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.deepEqual(emptied.candidates, []);
      assert.equal(emptied.report.filtered.tombstoned > 0, true);

      await ingestCorpusSource(corpus, {
        stableKey: 'evidence-eligible',
        body: `${EVIDENCE_TEXT} Fixture eligible, restored.`,
        labels: [{
          workspace: RETRIEVAL_WORKSPACE_ID,
          function: TARGET.functionId,
          agent: TARGET.agentId,
          plan: TARGET.planId,
        }],
        requestKey: 'restore-eligible',
        expectedTombstoneId: tombstone.tombstoneId,
      });
      const refilled = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.equal(refilled.candidates.length, 1);
    });
  } finally {
    await corpus.close();
  }
});

test('acceptance 2 — legacy-unverified returns only under the explicit opt-in', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'verified');
    const legacy = await seedEligible(corpus, 'legacy', { trust: 'legacy-unverified' });

    const withoutFlag = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
    assert.equal(
      withoutFlag.candidates.some((entry) => entry.citation.source_version_id === legacy.sourceVersionId),
      false,
    );
    assert.equal(withoutFlag.report.filtered['legacy-unverified'] > 0, true);

    const withFlag = await retrieveBrainContextEvidence(
      request(corpus, { includeLegacyUnverified: true }),
      { env: env(corpus) },
    );
    const admitted = withFlag.candidates.find(
      (entry) => entry.citation.source_version_id === legacy.sourceVersionId,
    );
    assert.notEqual(admitted, undefined);
    assert.equal(admitted!.trust, 'legacy-unverified');
  } finally {
    await corpus.close();
  }
});

test('acceptance 3 — lexical and structured retrieval need no embedding provider', options, async (t) => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'lexical');
    const identity = legacyRecordStableKey({ kind: 'entity', entityKind: 'org', slug: 'acme' });
    await ingestCorpusSource(corpus, {
      stableKey: identity,
      structured: true,
      body: structuredRecordBody('entity', { kind: 'org', slug: 'acme', title: 'Acme', body: 'A record.' }, identity),
      labels: [{
        workspace: RETRIEVAL_WORKSPACE_ID,
        function: TARGET.functionId,
        agent: TARGET.agentId,
        plan: TARGET.planId,
      }],
    });

    const zeroEmbeddings = await corpus.adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM brain.chunk_embeddings`,
    );
    assert.equal(zeroEmbeddings.rows[0]!.count, '0');

    await t.test('embedding disabled is a closed mode status, not a failure', async () => {
      const evidence = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.equal(evidence.status, 'available');
      assert.deepEqual(evidence.report.modes.embedding, { status: 'disabled' });
      assert.deepEqual(evidence.report.modes.lexical, { status: 'used' });
      assert.deepEqual(evidence.report.modes.structured, { status: 'used' });
      assert.equal(evidence.candidates.length >= 1, true);
      assert.deepEqual(evidence.report.graph, {
        status: 'unavailable',
        reasons: ['no-cited-edge-relation', 'unmeasured'],
      });
    });

    await t.test('an unsupported provider and a missing credential surface closed reasons', async () => {
      const client = await corpus.adminPool.connect();
      try {
        await setConfig(client, 'embeddings.enabled', 'true');
      } finally {
        client.release();
      }
      const unsupported = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.deepEqual(unsupported.report.modes.embedding, {
        status: 'invalid-configuration',
        reason: 'unsupported-provider',
      });

      const adapters: EmbeddingAdapterRegistry = Object.freeze({
        openai: () => ({ status: 'credential-unavailable' as const }),
      });
      const credential = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters,
      });
      assert.deepEqual(credential.report.modes.embedding, { status: 'credential-unavailable' });

      const novel: EmbeddingAdapterRegistry = Object.freeze({
        openai: () => ({ status: 'invalid-configuration' as const, reason: 'z'.repeat(4_096) }),
      });
      const unrecognized = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters: novel,
      });
      assert.deepEqual(unrecognized.report.modes.embedding, {
        status: 'invalid-configuration',
        reason: 'unrecognized',
      });
      assert.equal(unrecognized.candidates.length >= 1, true);
    });

    await t.test('the structured arm alone retrieves a record by its addressable equality key', async () => {
      const structuredOnly = await retrieveBrainContextEvidence(
        request(corpus, {
          // No lexical overlap with the corpus text, so only the structured arm
          // can produce a hit.
          query: 'zzzz',
          selectors: [{
            selector: 'entity',
            origins: ['plan-selector'],
            required: true,
            descriptions: [],
          }],
        }),
        { env: env(corpus) },
      );
      assert.equal(structuredOnly.candidates.length, 1);
      assert.equal(structuredOnly.candidates[0]!.retrieval_modes.includes('structured'), true);
      assert.deepEqual(structuredOnly.report.required_selectors_with_matches, ['entity']);
    });
  } finally {
    await corpus.close();
  }
});

test('acceptance 4 — every candidate carries one immutable, recomputable citation', options, async (t) => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'cited');
    const evidence = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
    assert.equal(evidence.candidates.length, 1);
    const candidate = evidence.candidates[0]!;
    const row = await corpus.adminPool.query<{
      source_id: string;
      source_version_id: string;
      object_id: string;
      content: string;
      content_sha256: string;
      extractor_name: string;
      extractor_version: number;
      versions: string;
    }>(
      `SELECT chunk_row.source_id, chunk_row.source_version_id,
              chunk_row.object_id, chunk_row.content, chunk_row.content_sha256,
              chunk_row.extractor_name, chunk_row.extractor_version,
              (SELECT count(*)::text FROM brain.source_versions
                WHERE source_version_id = chunk_row.source_version_id) AS versions
         FROM brain.current_source_chunks chunk_row
        WHERE chunk_row.chunk_id = $1`,
      [candidate.candidate_id],
    );
    const projected = row.rows[0]!;
    assert.equal(projected.versions, '1');
    // The cited version must be the version the durable chunk row records — a
    // well-formed but WRONG source_version_id has to fail here.
    assert.equal(
      candidate.citation.source_version_id,
      projected.source_version_id,
      'the cited source_version_id is the chunk row own version',
    );
    assert.equal(candidate.citation.logical_source_id, projected.source_id);
    assert.equal(candidate.citation.object_id, projected.object_id);
    assert.equal(candidate.citation.extractor_id, projected.extractor_name);
    assert.equal(candidate.citation.extractor_version, String(projected.extractor_version));
    assert.equal(candidate.citation.content_hash, `sha256:${projected.content_sha256}`);
    assert.equal(candidate.content, projected.content);
    assert.match(
      candidate.citation.locator,
      /^chunk:sha256:[a-f0-9]{64}#\d+@bytes:\d+-\d+;lines:\d+-\d+$/,
    );

    // The locator RE-SLICES the exact immutable object bytes: fetch the object
    // the citation names, cut the byte range the locator encodes, and prove the
    // slice reproduces the candidate content and its content_hash.
    const parsed = /^chunk:(sha256:[a-f0-9]{64})#(\d+)@bytes:(\d+)-(\d+);lines:(\d+)-(\d+)$/
      .exec(candidate.citation.locator)!;
    assert.equal(parsed[1], candidate.candidate_id, 'the locator names its own chunk');
    const objectRow = await corpus.adminPool.query<{ sha256: string; size_bytes: string }>(
      `SELECT sha256, size_bytes::text FROM brain.source_objects WHERE object_id = $1`,
      [candidate.citation.object_id!],
    );
    const stored = await corpus.objectStore.readVerified({
      sha256: objectRow.rows[0]!.sha256,
      byteLength: Number(objectRow.rows[0]!.size_bytes),
    });
    assert.equal(stored.status, 'verified');
    const objectBytes = (stored as { bytes: Buffer }).bytes;
    assert.equal(
      `sha256:${createHash('sha256').update(objectBytes).digest('hex')}`,
      candidate.citation.object_id,
      'the fetched bytes are the exact immutable object the citation names',
    );
    const sliced = objectBytes.subarray(Number(parsed[3]), Number(parsed[4]));
    assert.equal(sliced.toString('utf8'), candidate.content, 'the byte range re-slices the candidate content');
    assert.equal(
      `sha256:${createHash('sha256').update(sliced).digest('hex')}`,
      candidate.citation.content_hash,
      'the re-sliced bytes recompute the cited content hash',
    );
    // The line range addresses the same slice.
    const precedingLines = objectBytes.subarray(0, Number(parsed[3])).toString('utf8').split('\n').length;
    assert.equal(precedingLines, Number(parsed[5]), 'the line range agrees with the byte range');

    await t.test('a structured record cites its raw region truthfully and hashes its rendered content', async () => {
      const identity = legacyRecordStableKey({ kind: 'entity', entityKind: 'org', slug: 'acme' });
      const rawJson = structuredRecordBody(
        'entity',
        { kind: 'org', slug: 'acme', title: 'Acme', body: 'A cited synthetic organization.' },
        identity,
      );
      await ingestCorpusSource(corpus, {
        stableKey: identity,
        structured: true,
        body: rawJson,
        labels: [{
          workspace: RETRIEVAL_WORKSPACE_ID,
          function: TARGET.functionId,
          agent: TARGET.agentId,
          plan: TARGET.planId,
        }],
      });
      const structuredEvidence = await retrieveBrainContextEvidence(
        request(corpus, {
          query: 'acme organization',
          selectors: [{ selector: 'entity', origins: ['plan-selector'], required: true, descriptions: [] }],
        }),
        { env: env(corpus) },
      );
      const record = structuredEvidence.candidates.find(
        (entry) => entry.retrieval_modes.includes('structured'),
      )!;
      assert.notEqual(record, undefined, 'the structured record must be retrievable');

      // A rendered projection is NOT a byte slice, so the locator says `@object:`
      // and never claims a re-slice it cannot satisfy.
      const structuredLocator =
        /^chunk:(sha256:[a-f0-9]{64})#(\d+)@object:(\d+)-(\d+);lines:(\d+)-(\d+)$/
          .exec(record.citation.locator);
      assert.notEqual(structuredLocator, null, `structured locator was ${record.citation.locator}`);
      assert.equal(record.citation.locator.includes('@bytes:'), false);

      const rawRow = await corpus.adminPool.query<{ sha256: string; size_bytes: string }>(
        `SELECT sha256, size_bytes::text FROM brain.source_objects WHERE object_id = $1`,
        [record.citation.object_id!],
      );
      const rawRead = await corpus.objectStore.readVerified({
        sha256: rawRow.rows[0]!.sha256,
        byteLength: Number(rawRow.rows[0]!.size_bytes),
      });
      assert.equal(rawRead.status, 'verified');
      const rawBytes = (rawRead as { bytes: Buffer }).bytes;

      // 1. The `@object:` region is the WHOLE immutable document, and the region
      //    hashes to the raw object identity the citation names.
      assert.equal(Number(structuredLocator![3]), 0);
      assert.equal(Number(structuredLocator![4]), rawBytes.byteLength);
      const rawRegion = rawBytes.subarray(Number(structuredLocator![3]), Number(structuredLocator![4]));
      assert.equal(
        `sha256:${createHash('sha256').update(rawRegion).digest('hex')}`,
        record.citation.object_id,
        'the cited raw region hashes to the immutable object identity',
      );
      assert.equal(rawRegion.toString('utf8'), rawJson);

      // 2. content_hash covers the RENDERED content, and that content is exactly
      //    the durable extraction chunk — so both halves of the contract are
      //    independently checkable.
      assert.equal(
        record.citation.content_hash,
        `sha256:${createHash('sha256').update(Buffer.from(record.content, 'utf8')).digest('hex')}`,
        'content_hash covers the rendered content',
      );
      const storedChunk = await corpus.adminPool.query<{
        content: string;
        content_sha256: string;
        source_version_id: string;
        source_id: string;
      }>(
        `SELECT chunk_row.content, chunk_row.content_sha256, chunk_row.source_version_id,
                chunk_row.source_id
           FROM brain.current_source_chunks chunk_row WHERE chunk_row.chunk_id = $1`,
        [record.candidate_id],
      );
      assert.equal(storedChunk.rows[0]!.content, record.content);
      assert.equal(`sha256:${storedChunk.rows[0]!.content_sha256}`, record.citation.content_hash);
      assert.equal(
        record.citation.source_version_id,
        storedChunk.rows[0]!.source_version_id,
        'the structured candidate cites the chunk row own version',
      );
      assert.equal(record.citation.logical_source_id, storedChunk.rows[0]!.source_id);

      // 3. The rendered content is a projection, NOT a slice — the very reason
      //    the locator may not say `@bytes:` here.
      assert.equal(rawRegion.toString('utf8') === record.content, false);
      assert.equal(record.content.startsWith('$'), true, 'roster-structured renders $-addressed lines');
    });
  } finally {
    await corpus.close();
  }
});

test('projection-correlation mutation — the LATERAL correlation is load-bearing', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    const eligible = await seedEligible(corpus, 'eligible-labels', {
      labels: [
        { workspace: RETRIEVAL_WORKSPACE_ID },
        { workspace: RETRIEVAL_WORKSPACE_ID, function: TARGET.functionId, agent: TARGET.agentId },
      ],
    });
    const narrow = await seedEligible(corpus, 'narrow-labels', {
      labels: [{
        workspace: RETRIEVAL_WORKSPACE_ID,
        function: TARGET.functionId,
        agent: TARGET.agentId,
        plan: TARGET.planId,
      }],
    });
    await seedEligible(corpus, 'foreign-labels', {
      labels: [{ workspace: RETRIEVAL_WORKSPACE_ID, function: 'other' }],
    });

    const expected = new Map<string, readonly string[]>([
      [eligible.sourceVersionId, [
        `agent:${TARGET.functionId}/${TARGET.agentId}`,
        'workspace',
      ]],
      [narrow.sourceVersionId, [`plan:${TARGET.functionId}/${TARGET.agentId}#${TARGET.planId}`]],
    ]);
    const expectedScope = new Map<string, string | undefined>([
      [eligible.sourceVersionId, undefined],
      [narrow.sourceVersionId, TARGET.planId],
    ]);

    const honest = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
    assert.equal(honest.candidates.length, 2);
    for (const candidate of honest.candidates) {
      const versionId = candidate.citation.source_version_id;
      assert.deepEqual([...candidate.label_keys], [...expected.get(versionId)!]);
      assert.equal(candidate.scope.plan, expectedScope.get(versionId));
    }

    // The mutation deletes the correlation from the LATERAL projection, so the
    // projection returns the workspace-wide label union.
    const mutated = BRAIN_LABEL_PROJECTION_SQL.replace(
      'WHERE l2.source_version_id = chunk_row.source_version_id',
      '',
    );
    assert.notEqual(mutated, BRAIN_LABEL_PROJECTION_SQL);
    const poisoned = await retrieveBrainContextEvidence(request(corpus), {
      env: env(corpus),
      labelProjectionSql: mutated,
    });
    const changed = poisoned.candidates.some((candidate) => {
      const versionId = candidate.citation.source_version_id;
      return JSON.stringify([...candidate.label_keys]) !== JSON.stringify([...expected.get(versionId)!])
        || candidate.scope.plan !== expectedScope.get(versionId);
    });
    assert.equal(
      changed || poisoned.status === 'unavailable',
      true,
      'the projection-correlation mutation must change the observed labels or fail the retrieval',
    );
  } finally {
    await corpus.close();
  }
});

test('M honesty at the source — the report names exactly the required selectors with matches', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'matched');
    const evidence = await retrieveBrainContextEvidence(
      request(corpus, {
        selectors: [
          { selector: 'reliable', origins: ['plan-selector'], required: true, descriptions: ['Reliable operations.'] },
          { selector: 'unmatched-topic', origins: ['plan-selector'], required: true, descriptions: ['Nothing matches.'] },
          { selector: 'company-positioning', origins: ['plan-selector'], required: false, descriptions: [] },
        ],
        query: 'reliable',
      }),
      { env: env(corpus) },
    );
    assert.deepEqual([...evidence.report.required_selectors_with_matches], ['reliable']);

    // Adapter-side containment restricted to what was delivered.
    const required = new Set(['reliable', 'unmatched-topic']);
    const matched = new Set(evidence.report.required_selectors_with_matches);
    for (const candidate of evidence.candidates) {
      for (const selector of candidate.selectors) {
        if (required.has(selector)) assert.equal(matched.has(selector), true);
      }
    }
  } finally {
    await corpus.close();
  }
});

test('M honesty under overflow — M exceeds the delivered cap in strict ascending order', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    const selectorIds = Array.from({ length: 70 }, (_, index) => `topic-${String(index).padStart(2, '0')}`);
    for (const selector of selectorIds) {
      await ingestCorpusSource(corpus, {
        stableKey: `overflow-${selector}`,
        body: `Distinct evidence about ${selector} within reliable operations.`,
        labels: [{
          workspace: RETRIEVAL_WORKSPACE_ID,
          function: TARGET.functionId,
          agent: TARGET.agentId,
          plan: TARGET.planId,
        }],
      });
    }
    const evidence = await retrieveBrainContextEvidence(
      request(corpus, {
        query: 'reliable operations',
        selectors: selectorIds.map((selector) => ({
          selector,
          origins: ['plan-selector'] as const,
          required: true,
          descriptions: [],
        })),
      }),
      { env: env(corpus) },
    );
    assert.equal(evidence.candidates.length, TOTAL_CANDIDATE_LIMIT);
    assert.equal(evidence.report.required_selectors_with_matches.length, 70);
    const listed = [...evidence.report.required_selectors_with_matches];
    assert.deepEqual(listed, [...listed].sort(compareUnicodeCodePoints));
    assert.equal(new Set(listed).size, listed.length);
    const matched = new Set(listed);
    for (const candidate of evidence.candidates) {
      for (const selector of candidate.selectors) assert.equal(matched.has(selector), true);
    }
    assert.deepEqual(
      evidence.candidates.map((entry) => entry.retrieval_rank),
      Array.from({ length: TOTAL_CANDIDATE_LIMIT }, (_, index) => index),
    );
    assert.equal(evidence.report.truncated > 0, true);
    assert.equal(PER_SELECTOR_ARM_LIMIT, 8);
  } finally {
    await corpus.close();
  }
});

// The interception publishes a NEW version from a SEPARATE session strictly
// BETWEEN arm 1 and arm 2. Under REPEATABLE READ both arms keep the original
// snapshot; under READ COMMITTED arm 2 would observe the new version and the
// bundle would mix two versions of one logical source. The `isolation` knob is
// the mutation: the READ COMMITTED run MUST fail the same assertion.
async function retrieveWithInterleavedPublish(
  corpus: RetrievalCorpus,
  isolation: 'REPEATABLE READ' | 'READ COMMITTED',
  // Source-version identity is derived from content, so each interleaved
  // publish MUST carry distinct bytes; reusing the text would re-derive the
  // version already current and make the control pass vacuously.
  nonce: string,
): Promise<{ evidence: Awaited<ReturnType<typeof retrieveBrainContextEvidence>>; published: string | null; armsSeen: number }> {
  let published: string | null = null;
  let armsSeen = 0;
  const evidence = await retrieveBrainContextEvidence(request(corpus), {
    env: env(corpus),
    createPool: (connectionString, retrievalRequest) => {
      const pool = createVerifiedBrainPool({
        connectionString,
        authority: retrievalRequest.brainAuthority,
      });
      const connect = pool.connect.bind(pool);
      (pool as unknown as { connect: VerifiedBrainPool['connect'] }).connect = async () => {
        const client = await connect();
        const query = client.query.bind(client);
        (client as unknown as { query: typeof client.query }).query = (async (
          text: unknown,
          values?: unknown,
        ) => {
          const sql = typeof text === 'string' ? text : String((text as { text?: string }).text ?? '');
          // The isolation downgrade IS the mutation.
          if (sql.startsWith('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ')) {
            return await (query as (t: unknown, v?: unknown) => Promise<unknown>)(
              `BEGIN TRANSACTION ISOLATION LEVEL ${isolation} READ ONLY`,
            );
          }
          const isArm = sql.includes('current_source_chunks') && sql.includes('unnest');
          const result = await (query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values);
          // AFTER arm 1 has executed and BEFORE arm 2 runs.
          if (isArm) {
            armsSeen += 1;
            if (armsSeen === 1) {
              const next = await ingestCorpusSource(corpus, {
                stableKey: 'evidence-snapshot',
                body: `${EVIDENCE_TEXT} Fixture snapshot, revision ${nonce} published between arms.`,
                labels: [{
                  workspace: RETRIEVAL_WORKSPACE_ID,
                  function: TARGET.functionId,
                  agent: TARGET.agentId,
                  plan: TARGET.planId,
                }],
              });
              published = next.sourceVersionId;
            }
          }
          return result;
        }) as typeof client.query;
        return client;
      };
      return pool;
    },
  });
  return { evidence, published, armsSeen };
}

test('snapshot consistency — one repeatable-read snapshot serves every arm', options, async (t) => {
  const corpus = await createRetrievalCorpus();
  try {
    const first = await seedEligible(corpus, 'snapshot');

    await t.test('a version published BETWEEN arms is never mixed into the bundle', async () => {
      const run = await retrieveWithInterleavedPublish(corpus, 'REPEATABLE READ', 'alpha');
      assert.equal(run.armsSeen >= 2, true, 'the interception must sit between two arm statements');
      assert.notEqual(run.published, null, 'the concurrent session must have published a new version');
      assert.notEqual(run.published, first.sourceVersionId);
      const versions = new Set(run.evidence.candidates.map((entry) => entry.citation.source_version_id));
      assert.equal(versions.size, 1, 'a bundle must never mix two versions of one logical source');
      assert.equal(
        versions.has(first.sourceVersionId),
        true,
        'the repeatable-read snapshot must keep the version current when the transaction began',
      );
    });

    await t.test('the READ COMMITTED downgrade MUST fail the same interleaving', async () => {
      const run = await retrieveWithInterleavedPublish(corpus, 'READ COMMITTED', 'beta');
      assert.equal(run.armsSeen >= 2, true);
      assert.notEqual(run.published, null);
      const versions = new Set(run.evidence.candidates.map((entry) => entry.citation.source_version_id));
      // The mutation must be observable: either the bundle mixes versions, or it
      // silently swaps to the version published mid-retrieval. Both are exactly
      // what the snapshot exists to prevent, and neither can happen above.
      assert.equal(
        versions.size > 1 || versions.has(run.published!),
        true,
        'READ COMMITTED must observe the concurrent publish; if it did not, the snapshot test proves nothing',
      );
    });
  } finally {
    await corpus.close();
  }
});

test('one snapshot also serves the registry check, rrf_k, and the embedding resolution', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'config-flip');
    let flipped = false;
    const evidence = await retrieveBrainContextEvidence(request(corpus), {
      env: env(corpus),
      createPool: (connectionString, retrievalRequest) => {
        const pool = createVerifiedBrainPool({
          connectionString,
          authority: retrievalRequest.brainAuthority,
        });
        const connect = pool.connect.bind(pool);
        (pool as unknown as { connect: VerifiedBrainPool['connect'] }).connect = async () => {
          const client = await connect();
          const query = client.query.bind(client);
          (client as unknown as { query: typeof client.query }).query = (async (
            text: unknown,
            values?: unknown,
          ) => {
            const sql = typeof text === 'string' ? text : String((text as { text?: string }).text ?? '');
            const result = await (query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values);
            // Flip BOTH admin-owned inputs from a separate session immediately
            // after the in-transaction registry read. A second snapshot would
            // see the drift and fail the retrieval; one snapshot cannot.
            if (!flipped && sql.includes('brain.active_extractors')) {
              flipped = true;
              await corpus.adminPool.query(
                `UPDATE brain_meta.active_extractors SET active_version = active_version + 1
                  WHERE extractor_name = 'roster-text'`,
              );
              const configClient = await corpus.adminPool.connect();
              try {
                await setConfig(configClient, 'search.rrf_k', '999');
                await setConfig(configClient, 'embeddings.enabled', 'true');
              } finally {
                configClient.release();
              }
            }
            return result;
          }) as typeof client.query;
          return client;
        };
        return pool;
      },
    });
    assert.equal(flipped, true, 'the mid-retrieval flip must have executed');
    // The registry check passed inside the snapshot, so the retrieval completes
    // with evidence instead of registry-drift, and the embedding mode reflects
    // the PRE-flip configuration the snapshot pinned.
    assert.equal(evidence.status, 'available');
    assert.equal(evidence.report.unavailable_reason, null);
    assert.equal(evidence.candidates.length, 1);
    assert.deepEqual(evidence.report.modes.embedding, { status: 'disabled' });

    // A FRESH retrieval on a new snapshot now sees the drift and fails closed.
    const afterFlip = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
    assert.equal(afterFlip.status, 'unavailable');
    assert.equal(afterFlip.report.unavailable_reason, 'registry-drift');
  } finally {
    await corpus.close();
  }
});

test('#370 helper variants behave identically on a client and on a pool', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    const client = await corpus.adminPool.connect();
    try {
      await assert.doesNotReject(async () => await assertBrainExtractionRegistryOnClient(client));
      await assert.doesNotReject(async () => await assertBrainExtractionRegistry(corpus.activation));
      const onClient = await loadBrainEmbeddingResolutionOnClient(client);
      const onPool = await loadBrainEmbeddingResolution(corpus.activation);
      assert.deepEqual(onClient, onPool);

      // Memoization survives the delegation, and the drift error keeps its code.
      await corpus.adminPool.query(
        `UPDATE brain_meta.active_extractors SET active_version = active_version + 1
          WHERE extractor_name = 'roster-text'`,
      );
      await assert.doesNotReject(
        async () => await assertBrainExtractionRegistry(corpus.activation),
        'the memoized pool-based check keeps its cached success',
      );
      await assert.rejects(
        async () => await assertBrainExtractionRegistryOnClient(client),
        (error: unknown) => (error as { code?: string }).code === 'BRAIN_EXTRACTION_REGISTRY_DRIFT',
      );
      const drifted = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
      assert.equal(drifted.status, 'unavailable');
      assert.equal(drifted.report.unavailable_reason, 'registry-drift');
    } finally {
      client.release();
    }
  } finally {
    await corpus.close();
  }
});

// Any relation that holds company content or its labels. The authority
// handshake reads ONLY brain_meta.workspace_identity, so a mismatch must issue
// none of these.
const COMPANY_CONTENT_RELATIONS = [
  'current_source_chunks',
  'source_chunks',
  'source_extractions',
  'source_versions',
  'source_version_labels',
  'logical_sources',
  'chunk_embeddings',
] as const;

function companyContentSpy(corpus: RetrievalCorpus): {
  createPool: NonNullable<Parameters<typeof retrieveBrainContextEvidence>[1]>['createPool'];
  companyQueries: string[];
  verificationQueries: string[];
} {
  const companyQueries: string[] = [];
  const verificationQueries: string[] = [];
  return {
    companyQueries,
    verificationQueries,
    createPool: (connectionString, retrievalRequest) => {
      void corpus;
      // The spy is installed on the UNDERLYING pg.Pool, so the authority
      // handshake VerifiedBrainPool.connect() issues before returning a client
      // is observable. Wrapping the verified pool's connect would only see
      // statements made after the handshake had already run.
      const raw = new pg.Pool({ connectionString, max: 4 });
      const rawConnect = raw.connect.bind(raw);
      (raw as unknown as { connect: typeof raw.connect }).connect = (async () => {
        const client = await (rawConnect as () => Promise<pg.PoolClient>)();
        const query = client.query.bind(client);
        (client as unknown as { query: typeof client.query }).query = ((
          text: unknown,
          values?: unknown,
        ) => {
          const sql = typeof text === 'string' ? text : String((text as { text?: string }).text ?? '');
          const flat = sql.replace(/\s+/gu, ' ').slice(0, 120);
          if (sql.includes('workspace_identity')) verificationQueries.push(flat);
          if (COMPANY_CONTENT_RELATIONS.some((relation) => sql.includes(relation))) {
            companyQueries.push(flat);
          }
          return (query as (t: unknown, v?: unknown) => unknown)(text, values);
        }) as typeof client.query;
        return client;
      }) as typeof raw.connect;
      return new VerifiedBrainPool(raw, retrievalRequest.brainAuthority);
    },
  };
}

test('authority mismatches stop before any company-content read', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'protected');

    // The spy proves the negative directly: zero company-content statements are
    // issued when the handshake refuses.
    const foreignWorkspaceSpy = companyContentSpy(corpus);
    const foreignWorkspace = await retrieveBrainContextEvidence(
      request(corpus, {
        brainAuthority: {
          workspaceId: 'a-different-workspace',
          fingerprintFormatVersion: corpus.authority.fingerprintFormatVersion,
          namespaceFingerprint: corpus.authority.namespaceFingerprint,
        },
      }),
      { env: env(corpus), createPool: foreignWorkspaceSpy.createPool },
    );
    assert.equal(foreignWorkspace.status, 'unavailable');
    assert.equal(foreignWorkspace.report.unavailable_reason, 'identity-mismatch');
    assert.deepEqual(foreignWorkspace.candidates, []);
    assert.deepEqual(foreignWorkspaceSpy.companyQueries, []);
    assert.equal(
      foreignWorkspaceSpy.verificationQueries.length > 0,
      true,
      'the spy must observe the authority handshake it is proving stopped the read',
    );

    const foreignNamespaceSpy = companyContentSpy(corpus);
    const foreignNamespace = await retrieveBrainContextEvidence(
      request(corpus, {
        brainAuthority: {
          workspaceId: corpus.authority.workspaceId,
          fingerprintFormatVersion: corpus.authority.fingerprintFormatVersion,
          namespaceFingerprint: `sha256:${'1'.repeat(64)}`,
        },
      }),
      { env: env(corpus), createPool: foreignNamespaceSpy.createPool },
    );
    assert.equal(foreignNamespace.report.unavailable_reason, 'namespace-mismatch');
    assert.deepEqual(foreignNamespaceSpy.companyQueries, []);
    assert.equal(foreignNamespaceSpy.verificationQueries.length > 0, true);

    // The spy is only meaningful if it FIRES on the accepted path.
    const acceptedSpy = companyContentSpy(corpus);
    const accepted = await retrieveBrainContextEvidence(
      request(corpus),
      { env: env(corpus), createPool: acceptedSpy.createPool },
    );
    assert.equal(accepted.status, 'available');
    assert.equal(acceptedSpy.companyQueries.length > 0, true, 'the spy must observe the accepted path');
    assert.equal(acceptedSpy.verificationQueries.length > 0, true);

    const noCredential = await retrieveBrainContextEvidence(request(corpus), { env: {} });
    assert.equal(noCredential.report.unavailable_reason, 'credential-unavailable');
  } finally {
    await corpus.close();
  }
});

test('an unavailable result never claims a mode ran', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'never-used');
    const noArmClaimsUsed = (evidence: Awaited<ReturnType<typeof retrieveBrainContextEvidence>>): void => {
      assert.equal(evidence.status, 'unavailable');
      for (const mode of ['structured', 'lexical', 'embedding'] as const) {
        assert.notEqual(
          evidence.report.modes[mode].status,
          'used',
          `${mode} claimed it ran on an unavailable result`,
        );
      }
      assert.deepEqual(evidence.candidates, []);
    };

    // 1. Missing credential — the exact closed value fits.
    const noCredential = await retrieveBrainContextEvidence(request(corpus), { env: {} });
    noArmClaimsUsed(noCredential);
    assert.equal(noCredential.report.unavailable_reason, 'credential-unavailable');
    for (const mode of ['structured', 'lexical', 'embedding'] as const) {
      assert.deepEqual(noCredential.report.modes[mode], { status: 'credential-unavailable' });
    }

    // 2. Authority refusal.
    const foreign = await retrieveBrainContextEvidence(
      request(corpus, {
        brainAuthority: {
          workspaceId: 'a-different-workspace',
          fingerprintFormatVersion: corpus.authority.fingerprintFormatVersion,
          namespaceFingerprint: corpus.authority.namespaceFingerprint,
        },
      }),
      { env: env(corpus) },
    );
    noArmClaimsUsed(foreign);
    assert.equal(foreign.report.unavailable_reason, 'identity-mismatch');

    // 3. Transaction failure — the registry check inside the snapshot refuses.
    await corpus.adminPool.query(
      `UPDATE brain_meta.active_extractors SET active_version = active_version + 1
        WHERE extractor_name = 'roster-text'`,
    );
    const drifted = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
    noArmClaimsUsed(drifted);
    assert.equal(drifted.report.unavailable_reason, 'registry-drift');
  } finally {
    await corpus.close();
  }
});

test('an arm with nothing to run reports disabled, never used', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'no-selectors');
    // An empty catalog means neither the structured nor the lexical statement is
    // issued, so neither may claim `used`.
    const evidence = await retrieveBrainContextEvidence(
      request(corpus, { selectors: [] }),
      { env: env(corpus) },
    );
    assert.equal(evidence.status, 'available');
    assert.deepEqual(evidence.report.modes.structured, { status: 'disabled' });
    assert.deepEqual(evidence.report.modes.lexical, { status: 'disabled' });
    assert.deepEqual(evidence.candidates, []);
  } finally {
    await corpus.close();
  }
});

test('the runtime credential retrieves an identical bundle and writes nothing', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'runtime');
    const admin = await retrieveBrainContextEvidence(request(corpus), { env: env(corpus) });
    const runtime = await retrieveBrainContextEvidence(request(corpus), {
      env: { [BRAIN_RUNTIME_URL_ENV]: runtimeUrlFor(corpus) },
    });
    assert.deepEqual(runtime, admin);
    assert.equal(runtime.candidates.length, 1);

    // A real read-only proof: snapshot every mutable relation BEFORE retrieval
    // and compare AFTER, plus a transaction-id check that no write transaction
    // was assigned by the runtime path.
    const snapshot = async (): Promise<Record<string, string>> => {
      const row = await corpus.adminPool.query<Record<string, string>>(
        `SELECT (SELECT count(*)::text FROM brain.source_chunks) AS chunks,
                (SELECT count(*)::text FROM brain.source_versions) AS versions,
                (SELECT count(*)::text FROM brain.source_objects) AS objects,
                (SELECT count(*)::text FROM brain.source_extractions) AS extractions,
                (SELECT count(*)::text FROM brain.source_version_labels) AS labels,
                (SELECT count(*)::text FROM brain.logical_sources) AS sources,
                (SELECT count(*)::text FROM brain.ingest_intents) AS intents,
                (SELECT count(*)::text FROM brain.chunk_embeddings) AS embeddings,
                (SELECT coalesce(max(source_version_id), '') FROM brain.source_versions) AS max_version`,
      );
      return row.rows[0]!;
    };
    const before = await snapshot();
    const readOnly = await retrieveBrainContextEvidence(request(corpus), {
      env: { [BRAIN_RUNTIME_URL_ENV]: runtimeUrlFor(corpus) },
    });
    assert.equal(readOnly.status, 'available');
    const afterCounts = await snapshot();
    assert.deepEqual(afterCounts, before, 'retrieval mutated durable state');

    // Structural proof that the retrieval path CANNOT write, independent of any
    // shared-cluster timing: the runtime role physically holds no write grant on
    // a single relation the arms touch. (A transaction-id check would be
    // cluster-wide and would drift under concurrent test files.)
    const grants = await corpus.adminPool.query<{ relation: string; writable: boolean }>(
      `SELECT relation,
              bool_or(has_table_privilege($1, relation, privilege)) AS writable
         FROM unnest(ARRAY[
                'brain.source_chunks', 'brain.source_extractions', 'brain.source_versions',
                'brain.source_version_labels', 'brain.logical_sources', 'brain.source_objects',
                'brain.chunk_embeddings', 'brain.embedding_indexes'
              ]) AS relation,
              unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege
        GROUP BY relation
        ORDER BY relation`,
      [corpus.runtimeRole],
    );
    assert.equal(grants.rows.length, 8);
    assert.deepEqual(
      grants.rows.filter((row) => row.writable).map((row) => row.relation),
      [],
      'the runtime role must hold no write privilege on any relation retrieval reads',
    );

    // The control: a real write DOES move both, so the proof is not vacuous.
    await ingestCorpusSource(corpus, {
      stableKey: 'runtime-write-control',
      body: `${EVIDENCE_TEXT} Write control.`,
      labels: [{
        workspace: RETRIEVAL_WORKSPACE_ID,
        function: TARGET.functionId,
        agent: TARGET.agentId,
        plan: TARGET.planId,
      }],
    });
    assert.notDeepEqual(await snapshot(), before, 'the snapshot must be sensitive to a real write');
  } finally {
    await corpus.close();
  }
});

test('retrieval is deterministic, S3-free, and reports telemetry outside the bundle', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    await seedEligible(corpus, 'determinism-a');
    await seedEligible(corpus, 'determinism-b');
    const hostile = {
      [BRAIN_RUNTIME_URL_ENV]: corpus.db.url,
      AWS_ENDPOINT_URL: 'https://127.0.0.1:1',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    };
    const first = await retrieveBrainContextEvidence(request(corpus), { env: hostile });
    const second = await retrieveBrainContextEvidence(request(corpus), { env: hostile });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.candidates.length, 2);

    const withTelemetry = await retrieveBrainContextEvidenceWithTelemetry(request(corpus), { env: hostile });
    assert.equal(JSON.stringify(withTelemetry.evidence), JSON.stringify(first));
    assert.equal(Number.isFinite(withTelemetry.telemetry.totalMs), true);
    // No timing field can reach the evidence envelope.
    assert.equal(/(?:ms|duration|elapsed|telemetry)/i.test(JSON.stringify(
      Object.keys(withTelemetry.evidence.report),
    )), false);
  } finally {
    await corpus.close();
  }
});

test('acceptance 5 — one bounded bundle carries all four record kinds plus a document', options, async () => {
  const corpus = await createRetrievalCorpus();
  try {
    const labels = [{
      workspace: RETRIEVAL_WORKSPACE_ID,
      function: TARGET.functionId,
      agent: TARGET.agentId,
      plan: TARGET.planId,
    }];
    const entityIdentity = legacyRecordStableKey({ kind: 'entity', entityKind: 'org', slug: 'acme' });
    const factIdentity = legacyRecordStableKey({ kind: 'fact', entityKind: 'org', slug: 'acme', key: 'hq' });
    const eventIdentity = legacyRecordStableKey({ kind: 'event', id: '42' });
    const edgeIdentity = legacyRecordStableKey({
      kind: 'edge', fromKind: 'org', fromSlug: 'acme', rel: 'employs', toKind: 'person', toSlug: 'ada',
    });
    const records = [
      { identity: entityIdentity, kind: 'entity' as const, body: { kind: 'org', slug: 'acme', title: 'Acme', body: 'A synthetic organization.' } },
      { identity: factIdentity, kind: 'fact' as const, body: { subject: entityIdentity, subject_kind: 'org', subject_slug: 'acme', key: 'hq', value: 'Berlin', asserted: { source: null, confidence: null, actor: null } } },
      { identity: eventIdentity, kind: 'event' as const, body: { subject: null, subject_kind: null, subject_slug: null, kind: 'observed', payload: {}, event_key: '42', asserted: { actor: null } } },
      { identity: edgeIdentity, kind: 'edge' as const, body: { from: entityIdentity, from_kind: 'org', from_slug: 'acme', to: legacyRecordStableKey({ kind: 'entity', entityKind: 'person', slug: 'ada' }), to_kind: 'person', to_slug: 'ada', rel: 'employs', props: {}, asserted: { actor: null } } },
    ];
    for (const record of records) {
      await ingestCorpusSource(corpus, {
        stableKey: record.identity,
        structured: true,
        body: structuredRecordBody(record.kind, record.body, record.identity),
        labels,
      });
    }
    await ingestCorpusSource(corpus, {
      stableKey: 'markdown-document',
      body: '# Reliable operations\n\nA markdown document about strong examples and reliable operations.',
      labels,
    });

    const evidence = await retrieveBrainContextEvidence(
      request(corpus, {
        query: 'reliable operations acme',
        selectors: [
          { selector: 'entity', origins: ['plan-selector'], required: true, descriptions: [] },
          { selector: 'fact', origins: ['plan-selector'], required: true, descriptions: [] },
          { selector: 'event', origins: ['plan-selector'], required: true, descriptions: [] },
          { selector: 'edge', origins: ['plan-selector'], required: true, descriptions: [] },
          { selector: 'strong-examples', origins: ['plan-selector'], required: true, descriptions: ['Reliable operations.'] },
        ],
      }),
      { env: env(corpus) },
    );
    assert.equal(evidence.candidates.length >= 5, true);
    const versions = new Set(evidence.candidates.map((entry) => entry.citation.source_version_id));
    assert.equal(versions.size, evidence.candidates.length, 'every candidate cites a distinct version');
    for (const candidate of evidence.candidates) {
      assert.match(candidate.citation.logical_source_id, /^sha256:[a-f0-9]{64}$/);
      assert.match(candidate.citation.source_version_id, /^sha256:[a-f0-9]{64}$/);
      assert.match(candidate.citation.content_hash, /^sha256:[a-f0-9]{64}$/);
    }
    assert.deepEqual(
      [...evidence.report.required_selectors_with_matches].sort(compareUnicodeCodePoints),
      ['edge', 'entity', 'event', 'fact', 'strong-examples'],
    );
  } finally {
    await corpus.close();
  }
});

type FactRow = Readonly<{ id: string; slug: string; value: string; recordedAt: string }>;

// The v2 replay: one `source_versions` row per v1 `facts` row, published in the
// given order through the REAL ingest path as a §10 structured record.
async function replayFactSource(
  corpus: RetrievalCorpus,
  entityKind: string,
  slug: string,
  key: string,
  rows: readonly FactRow[],
  identitySlug = slug,
): Promise<Readonly<{ sourceId: string; identity: string; versionByFactId: Map<string, string> }>> {
  const identity = legacyRecordStableKey({ kind: 'fact', entityKind, slug: identitySlug, key });
  const versionByFactId = new Map<string, string>();
  let sourceId = '';
  for (const row of rows) {
    const body = {
      subject: legacyRecordStableKey({ kind: 'entity', entityKind, slug: identitySlug }),
      subject_kind: entityKind,
      subject_slug: identitySlug,
      key,
      value: row.value,
      asserted: { source: null, confidence: null, actor: null },
    };
    const envelope = JSON.stringify({
      envelope: 'roster.brain.record.v1',
      kind: 'fact',
      identity,
      body,
      legacy: { table: 'facts', id: row.id, recorded_at: row.recordedAt },
    });
    const published = await ingestCorpusSource(corpus, {
      stableKey: identity,
      structured: true,
      body: envelope,
      requestKey: `${identity}:${row.id}`,
      // The REAL #384 backfill metadata, per plan §10.3/§10.4: backfilled
      // records take trust_class `legacy-unverified` (so they are
      // default-excluded and floored when requested), a system-derived actor,
      // and the v1 `recorded_at` as the source version's source_timestamp.
      trust: 'legacy-unverified',
      sourceTimestamp: row.recordedAt,
      labels: [{
        workspace: RETRIEVAL_WORKSPACE_ID,
        function: TARGET.functionId,
        agent: TARGET.agentId,
        plan: TARGET.planId,
      }],
    });
    sourceId = published.sourceId;
    versionByFactId.set(row.id, published.sourceVersionId);
  }
  return Object.freeze({ sourceId, identity, versionByFactId });
}

async function currentVersionOf(corpus: RetrievalCorpus, sourceId: string): Promise<string> {
  const row = await corpus.adminPool.query<{ current_version_id: string }>(
    `SELECT current_version_id FROM brain.logical_sources WHERE source_id = $1`,
    [sourceId],
  );
  return row.rows[0]!.current_version_id;
}

// The head's own `legacy.id`, read back out of the durable structured extraction
// — the value #384's parity argument compares numerically as a bigint.
async function headLegacyId(corpus: RetrievalCorpus, sourceVersionId: string): Promise<string> {
  const row = await corpus.adminPool.query<{ legacy_id: string }>(
    `SELECT structured->'legacy'->>'id' AS legacy_id FROM brain.source_extractions
      WHERE source_version_id = $1 AND extractor_name = 'roster-structured'`,
    [sourceVersionId],
  );
  return row.rows[0]!.legacy_id;
}

async function insertMergeFacts(
  client: pg.PoolClient,
  entityId: string,
  entries: readonly Readonly<{ value: string; recordedAt: string }>[],
): Promise<FactRow[]> {
  const out: FactRow[] = [];
  for (const entry of entries) {
    const row = await client.query<{ id: string; slug: string }>(
      `INSERT INTO brain.facts (entity_id, key, value, recorded_at)
       VALUES ($1::bigint, 'hq', to_jsonb($2::text), $3::timestamptz)
       RETURNING id::text AS id, (SELECT slug FROM brain.entities WHERE id = $1::bigint) AS slug`,
      [entityId, entry.value, entry.recordedAt],
    );
    out.push({
      id: row.rows[0]!.id,
      slug: row.rows[0]!.slug,
      value: entry.value,
      recordedAt: entry.recordedAt,
    });
  }
  return out;
}

test('merge-view parity — resolved_current_facts selects the merged-away member head', options, async (t) => {
  const corpus = await createRetrievalCorpus();
  const client = await corpus.adminPool.connect();
  try {
    // STEP 1 — B (`org/acme`) gets TWO `hq` facts whose id order and
    // recorded_at order are DELIBERATELY inverted; A (`org/acme-inc`) gets one,
    // inserted LAST so it holds the greatest facts.id overall, with the
    // EARLIEST recorded_at. Cross-source order therefore disagrees too.
    const entityIds = new Map<string, string>();
    for (const slug of ['acme', 'acme-inc']) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO brain.entities (kind, slug, title, body) VALUES ('org', $1, $1, '{}'::jsonb)
         RETURNING id::text AS id`,
        [slug],
      );
      entityIds.set(slug, inserted.rows[0]!.id);
    }
    const b = entityIds.get('acme')!;
    const a = entityIds.get('acme-inc')!;
    const bFacts = await insertMergeFacts(client, b, [
      { value: 'Hamburg', recordedAt: '2024-03-03T00:00:00.000Z' },
      { value: 'Berlin', recordedAt: '2024-01-01T00:00:00.000Z' },
    ]);
    const aFacts = await insertMergeFacts(client, a, [
      { value: 'Munich', recordedAt: '2023-01-01T00:00:00.000Z' },
    ]);
    const [b1, b2] = bFacts;
    const a1 = aFacts[0]!;
    assert.equal(BigInt(b2!.id) > BigInt(b1!.id), true, 'B2 must hold the greater within-source id');
    assert.equal(BigInt(a1.id) > BigInt(b2!.id), true, 'A must hold the greatest id overall');
    assert.equal(new Date(b1!.recordedAt) > new Date(b2!.recordedAt), true, 'B order must be inverted');
    assert.equal(new Date(a1.recordedAt) < new Date(b2!.recordedAt), true, 'A must be the earliest');

    // STEP 2 — the pre-merge STABLE KEYS. These are the ingest identities the
    // logical source id is derived from; the assertions below compare both the
    // stable key AND the resulting `sourceId`, so name and comparison agree.
    const preMergeAcmeStableKey = legacyRecordStableKey({ kind: 'fact', entityKind: 'org', slug: 'acme', key: 'hq' });
    const preMergeAcmeIncStableKey = legacyRecordStableKey({ kind: 'fact', entityKind: 'org', slug: 'acme-inc', key: 'hq' });
    const logicalSourceIdFor = (stableKey: string): string => deriveLogicalSourceId(
      RETRIEVAL_WORKSPACE_ID,
      { kind: 'structured-record', stableKey },
    );
    const preMergeAcmeSourceId = logicalSourceIdFor(preMergeAcmeStableKey);
    const preMergeAcmeIncSourceId = logicalSourceIdFor(preMergeAcmeIncStableKey);

    // STEP 3 — merge A AWAY into B. The winner belongs to the NON-canonical
    // member, so an implementation that reads the canonical entity's own fact
    // fails right here.
    await mergeEntities(client, { kind: 'org', fromSlug: 'acme-inc', intoSlug: 'acme' });

    // STEP 4 — property M1: the view selects the globally greatest facts.id
    // across ALL merged members, not the greatest per member.
    const view = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM brain.resolved_current_facts
        WHERE canonical_id = $1::bigint AND key = 'hq'`,
      [b],
    );
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0]!.id, a1.id, 'M1: the view winner is the merged-away member fact');

    // STEP 5 — replay every facts row through the v2 contract, ascending
    // facts.id PER logical source, via the real ingest path.
    const replayedB = await replayFactSource(corpus, 'org', 'acme', 'hq',
      [...bFacts].sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1)));
    const replayedA = await replayFactSource(corpus, 'org', 'acme-inc', 'hq', aFacts);

    // STEP 6(a) — each member source's current_version_id cites the greatest
    // facts.id of ITS OWN member.
    const headB = await currentVersionOf(corpus, replayedB.sourceId);
    const headA = await currentVersionOf(corpus, replayedA.sourceId);
    assert.equal(headB, replayedB.versionByFactId.get(b2!.id));
    assert.equal(headA, replayedA.versionByFactId.get(a1.id));

    // STEP 7(b) — property M2: the numerically greatest legacy.id among the
    // member heads is exactly the id the view selected in step 4.
    const legacyB = await headLegacyId(corpus, headB);
    const legacyA = await headLegacyId(corpus, headA);
    assert.equal(legacyB, b2!.id);
    assert.equal(legacyA, a1.id);
    const greatest = BigInt(legacyA) > BigInt(legacyB) ? legacyA : legacyB;
    assert.equal(greatest, view.rows[0]!.id, 'M2: the greatest member head equals the view winner');

    // STEP 7(c) — merge invariance, on BOTH the stable key and the logical
    // source id it derives.
    assert.notEqual(replayedB.identity, replayedA.identity);
    assert.equal(replayedB.identity, preMergeAcmeStableKey);
    assert.equal(replayedA.identity, preMergeAcmeIncStableKey);
    assert.equal(replayedB.sourceId, preMergeAcmeSourceId);
    assert.equal(replayedA.sourceId, preMergeAcmeIncSourceId);
    assert.notEqual(replayedB.sourceId, replayedA.sourceId);

    // STEP 7(d) — backfilled records are `legacy-unverified`, so the DEFAULT
    // retrieval must not return them at all. That IS the product behavior.
    const defaultEvidence = await retrieveBrainContextEvidence(
      request(corpus, {
        query: 'acme hq',
        selectors: [{ selector: 'fact', origins: ['plan-selector'], required: true, descriptions: [] }],
      }),
      { env: env(corpus) },
    );
    assert.equal(
      defaultEvidence.candidates.some(
        (entry) => entry.citation.source_version_id === headA
          || entry.citation.source_version_id === headB,
      ),
      false,
      'a legacy-unverified backfill is default-excluded from retrieval',
    );
    assert.equal(defaultEvidence.report.filtered['legacy-unverified'] > 0, true);

    // The opt-in path returns them, labelled and floored, and the parity
    // assertions run against THAT bundle.
    const evidence = await retrieveBrainContextEvidence(
      request(corpus, {
        query: 'acme hq',
        includeLegacyUnverified: true,
        selectors: [{ selector: 'fact', origins: ['plan-selector'], required: true, descriptions: [] }],
      }),
      { env: env(corpus) },
    );
    const citedVersions = new Set(evidence.candidates.map((entry) => entry.citation.source_version_id));
    assert.equal(citedVersions.has(headA), true);
    assert.equal(citedVersions.has(headB), true);
    const replayedHeads = evidence.candidates.filter(
      (entry) => entry.citation.source_version_id === headA
        || entry.citation.source_version_id === headB,
    );
    assert.equal(replayedHeads.length, 2, 'both member heads must be in the opt-in bundle');
    assert.equal(
      replayedHeads.every((entry) => entry.trust === 'legacy-unverified'),
      true,
      'replayed backfill carries the legacy trust class',
    );
    assert.equal(
      new Set(evidence.candidates.map((entry) => entry.citation.logical_source_id)).size >= 2,
      true,
      'the two member sources stay distinct in the bundle',
    );

    await t.test('NEGATIVE 1 — replaying by recorded_at selects the wrong head for member B', async () => {
      const wrong = await createRetrievalCorpus();
      try {
        const byRecordedAt = [...bFacts].sort(
          (left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime(),
        );
        assert.notDeepEqual(
          byRecordedAt.map((row) => row.id),
          [...bFacts].sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1)).map((row) => row.id),
          'the fixture must make the two orderings disagree',
        );
        const replayed = await replayFactSource(wrong, 'org', 'acme', 'hq', byRecordedAt);
        const head = await currentVersionOf(wrong, replayed.sourceId);
        // Under the CORRECT replay the head is B2; under this one it is B1.
        assert.equal(head, replayed.versionByFactId.get(b1!.id));
        assert.notEqual(
          await headLegacyId(wrong, head),
          b2!.id,
          'a recorded_at-ordered backfill MUST select a different head — assertion 6(a) fails',
        );
      } finally {
        await wrong.close();
      }
    });

    await t.test('NEGATIVE 2 — the canonical-keyed replay actually breaks identity immutability', async () => {
      const canonical = await client.query<{ slug: string }>(
        `SELECT c.slug FROM brain.entities e JOIN brain.entities c ON c.id = e.canonical_id
          WHERE e.id = $1::bigint`,
        [a],
      );
      const canonicalSlug = canonical.rows[0]!.slug;
      assert.equal(canonicalSlug, 'acme', 'A is merged away, so its canonical slug is B');

      // Perform the WRONG replay for real, on a fresh corpus: member A's facts
      // keyed on the CANONICAL (kind, slug) instead of its own.
      const wrong = await createRetrievalCorpus();
      try {
        const wrongReplay = await replayFactSource(
          wrong, 'org', 'acme-inc', 'hq', aFacts, canonicalSlug,
        );
        // The winning fact id is UNCHANGED, which is exactly why asserting the
        // winner alone would not catch this defect...
        const wrongHead = await currentVersionOf(wrong, wrongReplay.sourceId);
        assert.equal(await headLegacyId(wrong, wrongHead), a1.id);
        // ...but member A's identity has moved, retroactively, because a later
        // merge changed the key it was derived from.
        assert.notEqual(
          wrongReplay.identity,
          preMergeAcmeIncStableKey,
          'canonical keying MUST change member A identity across the merge',
        );
        assert.notEqual(wrongReplay.sourceId, preMergeAcmeIncSourceId);
        // And it collapses A onto B's logical source.
        assert.equal(wrongReplay.identity, preMergeAcmeStableKey);
        assert.equal(wrongReplay.sourceId, preMergeAcmeSourceId);
      } finally {
        await wrong.close();
      }

      // The raw keying this ticket pins does neither.
      assert.equal(replayedA.identity, preMergeAcmeIncStableKey);
      assert.equal(replayedA.sourceId, preMergeAcmeIncSourceId);
      assert.notEqual(replayedA.identity, replayedB.identity);
    });

    await t.test('STEP 10 — a transitive merge repeats the property, and no resolved edge view exists', async () => {
      const cRow = await client.query<{ id: string }>(
        `INSERT INTO brain.entities (kind, slug, title, body)
         VALUES ('org', 'acme-holding', 'acme-holding', '{}'::jsonb) RETURNING id::text AS id`,
      );
      const c = cRow.rows[0]!.id;
      // The greatest facts.id now sits on the MIDDLE member of the chain.
      const middle = await insertMergeFacts(client, b, [
        { value: 'Leipzig', recordedAt: '2020-01-01T00:00:00.000Z' },
      ]);
      await mergeEntities(client, { kind: 'org', fromSlug: 'acme', intoSlug: 'acme-holding' });
      const transitive = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM brain.resolved_current_facts
          WHERE canonical_id = $1::bigint AND key = 'hq'`,
        [c],
      );
      assert.equal(transitive.rows[0]!.id, middle[0]!.id, 'the transitive winner is the middle member');

      const replayedMiddle = await replayFactSource(corpus, 'org', 'acme', 'hq', [middle[0]!]);
      const middleHead = await currentVersionOf(corpus, replayedMiddle.sourceId);
      assert.equal(await headLegacyId(corpus, middleHead), middle[0]!.id);
      assert.equal(replayedMiddle.identity, preMergeAcmeStableKey, 'identity survives the transitive merge too');

      const resolvedEdges = await client.query<{ absent: boolean }>(
        `SELECT to_regclass('brain.resolved_current_edges') IS NULL AS absent`,
      );
      assert.equal(resolvedEdges.rows[0]!.absent, true, 'no merge-resolved edge view exists');
    });
  } finally {
    client.release();
    await corpus.close();
  }
});

test('v1 version-ordering parity — current_facts and current_edges resolve by ascending id', options, async () => {
  const corpus = await createRetrievalCorpus();
  const client = await corpus.adminPool.connect();
  try {
    const entity = await client.query<{ id: string }>(
      `INSERT INTO brain.entities (kind, slug, title, body) VALUES ('org', 'ordering', 'ordering', '{}'::jsonb)
       RETURNING id::text AS id`,
    );
    const entityId = entity.rows[0]!.id;
    const ids: string[] = [];
    for (const [value, recordedAt] of [
      ['first', '2024-03-01T00:00:00.000Z'],
      ['second', '2024-01-01T00:00:00.000Z'],
      ['third', '2024-02-01T00:00:00.000Z'],
    ] as const) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO brain.facts (entity_id, key, value, recorded_at) VALUES ($1, 'k', to_jsonb($2::text), $3::timestamptz)
         RETURNING id::text AS id`,
        [entityId, value, recordedAt],
      );
      ids.push(row.rows[0]!.id);
    }
    const current = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM brain.current_facts WHERE entity_id = $1::bigint AND key = 'k'`,
      [entityId],
    );
    assert.equal(current.rows[0]!.id, ids.at(-1));

    const byRecordedAt = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM brain.facts WHERE entity_id = $1::bigint AND key = 'k'
        ORDER BY recorded_at DESC LIMIT 1`,
      [entityId],
    );
    assert.notEqual(
      byRecordedAt.rows[0]!.id,
      current.rows[0]!.id,
      'a recorded_at-ordered backfill MUST select a different head',
    );

    const other = await client.query<{ id: string }>(
      `INSERT INTO brain.entities (kind, slug, title, body) VALUES ('person', 'ada', 'ada', '{}'::jsonb)
       RETURNING id::text AS id`,
    );
    const edgeIds: string[] = [];
    for (const [props, recordedAt] of [
      ['{"n":1}', '2024-03-01T00:00:00.000Z'],
      ['{"n":2}', '2024-01-01T00:00:00.000Z'],
    ] as const) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO brain.edges (src_id, dst_id, rel, props, recorded_at)
         VALUES ($1::bigint, $2::bigint, 'employs', $3::jsonb, $4::timestamptz) RETURNING id::text AS id`,
        [entityId, other.rows[0]!.id, props, recordedAt],
      );
      edgeIds.push(row.rows[0]!.id);
    }
    const currentEdge = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM brain.current_edges
        WHERE src_id = $1::bigint AND dst_id = $2::bigint AND rel = 'employs'`,
      [entityId, other.rows[0]!.id],
    );
    assert.equal(currentEdge.rows[0]!.id, edgeIds.at(-1));
  } finally {
    client.release();
    await corpus.close();
  }
});

test('embedding parity — the adapter arm agrees with the TypeScript oracle', options, async (t) => {
  const corpus = await createRetrievalCorpus();
  const supportsVector = await corpus.adminPool
    .query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
    .then((result) => result.rows.length > 0)
    .catch(() => false);
  if (!supportsVector) {
    // CI runs pgvector/pgvector:pg16; a developer machine without the extension
    // skips this arm rather than failing the suite.
    await corpus.close();
    return;
  }
  try {
    for (const suffix of ['alpha', 'beta', 'gamma', 'delta']) await seedEligible(corpus, suffix);
    const dimensions = 4;
    // The config allowlist pins provider/model, so the fixture adapter answers
    // with exactly the configured identity and its spec IS registered — that is
    // what lets the ADAPTER's own arm run.
    const provider = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions,
      specVersion: 1,
      embed: async (texts: readonly string[]) => texts.map(() => [1, 0, 0, 0]),
    };
    const specId = deriveEmbeddingSpecId(provider);
    await corpus.adminPool.query(
      `INSERT INTO brain.embedding_indexes (embedding_spec_id, provider, model, dimensions, spec_version)
       VALUES ($1, $2, $3, $4, $5)`,
      [specId, provider.provider, provider.model, dimensions, provider.specVersion],
    );
    const chunks = await corpus.adminPool.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM brain.current_source_chunks ORDER BY chunk_id COLLATE "C"`,
    );
    assert.equal(chunks.rows.length >= 4, true);
    for (const [index, row] of chunks.rows.entries()) {
      // Distinct, deterministic vectors so the top-k order is a real ordering.
      const vector = [0, 0, 0, 0];
      vector[index % dimensions] = 1;
      vector[(index + 1) % dimensions] = 0.5 - index * 0.01;
      await corpus.adminPool.query(
        `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
        [row.chunk_id, specId, dimensions, `[${vector.join(',')}]`],
      );
    }
    const client = await corpus.adminPool.connect();
    try {
      await setConfig(client, 'embeddings.enabled', 'true');
    } finally {
      client.release();
    }
    const adapters: EmbeddingAdapterRegistry = Object.freeze({
      openai: () => ({ status: 'resolved' as const, provider }),
    });

    await t.test('the adapter arm runs and its order matches the TS oracle exactly', async () => {
      // Capture the ranked list the adapter's OWN embedding statement returns,
      // in the order the database produced it. Bundle order is the fused global
      // key, so it cannot stand in for the arm's ordering.
      const armOrder: string[] = [];
      const evidence = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters,
        createPool: (connectionString, retrievalRequest) => {
          const raw = new pg.Pool({ connectionString, max: 4 });
          const rawConnect = raw.connect.bind(raw);
          (raw as unknown as { connect: typeof raw.connect }).connect = (async () => {
            const client = await (rawConnect as () => Promise<pg.PoolClient>)();
            const query = client.query.bind(client);
            (client as unknown as { query: typeof client.query }).query = (async (
              text: unknown,
              values?: unknown,
            ) => {
              const sql = typeof text === 'string' ? text : String((text as { text?: string }).text ?? '');
              const result = await (query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values);
              if (sql.includes('<=>')) {
                for (const row of (result as { rows: { chunk_id: string }[] }).rows) {
                  armOrder.push(row.chunk_id);
                }
              }
              return result;
            }) as typeof client.query;
            return client;
          }) as typeof raw.connect;
          return new VerifiedBrainPool(raw, retrievalRequest.brainAuthority);
        },
      });
      assert.deepEqual(evidence.report.modes.embedding, { status: 'used' });
      const embeddingCandidates = evidence.candidates.filter(
        (entry) => entry.retrieval_modes.includes('embedding'),
      );
      assert.equal(embeddingCandidates.length > 0, true, 'the embedding arm must contribute candidates');

      // The oracle: cosine distance to [1,0,0,0] computed in TypeScript over the
      // same rows selectCurrentChunkEmbeddings returns.
      const oracleRows = await selectCurrentChunkEmbeddings(corpus.activation, specId, { limit: 64 });
      assert.equal(oracleRows.length, chunks.rows.length);
      const query = [1, 0, 0, 0];
      const cosineDistance = (vector: readonly number[]): number => {
        let dot = 0;
        let left = 0;
        let right = 0;
        for (const [index, component] of vector.entries()) {
          dot += component * query[index]!;
          left += component * component;
          right += query[index]! * query[index]!;
        }
        return 1 - dot / (Math.sqrt(left) * Math.sqrt(right));
      };
      const oracleOrder = [...oracleRows]
        .map((entry) => ({ chunkId: entry.chunkId, distance: cosineDistance(entry.embedding) }))
        .sort((left, right) => left.distance - right.distance
          || compareUnicodeCodePoints(left.chunkId, right.chunkId))
        .map((entry) => entry.chunkId);

      // The ADAPTER's ranked list, position by position, equals the oracle's.
      assert.equal(armOrder.length > 0, true, 'the embedding statement must have executed');
      assert.deepEqual(
        armOrder,
        oracleOrder.slice(0, armOrder.length),
        'the adapter arm and the TypeScript oracle produce the same ranking, in order',
      );
      assert.equal(armOrder[0], oracleOrder[0], 'the nearest chunk is the same on both sides');
      // Every candidate the arm reached is one the arm actually ranked.
      const ranked = new Set(armOrder);
      assert.equal(
        embeddingCandidates.every((entry) => ranked.has(entry.candidate_id)),
        true,
      );
    });

    await t.test('a spec that changes between the pre-read and the transaction drops the arm', async () => {
      // The pre-read resolves and embeds; a concurrent session then changes the
      // configured model, so the in-transaction re-validation disagrees with the
      // vector already produced and the arm is dropped — with lexical and
      // structured evidence intact.
      let flipped = false;
      const shifting: EmbeddingAdapterRegistry = Object.freeze({
        openai: () => ({
          status: 'resolved' as const,
          provider: flipped
            ? { ...provider, specVersion: 2 }
            : (flipped = true, provider),
        }),
      });
      const evidence = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters: shifting,
      });
      assert.deepEqual(evidence.report.modes.embedding, {
        status: 'invalid-configuration',
        reason: 'spec-changed-in-snapshot',
      });
      assert.equal(evidence.status, 'available');
      assert.equal(evidence.candidates.length > 0, true, 'the other arms proceed');
      assert.equal(
        evidence.candidates.every((entry) => !entry.retrieval_modes.includes('embedding')),
        true,
      );
    });

    await t.test('a pre-read blocked by config reports the pre-read status, never used', async () => {
      // The pre-read sees embeddings DISABLED (nothing to embed with), while the
      // in-transaction resolution succeeds because the injected adapter resolves.
      // No embed call was ever made, so the honest status is the pre-read's.
      const configClient = await corpus.adminPool.connect();
      try {
        await setConfig(configClient, 'embeddings.enabled', 'false');
      } finally {
        configClient.release();
      }
      const disabled = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters,
      });
      assert.deepEqual(disabled.report.modes.embedding, { status: 'disabled' });
      assert.equal(disabled.status, 'available');
      assert.equal(disabled.candidates.length > 0, true, 'the other arms proceed');
      assert.deepEqual(disabled.report.modes.lexical, { status: 'used' });
      assert.deepEqual(disabled.report.modes.structured, { status: 'used' });
      assert.equal(
        disabled.candidates.every((entry) => !entry.retrieval_modes.includes('embedding')),
        true,
        'no candidate may claim an arm that never ran',
      );

      // Same shape with a credential-unavailable pre-read.
      const credentialBlocked: EmbeddingAdapterRegistry = Object.freeze({
        openai: () => ({ status: 'credential-unavailable' as const }),
      });
      const configClient2 = await corpus.adminPool.connect();
      try {
        await setConfig(configClient2, 'embeddings.enabled', 'true');
      } finally {
        configClient2.release();
      }
      const noCredential = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters: credentialBlocked,
      });
      assert.deepEqual(noCredential.report.modes.embedding, { status: 'credential-unavailable' });
      assert.equal(noCredential.candidates.length > 0, true);
      assert.equal(
        noCredential.candidates.every((entry) => !entry.retrieval_modes.includes('embedding')),
        true,
      );
    });

    await t.test('an unregistered spec drops the arm without losing the other arms', async () => {
      const unregistered: EmbeddingAdapterRegistry = Object.freeze({
        openai: () => ({ status: 'resolved' as const, provider: { ...provider, specVersion: 7 } }),
      });
      const evidence = await retrieveBrainContextEvidence(request(corpus), {
        env: env(corpus),
        adapters: unregistered,
      });
      assert.deepEqual(evidence.report.modes.embedding, {
        status: 'invalid-configuration',
        reason: 'spec-unregistered',
      });
      assert.equal(evidence.candidates.length > 0, true);
    });

    await t.test('a broken embed drops the arm with a closed reason and never reports used', async () => {
      const cases = [
        {
          name: 'thrown',
          adapter: () => ({
            status: 'resolved' as const,
            provider: { ...provider, embed: async () => { throw new Error('provider exploded'); } },
          }),
          reason: 'adapter-failed',
        },
        {
          name: 'wrong length',
          adapter: () => ({
            status: 'resolved' as const,
            provider: { ...provider, embed: async () => [[1, 0]] },
          }),
          reason: 'adapter-contract-violation',
        },
        {
          name: 'NaN component',
          adapter: () => ({
            status: 'resolved' as const,
            provider: { ...provider, embed: async () => [[Number.NaN, 0, 0, 0]] },
          }),
          reason: 'adapter-contract-violation',
        },
        {
          name: 'non-numeric component',
          adapter: () => ({
            status: 'resolved' as const,
            provider: { ...provider, embed: async () => [['1', 0, 0, 0] as unknown as number[]] },
          }),
          reason: 'adapter-contract-violation',
        },
        {
          name: 'empty batch',
          adapter: () => ({
            status: 'resolved' as const,
            provider: { ...provider, embed: async () => [] },
          }),
          reason: 'adapter-contract-violation',
        },
      ] as const;
      for (const entry of cases) {
        const evidence = await retrieveBrainContextEvidence(request(corpus), {
          env: env(corpus),
          adapters: Object.freeze({ openai: entry.adapter }) as EmbeddingAdapterRegistry,
        });
        assert.deepEqual(
          evidence.report.modes.embedding,
          { status: 'invalid-configuration', reason: entry.reason },
          entry.name,
        );
        // The whole result must NOT collapse: lexical and structured proceed.
        assert.equal(evidence.status, 'available', entry.name);
        assert.equal(evidence.report.unavailable_reason, null, entry.name);
        assert.equal(evidence.candidates.length > 0, true, entry.name);
        assert.deepEqual(evidence.report.modes.lexical, { status: 'used' }, entry.name);
        assert.deepEqual(evidence.report.modes.structured, { status: 'used' }, entry.name);
        assert.equal(
          evidence.candidates.every((candidate) => !candidate.retrieval_modes.includes('embedding')),
          true,
          entry.name,
        );
      }
    });
  } finally {
    await corpus.close();
  }
});
