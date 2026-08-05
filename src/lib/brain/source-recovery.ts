import { createHash } from 'node:crypto';
import { EXIT_ERROR, RosterError } from '../errors.ts';
import type {
  BrainObjectStore,
  BrainObjectInspection,
} from './object-store.ts';
import {
  publishPreparedBrainIntent,
  readBrainIngestIntent,
  type BrainIngestIntent,
} from './source-lifecycle.ts';
import { MAX_SOURCE_BYTES } from './source-contracts.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';

const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-/]*$/u;

export type BrainSourceRecoveryStatus =
  | 'prepared'
  | 'publish-pending'
  | 'complete'
  | 'missing'
  | 'corrupt'
  | 'conflict';

export type BrainSourceRecoveryReason =
  | 'object-absent'
  | 'object-verified'
  | 'published-object-verified'
  | 'published-object-missing'
  | 'stored-object-invalid'
  | 'durable-state-invalid'
  | 'intent-not-found'
  | 'request-fingerprint-mismatch'
  | 'tombstone-mismatch'
  | 'supplied-bytes-mismatch';

export type BrainSourceRecoveryReport = Readonly<{
  status: BrainSourceRecoveryStatus;
  reason: BrainSourceRecoveryReason;
  repairable: boolean;
  requiresBytes: boolean;
}>;

export type BrainSourceRecoveryRequest = Readonly<{
  intentId: string;
  requestFingerprint: string;
}>;

export type BrainSourceRepairRequest = BrainSourceRecoveryRequest & Readonly<{
  bytes?: Uint8Array;
}>;

type RecoveryInspection = Readonly<{
  report: BrainSourceRecoveryReport;
  intent: BrainIngestIntent | null;
  object: BrainObjectInspection | null;
}>;

function recoveryError(code: 'BRAIN_SOURCE_RECOVERY_INPUT_INVALID' | 'BRAIN_SOURCE_NAMESPACE_MISMATCH', body: string): RosterError {
  return new RosterError({
    header: 'Brain source recovery refused the request',
    body,
    remedy: code === 'BRAIN_SOURCE_NAMESPACE_MISMATCH'
      ? 'Use the object store configured for this verified Brain workspace.'
      : 'Provide the exact durable intent ID and its expected request fingerprint.',
    exitCode: EXIT_ERROR,
    code,
  });
}

function assertRecoveryRequest(request: BrainSourceRecoveryRequest): void {
  if (request === null
    || typeof request !== 'object'
    || !SHA256_ID.test(request.intentId)
    || !SHA256_ID.test(request.requestFingerprint)) {
    throw recoveryError(
      'BRAIN_SOURCE_RECOVERY_INPUT_INVALID',
      'Recovery requires exact lowercase SHA-256 intent and request identifiers.',
    );
  }
}

function assertNamespace(pool: VerifiedBrainPool, objectStore: BrainObjectStore): void {
  if (objectStore.namespaceFingerprint !== pool.authority.namespaceFingerprint) {
    throw recoveryError(
      'BRAIN_SOURCE_NAMESPACE_MISMATCH',
      'The object store is not bound to the verified Brain workspace namespace.',
    );
  }
}

function report(
  status: BrainSourceRecoveryStatus,
  reason: BrainSourceRecoveryReason,
  repairable: boolean,
  requiresBytes: boolean,
): BrainSourceRecoveryReport {
  return Object.freeze({ status, reason, repairable, requiresBytes });
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validIntentShape(intent: BrainIngestIntent): boolean {
  return SHA256_ID.test(intent.intentId)
    && SHA256_ID.test(intent.requestFingerprint)
    && (intent.state === 'prepared' || intent.state === 'complete')
    && SHA256_HEX.test(intent.objectSha256)
    && intent.objectKey === `objects/${intent.objectSha256.slice(0, 2)}/${intent.objectSha256}`
    && Number.isSafeInteger(intent.sizeBytes)
    && intent.sizeBytes >= 0
    && intent.sizeBytes <= MAX_SOURCE_BYTES
    && typeof intent.contentType === 'string'
    && Buffer.byteLength(intent.contentType, 'utf8') <= 128
    && CONTENT_TYPE.test(intent.contentType)
    && (intent.databaseIntegrity === 'verified' || intent.databaseIntegrity === 'corrupt')
    && typeof intent.tombstoneMatches === 'boolean';
}

async function inspectRecovery(
  pool: VerifiedBrainPool,
  objectStore: BrainObjectStore,
  request: BrainSourceRecoveryRequest,
): Promise<RecoveryInspection> {
  assertRecoveryRequest(request);
  assertNamespace(pool, objectStore);

  const intent = await readBrainIngestIntent(pool, request.intentId);
  if (intent === null) {
    return {
      report: report('conflict', 'intent-not-found', false, false),
      intent: null,
      object: null,
    };
  }
  if (!validIntentShape(intent) || intent.intentId !== request.intentId || intent.databaseIntegrity === 'corrupt') {
    return {
      report: report('corrupt', 'durable-state-invalid', false, false),
      intent,
      object: null,
    };
  }
  if (intent.requestFingerprint !== request.requestFingerprint) {
    return {
      report: report('conflict', 'request-fingerprint-mismatch', false, false),
      intent,
      object: null,
    };
  }
  if (intent.state === 'prepared' && !intent.tombstoneMatches) {
    return {
      report: report('conflict', 'tombstone-mismatch', false, false),
      intent,
      object: null,
    };
  }

  const object = await objectStore.inspect({
    sha256: intent.objectSha256,
    byteLength: intent.sizeBytes,
  });
  if (object.status === 'corrupt') {
    return {
      report: report('corrupt', 'stored-object-invalid', false, false),
      intent,
      object,
    };
  }
  if (object.status === 'missing') {
    return {
      report: intent.state === 'complete'
        ? report('missing', 'published-object-missing', true, true)
        : report('prepared', 'object-absent', true, true),
      intent,
      object,
    };
  }
  if (object.sha256 !== intent.objectSha256
    || object.byteLength !== intent.sizeBytes
    || object.key !== intent.objectKey) {
    return {
      report: report('corrupt', 'stored-object-invalid', false, false),
      intent,
      object,
    };
  }
  return {
    report: intent.state === 'complete'
      ? report('complete', 'published-object-verified', false, false)
      : report('publish-pending', 'object-verified', true, false),
    intent,
    object,
  };
}

export async function inspectBrainSourceIntent(
  pool: VerifiedBrainPool,
  objectStore: BrainObjectStore,
  request: BrainSourceRecoveryRequest,
): Promise<BrainSourceRecoveryReport> {
  return (await inspectRecovery(pool, objectStore, request)).report;
}

export async function repairBrainSourceIntent(
  pool: VerifiedBrainPool,
  objectStore: BrainObjectStore,
  request: BrainSourceRepairRequest,
): Promise<BrainSourceRecoveryReport> {
  assertRecoveryRequest(request);
  if (request.bytes !== undefined && !(request.bytes instanceof Uint8Array)) {
    throw recoveryError(
      'BRAIN_SOURCE_RECOVERY_INPUT_INVALID',
      'Repair bytes must be supplied as a Uint8Array.',
    );
  }
  const inspected = await inspectRecovery(pool, objectStore, request);
  const { intent } = inspected;
  if (intent === null
    || inspected.report.status === 'complete'
    || inspected.report.status === 'conflict'
    || inspected.report.status === 'corrupt') {
    return inspected.report;
  }

  if (inspected.report.status !== 'publish-pending') {
    if (request.bytes === undefined) return inspected.report;
    if (request.bytes.byteLength !== intent.sizeBytes
      || digest(request.bytes) !== intent.objectSha256) {
      return report('corrupt', 'supplied-bytes-mismatch', true, true);
    }
    await objectStore.createOrVerify({
      sha256: intent.objectSha256,
      bytes: request.bytes,
      contentType: intent.contentType,
    });
  }

  if (intent.state === 'prepared') {
    await publishPreparedBrainIntent(pool, objectStore, request.intentId, request.requestFingerprint);
  }
  return (await inspectRecovery(pool, objectStore, request)).report;
}
