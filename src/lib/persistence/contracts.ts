import { createHash } from 'node:crypto';

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

// Composite cursor: `watermark` is the committed-seq high-water mark captured
// at page 1 — later pages only return committed rows at/below it, so an
// overlay record acked mid-pagination cannot reappear as committed. `overlay`
// tracks position in the queued-overlay domain (per producer), used by the
// postgres-s3 backend's outbox overlay; always null on a purely local listing.
export type Cursor = {
  watermark: number;
  committed: number;
  overlay: OverlayPosition | null;
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

export type HitlRequestInput = {
  functionName: string;
  title: string;
  // Exact-approval binding: the (action, target, contentHash) triple is the
  // request's identity — re-creating it with different title/body/expiry is a
  // ConflictError, not a new request.
  action: string;
  target: string;
  contentHash: string;
  body: string;
  expiresAt: number | null;
};

export type HitlRequestEnvelope = HitlRequestInput & {
  id: string;
  workspaceId: string;
  status: HitlStatus;
  createdAt: number;
  // Store-assigned once committed; null while the record is still queued in
  // the local outbox overlay.
  seq: number | null;
  // true when the record is served from the queued outbox overlay (not yet
  // committed at the store); committed reads always report false.
  queued: boolean;
};

export type HitlDecisionInput = {
  requestId: string;
  status: HitlDecisionStatus;
  decidedBy: string;
  note: string | null;
};

export type HitlDecisionEnvelope = HitlDecisionInput & {
  id: string;
  workspaceId: string;
  createdAt: number;
  // Decisions are never queued (owner decision 8) — a committed seq is always
  // present; when the store is down the write throws BackendUnavailableError.
  seq: number;
};

export type HitlRequestFilter = {
  functionName?: string;
  status?: HitlStatus;
  limit?: number;
};

export interface HitlStore {
  createRequest(input: HitlRequestInput): Promise<WriteOutcome>;
  getRequest(id: string, opts?: ReadOpts): Promise<HitlRequestEnvelope | null>;
  listRequests(filter: HitlRequestFilter, cursor?: Cursor, opts?: ReadOpts): Promise<Page<HitlRequestEnvelope>>;
  appendDecision(input: HitlDecisionInput): Promise<WriteOutcome>;
  count(filter?: HitlRequestFilter, opts?: ReadOpts): Promise<CountResult>;
}

// ---------- runs ----------

export type RunEventInput = {
  runId: string;
  // Caller-owned identity within the run: retrying the same event reuses the
  // same key (idempotent-ok); the same key with different data is a Conflict.
  dedupeKey: string;
  type: string;
  data: unknown;
};

export type RunEventEnvelope = RunEventInput & {
  id: string;
  workspaceId: string;
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
};

export type ArtifactPutResult = WriteOutcome & { digest: string };

// Create-only content-addressed store. No delete anywhere in the interface.
export interface ArtifactStore {
  putArtifact(meta: ArtifactMeta, bytes: Uint8Array): Promise<ArtifactPutResult>;
  getArtifact(digest: string, opts?: ReadOpts): Promise<{ record: ArtifactRecord; bytes: Buffer } | null>;
  head(digest: string, opts?: ReadOpts): Promise<ArtifactRecord | null>;
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
