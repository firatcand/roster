import { ConflictError, InvalidRecordError, canonicalJson, computeRecordId, sha256Hex, snapshotPayload } from './contracts.ts';
import type { RunEventEnvelope } from './contracts.ts';
import { sanitizeForIndex } from './sanitize-index.ts';

// The typed run-event model (#323 section B). A PURE module: it defines the
// closed kind set, the source trust taxonomy, the per-kind dedupe/authority
// rules, and the deterministic id + canonical payload hash. It never touches a
// store — stage 2's CLI verbs and the PgRunStore/LocalRunStore consume it, and
// the outbox delivery-ledger dedups on the id + payloadHash it produces.
//
// SEALED PROVENANCE. The store-assigned observations — `source` (the trust
// level, stamped by the write PATH, not the caller), `host`, `pid`,
// `started_at`/`ended_at`, `seq`, `object_version_id` — are NOT fields of a
// RunEventDraft and never enter the canonical payload. So a caller cannot forge
// trust through `--data`, and a retry with a new pid/timestamp has the SAME id +
// hash (idempotent replay, no false ConflictError). Duration is derived at read
// (ended_at - started_at). See Rev3-R2-2 / Rev4-R3-4.

// ---------- closed kind set ----------

export const RUN_EVENT_KINDS = [
  'run-start',
  'run-end',
  'tool-call',
  'tool-result',
  'error',
  'retry',
  'resumed',
  'approval-ref',
  'report',
  'artifact-declared',
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

const RUN_EVENT_KIND_SET: ReadonlySet<string> = new Set(RUN_EVENT_KINDS);

// ---------- source trust taxonomy (Rev3-R2-1) ----------

// 'host-attested' — only the #322 hook channel can stamp this (DEFERRED to #322;
//   #323 never produces it). The single source trusted for a "successful
//   external action".
// 'cli' — a lifecycle event written by the `roster run` CLI in the trusted
//   orchestrator/operator process (the normal case). Trusted for a lifecycle
//   FACT (start/end/exit), NOT for external success.
// 'agent' — subagent-authored report prose. Always unverified narrative; never
//   parsed for success.
// 'unverified' — legacy/unknown. The fail-closed default a missing source reads
//   as (never 'host-attested').
export const RUN_EVENT_SOURCES = ['host-attested', 'cli', 'agent', 'unverified'] as const;
export type RunEventSource = (typeof RUN_EVENT_SOURCES)[number];

// The composer promotes a lifecycle fact from a trusted source; a "successful
// external action" ONLY from a host attestation.
export const LIFECYCLE_TRUSTED_SOURCES: readonly RunEventSource[] = ['cli', 'host-attested'];
export const EXTERNAL_SUCCESS_TRUSTED_SOURCES: readonly RunEventSource[] = ['host-attested'];

export function promotesLifecycle(source: RunEventSource): boolean {
  return LIFECYCLE_TRUSTED_SOURCES.includes(source);
}

export function promotesExternalSuccess(source: RunEventSource): boolean {
  return EXTERNAL_SUCCESS_TRUSTED_SOURCES.includes(source);
}

// ---------- per-kind rules ----------

export type RunEventKindRule = {
  // A singleton event occurs at most once per run and carries a FIXED dedupe key;
  // a non-singleton event is repeatable and REQUIRES a caller correlation id (no
  // deterministic dedupe key otherwise).
  singleton: boolean;
  fixedKey: string | null;
  // May the generic `roster run event` verb emit this kind? Lifecycle kinds
  // (run-start/run-end) and tool-* come only from the dedicated host verbs / the
  // #322 hook; report and artifact-declared have their own dedicated verbs.
  // Enforcement lives in stage 2's CLI — this flag is the authority table.
  viaGenericEvent: boolean;
};

export const RUN_EVENT_KIND_RULES: Readonly<Record<RunEventKind, RunEventKindRule>> = {
  'run-start': { singleton: true, fixedKey: 'start', viaGenericEvent: false },
  'run-end': { singleton: true, fixedKey: 'end', viaGenericEvent: false },
  report: { singleton: true, fixedKey: 'report', viaGenericEvent: false },
  'tool-call': { singleton: false, fixedKey: null, viaGenericEvent: false },
  'tool-result': { singleton: false, fixedKey: null, viaGenericEvent: false },
  error: { singleton: false, fixedKey: null, viaGenericEvent: true },
  retry: { singleton: false, fixedKey: null, viaGenericEvent: true },
  resumed: { singleton: false, fixedKey: null, viaGenericEvent: true },
  'approval-ref': { singleton: false, fixedKey: null, viaGenericEvent: true },
  'artifact-declared': { singleton: false, fixedKey: null, viaGenericEvent: false },
};

export function isRunEventKind(value: unknown): value is RunEventKind {
  return typeof value === 'string' && RUN_EVENT_KIND_SET.has(value);
}

const RUN_EVENT_SOURCE_SET: ReadonlySet<string> = new Set(RUN_EVENT_SOURCES);

export function isRunEventSource(value: unknown): value is RunEventSource {
  return typeof value === 'string' && RUN_EVENT_SOURCE_SET.has(value);
}

// The RunStore write path is the trusted orchestrator/operator process, so a run
// event minted through it defaults to the 'cli' trust level (Rev3-R2-1). The
// agent-report path overrides with 'agent'; only the #322 hook may ever stamp
// 'host-attested'.
export const DEFAULT_RUN_EVENT_SOURCE: RunEventSource = 'cli';

// The generic `roster run event` verb may emit ONLY the kinds whose rule marks
// viaGenericEvent — lifecycle (run-start/run-end), tool-*, report, and
// artifact-declared come from dedicated verbs / the #322 hook, never the generic
// path. Stage 2's CLI enforces this by calling here.
export function assertGenericEventKind(kind: RunEventKind): void {
  if (!RUN_EVENT_KIND_RULES[kind].viaGenericEvent) {
    const allowed = RUN_EVENT_KINDS.filter((k) => RUN_EVENT_KIND_RULES[k].viaGenericEvent);
    throw new InvalidRecordError(
      `the '${kind}' event is not emittable via the generic 'run event' verb (allowed: ${allowed.join(' | ')}) — it comes from a dedicated verb or the #322 hook`,
    );
  }
}

// The correlation_id COLUMN value: the caller correlation id for repeatable
// kinds (which equals the dedupe key), NULL for singletons (which have a fixed
// dedupe key, not a correlation id). Defensive against a v1/unknown kind (a
// legacy row whose `type` is not in the current closed set): an absent rule
// exposes the stored dedupe key rather than throwing (finding: v1 records not
// upgraded — a v1 read must not TypeError in correlationColumn).
export function correlationColumn(kind: RunEventKind, dedupeKey: string): string | null {
  const rule = RUN_EVENT_KIND_RULES[kind];
  if (rule === undefined) return dedupeKey;
  return rule.singleton ? null : dedupeKey;
}

// v1→v2 normalization for a STORED run-event payload (finding: shipped v1 local
// and PG records are not upgraded). A #318 (v1) row's payload used `type` (not
// `kind`) and carried no agent/skill/trigger/parent/origin fields; reading it
// with the v2 reader left `kind` undefined and TypeError'd in correlationColumn.
// This maps `type`→`kind` and fills the v2-only fields with null so a v1 row
// reads cleanly. A v2 payload already has `kind` and passes through unchanged.
export function normalizeStoredEventPayload(raw: unknown): RunEventPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  const kind = (p.kind ?? p.type) as RunEventKind;
  return {
    runId: p.runId as string,
    kind,
    dedupeKey: (p.dedupeKey as string | undefined) ?? '',
    data: 'data' in p ? p.data : null,
    agent: (p.agent as string | null | undefined) ?? null,
    skill: (p.skill as string | null | undefined) ?? null,
    trigger: (p.trigger as string | null | undefined) ?? null,
    parentRunId: (p.parentRunId as string | null | undefined) ?? null,
    originTaskId: (p.originTaskId as string | null | undefined) ?? null,
  };
}

function requireKind(value: unknown): RunEventKind {
  if (!isRunEventKind(value)) {
    throw new InvalidRecordError(
      `'${String(value)}' is not a run-event kind (expected ${RUN_EVENT_KINDS.join(' | ')})`,
    );
  }
  return value;
}

// ---------- v1→v2 identity reconciliation (finding: v1 replay idempotency) ----------

// The v2-canonical record id for a (normalized) run event: computeRecordId over
// {kind, runId, dedupeKey}, exactly as sealRunEvent derives it. A shipped v1
// (#318) record's STORED id used the historical scheme
// computeRecordId(ws,'runs',{kind:'run-event',runId,dedupeKey}) — a LITERAL
// 'run-event' constant, NOT the event kind — so a v1 run-start's stored id
// differs from a v2 retry's id and store-level dedup misses. Recomputing the
// canonical id at READ time from the normalized {kind,runId,dedupeKey} maps a v1
// record and its v2 retry onto the SAME id (Rev-note: "canonicalize v1 ids to the
// v2 scheme so dedup still matches"). For a v2-native record this equals the
// stored id, so all-v2 data is untouched.
export function canonicalRunEventId(
  workspaceId: string,
  p: { kind: RunEventKind; runId: string; dedupeKey: string },
): string {
  return computeRecordId(workspaceId, 'runs', { kind: p.kind, runId: p.runId, dedupeKey: p.dedupeKey });
}

const SOURCE_TRUST_RANK: Readonly<Record<RunEventSource, number>> = {
  'host-attested': 3,
  cli: 2,
  agent: 1,
  unverified: 0,
};

function runEventOrder(a: RunEventEnvelope, b: RunEventEnvelope): number {
  const sa = a.seq ?? Number.MAX_SAFE_INTEGER;
  const sb = b.seq ?? Number.MAX_SAFE_INTEGER;
  return sa === sb ? a.createdAt - b.createdAt : sa - sb;
}

// Does event `a` supersede event `b` when the two share a canonical id (i.e. a
// v1 record and its v2 retry)? A committed record beats a queued one; a higher
// trust level beats a lower one (the trusted v2 'cli' retry supersedes the
// untrusted v1 'unverified' row); a tie keeps the later-sequenced record.
function supersedesRunEvent(a: RunEventEnvelope, b: RunEventEnvelope): boolean {
  if (a.queued !== b.queued) return b.queued;
  const ra = SOURCE_TRUST_RANK[a.source] ?? 0;
  const rb = SOURCE_TRUST_RANK[b.source] ?? 0;
  if (ra !== rb) return ra > rb;
  return runEventOrder(a, b) >= 0;
}

// The stable-payload hash of a run event — sha256 over EXACTLY the semantic
// fields sealRunEvent hashes (runId, kind, dedupeKey, data, agent, skill,
// trigger, parentRunId, originTaskId). Store observations (source/pid/timestamps/
// seq/versionId) are excluded. Two physical records sharing a canonical id are a
// BENIGN retry iff this hash matches; a differing hash is a genuine conflict
// (Rev4 R3-4). Accepts an envelope OR a normalized stored payload.
export function runEventStableHash(e: {
  runId: string;
  kind: RunEventKind;
  dedupeKey: string;
  data: unknown;
  agent: string | null;
  skill: string | null;
  trigger: string | null;
  parentRunId: string | null;
  originTaskId: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      runId: e.runId,
      kind: e.kind,
      dedupeKey: e.dedupeKey,
      data: e.data,
      agent: e.agent,
      skill: e.skill,
      trigger: e.trigger,
      parentRunId: e.parentRunId,
      originTaskId: e.originTaskId,
    }),
  );
}

// The ConflictError raised when two physical records share a canonical id but
// carry DIFFERENT stable payloads (Rev4 R3-4: changed stable data across the v1→
// v2 upgrade boundary is a genuine conflict, never a silent collapse).
function canonicalConflict(cid: string): ConflictError {
  return new ConflictError(
    cid,
    'a run event was replayed under the same canonical identity with a DIFFERENT stable payload — a genuine conflict, not a benign retry',
  );
}

// Guard for a canonical-id-grouping summary path (the count-only paths that do
// not build full deduped envelopes). Tracks the first stable hash seen per
// canonical id and RAISES the moment a second physical record shares the id with
// a different hash. `seen.size` is the correct canonical event count.
export function trackCanonicalStableHash(seen: Map<string, string>, cid: string, stableHash: string): void {
  const prior = seen.get(cid);
  if (prior === undefined) {
    seen.set(cid, stableHash);
    return;
  }
  if (prior !== stableHash) throw canonicalConflict(cid);
}

// Collapse a v1 record and its post-upgrade v2 retry — which share a canonical id
// but carry distinct physical ids — into ONE event (finding: v1 identity changed,
// breaking replay idempotency). When two records share a canonical id, their
// STABLE payload hashes are compared: an identical hash is a true retry (keep the
// trusted/committed one); a DIFFERENT hash is a ConflictError (Rev4 R3-4 — a
// v1 {phase:old} + a v2 replay {phase:new} of the same logical run-start must NOT
// silently return one). Records with distinct canonical ids pass through
// untouched (all-v2 data is unaffected). Every store read (local, PG committed+
// overlay, degraded overlay) funnels through this.
export function dedupRunEvents(workspaceId: string, events: readonly RunEventEnvelope[]): RunEventEnvelope[] {
  const byCanonical = new Map<string, RunEventEnvelope>();
  const hashByCanonical = new Map<string, string>();
  for (const e of events) {
    const cid = canonicalRunEventId(workspaceId, e);
    const h = runEventStableHash(e);
    const priorHash = hashByCanonical.get(cid);
    if (priorHash === undefined) hashByCanonical.set(cid, h);
    else if (priorHash !== h) throw canonicalConflict(cid);
    const prior = byCanonical.get(cid);
    if (prior === undefined || supersedesRunEvent(e, prior)) byCanonical.set(cid, e);
  }
  return [...byCanonical.values()].sort(runEventOrder);
}

// Deterministic dedupe key per kind: run-start -> 'start', run-end -> 'end',
// report -> 'report'; every repeatable kind (tool-*, error, retry, resumed,
// approval-ref, artifact-declared) requires a caller correlation id.
export function dedupeKeyFor(kind: RunEventKind, correlationId?: string | null): string {
  const rule = RUN_EVENT_KIND_RULES[kind];
  if (rule.singleton) {
    if (correlationId !== undefined && correlationId !== null && correlationId.length > 0) {
      throw new InvalidRecordError(
        `the '${kind}' event is a singleton per run (dedupe key '${rule.fixedKey}') and does not take a correlation id`,
      );
    }
    return rule.fixedKey!;
  }
  if (correlationId === undefined || correlationId === null || correlationId.length === 0) {
    throw new InvalidRecordError(
      `the '${kind}' event requires a correlation id — it has no deterministic dedupe key otherwise`,
    );
  }
  return correlationId;
}

// ---------- identifier validation (Rev2-R2-6) ----------

// run_id and agent are exposed in the safe projections (run_index / artifact_index),
// so they are strictly validated at WRITE time — a value failing the charset/length
// rule is REJECTED here, so a new row never carries caller free text into a view.
// (Legacy v1 rows, written before this rule, are normalized to a sentinel by the
// views instead.)
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_FIELD_LEN = 512;

function requireSafeIdentifier(field: string, value: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_RE.test(value)) {
    throw new InvalidRecordError(
      `${field} must match ${SAFE_IDENTIFIER_RE.source} (safe charset, 1..128 chars) — got '${String(value)}'`,
    );
  }
  return value;
}

// Non-projected identifier fields (skill/trigger/parent_run_id/origin_task_id):
// they enter indexes + the payload hash but never a safe view, so only a length
// cap is enforced (trigger may legitimately be a cron expression, etc.).
function optionalBounded(field: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidRecordError(`${field} must be a string or null`);
  if (value.length > MAX_FIELD_LEN) {
    throw new InvalidRecordError(`${field} exceeds ${MAX_FIELD_LEN} characters`);
  }
  return value;
}

// ---------- seal ----------

export type RunEventDraft = {
  runId: string;
  kind: RunEventKind;
  // Use null for an event without data (never undefined).
  data: unknown;
  // Required for repeatable kinds; rejected for singletons.
  correlationId?: string | null;
  // Stable caller-semantic metadata (all in the payload hash).
  agent?: string | null;
  skill?: string | null;
  trigger?: string | null;
  parentRunId?: string | null;
  originTaskId?: string | null;
};

// The stable payload persisted as the run-event jsonb (and hashed). Store
// observations (source/pid/timestamps/sanitized_report) live in dedicated
// columns, never here.
export type RunEventPayload = {
  runId: string;
  kind: RunEventKind;
  dedupeKey: string;
  data: unknown;
  agent: string | null;
  skill: string | null;
  trigger: string | null;
  parentRunId: string | null;
  originTaskId: string | null;
};

export type SealedRunEvent = {
  // Deterministic record id — the IDENTITY (workspace, runs namespace, {kind,
  // runId, dedupeKey}). Two events naming the same run-lifecycle point share it;
  // a same-id write with different stable content is a ConflictError.
  id: string;
  runId: string;
  kind: RunEventKind;
  dedupeKey: string;
  agent: string | null;
  skill: string | null;
  trigger: string | null;
  parentRunId: string | null;
  originTaskId: string | null;
  // The plain (toJSON-resolved) stable payload and its EXACT canonical bytes —
  // both from one snapshot, so the stored row can never disagree with payloadHash.
  payload: RunEventPayload;
  canonical: string;
  // sha256 of `canonical` over ALL stable semantic fields (Rev4-R3-4): run_id,
  // kind, dedupe key, data, agent, skill, trigger, parent_run_id, origin_task_id.
  // EXCLUDES store observations (source, host, pid, started_at/ended_at, seq,
  // object_version_id) — a retry with new observations is idempotent.
  payloadHash: string;
};

type NormalizedRunEventDraft = {
  runId: string;
  kind: RunEventKind;
  dedupeKey: string;
  agent: string | null;
  skill: string | null;
  trigger: string | null;
  parentRunId: string | null;
  originTaskId: string | null;
};

function normalizeRunEventDraft(draft: RunEventDraft): NormalizedRunEventDraft {
  const runId = requireSafeIdentifier('runId', draft.runId);
  const kind = requireKind(draft.kind);
  if (draft.data === undefined) {
    throw new InvalidRecordError('data is required (use null for an event without data)');
  }
  return {
    runId,
    kind,
    dedupeKey: dedupeKeyFor(kind, draft.correlationId),
    agent: draft.agent === undefined || draft.agent === null ? null : requireSafeIdentifier('agent', draft.agent),
    skill: optionalBounded('skill', draft.skill),
    trigger: optionalBounded('trigger', draft.trigger),
    parentRunId: optionalBounded('parentRunId', draft.parentRunId),
    originTaskId: optionalBounded('originTaskId', draft.originTaskId),
  };
}

// Validate a COMPLETE run-event draft with no store, no workspace id, and no
// side effect — the same rules sealRunEvent enforces (kind, dedupe/correlation
// pairing, identifier charset + length caps, data presence). A command that
// mutates more than one store per verb calls this FIRST (round-7 finding 4), so
// a rejected event can never leave a half-written trace — e.g. a scheduled
// `run start` must not stamp its `<fireId>.run-id` sidecar for an event that
// then fails validation, because pending-sync would later append error/run-end
// against a run that has no run-start.
export function assertRunEventDraft(draft: RunEventDraft): void {
  normalizeRunEventDraft(draft);
}

export function sealRunEvent(workspaceId: string, draft: RunEventDraft): SealedRunEvent {
  const { runId, kind, dedupeKey, agent, skill, trigger, parentRunId, originTaskId } = normalizeRunEventDraft(draft);

  const id = computeRecordId(workspaceId, 'runs', { kind, runId, dedupeKey });
  const snap = snapshotPayload({
    runId,
    kind,
    dedupeKey,
    data: draft.data,
    agent,
    skill,
    trigger,
    parentRunId,
    originTaskId,
  });
  return {
    id,
    runId,
    kind,
    dedupeKey,
    agent,
    skill,
    trigger,
    parentRunId,
    originTaskId,
    payload: snap.value as RunEventPayload,
    canonical: snap.canonical,
    payloadHash: sha256Hex(snap.canonical),
  };
}

// ---------- store-assigned observations (Rev3-R2-2) ----------

// The volatile facts a store records ALONGSIDE the sealed event, in dedicated
// columns, NEVER in the id / payload hash: the trust level, the writing pid, the
// lifecycle timestamps, and the internally-produced sanitized projection of a
// report's prose. A retry with a new pid/timestamp keeps the sealed id + hash,
// so it dedups idempotently while these observations stay at their first-write
// value.
export type RunEventObservations = {
  source: RunEventSource;
  pid: string | null;
  startedAt: number | null;
  endedAt: number | null;
  sanitizedReport: string | null;
};

// Caller-supplied observation inputs (all optional; the write path fills the
// defaults). Distinct from the sealed draft so the hash surface stays closed.
// `source` is deliberately ABSENT — the trust level is derived from the write
// path (the event kind), never accepted from the caller (see resolveRunObservations).
export type RunObservationInput = {
  pid?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
};

export type RunObservationContext = { now: number; pid: string };

function reportText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  try {
    return JSON.stringify(data) ?? '';
  } catch {
    return '';
  }
}

// Resolve the observation columns for one sealed event. `source` is DERIVED from
// the write path, never caller-supplied: a `report` event is agent-authored prose
// ('agent'); every other event written through the store is a trusted-process
// 'cli' event. 'host-attested' is produced by NO #323 path — it is #322's
// attested channel (and a DB CHECK rejects a raw insert of it). run-start/run-end
// stamp the lifecycle timestamp from the write clock unless the caller passed an
// explicit one; a `report` event's prose is run through the shared sanitizer so
// ONLY a redacted projection is ever stored (the raw prose lives only in the
// non-projected payload).
export function resolveRunObservations(
  kind: RunEventKind,
  data: unknown,
  input: RunObservationInput,
  ctx: RunObservationContext,
): RunEventObservations {
  const source: RunEventSource = kind === 'report' ? 'agent' : 'cli';
  const startedAt = input.startedAt ?? (kind === 'run-start' ? ctx.now : null);
  const endedAt = input.endedAt ?? (kind === 'run-end' ? ctx.now : null);
  const sanitizedReport = kind === 'report' ? sanitizeForIndex(reportText(data)) : null;
  const pid = input.pid ?? ctx.pid ?? null;
  return { source, pid, startedAt, endedAt, sanitizedReport };
}
