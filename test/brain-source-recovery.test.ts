import assert from 'node:assert/strict';
import test from 'node:test';
import { RosterError } from '../src/lib/errors.ts';
import type {
  BrainObjectCreateResult,
  BrainObjectInspection,
  BrainObjectStore,
} from '../src/lib/brain/object-store.ts';
import {
  publishPreparedBrainIntent,
} from '../src/lib/brain/source-lifecycle.ts';
import {
  inspectBrainSourceIntent,
  repairBrainSourceIntent,
} from '../src/lib/brain/source-recovery.ts';
import { prepareSourceIdentity } from '../src/lib/brain/source-identity.ts';
import type { VerifiedBrainPool } from '../src/lib/brain/workspace-authority.ts';

const NAMESPACE = `sha256:${'a'.repeat(64)}`;
const BYTES = Buffer.from('durable source bytes', 'utf8');
const PREPARED = prepareSourceIdentity('recovery-test', {
  requestKey: 'recovery-request',
  source: { kind: 'inline-text', stableKey: 'recovery-test' },
  bytes: BYTES,
  labels: [{ workspace: 'recovery-test' }],
  privacy: 'internal',
  trust: 'tool-output-untrusted',
  actor: { actorId: 'recovery-test', assurance: 'caller-asserted' },
  mediaType: 'text/plain',
  provenance: { fixture: true },
});
const TOMBSTONE_ID = `sha256:${'f'.repeat(64)}`;
const TOMBSTONED_PREPARED = prepareSourceIdentity('recovery-test', {
  requestKey: 'recovery-after-tombstone',
  expectedTombstoneId: TOMBSTONE_ID,
  source: { kind: 'inline-text', stableKey: 'recovery-test' },
  bytes: BYTES,
  labels: [{ workspace: 'recovery-test' }],
  privacy: 'internal',
  trust: 'tool-output-untrusted',
  actor: { actorId: 'recovery-test', assurance: 'caller-asserted' },
  mediaType: 'text/plain',
  provenance: { fixture: true },
});
const INTENT_ID = PREPARED.intentId;
const REQUEST_FINGERPRINT = PREPARED.requestFingerprint;
const OBJECT_SHA256 = PREPARED.object.contentHash.slice('sha256:'.length);
const OBJECT_KEY = PREPARED.object.objectKey;
const SOURCE_ID = PREPARED.logicalSourceId;
const VERSION_ID = PREPARED.sourceVersionId;

type IntentRow = {
  intent_id: string;
  request_key: string;
  request_fingerprint: string;
  source_id: string;
  prepared_sequence: string;
  source_version_id: string;
  version_fingerprint: string;
  object_id: string;
  object_sha256: string;
  object_key: string;
  size_bytes: string;
  expected_tombstone_id: string | null;
  request_payload: Record<string, unknown>;
  state: 'prepared' | 'complete';
  published_version_id: string | null;
  published_object_id: string | null;
  published_as_current: boolean | null;
};

function intentRow(
  overrides: Partial<IntentRow> = {},
  prepared = PREPARED,
): IntentRow {
  return {
    intent_id: prepared.intentId,
    request_key: prepared.normalized.requestKey,
    request_fingerprint: prepared.requestFingerprint,
    source_id: prepared.logicalSourceId,
    prepared_sequence: '1',
    source_version_id: prepared.sourceVersionId,
    version_fingerprint: prepared.sourceVersionId,
    object_id: prepared.object.objectId,
    object_sha256: OBJECT_SHA256,
    object_key: OBJECT_KEY,
    size_bytes: String(BYTES.byteLength),
    expected_tombstone_id: prepared.normalized.expectedTombstoneId,
    request_payload: {
      schema_version: 1,
      source: { kind: 'inline-text', stableKey: 'recovery-test' },
      labels: [{ workspace: 'recovery-test', function: null, agent: null, plan: null }],
      privacy: 'internal',
      trust: 'tool-output-untrusted',
      actor: { actorId: 'recovery-test', assurance: 'caller-asserted' },
      media_type: 'text/plain',
      source_timestamp: null,
      provenance: { fixture: true },
    },
    state: 'prepared',
    published_version_id: null,
    published_object_id: null,
    published_as_current: null,
    ...overrides,
  };
}

class FakeBrainDb {
  row: IntentRow | null;
  readonly events: string[];
  namespaceFingerprint = NAMESPACE;
  activeTombstoneId: string | null = null;
  sourceExists = true;
  durableMatches = true;
  publishCalls = 0;
  readCalls = 0;

  constructor(row: IntentRow | null, events: string[] = []) {
    this.row = row;
    this.events = events;
  }

  pool(): VerifiedBrainPool {
    const fixture = this;
    return {
      authority: {
        workspaceId: 'recovery-test',
        fingerprintFormatVersion: 1,
        namespaceFingerprint: this.namespaceFingerprint,
      },
      async connect() {
        return {
          async query(text: string) {
            return fixture.query(text);
          },
          release() {},
        };
      },
    } as never;
  }

  private result(rows: unknown[] = [], rowCount = rows.length) {
    return { rows, rowCount };
  }

  private query(text: string) {
    const sql = text.replace(/\s+/gu, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return this.result();
    if (sql.includes('pg_advisory_xact_lock')) return this.result([{}]);
    if (sql.includes('FROM brain.ingest_intents') && sql.startsWith('SELECT')) {
      this.events.push('db:read');
      this.readCalls++;
      return this.result(this.row === null ? [] : [{ ...this.row }]);
    }
    if (sql.includes('FROM brain.logical_sources WHERE source_id = $1')) {
      return this.result(this.sourceExists ? [{
        source_kind: 'inline-text',
        origin_fingerprint: SOURCE_ID,
        origin: { kind: 'inline-text', stableKey: 'recovery-test' },
        next_sequence: '1',
        current_sequence: '0',
        current_version_id: null,
        active_tombstone_id: this.activeTombstoneId,
      }] : []);
    }
    if (sql.includes('SELECT EXISTS (') && sql.includes('FROM brain.source_objects')) {
      return this.result([{ matches: this.durableMatches }]);
    }
    if (sql.startsWith('INSERT INTO brain.source_objects')) return this.result([], 1);
    if (sql.includes('FROM brain.source_objects WHERE object_id = $1')) {
      return this.result([{ matches: this.durableMatches }]);
    }
    if (sql.startsWith('INSERT INTO brain.source_versions')) return this.result([], 1);
    if (sql.includes('FROM brain.source_versions WHERE source_version_id = $1')) {
      return this.result([{ matches: this.durableMatches }]);
    }
    if (sql.startsWith('INSERT INTO brain.source_version_labels')) return this.result([], 1);
    if (sql.startsWith('SELECT function_id, agent_id, plan_id')) {
      return this.result([{ function_id: null, agent_id: null, plan_id: null }]);
    }
    if (sql.startsWith('UPDATE brain.logical_sources')) return this.result([], 1);
    if (sql.startsWith('UPDATE brain.ingest_intents')) {
      assert.ok(this.row !== null);
      this.events.push('db:publish');
      this.publishCalls++;
      this.row = {
        ...this.row,
        state: 'complete',
        published_version_id: this.row.source_version_id,
        published_object_id: this.row.object_id,
        published_as_current: true,
      };
      return this.result([{ ...this.row }], 1);
    }
    throw new Error(`unexpected recovery fixture SQL: ${sql}`);
  }
}

class FakeStore implements BrainObjectStore {
  readonly events: string[];
  readonly namespaceFingerprint: string;
  inspection: BrainObjectInspection;
  createCalls = 0;
  inspectCalls = 0;

  constructor(
    inspection: BrainObjectInspection,
    events: string[] = [],
    namespaceFingerprint = NAMESPACE,
  ) {
    this.inspection = inspection;
    this.events = events;
    this.namespaceFingerprint = namespaceFingerprint;
  }

  async createOrVerify(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<BrainObjectCreateResult> {
    this.events.push('object:create');
    this.createCalls++;
    assert.equal(input.sha256, OBJECT_SHA256);
    assert.deepEqual(input.bytes, BYTES);
    assert.equal(input.contentType, 'text/plain');
    const result: BrainObjectCreateResult = {
      outcome: 'stored',
      key: OBJECT_KEY,
      sha256: OBJECT_SHA256,
      byteLength: BYTES.byteLength,
      etag: 'secret-etag',
      versionId: 'secret-version',
    };
    this.inspection = { status: 'verified', ...result };
    return result;
  }

  async inspect(): Promise<BrainObjectInspection> {
    this.events.push('object:inspect');
    this.inspectCalls++;
    return this.inspection;
  }

  close(): void {}
}

function missingStore(events: string[] = []): FakeStore {
  return new FakeStore({ status: 'missing', key: OBJECT_KEY }, events);
}

function verifiedStore(events: string[] = []): FakeStore {
  return new FakeStore({
    status: 'verified',
    key: OBJECT_KEY,
    sha256: OBJECT_SHA256,
    byteLength: BYTES.byteLength,
    etag: 'secret-etag',
    versionId: 'secret-version',
  }, events);
}

const REQUEST = Object.freeze({
  intentId: INTENT_ID,
  requestFingerprint: REQUEST_FINGERPRINT,
});
const TOMBSTONED_REQUEST = Object.freeze({
  intentId: TOMBSTONED_PREPARED.intentId,
  requestFingerprint: TOMBSTONED_PREPARED.requestFingerprint,
});

test('recovery validates exact IDs and the namespace before DB or object reads', async () => {
  const store = missingStore();
  const database = new FakeBrainDb(intentRow());
  await assert.rejects(
    inspectBrainSourceIntent(database.pool(), store, { ...REQUEST, intentId: 'not-an-id' }),
    (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_SOURCE_RECOVERY_INPUT_INVALID',
  );
  database.namespaceFingerprint = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(
    inspectBrainSourceIntent(database.pool(), store, REQUEST),
    (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_SOURCE_NAMESPACE_MISMATCH',
  );
  database.namespaceFingerprint = NAMESPACE;
  await assert.rejects(
    repairBrainSourceIntent(database.pool(), store, { ...REQUEST, bytes: 'not-bytes' } as never),
    (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_SOURCE_RECOVERY_INPUT_INVALID',
  );
  assert.equal(database.readCalls, 0);
  assert.equal(store.inspectCalls, 0);
});

test('inspection reports prepared state without mutating or exposing durable material', async () => {
  const store = missingStore();
  const database = new FakeBrainDb(intentRow());
  const first = await inspectBrainSourceIntent(database.pool(), store, REQUEST);
  const second = await inspectBrainSourceIntent(database.pool(), store, REQUEST);
  assert.deepEqual(first, {
    status: 'prepared',
    reason: 'object-absent',
    repairable: true,
    requiresBytes: true,
  });
  assert.deepEqual(second, first);
  assert.equal(database.publishCalls, 0);
  assert.equal(store.createCalls, 0);

  const rendered = JSON.stringify(first);
  for (const sensitive of [INTENT_ID, REQUEST_FINGERPRINT, OBJECT_SHA256, OBJECT_KEY, 'secret-etag', 'secret-version']) {
    assert.equal(rendered.includes(sensitive), false);
  }
  assert.deepEqual(Object.keys(first).sort(), ['reason', 'repairable', 'requiresBytes', 'status']);
});

test('unknown intent, request mismatch, and active tombstone mismatch fail before S3', async () => {
  for (const [row, activeTombstoneId, request, expectedReason] of [
    [null, null, REQUEST, 'intent-not-found'],
    [intentRow(), null, { ...REQUEST, requestFingerprint: `sha256:${'f'.repeat(64)}` }, 'request-fingerprint-mismatch'],
    [intentRow({}, TOMBSTONED_PREPARED), null, TOMBSTONED_REQUEST, 'tombstone-mismatch'],
  ] as const) {
    const store = missingStore();
    const database = new FakeBrainDb(row);
    database.activeTombstoneId = activeTombstoneId;
    const result = await inspectBrainSourceIntent(database.pool(), store, request);
    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, expectedReason);
    assert.equal(result.repairable, false);
    assert.equal(store.inspectCalls, 0);
    assert.equal(database.publishCalls, 0);
  }
});

test('verified prepared objects publish without caller bytes and repeated repair converges', async () => {
  const events: string[] = [];
  const store = verifiedStore(events);
  const database = new FakeBrainDb(intentRow(), events);
  const repaired = await repairBrainSourceIntent(database.pool(), store, REQUEST);
  assert.deepEqual(repaired, {
    status: 'complete',
    reason: 'published-object-verified',
    repairable: false,
    requiresBytes: false,
  });
  assert.equal(events[0], 'db:read');
  assert.ok(events.indexOf('object:inspect') < events.indexOf('db:publish'));
  assert.equal(events.at(-1), 'object:inspect');
  assert.equal(store.createCalls, 0);
  assert.equal(database.publishCalls, 1);

  const replay = await repairBrainSourceIntent(database.pool(), store, REQUEST);
  assert.deepEqual(replay, repaired);
  assert.equal(store.createCalls, 0);
  assert.equal(database.publishCalls, 1);
});

test('prepared missing objects require exact supplied bytes before create and publish', async () => {
  const events: string[] = [];
  const store = missingStore(events);
  const database = new FakeBrainDb(intentRow(), events);
  const reportOnly = await repairBrainSourceIntent(database.pool(), store, REQUEST);
  assert.equal(reportOnly.status, 'prepared');
  assert.equal(store.createCalls, 0);
  assert.equal(database.publishCalls, 0);

  const wrong = await repairBrainSourceIntent(
    database.pool(),
    store,
    { ...REQUEST, bytes: Buffer.from('wrong') },
  );
  assert.deepEqual(wrong, {
    status: 'corrupt',
    reason: 'supplied-bytes-mismatch',
    repairable: true,
    requiresBytes: true,
  });
  assert.equal(store.createCalls, 0);
  assert.equal(database.publishCalls, 0);

  events.length = 0;
  const repaired = await repairBrainSourceIntent(database.pool(), store, { ...REQUEST, bytes: BYTES });
  assert.equal(repaired.status, 'complete');
  assert.equal(events[0], 'db:read');
  assert.ok(events.indexOf('object:create') < events.indexOf('db:publish'));
  assert.equal(events.at(-1), 'object:inspect');
});

test('completed DB state with missing bytes recreates only the same content key', async () => {
  const events: string[] = [];
  const store = missingStore(events);
  const database = new FakeBrainDb(intentRow({
    state: 'complete',
    published_version_id: VERSION_ID,
    published_object_id: `sha256:${OBJECT_SHA256}`,
    published_as_current: true,
  }), events);
  const before = await inspectBrainSourceIntent(database.pool(), store, REQUEST);
  assert.deepEqual(before, {
    status: 'missing',
    reason: 'published-object-missing',
    repairable: true,
    requiresBytes: true,
  });

  events.length = 0;
  const repaired = await repairBrainSourceIntent(database.pool(), store, { ...REQUEST, bytes: BYTES });
  assert.equal(repaired.status, 'complete');
  assert.deepEqual(events, ['db:read', 'object:inspect', 'object:create', 'db:read', 'object:inspect']);
  assert.equal(database.publishCalls, 0);
});

test('stored and durable corruption are report-only and never overwritten', async () => {
  const stored = new FakeStore({ status: 'corrupt', key: OBJECT_KEY, reason: 'digest' });
  const storedDatabase = new FakeBrainDb(intentRow());
  const storedReport = await repairBrainSourceIntent(storedDatabase.pool(), stored, { ...REQUEST, bytes: BYTES });
  assert.deepEqual(storedReport, {
    status: 'corrupt',
    reason: 'stored-object-invalid',
    repairable: false,
    requiresBytes: false,
  });
  assert.equal(stored.createCalls, 0);
  assert.equal(storedDatabase.publishCalls, 0);

  const forgedRow = intentRow();
  forgedRow.request_payload = {
    ...forgedRow.request_payload,
    source: { kind: 'inline-text', stableKey: 'forged-durable-origin' },
  };
  const forged = missingStore();
  const forgedDatabase = new FakeBrainDb(forgedRow);
  const forgedReport = await repairBrainSourceIntent(forgedDatabase.pool(), forged, REQUEST);
  assert.equal(forgedReport.status, 'corrupt');
  assert.equal(forgedReport.reason, 'durable-state-invalid');
  assert.equal(forged.inspectCalls, 0);
  await assert.rejects(
    publishPreparedBrainIntent(forgedDatabase.pool(), forged, INTENT_ID, REQUEST_FINGERPRINT),
    (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_SOURCE_INTEGRITY_CONFLICT',
  );
  assert.equal(forged.inspectCalls, 0);

  const durable = missingStore();
  const durableDatabase = new FakeBrainDb(intentRow({
    state: 'complete',
    published_version_id: VERSION_ID,
    published_object_id: `sha256:${OBJECT_SHA256}`,
    published_as_current: true,
  }));
  durableDatabase.durableMatches = false;
  const durableReport = await repairBrainSourceIntent(durableDatabase.pool(), durable, { ...REQUEST, bytes: BYTES });
  assert.equal(durableReport.status, 'corrupt');
  assert.equal(durableReport.reason, 'durable-state-invalid');
  assert.equal(durable.inspectCalls, 0);
  assert.equal(durable.createCalls, 0);
  assert.equal(durableDatabase.publishCalls, 0);
  await assert.rejects(
    publishPreparedBrainIntent(durableDatabase.pool(), durable, INTENT_ID, REQUEST_FINGERPRINT),
    (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_SOURCE_INTEGRITY_CONFLICT',
  );
  assert.equal(durable.inspectCalls, 0);

  for (const mismatch of [
    { sha256: '0'.repeat(64) },
    { byteLength: BYTES.byteLength + 1 },
    { key: `objects/00/${'0'.repeat(64)}` },
  ]) {
    const observation = {
      status: 'verified' as const,
      key: OBJECT_KEY,
      sha256: OBJECT_SHA256,
      byteLength: BYTES.byteLength,
      etag: null,
      versionId: null,
      ...mismatch,
    };
    const mismatchedStore = new FakeStore(observation);
    const mismatchedDatabase = new FakeBrainDb(intentRow());
    const result = await repairBrainSourceIntent(mismatchedDatabase.pool(), mismatchedStore, REQUEST);
    assert.equal(result.status, 'corrupt');
    assert.equal(result.reason, 'stored-object-invalid');
    assert.equal(mismatchedStore.createCalls, 0);
    assert.equal(mismatchedDatabase.publishCalls, 0);
  }

  const oversized = missingStore();
  const oversizedDatabase = new FakeBrainDb(intentRow({ size_bytes: String(64 * 1024 * 1024 + 1) }));
  const oversizedReport = await repairBrainSourceIntent(oversizedDatabase.pool(), oversized, REQUEST);
  assert.equal(oversizedReport.status, 'corrupt');
  assert.equal(oversized.inspectCalls, 0);
});
