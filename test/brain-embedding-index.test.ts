import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { requireBrainActivation } from '../src/lib/brain/activation.ts';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { DEFAULT_CONFIG, type BrainConfig } from '../src/lib/brain/config.ts';
import {
  deriveEmbeddingSpecId,
  ensureEmbeddingSpec,
  reindexChunkEmbeddings,
  selectCurrentChunkEmbeddings,
} from '../src/lib/brain/embedding-index.ts';
import {
  EMBEDDING_ADAPTERS,
  resolveEmbeddingProvider,
  type EmbeddingAdapterRegistry,
  type EmbeddingProvider,
  type EmbeddingResolution,
} from '../src/lib/brain/embedding-provider.ts';
import { ingestAndExtractBrainSource } from '../src/lib/brain/extraction.ts';
import { buildRuntimeUrl } from '../src/lib/brain/roles.ts';
import type { SourceIngestInput } from '../src/lib/brain/source-contracts.ts';
import { tombstoneBrainSource } from '../src/lib/brain/source-lifecycle.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
  type VerifiedBrainPool,
} from '../src/lib/brain/workspace-authority.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { WorkspaceBrainConfig } from '../src/lib/workspace-record.ts';
import { createFreshDb, HAS_DB } from './brain-helpers.ts';
import { MemoryBrainObjectStore } from './support/brain-memory-object-store.ts';

const WORKSPACE_ID = 'embedding-index-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };
const DIMENSIONS = 8;

function config(): WorkspaceBrainConfig {
  return {
    secrets_path: '/embedding-index-test',
    storage: { bucket: 'embedding-index-test', region: 'eu-central-1', force_path_style: false },
  };
}

function brainConfig(overrides: Partial<BrainConfig> = {}): BrainConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

type FakeProvider = EmbeddingProvider & { seen: string[]; calls: number };

function fakeProvider(
  overrides: Partial<Pick<EmbeddingProvider, 'provider' | 'model' | 'dimensions' | 'specVersion'>> = {},
  failAfterCalls = Number.POSITIVE_INFINITY,
): FakeProvider {
  const dimensions = overrides.dimensions ?? DIMENSIONS;
  const state = { seen: [] as string[], calls: 0 };
  const provider: FakeProvider = {
    provider: overrides.provider ?? 'fixture',
    model: overrides.model ?? 'fixture-model',
    dimensions,
    specVersion: overrides.specVersion ?? 1,
    get seen() {
      return state.seen;
    },
    get calls() {
      return state.calls;
    },
    async embed(texts: readonly string[]): Promise<number[][]> {
      state.calls += 1;
      if (state.calls > failAfterCalls) throw new Error('fixture provider outage');
      state.seen.push(...texts);
      return texts.map((text) => {
        const seed = createHash('sha256').update(text).digest();
        return Array.from({ length: dimensions }, (_unused, index) => (seed[index % 32]! - 128) / 128);
      });
    },
  } as FakeProvider;
  return provider;
}

function resolved(provider: EmbeddingProvider): EmbeddingResolution {
  return { status: 'resolved', provider };
}

function sourceInput(stableKey: string, requestKey: string, body: string, privacy: 'internal' | 'secret'): SourceIngestInput {
  return {
    requestKey,
    source: { kind: 'inline-text', stableKey },
    bytes: Buffer.from(body, 'utf8'),
    labels: [{ workspace: WORKSPACE_ID }],
    privacy,
    trust: 'host-asserted',
    actor: {
      actorId: 'codex-test',
      assurance: 'host-attested',
      host: 'codex',
      sessionId: 'embedding-index-test',
    },
    mediaType: 'text/plain',
    provenance: { fixture: 'brain-embedding-index', request_key: requestKey },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

test('embedding resolution is closed, never throws, and ships no named provider', () => {
  assert.deepEqual(Object.keys(EMBEDDING_ADAPTERS), []);
  assert.deepEqual(resolveEmbeddingProvider(brainConfig({ embeddingsEnabled: false })), { status: 'disabled' });
  assert.deepEqual(
    resolveEmbeddingProvider(brainConfig({ embeddingsEnabled: true })),
    { status: 'invalid-configuration', reason: 'unsupported-provider' },
    'the shipped registry is empty, so no configuration can resolve',
  );
  assert.deepEqual(
    resolveEmbeddingProvider(brainConfig({ embeddingsEnabled: true, embeddingsProvider: 'Not Valid' })),
    { status: 'invalid-configuration', reason: 'provider-name-invalid' },
  );
  assert.deepEqual(
    resolveEmbeddingProvider(brainConfig({ embeddingsEnabled: true, embeddingsModel: '' })),
    { status: 'invalid-configuration', reason: 'model-invalid' },
  );

  const adapters: EmbeddingAdapterRegistry = {
    fixture: () => ({ status: 'credential-unavailable' }),
    broken: () => {
      throw new Error('adapter exploded');
    },
    liar: () => ({ status: 'resolved', provider: { provider: 'liar', model: 'm', dimensions: 0 } as never }),
    imposter: () => ({ status: 'resolved', provider: fakeProvider({ provider: 'fixture' }) }),
  };
  const base = brainConfig({ embeddingsEnabled: true, embeddingsModel: 'fixture-model' });
  assert.deepEqual(
    resolveEmbeddingProvider({ ...base, embeddingsProvider: 'fixture' }, { adapters }),
    { status: 'credential-unavailable' },
  );
  assert.deepEqual(
    resolveEmbeddingProvider({ ...base, embeddingsProvider: 'broken' }, { adapters }),
    { status: 'invalid-configuration', reason: 'adapter-failed' },
  );
  assert.deepEqual(
    resolveEmbeddingProvider({ ...base, embeddingsProvider: 'liar' }, { adapters }),
    { status: 'invalid-configuration', reason: 'adapter-contract-violation' },
  );
  assert.deepEqual(
    resolveEmbeddingProvider({ ...base, embeddingsProvider: 'imposter' }, { adapters }),
    { status: 'invalid-configuration', reason: 'adapter-identity-mismatch' },
  );

  const spec = deriveEmbeddingSpecId({ provider: 'fixture', model: 'fixture-model', dimensions: 8, specVersion: 1 });
  assert.match(spec, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    spec,
    deriveEmbeddingSpecId({ provider: 'fixture', model: 'fixture-model', dimensions: 8, specVersion: 1 }),
  );
  assert.notEqual(
    spec,
    deriveEmbeddingSpecId({ provider: 'fixture', model: 'fixture-model', dimensions: 16, specVersion: 1 }),
  );
});

test('exact-only chunk embeddings stay resumable, spec-scoped, and secret-free', options, async (t) => {
  const fresh = await createFreshDb();
  const authority = deriveBrainWorkspaceAuthority(WORKSPACE_ID, config());
  const bootstrapPool = createBrainPool('admin', fresh.url);
  let pool: VerifiedBrainPool | undefined;
  let runtimePool: VerifiedBrainPool | undefined;
  try {
    const runtimePassword = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
    const bootstrap = await bootstrapBrainWorkspaceAuthority(bootstrapPool, authority, {
      runtimeRole: fresh.role,
      runtimePassword,
    });
    await bootstrapPool.end();
    pool = createVerifiedBrainPool({
      connectionString: fresh.url,
      authority,
      databaseAuthorityId: bootstrap.databaseAuthorityId,
    });
    const adminPool = pool;
    const store = new MemoryBrainObjectStore(authority.namespaceFingerprint);
    const activation = requireBrainActivation({ pool: adminPool, objectStore: store });

    const publicSource = await ingestAndExtractBrainSource(
      activation,
      sourceInput('public-a', 'public-a-v1', 'alpha indexable body\n\nbeta indexable body\n', 'internal'),
    );
    const secondSource = await ingestAndExtractBrainSource(
      activation,
      sourceInput('public-b', 'public-b-v1', 'gamma indexable body\n', 'internal'),
    );
    const secretSource = await ingestAndExtractBrainSource(
      activation,
      sourceInput('secret-a', 'secret-a-v1', 'classified payroll ledger\n', 'secret'),
    );
    assert.equal(publicSource.extraction.chunkCount, 2);
    assert.equal(secretSource.extraction.chunkCount, 1);

    await t.test('a non-resolved outcome reports verbatim and touches no state', async () => {
      for (const resolution of [
        { status: 'disabled' } as const,
        { status: 'credential-unavailable' } as const,
        { status: 'invalid-configuration', reason: 'unsupported-provider' } as const,
      ]) {
        const report = await reindexChunkEmbeddings(activation, resolution);
        assert.equal(report.embeddings, resolution.status);
        assert.equal(report.reason, resolution.status === 'invalid-configuration' ? 'unsupported-provider' : null);
        assert.equal(report.embeddingSpecId, null);
        assert.equal(report.targeted, 0);
        assert.equal(report.embedded, 0);
      }
      const untouched = await adminPool.query<{ specs: string; vectors: string }>(
        `SELECT (SELECT count(*)::text FROM brain.embedding_indexes) AS specs,
                (SELECT count(*)::text FROM brain.chunk_embeddings) AS vectors`,
      );
      assert.deepEqual(untouched.rows[0], { specs: '0', vectors: '0' });
      const stillIndexed = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks
          WHERE tsv @@ plainto_tsquery('english', 'indexable')`,
      );
      assert.equal(stillIndexed.rows[0]!.count, '3', 'lexical readiness is untouched by embedding degradation');
    });

    await t.test('the spec registry row records provider identity and is immutable', async () => {
      const provider = fakeProvider();
      const registered = await ensureEmbeddingSpec(activation, provider);
      assert.equal(registered.outcome, 'registered');
      assert.equal(registered.embeddingSpecId, deriveEmbeddingSpecId(provider));
      const replay = await ensureEmbeddingSpec(activation, provider);
      assert.equal(replay.outcome, 'unchanged');
      const stored = await adminPool.query<{
        provider: string;
        model: string;
        dimensions: number;
        spec_version: number;
      }>(
        `SELECT provider, model, dimensions, spec_version FROM brain.embedding_indexes
          WHERE embedding_spec_id = $1`,
        [registered.embeddingSpecId],
      );
      assert.deepEqual(stored.rows[0], {
        provider: 'fixture',
        model: 'fixture-model',
        dimensions: DIMENSIONS,
        spec_version: 1,
      });
      await assert.rejects(
        adminPool.query(`UPDATE brain.embedding_indexes SET model = 'other'`),
        /brain\.embedding_indexes is immutable/u,
      );
      await assert.rejects(
        adminPool.query(`DELETE FROM brain.embedding_indexes`),
        /brain\.embedding_indexes is immutable/u,
      );
      await assert.rejects(
        ensureEmbeddingSpec(activation, { ...provider, dimensions: 0 } as EmbeddingProvider),
        hasCode('BRAIN_EMBEDDING_INPUT_INVALID'),
      );
    });

    await t.test('a mid-batch provider outage keeps committed batches and a rerun converges', async () => {
      const flaky = fakeProvider({ provider: 'flaky' }, 1);
      await assert.rejects(
        reindexChunkEmbeddings(activation, resolved(flaky), { batchSize: 1 }),
        hasCode('BRAIN_EMBEDDING_PROVIDER_FAILED'),
      );
      const committed = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.chunk_embeddings WHERE embedding_spec_id = $1`,
        [deriveEmbeddingSpecId(flaky)],
      );
      assert.equal(committed.rows[0]!.count, '1', 'the batch that succeeded stays committed');

      const healthy = fakeProvider({ provider: 'flaky' });
      const rerun = await reindexChunkEmbeddings(activation, resolved(healthy), { batchSize: 1 });
      assert.equal(rerun.embeddings, 'resolved');
      assert.equal(rerun.remaining, 0);
      assert.equal(rerun.embedded, 2);
      const converged = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.chunk_embeddings WHERE embedding_spec_id = $1`,
        [deriveEmbeddingSpecId(healthy)],
      );
      assert.equal(converged.rows[0]!.count, '3');
    });

    await t.test('secret-class content is excluded by predicate, assembly, and trigger', async () => {
      const canary = fakeProvider({ provider: 'canary' });
      const report = await reindexChunkEmbeddings(activation, resolved(canary));
      assert.equal(report.targeted, 3, 'only non-secret current chunks are targeted');
      assert.equal(report.embedded, 3);
      assert.equal(
        canary.seen.some((text) => text.includes('classified payroll')),
        false,
        'secret text never reaches the provider',
      );
      const secretChunk = await adminPool.query<{ chunk_id: string }>(
        `SELECT chunk_id FROM brain.source_chunks WHERE source_version_id = $1`,
        [secretSource.ingest.sourceVersionId],
      );
      await assert.rejects(
        adminPool.query(
          `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [
            secretChunk.rows[0]!.chunk_id,
            deriveEmbeddingSpecId(canary),
            DIMENSIONS,
            `[${Array.from({ length: DIMENSIONS }, () => 0).join(',')}]`,
          ],
        ),
        /secret-class content is never embedded/u,
      );
    });

    await t.test('a replay is a no-op and a spec change targets only the new spec', async () => {
      const provider = fakeProvider({ provider: 'canary' });
      const replay = await reindexChunkEmbeddings(activation, resolved(provider));
      assert.equal(replay.targeted, 0);
      assert.equal(replay.embedded, 0);
      assert.equal(replay.remaining, 0);

      const upgraded = fakeProvider({ provider: 'canary', specVersion: 2 });
      const migrated = await reindexChunkEmbeddings(activation, resolved(upgraded));
      assert.equal(migrated.targeted, 3);
      assert.equal(migrated.embedded, 3);
      assert.notEqual(migrated.embeddingSpecId, deriveEmbeddingSpecId(provider));
      const perSpec = await adminPool.query<{ embedding_spec_id: string; count: string }>(
        `SELECT embedding_spec_id, count(*)::text AS count FROM brain.chunk_embeddings
          GROUP BY embedding_spec_id ORDER BY embedding_spec_id`,
      );
      assert.equal(perSpec.rows.every((row) => row.count === '3' || row.count === '1'), true);
    });

    await t.test('the exact-only selection never returns other-spec or non-current vectors', async () => {
      const canarySpec = deriveEmbeddingSpecId(fakeProvider({ provider: 'canary' }));
      const upgradedSpec = deriveEmbeddingSpecId(fakeProvider({ provider: 'canary', specVersion: 2 }));
      const selected = await selectCurrentChunkEmbeddings(activation, canarySpec);
      assert.equal(selected.length, 3);
      assert.equal(selected.every((row) => row.dimensions === DIMENSIONS), true);
      assert.equal(selected.every((row) => row.embedding.length === DIMENSIONS), true);
      assert.equal(selected.every((row) => row.privacyClass !== 'secret'), true);
      assert.equal(selected.every((row) => row.extractorName === 'roster-text'), true);
      assert.deepEqual(
        selected.map((row) => row.chunkId),
        [...selected.map((row) => row.chunkId)].sort(),
        'the exact scan is deterministically ordered',
      );
      assert.equal((await selectCurrentChunkEmbeddings(activation, upgradedSpec)).length, 3);
      assert.equal(
        (await selectCurrentChunkEmbeddings(activation, `sha256:${'a'.repeat(64)}`)).length,
        0,
        'an unregistered spec surfaces no vectors at all',
      );
      const paged = await selectCurrentChunkEmbeddings(activation, canarySpec, { limit: 2, offset: 2 });
      assert.equal(paged.length, 1);
      await assert.rejects(
        selectCurrentChunkEmbeddings(activation, 'not-a-spec'),
        hasCode('BRAIN_EMBEDDING_INPUT_INVALID'),
      );
      await assert.rejects(
        selectCurrentChunkEmbeddings(activation, canarySpec, { limit: 0 }),
        hasCode('BRAIN_EMBEDDING_INPUT_INVALID'),
      );

      await tombstoneBrainSource(adminPool, {
        sourceId: secondSource.ingest.sourceId,
        requestKey: 'public-b-tombstone',
        actor: { actorId: 'codex-test', assurance: 'caller-asserted' },
        provenance: { fixture: 'brain-embedding-index' },
      });
      const afterTombstone = await selectCurrentChunkEmbeddings(activation, canarySpec);
      assert.equal(afterTombstone.length, 2);
      assert.equal(afterTombstone.every((row) => row.sourceId !== secondSource.ingest.sourceId), true);
      const rowsStillStored = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.chunk_embeddings WHERE embedding_spec_id = $1`,
        [canarySpec],
      );
      assert.equal(rowsStillStored.rows[0]!.count, '3', 'history is retained, only the current view narrows');
    });

    await t.test('the runtime credential can consume the exact-only selection surface', async () => {
      runtimePool = createVerifiedBrainPool({
        connectionString: buildRuntimeUrl(fresh.url, runtimePassword, bootstrap.role.roleName),
        authority,
        databaseAuthorityId: bootstrap.databaseAuthorityId,
      });
      const runtimeActivation = requireBrainActivation({ pool: runtimePool, objectStore: store });
      const canarySpec = deriveEmbeddingSpecId(fakeProvider({ provider: 'canary' }));
      const rows = await selectCurrentChunkEmbeddings(runtimeActivation, canarySpec);
      assert.equal(rows.length, 2);
      await assert.rejects(
        ensureEmbeddingSpec(runtimeActivation, fakeProvider({ provider: 'runtime-denied' })),
        hasCode('BRAIN_EXTRACTION_ADMIN_REQUIRED'),
      );
      await assert.rejects(
        reindexChunkEmbeddings(runtimeActivation, resolved(fakeProvider({ provider: 'runtime-denied' }))),
        hasCode('BRAIN_EXTRACTION_ADMIN_REQUIRED'),
      );
    });

    await t.test('extractor-registry drift fails closed on both embedding paths', async () => {
      const canarySpec = deriveEmbeddingSpecId(fakeProvider({ provider: 'canary' }));
      const before = await adminPool.query<{ specs: string; vectors: string }>(
        `SELECT (SELECT count(*)::text FROM brain.embedding_indexes) AS specs,
                (SELECT count(*)::text FROM brain.chunk_embeddings) AS vectors`,
      );
      await adminPool.query(
        `UPDATE brain_meta.active_extractors SET active_version = 2 WHERE extractor_name = 'roster-text'`,
      );
      const drifted = requireBrainActivation({ pool: adminPool, objectStore: store });
      const provider = fakeProvider({ provider: 'drifted' });

      await assert.rejects(
        reindexChunkEmbeddings(drifted, resolved(provider)),
        hasCode('BRAIN_EXTRACTION_REGISTRY_DRIFT'),
      );
      await assert.rejects(
        ensureEmbeddingSpec(drifted, provider),
        hasCode('BRAIN_EXTRACTION_REGISTRY_DRIFT'),
      );
      await assert.rejects(
        selectCurrentChunkEmbeddings(drifted, canarySpec),
        hasCode('BRAIN_EXTRACTION_REGISTRY_DRIFT'),
      );
      assert.equal(provider.calls, 0, 'no content reached the provider under drift');
      const after = await adminPool.query<{ specs: string; vectors: string }>(
        `SELECT (SELECT count(*)::text FROM brain.embedding_indexes) AS specs,
                (SELECT count(*)::text FROM brain.chunk_embeddings) AS vectors`,
      );
      assert.deepEqual(after.rows[0], before.rows[0], 'no spec or vector row was written under drift');

      const driftedRuntime = requireBrainActivation({ pool: runtimePool!, objectStore: store });
      await assert.rejects(
        selectCurrentChunkEmbeddings(driftedRuntime, canarySpec),
        hasCode('BRAIN_EXTRACTION_REGISTRY_DRIFT'),
        'the runtime role runs the same check through the owner-privileged projection',
      );
    });
  } finally {
    if (runtimePool !== undefined) await runtimePool.end();
    if (pool !== undefined) await pool.end();
    await fresh.drop();
  }
});
