import {
  InvalidRecordError,
  sha256Hex,
  snapshotPayload,
  type ArtifactDeclaration,
  type ArtifactDeclarationKind,
  type ArtifactMeta,
  type ArtifactRole,
  type ExternalArtifactInput,
  type InternalDeclarationInput,
} from './contracts.ts';
import { sanitizeForIndex, safeProjectionIdent, looksSecret } from './sanitize-index.ts';

// Shared validation + deterministic id/canonical derivation for artifact
// declarations (#323), used by the postgres and local stores AND the degraded
// spool so every producer of a given logical declaration derives byte-identical
// (id, payload) — a replay after an outage dedups instead of conflicting.
//
// Declaration id (Rev3-R2-5 + Rev4-R3-2): sha256hex over
//   [workspace_id, run_id, declaring_agent, role, ref]
// joined by '\n', where ref = digest (internal) or 'provider:external_id'
// (external). role is IN the id, so a produced and a used declaration of the
// same reference by the same run/agent are two distinct rows.

const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TYPE_RE = /^[A-Za-z0-9._+/:-]{1,128}$/;
const MAX_FIELD_LEN = 512;
const ROLES: ReadonlySet<string> = new Set<ArtifactRole>(['produced', 'used']);

function requireSafeIdentifier(field: string, value: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_RE.test(value)) {
    throw new InvalidRecordError(`${field} must match ${SAFE_IDENTIFIER_RE.source} — got '${String(value)}'`);
  }
  return value;
}

function optionalType(field: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SAFE_TYPE_RE.test(value)) {
    throw new InvalidRecordError(`${field} must match ${SAFE_TYPE_RE.source} or be null — got '${String(value)}'`);
  }
  return value;
}

function optionalBounded(field: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidRecordError(`${field} must be a string or null`);
  if (value.length > MAX_FIELD_LEN) throw new InvalidRecordError(`${field} exceeds ${MAX_FIELD_LEN} characters`);
  return value;
}

function requireRole(value: ArtifactRole | undefined): ArtifactRole {
  const role = value ?? 'produced';
  if (!ROLES.has(role)) {
    throw new InvalidRecordError(`role must be 'produced' or 'used' (got '${String(role)}')`);
  }
  return role;
}

export function declarationId(
  workspaceId: string,
  runId: string,
  declaringAgent: string,
  role: ArtifactRole,
  ref: string,
): string {
  return sha256Hex([workspaceId, runId, declaringAgent, role, ref].join('\n'));
}

// The external reference used in the declaration id: a LENGTH-PREFIXED frame of
// (provider, externalId), NOT a raw 'provider:externalId' colon-join (finding:
// both fields permit colons, so provider='a:b',id='c' and provider='a',id='b:c'
// produced the SAME id and the second valid declaration became a false conflict).
// The provider length prefix makes the split unambiguous.
export function externalRef(provider: string, externalId: string): string {
  return `${provider.length}:${provider}:${externalId}`;
}

// The semantic fields that participate in the id/payload hash (a same-id write
// with different semantic content is a ConflictError).
export type DeclarationSemantic = {
  runId: string;
  declaringAgent: string;
  role: ArtifactRole;
  kind: ArtifactDeclarationKind;
  digest: string | null;
  provider: string | null;
  externalId: string | null;
  externalUrl: string | null;
  artifactType: string | null;
  mediaType: string | null;
  provenance: unknown;
};

// Store-assigned observations: derived / write-path-stamped, never in the id or
// payload hash (a re-declare with different prose or a later version fill is not
// a conflict). verified is NEVER caller-supplied; version_state is admin-repair
// mutable only (Rev4-R3 should-fix).
export type DeclarationObservations = {
  verified: boolean;
  versionState: string | null;
  sanitizedText: string | null;
  // Set when the declaration is SPOOLED while its blob is still queued: the
  // immutable object version cannot be observed yet, so `versionState` is only a
  // placeholder ('unverified') and the materializing store must derive the real
  // state from the committed blob row when the entry drains (round-7 finding 5).
  // Absent/false on the direct path, where the write already observed the
  // committed row — there the snapshot IS the authority and is never re-derived.
  versionPending?: boolean;
};

export type DeclarationParts = {
  id: string;
  ref: string;
  payload: DeclarationSemantic;
  canonical: string;
  observations: DeclarationObservations;
};

function partsOf(
  workspaceId: string,
  ref: string,
  semantic: DeclarationSemantic,
  observations: DeclarationObservations,
): DeclarationParts {
  const id = declarationId(workspaceId, semantic.runId, semantic.declaringAgent, semantic.role, ref);
  // Serialize the COMPLETE declaration (incl. provenance) HERE so an
  // unserializable (e.g. circular) provenance is rejected as an InvalidRecordError
  // at the derivation step — which every store calls BEFORE any blob write —
  // rather than throwing a raw TypeError mid-mutation (finding: a circular
  // provenance committed the blob, then JSON.stringify threw, orphaning it).
  let snap;
  try {
    snap = snapshotPayload(semantic);
  } catch (err) {
    throw new InvalidRecordError(`declaration provenance is not JSON-serializable: ${(err as Error).message}`);
  }
  return { id, ref, payload: snap.value as DeclarationSemantic, canonical: snap.canonical, observations };
}

// Validate the caller-supplied declaration inputs (role, declaring agent, run
// id, artifact/media types) WITHOUT the digest — so a put path can reject a bad
// declaration BEFORE it writes/uploads any blob bytes (finding: declaration
// validation ran AFTER the blob mutation, orphaning the blob/upload on an
// invalid --role/agent). Throws InvalidRecordError on the first bad field.
export function assertInternalDeclarationInput(decl: InternalDeclarationInput): void {
  requireSafeIdentifier('declaration runId', decl.runId);
  requireSafeIdentifier('declaring agent', decl.declaringAgent);
  requireRole(decl.role);
  optionalType('artifactType', decl.artifactType);
  optionalType('mediaType', decl.mediaType);
}

// An internal declaration: a run declares it produced/used content bytes (the
// blob is stored separately, keyed by digest). versionState reflects whether the
// blob's object version id was captured at write ('verified') or must be filled
// by a later admin-repair ('unverified').
export function internalDeclarationParts(
  workspaceId: string,
  digest: string,
  decl: InternalDeclarationInput,
  versionState: 'verified' | 'unverified',
): DeclarationParts {
  const runId = requireSafeIdentifier('declaration runId', decl.runId);
  const declaringAgent = requireSafeIdentifier('declaring agent', decl.declaringAgent);
  const role = requireRole(decl.role);
  const provenance = decl.provenance ?? {};
  const semantic: DeclarationSemantic = {
    runId,
    declaringAgent,
    role,
    kind: 'internal',
    digest,
    provider: null,
    externalId: null,
    externalUrl: null,
    artifactType: optionalType('artifactType', decl.artifactType),
    mediaType: optionalType('mediaType', decl.mediaType),
    provenance,
  };
  const sanitizedText = decl.text != null ? sanitizeForIndex(decl.text) : null;
  return partsOf(workspaceId, digest, semantic, { verified: true, versionState, sanitizedText });
}

// An external declaration: a declaration-only row (no bytes, no digest). ref is
// 'provider:external_id'. verified stays false until #322 supplies a correlated
// host-attested tool result.
export function externalDeclarationParts(workspaceId: string, input: ExternalArtifactInput): DeclarationParts {
  const runId = requireSafeIdentifier('declaration runId', input.runId);
  const declaringAgent = requireSafeIdentifier('declaring agent', input.declaringAgent);
  const role = requireRole(input.role);
  const provider = requireSafeIdentifier('provider', input.provider);
  const externalId = optionalBounded('externalId', input.externalId);
  if (externalId === null || externalId.length === 0) {
    throw new InvalidRecordError('external declarations require a non-empty externalId');
  }
  const provenance = input.provenance ?? {};
  const semantic: DeclarationSemantic = {
    runId,
    declaringAgent,
    role,
    kind: 'external',
    digest: null,
    provider,
    externalId,
    externalUrl: optionalBounded('externalUrl', input.externalUrl),
    artifactType: optionalType('artifactType', input.artifactType),
    mediaType: optionalType('mediaType', input.mediaType),
    provenance,
  };
  const ref = externalRef(provider, externalId);
  const sanitizedText = input.text != null ? sanitizeForIndex(input.text) : null;
  return partsOf(workspaceId, ref, semantic, { verified: false, versionState: null, sanitizedText });
}

const MEDIA_TYPE_RE = /^[A-Za-z0-9._+/:-]{1,128}$/;

// The deterministic legacy declaration synthesized for a v1 artifact blob (a
// #318 row with no declaration). declaring_agent='legacy', role='produced',
// version_state='unverified'. run_id is sentinel-normalized to match the PG
// migration backfill's id derivation byte-for-byte (finding: v1 records not
// upgraded — PG backfill, local fold, and v1 outbox drain must synthesize the
// SAME id). The raw legacy meta is preserved in provenance (non-projected).
export function legacyDeclarationOf(
  workspaceId: string,
  digest: string,
  meta: ArtifactMeta,
  createdAt: number,
): ArtifactDeclaration {
  const rawRunId = meta.runId != null && meta.runId.length > 0 ? meta.runId : 'unknown';
  const runId = safeProjectionIdent(rawRunId);
  const ct = meta.contentType;
  const mediaType = ct != null && MEDIA_TYPE_RE.test(ct) && !looksSecret(ct) ? ct : null;
  return {
    id: declarationId(workspaceId, runId, 'legacy', 'produced', digest),
    workspaceId,
    runId,
    declaringAgent: 'legacy',
    role: 'produced',
    kind: 'internal',
    digest,
    provider: null,
    externalId: null,
    externalUrl: null,
    artifactType: null,
    mediaType,
    provenance: { origin: 'legacy-backfill', legacy_meta: meta },
    verified: false,
    versionState: 'unverified',
    sanitizedText: null,
    createdAt,
    seq: null,
    queued: false,
  };
}
