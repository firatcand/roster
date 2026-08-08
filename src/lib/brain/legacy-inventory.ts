import { createHash } from 'node:crypto';
import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import { canonicalSourceJson, type SourceJsonValue } from './source-contracts.ts';

export const LEGACY_INVENTORY_MANIFEST_FORMAT_VERSION = 1;
export const LEGACY_INVENTORY_ALGORITHM = 'roster-legacy-inventory-v1';
export const LEGACY_INVENTORY_TOKEN_SCHEME = 'sha256-domain-v1';
export const LEGACY_INVENTORY_TOKEN_CONTEXT = 'roster/legacy-inventory/v1/';
export const LEGACY_S3_CURSOR_FORMAT = 'roster-legacy-inventory-s3-cursor/v1';

export const LEGACY_INVENTORY_TOKEN_DOMAINS = [
  'relation-name',
  'column-name',
  'role-name',
  's3-key',
  'path',
  'stable-id',
  'schema-name',
] as const;
export type LegacyInventoryTokenDomain = (typeof LEGACY_INVENTORY_TOKEN_DOMAINS)[number];

export const LEGACY_INVENTORY_FINDING_CODES = [
  'absolute-locator',
  'temporary-locator',
  'foreign-locator',
  'malformed-locator',
  'userinfo-locator',
  'reused-hash',
  'missing-bytes',
  'ambiguous-version-match',
  'mutable-key-history',
  'etag-drift',
  'version-drift',
  'ambiguous-ownership',
  'partial-cutover',
  'migration-metadata-missing',
  'migration-metadata-malformed',
  'identity-mismatch',
  'identity-unverified-refused',
  'catalog-shape-unsafe',
  'missing-stable-key',
  'relation-limit',
  'row-limit',
  'object-history-limit',
  'finding-limit',
  'time-limit',
  'cursor-invalid',
  'provider-integrity',
  'connection-affinity',
  'sql-error',
  'provider-error',
] as const;
export type LegacyInventoryFindingCode = (typeof LEGACY_INVENTORY_FINDING_CODES)[number];

const FATAL_FINDING_CODES: ReadonlySet<LegacyInventoryFindingCode> = new Set([
  'identity-mismatch',
  'identity-unverified-refused',
  'catalog-shape-unsafe',
  'missing-stable-key',
  'relation-limit',
  'row-limit',
  'object-history-limit',
  'finding-limit',
  'time-limit',
  'cursor-invalid',
  'provider-integrity',
  'connection-affinity',
  'sql-error',
  'provider-error',
]);

export const LEGACY_INVENTORY_RESOURCE_KINDS = [
  'database',
  'relation',
  'row',
  'role',
  'migration',
  'object',
  'object-version',
  'inventory',
] as const;
export type LegacyInventoryResourceKind = (typeof LEGACY_INVENTORY_RESOURCE_KINDS)[number];

export type LegacyInventoryFinding = Readonly<{
  code: LegacyInventoryFindingCode;
  resource_kind: LegacyInventoryResourceKind;
  resource_ref: string;
  detail_ref: string;
}>;

// The whole inventory runs inside one REPEATABLE READ transaction, so it must
// execute on exactly ONE PostgreSQL session. The port is therefore structural:
// connect() is called once, every statement (BEGIN, pins, probes, reads,
// ROLLBACK) is issued on the returned session, and release() runs in finally.
// pg.Pool satisfies it directly; a raw pg.Client adapts by returning itself
// from connect() with a no-op release(). One pg_backend_pid() probe pair at
// transaction start remains as defense in depth against misbehaving proxies.
export type LegacyInventoryPgSession = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }>;
  release(): void;
};

export type LegacyInventoryPgPort = {
  connect(): Promise<LegacyInventoryPgSession>;
};

export type LegacyObjectHistoryObservation = {
  kind: 'version' | 'delete-marker';
  key: string;
  versionId: string | null;
  isLatest: boolean;
  etag: string | null;
  sizeBytes: string | null;
};

export type LegacyObjectHistoryPage = {
  entries: readonly LegacyObjectHistoryObservation[];
  cursor: string | null;
};

export type LegacyObjectHeadVersion = {
  etag: string | null;
  sizeBytes: string;
  versionId: string | null;
};

export type LegacyObjectHistoryReader = {
  readonly bucket: string;
  readonly prefix: string;
  readonly namespaceFingerprint: string;
  listHistory(cursor: string | null): Promise<LegacyObjectHistoryPage>;
  headVersion(input: { key: string; versionId: string }): Promise<LegacyObjectHeadVersion | null>;
};

export type LegacyInventoryLimits = {
  maxRelations: number;
  maxStableIdRows: number;
  maxObjectHistoryPages: number;
  maxObjectHistoryItems: number;
  maxFindings: number;
  maxTransactionMs: number;
};

export type LegacyInventoryExpectedIdentity = {
  workspaceId: string;
  fingerprintFormatVersion: number;
  namespaceFingerprint: string;
};

export type LegacyAbsentIdentityPolicy = 'refuse' | 'permit-unverified';

export type LegacyInventoryInput = {
  pg: LegacyInventoryPgPort;
  objectHistory: LegacyObjectHistoryReader;
  expected: LegacyInventoryExpectedIdentity;
  limits: LegacyInventoryLimits;
  absentIdentityPolicy: LegacyAbsentIdentityPolicy;
  clock?: () => number;
};

export type LegacyInventoryManifest = Record<string, JsonValue>;

export type LegacyInventoryReport = Readonly<{
  inventory_algorithm: string;
  manifest_digest: string;
  ownership: 'verified' | 'unverified';
  workspace_id: string;
  totals: Readonly<{
    relations: number;
    product_legacy_rows: number;
    lifecycle_rows: number;
    custom_tables: number;
    custom_stable_ids: number;
    object_versions: number;
    delete_markers: number;
    migrations: number;
    findings: number;
  }>;
  findings: readonly LegacyInventoryFinding[];
}>;

export type LegacyInventoryResult =
  | Readonly<{
      outcome: 'complete';
      manifestBytes: Buffer;
      digest: string;
      manifest: LegacyInventoryManifest;
      report: LegacyInventoryReport;
    }>
  | Readonly<{ outcome: 'incomplete'; findings: readonly LegacyInventoryFinding[] }>;

const SHA256_TOKEN = /^sha256:[a-f0-9]{64}$/u;
const WORKSPACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)$/u;
const NUMERIC_TEXT = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const HASH_TEXT = /^(?:sha256:)?[0-9a-fA-F]{16,128}$/u;
const ETAG_TEXT = /^"?[A-Za-z0-9._-]{1,128}"?$/u;
const VERSION_ID_TEXT = /^[\x21-\x7e]{1,1024}$/u;
const BUCKET_TEXT = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const TIMESTAMP_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:[+-][0-9]{2}(?::?[0-9]{2})?)?$/u;
const BACKEND_PID_TEXT = /^[0-9]{1,10}$/u;
const CONTENT_ADDRESSED_KEY = /(?:^|\/)objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/u;
const MIGRATION_FILENAME = /^[0-9]{3}_[a-z0-9_]+\.sql$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u;
const TEMPORARY_PATH = /(?:^|\/)tmp\/|\/var\/folders\/|(?:^|\/)\..+\.roster-[0-9]+-[0-9]+-[a-f0-9]{12}(?:\.|\/|$)/u;

const STATEMENT_TIMEOUT_MAX_MS = 3_600_000;

const PRODUCT_SCHEMAS: ReadonlySet<string> = new Set(['brain', 'brain_meta', 'public']);

export function legacyRelationIdentity(schema: string, name: string): string {
  return canonicalSourceJson([schema, name]);
}

function productRelationSet(entries: readonly string[]): ReadonlySet<string> {
  return new Set(entries.map((entry) => {
    const dot = entry.indexOf('.');
    return legacyRelationIdentity(entry.slice(0, dot), entry.slice(dot + 1));
  }));
}

const PRODUCT_META_RELATIONS: ReadonlySet<string> = productRelationSet([
  'brain_meta.schema_migrations',
  'brain_meta.runtime_roles',
  'brain_meta.workspace_identity',
  'brain_meta.runtime_protected_tables',
  'brain_meta.config',
  'brain.current_facts',
  'brain.current_edges',
  'brain.current_documents',
  'brain.current_files',
  'brain.resolved_current_facts',
]);

const PRODUCT_LEGACY_RELATIONS: ReadonlySet<string> = productRelationSet([
  'brain.entities',
  'brain.mounts',
  'brain.facts',
  'brain.events',
  'brain.edges',
  'brain.documents',
  'brain.files',
  'brain.entity_aliases',
  'brain.entity_merges',
]);

const PRODUCT_LIFECYCLE_RELATIONS: ReadonlySet<string> = productRelationSet([
  'brain.source_objects',
  'brain.logical_sources',
  'brain.source_versions',
  'brain.source_version_labels',
  'brain.source_tombstones',
  'brain.ingest_intents',
]);

const PROVIDER_ERROR_DETAILS: ReadonlySet<string> = new Set([
  'missing-region',
  'invalid-page-size',
  'invalid-cursor',
  'cursor-namespace-mismatch',
  'unexpected-common-prefixes',
  'malformed-page',
  'missing-is-latest',
  'missing-etag',
  'missing-size',
  'invalid-key',
  'prefix-escape',
  'invalid-version-id',
  'invalid-etag',
  'invalid-version-marker',
  'truncated-without-key-marker',
  'credentials-missing',
  'network-policy-denied',
  'list-failed',
  'head-failed',
]);

const SAFE_STABLE_KEY_TYPES: ReadonlySet<string> = new Set([
  'int2',
  'int4',
  'int8',
  'numeric',
  'uuid',
  'bool',
  'text',
  'varchar',
  'bpchar',
  'char',
  'name',
  'bytea',
  'date',
  'timestamp',
  'timestamptz',
]);

type LegacyRowValueKind = 'id' | 'timestamp' | 'stable' | 'path' | 's3-key' | 'hash' | 'etag' | 'decimal' | 'numeric' | 'op';

type LegacyRowColumnSpec = {
  output: string;
  columns: readonly string[];
  kind: LegacyRowValueKind;
  required?: boolean;
};

const PRODUCT_LEGACY_ROW_SPECS: Readonly<Record<string, readonly LegacyRowColumnSpec[]>> = {
  'brain.entities': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'kind', columns: ['kind'], kind: 'stable', required: true },
    { output: 'canonical_id', columns: ['canonical_id'], kind: 'id' },
  ],
  'brain.facts': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'entity_id', columns: ['entity_id'], kind: 'id', required: true },
    { output: 'key', columns: ['key'], kind: 'stable', required: true },
    { output: 'source', columns: ['source'], kind: 'path' },
    { output: 'confidence', columns: ['confidence'], kind: 'numeric' },
    { output: 'actor', columns: ['actor'], kind: 'stable' },
  ],
  'brain.events': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'entity_id', columns: ['entity_id'], kind: 'id' },
    { output: 'kind', columns: ['kind'], kind: 'stable', required: true },
    { output: 'actor', columns: ['actor'], kind: 'stable' },
  ],
  'brain.edges': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'src_id', columns: ['src_id'], kind: 'id', required: true },
    { output: 'dst_id', columns: ['dst_id'], kind: 'id', required: true },
    { output: 'rel', columns: ['rel'], kind: 'stable', required: true },
    { output: 'actor', columns: ['actor'], kind: 'stable' },
  ],
  'brain.documents': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'mount_id', columns: ['mount_id'], kind: 'id' },
    { output: 'chunk_index', columns: ['chunk_index', 'chunk_ix'], kind: 'decimal' },
    { output: 'source_path', columns: ['source_path', 'uri'], kind: 'path' },
    { output: 'embedding_model', columns: ['embedding_model'], kind: 'stable' },
  ],
  'brain.mounts': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'source_path', columns: ['source_path'], kind: 'path', required: true },
    { output: 'file_hash', columns: ['file_hash'], kind: 'hash', required: true },
  ],
  'brain.entity_aliases': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'entity_id', columns: ['entity_id'], kind: 'id', required: true },
    { output: 'source', columns: ['source'], kind: 'path' },
    { output: 'actor', columns: ['actor'], kind: 'stable' },
  ],
  'brain.entity_merges': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'from_id', columns: ['from_id'], kind: 'id', required: true },
    { output: 'into_id', columns: ['into_id'], kind: 'id', required: true },
    { output: 'actor', columns: ['actor'], kind: 'stable' },
  ],
  'brain.files': [
    { output: 'id', columns: ['id'], kind: 'id', required: true },
    { output: 'recorded_at', columns: ['recorded_at'], kind: 'timestamp' },
    { output: 'kind', columns: ['kind'], kind: 'stable' },
    { output: 'slug', columns: ['slug'], kind: 'stable' },
    { output: 'filename', columns: ['filename'], kind: 'stable' },
    { output: 'op', columns: ['op'], kind: 'op', required: true },
    { output: 'source_path', columns: ['source_path'], kind: 'path', required: true },
    { output: 'bucket', columns: ['bucket'], kind: 'path', required: true },
    { output: 's3_key', columns: ['s3_key'], kind: 's3-key', required: true },
    { output: 'size_bytes', columns: ['size_bytes'], kind: 'decimal' },
    { output: 'content_hash', columns: ['content_hash'], kind: 'hash' },
    { output: 'etag', columns: ['etag'], kind: 'etag' },
    { output: 'content_type', columns: ['content_type'], kind: 'stable' },
    { output: 'mount_id', columns: ['mount_id'], kind: 'id' },
    { output: 'actor', columns: ['actor'], kind: 'stable' },
  ],
  'brain.source_objects': [
    { output: 'object_id', columns: ['object_id'], kind: 'hash', required: true },
    { output: 'sha256', columns: ['sha256'], kind: 'hash', required: true },
    { output: 'object_key', columns: ['object_key'], kind: 's3-key', required: true },
    { output: 'size_bytes', columns: ['size_bytes'], kind: 'decimal', required: true },
    { output: 'etag', columns: ['etag'], kind: 'etag' },
    { output: 's3_version_id', columns: ['s3_version_id'], kind: 'etag' },
    { output: 'created_at', columns: ['created_at'], kind: 'timestamp' },
  ],
};

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function legacyInventoryToken(domain: LegacyInventoryTokenDomain, value: string): string {
  return `sha256:${createHash('sha256')
    .update(LEGACY_INVENTORY_TOKEN_CONTEXT + domain, 'utf8')
    .update(Buffer.from([0]))
    .update(value, 'utf8')
    .digest('hex')}`;
}

export function quoteLegacyInventoryIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\u0000') || Buffer.byteLength(name, 'utf8') > 512) {
    throw new RosterError({
      header: 'Legacy inventory rejected a catalog identifier',
      body: 'A catalog-derived identifier is empty, oversized, or contains NUL bytes.',
      remedy: 'Repair the database catalog before running the legacy inventory.',
      exitCode: EXIT_ERROR,
      code: 'LEGACY_INVENTORY_IDENTIFIER_INVALID',
    });
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function normalizeLegacyObjectPrefix(prefix: string): string {
  if (typeof prefix !== 'string') throw inputError('objectHistory.prefix', 'it must be a string');
  if (prefix.length === 0) return '';
  if (
    prefix.startsWith('/')
    || prefix.endsWith('/')
    || prefix.includes('\\')
    || CONTROL_CHARS.test(prefix)
    || Buffer.byteLength(prefix, 'utf8') > 1_024
    || prefix.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw inputError('objectHistory.prefix', 'it is not a normalized object prefix');
  }
  return prefix;
}

export type LegacyS3Cursor = {
  namespaceFingerprint: string;
  keyMarker: string;
  versionMarker: string;
};

export function encodeLegacyS3Cursor(cursor: LegacyS3Cursor): string {
  const payload = canonicalSourceJson({
    format: LEGACY_S3_CURSOR_FORMAT,
    namespace_fingerprint: cursor.namespaceFingerprint,
    key_marker: cursor.keyMarker,
    version_marker: cursor.versionMarker,
  });
  return `${LEGACY_S3_CURSOR_FORMAT}.${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeLegacyS3Cursor(raw: string): LegacyS3Cursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8_192) return null;
  const separator = raw.lastIndexOf('.');
  if (separator <= 0 || raw.slice(0, separator) !== LEGACY_S3_CURSOR_FORMAT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(separator + 1), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'format,key_marker,namespace_fingerprint,version_marker') return null;
  if (
    record.format !== LEGACY_S3_CURSOR_FORMAT
    || typeof record.namespace_fingerprint !== 'string'
    || !SHA256_TOKEN.test(record.namespace_fingerprint)
    || typeof record.key_marker !== 'string'
    || record.key_marker.length === 0
    || Buffer.byteLength(record.key_marker, 'utf8') > 1_024
    || CONTROL_CHARS.test(record.key_marker)
    || typeof record.version_marker !== 'string'
    || Buffer.byteLength(record.version_marker, 'utf8') > 1_024
    || CONTROL_CHARS.test(record.version_marker)
  ) {
    return null;
  }
  return {
    namespaceFingerprint: record.namespace_fingerprint,
    keyMarker: record.key_marker,
    versionMarker: record.version_marker,
  };
}

function inputError(field: string, reason: string): RosterError {
  return new RosterError({
    header: 'Invalid legacy inventory input',
    body: `The '${field}' input is invalid: ${reason}.`,
    remedy: 'Call the legacy inventory with a complete, explicitly bounded input contract.',
    exitCode: EXIT_ERROR,
    code: 'LEGACY_INVENTORY_INPUT_INVALID',
    details: { field, reason },
  });
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareDecimal(left: string, right: string): number {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const l = leftNegative ? left.slice(1) : left;
  const r = rightNegative ? right.slice(1) : right;
  const magnitude = l.length === r.length ? (l < r ? -1 : l > r ? 1 : 0) : l.length < r.length ? -1 : 1;
  return leftNegative ? -magnitude : magnitude;
}

function sortedByCanonical<T>(items: readonly T[], encode: (item: T) => string): T[] {
  return [...items].sort((a, b) => byteCompare(encode(a), encode(b)));
}

class IncompleteInventoryError extends Error {
  readonly finding: LegacyInventoryFinding;

  constructor(finding: LegacyInventoryFinding) {
    super(`legacy inventory incomplete (${finding.code})`);
    this.name = 'IncompleteInventoryError';
    this.finding = finding;
  }
}

function finding(
  code: LegacyInventoryFindingCode,
  resourceKind: LegacyInventoryResourceKind,
  resourceRef: string,
  detailRef: string,
): LegacyInventoryFinding {
  return Object.freeze({ code, resource_kind: resourceKind, resource_ref: resourceRef, detail_ref: detailRef });
}

function providerErrorDetail(error: unknown): string {
  const candidate = error as { reason?: unknown; code?: unknown; name?: unknown } | null;
  for (const value of [candidate?.reason, candidate?.code, candidate?.name]) {
    if (typeof value === 'string' && PROVIDER_ERROR_DETAILS.has(value)) return value;
  }
  return 'provider-error';
}

function compareFindings(left: LegacyInventoryFinding, right: LegacyInventoryFinding): number {
  return byteCompare(left.code, right.code)
    || byteCompare(left.resource_kind, right.resource_kind)
    || byteCompare(left.resource_ref, right.resource_ref)
    || byteCompare(left.detail_ref, right.detail_ref);
}

type LocatorClass = 'absolute-locator' | 'temporary-locator' | 'foreign-locator' | 'malformed-locator' | 'userinfo-locator' | null;

export function classifyLegacyLocator(value: string, expectedBucket: string): LocatorClass {
  if (CONTROL_CHARS.test(value) || value.length === 0) return 'malformed-locator';
  const scheme = value.match(URI_SCHEME);
  if (scheme !== null) {
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/iu.test(value)) return 'userinfo-locator';
    if (scheme[1]!.toLowerCase() === 's3') {
      const rest = value.slice(scheme[0].length);
      const bucket = rest.split('/', 1)[0] ?? '';
      if (bucket.length === 0) return 'malformed-locator';
      return bucket === expectedBucket ? null : 'foreign-locator';
    }
    return 'foreign-locator';
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !WINDOWS_DRIVE.test(value)) return 'foreign-locator';
  if (value.startsWith('~')) return 'foreign-locator';
  if (TEMPORARY_PATH.test(value)) return 'temporary-locator';
  if (value.startsWith('/') || WINDOWS_DRIVE.test(value)) return 'absolute-locator';
  return null;
}

function assertLimit(field: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw inputError(field, `it must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function validateInput(input: LegacyInventoryInput): void {
  if (input === null || typeof input !== 'object') throw inputError('input', 'it must be an inventory input mapping');
  if (input.pg === null || typeof input.pg !== 'object' || typeof input.pg.connect !== 'function') {
    throw inputError('pg', 'it must expose a connect() port resolving one PostgreSQL session');
  }
  const reader = input.objectHistory;
  if (
    reader === null
    || typeof reader !== 'object'
    || typeof reader.listHistory !== 'function'
    || typeof reader.headVersion !== 'function'
  ) {
    throw inputError('objectHistory', 'it must expose listHistory() and headVersion() only');
  }
  if (typeof reader.bucket !== 'string' || !BUCKET_TEXT.test(reader.bucket)) {
    throw inputError('objectHistory.bucket', 'it must name the validated bucket');
  }
  if (typeof reader.namespaceFingerprint !== 'string' || !SHA256_TOKEN.test(reader.namespaceFingerprint)) {
    throw inputError('objectHistory.namespaceFingerprint', 'it must be the canonical sha256:<hex> namespace fingerprint');
  }
  normalizeLegacyObjectPrefix(reader.prefix);
  const expected = input.expected;
  if (expected === null || typeof expected !== 'object') throw inputError('expected', 'it must be an identity mapping');
  if (typeof expected.workspaceId !== 'string' || !WORKSPACE_ID.test(expected.workspaceId) || expected.workspaceId.length > 80) {
    throw inputError('expected.workspaceId', 'it must be the tracked kebab-case workspace id');
  }
  if (!Number.isSafeInteger(expected.fingerprintFormatVersion) || expected.fingerprintFormatVersion < 1) {
    throw inputError('expected.fingerprintFormatVersion', 'it must be a positive integer');
  }
  if (typeof expected.namespaceFingerprint !== 'string' || !SHA256_TOKEN.test(expected.namespaceFingerprint)) {
    throw inputError('expected.namespaceFingerprint', 'it must be a sha256:<hex> fingerprint');
  }
  const limits = input.limits;
  if (limits === null || typeof limits !== 'object') throw inputError('limits', 'it must be an explicit limits mapping');
  assertLimit('limits.maxRelations', limits.maxRelations, 100_000);
  assertLimit('limits.maxStableIdRows', limits.maxStableIdRows, 10_000_000);
  assertLimit('limits.maxObjectHistoryPages', limits.maxObjectHistoryPages, 1_000_000);
  assertLimit('limits.maxObjectHistoryItems', limits.maxObjectHistoryItems, 10_000_000);
  assertLimit('limits.maxFindings', limits.maxFindings, 1_000_000);
  assertLimit('limits.maxTransactionMs', limits.maxTransactionMs, STATEMENT_TIMEOUT_MAX_MS);
  if (input.absentIdentityPolicy !== 'refuse' && input.absentIdentityPolicy !== 'permit-unverified') {
    throw inputError('absentIdentityPolicy', "it must be 'refuse' or 'permit-unverified'");
  }
  if (input.clock !== undefined && typeof input.clock !== 'function') {
    throw inputError('clock', 'it must be a function returning epoch milliseconds');
  }
}

const CATALOG_FILTER = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;
const RELKIND_FILTER = `c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`;
const EXTENSION_FILTER = `NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND d.objid = c.oid
        AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND d.deptype = 'e')`;

const SQL_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const SQL_ROLLBACK = 'ROLLBACK';
const SQL_BACKEND_PID = 'SELECT pg_catalog.pg_backend_pid()::text AS backend_pid';

const SQL_PIN = `SELECT
  pg_catalog.pg_backend_pid()::text AS backend_pid,
  pg_catalog.set_config('search_path', '', true) AS search_path,
  pg_catalog.set_config('statement_timeout', $1, true) AS statement_timeout,
  pg_catalog.set_config('idle_in_transaction_session_timeout', $1, true) AS idle_timeout,
  pg_catalog.set_config('TimeZone', 'UTC', true) AS time_zone,
  pg_catalog.set_config('DateStyle', 'ISO, YMD', true) AS date_style,
  pg_catalog.set_config('IntervalStyle', 'iso_8601', true) AS interval_style,
  pg_catalog.set_config('extra_float_digits', '3', true) AS float_digits,
  pg_catalog.set_config('bytea_output', 'hex', true) AS bytea_output`;

const SQL_IDENTITY_READ = `SELECT workspace_id, fingerprint_format_version::text AS fingerprint_format_version,
       namespace_fingerprint, migration_state
  FROM brain_meta.workspace_identity`;

const SQL_CATALOG_SCAN = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       c.relkind::text AS relation_kind, o.rolname AS owner_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
 WHERE ${CATALOG_FILTER}
   AND ${RELKIND_FILTER}
   AND ${EXTENSION_FILTER}`;

const SQL_COLUMNS = `SELECT n.nspname AS schema_name, c.relname AS relation_name, a.attnum::text AS ordinal,
       a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name,
       tn.nspname AS type_schema, t.typname AS type_base_name,
       a.attnotnull AS not_null, a.attgenerated::text AS generated_kind,
       a.attidentity::text AS identity_kind, a.atthasdef AS has_default
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
 WHERE a.attnum > 0 AND NOT a.attisdropped
   AND ${CATALOG_FILTER}
   AND ${RELKIND_FILTER}
   AND ${EXTENSION_FILTER}`;

const SQL_PRIMARY_KEYS = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       a.attname AS column_name, k.ord::text AS key_position
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
 WHERE i.indisprimary AND ${CATALOG_FILTER}`;

const SQL_COLUMN_DEFAULTS = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       a.attname AS column_name, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS raw_expression
  FROM pg_catalog.pg_attrdef ad
  JOIN pg_catalog.pg_class c ON c.oid = ad.adrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
 WHERE ${CATALOG_FILTER}`;

const SQL_CONSTRAINTS = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       con.conname AS constraint_name, con.contype::text AS constraint_kind,
       pg_catalog.pg_get_constraintdef(con.oid) AS raw_definition
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${CATALOG_FILTER}`;

const SQL_INDEXES = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       ic.relname AS index_name, pg_catalog.pg_get_indexdef(i.indexrelid) AS raw_definition
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${CATALOG_FILTER}`;

const SQL_VIEW_DEFINITIONS = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       pg_catalog.pg_get_viewdef(c.oid) AS raw_definition
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('v', 'm') AND ${CATALOG_FILTER}`;

const SQL_MIGRATIONS = 'SELECT filename, sha256 FROM brain_meta.schema_migrations';

const SQL_DATABASE_ACL = `SELECT pg_catalog.pg_get_userbyid(d.datdba) AS owner_name,
       pg_catalog.pg_get_userbyid(e.grantor) AS grantor_name,
       CASE WHEN e.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(e.grantee) END AS grantee_name,
       e.privilege_type AS privilege_type, e.is_grantable AS is_grantable
  FROM pg_catalog.pg_database d
  LEFT JOIN LATERAL pg_catalog.aclexplode(d.datacl) e ON true
 WHERE d.datname = pg_catalog.current_database()`;

const SQL_SCHEMA_ACL = `SELECT ns.nspname AS schema_name, pg_catalog.pg_get_userbyid(ns.nspowner) AS owner_name,
       pg_catalog.pg_get_userbyid(e.grantor) AS grantor_name,
       CASE WHEN e.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(e.grantee) END AS grantee_name,
       e.privilege_type AS privilege_type, e.is_grantable AS is_grantable
  FROM pg_catalog.pg_namespace ns
  LEFT JOIN LATERAL pg_catalog.aclexplode(ns.nspacl) e ON true
 WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'`;

const SQL_RELATION_ACL = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
       pg_catalog.pg_get_userbyid(e.grantor) AS grantor_name,
       CASE WHEN e.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(e.grantee) END AS grantee_name,
       e.privilege_type AS privilege_type, e.is_grantable AS is_grantable
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL pg_catalog.aclexplode(c.relacl) e ON true
 WHERE c.relacl IS NOT NULL AND ${CATALOG_FILTER} AND ${RELKIND_FILTER}`;

const SQL_RUNTIME_ROLES = 'SELECT rolname FROM brain_meta.runtime_roles';

const SQL_ROLE_MEMBERSHIP = `SELECT r.rolname AS role_name, m.rolname AS member_name
  FROM pg_catalog.pg_auth_members am
  JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
  JOIN pg_catalog.pg_roles m ON m.oid = am.member
 WHERE r.rolname = ANY($1::pg_catalog.text[]) OR m.rolname = ANY($1::pg_catalog.text[])`;

const SQL_DEFAULT_ACL = `SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS owner_name,
       n.nspname AS schema_name, d.defaclobjtype::text AS object_type,
       pg_catalog.pg_get_userbyid(e.grantor) AS grantor_name,
       CASE WHEN e.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(e.grantee) END AS grantee_name,
       e.privilege_type AS privilege_type, e.is_grantable AS is_grantable
  FROM pg_catalog.pg_default_acl d
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
  JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) e ON true`;

function regclassProbeSql(qualified: string): string {
  return `SELECT (pg_catalog.to_regclass('${qualified}') IS NOT NULL) AS present`;
}

type RelationClassification = 'product-meta' | 'product-legacy' | 'product-lifecycle' | 'adopter-custom';

type RelationKind = 'table' | 'partitioned-table' | 'view' | 'materialized-view' | 'foreign-table' | 'sequence';

type CatalogColumn = {
  ordinal: string;
  name: string;
  typeName: string;
  typeSchema: string;
  typeBaseName: string;
  notNull: boolean;
  generated: string;
  identity: string;
  hasDefault: boolean;
};

type AclRecord = {
  grantor: string;
  grantee: string | null;
  privilege: string;
  grantable: boolean;
};

type CatalogRelation = {
  schema: string;
  name: string;
  qualified: string;
  identityKey: string;
  kind: RelationKind;
  classification: RelationClassification;
  owner: string;
  columns: CatalogColumn[];
  primaryKey: { column: string; position: string }[];
  defaults: { column: string; expression: string }[];
  constraints: { name: string; kind: string; definition: string }[];
  indexes: { name: string; definition: string }[];
  viewDefinition: string | null;
  acl: AclRecord[];
  rowCount: string | null;
  rows: Record<string, JsonValue>[] | null;
  stableIds: { count: number; digest: string; ids: JsonValue[] } | null;
};

type FilesCorrelationRow = {
  rowId: string;
  op: string;
  bucket: string | null;
  key: string | null;
  etag: string | null;
  sizeBytes: string | null;
  contentHash: string | null;
  record: Record<string, JsonValue>;
};

type LifecycleCorrelationRow = {
  objectId: string;
  objectKey: string;
  versionId: string | null;
  etag: string | null;
  sizeBytes: string | null;
  record: Record<string, JsonValue>;
};

const RELKIND_NAMES: Readonly<Record<string, RelationKind>> = {
  r: 'table',
  p: 'partitioned-table',
  v: 'view',
  m: 'materialized-view',
  f: 'foreign-table',
  S: 'sequence',
};

function classifyRelation(identityKey: string): RelationClassification {
  if (PRODUCT_META_RELATIONS.has(identityKey)) return 'product-meta';
  if (PRODUCT_LEGACY_RELATIONS.has(identityKey)) return 'product-legacy';
  if (PRODUCT_LIFECYCLE_RELATIONS.has(identityKey)) return 'product-lifecycle';
  return 'adopter-custom';
}

function requireString(row: Record<string, unknown>, field: string, context: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'database', context, field));
  }
  return value;
}

function optionalString(row: Record<string, unknown>, field: string, context: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'database', context, field));
  }
  return value;
}

function requireBoolean(row: Record<string, unknown>, field: string, context: string): boolean {
  const value = row[field];
  if (typeof value !== 'boolean') {
    throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'database', context, field));
  }
  return value;
}

class LegacyInventoryRun {
  private readonly input: LegacyInventoryInput;
  private readonly limits: LegacyInventoryLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly prefix: string;
  private readonly namespaceFingerprint: string;
  private readonly findings = new Map<string, LegacyInventoryFinding>();
  private rowBudgetUsed = 0;
  private ownership: 'verified' | 'unverified' = 'unverified';
  private observedIdentity: Record<string, JsonValue> = { status: 'unverified' };
  private migrations: Record<string, JsonValue> = { status: 'missing' };
  private migrationCount = 0;
  private relations: CatalogRelation[] = [];
  private databaseSection: Record<string, JsonValue> = { owner_token: null, acl: [] };
  private schemasSection: JsonValue[] = [];
  private runtimeRolesSection: Record<string, JsonValue> = { status: 'missing' };
  private membershipSection: JsonValue[] = [];
  private defaultAclSection: JsonValue[] = [];
  private history: LegacyObjectHistoryObservation[] = [];
  private filesRows: FilesCorrelationRow[] = [];
  private lifecycleRows: LifecycleCorrelationRow[] = [];
  private legacyRowTotal = 0;
  private lifecycleRowTotal = 0;
  private customStableIdTotal = 0;
  private backendPid: string | null = null;
  private session: LegacyInventoryPgSession | null = null;

  constructor(input: LegacyInventoryInput) {
    this.input = input;
    this.limits = input.limits;
    this.now = input.clock ?? Date.now;
    this.startedAt = this.now();
    this.prefix = normalizeLegacyObjectPrefix(input.objectHistory.prefix);
    this.namespaceFingerprint = input.objectHistory.namespaceFingerprint;
  }

  private guardTime(): void {
    if (this.now() - this.startedAt > this.limits.maxTransactionMs) {
      throw new IncompleteInventoryError(finding('time-limit', 'inventory', 'inventory', 'transaction-duration'));
    }
  }

  private addFinding(entry: LegacyInventoryFinding): void {
    this.findings.set(canonicalSourceJson(entry as unknown as SourceJsonValue), entry);
  }

  private async query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.guardTime();
    const session = this.session;
    if (session === null) {
      throw new IncompleteInventoryError(finding('sql-error', 'database', 'database', 'session-not-acquired'));
    }
    try {
      const result = await session.query(sql, values);
      this.guardTime();
      return result.rows;
    } catch (error) {
      if (error instanceof IncompleteInventoryError) throw error;
      const sqlstate = (error as { code?: unknown }).code;
      const detail = typeof sqlstate === 'string' && SQLSTATE.test(sqlstate) ? `sqlstate-${sqlstate}` : 'statement-failed';
      throw new IncompleteInventoryError(finding('sql-error', 'database', 'database', detail));
    }
  }

  private async rollback(): Promise<void> {
    try {
      await this.session?.query(SQL_ROLLBACK);
    } catch {
      /* the read-only transaction left nothing to preserve */
    }
  }

  async execute(): Promise<LegacyInventoryResult> {
    try {
      this.verifyNamespaceBinding();
      await this.collectPostgres();
      await this.collectObjectHistory();
      return await this.assemble();
    } catch (error) {
      if (error instanceof IncompleteInventoryError) {
        return this.incomplete(error.finding);
      }
      throw error;
    }
  }

  private verifyNamespaceBinding(): void {
    if (this.namespaceFingerprint !== this.input.expected.namespaceFingerprint) {
      throw new IncompleteInventoryError(
        finding('identity-mismatch', 'database', 'object-namespace', 'namespace-fingerprint'),
      );
    }
  }

  private incomplete(fatal: LegacyInventoryFinding): LegacyInventoryResult {
    const merged = new Map(this.findings);
    merged.set(canonicalSourceJson(fatal as unknown as SourceJsonValue), fatal);
    const sorted = [...merged.values()].sort(compareFindings);
    return Object.freeze({
      outcome: 'incomplete' as const,
      findings: Object.freeze(sorted.slice(0, this.limits.maxFindings)),
    });
  }

  private backendPidOf(rows: readonly Record<string, unknown>[]): string {
    const pid = rows.length === 1 ? rows[0]?.backend_pid : undefined;
    if (typeof pid !== 'string' || !BACKEND_PID_TEXT.test(pid)) {
      throw new IncompleteInventoryError(finding('connection-affinity', 'database', 'database', 'backend-pid'));
    }
    return pid;
  }

  private async assertSessionAffinity(): Promise<void> {
    const pid = this.backendPidOf(await this.query(SQL_BACKEND_PID));
    if (this.backendPid === null || pid !== this.backendPid) {
      throw new IncompleteInventoryError(finding('connection-affinity', 'database', 'database', 'backend-pid'));
    }
  }

  private async collectPostgres(): Promise<void> {
    let session: LegacyInventoryPgSession;
    try {
      session = await this.input.pg.connect();
    } catch {
      throw new IncompleteInventoryError(finding('sql-error', 'database', 'database', 'connect-failed'));
    }
    if (
      session === null
      || typeof session !== 'object'
      || typeof session.query !== 'function'
      || typeof session.release !== 'function'
    ) {
      throw inputError('pg.connect', 'it must resolve to a session exposing query() and release()');
    }
    this.session = session;
    let begun = false;
    try {
      this.guardTime();
      // The rollback flag is raised BEFORE dispatching BEGIN: the post-await
      // time guard can expire after BEGIN executed on the session, and finally
      // must then roll back. A ROLLBACK after a BEGIN that never dispatched is
      // a harmless no-op on a session with no open transaction.
      begun = true;
      await this.query(SQL_BEGIN);
      this.backendPid = this.backendPidOf(await this.query(SQL_PIN, [String(this.limits.maxTransactionMs)]));
      await this.assertSessionAffinity();
      await this.verifyIdentityGate();
      await this.scanCatalog();
      await this.collectMigrations();
      await this.collectCounts();
      await this.collectProductRows();
      await this.collectCustomStableIds();
      await this.collectRolesAndAcls();
    } finally {
      if (begun) await this.rollback();
      this.session = null;
      try {
        session.release();
      } catch {
        /* a failed release must not mask the inventory outcome */
      }
    }
  }

  private async verifyIdentityGate(): Promise<void> {
    const probe = await this.query(regclassProbeSql('brain_meta.workspace_identity'));
    const present = probe.length === 1 && probe[0]?.present === true;
    if (!present) {
      if (this.input.absentIdentityPolicy === 'refuse') {
        throw new IncompleteInventoryError(
          finding('identity-unverified-refused', 'database', 'workspace-identity', 'absent'),
        );
      }
      this.ownership = 'unverified';
      this.observedIdentity = { status: 'unverified' };
      return;
    }
    const rows = await this.query(SQL_IDENTITY_READ);
    if (rows.length !== 1) {
      throw new IncompleteInventoryError(finding('identity-mismatch', 'database', 'workspace-identity', 'shape'));
    }
    const row = rows[0]!;
    const workspaceId = requireString(row, 'workspace_id', 'workspace-identity');
    const formatVersionText = requireString(row, 'fingerprint_format_version', 'workspace-identity');
    const namespaceFingerprint = requireString(row, 'namespace_fingerprint', 'workspace-identity');
    const migrationState = requireString(row, 'migration_state', 'workspace-identity');
    if (!/^[0-9]{1,4}$/u.test(formatVersionText) || !SHA256_TOKEN.test(namespaceFingerprint)) {
      throw new IncompleteInventoryError(finding('identity-mismatch', 'database', 'workspace-identity', 'shape'));
    }
    if (workspaceId !== this.input.expected.workspaceId) {
      throw new IncompleteInventoryError(finding('identity-mismatch', 'database', 'workspace-identity', 'workspace-id'));
    }
    if (Number.parseInt(formatVersionText, 10) !== this.input.expected.fingerprintFormatVersion) {
      throw new IncompleteInventoryError(
        finding('identity-mismatch', 'database', 'workspace-identity', 'fingerprint-format-version'),
      );
    }
    if (namespaceFingerprint !== this.input.expected.namespaceFingerprint) {
      throw new IncompleteInventoryError(
        finding('identity-mismatch', 'database', 'workspace-identity', 'namespace-fingerprint'),
      );
    }
    if (migrationState !== 'ready') {
      throw new IncompleteInventoryError(finding('identity-mismatch', 'database', 'workspace-identity', 'migration-state'));
    }
    this.ownership = 'verified';
    this.observedIdentity = {
      status: 'verified',
      workspace_id: workspaceId,
      fingerprint_format_version: Number.parseInt(formatVersionText, 10),
      namespace_fingerprint: namespaceFingerprint,
      migration_state: migrationState,
    };
  }

  private relationRef(relation: CatalogRelation): string {
    return relation.classification === 'adopter-custom'
      ? legacyInventoryToken('relation-name', relation.identityKey)
      : relation.qualified;
  }

  private async scanCatalog(): Promise<void> {
    const scanned = await this.query(SQL_CATALOG_SCAN);
    if (scanned.length > this.limits.maxRelations) {
      throw new IncompleteInventoryError(finding('relation-limit', 'inventory', 'inventory', 'relations'));
    }
    const byQualified = new Map<string, CatalogRelation>();
    for (const row of scanned) {
      const schema = requireString(row, 'schema_name', 'catalog');
      const name = requireString(row, 'relation_name', 'catalog');
      const kindCode = requireString(row, 'relation_kind', 'catalog');
      const owner = requireString(row, 'owner_name', 'catalog');
      const kind = RELKIND_NAMES[kindCode];
      if (kind === undefined) {
        throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'database', 'catalog', 'relation-kind'));
      }
      const identityKey = legacyRelationIdentity(schema, name);
      if (byQualified.has(identityKey)) {
        throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'database', 'catalog', 'duplicate-relation'));
      }
      byQualified.set(identityKey, {
        schema,
        name,
        qualified: `${schema}.${name}`,
        identityKey,
        kind,
        classification: classifyRelation(identityKey),
        owner,
        columns: [],
        primaryKey: [],
        defaults: [],
        constraints: [],
        indexes: [],
        viewDefinition: null,
        acl: [],
        rowCount: null,
        rows: null,
        stableIds: null,
      });
    }
    for (const row of await this.query(SQL_COLUMNS)) {
      const relation = byQualified.get(legacyRelationIdentity(requireString(row, 'schema_name', 'columns'), requireString(row, 'relation_name', 'columns')));
      if (relation === undefined) continue;
      relation.columns.push({
        ordinal: requireString(row, 'ordinal', 'columns'),
        name: requireString(row, 'column_name', 'columns'),
        typeName: requireString(row, 'type_name', 'columns'),
        typeSchema: requireString(row, 'type_schema', 'columns'),
        typeBaseName: requireString(row, 'type_base_name', 'columns'),
        notNull: requireBoolean(row, 'not_null', 'columns'),
        generated: optionalString(row, 'generated_kind', 'columns') ?? '',
        identity: optionalString(row, 'identity_kind', 'columns') ?? '',
        hasDefault: requireBoolean(row, 'has_default', 'columns'),
      });
    }
    for (const row of await this.query(SQL_PRIMARY_KEYS)) {
      const relation = byQualified.get(legacyRelationIdentity(requireString(row, 'schema_name', 'primary-keys'), requireString(row, 'relation_name', 'primary-keys')));
      if (relation === undefined) continue;
      relation.primaryKey.push({
        column: requireString(row, 'column_name', 'primary-keys'),
        position: requireString(row, 'key_position', 'primary-keys'),
      });
    }
    for (const row of await this.query(SQL_COLUMN_DEFAULTS)) {
      const relation = byQualified.get(legacyRelationIdentity(requireString(row, 'schema_name', 'defaults'), requireString(row, 'relation_name', 'defaults')));
      if (relation === undefined) continue;
      relation.defaults.push({
        column: requireString(row, 'column_name', 'defaults'),
        expression: optionalString(row, 'raw_expression', 'defaults') ?? '',
      });
    }
    for (const row of await this.query(SQL_CONSTRAINTS)) {
      const relation = byQualified.get(legacyRelationIdentity(requireString(row, 'schema_name', 'constraints'), requireString(row, 'relation_name', 'constraints')));
      if (relation === undefined) continue;
      relation.constraints.push({
        name: requireString(row, 'constraint_name', 'constraints'),
        kind: requireString(row, 'constraint_kind', 'constraints'),
        definition: optionalString(row, 'raw_definition', 'constraints') ?? '',
      });
    }
    for (const row of await this.query(SQL_INDEXES)) {
      const relation = byQualified.get(legacyRelationIdentity(requireString(row, 'schema_name', 'indexes'), requireString(row, 'relation_name', 'indexes')));
      if (relation === undefined) continue;
      relation.indexes.push({
        name: requireString(row, 'index_name', 'indexes'),
        definition: optionalString(row, 'raw_definition', 'indexes') ?? '',
      });
    }
    for (const row of await this.query(SQL_VIEW_DEFINITIONS)) {
      const relation = byQualified.get(legacyRelationIdentity(requireString(row, 'schema_name', 'view-definitions'), requireString(row, 'relation_name', 'view-definitions')));
      if (relation === undefined) continue;
      relation.viewDefinition = optionalString(row, 'raw_definition', 'view-definitions') ?? '';
    }
    for (const relation of byQualified.values()) {
      relation.columns.sort((a, b) => compareDecimal(a.ordinal, b.ordinal));
      relation.primaryKey.sort((a, b) => compareDecimal(a.position, b.position));
      relation.defaults = sortedByCanonical(relation.defaults, (entry) => canonicalSourceJson([entry.column, entry.expression]));
      relation.constraints = sortedByCanonical(relation.constraints, (entry) => canonicalSourceJson([entry.name, entry.kind, entry.definition]));
      relation.indexes = sortedByCanonical(relation.indexes, (entry) => canonicalSourceJson([entry.name, entry.definition]));
    }
    this.relations = sortedByCanonical([...byQualified.values()], (relation) => this.relationRef(relation));
  }

  private async collectMigrations(): Promise<void> {
    const probe = await this.query(regclassProbeSql('brain_meta.schema_migrations'));
    if (!(probe.length === 1 && probe[0]?.present === true)) {
      this.migrations = { status: 'missing' };
      this.addFinding(finding('migration-metadata-missing', 'migration', 'brain_meta.schema_migrations', 'absent'));
      return;
    }
    const rows = await this.query(SQL_MIGRATIONS);
    const entries: { filename: string; sha256: string }[] = [];
    let malformed = 0;
    for (const row of rows) {
      const filename = typeof row.filename === 'string' ? row.filename : null;
      const digest = typeof row.sha256 === 'string' ? row.sha256 : null;
      if (filename === null || digest === null || !MIGRATION_FILENAME.test(filename) || !SHA256_HEX.test(digest)) {
        malformed++;
        continue;
      }
      entries.push({ filename, sha256: digest });
    }
    if (malformed > 0) {
      this.addFinding(finding('migration-metadata-malformed', 'migration', 'brain_meta.schema_migrations', 'malformed-entries'));
    }
    const sorted = sortedByCanonical(entries, (entry) => entry.filename);
    const setHash = `sha256:${sha256Hex(canonicalSourceJson({
      domain: `${LEGACY_INVENTORY_TOKEN_CONTEXT}migration-set`,
      entries: sorted.map((entry) => [entry.filename, entry.sha256]),
    }))}`;
    this.migrationCount = sorted.length;
    this.migrations = {
      status: 'present',
      entries: sorted.map((entry) => ({ filename: entry.filename, sha256: entry.sha256 })),
      malformed_count: malformed,
      set_hash: setHash,
    };
  }

  private async collectCounts(): Promise<void> {
    for (const relation of this.relations) {
      if (relation.kind !== 'table' && relation.kind !== 'partitioned-table' && relation.kind !== 'materialized-view') continue;
      const qualified = `${quoteLegacyInventoryIdentifier(relation.schema)}.${quoteLegacyInventoryIdentifier(relation.name)}`;
      const rows = await this.query(`SELECT pg_catalog.count(*)::text AS row_count FROM ${qualified}`);
      const count = rows.length === 1 ? rows[0]?.row_count : undefined;
      if (typeof count !== 'string' || !DECIMAL.test(count)) {
        throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), 'row-count'));
      }
      relation.rowCount = count;
      if (relation.classification === 'product-lifecycle' && count !== '0') {
        this.addFinding(finding('partial-cutover', 'relation', relation.qualified, 'non-empty'));
      }
    }
  }

  private consumeRowBudget(relation: CatalogRelation, consumed: number, available: number): void {
    if (consumed > available) {
      throw new IncompleteInventoryError(finding('row-limit', 'relation', this.relationRef(relation), 'stable-id-rows'));
    }
    this.rowBudgetUsed += consumed;
  }

  private renderRowValue(
    relation: CatalogRelation,
    rowId: string,
    spec: LegacyRowColumnSpec,
    raw: string | null,
  ): JsonValue {
    if (raw === null) return null;
    switch (spec.kind) {
      case 'id':
      case 'decimal':
        if (!DECIMAL.test(raw)) {
          throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), spec.output));
        }
        return raw;
      case 'timestamp':
        return TIMESTAMP_TEXT.test(raw) ? raw : legacyInventoryToken('stable-id', raw);
      case 'numeric':
        return NUMERIC_TEXT.test(raw) ? raw : legacyInventoryToken('stable-id', raw);
      case 'hash':
        return HASH_TEXT.test(raw) ? raw.toLowerCase() : legacyInventoryToken('stable-id', raw);
      case 'etag':
        return ETAG_TEXT.test(raw) ? raw : legacyInventoryToken('stable-id', raw);
      case 'op':
        return raw === 'put' || raw === 'rm' ? raw : legacyInventoryToken('stable-id', raw);
      case 'path': {
        const locator = classifyLegacyLocator(raw, this.input.objectHistory.bucket);
        if (locator !== null) {
          this.addFinding(finding(locator, 'row', `${relation.qualified}/${rowId}`, legacyInventoryToken('path', raw)));
        }
        return legacyInventoryToken('path', raw);
      }
      case 's3-key':
        return legacyInventoryToken('s3-key', raw);
      case 'stable':
        return legacyInventoryToken('stable-id', raw);
    }
  }

  private async collectProductRows(): Promise<void> {
    for (const relation of this.relations) {
      const spec = PRODUCT_LEGACY_ROW_SPECS[relation.qualified];
      if (spec === undefined) continue;
      if (relation.classification !== 'product-legacy' && relation.classification !== 'product-lifecycle') continue;
      if (relation.kind !== 'table' && relation.kind !== 'partitioned-table') continue;
      const present = new Map(relation.columns.map((column) => [column.name, column]));
      const selected: { spec: LegacyRowColumnSpec; column: string }[] = [];
      for (const columnSpec of spec) {
        const match = columnSpec.columns.find((candidate) => present.has(candidate));
        if (match === undefined) {
          if (columnSpec.required === true) {
            throw new IncompleteInventoryError(
              finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), columnSpec.output),
            );
          }
          continue;
        }
        selected.push({ spec: columnSpec, column: match });
      }
      const available = this.limits.maxStableIdRows - this.rowBudgetUsed;
      const items = selected
        .map((entry) => `${quoteLegacyInventoryIdentifier(entry.column)}::text AS ${quoteLegacyInventoryIdentifier(entry.spec.output)}`)
        .join(', ');
      const qualified = `${quoteLegacyInventoryIdentifier(relation.schema)}.${quoteLegacyInventoryIdentifier(relation.name)}`;
      const rows = await this.query(`SELECT ${items} FROM ${qualified} LIMIT $1`, [String(available + 1)]);
      this.consumeRowBudget(relation, rows.length, available);
      const idField = relation.qualified === 'brain.source_objects' ? 'object_id' : 'id';
      const records: { sortKey: string; record: Record<string, JsonValue> }[] = [];
      for (const row of rows) {
        const rowIdRaw = row[idField];
        if (typeof rowIdRaw !== 'string' || rowIdRaw.length === 0
          || (idField === 'id' && !DECIMAL.test(rowIdRaw))) {
          throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), idField));
        }
        const rowRef = idField === 'id' || SHA256_TOKEN.test(rowIdRaw)
          ? rowIdRaw
          : legacyInventoryToken('stable-id', rowIdRaw);
        const record: Record<string, JsonValue> = {};
        for (const entry of selected) {
          const raw = row[entry.spec.output];
          if (raw !== null && raw !== undefined && typeof raw !== 'string') {
            throw new IncompleteInventoryError(
              finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), entry.spec.output),
            );
          }
          record[entry.spec.output] = this.renderRowValue(relation, rowRef, entry.spec, raw ?? null);
        }
        records.push({ sortKey: rowRef, record });
        this.trackCorrelationRow(relation, rowRef, row, record);
      }
      records.sort((a, b) => (idField === 'id' && DECIMAL.test(a.sortKey) && DECIMAL.test(b.sortKey)
        ? compareDecimal(a.sortKey, b.sortKey)
        : byteCompare(a.sortKey, b.sortKey)));
      relation.rows = records.map((entry) => entry.record);
      if (relation.classification === 'product-legacy') this.legacyRowTotal += records.length;
      else this.lifecycleRowTotal += records.length;
    }
  }

  private trackCorrelationRow(
    relation: CatalogRelation,
    rowId: string,
    raw: Record<string, unknown>,
    record: Record<string, JsonValue>,
  ): void {
    const text = (field: string): string | null => (typeof raw[field] === 'string' ? (raw[field] as string) : null);
    if (relation.qualified === 'brain.files') {
      this.filesRows.push({
        rowId,
        op: text('op') ?? '',
        bucket: text('bucket'),
        key: text('s3_key'),
        etag: text('etag'),
        sizeBytes: text('size_bytes'),
        contentHash: text('content_hash'),
        record,
      });
    } else if (relation.qualified === 'brain.source_objects') {
      this.lifecycleRows.push({
        objectId: rowId,
        objectKey: text('object_key') ?? '',
        versionId: text('s3_version_id'),
        etag: text('etag'),
        sizeBytes: text('size_bytes'),
        record,
      });
    }
  }

  private async collectCustomStableIds(): Promise<void> {
    for (const relation of this.relations) {
      if (relation.classification !== 'adopter-custom') continue;
      if (relation.kind !== 'table' && relation.kind !== 'partitioned-table') continue;
      if (relation.primaryKey.length === 0) {
        throw new IncompleteInventoryError(finding('missing-stable-key', 'relation', this.relationRef(relation), 'no-primary-key'));
      }
      const keyColumns: CatalogColumn[] = [];
      for (const key of relation.primaryKey) {
        const column = relation.columns.find((candidate) => candidate.name === key.column);
        if (column === undefined) {
          throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), 'primary-key'));
        }
        if (column.typeSchema !== 'pg_catalog' || !SAFE_STABLE_KEY_TYPES.has(column.typeBaseName)) {
          throw new IncompleteInventoryError(
            finding(
              'catalog-shape-unsafe',
              'relation',
              this.relationRef(relation),
              legacyInventoryToken('column-name', canonicalSourceJson([relation.schema, relation.name, column.name])),
            ),
          );
        }
        keyColumns.push(column);
      }
      const available = this.limits.maxStableIdRows - this.rowBudgetUsed;
      const items = keyColumns
        .map((column, index) => `${quoteLegacyInventoryIdentifier(column.name)}::text AS ${quoteLegacyInventoryIdentifier(`k${index}`)}`)
        .join(', ');
      const qualified = `${quoteLegacyInventoryIdentifier(relation.schema)}.${quoteLegacyInventoryIdentifier(relation.name)}`;
      const rows = await this.query(`SELECT ${items} FROM ${qualified} LIMIT $1`, [String(available + 1)]);
      this.consumeRowBudget(relation, rows.length, available);
      const rawTuples: string[][] = [];
      for (const row of rows) {
        const tuple: string[] = [];
        for (let index = 0; index < keyColumns.length; index++) {
          const value = row[`k${index}`];
          if (typeof value !== 'string') {
            throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'relation', this.relationRef(relation), 'primary-key'));
          }
          tuple.push(value);
        }
        rawTuples.push(tuple);
      }
      rawTuples.sort((a, b) => byteCompare(canonicalSourceJson(a), canonicalSourceJson(b)));
      const digest = `sha256:${sha256Hex(canonicalSourceJson({
        domain: `${LEGACY_INVENTORY_TOKEN_CONTEXT}stable-id-set`,
        relation: [relation.schema, relation.name],
        ids: rawTuples,
      }))}`;
      const ids = rawTuples.map((tuple) => tuple.map((value) => legacyInventoryToken('stable-id', value)));
      relation.stableIds = { count: rawTuples.length, digest, ids };
      this.customStableIdTotal += rawTuples.length;
    }
  }

  private aclFromRow(row: Record<string, unknown>, context: string): AclRecord | null {
    const grantor = optionalString(row, 'grantor_name', context);
    const privilege = optionalString(row, 'privilege_type', context);
    if (grantor === null || privilege === null) return null;
    const grantable = row.is_grantable;
    return {
      grantor,
      grantee: optionalString(row, 'grantee_name', context),
      privilege,
      grantable: grantable === true,
    };
  }

  private renderAcl(entries: readonly AclRecord[]): JsonValue[] {
    const rendered = entries.map((entry) => ({
      grantor_token: legacyInventoryToken('role-name', entry.grantor),
      grantee: entry.grantee === null ? 'PUBLIC' : null,
      grantee_token: entry.grantee === null ? null : legacyInventoryToken('role-name', entry.grantee),
      privilege: entry.privilege,
      grantable: entry.grantable,
    }));
    return sortedByCanonical(rendered, (entry) => canonicalSourceJson(entry as unknown as SourceJsonValue)) as unknown as JsonValue[];
  }

  private async collectRolesAndAcls(): Promise<void> {
    const scopedRoles = new Set<string>();
    const databaseRows = await this.query(SQL_DATABASE_ACL);
    if (databaseRows.length === 0) {
      throw new IncompleteInventoryError(finding('catalog-shape-unsafe', 'database', 'database', 'owner'));
    }
    const databaseOwner = requireString(databaseRows[0]!, 'owner_name', 'database-acl');
    scopedRoles.add(databaseOwner);
    const databaseAcl: AclRecord[] = [];
    for (const row of databaseRows) {
      const entry = this.aclFromRow(row, 'database-acl');
      if (entry === null) continue;
      databaseAcl.push(entry);
      scopedRoles.add(entry.grantor);
      if (entry.grantee !== null) scopedRoles.add(entry.grantee);
    }
    this.databaseSection = {
      owner_token: legacyInventoryToken('role-name', databaseOwner),
      acl: this.renderAcl(databaseAcl),
    };

    const schemaRows = await this.query(SQL_SCHEMA_ACL);
    const schemas = new Map<string, { owner: string; acl: AclRecord[] }>();
    for (const row of schemaRows) {
      const schemaName = requireString(row, 'schema_name', 'schema-acl');
      const owner = requireString(row, 'owner_name', 'schema-acl');
      const record = schemas.get(schemaName) ?? { owner, acl: [] };
      record.owner = owner;
      const entry = this.aclFromRow(row, 'schema-acl');
      if (entry !== null) {
        record.acl.push(entry);
        scopedRoles.add(entry.grantor);
        if (entry.grantee !== null) scopedRoles.add(entry.grantee);
      }
      scopedRoles.add(owner);
      schemas.set(schemaName, record);
    }
    this.schemasSection = sortedByCanonical(
      [...schemas.entries()].map(([schemaName, record]) => ({
        schema: PRODUCT_SCHEMAS.has(schemaName) ? schemaName : null,
        schema_token: PRODUCT_SCHEMAS.has(schemaName) ? null : legacyInventoryToken('schema-name', schemaName),
        owner_token: legacyInventoryToken('role-name', record.owner),
        acl: this.renderAcl(record.acl),
      })),
      (entry) => canonicalSourceJson(entry as unknown as SourceJsonValue),
    ) as unknown as JsonValue[];

    const relationAclRows = await this.query(SQL_RELATION_ACL);
    const relationsByQualified = new Map(this.relations.map((relation) => [relation.identityKey, relation]));
    for (const row of relationAclRows) {
      const relation = relationsByQualified.get(
        legacyRelationIdentity(requireString(row, 'schema_name', 'relation-acl'), requireString(row, 'relation_name', 'relation-acl')),
      );
      const entry = this.aclFromRow(row, 'relation-acl');
      if (relation === undefined || entry === null) continue;
      relation.acl.push(entry);
      scopedRoles.add(entry.grantor);
      if (entry.grantee !== null) scopedRoles.add(entry.grantee);
    }
    for (const relation of this.relations) scopedRoles.add(relation.owner);

    const runtimeProbe = await this.query(regclassProbeSql('brain_meta.runtime_roles'));
    if (runtimeProbe.length === 1 && runtimeProbe[0]?.present === true) {
      const runtimeRows = await this.query(SQL_RUNTIME_ROLES);
      const names: string[] = [];
      for (const row of runtimeRows) {
        const name = requireString(row, 'rolname', 'runtime-roles');
        names.push(name);
        scopedRoles.add(name);
      }
      this.runtimeRolesSection = {
        status: 'present',
        role_tokens: sortedByCanonical(
          names.map((name) => legacyInventoryToken('role-name', name)),
          (token) => token,
        ),
      };
    } else {
      this.runtimeRolesSection = { status: 'missing' };
    }

    const memberships = await this.query(SQL_ROLE_MEMBERSHIP, [[...scopedRoles].sort(byteCompare)]);
    this.membershipSection = sortedByCanonical(
      memberships.map((row) => ({
        role_token: legacyInventoryToken('role-name', requireString(row, 'role_name', 'role-membership')),
        member_token: legacyInventoryToken('role-name', requireString(row, 'member_name', 'role-membership')),
      })),
      (entry) => canonicalSourceJson(entry as unknown as SourceJsonValue),
    ) as unknown as JsonValue[];

    const defaultRows = await this.query(SQL_DEFAULT_ACL);
    const defaults: Record<string, JsonValue>[] = [];
    for (const row of defaultRows) {
      const schemaName = optionalString(row, 'schema_name', 'default-acl');
      if (schemaName !== null && (schemaName.startsWith('pg_') || schemaName === 'information_schema')) continue;
      const owner = requireString(row, 'owner_name', 'default-acl');
      const entry = this.aclFromRow(row, 'default-acl');
      if (entry === null) continue;
      defaults.push({
        owner_token: legacyInventoryToken('role-name', owner),
        schema: schemaName !== null && PRODUCT_SCHEMAS.has(schemaName) ? schemaName : null,
        schema_token: schemaName === null || PRODUCT_SCHEMAS.has(schemaName) ? null : legacyInventoryToken('schema-name', schemaName),
        object_type: requireString(row, 'object_type', 'default-acl'),
        grantor_token: legacyInventoryToken('role-name', entry.grantor),
        grantee: entry.grantee === null ? 'PUBLIC' : null,
        grantee_token: entry.grantee === null ? null : legacyInventoryToken('role-name', entry.grantee),
        privilege: entry.privilege,
        grantable: entry.grantable,
      });
    }
    this.defaultAclSection = sortedByCanonical(
      defaults,
      (entry) => canonicalSourceJson(entry as unknown as SourceJsonValue),
    ) as unknown as JsonValue[];
  }

  private async collectObjectHistory(): Promise<void> {
    const reader = this.input.objectHistory;
    const seenCursors = new Set<string>();
    const seenEntries = new Set<string>();
    let previous: LegacyS3Cursor | null = null;
    let cursor: string | null = null;
    let pages = 0;
    const prefixSlash = this.prefix.length === 0 ? '' : `${this.prefix}/`;
    for (;;) {
      this.guardTime();
      pages++;
      if (pages > this.limits.maxObjectHistoryPages) {
        throw new IncompleteInventoryError(finding('object-history-limit', 'inventory', 'inventory', 'pages'));
      }
      let page: LegacyObjectHistoryPage;
      try {
        page = await reader.listHistory(cursor);
      } catch (error) {
        throw new IncompleteInventoryError(finding('provider-error', 'object', 'object-history', providerErrorDetail(error)));
      }
      this.guardTime();
      if (page === null || typeof page !== 'object' || !Array.isArray(page.entries)) {
        throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'page-shape'));
      }
      for (const entry of page.entries) {
        this.validateHistoryEntry(entry, prefixSlash);
        const identity = canonicalSourceJson([entry.kind, entry.key, entry.versionId]);
        if (seenEntries.has(identity)) {
          throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'duplicate-entry'));
        }
        seenEntries.add(identity);
        this.history.push({
          kind: entry.kind,
          key: entry.key,
          versionId: entry.versionId,
          isLatest: entry.isLatest,
          etag: entry.etag,
          sizeBytes: entry.sizeBytes,
        });
        if (this.history.length > this.limits.maxObjectHistoryItems) {
          throw new IncompleteInventoryError(finding('object-history-limit', 'inventory', 'inventory', 'items'));
        }
      }
      if (page.cursor === null) break;
      if (typeof page.cursor !== 'string' || seenCursors.has(page.cursor)) {
        throw new IncompleteInventoryError(finding('cursor-invalid', 'object', 'object-history', 'repeated-cursor'));
      }
      seenCursors.add(page.cursor);
      const decoded = decodeLegacyS3Cursor(page.cursor);
      if (decoded === null) {
        throw new IncompleteInventoryError(finding('cursor-invalid', 'object', 'object-history', 'malformed-cursor'));
      }
      if (decoded.namespaceFingerprint !== this.namespaceFingerprint) {
        throw new IncompleteInventoryError(finding('cursor-invalid', 'object', 'object-history', 'wrong-namespace'));
      }
      if (prefixSlash.length > 0 && !decoded.keyMarker.startsWith(prefixSlash)) {
        throw new IncompleteInventoryError(finding('cursor-invalid', 'object', 'object-history', 'marker-prefix'));
      }
      if (previous !== null) {
        // Opaque S3 version ids carry no defined order: progress on an unchanged
        // key marker requires only that the version marker CHANGES.
        const keyOrder = byteCompare(decoded.keyMarker, previous.keyMarker);
        if (keyOrder < 0 || (keyOrder === 0 && decoded.versionMarker === previous.versionMarker)) {
          throw new IncompleteInventoryError(finding('cursor-invalid', 'object', 'object-history', 'non-progressing-cursor'));
        }
      }
      previous = decoded;
      cursor = page.cursor;
    }
    this.history.sort((a, b) =>
      byteCompare(a.key, b.key)
      || (a.versionId === null ? (b.versionId === null ? 0 : -1) : b.versionId === null ? 1 : byteCompare(a.versionId, b.versionId))
      || byteCompare(a.kind, b.kind)
      || Number(a.isLatest) - Number(b.isLatest));
  }

  private validateHistoryEntry(entry: LegacyObjectHistoryObservation, prefixSlash: string): void {
    if (
      entry === null
      || typeof entry !== 'object'
      || (entry.kind !== 'version' && entry.kind !== 'delete-marker')
      || typeof entry.key !== 'string'
      || entry.key.length === 0
      || CONTROL_CHARS.test(entry.key)
      || typeof entry.isLatest !== 'boolean'
    ) {
      throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'entry-shape'));
    }
    if (entry.versionId !== null && (typeof entry.versionId !== 'string' || !VERSION_ID_TEXT.test(entry.versionId))) {
      throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'version-id'));
    }
    if (prefixSlash.length > 0 && !entry.key.startsWith(prefixSlash)) {
      throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'prefix-escape'));
    }
    if (entry.kind === 'version') {
      if (typeof entry.etag !== 'string' || !ETAG_TEXT.test(entry.etag)) {
        throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'missing-etag'));
      }
      if (typeof entry.sizeBytes !== 'string' || !DECIMAL.test(entry.sizeBytes) || entry.sizeBytes.startsWith('-')) {
        throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'missing-size'));
      }
    } else if (entry.etag !== null || entry.sizeBytes !== null) {
      throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'delete-marker-shape'));
    }
  }

  private normalizeEtag(etag: string): string {
    return etag.replaceAll('"', '');
  }

  private async headVersion(key: string, versionId: string): Promise<LegacyObjectHeadVersion | null> {
    this.guardTime();
    try {
      const head = await this.input.objectHistory.headVersion({ key, versionId });
      this.guardTime();
      if (head === null) return null;
      if (
        typeof head !== 'object'
        || (head.etag !== null && (typeof head.etag !== 'string' || !ETAG_TEXT.test(head.etag)))
        || typeof head.sizeBytes !== 'string'
        || !DECIMAL.test(head.sizeBytes)
        || head.sizeBytes.startsWith('-')
      ) {
        throw new IncompleteInventoryError(finding('provider-integrity', 'object', 'object-history', 'head-shape'));
      }
      return head;
    } catch (error) {
      if (error instanceof IncompleteInventoryError) throw error;
      throw new IncompleteInventoryError(finding('provider-error', 'object', 'object-history', providerErrorDetail(error)));
    }
  }

  private assembleRelationEntry(relation: CatalogRelation): Record<string, JsonValue> {
    const definitionHash = `sha256:${sha256Hex(canonicalSourceJson({
      domain: `${LEGACY_INVENTORY_TOKEN_CONTEXT}relation-definition`,
      relation: [relation.schema, relation.name],
      kind: relation.kind,
      columns: relation.columns.map((column) => [
        column.ordinal,
        column.name,
        column.typeName,
        column.typeSchema,
        column.typeBaseName,
        column.notNull,
        column.generated,
        column.identity,
        column.hasDefault,
      ]),
      primary_key: relation.primaryKey.map((key) => [key.position, key.column]),
      defaults: relation.defaults.map((entry) => [entry.column, entry.expression]),
      constraints: relation.constraints.map((entry) => [entry.name, entry.kind, entry.definition]),
      indexes: relation.indexes.map((entry) => [entry.name, entry.definition]),
      view_definition: relation.viewDefinition,
    }))}`;
    const custom = relation.classification === 'adopter-custom';
    const schemaClear = PRODUCT_SCHEMAS.has(relation.schema);
    return {
      classification: relation.classification,
      schema: schemaClear ? relation.schema : null,
      schema_token: schemaClear ? null : legacyInventoryToken('schema-name', relation.schema),
      name: custom ? null : relation.name,
      name_token: custom ? legacyInventoryToken('relation-name', relation.identityKey) : null,
      relation_kind: relation.kind,
      owner_token: legacyInventoryToken('role-name', relation.owner),
      definition: {
        columns: relation.columns.map((column): JsonValue => ({
          ordinal: column.ordinal,
          type: column.typeSchema === 'pg_catalog'
            ? ({ kind: 'builtin', name: column.typeName } as JsonValue)
            : ({ kind: 'custom', name_token: legacyInventoryToken('relation-name', legacyRelationIdentity(column.typeSchema, column.typeBaseName)) } as JsonValue),
          not_null: column.notNull,
          generated: column.generated,
          identity: column.identity,
          has_default: column.hasDefault,
        })),
        primary_key_positions: relation.primaryKey.map((key) => key.position),
      },
      definition_hash: definitionHash,
      row_count: relation.rowCount,
      rows: relation.rows === null ? null : (relation.rows as unknown as JsonValue),
      stable_ids: relation.stableIds === null
        ? null
        : { count: relation.stableIds.count, digest: relation.stableIds.digest, ids: relation.stableIds.ids },
      acl: this.renderAcl(relation.acl),
    };
  }

  private async assemble(): Promise<LegacyInventoryResult> {
    await this.runCorrelation();
    const deduped = [...this.findings.values()].sort(compareFindings);
    if (deduped.length > this.limits.maxFindings) {
      const fatal = finding('finding-limit', 'inventory', 'inventory', 'findings');
      this.addFinding(fatal);
      throw new IncompleteInventoryError(fatal);
    }
    const relationEntries = this.relations.map((relation) => this.assembleRelationEntry(relation));
    const definitionSetHash = `sha256:${sha256Hex(canonicalSourceJson({
      domain: `${LEGACY_INVENTORY_TOKEN_CONTEXT}relation-definition-set`,
      hashes: relationEntries.map((entry) => entry.definition_hash as string).sort(byteCompare),
    }))}`;
    const historyEntries = this.history.map((entry) => ({
      kind: entry.kind,
      key_token: legacyInventoryToken('s3-key', entry.key),
      version_id: entry.versionId,
      is_latest: entry.isLatest,
      etag: entry.etag === null ? null : ETAG_TEXT.test(entry.etag) ? entry.etag : legacyInventoryToken('stable-id', entry.etag),
      size_bytes: entry.sizeBytes,
    }));
    const manifest: LegacyInventoryManifest = {
      manifest_format_version: LEGACY_INVENTORY_MANIFEST_FORMAT_VERSION,
      inventory_algorithm: LEGACY_INVENTORY_ALGORITHM,
      token_scheme: LEGACY_INVENTORY_TOKEN_SCHEME,
      identity: {
        expected: {
          workspace_id: this.input.expected.workspaceId,
          fingerprint_format_version: this.input.expected.fingerprintFormatVersion,
          namespace_fingerprint: this.input.expected.namespaceFingerprint,
        },
        observed: this.observedIdentity,
        ownership: this.ownership,
        absent_identity_policy: this.input.absentIdentityPolicy,
      },
      postgres: {
        migrations: this.migrations,
        relations: relationEntries as unknown as JsonValue,
        definition_set_hash: definitionSetHash,
        database: this.databaseSection,
        schemas: this.schemasSection,
        runtime_roles: this.runtimeRolesSection,
        role_memberships: this.membershipSection,
        default_acls: this.defaultAclSection,
      },
      s3: {
        namespace: {
          bucket_token: legacyInventoryToken('path', this.input.objectHistory.bucket),
          prefix_token: legacyInventoryToken('path', this.prefix),
          fingerprint: this.namespaceFingerprint,
        },
        history: historyEntries as unknown as JsonValue,
      },
      findings: deduped as unknown as JsonValue,
    };
    const manifestBytes = Buffer.from(`${canonicalSourceJson(manifest as unknown as SourceJsonValue)}\n`, 'utf8');
    const digest = `sha256:${sha256Hex(manifestBytes)}`;
    const report: LegacyInventoryReport = Object.freeze({
      inventory_algorithm: LEGACY_INVENTORY_ALGORITHM,
      manifest_digest: digest,
      ownership: this.ownership,
      workspace_id: this.input.expected.workspaceId,
      totals: Object.freeze({
        relations: this.relations.length,
        product_legacy_rows: this.legacyRowTotal,
        lifecycle_rows: this.lifecycleRowTotal,
        custom_tables: this.relations.filter((relation) => relation.classification === 'adopter-custom'
          && (relation.kind === 'table' || relation.kind === 'partitioned-table')).length,
        custom_stable_ids: this.customStableIdTotal,
        object_versions: this.history.filter((entry) => entry.kind === 'version').length,
        delete_markers: this.history.filter((entry) => entry.kind === 'delete-marker').length,
        migrations: this.migrationCount,
        findings: deduped.length,
      }),
      findings: Object.freeze(deduped),
    });
    return Object.freeze({
      outcome: 'complete' as const,
      manifestBytes,
      digest,
      manifest,
      report,
    });
  }

  private async runCorrelation(): Promise<void> {
    const prefixSlash = this.prefix.length === 0 ? '' : `${this.prefix}/`;
    const versionsByKey = new Map<string, LegacyObjectHistoryObservation[]>();
    for (const entry of this.history) {
      if (entry.kind !== 'version') continue;
      const list = versionsByKey.get(entry.key) ?? [];
      list.push(entry);
      versionsByKey.set(entry.key, list);
    }
    for (const [key, versions] of versionsByKey) {
      if (CONTENT_ADDRESSED_KEY.test(key) && versions.length > 1) {
        this.addFinding(finding('mutable-key-history', 'object', legacyInventoryToken('s3-key', key), 'mutable-content-key'));
      }
    }
    const ownedKeys = new Set<string>();
    const claims = new Map<string, number>();
    const claim = (key: string, versionId: string | null): void => {
      const identity = canonicalSourceJson([key, versionId]);
      claims.set(identity, (claims.get(identity) ?? 0) + 1);
    };

    const hashKeys = new Map<string, Set<string>>();
    for (const row of this.filesRows) {
      if (row.op !== 'put') continue;
      const rowRef = `brain.files/${row.rowId}`;
      const inNamespace = row.bucket === this.input.objectHistory.bucket
        && row.key !== null
        && (prefixSlash.length === 0 || row.key.startsWith(prefixSlash));
      if (!inNamespace) {
        this.addFinding(finding('ambiguous-ownership', 'row', rowRef, 'outside-namespace'));
        row.record.correlation = { status: 'outside-namespace' };
        continue;
      }
      const key = row.key!;
      ownedKeys.add(key);
      if (row.contentHash !== null) {
        const keys = hashKeys.get(row.contentHash) ?? new Set<string>();
        keys.add(key);
        hashKeys.set(row.contentHash, keys);
      }
      const candidates = (versionsByKey.get(key) ?? []).filter((entry) => {
        if (row.etag !== null && entry.etag !== null && this.normalizeEtag(entry.etag) !== this.normalizeEtag(row.etag)) {
          return false;
        }
        if (row.sizeBytes !== null && entry.sizeBytes !== row.sizeBytes) return false;
        return row.etag !== null || row.sizeBytes !== null;
      });
      if (candidates.length === 0) {
        this.addFinding(finding('missing-bytes', 'row', rowRef, legacyInventoryToken('s3-key', key)));
        row.record.correlation = { status: 'missing' };
      } else if (candidates.length > 1) {
        this.addFinding(finding('ambiguous-version-match', 'row', rowRef, legacyInventoryToken('s3-key', key)));
        row.record.correlation = { status: 'ambiguous', match_count: candidates.length };
      } else {
        const matched = candidates[0]!;
        claim(key, matched.versionId);
        row.record.correlation = { status: 'matched', version_id: matched.versionId };
      }
    }
    for (const [hash, keys] of hashKeys) {
      if (keys.size > 1) {
        const ref = HASH_TEXT.test(hash) ? hash.toLowerCase() : legacyInventoryToken('stable-id', hash);
        this.addFinding(finding('reused-hash', 'object', ref, 'multiple-keys'));
      }
    }

    for (const row of this.lifecycleRows) {
      const rowRef = `brain.source_objects/${row.objectId}`;
      const key = prefixSlash.length === 0 ? row.objectKey : `${prefixSlash}${row.objectKey}`;
      ownedKeys.add(key);
      if (row.versionId !== null) {
        const listed = (versionsByKey.get(key) ?? []).find((entry) => entry.versionId === row.versionId);
        const head = await this.headVersion(key, row.versionId);
        if (head === null) {
          this.addFinding(finding('missing-bytes', 'row', rowRef, legacyInventoryToken('s3-key', key)));
          row.record.correlation = { status: 'missing' };
          continue;
        }
        let drifted = false;
        if (head.versionId === null || head.versionId !== row.versionId) {
          this.addFinding(finding('version-drift', 'object-version', rowRef, 'head-version-identity'));
          drifted = true;
        }
        if (row.etag !== null) {
          if (head.etag === null) {
            this.addFinding(finding('etag-drift', 'object-version', rowRef, 'head-etag-missing'));
            drifted = true;
          } else if (this.normalizeEtag(row.etag) !== this.normalizeEtag(head.etag)) {
            this.addFinding(finding('etag-drift', 'object-version', rowRef, 'head-vs-database'));
            drifted = true;
          }
        }
        if (row.sizeBytes !== null && head.sizeBytes !== row.sizeBytes) {
          this.addFinding(finding('version-drift', 'object-version', rowRef, 'size-vs-database'));
          drifted = true;
        }
        if (listed === undefined) {
          this.addFinding(finding('version-drift', 'object-version', rowRef, 'not-listed'));
          drifted = true;
        } else if (
          (listed.etag !== null && head.etag !== null && this.normalizeEtag(listed.etag) !== this.normalizeEtag(head.etag))
          || listed.sizeBytes !== head.sizeBytes
        ) {
          this.addFinding(finding('etag-drift', 'object-version', rowRef, 'head-vs-history'));
          drifted = true;
        }
        claim(key, row.versionId);
        row.record.correlation = drifted ? { status: 'drift', version_id: row.versionId } : { status: 'matched', version_id: row.versionId };
      } else {
        const candidates = (versionsByKey.get(key) ?? []).filter((entry) => {
          if (row.etag !== null && entry.etag !== null && this.normalizeEtag(entry.etag) !== this.normalizeEtag(row.etag)) {
            return false;
          }
          if (row.sizeBytes !== null && entry.sizeBytes !== row.sizeBytes) return false;
          return row.etag !== null || row.sizeBytes !== null;
        });
        if (candidates.length === 0) {
          this.addFinding(finding('missing-bytes', 'row', rowRef, legacyInventoryToken('s3-key', key)));
          row.record.correlation = { status: 'missing' };
        } else if (candidates.length > 1) {
          this.addFinding(finding('ambiguous-version-match', 'row', rowRef, legacyInventoryToken('s3-key', key)));
          row.record.correlation = { status: 'ambiguous', match_count: candidates.length };
        } else {
          claim(key, candidates[0]!.versionId);
          row.record.correlation = { status: 'matched', version_id: candidates[0]!.versionId };
        }
      }
    }

    for (const [identity, count] of claims) {
      if (count > 1) {
        const [key] = JSON.parse(identity) as [string, string | null];
        this.addFinding(finding('ambiguous-ownership', 'object-version', legacyInventoryToken('s3-key', key), 'multiple-claims'));
      }
    }
    const distinctKeys = new Set(this.history.map((entry) => entry.key));
    for (const key of distinctKeys) {
      if (!ownedKeys.has(key)) {
        this.addFinding(finding('ambiguous-ownership', 'object', legacyInventoryToken('s3-key', key), 'unowned'));
      }
    }
  }
}

export function isFatalLegacyInventoryFinding(code: LegacyInventoryFindingCode): boolean {
  return FATAL_FINDING_CODES.has(code);
}

export async function inventoryLegacyBrain(input: LegacyInventoryInput): Promise<LegacyInventoryResult> {
  validateInput(input);
  return new LegacyInventoryRun(input).execute();
}
