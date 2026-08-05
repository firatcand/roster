import { createHash } from 'node:crypto';
import type pg from 'pg';
import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import {
  canonicalSourceJson,
  MAX_SOURCE_BYTES,
  normalizeSourceIngest,
  normalizeSourceActor,
  normalizeSourceProvenance,
  normalizeSourceRequestKey,
  type NormalizedSourceIngest,
  type SourceActorInput,
  type SourceIngestInput,
  type SourceJsonObject,
  type SourceJsonValue,
  type SourceOrigin,
  type SourceOriginInput,
  type SourceRetrievalLabel,
  type SourceRetrievalLabelInput,
} from './source-contracts.ts';
import {
  deriveIngestIntentId,
  deriveIngestRequestFingerprint,
  deriveLogicalSourceId,
  deriveSourceVersionId,
  prepareSourceIdentity,
  type PreparedSourceIdentity,
  type SourceObjectIdentity,
} from './source-identity.ts';
import type {
  BrainObjectObservation,
  BrainObjectStore,
} from './object-store.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';

const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_TOMBSTONE_REASON_BYTES = 2_048;

type QueryClient = Pick<pg.PoolClient, 'query'>;

type StoredRequestPayload = {
  schema_version: 1;
  source: PreparedSourceIdentity['normalized']['source'];
  labels: readonly SourceRetrievalLabel[];
  privacy: PreparedSourceIdentity['normalized']['privacy'];
  trust: PreparedSourceIdentity['normalized']['trust'];
  actor: PreparedSourceIdentity['normalized']['actor'];
  media_type: string;
  source_timestamp: string | null;
  provenance: SourceJsonObject;
};

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
  request_payload: unknown;
  state: 'prepared' | 'complete';
  published_version_id: string | null;
  published_object_id: string | null;
  published_as_current: boolean | null;
};

type SourceRow = {
  source_kind: string;
  origin_fingerprint: string;
  origin: unknown;
  next_sequence: string;
  current_sequence: string;
  current_version_id: string | null;
  active_tombstone_id: string | null;
};

export type BrainIngestResult = Readonly<{
  intentId: string;
  sourceId: string;
  sourceVersionId: string;
  objectId: string;
  objectKey: string;
  publishedAsCurrent: boolean;
}>;

export type BrainIngestIntent = Readonly<{
  intentId: string;
  requestKey: string;
  requestFingerprint: string;
  sourceId: string;
  preparedSequence: string;
  sourceVersionId: string;
  versionFingerprint: string;
  objectId: string;
  objectSha256: string;
  objectKey: string;
  sizeBytes: number;
  expectedTombstoneId: string | null;
  contentType: string;
  state: 'prepared' | 'complete';
  publishedVersionId: string | null;
  publishedObjectId: string | null;
  publishedAsCurrent: boolean | null;
  tombstoneMatches: boolean;
  databaseIntegrity: 'verified' | 'corrupt';
}>;

export type BrainTombstoneInput = Readonly<{
  sourceId: string;
  requestKey: string;
  reason?: string | null;
  actor: SourceActorInput;
  provenance: unknown;
}>;

export type BrainTombstoneResult = Readonly<{
  tombstoneId: string;
  sourceId: string;
  sequence: string;
  priorVersionId: string;
}>;

export type BrainRestoreInput = Readonly<{
  tombstoneId: string;
  requestKey: string;
  actor: SourceActorInput;
  provenance: unknown;
}>;

export type BrainRestoreResult = Readonly<{
  tombstoneId: string;
  sourceId: string;
  sequence: string;
  restoredVersionId: string;
}>;

function lifecycleError(
  code:
    | 'BRAIN_SOURCE_NAMESPACE_MISMATCH'
    | 'BRAIN_SOURCE_IDEMPOTENCY_CONFLICT'
    | 'BRAIN_SOURCE_TOMBSTONE_CONFLICT'
    | 'BRAIN_SOURCE_INTEGRITY_CONFLICT'
    | 'BRAIN_SOURCE_NOT_FOUND'
    | 'BRAIN_SOURCE_OBJECT_UNVERIFIED'
    | 'BRAIN_SOURCE_INPUT_INVALID',
  body: string,
  details: Record<string, JsonValue> = {},
): RosterError {
  return new RosterError({
    header: 'Brain source lifecycle refused the operation',
    body,
    remedy: code === 'BRAIN_SOURCE_NAMESPACE_MISMATCH'
      ? 'Use the object store configured for this verified Brain workspace.'
      : 'Inspect the exact durable source or intent and retry with matching immutable input.',
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

function canonicalDigest(domain: string, value: SourceJsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalSourceJson({ domain, value })).digest('hex')}`;
}

function assertSha256Id(value: string, field: string): string {
  if (!SHA256_ID.test(value)) {
    throw lifecycleError('BRAIN_SOURCE_INPUT_INVALID', `The ${field} must be a lowercase SHA-256 identifier.`, { field });
  }
  return value;
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_TOMBSTONE_REASON_BYTES
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.trim() !== value) {
    throw lifecycleError('BRAIN_SOURCE_INPUT_INVALID', 'The tombstone reason is not a bounded canonical string.', {
      field: 'reason',
    });
  }
  return value;
}

function assertNamespace(pool: VerifiedBrainPool, objectStore: BrainObjectStore): void {
  if (objectStore.namespaceFingerprint !== pool.authority.namespaceFingerprint) {
    throw lifecycleError(
      'BRAIN_SOURCE_NAMESPACE_MISMATCH',
      'The object store is not bound to the verified Brain workspace namespace.',
    );
  }
}

async function withTransaction<T>(
  pool: VerifiedBrainPool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockRequest(client: QueryClient, identifier: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [identifier]);
}

function payloadFor(prepared: PreparedSourceIdentity): StoredRequestPayload {
  return payloadForNormalized(prepared.normalized);
}

function payloadForNormalized(normalized: NormalizedSourceIngest): StoredRequestPayload {
  return {
    schema_version: 1,
    source: normalized.source,
    labels: normalized.labels,
    privacy: normalized.privacy,
    trust: normalized.trust,
    actor: normalized.actor,
    media_type: normalized.mediaType,
    source_timestamp: normalized.sourceTimestamp,
    provenance: normalized.provenance,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(value: unknown): StoredRequestPayload | null {
  if (!isRecord(value)
    || value.schema_version !== 1
    || !isRecord(value.source)
    || !Array.isArray(value.labels)
    || typeof value.privacy !== 'string'
    || typeof value.trust !== 'string'
    || !isRecord(value.actor)
    || typeof value.media_type !== 'string'
    || value.media_type.length === 0
    || (value.source_timestamp !== null && typeof value.source_timestamp !== 'string')
    || !isRecord(value.provenance)) return null;
  try {
    canonicalSourceJson(value as SourceJsonValue);
  } catch {
    return null;
  }
  return value as unknown as StoredRequestPayload;
}

function sourceInputFromStored(source: SourceOrigin): SourceOriginInput {
  if (source.kind === 'workspace-file') {
    return { kind: source.kind, workspacePath: source.workspacePath };
  }
  if (source.kind === 'fetched-media') {
    if (source.identity.kind === 'provider-id') {
      return {
        kind: source.kind,
        provider: source.identity.provider,
        upstreamId: source.identity.upstreamId,
        canonicalUrl: source.canonicalUrl,
      };
    }
    return { kind: source.kind, canonicalUrl: source.identity.canonicalUrl };
  }
  return { kind: source.kind, stableKey: source.stableKey };
}

function labelInputFromStored(value: SourceRetrievalLabel): SourceRetrievalLabelInput {
  return {
    workspace: value.workspace,
    ...(value.function === null ? {} : { function: value.function }),
    ...(value.agent === null ? {} : { agent: value.agent }),
    ...(value.plan === null ? {} : { plan: value.plan }),
  };
}

function validateDurableIntent(
  workspaceId: string,
  row: IntentRow,
): { payload: StoredRequestPayload; normalized: NormalizedSourceIngest } | null {
  if (!validIntentIdentity(row)) return null;
  const payload = parsePayload(row.request_payload);
  if (payload === null) return null;
  try {
    const normalized = normalizeSourceIngest(workspaceId, {
      requestKey: row.request_key,
      expectedTombstoneId: row.expected_tombstone_id,
      source: sourceInputFromStored(payload.source),
      bytes: new Uint8Array(0),
      labels: payload.labels.map(labelInputFromStored),
      privacy: payload.privacy,
      trust: payload.trust,
      actor: payload.actor,
      mediaType: payload.media_type,
      sourceTimestamp: payload.source_timestamp,
      provenance: payload.provenance,
    });
    if (canonicalSourceJson(payload as unknown as SourceJsonValue)
      !== canonicalSourceJson(payloadForNormalized(normalized) as unknown as SourceJsonValue)) return null;
    const sizeBytes = Number(row.size_bytes);
    const object: SourceObjectIdentity = {
      contentHash: `sha256:${row.object_sha256}`,
      objectId: row.object_id,
      objectKey: row.object_key,
      sizeBytes,
    };
    if (deriveIngestIntentId(workspaceId, normalized.requestKey) !== row.intent_id
      || deriveLogicalSourceId(workspaceId, normalized.source) !== row.source_id
      || deriveSourceVersionId(row.source_id, row.object_id, normalized) !== row.source_version_id
      || row.version_fingerprint !== row.source_version_id
      || deriveIngestRequestFingerprint(workspaceId, row.source_id, object, normalized)
        !== row.request_fingerprint) return null;
    return { payload, normalized };
  } catch {
    return null;
  }
}

function logicalSourceMatches(source: SourceRow, intent: IntentRow, payload: StoredRequestPayload): boolean {
  try {
    return source.source_kind === payload.source.kind
      && source.origin_fingerprint === intent.source_id
      && canonicalSourceJson(source.origin as SourceJsonValue)
        === canonicalSourceJson(payload.source as unknown as SourceJsonValue);
  } catch {
    return false;
  }
}

function intentResult(row: IntentRow): BrainIngestResult {
  if (row.state !== 'complete'
    || row.published_version_id !== row.source_version_id
    || row.published_object_id !== row.object_id
    || row.published_as_current === null) {
    throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The completed ingest intent has invalid durable state.');
  }
  return Object.freeze({
    intentId: row.intent_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    objectId: row.object_id,
    objectKey: row.object_key,
    publishedAsCurrent: row.published_as_current,
  });
}

function validIntentIdentity(row: IntentRow): boolean {
  const size = Number(row.size_bytes);
  return SHA256_ID.test(row.intent_id)
    && SHA256_ID.test(row.request_fingerprint)
    && SHA256_ID.test(row.source_id)
    && SHA256_ID.test(row.source_version_id)
    && SHA256_ID.test(row.version_fingerprint)
    && SHA256_ID.test(row.object_id)
    && SHA256_HEX.test(row.object_sha256)
    && row.object_id === `sha256:${row.object_sha256}`
    && row.object_key === `objects/${row.object_sha256.slice(0, 2)}/${row.object_sha256}`
    && Number.isSafeInteger(size)
    && size >= 0
    && size <= MAX_SOURCE_BYTES
    && /^\d+$/u.test(row.prepared_sequence)
    && (row.expected_tombstone_id === null || SHA256_ID.test(row.expected_tombstone_id))
    && (row.state === 'prepared'
      ? row.published_version_id === null
        && row.published_object_id === null
        && row.published_as_current === null
      : row.state === 'complete'
        && row.published_version_id === row.source_version_id
        && row.published_object_id === row.object_id
        && typeof row.published_as_current === 'boolean');
}

async function selectIntent(
  client: QueryClient,
  where: 'intent' | 'request',
  value: string,
  lock = false,
): Promise<IntentRow | null> {
  const column = where === 'intent' ? 'intent_id' : 'request_key';
  const result = await client.query<IntentRow>(
    `SELECT intent_id, request_key, request_fingerprint, source_id,
            prepared_sequence::text, source_version_id, version_fingerprint,
            object_id, object_sha256, object_key, size_bytes::text,
            expected_tombstone_id, request_payload, state,
            published_version_id, published_object_id, published_as_current
       FROM brain.ingest_intents
      WHERE ${column} = $1${lock ? ' FOR UPDATE' : ''}`,
    [value],
  );
  return result.rows[0] ?? null;
}

function assertExistingIntent(row: IntentRow, prepared: PreparedSourceIdentity): void {
  if (row.intent_id !== prepared.intentId
    || row.request_key !== prepared.normalized.requestKey
    || row.request_fingerprint !== prepared.requestFingerprint) {
    throw lifecycleError(
      'BRAIN_SOURCE_IDEMPOTENCY_CONFLICT',
      'The request key is already bound to different immutable source input.',
    );
  }
  const payload = parsePayload(row.request_payload);
  if (!validIntentIdentity(row)
    || payload === null
    || row.source_id !== prepared.logicalSourceId
    || row.source_version_id !== prepared.sourceVersionId
    || row.version_fingerprint !== prepared.sourceVersionId
    || row.object_id !== prepared.object.objectId
    || row.object_sha256 !== prepared.object.contentHash.slice('sha256:'.length)
    || row.object_key !== prepared.object.objectKey
    || Number(row.size_bytes) !== prepared.object.sizeBytes
    || row.expected_tombstone_id !== prepared.normalized.expectedTombstoneId
    || canonicalSourceJson(payload as unknown as SourceJsonValue)
      !== canonicalSourceJson(payloadFor(prepared) as unknown as SourceJsonValue)) {
    throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The durable ingest intent disagrees with its immutable identity.');
  }
}

async function prepareIntent(
  pool: VerifiedBrainPool,
  prepared: PreparedSourceIdentity,
): Promise<IntentRow> {
  return await withTransaction(pool, async (client) => {
    await lockRequest(client, prepared.intentId);
    const byIntent = await selectIntent(client, 'intent', prepared.intentId, true);
    const byRequest = byIntent ?? await selectIntent(client, 'request', prepared.normalized.requestKey, true);
    if (byRequest !== null) {
      assertExistingIntent(byRequest, prepared);
      return byRequest;
    }

    const payload = payloadFor(prepared);
    await client.query(
      `INSERT INTO brain.logical_sources
         (source_id, source_kind, origin_fingerprint, origin)
       VALUES ($1, $2, $1, $3::jsonb)
       ON CONFLICT (source_id) DO NOTHING`,
      [prepared.logicalSourceId, prepared.normalized.source.kind, JSON.stringify(prepared.normalized.source)],
    );
    const sourceResult = await client.query<SourceRow>(
      `SELECT source_kind, origin_fingerprint, origin, next_sequence::text,
              current_sequence::text, current_version_id, active_tombstone_id
         FROM brain.logical_sources WHERE source_id = $1 FOR UPDATE`,
      [prepared.logicalSourceId],
    );
    const source = sourceResult.rows[0];
    if (source === undefined
      || source.source_kind !== prepared.normalized.source.kind
      || source.origin_fingerprint !== prepared.logicalSourceId
      || canonicalSourceJson(source.origin as SourceJsonValue)
        !== canonicalSourceJson(prepared.normalized.source as unknown as SourceJsonValue)) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The logical source identity collides with different durable origin data.');
    }
    if (source.active_tombstone_id !== prepared.normalized.expectedTombstoneId) {
      throw lifecycleError(
        'BRAIN_SOURCE_TOMBSTONE_CONFLICT',
        'Ingestion must name the exact active tombstone before restoring a deleted source.',
      );
    }
    const sequenceResult = await client.query<{ prepared_sequence: string }>(
      `UPDATE brain.logical_sources
          SET next_sequence = next_sequence + 1
        WHERE source_id = $1
        RETURNING next_sequence::text AS prepared_sequence`,
      [prepared.logicalSourceId],
    );
    const sequence = sequenceResult.rows[0]?.prepared_sequence;
    if (sequence === undefined) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The source mutation sequence could not be allocated.');
    }
    const inserted = await client.query<IntentRow>(
      `INSERT INTO brain.ingest_intents
         (intent_id, request_key, request_fingerprint, source_id,
          prepared_sequence, source_version_id, version_fingerprint,
          object_id, object_sha256, object_key, size_bytes,
          expected_tombstone_id, request_payload, state)
       VALUES ($1, $2, $3, $4, $5::bigint, $6, $6, $7, $8, $9, $10::bigint,
               $11, $12::jsonb, 'prepared')
       RETURNING intent_id, request_key, request_fingerprint, source_id,
                 prepared_sequence::text, source_version_id, version_fingerprint,
                 object_id, object_sha256, object_key, size_bytes::text,
                 expected_tombstone_id, request_payload, state,
                 published_version_id, published_object_id, published_as_current`,
      [
        prepared.intentId,
        prepared.normalized.requestKey,
        prepared.requestFingerprint,
        prepared.logicalSourceId,
        sequence,
        prepared.sourceVersionId,
        prepared.object.objectId,
        prepared.object.contentHash.slice('sha256:'.length),
        prepared.object.objectKey,
        String(prepared.object.sizeBytes),
        prepared.normalized.expectedTombstoneId,
        JSON.stringify(payload),
      ],
    );
    return inserted.rows[0]!;
  });
}

function locators(payload: StoredRequestPayload): SourceJsonValue[] {
  if (payload.source.kind === 'workspace-file') {
    return [{ kind: 'workspace-path', value: payload.source.workspacePath }];
  }
  if (payload.source.kind === 'fetched-media' && payload.source.canonicalUrl !== null) {
    return [{ kind: 'canonical-url', value: payload.source.canonicalUrl }];
  }
  return [];
}

async function assertVersionEquivalent(
  client: QueryClient,
  intent: IntentRow,
  payload: StoredRequestPayload,
): Promise<void> {
  const evidence = payload.actor as unknown as SourceJsonValue;
  const metadata = { source: payload.source } as unknown as SourceJsonValue;
  const locatorValues = locators(payload);
  const equivalent = await client.query<{ matches: boolean }>(
    `SELECT source_id = $2
            AND version_fingerprint = $1
            AND object_id = $3
            AND media_type = $4
            AND source_timestamp IS NOT DISTINCT FROM $5::timestamptz
            AND privacy_class = $6
            AND trust_class = $7
            AND actor_assurance = $8
            AND assurance_evidence = $9::jsonb
            AND metadata = $10::jsonb
            AND provenance = $11::jsonb
            AND locators = $12::jsonb AS matches
       FROM brain.source_versions WHERE source_version_id = $1`,
    [
      intent.source_version_id,
      intent.source_id,
      intent.object_id,
      payload.media_type,
      payload.source_timestamp,
      payload.privacy,
      payload.trust,
      payload.actor.assurance,
      JSON.stringify(evidence),
      JSON.stringify(metadata),
      JSON.stringify(payload.provenance),
      JSON.stringify(locatorValues),
    ],
  );
  if (equivalent.rows[0]?.matches !== true) {
    throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The immutable source version disagrees with the ingest intent.');
  }
}

async function assertLabelsEquivalent(
  client: QueryClient,
  sourceVersionId: string,
  labels: readonly SourceRetrievalLabel[],
): Promise<void> {
  const result = await client.query<{ function_id: string | null; agent_id: string | null; plan_id: string | null }>(
    `SELECT function_id, agent_id, plan_id
       FROM brain.source_version_labels
      WHERE source_version_id = $1
      ORDER BY label_key`,
    [sourceVersionId],
  );
  const stored = result.rows.map((row) => ({
    workspace: labels[0]?.workspace ?? '',
    function: row.function_id,
    agent: row.agent_id,
    plan: row.plan_id,
  }));
  const storedKeys = stored
    .map((label) => canonicalSourceJson(label as unknown as SourceJsonValue))
    .sort();
  const expectedKeys = labels
    .map((label) => canonicalSourceJson(label as unknown as SourceJsonValue))
    .sort();
  if (canonicalSourceJson(storedKeys)
    !== canonicalSourceJson(expectedKeys)) {
    throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The immutable source labels disagree with the ingest intent.');
  }
}

async function publishVerifiedBrainIntent(
  pool: VerifiedBrainPool,
  observation: BrainObjectObservation,
  intentId: string,
  requestFingerprint: string,
): Promise<BrainIngestResult> {
  return await withTransaction(pool, async (client) => {
    await lockRequest(client, intentId);
    const intent = await selectIntent(client, 'intent', intentId, true);
    if (intent === null) throw lifecycleError('BRAIN_SOURCE_NOT_FOUND', 'The durable ingest intent does not exist.');
    if (intent.request_fingerprint !== requestFingerprint) {
      throw lifecycleError('BRAIN_SOURCE_IDEMPOTENCY_CONFLICT', 'The request fingerprint does not match the durable ingest intent.');
    }
    const durable = validateDurableIntent(pool.authority.workspaceId, intent);
    if (durable === null) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The durable ingest intent has invalid identity fields.');
    }
    if (intent.state === 'complete') return intentResult(intent);
    const { payload } = durable;
    if (observation.sha256 !== intent.object_sha256
      || observation.byteLength !== Number(intent.size_bytes)
      || observation.key !== intent.object_key) {
      throw lifecycleError('BRAIN_SOURCE_OBJECT_UNVERIFIED', 'The verified object observation does not match the durable ingest intent.');
    }

    const sourceResult = await client.query<SourceRow>(
      `SELECT source_kind, origin_fingerprint, origin, next_sequence::text,
              current_sequence::text, current_version_id, active_tombstone_id
         FROM brain.logical_sources WHERE source_id = $1 FOR UPDATE`,
      [intent.source_id],
    );
    const source = sourceResult.rows[0];
    if (source === undefined || !logicalSourceMatches(source, intent, payload)) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The intent source is missing or disagrees with its immutable origin.');
    }
    if (intent.expected_tombstone_id !== null
      && source.active_tombstone_id !== intent.expected_tombstone_id) {
      throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'The expected tombstone is no longer active.');
    }

    await client.query(
      `INSERT INTO brain.source_objects
         (object_id, sha256, object_key, size_bytes, etag, s3_version_id)
       VALUES ($1, $2, $3, $4::bigint, $5, $6)
       ON CONFLICT (object_id) DO NOTHING`,
      [intent.object_id, intent.object_sha256, intent.object_key, intent.size_bytes, observation.etag, observation.versionId],
    );
    const objectMatch = await client.query<{ matches: boolean }>(
      `SELECT object_id = $1 AND sha256 = $2 AND object_key = $3
              AND size_bytes = $4::bigint AS matches
         FROM brain.source_objects WHERE object_id = $1`,
      [intent.object_id, intent.object_sha256, intent.object_key, intent.size_bytes],
    );
    if (objectMatch.rows[0]?.matches !== true) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The immutable source object disagrees with the ingest intent.');
    }

    await client.query(
      `INSERT INTO brain.source_versions
         (source_version_id, source_id, version_fingerprint, object_id,
          first_prepared_sequence, media_type, source_timestamp, privacy_class,
          trust_class, actor_assurance, assurance_evidence, metadata, provenance, locators)
       VALUES ($1, $2, $1, $3, $4::bigint, $5, $6::timestamptz, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)
       ON CONFLICT (source_version_id) DO NOTHING`,
      [
        intent.source_version_id,
        intent.source_id,
        intent.object_id,
        intent.prepared_sequence,
        payload.media_type,
        payload.source_timestamp,
        payload.privacy,
        payload.trust,
        payload.actor.assurance,
        JSON.stringify(payload.actor),
        JSON.stringify({ source: payload.source }),
        JSON.stringify(payload.provenance),
        JSON.stringify(locators(payload)),
      ],
    );
    await assertVersionEquivalent(client, intent, payload);

    for (const label of payload.labels) {
      await client.query(
        `INSERT INTO brain.source_version_labels
           (source_version_id, function_id, agent_id, plan_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_version_id, label_key) DO NOTHING`,
        [intent.source_version_id, label.function, label.agent, label.plan],
      );
    }
    await assertLabelsEquivalent(client, intent.source_version_id, payload.labels);

    let becameCurrent: boolean;
    if (intent.expected_tombstone_id !== null) {
      const restored = await client.query(
        `UPDATE brain.source_tombstones
            SET restored_sequence = $3::bigint,
                restored_version_id = $4,
                restored_by_intent_id = $5,
                restored_at = now()
          WHERE source_id = $1 AND tombstone_id = $2 AND restored_at IS NULL`,
        [intent.source_id, intent.expected_tombstone_id, intent.prepared_sequence, intent.source_version_id, intent.intent_id],
      );
      if ((restored.rowCount ?? 0) !== 1) {
        throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'The expected tombstone was already consumed.');
      }
      const promoted = await client.query(
        `UPDATE brain.logical_sources
            SET current_sequence = $2::bigint,
                current_version_id = $3,
                active_tombstone_id = NULL
          WHERE source_id = $1
            AND active_tombstone_id = $4
            AND current_sequence < $2::bigint`,
        [intent.source_id, intent.prepared_sequence, intent.source_version_id, intent.expected_tombstone_id],
      );
      if ((promoted.rowCount ?? 0) !== 1) {
        throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'The tombstoned source advanced before publication.');
      }
      becameCurrent = true;
    } else {
      const promoted = await client.query(
        `UPDATE brain.logical_sources
            SET current_sequence = $2::bigint, current_version_id = $3
          WHERE source_id = $1
            AND active_tombstone_id IS NULL
            AND current_sequence < $2::bigint`,
        [intent.source_id, intent.prepared_sequence, intent.source_version_id],
      );
      becameCurrent = (promoted.rowCount ?? 0) === 1;
    }

    const completed = await client.query<IntentRow>(
      `UPDATE brain.ingest_intents
          SET state = 'complete',
              published_version_id = source_version_id,
              published_object_id = object_id,
              published_as_current = $2,
              completed_at = now()
        WHERE intent_id = $1 AND state = 'prepared'
        RETURNING intent_id, request_key, request_fingerprint, source_id,
                  prepared_sequence::text, source_version_id, version_fingerprint,
                  object_id, object_sha256, object_key, size_bytes::text,
                  expected_tombstone_id, request_payload, state,
                  published_version_id, published_object_id, published_as_current`,
      [intent.intent_id, becameCurrent],
    );
    const completedRow = completed.rows[0];
    if (completedRow === undefined) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The ingest intent could not be completed atomically.');
    }
    return intentResult(completedRow);
  });
}

export async function ingestBrainSource(
  deps: { pool: VerifiedBrainPool; objectStore: BrainObjectStore },
  input: SourceIngestInput,
): Promise<BrainIngestResult> {
  const prepared = prepareSourceIdentity(deps.pool.authority.workspaceId, input);
  assertNamespace(deps.pool, deps.objectStore);
  const intent = await prepareIntent(deps.pool, prepared);
  if (intent.state === 'complete') {
    const inspected = await readBrainIngestIntent(deps.pool, intent.intent_id);
    if (inspected === null || inspected.databaseIntegrity !== 'verified') {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The completed ingest intent has invalid durable dependencies.');
    }
    return intentResult(intent);
  }
  const observation = await deps.objectStore.createOrVerify({
    sha256: intent.object_sha256,
    bytes: prepared.bytes,
    contentType: prepared.normalized.mediaType,
  });
  return await publishVerifiedBrainIntent(
    deps.pool,
    observation,
    intent.intent_id,
    intent.request_fingerprint,
  );
}

export async function publishPreparedBrainIntent(
  pool: VerifiedBrainPool,
  objectStore: BrainObjectStore,
  intentId: string,
  requestFingerprint: string,
): Promise<BrainIngestResult> {
  assertSha256Id(intentId, 'intentId');
  assertSha256Id(requestFingerprint, 'requestFingerprint');
  assertNamespace(pool, objectStore);
  const intent = await readBrainIngestIntent(pool, intentId);
  if (intent === null) throw lifecycleError('BRAIN_SOURCE_NOT_FOUND', 'The durable ingest intent does not exist.');
  if (intent.databaseIntegrity !== 'verified') {
    throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The durable ingest intent has invalid dependencies.');
  }
  if (intent.requestFingerprint !== requestFingerprint) {
    throw lifecycleError('BRAIN_SOURCE_IDEMPOTENCY_CONFLICT', 'The request fingerprint does not match the durable ingest intent.');
  }
  if (intent.state === 'complete') {
    return Object.freeze({
      intentId: intent.intentId,
      sourceId: intent.sourceId,
      sourceVersionId: intent.sourceVersionId,
      objectId: intent.objectId,
      objectKey: intent.objectKey,
      publishedAsCurrent: intent.publishedAsCurrent!,
    });
  }
  const inspection = await objectStore.inspect({
    sha256: intent.objectSha256,
    byteLength: intent.sizeBytes,
  });
  if (inspection.status !== 'verified') {
    throw lifecycleError('BRAIN_SOURCE_OBJECT_UNVERIFIED', 'The intent-owned object is not present with exact verified bytes.');
  }
  return await publishVerifiedBrainIntent(pool, inspection, intentId, requestFingerprint);
}

export async function readBrainIngestIntent(
  pool: VerifiedBrainPool,
  intentId: string,
): Promise<BrainIngestIntent | null> {
  assertSha256Id(intentId, 'intentId');
  const client = await pool.connect();
  try {
    const row = await selectIntent(client, 'intent', intentId);
    if (row === null) return null;
    const durable = validateDurableIntent(pool.authority.workspaceId, row);
    const payload = durable?.payload ?? null;
    let databaseIntegrity: BrainIngestIntent['databaseIntegrity'] = durable !== null
      ? 'verified'
      : 'corrupt';
    const source = await client.query<SourceRow>(
      `SELECT source_kind, origin_fingerprint, origin, next_sequence::text,
              current_sequence::text, current_version_id, active_tombstone_id
         FROM brain.logical_sources WHERE source_id = $1`,
      [row.source_id],
    );
    if (source.rows[0] === undefined
      || payload === null
      || !logicalSourceMatches(source.rows[0], row, payload)) databaseIntegrity = 'corrupt';
    const tombstoneMatches = row.expected_tombstone_id === null
      ? source.rows[0] !== undefined
      : source.rows[0]?.active_tombstone_id === row.expected_tombstone_id;
    if (row.state === 'complete') {
      const object = await client.query<{ matches: boolean }>(
        `SELECT object_id = $1 AND sha256 = $2 AND object_key = $3
                AND size_bytes = $4::bigint AS matches
           FROM brain.source_objects WHERE object_id = $1`,
        [row.object_id, row.object_sha256, row.object_key, row.size_bytes],
      );
      if (object.rows[0]?.matches !== true
        || row.published_version_id !== row.source_version_id
        || row.published_object_id !== row.object_id
        || row.published_as_current === null) databaseIntegrity = 'corrupt';
      if (payload !== null) {
        try {
          await assertVersionEquivalent(client, row, payload);
          await assertLabelsEquivalent(client, row.source_version_id, payload.labels);
        } catch (error) {
          if (error instanceof RosterError && error.code === 'BRAIN_SOURCE_INTEGRITY_CONFLICT') {
            databaseIntegrity = 'corrupt';
          } else {
            throw error;
          }
        }
      }
    }
    return Object.freeze({
      intentId: row.intent_id,
      requestKey: row.request_key,
      requestFingerprint: row.request_fingerprint,
      sourceId: row.source_id,
      preparedSequence: row.prepared_sequence,
      sourceVersionId: row.source_version_id,
      versionFingerprint: row.version_fingerprint,
      objectId: row.object_id,
      objectSha256: row.object_sha256,
      objectKey: row.object_key,
      sizeBytes: Number(row.size_bytes),
      expectedTombstoneId: row.expected_tombstone_id,
      contentType: payload?.media_type ?? '',
      state: row.state,
      publishedVersionId: row.published_version_id,
      publishedObjectId: row.published_object_id,
      publishedAsCurrent: row.published_as_current,
      tombstoneMatches,
      databaseIntegrity,
    });
  } finally {
    client.release();
  }
}

function normalizeLifecycleActor(actor: SourceActorInput): PreparedSourceIdentity['normalized']['actor'] {
  return normalizeSourceActor(actor);
}

export async function tombstoneBrainSource(
  pool: VerifiedBrainPool,
  input: BrainTombstoneInput,
): Promise<BrainTombstoneResult> {
  const sourceId = assertSha256Id(input.sourceId, 'sourceId');
  const requestKey = normalizeSourceRequestKey(input.requestKey);
  const reason = normalizeReason(input.reason);
  const actor = normalizeLifecycleActor(input.actor);
  const provenance = normalizeSourceProvenance(input.provenance);
  const tombstoneId = canonicalDigest('roster.brain.source-tombstone.v1', {
    workspace_id: pool.authority.workspaceId,
    request_key: requestKey,
  });
  const fingerprint = canonicalDigest('roster.brain.source-tombstone-request.v1', {
    workspace_id: pool.authority.workspaceId,
    source_id: sourceId,
    reason,
    actor: actor as unknown as SourceJsonValue,
    provenance,
  });
  return await withTransaction(pool, async (client) => {
    await lockRequest(client, tombstoneId);
    const existing = await client.query<{
      tombstone_id: string;
      source_id: string;
      sequence: string;
      prior_version_id: string;
      request_fingerprint: string;
    }>(
      `SELECT tombstone_id, source_id, sequence::text, prior_version_id, request_fingerprint
         FROM brain.source_tombstones
        WHERE tombstone_id = $1 OR request_key = $2
        FOR UPDATE`,
      [tombstoneId, requestKey],
    );
    if (existing.rows.length > 1) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The tombstone request resolves to conflicting durable rows.');
    }
    const replay = existing.rows[0];
    if (replay !== undefined) {
      if (replay.tombstone_id !== tombstoneId
        || replay.source_id !== sourceId
        || replay.request_fingerprint !== fingerprint) {
        throw lifecycleError('BRAIN_SOURCE_IDEMPOTENCY_CONFLICT', 'The tombstone request key is bound to different input.');
      }
      return Object.freeze({
        tombstoneId: replay.tombstone_id,
        sourceId: replay.source_id,
        sequence: replay.sequence,
        priorVersionId: replay.prior_version_id,
      });
    }
    const sourceResult = await client.query<{
      current_version_id: string | null;
      active_tombstone_id: string | null;
    }>(
      `SELECT current_version_id, active_tombstone_id
         FROM brain.logical_sources WHERE source_id = $1 FOR UPDATE`,
      [sourceId],
    );
    const source = sourceResult.rows[0];
    if (source === undefined || source.current_version_id === null) {
      throw lifecycleError('BRAIN_SOURCE_NOT_FOUND', 'The logical source has no current version to tombstone.');
    }
    if (source.active_tombstone_id !== null) {
      throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'The logical source already has an active tombstone.');
    }
    const sequenceResult = await client.query<{ sequence: string }>(
      `UPDATE brain.logical_sources SET next_sequence = next_sequence + 1
        WHERE source_id = $1 RETURNING next_sequence::text AS sequence`,
      [sourceId],
    );
    const sequence = sequenceResult.rows[0]!.sequence;
    const inserted = await client.query(
      `INSERT INTO brain.source_tombstones
         (tombstone_id, source_id, sequence, prior_version_id, request_key,
          request_fingerprint, reason, actor_assurance, assurance_evidence, provenance)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
      [
        tombstoneId,
        sourceId,
        sequence,
        source.current_version_id,
        requestKey,
        fingerprint,
        reason,
        actor.assurance,
        JSON.stringify(actor),
        JSON.stringify(provenance),
      ],
    );
    if ((inserted.rowCount ?? 0) !== 1) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The tombstone history row could not be recorded atomically.');
    }
    const activated = await client.query(
      `UPDATE brain.logical_sources
          SET current_sequence = $2::bigint, active_tombstone_id = $3
        WHERE source_id = $1`,
      [sourceId, sequence, tombstoneId],
    );
    if ((activated.rowCount ?? 0) !== 1) {
      throw lifecycleError('BRAIN_SOURCE_INTEGRITY_CONFLICT', 'The tombstone could not become active atomically.');
    }
    return Object.freeze({
      tombstoneId,
      sourceId,
      sequence,
      priorVersionId: source.current_version_id,
    });
  });
}

export async function restoreBrainSource(
  pool: VerifiedBrainPool,
  input: BrainRestoreInput,
): Promise<BrainRestoreResult> {
  const tombstoneId = assertSha256Id(input.tombstoneId, 'tombstoneId');
  const requestKey = normalizeSourceRequestKey(input.requestKey);
  const actor = normalizeLifecycleActor(input.actor);
  const provenance = normalizeSourceProvenance(input.provenance);
  const restoreRequestId = canonicalDigest('roster.brain.source-restore-intent.v1', {
    workspace_id: pool.authority.workspaceId,
    request_key: requestKey,
  });
  const fingerprint = canonicalDigest('roster.brain.source-restore-request.v1', {
    workspace_id: pool.authority.workspaceId,
    tombstone_id: tombstoneId,
    actor: actor as unknown as SourceJsonValue,
    provenance,
  });
  return await withTransaction(pool, async (client) => {
    await lockRequest(client, restoreRequestId);
    const replayResult = await client.query<{
      tombstone_id: string;
      source_id: string;
      restored_sequence: string;
      restored_version_id: string;
      restore_request_fingerprint: string;
    }>(
      `SELECT tombstone_id, source_id, restored_sequence::text, restored_version_id,
              restore_request_fingerprint
         FROM brain.source_tombstones
        WHERE restore_request_key = $1
        FOR UPDATE`,
      [requestKey],
    );
    const replay = replayResult.rows[0];
    if (replay !== undefined) {
      if (replay.tombstone_id !== tombstoneId || replay.restore_request_fingerprint !== fingerprint) {
        throw lifecycleError('BRAIN_SOURCE_IDEMPOTENCY_CONFLICT', 'The restore request key is bound to different input.');
      }
      return Object.freeze({
        tombstoneId: replay.tombstone_id,
        sourceId: replay.source_id,
        sequence: replay.restored_sequence,
        restoredVersionId: replay.restored_version_id,
      });
    }
    const targetResult = await client.query<{
      source_id: string;
      prior_version_id: string;
      restored_at: string | null;
    }>(
      `SELECT source_id, prior_version_id, restored_at::text
         FROM brain.source_tombstones WHERE tombstone_id = $1`,
      [tombstoneId],
    );
    const target = targetResult.rows[0];
    if (target === undefined) throw lifecycleError('BRAIN_SOURCE_NOT_FOUND', 'The exact tombstone does not exist.');
    const sourceResult = await client.query<{ active_tombstone_id: string | null }>(
      `SELECT active_tombstone_id FROM brain.logical_sources WHERE source_id = $1 FOR UPDATE`,
      [target.source_id],
    );
    const lockedTarget = await client.query<{
      prior_version_id: string;
      restored_at: string | null;
    }>(
      `SELECT prior_version_id, restored_at::text
         FROM brain.source_tombstones
        WHERE tombstone_id = $1 AND source_id = $2 FOR UPDATE`,
      [tombstoneId, target.source_id],
    );
    if (sourceResult.rows[0]?.active_tombstone_id !== tombstoneId
      || lockedTarget.rows[0] === undefined
      || lockedTarget.rows[0].restored_at !== null) {
      throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'Only the exact active tombstone can restore the source.');
    }
    const sequenceResult = await client.query<{ sequence: string }>(
      `UPDATE brain.logical_sources SET next_sequence = next_sequence + 1
        WHERE source_id = $1 RETURNING next_sequence::text AS sequence`,
      [target.source_id],
    );
    const sequence = sequenceResult.rows[0]!.sequence;
    const consumed = await client.query(
      `UPDATE brain.source_tombstones
          SET restored_sequence = $2::bigint,
              restored_version_id = prior_version_id,
              restore_request_key = $3,
              restore_request_fingerprint = $4,
              restored_at = now()
        WHERE tombstone_id = $1`,
      [tombstoneId, sequence, requestKey, fingerprint],
    );
    if ((consumed.rowCount ?? 0) !== 1) {
      throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'The exact tombstone could not be consumed atomically.');
    }
    const restored = await client.query(
      `UPDATE brain.logical_sources
          SET current_sequence = $2::bigint,
              current_version_id = $3,
              active_tombstone_id = NULL
        WHERE source_id = $1 AND active_tombstone_id = $4`,
      [target.source_id, sequence, target.prior_version_id, tombstoneId],
    );
    if ((restored.rowCount ?? 0) !== 1) {
      throw lifecycleError('BRAIN_SOURCE_TOMBSTONE_CONFLICT', 'The exact tombstone could not restore the source atomically.');
    }
    return Object.freeze({
      tombstoneId,
      sourceId: target.source_id,
      sequence,
      restoredVersionId: target.prior_version_id,
    });
  });
}
