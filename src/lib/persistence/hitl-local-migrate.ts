import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InvalidRecordError, sha256Hex, type HitlDecisionStatus } from './contracts.ts';
import {
  CANONICALIZATION_VERSION,
  DEFAULT_HITL_TTL_MS,
  LEGACY_CANONICALIZATION_VERSION,
  classifyAction,
  packetHashOf,
  requestIdOf,
  requestKeyOf,
  targetHashOf,
} from './hitl-machine.ts';
import { decisionId, normalizeFunctionName, type NormalizedDecision } from './hitl-store.ts';
import { sanitizeForIndex } from './sanitize-index.ts';
import {
  atomicWriteFileSync,
  readRegularFileSync,
  type AppendInput,
  type LedgerRecord,
  type LocalLedger,
} from './local/ledger.ts';
import { HITL_MIGRATION_MARKER } from './local/format-fence.ts';
import {
  HITL_DECISION_KIND,
  HITL_VERSION_KIND,
  hitlVersionRecordId,
  type LocalHitlDecisionObservations,
  type LocalHitlVersionObservations,
  type LocalHitlVersionPayload,
} from './hitl-local-records.ts';

// #319 F/D6: the local v1 → v2 HITL conversion and its migration BARRIER.
//
// The barrier has three parts, and it needs all three:
//
//   1. THE LOCK. v1 writers synchronize on `hitl/.lock` (the ledger's
//      per-namespace lock) and know nothing about a workspace gate, so the
//      conversion enforces quiescence with the SAME primitive — it holds
//      `hitl/.lock` EXCLUSIVELY from the marker check through every conversion
//      chunk and the DONE marker write. No v1 append can interleave.
//   2. THE FORMAT FENCE (local/format-fence.ts). The lock only covers the
//      conversion's own window. A shipped v1 writer that resolved BEFORE the
//      migration and blocked on the lock would append a v1-format record the
//      instant the lock is released — after which every migration check
//      short-circuits on the DONE marker and the v2 projection ignores that
//      record forever. So the APPEND PRIMITIVE itself refuses a v1-format HITL
//      record once the marker exists (finding 7).
//   3. THE EPOCH. A backend resolved before a conversion holds a stale picture
//      of the on-disk format, so every mutation re-reads the marker after
//      taking its lock and refuses when the epoch it resolved against is not
//      the epoch on disk (LocalHitlStore#barrier).
//
// Crash safety: a durable CONVERTING marker plus deterministic record ids make a
// re-run a replay. The conversion is written in BOUNDED CHUNKS (finding 9) — a
// large-but-valid v1 history would otherwise exceed the ledger's per-record
// limit and make the migration fail permanently — and each chunk is its own
// atomic envelope, so a crash between chunks rolls forward: the next run
// re-derives byte-identical records, the ledger dedups the ones already there,
// and the marker is completed.

export { HITL_MIGRATION_MARKER };
const MAX_MARKER_BYTES = 64 * 1024;

export type HitlMigrationMarker = {
  state: 'converting' | 'done';
  epoch: string;
  startedAt: number;
  completedAt: number | null;
  converted: number;
};

export type HitlMigrationResult = {
  epoch: string;
  // true when THIS call performed (or completed) the conversion — the only case
  // in which a backend may adopt the epoch it did not resolve against.
  converted: boolean;
  records: number;
};

export type HitlMigrationHooks = {
  // Fires after the conversion segment is fsynced and BEFORE the DONE marker is
  // written — the crash-injection boundary the roll-forward test drives.
  afterAppend?: () => void;
  // Fires after each bounded chunk is durable — the between-chunks crash
  // boundary (finding 9's resumability).
  afterChunk?: () => void;
};

function markerPath(ledger: LocalLedger): string {
  return join(ledger.namespaceDir('hitl'), HITL_MIGRATION_MARKER);
}

function parseMarker(raw: string): HitlMigrationMarker | null {
  let parsed: HitlMigrationMarker;
  try {
    parsed = JSON.parse(raw) as HitlMigrationMarker;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (parsed.state !== 'converting' && parsed.state !== 'done') return null;
  if (typeof parsed.epoch !== 'string' || parsed.epoch.length === 0) return null;
  return parsed;
}

export function readHitlMarker(ledger: LocalLedger): HitlMigrationMarker | null {
  let raw: Buffer | null;
  try {
    raw = readRegularFileSync(markerPath(ledger));
  } catch {
    // An unreadable/planted marker is not trusted: the conversion re-runs under
    // the lock, which refuses a non-regular file loudly through the same reader.
    return null;
  }
  if (raw === null) return null;
  if (raw.byteLength > MAX_MARKER_BYTES) {
    throw new InvalidRecordError(`${markerPath(ledger)} is larger than ${MAX_MARKER_BYTES} bytes — refusing to read it`);
  }
  return parseMarker(raw.toString('utf8'));
}

// The epoch a backend resolves against: only a COMPLETED conversion has one.
export function readHitlMigrationEpoch(ledger: LocalLedger): string | null {
  const marker = readHitlMarker(ledger);
  return marker !== null && marker.state === 'done' ? marker.epoch : null;
}

function writeMarker(ledger: LocalLedger, marker: HitlMigrationMarker): void {
  atomicWriteFileSync(markerPath(ledger), JSON.stringify(marker, null, 2) + '\n');
}

// ---------- v1 record shapes (#318) ----------

type V1RequestPayload = {
  functionName?: unknown;
  title?: unknown;
  action?: unknown;
  target?: unknown;
  contentHash?: unknown;
  body?: unknown;
  expiresAt?: unknown;
  status?: unknown;
};

type V1DecisionPayload = {
  requestId?: unknown;
  status?: unknown;
  decidedBy?: unknown;
  note?: unknown;
};

const DECISION_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'changes-requested',
  'rejected',
  'deferred',
  'expired',
  'cancelled',
]);

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

type LegacyRequest = {
  legacyId: string;
  seq: number;
  createdAt: number;
  functionName: string;
  title: string;
  action: string;
  target: string;
  contentHash: string;
  body: string | null;
  // Whether the v1 payload carried a STRING body at all. An empty string is a
  // body (and hashes to sha256('')); an absent or non-string one is not.
  bodyPresent: boolean;
  expiresAt: number | null;
  requestKey: string;
  requestId: string;
};

type LegacyDecision = {
  legacyId: string;
  seq: number;
  createdAt: number;
  requestId: string;
  status: HitlDecisionStatus;
  decidedBy: string;
  note: string | null;
  terminal: boolean;
};

// The SAME shapes the SQL preflight refuses (002_state_machine.sql section 2):
// GUESSING a generation boundary would silently mint an approval scope nobody
// authorized, so an unreadable legacy history refuses the conversion by name.
function preflight(requests: LegacyRequest[], decisions: LegacyDecision[]): void {
  const problems: string[] = [];
  const byLegacyId = new Map(requests.map((r) => [r.legacyId, r]));
  const terminalCount = new Map<string, string[]>();
  const statusCount = new Map<string, number>();
  for (const d of decisions) {
    const owner = byLegacyId.get(d.requestId);
    if (owner === undefined) {
      problems.push(`decision ${d.legacyId}: references request ${d.requestId}, which does not exist`);
      continue;
    }
    if (d.createdAt < owner.createdAt) {
      problems.push(
        `decision ${d.legacyId}: is stamped ${d.createdAt}, before its request ${d.requestId} at ${owner.createdAt}`,
      );
    }
    if (d.terminal) {
      const list = terminalCount.get(d.requestId) ?? [];
      list.push(d.status);
      terminalCount.set(d.requestId, list);
    }
    const key = `${d.requestId}\n${d.status}`;
    statusCount.set(key, (statusCount.get(key) ?? 0) + 1);
  }
  for (const [requestId, statuses] of terminalCount) {
    if (statuses.length > 1) {
      problems.push(
        `request ${requestId}: carries ${statuses.length} terminal decisions (${[...statuses].sort().join(', ')})`,
      );
    }
  }
  for (const [key, n] of statusCount) {
    if (n > 1) {
      const [requestId, status] = key.split('\n') as [string, string];
      problems.push(`request ${requestId}: carries ${n} '${status}' decisions`);
    }
  }
  // The real ambiguity: a same-key row created BEFORE the previous row's
  // terminal decision landed — was it a revision inside the open generation or a
  // fresh post-terminal one?
  const byKey = new Map<string, LegacyRequest[]>();
  for (const r of requests) {
    const list = byKey.get(r.requestKey) ?? [];
    list.push(r);
    byKey.set(r.requestKey, list);
  }
  // The ledger assigns one strictly increasing seq to every hitl append —
  // requests and decisions share the same stream — so seq totally orders two
  // events even when their millisecond-resolution createdAt ties, which is
  // routine for synchronous back-to-back appends. seq is therefore the
  // authoritative signal here, not createdAt (which can also read stale under
  // real clock skew); createdAt stays in the message only for human context.
  const firstTerminalAt = new Map<string, { createdAt: number; seq: number }>();
  for (const d of decisions) {
    if (!d.terminal) continue;
    const prior = firstTerminalAt.get(d.requestId);
    if (prior === undefined || d.seq < prior.seq) {
      firstTerminalAt.set(d.requestId, { createdAt: d.createdAt, seq: d.seq });
    }
  }
  for (const list of byKey.values()) {
    const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    for (let i = 0; i < ordered.length - 1; i++) {
      const cur = ordered[i]!;
      const next = ordered[i + 1]!;
      const terminal = firstTerminalAt.get(cur.legacyId);
      if (terminal !== undefined && terminal.seq > next.seq) {
        problems.push(
          `request_key ${cur.requestKey.slice(0, 12)}: request ${cur.legacyId} was terminally decided at ${terminal.createdAt} (seq ${terminal.seq}) but the next same-key request ${next.legacyId} already existed at ${next.createdAt} (seq ${next.seq}) — the generation boundary is ambiguous`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRecordError(
      `the local hitl v1→v2 conversion refused: ${problems.length} legacy condition(s) make generation partitioning ambiguous.\n  - ${problems
        .slice(0, 20)
        .sort()
        .join('\n  - ')}`,
    );
  }
}

export type HitlConversionPlan = { records: AppendInput[]; versions: number; decisions: number };

// Fold the v1 ledger into v2 identity records. Deterministic in its inputs, so a
// roll-forward after a crash re-derives byte-identical records.
export function planLocalHitlConversion(
  workspaceId: string,
  records: readonly LedgerRecord[],
): HitlConversionPlan {
  const requests: LegacyRequest[] = [];
  const decisions: LegacyDecision[] = [];
  for (const rec of records) {
    if (rec.kind === 'hitl-request') {
      const p = (rec.payload ?? {}) as V1RequestPayload;
      const functionName = normalizeFunctionName(p.functionName);
      const action = str(p.action, 'unknown');
      const target = str(p.target, '');
      const requestKey = requestKeyOf({ functionName, action, target });
      requests.push({
        legacyId: rec.id,
        seq: rec.seq,
        createdAt: rec.ts,
        functionName,
        title: str(p.title, ''),
        action,
        target,
        contentHash: str(p.contentHash, ''),
        // A missing or non-string body is preserved as NULL, not flattened to
        // '': postgres keeps the v1 payload jsonb verbatim and projects a body
        // that is not a JSON string as null, so storing '' here made the SAME
        // legacy row report two different bodies in an audit (round-4 finding
        // 3). '' remains a real, verifiable body — only ABSENCE is null.
        body: typeof p.body === 'string' ? p.body : null,
        bodyPresent: typeof p.body === 'string',
        expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : null,
        requestKey,
        requestId: requestIdOf(workspaceId, requestKey),
      });
      continue;
    }
    if (rec.kind === 'hitl-decision') {
      const p = (rec.payload ?? {}) as V1DecisionPayload;
      const status = str(p.status, '');
      if (!DECISION_STATUSES.has(status)) {
        throw new InvalidRecordError(
          `the local hitl v1→v2 conversion refused: decision ${rec.id} carries status '${status}', which is not a decision status`,
        );
      }
      decisions.push({
        legacyId: rec.id,
        seq: rec.seq,
        createdAt: rec.ts,
        requestId: str(p.requestId, ''),
        status: status as HitlDecisionStatus,
        decidedBy: str(p.decidedBy, 'unknown'),
        note: typeof p.note === 'string' ? p.note : null,
        terminal: status !== 'deferred',
      });
    }
  }
  if (requests.length === 0 && decisions.length === 0) return { records: [], versions: 0, decisions: 0 };
  preflight(requests, decisions);

  const hasTerminal = new Set<string>();
  for (const d of decisions) if (d.terminal) hasTerminal.add(d.requestId);

  const byKey = new Map<string, LegacyRequest[]>();
  for (const r of requests) {
    const list = byKey.get(r.requestKey) ?? [];
    list.push(r);
    byKey.set(r.requestKey, list);
  }
  const identity = new Map<string, { generation: number; version: number; row: LegacyRequest }>();
  for (const list of byKey.values()) {
    const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    let sealedBefore = 0;
    let version = 0;
    for (const row of ordered) {
      version += 1;
      identity.set(row.legacyId, { generation: sealedBefore + 1, version, row });
      if (hasTerminal.has(row.legacyId)) {
        sealedBefore += 1;
        version = 0;
      }
    }
  }

  const out: AppendInput[] = [];
  for (const [legacyId, { generation, version, row }] of identity) {
    const actionKind = classifyAction(row.action);
    // A legacy row whose stored content hash does not cover its stored body was
    // never write-verified: canonicalization_version 0 exempts it from
    // verification HERE and D8 makes it categorically non-authoritative.
    // PRESENCE, not length (round-3 finding 5): SQL accepts an EMPTY body whose
    // stored digest is sha256(''), so demanding a non-empty one here made the
    // identical legacy row verified on postgres and permanently exempt on local.
    const canonicalizationVersion =
      row.bodyPresent && sha256Hex(Buffer.from(row.body ?? '', 'utf8')) === row.contentHash
        ? CANONICALIZATION_VERSION
        : LEGACY_CANONICALIZATION_VERSION;
    const expiresAt =
      row.expiresAt ?? (actionKind === 'execution' ? row.createdAt + DEFAULT_HITL_TTL_MS : null);
    const payload: LocalHitlVersionPayload = {
      requestId: row.requestId,
      requestKey: row.requestKey,
      generation,
      version,
      functionName: row.functionName,
      title: row.title,
      action: row.action,
      actionKind,
      target: row.target,
      targetHash: targetHashOf(row.target),
      packetHash: packetHashOf({
        action: row.action,
        actionKind,
        target: row.target,
        contentHash: row.contentHash,
        payloadRef: null,
        expiresAt,
        canonicalizationVersion,
        // A v1 row carries a title but never origin/agent provenance; a missing
        // title normalizes to '' on BOTH backends and in the SQL backfill.
        title: row.title,
        summary: null,
        warnings: null,
        sideEffects: null,
        choices: null,
        originRunId: null,
        originTaskId: null,
        requestingAgent: null,
      }),
      canonicalizationVersion,
      contentHash: row.contentHash,
      body: row.body,
      payloadRef: null,
      expiresAt,
      summary: null,
      warnings: null,
      sideEffects: null,
      choices: null,
      originRunId: null,
      originTaskId: null,
      requestingAgent: null,
      sanitizedSummary: sanitizeForIndex(row.title),
      supersedes: null,
    };
    // The legacy creation time rides as an observation so the converted record
    // reports when the REQUEST was created, not when the conversion ran — the
    // same timestamp the postgres backfill preserves in `created_at`.
    const observations: LocalHitlVersionObservations = { createdAt: row.createdAt };
    out.push({
      id: hitlVersionRecordId(workspaceId, row.requestId, generation, version),
      kind: HITL_VERSION_KIND,
      payload,
      observations,
    });
    void legacyId;
  }

  let converted = 0;
  for (const d of decisions) {
    const owner = identity.get(d.requestId);
    if (owner === undefined) continue; // preflight already refused a true orphan
    const normalized: NormalizedDecision = {
      requestId: owner.row.requestId,
      generation: owner.generation,
      requestVersion: owner.version,
      status: d.status,
      decidedBy: d.decidedBy,
      note: d.note,
      feedback: null,
    };
    const observations: LocalHitlDecisionObservations = { decidedAt: d.createdAt };
    out.push({
      id: decisionId(workspaceId, normalized),
      kind: HITL_DECISION_KIND,
      payload: {
        requestId: normalized.requestId,
        generation: normalized.generation,
        requestVersion: normalized.requestVersion,
        status: normalized.status,
        decidedBy: normalized.decidedBy,
        note: normalized.note,
        feedback: normalized.feedback,
      },
      observations,
    });
    converted += 1;
  }
  return { records: out, versions: identity.size, decisions: converted };
}

// Idempotent, roll-forward conversion. Safe to call on every store entry point:
// once the DONE marker exists it is a single lock-free file read.
export function ensureLocalHitlV2(
  ledger: LocalLedger,
  now: number,
  hooks?: HitlMigrationHooks,
): HitlMigrationResult {
  const seen = readHitlMarker(ledger);
  if (seen !== null && seen.state === 'done') {
    return { epoch: seen.epoch, converted: false, records: seen.converted };
  }
  return ledger.withNamespaceState('hitl', (ctx) => {
    // Re-read UNDER the lock: another process may have converted between the
    // probe above and this acquisition.
    const marker = readHitlMarker(ledger);
    if (marker !== null && marker.state === 'done') {
      return { epoch: marker.epoch, converted: false, records: marker.converted };
    }
    const epoch = marker?.epoch ?? randomUUID();
    const startedAt = marker?.startedAt ?? now;
    if (marker === null) {
      // The CONVERTING marker is written FIRST and is itself the format fence:
      // from here on the append primitive refuses a v1-format HITL record, so a
      // half-converted tree can never take on new v1 data.
      writeMarker(ledger, { state: 'converting', epoch, startedAt, completedAt: null, converted: 0 });
    }
    const plan = planLocalHitlConversion(ledger.workspaceId, ctx.records);
    // Bounded chunks, still under this ONE lock acquisition: the whole history
    // as a single compound record would hit the ledger's per-record limit and
    // fail the migration permanently.
    ctx.appendChunked(plan.records, hooks?.afterChunk);
    hooks?.afterAppend?.();
    writeMarker(ledger, {
      state: 'done',
      epoch,
      startedAt,
      completedAt: now,
      converted: plan.records.length,
    });
    // The tree's advertised component versions follow the CODE (ledger.meta()
    // clamps hitl up to LOCAL_COMPONENT_VERSIONS), so nothing else to bump.
    ledger.meta();
    return { epoch, converted: true, records: plan.records.length };
  });
}
