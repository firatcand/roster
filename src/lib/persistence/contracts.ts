import { createHash } from 'node:crypto';
import type { RunEventKind, RunEventSource } from './run-events.ts';
// Type-only (erased at build): hitl-machine.ts imports VALUES from this module,
// so anything but `import type` here would be a runtime import cycle.
import type { HitlActionKind, HitlExpectedHead, HitlPayloadRef } from './hitl-machine.ts';

// v1 store contracts for the workspace operations ledger (#318 section C).
// Local and postgres-s3 backends implement these; one contract test suite runs
// unchanged against both. HITL state-machine VALIDATION is #319 — this module
// carries only envelope types + append plumbing.

// ---------- error taxonomy ----------

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotConfiguredError extends PersistenceError {}
export class BackendUnavailableError extends PersistenceError {}
export class WorkspaceMismatchError extends PersistenceError {}
export class VersionSkewError extends PersistenceError {}
export class InvalidRecordError extends PersistenceError {}

export class ConflictError extends PersistenceError {
  readonly id: string;
  constructor(id: string, detail: string) {
    super(`record ${id}: ${detail}`);
    this.id = id;
  }
}

// ---------- ids ----------

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    // Object.create(null): a parsed-JSON own key that names a prototype accessor
    // ("__proto__") or a prototype member ("constructor", "prototype") is copied
    // as an OWN data property instead of hitting Object.prototype's setter — so
    // it is preserved in the canonical bytes (no payload loss, no hash collision)
    // and no actual prototype pollution occurs. JSON.stringify still emits it
    // (own enumerable). Object.keys reads the same own keys off the source.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key] = sortValue(src[key]);
    }
    return out;
  }
  return value;
}

// The round-trip (JSON.stringify → JSON.parse) collapses toJSON/getters to
// PLAIN data FIRST, then the recursive key-sort applies to that plain data —
// otherwise a toJSON-returned object is stringified in its own key order and
// never sorted, so its checksum breaks the moment it is re-canonicalized after
// recovery. toJSON is therefore invoked exactly once (during the stringify).
export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value);
  // Preserve the pre-existing quirk: a non-serializable top-level value (e.g.
  // undefined) yields undefined so callers can detect it (see ledger.append).
  if (json === undefined) return json as unknown as string;
  return JSON.stringify(sortValue(JSON.parse(json)));
}

// Snapshot a payload ONCE at the contract boundary: `canonical` is the exact
// bytes to hash and store, `value` is the parsed-plain form (toJSON/getters
// already resolved) to embed. Threading this pair means a stateful toJSON can
// never make the hash and the stored content disagree — every downstream
// serialization operates on the already-plain `value`, which is idempotent.
export function snapshotPayload(value: unknown): { canonical: string; value: unknown } {
  const canonical = canonicalJson(value);
  if (canonical === undefined) return { canonical, value };
  return { canonical, value: JSON.parse(canonical) };
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

// Deterministic full-length record id scoped (workspace, namespace). The
// identity object holds the fields that NAME the record (not necessarily its
// whole payload) — same identity with a different payload is a ConflictError,
// never a silent dedup.
export function computeRecordId(workspaceId: string, namespace: string, identity: unknown): string {
  return sha256Hex(`${workspaceId}\n${namespace}\n${canonicalJson(identity)}`);
}

// ---------- common write / read semantics ----------

export type WriteOutcomeKind = 'committed' | 'queued';
export type WriteOutcome = { outcome: WriteOutcomeKind; id: string };

export type OverlayPosition = { producerId: string; producerSeq: number };

// One queued-overlay run frozen into a Cursor at creation (round-7 finding 4):
// its stable ordering position plus the canonical-id → stable-payload-hash map
// of its queued events. Later pages traverse THIS set and read each run through
// by id — committed or pending, regardless of seq — so a run that fully
// commits+acks mid-pagination neither vanishes nor duplicates.
export type FrozenQueuedRun = {
  runId: string;
  pos: OverlayPosition;
  hashes: Record<string, string>;
  startedAt: number;
  lastEventAt: number;
};

// Composite cursor: `watermark` is the committed-seq high-water mark captured
// at page 1 — later pages only return committed rows at/below it, so an
// overlay record acked mid-pagination cannot reappear as committed. `overlay`
// tracks position in the queued-overlay domain (per producer), used by the
// postgres-s3 backend's outbox overlay; always null on a purely local listing.
// `frozenQueued` is the queued-overlay identity set captured at cursor creation
// (postgres run listing only — see FrozenQueuedRun).
export type Cursor = {
  watermark: number;
  committed: number;
  // The committed position INSIDE `committed`, for a backend whose ordering
  // position is not unique on its own: the local ledger writes a compound
  // envelope's children under ONE seq, so `committed` alone cannot say which
  // siblings a page already returned. Absent ⇒ the whole seq was consumed
  // (postgres, whose bigserial seq is unique per row, never sets it).
  committedPos?: number;
  overlay: OverlayPosition | null;
  frozenQueued?: FrozenQueuedRun[];
};

export type Page<T> = { items: T[]; cursor: Cursor | null; partial: boolean };

export type CountResult = { committed: number; queued: number; partial: boolean };

// Explicit opt-in for overlay-only reads while the remote store is down
// (section G/I): without it a degraded read throws BackendUnavailableError;
// with it the result is served from the local outbox overlay and flagged
// partial (Page.partial / CountResult.partial).
export type ReadOpts = { allowPartial?: boolean };

export const OPS_NAMESPACES = ['hitl', 'runs', 'artifacts', 'outbox'] as const;
export type OpsNamespace = (typeof OPS_NAMESPACES)[number];

// ---------- HITL envelopes ----------

export const HITL_STATUS_VALUES = [
  'awaiting',
  'approved',
  'changes-requested',
  'rejected',
  'deferred',
  'expired',
  'cancelled',
] as const;
export type HitlStatus = (typeof HITL_STATUS_VALUES)[number];
export type HitlDecisionStatus = Exclude<HitlStatus, 'awaiting'>;

// #319: the caller's submission. Identity (the group a revision joins) is
// (functionName, action, target) — the content is NOT in the key, so a revised
// packet lands as version N+1 of the SAME group instead of a stranded new row.
// `intent` + `expectedHead` are the optimistic-concurrency pair: the store
// re-reads the head under the per-group lock and refuses a stale submission
// SYNCHRONOUSLY (HITL writes require a live store — owner decision 6).
export type HitlSubmitIntent = 'auto' | 'create' | 'revise';

export type HitlRequestInput = {
  functionName: string;
  title: string;
  action: string;
  target: string;
  // Verified server-side against sha256(body): the caller's hex is checked,
  // never trusted. For an offloaded body it is the object's digest.
  contentHash: string;
  body: string;
  // Absent ⇒ the expiry policy's default TTL (execution) / no expiry
  // (editorial). A supplied value is clamped to the policy bounds.
  expiresAt?: number | null;
  summary?: string | null;
  warnings?: unknown;
  sideEffects?: unknown;
  choices?: unknown;
  originRunId?: string | null;
  originTaskId?: string | null;
  requestingAgent?: string | null;
  intent?: HitlSubmitIntent;
  // REQUIRED (D1): there is no "adopt whatever head you find" mode, because
  // that mode cannot distinguish an open head from one that was approved while
  // the caller composed its packet. `null` ⇒ "this key has no history at all"
  // (a first creation; also satisfied idempotently when the head turns out to
  // be an OPEN, byte-identical packet — an at-least-once retry). An object ⇒
  // the exact head the caller read, INCLUDING its `sealed` flag (D1: the
  // HIGHEST generation's head, sealed or not). Every generation crossing is
  // therefore an explicit, observed decision.
  expectedHead: HitlExpectedHead | null;
};

export type HitlSupersedesRef = { requestId: string; generation: number; version: number };

export type HitlRequestEnvelope = {
  // The stable logical id of the whole group: sha256(workspaceId, requestKey).
  id: string;
  workspaceId: string;
  requestKey: string;
  generation: number;
  version: number;
  functionName: string;
  title: string;
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  contentHash: string;
  // null when the body lives in the object store (payloadRef).
  body: string | null;
  payloadRef: HitlPayloadRef | null;
  expiresAt: number | null;
  summary: string | null;
  warnings: unknown;
  sideEffects: unknown;
  choices: unknown;
  originRunId: string | null;
  originTaskId: string | null;
  requestingAgent: string | null;
  supersedes: HitlSupersedesRef | null;
  // The SWEEP-INDEPENDENT effective status (see hitl-machine deriveRequestState).
  status: HitlStatus;
  // The decision-graph status ignoring expiry.
  nodeStatus: HitlStatus;
  terminalStatus: HitlDecisionStatus | null;
  deferred: boolean;
  sealed: boolean;
  superseded: boolean;
  authoritative: boolean;
  createdAt: number;
  seq: number | null;
  // Always false: HITL never spools (owner decision 6 / D7).
  queued: boolean;
};

export type HitlDecisionInput = {
  requestId: string;
  // Required (#319): a decision names an exact request VERSION, never "the
  // latest" — the store and the DB trigger both refuse a non-head target.
  generation: number;
  requestVersion: number;
  status: HitlDecisionStatus;
  decidedBy: string;
  note: string | null;
  feedback?: string | null;
};

export type HitlDecisionEnvelope = {
  id: string;
  workspaceId: string;
  requestId: string;
  generation: number;
  requestVersion: number;
  status: HitlDecisionStatus;
  decidedBy: string;
  note: string | null;
  feedback: string | null;
  terminal: boolean;
  decidedAt: number;
  createdAt: number;
  seq: number | null;
};

// A cross-group edit (D3): the destination submission durably records that it
// supersedes the source group's head, which makes that head non-authoritative
// and undecidable without ever UPDATE-ing it.
export type HitlReplaceInput = {
  sourceRequestId: string;
  sourceExpectedHead: HitlExpectedHead;
  request: HitlRequestInput;
};

export type HitlVersionRecord = {
  requestId: string;
  requestKey: string;
  generation: number;
  version: number;
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  expiresAt: number | null;
  createdAt: number;
  seq: number | null;
  supersedes: HitlSupersedesRef | null;
};

export type HitlGenerationSummary = {
  generation: number;
  versions: number;
  headVersion: number;
  status: HitlStatus;
  sealed: boolean;
  createdAt: number;
};

export type HitlRequestFilter = {
  functionName?: string;
  // Absent ⇒ the ACTIONABLE set (effective status awaiting | deferred).
  // Supplied ⇒ exactly that effective status.
  status?: HitlStatus;
  limit?: number;
};

// D5: HITL commits carry the allocated identity. HITL never queues, so the
// spoolable-store `WriteOutcome` (committed | queued) is not expressive enough
// — `id` stays the stable request id so the generic shape still holds.
export type HitlWriteOutcome = {
  outcome: 'committed';
  id: string;
  requestId: string;
  generation: number;
  version: number;
  // true when the identical packet was already the open head (no new version).
  idempotent: boolean;
  // Non-fatal policy notes (e.g. an expiry clamped to the configured bounds).
  warnings: string[];
};

export type HitlDecisionOutcome = {
  outcome: 'committed';
  id: string;
  requestId: string;
  generation: number;
  requestVersion: number;
  status: HitlDecisionStatus;
};

// One expiry-sweep candidate: a head that is EFFECTIVELY expired (past its
// deadline with no terminal decision) but has no durable `expired` decision yet.
export type HitlExpiryCandidate = {
  requestId: string;
  requestKey: string;
  generation: number;
  version: number;
  expiresAt: number;
};

// HITL is fail-closed end to end (owner decision 6): every write requires the
// live store (the whole namespace is refused at the outbox boundary) and every
// read either answers from the live store or throws. `ReadOpts` stays on the
// read signatures so the shared read shape holds, but HITL IGNORES
// `allowPartial` — there is no queued HITL overlay to serve, and an approval
// system that reports "nothing awaiting" from a partial view is worse than one
// that admits it cannot answer.
export interface HitlStore {
  createRequest(input: HitlRequestInput): Promise<HitlWriteOutcome>;
  replaces(input: HitlReplaceInput): Promise<HitlWriteOutcome>;
  appendDecision(input: HitlDecisionInput): Promise<HitlDecisionOutcome>;
  getRequest(id: string, opts?: ReadOpts): Promise<HitlRequestEnvelope | null>;
  listRequests(filter: HitlRequestFilter, cursor?: Cursor, opts?: ReadOpts): Promise<Page<HitlRequestEnvelope>>;
  count(filter?: HitlRequestFilter, opts?: ReadOpts): Promise<CountResult>;
  listVersions(id: string): Promise<HitlVersionRecord[]>;
  listGenerations(id: string): Promise<HitlGenerationSummary[]>;
  listDecisions(id: string): Promise<HitlDecisionEnvelope[]>;
  // Sweep surface (hitl-sweep.ts). Both are bounded and idempotent.
  listExpiryCandidates(now: number, limit: number): Promise<HitlExpiryCandidate[]>;
  insertSystemExpiry(candidate: HitlExpiryCandidate, now: number): Promise<'expired' | 'conflict'>;
}

// ---------- runs ----------

// #323: the run-event write input is the sealed model (run-events.ts). `kind` is
// the closed typed kind; the dedupe key is DERIVED (fixed for singletons, the
// caller correlation id for repeatable kinds) — never caller-supplied free text.
// agent/skill/trigger/parentRunId/originTaskId are stable semantic fields (in the
// payload hash). source/pid/startedAt/endedAt are store-assigned observations
// (stamped by the write path; NEVER in the id/hash). `source` is NOT a caller
// field: the STORE derives the trust level from the write path (a `report`
// event is 'agent'; every other CLI-written event is 'cli'). 'host-attested'
// is produced by NO #323 path (a DB CHECK rejects it) — it is #322's attested
// channel. This closes the forge-trust hole (a runtime caller cannot mint a
// trusted lifecycle or a host-attested success).
export type RunEventInput = {
  runId: string;
  kind: RunEventKind;
  data: unknown;
  correlationId?: string | null;
  agent?: string | null;
  skill?: string | null;
  trigger?: string | null;
  parentRunId?: string | null;
  originTaskId?: string | null;
  pid?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
};

export type RunEventEnvelope = {
  id: string;
  workspaceId: string;
  runId: string;
  kind: RunEventKind;
  dedupeKey: string;
  data: unknown;
  agent: string | null;
  skill: string | null;
  trigger: string | null;
  parentRunId: string | null;
  originTaskId: string | null;
  correlationId: string | null;
  // resolved observations (null when unstamped / a legacy v1 row)
  source: RunEventSource;
  pid: string | null;
  startedAt: number | null;
  endedAt: number | null;
  sanitizedReport: string | null;
  createdAt: number;
  seq: number | null;
  queued: boolean;
};

export type RunSummary = {
  runId: string;
  workspaceId: string;
  // firstSeq/lastSeq are 0 for a run that exists only as queued events.
  firstSeq: number;
  lastSeq: number;
  events: number;
  startedAt: number;
  lastEventAt: number;
  // true when the run has NO committed events yet (overlay-only run).
  queued: boolean;
};

export type RunFilter = {
  runId?: string;
  limit?: number;
};

export interface RunStore {
  appendEvent(input: RunEventInput): Promise<WriteOutcome>;
  getRun(runId: string, opts?: ReadOpts): Promise<{ runId: string; events: RunEventEnvelope[] } | null>;
  listRuns(filter: RunFilter, cursor?: Cursor, opts?: ReadOpts): Promise<Page<RunSummary>>;
  count(filter?: RunFilter, opts?: ReadOpts): Promise<CountResult>;
}

// ---------- artifacts ----------

export type ArtifactMeta = {
  filename: string;
  contentType: string;
  runId: string | null;
};

export type ArtifactRecord = {
  digest: string;
  size: number;
  meta: ArtifactMeta;
  workspaceId: string;
  createdAt: number;
  seq: number | null;
  queued: boolean;
  // The store's version handle for the immutable bytes (S3 x-amz-version-id);
  // null for a legacy/queued/local blob without a captured version (#323).
  objectVersionId: string | null;
};

// ---------- artifact declarations (#323 identity split) ----------

// A run DECLARES it produced or used an artifact. Identity (id) covers role, so
// a produced and a used declaration of the same reference by the same run/agent
// are two distinct rows (Rev4-R3-2). Provenance/run metadata lives HERE, never
// on the content blob — two runs declaring identical bytes yield one blob + two
// declarations.
export type ArtifactRole = 'produced' | 'used';
export type ArtifactDeclarationKind = 'internal' | 'external';

export type ArtifactDeclaration = {
  id: string;
  workspaceId: string;
  runId: string;
  declaringAgent: string;
  role: ArtifactRole;
  kind: ArtifactDeclarationKind;
  // internal only: the content blob's digest (ref).
  digest: string | null;
  // external only: the provider triple (no digest — declaration-only row).
  provider: string | null;
  externalId: string | null;
  externalUrl: string | null;
  artifactType: string | null;
  mediaType: string | null;
  provenance: unknown;
  // external references stay false until a correlated host-attested tool result
  // exists (#322): never caller-supplied, never runtime-mutated.
  verified: boolean;
  versionState: string | null;
  // internally-produced sanitized projection of any declaration prose (Rev4-R3-3).
  sanitizedText: string | null;
  createdAt: number;
  seq: number | null;
  queued: boolean;
};

// Optional declaration context for an INTERNAL put: when supplied (a run + agent
// are known) the store writes an internal declaration alongside the blob. Absent
// ⇒ a bare content blob (the #318 behavior, no declaration).
export type InternalDeclarationInput = {
  runId: string;
  declaringAgent: string;
  role?: ArtifactRole;
  artifactType?: string | null;
  mediaType?: string | null;
  provenance?: unknown;
  // free-text description sanitized into sanitized_text.
  text?: string | null;
};

// An EXTERNAL artifact: a declaration-only row (no bytes, no digest).
export type ExternalArtifactInput = {
  runId: string;
  declaringAgent: string;
  role?: ArtifactRole;
  provider: string;
  externalId: string;
  externalUrl?: string | null;
  artifactType?: string | null;
  mediaType?: string | null;
  provenance?: unknown;
  text?: string | null;
};

export type ArtifactPutResult = WriteOutcome & {
  digest: string;
  objectVersionId: string | null;
  // The internal declaration written alongside the blob, when a declaration
  // context was supplied; null for a bare-blob put.
  declarationId: string | null;
  // The two sub-writes exposed independently (finding: a multi-write result must
  // not hide a queued declaration behind a committed blob). The top-level
  // `outcome` is the AGGREGATE — 'queued' if EITHER sub-write queued.
  blobOutcome: WriteOutcomeKind;
  // null when no declaration was written (bare-blob put).
  declarationOutcome: WriteOutcomeKind | null;
};

export type DeclarationPutResult = WriteOutcome;

// Create-only content-addressed store + the #323 declaration surface. No delete
// anywhere in the interface.
export interface ArtifactStore {
  putArtifact(meta: ArtifactMeta, bytes: Uint8Array, decl?: InternalDeclarationInput): Promise<ArtifactPutResult>;
  getArtifact(digest: string, opts?: ReadOpts): Promise<{ record: ArtifactRecord; bytes: Buffer } | null>;
  head(digest: string, opts?: ReadOpts): Promise<ArtifactRecord | null>;
  // #323 declaration surface (parity local + postgres).
  putExternal(meta: ExternalArtifactInput): Promise<DeclarationPutResult>;
  getByRun(runId: string, opts?: ReadOpts): Promise<ArtifactDeclaration[]>;
  getDeclaration(id: string, opts?: ReadOpts): Promise<ArtifactDeclaration | null>;
}

// ---------- action / wake adapters (declarations only; #322 / #324) ----------

export type ActionCheckRequest = {
  workspaceId: string;
  action: string;
  target: string;
  payloadHash: string;
  at: number;
};

export type ActionDenyReason =
  | 'no-approval'
  | 'expired'
  | 'hash-mismatch'
  | 'target-mismatch'
  | 'action-mismatch'
  | 'store-unavailable';

export type ActionCheckResult =
  | { allowed: true; requestId: string; decisionId: string }
  | { allowed: false; reason: ActionDenyReason };

export type ActionResultInput = {
  workspaceId: string;
  requestId: string;
  action: string;
  target: string;
  payloadHash: string;
  outcome: 'executed' | 'failed';
  detail: string | null;
  at: number;
};

export interface ActionAdapter {
  checkApproval(req: ActionCheckRequest): Promise<ActionCheckResult>;
  recordResult(input: ActionResultInput): Promise<WriteOutcome>;
}

export type WakeDeliveryRequest = {
  workspaceId: string;
  requestId: string;
  decisionId: string;
  task: {
    tool: string;
    functionName: string;
    sessionRef: string | null;
  };
};

export type WakeDeliveryResult = { delivered: boolean; detail: string | null };

export interface WakeAdapter {
  deliver(req: WakeDeliveryRequest): Promise<WakeDeliveryResult>;
}

// ---------- backend bundle ----------

export type OpsBackendKind = 'local' | 'postgres-s3';

export interface OpsBackend {
  readonly backend: OpsBackendKind;
  readonly workspaceId: string;
  readonly hitl: HitlStore;
  readonly runs: RunStore;
  readonly artifacts: ArtifactStore;
}
