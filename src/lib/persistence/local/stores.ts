import { join } from 'node:path';
import {
  ConflictError,
  InvalidRecordError,
  computeRecordId,
  sha256Hex,
  HITL_STATUS_VALUES,
  type ArtifactDeclaration,
  type ArtifactMeta,
  type ArtifactPutResult,
  type ArtifactRecord,
  type ArtifactStore,
  type CountResult,
  type Cursor,
  type DeclarationPutResult,
  type ExternalArtifactInput,
  type HitlDecisionInput,
  type HitlRequestEnvelope,
  type HitlRequestFilter,
  type HitlRequestInput,
  type HitlStore,
  type InternalDeclarationInput,
  type OpsBackend,
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
  canonicalRunEventId,
  correlationColumn,
  dedupRunEvents,
  normalizeStoredEventPayload,
  resolveRunObservations,
  runEventStableHash,
  sealRunEvent,
  trackCanonicalStableHash,
  type RunEventObservations,
  type RunEventPayload,
} from '../run-events.ts';
import { legacyDeclarationOf } from '../artifact-declarations.ts';
import {
  externalDeclarationParts,
  internalDeclarationParts,
  type DeclarationObservations,
  type DeclarationSemantic,
} from '../artifact-declarations.ts';
import {
  LocalLedger,
  assertRegularFileIfExists,
  fsyncDir,
  readRegularFileSync,
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

function eventFromRecord(rec: LedgerRecord): RunEventEnvelope {
  // v1→v2 normalize (finding: v1 records not upgraded) — a #318 payload used
  // `type` (not `kind`) and lacked the v2 metadata fields.
  const p = normalizeStoredEventPayload(rec.payload);
  const obs = (rec.observations ?? null) as RunEventObservations | null;
  return {
    id: rec.id,
    workspaceId: rec.ws,
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
    createdAt: rec.ts,
    seq: rec.seq,
    queued: false,
  };
}

class LocalRunStore implements RunStore {
  private readonly ledger: LocalLedger;
  private readonly now: () => number;
  private readonly pid: () => string;

  constructor(ledger: LocalLedger, now: () => number, pid: () => string) {
    this.ledger = ledger;
    this.now = now;
    this.pid = pid;
  }

  async appendEvent(input: RunEventInput): Promise<WriteOutcome> {
    const sealed = sealRunEvent(this.ledger.workspaceId, {
      runId: input.runId,
      kind: input.kind,
      data: input.data,
      correlationId: input.correlationId,
      agent: input.agent,
      skill: input.skill,
      trigger: input.trigger,
      parentRunId: input.parentRunId,
      originTaskId: input.originTaskId,
    });
    const observations = resolveRunObservations(sealed.kind, input.data, input, {
      now: this.now(),
      pid: this.pid(),
    });
    const res = this.ledger.append('runs', {
      id: sealed.id,
      kind: 'run-event',
      payload: sealed.payload,
      observations,
    });
    return { outcome: 'committed', id: res.record.id };
  }

  async getRun(runId: string): Promise<{ runId: string; events: RunEventEnvelope[] } | null> {
    requireString('runId', runId);
    const { records } = this.ledger.scan('runs');
    const events = records
      // v1 payloads carry runId directly; normalize the runId read defensively.
      .filter((r) => r.kind === 'run-event' && normalizeStoredEventPayload(r.payload).runId === runId)
      .map(eventFromRecord);
    // Collapse a v1 record and its post-upgrade v2 retry (shared canonical id).
    const deduped = dedupRunEvents(this.ledger.workspaceId, events);
    return deduped.length > 0 ? { runId, events: deduped } : null;
  }

  async listRuns(filter: RunFilter, cursor?: Cursor): Promise<Page<RunSummary>> {
    const { records, lastSeq } = this.ledger.scan('runs');
    const watermark = cursor?.watermark ?? lastSeq;
    // Count CANONICAL event identities, not physical rows (finding: a v1 record
    // and its post-upgrade v2 retry share a canonical id — getRun collapses them
    // to one event, but the summary counted both, so `run show` and `run list`
    // disagreed). A run-scoped Set of canonical ids gives the same count as
    // dedupRunEvents.
    // canonical: cid -> stable hash. Grouping by canonical id agrees with getRun,
    // and comparing stable hashes surfaces a v1/v2 same-id/different-payload
    // conflict as a ConflictError instead of silently under-counting (Rev4 R3-4).
    const byRun = new Map<string, { summary: RunSummary; canonical: Map<string, string> }>();
    for (const rec of records) {
      if (rec.kind !== 'run-event' || rec.seq > watermark) continue;
      const p = normalizeStoredEventPayload(rec.payload);
      if (filter.runId !== undefined && p.runId !== filter.runId) continue;
      const cid = canonicalRunEventId(rec.ws, p);
      const existing = byRun.get(p.runId);
      if (existing) {
        existing.summary.lastSeq = rec.seq;
        trackCanonicalStableHash(existing.canonical, cid, runEventStableHash(p));
        existing.summary.lastEventAt = rec.ts;
      } else {
        byRun.set(p.runId, {
          canonical: new Map([[cid, runEventStableHash(p)]]),
          summary: {
            runId: p.runId,
            workspaceId: rec.ws,
            firstSeq: rec.seq,
            lastSeq: rec.seq,
            events: 0,
            startedAt: rec.ts,
            lastEventAt: rec.ts,
            queued: false,
          },
        });
      }
    }
    const summaries = [...byRun.values()].map((s) => ({
      orderSeq: s.summary.firstSeq,
      item: { ...s.summary, events: s.canonical.size },
    }));
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

// Content-only hashed blob payload (finding: blob identity must not include run
// metadata); meta rides as a store observation (first-write-wins).
type ArtifactPayload = { digest: string; size: number };
type ArtifactObservations = { meta: ArtifactMeta };

function artifactFromRecord(rec: LedgerRecord): ArtifactRecord {
  const p = rec.payload as ArtifactPayload & { meta?: ArtifactMeta };
  const obs = (rec.observations ?? {}) as Partial<ArtifactObservations>;
  return {
    digest: p.digest,
    size: p.size,
    // v2 meta rides in observations; a v1 record carried it inside the payload
    // (finding: v1 records not upgraded) — fall back so v1 meta round-trips.
    meta: obs.meta ?? p.meta ?? { filename: 'artifact', contentType: 'application/octet-stream', runId: null },
    workspaceId: rec.ws,
    createdAt: rec.ts,
    seq: rec.seq,
    queued: false,
    // The local filesystem blob store is unversioned — no S3 version handle.
    objectVersionId: null,
  };
}

function declarationFromRecord(rec: LedgerRecord): ArtifactDeclaration {
  const p = rec.payload as DeclarationSemantic;
  const obs = (rec.observations ?? {}) as Partial<DeclarationObservations>;
  return {
    id: rec.id,
    workspaceId: rec.ws,
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

  async putArtifact(meta: ArtifactMeta, bytes: Uint8Array, decl?: InternalDeclarationInput): Promise<ArtifactPutResult> {
    requireString('meta.filename', meta.filename);
    requireString('meta.contentType', meta.contentType);
    if (meta.runId !== null) requireString('meta.runId', meta.runId);
    const digest = sha256Hex(bytes);
    // Derive + snapshot the COMPLETE declaration (role/agent/types AND the
    // provenance canonical serialization) BEFORE any blob write, so a bad field
    // OR unserializable (e.g. circular) provenance throws with NO side effect
    // (finding: validation ran AFTER the blob mutation — a circular provenance
    // committed the bytes, then threw during JSON.stringify, orphaning the blob).
    // The local blob store is unversioned, so version_state is 'unverified'.
    const declParts =
      decl !== undefined ? internalDeclarationParts(this.ledger.workspaceId, digest, decl, 'unverified') : undefined;
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
      const existing = readRegularFileSync(path);
      if (existing === null || sha256Hex(existing) !== digest) {
        throw new ConflictError(digest, 'stored artifact bytes do not match their digest');
      }
      fsyncDir(dir);
    } else {
      writeBlobSync(dir, digest, bytes);
    }
    const id = computeRecordId(this.ledger.workspaceId, 'artifacts', { kind: 'artifact', digest });
    // Skip-if-present-by-digest (finding: a REAL v1 blob record hashed
    // {digest,size,meta}; a v2 re-declare of identical bytes hashes {digest,size}
    // → the SAME id but a DIFFERENT checksum → ConflictError). An already-present
    // blob (from v1 or v2) satisfies the digest, so do NOT re-append the blob
    // record — just add the declaration. The blob write is idempotent on the
    // DIGEST, never on the full payload hash.
    if (this.findRecord(digest) === null) {
      // Content-only payload; meta is a store observation so two runs' identical
      // bytes dedup to one blob record (first meta wins) with no ConflictError.
      const payload: ArtifactPayload = { digest, size: bytes.byteLength };
      const observations: ArtifactObservations = { meta };
      this.ledger.append('artifacts', { id, kind: 'artifact', payload, observations });
    }
    // Blob committed first (index-last); THEN the declaration references it.
    let declarationId: string | null = null;
    if (declParts !== undefined) {
      this.ledger.append('artifacts', {
        id: declParts.id,
        kind: 'artifact-declaration',
        payload: declParts.payload,
        observations: declParts.observations,
      });
      declarationId = declParts.id;
    }
    return {
      outcome: 'committed',
      id,
      digest,
      objectVersionId: null,
      declarationId,
      blobOutcome: 'committed',
      declarationOutcome: decl !== undefined ? 'committed' : null,
    };
  }

  async putExternal(meta: ExternalArtifactInput): Promise<DeclarationPutResult> {
    const parts = externalDeclarationParts(this.ledger.workspaceId, meta);
    const res = this.ledger.append('artifacts', {
      id: parts.id,
      kind: 'artifact-declaration',
      payload: parts.payload,
      observations: parts.observations,
    });
    return { outcome: 'committed', id: res.record.id };
  }

  // Synthesize a deterministic legacy declaration for every v1 artifact record
  // (a blob whose PAYLOAD carried `meta` — the #318 shape). Keyed on the BLOB's
  // OWN recorded provenance (its legacy runId via legacyDeclarationOf), NOT on
  // "does ANY declaration for this digest exist" (finding: a later run declaring
  // the same digest suppressed the legacy blob's provenance, diverging from PG,
  // which keeps its once-per-blob backfill row). Matches the PG migration: one
  // legacy declaration per legacy blob, suppressed ONLY when that EXACT
  // declaration id is already materialized (idempotent, like ON CONFLICT DO
  // NOTHING). declaring_agent='legacy', role='produced', sentinel-normalized
  // runId — byte-identical id to the PG backfill. A v2 bare-blob put (payload has
  // no `meta`) is NOT synthesized, matching the PG side (no post-migration backfill).
  private synthesizedLegacyDeclarations(records: readonly LedgerRecord[]): ArtifactDeclaration[] {
    const existingIds = new Set<string>();
    for (const r of records) {
      if (r.kind === 'artifact-declaration') existingIds.add(r.id);
    }
    const out: ArtifactDeclaration[] = [];
    for (const r of records) {
      if (r.kind !== 'artifact') continue;
      const p = r.payload as ArtifactPayload & { meta?: ArtifactMeta };
      if (p.meta === undefined || p.meta === null) continue; // v2 bare blob — no synthesis
      const decl = legacyDeclarationOf(r.ws, p.digest, p.meta, r.ts);
      // Suppress only when this SPECIFIC legacy declaration is already present
      // (a real declaration collided with the deterministic legacy id, or a
      // duplicate legacy blob row for the same digest+provenance).
      if (existingIds.has(decl.id)) continue;
      existingIds.add(decl.id);
      out.push(decl);
    }
    return out;
  }

  async getByRun(runId: string, _opts?: ReadOpts): Promise<ArtifactDeclaration[]> {
    requireString('runId', runId);
    const { records } = this.ledger.scan('artifacts');
    const real = records
      .filter((r) => r.kind === 'artifact-declaration' && (r.payload as DeclarationSemantic).runId === runId)
      .map(declarationFromRecord);
    const legacy = this.synthesizedLegacyDeclarations(records).filter((d) => d.runId === runId);
    return real.concat(legacy);
  }

  async getDeclaration(id: string, _opts?: ReadOpts): Promise<ArtifactDeclaration | null> {
    requireString('id', id);
    const { records } = this.ledger.scan('artifacts');
    const rec = records.find((r) => r.kind === 'artifact-declaration' && r.id === id);
    if (rec) return declarationFromRecord(rec);
    return this.synthesizedLegacyDeclarations(records).find((d) => d.id === id) ?? null;
  }

  // The ONE integrity standard for a committed local blob (round-8 finding 3):
  // the digest path must be a REGULAR file — read through its descriptor, so a
  // symlink is refused and a FIFO/directory can neither hang nor divert the read
  // — whose bytes hash to the digest. `head` applies it too: it previously only
  // statSync'd the path, so a reconstruction (`roster run show`) reported an
  // artifact `resolved` that `getArtifact` would reject for the same content.
  private verifiedBytes(digest: string): Buffer {
    const path = join(this.bytesDir(), digest);
    const bytes = readRegularFileSync(path);
    if (bytes === null) {
      throw new InvalidRecordError(
        `artifact ${digest} is indexed but its bytes are missing at ${path} — the bytes-first invariant is broken`,
      );
    }
    if (sha256Hex(bytes) !== digest) {
      throw new InvalidRecordError(`artifact ${digest} bytes on disk do not match their digest`);
    }
    return bytes;
  }

  async getArtifact(digest: string): Promise<{ record: ArtifactRecord; bytes: Buffer } | null> {
    this.assertDigest(digest);
    const rec = this.findRecord(digest);
    if (!rec) return null;
    return { record: artifactFromRecord(rec), bytes: this.verifiedBytes(digest) };
  }

  async head(digest: string): Promise<ArtifactRecord | null> {
    this.assertDigest(digest);
    const rec = this.findRecord(digest);
    if (!rec) return null;
    this.verifiedBytes(digest);
    return artifactFromRecord(rec);
  }

  private assertDigest(digest: string): void {
    if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
      throw new InvalidRecordError('artifact digest must be a full-length lowercase sha256 hex digest');
    }
  }
}

export type LocalBackendOptions = Omit<LocalLedgerOptions, 'maxRecordBytes'> & {
  // Injectable pid seam for the run-event observation columns (tests).
  pid?: () => string;
};

export type LocalOpsBackend = OpsBackend & { readonly ledger: LocalLedger };

export function createLocalBackend(opts: LocalBackendOptions): LocalOpsBackend {
  const ledger = new LocalLedger(opts);
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? (() => String(process.pid));
  return {
    backend: 'local',
    workspaceId: opts.workspaceId,
    ledger,
    hitl: new LocalHitlStore(ledger),
    runs: new LocalRunStore(ledger, now, pid),
    artifacts: new LocalArtifactStore(ledger),
  };
}
