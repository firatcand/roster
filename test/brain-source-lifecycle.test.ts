import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { RosterError } from '../src/lib/errors.ts';
import type {
  BrainObjectCreateResult,
  BrainObjectInspection,
  BrainObjectStore,
} from '../src/lib/brain/object-store.ts';
import type { SourceIngestInput } from '../src/lib/brain/source-contracts.ts';
import {
  ingestBrainSource,
  publishPreparedBrainIntent,
  readBrainIngestIntent,
  restoreBrainSource,
  tombstoneBrainSource,
} from '../src/lib/brain/source-lifecycle.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
  type VerifiedBrainPool,
} from '../src/lib/brain/workspace-authority.ts';
import type { WorkspaceBrainConfig } from '../src/lib/workspace-record.ts';
import { createFreshDb, HAS_DB } from './brain-helpers.ts';

const WORKSPACE_ID = 'source-lifecycle-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 120_000 };

function config(): WorkspaceBrainConfig {
  return {
    secrets_path: '/source-lifecycle-test',
    storage: {
      bucket: 'source-lifecycle-test',
      region: 'eu-central-1',
      force_path_style: false,
    },
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectKey(sha256: string): string {
  return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

function sourceInput(
  stableKey: string,
  requestKey: string,
  body: string,
  expectedTombstoneId?: string,
): SourceIngestInput {
  return {
    requestKey,
    ...(expectedTombstoneId === undefined ? {} : { expectedTombstoneId }),
    source: { kind: 'inline-text', stableKey },
    bytes: Buffer.from(body, 'utf8'),
    labels: [
      { workspace: WORKSPACE_ID },
      {
        workspace: WORKSPACE_ID,
        function: 'social-media',
        agent: 'manager',
        plan: 'discovery',
      },
    ],
    privacy: 'internal',
    trust: 'host-asserted',
    actor: {
      actorId: 'codex-test',
      assurance: 'host-attested',
      host: 'codex',
      sessionId: 'source-lifecycle-test',
    },
    mediaType: 'text/plain',
    provenance: { fixture: 'brain-source-lifecycle', request_key: requestKey },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryObjectStore implements BrainObjectStore {
  readonly namespaceFingerprint: string;
  readonly objects = new Map<string, Buffer>();
  readonly createCalls: string[] = [];
  readonly inspectCalls: string[] = [];
  private readonly hooks = new Map<string, () => Promise<void>>();
  private readonly failBeforeWrite = new Map<string, Error>();
  private readonly failAfterWrite = new Map<string, Error>();

  constructor(namespaceFingerprint: string) {
    this.namespaceFingerprint = namespaceFingerprint;
  }

  hookNextCreate(sha256: string, hook: () => Promise<void>): void {
    this.hooks.set(sha256, hook);
  }

  failNextCreateBeforeWrite(sha256: string, error: Error): void {
    this.failBeforeWrite.set(sha256, error);
  }

  failNextCreateAfterWrite(sha256: string, error: Error): void {
    this.failAfterWrite.set(sha256, error);
  }

  async createOrVerify(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<BrainObjectCreateResult> {
    this.createCalls.push(input.sha256);
    assert.equal(input.sha256, digest(input.bytes));
    assert.equal(input.contentType, 'text/plain');

    const hook = this.hooks.get(input.sha256);
    if (hook !== undefined) {
      this.hooks.delete(input.sha256);
      await hook();
    }

    const beforeFailure = this.failBeforeWrite.get(input.sha256);
    if (beforeFailure !== undefined) {
      this.failBeforeWrite.delete(input.sha256);
      throw beforeFailure;
    }

    const bytes = Buffer.from(input.bytes);
    const existing = this.objects.get(input.sha256);
    if (existing !== undefined) assert.deepEqual(existing, bytes);
    else this.objects.set(input.sha256, bytes);

    const afterFailure = this.failAfterWrite.get(input.sha256);
    if (afterFailure !== undefined) {
      this.failAfterWrite.delete(input.sha256);
      throw afterFailure;
    }

    return {
      outcome: existing === undefined ? 'stored' : 'exists',
      key: objectKey(input.sha256),
      sha256: input.sha256,
      byteLength: bytes.byteLength,
      etag: null,
      versionId: null,
    };
  }

  async inspect(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }): Promise<BrainObjectInspection> {
    this.inspectCalls.push(input.sha256);
    const bytes = this.objects.get(input.sha256);
    if (bytes === undefined) return { status: 'missing', key: objectKey(input.sha256) };
    if (bytes.byteLength !== input.byteLength) {
      return { status: 'corrupt', key: objectKey(input.sha256), reason: 'size' };
    }
    return {
      status: 'verified',
      key: objectKey(input.sha256),
      sha256: input.sha256,
      byteLength: bytes.byteLength,
      etag: null,
      versionId: null,
    };
  }

  close(): void {}
}

async function dropRuntimeRole(roleName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName)) throw new Error('unsafe derived role fixture');
  const pool = createBrainPool('admin');
  try {
    await pool.query(`REVOKE "${roleName}" FROM CURRENT_USER`);
    await pool.query(`DROP ROLE IF EXISTS "${roleName}"`);
  } finally {
    await pool.end();
  }
}

test('brain source lifecycle keeps publication durable, ordered, and recoverable', options, async (t) => {
  const fresh = await createFreshDb();
  const authority = deriveBrainWorkspaceAuthority(WORKSPACE_ID, config());
  const bootstrapPool = createBrainPool('admin', fresh.url);
  let pool: VerifiedBrainPool | undefined;
  let runtimeRole: string | undefined;
  try {
    const bootstrap = await bootstrapBrainWorkspaceAuthority(bootstrapPool, authority, {
      runtimeRole: fresh.role,
      runtimePassword: `Aa0_${randomBytes(32).toString('base64url')}-A1_`,
    });
    runtimeRole = bootstrap.role.roleName;
    await bootstrapPool.end();
    pool = createVerifiedBrainPool({
      connectionString: fresh.url,
      authority,
      databaseAuthorityId: bootstrap.databaseAuthorityId,
    });
    const verifiedPool = pool;
    const store = new MemoryObjectStore(authority.namespaceFingerprint);

    await t.test('commits prepare before object creation and retries only identical input', async () => {
      const input = sourceInput('prepare-order', 'prepare-order-v1', 'first durable body');
      const sha256 = digest(input.bytes);
      const callsBefore = store.createCalls.length;
      store.hookNextCreate(sha256, async () => {
        const prepared = await verifiedPool.query<{
          state: string;
          object_id: string;
          object_exists: boolean;
        }>(
          `SELECT intent.state, intent.object_id,
                  EXISTS (SELECT 1 FROM brain.source_objects object WHERE object.object_id = intent.object_id) AS object_exists
             FROM brain.ingest_intents intent WHERE intent.request_key = $1`,
          [input.requestKey],
        );
        assert.equal(prepared.rows[0]?.state, 'prepared');
        assert.equal(prepared.rows[0]?.object_exists, false);
      });

      const first = await ingestBrainSource({ pool: verifiedPool, objectStore: store }, input);
      assert.equal(first.publishedAsCurrent, true);
      assert.equal(store.createCalls.length, callsBefore + 1);
      assert.equal((await readBrainIngestIntent(verifiedPool, first.intentId))?.state, 'complete');
      const labels = await verifiedPool.query<{
        function_id: string | null;
        agent_id: string | null;
        plan_id: string | null;
      }>(
        `SELECT function_id, agent_id, plan_id FROM brain.source_version_labels
          WHERE source_version_id = $1 ORDER BY label_key`,
        [first.sourceVersionId],
      );
      assert.deepEqual(labels.rows, [
        { function_id: 'social-media', agent_id: 'manager', plan_id: 'discovery' },
        { function_id: null, agent_id: null, plan_id: null },
      ]);

      const replay = await ingestBrainSource({ pool: verifiedPool, objectStore: store }, input);
      assert.deepEqual(replay, first);
      assert.equal(store.createCalls.length, callsBefore + 1);
      await assert.rejects(
        ingestBrainSource(
          { pool: verifiedPool, objectStore: store },
          sourceInput('prepare-order', input.requestKey, 'changed bytes under the same key'),
        ),
        hasCode('BRAIN_SOURCE_IDEMPOTENCY_CONFLICT'),
      );
      assert.equal(store.createCalls.length, callsBefore + 1);
    });

    await t.test('a late older publish cannot rewind the current version', async () => {
      const older = sourceInput('ordered-source', 'ordered-source-v1', 'older bytes');
      const newer = sourceInput('ordered-source', 'ordered-source-v2', 'newer bytes');
      const olderStarted = deferred();
      const releaseOlder = deferred();
      store.hookNextCreate(digest(older.bytes), async () => {
        olderStarted.resolve();
        await releaseOlder.promise;
      });

      const olderPromise = ingestBrainSource({ pool: verifiedPool, objectStore: store }, older);
      await olderStarted.promise;
      let newerResult;
      try {
        newerResult = await ingestBrainSource({ pool: verifiedPool, objectStore: store }, newer);
      } finally {
        releaseOlder.resolve();
      }
      const olderResult = await olderPromise;
      assert.equal(newerResult.publishedAsCurrent, true);
      assert.equal(olderResult.publishedAsCurrent, false);

      const current = await verifiedPool.query<{
        current_version_id: string;
        current_sequence: string;
        next_sequence: string;
      }>(
        `SELECT current_version_id, current_sequence::text, next_sequence::text
           FROM brain.logical_sources WHERE source_id = $1`,
        [newerResult.sourceId],
      );
      assert.deepEqual(current.rows[0], {
        current_version_id: newerResult.sourceVersionId,
        current_sequence: '2',
        next_sequence: '2',
      });
    });

    await t.test('a normal intent overtaken by a tombstone publishes history without resurrection', async () => {
      const initialInput = sourceInput('tombstone-race', 'tombstone-race-v1', 'current before deletion');
      const initial = await ingestBrainSource({ pool: verifiedPool, objectStore: store }, initialInput);
      const lateInput = sourceInput('tombstone-race', 'tombstone-race-v2', 'prepared before deletion');
      const lateStarted = deferred();
      const releaseLate = deferred();
      store.hookNextCreate(digest(lateInput.bytes), async () => {
        lateStarted.resolve();
        await releaseLate.promise;
      });

      const latePromise = ingestBrainSource({ pool: verifiedPool, objectStore: store }, lateInput);
      await lateStarted.promise;
      const tombstone = await tombstoneBrainSource(verifiedPool, {
        sourceId: initial.sourceId,
        requestKey: 'tombstone-race-delete',
        actor: { actorId: 'codex-test', assurance: 'caller-asserted' },
        provenance: { fixture: 'brain-source-lifecycle' },
      });
      releaseLate.resolve();
      const late = await latePromise;
      assert.equal(late.publishedAsCurrent, false);

      const durable = await verifiedPool.query<{
        current_version_id: string;
        active_tombstone_id: string | null;
        intent_state: string;
      }>(
        `SELECT source.current_version_id, source.active_tombstone_id, intent.state AS intent_state
           FROM brain.logical_sources source
           JOIN brain.ingest_intents intent ON intent.intent_id = $3
          WHERE source.source_id = $1 AND source.active_tombstone_id = $2`,
        [initial.sourceId, tombstone.tombstoneId, late.intentId],
      );
      assert.deepEqual(durable.rows[0], {
        current_version_id: initial.sourceVersionId,
        active_tombstone_id: tombstone.tombstoneId,
        intent_state: 'complete',
      });
    });

    await t.test('only the exact tombstone restores or re-ingests and objects are retained', async () => {
      const initialInput = sourceInput('deleted-source', 'deleted-source-v1', 'retain these original bytes');
      const initial = await ingestBrainSource({ pool: verifiedPool, objectStore: store }, initialInput);
      const initialDigest = digest(initialInput.bytes);
      const objectCount = store.objects.size;
      const actor = { actorId: 'codex-test', assurance: 'caller-asserted' } as const;

      const firstTombstoneInput = {
        sourceId: initial.sourceId,
        requestKey: 'deleted-source-tombstone-1',
        reason: 'fixture deletion',
        actor,
        provenance: { fixture: 'brain-source-lifecycle' },
      };
      const firstTombstone = await tombstoneBrainSource(verifiedPool, firstTombstoneInput);
      assert.deepEqual(await tombstoneBrainSource(verifiedPool, firstTombstoneInput), firstTombstone);
      assert.equal(store.objects.size, objectCount);
      assert.equal(store.objects.has(initialDigest), true);

      const firstRestoreInput = {
        tombstoneId: firstTombstone.tombstoneId,
        requestKey: 'deleted-source-restore-1',
        actor,
        provenance: { fixture: 'brain-source-lifecycle' },
      };
      const restored = await restoreBrainSource(verifiedPool, firstRestoreInput);
      assert.equal(restored.restoredVersionId, initial.sourceVersionId);
      assert.deepEqual(await restoreBrainSource(verifiedPool, firstRestoreInput), restored);
      assert.equal(store.objects.size, objectCount);

      const secondTombstone = await tombstoneBrainSource(verifiedPool, {
        ...firstTombstoneInput,
        requestKey: 'deleted-source-tombstone-2',
      });
      await assert.rejects(
        restoreBrainSource(verifiedPool, {
          ...firstRestoreInput,
          requestKey: 'deleted-source-stale-restore',
        }),
        hasCode('BRAIN_SOURCE_TOMBSTONE_CONFLICT'),
      );

      const callsBeforeConflict = store.createCalls.length;
      await assert.rejects(
        ingestBrainSource(
          { pool: verifiedPool, objectStore: store },
          sourceInput('deleted-source', 'deleted-source-wrong-tombstone', 'replacement bytes', firstTombstone.tombstoneId),
        ),
        hasCode('BRAIN_SOURCE_TOMBSTONE_CONFLICT'),
      );
      assert.equal(store.createCalls.length, callsBeforeConflict);

      const replacementInput = sourceInput(
        'deleted-source',
        'deleted-source-v2',
        'replacement bytes',
        secondTombstone.tombstoneId,
      );
      const replacement = await ingestBrainSource(
        { pool: verifiedPool, objectStore: store },
        replacementInput,
      );
      assert.equal(replacement.publishedAsCurrent, true);
      assert.notEqual(replacement.sourceVersionId, initial.sourceVersionId);
      assert.equal(store.objects.has(initialDigest), true);
      assert.equal(store.objects.has(digest(replacementInput.bytes)), true);
      assert.equal(store.objects.size, objectCount + 1);
      assert.equal('delete' in store, false);

      const durable = await verifiedPool.query<{
        current_version_id: string;
        active_tombstone_id: string | null;
        restored_by_intent_id: string | null;
      }>(
        `SELECT source.current_version_id, source.active_tombstone_id, tombstone.restored_by_intent_id
           FROM brain.logical_sources source
           JOIN brain.source_tombstones tombstone ON tombstone.tombstone_id = $2
          WHERE source.source_id = $1`,
        [initial.sourceId, secondTombstone.tombstoneId],
      );
      assert.deepEqual(durable.rows[0], {
        current_version_id: replacement.sourceVersionId,
        active_tombstone_id: null,
        restored_by_intent_id: replacement.intentId,
      });
    });

    await t.test('prepared intents recover across failures before and after object persistence', async () => {
      const beforeWrite = sourceInput('failure-before-write', 'failure-before-write-v1', 'bytes absent after failure');
      const beforeDigest = digest(beforeWrite.bytes);
      store.failNextCreateBeforeWrite(beforeDigest, new Error('object write failed before persistence'));
      await assert.rejects(
        ingestBrainSource({ pool: verifiedPool, objectStore: store }, beforeWrite),
        /failed before persistence/u,
      );
      const beforeRow = await verifiedPool.query<{ intent_id: string }>(
        `SELECT intent_id FROM brain.ingest_intents WHERE request_key = $1`,
        [beforeWrite.requestKey],
      );
      const beforeIntent = await readBrainIngestIntent(verifiedPool, beforeRow.rows[0]!.intent_id);
      assert.equal(beforeIntent?.state, 'prepared');
      assert.equal((await store.inspect({ sha256: beforeDigest, byteLength: beforeWrite.bytes.byteLength })).status, 'missing');
      assert.equal((await ingestBrainSource({ pool: verifiedPool, objectStore: store }, beforeWrite)).publishedAsCurrent, true);

      const afterWrite = sourceInput('failure-after-write', 'failure-after-write-v1', 'bytes exist after failure');
      const afterDigest = digest(afterWrite.bytes);
      store.failNextCreateAfterWrite(afterDigest, new Error('object response lost after persistence'));
      await assert.rejects(
        ingestBrainSource({ pool: verifiedPool, objectStore: store }, afterWrite),
        /response lost after persistence/u,
      );
      const afterRow = await verifiedPool.query<{ intent_id: string }>(
        `SELECT intent_id FROM brain.ingest_intents WHERE request_key = $1`,
        [afterWrite.requestKey],
      );
      const prepared = await readBrainIngestIntent(verifiedPool, afterRow.rows[0]!.intent_id);
      assert.equal(prepared?.state, 'prepared');
      assert.equal((await store.inspect({ sha256: afterDigest, byteLength: afterWrite.bytes.byteLength })).status, 'verified');

      const repaired = await publishPreparedBrainIntent(
        verifiedPool,
        store,
        prepared!.intentId,
        prepared!.requestFingerprint,
      );
      assert.equal(repaired.publishedAsCurrent, true);
      assert.equal((await readBrainIngestIntent(verifiedPool, repaired.intentId))?.state, 'complete');
    });
  } finally {
    if (pool !== undefined) await pool.end();
    await bootstrapPool.end().catch(() => {});
    await fresh.drop();
    if (runtimeRole !== undefined) await dropRuntimeRole(runtimeRole);
  }
});
