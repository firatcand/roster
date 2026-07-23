import type pg from 'pg';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  NotConfiguredError,
  PersistenceError,
  WorkspaceMismatchError,
  computeRecordId,
  sha256Hex,
  snapshotPayload,
  HITL_STATUS_VALUES,
  type ArtifactMeta,
  type ArtifactPutResult,
  type ArtifactRecord,
  type ArtifactStore,
  type CountResult,
  type Cursor,
  type HitlDecisionInput,
  type HitlRequestEnvelope,
  type HitlRequestFilter,
  type HitlRequestInput,
  type HitlStore,
  type OpsBackend,
  type OverlayPosition,
  type Page,
  type ReadOpts,
  type RunEventEnvelope,
  type RunEventInput,
  type RunFilter,
  type RunStore,
  type RunSummary,
  type WriteOutcome,
} from '../contracts.ts';
import {
  type CommittedRef,
  type DeliverResult,
  type LocalOutbox,
  type OutboxEntryState,
  type OutboxRecord,
  type OutboxTargetNamespace,
  type RemoteTarget,
} from '../outbox.ts';
import { makeBackendInfo, type BackendInfo } from '../capabilities.ts';
import { BoundPool, type PgQueryable } from './binding.ts';
import { S3ObjectTarget, type CreateOnlyObjectStore } from '../objects.ts';
import { mayDegradeToPartial } from '../error-classify.ts';
import {
  overlayArtifactGet,
  overlayArtifactHead,
  overlayHitlCount,
  overlayHitlGet,
  overlayHitlList,
  overlayRunGet,
  overlayRunsCount,
  overlayRunsList,
} from '../overlay-reads.ts';

// postgres-s3 store set (#318 stage 4). Same contract semantics as the local
// backend: deterministic sha256 ids, ConflictError on same-id/different-hash
// (backed by the delivery ledger), committed-seq watermark cursors. Every
// write — direct or outbox-drained — funnels through applyRecord's single
// ledger+data transaction, so replay dedup behaves identically on both paths.
// When a LocalOutbox is wired in, spoolable writes go writeThrough (tri-state
// committed | queued), reads and counts overlay the queued entries (surfaced
// with queued: true, ordered after committed rows by producer position), and
// HITL decisions stay fail-closed direct (owner decision 8). allowPartial
// reads degrade to the overlay only (partial: true) on TRANSPORT failures;
// semantic refusals (workspace mismatch, version skew) always fail hard.

const DEFAULT_PAGE_LIMIT = 100;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function requireString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRecordError(`${field} is required`);
  }
  return value;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidRecordError(`limit must be a positive integer (got ${String(limit)})`);
  }
  return limit;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function rethrowAsBackendError(err: unknown, what: string): never {
  if (err instanceof PersistenceError) throw err;
  throw new BackendUnavailableError(`${what}: ${(err as Error).message}`);
}

// The single fail-closed read-degrade gate every PG read/count catch funnels
// through (#318 R4 finding 1). Returns NORMALLY only when the caller opted into
// allowPartial AND the caught error is a classified transport outage — the one
// case where an overlay-only partial is safe. EVERY other error fails closed:
// a typed semantic PersistenceError (WorkspaceMismatch / VersionSkew / Conflict
// / InvalidRecord) rethrows as-is; a config/auth 'halt' or an unrecognized
// 'unknown' programming/schema defect (e.g. PG 42703) is surfaced (wrapped
// BackendUnavailable), never softened into a benign-looking partial.
function assertDegradableTransport(err: unknown, allowPartial: boolean | undefined, what: string): void {
  if (allowPartial === true && mayDegradeToPartial(err)) return;
  rethrowAsBackendError(err, what);
}

function overlayOrder(a: OutboxEntryState, b: OutboxEntryState): number {
  if (a.producerId !== b.producerId) return a.producerId < b.producerId ? -1 : 1;
  return a.producerSeq - b.producerSeq;
}

function positionOf(e: OutboxEntryState): OverlayPosition {
  return { producerId: e.producerId, producerSeq: e.producerSeq };
}

function positionAfter(e: OutboxEntryState, after: OverlayPosition): boolean {
  if (e.producerId !== after.producerId) return e.producerId > after.producerId;
  return e.producerSeq > after.producerSeq;
}

// ---------- the single write path ----------

export type OpsPgRecord = {
  namespace: OutboxTargetNamespace;
  kind: string;
  id: string;
  workspaceId: string;
  // The plain snapshot value (column extraction) and its exact canonical bytes
  // (the jsonb payload column) — both derive from ONE snapshot, so a stateful
  // toJSON cannot make the stored row disagree with payloadHash.
  payload: unknown;
  canonical: string;
  payloadHash: string;
  producerId: string | null;
  producerSeq: number | null;
  createdAt: number;
};

export type HitlRequestPayload = Omit<HitlRequestEnvelope, 'id' | 'workspaceId' | 'seq' | 'createdAt' | 'queued'>;
export type HitlDecisionPayload = { requestId: string; status: string; decidedBy: string; note: string | null };
export type RunEventPayload = Pick<RunEventEnvelope, 'runId' | 'dedupeKey' | 'type' | 'data'>;
export type ArtifactPayload = { digest: string; size: number; meta: ArtifactMeta };

// Validation + deterministic id derivation shared by the direct write path,
// the outbox writeThrough path, AND the degraded backend (resolve.ts): every
// producer of a given logical record derives byte-identical (id, payload), so
// replay after an outage dedups instead of conflicting.

export function hitlRequestParts(
  workspaceId: string,
  input: HitlRequestInput,
): { id: string; payload: HitlRequestPayload; canonical: string } {
  const functionName = requireString('functionName', input.functionName);
  const title = requireString('title', input.title);
  const action = requireString('action', input.action);
  const target = requireString('target', input.target);
  const contentHash = requireString('contentHash', input.contentHash);
  if (!SHA256_HEX_RE.test(contentHash)) {
    throw new InvalidRecordError('contentHash must be a full-length lowercase sha256 hex digest');
  }
  const body = requireString('body', input.body);
  if (input.expiresAt !== null && typeof input.expiresAt !== 'number') {
    throw new InvalidRecordError('expiresAt must be an epoch-ms number or null');
  }
  const id = computeRecordId(workspaceId, 'hitl', {
    kind: 'hitl-request',
    functionName,
    action,
    target,
    contentHash,
  });
  const snap = snapshotPayload({
    functionName,
    title,
    action,
    target,
    contentHash,
    body,
    expiresAt: input.expiresAt,
    status: 'awaiting',
  });
  return { id, payload: snap.value as HitlRequestPayload, canonical: snap.canonical };
}

export function hitlDecisionParts(
  workspaceId: string,
  input: HitlDecisionInput,
): { id: string; payload: HitlDecisionPayload; canonical: string } {
  const requestId = requireString('requestId', input.requestId);
  const status = requireString('status', input.status);
  if (!HITL_STATUS_VALUES.includes(status as (typeof HITL_STATUS_VALUES)[number]) || status === 'awaiting') {
    throw new InvalidRecordError(
      `status must be a decision status (${HITL_STATUS_VALUES.filter((s) => s !== 'awaiting').join(' | ')})`,
    );
  }
  const decidedBy = requireString('decidedBy', input.decidedBy);
  if (input.note !== null && typeof input.note !== 'string') {
    throw new InvalidRecordError('note must be a string or null');
  }
  const id = computeRecordId(workspaceId, 'hitl', {
    kind: 'hitl-decision',
    requestId,
    status,
    decidedBy,
    note: input.note,
  });
  const snap = snapshotPayload({ requestId, status, decidedBy, note: input.note });
  return { id, payload: snap.value as HitlDecisionPayload, canonical: snap.canonical };
}

export function runEventParts(
  workspaceId: string,
  input: RunEventInput,
): { id: string; payload: RunEventPayload; canonical: string } {
  const runId = requireString('runId', input.runId);
  const dedupeKey = requireString('dedupeKey', input.dedupeKey);
  const type = requireString('type', input.type);
  if (input.data === undefined) {
    throw new InvalidRecordError('data is required (use null for an event without data)');
  }
  const id = computeRecordId(workspaceId, 'runs', { kind: 'run-event', runId, dedupeKey });
  const snap = snapshotPayload({ runId, dedupeKey, type, data: input.data });
  return { id, payload: snap.value as RunEventPayload, canonical: snap.canonical };
}

export function artifactParts(
  workspaceId: string,
  meta: ArtifactMeta,
  bytes: Uint8Array,
): { id: string; payload: ArtifactPayload; canonical: string; digest: string } {
  requireString('meta.filename', meta.filename);
  requireString('meta.contentType', meta.contentType);
  if (meta.runId !== null) requireString('meta.runId', meta.runId);
  const digest = sha256Hex(bytes);
  const id = computeRecordId(workspaceId, 'artifacts', { kind: 'artifact', digest });
  const snap = snapshotPayload({ digest, size: bytes.byteLength, meta });
  return { id, payload: snap.value as ArtifactPayload, canonical: snap.canonical, digest };
}

async function insertDataRow(client: pg.PoolClient, rec: OpsPgRecord): Promise<void> {
  const route = `${rec.namespace}/${rec.kind}`;
  if (route === 'hitl/hitl-request') {
    const p = rec.payload as HitlRequestPayload;
    await client.query(
      `INSERT INTO hitl.requests
         (id, workspace_id, version, action, target, content_hash, payload, status, producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, 1, $3, $4, $5, $6::jsonb, $7, $8::uuid, $9, $10)`,
      [
        rec.id,
        rec.workspaceId,
        p.action,
        p.target,
        p.contentHash,
        rec.canonical,
        p.status,
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
      ],
    );
    return;
  }
  if (route === 'hitl/hitl-decision') {
    const p = rec.payload as HitlDecisionPayload;
    const version = await client.query(
      `SELECT COALESCE(MAX(version), 1) AS v FROM hitl.requests WHERE workspace_id = $1::uuid AND id = $2`,
      [rec.workspaceId, p.requestId],
    );
    await client.query(
      `INSERT INTO hitl.decisions
         (id, workspace_id, request_id, request_version, status, payload, producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, $8, $9)`,
      [
        rec.id,
        rec.workspaceId,
        p.requestId,
        num((version.rows[0] as { v: unknown }).v),
        p.status,
        rec.canonical,
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
      ],
    );
    return;
  }
  if (route === 'runs/run-event') {
    const p = rec.payload as RunEventPayload;
    await client.query(
      `INSERT INTO roster_ops.run_events
         (id, workspace_id, run_id, dedupe_key, type, payload, producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, $8, $9)`,
      [
        rec.id,
        rec.workspaceId,
        p.runId,
        p.dedupeKey,
        p.type,
        rec.canonical,
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
      ],
    );
    return;
  }
  if (route === 'artifacts/artifact') {
    const p = rec.payload as ArtifactPayload;
    await client.query(
      `INSERT INTO roster_ops.artifacts
         (id, workspace_id, digest, size, meta, producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7, $8)`,
      [
        rec.id,
        rec.workspaceId,
        p.digest,
        p.size,
        JSON.stringify(p.meta),
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
      ],
    );
    return;
  }
  throw new InvalidRecordError(`no postgres materialization for namespace '${rec.namespace}' kind '${rec.kind}'`);
}

// Delivery-ledger-first transaction: the unique (workspace_id, namespace,
// record_id) insert arbitrates. Loser with an identical payload hash is a
// 'duplicate' (acked-equivalent, nothing written); a different hash is a
// ConflictError, never a blanket DO NOTHING. Transient pg errors propagate
// untouched so the outbox retry policy classifies them.
export async function applyRecord(client: pg.PoolClient, rec: OpsPgRecord): Promise<DeliverResult> {
  await client.query('BEGIN');
  let existingHash: string | null | undefined;
  try {
    const ins = await client.query(
      `INSERT INTO roster_ops.delivery_ledger (workspace_id, namespace, record_id, payload_hash)
       VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (workspace_id, namespace, record_id) DO NOTHING`,
      [rec.workspaceId, rec.namespace, rec.id, rec.payloadHash],
    );
    if ((ins.rowCount ?? 0) === 0) {
      const existing = await client.query(
        `SELECT payload_hash FROM roster_ops.delivery_ledger
          WHERE workspace_id = $1::uuid AND namespace = $2 AND record_id = $3`,
        [rec.workspaceId, rec.namespace, rec.id],
      );
      existingHash = (existing.rows[0] as { payload_hash: string } | undefined)?.payload_hash ?? null;
      await client.query('ROLLBACK');
    } else {
      await insertDataRow(client, rec);
      await client.query('COMMIT');
      return 'committed';
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  if (existingHash === rec.payloadHash) return 'duplicate';
  throw new ConflictError(
    rec.id,
    `server already holds this record with payload hash ${existingHash ?? '(unreadable)'}, incoming has ${rec.payloadHash}`,
  );
}

// Stage 3 RemoteTarget over the delivery ledger. Runs on the bound pool, so
// every physical connection has passed binding verification before the ledger
// is ever touched; a record stamped for a different workspace is refused
// outright — spooled data must never land in a foreign workspace. The factory
// (resolve.ts) attaches a preflight that revalidates binding + marker once
// per drain batch, before any remote I/O.
export class PgRemoteTarget implements RemoteTarget {
  private readonly pool: BoundPool;
  preflight?: () => Promise<void>;

  constructor(pool: BoundPool) {
    this.pool = pool;
  }

  async deliver(record: OutboxRecord): Promise<DeliverResult> {
    if (record.workspaceId !== this.pool.workspaceId) {
      throw new WorkspaceMismatchError(
        `outbox record ${record.id} belongs to workspace ${record.workspaceId}, not ${this.pool.workspaceId}`,
      );
    }
    const client = await this.pool.connect();
    try {
      return await applyRecord(client, {
        namespace: record.namespace,
        kind: record.kind,
        id: record.id,
        workspaceId: record.workspaceId,
        payload: record.payload,
        canonical: record.canonical,
        payloadHash: record.payloadHash,
        producerId: record.producerId,
        producerSeq: record.producerSeq,
        createdAt: record.enqueuedAt,
      });
    } finally {
      client.release();
    }
  }
}

// ---------- shared store plumbing ----------

type StoreDeps = {
  pool: BoundPool;
  workspaceId: string;
  outbox: LocalOutbox | null;
  remote: PgRemoteTarget;
  now: () => number;
};

async function directApply(deps: StoreDeps, rec: OpsPgRecord, what: string): Promise<WriteOutcome> {
  const client = await deps.pool.connect().catch((err) => rethrowAsBackendError(err, what));
  try {
    await applyRecord(client, rec);
    return { outcome: 'committed', id: rec.id };
  } catch (err) {
    rethrowAsBackendError(err, what);
  } finally {
    client.release();
  }
}

function overlayEntries(res: { queued: OutboxEntryState[]; conflicts: { entry: OutboxEntryState }[] }): OutboxEntryState[] {
  return [...res.queued, ...res.conflicts.map((c) => c.entry)];
}

async function fetchCommittedRefs(
  deps: StoreDeps,
  namespace: OutboxTargetNamespace,
): Promise<CommittedRef[]> {
  const res = await deps.pool.query(
    `SELECT record_id, payload_hash FROM roster_ops.delivery_ledger
      WHERE workspace_id = $1::uuid AND namespace = $2`,
    [deps.workspaceId, namespace],
  );
  return (res.rows as { record_id: string; payload_hash: string }[]).map((r) => ({
    id: r.record_id,
    payloadHash: r.payload_hash,
  }));
}

// Point-read conflict surfacing (finding 6): a POINT read (getRequest, artifact
// get/head) must not silently return a committed row while a genuinely
// CONFLICTING write (same id, DIFFERENT payload hash) sits queued in the
// overlay. overlay() parks + returns those same-id/different-hash conflicts (an
// identical-hash queued entry is a dup — excluded, so the committed row is
// returned normally). If the requested record is among the parked conflicts,
// surface it as a ConflictError exactly as the write path and list paths do,
// rather than returning stale data. Cheap gate first (a local fold) so the extra
// delivery-ledger round-trip only happens when a matching entry is actually
// queued. getRun/listRuns/count already union-by-id+hash via overlay().
async function surfaceQueuedConflict(
  deps: StoreDeps,
  namespace: OutboxTargetNamespace,
  matches: (e: OutboxEntryState) => boolean,
): Promise<void> {
  if (!deps.outbox) return;
  if (!deps.outbox.overlayOnly(namespace).some(matches)) return;
  const refs = await fetchCommittedRefs(deps, namespace);
  const { conflicts } = deps.outbox.overlay(namespace, refs);
  const hit = conflicts.find((c) => matches(c.entry));
  if (hit) {
    throw new ConflictError(
      hit.entry.entryId,
      `a queued write conflicts with the committed record (committed hash ${hit.committedHash}, queued ${hit.entry.payloadHash})`,
    );
  }
}

// ---------- hitl ----------

function hitlEnvelopeFromRow(row: Record<string, unknown>): HitlRequestEnvelope {
  const p = row.payload as HitlRequestPayload;
  return {
    ...p,
    status: row.status as HitlRequestEnvelope['status'],
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    seq: num(row.seq),
    createdAt: num(row.created_at),
    queued: false,
  };
}

function queuedHitlEnvelope(workspaceId: string, e: OutboxEntryState): HitlRequestEnvelope {
  const p = e.payload as HitlRequestPayload;
  return { ...p, id: e.entryId, workspaceId, seq: null, createdAt: e.enqueuedAt, queued: true };
}

function hitlFilterMatches(p: HitlRequestPayload, filter?: HitlRequestFilter): boolean {
  return (
    (filter?.functionName === undefined || p.functionName === filter.functionName) &&
    (filter?.status === undefined || p.status === filter.status)
  );
}

class PgHitlStore implements HitlStore {
  private readonly deps: StoreDeps;

  constructor(deps: StoreDeps) {
    this.deps = deps;
  }

  private overlayLocalOnly(filter?: HitlRequestFilter): OutboxEntryState[] {
    if (!this.deps.outbox) return [];
    return this.deps.outbox
      .overlayOnly('hitl')
      .filter((e) => e.kind === 'hitl-request' && hitlFilterMatches(e.payload as HitlRequestPayload, filter))
      .sort(overlayOrder);
  }

  private async overlayAgainstCommitted(filter?: HitlRequestFilter): Promise<OutboxEntryState[]> {
    if (!this.deps.outbox) return [];
    const refs = await fetchCommittedRefs(this.deps, 'hitl');
    const res = this.deps.outbox.overlay('hitl', refs);
    return overlayEntries(res)
      .filter((e) => e.kind === 'hitl-request' && hitlFilterMatches(e.payload as HitlRequestPayload, filter))
      .sort(overlayOrder);
  }

  async createRequest(input: HitlRequestInput): Promise<WriteOutcome> {
    const { id, payload, canonical } = hitlRequestParts(this.deps.workspaceId, input);
    if (this.deps.outbox) {
      return await this.deps.outbox.writeThrough(
        { namespace: 'hitl', id, kind: 'hitl-request', payload },
        this.deps.remote,
      );
    }
    return await directApply(
      this.deps,
      {
        namespace: 'hitl',
        kind: 'hitl-request',
        id,
        workspaceId: this.deps.workspaceId,
        payload,
        canonical,
        payloadHash: sha256Hex(canonical),
        producerId: null,
        producerSeq: null,
        createdAt: this.deps.now(),
      },
      'postgres hitl.createRequest failed',
    );
  }

  async getRequest(id: string, opts?: ReadOpts): Promise<HitlRequestEnvelope | null> {
    requireString('id', id);
    try {
      const res = await this.deps.pool.query(
        `SELECT seq, id, workspace_id::text AS workspace_id, payload, status, created_at
           FROM hitl.requests
          WHERE workspace_id = $1::uuid AND id = $2
          ORDER BY version DESC LIMIT 1`,
        [this.deps.workspaceId, id],
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      // Surface a queued same-id/different-hash conflict BEFORE returning the
      // committed (possibly stale) row — never silently hide the conflict.
      await surfaceQueuedConflict(this.deps, 'hitl', (e) => e.kind === 'hitl-request' && e.entryId === id);
      if (row !== undefined) return hitlEnvelopeFromRow(row);
      const hit = this.overlayLocalOnly().find((e) => e.entryId === id);
      return hit === undefined ? null : queuedHitlEnvelope(this.deps.workspaceId, hit);
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres hitl.getRequest failed');
      return this.deps.outbox ? overlayHitlGet(this.deps.outbox, this.deps.workspaceId, id) : null;
    }
  }

  async listRequests(filter: HitlRequestFilter, cursor?: Cursor, opts?: ReadOpts): Promise<Page<HitlRequestEnvelope>> {
    const limit = pageLimit(filter.limit);
    try {
      const watermark =
        cursor?.watermark ??
        num(
          (
            (await this.deps.pool.query(
              `SELECT COALESCE(MAX(seq), 0) AS w FROM hitl.requests WHERE workspace_id = $1::uuid`,
              [this.deps.workspaceId],
            )).rows[0] as { w: unknown }
          ).w,
        );
      const after = cursor?.committed ?? 0;
      const res = await this.deps.pool.query(
        `SELECT * FROM (
             SELECT DISTINCT ON (id)
                    seq, id, workspace_id::text AS workspace_id, payload, status, created_at
               FROM hitl.requests
              WHERE workspace_id = $1::uuid AND seq <= $2
              ORDER BY id, version DESC
           ) latest
          WHERE seq > $3
            AND ($4::text IS NULL OR payload->>'functionName' = $4)
            AND ($5::text IS NULL OR status = $5)
          ORDER BY seq
          LIMIT $6`,
        [this.deps.workspaceId, watermark, after, filter.functionName ?? null, filter.status ?? null, limit + 1],
      );
      const rows = res.rows as Record<string, unknown>[];
      const taken = rows.slice(0, limit);
      let items = taken.map(hitlEnvelopeFromRow);
      const moreCommitted = rows.length > limit;
      const committedMark = items.length > 0 ? items[items.length - 1]!.seq! : after;
      if (moreCommitted) {
        return { items, cursor: { watermark, committed: committedMark, overlay: null }, partial: false };
      }
      // Committed rows exhausted: queued overlay entries order after them,
      // by (producerId, producerSeq) — union by id with payload-hash equality.
      const overlayAfter = cursor?.overlay ?? null;
      const all = await this.overlayAgainstCommitted(filter);
      const remaining = overlayAfter === null ? all : all.filter((e) => positionAfter(e, overlayAfter));
      const slice = remaining.slice(0, Math.max(0, limit - items.length));
      items = items.concat(slice.map((e) => queuedHitlEnvelope(this.deps.workspaceId, e)));
      const nextCursor: Cursor | null =
        remaining.length > slice.length
          ? {
              watermark,
              committed: committedMark,
              overlay: slice.length > 0 ? positionOf(slice[slice.length - 1]!) : overlayAfter,
            }
          : null;
      return { items, cursor: nextCursor, partial: false };
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres hitl.listRequests failed');
      // #318 R4 finding 4: honor cursor + limit over the queued overlay (the
      // SAME pager the degraded backend uses) — never slice the first `limit`
      // and signal done.
      return this.deps.outbox
        ? overlayHitlList(this.deps.outbox, this.deps.workspaceId, filter, cursor)
        : { items: [], cursor: null, partial: true };
    }
  }

  async appendDecision(input: HitlDecisionInput): Promise<WriteOutcome> {
    const { id, payload, canonical } = hitlDecisionParts(this.deps.workspaceId, input);
    // Decisions are never queued (owner decision 8): always the direct path,
    // even when an outbox is wired — a dead store surfaces BackendUnavailable.
    return await directApply(
      this.deps,
      {
        namespace: 'hitl',
        kind: 'hitl-decision',
        id,
        workspaceId: this.deps.workspaceId,
        payload,
        canonical,
        payloadHash: sha256Hex(canonical),
        producerId: null,
        producerSeq: null,
        createdAt: this.deps.now(),
      },
      'postgres hitl.appendDecision failed (decisions require the live store and are never spooled)',
    );
  }

  async count(filter?: HitlRequestFilter, opts?: ReadOpts): Promise<CountResult> {
    try {
      const res = await this.deps.pool.query(
        `SELECT count(*)::int AS n FROM (
             SELECT DISTINCT ON (id) id, payload, status
               FROM hitl.requests
              WHERE workspace_id = $1::uuid
              ORDER BY id, version DESC
           ) latest
          WHERE ($2::text IS NULL OR payload->>'functionName' = $2)
            AND ($3::text IS NULL OR status = $3)`,
        [this.deps.workspaceId, filter?.functionName ?? null, filter?.status ?? null],
      );
      const committed = num((res.rows[0] as { n: unknown }).n);
      if (!this.deps.outbox) return { committed, queued: 0, partial: false };
      const queued = (await this.overlayAgainstCommitted(filter)).length;
      return { committed, queued, partial: false };
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres hitl.count failed');
      return { committed: 0, queued: this.deps.outbox ? overlayHitlCount(this.deps.outbox, filter) : 0, partial: true };
    }
  }
}

// ---------- runs ----------

function runEventFromRow(row: Record<string, unknown>): RunEventEnvelope {
  const p = row.payload as RunEventPayload;
  return {
    ...p,
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    seq: num(row.seq),
    createdAt: num(row.created_at),
    queued: false,
  };
}

function queuedRunEvent(workspaceId: string, e: OutboxEntryState): RunEventEnvelope {
  const p = e.payload as RunEventPayload;
  return { ...p, id: e.entryId, workspaceId, seq: null, createdAt: e.enqueuedAt, queued: true };
}

class PgRunStore implements RunStore {
  private readonly deps: StoreDeps;

  constructor(deps: StoreDeps) {
    this.deps = deps;
  }

  async appendEvent(input: RunEventInput): Promise<WriteOutcome> {
    const { id, payload, canonical } = runEventParts(this.deps.workspaceId, input);
    if (this.deps.outbox) {
      return await this.deps.outbox.writeThrough(
        { namespace: 'runs', id, kind: 'run-event', payload },
        this.deps.remote,
      );
    }
    return await directApply(
      this.deps,
      {
        namespace: 'runs',
        kind: 'run-event',
        id,
        workspaceId: this.deps.workspaceId,
        payload,
        canonical,
        payloadHash: sha256Hex(canonical),
        producerId: null,
        producerSeq: null,
        createdAt: this.deps.now(),
      },
      'postgres runs.appendEvent failed',
    );
  }

  async getRun(runId: string, opts?: ReadOpts): Promise<{ runId: string; events: RunEventEnvelope[] } | null> {
    requireString('runId', runId);
    try {
      const res = await this.deps.pool.query(
        `SELECT seq, id, workspace_id::text AS workspace_id, payload, created_at
           FROM roster_ops.run_events
          WHERE workspace_id = $1::uuid AND run_id = $2
          ORDER BY seq`,
        [this.deps.workspaceId, runId],
      );
      const rows = res.rows as Record<string, unknown>[];
      let events = rows.map(runEventFromRow);
      // Event-granular union-by-id+hash (NOT committed-id filtering, which hides
      // same-id conflicts): a queued event on this run whose id is already
      // committed with an identical hash is deduped; a different hash surfaces
      // as a Conflict (parked by overlay()); every other queued event appends.
      if (this.deps.outbox) {
        const refs = await fetchCommittedRefs(this.deps, 'runs');
        const queued = overlayEntries(this.deps.outbox.overlay('runs', refs))
          .filter((e) => e.kind === 'run-event' && (e.payload as RunEventPayload).runId === runId)
          .sort(overlayOrder)
          .map((e) => queuedRunEvent(this.deps.workspaceId, e));
        events = events.concat(queued);
      }
      return events.length === 0 ? null : { runId, events };
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres runs.getRun failed');
      return this.deps.outbox ? overlayRunGet(this.deps.outbox, this.deps.workspaceId, runId) : null;
    }
  }

  async listRuns(filter: RunFilter, cursor?: Cursor, opts?: ReadOpts): Promise<Page<RunSummary>> {
    const limit = pageLimit(filter.limit);
    try {
      const watermark =
        cursor?.watermark ??
        num(
          (
            (await this.deps.pool.query(
              `SELECT COALESCE(MAX(seq), 0) AS w FROM roster_ops.run_events WHERE workspace_id = $1::uuid`,
              [this.deps.workspaceId],
            )).rows[0] as { w: unknown }
          ).w,
        );
      const after = cursor?.committed ?? 0;
      const res = await this.deps.pool.query(
        `SELECT run_id, MIN(seq) AS first_seq, MAX(seq) AS last_seq, COUNT(*) AS events,
                MIN(created_at) AS started_at, MAX(created_at) AS last_event_at
           FROM roster_ops.run_events
          WHERE workspace_id = $1::uuid AND seq <= $2
            AND ($3::text IS NULL OR run_id = $3)
          GROUP BY run_id
         HAVING MIN(seq) > $4
          ORDER BY first_seq
          LIMIT $5`,
        [this.deps.workspaceId, watermark, filter.runId ?? null, after, limit + 1],
      );
      const rows = res.rows as Record<string, unknown>[];
      const taken = rows.slice(0, limit);
      let items: RunSummary[] = taken.map((row) => ({
        runId: row.run_id as string,
        workspaceId: this.deps.workspaceId,
        firstSeq: num(row.first_seq),
        lastSeq: num(row.last_seq),
        events: num(row.events),
        startedAt: num(row.started_at),
        lastEventAt: num(row.last_event_at),
        queued: false,
      }));
      const moreCommitted = rows.length > limit;
      const committedMark = items.length > 0 ? items[items.length - 1]!.firstSeq : after;

      // Event-granular overlay merge (finding: partially-committed runs). Group
      // the queued overlay by run, ADD queued events to any committed run in this
      // page (never skip the whole run by committed id), and carry runs with NO
      // committed events forward as overlay-only summaries. overlay() surfaces +
      // parks same-id/different-hash conflicts as it groups.
      const overlayByRun = new Map<
        string,
        { pos: OverlayPosition; count: number; startedAt: number; lastEventAt: number }
      >();
      // Stable per-run overlay anchors (finding 5): MIN position over ALL run
      // entries incl. acked, so a run already returned on an earlier page cannot
      // reappear once its earliest queued event acks mid-pagination.
      let runAnchors: Map<string, OverlayPosition> | null = null;
      if (this.deps.outbox) {
        const refs = await fetchCommittedRefs(this.deps, 'runs');
        runAnchors = this.deps.outbox.overlayGroupAnchors('runs', (e) =>
          e.kind === 'run-event' ? (e.payload as RunEventPayload).runId : null,
        );
        const entries = overlayEntries(this.deps.outbox.overlay('runs', refs))
          .filter(
            (e) =>
              e.kind === 'run-event' &&
              (filter.runId === undefined || (e.payload as RunEventPayload).runId === filter.runId),
          )
          .sort(overlayOrder);
        for (const e of entries) {
          const p = e.payload as RunEventPayload;
          const existing = overlayByRun.get(p.runId);
          if (existing) {
            existing.count += 1;
            existing.lastEventAt = Math.max(existing.lastEventAt, e.enqueuedAt);
          } else {
            overlayByRun.set(p.runId, { pos: positionOf(e), count: 1, startedAt: e.enqueuedAt, lastEventAt: e.enqueuedAt });
          }
        }
        for (const item of items) {
          const o = overlayByRun.get(item.runId);
          if (o) {
            item.events += o.count;
            item.lastEventAt = Math.max(item.lastEventAt, o.lastEventAt);
          }
        }
      }

      if (moreCommitted) {
        return { items, cursor: { watermark, committed: committedMark, overlay: null }, partial: false };
      }

      let queuedRuns: Array<{ pos: OverlayPosition; item: RunSummary }> = [];
      if (overlayByRun.size > 0) {
        // Classify runs as committed for THIS pagination ONLY by events at/below
        // the frozen watermark. A run whose only committed events landed AFTER
        // page 1 (seq > watermark) stays overlay-only here, so it is neither
        // omitted (dropped by the watermark on the committed side) nor duplicated.
        const committedRes = await this.deps.pool.query(
          `SELECT COALESCE(array_agg(DISTINCT run_id), '{}') AS runs
             FROM roster_ops.run_events
            WHERE workspace_id = $1::uuid AND seq <= $2 AND ($3::text IS NULL OR run_id = $3)`,
          [this.deps.workspaceId, watermark, filter.runId ?? null],
        );
        const committedRunIds = new Set((committedRes.rows[0] as { runs: string[] }).runs);
        for (const [runId, o] of overlayByRun) {
          if (committedRunIds.has(runId)) continue; // already merged into a committed summary
          queuedRuns.push({
            pos: runAnchors?.get(runId) ?? o.pos,
            item: {
              runId,
              workspaceId: this.deps.workspaceId,
              firstSeq: 0,
              lastSeq: 0,
              events: o.count,
              startedAt: o.startedAt,
              lastEventAt: o.lastEventAt,
              queued: true,
            },
          });
        }
        queuedRuns.sort((a, b) =>
          a.pos.producerId !== b.pos.producerId
            ? a.pos.producerId < b.pos.producerId
              ? -1
              : 1
            : a.pos.producerSeq - b.pos.producerSeq,
        );
      }
      const overlayAfter = cursor?.overlay ?? null;
      const remaining =
        overlayAfter === null
          ? queuedRuns
          : queuedRuns.filter(
              (s) =>
                s.pos.producerId > overlayAfter.producerId ||
                (s.pos.producerId === overlayAfter.producerId && s.pos.producerSeq > overlayAfter.producerSeq),
            );
      const slice = remaining.slice(0, Math.max(0, limit - items.length));
      items = items.concat(slice.map((s) => s.item));
      const nextCursor: Cursor | null =
        remaining.length > slice.length
          ? {
              watermark,
              committed: committedMark,
              overlay: slice.length > 0 ? slice[slice.length - 1]!.pos : overlayAfter,
            }
          : null;
      return { items, cursor: nextCursor, partial: false };
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres runs.listRuns failed');
      // #318 R4 finding 4: cursor + limit aware, run-grouped, anchor-stable —
      // the SAME pager the degraded backend uses.
      return this.deps.outbox
        ? overlayRunsList(this.deps.outbox, this.deps.workspaceId, filter, cursor)
        : { items: [], cursor: null, partial: true };
    }
  }

  async count(filter?: RunFilter, opts?: ReadOpts): Promise<CountResult> {
    try {
      const res = await this.deps.pool.query(
        `SELECT COALESCE(array_agg(DISTINCT run_id), '{}') AS runs
           FROM roster_ops.run_events
          WHERE workspace_id = $1::uuid AND ($2::text IS NULL OR run_id = $2)`,
        [this.deps.workspaceId, filter?.runId ?? null],
      );
      const committedRuns = new Set((res.rows[0] as { runs: string[] }).runs);
      if (!this.deps.outbox) return { committed: committedRuns.size, queued: 0, partial: false };
      const refs = await fetchCommittedRefs(this.deps, 'runs');
      const overlay = this.deps.outbox.overlay('runs', refs);
      const queuedRuns = new Set<string>();
      for (const entry of overlayEntries(overlay)) {
        if (entry.kind !== 'run-event') continue;
        const p = entry.payload as RunEventPayload;
        if (filter?.runId !== undefined && p.runId !== filter.runId) continue;
        if (!committedRuns.has(p.runId)) queuedRuns.add(p.runId);
      }
      return { committed: committedRuns.size, queued: queuedRuns.size, partial: false };
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres runs.count failed');
      return { committed: 0, queued: this.deps.outbox ? overlayRunsCount(this.deps.outbox, filter) : 0, partial: true };
    }
  }
}

// ---------- artifacts ----------

function artifactFromRow(row: Record<string, unknown>): ArtifactRecord {
  return {
    digest: row.digest as string,
    size: num(row.size),
    meta: row.meta as ArtifactMeta,
    workspaceId: row.workspace_id as string,
    createdAt: num(row.created_at),
    seq: num(row.seq),
    queued: false,
  };
}

class PgArtifactStore implements ArtifactStore {
  private readonly deps: StoreDeps;
  private readonly objects: CreateOnlyObjectStore;
  private readonly objectTarget: S3ObjectTarget;

  constructor(deps: StoreDeps, objects: CreateOnlyObjectStore) {
    this.deps = deps;
    this.objects = objects;
    this.objectTarget = new S3ObjectTarget(objects);
  }

  private queuedRecord(digest: string): { record: ArtifactRecord; entry: OutboxEntryState } | null {
    if (!this.deps.outbox) return null;
    const hit = this.deps.outbox
      .overlayOnly('artifacts')
      .find((e) => e.kind === 'artifact' && (e.payload as ArtifactPayload).digest === digest);
    if (hit === undefined) return null;
    const p = hit.payload as ArtifactPayload;
    return {
      record: {
        digest: p.digest,
        size: p.size,
        meta: p.meta,
        workspaceId: this.deps.workspaceId,
        createdAt: hit.enqueuedAt,
        seq: null,
        queued: true,
      },
      entry: hit,
    };
  }

  private queuedBytes(digest: string): Buffer {
    const bytes = this.deps.outbox!.spoolBytes(digest);
    if (bytes === null) {
      throw new InvalidRecordError(
        `artifact ${digest} is queued but its spooled bytes are missing — the staging invariant is broken`,
      );
    }
    return bytes;
  }

  async putArtifact(meta: ArtifactMeta, bytes: Uint8Array): Promise<ArtifactPutResult> {
    const { id, payload, canonical, digest } = artifactParts(this.deps.workspaceId, meta, bytes);
    if (this.deps.outbox) {
      return await this.deps.outbox.writeThroughArtifact(
        { namespace: 'artifacts', id, kind: 'artifact', payload },
        bytes,
        this.deps.remote,
        { objects: this.objectTarget },
      );
    }
    // Object-first / index-last: bytes are durable (and digest-verified) at
    // the object store before the index row exists, so a committed row always
    // implies readable bytes.
    const stored = await this.objectTarget.deliver(digest, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    if (stored !== 'stored' && stored !== 'exists') {
      throw new InvalidRecordError(`object target returned invalid result '${String(stored)}'`);
    }
    const outcome = await directApply(
      this.deps,
      {
        namespace: 'artifacts',
        kind: 'artifact',
        id,
        workspaceId: this.deps.workspaceId,
        payload,
        canonical,
        payloadHash: sha256Hex(canonical),
        producerId: null,
        producerSeq: null,
        createdAt: this.deps.now(),
      },
      'postgres artifacts.putArtifact failed',
    );
    return { ...outcome, digest };
  }

  private async findRecord(digest: string): Promise<ArtifactRecord | null> {
    const res = await this.deps.pool.query(
      `SELECT seq, id, workspace_id::text AS workspace_id, digest, size, meta, created_at
         FROM roster_ops.artifacts
        WHERE workspace_id = $1::uuid AND digest = $2`,
      [this.deps.workspaceId, digest],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : artifactFromRow(row);
  }

  async getArtifact(digest: string, opts?: ReadOpts): Promise<{ record: ArtifactRecord; bytes: Buffer } | null> {
    this.assertDigest(digest);
    try {
      const record = await this.findRecord(digest);
      // Surface a queued same-digest/different-meta (same id, different hash)
      // conflict before returning a committed artifact row.
      await surfaceQueuedConflict(
        this.deps,
        'artifacts',
        (e) => e.kind === 'artifact' && (e.payload as ArtifactPayload).digest === digest,
      );
      if (record === null) {
        const queued = this.queuedRecord(digest);
        if (queued === null) return null;
        return { record: queued.record, bytes: this.queuedBytes(digest) };
      }
      const obj = await this.objects.get({ prefix: 'artifacts', segments: [digest] });
      if (obj === null) {
        throw new InvalidRecordError(
          `artifact ${digest} is indexed but its bytes are missing at artifacts/${digest} — the object-first invariant is broken`,
        );
      }
      if (sha256Hex(obj.body) !== digest) {
        throw new InvalidRecordError(`artifact ${digest} bytes in the object store do not match their digest`);
      }
      return { record, bytes: obj.body };
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres artifacts.getArtifact failed');
      return this.deps.outbox ? overlayArtifactGet(this.deps.outbox, this.deps.workspaceId, digest) : null;
    }
  }

  async head(digest: string, opts?: ReadOpts): Promise<ArtifactRecord | null> {
    this.assertDigest(digest);
    try {
      const record = await this.findRecord(digest);
      await surfaceQueuedConflict(
        this.deps,
        'artifacts',
        (e) => e.kind === 'artifact' && (e.payload as ArtifactPayload).digest === digest,
      );
      if (record === null) {
        const queued = this.queuedRecord(digest);
        if (queued === null) return null;
        this.queuedBytes(digest);
        return queued.record;
      }
      const obj = await this.objects.head({ prefix: 'artifacts', segments: [digest] });
      if (obj === null) {
        throw new InvalidRecordError(
          `artifact ${digest} is indexed but its bytes are missing at artifacts/${digest} — the object-first invariant is broken`,
        );
      }
      return record;
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres artifacts.head failed');
      return this.deps.outbox ? overlayArtifactHead(this.deps.outbox, this.deps.workspaceId, digest) : null;
    }
  }

  private assertDigest(digest: string): void {
    if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
      throw new InvalidRecordError('artifact digest must be a full-length lowercase sha256 hex digest');
    }
  }
}

// ---------- capabilities (section H) ----------

function capabilityList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== 'string')) {
    throw new InvalidRecordError(`${where} capabilities must be a JSON array of strings`);
  }
  return raw as string[];
}

// Admin-authored, runtime-read-only: sourced from the two meta tables. Accepts
// any queryable (BoundPool, raw pool, client) so doctor can read it before a
// binding is finalized.
export async function pgBackendInfo(q: PgQueryable): Promise<BackendInfo> {
  try {
    const hitl = await q.query(`SELECT component_version, capabilities FROM hitl.meta WHERE singleton`);
    const ops = await q.query(
      `SELECT component_version, capabilities, objects_component_version, objects_capabilities
         FROM roster_ops.meta WHERE singleton`,
    );
    const hitlRow = hitl.rows[0] as { component_version: number; capabilities: unknown } | undefined;
    const opsRow = ops.rows[0] as
      | {
          component_version: number;
          capabilities: unknown;
          objects_component_version: number;
          objects_capabilities: unknown;
        }
      | undefined;
    if (hitlRow === undefined || opsRow === undefined) {
      throw new InvalidRecordError('hitl.meta / roster_ops.meta singleton row missing — the schema migration is incomplete');
    }
    return makeBackendInfo('postgres-s3', {
      hitl: { version: num(hitlRow.component_version), capabilities: capabilityList(hitlRow.capabilities, 'hitl.meta') },
      roster_ops: {
        version: num(opsRow.component_version),
        capabilities: capabilityList(opsRow.capabilities, 'roster_ops.meta'),
      },
      objects: {
        version: num(opsRow.objects_component_version),
        capabilities: capabilityList(opsRow.objects_capabilities, 'roster_ops.meta objects'),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      throw new NotConfiguredError(
        'the ops schemas are not migrated on this database — run roster ops setup',
      );
    }
    throw err;
  }
}

// ---------- backend bundle ----------

export type PgBackendOptions = {
  pool: BoundPool;
  objects: CreateOnlyObjectStore;
  outbox?: LocalOutbox;
  now?: () => number;
  // Batch revalidation composed by the factory (resolve.ts): runs once per
  // drain batch before ANY remote I/O — binding + marker verification.
  preflight?: () => Promise<void>;
};

export type PgOpsBackend = OpsBackend & { readonly remote: PgRemoteTarget };

export function createPgBackend(opts: PgBackendOptions): PgOpsBackend {
  const workspaceId = opts.pool.workspaceId;
  if (opts.outbox && opts.outbox.ledger.workspaceId !== workspaceId) {
    throw new WorkspaceMismatchError(
      `outbox belongs to workspace ${opts.outbox.ledger.workspaceId}, not ${workspaceId}`,
    );
  }
  const remote = new PgRemoteTarget(opts.pool);
  if (opts.preflight) remote.preflight = opts.preflight;
  const deps: StoreDeps = {
    pool: opts.pool,
    workspaceId,
    outbox: opts.outbox ?? null,
    remote,
    now: opts.now ?? Date.now,
  };
  return {
    backend: 'postgres-s3',
    workspaceId,
    hitl: new PgHitlStore(deps),
    runs: new PgRunStore(deps),
    artifacts: new PgArtifactStore(deps, opts.objects),
    remote,
  };
}
