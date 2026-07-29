import {
  ConflictError,
  InvalidRecordError,
  canonicalJson,
  sha256Hex,
  HITL_STATUS_VALUES,
  type HitlDecisionInput,
  type HitlRequestInput,
  type HitlDecisionStatus,
  type HitlSubmitIntent,
  type HitlSupersedesRef,
} from './contracts.ts';
import {
  CANONICALIZATION_VERSION,
  DEFAULT_HITL_TTL_MS,
  classifyAction,
  packetHashOf,
  planSubmission,
  requestIdOf,
  requestKeyOf,
  supersededHeadConflict,
  targetHashOf,
  type HitlActionKind,
  type HitlDecisionCheck,
  type HitlExpectedHead,
  type HitlPayloadRef,
  type HitlSubmissionPlan,
  type HitlSubmissionState,
} from './hitl-machine.ts';
import { sanitizeForIndex } from './sanitize-index.ts';

// #319 stage 2: everything a HITL store must do BEFORE it touches its backend —
// validation, byte-exact identity derivation, expiry policy, submission
// planning, decision normalization. Both backends route through this module, so
// "what does the store accept and what does it derive?" has one answer and the
// postgres/local parity tests compare two backends that agree by construction.

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Bodies above this land in the object store as a payload_ref (#323's object
// ports); the row then carries the immutable reference, never the bytes.
export const HITL_INLINE_MAX_BYTES = 8 * 1024;

// ---------- expiry policy (PLAN section C) ----------

export type HitlExpiryPolicy = {
  defaultTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
};

export const DEFAULT_HITL_EXPIRY_POLICY: HitlExpiryPolicy = {
  defaultTtlMs: DEFAULT_HITL_TTL_MS,
  minTtlMs: 60 * 60 * 1000,
  maxTtlMs: 7 * 24 * 60 * 60 * 1000,
};

// A per-request expiry is CLAMPED (with a warning), never refused: the request
// still needs to reach a human. An execution request always ends up with one —
// the DB CHECK refuses an execution row without an expiry.
export function resolveExpiry(
  kind: HitlActionKind,
  requested: number | null | undefined,
  policy: HitlExpiryPolicy,
  now: number,
): { expiresAt: number | null; warnings: string[] } {
  const warnings: string[] = [];
  if (requested === undefined || requested === null) {
    if (kind === 'editorial') return { expiresAt: null, warnings };
    if (requested === null) {
      warnings.push(
        `an '${kind}' request must expire: applied the default TTL of ${policy.defaultTtlMs}ms instead of no expiry`,
      );
    }
    return { expiresAt: now + policy.defaultTtlMs, warnings };
  }
  if (!Number.isInteger(requested)) {
    throw new InvalidRecordError('expiresAt must be an integer epoch-ms timestamp or null');
  }
  const min = now + policy.minTtlMs;
  const max = now + policy.maxTtlMs;
  if (requested < min) {
    warnings.push(`expiresAt ${requested} is below the minimum TTL (${policy.minTtlMs}ms) — clamped to ${min}`);
    return { expiresAt: min, warnings };
  }
  if (requested > max) {
    warnings.push(`expiresAt ${requested} is above the maximum TTL (${policy.maxTtlMs}ms) — clamped to ${max}`);
    return { expiresAt: max, warnings };
  }
  return { expiresAt: requested, warnings };
}

// ---------- validation helpers ----------

function requireString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRecordError(`${field} is required`);
  }
  return value;
}

function optionalString(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidRecordError(`${field} must be a string or null`);
  return value;
}

function jsonField(field: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch (err) {
    throw new InvalidRecordError(`${field} is not JSON-serializable: ${(err as Error).message}`);
  }
  if (canonical === undefined) throw new InvalidRecordError(`${field} is not JSON-serializable`);
  return JSON.parse(canonical) as unknown;
}

function assertIntent(value: unknown): HitlSubmitIntent {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'create' || value === 'revise') return value;
  throw new InvalidRecordError(`intent must be 'auto' | 'create' | 'revise' (got '${String(value)}')`);
}

// D1: an expectation is REQUIRED and, when present, complete. `undefined` is a
// caller bug (a missing observation), never "adopt whatever head is there" —
// that mode is exactly what let an approval land unnoticed between a caller's
// read and its write.
export function assertExpectedHead(value: unknown, field = 'expectedHead'): HitlExpectedHead | null {
  if (value === undefined) {
    throw new InvalidRecordError(
      `${field} is required: pass null when the key has no history, or the exact head you observed ({generation, version, packetHash, sealed})`,
    );
  }
  if (value === null) return null;
  if (typeof value !== 'object') throw new InvalidRecordError(`${field} must be an object or null`);
  const h = value as Record<string, unknown>;
  if (!Number.isInteger(h.generation) || (h.generation as number) < 1) {
    throw new InvalidRecordError(`${field}.generation must be a positive integer`);
  }
  if (!Number.isInteger(h.version) || (h.version as number) < 1) {
    throw new InvalidRecordError(`${field}.version must be a positive integer`);
  }
  if (typeof h.packetHash !== 'string' || !SHA256_HEX_RE.test(h.packetHash)) {
    throw new InvalidRecordError(`${field}.packetHash must be a full-length lowercase sha256 hex digest`);
  }
  if (typeof h.sealed !== 'boolean') {
    throw new InvalidRecordError(
      `${field}.sealed must be a boolean — a terminal decision changes nothing else about the head, so an expectation without it cannot detect a sealing race`,
    );
  }
  return {
    generation: h.generation as number,
    version: h.version as number,
    packetHash: h.packetHash,
    sealed: h.sealed,
  };
}

// ---------- prepared submission ----------

export type HitlPayloadOffload = (bytes: Buffer, digest: string) => Promise<{
  objectVersionId: string | null;
  uri: string | null;
  mediaType?: string | null;
}>;

export type PreparedSubmission = {
  requestId: string;
  requestKey: string;
  functionName: string;
  title: string;
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  contentHash: string;
  // Exactly one of body / payloadRef, mirroring the DB channel CHECK.
  body: string | null;
  payloadRef: HitlPayloadRef | null;
  expiresAt: number | null;
  summary: string | null;
  warnings: unknown;
  sideEffects: unknown;
  choices: unknown;
  originRunId: string | null;
  originTaskId: string | null;
  requestingAgent: string | null;
  sanitizedSummary: string | null;
  intent: HitlSubmitIntent;
  expectedHead: HitlExpectedHead | null;
  // The caller's RAW `expiresAt` input, kept so a backend whose authoritative
  // clock is NOT the application's (postgres) can re-resolve the policy against
  // that clock under the group lock — see resealExpiry. `null` here means "this
  // submission's expiry does not come from the policy at all" (the legacy drain
  // derives its own), and re-sealing is then a no-op.
  expiryPolicyInput: { requested: number | null | undefined } | null;
  // The ONE exemption from the mandatory expectation, and it is server-side:
  // a pre-#319 spool entry carries no observation at all, and the store reads
  // the head and writes its successor INSIDE a single advisory-lock section, so
  // there is no read-to-write window a sealing race could open. Never settable
  // by a caller — only prepareLegacySubmission produces it.
  adoptLockedHead: boolean;
  policyWarnings: string[];
};

// The ONE place a packet hash is computed from a prepared submission, so
// prepareSubmission and resealExpiry cannot drift into two field lists (and the
// stored packet hash therefore always covers the stored expiry — the SQL mirror
// hitl.packet_hash_v1 frames exactly these fields in exactly this order).
type PacketFields = Pick<
  PreparedSubmission,
  | 'action'
  | 'actionKind'
  | 'target'
  | 'contentHash'
  | 'payloadRef'
  | 'expiresAt'
  | 'canonicalizationVersion'
  | 'title'
  | 'summary'
  | 'warnings'
  | 'sideEffects'
  | 'choices'
  | 'originRunId'
  | 'originTaskId'
  | 'requestingAgent'
>;

function packetHashOfFields(p: PacketFields): string {
  return packetHashOf({
    action: p.action,
    actionKind: p.actionKind,
    target: p.target,
    contentHash: p.payloadRef === null ? p.contentHash : null,
    payloadRef: p.payloadRef,
    expiresAt: p.expiresAt,
    canonicalizationVersion: p.canonicalizationVersion,
    title: p.title,
    summary: p.summary,
    warnings: p.warnings,
    sideEffects: p.sideEffects,
    choices: p.choices,
    originRunId: p.originRunId,
    originTaskId: p.originTaskId,
    requestingAgent: p.requestingAgent,
  });
}

// Re-resolve the expiry policy against `now` and RE-SEAL the packet around the
// result. Postgres calls this inside the locked transaction with the DATABASE's
// clock, because that is the clock every expiry consumer already uses:
// hitl.request_state's effective_status, the decision trigger's direction check
// and the sweep's durable stamp all read hitl.now_ms(). Resolving the policy on
// the APPLICATION clock made those two disagree — an app clock two days behind
// the database minted a 24h request that was BORN expired, and one ten days
// ahead minted an expiry past the DB-relative 7-day maximum the bounds promise.
//
// `expiresAt` is packet-VISIBLE, so the packet hash is recomputed here from the
// same field list prepareSubmission used: whatever expiry is stored is the
// expiry that was hashed, byte-for-byte, and hitl.fill_request_derived() leaves
// a supplied packet_hash untouched.
export function resealExpiry(
  p: PreparedSubmission,
  policy: HitlExpiryPolicy,
  now: number,
): PreparedSubmission {
  if (p.expiryPolicyInput === null) return p;
  const expiry = resolveExpiry(p.actionKind, p.expiryPolicyInput.requested, policy, now);
  if (expiry.expiresAt === p.expiresAt) return p;
  const resealed = { ...p, expiresAt: expiry.expiresAt, policyWarnings: expiry.warnings };
  return { ...resealed, packetHash: packetHashOfFields(resealed) };
}

// Validates the caller's packet, verifies its content hash SERVER-SIDE, offloads
// an oversized body through the caller-supplied object port, and derives every
// identity digest. Never touches the request tables — the caller runs this
// BEFORE taking the per-group lock so the locked section stays short.
export async function prepareSubmission(
  workspaceId: string,
  input: HitlRequestInput,
  policy: HitlExpiryPolicy,
  now: number,
  offload: HitlPayloadOffload,
): Promise<PreparedSubmission> {
  const functionName = requireString('functionName', input.functionName);
  const title = requireString('title', input.title);
  const action = requireString('action', input.action);
  const target = requireString('target', input.target);
  const contentHash = requireString('contentHash', input.contentHash);
  if (!SHA256_HEX_RE.test(contentHash)) {
    throw new InvalidRecordError('contentHash must be a full-length lowercase sha256 hex digest');
  }
  const body = requireString('body', input.body);
  const bytes = Buffer.from(body, 'utf8');
  // Server-side verification: an approval whose stored hash does not cover its
  // stored bytes can never be re-validated at execution time (D8 makes exactly
  // those rows non-authoritative), so a live write refuses instead of minting one.
  const actualHash = sha256Hex(bytes);
  if (actualHash !== contentHash) {
    throw new InvalidRecordError(
      `contentHash does not match the body: the store computed ${actualHash}, the caller supplied ${contentHash}`,
    );
  }
  const actionKind = classifyAction(action);
  const requestKey = requestKeyOf({ functionName, action, target });
  const requestId = requestIdOf(workspaceId, requestKey);
  const summary = optionalString('summary', input.summary);
  const warnings = jsonField('warnings', input.warnings);
  const sideEffects = jsonField('sideEffects', input.sideEffects);
  const choices = jsonField('choices', input.choices);
  const expiry = resolveExpiry(actionKind, input.expiresAt, policy, now);

  let payloadRef: HitlPayloadRef | null = null;
  let inlineBody: string | null = body;
  if (bytes.byteLength > HITL_INLINE_MAX_BYTES) {
    const put = await offload(bytes, contentHash);
    payloadRef = {
      digest: contentHash,
      size: bytes.byteLength,
      mediaType: put.mediaType ?? 'text/plain; charset=utf-8',
      uri: put.uri,
      objectVersionId: put.objectVersionId,
    };
    inlineBody = null;
  }

  const originRunId = optionalString('originRunId', input.originRunId);
  const originTaskId = optionalString('originTaskId', input.originTaskId);
  const requestingAgent = optionalString('requestingAgent', input.requestingAgent);

  const prepared: PreparedSubmission = {
    requestId,
    requestKey,
    functionName,
    title,
    action,
    actionKind,
    target,
    targetHash: targetHashOf(target),
    packetHash: '',
    canonicalizationVersion: CANONICALIZATION_VERSION,
    contentHash,
    body: inlineBody,
    payloadRef,
    expiresAt: expiry.expiresAt,
    summary,
    warnings,
    sideEffects,
    choices,
    originRunId,
    originTaskId,
    requestingAgent,
    sanitizedSummary: sanitizeForIndex(summary ?? title),
    intent: assertIntent(input.intent),
    expectedHead: assertExpectedHead(input.expectedHead),
    expiryPolicyInput: { requested: input.expiresAt },
    adoptLockedHead: false,
    policyWarnings: expiry.warnings,
  };
  return { ...prepared, packetHash: packetHashOfFields(prepared) };
}

// A v1 (#318) HITL request that was spooled BEFORE the upgrade and only drains
// now. It carries no packet, no expiry policy and an unverified content hash, so
// it is derived exactly the way the migration derives a legacy row: hash-exempt
// when the stored digest does not cover the stored body (canonicalization 0,
// which D8 makes categorically non-authoritative), default TTL from its own
// creation stamp. Never used by a live write.
export function prepareLegacySubmission(
  workspaceId: string,
  payload: unknown,
  createdAt: number,
  now: number,
): PreparedSubmission {
  const p = (payload ?? {}) as Record<string, unknown>;
  const functionName = normalizeFunctionName(p.functionName);
  const action = requireString('action', p.action);
  const target = typeof p.target === 'string' ? p.target : '';
  const contentHash = requireString('contentHash', p.contentHash);
  const bodyPresent = typeof p.body === 'string';
  // This '' is a HASHING placeholder only, never a stored body: the drain writes
  // the untouched v1 payload jsonb (rec.canonical) and `identityFieldsOf`
  // projects a non-string body as null, matching the local conversion (round-4
  // finding 3). Guarded by `bodyPresent`, so the placeholder is never hashed.
  const body = bodyPresent ? (p.body as string) : '';
  const actionKind = classifyAction(action);
  // PRESENCE, not length: an EMPTY body whose stored digest is sha256('') is
  // verifiable, and SQL (fill trigger + backfill) accepts exactly that. Demanding
  // a non-empty body here made the same legacy row permanently non-authoritative
  // on local and verified on postgres (round-3 finding 5).
  const canonicalizationVersion =
    bodyPresent && sha256Hex(Buffer.from(body, 'utf8')) === contentHash ? CANONICALIZATION_VERSION : 0;
  // A request is never BORN expired (the same rule the SQL fill trigger uses):
  // the default TTL runs from the LATER of the spooled stamp and the server
  // clock, so a long-queued entry still lands decidable rather than dead.
  const expiresAt =
    typeof p.expiresAt === 'number'
      ? p.expiresAt
      : actionKind === 'execution'
        ? Math.max(createdAt, now) + DEFAULT_HITL_TTL_MS
        : null;
  const requestKey = requestKeyOf({ functionName, action, target });
  const title = typeof p.title === 'string' ? p.title : '';
  return {
    requestId: requestIdOf(workspaceId, requestKey),
    requestKey,
    functionName,
    title,
    action,
    actionKind,
    target,
    targetHash: targetHashOf(target),
    packetHash: packetHashOf({
      action,
      actionKind,
      target,
      contentHash,
      payloadRef: null,
      expiresAt,
      canonicalizationVersion,
      title,
      summary: null,
      warnings: null,
      sideEffects: null,
      choices: null,
      originRunId: null,
      originTaskId: null,
      requestingAgent: null,
    }),
    canonicalizationVersion,
    contentHash,
    body,
    payloadRef: null,
    expiresAt,
    summary: null,
    warnings: null,
    sideEffects: null,
    choices: null,
    originRunId: null,
    originTaskId: null,
    requestingAgent: null,
    sanitizedSummary: sanitizeForIndex(title),
    intent: 'auto',
    expectedHead: null,
    // A legacy drain's expiry follows the LEGACY rule (the spooled value, or the
    // default TTL from max(spool stamp, server clock)) — not the policy — so it
    // is never re-sealed against another clock.
    expiryPolicyInput: null,
    adoptLockedHead: true,
    policyWarnings: [],
  };
}

// ---------- submission planning ----------

// planSubmission + the caller's declared intent. The caller's expectation is
// compared exactly (D1); the ONLY substitution is the legacy-drain path, whose
// "observation" is the store's own read inside the same lock (see
// PreparedSubmission.adoptLockedHead).
export function planFor(state: HitlSubmissionState, prepared: PreparedSubmission): HitlSubmissionPlan {
  const expectedHead = prepared.adoptLockedHead
    ? state.head === null
      ? null
      : {
          generation: state.head.generation,
          version: state.head.version,
          packetHash: state.head.packetHash,
          sealed: state.head.sealed,
        }
    : prepared.expectedHead;
  const plan = planSubmission(state, { packetHash: prepared.packetHash, expectedHead });
  if (plan.kind === 'conflict') return plan;
  if (prepared.intent === 'create' && plan.kind !== 'open-generation') {
    return {
      kind: 'conflict',
      reason: 'unexpected-history',
      detail: `intent 'create' requires a fresh generation, but this key resolves to '${plan.kind}' at generation ${plan.generation} version ${plan.version}`,
    };
  }
  if (prepared.intent === 'revise' && plan.kind === 'open-generation') {
    return {
      kind: 'conflict',
      reason: state.head === null ? 'missing-history' : 'stale-expected-head',
      detail:
        state.head === null
          ? "intent 'revise' requires an open head, but this key has no history"
          : `intent 'revise' requires an open head, but generation ${state.head.generation} version ${state.head.version} is sealed`,
    };
  }
  return plan;
}

// The ONE place a plan's kind may change after planSubmission derived it, and
// therefore the one place the permanent-closure rule has to be re-asserted.
//
// The change itself: a `replaces` whose destination packet is byte-identical to
// the destination's open head plans as `idempotent` — a NO-WRITE result the
// machine deliberately lets past the closure check, since writing nothing can
// resurrect nothing. But the supersession LINK is part of what a destination
// row asserts, so when the head does not already record exactly this link the
// call still owes a version that does, and the no-write plan is upgraded to a
// writing revision. That upgrade is what re-opened the door round 4 closed on
// the SOURCE side: an OPEN, byte-identical, SUPERSEDED destination (A→B, B→C,
// then X→B with B's own fingerprint and packet) committed B v2, which C's
// pointer at B v1 does not cover — two live authorities again.
//
// So closure is evaluated against the FINAL plan, never the derived one.
export function finalizeSubmissionPlan(
  planned: HitlSubmissionPlan,
  head: { generation: number; version: number; superseded: boolean } | null,
  link: { requested: HitlSupersedesRef; recorded: HitlSupersedesRef | null } | null,
): HitlSubmissionPlan {
  const plan =
    planned.kind === 'idempotent' && link !== null && !sameSupersedesRef(link.recorded, link.requested)
      ? ({ kind: 'revise', generation: planned.generation, version: planned.version + 1 } as const)
      : planned;
  if (head !== null && head.superseded && (plan.kind === 'revise' || plan.kind === 'open-generation')) {
    return supersededHeadConflict(head);
  }
  return plan;
}

export function sameSupersedesRef(a: HitlSupersedesRef | null, b: HitlSupersedesRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.requestId === b.requestId && a.generation === b.generation && a.version === b.version;
}

export function conflictFromPlan(requestId: string, plan: Extract<HitlSubmissionPlan, { kind: 'conflict' }>): ConflictError {
  return new ConflictError(requestId, `${plan.reason}: ${plan.detail}`);
}

// ---------- decisions ----------

export type NormalizedDecision = {
  requestId: string;
  generation: number;
  requestVersion: number;
  status: HitlDecisionStatus;
  decidedBy: string;
  note: string | null;
  feedback: string | null;
};

export function normalizeDecision(input: HitlDecisionInput): NormalizedDecision {
  const requestId = requireString('requestId', input.requestId);
  const status = requireString('status', input.status);
  if (!HITL_STATUS_VALUES.includes(status as (typeof HITL_STATUS_VALUES)[number]) || status === 'awaiting') {
    throw new InvalidRecordError(
      `status must be a decision status (${HITL_STATUS_VALUES.filter((s) => s !== 'awaiting').join(' | ')})`,
    );
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new InvalidRecordError('generation is required and must be a positive integer');
  }
  if (!Number.isInteger(input.requestVersion) || input.requestVersion < 1) {
    throw new InvalidRecordError('requestVersion is required and must be a positive integer');
  }
  return {
    requestId,
    generation: input.generation,
    requestVersion: input.requestVersion,
    status: status as HitlDecisionStatus,
    decidedBy: requireString('decidedBy', input.decidedBy),
    note: optionalString('note', input.note),
    feedback: optionalString('feedback', input.feedback),
  };
}

export function decisionId(workspaceId: string, d: NormalizedDecision): string {
  return sha256Hex(
    `${workspaceId}\nhitl\ndecision\n${canonicalJson({
      requestId: d.requestId,
      generation: d.generation,
      version: d.requestVersion,
      status: d.status,
      decidedBy: d.decidedBy,
      note: d.note,
      feedback: d.feedback,
    })}`,
  );
}

// The SYSTEM expiry id — deterministic in (workspace, request, generation,
// version) ALONE so two concurrent sweeps derive the same id and converge
// (ON CONFLICT DO NOTHING / the trigger's identical-expiry exemption) instead of
// one of them throwing. Never includes a clock or a decider.
export function systemExpiryId(
  workspaceId: string,
  requestId: string,
  generation: number,
  version: number,
): string {
  return sha256Hex(`${workspaceId}\nhitl\nexpired\n${requestId}\n${generation}\n${version}`);
}

export const SYSTEM_DECIDER = 'system';

export function systemExpiryDecision(requestId: string, generation: number, version: number): NormalizedDecision {
  return {
    requestId,
    generation,
    requestVersion: version,
    status: 'expired',
    decidedBy: SYSTEM_DECIDER,
    note: null,
    feedback: null,
  };
}

// canDecide's refusals split by kind: a malformed status is the CALLER's bug
// (InvalidRecordError); everything else is a genuine race with the current state
// and is surfaced synchronously as the same ConflictError the DB's 23505 maps to.
export function decisionRefusal(requestId: string, check: Extract<HitlDecisionCheck, { ok: false }>): Error {
  if (check.reason === 'invalid-status') return new InvalidRecordError(check.detail);
  return new ConflictError(requestId, `${check.reason}: ${check.detail}`);
}

// ---------- stored payload encoding (shared by both backends) ----------

// The jsonb content channel. Exactly one of `payload` / `payload_ref` is set
// (a DB CHECK enforces it), so the two fields that have no dedicated column —
// functionName and title — ride in whichever channel is live.
export type HitlInlinePayload = { functionName: string; title: string; body: string };
export type HitlStoredRef = HitlPayloadRef & { meta: { functionName: string; title: string } };

export function encodeInlinePayload(p: PreparedSubmission): HitlInlinePayload {
  return { functionName: p.functionName, title: p.title, body: p.body as string };
}

export function encodeStoredRef(p: PreparedSubmission): HitlStoredRef {
  return { ...(p.payloadRef as HitlPayloadRef), meta: { functionName: p.functionName, title: p.title } };
}

export function payloadRefOf(stored: unknown): HitlPayloadRef | null {
  if (stored === null || typeof stored !== 'object') return null;
  const r = stored as Record<string, unknown>;
  return {
    digest: String(r.digest ?? ''),
    size: typeof r.size === 'number' ? r.size : 0,
    mediaType: typeof r.mediaType === 'string' ? r.mediaType : null,
    uri: typeof r.uri === 'string' ? r.uri : null,
    objectVersionId: typeof r.objectVersionId === 'string' ? r.objectVersionId : null,
  };
}

// ---------- functionName: ONE normalization rule (round-3 finding 2) ----------

// functionName is the one request_key input with no column of its own — it
// rides in whichever content channel is live — so every layer that reads,
// filters or projects it must apply the SAME rule, or a row is filed under one
// identity and queried under another. THE rule (byte-identical to
// hitl.function_name() in 002_state_machine.sql): anything that is not a
// NON-EMPTY STRING — absent, null, empty, a number, an object — is the same
// 'unknown' sentinel. Postgres keeps the writer's payload verbatim and derives
// at read; the local ledger stores the derived field; both end here.
export const UNKNOWN_FUNCTION_NAME = 'unknown';

export function normalizeFunctionName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : UNKNOWN_FUNCTION_NAME;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

// The inline channel first, then the offloaded ref's meta — the same order (and
// the same fall-through, not an early return on a present-but-degenerate
// payload) as the SQL function.
export function functionNameOf(payload: unknown, payloadRef: unknown): string {
  const inline = recordOf(payload)?.functionName;
  if (typeof inline === 'string' && inline.length > 0) return inline;
  return normalizeFunctionName(recordOf(recordOf(payloadRef)?.meta)?.functionName);
}

// functionName / title from either channel, tolerating a v1 (#318) inline
// payload — which carried the same two keys alongside the rest of the request.
export function identityFieldsOf(
  payload: unknown,
  payloadRef: unknown,
): { functionName: string; title: string; body: string | null } {
  const p = recordOf(payload);
  const meta = recordOf(recordOf(payloadRef)?.meta);
  const title = typeof p?.title === 'string' ? p.title : typeof meta?.title === 'string' ? meta.title : '';
  return {
    functionName: functionNameOf(payload, payloadRef),
    title,
    body: typeof p?.body === 'string' ? p.body : null,
  };
}

export function supersedesOf(
  requestId: unknown,
  generation: unknown,
  version: unknown,
): HitlSupersedesRef | null {
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  if (typeof generation !== 'number' || typeof version !== 'number') return null;
  return { requestId, generation, version };
}
