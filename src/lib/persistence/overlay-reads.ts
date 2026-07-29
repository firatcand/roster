import {
  InvalidRecordError,
  type ArtifactDeclaration,
  type ArtifactMeta,
  type ArtifactRecord,
  type Cursor,
  type OverlayPosition,
  type Page,
  type RunEventEnvelope,
  type RunFilter,
  type RunSummary,
} from './contracts.ts';
import {
  canonicalRunEventId,
  correlationColumn,
  dedupRunEvents,
  normalizeStoredEventPayload,
  runEventStableHash,
  trackCanonicalStableHash,
  type RunEventObservations,
  type RunEventPayload,
} from './run-events.ts';
import type { DeclarationObservations, DeclarationSemantic } from './artifact-declarations.ts';
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

// Content-only hashed blob payload; meta rides as a store observation.
type ArtifactPayload = { digest: string; size: number };
type ArtifactObservations = { meta: ArtifactMeta };

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

function queuedRunEvent(workspaceId: string, e: OutboxEntryState): RunEventEnvelope {
  // v1→v2 normalize a queued (#318) payload before exposing it (finding: queued
  // v1 run events read kind=undefined).
  const p = normalizeStoredEventPayload(e.payload);
  const obs = (e.observations ?? null) as RunEventObservations | null;
  return {
    id: e.entryId,
    workspaceId,
    runId: p.runId,
    kind: p.kind,
    dedupeKey: p.dedupeKey,
    data: p.data,
    agent: p.agent ?? null,
    skill: p.skill ?? null,
    trigger: p.trigger ?? null,
    parentRunId: p.parentRunId ?? null,
    originTaskId: p.originTaskId ?? null,
    correlationId: correlationColumn(p.kind, p.dedupeKey),
    source: obs?.source ?? 'unverified',
    pid: obs?.pid ?? null,
    startedAt: obs?.startedAt ?? null,
    endedAt: obs?.endedAt ?? null,
    sanitizedReport: obs?.sanitizedReport ?? null,
    seq: null,
    createdAt: e.enqueuedAt,
    queued: true,
  };
}

// The `hitl` namespace has NO overlay reader (#319 owner decision 6 / D7): HITL
// never spools, so there is never a queued HITL entry to serve — a degraded HITL
// read fails closed instead of answering from a partial view.

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
  const events = dedupRunEvents(
    workspaceId,
    runsOverlay(outbox, runId).map((e) => queuedRunEvent(workspaceId, e)),
  );
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
  // Count CANONICAL event identities per run, not physical outbox entries
  // (finding: a queued v1 run-start + its v2 retry share a canonical id and
  // getRun collapses them via dedupRunEvents, but this summary path counted each
  // physical row, so degraded/allow-partial listRuns reported events=2 while
  // getRun returned 1). Group by canonicalRunEventId so both agree.
  // canonical: cid -> stable hash — same-id/different-payload conflicts raise here
  // too (Rev4 R3-4), matching getRun's dedupRunEvents.
  const byRun = new Map<string, { pos: OverlayPosition; canonical: Map<string, string>; item: RunSummary }>();
  for (const e of runsOverlay(outbox, filter.runId)) {
    const np = normalizeStoredEventPayload(e.payload);
    const cid = canonicalRunEventId(workspaceId, np);
    const existing = byRun.get(np.runId);
    if (existing) {
      trackCanonicalStableHash(existing.canonical, cid, runEventStableHash(np));
      existing.item.lastEventAt = Math.max(existing.item.lastEventAt, e.enqueuedAt);
    } else {
      byRun.set(np.runId, {
        pos: anchors.get(np.runId) ?? positionOf(e),
        canonical: new Map([[cid, runEventStableHash(np)]]),
        item: {
          runId: np.runId,
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
  for (const s of byRun.values()) s.item.events = s.canonical.size;
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
  const obs = (hit.observations ?? {}) as Partial<ArtifactObservations>;
  return {
    digest: p.digest,
    size: p.size,
    meta: obs.meta ?? { filename: 'artifact', contentType: 'application/octet-stream', runId: null },
    workspaceId,
    createdAt: hit.enqueuedAt,
    seq: null,
    queued: true,
    objectVersionId: null,
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

function queuedDeclaration(workspaceId: string, e: OutboxEntryState): ArtifactDeclaration {
  const p = e.payload as DeclarationSemantic;
  const obs = (e.observations ?? {}) as Partial<DeclarationObservations>;
  return {
    id: e.entryId,
    workspaceId,
    runId: p.runId,
    declaringAgent: p.declaringAgent,
    role: p.role,
    kind: p.kind,
    digest: p.digest ?? null,
    provider: p.provider ?? null,
    externalId: p.externalId ?? null,
    externalUrl: p.externalUrl ?? null,
    artifactType: p.artifactType ?? null,
    mediaType: p.mediaType ?? null,
    provenance: p.provenance ?? null,
    verified: obs.verified ?? false,
    versionState: obs.versionState ?? null,
    sanitizedText: obs.sanitizedText ?? null,
    createdAt: e.enqueuedAt,
    seq: null,
    queued: true,
  };
}

export function overlayDeclarationsByRun(outbox: LocalOutbox, workspaceId: string, runId: string): ArtifactDeclaration[] {
  return outbox
    .overlayOnly('artifacts')
    .filter((e) => e.kind === 'artifact-declaration' && (e.payload as DeclarationSemantic).runId === runId)
    .map((e) => queuedDeclaration(workspaceId, e));
}

export function overlayDeclarationGet(
  outbox: LocalOutbox,
  workspaceId: string,
  id: string,
): ArtifactDeclaration | null {
  const hit = outbox.overlayOnly('artifacts').find((e) => e.kind === 'artifact-declaration' && e.entryId === id);
  return hit === undefined ? null : queuedDeclaration(workspaceId, hit);
}
