import { join } from 'node:path';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  computeRecordId,
  sha256Hex,
  type ArtifactDeclaration,
  type ArtifactMeta,
  type ArtifactPutResult,
  type ArtifactRecord,
  type ArtifactStore,
  type CountResult,
  type Cursor,
  type DeclarationPutResult,
  type ExternalArtifactInput,
  type HitlDecisionEnvelope,
  type HitlDecisionInput,
  type HitlDecisionOutcome,
  type HitlExpiryCandidate,
  type HitlGenerationSummary,
  type HitlReplaceInput,
  type HitlRequestEnvelope,
  type HitlRequestFilter,
  type HitlRequestInput,
  type HitlStore,
  type HitlSupersedesRef,
  type HitlVersionRecord,
  type HitlWriteOutcome,
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
  canDecide,
  deriveRequestState,
  type HitlDecisionRow,
  type HitlExpectedHead,
  type HitlRequestState,
  type HitlSubmissionState,
  type HitlSupersession,
  type HitlVersionRow,
} from '../hitl-machine.ts';
import {
  assertExpectedHead,
  conflictFromPlan,
  decisionId,
  decisionRefusal,
  finalizeSubmissionPlan,
  normalizeDecision,
  normalizeFunctionName,
  planFor,
  prepareSubmission,
  systemExpiryDecision,
  systemExpiryId,
  DEFAULT_HITL_EXPIRY_POLICY,
  type HitlExpiryPolicy,
  type HitlPayloadOffload,
  type NormalizedDecision,
  type PreparedSubmission,
} from '../hitl-store.ts';
import { ensureLocalHitlV2, readHitlMigrationEpoch } from '../hitl-local-migrate.ts';
import { maybeSweep } from '../hitl-sweep.ts';
import {
  HITL_DECISION_KIND,
  HITL_PAYLOAD_DIR,
  HITL_VERSION_KIND,
  hitlVersionRecordId,
  type LocalHitlDecisionObservations,
  type LocalHitlVersionObservations,
  type LocalHitlDecisionPayload,
  type LocalHitlVersionPayload,
} from '../hitl-local-records.ts';
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
  type AppendInput,
  type LedgerRecord,
  type LogicalRecord,
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

// The unique logical ordering position of a local record: the compound envelope
// primitive gives every child of one atomic append the SAME seq, so a scalar
// seq is NOT an ordering key — (seq, pos) is.
type OrderKey = { seq: number; pos: number };

function compareOrder(a: OrderKey, b: OrderKey): number {
  return a.seq - b.seq || a.pos - b.pos;
}

// Committed-domain pagination shared by the local stores: the watermark is the
// namespace's committed seq captured at page 1; later pages never surface rows
// above it, so a fresh commit (or an overlay ack) mid-pagination cannot leak
// into an in-flight listing.
//
// The cursor is a TUPLE (round-2 finding 2). With a scalar `seq >` cursor every
// batch sibling except the one that ended a page was skipped forever: two v1
// requests converted in ONE batch share a seq, so page 2 (seq > committed)
// returned nothing and the second request was unreachable. A cursor without
// `committedPos` is read as "the whole seq was consumed", which is exactly what
// the scalar form meant.
function pageBySeq<T>(
  items: ReadonlyArray<{ order: OrderKey; item: T }>,
  cursor: Cursor | undefined,
  limit: number,
  namespaceLastSeq: number,
): Page<T> {
  const watermark = cursor?.watermark ?? namespaceLastSeq;
  const after: OrderKey = {
    seq: cursor?.committed ?? 0,
    pos: cursor?.committedPos ?? Number.MAX_SAFE_INTEGER,
  };
  const eligible = items.filter((e) => e.order.seq <= watermark && compareOrder(e.order, after) > 0);
  const taken = eligible.slice(0, limit);
  const more = eligible.length > taken.length;
  const last = taken[taken.length - 1];
  return {
    items: taken.map((e) => e.item),
    cursor:
      more && last !== undefined
        ? { watermark, committed: last.order.seq, committedPos: last.order.pos, overlay: null }
        : null,
    partial: false,
  };
}

// ---------- hitl (#319: the state machine over the local ledger) ----------

type ProjectedVersion = LocalHitlVersionPayload & { createdAt: number; seq: number; pos: number };
type ProjectedDecision = LocalHitlDecisionPayload & { id: string; decidedAt: number; seq: number; pos: number };

type HitlProjection = {
  versions: Map<string, ProjectedVersion[]>;
  decisions: Map<string, ProjectedDecision[]>;
  // requestId -> the (generation, version) pairs some other group superseded.
  superseded: Map<string, HitlSupersession[]>;
  lastSeq: number;
};

function projectHitl(records: readonly LogicalRecord[], lastSeq: number): HitlProjection {
  const versions = new Map<string, ProjectedVersion[]>();
  const decisions = new Map<string, ProjectedDecision[]>();
  const superseded = new Map<string, HitlSupersession[]>();
  for (const rec of records) {
    if (rec.kind === HITL_VERSION_KIND) {
      const p = rec.payload as LocalHitlVersionPayload;
      const obs = (rec.observations ?? {}) as Partial<LocalHitlVersionObservations>;
      const list = versions.get(p.requestId) ?? [];
      // `createdAt` is the time the REQUEST was created, which is the record's
      // own timestamp for a live write but a preserved observation for a record
      // the v1→v2 conversion re-derived (round-2 finding 3: without it every
      // converted request reported the CONVERSION's timestamp, contradicting
      // the postgres backfill, which keeps the v1 created_at).
      // `functionName` is re-normalized at READ (round-3 finding 2): postgres
      // derives it from the stored payload on every read, so a stored record
      // whose field is empty/absent/not-a-string must resolve to the same
      // 'unknown' sentinel here or the two backends file one row under two
      // identities.
      list.push({
        ...p,
        functionName: normalizeFunctionName(p.functionName),
        createdAt: obs.createdAt ?? rec.ts,
        seq: rec.seq,
        pos: rec.pos,
      });
      versions.set(p.requestId, list);
      if (p.supersedes !== null && p.supersedes !== undefined) {
        const targets = superseded.get(p.supersedes.requestId) ?? [];
        targets.push({ generation: p.supersedes.generation, version: p.supersedes.version });
        superseded.set(p.supersedes.requestId, targets);
      }
      continue;
    }
    if (rec.kind === HITL_DECISION_KIND) {
      const p = rec.payload as LocalHitlDecisionPayload;
      const obs = (rec.observations ?? {}) as Partial<LocalHitlDecisionObservations>;
      const list = decisions.get(p.requestId) ?? [];
      list.push({ ...p, id: rec.id, decidedAt: obs.decidedAt ?? rec.ts, seq: rec.seq, pos: rec.pos });
      decisions.set(p.requestId, list);
    }
  }
  for (const list of versions.values()) {
    list.sort((a, b) => a.generation - b.generation || a.version - b.version);
  }
  return { versions, decisions, superseded, lastSeq };
}

function machineVersions(rows: readonly ProjectedVersion[]): HitlVersionRow[] {
  return rows.map((r) => ({
    requestId: r.requestId,
    requestKey: r.requestKey,
    generation: r.generation,
    version: r.version,
    action: r.action,
    actionKind: r.actionKind,
    target: r.target,
    targetHash: r.targetHash,
    packetHash: r.packetHash,
    canonicalizationVersion: r.canonicalizationVersion,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

function machineDecisions(rows: readonly ProjectedDecision[]): HitlDecisionRow[] {
  return rows.map((d) => ({
    id: d.id,
    generation: d.generation,
    version: d.requestVersion,
    status: d.status,
    decidedAt: d.decidedAt,
  }));
}

function stateOf(proj: HitlProjection, requestId: string, now: number): HitlRequestState {
  return deriveRequestState(
    machineVersions(proj.versions.get(requestId) ?? []),
    machineDecisions(proj.decisions.get(requestId) ?? []),
    now,
    proj.superseded.get(requestId) ?? [],
  );
}

function headRowOf(proj: HitlProjection, requestId: string): ProjectedVersion | null {
  const rows = proj.versions.get(requestId) ?? [];
  return rows.length === 0 ? null : rows[rows.length - 1]!;
}

// The group's CREATION position: the lowest (seq, pos) any of its versions
// holds. Immutable for the life of the group — which is what makes it a sound
// pagination anchor, unlike the head's position, which moves on every revision
// (round-3 finding 4). Unique per group, since (seq, pos) is unique per record.
function anchorOrderOf(rows: readonly ProjectedVersion[]): OrderKey {
  let anchor: OrderKey = { seq: rows[0]!.seq, pos: rows[0]!.pos };
  for (const row of rows) {
    const candidate = { seq: row.seq, pos: row.pos };
    if (compareOrder(candidate, anchor) < 0) anchor = candidate;
  }
  return anchor;
}

function envelopeOf(
  workspaceId: string,
  row: ProjectedVersion,
  state: HitlRequestState,
  body: string | null,
): HitlRequestEnvelope {
  const head = state.head!;
  return {
    id: row.requestId,
    workspaceId,
    requestKey: row.requestKey,
    generation: row.generation,
    version: row.version,
    functionName: row.functionName,
    title: row.title,
    action: row.action,
    actionKind: row.actionKind,
    target: row.target,
    targetHash: row.targetHash,
    packetHash: row.packetHash,
    canonicalizationVersion: row.canonicalizationVersion,
    contentHash: row.contentHash,
    body,
    payloadRef: row.payloadRef ?? null,
    expiresAt: row.expiresAt,
    summary: row.summary ?? null,
    warnings: row.warnings ?? null,
    sideEffects: row.sideEffects ?? null,
    choices: row.choices ?? null,
    originRunId: row.originRunId ?? null,
    originTaskId: row.originTaskId ?? null,
    requestingAgent: row.requestingAgent ?? null,
    supersedes: row.supersedes ?? null,
    status: head.status,
    nodeStatus: head.nodeStatus,
    terminalStatus: head.terminalStatus,
    deferred: head.deferred,
    sealed: head.sealed,
    superseded: head.superseded,
    authoritative: state.authoritative,
    createdAt: row.createdAt,
    seq: row.seq,
    queued: false,
  };
}

function versionRecordInput(workspaceId: string, payload: LocalHitlVersionPayload): AppendInput {
  return {
    id: hitlVersionRecordId(workspaceId, payload.requestId, payload.generation, payload.version),
    kind: HITL_VERSION_KIND,
    payload,
  };
}

function decisionRecordInput(workspaceId: string, d: NormalizedDecision, decidedAt: number, id?: string): AppendInput {
  const payload: LocalHitlDecisionPayload = {
    requestId: d.requestId,
    generation: d.generation,
    requestVersion: d.requestVersion,
    status: d.status,
    decidedBy: d.decidedBy,
    note: d.note,
    feedback: d.feedback,
  };
  const observations: LocalHitlDecisionObservations = { decidedAt };
  return { id: id ?? decisionId(workspaceId, d), kind: HITL_DECISION_KIND, payload, observations };
}

function preparedVersionPayload(
  p: PreparedSubmission,
  generation: number,
  version: number,
  supersedes: HitlSupersedesRef | null,
): LocalHitlVersionPayload {
  return {
    requestId: p.requestId,
    requestKey: p.requestKey,
    generation,
    version,
    functionName: p.functionName,
    title: p.title,
    action: p.action,
    actionKind: p.actionKind,
    target: p.target,
    targetHash: p.targetHash,
    packetHash: p.packetHash,
    canonicalizationVersion: p.canonicalizationVersion,
    contentHash: p.contentHash,
    body: p.body,
    payloadRef: p.payloadRef,
    expiresAt: p.expiresAt,
    summary: p.summary,
    warnings: p.warnings,
    sideEffects: p.sideEffects,
    choices: p.choices,
    originRunId: p.originRunId,
    originTaskId: p.originTaskId,
    requestingAgent: p.requestingAgent,
    sanitizedSummary: p.sanitizedSummary,
    supersedes,
  };
}

// The local filesystem ledger IS the authoritative live store for a workspace
// with no database (owner decision 6): every HITL write is synchronous to disk
// under the namespace lock and either commits or throws — nothing is ever
// spooled, and a read never falls back to an overlay.
class LocalHitlStore implements HitlStore {
  private readonly ledger: LocalLedger;
  private readonly now: () => number;
  private readonly policy: HitlExpiryPolicy;
  // D6: the migration epoch this backend resolved against. A conversion that
  // completed since then means our view of the on-disk format is stale.
  private resolvedEpoch: string | null;
  private sweeping = false;

  constructor(ledger: LocalLedger, now: () => number, policy: HitlExpiryPolicy) {
    this.ledger = ledger;
    this.now = now;
    this.policy = policy;
    this.resolvedEpoch = readHitlMigrationEpoch(ledger);
  }

  // Every entry point passes through here: the v1→v2 conversion is idempotent
  // and holds the SAME `hitl/.lock` v1 writers respect, so no v1 append can
  // interleave with it. Mutations additionally revalidate the epoch.
  private barrier(forWrite: boolean): void {
    const ensured = ensureLocalHitlV2(this.ledger, this.now());
    if (this.resolvedEpoch === null && ensured.converted) this.resolvedEpoch = ensured.epoch;
    if (!forWrite) return;
    if (this.resolvedEpoch === null || this.resolvedEpoch !== ensured.epoch) {
      throw new BackendUnavailableError(
        `the local HITL ledger was converted to v2 (epoch ${ensured.epoch}) after this backend was resolved — re-resolve the workspace backend and retry the write`,
      );
    }
  }

  // The throttled bookkeeping sweep (PLAN D). It runs AFTER the verb's own work
  // and swallows its own failures, because nothing depends on it: the
  // sweep-INDEPENDENT effective status already keeps an unswept expiry out of
  // the queue and out of authority. The re-entrancy flag keeps the sweep's own
  // insertSystemExpiry calls from re-triggering it.
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await maybeSweep(this, this.now());
    } finally {
      this.sweeping = false;
    }
  }

  private payloadDir(): string {
    return join(this.ledger.treeDir, HITL_PAYLOAD_DIR);
  }

  // The local object port for an oversized body: the same create-only,
  // digest-named blob primitive the artifact store uses. Unversioned, so the
  // recorded objectVersionId is null and integrity rests on the digest.
  private offload(): HitlPayloadOffload {
    return async (bytes, digest) => {
      const dir = this.payloadDir();
      this.ledger.meta();
      this.ledger.ensureDir(dir);
      const path = join(dir, digest);
      if (assertRegularFileIfExists(path) !== null) {
        const existing = readRegularFileSync(path);
        if (existing === null || sha256Hex(existing) !== digest) {
          throw new ConflictError(digest, 'stored HITL payload bytes do not match their digest');
        }
        fsyncDir(dir);
      } else {
        writeBlobSync(dir, digest, bytes);
      }
      return { objectVersionId: null, uri: null };
    };
  }

  private resolveBody(row: ProjectedVersion): string | null {
    if (row.body !== null && row.body !== undefined) return row.body;
    if (row.payloadRef === null || row.payloadRef === undefined) return null;
    const bytes = readRegularFileSync(join(this.payloadDir(), row.payloadRef.digest));
    if (bytes === null) {
      throw new InvalidRecordError(
        `HITL request ${row.requestId} references payload ${row.payloadRef.digest}, whose bytes are missing`,
      );
    }
    if (sha256Hex(bytes) !== row.payloadRef.digest) {
      throw new InvalidRecordError(`HITL payload ${row.payloadRef.digest} bytes do not match their digest`);
    }
    return bytes.toString('utf8');
  }

  private read(): HitlProjection {
    this.barrier(false);
    const { records, lastSeq } = this.ledger.scan('hitl');
    return projectHitl(records, lastSeq);
  }

  private submissionState(proj: HitlProjection, requestId: string, now: number): HitlSubmissionState {
    const state = stateOf(proj, requestId, now);
    if (state.head === null) return { head: null };
    return {
      head: {
        generation: state.head.generation,
        version: state.head.version,
        packetHash: state.head.packetHash,
        // The incoming cross-group supersession (D3), bound into PLANNING and
        // not only into authority: a replaced head keeps its exact fingerprint,
        // so nothing else can tell a stale caller that its group is closed.
        sealed: state.head.sealed,
        superseded: state.head.superseded,
      },
    };
  }

  // The expiry a head must carry before this write CLOSES it — whether by the
  // NEXT generation over it or by another group's supersession row: an
  // effectively-expired head whose durable `expired` decision the sweep has not
  // written yet is materialized in the SAME batch, so it can never be hidden
  // behind the closing record. Parity with postgres materializeHeadExpiry(),
  // including its already-durable and superseded exclusions.
  private pendingExpiry(proj: HitlProjection, requestId: string, now: number): AppendInput | null {
    const state = stateOf(proj, requestId, now);
    if (
      state.head === null ||
      state.effectiveStatus !== 'expired' ||
      state.head.terminalStatus !== null ||
      state.head.superseded
    ) {
      return null;
    }
    const { generation, version } = state.head;
    return decisionRecordInput(
      this.ledger.workspaceId,
      systemExpiryDecision(requestId, generation, version),
      now,
      systemExpiryId(this.ledger.workspaceId, requestId, generation, version),
    );
  }

  async createRequest(input: HitlRequestInput): Promise<HitlWriteOutcome> {
    // This clock is the POLICY clock (the expiry the packet will carry). The
    // STATE-MACHINE clock is read again inside the locked commit — the offload
    // below is an await, and a head can expire while it is in flight.
    const prepared = await prepareSubmission(
      this.ledger.workspaceId,
      input,
      this.policy,
      this.now(),
      this.offload(),
    );
    this.barrier(true);
    const out = this.commit(prepared, null);
    await this.sweep();
    return out;
  }

  // D3: one atomic batch under the single `hitl` namespace lock records the
  // destination version AND its supersession pointer at the source head. Both
  // expected heads are validated first, so neither group can move underneath.
  async replaces(input: HitlReplaceInput): Promise<HitlWriteOutcome> {
    const sourceRequestId = requireString('sourceRequestId', input.sourceRequestId);
    const sourceExpected = assertExpectedHead(input.sourceExpectedHead, 'sourceExpectedHead');
    if (sourceExpected === undefined || sourceExpected === null) {
      throw new InvalidRecordError('sourceExpectedHead is required — a replace must name the head it cancels');
    }
    const prepared = await prepareSubmission(
      this.ledger.workspaceId,
      input.request,
      this.policy,
      this.now(),
      this.offload(),
    );
    if (prepared.requestId === sourceRequestId) {
      throw new InvalidRecordError(
        'replaces targets a DIFFERENT request group — a same-key edit is a revision, not a supersession',
      );
    }
    this.barrier(true);
    const out = this.commit(prepared, { sourceRequestId, sourceExpected });
    await this.sweep();
    return out;
  }

  private commit(
    prepared: PreparedSubmission,
    replace: { sourceRequestId: string; sourceExpected: HitlExpectedHead } | null,
  ): HitlWriteOutcome {
    return this.ledger.appendValidatedBatch<HitlWriteOutcome>('hitl', (ctx) => {
      // The state-machine clock is read HERE — under the namespace lock, after
      // the packet preparation/offload that may have taken arbitrary time —
      // never the pre-offload value, or a head that expired meanwhile would be
      // revised in place instead of sealed.
      const now = this.now();
      const proj = projectHitl(ctx.records, ctx.lastSeq);
      let supersedes: HitlSupersedesRef | null = null;
      let sourceSuperseded = false;
      // Every group this batch CLOSES a head of, keyed for the deterministic
      // ordering below: the destination group always, plus the source group of a
      // `replaces`.
      const owing: { requestKey: string; requestId: string }[] = [
        { requestKey: prepared.requestKey, requestId: prepared.requestId },
      ];
      if (replace !== null) {
        const sourceState = stateOf(proj, replace.sourceRequestId, now);
        if (sourceState.head === null) {
          throw new ConflictError(replace.sourceRequestId, 'missing-history: the source request group has no versions');
        }
        const sh = sourceState.head;
        sourceSuperseded = sh.superseded;
        if (
          sh.generation !== replace.sourceExpected.generation ||
          sh.version !== replace.sourceExpected.version ||
          sh.packetHash !== replace.sourceExpected.packetHash ||
          sh.sealed !== replace.sourceExpected.sealed
        ) {
          throw new ConflictError(
            replace.sourceRequestId,
            `stale-expected-head: the source head is generation ${sh.generation} version ${sh.version} (sealed: ${sh.sealed}), not ${replace.sourceExpected.generation}/${replace.sourceExpected.version} (sealed: ${replace.sourceExpected.sealed})`,
          );
        }
        supersedes = { requestId: sh.requestId, generation: sh.generation, version: sh.version };
        owing.push({ requestKey: sh.requestKey, requestId: sh.requestId });
      }
      const state = this.submissionState(proj, prepared.requestId, now);
      const planned = planFor(state, prepared);
      if (planned.kind === 'conflict') throw conflictFromPlan(prepared.requestId, planned);
      // The shared finalizer owns BOTH the idempotent→revise upgrade a
      // `replaces` owes its supersession link AND the closure re-check that
      // upgrade demands (R5 finding 1).
      const plan = finalizeSubmissionPlan(
        planned,
        state.head,
        supersedes === null
          ? null
          : { requested: supersedes, recorded: headRowOf(proj, prepared.requestId)?.supersedes ?? null },
      );
      if (plan.kind === 'conflict') throw conflictFromPlan(prepared.requestId, plan);
      // The SOURCE side of the same closure rule the machine applies to the
      // destination: a head that another group already replaced cannot be
      // replaced a second time, or two destinations would each claim to cancel
      // it. Scoped to plans that WRITE, so replaying the original replace (whose
      // link the destination head already records) stays an idempotent no-op.
      if (plan.kind !== 'idempotent' && replace !== null && sourceSuperseded) {
        throw new ConflictError(
          replace.sourceRequestId,
          'superseded-head: the source head was already superseded by another request group — re-read and target the group that replaced it',
        );
      }
      if (plan.kind === 'idempotent') {
        return {
          records: [],
          result: {
            outcome: 'committed' as const,
            id: prepared.requestId,
            requestId: prepared.requestId,
            generation: plan.generation,
            version: plan.version,
            idempotent: true,
            warnings: prepared.policyWarnings,
          },
        };
      }
      // Both closed heads' owed expiries, BEFORE the version record that closes
      // them. The destination's is the generation boundary; the SOURCE's is the
      // one a supersession row would otherwise erase forever, since a superseded
      // head is skipped by every candidate scan and refused by the postgres
      // decision trigger (round-7 finding). Ordered by request_key — the same
      // deterministic sort the postgres backend locks and writes in, so the two
      // backends produce the same decision order for a both-expired replace.
      const extra = owing
        .sort((a, b) => (a.requestKey < b.requestKey ? -1 : a.requestKey > b.requestKey ? 1 : 0))
        .map((g) => this.pendingExpiry(proj, g.requestId, now))
        .filter((e): e is AppendInput => e !== null);
      const payload = preparedVersionPayload(prepared, plan.generation, plan.version, supersedes);
      return {
        records: [...extra, versionRecordInput(this.ledger.workspaceId, payload)],
        result: {
          outcome: 'committed' as const,
          id: prepared.requestId,
          requestId: prepared.requestId,
          generation: plan.generation,
          version: plan.version,
          idempotent: false,
          warnings: prepared.policyWarnings,
        },
      };
    });
  }

  async appendDecision(input: HitlDecisionInput): Promise<HitlDecisionOutcome> {
    const d = normalizeDecision(input);
    this.barrier(true);
    const out = this.ledger.appendValidatedBatch<HitlDecisionOutcome>('hitl', (ctx) => {
      // Same rule as commit(): the expiry-direction check must run on the clock
      // as it is INSIDE the lock, not as it was before the caller queued.
      const now = this.now();
      const proj = projectHitl(ctx.records, ctx.lastSeq);
      const state = stateOf(proj, d.requestId, now);
      if (state.head === null) {
        throw new InvalidRecordError(`HITL request ${d.requestId} does not exist`);
      }
      if (state.head.generation !== d.generation || state.head.version !== d.requestVersion) {
        throw new ConflictError(
          d.requestId,
          `not-head: generation ${d.generation} version ${d.requestVersion} is not the current head (head is ${state.head.generation}/${state.head.version})`,
        );
      }
      const check = canDecide(state.head, d.status, now);
      if (!check.ok) throw decisionRefusal(d.requestId, check);
      return {
        records: [decisionRecordInput(this.ledger.workspaceId, d, now)],
        result: {
          outcome: 'committed' as const,
          id: decisionId(this.ledger.workspaceId, d),
          requestId: d.requestId,
          generation: d.generation,
          requestVersion: d.requestVersion,
          status: d.status,
        },
      };
    });
    await this.sweep();
    return out;
  }

  async getRequest(id: string): Promise<HitlRequestEnvelope | null> {
    requireString('id', id);
    const proj = this.read();
    const row = headRowOf(proj, id);
    if (row === null) return null;
    const state = stateOf(proj, id, this.now());
    return envelopeOf(this.ledger.workspaceId, row, state, this.resolveBody(row));
  }

  async listRequests(filter: HitlRequestFilter, cursor?: Cursor): Promise<Page<HitlRequestEnvelope>> {
    if (filter.status === undefined) await this.sweep();
    const proj = this.read();
    const now = this.now();
    const matches: { order: OrderKey; item: HitlRequestEnvelope }[] = [];
    for (const requestId of proj.versions.keys()) {
      const row = headRowOf(proj, requestId)!;
      const state = stateOf(proj, requestId, now);
      if (!matchesHitlFilter(row.functionName, state, filter)) continue;
      // Listings never resolve an offloaded body (a page must not fan out into
      // object reads); `getRequest` is the read that materializes it.
      matches.push({
        // The GROUP's anchor, not the head's own position: a revision during
        // pagination must not move a request across the watermark and out of
        // the traversal entirely (round-3 finding 4).
        order: anchorOrderOf(proj.versions.get(requestId)!),
        item: envelopeOf(this.ledger.workspaceId, row, state, row.body ?? null),
      });
    }
    matches.sort((a, b) => compareOrder(a.order, b.order));
    return pageBySeq(matches, cursor, pageLimit(filter.limit), proj.lastSeq);
  }

  async count(filter?: HitlRequestFilter): Promise<CountResult> {
    if (filter?.status === undefined) await this.sweep();
    const proj = this.read();
    const now = this.now();
    let committed = 0;
    for (const requestId of proj.versions.keys()) {
      const row = headRowOf(proj, requestId)!;
      if (matchesHitlFilter(row.functionName, stateOf(proj, requestId, now), filter)) committed += 1;
    }
    return { committed, queued: 0, partial: false };
  }

  async listVersions(id: string): Promise<HitlVersionRecord[]> {
    requireString('id', id);
    const proj = this.read();
    return (proj.versions.get(id) ?? []).map((r) => ({
      requestId: r.requestId,
      requestKey: r.requestKey,
      generation: r.generation,
      version: r.version,
      action: r.action,
      actionKind: r.actionKind,
      target: r.target,
      targetHash: r.targetHash,
      packetHash: r.packetHash,
      canonicalizationVersion: r.canonicalizationVersion,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      seq: r.seq,
      supersedes: r.supersedes ?? null,
    }));
  }

  async listGenerations(id: string): Promise<HitlGenerationSummary[]> {
    requireString('id', id);
    const proj = this.read();
    const now = this.now();
    const rows = proj.versions.get(id) ?? [];
    const decisions = proj.decisions.get(id) ?? [];
    const superseded = proj.superseded.get(id) ?? [];
    const byGeneration = new Map<number, ProjectedVersion[]>();
    for (const r of rows) {
      const list = byGeneration.get(r.generation) ?? [];
      list.push(r);
      byGeneration.set(r.generation, list);
    }
    return [...byGeneration.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([generation, list]) => {
        // Each generation is projected in isolation: deriveRequestState always
        // reports on the HIGHEST generation it is given, so restricting the input
        // to one generation yields that generation's own head + status.
        const scoped = deriveRequestState(machineVersions(list), machineDecisions(decisions), now, superseded);
        const head = scoped.head!;
        return {
          generation,
          versions: list.length,
          headVersion: head.version,
          status: scoped.effectiveStatus!,
          sealed: head.sealed,
          createdAt: list[0]!.createdAt,
        };
      });
  }

  async listDecisions(id: string): Promise<HitlDecisionEnvelope[]> {
    requireString('id', id);
    const proj = this.read();
    return (proj.decisions.get(id) ?? [])
      .slice()
      .sort(
        (a, b) =>
          a.generation - b.generation || a.requestVersion - b.requestVersion || a.seq - b.seq || a.pos - b.pos,
      )
      .map((d) => ({
        id: d.id,
        workspaceId: this.ledger.workspaceId,
        requestId: d.requestId,
        generation: d.generation,
        requestVersion: d.requestVersion,
        status: d.status,
        decidedBy: d.decidedBy,
        note: d.note,
        feedback: d.feedback,
        terminal: d.status !== 'deferred',
        decidedAt: d.decidedAt,
        createdAt: d.decidedAt,
        seq: d.seq,
      }));
  }

  async listExpiryCandidates(now: number, limit: number): Promise<HitlExpiryCandidate[]> {
    const proj = this.read();
    const out: HitlExpiryCandidate[] = [];
    for (const requestId of proj.versions.keys()) {
      if (out.length >= limit) break;
      const state = stateOf(proj, requestId, now);
      // Effectively expired AND not yet materialized: an already-durable expiry
      // is not a candidate (or every sweep would re-report the same rows).
      // A SUPERSEDED head is not a candidate either — the postgres decision
      // trigger refuses EVERY decision on a superseded version, system expiry
      // included, so leaving it in the workset would make the local ledger write
      // a row the database can never hold (round-4 finding 1c).
      if (
        state.head === null ||
        state.effectiveStatus !== 'expired' ||
        state.head.terminalStatus !== null ||
        state.head.superseded
      ) {
        continue;
      }
      out.push({
        requestId,
        requestKey: state.head.requestKey,
        generation: state.head.generation,
        version: state.head.version,
        expiresAt: state.head.expiresAt!,
      });
    }
    return out;
  }

  async insertSystemExpiry(candidate: HitlExpiryCandidate, now: number): Promise<'expired' | 'conflict'> {
    this.barrier(true);
    return this.ledger.appendValidatedBatch<'expired' | 'conflict'>('hitl', (ctx) => {
      const proj = projectHitl(ctx.records, ctx.lastSeq);
      const state = stateOf(proj, candidate.requestId, now);
      if (
        state.head === null ||
        state.head.generation !== candidate.generation ||
        state.head.version !== candidate.version ||
        state.effectiveStatus !== 'expired' ||
        // Another sweep (or the new-generation path) already materialized it.
        state.head.terminalStatus !== null ||
        // Parity with the postgres decision trigger, which refuses any decision
        // on a superseded version: a conflict, never a write (finding 1c).
        state.head.superseded
      ) {
        return { records: [], result: 'conflict' as const };
      }
      return {
        records: [
          decisionRecordInput(
            this.ledger.workspaceId,
            systemExpiryDecision(candidate.requestId, candidate.generation, candidate.version),
            now,
            systemExpiryId(this.ledger.workspaceId, candidate.requestId, candidate.generation, candidate.version),
          ),
        ],
        result: 'expired' as const,
      };
    });
  }
}

// Absent `status` filter ⇒ the ACTIONABLE queue (awaiting | deferred, owner
// decision 3: a deferred item stays in the queue). A supplied `status` selects
// exactly that effective status, which is how #320 will list decided history.
function matchesHitlFilter(
  functionName: string,
  state: HitlRequestState,
  filter?: HitlRequestFilter,
): boolean {
  if (filter?.functionName !== undefined && functionName !== filter.functionName) return false;
  if (filter?.status !== undefined) return state.effectiveStatus === filter.status;
  return state.actionable;
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
    const byRun = new Map<string, { summary: RunSummary; canonical: Map<string, string>; order: OrderKey }>();
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
          // A run's ordering position is its FIRST event's logical position —
          // (seq, pos), so two runs whose first events landed in one compound
          // envelope still page deterministically and completely.
          order: { seq: rec.seq, pos: rec.pos },
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
    const summaries = [...byRun.values()]
      .map((s) => ({ order: s.order, item: { ...s.summary, events: s.canonical.size } }))
      .sort((a, b) => compareOrder(a.order, b.order));
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
  // #319 expiry policy from roster/persistence.yaml (hitl.expiry).
  hitlExpiry?: HitlExpiryPolicy;
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
    hitl: new LocalHitlStore(ledger, now, opts.hitlExpiry ?? DEFAULT_HITL_EXPIRY_POLICY),
    runs: new LocalRunStore(ledger, now, pid),
    artifacts: new LocalArtifactStore(ledger),
  };
}
