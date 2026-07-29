import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InvalidRecordError, type HitlDecisionStatus, type HitlStatus } from '../src/lib/persistence/contracts.ts';
import {
  CANONICALIZATION_VERSION,
  EDITORIAL_ACTIONS,
  HITL_GROUP_LOCK_MASK,
  LEGACY_CANONICALIZATION_VERSION,
  TRANSITIONS,
  canAuthorizeExecution,
  canDecide,
  classifyAction,
  deriveRequestState,
  frameFields,
  normalizeTarget,
  packetHashOf,
  planSubmission,
  requestIdOf,
  requestKeyOf,
  targetHashOf,
  validateApproval,
  type HitlApprovalExpectation,
  type HitlDecisionRow,
  type HitlHead,
  type HitlVersionRow,
} from '../src/lib/persistence/hitl-machine.ts';

// #319 stage 1: hermetic contract suite for the shared state machine. No I/O,
// no clock — every predicate takes an injected `now`. The SQL mirror of the
// same rules is exercised in test/hitl-migration.test.ts (PG-gated).

const NOW = 1_700_000_000_000;
const WS = '11111111-1111-4111-8111-111111111111';
const HEX = 'a'.repeat(64);

function head(overrides: Partial<HitlHead> = {}): HitlHead {
  const base: HitlHead = {
    requestId: 'req-1',
    requestKey: 'key-1',
    generation: 1,
    version: 1,
    action: 'publish-post',
    actionKind: 'execution',
    target: 'blog/launch.md',
    targetHash: targetHashOf('blog/launch.md'),
    packetHash: 'packet-1',
    canonicalizationVersion: CANONICALIZATION_VERSION,
    expiresAt: NOW + 60_000,
    createdAt: NOW - 60_000,
    nodeStatus: 'approved',
    status: 'approved',
    terminalStatus: 'approved',
    deferred: false,
    sealed: true,
    isCurrentVersion: true,
    isHighestGeneration: true,
    superseded: false,
  };
  return { ...base, ...overrides };
}

function expectation(h: HitlHead, overrides: Partial<HitlApprovalExpectation> = {}): HitlApprovalExpectation {
  return {
    action: h.action,
    actionKind: h.actionKind,
    target: h.target,
    targetHash: h.targetHash,
    packetHash: h.packetHash,
    canonicalizationVersion: h.canonicalizationVersion,
    expiresAt: h.expiresAt,
    ...overrides,
  };
}

function denial(result: ReturnType<typeof canAuthorizeExecution>): string {
  return result.authorized ? 'authorized' : result.reason;
}

// ---------------- action classification ----------------

test('hitl-machine: classifyAction is a closed allowlist that fails safe to execution', () => {
  for (const action of EDITORIAL_ACTIONS) {
    assert.equal(classifyAction(action), 'editorial', `${action} is editorial`);
  }
  for (const action of ['publish-post', 'schedule-post', 'delete-artifact', '', 'APPROVE-DRAFT', 'approve-draft ']) {
    assert.equal(classifyAction(action), 'execution', `${JSON.stringify(action)} classifies as execution`);
  }
  // A brand-new action nobody has heard of must NOT be able to opt itself into
  // the weaker editorial regime.
  assert.equal(classifyAction('wire-transfer-funds'), 'execution');
  assert.equal(classifyAction(undefined as never), 'execution');
});

// ---------------- framing / identity ----------------

test('hitl-machine: field framing is length-prefixed and injective', () => {
  assert.equal(frameFields(['ab', '', 'héllo']), '2:ab0:6:héllo');
  // The classic separator-forgery: ['a:b','c'] and ['a','b:c'] must not collide.
  assert.notEqual(frameFields(['a:b', 'c']), frameFields(['a', 'b:c']));
  // Reordering fields changes the digest.
  assert.notEqual(
    requestKeyOf({ functionName: 'a', action: 'b', target: 'c' }),
    requestKeyOf({ functionName: 'b', action: 'a', target: 'c' }),
  );
});

test('hitl-machine: normalizeTarget strips exactly the six ASCII whitespace codes', () => {
  assert.equal(normalizeTarget('  blog/x.md \t\n\r\v\f'), 'blog/x.md');
  assert.equal(normalizeTarget('blog/x.md'), 'blog/x.md');
  assert.equal(normalizeTarget('   '), '');
  // NBSP is NOT ASCII whitespace: SQL's btrim over the same six characters
  // leaves it too, so both sides agree.
  assert.equal(normalizeTarget(' x '), ' x ');
  // Interior whitespace is untouched.
  assert.equal(normalizeTarget(' a b '), 'a b');
  assert.equal(
    targetHashOf('  blog/x.md  '),
    targetHashOf('blog/x.md'),
    'the target hash is over the NORMALIZED target',
  );
});

test('hitl-machine: request identity is stable, full-length, and workspace-scoped', () => {
  const key = requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/x.md' });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: ' blog/x.md ' }));
  assert.notEqual(key, requestKeyOf({ functionName: 'sales', action: 'publish-post', target: 'blog/x.md' }));
  const id = requestIdOf(WS, key);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(id, requestIdOf('22222222-2222-4222-8222-222222222222', key));
});

test('hitl-machine: packetHashOf covers every approval-visible field', () => {
  const base = {
    action: 'publish-post',
    actionKind: 'execution' as const,
    target: 'blog/x.md',
    contentHash: HEX,
    payloadRef: null,
    expiresAt: NOW,
    canonicalizationVersion: 1,
    title: 'Approve the launch post',
    summary: 'Ship the launch post',
    warnings: ['irreversible'],
    sideEffects: [{ system: 'blog' }],
    choices: ['now', 'later'],
    originRunId: 'run-1',
    originTaskId: 'task-1',
    requestingAgent: 'sdr',
  };
  const reference = packetHashOf(base);
  const mutations: Array<[string, Parameters<typeof packetHashOf>[0]]> = [
    ['action', { ...base, action: 'schedule-post' }],
    ['actionKind', { ...base, actionKind: 'editorial' }],
    ['target', { ...base, target: 'blog/y.md' }],
    ['contentHash', { ...base, contentHash: 'b'.repeat(64) }],
    ['expiresAt', { ...base, expiresAt: NOW + 1 }],
    ['expiresAt→null', { ...base, expiresAt: null }],
    ['canonicalizationVersion', { ...base, canonicalizationVersion: 0 }],
    // Presentation + attribution are approval-VISIBLE, so they are identity.
    ['title', { ...base, title: 'Approve the launch post ' }],
    ['title→empty', { ...base, title: '' }],
    ['summary', { ...base, summary: 'Ship the launch post.' }],
    ['summary→null', { ...base, summary: null }],
    ['warnings', { ...base, warnings: [] }],
    ['sideEffects', { ...base, sideEffects: null }],
    ['choices', { ...base, choices: ['now'] }],
    ['originRunId', { ...base, originRunId: 'run-2' }],
    ['originRunId→null', { ...base, originRunId: null }],
    ['originTaskId', { ...base, originTaskId: 'task-2' }],
    ['originTaskId→null', { ...base, originTaskId: null }],
    ['requestingAgent', { ...base, requestingAgent: 'chief-of-staff' }],
    ['requestingAgent→null', { ...base, requestingAgent: null }],
  ];
  const seen = new Set([reference]);
  for (const [label, mutated] of mutations) {
    const hash = packetHashOf(mutated);
    assert.notEqual(hash, reference, `${label} must change the packet hash`);
    assert.ok(!seen.has(hash), `${label} must not collide with an earlier variant`);
    seen.add(hash);
  }
  // Idempotent: the same packet hashes identically, and key ORDER in the jsonb
  // fields is canonicalized away.
  assert.equal(packetHashOf({ ...base }), reference);
  assert.equal(
    packetHashOf({ ...base, sideEffects: [{ system: 'blog' }] }),
    packetHashOf({ ...base, sideEffects: [{ system: 'blog' }] }),
  );
});

test('hitl-machine: a packet carries exactly one content channel', () => {
  const ref = { digest: HEX, size: 10, mediaType: 'text/markdown', uri: null, objectVersionId: 'v1' };
  const inline = {
    action: 'publish-post',
    actionKind: 'execution' as const,
    target: 't',
    expiresAt: NOW,
    canonicalizationVersion: 1,
    title: 'Approve it',
  };
  assert.throws(() => packetHashOf({ ...inline, contentHash: HEX, payloadRef: ref }), InvalidRecordError);
  assert.throws(() => packetHashOf({ ...inline, contentHash: null, payloadRef: null }), InvalidRecordError);
  const byRef = packetHashOf({ ...inline, contentHash: null, payloadRef: ref });
  assert.match(byRef, /^[0-9a-f]{64}$/);
  // payload_ref metadata is IN the packet: swapping the object version is a
  // packet change, so an approval of the old bytes cannot cover the new ones.
  assert.notEqual(
    byRef,
    packetHashOf({ ...inline, contentHash: null, payloadRef: { ...ref, objectVersionId: 'v2' } }),
  );
  assert.notEqual(byRef, packetHashOf({ ...inline, contentHash: HEX, payloadRef: null }));
});

// ---------------- transition matrix ----------------

test('hitl-machine: the transition matrix is exhaustive and terminal statuses are sinks', () => {
  const statuses: HitlStatus[] = [
    'awaiting',
    'approved',
    'changes-requested',
    'rejected',
    'deferred',
    'expired',
    'cancelled',
  ];
  for (const status of statuses) assert.ok(TRANSITIONS[status] !== undefined, `${status} is in the table`);
  assert.deepEqual(
    [...TRANSITIONS.awaiting],
    ['approved', 'changes-requested', 'rejected', 'deferred', 'expired', 'cancelled'],
  );
  // deferred is NON-terminal: it accepts everything except another deferral.
  assert.ok(!TRANSITIONS.deferred.includes('deferred' as HitlDecisionStatus));
  assert.equal(TRANSITIONS.deferred.length, TRANSITIONS.awaiting.length - 1);
  for (const terminal of ['approved', 'changes-requested', 'rejected', 'expired', 'cancelled'] as HitlStatus[]) {
    assert.deepEqual([...TRANSITIONS[terminal]], [], `${terminal} is a sink`);
  }
});

test('hitl-machine: canDecide walks the matrix and refuses off-head / expired / duplicate writes', () => {
  const open = head({ nodeStatus: 'awaiting', status: 'awaiting', terminalStatus: null, sealed: false });
  for (const decision of TRANSITIONS.awaiting) {
    const result = canDecide(open, decision, decision === 'expired' ? open.expiresAt! + 1 : NOW);
    assert.equal(result.ok, true, `awaiting accepts ${decision}: ${JSON.stringify(result)}`);
  }

  const deferred = head({ nodeStatus: 'deferred', status: 'deferred', terminalStatus: null, deferred: true, sealed: false });
  assert.equal(canDecide(deferred, 'approved', NOW).ok, true, 'a deferred version stays decidable');
  const dup = canDecide(deferred, 'deferred', NOW);
  assert.equal(dup.ok, false);
  assert.equal(dup.ok === false && dup.reason, 'invalid-transition');

  const settled = head({ nodeStatus: 'rejected', status: 'rejected', terminalStatus: 'rejected' });
  const reopen = canDecide(settled, 'approved', NOW);
  assert.equal(reopen.ok === false && reopen.reason, 'already-terminal');

  const stale = canDecide(head({ isHighestGeneration: false, terminalStatus: null, nodeStatus: 'awaiting' }), 'approved', NOW);
  assert.equal(stale.ok === false && stale.reason, 'stale-generation');
  const notHead = canDecide(head({ isCurrentVersion: false, terminalStatus: null, nodeStatus: 'awaiting' }), 'approved', NOW);
  assert.equal(notHead.ok === false && notHead.reason, 'not-head');
  const superseded = canDecide(head({ superseded: true, terminalStatus: null, nodeStatus: 'awaiting' }), 'approved', NOW);
  assert.equal(superseded.ok === false && superseded.reason, 'superseded');

  // Expiry direction, both ways.
  const late = canDecide(open, 'approved', open.expiresAt! + 1);
  assert.equal(late.ok === false && late.reason, 'expired');
  const early = canDecide(open, 'expired', NOW);
  assert.equal(early.ok === false && early.reason, 'not-expired');
  const editorialForever = head({
    actionKind: 'editorial',
    expiresAt: null,
    nodeStatus: 'awaiting',
    status: 'awaiting',
    terminalStatus: null,
    sealed: false,
  });
  assert.equal(canDecide(editorialForever, 'approved', NOW + 10 ** 12).ok, true, 'an open-ended editorial request never times out');
  const neverExpires = canDecide(editorialForever, 'expired', NOW);
  assert.equal(neverExpires.ok === false && neverExpires.reason, 'not-expired');

  const bogus = canDecide(open, 'awaiting' as never, NOW);
  assert.equal(bogus.ok === false && bogus.reason, 'invalid-status');
});

// ---------------- authority ----------------

test('hitl-machine: an approved TERMINAL head IS authoritative (the normal approve-then-execute path)', () => {
  const approved = head();
  assert.equal(approved.sealed, true, 'approval seals the generation');
  assert.equal(canAuthorizeExecution(approved, NOW).authorized, true);
});

test('hitl-machine: canAuthorizeExecution refuses every non-authoritative shape', () => {
  const cases: Array<[string, HitlHead, number, string]> = [
    // D8: a legacy row whose content hash was never verified can never
    // authorize, no matter how cleanly it was approved.
    ['legacy canonicalization', head({ canonicalizationVersion: LEGACY_CANONICALIZATION_VERSION }), NOW, 'legacy-canonicalization'],
    ['older generation', head({ isHighestGeneration: false }), NOW, 'stale-generation'],
    ['older version', head({ isCurrentVersion: false }), NOW, 'stale-version'],
    ['superseded by another group', head({ superseded: true }), NOW, 'superseded'],
    ['rejected', head({ status: 'rejected', nodeStatus: 'rejected', terminalStatus: 'rejected' }), NOW, 'not-approved'],
    ['awaiting', head({ status: 'awaiting', nodeStatus: 'awaiting', terminalStatus: null, sealed: false }), NOW, 'not-approved'],
    ['expired', head({ status: 'expired', nodeStatus: 'expired', terminalStatus: 'expired' }), NOW, 'not-approved'],
    // Approved BEFORE the deadline, validated AFTER it: the status stays
    // 'approved' (terminal dominates) but authority is gone.
    ['approved then elapsed', head(), NOW + 60_001, 'expired'],
    ['execution without an expiry', head({ expiresAt: null }), NOW, 'missing-expiry'],
  ];
  for (const [label, h, now, reason] of cases) {
    const result = canAuthorizeExecution(h, now);
    assert.equal(result.authorized, false, `${label} must not authorize`);
    assert.equal(denial(result), reason, label);
  }
  // Exactly at the deadline is already too late.
  assert.equal(denial(canAuthorizeExecution(head(), NOW + 60_000)), 'expired');
  assert.equal(canAuthorizeExecution(head(), NOW + 59_999).authorized, true);
  // An editorial approval may be open-ended.
  assert.equal(canAuthorizeExecution(head({ actionKind: 'editorial', expiresAt: null }), NOW + 10 ** 12).authorized, true);
});

test('hitl-machine: validateApproval refuses on every binding dimension', () => {
  const h = head();
  assert.equal(validateApproval(h, expectation(h), NOW).authorized, true);

  const mismatches: Array<[string, Partial<HitlApprovalExpectation>, string]> = [
    ['action', { action: 'schedule-post' }, 'action-mismatch'],
    ['action kind', { actionKind: 'editorial' }, 'action-kind-mismatch'],
    ['target', { target: 'blog/other.md' }, 'target-mismatch'],
    ['target hash', { targetHash: 'b'.repeat(64) }, 'target-hash-mismatch'],
    ['packet hash', { packetHash: 'packet-2' }, 'packet-hash-mismatch'],
    ['canonicalization version', { canonicalizationVersion: 2 }, 'canonicalization-mismatch'],
    ['expiry', { expiresAt: NOW + 60_001 }, 'expiry-mismatch'],
    ['expiry→null', { expiresAt: null }, 'expiry-mismatch'],
    ['request id', { requestId: 'req-2' }, 'request-mismatch'],
    ['generation', { generation: 2 }, 'version-mismatch'],
    ['version', { version: 2 }, 'version-mismatch'],
  ];
  for (const [label, override, reason] of mismatches) {
    const result = validateApproval(h, expectation(h, override), NOW);
    assert.equal(result.authorized, false, `${label} must invalidate the approval`);
    assert.equal(denial(result), reason, label);
  }
  // Whitespace-only target drift is NOT drift: both sides normalize.
  assert.equal(validateApproval(h, expectation(h, { target: '  blog/launch.md ' }), NOW).authorized, true);
});

test('hitl-machine: an editorial approval can never satisfy an execution request', () => {
  const editorial = head({
    action: 'approve-draft',
    actionKind: 'editorial',
    expiresAt: null,
  });
  // The same action name, the same target, the same packet — but the approval
  // was editorial and the caller is about to EXECUTE.
  const asExecution = expectation(editorial, { actionKind: 'execution' });
  assert.equal(denial(validateApproval(editorial, asExecution, NOW)), 'action-kind-mismatch');
  // ...and the reverse (an execution approval reused for editorial work).
  const execution = head();
  assert.equal(denial(validateApproval(execution, expectation(execution, { actionKind: 'editorial' }), NOW)), 'action-kind-mismatch');
});

test('hitl-machine: validateApproval refuses a legacy head before it ever looks at the binding', () => {
  const legacy = head({ canonicalizationVersion: LEGACY_CANONICALIZATION_VERSION });
  assert.equal(denial(validateApproval(legacy, expectation(legacy), NOW)), 'legacy-canonicalization');
});

// ---------------- submission planning ----------------

test('hitl-machine: planSubmission produces all four outcomes', () => {
  // (1) no history at all -> generation 1 version 1
  assert.deepEqual(planSubmission({ head: null }, { packetHash: 'p1', expectedHead: null }), {
    kind: 'open-generation',
    generation: 1,
    version: 1,
  });

  const open = { generation: 1, version: 2, packetHash: 'p2', sealed: false, superseded: false };
  const observed = { generation: 1, version: 2, packetHash: 'p2', sealed: false };

  // (2) identical packet against the OPEN head -> idempotent
  assert.deepEqual(planSubmission({ head: open }, { packetHash: 'p2', expectedHead: observed }), {
    kind: 'idempotent',
    generation: 1,
    version: 2,
  });

  // (3) a changed packet against the OPEN head -> revise to v+1
  assert.deepEqual(planSubmission({ head: open }, { packetHash: 'p3', expectedHead: observed }), {
    kind: 'revise',
    generation: 1,
    version: 3,
  });

  // (4) a sealed head -> a fresh generation, even for an IDENTICAL packet
  //     (re-asking after a rejection is a new ask, never a silent no-op). The
  //     caller must have OBSERVED the seal, or this is a sealing race.
  const sealed = { ...open, sealed: true };
  assert.deepEqual(
    planSubmission({ head: sealed }, { packetHash: 'p2', expectedHead: { ...observed, sealed: true } }),
    { kind: 'open-generation', generation: 2, version: 1 },
  );
});

test('hitl-machine: `sealed` is part of the fingerprint — a sealing race conflicts (D1)', () => {
  // The head the caller read, and the SAME head after an approval landed: same
  // generation, same version, same packet — only `sealed` differs.
  const observedOpen = { generation: 1, version: 1, packetHash: 'p1', sealed: false, superseded: false };
  const nowSealed = { generation: 1, version: 1, packetHash: 'p1', sealed: true, superseded: false };

  const race = planSubmission({ head: nowSealed }, { packetHash: 'p2', expectedHead: observedOpen });
  assert.equal(race.kind, 'conflict');
  assert.equal(race.kind === 'conflict' && race.reason, 'stale-expected-head');
  // ...including for an IDENTICAL packet, which would otherwise read as a
  // harmless idempotent replay of a request that has since been decided.
  const idempotentRace = planSubmission({ head: nowSealed }, { packetHash: 'p1', expectedHead: observedOpen });
  assert.equal(idempotentRace.kind === 'conflict' && idempotentRace.reason, 'stale-expected-head');
  // The reverse direction (the caller believes it is sealed, it is not) is
  // equally a conflict — no silent generation minting either way.
  const inverse = planSubmission({ head: observedOpen }, { packetHash: 'p2', expectedHead: nowSealed });
  assert.equal(inverse.kind === 'conflict' && inverse.reason, 'stale-expected-head');
});

test('hitl-machine: expectedHead null is a first creation, and an at-least-once retry of it', () => {
  const open = { generation: 1, version: 1, packetHash: 'p1', sealed: false, superseded: false };
  // A blind retry of the SAME packet against an OPEN head is idempotent: the
  // caller's ask is already pending, exactly as it intended.
  assert.deepEqual(planSubmission({ head: open }, { packetHash: 'p1', expectedHead: null }), {
    kind: 'idempotent',
    generation: 1,
    version: 1,
  });
  // A DIFFERENT packet, or a SEALED head, demands a re-read — the null
  // expectation can never cross a terminal boundary.
  assert.equal(
    planSubmission({ head: open }, { packetHash: 'p2', expectedHead: null }).kind,
    'conflict',
  );
  const sealedConflict = planSubmission(
    { head: { ...open, sealed: true } },
    { packetHash: 'p1', expectedHead: null },
  );
  assert.equal(sealedConflict.kind === 'conflict' && sealedConflict.reason, 'unexpected-history');
});

test('hitl-machine: planSubmission conflicts on a stale expectedHead (D1 ABA guard)', () => {
  const current = { generation: 3, version: 1, packetHash: 'p9', sealed: true, superseded: false };

  // The scenario D1 names: caller B observed a sealed G1, caller A opened and
  // sealed G2 meanwhile. B must NOT silently mint G3.
  const stale = planSubmission(
    { head: current },
    { packetHash: 'new', expectedHead: { generation: 1, version: 1, packetHash: 'p1', sealed: true } },
  );
  assert.equal(stale.kind, 'conflict');
  assert.equal(stale.kind === 'conflict' && stale.reason, 'stale-expected-head');

  // Same generation+version but a different packet hash is equally stale (the
  // head was revised out from under the caller).
  const drifted = planSubmission(
    { head: { generation: 3, version: 1, packetHash: 'p9', sealed: false, superseded: false } },
    { packetHash: 'new', expectedHead: { generation: 3, version: 1, packetHash: 'OLD', sealed: false } },
  );
  assert.equal(drifted.kind === 'conflict' && drifted.reason, 'stale-expected-head');

  // A caller that believes there is no history but history exists.
  const unexpected = planSubmission({ head: current }, { packetHash: 'new', expectedHead: null });
  assert.equal(unexpected.kind === 'conflict' && unexpected.reason, 'unexpected-history');

  // ...and a caller that expects a head where the key has none.
  const missing = planSubmission(
    { head: null },
    { packetHash: 'new', expectedHead: { generation: 1, version: 1, packetHash: 'p1', sealed: false } },
  );
  assert.equal(missing.kind === 'conflict' && missing.reason, 'missing-history');
});

// R4 finding 1a: `replaces` records the supersession on the DESTINATION row, so
// the source head's fingerprint is byte-identical before and after. The
// expectation check therefore CANNOT see it — only the store's anti-join can,
// which is why `superseded` is part of the observed head, not the expectation.
test('hitl-machine: a superseded head is closed to every WRITING plan (R4 finding 1a)', () => {
  const observed = { generation: 1, version: 1, packetHash: 'p1', sealed: false };
  const superseded = { ...observed, superseded: true };

  // Revise: the fingerprint still matches exactly, and the plan is refused.
  const revise = planSubmission({ head: superseded }, { packetHash: 'p2', expectedHead: observed });
  assert.equal(revise.kind, 'conflict');
  assert.equal(revise.kind === 'conflict' && revise.reason, 'superseded-head');

  // Open-generation: same, for a SEALED superseded head.
  const sealed = { ...superseded, sealed: true };
  const opened = planSubmission(
    { head: sealed },
    { packetHash: 'p2', expectedHead: { ...observed, sealed: true } },
  );
  assert.equal(opened.kind === 'conflict' && opened.reason, 'superseded-head');
  const reopenIdentical = planSubmission(
    { head: sealed },
    { packetHash: 'p1', expectedHead: { ...observed, sealed: true } },
  );
  assert.equal(reopenIdentical.kind === 'conflict' && reopenIdentical.reason, 'superseded-head');

  // An IDENTICAL packet against an open head writes nothing, so it stays a
  // valid at-least-once retry — it cannot resurrect anything.
  assert.deepEqual(planSubmission({ head: superseded }, { packetHash: 'p1', expectedHead: observed }), {
    kind: 'idempotent',
    generation: 1,
    version: 1,
  });
  assert.deepEqual(planSubmission({ head: superseded }, { packetHash: 'p1', expectedHead: null }), {
    kind: 'idempotent',
    generation: 1,
    version: 1,
  });

  // A stale expectation is still reported as staleness, not supersession.
  const stale = planSubmission(
    { head: superseded },
    { packetHash: 'p2', expectedHead: { ...observed, version: 9 } },
  );
  assert.equal(stale.kind === 'conflict' && stale.reason, 'stale-expected-head');
});

// ---------------- projection ----------------

function version(overrides: Partial<HitlVersionRow> = {}): HitlVersionRow {
  return {
    requestId: 'req-1',
    requestKey: 'key-1',
    generation: 1,
    version: 1,
    action: 'publish-post',
    actionKind: 'execution',
    target: 'blog/x.md',
    targetHash: targetHashOf('blog/x.md'),
    packetHash: 'p1',
    canonicalizationVersion: CANONICALIZATION_VERSION,
    expiresAt: NOW + 60_000,
    createdAt: NOW - 1000,
    ...overrides,
  };
}

function decision(overrides: Partial<HitlDecisionRow> = {}): HitlDecisionRow {
  return { id: 'd1', generation: 1, version: 1, status: 'approved', decidedAt: NOW, ...overrides };
}

test('hitl-machine: deriveRequestState folds decisions onto the highest generation head', () => {
  const empty = deriveRequestState([], [], NOW);
  assert.deepEqual(
    { head: empty.head, status: empty.effectiveStatus, actionable: empty.actionable, authoritative: empty.authoritative },
    { head: null, status: null, actionable: false, authoritative: false },
  );

  const versions = [
    version({ generation: 1, version: 1, packetHash: 'g1v1' }),
    version({ generation: 1, version: 2, packetHash: 'g1v2' }),
    version({ generation: 2, version: 1, packetHash: 'g2v1' }),
  ];
  const decisions = [
    decision({ id: 'd-old', generation: 1, version: 2, status: 'rejected' }),
  ];
  const state = deriveRequestState(versions, decisions, NOW);
  assert.equal(state.highestGeneration, 2);
  assert.equal(state.head?.packetHash, 'g2v1');
  assert.equal(state.effectiveStatus, 'awaiting');
  assert.equal(state.actionable, true);
  assert.equal(state.authoritative, false);
  assert.equal(state.head?.sealed, false, 'the new generation is open');
});

test('hitl-machine: deferred stays actionable and terminal dominates', () => {
  const deferredState = deriveRequestState([version()], [decision({ status: 'deferred' })], NOW);
  assert.equal(deferredState.effectiveStatus, 'deferred');
  assert.equal(deferredState.actionable, true, 'a deferred item remains in the actionable queue');
  assert.equal(deferredState.head?.sealed, false);

  // A deferral followed by a terminal decision on the same version: terminal
  // wins the effective status even though it is the LATER row.
  const settled = deriveRequestState(
    [version()],
    [decision({ id: 'd-defer', status: 'deferred', decidedAt: NOW - 10 }), decision({ id: 'd-final', status: 'approved', decidedAt: NOW })],
    NOW,
  );
  assert.equal(settled.effectiveStatus, 'approved');
  assert.equal(settled.actionable, false);
  assert.equal(settled.head?.deferred, true, 'the deferral is still visible in history');
  assert.equal(settled.head?.sealed, true);
});

test('hitl-machine: effective status is sweep-independent — an un-swept expiry is never actionable', () => {
  const past = deriveRequestState([version({ expiresAt: NOW - 1 })], [], NOW);
  assert.equal(past.effectiveStatus, 'expired', 'no durable expired decision exists yet');
  assert.equal(past.actionable, false);
  assert.equal(past.authoritative, false);
  assert.equal(past.head?.sealed, true, 'an effective expiry seals the generation');

  // Deferred + elapsed expiry is still expired, not actionable.
  const deferredThenExpired = deriveRequestState(
    [version({ expiresAt: NOW - 1 })],
    [decision({ status: 'deferred', decidedAt: NOW - 100 })],
    NOW,
  );
  assert.equal(deferredThenExpired.effectiveStatus, 'expired');
  assert.equal(deferredThenExpired.actionable, false);
});

test('hitl-machine: deriveRequestState applies the cross-group supersession anti-join', () => {
  const versions = [version({ generation: 2, version: 1 })];
  const decisions = [decision({ generation: 2, version: 1, status: 'approved' })];
  const live = deriveRequestState(versions, decisions, NOW);
  assert.equal(live.authoritative, true);

  const superseded = deriveRequestState(versions, decisions, NOW, [{ generation: 2, version: 1 }]);
  assert.equal(superseded.head?.superseded, true);
  assert.equal(superseded.authoritative, false, 'a superseded approval never authorizes');
  // A supersession pointed at a DIFFERENT version does not touch the head.
  assert.equal(deriveRequestState(versions, decisions, NOW, [{ generation: 1, version: 1 }]).authoritative, true);

  // R4 finding 1b: a REPLACED head is not actionable either — there is nothing
  // left for a human to decide on it.
  const undecided = [version({ generation: 2, version: 1 })];
  assert.equal(deriveRequestState(undecided, [], NOW).actionable, true);
  const replaced = deriveRequestState(undecided, [], NOW, [{ generation: 2, version: 1 }]);
  assert.equal(replaced.effectiveStatus, 'awaiting', 'the effective status is unchanged — only the queue is');
  assert.equal(replaced.actionable, false);
  const deferredReplaced = deriveRequestState(
    undecided,
    [decision({ generation: 2, version: 1, status: 'deferred' })],
    NOW,
    [{ generation: 2, version: 1 }],
  );
  assert.equal(deferredReplaced.actionable, false, 'a deferred head that was replaced leaves the queue too');
});

test('hitl-machine: deriveRequestState feeds planSubmission and canAuthorizeExecution unchanged', () => {
  const versions = [version({ packetHash: 'p1' })];
  const state = deriveRequestState(versions, [decision({ status: 'approved' })], NOW);
  assert.equal(canAuthorizeExecution(state.head!, NOW).authorized, true);
  // The head the projection produced is exactly what planSubmission binds on.
  const plan = planSubmission(state, {
    packetHash: 'p1',
    expectedHead: { generation: 1, version: 1, packetHash: 'p1', sealed: true },
  });
  assert.deepEqual(plan, { kind: 'open-generation', generation: 2, version: 1 });
});

// The store takes the per-group advisory lock and the decisions trigger takes
// it again inside the same transaction; they MUST compute the same id or the
// serialization guarantee silently disappears. The mask is also the resulting
// lock id whenever hashtext() returns 0, so it must not equal a schema
// migration key (8135318 hitl / 8135319 roster_ops).
test('HITL_GROUP_LOCK_MASK matches the SQL trigger literal and avoids the migration keys', () => {
  const sql = readFileSync(
    new URL('../data/ops/schema/hitl/002_state_machine.sql', import.meta.url),
    'utf8',
  );
  const m = sql.match(/pg_advisory_xact_lock\(hashtext\(req\.request_key\) # (\d+)\)/);
  assert.ok(m, 'trigger must take the per-group advisory lock');
  assert.equal(Number(m![1]), HITL_GROUP_LOCK_MASK);
  assert.notEqual(HITL_GROUP_LOCK_MASK, 8135318);
  assert.notEqual(HITL_GROUP_LOCK_MASK, 8135319);
  assert.ok(HITL_GROUP_LOCK_MASK > 0 && HITL_GROUP_LOCK_MASK < 2 ** 31 - 1);
});
