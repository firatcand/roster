import {
  InvalidRecordError,
  type ArtifactMeta,
  type ArtifactRecord,
  type Cursor,
  type HitlRequestEnvelope,
  type HitlRequestFilter,
  type OverlayPosition,
  type Page,
  type RunEventEnvelope,
  type RunFilter,
  type RunSummary,
} from './contracts.ts';
import type { LocalOutbox, OutboxEntryState } from './outbox.ts';

// Overlay-only reads: the ONE implementation the degraded backend (resolve.ts)
// and the healthy backend's allowPartial fallback (postgres/stores.ts) both
// delegate to, so a transport-degraded partial read paginates identically on
// both — same composite cursor (watermark/committed are 0 offline; only the
// overlay position advances), same run grouping, same stable per-run anchors.
// #318 R4 finding 4: a PG partial listing must honor cursor + limit and emit a
// cursor that reaches the remaining queued records, never slice the first
// `limit` and signal done. Every result is flagged partial: true (or carries a
// queued: true envelope).

type HitlRequestPayload = Omit<HitlRequestEnvelope, 'id' | 'workspaceId' | 'seq' | 'createdAt' | 'queued'>;
type RunEventPayload = Pick<RunEventEnvelope, 'runId' | 'dedupeKey' | 'type' | 'data'>;
type ArtifactPayload = { digest: string; size: number; meta: ArtifactMeta };

const DEFAULT_OVERLAY_LIMIT = 100;

function overlayOrder(a: OutboxEntryState, b: OutboxEntryState): number {
  if (a.producerId !== b.producerId) return a.producerId < b.producerId ? -1 : 1;
  return a.producerSeq - b.producerSeq;
}

function positionOf(e: OutboxEntryState): OverlayPosition {
  return { producerId: e.producerId, producerSeq: e.producerSeq };
}

function positionAfter(pos: OverlayPosition, after: OverlayPosition | null): boolean {
  if (after === null) return true;
  if (pos.producerId !== after.producerId) return pos.producerId > after.producerId;
  return pos.producerSeq > after.producerSeq;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Point-read argument validation, shared so a degraded (overlay-only) read
// rejects the same bad inputs the local + healthy-PG stores reject — backend
// parity (#318 R5 nit). getRequest('')/getRun('') and a malformed artifact
// digest must throw InvalidRecordError, not silently return null.
export function requireReadId(field: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRecordError(`${field} is required`);
  }
  return value;
}

export function requireReadDigest(digest: string): string {
  if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
    throw new InvalidRecordError('artifact digest must be a full-length lowercase sha256 hex digest');
  }
  return digest;
}

export function overlayPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_OVERLAY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidRecordError(`limit must be a positive integer (got ${String(limit)})`);
  }
  return limit;
}

function overlayCursor(taken: OverlayPosition[], hasMore: boolean): Cursor | null {
  if (!hasMore || taken.length === 0) return null;
  return { watermark: 0, committed: 0, overlay: taken[taken.length - 1]! };
}

function queuedHitlEnvelope(workspaceId: string, e: OutboxEntryState): HitlRequestEnvelope {
  const p = e.payload as HitlRequestPayload;
  return { ...p, id: e.entryId, workspaceId, seq: null, createdAt: e.enqueuedAt, queued: true };
}

function queuedRunEvent(workspaceId: string, e: OutboxEntryState): RunEventEnvelope {
  const p = e.payload as RunEventPayload;
  return { ...p, id: e.entryId, workspaceId, seq: null, createdAt: e.enqueuedAt, queued: true };
}

function hitlFilterMatches(p: HitlRequestPayload, filter?: HitlRequestFilter): boolean {
  return (
    (filter?.functionName === undefined || p.functionName === filter.functionName) &&
    (filter?.status === undefined || p.status === filter.status)
  );
}

function hitlOverlay(outbox: LocalOutbox, filter?: HitlRequestFilter): OutboxEntryState[] {
  return outbox
    .overlayOnly('hitl')
    .filter((e) => e.kind === 'hitl-request' && hitlFilterMatches(e.payload as HitlRequestPayload, filter))
    .sort(overlayOrder);
}

export function overlayHitlGet(outbox: LocalOutbox, workspaceId: string, id: string): HitlRequestEnvelope | null {
  const hit = hitlOverlay(outbox).find((e) => e.entryId === id);
  return hit === undefined ? null : queuedHitlEnvelope(workspaceId, hit);
}

export function overlayHitlList(
  outbox: LocalOutbox,
  workspaceId: string,
  filter: HitlRequestFilter,
  cursor: Cursor | undefined,
): Page<HitlRequestEnvelope> {
  const after = cursor?.overlay ?? null;
  const eligible = hitlOverlay(outbox, filter).filter((e) => positionAfter(positionOf(e), after));
  const limit = overlayPageLimit(filter.limit);
  const taken = eligible.slice(0, limit);
  return {
    items: taken.map((e) => queuedHitlEnvelope(workspaceId, e)),
    cursor: overlayCursor(taken.map(positionOf), eligible.length > taken.length),
    partial: true,
  };
}

export function overlayHitlCount(outbox: LocalOutbox, filter?: HitlRequestFilter): number {
  return hitlOverlay(outbox, filter).length;
}

function runsOverlay(outbox: LocalOutbox, runId?: string): OutboxEntryState[] {
  return outbox
    .overlayOnly('runs')
    .filter((e) => e.kind === 'run-event' && (runId === undefined || (e.payload as RunEventPayload).runId === runId))
    .sort(overlayOrder);
}

export function overlayRunGet(
  outbox: LocalOutbox,
  workspaceId: string,
  runId: string,
): { runId: string; events: RunEventEnvelope[] } | null {
  const events = runsOverlay(outbox, runId).map((e) => queuedRunEvent(workspaceId, e));
  return events.length === 0 ? null : { runId, events };
}

export function overlayRunsList(
  outbox: LocalOutbox,
  workspaceId: string,
  filter: RunFilter,
  cursor: Cursor | undefined,
): Page<RunSummary> {
  // Stable per-run anchor: MIN position over ALL run entries incl. acked, so a
  // run already returned on an earlier page cannot reappear once its earliest
  // queued event acks between pages (a background drain healing partway does not
  // shift the group key).
  const anchors = outbox.overlayGroupAnchors('runs', (e) =>
    e.kind === 'run-event' ? (e.payload as RunEventPayload).runId : null,
  );
  const byRun = new Map<string, { pos: OverlayPosition; item: RunSummary }>();
  for (const e of runsOverlay(outbox, filter.runId)) {
    const p = e.payload as RunEventPayload;
    const existing = byRun.get(p.runId);
    if (existing) {
      existing.item.events += 1;
      existing.item.lastEventAt = Math.max(existing.item.lastEventAt, e.enqueuedAt);
    } else {
      byRun.set(p.runId, {
        pos: anchors.get(p.runId) ?? positionOf(e),
        item: {
          runId: p.runId,
          workspaceId,
          firstSeq: 0,
          lastSeq: 0,
          events: 1,
          startedAt: e.enqueuedAt,
          lastEventAt: e.enqueuedAt,
          queued: true,
        },
      });
    }
  }
  const after = cursor?.overlay ?? null;
  const eligible = [...byRun.values()]
    .sort((a, b) =>
      a.pos.producerId !== b.pos.producerId
        ? a.pos.producerId < b.pos.producerId
          ? -1
          : 1
        : a.pos.producerSeq - b.pos.producerSeq,
    )
    .filter((s) => positionAfter(s.pos, after));
  const limit = overlayPageLimit(filter.limit);
  const taken = eligible.slice(0, limit);
  return {
    items: taken.map((s) => s.item),
    cursor: overlayCursor(taken.map((s) => s.pos), eligible.length > taken.length),
    partial: true,
  };
}

export function overlayRunsCount(outbox: LocalOutbox, filter?: RunFilter): number {
  return new Set(runsOverlay(outbox, filter?.runId).map((e) => (e.payload as RunEventPayload).runId)).size;
}

function queuedArtifactRecord(outbox: LocalOutbox, workspaceId: string, digest: string): ArtifactRecord | null {
  const hit = outbox
    .overlayOnly('artifacts')
    .find((e) => e.kind === 'artifact' && (e.payload as ArtifactPayload).digest === digest);
  if (hit === undefined) return null;
  const p = hit.payload as ArtifactPayload;
  return {
    digest: p.digest,
    size: p.size,
    meta: p.meta,
    workspaceId,
    createdAt: hit.enqueuedAt,
    seq: null,
    queued: true,
  };
}

function queuedArtifactBytes(outbox: LocalOutbox, digest: string): Buffer {
  const bytes = outbox.spoolBytes(digest);
  if (bytes === null) {
    throw new InvalidRecordError(
      `artifact ${digest} is queued but its spooled bytes are missing — the staging invariant is broken`,
    );
  }
  return bytes;
}

export function overlayArtifactGet(
  outbox: LocalOutbox,
  workspaceId: string,
  digest: string,
): { record: ArtifactRecord; bytes: Buffer } | null {
  const record = queuedArtifactRecord(outbox, workspaceId, digest);
  if (record === null) return null;
  return { record, bytes: queuedArtifactBytes(outbox, digest) };
}

export function overlayArtifactHead(outbox: LocalOutbox, workspaceId: string, digest: string): ArtifactRecord | null {
  const record = queuedArtifactRecord(outbox, workspaceId, digest);
  if (record === null) return null;
  queuedArtifactBytes(outbox, digest); // assert the staging invariant before answering head
  return record;
}
