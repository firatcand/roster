import {
  InvalidRecordError,
  canonicalJson,
  sha256Hex,
  type HitlDecisionStatus,
  type HitlStatus,
} from './contracts.ts';

// #319 stage 1: the ONE shared HITL state machine. Pure — no I/O, no clock, no
// store types. Both backends route through it (postgres via the SQL mirror in
// data/ops/schema/hitl/002_state_machine.sql, local via deriveRequestState), so
// "is this approval authoritative?" has exactly one answer everywhere.
//
// Vocabulary (PLAN #319 Model):
//   request_key  — sha256(functionName, action, normalized target). GROUPS the
//                  revision versions of one proposal.
//   request_id   — sha256(workspace_id, request_key). The stable logical id a
//                  whole group (all generations, all versions) lives under.
//   generation   — a group is SEALED by any terminal decision; a later same-key
//                  submission opens generation G+1 (an independent approval).
//   version      — a revision WITHIN an open generation (v+1 supersedes v).
//   packet_hash  — covers every approval-visible field. Any change to what the
//                  human would see is a new version, never a silent edit.

// ---------- constants ----------

// The canonicalization the CURRENT code writes. 0 is reserved for legacy rows
// the migration exempted from write-time hash verification: their content hash
// was never validated, so D8 makes them categorically non-authoritative.
export const CANONICALIZATION_VERSION = 1;
export const LEGACY_CANONICALIZATION_VERSION = 0;

// Default request TTL (owner decision 3). The `hitl.expiry` config block
// (PLAN section C) clamps a per-request expiry to policy bounds around this;
// the SQL mirror hardcodes the same number for legacy backfill + the v1-shaped
// insert fallback.
export const DEFAULT_HITL_TTL_MS = 86_400_000;

// XOR mask for the per-group advisory lock: pg_advisory_xact_lock(hashtext(
// request_key) # HITL_GROUP_LOCK_MASK). Shared verbatim with the decisions
// trigger in 002_state_machine.sql so the trigger and the store serialize on
// the SAME key. 0x4849544C ('HITL') is deliberately far from the migration
// keys (8135318 / 8135319 in postgres/migrate.ts): the mask IS the resulting
// lock id whenever hashtext() returns 0, so reusing a migration key there
// would let one request_key collide with a schema-migration lock.
export const HITL_GROUP_LOCK_MASK = 0x4849544c;

// Closed allowlist (owner decision 2). Editorial actions choose or bless
// CONTENT; they never touch the outside world. EVERYTHING else — including any
// action this list does not know — classifies as `execution`, so an unknown or
// attacker-chosen action name can never downgrade itself into the weaker,
// expiry-optional editorial regime. Grow this list deliberately.
export const EDITORIAL_ACTIONS: ReadonlySet<string> = new Set([
  'approve-draft',
  'approve-lesson',
  'select-candidate',
  'acknowledge-error',
]);

export type HitlActionKind = 'editorial' | 'execution';

export function classifyAction(action: string): HitlActionKind {
  return typeof action === 'string' && EDITORIAL_ACTIONS.has(action) ? 'editorial' : 'execution';
}

// ---------- byte-exact identity framing ----------

// Every hash below is sha256 over LENGTH-PREFIXED field framing:
//   frame([a, b, …]) = "<utf8 byte length>:<field>" concatenated, in order.
// A length prefix makes the framing injective (no separator can be forged into
// a field), and it is trivially reproducible in SQL:
//   octet_length(convert_to(p,'UTF8'))::text || ':' || p
// so the migration backfill derives BYTE-IDENTICAL digests (pinned by the
// Node↔SQL test-vector suite in test/hitl-migration.test.ts).
//
// Nullable fields are framed as a PRESENCE PAIR (['0',''] absent / ['1',value])
// rather than a JSON-encoded null, so neither side ever has to reproduce the
// other's string-escaping rules.

export const REQUEST_KEY_DOMAIN = 'hitl.request_key.v1';
export const TARGET_HASH_DOMAIN = 'hitl.target_hash.v1';
export const PACKET_HASH_DOMAIN = 'hitl.packet_hash.v1';
export const REQUEST_ID_DOMAIN = 'hitl.request_id.v1';

// ASCII whitespace ONLY (space, tab, LF, VT, FF, CR). Deliberately NOT
// String.prototype.trim(), whose Unicode whitespace set (NBSP, ideographic
// space, BOM…) SQL cannot cheaply reproduce; and deliberately not a Unicode
// normalization, which needs PG >= 13 `normalize()`. Both sides implement
// exactly this set.
const ASCII_TRIM_CODES: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

export function normalizeTarget(target: string): string {
  let start = 0;
  let end = target.length;
  while (start < end && ASCII_TRIM_CODES.has(target.charCodeAt(start))) start += 1;
  while (end > start && ASCII_TRIM_CODES.has(target.charCodeAt(end - 1))) end -= 1;
  return target.slice(start, end);
}

export function frameFields(parts: readonly string[]): string {
  let out = '';
  for (const part of parts) out += `${Buffer.byteLength(part, 'utf8')}:${part}`;
  return out;
}

function framedDigest(parts: readonly string[]): string {
  return sha256Hex(Buffer.from(frameFields(parts), 'utf8'));
}

function presence(value: string | null | undefined): [string, string] {
  return value === null || value === undefined ? ['0', ''] : ['1', value];
}

function presenceJson(value: unknown): [string, string] {
  return value === null || value === undefined ? ['0', ''] : ['1', canonicalJson(value)];
}

export type HitlRequestKeyInput = { functionName: string; action: string; target: string };

export function requestKeyOf(input: HitlRequestKeyInput): string {
  return framedDigest([
    REQUEST_KEY_DOMAIN,
    input.functionName,
    input.action,
    normalizeTarget(input.target),
  ]);
}

export function targetHashOf(target: string): string {
  return framedDigest([TARGET_HASH_DOMAIN, normalizeTarget(target)]);
}

export function requestIdOf(workspaceId: string, requestKey: string): string {
  return framedDigest([REQUEST_ID_DOMAIN, workspaceId, requestKey]);
}

// The immutable reference to large content held in the object store (#323's
// objectVersionId port). Its canonical JSON is what the packet hash covers, so
// swapping the referenced bytes/version is a packet change like any other.
export type HitlPayloadRef = {
  digest: string;
  size: number;
  mediaType: string | null;
  uri: string | null;
  objectVersionId: string | null;
};

// EVERY approval-visible field. If a human could read it on the approval card,
// it is in here — so editing it invalidates the old approval (ISSUE-319
// "Editing content, target, action, or policy-relevant metadata creates a new
// version"). That includes the PRESENTATION and ATTRIBUTION fields (`title`,
// `originRunId`, `originTaskId`, `requestingAgent`): they are rendered next to
// the ask, so re-submitting the same body under a different requesting agent is
// a different approval question, not an idempotent replay of the old one.
// Audit-only observations (created_at, seq, the generation/version the store
// ALLOCATES) stay excluded: an idempotent replay of the same packet must hash
// identically.
//
// `title` is a plain (never-absent) field — the store requires it and every
// legacy path normalizes a missing one to '' — so both sides frame it without a
// presence pair. The origin/agent trio is nullable and framed as presence pairs.
export type HitlPacket = {
  action: string;
  actionKind: HitlActionKind;
  target: string;
  // Exactly one of contentHash (small exact text, inline) / payloadRef (large
  // content in the object store) — mirrored by a DB CHECK.
  contentHash: string | null;
  payloadRef: HitlPayloadRef | null;
  expiresAt: number | null;
  canonicalizationVersion: number;
  title: string;
  summary?: string | null;
  warnings?: unknown;
  sideEffects?: unknown;
  choices?: unknown;
  originRunId?: string | null;
  originTaskId?: string | null;
  requestingAgent?: string | null;
};

export function packetHashOf(packet: HitlPacket): string {
  const hasRef = packet.payloadRef !== null && packet.payloadRef !== undefined;
  const hasInline = packet.contentHash !== null && packet.contentHash !== undefined;
  if (hasRef === hasInline) {
    throw new InvalidRecordError(
      'a HITL packet carries exactly one of contentHash (inline) or payloadRef (object store)',
    );
  }
  if (typeof packet.title !== 'string') {
    throw new InvalidRecordError('a HITL packet title is a string (use "" when a legacy row carries none)');
  }
  return framedDigest([
    PACKET_HASH_DOMAIN,
    packet.action,
    packet.actionKind,
    normalizeTarget(packet.target),
    targetHashOf(packet.target),
    hasRef ? 'ref' : 'inline',
    hasRef ? canonicalJson(packet.payloadRef) : (packet.contentHash as string),
    ...presence(
      packet.expiresAt === null || packet.expiresAt === undefined ? null : String(packet.expiresAt),
    ),
    String(packet.canonicalizationVersion),
    packet.title,
    ...presence(packet.summary ?? null),
    ...presenceJson(packet.warnings),
    ...presenceJson(packet.sideEffects),
    ...presenceJson(packet.choices),
    ...presence(packet.originRunId ?? null),
    ...presence(packet.originTaskId ?? null),
    ...presence(packet.requestingAgent ?? null),
  ]);
}

// ---------- transition table ----------

// awaiting → any decision. deferred → any decision EXCEPT another deferred
// (the duplicate-deferred guard; deferred stays NON-terminal and actionable —
// ISSUE-319 "a deferred item remains included in the actionable queue").
// Every terminal status is a sink: continuation is a NEW version (owner
// decision 4) or, once the generation is sealed, a NEW generation.
export const TRANSITIONS: Readonly<Record<HitlStatus, readonly HitlDecisionStatus[]>> = {
  awaiting: ['approved', 'changes-requested', 'rejected', 'deferred', 'expired', 'cancelled'],
  deferred: ['approved', 'changes-requested', 'rejected', 'expired', 'cancelled'],
  approved: [],
  'changes-requested': [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export function isTerminalStatus(status: HitlStatus): boolean {
  return status !== 'awaiting' && status !== 'deferred';
}

// ---------- the head ----------

// The current version of the HIGHEST generation of one request group, with its
// decisions already folded in. Every predicate below reads exactly this shape,
// whether it came from the PG `hitl.request_state` view or from
// deriveRequestState over local ledger records.
export type HitlHead = {
  requestId: string;
  requestKey: string;
  generation: number;
  version: number;
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  expiresAt: number | null;
  createdAt: number;
  // The decision-graph status IGNORING expiry ('awaiting' | 'deferred' | the
  // terminal decision's status). Drives the transition table.
  nodeStatus: HitlStatus;
  // The SWEEP-INDEPENDENT status: 'expired' the moment the clock passes
  // expires_at with no terminal decision, whether or not the expiry sweep has
  // materialized a durable `expired` decision yet (owner decision 3).
  status: HitlStatus;
  terminalStatus: HitlDecisionStatus | null;
  deferred: boolean;
  // A sealed generation accepts no further decisions; a same-key submission
  // opens G+1. Effective expiry seals too (the store materializes the durable
  // `expired` decision in the same lock/txn that opens the next generation).
  sealed: boolean;
  isCurrentVersion: boolean;
  isHighestGeneration: boolean;
  // Pointed at by a live cross-group supersession row (D3 `replaces`).
  superseded: boolean;
};

export type HitlAuthorityDenial =
  | 'legacy-canonicalization'
  | 'stale-generation'
  | 'stale-version'
  | 'superseded'
  | 'not-approved'
  | 'missing-expiry'
  | 'expired'
  | 'action-mismatch'
  | 'action-kind-mismatch'
  | 'target-mismatch'
  | 'target-hash-mismatch'
  | 'packet-hash-mismatch'
  | 'canonicalization-mismatch'
  | 'expiry-mismatch'
  | 'request-mismatch'
  | 'version-mismatch';

export type HitlAuthority =
  | { authorized: true }
  | { authorized: false; reason: HitlAuthorityDenial; detail: string };

function deny(reason: HitlAuthorityDenial, detail: string): HitlAuthority {
  return { authorized: false, reason, detail };
}

// The #322 predicate. An APPROVED head is terminal — and terminal is exactly
// what the normal approve-then-execute path looks like — so being terminal is
// NOT a reason to refuse (D1 resolves the rev-6 line-17/20 contradiction).
// What DOES refuse: a legacy unverifiable packet (D8), an older generation
// (authority NEVER falls back), a superseded or non-current version, a
// non-approved status, and an elapsed expiry.
export function canAuthorizeExecution(head: HitlHead, now: number): HitlAuthority {
  if (head.canonicalizationVersion <= LEGACY_CANONICALIZATION_VERSION) {
    return deny(
      'legacy-canonicalization',
      `canonicalization_version ${head.canonicalizationVersion}: this row's content hash was never verified (migration-exempt), so it can never authorize execution`,
    );
  }
  if (!head.isHighestGeneration) {
    return deny(
      'stale-generation',
      `generation ${head.generation} is not the highest generation for request_key ${head.requestKey}`,
    );
  }
  if (!head.isCurrentVersion) {
    return deny('stale-version', `version ${head.version} is not the current version of generation ${head.generation}`);
  }
  if (head.superseded) {
    return deny('superseded', `generation ${head.generation} version ${head.version} was superseded by another request group`);
  }
  if (head.status !== 'approved') {
    return deny('not-approved', `effective status is '${head.status}', not 'approved'`);
  }
  if (head.expiresAt === null) {
    // Execution requests MUST carry an expiry (DB CHECK); a NULL expiry here
    // therefore means an editorial approval, which authorizes only editorial
    // work — never an unbounded execution grant.
    if (head.actionKind !== 'editorial') {
      return deny('missing-expiry', "an execution approval without an expiry is never authoritative");
    }
  } else if (now >= head.expiresAt) {
    return deny('expired', `approval expired at ${head.expiresAt} (now ${now})`);
  }
  return { authorized: true };
}

// What the caller believes it is about to execute. Every field is compared for
// EXACT equality against the stored head: any drift in action, kind, target,
// content, canonicalization, or expiry invalidates the approval (ISSUE-319).
export type HitlApprovalExpectation = {
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  expiresAt: number | null;
  requestId?: string;
  generation?: number;
  version?: number;
};

export function validateApproval(
  head: HitlHead,
  expected: HitlApprovalExpectation,
  now: number,
): HitlAuthority {
  const authority = canAuthorizeExecution(head, now);
  if (!authority.authorized) return authority;
  if (expected.requestId !== undefined && expected.requestId !== head.requestId) {
    return deny('request-mismatch', `expected request ${expected.requestId}, head is ${head.requestId}`);
  }
  if (
    (expected.generation !== undefined && expected.generation !== head.generation) ||
    (expected.version !== undefined && expected.version !== head.version)
  ) {
    return deny(
      'version-mismatch',
      `expected generation/version ${String(expected.generation)}/${String(expected.version)}, head is ${head.generation}/${head.version}`,
    );
  }
  if (expected.action !== head.action) {
    return deny('action-mismatch', `expected action '${expected.action}', approved action is '${head.action}'`);
  }
  // Editorial approval can NEVER satisfy an execution request (owner decision 2).
  if (expected.actionKind !== head.actionKind) {
    return deny(
      'action-kind-mismatch',
      `expected a '${expected.actionKind}' approval, the head is '${head.actionKind}'`,
    );
  }
  if (normalizeTarget(expected.target) !== normalizeTarget(head.target)) {
    return deny('target-mismatch', `expected target '${expected.target}', approved target is '${head.target}'`);
  }
  if (expected.targetHash !== head.targetHash) {
    return deny('target-hash-mismatch', 'the normalized target hash does not match the approved one');
  }
  if (expected.packetHash !== head.packetHash) {
    return deny('packet-hash-mismatch', 'the approval packet changed since it was approved');
  }
  if (expected.canonicalizationVersion !== head.canonicalizationVersion) {
    return deny(
      'canonicalization-mismatch',
      `expected canonicalization_version ${expected.canonicalizationVersion}, head is ${head.canonicalizationVersion}`,
    );
  }
  if (expected.expiresAt !== head.expiresAt) {
    return deny(
      'expiry-mismatch',
      `expected expiry ${String(expected.expiresAt)}, approved expiry is ${String(head.expiresAt)}`,
    );
  }
  return { authorized: true };
}

// ---------- decisions ----------

export type HitlDecisionDenial =
  | 'invalid-status'
  | 'stale-generation'
  | 'not-head'
  | 'superseded'
  | 'already-terminal'
  | 'not-expired'
  | 'expired'
  | 'invalid-transition';

export type HitlDecisionCheck = { ok: true } | { ok: false; reason: HitlDecisionDenial; detail: string };

function refuse(reason: HitlDecisionDenial, detail: string): HitlDecisionCheck {
  return { ok: false, reason, detail };
}

// Mirrors hitl.enforce_decision() in 002_state_machine.sql check-for-check, so
// the local backend and the DB refuse the same writes for the same reasons.
export function canDecide(head: HitlHead, decision: HitlDecisionStatus, now: number): HitlDecisionCheck {
  if (decision === ('awaiting' as HitlStatus) || TRANSITIONS[decision as HitlStatus] === undefined) {
    return refuse('invalid-status', `'${decision}' is not a decision status`);
  }
  if (!head.isHighestGeneration) {
    return refuse('stale-generation', `generation ${head.generation} is not the highest generation`);
  }
  if (!head.isCurrentVersion) {
    return refuse('not-head', `version ${head.version} is not the current version of generation ${head.generation}`);
  }
  if (head.superseded) {
    return refuse('superseded', 'this version was superseded by another request group');
  }
  if (head.terminalStatus !== null) {
    return refuse('already-terminal', `version already carries the terminal decision '${head.terminalStatus}'`);
  }
  if (decision === 'expired') {
    // Direction check: a system expiry may only be recorded once the clock has
    // actually passed the stored expiry.
    if (head.expiresAt === null || now < head.expiresAt) {
      return refuse('not-expired', `request does not expire until ${String(head.expiresAt)} (now ${now})`);
    }
  } else if (head.expiresAt !== null && now >= head.expiresAt) {
    return refuse('expired', `request expired at ${head.expiresAt} (now ${now})`);
  }
  if (!TRANSITIONS[head.nodeStatus].includes(decision)) {
    return refuse('invalid-transition', `'${head.nodeStatus}' does not accept '${decision}'`);
  }
  return { ok: true };
}

// ---------- submission planning ----------

// The head the CALLER believes is current, read before it composed its packet.
// D1: it binds the HIGHEST observed generation's head (sealed or not), and
// `null` means "no history for this key AT ALL" — so a caller that observed a
// sealed G1 cannot silently mint G3 after an intervening G2 it never saw.
//
// `sealed` is MANDATORY, not decorative: a terminal decision (or an elapsed
// expiry) changes NOTHING ELSE about the head — same generation, same version,
// same packet — so a fingerprint without it cannot tell "the open head I read"
// from "the approval that landed while I was composing", and a stale submission
// would silently open the next generation behind a fresh approval.
export type HitlExpectedHead = {
  generation: number;
  version: number;
  packetHash: string;
  sealed: boolean;
};

// What the STORE read under the group lock. It carries one field the caller's
// expectation cannot: `superseded` — whether a live cross-group supersession row
// points at this exact head. A `replaces` records that pointer on the
// DESTINATION row (D3), so the source head's own {generation, version,
// packetHash, sealed} fingerprint is completely unchanged by being replaced;
// only the store-side anti-join can tell.
export type HitlObservedHead = {
  generation: number;
  version: number;
  packetHash: string;
  sealed: boolean;
  superseded: boolean;
};

export type HitlSubmissionState = { head: HitlObservedHead | null };

export type HitlSubmissionInput = {
  packetHash: string;
  expectedHead: HitlExpectedHead | null;
};

export type HitlConflictReason =
  | 'stale-expected-head'
  | 'unexpected-history'
  | 'missing-history'
  | 'superseded-head';

export type HitlSubmissionPlan =
  | { kind: 'idempotent'; generation: number; version: number }
  | { kind: 'revise'; generation: number; version: number }
  | { kind: 'open-generation'; generation: number; version: number }
  | { kind: 'conflict'; reason: HitlConflictReason; detail: string };

// The permanent-closure refusal, as ONE value. Every gate that can let a WRITE
// reach a superseded group returns exactly this — planSubmission below, and the
// post-plan re-check in hitl-store.ts#finalizeSubmissionPlan, which is where a
// plan's kind is allowed to change after this function returned.
export function supersededHeadConflict(head: {
  generation: number;
  version: number;
}): Extract<HitlSubmissionPlan, { kind: 'conflict' }> {
  return {
    kind: 'conflict',
    reason: 'superseded-head',
    detail: `generation ${head.generation} version ${head.version} was superseded by another request group — this group is closed; submit against the group that replaced it`,
  };
}

export function planSubmission(
  state: HitlSubmissionState,
  input: HitlSubmissionInput,
): HitlSubmissionPlan {
  const head = state.head;
  if (head === null) {
    if (input.expectedHead !== null) {
      return {
        kind: 'conflict',
        reason: 'missing-history',
        detail: `caller expected generation ${input.expectedHead.generation} version ${input.expectedHead.version}, but this key has no history`,
      };
    }
    return { kind: 'open-generation', generation: 1, version: 1 };
  }
  if (input.expectedHead === null) {
    // The caller asserted "no history at all". Exactly ONE reality satisfies
    // that assertion anyway: the head is an OPEN, byte-identical packet — an
    // at-least-once retry of this very submission, which is idempotent by
    // definition. Anything else (a different packet, or a SEALED head whose
    // successor would be an independent approval) demands a re-read, so this
    // exception can never cross a terminal boundary.
    if (!head.sealed && head.packetHash === input.packetHash) {
      return { kind: 'idempotent', generation: head.generation, version: head.version };
    }
    return {
      kind: 'conflict',
      reason: 'unexpected-history',
      detail: `caller expected no history, but generation ${head.generation} version ${head.version} exists (sealed: ${head.sealed})`,
    };
  }
  const expected = input.expectedHead;
  if (
    expected.generation !== head.generation ||
    expected.version !== head.version ||
    expected.packetHash !== head.packetHash ||
    expected.sealed !== head.sealed
  ) {
    return {
      kind: 'conflict',
      reason: 'stale-expected-head',
      detail: `caller observed generation ${expected.generation} version ${expected.version} (sealed: ${expected.sealed}), current head is generation ${head.generation} version ${head.version} (sealed: ${head.sealed})`,
    };
  }
  // Idempotent FIRST among the WRITING branches' exclusions: an identical packet
  // against an open head writes nothing at all, so it can never resurrect
  // anything and stays a valid at-least-once retry even here.
  if (!head.sealed && head.packetHash === input.packetHash) {
    return { kind: 'idempotent', generation: head.generation, version: head.version };
  }
  // A SUPERSEDED group is permanently closed. `replaces` records the
  // supersession on the destination row, so this head's fingerprint still
  // matches what the caller observed — the expectation check above cannot see
  // it. Without this refusal a stale caller wrote version N+1 (or generation
  // G+1) that NO supersession row points at, and that new head became
  // authoritative alongside the destination: two live approvals for one decision
  // that was meant to be replaced. There is no reopen intent: the caller must
  // re-read and target the destination group.
  if (head.superseded) {
    return supersededHeadConflict(head);
  }
  // Sealed: re-submitting an identical packet after a terminal decision is a
  // fresh ask (an independent approval), never an idempotent no-op.
  if (head.sealed) {
    return { kind: 'open-generation', generation: head.generation + 1, version: 1 };
  }
  return { kind: 'revise', generation: head.generation, version: head.version + 1 };
}

// ---------- projection ----------

export type HitlVersionRow = {
  requestId: string;
  requestKey: string;
  generation: number;
  version: number;
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  expiresAt: number | null;
  createdAt: number;
};

export type HitlDecisionRow = {
  id: string;
  generation: number;
  version: number;
  status: HitlDecisionStatus;
  decidedAt: number;
};

// Cross-group supersession pointing AT this group (D3). It cannot be derived
// from this group's own rows — the superseding row lives in another group — so
// the caller supplies the anti-join result.
export type HitlSupersession = { generation: number; version: number };

export type HitlRequestState = {
  requestId: string | null;
  requestKey: string | null;
  highestGeneration: number;
  head: HitlHead | null;
  effectiveStatus: HitlStatus | null;
  actionable: boolean;
  authoritative: boolean;
};

// The authoritative projection the local store computes and the PG
// hitl.request_state view mirrors. `now` is injected — never Date.now() — so
// the property-equality test can drive both sides off one clock.
export function deriveRequestState(
  versions: readonly HitlVersionRow[],
  decisions: readonly HitlDecisionRow[],
  now: number,
  superseded: readonly HitlSupersession[] = [],
): HitlRequestState {
  if (versions.length === 0) {
    return {
      requestId: null,
      requestKey: null,
      highestGeneration: 0,
      head: null,
      effectiveStatus: null,
      actionable: false,
      authoritative: false,
    };
  }
  let highestGeneration = versions[0]!.generation;
  for (const row of versions) if (row.generation > highestGeneration) highestGeneration = row.generation;

  let headRow = versions.find((r) => r.generation === highestGeneration)!;
  for (const row of versions) {
    if (row.generation === highestGeneration && row.version > headRow.version) headRow = row;
  }

  const forHead = decisions
    .filter((d) => d.generation === headRow.generation && d.version === headRow.version)
    // Deterministic winner when a (DB-prevented) duplicate slips through a
    // hand-built local ledger: earliest decision, then lowest id.
    .sort((a, b) => a.decidedAt - b.decidedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const terminal = forHead.find((d) => isTerminalStatus(d.status)) ?? null;
  const deferred = forHead.some((d) => d.status === 'deferred');
  const nodeStatus: HitlStatus = terminal !== null ? terminal.status : deferred ? 'deferred' : 'awaiting';
  const expired = headRow.expiresAt !== null && now >= headRow.expiresAt;
  // Terminal dominates: an approval recorded before the deadline stays
  // 'approved' as a STATUS (canAuthorizeExecution is what refuses to act on it
  // afterwards). Only an undecided version flips to 'expired'.
  const effectiveStatus: HitlStatus = terminal !== null ? terminal.status : expired ? 'expired' : nodeStatus;

  const head: HitlHead = {
    requestId: headRow.requestId,
    requestKey: headRow.requestKey,
    generation: headRow.generation,
    version: headRow.version,
    action: headRow.action,
    actionKind: headRow.actionKind,
    target: headRow.target,
    targetHash: headRow.targetHash,
    packetHash: headRow.packetHash,
    canonicalizationVersion: headRow.canonicalizationVersion,
    expiresAt: headRow.expiresAt,
    createdAt: headRow.createdAt,
    nodeStatus,
    status: effectiveStatus,
    terminalStatus: terminal !== null ? terminal.status : null,
    deferred,
    sealed: terminal !== null || expired,
    isCurrentVersion: true,
    isHighestGeneration: true,
    superseded: superseded.some(
      (s) => s.generation === headRow.generation && s.version === headRow.version,
    ),
  };

  return {
    requestId: head.requestId,
    requestKey: head.requestKey,
    highestGeneration,
    head,
    effectiveStatus,
    // A superseded head was REPLACED by another group: there is nothing left for
    // a human to decide on it, so it is out of the default actionable workset on
    // both backends (the postgres filter applies the same `NOT superseded` to
    // the view's anti-join column). An EXPLICIT status filter still reaches it —
    // that query is history, not the queue.
    actionable: (effectiveStatus === 'awaiting' || effectiveStatus === 'deferred') && !head.superseded,
    authoritative: canAuthorizeExecution(head, now).authorized,
  };
}
