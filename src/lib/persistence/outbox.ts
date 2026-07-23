import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  PersistenceError,
  canonicalJson,
  computeRecordId,
  sha256Hex,
  snapshotPayload,
  OPS_NAMESPACES,
  type CountResult,
  type OpsNamespace,
  type OverlayPosition,
  type WriteOutcome,
} from './contracts.ts';
import {
  LocalLedger,
  assertRegularFileIfExists,
  atomicWriteFileSync,
  fsyncDir,
  writeBlobSync,
  type LedgerRecord,
} from './local/ledger.ts';
import { classifyDeliveryError, mayDegradeToPartial } from './error-classify.ts';

// Durable local outbox (#318 section G) on top of the stage-2 ledger engine.
// The outbox is the 'outbox' namespace of the workspace's ledger tree
// (.roster/ops/<workspaceId>/outbox/): immutable events enqueued / attempt /
// acked / failed{transient|permanent} — never mutated, never rewritten —
// with per-entry state derived by folding events. Ordering is contractual
// per (producer, namespace); every record carries (producerId, producerSeq).
//
// Tri-state (owner decision 8): writeThrough returns committed | queued and
// never silently succeeds; HITL decisions are fail-closed — they require the
// live store and are refused by enqueue, never spooled.

export const OUTBOX_NAMESPACE = 'outbox';
export type OutboxTargetNamespace = Exclude<OpsNamespace, 'outbox'>;
const TARGET_NAMESPACES = OPS_NAMESPACES.filter((n): n is OutboxTargetNamespace => n !== OUTBOX_NAMESPACE);

// Owner decision 8 fail-closed set: record kinds that must never be spooled.
// Their writes require the live store; when it is down the caller gets an
// actionable BackendUnavailableError, not a queued entry.
export const NON_SPOOLABLE_KINDS: ReadonlySet<string> = new Set(['hitl-decision']);

export const DEFAULT_ATTEMPT_CAP = 5;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_JITTER_RATIO = 0.2;
export const DEFAULT_MAX_SPOOL_BYTES = 256 * 1024 * 1024;

// The record a drain delivers to the remote store. producerId/producerSeq
// disambiguate cross-producer interleaving at the server; the server-side
// delivery ledger (stage 4, section E) dedups by (workspace, namespace, id)
// with payloadHash equality.
export type OutboxRecord = {
  id: string;
  workspaceId: string;
  namespace: OutboxTargetNamespace;
  kind: string;
  payload: unknown;
  // The exact canonical JSON bytes the payloadHash was computed from — the
  // remote target stores THESE (never re-serializes `payload`), so a stateful
  // toJSON can never make the stored row and the delivery-ledger hash disagree.
  canonical: string;
  payloadHash: string;
  producerId: string;
  producerSeq: number;
  enqueuedAt: number;
  artifact: { digest: string; size: number } | null;
};

export type DeliverResult = 'committed' | 'duplicate';

// Stage 4 plugs its PG delivery-ledger in here. deliver resolves 'committed'
// (first delivery) or 'duplicate' (server already holds this id with an
// identical payload hash — acked-equivalent, the drain advances); it throws
// ConflictError when the server holds the id with a DIFFERENT hash (genuine
// conflict — the entry parks its namespace) and any other error for a
// transient failure (retried with backoff up to the attempt cap). The
// optional preflight runs ONCE per drain batch before any remote I/O (object
// bytes included) — the factory composes binding + marker revalidation here,
// so a re-pointed database or swapped bucket refuses the whole batch.
export interface RemoteTarget {
  deliver(record: OutboxRecord): Promise<DeliverResult>;
  preflight?(): Promise<void>;
}

// Remote byte sink for artifact entries (stage 4: the S3 CreateOnlyObjectStore
// leg). Publication is object-first / index-last: the drain confirms this
// delivery before the index record ever reaches the RemoteTarget, so a
// committed index row always implies readable, digest-verified bytes.
// Content-addressed and idempotent: 'exists' when the digest is already
// stored; throws ConflictError if stored bytes mismatch the digest.
export interface ObjectTarget {
  deliver(digest: string, bytes: Buffer): Promise<'stored' | 'exists'>;
}

export class SpoolQuotaError extends PersistenceError {
  readonly activeBytes: number;
  readonly maxBytes: number;
  constructor(activeBytes: number, incoming: number, maxBytes: number) {
    super(
      `outbox spool quota exceeded: ${activeBytes} bytes active + ${incoming} incoming > ${maxBytes} max — drain the outbox (restore connectivity) before staging more artifacts`,
    );
    this.activeBytes = activeBytes;
    this.maxBytes = maxBytes;
  }
}

export type OutboxEntryStatus = 'queued' | 'acked' | 'failed-permanent';
export type PermanentFailureKind = 'conflict' | 'attempts-exhausted';

export type OutboxEntryState = {
  entryId: string;
  namespace: OutboxTargetNamespace;
  kind: string;
  payload: unknown;
  payloadHash: string;
  spoolDigest: string | null;
  spoolSize: number;
  producerId: string;
  producerSeq: number;
  enqueuedAt: number;
  status: OutboxEntryStatus;
  attempts: number;
  // Recorded TRANSPORT failures only — the poison cap counts these, so a
  // semantic halt (workspace mismatch) or a crash mid-delivery never burns
  // attempts toward failed-permanent.
  transientFailures: number;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  failure: { class: 'transient' | 'permanent'; kind: PermanentFailureKind | null; reason: string } | null;
  ackResult: DeliverResult | null;
};

export type OutboxNamespaceState = {
  namespace: OutboxTargetNamespace;
  // Undelivered entries (queued + the parked poison entry) in producerSeq
  // order — the strict drain order.
  pending: OutboxEntryState[];
  ackedCount: number;
  parked: boolean;
  poisonEntryId: string | null;
  headReadyAt: number | null;
};

// Doctor-visible derived state: recomputed from the segments on every call,
// never persisted as truth (section D derived-state rule).
export type OutboxFold = {
  namespaces: Partial<Record<OutboxTargetNamespace, OutboxNamespaceState>>;
  entries: Map<string, OutboxEntryState>;
  spool: { activeBytes: number; maxBytes: number };
};

export type EnqueueInput = {
  namespace: OutboxTargetNamespace;
  id: string;
  kind: string;
  payload: unknown;
};

export type EnqueueResult = { outcome: 'queued'; id: string; producerSeq: number };
export type EnqueueArtifactResult = EnqueueResult & { digest: string };

// kind distinguishes a KNOWN, operator-fixable config/auth/identity halt
// ('config' — grant, credential, bucket policy, URL) from a fail-closed
// 'unknown' halt (a programming/schema defect such as PG 42703 or a stray
// TypeError). Both stop the drain without consuming an attempt or poisoning;
// 'unknown' is a doctor-visible ERROR (a bug to investigate), never a benign
// outage that would silently degrade.
// `error` carries the exact caught error the classifier saw, so an API
// boundary (settle) can re-surface it fail-closed instead of masking a
// programming/semantic defect as an ordinary queued outage.
export type DrainHalt = { entryId: string; reason: string; kind: 'config' | 'unknown'; error: unknown };

export type DrainNamespaceReport = {
  delivered: number;
  remaining: number;
  parked: boolean;
  poisonEntryId: string | null;
  waitingUntil: number | null;
  // Semantic refusal (WorkspaceMismatch / VersionSkew / NotConfigured), a KNOWN
  // config/auth halt, OR a fail-closed 'unknown' defect from the remote: the
  // drain HALTED — nothing consumed, nothing parked. A 'config' halt heals once
  // the target is fixed (grant/credentials/URL); an 'unknown' halt is a
  // doctor-visible bug that must be investigated, never retried into poison.
  halted: DrainHalt | null;
};
export type DrainReport = {
  namespaces: Partial<Record<OutboxTargetNamespace, DrainNamespaceReport>>;
  // A failed checkpoint.json write after successful remote commits is doctor-
  // visible here — never an exception (the checkpoint is recomputable).
  checkpointWarning: string | null;
};

export type CommittedRef = { id: string; payloadHash: string };
export type OverlayConflict = { entry: OutboxEntryState; committedHash: string };
export type OverlayResult = { queued: OutboxEntryState[]; conflicts: OverlayConflict[] };

// checkpoint.json: checksummed audit digest of the last-acked producerSeq per
// namespace. Purely derived — a torn or invalid file is discarded and
// recomputed from the segments; it is never trusted over them.
export type OutboxCheckpoint = {
  producerId: string;
  lastAcked: Partial<Record<OutboxTargetNamespace, number>>;
  checksum: string;
};

export type LocalOutboxOptions = {
  ledger: LocalLedger;
  attemptCap?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitterRatio?: number;
  maxSpoolBytes?: number;
  now?: () => number;
  rng?: () => number;
};

type EnqueuedPayload = {
  entryId: string;
  namespace: OutboxTargetNamespace;
  kind: string;
  payload: unknown;
  payloadHash: string;
  spoolDigest: string | null;
  spoolSize: number;
};

type AttemptPayload = { entryId: string; attempt: number; at: number };
type AckedPayload = { entryId: string; result: DeliverResult };
type FailedPayload = {
  entryId: string;
  attempt: number;
  class: 'transient' | 'permanent';
  kind: PermanentFailureKind | null;
  reason: string;
  nextRetryAt: number | null;
};

function isTargetNamespace(value: string): value is OutboxTargetNamespace {
  return (TARGET_NAMESPACES as readonly string[]).includes(value);
}

export function payloadHashOf(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

export class LocalOutbox {
  readonly ledger: LocalLedger;
  private readonly attemptCap: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitterRatio: number;
  private readonly maxSpoolBytes: number;
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(opts: LocalOutboxOptions) {
    this.ledger = opts.ledger;
    this.attemptCap = opts.attemptCap ?? DEFAULT_ATTEMPT_CAP;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.maxSpoolBytes = opts.maxSpoolBytes ?? DEFAULT_MAX_SPOOL_BYTES;
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    if (this.attemptCap < 1) throw new InvalidRecordError('attemptCap must be at least 1');
  }

  spoolDir(): string {
    return join(this.ledger.treeDir, 'spool');
  }

  private checkpointPath(): string {
    return join(this.ledger.namespaceDir(OUTBOX_NAMESPACE), 'checkpoint.json');
  }

  // ---------- fold ----------

  fold(): OutboxFold {
    const { records } = this.ledger.scan(OUTBOX_NAMESPACE);
    const entries = new Map<string, OutboxEntryState>();
    for (const rec of records) {
      switch (rec.kind) {
        case 'outbox-enqueued': {
          const p = rec.payload as EnqueuedPayload;
          if (entries.has(p.entryId)) break;
          entries.set(p.entryId, {
            entryId: p.entryId,
            namespace: p.namespace,
            kind: p.kind,
            payload: p.payload,
            payloadHash: p.payloadHash,
            spoolDigest: p.spoolDigest,
            spoolSize: p.spoolSize,
            producerId: rec.producerId,
            producerSeq: rec.producerSeq,
            enqueuedAt: rec.ts,
            status: 'queued',
            attempts: 0,
            transientFailures: 0,
            lastAttemptAt: null,
            nextRetryAt: null,
            failure: null,
            ackResult: null,
          });
          break;
        }
        case 'outbox-attempt': {
          const p = rec.payload as AttemptPayload;
          const e = this.foldEntry(entries, p.entryId, rec);
          e.attempts += 1;
          e.lastAttemptAt = p.at;
          break;
        }
        case 'outbox-acked': {
          const p = rec.payload as AckedPayload;
          const e = this.foldEntry(entries, p.entryId, rec);
          e.status = 'acked';
          e.ackResult = p.result;
          e.failure = null;
          e.nextRetryAt = null;
          break;
        }
        case 'outbox-failed': {
          const p = rec.payload as FailedPayload;
          const e = this.foldEntry(entries, p.entryId, rec);
          if (e.status === 'acked') break;
          e.failure = { class: p.class, kind: p.kind, reason: p.reason };
          if (p.class === 'permanent') {
            e.status = 'failed-permanent';
            e.nextRetryAt = null;
          } else {
            e.transientFailures += 1;
            e.nextRetryAt = p.nextRetryAt;
          }
          break;
        }
        default:
          throw new InvalidRecordError(`outbox ledger record ${rec.id} has unknown kind '${rec.kind}'`);
      }
    }
    const namespaces: Partial<Record<OutboxTargetNamespace, OutboxNamespaceState>> = {};
    let activeBytes = 0;
    const activeDigests = new Set<string>();
    for (const entry of entries.values()) {
      let ns = namespaces[entry.namespace];
      if (!ns) {
        ns = {
          namespace: entry.namespace,
          pending: [],
          ackedCount: 0,
          parked: false,
          poisonEntryId: null,
          headReadyAt: null,
        };
        namespaces[entry.namespace] = ns;
      }
      if (entry.status === 'acked') {
        ns.ackedCount += 1;
        continue;
      }
      ns.pending.push(entry);
      if (entry.spoolDigest !== null && !activeDigests.has(entry.spoolDigest)) {
        activeDigests.add(entry.spoolDigest);
        activeBytes += entry.spoolSize;
      }
    }
    for (const ns of Object.values(namespaces)) {
      ns.pending.sort((a, b) => a.producerSeq - b.producerSeq);
      const poison = ns.pending.find((e) => e.status === 'failed-permanent');
      if (poison) {
        ns.parked = true;
        ns.poisonEntryId = poison.entryId;
      }
      const head = ns.pending[0];
      if (head && !ns.parked) ns.headReadyAt = head.nextRetryAt;
    }
    return { namespaces, entries, spool: { activeBytes, maxBytes: this.maxSpoolBytes } };
  }

  private foldEntry(entries: Map<string, OutboxEntryState>, entryId: string, rec: LedgerRecord): OutboxEntryState {
    const e = entries.get(entryId);
    if (!e) {
      throw new InvalidRecordError(
        `outbox ledger record ${rec.id} (${rec.kind}) references unknown entry ${entryId} — enqueued event missing`,
      );
    }
    return e;
  }

  // ---------- enqueue ----------

  enqueue(input: EnqueueInput): EnqueueResult {
    return this.enqueueInternal(input, null, null);
  }

  // fold + quota check + staging + enqueue run under a dedicated quota lock so
  // two processes cannot both observe free space and jointly exceed the cap.
  enqueueArtifact(input: EnqueueInput, bytes: Uint8Array): EnqueueArtifactResult {
    const digest = sha256Hex(bytes);
    this.ledger.meta();
    const outboxDir = this.ledger.namespaceDir(OUTBOX_NAMESPACE);
    this.ledger.ensureDir(outboxDir);
    return this.ledger.withLock(outboxDir, '.quota.lock', () => {
      const fold = this.fold();
      const alreadyActive = [...fold.entries.values()].some(
        (e) => e.status !== 'acked' && e.spoolDigest === digest,
      );
      if (!alreadyActive && fold.spool.activeBytes + bytes.byteLength > this.maxSpoolBytes) {
        throw new SpoolQuotaError(fold.spool.activeBytes, bytes.byteLength, this.maxSpoolBytes);
      }
      this.stageSpool(digest, bytes);
      const res = this.enqueueInternal(input, digest, bytes.byteLength);
      return { ...res, digest };
    });
  }

  private enqueueInternal(input: EnqueueInput, spoolDigest: string | null, spoolSize: number | null): EnqueueResult {
    if (!isTargetNamespace(input.namespace)) {
      throw new InvalidRecordError(
        `'${String(input.namespace)}' is not a spoolable namespace (expected ${TARGET_NAMESPACES.join(' | ')})`,
      );
    }
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new InvalidRecordError('entry id is required');
    }
    if (typeof input.kind !== 'string' || input.kind.length === 0) {
      throw new InvalidRecordError('entry kind is required');
    }
    if (NON_SPOOLABLE_KINDS.has(input.kind)) {
      throw new BackendUnavailableError(
        `'${input.kind}' records require the live store and are never spooled (owner decision 8) — restore connectivity and retry`,
      );
    }
    // Snapshot ONCE here so the ledger stores the plain (toJSON-resolved) value
    // and the hash derives from the same canonical bytes — never the original
    // object re-canonicalized later (finding: outbox double-serialization).
    const snap = snapshotPayload(input.payload);
    const payload: EnqueuedPayload = {
      entryId: input.id,
      namespace: input.namespace,
      kind: input.kind,
      payload: snap.value,
      payloadHash: sha256Hex(snap.canonical),
      spoolDigest,
      spoolSize: spoolSize ?? 0,
    };
    const eventId = computeRecordId(this.ledger.workspaceId, OUTBOX_NAMESPACE, {
      e: 'enqueued',
      namespace: input.namespace,
      entryId: input.id,
    });
    const res = this.ledger.append(OUTBOX_NAMESPACE, { id: eventId, kind: 'outbox-enqueued', payload });
    return { outcome: 'queued', id: input.id, producerSeq: res.record.producerSeq };
  }

  private stageSpool(digest: string, bytes: Uint8Array): void {
    const dir = this.spoolDir();
    this.ledger.meta();
    this.ledger.ensureDir(dir);
    const path = join(dir, digest);
    if (assertRegularFileIfExists(path) !== null) {
      if (sha256Hex(readFileSync(path)) !== digest) {
        throw new ConflictError(digest, 'spooled artifact bytes do not match their digest');
      }
      // Orphan re-adoption (crash after staging, before enqueue): re-fsync the
      // blob dir so the directory entry is provably durable before the outbox
      // event that references it is appended.
      fsyncDir(dir);
      return;
    }
    writeBlobSync(dir, digest, bytes);
  }

  // Digest-verified spool access for queued-overlay artifact reads: null when
  // no bytes are staged under this digest.
  spoolBytes(digest: string): Buffer | null {
    const path = join(this.spoolDir(), digest);
    if (assertRegularFileIfExists(path) === null) return null;
    const bytes = readFileSync(path);
    if (sha256Hex(bytes) !== digest) {
      throw new InvalidRecordError(`spooled artifact at ${path} does not match its digest`);
    }
    return bytes;
  }

  private readSpool(entry: OutboxEntryState): Buffer {
    const path = join(this.spoolDir(), entry.spoolDigest!);
    assertRegularFileIfExists(path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new InvalidRecordError(
        `outbox entry ${entry.entryId} references spooled bytes missing at ${path} — the staging invariant is broken`,
      );
    }
    if (sha256Hex(bytes) !== entry.spoolDigest) {
      throw new InvalidRecordError(`spooled artifact at ${path} does not match its digest`);
    }
    return bytes;
  }

  // ---------- drain ----------

  private recordOf(entry: OutboxEntryState): OutboxRecord {
    // entry.payload is already the plain snapshot value (toJSON resolved at
    // enqueue), so canonicalJson here is deterministic and byte-identical to
    // the canonical the payloadHash was computed from — no re-invocation risk.
    return {
      id: entry.entryId,
      workspaceId: this.ledger.workspaceId,
      namespace: entry.namespace,
      kind: entry.kind,
      payload: entry.payload,
      canonical: canonicalJson(entry.payload),
      payloadHash: entry.payloadHash,
      producerId: entry.producerId,
      producerSeq: entry.producerSeq,
      enqueuedAt: entry.enqueuedAt,
      artifact: entry.spoolDigest !== null ? { digest: entry.spoolDigest, size: entry.spoolSize } : null,
    };
  }

  private backoffDelayMs(attempt: number): number {
    const base = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
    return Math.round(base * (1 + this.jitterRatio * this.rng()));
  }

  // identity distinguishes the two failure sources: drain failures are unique
  // per (entryId, attempt); overlay-detected conflicts are one-per-entry
  // ({e:'conflict'}) so they can never collide with a prior transient failure
  // recorded at the same attempt number.
  private appendFailure(identity: unknown, payload: FailedPayload): void {
    const eventId = computeRecordId(this.ledger.workspaceId, OUTBOX_NAMESPACE, identity);
    this.ledger.append(OUTBOX_NAMESPACE, { id: eventId, kind: 'outbox-failed', payload });
  }

  private isDue(entry: OutboxEntryState): boolean {
    return (
      entry.status !== 'failed-permanent' &&
      (entry.nextRetryAt === null || entry.nextRetryAt <= this.now())
    );
  }

  // A transport-unverified preflight (#318 R4 finding 3): nothing delivered,
  // every namespace's entries remain queued exactly where they were. `halted`
  // is null — a transport skip is NOT a fail-closed halt, so settle degrades it
  // to a silent {outcome:'queued'} (round-2: transport ⇒ queue, never a hard
  // error). No checkpoint write: no acks occurred, so derived state is unchanged.
  private preflightSkippedReport(fold: OutboxFold, names: OutboxTargetNamespace[]): DrainReport {
    const namespaces: Partial<Record<OutboxTargetNamespace, DrainNamespaceReport>> = {};
    for (const name of names) {
      const ns = fold.namespaces[name]!;
      namespaces[name] = {
        delivered: 0,
        remaining: ns.pending.length,
        parked: ns.parked,
        poisonEntryId: ns.poisonEntryId,
        waitingUntil: null,
        halted: null,
      };
    }
    return { namespaces, checkpointWarning: null };
  }

  async drain(target: RemoteTarget, opts: { objects?: ObjectTarget; namespace?: OutboxTargetNamespace } = {}): Promise<DrainReport> {
    const fold = this.fold();
    const report: DrainReport = { namespaces: {}, checkpointWarning: null };
    const names = (Object.keys(fold.namespaces) as OutboxTargetNamespace[])
      .filter((n) => opts.namespace === undefined || n === opts.namespace)
      .sort();
    // Batch preflight (binding + marker revalidation when the factory wired
    // it): runs once, BEFORE any remote I/O — object bytes included. A
    // refusal propagates with nothing consumed and nothing poisoned.
    const anyDue = names.some((n) => {
      const ns = fold.namespaces[n]!;
      const head = ns.pending[0];
      return !ns.parked && head !== undefined && this.isDue(head);
    });
    if (anyDue && target.preflight) {
      try {
        await target.preflight();
      } catch (err) {
        // The batch could not POSITIVELY revalidate binding + marker before any
        // remote I/O. A classified transport outage means the store is simply
        // unreachable right now — deliver NOTHING (every entry stays queued, no
        // commit, no poison): a PG-only (hitl/run) delivery must never commit
        // while the marker went unverified on a transport blip (#318 R4 finding
        // 3). Any other failure — a semantic mismatch, a config/auth halt, or an
        // unknown defect — is fail-closed: surface it (the entries remain
        // durably queued because the drain delivered nothing).
        if (classifyDeliveryError(err) !== 'transport') throw err;
        return this.preflightSkippedReport(fold, names);
      }
    }
    for (const name of names) {
      const ns = fold.namespaces[name]!;
      let delivered = 0;
      let parked = ns.parked;
      let poisonEntryId = ns.poisonEntryId;
      let waitingUntil: number | null = null;
      let halted: DrainHalt | null = null;
      // Strictly in producerSeq order; the head blocks the line — never skip.
      for (const entry of ns.pending) {
        if (entry.status === 'failed-permanent') {
          parked = true;
          poisonEntryId = entry.entryId;
          break;
        }
        if (entry.nextRetryAt !== null && entry.nextRetryAt > this.now()) {
          waitingUntil = entry.nextRetryAt;
          break;
        }
        if (entry.spoolDigest !== null && !opts.objects) {
          throw new InvalidRecordError(
            `outbox entry ${entry.entryId} carries artifact bytes but drain was called without an object target`,
          );
        }
        const attempt = entry.attempts + 1;
        const attemptEventId = computeRecordId(this.ledger.workspaceId, OUTBOX_NAMESPACE, {
          e: 'attempt',
          entryId: entry.entryId,
          attempt,
        });
        // Recorded BEFORE the network call so a crash mid-delivery leaves
        // evidence; replay dedups server-side, never locally re-acks. Only
        // recorded TRANSIENT failures count toward the poison cap.
        this.ledger.append(OUTBOX_NAMESPACE, {
          id: attemptEventId,
          kind: 'outbox-attempt',
          payload: { entryId: entry.entryId, attempt, at: this.now() } satisfies AttemptPayload,
        });
        try {
          if (entry.spoolDigest !== null) {
            // Object-first / index-last: bytes are confirmed at the object
            // target before the index record is delivered.
            await opts.objects!.deliver(entry.spoolDigest, this.readSpool(entry));
          }
          const result = await target.deliver(this.recordOf(entry));
          if (result !== 'committed' && result !== 'duplicate') {
            throw new InvalidRecordError(`remote target returned invalid result '${String(result)}'`);
          }
          const ackedEventId = computeRecordId(this.ledger.workspaceId, OUTBOX_NAMESPACE, {
            e: 'acked',
            entryId: entry.entryId,
          });
          this.ledger.append(OUTBOX_NAMESPACE, {
            id: ackedEventId,
            kind: 'outbox-acked',
            payload: { entryId: entry.entryId, result } satisfies AckedPayload,
          });
          delivered += 1;
        } catch (err) {
          // A local invariant violation (bad remote result shape, missing spool
          // bytes) is a programming bug — surface it out of the drain loudly.
          if (err instanceof InvalidRecordError) throw err;
          if (err instanceof ConflictError) {
            // Genuine conflict: the server holds this id with a different
            // payload hash. Parks the namespace — order is never silently
            // violated by skipping.
            this.appendFailure({ e: 'failed', entryId: entry.entryId, attempt }, {
              entryId: entry.entryId,
              attempt,
              class: 'permanent',
              kind: 'conflict',
              reason: err.message,
              nextRetryAt: null,
            });
            parked = true;
            poisonEntryId = entry.entryId;
            break;
          }
          const cls = classifyDeliveryError(err);
          if (cls !== 'transport') {
            // 'halt' (KNOWN config/auth/identity refusal — wrong workspace,
            // revoked grant, denied bucket, unmigrated target) OR 'unknown' (a
            // programming/schema defect: PG 42703, a stray TypeError). BOTH stop
            // the drain WITHOUT consuming an attempt or poisoning; fixing a
            // 'config' halt heals the queue, an 'unknown' halt is a doctor-
            // visible bug — never a benign outage retried into poison.
            halted = {
              entryId: entry.entryId,
              reason: (err as Error).message,
              kind: cls === 'unknown' ? 'unknown' : 'config',
              error: err,
            };
            break;
          }
          // Genuine transport failure: retry with backoff, poison at the cap.
          if (entry.transientFailures + 1 >= this.attemptCap) {
            this.appendFailure({ e: 'failed', entryId: entry.entryId, attempt }, {
              entryId: entry.entryId,
              attempt,
              class: 'permanent',
              kind: 'attempts-exhausted',
              reason: (err as Error).message,
              nextRetryAt: null,
            });
            parked = true;
            poisonEntryId = entry.entryId;
          } else {
            // Backoff scales with prior TRANSIENT failures only — surfaced
            // config/unknown halts record an attempt but must not inflate the
            // next genuine transport retry's delay.
            const nextRetryAt = this.now() + this.backoffDelayMs(entry.transientFailures + 1);
            this.appendFailure({ e: 'failed', entryId: entry.entryId, attempt }, {
              entryId: entry.entryId,
              attempt,
              class: 'transient',
              kind: null,
              reason: (err as Error).message,
              nextRetryAt,
            });
            waitingUntil = nextRetryAt;
          }
          break;
        }
      }
      report.namespaces[name] = {
        delivered,
        remaining: ns.pending.length - delivered,
        parked,
        poisonEntryId,
        waitingUntil,
        halted,
      };
    }
    try {
      this.writeCheckpoint();
    } catch (err) {
      report.checkpointWarning = `checkpoint.json write failed (recomputable derived state; commits unaffected): ${(err as Error).message}`;
    }
    return report;
  }

  // Tri-state write front door (owner decision 8): the record is durably
  // enqueued first, then the namespace drains in strict order — 'committed'
  // when this entry (and everything queued ahead of it) delivered, 'queued'
  // otherwise. A live write can therefore never overtake older queued records.
  async writeThrough(
    input: EnqueueInput,
    target: RemoteTarget,
    opts: { objects?: ObjectTarget } = {},
  ): Promise<WriteOutcome> {
    this.enqueue(input);
    return await this.settle(input, target, opts);
  }

  async writeThroughArtifact(
    input: EnqueueInput,
    bytes: Uint8Array,
    target: RemoteTarget,
    opts: { objects: ObjectTarget },
  ): Promise<WriteOutcome & { digest: string }> {
    const { digest } = this.enqueueArtifact(input, bytes);
    const outcome = await this.settle(input, target, opts);
    return { ...outcome, digest };
  }

  private async settle(
    input: EnqueueInput,
    target: RemoteTarget,
    opts: { objects?: ObjectTarget },
  ): Promise<WriteOutcome> {
    const report = await this.drain(target, { namespace: input.namespace, objects: opts.objects });
    const entry = this.fold().entries.get(input.id);
    if (entry?.status === 'acked') return { outcome: 'committed', id: input.id };
    // The durable queue entry is preserved above (enqueue appended it; a halt
    // neither acks nor poisons). If the drain HALTED on a config/auth ('config')
    // or programming/schema ('unknown') defect — NOT a plain transport outage,
    // which never sets `halted` — the write did not merely queue behind an
    // outage. SURFACE the classified error fail-closed (#318 R4 finding 2) so
    // the caller learns it did not commit; a later drain re-verifies and drains
    // once the defect is fixed. A transport skip/backoff leaves halted null and
    // degrades silently to 'queued'.
    const halted = report.namespaces[input.namespace]?.halted;
    if (halted) throw halted.error;
    return { outcome: 'queued', id: input.id };
  }

  // ---------- overlay reads ----------

  // Union-by-id with payload-hash equality for reads/counts: a queued entry
  // whose id is already committed with an identical hash is excluded (no
  // double-count); an id collision with a different hash is a Conflict —
  // surfaced, durably parked, and still counted, never silently dropped.
  overlay(namespace: OutboxTargetNamespace, committed: readonly CommittedRef[]): OverlayResult {
    const byId = new Map(committed.map((c) => [c.id, c.payloadHash]));
    const ns = this.fold().namespaces[namespace];
    const queued: OutboxEntryState[] = [];
    const conflicts: OverlayConflict[] = [];
    for (const entry of ns?.pending ?? []) {
      const committedHash = byId.get(entry.entryId);
      if (committedHash === undefined) {
        queued.push(entry);
      } else if (committedHash === entry.payloadHash) {
        continue;
      } else {
        this.appendFailure({ e: 'conflict', entryId: entry.entryId }, {
          entryId: entry.entryId,
          attempt: entry.attempts,
          class: 'permanent',
          kind: 'conflict',
          reason: `committed record ${entry.entryId} has payload hash ${committedHash}, queued entry has ${entry.payloadHash}`,
          nextRetryAt: null,
        });
        conflicts.push({ entry, committedHash });
      }
    }
    return { queued, conflicts };
  }

  // Queued overlay without a remote view — the allowPartial read path.
  overlayOnly(namespace: OutboxTargetNamespace): OutboxEntryState[] {
    return this.fold().namespaces[namespace]?.pending ?? [];
  }

  // Stable group anchors (finding: unstable grouped run cursor). For a namespace,
  // the MIN (producerId, producerSeq) over ALL entries — queued, acked, OR
  // failed — grouped by keyOf(entry). The ledger is append-only, so an entry's
  // position never changes; a group's anchor is therefore INVARIANT under
  // acknowledgement of its earliest entry. A grouped listing (e.g. runs) that
  // pages by this anchor cannot re-emit a group whose head acks mid-pagination:
  // the anchor stays <= the cursor it was returned under. Entries whose keyOf
  // returns null are skipped.
  overlayGroupAnchors(
    namespace: OutboxTargetNamespace,
    keyOf: (e: OutboxEntryState) => string | null,
  ): Map<string, OverlayPosition> {
    const anchors = new Map<string, OverlayPosition>();
    for (const e of this.fold().entries.values()) {
      if (e.namespace !== namespace) continue;
      const key = keyOf(e);
      if (key === null) continue;
      const pos: OverlayPosition = { producerId: e.producerId, producerSeq: e.producerSeq };
      const cur = anchors.get(key);
      if (cur === undefined || pos.producerId < cur.producerId || (pos.producerId === cur.producerId && pos.producerSeq < cur.producerSeq)) {
        anchors.set(key, pos);
      }
    }
    return anchors;
  }

  // Count helper stage 4's stores consume. Strict mode (default): a remote
  // failure surfaces as BackendUnavailableError — never a silent local-only
  // answer. allowPartial: the result is the outbox overlay only, flagged
  // partial: true (section I).
  async countWithOverlay(
    namespace: OutboxTargetNamespace,
    fetchCommitted: () => Promise<readonly CommittedRef[]>,
    opts: { allowPartial?: boolean } = {},
  ): Promise<CountResult> {
    let committed: readonly CommittedRef[];
    try {
      committed = await fetchCommitted();
    } catch (err) {
      // Only a classified transport outage degrades to a partial (overlay-only)
      // count (#318 R4 finding 2). A semantic mismatch (workspace / version), a
      // config/auth halt, or an unrecognized 'unknown' programming/schema
      // defect (a bare Error included) all fail closed — overlaying against a
      // wrong-workspace, version-skewed, or defect-target answer is never
      // allowed (section I).
      if (opts.allowPartial === true && mayDegradeToPartial(err)) {
        return { committed: 0, queued: this.overlayOnly(namespace).length, partial: true };
      }
      if (err instanceof PersistenceError) throw err;
      throw new BackendUnavailableError(`remote count failed: ${(err as Error).message}`);
    }
    const { queued, conflicts } = this.overlay(namespace, committed);
    return { committed: committed.length, queued: queued.length + conflicts.length, partial: false };
  }

  // ---------- checkpoint ----------

  private checkpointChecksum(body: Omit<OutboxCheckpoint, 'checksum'>): string {
    return sha256Hex(canonicalJson(body));
  }

  private computeCheckpoint(fold: OutboxFold): OutboxCheckpoint {
    const lastAcked: Partial<Record<OutboxTargetNamespace, number>> = {};
    for (const entry of fold.entries.values()) {
      if (entry.status !== 'acked') continue;
      const cur = lastAcked[entry.namespace];
      if (cur === undefined || entry.producerSeq > cur) lastAcked[entry.namespace] = entry.producerSeq;
    }
    const body = { producerId: this.ledger.meta().producerId, lastAcked };
    return { ...body, checksum: this.checkpointChecksum(body) };
  }

  private readCheckpointFile(): OutboxCheckpoint | null {
    let raw: string;
    try {
      raw = readFileSync(this.checkpointPath(), 'utf8');
    } catch {
      return null;
    }
    let parsed: OutboxCheckpoint;
    try {
      parsed = JSON.parse(raw) as OutboxCheckpoint;
    } catch {
      return null;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.producerId !== 'string' ||
      parsed.lastAcked === null ||
      typeof parsed.lastAcked !== 'object' ||
      typeof parsed.checksum !== 'string' ||
      parsed.checksum !== this.checkpointChecksum({ producerId: parsed.producerId, lastAcked: parsed.lastAcked })
    ) {
      return null;
    }
    return parsed;
  }

  // Always recomputed from the segments and compared against the file: a torn,
  // invalid, or stale checkpoint.json is discarded and rewritten atomically.
  checkpoint(): OutboxCheckpoint {
    return this.writeCheckpoint();
  }

  private writeCheckpoint(): OutboxCheckpoint {
    const truth = this.computeCheckpoint(this.fold());
    const onDisk = this.readCheckpointFile();
    if (onDisk === null || onDisk.checksum !== truth.checksum) {
      const dir = this.ledger.namespaceDir(OUTBOX_NAMESPACE);
      this.ledger.ensureDir(dir);
      atomicWriteFileSync(this.checkpointPath(), JSON.stringify(truth, null, 2) + '\n');
    }
    return truth;
  }
}
