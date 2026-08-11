import { createHash } from 'node:crypto';
import {
  canonicalSourceJson,
  normalizeSourceIngest,
  type NormalizedSourceIngest,
  type SourceIngestInput,
  type SourceJsonValue,
  type SourceOrigin,
} from './source-contracts.ts';
import { assertWorkspaceId } from '../workspace-layout.ts';

export const LOGICAL_SOURCE_DOMAIN = 'roster.brain.logical-source.v1';
export const SOURCE_VERSION_DOMAIN = 'roster.brain.source-version.v1';
export const INGEST_INTENT_DOMAIN = 'roster.brain.ingest-intent.v1';
export const INGEST_REQUEST_DOMAIN = 'roster.brain.ingest-request.v1';

export type SourceObjectIdentity = Readonly<{
  contentHash: string;
  objectId: string;
  objectKey: string;
  sizeBytes: number;
}>;

export type PreparedSourceIdentity = Readonly<{
  normalized: NormalizedSourceIngest;
  bytes: Buffer;
  logicalSourceId: string;
  sourceVersionId: string;
  intentId: string;
  requestFingerprint: string;
  object: SourceObjectIdentity;
}>;

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(domain: string, value: SourceJsonValue): string {
  return sha256(canonicalSourceJson({ domain, value }));
}

function logicalOrigin(source: SourceOrigin): SourceJsonValue {
  if (source.kind === 'workspace-file') {
    return { kind: source.kind, workspace_path: source.workspacePath };
  }
  if (source.kind === 'fetched-media') {
    if (source.identity.kind === 'provider-id') {
      return {
        kind: source.kind,
        identity: {
          kind: source.identity.kind,
          provider: source.identity.provider,
          upstream_id: source.identity.upstreamId,
        },
      };
    }
    return {
      kind: source.kind,
      identity: { kind: source.identity.kind, canonical_url: source.identity.canonicalUrl },
    };
  }
  return { kind: source.kind, stable_key: source.stableKey };
}

function immutableMetadata(normalized: NormalizedSourceIngest): SourceJsonValue {
  return {
    source: normalized.source as unknown as SourceJsonValue,
    labels: normalized.labels as unknown as SourceJsonValue,
    privacy: normalized.privacy,
    trust: normalized.trust,
    actor: normalized.actor as unknown as SourceJsonValue,
    media_type: normalized.mediaType,
    source_timestamp: normalized.sourceTimestamp,
    provenance: normalized.provenance,
  };
}

export const LEGACY_RECORD_DOMAIN = 'roster.brain.legacy-record.v1';

export type LegacyRecordKey =
  | Readonly<{ kind: 'entity'; entityKind: string; slug: string }>
  | Readonly<{ kind: 'fact'; entityKind: string; slug: string; key: string }>
  | Readonly<{ kind: 'event'; id: string }>
  | Readonly<{
    kind: 'edge';
    fromKind: string;
    fromSlug: string;
    rel: string;
    toKind: string;
    toSlug: string;
  }>;

// v1 `entities.kind/.slug`, `facts.key`, and `edges.rel` are plain `text NOT
// NULL` with no CHECK, while SourceOriginInput.stableKey is a 256-byte STABLE_KEY
// class. Interpolation is therefore neither total nor injective. The preimage is
// a canonical JSON ARRAY of strings — never a concatenation — so no delimiter is
// interpretable and the 81-byte result always conforms.
export function legacyRecordStableKey(record: LegacyRecordKey): string {
  const tuple: readonly string[] = record.kind === 'entity'
    ? ['entity', record.entityKind, record.slug]
    : record.kind === 'fact'
      ? ['fact', record.entityKind, record.slug, record.key]
      : record.kind === 'event'
        ? ['event', record.id]
        : [
          'edge',
          record.fromKind,
          record.fromSlug,
          record.rel,
          record.toKind,
          record.toSlug,
        ];
  const hex = createHash('sha256')
    .update(canonicalSourceJson({
      domain: LEGACY_RECORD_DOMAIN,
      value: tuple as unknown as SourceJsonValue,
    }), 'utf8')
    .digest('hex');
  return `legacy.${record.kind}.v1:${hex}`;
}

export function deriveLogicalSourceId(workspaceId: string, source: SourceOrigin): string {
  return canonicalDigest(LOGICAL_SOURCE_DOMAIN, {
    workspace_id: assertWorkspaceId(workspaceId),
    origin: logicalOrigin(source),
  });
}

export function deriveSourceObjectIdentity(bytes: Uint8Array): SourceObjectIdentity {
  const contentHash = sha256(bytes);
  const digest = contentHash.slice('sha256:'.length);
  return Object.freeze({
    contentHash,
    objectId: contentHash,
    objectKey: `objects/${digest.slice(0, 2)}/${digest}`,
    sizeBytes: bytes.byteLength,
  });
}

export function deriveSourceVersionId(
  logicalSourceId: string,
  objectId: string,
  normalized: NormalizedSourceIngest,
): string {
  return canonicalDigest(SOURCE_VERSION_DOMAIN, {
    logical_source_id: logicalSourceId,
    object_id: objectId,
    metadata: immutableMetadata(normalized),
  });
}

export function deriveIngestIntentId(workspaceId: string, requestKey: string): string {
  return canonicalDigest(INGEST_INTENT_DOMAIN, {
    workspace_id: assertWorkspaceId(workspaceId),
    request_key: requestKey,
  });
}

export function deriveIngestRequestFingerprint(
  workspaceId: string,
  logicalSourceId: string,
  object: SourceObjectIdentity,
  normalized: NormalizedSourceIngest,
): string {
  return canonicalDigest(INGEST_REQUEST_DOMAIN, {
    workspace_id: assertWorkspaceId(workspaceId),
    logical_source_id: logicalSourceId,
    object_id: object.objectId,
    content_hash: object.contentHash,
    size_bytes: object.sizeBytes,
    expected_tombstone_id: normalized.expectedTombstoneId,
    metadata: immutableMetadata(normalized),
  });
}

export function prepareSourceIdentity(workspaceId: string, input: SourceIngestInput): PreparedSourceIdentity {
  const workspace = assertWorkspaceId(workspaceId);
  const normalized = normalizeSourceIngest(workspace, input);
  const bytes = Buffer.from(normalized.bytes);
  const object = deriveSourceObjectIdentity(bytes);
  const logicalSourceId = deriveLogicalSourceId(workspace, normalized.source);
  const sourceVersionId = deriveSourceVersionId(logicalSourceId, object.objectId, normalized);
  return Object.freeze({
    normalized,
    bytes,
    logicalSourceId,
    sourceVersionId,
    intentId: deriveIngestIntentId(workspace, normalized.requestKey),
    requestFingerprint: deriveIngestRequestFingerprint(workspace, logicalSourceId, object, normalized),
    object,
  });
}
