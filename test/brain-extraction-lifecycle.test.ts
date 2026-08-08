import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { requireBrainActivation, type BrainActivation } from '../src/lib/brain/activation.ts';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import {
  extractBrainSourceVersion,
  ingestAndExtractBrainSource,
  reindexBrainExtractions,
} from '../src/lib/brain/extraction.ts';
import { deriveChunkId, deriveExtractionId } from '../src/lib/brain/extractors.ts';
import { buildRuntimeUrl } from '../src/lib/brain/roles.ts';
import type { SourceIngestInput } from '../src/lib/brain/source-contracts.ts';
import {
  ingestBrainSource,
  restoreBrainSource,
  tombstoneBrainSource,
} from '../src/lib/brain/source-lifecycle.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
  type VerifiedBrainPool,
} from '../src/lib/brain/workspace-authority.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { WorkspaceBrainConfig } from '../src/lib/workspace-record.ts';
import { createFreshDb, HAS_DB } from './brain-helpers.ts';
import { MemoryBrainObjectStore, digestOf } from './support/brain-memory-object-store.ts';

const WORKSPACE_ID = 'extraction-lifecycle-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

function config(): WorkspaceBrainConfig {
  return {
    secrets_path: '/extraction-lifecycle-test',
    storage: { bucket: 'extraction-lifecycle-test', region: 'eu-central-1', force_path_style: false },
  };
}

function sourceInput(
  stableKey: string,
  requestKey: string,
  body: string,
  overrides: Partial<Pick<SourceIngestInput, 'mediaType' | 'privacy' | 'expectedTombstoneId'>> = {},
): SourceIngestInput {
  return {
    requestKey,
    ...(overrides.expectedTombstoneId === undefined ? {} : { expectedTombstoneId: overrides.expectedTombstoneId }),
    source: { kind: 'inline-text', stableKey },
    bytes: Buffer.from(body, 'utf8'),
    labels: [{ workspace: WORKSPACE_ID }],
    privacy: overrides.privacy ?? 'internal',
    trust: 'host-asserted',
    actor: {
      actorId: 'codex-test',
      assurance: 'host-attested',
      host: 'codex',
      sessionId: 'extraction-lifecycle-test',
    },
    mediaType: overrides.mediaType ?? 'text/markdown',
    provenance: { fixture: 'brain-extraction-lifecycle', request_key: requestKey },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

async function lifecycleCounts(pool: VerifiedBrainPool): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*)::text FROM brain.ingest_intents) AS intents,
            (SELECT count(*)::text FROM brain.logical_sources) AS sources,
            (SELECT count(*)::text FROM brain.source_versions) AS versions,
            (SELECT count(*)::text FROM brain.source_objects) AS objects,
            (SELECT count(*)::text FROM brain.source_extractions) AS extractions,
            (SELECT count(*)::text FROM brain.source_chunks) AS chunks`,
  );
  return result.rows[0]!;
}

test('brain extraction is admin-path, cited, deterministic, and recoverable', options, async (t) => {
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

    await t.test('activation refuses an absent, foreign, or read-incapable object store', () => {
      assert.throws(
        () => requireBrainActivation({ pool: adminPool, objectStore: undefined as never }),
        hasCode('BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE'),
      );
      assert.throws(
        () => requireBrainActivation({
          pool: adminPool,
          objectStore: {
            namespaceFingerprint: authority.namespaceFingerprint,
            createOrVerify: () => {},
            inspect: () => {},
            close: () => {},
          } as never,
        }),
        hasCode('BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE'),
      );
      assert.throws(
        () => requireBrainActivation({
          pool: adminPool,
          objectStore: new MemoryBrainObjectStore('sha256:foreign-namespace'),
        }),
        hasCode('BRAIN_EXTRACTION_NAMESPACE_MISMATCH'),
      );
      assert.throws(
        () => requireBrainActivation({ pool: undefined as never, objectStore: store }),
        hasCode('BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE'),
      );
      // @ts-expect-error the branded activation capability is not literal-constructible
      const forged: BrainActivation = { pool: adminPool, objectStore: store };
      assert.equal(typeof forged, 'object');
    });

    await t.test('every chunk cites one immutable version, extractor identity, and byte locators', async () => {
      const input = sourceInput('cited-source', 'cited-source-v1', '# Title\n\nAlpha body.\n\n## Second\n\nBeta body.\n');
      const sha256 = digestOf(input.bytes);
      store.versionIds.set(sha256, 'object-version-1');
      const ingest = await ingestBrainSource({ pool: adminPool, objectStore: store }, input);
      const result = await extractBrainSourceVersion(activation, {
        sourceVersionId: ingest.sourceVersionId,
        bytes: input.bytes,
      });
      assert.equal(result.outcome, 'extracted');
      assert.equal(result.status, 'complete');
      assert.equal(result.extractorName, 'roster-text');
      assert.equal(result.extractorVersion, 1);
      assert.equal(result.chunkCount, 2);
      assert.equal(
        result.extractionId,
        deriveExtractionId(ingest.sourceVersionId, 'roster-text', 1),
      );
      assert.equal(result.textSha256, createHash('sha256').update(input.bytes).digest('hex'));

      const chunks = await adminPool.query<{
        chunk_id: string;
        source_version_id: string;
        extractor_name: string;
        extractor_version: number;
        content: string;
        byte_start: string;
        byte_end: string;
        object_id: string;
        source_id: string;
      }>(
        `SELECT chunk_id, source_version_id, extractor_name, extractor_version, content,
                byte_start::text, byte_end::text, object_id, source_id
           FROM brain.current_source_chunks ORDER BY chunk_index`,
      );
      assert.equal(chunks.rows.length, 2);
      const body = Buffer.from(input.bytes);
      chunks.rows.forEach((row, index) => {
        assert.equal(row.source_version_id, ingest.sourceVersionId);
        assert.equal(row.source_id, ingest.sourceId);
        assert.equal(row.object_id, ingest.objectId);
        assert.equal(row.extractor_name, 'roster-text');
        assert.equal(row.extractor_version, 1);
        assert.equal(row.chunk_id, deriveChunkId(result.extractionId, index));
        assert.equal(
          body.subarray(Number(row.byte_start), Number(row.byte_end)).toString('utf8'),
          row.content,
        );
      });

      const replay = await extractBrainSourceVersion(activation, {
        sourceVersionId: ingest.sourceVersionId,
        bytes: input.bytes,
      });
      assert.equal(replay.outcome, 'unchanged');
      assert.equal(replay.extractionId, result.extractionId);
    });

    await t.test('caller-supplied and fetched bytes are verified against the recorded object', async () => {
      const input = sourceInput('verified-source', 'verified-source-v1', 'plain body text\n', {
        mediaType: 'text/plain',
      });
      const sha256 = digestOf(input.bytes);
      store.versionIds.set(sha256, 'object-version-2');
      const ingest = await ingestBrainSource({ pool: adminPool, objectStore: store }, input);

      await assert.rejects(
        extractBrainSourceVersion(activation, {
          sourceVersionId: ingest.sourceVersionId,
          bytes: Buffer.from('a different body\n', 'utf8'),
        }),
        hasCode('BRAIN_EXTRACTION_OBJECT_UNVERIFIED'),
      );
      await assert.rejects(
        extractBrainSourceVersion(activation, {
          sourceVersionId: ingest.sourceVersionId,
          bytes: Buffer.concat([Buffer.from(input.bytes), Buffer.from('x')]),
        }),
        hasCode('BRAIN_EXTRACTION_OBJECT_UNVERIFIED'),
      );
      const nothingStored = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.source_extractions WHERE source_version_id = $1`,
        [ingest.sourceVersionId],
      );
      assert.equal(nothingStored.rows[0]!.count, '0');

      store.corrupt(sha256);
      await assert.rejects(
        extractBrainSourceVersion(activation, { sourceVersionId: ingest.sourceVersionId }),
        hasCode('BRAIN_EXTRACTION_OBJECT_UNVERIFIED'),
      );
      store.repair(sha256);
      const readsBefore = store.readCalls.length;
      const backfilled = await extractBrainSourceVersion(activation, {
        sourceVersionId: ingest.sourceVersionId,
      });
      assert.equal(backfilled.status, 'complete');
      assert.equal(store.readCalls[readsBefore]!.versionId, 'object-version-2');

      await assert.rejects(
        extractBrainSourceVersion(activation, { sourceVersionId: `sha256:${'9'.repeat(64)}` }),
        hasCode('BRAIN_EXTRACTION_SOURCE_NOT_FOUND'),
      );
      await assert.rejects(
        extractBrainSourceVersion(activation, { sourceVersionId: 'not-an-identifier' }),
        hasCode('BRAIN_EXTRACTION_INPUT_INVALID'),
      );
    });

    await t.test('an unsupported media type records an explicit refusal with zero chunks', async () => {
      const input = sourceInput('binary-source', 'binary-source-v1', 'ignored', { mediaType: 'image/png' });
      const ingest = await ingestBrainSource({ pool: adminPool, objectStore: store }, input);
      const result = await extractBrainSourceVersion(activation, {
        sourceVersionId: ingest.sourceVersionId,
        bytes: input.bytes,
      });
      assert.equal(result.status, 'unsupported');
      assert.equal(result.unsupportedReason, 'media-type');
      assert.equal(result.chunkCount, 0);
      assert.equal(result.textSha256, null);
      const exposed = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks WHERE source_version_id = $1`,
        [ingest.sourceVersionId],
      );
      assert.equal(exposed.rows[0]!.count, '0');
    });

    await t.test('structured records index as jsonb and stay filterable without embeddings', async () => {
      const input = sourceInput(
        'structured-source',
        'structured-source-v1',
        '{"campaign":"spring","channels":["email","social"]}',
        { mediaType: 'application/json' },
      );
      const composed = await ingestAndExtractBrainSource(activation, input);
      assert.equal(composed.extraction.extractorName, 'roster-structured');
      assert.equal(composed.extraction.status, 'complete');
      const filtered = await adminPool.query<{ extraction_id: string }>(
        `SELECT extraction_id FROM brain.source_extractions
          WHERE structured @> '{"campaign":"spring"}'::jsonb`,
      );
      assert.deepEqual(filtered.rows.map((row) => row.extraction_id), [composed.extraction.extractionId]);
      const lexical = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks
          WHERE tsv @@ plainto_tsquery('english', 'social')`,
      );
      assert.equal(lexical.rows[0]!.count, '1');
    });

    await t.test('current selection follows supersede, tombstone, and exact restore', async () => {
      const first = sourceInput('lifecycle-source', 'lifecycle-source-v1', 'first generation body\n', {
        mediaType: 'text/plain',
      });
      const firstIngest = await ingestAndExtractBrainSource(activation, first);
      const firstChunks = await adminPool.query<{ content: string }>(
        `SELECT content FROM brain.current_source_chunks WHERE source_id = $1 ORDER BY chunk_index`,
        [firstIngest.ingest.sourceId],
      );
      assert.deepEqual(firstChunks.rows.map((row) => row.content), ['first generation body']);

      const second = sourceInput('lifecycle-source', 'lifecycle-source-v2', 'second generation body\n', {
        mediaType: 'text/plain',
      });
      const secondIngest = await ingestAndExtractBrainSource(activation, second);
      const afterSupersede = await adminPool.query<{ content: string; source_version_id: string }>(
        `SELECT content, source_version_id FROM brain.current_source_chunks
          WHERE source_id = $1 ORDER BY chunk_index`,
        [firstIngest.ingest.sourceId],
      );
      assert.deepEqual(afterSupersede.rows.map((row) => row.content), ['second generation body']);
      assert.equal(afterSupersede.rows[0]!.source_version_id, secondIngest.ingest.sourceVersionId);
      const priorRetained = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.source_chunks WHERE source_version_id = $1`,
        [firstIngest.ingest.sourceVersionId],
      );
      assert.equal(priorRetained.rows[0]!.count, '1', 'superseded chunks are retained, never moved');

      const tombstone = await tombstoneBrainSource(adminPool, {
        sourceId: firstIngest.ingest.sourceId,
        requestKey: 'lifecycle-source-tombstone',
        reason: 'fixture removal',
        actor: { actorId: 'codex-test', assurance: 'caller-asserted' },
        provenance: { fixture: 'brain-extraction-lifecycle' },
      });
      const afterTombstone = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks WHERE source_id = $1`,
        [firstIngest.ingest.sourceId],
      );
      assert.equal(afterTombstone.rows[0]!.count, '0');

      await restoreBrainSource(adminPool, {
        tombstoneId: tombstone.tombstoneId,
        requestKey: 'lifecycle-source-restore',
        actor: { actorId: 'codex-test', assurance: 'caller-asserted' },
        provenance: { fixture: 'brain-extraction-lifecycle' },
      });
      const afterRestore = await adminPool.query<{ content: string }>(
        `SELECT content FROM brain.current_source_chunks WHERE source_id = $1 ORDER BY chunk_index`,
        [firstIngest.ingest.sourceId],
      );
      assert.deepEqual(afterRestore.rows.map((row) => row.content), ['second generation body']);
    });

    await t.test('reindex backfills current versions resumably and idempotently', async () => {
      const pending = [
        sourceInput('reindex-a', 'reindex-a-v1', 'alpha backfill body\n', { mediaType: 'text/plain' }),
        sourceInput('reindex-b', 'reindex-b-v1', 'beta backfill body\n', { mediaType: 'text/plain' }),
        sourceInput('reindex-c', 'reindex-c-v1', 'gamma backfill body\n', { mediaType: 'text/plain' }),
      ];
      for (const input of pending) {
        await ingestBrainSource({ pool: adminPool, objectStore: store }, input);
      }
      const missing = sourceInput('reindex-missing', 'reindex-missing-v1', 'lost bytes body\n', {
        mediaType: 'text/plain',
      });
      const missingIngest = await ingestBrainSource({ pool: adminPool, objectStore: store }, missing);
      store.withhold(digestOf(missing.bytes));

      const partial = await reindexBrainExtractions(activation, { batchSize: 1, limit: 2 });
      assert.equal(partial.targeted, 4);
      assert.equal(partial.extracted + partial.unsupported + partial.failed, 2);
      assert.equal(
        partial.remaining,
        4 - partial.extracted - partial.unsupported,
        'a bounded run commits per item and leaves every unfinished target',
      );

      const full = await reindexBrainExtractions(activation, { batchSize: 2 });
      assert.equal(full.remaining, 1, 'only the unreadable object stays targeted');

      const replay = await reindexBrainExtractions(activation);
      assert.equal(replay.targeted, 1);
      assert.equal(replay.extracted, 0);
      assert.equal(replay.failed, 1);
      assert.equal(replay.remaining, 1);

      const stored = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.source_extractions WHERE source_version_id = $1`,
        [missingIngest.sourceVersionId],
      );
      assert.equal(stored.rows[0]!.count, '0');

      await assert.rejects(
        reindexBrainExtractions(activation, { batchSize: 0 }),
        hasCode('BRAIN_EXTRACTION_INPUT_INVALID'),
      );
    });

    await t.test('a stored chunk whose content diverges from its claimed digest is refused', async () => {
      const input = sourceInput('forged-source', 'forged-source-v1', 'plain body text\n', {
        mediaType: 'text/plain',
      });
      const ingest = await ingestBrainSource({ pool: adminPool, objectStore: store }, input);
      const extractionId = deriveExtractionId(ingest.sourceVersionId, 'roster-text', 1);
      const chunkId = deriveChunkId(extractionId, 0);
      const honestDigest = createHash('sha256').update(Buffer.from('plain body text', 'utf8')).digest('hex');
      await adminPool.query(
        `INSERT INTO brain.source_extractions
           (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
            status, chunk_count, text_sha256)
         VALUES ($1, $2, $3, 'roster-text', 1, 'complete', 1, $4)`,
        [
          extractionId,
          ingest.sourceId,
          ingest.sourceVersionId,
          createHash('sha256').update(input.bytes).digest('hex'),
        ],
      );
      const forgery = `INSERT INTO brain.source_chunks
           (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
            byte_start, byte_end, line_start, line_end)
         VALUES ($1, $2, $3, 0, 'tampered body!!', $4, 0, 15, 1, 1)`;
      const forgeryValues = [chunkId, extractionId, ingest.sourceVersionId, honestDigest];

      await assert.rejects(
        adminPool.query(forgery, forgeryValues),
        /source chunk content does not match its content digest/u,
        'the database refuses a chunk whose content does not hash to its claimed digest',
      );

      await adminPool.query(`ALTER TABLE brain.source_chunks DISABLE TRIGGER source_chunks_guard_insert`);
      try {
        await adminPool.query(forgery, forgeryValues);
      } finally {
        await adminPool.query(`ALTER TABLE brain.source_chunks ENABLE TRIGGER source_chunks_guard_insert`);
      }
      const planted = await adminPool.query<{ content: string; content_sha256: string }>(
        `SELECT content, content_sha256 FROM brain.source_chunks WHERE chunk_id = $1`,
        [chunkId],
      );
      assert.equal(planted.rows[0]!.content, 'tampered body!!');
      assert.equal(planted.rows[0]!.content_sha256, honestDigest);

      await assert.rejects(
        extractBrainSourceVersion(activation, {
          sourceVersionId: ingest.sourceVersionId,
          bytes: input.bytes,
        }),
        hasCode('BRAIN_EXTRACTION_INTEGRITY_CONFLICT'),
        'replay recomputes the digest over stored content instead of trusting the column',
      );
      const unchanged = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.source_chunks WHERE extraction_id = $1`,
        [extractionId],
      );
      assert.equal(unchanged.rows[0]!.count, '1', 'the refused replay wrote nothing');
    });

    await t.test('a runtime credential reads the view but is refused before any write', async () => {
      runtimePool = createVerifiedBrainPool({
        connectionString: buildRuntimeUrl(fresh.url, runtimePassword, bootstrap.role.roleName),
        authority,
        databaseAuthorityId: bootstrap.databaseAuthorityId,
      });
      const runtimeActivation = requireBrainActivation({ pool: runtimePool, objectStore: store });
      const readable = await runtimePool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks`,
      );
      assert.ok(Number(readable.rows[0]!.count) > 0);

      const input = sourceInput('runtime-denied', 'runtime-denied-v1', 'runtime body\n', {
        mediaType: 'text/plain',
      });
      const ingest = await ingestBrainSource({ pool: adminPool, objectStore: store }, input);
      await assert.rejects(
        extractBrainSourceVersion(runtimeActivation, {
          sourceVersionId: ingest.sourceVersionId,
          bytes: input.bytes,
        }),
        hasCode('BRAIN_EXTRACTION_ADMIN_REQUIRED'),
      );
      await assert.rejects(
        reindexBrainExtractions(runtimeActivation),
        hasCode('BRAIN_EXTRACTION_ADMIN_REQUIRED'),
      );
      const untouched = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.source_extractions WHERE source_version_id = $1`,
        [ingest.sourceVersionId],
      );
      assert.equal(untouched.rows[0]!.count, '0');

      const before = await lifecycleCounts(adminPool);
      const createsBefore = store.createCalls.length;
      await assert.rejects(
        ingestAndExtractBrainSource(
          runtimeActivation,
          sourceInput('runtime-composed', 'runtime-composed-v1', 'composed body\n', { mediaType: 'text/plain' }),
        ),
        hasCode('BRAIN_EXTRACTION_ADMIN_REQUIRED'),
        'the composed helper proves write authority before the ingestion mutation',
      );
      assert.deepEqual(await lifecycleCounts(adminPool), before, 'no lifecycle row was written');
      assert.equal(store.createCalls.length, createsBefore, 'no object-store write occurred');

      assert.equal(
        (await extractBrainSourceVersion(activation, {
          sourceVersionId: ingest.sourceVersionId,
          bytes: input.bytes,
        })).outcome,
        'extracted',
      );
    });

    await t.test('compiled-registry drift against the durable registry fails closed', async () => {
      await adminPool.query(
        `UPDATE brain_meta.active_extractors SET active_version = 2 WHERE extractor_name = 'roster-text'`,
      );
      const drifted = requireBrainActivation({ pool: adminPool, objectStore: store });
      const input = sourceInput('drift-source', 'drift-source-v1', 'drift body\n', { mediaType: 'text/plain' });
      const ingest = await ingestBrainSource({ pool: adminPool, objectStore: store }, input);
      await assert.rejects(
        extractBrainSourceVersion(drifted, {
          sourceVersionId: ingest.sourceVersionId,
          bytes: input.bytes,
        }),
        hasCode('BRAIN_EXTRACTION_REGISTRY_DRIFT'),
      );
      await assert.rejects(
        reindexBrainExtractions(drifted),
        hasCode('BRAIN_EXTRACTION_REGISTRY_DRIFT'),
      );
    });
  } finally {
    if (runtimePool !== undefined) await runtimePool.end();
    if (pool !== undefined) await pool.end();
    await fresh.drop();
  }
});
