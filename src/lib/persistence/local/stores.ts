import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  InvalidRecordError,
  computeRecordId,
  sha256Hex,
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
  type Page,
  type RunEventEnvelope,
  type RunEventInput,
  type RunFilter,
  type RunStore,
  type RunSummary,
  type WriteOutcome,
} from '../contracts.ts';
import {
  LocalLedger,
  assertRegularFileIfExists,
  fsyncDir,
  writeBlobSync,
  type LedgerRecord,
  type LocalLedgerOptions,
} from './ledger.ts';

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

// Committed-domain pagination shared by the local stores: the watermark is the
// namespace's committed seq captured at page 1; later pages never surface rows
// above it, so a fresh commit (or an overlay ack) mid-pagination cannot leak
// into an in-flight listing.
function pageBySeq<T>(
  items: ReadonlyArray<{ orderSeq: number; item: T }>,
  cursor: Cursor | undefined,
  limit: number,
  namespaceLastSeq: number,
): Page<T> {
  const watermark = cursor?.watermark ?? namespaceLastSeq;
  const after = cursor?.committed ?? 0;
  const eligible = items.filter((e) => e.orderSeq <= watermark && e.orderSeq > after);
  const taken = eligible.slice(0, limit);
  const more = eligible.length > taken.length;
  return {
    items: taken.map((e) => e.item),
    cursor:
      more && taken.length > 0
        ? { watermark, committed: taken[taken.length - 1]!.orderSeq, overlay: null }
        : null,
    partial: false,
  };
}

type HitlRequestPayload = Omit<HitlRequestEnvelope, 'id' | 'workspaceId' | 'seq' | 'createdAt' | 'queued'>;

function requestFromRecord(rec: LedgerRecord): HitlRequestEnvelope {
  const p = rec.payload as HitlRequestPayload;
  return { ...p, id: rec.id, workspaceId: rec.ws, seq: rec.seq, createdAt: rec.ts, queued: false };
}

class LocalHitlStore implements HitlStore {
  private readonly ledger: LocalLedger;

  constructor(ledger: LocalLedger) {
    this.ledger = ledger;
  }

  async createRequest(input: HitlRequestInput): Promise<WriteOutcome> {
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
    const id = computeRecordId(this.ledger.workspaceId, 'hitl', {
      kind: 'hitl-request',
      functionName,
      action,
      target,
      contentHash,
    });
    const payload: HitlRequestPayload = {
      functionName,
      title,
      action,
      target,
      contentHash,
      body,
      expiresAt: input.expiresAt,
      status: 'awaiting',
    };
    const res = this.ledger.append('hitl', { id, kind: 'hitl-request', payload });
    return { outcome: 'committed', id: res.record.id };
  }

  async getRequest(id: string): Promise<HitlRequestEnvelope | null> {
    requireString('id', id);
    const { records } = this.ledger.scan('hitl');
    const rec = records.find((r) => r.kind === 'hitl-request' && r.id === id);
    return rec ? requestFromRecord(rec) : null;
  }

  async listRequests(filter: HitlRequestFilter, cursor?: Cursor): Promise<Page<HitlRequestEnvelope>> {
    const { records, lastSeq } = this.ledger.scan('hitl');
    const matches = records
      .filter((r) => r.kind === 'hitl-request')
      .map((r) => ({ orderSeq: r.seq, item: requestFromRecord(r) }))
      .filter(
        (e) =>
          (filter.functionName === undefined || e.item.functionName === filter.functionName) &&
          (filter.status === undefined || e.item.status === filter.status),
      );
    return pageBySeq(matches, cursor, pageLimit(filter.limit), lastSeq);
  }

  async appendDecision(input: HitlDecisionInput): Promise<WriteOutcome> {
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
    const payload = { requestId, status, decidedBy, note: input.note };
    const id = computeRecordId(this.ledger.workspaceId, 'hitl', { kind: 'hitl-decision', ...payload });
    // Decisions are never 'queued' (owner decision 8): the local ledger either
    // commits or throws BackendUnavailableError — there is no spool path here.
    const res = this.ledger.append('hitl', { id, kind: 'hitl-decision', payload });
    return { outcome: 'committed', id: res.record.id };
  }

  async count(filter?: HitlRequestFilter): Promise<CountResult> {
    const { records } = this.ledger.scan('hitl');
    const committed = records.filter(
      (r) =>
        r.kind === 'hitl-request' &&
        (filter?.functionName === undefined ||
          (r.payload as HitlRequestPayload).functionName === filter.functionName) &&
        (filter?.status === undefined || (r.payload as HitlRequestPayload).status === filter.status),
    ).length;
    return { committed, queued: 0, partial: false };
  }
}

type RunEventPayload = Pick<RunEventEnvelope, 'runId' | 'dedupeKey' | 'type' | 'data'>;

function eventFromRecord(rec: LedgerRecord): RunEventEnvelope {
  const p = rec.payload as RunEventPayload;
  return { ...p, id: rec.id, workspaceId: rec.ws, createdAt: rec.ts, seq: rec.seq, queued: false };
}

class LocalRunStore implements RunStore {
  private readonly ledger: LocalLedger;

  constructor(ledger: LocalLedger) {
    this.ledger = ledger;
  }

  async appendEvent(input: RunEventInput): Promise<WriteOutcome> {
    const runId = requireString('runId', input.runId);
    const dedupeKey = requireString('dedupeKey', input.dedupeKey);
    const type = requireString('type', input.type);
    if (input.data === undefined) {
      throw new InvalidRecordError('data is required (use null for an event without data)');
    }
    const id = computeRecordId(this.ledger.workspaceId, 'runs', {
      kind: 'run-event',
      runId,
      dedupeKey,
    });
    const payload: RunEventPayload = { runId, dedupeKey, type, data: input.data };
    const res = this.ledger.append('runs', { id, kind: 'run-event', payload });
    return { outcome: 'committed', id: res.record.id };
  }

  async getRun(runId: string): Promise<{ runId: string; events: RunEventEnvelope[] } | null> {
    requireString('runId', runId);
    const { records } = this.ledger.scan('runs');
    const events = records
      .filter((r) => r.kind === 'run-event' && (r.payload as RunEventPayload).runId === runId)
      .map(eventFromRecord);
    return events.length > 0 ? { runId, events } : null;
  }

  async listRuns(filter: RunFilter, cursor?: Cursor): Promise<Page<RunSummary>> {
    const { records, lastSeq } = this.ledger.scan('runs');
    const watermark = cursor?.watermark ?? lastSeq;
    const byRun = new Map<string, RunSummary>();
    for (const rec of records) {
      if (rec.kind !== 'run-event' || rec.seq > watermark) continue;
      const p = rec.payload as RunEventPayload;
      if (filter.runId !== undefined && p.runId !== filter.runId) continue;
      const existing = byRun.get(p.runId);
      if (existing) {
        existing.lastSeq = rec.seq;
        existing.events += 1;
        existing.lastEventAt = rec.ts;
      } else {
        byRun.set(p.runId, {
          runId: p.runId,
          workspaceId: rec.ws,
          firstSeq: rec.seq,
          lastSeq: rec.seq,
          events: 1,
          startedAt: rec.ts,
          lastEventAt: rec.ts,
          queued: false,
        });
      }
    }
    const summaries = [...byRun.values()].map((s) => ({ orderSeq: s.firstSeq, item: s }));
    return pageBySeq(summaries, cursor ?? { watermark, committed: 0, overlay: null }, pageLimit(filter.limit), lastSeq);
  }

  async count(filter?: RunFilter): Promise<CountResult> {
    const { records } = this.ledger.scan('runs');
    const runs = new Set<string>();
    for (const rec of records) {
      if (rec.kind !== 'run-event') continue;
      const p = rec.payload as RunEventPayload;
      if (filter?.runId !== undefined && p.runId !== filter.runId) continue;
      runs.add(p.runId);
    }
    return { committed: runs.size, queued: 0, partial: false };
  }
}

type ArtifactPayload = { digest: string; size: number; meta: ArtifactMeta };

function artifactFromRecord(rec: LedgerRecord): ArtifactRecord {
  const p = rec.payload as ArtifactPayload;
  return {
    digest: p.digest,
    size: p.size,
    meta: p.meta,
    workspaceId: rec.ws,
    createdAt: rec.ts,
    seq: rec.seq,
    queued: false,
  };
}

class LocalArtifactStore implements ArtifactStore {
  private readonly ledger: LocalLedger;

  constructor(ledger: LocalLedger) {
    this.ledger = ledger;
  }

  private bytesDir(): string {
    return join(this.ledger.treeDir, 'artifacts');
  }

  private findRecord(digest: string): LedgerRecord | null {
    const { records } = this.ledger.scan('artifacts');
    return (
      records.find((r) => r.kind === 'artifact' && (r.payload as ArtifactPayload).digest === digest) ??
      null
    );
  }

  async putArtifact(meta: ArtifactMeta, bytes: Uint8Array): Promise<ArtifactPutResult> {
    requireString('meta.filename', meta.filename);
    requireString('meta.contentType', meta.contentType);
    if (meta.runId !== null) requireString('meta.runId', meta.runId);
    const digest = sha256Hex(bytes);
    // Bytes-first / index-last: the ledger record is appended only after the
    // bytes are durable, so a committed record always implies readable,
    // digest-verified bytes. Orphaned bytes (crash before the index append)
    // are re-adopted by the digest-verify path on the next put — with the blob
    // dir re-fsynced so the directory entry is durable before the index lands.
    const dir = this.bytesDir();
    this.ledger.meta(); // ensures the workspace tree (and its 0700 modes) exists
    this.ledger.ensureDir(dir);
    const path = join(dir, digest);
    if (assertRegularFileIfExists(path) !== null) {
      const existing = readFileSync(path);
      if (sha256Hex(existing) !== digest) {
        throw new ConflictError(digest, 'stored artifact bytes do not match their digest');
      }
      fsyncDir(dir);
    } else {
      writeBlobSync(dir, digest, bytes);
    }
    const id = computeRecordId(this.ledger.workspaceId, 'artifacts', { kind: 'artifact', digest });
    const payload: ArtifactPayload = { digest, size: bytes.byteLength, meta };
    const res = this.ledger.append('artifacts', { id, kind: 'artifact', payload });
    return { outcome: 'committed', id: res.record.id, digest };
  }

  async getArtifact(digest: string): Promise<{ record: ArtifactRecord; bytes: Buffer } | null> {
    this.assertDigest(digest);
    const rec = this.findRecord(digest);
    if (!rec) return null;
    const path = join(this.bytesDir(), digest);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new InvalidRecordError(
        `artifact ${digest} is indexed but its bytes are missing at ${path} — the bytes-first invariant is broken`,
      );
    }
    if (sha256Hex(bytes) !== digest) {
      throw new InvalidRecordError(`artifact ${digest} bytes on disk do not match their digest`);
    }
    return { record: artifactFromRecord(rec), bytes };
  }

  async head(digest: string): Promise<ArtifactRecord | null> {
    this.assertDigest(digest);
    const rec = this.findRecord(digest);
    if (!rec) return null;
    const path = join(this.bytesDir(), digest);
    try {
      statSync(path);
    } catch {
      throw new InvalidRecordError(
        `artifact ${digest} is indexed but its bytes are missing at ${path} — the bytes-first invariant is broken`,
      );
    }
    return artifactFromRecord(rec);
  }

  private assertDigest(digest: string): void {
    if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
      throw new InvalidRecordError('artifact digest must be a full-length lowercase sha256 hex digest');
    }
  }
}

export type LocalBackendOptions = Omit<LocalLedgerOptions, 'maxRecordBytes'>;

export type LocalOpsBackend = OpsBackend & { readonly ledger: LocalLedger };

export function createLocalBackend(opts: LocalBackendOptions): LocalOpsBackend {
  const ledger = new LocalLedger(opts);
  return {
    backend: 'local',
    workspaceId: opts.workspaceId,
    ledger,
    hitl: new LocalHitlStore(ledger),
    runs: new LocalRunStore(ledger),
    artifacts: new LocalArtifactStore(ledger),
  };
}
