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
  type ArtifactDeclaration,
  type ArtifactMeta,
  type ArtifactPutResult,
  type ArtifactRecord,
  type ArtifactStore,
  type CountResult,
  type Cursor,
  type FrozenQueuedRun,
  type DeclarationPutResult,
  type ExternalArtifactInput,
  type HitlDecisionEnvelope,
  type HitlDecisionInput,
  type HitlDecisionOutcome,
  type HitlDecisionStatus,
  type HitlExpiryCandidate,
  type HitlGenerationSummary,
  type HitlReplaceInput,
  type HitlRequestEnvelope,
  type HitlRequestFilter,
  type HitlRequestInput,
  type HitlStatus,
  type HitlStore,
  type HitlSupersedesRef,
  type HitlVersionRecord,
  type HitlWriteOutcome,
  type InternalDeclarationInput,
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
  type WriteOutcomeKind,
} from '../contracts.ts';
import {
  HITL_GROUP_LOCK_MASK,
  canDecide,
  type HitlActionKind,
  type HitlHead,
} from '../hitl-machine.ts';
import {
  assertExpectedHead,
  conflictFromPlan,
  decisionId,
  decisionRefusal,
  encodeInlinePayload,
  encodeStoredRef,
  finalizeSubmissionPlan,
  identityFieldsOf,
  normalizeDecision,
  payloadRefOf,
  planFor,
  prepareLegacySubmission,
  prepareSubmission,
  resealExpiry,
  supersedesOf,
  systemExpiryDecision,
  systemExpiryId,
  DEFAULT_HITL_EXPIRY_POLICY,
  type HitlExpiryPolicy,
  type HitlPayloadOffload,
  type NormalizedDecision,
  type PreparedSubmission,
} from '../hitl-store.ts';
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
  type RunEventSource,
  type RunObservationContext,
} from '../run-events.ts';
import {
  externalDeclarationParts,
  internalDeclarationParts,
  legacyDeclarationOf,
  type DeclarationObservations,
  type DeclarationSemantic,
} from '../artifact-declarations.ts';
import {
  type CommittedRef,
  type DeliverResult,
  type LocalOutbox,
  type OutboxEntryState,
  type OutboxRecord,
  type OutboxTargetNamespace,
  type RemoteTarget,
} from '../outbox.ts';
import { CURRENT_COMPONENT_VERSIONS, makeBackendInfo, type BackendInfo } from '../capabilities.ts';
import { BoundPool, type PgQueryable } from './binding.ts';
import { S3ObjectTarget, type CreateOnlyObjectStore } from '../objects.ts';
import { mayDegradeToPartial } from '../error-classify.ts';
import { maybeSweep } from '../hitl-sweep.ts';
import {
  overlayArtifactGet,
  overlayArtifactHead,
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
  // Store-assigned observations (#323): the run-event trust/lifecycle columns
  // (RunEventObservations) or the declaration verified/version/sanitized columns
  // (DeclarationObservations). NEVER in payloadHash — a retry replays clean.
  observations?: unknown;
  // The captured S3 version id for an artifact blob (direct path only; the
  // outbox-drained path leaves it null for a later admin-repair fill).
  objectVersionId?: string | null;
};

export type HitlRequestPayload = Omit<HitlRequestEnvelope, 'id' | 'workspaceId' | 'seq' | 'createdAt' | 'queued'>;
export type HitlDecisionPayload = { requestId: string; status: string; decidedBy: string; note: string | null };
// The blob's HASHED payload is content-only (digest + size) — finding: blob
// identity must not include run metadata. Two runs declaring identical bytes with
// different meta thus derive the SAME id AND payload hash (one blob row, dedup),
// and their per-run/provenance metadata lives on the declarations. `meta` rides
// as a store observation (first-write-wins), never in the hash.
export type ArtifactPayload = { digest: string; size: number };
export type ArtifactObservations = { meta: ArtifactMeta };

// Validation + deterministic id derivation shared by the direct write path,
// the outbox writeThrough path, AND the degraded backend (resolve.ts): every
// producer of a given logical record derives byte-identical (id, payload), so
// replay after an outage dedups instead of conflicting.

// Seals the event (id + stable payload) via the #323 model and resolves its
// store observations from the write-path context. Shared by the direct write
// path, the outbox writeThrough path, AND the degraded backend (resolve.ts).
export function runEventParts(
  workspaceId: string,
  input: RunEventInput,
  ctx: RunObservationContext,
): { id: string; payload: RunEventPayload; canonical: string; observations: RunEventObservations } {
  const sealed = sealRunEvent(workspaceId, {
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
  const observations = resolveRunObservations(sealed.kind, input.data, input, ctx);
  return { id: sealed.id, payload: sealed.payload, canonical: sealed.canonical, observations };
}

export function artifactParts(
  workspaceId: string,
  meta: ArtifactMeta,
  bytes: Uint8Array,
): { id: string; payload: ArtifactPayload; canonical: string; digest: string; observations: ArtifactObservations } {
  requireString('meta.filename', meta.filename);
  requireString('meta.contentType', meta.contentType);
  if (meta.runId !== null) requireString('meta.runId', meta.runId);
  const digest = sha256Hex(bytes);
  const id = computeRecordId(workspaceId, 'artifacts', { kind: 'artifact', digest });
  // Content-only hashed payload; meta is a store observation (never hashed).
  const snap = snapshotPayload({ digest, size: bytes.byteLength });
  return { id, payload: snap.value as ArtifactPayload, canonical: snap.canonical, digest, observations: { meta } };
}

async function insertDataRow(client: pg.PoolClient, rec: OpsPgRecord): Promise<void> {
  const route = `${rec.namespace}/${rec.kind}`;
  // The `hitl` namespace is non-spoolable (owner decision 6 / D7), so these two
  // routes are reachable ONLY by draining a spool a pre-#319 CLI created. They
  // allocate v2 identity server-side under the same per-group advisory lock a
  // live write takes — a legacy entry materializes as a coherent v2 row or not
  // at all, never as a v1-shaped orphan the state machine cannot read.
  if (route === 'hitl/hitl-request') {
    // The DB clock, not the draining host's: a legacy execution request with no
    // expiry gets its default TTL from the same clock the projection and the
    // triggers judge it by, so a skewed drainer cannot land a row that is born
    // expired (this path supplies packet_hash, so the fill trigger's own
    // expiry default never runs). Read before the lock is fine — it only sets
    // the TTL baseline; every ordering-sensitive read happens under the lock.
    const now = await dbNowMs(client);
    const prepared = prepareLegacySubmission(rec.workspaceId, rec.payload, rec.createdAt, now);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1) # ${HITL_GROUP_LOCK_MASK})`, [prepared.requestKey]);
    const head = await client.query(
      `SELECT generation, version, packet_hash, sealed, superseded, effective_status, terminal_status
         FROM hitl.request_state WHERE workspace_id = $1::uuid AND request_id = $2`,
      [rec.workspaceId, prepared.requestId],
    );
    const headRow = head.rows[0] as Record<string, unknown> | undefined;
    const plan = planFor(
      {
        head:
          headRow === undefined
            ? null
            : {
                generation: num(headRow.generation),
                version: num(headRow.version),
                packetHash: headRow.packet_hash as string,
                sealed: headRow.sealed === true,
                // A superseded group is closed to the drain too — resurrecting
                // it here would recreate exactly the authority hole the live
                // path now refuses (round-4 finding 1a).
                superseded: headRow.superseded === true,
              },
      },
      prepared,
    );
    if (plan.kind === 'conflict') throw conflictFromPlan(prepared.requestId, plan);
    if (plan.kind === 'idempotent') return;
    // The drain opens generations exactly like the live path does, so it owes
    // the same durable boundary: materialize the previous generation's expiry
    // in THIS transaction, before G+1 exists. Skipping it would leave a head
    // the sweep can no longer discover and no durable expiry ever.
    if (plan.kind === 'open-generation' && headRow !== undefined) {
      await materializeHeadExpiry(
        client,
        rec.workspaceId,
        {
          requestId: prepared.requestId,
          generation: num(headRow.generation),
          version: num(headRow.version),
          effectiveStatus: headRow.effective_status as HitlStatus,
          terminalStatus: (headRow.terminal_status ?? null) as HitlDecisionStatus | null,
          superseded: headRow.superseded === true,
        },
      );
    }
    await client.query(
      `INSERT INTO hitl.requests
         (id, legacy_id, workspace_id, request_key, generation, version, action, action_kind, target, target_hash,
          packet_hash, canonicalization_version, content_hash, payload, expires_at, sanitized_summary,
          status, producer_id, producer_seq, created_at)
       VALUES ($1, $19, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15,
               'awaiting', $16::uuid, $17, $18)`,
      [
        prepared.requestId,
        rec.workspaceId,
        prepared.requestKey,
        plan.generation,
        plan.version,
        prepared.action,
        prepared.actionKind,
        prepared.target,
        prepared.targetHash,
        prepared.packetHash,
        prepared.canonicalizationVersion,
        prepared.contentHash,
        rec.canonical,
        prepared.expiresAt,
        prepared.sanitizedSummary,
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
        // Preserve the pre-#319 spool entry id so a legacy DECISION queued
        // alongside this request still resolves its target after the re-key.
        rec.id,
      ],
    );
    return;
  }
  if (route === 'hitl/hitl-decision') {
    const p = rec.payload as HitlDecisionPayload;
    // A legacy decision names the v1 content-addressed request id; the migration
    // re-keyed those rows and preserved the old value in `legacy_id`.
    const target = await client.query(
      `SELECT id, request_key, generation, version FROM hitl.requests
        WHERE workspace_id = $1::uuid AND (id = $2 OR legacy_id = $2)
        ORDER BY generation DESC, version DESC LIMIT 1`,
      [rec.workspaceId, p.requestId],
    );
    const row = target.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new InvalidRecordError(`queued HITL decision ${rec.id} references request ${p.requestId}, which does not exist`);
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1) # ${HITL_GROUP_LOCK_MASK})`, [row.request_key]);
    await client.query(
      `INSERT INTO hitl.decisions
         (id, workspace_id, request_id, generation, request_version, status, payload, decided_at,
          producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid, $10, $8)`,
      [
        rec.id,
        rec.workspaceId,
        row.id,
        num(row.generation),
        num(row.version),
        p.status,
        rec.canonical,
        rec.createdAt,
        rec.producerId,
        rec.producerSeq,
      ],
    );
    return;
  }
  if (route === 'runs/run-event') {
    // Normalize a v1 (#318) outbox payload (`type`, no `kind`/metadata) to the v2
    // shape BEFORE extracting columns (finding: v1 queued events drain NULL into
    // run_events.type — a NOT NULL violation that permanently halts the drain).
    const p = normalizeStoredEventPayload(rec.payload);
    // Observations (source/pid/timestamps/sanitized_report) land in dedicated
    // columns, never the payload jsonb (rec.canonical) — a v1 row / missing
    // observation reads as 'unverified'. `type` carries the kind (the run_index
    // view + v1 NOT NULL column). agent/skill/trigger/parent/origin come from the
    // hashed payload but are also columnized for indexing + the safe view.
    const obs = (rec.observations ?? null) as RunEventObservations | null;
    await client.query(
      `INSERT INTO roster_ops.run_events
         (id, workspace_id, run_id, dedupe_key, type, payload, source, agent, skill, trigger,
          parent_run_id, origin_task_id, correlation_id, pid, started_at, ended_at, sanitized_report,
          producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17,
               $18::uuid, $19, $20)`,
      [
        rec.id,
        rec.workspaceId,
        p.runId,
        p.dedupeKey,
        p.kind,
        rec.canonical,
        obs?.source ?? 'unverified',
        p.agent,
        p.skill,
        p.trigger,
        p.parentRunId,
        p.originTaskId,
        correlationColumn(p.kind, p.dedupeKey),
        obs?.pid ?? null,
        obs?.startedAt ?? null,
        obs?.endedAt ?? null,
        obs?.sanitizedReport ?? null,
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
      ],
    );
    return;
  }
  if (route === 'artifacts/artifact-declaration') {
    const p = rec.payload as DeclarationSemantic;
    const obs = (rec.observations ?? {}) as Partial<DeclarationObservations>;
    // Ordered materialization derives the version state for a declaration that
    // was spooled while its blob was still queued (round-7 finding 5). The blob
    // holds the earlier producer_seq in this namespace, so by the time the
    // declaration lands its row is committed: read the row's object_version_id
    // and stamp 'verified' when it carries one. version_state is a non-hashed
    // store observation, so deriving it here cannot change the record identity.
    // Gated on `versionPending` — a direct (healthy) write already resolved the
    // state against the committed ROW authority and must never be re-derived,
    // or a v1 versionless row / an object-version contradiction would be blessed
    // (round-7 finding 6).
    const versionStateExpr =
      obs.versionPending === true && p.kind === 'internal' && p.digest !== null
        ? `COALESCE((SELECT CASE WHEN a.object_version_id IS NOT NULL THEN 'verified' ELSE 'unverified' END
                       FROM roster_ops.artifacts a
                      WHERE a.workspace_id = $2::uuid AND a.digest = $7), $15)`
        : '$15';
    await client.query(
      `INSERT INTO roster_ops.artifact_declarations
         (id, workspace_id, run_id, declaring_agent, role, kind, digest, provider, external_id, external_url,
          artifact_type, media_type, provenance, verified, version_state, sanitized_text, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13::jsonb, $14, ${versionStateExpr}, $16, $17)`,
      [
        rec.id,
        rec.workspaceId,
        p.runId,
        p.declaringAgent,
        p.role,
        p.kind,
        p.digest,
        p.provider,
        p.externalId,
        p.externalUrl,
        p.artifactType,
        p.mediaType,
        JSON.stringify(p.provenance ?? {}),
        obs.verified ?? false,
        obs.versionState ?? null,
        obs.sanitizedText ?? null,
        rec.createdAt,
      ],
    );
    return;
  }
  if (route === 'artifacts/artifact') {
    const p = rec.payload as ArtifactPayload & { meta?: ArtifactMeta };
    // meta is a store observation (NOT in the content-only payload hash) so two
    // runs' identical bytes dedup to one blob; the first writer's meta lands.
    // A v1 outbox entry carried meta INSIDE the payload (finding: v1 records not
    // upgraded) — fall back so v1 meta survives the drain.
    // object_version_id is a store observation captured on the direct put path
    // AND threaded from the object delivery on the outbox-drained path (finding:
    // VersionId discarded on queued writes). Never part of the payload hash.
    const obs = (rec.observations ?? {}) as Partial<ArtifactObservations>;
    const meta = obs.meta ?? p.meta ?? { filename: 'artifact', contentType: 'application/octet-stream', runId: null };
    await client.query(
      `INSERT INTO roster_ops.artifacts
         (id, workspace_id, digest, size, meta, object_version_id, producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid, $8, $9)`,
      [
        rec.id,
        rec.workspaceId,
        p.digest,
        p.size,
        JSON.stringify(meta),
        rec.objectVersionId ?? null,
        rec.producerId,
        rec.producerSeq,
        rec.createdAt,
      ],
    );
    // A v1 artifact outbox entry (meta carried in the payload) drains into
    // blob + a synthesized legacy declaration (finding: v1 artifact outbox
    // entries drain only into blob materialization). Idempotent under the
    // declaration unique key.
    if (p.meta !== undefined && p.meta !== null) {
      const decl = legacyDeclarationOf(rec.workspaceId, p.digest, p.meta, rec.createdAt);
      await client.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, digest, provider, external_id, external_url,
            artifact_type, media_type, provenance, verified, version_state, sanitized_text, created_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
         ON CONFLICT (workspace_id, id) DO NOTHING`,
        [
          decl.id,
          rec.workspaceId,
          decl.runId,
          decl.declaringAgent,
          decl.role,
          decl.kind,
          decl.digest,
          null,
          null,
          null,
          decl.artifactType,
          decl.mediaType,
          JSON.stringify(decl.provenance ?? {}),
          decl.verified,
          decl.versionState,
          decl.sanitizedText,
          decl.createdAt,
        ],
      );
    }
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
  // EXPLICIT read committed (#319 D4): the hitl decisions trigger refuses to run
  // under a higher isolation, where its lock-then-read serialization would miss
  // a concurrently committed terminal decision.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
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
  // The artifact BLOB is content-addressed: its record id already encodes the
  // digest, the bytes are immutable, and `meta` is a first-write-wins store
  // observation (never part of identity). So a same-id collision with a DIFFERENT
  // payload hash — a REAL v1 (#318) blob row whose hash covered {digest,size,meta}
  // re-declared through the v2 content-only {digest,size} path — is a DUPLICATE,
  // not a conflict: the digest is already satisfied. The delivery-ledger dedup for
  // the blob therefore keys on the digest (via the record id), not the payload
  // hash (finding: a v1 blob re-declared through v2 tripped a false ConflictError /
  // parked the artifact queue). Declarations and every other record still conflict.
  if (rec.namespace === 'artifacts' && rec.kind === 'artifact') return 'duplicate';
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
        // Observations spool alongside the record (run-event trust/lifecycle or
        // declaration verified/version/sanitized columns, artifact meta). A
        // blob's object_version_id is threaded from the object delivery on the
        // drain path (finding: VersionId discarded on queued writes) so the row
        // materializes with the recorded immutable version, not NULL.
        observations: record.observations,
        objectVersionId: record.objectVersionId,
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
  // Injectable pid seam for the run-event observation columns (tests).
  pid: () => string;
  // The roster_ops schema version of THIS backend (from meta). getArtifact/head
  // are allowed on a v1 backend (gated only on base `artifacts`), but the
  // object_version_id column arrives with migration 002 (v2). The artifact read
  // query selects that column ONLY when opsVersion >= 2 so a finalized v1 backend
  // reads the blob version-less instead of failing with undefined_column
  // (finding: capability gating permits v1 reads that execute v2-only SQL).
  opsVersion: number;
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

// Everything the envelope needs: the authoritative projection (hitl.request_state)
// joined to its own packet row. The view is one row per request GROUP — the
// current version of the highest generation — so the join is on its identity.
const HITL_HEAD_COLUMNS = `
  s.request_id, s.request_key, s.generation, s.version, s.action, s.action_kind, s.target,
  s.target_hash, s.packet_hash, s.canonicalization_version, s.expires_at, s.created_at, s.seq,
  s.terminal_status, s.deferred, s.superseded, s.effective_status, s.sealed, s.authoritative,
  r.content_hash, r.payload, r.payload_ref, r.summary, r.warnings, r.side_effects, r.choices,
  r.origin_run_id, r.origin_task_id, r.requesting_agent,
  r.supersedes_request_id, r.supersedes_generation, r.supersedes_version`;

const HITL_HEAD_FROM = `
  FROM hitl.request_state s
  JOIN hitl.requests r
    ON r.workspace_id = s.workspace_id AND r.id = s.request_id
   AND r.generation = s.generation AND r.version = s.version`;

// Absent `status` filter ⇒ the ACTIONABLE queue (awaiting | deferred — a
// deferred item stays in the queue, owner decision 3). A supplied status selects
// exactly that effective status.
//
// The functionName comparison goes through hitl.function_name() — the SAME
// derivation the fill trigger keys on and functionNameOf() projects with. It
// used to compare the RAW payload value, so a migrated row carrying
// functionName 5 / '' / no key at all reported 'unknown' in its envelope and
// then answered to neither 'unknown' nor its raw value: an actionable approval
// hidden from the only queries a caller can make (round-3 finding 2).
// A SUPERSEDED head is excluded from the DEFAULT workset (round-4 finding 1b):
// it was replaced by another group, so there is nothing left to decide on it —
// the same rule deriveRequestState().actionable applies on the local backend. An
// EXPLICIT status filter still reaches it; that query is history, not the queue.
const HITL_FILTER_SQL = `
    AND ($fn::text IS NULL OR hitl.function_name(r.payload, r.payload_ref) = $fn)
    AND (CASE WHEN $st::text IS NULL
              THEN s.effective_status IN ('awaiting', 'deferred') AND NOT s.superseded
              ELSE s.effective_status = $st END)`;

function hitlFilterSql(fn: string, st: string): string {
  return HITL_FILTER_SQL.replaceAll('$fn', fn).replaceAll('$st', st);
}

function hitlEnvelopeFromRow(workspaceId: string, row: Record<string, unknown>): HitlRequestEnvelope {
  const ids = identityFieldsOf(row.payload ?? null, row.payload_ref ?? null);
  const terminalStatus = (row.terminal_status ?? null) as HitlDecisionStatus | null;
  const deferred = row.deferred === true;
  return {
    id: row.request_id as string,
    workspaceId,
    requestKey: row.request_key as string,
    generation: num(row.generation),
    version: num(row.version),
    functionName: ids.functionName,
    title: ids.title,
    action: row.action as string,
    actionKind: row.action_kind as HitlActionKind,
    target: row.target as string,
    targetHash: row.target_hash as string,
    packetHash: row.packet_hash as string,
    canonicalizationVersion: num(row.canonicalization_version),
    contentHash: row.content_hash as string,
    body: ids.body,
    payloadRef: row.payload_ref === null || row.payload_ref === undefined ? null : payloadRefOf(row.payload_ref),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : num(row.expires_at),
    summary: (row.summary ?? null) as string | null,
    warnings: row.warnings ?? null,
    sideEffects: row.side_effects ?? null,
    choices: row.choices ?? null,
    originRunId: (row.origin_run_id ?? null) as string | null,
    originTaskId: (row.origin_task_id ?? null) as string | null,
    requestingAgent: (row.requesting_agent ?? null) as string | null,
    supersedes: supersedesOf(
      row.supersedes_request_id,
      row.supersedes_generation === null || row.supersedes_generation === undefined
        ? null
        : num(row.supersedes_generation),
      row.supersedes_version === null || row.supersedes_version === undefined ? null : num(row.supersedes_version),
    ),
    status: row.effective_status as HitlStatus,
    nodeStatus: terminalStatus ?? (deferred ? 'deferred' : 'awaiting'),
    terminalStatus,
    deferred,
    sealed: row.sealed === true,
    superseded: row.superseded === true,
    authoritative: row.authoritative === true,
    createdAt: num(row.created_at),
    seq: num(row.seq),
    queued: false,
  };
}

// SQLSTATE → the store's taxonomy. The decision trigger deliberately RAISEs with
// unique_violation for every state refusal (prior terminal, not-head, sealed
// generation, superseded) so a concurrent loser and an index loser are ONE case.
function mapHitlPgError(err: unknown, what: string): never {
  if (err instanceof PersistenceError) throw err;
  const code = (err as { code?: string }).code;
  const detail = (err as Error).message;
  if (code === '23505') throw new ConflictError('hitl', detail);
  // 23514: the expiry-direction CHECK — recording an expiry before the deadline,
  // or a user decision after it. A live race, not a malformed request.
  if (code === '23514') throw new ConflictError('hitl', detail);
  // 23503: the decision names a (request, generation, version) that does not exist.
  if (code === '23503') throw new InvalidRecordError(detail);
  // P0001: the trigger's isolation refusal — the store always opens READ
  // COMMITTED, so this means the server forced a higher isolation on us.
  if (code === 'P0001') throw new InvalidRecordError(detail);
  throw new BackendUnavailableError(`${what}: ${detail}`);
}

// Shared by the live store AND the legacy-spool drain in insertDataRow, so a
// drained entry materializes the same durable rows a live write would.
async function insertHitlDecisionRow(
  client: pg.PoolClient,
  workspaceId: string,
  d: NormalizedDecision,
  id: string,
  now: number,
): Promise<number> {
  const payload = snapshotPayload({
    requestId: d.requestId,
    generation: d.generation,
    requestVersion: d.requestVersion,
    status: d.status,
    decidedBy: d.decidedBy,
    note: d.note,
    feedback: d.feedback,
  });
  const res = await client.query(
    `INSERT INTO hitl.decisions
       (id, workspace_id, request_id, generation, request_version, status, payload, decided_at, feedback,
        producer_id, producer_seq, created_at)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, NULL, NULL, $8)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [id, workspaceId, d.requestId, d.generation, d.requestVersion, d.status, payload.canonical, now, d.feedback],
  );
  return res.rowCount ?? 0;
}

// The clock that DECIDED an expiry, read inside the locked transaction. Expiry
// eligibility is evaluated by the database (hitl.request_state and the decision
// trigger both use clock_timestamp()), so the durable audit stamp must come from
// that same clock: stamping a system expiry with the caller's clock let a skewed
// application write "expired at T" for a T at which the request had not yet
// expired — a history record contradicting the decision that produced it.
async function dbNowMs(client: pg.PoolClient): Promise<number> {
  const res = await client.query(`SELECT hitl.now_ms() AS now_ms`);
  return num((res.rows[0] as { now_ms: unknown }).now_ms);
}

// The expiry a generation must carry BEFORE the next one may open. Called from
// both write paths — the live store and the pre-#319 spool drain — inside the
// same locked transaction that inserts G+1, so an effectively-expired head can
// never be hidden behind a new generation with no durable boundary.
async function materializeHeadExpiry(
  client: pg.PoolClient,
  workspaceId: string,
  head: {
    requestId: string;
    generation: number;
    version: number;
    effectiveStatus: HitlStatus;
    terminalStatus: HitlDecisionStatus | null;
    superseded: boolean;
  },
): Promise<void> {
  // A superseded head takes no decision at all (the trigger RAISEs), and a
  // superseded group can no longer open a next generation anyway — the same
  // exclusion the candidate scan applies (finding 1c).
  if (head.effectiveStatus !== 'expired' || head.terminalStatus !== null || head.superseded) return;
  await insertHitlDecisionRow(
    client,
    workspaceId,
    systemExpiryDecision(head.requestId, head.generation, head.version),
    systemExpiryId(workspaceId, head.requestId, head.generation, head.version),
    await dbNowMs(client),
  );
}

// Every head a write CLOSES owes its durable expiry first, and a `replaces`
// closes two: the destination head that generation G+1 supersedes, and the
// SOURCE head the supersession row cancels. Materializing only the destination's
// lost the source's transition permanently — once the supersession row exists,
// the decision trigger refuses every decision on that head and both backends'
// candidate scans skip it, so nothing could ever record it (round-7 finding).
// Ordered by request_key: the SAME deterministic sort inGroupTxn takes the two
// group locks in and the fill trigger mirrors, so a both-expired replace writes
// its two decisions in one order on both backends. Neither ordering constrains
// the other — but both must precede the version row, which is why they are
// written here rather than beside their own reads.
function expiryOrder(head: PgHeadRow | null, source: PgHeadRow | null): PgHeadRow[] {
  return [head, source]
    .filter((h): h is PgHeadRow => h !== null)
    .sort((a, b) => (a.requestKey < b.requestKey ? -1 : a.requestKey > b.requestKey ? 1 : 0));
}

type PgHeadRow = {
  requestId: string;
  requestKey: string;
  generation: number;
  version: number;
  packetHash: string;
  sealed: boolean;
  // The INCOMING supersession: hitl.request_state's anti-join over
  // requests.supersedes_* — is some other group's row pointing at THIS head?
  superseded: boolean;
  effectiveStatus: HitlStatus;
  terminalStatus: HitlDecisionStatus | null;
  // What this head row itself supersedes (the destination side of a `replaces`).
  supersedes: HitlSupersedesRef | null;
};

// For a workspace with a database, the LIVE store is Postgres: every write is a
// synchronous transaction under the per-group advisory lock and a DB outage is a
// BackendUnavailableError the agent retries. Nothing here ever touches the
// outbox — the whole `hitl` namespace is non-spoolable (owner decision 6 / D7).
class PgHitlStore implements HitlStore {
  private readonly deps: StoreDeps;
  private readonly objects: CreateOnlyObjectStore;
  private readonly policy: HitlExpiryPolicy;
  private sweeping = false;

  constructor(deps: StoreDeps, objects: CreateOnlyObjectStore, policy: HitlExpiryPolicy) {
    this.deps = deps;
    this.objects = objects;
    this.policy = policy;
  }

  // The throttled bookkeeping sweep (PLAN D). It runs AFTER the verb's own work
  // and swallows its own failures, because nothing depends on it: the
  // sweep-INDEPENDENT effective_status already keeps an unswept expiry out of
  // the queue and out of authority. The re-entrancy flag keeps the sweep's own
  // insertSystemExpiry calls from re-triggering it.
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await maybeSweep(this, this.deps.now());
    } finally {
      this.sweeping = false;
    }
  }

  // #323's object port, unchanged: object-first, then the row; the immutable
  // version id is recorded IN the packet hash, so swapping the referenced bytes
  // invalidates the approval like any other packet edit.
  private offload(): HitlPayloadOffload {
    return async (bytes, digest) => {
      const put = await this.objects.putIfAbsent({ prefix: 'hitl', segments: [digest] }, bytes, {
        contentType: 'text/plain; charset=utf-8',
      });
      return { objectVersionId: put.objectVersionId, uri: null };
    };
  }

  private async resolveBody(row: HitlRequestEnvelope): Promise<string | null> {
    if (row.body !== null) return row.body;
    if (row.payloadRef === null) return null;
    // Read BY THE RECORDED VERSION, never "latest".
    const got = await this.objects.get(
      { prefix: 'hitl', segments: [row.payloadRef.digest] },
      row.payloadRef.objectVersionId,
    );
    if (got === null) {
      throw new InvalidRecordError(
        `HITL request ${row.id} references payload ${row.payloadRef.digest}, which is not in the object store`,
      );
    }
    if (sha256Hex(got.body) !== row.payloadRef.digest) {
      throw new InvalidRecordError(`HITL payload ${row.payloadRef.digest} bytes do not match their digest`);
    }
    return got.body.toString('utf8');
  }

  // Every HITL transaction: EXPLICIT read committed (the decision trigger RAISEs
  // under a higher isolation — its lock-then-read serialization cannot see a
  // concurrent terminal decision through a snapshot taken before the lock), then
  // the per-group advisory lock(s) in deterministic key order so two cross-group
  // `replaces` in opposite directions cannot deadlock. The trigger takes the SAME
  // lock, which makes it re-entrant here, not a self-deadlock.
  private async inGroupTxn<T>(
    keys: readonly string[],
    what: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect().catch((err) => rethrowAsBackendError(err, what));
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      for (const key of [...new Set(keys)].sort()) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1) # ${HITL_GROUP_LOCK_MASK})`, [key]);
      }
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      mapHitlPgError(err, what);
    } finally {
      client.release();
    }
  }

  private async readHeadLocked(client: pg.PoolClient, requestId: string): Promise<PgHeadRow | null> {
    const res = await client.query(
      `SELECT s.request_id, s.request_key, s.generation, s.version, s.packet_hash, s.sealed,
              s.superseded, s.effective_status, s.terminal_status,
              r.supersedes_request_id, r.supersedes_generation, r.supersedes_version
         FROM hitl.request_state s
         JOIN hitl.requests r
           ON r.workspace_id = s.workspace_id AND r.id = s.request_id
          AND r.generation = s.generation AND r.version = s.version
        WHERE s.workspace_id = $1::uuid AND s.request_id = $2`,
      [this.deps.workspaceId, requestId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      requestId: row.request_id as string,
      requestKey: row.request_key as string,
      generation: num(row.generation),
      version: num(row.version),
      packetHash: row.packet_hash as string,
      sealed: row.sealed === true,
      superseded: row.superseded === true,
      effectiveStatus: row.effective_status as HitlStatus,
      terminalStatus: (row.terminal_status ?? null) as HitlDecisionStatus | null,
      supersedes: supersedesOf(
        row.supersedes_request_id,
        row.supersedes_generation === null || row.supersedes_generation === undefined
          ? null
          : num(row.supersedes_generation),
        row.supersedes_version === null || row.supersedes_version === undefined ? null : num(row.supersedes_version),
      ),
    };
  }

  // A head may only be closed — by the NEXT generation over it, or by another
  // group's supersession row — once its own expiry is durable: materialize it in
  // the SAME transaction that writes the closing row, so an un-swept expiry can
  // never be hidden behind one.
  private async materializeExpiry(client: pg.PoolClient, head: PgHeadRow): Promise<void> {
    await materializeHeadExpiry(client, this.deps.workspaceId, head);
  }

  private async insertDecisionRow(
    client: pg.PoolClient,
    d: NormalizedDecision,
    id: string,
    now: number,
  ): Promise<number> {
    return await insertHitlDecisionRow(client, this.deps.workspaceId, d, id, now);
  }

  private async insertVersionRow(
    client: pg.PoolClient,
    p: PreparedSubmission,
    generation: number,
    version: number,
    supersedes: { requestId: string; generation: number; version: number } | null,
    now: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO hitl.requests
         (id, workspace_id, request_key, generation, version, action, action_kind, target, target_hash,
          packet_hash, canonicalization_version, content_hash, payload, payload_ref, expires_at,
          summary, warnings, side_effects, choices, origin_run_id, origin_task_id, requesting_agent,
          sanitized_summary, supersedes_request_id, supersedes_generation, supersedes_version,
          status, producer_id, producer_seq, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13::jsonb, $14::jsonb, $15,
               $16, $17::jsonb, $18::jsonb, $19::jsonb, $20, $21, $22,
               $23, $24, $25, $26,
               'awaiting', NULL, NULL, $27)`,
      [
        p.requestId,
        this.deps.workspaceId,
        p.requestKey,
        generation,
        version,
        p.action,
        p.actionKind,
        p.target,
        p.targetHash,
        p.packetHash,
        p.canonicalizationVersion,
        p.contentHash,
        p.body === null ? null : JSON.stringify(encodeInlinePayload(p)),
        p.payloadRef === null ? null : JSON.stringify(encodeStoredRef(p)),
        p.expiresAt,
        p.summary,
        p.warnings === null ? null : JSON.stringify(p.warnings),
        p.sideEffects === null ? null : JSON.stringify(p.sideEffects),
        p.choices === null ? null : JSON.stringify(p.choices),
        p.originRunId,
        p.originTaskId,
        p.requestingAgent,
        p.sanitizedSummary,
        supersedes?.requestId ?? null,
        supersedes?.generation ?? null,
        supersedes?.version ?? null,
        now,
      ],
    );
  }

  async createRequest(input: HitlRequestInput): Promise<HitlWriteOutcome> {
    const prepared = await prepareSubmission(
      this.deps.workspaceId,
      input,
      this.policy,
      this.deps.now(),
      this.offload(),
    );
    const out = await this.inGroupTxn([prepared.requestKey], 'postgres hitl.createRequest failed', async (client) => {
      // The DATABASE clock, read under the group lock: the expiry policy is
      // re-resolved (and the packet re-sealed around it) against the same clock
      // hitl.request_state, the decision trigger and the sweep all evaluate
      // expiry with, and it stamps created_at too. See resealExpiry.
      const now = await dbNowMs(client);
      const sealed = resealExpiry(prepared, this.policy, now);
      const head = await this.readHeadLocked(client, sealed.requestId);
      return await this.applyPlan(client, sealed, head, null, now);
    });
    await this.sweep();
    return out;
  }

  async replaces(input: HitlReplaceInput): Promise<HitlWriteOutcome> {
    const sourceRequestId = requireString('sourceRequestId', input.sourceRequestId);
    const sourceExpected = assertExpectedHead(input.sourceExpectedHead, 'sourceExpectedHead');
    if (sourceExpected === undefined || sourceExpected === null) {
      throw new InvalidRecordError('sourceExpectedHead is required — a replace must name the head it cancels');
    }
    const prepared = await prepareSubmission(
      this.deps.workspaceId,
      input.request,
      this.policy,
      this.deps.now(),
      this.offload(),
    );
    if (prepared.requestId === sourceRequestId) {
      throw new InvalidRecordError(
        'replaces targets a DIFFERENT request group — a same-key edit is a revision, not a supersession',
      );
    }
    // request_key is immutable per row, so resolving the source's lock key
    // BEFORE the lock is safe (the DB trigger reads it the same way).
    const sourceKey = await this.deps.pool
      .query(`SELECT request_key FROM hitl.requests WHERE workspace_id = $1::uuid AND id = $2 LIMIT 1`, [
        this.deps.workspaceId,
        sourceRequestId,
      ])
      .catch((err) => rethrowAsBackendError(err, 'postgres hitl.replaces failed'));
    const sourceKeyRow = sourceKey.rows[0] as { request_key: string } | undefined;
    if (sourceKeyRow === undefined) {
      throw new InvalidRecordError(`HITL request ${sourceRequestId} does not exist — nothing to supersede`);
    }
    const out = await this.inGroupTxn(
      [prepared.requestKey, sourceKeyRow.request_key],
      'postgres hitl.replaces failed',
      async (client) => {
        const now = await dbNowMs(client);
        const sealedSubmission = resealExpiry(prepared, this.policy, now);
        const source = await this.readHeadLocked(client, sourceRequestId);
        if (source === null) {
          throw new ConflictError(sourceRequestId, 'missing-history: the source request group has no versions');
        }
        if (
          source.generation !== sourceExpected.generation ||
          source.version !== sourceExpected.version ||
          source.packetHash !== sourceExpected.packetHash ||
          source.sealed !== sourceExpected.sealed
        ) {
          throw new ConflictError(
            sourceRequestId,
            `stale-expected-head: the source head is generation ${source.generation} version ${source.version} (sealed: ${source.sealed}), not ${sourceExpected.generation}/${sourceExpected.version} (sealed: ${sourceExpected.sealed})`,
          );
        }
        const head = await this.readHeadLocked(client, sealedSubmission.requestId);
        return await this.applyPlan(client, sealedSubmission, head, source, now);
      },
    );
    await this.sweep();
    return out;
  }

  private async applyPlan(
    client: pg.PoolClient,
    prepared: PreparedSubmission,
    head: PgHeadRow | null,
    source: PgHeadRow | null,
    now: number,
  ): Promise<HitlWriteOutcome> {
    const supersedes =
      source === null
        ? null
        : { requestId: source.requestId, generation: source.generation, version: source.version };
    const planned = planFor(
      {
        head:
          head === null
            ? null
            : {
                generation: head.generation,
                version: head.version,
                packetHash: head.packetHash,
                sealed: head.sealed,
                // The incoming supersession, bound into PLANNING (round-4
                // finding 1a): a replaced head keeps its exact fingerprint, so
                // the expectation check alone cannot tell a stale caller that
                // its group is closed.
                superseded: head.superseded,
              },
      },
      prepared,
    );
    if (planned.kind === 'conflict') throw conflictFromPlan(prepared.requestId, planned);
    // The shared finalizer owns BOTH the idempotent→revise upgrade a `replaces`
    // owes its supersession link AND the closure re-check that upgrade demands
    // (R5 finding 1).
    const plan = finalizeSubmissionPlan(
      planned,
      head,
      supersedes === null ? null : { requested: supersedes, recorded: head?.supersedes ?? null },
    );
    if (plan.kind === 'conflict') throw conflictFromPlan(prepared.requestId, plan);
    // The SOURCE side of the same closure rule the machine applies to the
    // destination: a head another group already replaced cannot be replaced a
    // second time, or two destinations would each claim to cancel it. Scoped to
    // plans that WRITE, so replaying the original replace (whose link the
    // destination head already records) stays an idempotent no-op.
    if (plan.kind !== 'idempotent' && source !== null && source.superseded) {
      throw new ConflictError(
        source.requestId,
        'superseded-head: the source head was already superseded by another request group — re-read and target the group that replaced it',
      );
    }
    const outcome: HitlWriteOutcome = {
      outcome: 'committed',
      id: prepared.requestId,
      requestId: prepared.requestId,
      generation: plan.generation,
      version: plan.version,
      idempotent: plan.kind === 'idempotent',
      warnings: prepared.policyWarnings,
    };
    if (plan.kind === 'idempotent') return outcome;
    for (const owed of expiryOrder(head, source)) await this.materializeExpiry(client, owed);
    await this.insertVersionRow(client, prepared, plan.generation, plan.version, supersedes, now);
    return outcome;
  }

  async appendDecision(input: HitlDecisionInput): Promise<HitlDecisionOutcome> {
    const d = normalizeDecision(input);
    const keyRes = await this.deps.pool
      .query(`SELECT request_key FROM hitl.requests WHERE workspace_id = $1::uuid AND id = $2 LIMIT 1`, [
        this.deps.workspaceId,
        d.requestId,
      ])
      .catch((err) => rethrowAsBackendError(err, 'postgres hitl.appendDecision failed'));
    const keyRow = keyRes.rows[0] as { request_key: string } | undefined;
    if (keyRow === undefined) throw new InvalidRecordError(`HITL request ${d.requestId} does not exist`);
    const out = await this.inGroupTxn(
      [keyRow.request_key],
      'postgres hitl.appendDecision failed (decisions require the live store and are never spooled)',
      async (client) => {
        const head = await this.readHeadLocked(client, d.requestId);
        if (head === null) throw new InvalidRecordError(`HITL request ${d.requestId} does not exist`);
        // The DB's clock, read AFTER the group lock — the same clock that
        // decided this head's effective status (hitl.request_state) and that the
        // decision trigger will re-check the expiry direction against. Reading
        // the application clock here made a skewed caller refuse a decision the
        // database considered perfectly decidable (round-3 finding 3), exactly
        // the mismatch the system-expiry path already fixed via dbNowMs.
        const now = await dbNowMs(client);
        // The shared machine refuses first (same reasons, same wording as the
        // local backend); the trigger + partial indexes are the DB-side backstop
        // that also binds a RAW runtime INSERT.
        const projected = await this.headForMachine(client, d.requestId);
        const check = canDecide(projected, d.status, now);
        if (!check.ok) throw decisionRefusal(d.requestId, check);
        await this.insertDecisionRow(client, d, decisionId(this.deps.workspaceId, d), now);
        return {
          outcome: 'committed' as const,
          id: decisionId(this.deps.workspaceId, d),
          requestId: d.requestId,
          generation: d.generation,
          requestVersion: d.requestVersion,
          status: d.status,
        };
      },
    );
    await this.sweep();
    return out;
  }

  // The view row rendered as the machine's HitlHead so canDecide/canAuthorize
  // read exactly the same shape on both backends.
  private async headForMachine(client: PgQueryable, requestId: string): Promise<HitlHead> {
    const res = await client.query(
      `SELECT ${HITL_HEAD_COLUMNS} ${HITL_HEAD_FROM}
        WHERE s.workspace_id = $1::uuid AND s.request_id = $2`,
      [this.deps.workspaceId, requestId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new InvalidRecordError(`HITL request ${requestId} does not exist`);
    const env = hitlEnvelopeFromRow(this.deps.workspaceId, row);
    return {
      requestId: env.id,
      requestKey: env.requestKey,
      generation: env.generation,
      version: env.version,
      action: env.action,
      actionKind: env.actionKind,
      target: env.target,
      targetHash: env.targetHash,
      packetHash: env.packetHash,
      canonicalizationVersion: env.canonicalizationVersion,
      expiresAt: env.expiresAt,
      createdAt: env.createdAt,
      nodeStatus: env.nodeStatus,
      status: env.status,
      terminalStatus: env.terminalStatus,
      deferred: env.deferred,
      sealed: env.sealed,
      isCurrentVersion: true,
      isHighestGeneration: true,
      superseded: env.superseded,
    };
  }

  // Degraded HITL reads FAIL CLOSED (owner decision 6): there is no queued HITL
  // overlay to serve and `allowPartial` is not offered — an approval system that
  // answers "no pending approvals" from an incomplete view is worse than one that
  // says it cannot answer.
  private unavailable(err: unknown, what: string): never {
    rethrowAsBackendError(err, what);
  }

  async getRequest(id: string): Promise<HitlRequestEnvelope | null> {
    requireString('id', id);
    try {
      const res = await this.deps.pool.query(
        `SELECT ${HITL_HEAD_COLUMNS} ${HITL_HEAD_FROM}
          WHERE s.workspace_id = $1::uuid AND s.request_id = $2`,
        [this.deps.workspaceId, id],
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      const env = hitlEnvelopeFromRow(this.deps.workspaceId, row);
      return { ...env, body: await this.resolveBody(env) };
    } catch (err) {
      this.unavailable(err, 'postgres hitl.getRequest failed');
    }
  }

  async listRequests(filter: HitlRequestFilter, cursor?: Cursor): Promise<Page<HitlRequestEnvelope>> {
    if (filter.status === undefined) await this.sweep();
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
      // Pagination is anchored on the GROUP's creation position (the lowest seq
      // any of its versions holds), never on its head's — a head moves when the
      // request is revised. Both backends used to project the latest head and
      // then apply `seq <= watermark`, so revising a request mid-traversal
      // pushed it past the watermark and it vanished from the whole listing
      // while a fresh listing found it (round-3 finding 4). The anchor is
      // immutable for the life of the group, so a request that exists
      // throughout the traversal is visited exactly once — and the watermark
      // keeps its stated meaning: groups CREATED after page one stay out.
      const res = await this.deps.pool.query(
        `SELECT ${HITL_HEAD_COLUMNS}, a.anchor_seq ${HITL_HEAD_FROM}
          JOIN LATERAL (
            SELECT min(g.seq) AS anchor_seq
              FROM hitl.requests g
             WHERE g.workspace_id = s.workspace_id AND g.id = s.request_id
          ) a ON true
          WHERE s.workspace_id = $1::uuid AND a.anchor_seq <= $2 AND a.anchor_seq > $3
          ${hitlFilterSql('$4', '$5')}
          ORDER BY a.anchor_seq
          LIMIT $6`,
        [this.deps.workspaceId, watermark, after, filter.functionName ?? null, filter.status ?? null, limit + 1],
      );
      const rows = res.rows as Record<string, unknown>[];
      const taken = rows.slice(0, limit);
      // A listing never fans out into object reads; `getRequest` materializes an
      // offloaded body.
      const items = taken.map((row) => hitlEnvelopeFromRow(this.deps.workspaceId, row));
      const more = rows.length > limit;
      const committedMark = taken.length > 0 ? num(taken[taken.length - 1]!.anchor_seq) : after;
      return {
        items,
        cursor: more ? { watermark, committed: committedMark, overlay: null } : null,
        partial: false,
      };
    } catch (err) {
      this.unavailable(err, 'postgres hitl.listRequests failed');
    }
  }

  async count(filter?: HitlRequestFilter): Promise<CountResult> {
    if (filter?.status === undefined) await this.sweep();
    try {
      const res = await this.deps.pool.query(
        `SELECT count(*)::int AS n ${HITL_HEAD_FROM}
          WHERE s.workspace_id = $1::uuid
          ${hitlFilterSql('$2', '$3')}`,
        [this.deps.workspaceId, filter?.functionName ?? null, filter?.status ?? null],
      );
      return { committed: num((res.rows[0] as { n: unknown }).n), queued: 0, partial: false };
    } catch (err) {
      this.unavailable(err, 'postgres hitl.count failed');
    }
  }

  async listVersions(id: string): Promise<HitlVersionRecord[]> {
    requireString('id', id);
    try {
      const res = await this.deps.pool.query(
        `SELECT id, request_key, generation, version, action, action_kind, target, target_hash, packet_hash,
                canonicalization_version, expires_at, created_at, seq,
                supersedes_request_id, supersedes_generation, supersedes_version
           FROM hitl.requests
          WHERE workspace_id = $1::uuid AND id = $2
          ORDER BY generation, version`,
        [this.deps.workspaceId, id],
      );
      return (res.rows as Record<string, unknown>[]).map((row) => ({
        requestId: row.id as string,
        requestKey: row.request_key as string,
        generation: num(row.generation),
        version: num(row.version),
        action: row.action as string,
        actionKind: row.action_kind as HitlActionKind,
        target: row.target as string,
        targetHash: row.target_hash as string,
        packetHash: row.packet_hash as string,
        canonicalizationVersion: num(row.canonicalization_version),
        expiresAt: row.expires_at === null ? null : num(row.expires_at),
        createdAt: num(row.created_at),
        seq: num(row.seq),
        supersedes: supersedesOf(
          row.supersedes_request_id,
          row.supersedes_generation === null ? null : num(row.supersedes_generation),
          row.supersedes_version === null ? null : num(row.supersedes_version),
        ),
      }));
    } catch (err) {
      this.unavailable(err, 'postgres hitl.listVersions failed');
    }
  }

  async listGenerations(id: string): Promise<HitlGenerationSummary[]> {
    requireString('id', id);
    try {
      const res = await this.deps.pool.query(
        `WITH heads AS (
             SELECT DISTINCT ON (r.generation) r.generation, r.version, r.expires_at
               FROM hitl.requests r
              WHERE r.workspace_id = $1::uuid AND r.id = $2
              ORDER BY r.generation, r.version DESC
           ), counts AS (
             SELECT generation, count(*)::int AS versions, min(created_at) AS created_at
               FROM hitl.requests
              WHERE workspace_id = $1::uuid AND id = $2
              GROUP BY generation
           )
           SELECT c.generation, c.versions, c.created_at, h.version AS head_version, h.expires_at,
                  hitl.now_ms() AS now_ms,
                  t.status AS terminal_status,
                  EXISTS (
                    SELECT 1 FROM hitl.decisions d
                     WHERE d.workspace_id = $1::uuid AND d.request_id = $2
                       AND d.generation = c.generation AND d.request_version = h.version
                       AND d.status = 'deferred'
                  ) AS deferred
             FROM counts c
             JOIN heads h ON h.generation = c.generation
             LEFT JOIN LATERAL (
               SELECT d.status FROM hitl.decisions d
                WHERE d.workspace_id = $1::uuid AND d.request_id = $2
                  AND d.generation = c.generation AND d.request_version = h.version AND d.terminal
                ORDER BY d.decided_at, d.seq LIMIT 1
             ) t ON true
            ORDER BY c.generation`,
        [this.deps.workspaceId, id],
      );
      return (res.rows as Record<string, unknown>[]).map((row) => {
        const terminal = (row.terminal_status ?? null) as HitlStatus | null;
        const expiresAt = row.expires_at === null ? null : num(row.expires_at);
        const expired = expiresAt !== null && num(row.now_ms) >= expiresAt;
        return {
          generation: num(row.generation),
          versions: num(row.versions),
          headVersion: num(row.head_version),
          status: terminal ?? (expired ? 'expired' : row.deferred === true ? 'deferred' : 'awaiting'),
          sealed: terminal !== null || expired,
          createdAt: num(row.created_at),
        };
      });
    } catch (err) {
      this.unavailable(err, 'postgres hitl.listGenerations failed');
    }
  }

  async listDecisions(id: string): Promise<HitlDecisionEnvelope[]> {
    requireString('id', id);
    try {
      const res = await this.deps.pool.query(
        `SELECT id, request_id, generation, request_version, status, terminal, payload, decided_at,
                feedback, created_at, seq
           FROM hitl.decisions
          WHERE workspace_id = $1::uuid AND request_id = $2
          ORDER BY generation, request_version, seq`,
        [this.deps.workspaceId, id],
      );
      return (res.rows as Record<string, unknown>[]).map((row) => {
        const p = (row.payload ?? {}) as { decidedBy?: unknown; note?: unknown };
        return {
          id: row.id as string,
          workspaceId: this.deps.workspaceId,
          requestId: row.request_id as string,
          generation: num(row.generation),
          requestVersion: num(row.request_version),
          status: row.status as HitlDecisionStatus,
          decidedBy: typeof p.decidedBy === 'string' ? p.decidedBy : 'unknown',
          note: typeof p.note === 'string' ? p.note : null,
          feedback: (row.feedback ?? null) as string | null,
          terminal: row.terminal === true,
          decidedAt: num(row.decided_at),
          createdAt: num(row.created_at),
          seq: num(row.seq),
        };
      });
    } catch (err) {
      this.unavailable(err, 'postgres hitl.listDecisions failed');
    }
  }

  // The candidate set is the DB's own sweep-independent projection, so the
  // caller's clock is advisory only — the view evaluates clock_timestamp().
  async listExpiryCandidates(_now: number, limit: number): Promise<HitlExpiryCandidate[]> {
    try {
      const res = await this.deps.pool.query(
        // `NOT superseded`: the decision trigger refuses EVERY decision on a
        // superseded version, system expiry included, so such a head can never
        // be materialized — leaving it in the workset would make each sweep
        // re-attempt a write the database always rejects (round-4 finding 1c).
        `SELECT request_id, request_key, generation, version, expires_at
           FROM hitl.request_state
          WHERE workspace_id = $1::uuid
            AND effective_status = 'expired'
            AND terminal_status IS NULL
            AND NOT superseded
          ORDER BY expires_at
          LIMIT $2`,
        [this.deps.workspaceId, limit],
      );
      return (res.rows as Record<string, unknown>[]).map((row) => ({
        requestId: row.request_id as string,
        requestKey: row.request_key as string,
        generation: num(row.generation),
        version: num(row.version),
        expiresAt: num(row.expires_at),
      }));
    } catch (err) {
      this.unavailable(err, 'postgres hitl.listExpiryCandidates failed');
    }
  }

  // `now` is the CALLER's clock and is deliberately unused: both the eligibility
  // decision and the durable stamp belong to the database's clock (see dbNowMs).
  async insertSystemExpiry(candidate: HitlExpiryCandidate, _now: number): Promise<'expired' | 'conflict'> {
    return await this.inGroupTxn([candidate.requestKey], 'postgres hitl.insertSystemExpiry failed', async (client) => {
      const head = await this.readHeadLocked(client, candidate.requestId);
      if (
        head === null ||
        head.generation !== candidate.generation ||
        head.version !== candidate.version ||
        head.effectiveStatus !== 'expired' ||
        // The trigger would RAISE here; report the conflict the local backend
        // reports instead of turning a bookkeeping pass into an error (1c).
        head.superseded
      ) {
        return 'conflict' as const;
      }
      // Server-stamped: the DB clock decided this candidate is expired (the
      // view's clock_timestamp()), so the DB clock — read here, after the group
      // lock — is what the durable record carries. The deterministic id is
      // unchanged, so concurrent sweeps still converge on ONE row instead of
      // two differently-stamped ones.
      const written = await this.insertDecisionRow(
        client,
        systemExpiryDecision(candidate.requestId, candidate.generation, candidate.version),
        systemExpiryId(this.deps.workspaceId, candidate.requestId, candidate.generation, candidate.version),
        await dbNowMs(client),
      );
      return written > 0 ? ('expired' as const) : ('conflict' as const);
    });
  }
}

// ---------- runs ----------

function runEventFromRow(row: Record<string, unknown>): RunEventEnvelope {
  // v1→v2 normalize (finding: v1 records not upgraded) — a #318 payload jsonb
  // used `type` (not `kind`) and lacked the v2 metadata fields.
  const p = normalizeStoredEventPayload(row.payload);
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    runId: p.runId,
    kind: p.kind,
    dedupeKey: p.dedupeKey,
    data: p.data,
    agent: p.agent ?? null,
    skill: p.skill ?? null,
    trigger: p.trigger ?? null,
    parentRunId: p.parentRunId ?? null,
    originTaskId: p.originTaskId ?? null,
    correlationId: (row.correlation_id as string | null) ?? null,
    source: (row.source as RunEventSource | null) ?? 'unverified',
    pid: (row.pid as string | null) ?? null,
    startedAt: row.started_at == null ? null : num(row.started_at),
    endedAt: row.ended_at == null ? null : num(row.ended_at),
    sanitizedReport: (row.sanitized_report as string | null) ?? null,
    seq: num(row.seq),
    createdAt: num(row.created_at),
    queued: false,
  };
}

function queuedRunEvent(workspaceId: string, e: OutboxEntryState): RunEventEnvelope {
  // v1→v2 normalize a queued (#318) payload (finding: queued v1 run events read
  // kind=undefined) before exposing it.
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

class PgRunStore implements RunStore {
  private readonly deps: StoreDeps;

  constructor(deps: StoreDeps) {
    this.deps = deps;
  }

  // The committed canonical event identities (run-scoped) WITH their stable
  // payload hashes for a set of runs, so a queued v1/v2 retry of an already-
  // committed event is not re-counted when merged into a committed run's summary
  // (finding: canonical dedup did not reach run summaries) AND a queued event
  // whose canonical id matches a committed one is suppressed ONLY when its
  // stable payload is identical — a differing payload is the same divergence
  // getRun raises, never silently hidden (round-6 finding 7).
  //
  // TWO maps, because identity and pagination answer different questions
  // (round-7 finding 1): `all` spans EVERY committed row of the run regardless of
  // seq and is the divergence arbiter — a committed row that landed ABOVE the
  // frozen watermark (an outage healing mid-pagination) previously escaped the
  // committed↔queued comparison entirely, so listRuns returned a clean one-event
  // summary while getRun raised ConflictError. `atWatermark` keeps the
  // seq <= watermark bound and is what the page's event COUNT merges against, so
  // the summary stays a consistent snapshot.
  private async committedCanonicalByRun(
    runIds: string[],
    watermark: number,
  ): Promise<{ all: Map<string, Map<string, string>>; atWatermark: Map<string, Map<string, string>> }> {
    const all = new Map<string, Map<string, string>>();
    const atWatermark = new Map<string, Map<string, string>>();
    if (runIds.length === 0) return { all, atWatermark };
    const res = await this.deps.pool.query(
      `SELECT run_id, seq, payload FROM roster_ops.run_events
        WHERE workspace_id = $1::uuid AND run_id = ANY($2::text[])
        ORDER BY seq`,
      [this.deps.workspaceId, runIds],
    );
    for (const row of res.rows as Record<string, unknown>[]) {
      const p = normalizeStoredEventPayload(row.payload);
      const cid = canonicalRunEventId(this.deps.workspaceId, p);
      const hash = runEventStableHash(p);
      let m = all.get(p.runId);
      if (m === undefined) {
        m = new Map();
        all.set(p.runId, m);
      }
      trackCanonicalStableHash(m, cid, hash);
      if (num(row.seq) <= watermark) {
        let w = atWatermark.get(p.runId);
        if (w === undefined) {
          w = new Map();
          atWatermark.set(p.runId, w);
        }
        trackCanonicalStableHash(w, cid, hash);
      }
    }
    return { all, atWatermark };
  }

  // Committed-side canonical-conflict detection — parity with local listRuns and
  // getRun (finding: PG listRuns' COUNT(DISTINCT (type, dedupe_key)) summary
  // silently collapsed a v1 {phase:old} + v2 {phase:new} pair into a clean
  // one-event count, while local's grouping — and getRun's dedupRunEvents —
  // raised a ConflictError). A run whose physical committed rows exceed its
  // DISTINCT (type, dedupe_key) count has records sharing a canonical id: a
  // BENIGN v1↔v2 retry (identical stable payload) OR a GENUINE conflict; COUNT
  // alone cannot tell them apart. Materialize ONLY those collision-candidate runs
  // and route them through the SAME stable-hash arbiter (trackCanonicalStableHash)
  // the write / getRun / local-summary paths use, which throws on a differing
  // stable payload. All-v2 data (no shared canonical ids) skips the second query.
  // Watermark-INDEPENDENT (round-7 finding 1): divergence is an identity fact,
  // not a pagination snapshot — a v1/v2 pair that commits ABOVE a frozen
  // watermark mid-pagination must raise here exactly as getRun raises for it.
  private async assertNoCommittedCanonicalConflict(runId: string | null): Promise<void> {
    const candidates = await this.deps.pool.query(
      `SELECT run_id FROM roster_ops.run_events
        WHERE workspace_id = $1::uuid AND ($2::text IS NULL OR run_id = $2)
        GROUP BY run_id
       HAVING COUNT(*) > COUNT(DISTINCT (type, dedupe_key))`,
      [this.deps.workspaceId, runId],
    );
    const runIds = (candidates.rows as { run_id: string }[]).map((r) => r.run_id);
    if (runIds.length === 0) return;
    const res = await this.deps.pool.query(
      `SELECT run_id, payload FROM roster_ops.run_events
        WHERE workspace_id = $1::uuid AND run_id = ANY($2::text[])
        ORDER BY seq`,
      [this.deps.workspaceId, runIds],
    );
    const seenByRun = new Map<string, Map<string, string>>();
    for (const row of res.rows as Record<string, unknown>[]) {
      const p = normalizeStoredEventPayload(row.payload);
      const cid = canonicalRunEventId(this.deps.workspaceId, p);
      let seen = seenByRun.get(p.runId);
      if (seen === undefined) {
        seen = new Map();
        seenByRun.set(p.runId, seen);
      }
      trackCanonicalStableHash(seen, cid, runEventStableHash(p)); // throws ConflictError on a differing payload
    }
  }

  // Read a frozen queued run through the committed store by id, IGNORING the
  // pagination watermark (round-7 finding 4): the run left the pending overlay
  // mid-pagination (drained + acked), so its rows sit at seq > watermark — the
  // committed page query excludes them and the live overlay no longer carries
  // them; without this read-through the run would silently vanish from the
  // traversal. The frozen stable hashes seed the canonical map, so a commit
  // that DIVERGED from what was frozen raises the same ConflictError the live
  // merge would have raised.
  private async readRunThrough(frozen: FrozenQueuedRun): Promise<RunSummary> {
    const res = await this.deps.pool.query(
      `SELECT seq, payload, created_at FROM roster_ops.run_events
        WHERE workspace_id = $1::uuid AND run_id = $2
        ORDER BY seq`,
      [this.deps.workspaceId, frozen.runId],
    );
    const rows = res.rows as Record<string, unknown>[];
    if (rows.length === 0) {
      // Neither pending nor committed (an ack without rows should not happen);
      // fall back to the frozen identity so the run still appears exactly once.
      return {
        runId: frozen.runId,
        workspaceId: this.deps.workspaceId,
        firstSeq: 0,
        lastSeq: 0,
        events: Object.keys(frozen.hashes).length,
        startedAt: frozen.startedAt,
        lastEventAt: frozen.lastEventAt,
        queued: true,
      };
    }
    const canonical = new Map<string, string>(Object.entries(frozen.hashes));
    let firstSeq = Number.MAX_SAFE_INTEGER;
    let lastSeq = 0;
    let startedAt = Number.MAX_SAFE_INTEGER;
    let lastEventAt = 0;
    for (const row of rows) {
      const p = normalizeStoredEventPayload(row.payload);
      trackCanonicalStableHash(canonical, canonicalRunEventId(this.deps.workspaceId, p), runEventStableHash(p));
      const seq = num(row.seq);
      const at = num(row.created_at);
      firstSeq = Math.min(firstSeq, seq);
      lastSeq = Math.max(lastSeq, seq);
      startedAt = Math.min(startedAt, at);
      lastEventAt = Math.max(lastEventAt, at);
    }
    return {
      runId: frozen.runId,
      workspaceId: this.deps.workspaceId,
      firstSeq,
      lastSeq,
      events: canonical.size,
      startedAt,
      lastEventAt,
      queued: false,
    };
  }

  async appendEvent(input: RunEventInput): Promise<WriteOutcome> {
    const { id, payload, canonical, observations } = runEventParts(this.deps.workspaceId, input, {
      now: this.deps.now(),
      pid: this.deps.pid(),
    });
    if (this.deps.outbox) {
      return await this.deps.outbox.writeThrough(
        { namespace: 'runs', id, kind: 'run-event', payload, observations },
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
        observations,
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
        `SELECT seq, id, workspace_id::text AS workspace_id, payload, source, correlation_id,
                pid, started_at, ended_at, sanitized_report, created_at
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
          .filter((e) => e.kind === 'run-event' && normalizeStoredEventPayload(e.payload).runId === runId)
          .sort(overlayOrder)
          .map((e) => queuedRunEvent(this.deps.workspaceId, e));
        events = events.concat(queued);
      }
      // Collapse a v1 record and its post-upgrade v2 retry (shared canonical id).
      events = dedupRunEvents(this.deps.workspaceId, events);
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
      // Surface a committed-side canonical conflict BEFORE the summary (parity
      // with local + getRun): the COUNT(DISTINCT (type, dedupe_key)) below cannot
      // detect a v1/v2 same-id/different-payload collision, so check the
      // collision-candidate runs through the shared stable-hash arbiter first.
      await this.assertNoCommittedCanonicalConflict(filter.runId ?? null);
      const res = await this.deps.pool.query(
        // Count CANONICAL event identities (finding: a v1 record and its v2 retry
        // share a canonical id (type, run_id, dedupe_key) — getRun collapses them,
        // but COUNT(*) double-counted, so `run show` and `run list` disagreed).
        // DISTINCT (type, dedupe_key) per run equals the dedupRunEvents count.
        `SELECT run_id, MIN(seq) AS first_seq, MAX(seq) AS last_seq,
                COUNT(DISTINCT (type, dedupe_key)) AS events,
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
        { pos: OverlayPosition; canonical: Map<string, string>; startedAt: number; lastEventAt: number }
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
          const np = normalizeStoredEventPayload(e.payload);
          // Canonical id so a queued v1 record and its v2 retry count once
          // (finding: queued overlay summaries double-counted physical rows); the
          // stable-hash guard raises a same-id/different-payload conflict (R3-4).
          const cid = canonicalRunEventId(this.deps.workspaceId, np);
          const existing = overlayByRun.get(np.runId);
          if (existing) {
            trackCanonicalStableHash(existing.canonical, cid, runEventStableHash(np));
            existing.lastEventAt = Math.max(existing.lastEventAt, e.enqueuedAt);
          } else {
            overlayByRun.set(np.runId, {
              pos: positionOf(e),
              canonical: new Map([[cid, runEventStableHash(np)]]),
              startedAt: e.enqueuedAt,
              lastEventAt: e.enqueuedAt,
            });
          }
        }
        // The committed canonical identities (+ stable hashes) for the runs that
        // ALSO have queued events, so a queued retry of an already-committed
        // event is not re-counted on top of the committed DISTINCT
        // (type, dedupe_key) count. A queued event sharing a committed canonical
        // id is a benign retry ONLY when its stable payload hash matches; a
        // differing hash raises the SAME ConflictError getRun raises (round-6
        // finding 7 — the merge previously suppressed by id alone, silently
        // hiding the divergence).
        const committedCanonical = await this.committedCanonicalByRun([...overlayByRun.keys()], watermark);
        // Round-7 finding 3: run the stable-hash divergence check for EVERY
        // overlay run whose canonical id matches a committed one — page
        // membership must not matter. (The old check ran only inside the
        // current page's item merge, so a conflicting queued retry on a run
        // BEFORE the page — already returned — or AFTER it — beyond the page
        // bound — was silently discarded at the committed-run skip below.)
        for (const [runId, o] of overlayByRun) {
          const already = committedCanonical.all.get(runId);
          if (already === undefined) continue;
          for (const [cid, stableHash] of o.canonical) {
            if (already.has(cid)) {
              trackCanonicalStableHash(already, cid, stableHash); // throws ConflictError on a differing payload
            }
          }
        }
        for (const item of items) {
          const o = overlayByRun.get(item.runId);
          if (o) {
            const already = committedCanonical.atWatermark.get(item.runId);
            let add = 0;
            for (const cid of o.canonical.keys()) {
              if (already === undefined || !already.has(cid)) add += 1;
            }
            item.events += add;
            item.lastEventAt = Math.max(item.lastEventAt, o.lastEventAt);
          }
        }
      }

      // Round-7 finding 4: the queued-overlay identity set (run ids + their
      // stable hashes + ordering anchors) is FROZEN into the cursor at creation.
      // Later pages traverse this frozen set instead of rebuilding it from the
      // currently-pending entries: a run queued at page 1 that fully
      // commits+acks at seq > watermark before page 2 is no longer pending
      // (invisible to the live overlay) AND excluded by seq <= watermark on the
      // committed side — pre-fix it silently vanished from the traversal.
      const frozenQueued: FrozenQueuedRun[] =
        cursor?.frozenQueued ??
        [...overlayByRun].map(([runId, o]) => ({
          runId,
          pos: runAnchors?.get(runId) ?? o.pos,
          hashes: Object.fromEntries(o.canonical),
          startedAt: o.startedAt,
          lastEventAt: o.lastEventAt,
        }));

      if (moreCommitted) {
        return { items, cursor: { watermark, committed: committedMark, overlay: null, frozenQueued }, partial: false };
      }

      const queuedRuns: Array<{ pos: OverlayPosition; item: RunSummary }> = [];
      if (frozenQueued.length > 0) {
        // Classify runs as committed for THIS pagination ONLY by events at/below
        // the frozen watermark. A run whose only committed events landed AFTER
        // page 1 (seq > watermark) stays in the frozen-overlay traversal here,
        // so it is neither omitted (dropped by the watermark on the committed
        // side) nor duplicated.
        const committedRes = await this.deps.pool.query(
          `SELECT COALESCE(array_agg(DISTINCT run_id), '{}') AS runs
             FROM roster_ops.run_events
            WHERE workspace_id = $1::uuid AND seq <= $2 AND ($3::text IS NULL OR run_id = $3)`,
          [this.deps.workspaceId, watermark, filter.runId ?? null],
        );
        const committedRunIds = new Set((committedRes.rows[0] as { runs: string[] }).runs);
        for (const frozen of frozenQueued) {
          if (committedRunIds.has(frozen.runId)) continue; // already merged into a committed summary
          const live = overlayByRun.get(frozen.runId);
          if (live !== undefined) {
            queuedRuns.push({
              pos: frozen.pos,
              item: {
                runId: frozen.runId,
                workspaceId: this.deps.workspaceId,
                firstSeq: 0,
                lastSeq: 0,
                events: live.canonical.size,
                startedAt: live.startedAt,
                lastEventAt: live.lastEventAt,
                queued: true,
              },
            });
          } else {
            // The frozen run is no longer pending: it fully committed (and
            // acked) mid-pagination, at seq > watermark. Read it through by id
            // — committed or pending, regardless of seq — so the traversal
            // stays a consistent snapshot and the run appears exactly once.
            queuedRuns.push({ pos: frozen.pos, item: await this.readRunThrough(frozen) });
          }
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
              frozenQueued,
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
    objectVersionId: (row.object_version_id as string | null) ?? null,
  };
}

function declarationFromRow(row: Record<string, unknown>): ArtifactDeclaration {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    runId: row.run_id as string,
    declaringAgent: row.declaring_agent as string,
    role: row.role as ArtifactDeclaration['role'],
    kind: row.kind as ArtifactDeclaration['kind'],
    digest: (row.digest as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    externalId: (row.external_id as string | null) ?? null,
    externalUrl: (row.external_url as string | null) ?? null,
    artifactType: (row.artifact_type as string | null) ?? null,
    mediaType: (row.media_type as string | null) ?? null,
    provenance: row.provenance ?? null,
    verified: row.verified === true,
    versionState: (row.version_state as string | null) ?? null,
    sanitizedText: (row.sanitized_text as string | null) ?? null,
    createdAt: num(row.created_at),
    seq: num(row.seq),
    queued: false,
  };
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

const DECLARATION_COLUMNS =
  `id, workspace_id::text AS workspace_id, run_id, declaring_agent, role, kind, digest, provider,` +
  ` external_id, external_url, artifact_type, media_type, provenance, verified, version_state,` +
  ` sanitized_text, seq, created_at`;

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
    const obs = (hit.observations ?? {}) as Partial<ArtifactObservations>;
    return {
      record: {
        digest: p.digest,
        size: p.size,
        meta: obs.meta ?? { filename: 'artifact', contentType: 'application/octet-stream', runId: null },
        workspaceId: this.deps.workspaceId,
        createdAt: hit.enqueuedAt,
        seq: null,
        queued: true,
        objectVersionId: null,
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

  private async writeDeclaration(parts: {
    id: string;
    payload: DeclarationSemantic;
    canonical: string;
    observations: DeclarationObservations;
  }): Promise<WriteOutcome> {
    if (this.deps.outbox) {
      return await this.deps.outbox.writeThrough(
        { namespace: 'artifacts', id: parts.id, kind: 'artifact-declaration', payload: parts.payload, observations: parts.observations },
        this.deps.remote,
      );
    }
    return await directApply(
      this.deps,
      {
        namespace: 'artifacts',
        kind: 'artifact-declaration',
        id: parts.id,
        workspaceId: this.deps.workspaceId,
        payload: parts.payload,
        canonical: parts.canonical,
        payloadHash: sha256Hex(parts.canonical),
        observations: parts.observations,
        producerId: null,
        producerSeq: null,
        createdAt: this.deps.now(),
      },
      'postgres artifacts.declaration write failed',
    );
  }

  async putArtifact(meta: ArtifactMeta, bytes: Uint8Array, decl?: InternalDeclarationInput): Promise<ArtifactPutResult> {
    const { id, payload, canonical, digest, observations } = artifactParts(this.deps.workspaceId, meta, bytes);
    // Derive + snapshot the COMPLETE declaration (role/agent/types AND the
    // provenance canonical serialization) BEFORE any object upload / spool /
    // blob write, so a bad field OR unserializable (e.g. circular) provenance
    // throws with NO side effect (finding: validation ran AFTER the blob
    // mutation — a circular provenance uploaded/queued the bytes, then threw
    // during JSON.stringify, orphaning the object/blob). version_state is
    // resolved to 'verified' below once the immutable object version is known.
    const declParts =
      decl !== undefined ? internalDeclarationParts(this.deps.workspaceId, digest, decl, 'unverified') : undefined;
    // Blob first (object-first / index-last), THEN the declaration references
    // it; a queued declaration referencing a not-yet-committed blob converges on
    // drain (blob has the earlier producerSeq in the same namespace).
    let blobOutcome: WriteOutcome;
    let objectVersionId: string | null = null;
    if (this.deps.outbox) {
      const res = await this.deps.outbox.writeThroughArtifact(
        { namespace: 'artifacts', id, kind: 'artifact', payload, observations },
        bytes,
        this.deps.remote,
        { objects: this.objectTarget },
      );
      // A HEALTHY write-through drains the blob immediately; the observed
      // immutable version is threaded back here (finding: it was discarded, so
      // every normal artifact's declaration was version_state='unverified'). A
      // still-queued write returns null → declaration stays 'unverified' until
      // drain/repair, which is correct.
      objectVersionId = res.objectVersionId ?? null;
      blobOutcome = { outcome: res.outcome, id: res.id };
    } else {
      // Direct path: putIfAbsent captures the object version id, recorded on the
      // blob row in the same INSERT (bytes durable + digest-verified first).
      const put = await this.objects.putIfAbsent(
        { prefix: 'artifacts', segments: [digest] },
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
        { contentType: 'application/octet-stream' },
      );
      objectVersionId = put.objectVersionId ?? null;
      blobOutcome = await directApply(
        this.deps,
        {
          namespace: 'artifacts',
          kind: 'artifact',
          id,
          workspaceId: this.deps.workspaceId,
          payload,
          canonical,
          payloadHash: sha256Hex(canonical),
          observations,
          objectVersionId,
          producerId: null,
          producerSeq: null,
          createdAt: this.deps.now(),
        },
        'postgres artifacts.putArtifact failed',
      );
    }
    // Verification authority is the COMMITTED ROW, never the current op's
    // observation (round-7 finding 6). Two prior behaviors folded here:
    //   - healthy same-content reuse (run B re-declares run A's bytes): the
    //     drain delivers nothing new, so the op observes no VersionId — the
    //     committed row's recorded object_version_id supplies it (no repair).
    //   - v1-row redeclare: delivery dedup leaves the committed row's
    //     object_version_id NULL while the object-store op returns a VersionId
    //     for the LATEST object. Marking the declaration 'verified' against
    //     that observation would bless the wrong thing — the row records no
    //     immutable version (reads fall back to 'latest'); only the explicit
    //     admin repair (`roster run repair --fill-version-ids`) may bless it.
    // So: when the blob is committed, re-read the row; the declaration is
    // 'verified' ONLY when the row itself carries a version id that does not
    // contradict what this op observed. A still-queued blob stays unverified
    // until drain.
    let versionVerified = false;
    if (blobOutcome.outcome === 'committed') {
      const opObservedVersionId = objectVersionId;
      const existing = await this.findRecord(digest);
      const rowVersionId = existing?.objectVersionId ?? null;
      versionVerified =
        rowVersionId !== null && (opObservedVersionId === null || opObservedVersionId === rowVersionId);
      objectVersionId = rowVersionId;
    }
    let declarationId: string | null = null;
    let declarationOutcome: WriteOutcome | null = null;
    if (declParts !== undefined) {
      // version_state is a store observation (NOT in the id/payload hash), so
      // promoting it to 'verified' after the pre-snapshot is safe — the id and
      // canonical bytes are unchanged, and a replay still dedups.
      declParts.observations.versionState = versionVerified ? 'verified' : 'unverified';
      // A blob that is still QUEUED has no observable immutable version yet, so
      // this 'unverified' is a placeholder, not a verdict (round-7 finding 5):
      // mark it pending so the drain-time materialization derives the real state
      // from the committed blob row instead of freezing an offline snapshot.
      if (blobOutcome.outcome === 'queued') declParts.observations.versionPending = true;
      // The declaration write outcome is NOT discarded (finding: a multi-write
      // result must not hide a queued declaration behind a committed blob).
      declarationOutcome = await this.writeDeclaration(declParts);
      declarationId = declParts.id;
    }
    // Aggregate outcome: 'queued' if EITHER sub-write queued.
    const aggregate: WriteOutcomeKind =
      blobOutcome.outcome === 'queued' || declarationOutcome?.outcome === 'queued' ? 'queued' : 'committed';
    return {
      outcome: aggregate,
      id,
      digest,
      objectVersionId,
      declarationId,
      blobOutcome: blobOutcome.outcome,
      declarationOutcome: declarationOutcome?.outcome ?? null,
    };
  }

  async putExternal(meta: ExternalArtifactInput): Promise<DeclarationPutResult> {
    const parts = externalDeclarationParts(this.deps.workspaceId, meta);
    return await this.writeDeclaration(parts);
  }

  async getByRun(runId: string, opts?: ReadOpts): Promise<ArtifactDeclaration[]> {
    requireString('runId', runId);
    try {
      const res = await this.deps.pool.query(
        `SELECT ${DECLARATION_COLUMNS}
           FROM roster_ops.artifact_declarations
          WHERE workspace_id = $1::uuid AND run_id = $2
          ORDER BY seq`,
        [this.deps.workspaceId, runId],
      );
      const committed = (res.rows as Record<string, unknown>[]).map(declarationFromRow);
      if (!this.deps.outbox) return committed;
      // Union-by-id+hash via overlay() (NOT a plain committed-id drop): a queued
      // declaration whose id is committed with an IDENTICAL hash is deduped; a
      // DIFFERENT hash is a Conflict — parked + surfaced here (finding: a
      // committed-vs-queued same-id/different-payload conflict was invisible until
      // drain). Mirrors the run-event overlay handling.
      const refs = await fetchCommittedRefs(this.deps, 'artifacts');
      const queued = overlayEntries(this.deps.outbox.overlay('artifacts', refs))
        .filter((e) => e.kind === 'artifact-declaration' && (e.payload as DeclarationSemantic).runId === runId)
        .map((e) => queuedDeclaration(this.deps.workspaceId, e));
      return committed.concat(queued);
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres artifacts.getByRun failed');
      if (!this.deps.outbox) return [];
      return this.deps.outbox
        .overlayOnly('artifacts')
        .filter((e) => e.kind === 'artifact-declaration' && (e.payload as DeclarationSemantic).runId === runId)
        .map((e) => queuedDeclaration(this.deps.workspaceId, e));
    }
  }

  async getDeclaration(id: string, opts?: ReadOpts): Promise<ArtifactDeclaration | null> {
    requireString('id', id);
    try {
      const res = await this.deps.pool.query(
        `SELECT ${DECLARATION_COLUMNS}
           FROM roster_ops.artifact_declarations
          WHERE workspace_id = $1::uuid AND id = $2`,
        [this.deps.workspaceId, id],
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      // Surface a queued same-id/different-hash conflict BEFORE returning the
      // committed (possibly stale) row (finding: getDeclaration returned the
      // committed row immediately, hiding a conflicting queued payload until drain).
      await surfaceQueuedConflict(this.deps, 'artifacts', (e) => e.kind === 'artifact-declaration' && e.entryId === id);
      if (row !== undefined) return declarationFromRow(row);
      if (!this.deps.outbox) return null;
      const hit = this.deps.outbox
        .overlayOnly('artifacts')
        .find((e) => e.kind === 'artifact-declaration' && e.entryId === id);
      return hit === undefined ? null : queuedDeclaration(this.deps.workspaceId, hit);
    } catch (err) {
      assertDegradableTransport(err, opts?.allowPartial, 'postgres artifacts.getDeclaration failed');
      if (!this.deps.outbox) return null;
      const hit = this.deps.outbox
        .overlayOnly('artifacts')
        .find((e) => e.kind === 'artifact-declaration' && e.entryId === id);
      return hit === undefined ? null : queuedDeclaration(this.deps.workspaceId, hit);
    }
  }

  private async findRecord(digest: string): Promise<ArtifactRecord | null> {
    // object_version_id exists iff roster_ops is v2 (migration 002 adds it). On a
    // finalized v1 backend, select NULL for it so the read returns the blob
    // version-less rather than erroring with undefined_column (finding 5). All v2
    // artifact reads (getArtifact/head/putArtifact-dedup) funnel through here.
    const versionCol = this.deps.opsVersion >= 2 ? 'object_version_id' : 'NULL::text AS object_version_id';
    const res = await this.deps.pool.query(
      `SELECT seq, id, workspace_id::text AS workspace_id, digest, size, meta, ${versionCol}, created_at
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
      // Read the EXACT recorded immutable version (finding: VersionId ignored on
      // reads) — never 'latest', which a later overwrite of the same key could
      // change. Null recorded version (legacy/queued) falls back to latest.
      const obj = await this.objects.get({ prefix: 'artifacts', segments: [digest] }, record.objectVersionId);
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
      // Head the EXACT recorded immutable version (finding: VersionId ignored on
      // reads), not 'latest'. Null recorded version falls back to latest.
      const obj = await this.objects.head({ prefix: 'artifacts', segments: [digest] }, record.objectVersionId);
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
  // Injectable pid seam for the run-event observation columns (tests).
  pid?: () => string;
  // The roster_ops schema version this backend reports (from meta). Defaults to
  // the current CLI version; resolve.ts passes the negotiated value so a v1
  // backend's artifact reads stay version-less (finding 5).
  opsVersion?: number;
  // Batch revalidation composed by the factory (resolve.ts): runs once per
  // drain batch before ANY remote I/O — binding + marker verification.
  preflight?: () => Promise<void>;
  // #319 expiry policy from roster/persistence.yaml (hitl.expiry).
  hitlExpiry?: HitlExpiryPolicy;
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
    pid: opts.pid ?? (() => String(process.pid)),
    opsVersion: opts.opsVersion ?? CURRENT_COMPONENT_VERSIONS.roster_ops,
  };
  return {
    backend: 'postgres-s3',
    workspaceId,
    hitl: new PgHitlStore(deps, opts.objects, opts.hitlExpiry ?? DEFAULT_HITL_EXPIRY_POLICY),
    runs: new PgRunStore(deps),
    artifacts: new PgArtifactStore(deps, opts.objects),
    remote,
  };
}
