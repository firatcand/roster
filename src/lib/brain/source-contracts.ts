import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import {
  assertFunctionId,
  assertRecordId,
  assertWorkspaceId,
  normalizeWorkspaceRelativePath,
} from '../workspace-layout.ts';
import type { ContextTrustClass } from '../context-trust.ts';

export const SOURCE_KINDS = [
  'workspace-file',
  'fetched-media',
  'inline-text',
  'structured-record',
  'produced-artifact',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_PRIVACY_CLASSES = ['public', 'internal', 'secret'] as const;
export type SourcePrivacyClass = (typeof SOURCE_PRIVACY_CLASSES)[number];

export const SOURCE_TRUST_CLASSES = [
  'brain-structured',
  'brain-extract-untrusted',
  'tool-output-untrusted',
  'host-asserted',
  'legacy-unverified',
] as const satisfies readonly ContextTrustClass[];
export type SourceTrustClass = (typeof SOURCE_TRUST_CLASSES)[number];

export const ACTOR_ASSURANCES = [
  'system-derived',
  'caller-asserted',
  'host-attested',
  'human-confirmed',
] as const;
export type ActorAssurance = (typeof ACTOR_ASSURANCES)[number];

export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_REQUEST_KEY_BYTES = 256;
export const MAX_SOURCE_STABLE_KEY_BYTES = 256;
export const MAX_SOURCE_LABELS = 64;
export const MAX_SOURCE_PATH_BYTES = 4_096;
export const MAX_SOURCE_URL_BYTES = 4_096;
export const MAX_SOURCE_PROVENANCE_BYTES = 64 * 1024;

const MAX_PROVIDER_BYTES = 128;
const MAX_UPSTREAM_ID_BYTES = 512;
const MAX_ACTOR_ID_BYTES = 256;
const MAX_EVIDENCE_ID_BYTES = 256;
const MAX_MEDIA_TYPE_BYTES = 128;
const MAX_SOURCE_TIMESTAMP_BYTES = 128;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_PATH_COMPONENT_BYTES = 255;
const STABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]*$/u;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-/]*$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:\//u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const ROSTER_TEMPORARY = /^\..+\.roster-\d+-\d+-[a-f0-9]{12}(?:\.(?:recovery|rollback))?$/u;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

export type SourceJsonValue = JsonValue;
export type SourceJsonObject = { readonly [key: string]: SourceJsonValue };

export type SourceRetrievalLabelInput = {
  workspace: string;
  function?: string;
  agent?: string;
  plan?: string;
};

export type SourceRetrievalLabel = Readonly<{
  workspace: string;
  function: string | null;
  agent: string | null;
  plan: string | null;
}>;

export type SourceOriginInput =
  | { kind: 'workspace-file'; workspacePath: string }
  | {
      kind: 'fetched-media';
      provider?: string | null;
      upstreamId?: string | null;
      canonicalUrl?: string | null;
    }
  | { kind: 'inline-text' | 'structured-record' | 'produced-artifact'; stableKey: string };

export type SourceOrigin =
  | Readonly<{ kind: 'workspace-file'; workspacePath: string }>
  | Readonly<{
      kind: 'fetched-media';
      identity: Readonly<{ kind: 'provider-id'; provider: string; upstreamId: string }>;
      canonicalUrl: string | null;
    }>
  | Readonly<{
      kind: 'fetched-media';
      identity: Readonly<{ kind: 'canonical-url'; canonicalUrl: string }>;
      canonicalUrl: string;
    }>
  | Readonly<{
      kind: 'inline-text' | 'structured-record' | 'produced-artifact';
      stableKey: string;
    }>;

export type SourceActorInput =
  | { actorId: string; assurance: 'system-derived'; component: 'roster' }
  | { actorId: string; assurance: 'caller-asserted' }
  | { actorId: string; assurance: 'host-attested'; host: 'claude' | 'codex'; sessionId: string }
  | { actorId: string; assurance: 'human-confirmed'; decisionId: string; actionDigest: string };

export type SourceActor =
  | Readonly<{ actorId: string; assurance: 'system-derived'; component: 'roster' }>
  | Readonly<{ actorId: string; assurance: 'caller-asserted' }>
  | Readonly<{ actorId: string; assurance: 'host-attested'; host: 'claude' | 'codex'; sessionId: string }>
  | Readonly<{ actorId: string; assurance: 'human-confirmed'; decisionId: string; actionDigest: string }>;

export type SourceIngestInput = {
  requestKey: string;
  expectedTombstoneId?: string | null;
  source: SourceOriginInput;
  bytes: Uint8Array;
  labels: readonly SourceRetrievalLabelInput[];
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  actor: SourceActorInput;
  mediaType?: string | null;
  sourceTimestamp?: string | null;
  provenance: unknown;
};

export type NormalizedSourceIngest = Readonly<{
  requestKey: string;
  expectedTombstoneId: string | null;
  source: SourceOrigin;
  bytes: Buffer;
  labels: readonly SourceRetrievalLabel[];
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  actor: SourceActor;
  mediaType: string;
  sourceTimestamp: string | null;
  provenance: SourceJsonObject;
}>;

function sourceFailure(field: string, reason: string, details: Record<string, JsonValue> = {}): never {
  throw new RosterError({
    header: 'Invalid Brain source input',
    body: `The '${field}' field is invalid: ${reason}.`,
    remedy: 'Provide a bounded value that follows the documented Brain source contract.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_SOURCE_INPUT_INVALID',
    details: { field, reason, ...details },
  });
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(
  field: string,
  value: unknown,
  maximum: number,
  options: { pattern?: RegExp; trimSafe?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) sourceFailure(field, 'it must be a non-empty string');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximum) sourceFailure(field, `it exceeds ${maximum} UTF-8 bytes`, { maximum, observed_bytes: bytes });
  if (!isWellFormed(value) || hasControl(value)) sourceFailure(field, 'it contains invalid Unicode or control characters');
  if (options.trimSafe === true && value.trim() !== value) sourceFailure(field, 'leading or trailing whitespace is not canonical');
  if (options.pattern !== undefined && !options.pattern.test(value)) sourceFailure(field, 'it contains unsupported characters');
  return value;
}

function exactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    sourceFailure(field, 'its evidence shape contains missing or unknown fields');
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value: unknown, field: string): SourceJsonValue {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (entry: unknown, depth: number): SourceJsonValue => {
    nodes++;
    if (nodes > MAX_JSON_NODES) sourceFailure(field, `it exceeds ${MAX_JSON_NODES} JSON nodes`);
    if (depth > MAX_JSON_DEPTH) sourceFailure(field, `it exceeds ${MAX_JSON_DEPTH} levels of nesting`);
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') {
      if (typeof entry === 'string' && (!isWellFormed(entry) || entry.includes('\u0000'))) {
        sourceFailure(field, 'it contains a string PostgreSQL cannot preserve exactly');
      }
      return entry;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) sourceFailure(field, 'it contains a non-finite number');
      return Object.is(entry, -0) ? 0 : entry;
    }
    if (typeof entry !== 'object') sourceFailure(field, 'it must contain only strict JSON values');
    if (active.has(entry)) sourceFailure(field, 'it contains a cycle');
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        const keys = Reflect.ownKeys(entry);
        if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
          sourceFailure(field, 'its arrays contain non-JSON properties');
        }
        const out: SourceJsonValue[] = [];
        for (let index = 0; index < entry.length; index++) {
          if (!Object.hasOwn(entry, index)) sourceFailure(field, 'its arrays must not contain holes');
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            sourceFailure(field, 'its arrays must contain plain data properties');
          }
          out.push(visit(descriptor.value, depth + 1));
        }
        return deepFreeze(out);
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) sourceFailure(field, 'it contains a non-plain object');
      const out: Record<string, SourceJsonValue> = Object.create(null) as Record<string, SourceJsonValue>;
      for (const key of Reflect.ownKeys(entry)) {
        if (typeof key !== 'string') sourceFailure(field, 'it contains a symbol key');
        if (!isWellFormed(key) || key.includes('\u0000')) sourceFailure(field, 'it contains an unsupported object key');
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          sourceFailure(field, 'it contains an accessor or non-enumerable property');
        }
        out[key] = visit(descriptor.value, depth + 1);
      }
      return deepFreeze(out);
    } finally {
      active.delete(entry);
    }
  };
  return visit(value, 0);
}

export function canonicalSourceJson(value: SourceJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSourceJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSourceJson(value[key]!)}`)
    .join(',')}}`;
}

export function normalizeSourceProvenance(value: unknown): SourceJsonObject {
  const cloned = cloneJson(value, 'provenance');
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    sourceFailure('provenance', 'it must be a plain JSON object');
  }
  const canonical = canonicalSourceJson(cloned);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes > MAX_SOURCE_PROVENANCE_BYTES) {
    sourceFailure('provenance', `it exceeds ${MAX_SOURCE_PROVENANCE_BYTES} canonical JSON bytes`, {
      maximum: MAX_SOURCE_PROVENANCE_BYTES,
      observed_bytes: bytes,
    });
  }
  return cloned as SourceJsonObject;
}

export function normalizeSourceRequestKey(value: unknown): string {
  return boundedString('requestKey', value, MAX_SOURCE_REQUEST_KEY_BYTES, { pattern: STABLE_KEY });
}

export function normalizeCanonicalHttpsUrl(value: unknown): string {
  const raw = boundedString('source.canonicalUrl', value, MAX_SOURCE_URL_BYTES);
  if (raw.includes('\\')) sourceFailure('source.canonicalUrl', 'backslashes are not canonical URL separators');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    sourceFailure('source.canonicalUrl', 'it must be an absolute HTTPS URL');
  }
  if (parsed!.protocol !== 'https:' || parsed!.username.length > 0 || parsed!.password.length > 0) {
    sourceFailure('source.canonicalUrl', 'it must use HTTPS and contain no user information');
  }
  const hostname = parsed!.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (hostname.length === 0) sourceFailure('source.canonicalUrl', 'it must name a host');
  const renderedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  const port = parsed!.port.length === 0 ? '' : `:${parsed!.port}`;
  return `https://${renderedHost}${port}${parsed!.pathname}${parsed!.search}`;
}

function normalizeWorkspacePath(value: unknown): string {
  const raw = boundedString('source.workspacePath', value, MAX_SOURCE_PATH_BYTES);
  if (WINDOWS_DRIVE.test(raw) || /^file:/iu.test(raw) || raw.startsWith('~')) {
    sourceFailure('source.workspacePath', 'it names a foreign or expanded path instead of a workspace-relative path');
  }
  let normalized: string;
  try {
    normalized = normalizeWorkspaceRelativePath(raw);
  } catch {
    sourceFailure('source.workspacePath', 'it is not an exact workspace-relative POSIX path');
  }
  for (const component of normalized!.split('/')) {
    if (Buffer.byteLength(component, 'utf8') > MAX_PATH_COMPONENT_BYTES) {
      sourceFailure('source.workspacePath', `a path component exceeds ${MAX_PATH_COMPONENT_BYTES} UTF-8 bytes`);
    }
    if (WINDOWS_RESERVED.test(component) || ROSTER_TEMPORARY.test(component)) {
      sourceFailure('source.workspacePath', 'it contains a reserved or Roster-temporary component');
    }
  }
  return normalized!;
}

export function normalizeSourceOrigin(input: SourceOriginInput): SourceOrigin {
  if (input === null || typeof input !== 'object') sourceFailure('source', 'it must be a source mapping');
  if (!(SOURCE_KINDS as readonly string[]).includes(input.kind)) sourceFailure('source.kind', 'it is not a supported source kind');
  if (input.kind === 'workspace-file') {
    exactKeys(input, ['kind', 'workspacePath'], 'source');
    return Object.freeze({ kind: input.kind, workspacePath: normalizeWorkspacePath(input.workspacePath) });
  }
  if (input.kind === 'fetched-media') {
    const allowed = ['kind', 'provider', 'upstreamId', 'canonicalUrl'];
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) sourceFailure('source', 'it contains unknown fetched-media fields');
    const hasProvider = input.provider !== undefined && input.provider !== null;
    const hasUpstream = input.upstreamId !== undefined && input.upstreamId !== null;
    const hasUrl = input.canonicalUrl !== undefined && input.canonicalUrl !== null;
    if (hasProvider !== hasUpstream) {
      sourceFailure('source', 'provider and upstreamId must be supplied together');
    }
    if (hasProvider) {
      const provider = boundedString('source.provider', input.provider, MAX_PROVIDER_BYTES, { pattern: PROVIDER });
      const upstreamId = boundedString('source.upstreamId', input.upstreamId, MAX_UPSTREAM_ID_BYTES, { trimSafe: true });
      const canonicalUrl = hasUrl ? normalizeCanonicalHttpsUrl(input.canonicalUrl) : null;
      return deepFreeze({
        kind: input.kind,
        identity: { kind: 'provider-id', provider, upstreamId },
        canonicalUrl,
      });
    }
    if (!hasUrl) sourceFailure('source', 'fetched media needs provider + upstreamId or a canonicalUrl fallback');
    const canonicalUrl = normalizeCanonicalHttpsUrl(input.canonicalUrl);
    return deepFreeze({
      kind: input.kind,
      identity: { kind: 'canonical-url', canonicalUrl },
      canonicalUrl,
    });
  }
  exactKeys(input, ['kind', 'stableKey'], 'source');
  return Object.freeze({
    kind: input.kind,
    stableKey: boundedString('source.stableKey', input.stableKey, MAX_SOURCE_STABLE_KEY_BYTES, { pattern: STABLE_KEY }),
  });
}

function labelKey(label: SourceRetrievalLabel): string {
  return canonicalSourceJson(label as unknown as SourceJsonValue);
}

export function normalizeSourceLabels(
  workspaceId: string,
  labels: readonly SourceRetrievalLabelInput[],
): readonly SourceRetrievalLabel[] {
  const workspace = assertWorkspaceId(workspaceId);
  if (!Array.isArray(labels) || labels.length === 0) sourceFailure('labels', 'at least one retrieval label is required');
  if (labels.length > MAX_SOURCE_LABELS) sourceFailure('labels', `it exceeds ${MAX_SOURCE_LABELS} entries`);
  const distinct = new Map<string, SourceRetrievalLabel>();
  for (const input of labels) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) sourceFailure('labels', 'each label must be a mapping');
    const unknown = Object.keys(input).filter((key) => !['workspace', 'function', 'agent', 'plan'].includes(key));
    if (unknown.length > 0) sourceFailure('labels', 'a label contains unknown fields');
    if (assertWorkspaceId(input.workspace) !== workspace) sourceFailure('labels.workspace', 'it does not match the active workspace');
    if (input.agent !== undefined && input.function === undefined) sourceFailure('labels', 'agent requires its function parent');
    if (input.plan !== undefined && (input.function === undefined || input.agent === undefined)) {
      sourceFailure('labels', 'plan requires its function and agent parents');
    }
    const label = Object.freeze({
      workspace,
      function: input.function === undefined ? null : assertFunctionId(input.function),
      agent: input.agent === undefined ? null : assertRecordId(input.agent),
      plan: input.plan === undefined ? null : assertRecordId(input.plan),
    });
    distinct.set(labelKey(label), label);
  }
  return Object.freeze([...distinct.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, label]) => label));
}

export function normalizeSourceActor(input: SourceActorInput): SourceActor {
  if (input === null || typeof input !== 'object') sourceFailure('actor', 'it must be an actor mapping');
  const actorId = boundedString('actor.actorId', input.actorId, MAX_ACTOR_ID_BYTES, { pattern: STABLE_KEY });
  if (!(ACTOR_ASSURANCES as readonly string[]).includes(input.assurance)) sourceFailure('actor.assurance', 'it is not a supported assurance');
  if (input.assurance === 'system-derived') {
    exactKeys(input, ['actorId', 'assurance', 'component'], 'actor');
    if (input.component !== 'roster') sourceFailure('actor.component', "system-derived evidence must name 'roster'");
    return Object.freeze({ actorId, assurance: input.assurance, component: input.component });
  }
  if (input.assurance === 'caller-asserted') {
    exactKeys(input, ['actorId', 'assurance'], 'actor');
    return Object.freeze({ actorId, assurance: input.assurance });
  }
  if (input.assurance === 'host-attested') {
    exactKeys(input, ['actorId', 'assurance', 'host', 'sessionId'], 'actor');
    if (input.host !== 'claude' && input.host !== 'codex') sourceFailure('actor.host', 'it must name a supported host');
    return Object.freeze({
      actorId,
      assurance: input.assurance,
      host: input.host,
      sessionId: boundedString('actor.sessionId', input.sessionId, MAX_EVIDENCE_ID_BYTES, { pattern: STABLE_KEY }),
    });
  }
  exactKeys(input, ['actorId', 'assurance', 'decisionId', 'actionDigest'], 'actor');
  if (!SHA256.test(input.actionDigest)) sourceFailure('actor.actionDigest', 'it must be a lowercase sha256 digest');
  return Object.freeze({
    actorId,
    assurance: input.assurance,
    decisionId: boundedString('actor.decisionId', input.decisionId, MAX_EVIDENCE_ID_BYTES, { pattern: STABLE_KEY }),
    actionDigest: input.actionDigest,
  });
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const raw = boundedString('sourceTimestamp', value, MAX_SOURCE_TIMESTAMP_BYTES);
  const match = raw.match(RFC3339);
  if (match === null) sourceFailure('sourceTimestamp', 'it must be an RFC 3339 timestamp with at most millisecond precision');
  const year = Number(match![1]);
  const month = Number(match![2]);
  const day = Number(match![3]);
  const hour = Number(match![4]);
  const minute = Number(match![5]);
  const second = Number(match![6]);
  const offsetHour = match![8] === undefined ? 0 : Number(match![8]);
  const offsetMinute = match![9] === undefined ? 0 : Number(match![9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0
    || month < 1
    || month > 12
    || day < 1
    || day > days[month - 1]!
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59) {
    sourceFailure('sourceTimestamp', 'it is not a real calendar timestamp');
  }
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) sourceFailure('sourceTimestamp', 'it is not a real timestamp');
  return new Date(time).toISOString();
}

export function normalizeSourceIngest(workspaceId: string, input: SourceIngestInput): NormalizedSourceIngest {
  assertWorkspaceId(workspaceId);
  if (input === null || typeof input !== 'object') sourceFailure('input', 'it must be an ingest mapping');
  const allowed = [
    'requestKey',
    'expectedTombstoneId',
    'source',
    'bytes',
    'labels',
    'privacy',
    'trust',
    'actor',
    'mediaType',
    'sourceTimestamp',
    'provenance',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    sourceFailure('input', 'it contains unknown fields');
  }
  if (!(input.bytes instanceof Uint8Array)) sourceFailure('bytes', 'it must be a Uint8Array or Buffer');
  if (input.bytes.byteLength > MAX_SOURCE_BYTES) {
    sourceFailure('bytes', `it exceeds the ${MAX_SOURCE_BYTES}-byte source limit`, {
      maximum: MAX_SOURCE_BYTES,
      observed_bytes: input.bytes.byteLength,
    });
  }
  if (!(SOURCE_PRIVACY_CLASSES as readonly string[]).includes(input.privacy)) sourceFailure('privacy', 'it is not a supported privacy class');
  if (!(SOURCE_TRUST_CLASSES as readonly string[]).includes(input.trust)) sourceFailure('trust', 'it is not a supported source trust class');
  const source = normalizeSourceOrigin(input.source);
  const actor = normalizeSourceActor(input.actor);
  if (input.trust === 'host-asserted'
    && actor.assurance !== 'host-attested'
    && actor.assurance !== 'human-confirmed') {
    sourceFailure('trust', 'host-asserted trust requires host-attested or human-confirmed actor evidence');
  }
  if (input.trust === 'brain-structured'
    && (source.kind !== 'structured-record'
      || (actor.assurance !== 'host-attested' && actor.assurance !== 'human-confirmed'))) {
    sourceFailure('trust', 'brain-structured trust requires a structured record with host or human evidence');
  }
  if (input.trust === 'legacy-unverified' && actor.assurance !== 'system-derived') {
    sourceFailure('trust', 'legacy-unverified input must be system-derived migration evidence');
  }
  const mediaType = input.mediaType === undefined || input.mediaType === null
    ? 'application/octet-stream'
    : boundedString('mediaType', input.mediaType, MAX_MEDIA_TYPE_BYTES, { pattern: MEDIA_TYPE });
  return Object.freeze({
    requestKey: normalizeSourceRequestKey(input.requestKey),
    expectedTombstoneId: input.expectedTombstoneId === undefined || input.expectedTombstoneId === null
      ? null
      : SHA256.test(input.expectedTombstoneId)
        ? input.expectedTombstoneId
        : sourceFailure('expectedTombstoneId', 'it must be a lowercase sha256 digest'),
    source,
    bytes: Buffer.from(input.bytes),
    labels: normalizeSourceLabels(workspaceId, input.labels),
    privacy: input.privacy,
    trust: input.trust,
    actor,
    mediaType,
    sourceTimestamp: normalizeTimestamp(input.sourceTimestamp),
    provenance: normalizeSourceProvenance(input.provenance),
  });
}
