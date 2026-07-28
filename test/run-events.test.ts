import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  RUN_EVENT_KINDS,
  RUN_EVENT_SOURCES,
  RUN_EVENT_KIND_RULES,
  assertGenericEventKind,
  canonicalRunEventId,
  correlationColumn,
  dedupRunEvents,
  dedupeKeyFor,
  isRunEventKind,
  isRunEventSource,
  promotesExternalSuccess,
  promotesLifecycle,
  resolveRunObservations,
  runEventStableHash,
  sealRunEvent,
  type RunEventDraft,
  type RunEventKind,
  type RunEventSource,
} from '../src/lib/persistence/run-events.ts';
import { computeRecordId, type RunEventEnvelope } from '../src/lib/persistence/contracts.ts';
import { ConflictError, InvalidRecordError } from '../src/lib/persistence/contracts.ts';

// #323 section B: the pure run-event model — closed kind set, source trust
// taxonomy, per-kind dedupe/authority rules, deterministic id + a payload hash
// that covers the stable caller-semantic fields and EXCLUDES store observations.

const WS = randomUUID();

// ---------------- closed sets ----------------

test('run-events: RUN_EVENT_KINDS is the closed set and isRunEventKind gates it', () => {
  assert.deepEqual(
    [...RUN_EVENT_KINDS],
    ['run-start', 'run-end', 'tool-call', 'tool-result', 'error', 'retry', 'resumed', 'approval-ref', 'report', 'artifact-declared'],
  );
  assert.deepEqual([...RUN_EVENT_SOURCES], ['host-attested', 'cli', 'agent', 'unverified']);
  for (const k of RUN_EVENT_KINDS) assert.ok(isRunEventKind(k));
  for (const bad of ['step', 'RUN-START', '', 'tool', null, 42]) assert.equal(isRunEventKind(bad), false);
});

// ---------------- dedupe keys ----------------

test('run-events: singleton kinds carry fixed dedupe keys; repeatable kinds require a correlation id', () => {
  assert.equal(dedupeKeyFor('run-start'), 'start');
  assert.equal(dedupeKeyFor('run-end'), 'end');
  assert.equal(dedupeKeyFor('report'), 'report');

  // singleton + correlation id is a contradiction
  assert.throws(() => dedupeKeyFor('run-start', 'c1'), InvalidRecordError);

  // every repeatable kind needs a correlation id, and uses it verbatim
  for (const kind of RUN_EVENT_KINDS.filter((k) => !RUN_EVENT_KIND_RULES[k].singleton)) {
    assert.equal(dedupeKeyFor(kind, 'corr-9'), 'corr-9');
    assert.throws(() => dedupeKeyFor(kind), InvalidRecordError, `${kind} must require a correlation id`);
    assert.throws(() => dedupeKeyFor(kind, ''), InvalidRecordError);
    assert.throws(() => dedupeKeyFor(kind, null), InvalidRecordError);
  }
});

test('run-events: generic `run event` verb authority — lifecycle + tool-* + dedicated-verb kinds are NOT generic', () => {
  const generic = RUN_EVENT_KINDS.filter((k) => RUN_EVENT_KIND_RULES[k].viaGenericEvent);
  const notGeneric = RUN_EVENT_KINDS.filter((k) => !RUN_EVENT_KIND_RULES[k].viaGenericEvent);
  assert.deepEqual([...generic].sort(), ['approval-ref', 'error', 'resumed', 'retry']);
  for (const k of ['run-start', 'run-end', 'tool-call', 'tool-result', 'report', 'artifact-declared'] as const) {
    assert.ok(notGeneric.includes(k), `${k} must not be emittable via the generic event verb`);
  }
});

test('run-events: assertGenericEventKind refuses lifecycle / tool-result / dedicated kinds, allows the generic set', () => {
  for (const k of ['run-start', 'run-end', 'tool-call', 'tool-result', 'report', 'artifact-declared'] as const) {
    assert.throws(() => assertGenericEventKind(k), InvalidRecordError, `${k} must be refused via the generic verb`);
  }
  for (const k of ['error', 'retry', 'resumed', 'approval-ref'] as const) {
    assert.doesNotThrow(() => assertGenericEventKind(k));
  }
});

test('run-events: source taxonomy + correlation column helpers', () => {
  for (const s of RUN_EVENT_SOURCES) assert.ok(isRunEventSource(s));
  for (const bad of ['host', 'HOST-ATTESTED', '', null, 7]) assert.equal(isRunEventSource(bad), false);
  // correlation_id column: the dedupe key for repeatable kinds, null for singletons.
  assert.equal(correlationColumn('tool-call', 'c-1'), 'c-1');
  assert.equal(correlationColumn('run-start', 'start'), null);
  assert.equal(correlationColumn('report', 'report'), null);
});

test('run-events: resolveRunObservations DERIVES source from the write path (kind), never from the caller', () => {
  const ctx = { now: 5000, pid: '4242' };
  // Lifecycle + generic events written through the store are the trusted 'cli'
  // level; the caller has no `source` field to forge (finding: runtime writers
  // can forge trust).
  const start = resolveRunObservations('run-start', null, {}, ctx);
  assert.equal(start.source, 'cli', 'a run-start is stamped cli by the write path');
  assert.equal(start.pid, '4242');
  assert.equal(start.startedAt, 5000, 'run-start stamps started_at from the write clock');
  assert.equal(start.endedAt, null);
  assert.equal(start.sanitizedReport, null);

  const end = resolveRunObservations('run-end', null, {}, ctx);
  assert.equal(end.source, 'cli', 'a run-end is stamped cli');
  assert.equal(end.endedAt, 5000, 'run-end stamps ended_at');

  assert.equal(resolveRunObservations('error', null, {}, ctx).source, 'cli', 'a generic event is cli');

  // ONLY a report event is agent-authored (unverified prose).
  const report = resolveRunObservations('report', 'sk-secretVALUE0123456789abcdef done', {}, ctx);
  assert.equal(report.source, 'agent', 'a report is stamped agent (unverified prose)');
  assert.ok(report.sanitizedReport !== null);
  assert.ok(!report.sanitizedReport.includes('sk-secretVALUE0123456789abcdef'), 'report prose is sanitized');

  // No #323 path produces host-attested — it is derived, never one of the values
  // any kind maps to.
  for (const kind of ['run-start', 'run-end', 'error', 'report', 'tool-call'] as const) {
    assert.notEqual(resolveRunObservations(kind, null, {}, ctx).source, 'host-attested');
  }

  // a non-report kind never carries a sanitized_report (no prose to project)
  assert.equal(resolveRunObservations('error', 'sk-abc0123456789abcdef0123', {}, ctx).sanitizedReport, null);
});

// ---------------- source trust taxonomy ----------------

test('run-events: only cli|host-attested promote a lifecycle fact; only host-attested promotes external success', () => {
  const expectLifecycle: Record<RunEventSource, boolean> = {
    'host-attested': true,
    cli: true,
    agent: false,
    unverified: false,
  };
  const expectExternal: Record<RunEventSource, boolean> = {
    'host-attested': true,
    cli: false,
    agent: false,
    unverified: false,
  };
  for (const s of RUN_EVENT_SOURCES) {
    assert.equal(promotesLifecycle(s), expectLifecycle[s], `lifecycle(${s})`);
    assert.equal(promotesExternalSuccess(s), expectExternal[s], `external(${s})`);
  }
});

// ---------------- deterministic id + hash ----------------

function draft(overrides: Partial<RunEventDraft> = {}): RunEventDraft {
  return { runId: 'run-1', kind: 'run-start', data: null, ...overrides };
}

test('run-events: sealing is deterministic — same draft yields the same id + hash (idempotent replay)', () => {
  const a = sealRunEvent(WS, draft({ agent: 'sdr', data: { n: 1 } }));
  const b = sealRunEvent(WS, draft({ agent: 'sdr', data: { n: 1 } }));
  assert.equal(a.id, b.id);
  assert.equal(a.payloadHash, b.payloadHash);
  assert.equal(a.dedupeKey, 'start');
});

test('run-events: id identity is (kind, runId, dedupeKey) — a tool-call and tool-result sharing a correlation id do NOT collide', () => {
  const call = sealRunEvent(WS, draft({ kind: 'tool-call', correlationId: 'c-1', data: { tool: 'x' } }));
  const result = sealRunEvent(WS, draft({ kind: 'tool-result', correlationId: 'c-1', data: { ok: true } }));
  assert.notEqual(call.id, result.id, 'kind is part of the identity');
  assert.equal(call.dedupeKey, 'c-1');
  assert.equal(result.dedupeKey, 'c-1');
});

test('run-events: the hash covers stable semantic fields — a changed agent keeps the id but changes the hash (a ConflictError condition)', () => {
  const base = sealRunEvent(WS, draft({ agent: 'sdr' }));
  const changedAgent = sealRunEvent(WS, draft({ agent: 'chief-of-staff' }));
  // agent is NOT part of the identity, so the id is the same; but it IS in the
  // payload hash, so the hash differs — same id + different hash is the conflict.
  assert.equal(base.id, changedAgent.id);
  assert.notEqual(base.payloadHash, changedAgent.payloadHash);

  // every other stable field also participates in the hash
  for (const [field, value] of [
    ['data', { changed: true }],
    ['skill', 'draft-outreach'],
    ['trigger', '0 9 * * *'],
    ['parentRunId', 'parent-1'],
    ['originTaskId', 'ROS-99'],
  ] as const) {
    const changed = sealRunEvent(WS, draft({ agent: 'sdr', [field]: value } as Partial<RunEventDraft>));
    assert.notEqual(base.payloadHash, changed.payloadHash, `${field} must be in the payload hash`);
  }
});

test('run-events: store observations are NOT in the canonical payload — a retry with new pid/timestamps replays clean', () => {
  const sealed = sealRunEvent(WS, draft({ agent: 'sdr', skill: 's', trigger: 't', parentRunId: 'p', originTaskId: 'o', data: { a: 1 } }));
  const keys = Object.keys(JSON.parse(sealed.canonical) as Record<string, unknown>).sort();
  assert.deepEqual(keys, ['agent', 'data', 'dedupeKey', 'kind', 'originTaskId', 'parentRunId', 'runId', 'skill', 'trigger']);
  for (const observation of ['source', 'host', 'pid', 'started_at', 'ended_at', 'startedAt', 'endedAt', 'seq', 'object_version_id', 'objectVersionId']) {
    assert.ok(!sealed.canonical.includes(`"${observation}"`), `${observation} must not appear in the canonical payload`);
  }
  // pid/timestamps are not draft fields at all, so a "retry" is byte-identical.
  const retry = sealRunEvent(WS, draft({ agent: 'sdr', skill: 's', trigger: 't', parentRunId: 'p', originTaskId: 'o', data: { a: 1 } }));
  assert.equal(sealed.id, retry.id);
  assert.equal(sealed.payloadHash, retry.payloadHash);
});

// ---------------- identifier validation ----------------

test('run-events: run_id and agent are strictly validated at write time (safe projection charset)', () => {
  // unsafe run_id (spaces / secret-shaped) is rejected before any store write
  assert.throws(() => sealRunEvent(WS, draft({ runId: 'evil run SECRET' })), InvalidRecordError);
  assert.throws(() => sealRunEvent(WS, draft({ runId: '' })), InvalidRecordError);
  assert.throws(() => sealRunEvent(WS, draft({ runId: 'x'.repeat(129) })), InvalidRecordError);
  // unsafe agent likewise
  assert.throws(() => sealRunEvent(WS, draft({ agent: 'a b' })), InvalidRecordError);
  // safe values pass; a null agent is allowed
  assert.doesNotThrow(() => sealRunEvent(WS, draft({ runId: 'run.1:step-2', agent: 'sdr' })));
  assert.equal(sealRunEvent(WS, draft({ agent: null })).agent, null);
});

test('run-events: data is required (null for none); undefined refuses; an unknown kind refuses', () => {
  assert.throws(() => sealRunEvent(WS, { runId: 'r', kind: 'run-start', data: undefined }), InvalidRecordError);
  assert.doesNotThrow(() => sealRunEvent(WS, { runId: 'r', kind: 'run-start', data: null }));
  assert.throws(() => sealRunEvent(WS, { runId: 'r', kind: 'nope' as RunEventKind, data: null }), InvalidRecordError);
});

test('run-events: non-projected identifier fields accept a cron trigger but enforce a length cap', () => {
  assert.doesNotThrow(() => sealRunEvent(WS, draft({ trigger: '*/5 * * * *', skill: 'a/b:c' })));
  assert.throws(() => sealRunEvent(WS, draft({ skill: 'x'.repeat(513) })), InvalidRecordError);
});

// ── finding 6: v1↔v2 identity reconciliation (canonical id + dedup) ────────────

const WS6 = '44444444-4444-4444-8444-444444444444';

function envelope(over: Partial<RunEventEnvelope> & { kind: RunEventKind; runId: string; dedupeKey: string; id: string }): RunEventEnvelope {
  return {
    workspaceId: WS6,
    data: null,
    agent: null,
    skill: null,
    trigger: null,
    parentRunId: null,
    originTaskId: null,
    correlationId: null,
    source: 'unverified' as RunEventSource,
    pid: null,
    startedAt: null,
    endedAt: null,
    sanitizedReport: null,
    createdAt: 1,
    seq: 1,
    queued: false,
    ...over,
  };
}

test('canonicalRunEventId: a v1 record and its v2 retry map to the same canonical id', () => {
  // v1 STORED id used the literal kind:'run-event'; v2 uses the event kind.
  const v1StoredId = computeRecordId(WS6, 'runs', { kind: 'run-event', runId: 'r', dedupeKey: 'start' });
  const v2StoredId = computeRecordId(WS6, 'runs', { kind: 'run-start', runId: 'r', dedupeKey: 'start' });
  assert.notEqual(v1StoredId, v2StoredId, 'the STORED ids differ across the schema change');
  // Recomputing the canonical id from the normalized {kind,runId,dedupeKey}
  // collapses both onto the v2 id.
  const canon = canonicalRunEventId(WS6, { kind: 'run-start', runId: 'r', dedupeKey: 'start' });
  assert.equal(canon, v2StoredId);
});

test('dedupRunEvents: collapses a v1 record + its v2 retry, keeping the trusted one; leaves distinct events', () => {
  const v1 = envelope({ id: 'v1-id', kind: 'run-start', runId: 'r', dedupeKey: 'start', source: 'unverified', seq: 1 });
  const v2 = envelope({ id: 'v2-id', kind: 'run-start', runId: 'r', dedupeKey: 'start', source: 'cli', seq: 2 });
  const other = envelope({ id: 'end-id', kind: 'run-end', runId: 'r', dedupeKey: 'end', source: 'cli', seq: 3 });
  const out = dedupRunEvents(WS6, [v1, v2, other]);
  assert.equal(out.length, 2, 'the v1/v2 run-start pair collapses; run-end is distinct');
  const start = out.find((e) => e.kind === 'run-start')!;
  assert.equal(start.source, 'cli', 'the trusted v2 retry supersedes the v1 unverified row');
  assert.ok(out.some((e) => e.kind === 'run-end'));
});

// ── round-5 finding 4: same canonical id, DIFFERENT stable payload → ConflictError ──

test('runEventStableHash: excludes store observations — pid/source/seq/timestamps do not change the hash', () => {
  const a = envelope({ id: 'a', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'x' }, source: 'unverified', pid: '1', seq: 1, startedAt: 10 });
  const b = envelope({ id: 'b', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'x' }, source: 'cli', pid: '999', seq: 7, startedAt: 20 });
  assert.equal(runEventStableHash(a), runEventStableHash(b), 'only stable semantic fields count');
  const c = envelope({ id: 'c', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'y' }, source: 'cli' });
  assert.notEqual(runEventStableHash(a), runEventStableHash(c), 'a changed data field changes the hash');
});

test('dedupRunEvents: same canonical id with DIFFERENT stable payloads raises ConflictError (Rev4 R3-4)', () => {
  // v1 stored {phase:old}; a post-upgrade v2 replay carries {phase:new}. Same
  // canonical id (run-start/r/start), different stable hash → a genuine conflict.
  const v1 = envelope({ id: 'v1-id', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'old' }, source: 'unverified', seq: 1 });
  const v2 = envelope({ id: 'v2-id', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'new' }, source: 'cli', seq: 2 });
  assert.throws(() => dedupRunEvents(WS6, [v1, v2]), ConflictError);
});

test('dedupRunEvents: same canonical id with IDENTICAL stable payloads dedups (round-2 finding 6 stays fixed)', () => {
  const v1 = envelope({ id: 'v1-id', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'same' }, source: 'unverified', seq: 1 });
  const v2 = envelope({ id: 'v2-id', kind: 'run-start', runId: 'r', dedupeKey: 'start', data: { phase: 'same' }, source: 'cli', seq: 2 });
  const out = dedupRunEvents(WS6, [v1, v2]);
  assert.equal(out.length, 1, 'an identical-payload retry dedups to one event');
  assert.equal(out[0]!.source, 'cli', 'the trusted retry is kept');
});
