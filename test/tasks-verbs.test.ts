// ROS-151 — task verbs + collapse mechanism. Pure/mocked: a FakeAdapter stands in
// for Notion, and contexts are built directly from status maps (no disk/network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignedScope,
  buildMaps,
  deriveCurrentState,
  isStop,
  planVerb,
  readyScope,
  resolveSelector,
  type TaskContext,
} from '../src/lib/tasks/context.ts';
import { applyVerb, composeDigest, composeReport } from '../src/commands/task.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { CanonicalState } from '../src/lib/tasks/machine.ts';
import type {
  AssignedScope,
  ReadyScope,
  StatusSchema,
  Task,
  TaskIdentity,
  TaskSummary,
  TrackerAdapter,
} from '../src/lib/tasks/adapters/types.ts';
import type { TrackerConfig } from '../src/lib/tasks/tracker-schema.ts';

const SELF: TaskIdentity = { id: 'u1', name: 'Me' };

const FULL: Record<string, string> = {
  ready: 'Ready',
  claimed: 'Claimed',
  active: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};
const MINIMAL: Record<string, string> = { ready: 'To do', active: 'Doing', done: 'Done' };

class FakeAdapter implements TrackerAdapter {
  tasks = new Map<string, Task>();
  statusCalls: Array<{ id: string; name: string }> = [];
  assigneeCalls: Array<{ id: string; userId: string }> = [];
  comments: Array<{ id: string; text: string }> = [];
  ready: TaskSummary[] = [];
  assigned: TaskSummary[] = [];

  add(t: Task): Task {
    this.tasks.set(t.id, t);
    return t;
  }
  async self(): Promise<TaskIdentity> {
    return SELF;
  }
  async listReady(_scope: ReadyScope): Promise<TaskSummary[]> {
    return this.ready;
  }
  async listAssigned(_scope: AssignedScope): Promise<TaskSummary[]> {
    return this.assigned;
  }
  async getTask(handle: string): Promise<Task> {
    for (const t of this.tasks.values()) {
      if (t.id === handle || t.handle === handle) return t;
    }
    throw new RosterError({ header: 'not found', body: '', remedy: '', exitCode: 1 });
  }
  async setStatus(id: string, name: string): Promise<void> {
    this.statusCalls.push({ id, name });
    const t = this.tasks.get(id);
    if (t) t.status = name;
  }
  async setAssignee(id: string, userId: string): Promise<void> {
    this.assigneeCalls.push({ id, userId });
    const t = this.tasks.get(id);
    if (t) t.assigneeIds = [userId];
  }
  async comment(id: string, text: string): Promise<void> {
    this.comments.push({ id, text });
  }
  async introspectStatuses(): Promise<StatusSchema> {
    return { statuses: [], hasUniqueId: false };
  }
}

function makeCtx(statusMap: Record<string, string>, adapter: TrackerAdapter): TaskContext {
  const config = {
    version: 1,
    tracker: 'notion',
    data_source_id: 'ds',
    status_property: 'Status',
    assignee_property: 'Assignee',
    unique_id_property: 'Task ID',
    unique_id_prefix: 'TASK',
    status_map: statusMap,
  } as unknown as TrackerConfig;
  const { forward, reverse } = buildMaps(config);
  return { config, adapter, self: SELF, forward, reverse };
}

function task(over: Partial<Task> & { id: string; status: string }): Task {
  return {
    handle: over.handle ?? over.id,
    title: over.title ?? 'A task',
    assigneeIds: over.assigneeIds ?? [],
    ...over,
  };
}

// ── buildMaps ────────────────────────────────────────────────────────────────

test('buildMaps rejects a status backing two canonical states', () => {
  assert.throws(
    () => buildMaps({ status_map: { ready: 'X', active: 'Y', done: 'X' } } as unknown as TrackerConfig),
    (e: unknown) => e instanceof RosterError && /two states/.test((e as RosterError).header),
  );
});

// ── isStop ───────────────────────────────────────────────────────────────────

test('isStop: required + claimed always stop; unmapped optionals do not', () => {
  const full = makeCtx(FULL, new FakeAdapter());
  const min = makeCtx(MINIMAL, new FakeAdapter());
  for (const s of ['ready', 'active', 'done', 'claimed'] as CanonicalState[]) {
    assert.equal(isStop(full, s), true);
    assert.equal(isStop(min, s), true, `${s} should be a stop even minimal`);
  }
  assert.equal(isStop(full, 'review'), true);
  assert.equal(isStop(min, 'review'), false);
  assert.equal(isStop(min, 'blocked'), false);
  assert.equal(isStop(min, 'cancelled'), false);
});

// ── scopes carry the project filter ──────────────────────────────────────────

test('readyScope/assignedScope carry a configured project filter (never silently dropped)', () => {
  const a = new FakeAdapter();
  const config = {
    version: 1,
    tracker: 'notion',
    data_source_id: 'ds',
    status_property: 'Status',
    assignee_property: 'Assignee',
    project_property: 'Project',
    project_filter: ['Alpha'],
    status_map: MINIMAL,
  } as unknown as TrackerConfig;
  const { forward, reverse } = buildMaps(config);
  const ctx: TaskContext = { config, adapter: a, self: SELF, forward, reverse };
  assert.deepEqual(readyScope(ctx).projectValues, ['Alpha']);
  assert.deepEqual(assignedScope(ctx).projectValues, ['Alpha']);
});

// ── deriveCurrentState (self-relative overlay) ───────────────────────────────

test('overlay: assigned-to-me Ready reads as claimed only when claimed unmapped', () => {
  const min = makeCtx(MINIMAL, new FakeAdapter());
  assert.equal(deriveCurrentState(min, task({ id: 't', status: 'To do', assigneeIds: ['u1'] })), 'claimed');
  assert.equal(deriveCurrentState(min, task({ id: 't', status: 'To do', assigneeIds: ['u2'] })), 'ready');
  assert.equal(deriveCurrentState(min, task({ id: 't', status: 'To do', assigneeIds: [] })), 'ready');

  const full = makeCtx(FULL, new FakeAdapter());
  // claimed is mapped → no overlay; an assigned Ready-status task stays ready.
  assert.equal(deriveCurrentState(full, task({ id: 't', status: 'Ready', assigneeIds: ['u1'] })), 'ready');
});

test('deriveCurrentState throws on an unmapped status', () => {
  const min = makeCtx(MINIMAL, new FakeAdapter());
  assert.throws(
    () => deriveCurrentState(min, task({ id: 't', status: 'Weird', assigneeIds: [] })),
    (e: unknown) => e instanceof RosterError && /unmapped status/.test((e as RosterError).header),
  );
});

// ── planVerb (collapse) ──────────────────────────────────────────────────────

test('planVerb full board: submit→review move, done→done move, done-from-active illegal', () => {
  const full = makeCtx(FULL, new FakeAdapter());
  assert.deepEqual(planVerb(full, 'active', 'submit'), { kind: 'move', to: 'review', statusName: 'In review' });
  assert.deepEqual(planVerb(full, 'review', 'done'), { kind: 'move', to: 'done', statusName: 'Done' });
  assert.equal(planVerb(full, 'active', 'done').kind, 'illegal'); // review mapped → must submit first
});

test('planVerb minimal board: submit passthrough, done bridges through review', () => {
  const min = makeCtx(MINIMAL, new FakeAdapter());
  assert.deepEqual(planVerb(min, 'active', 'submit'), { kind: 'passthrough', state: 'review' });
  assert.deepEqual(planVerb(min, 'active', 'done'), { kind: 'bridge', to: 'done', statusName: 'Done', through: 'review' });
  assert.equal(planVerb(min, 'claimed', 'done').kind, 'illegal'); // can't reach done from claimed
});

test('planVerb: cancel/block collapse to passthrough when unmapped', () => {
  const min = makeCtx(MINIMAL, new FakeAdapter());
  assert.deepEqual(planVerb(min, 'active', 'cancel'), { kind: 'passthrough', state: 'cancelled' });
  assert.deepEqual(planVerb(min, 'active', 'block'), { kind: 'passthrough', state: 'blocked' });
  const full = makeCtx(FULL, new FakeAdapter());
  assert.deepEqual(planVerb(full, 'active', 'cancel'), { kind: 'move', to: 'cancelled', statusName: 'Cancelled' });
});

test('planVerb: idempotent no-op and illegal with allowed events', () => {
  const full = makeCtx(FULL, new FakeAdapter());
  assert.deepEqual(planVerb(full, 'active', 'start'), { kind: 'noop', state: 'active' });
  const illegal = planVerb(full, 'ready', 'start');
  assert.equal(illegal.kind, 'illegal');
  if (illegal.kind === 'illegal') assert.deepEqual(illegal.allowed, ['claim']);
});

// ── resolveSelector ──────────────────────────────────────────────────────────

test('resolveSelector: direct unique-id and page-id hit getTask', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(FULL, a);
  a.add(task({ id: 'p1', handle: 'TASK-5', status: 'Ready', title: 'Wire the widget' }));
  a.add(task({ id: 'a'.repeat(32), status: 'Ready', title: 'By page id' }));
  assert.equal((await resolveSelector(ctx, 'TASK-5')).id, 'p1');
  assert.equal((await resolveSelector(ctx, 'a'.repeat(32))).handle, 'a'.repeat(32));
});

test('resolveSelector: a mismatched unique-id prefix falls back to fuzzy (never cross-matches by number)', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(FULL, a);
  a.add(task({ id: 'p1', handle: 'TASK-151', status: 'Ready', title: 'the real one' }));
  assert.equal((await resolveSelector(ctx, 'TASK-151')).id, 'p1'); // matching prefix → direct
  // ROS-151 must NOT resolve to TASK-151; it goes fuzzy and (empty pool) reports not-found.
  await assert.rejects(resolveSelector(ctx, 'ROS-151'), (e: unknown) => e instanceof RosterError && /no task matches/.test((e as RosterError).header));
});

test('composeReport: assigned-to-me Ready surfaces under in-flight (claimed on a minimal board)', () => {
  const ctx = makeCtx(MINIMAL, new FakeAdapter());
  const ready: TaskSummary[] = [
    { id: 'a', handle: 'T-1', title: 'pool one', status: 'To do', assigneeIds: [] },
    { id: 'b', handle: 'T-2', title: 'mine ready', status: 'To do', assigneeIds: ['u1'] },
  ];
  const mine: TaskSummary[] = [{ id: 'c', handle: 'T-3', title: 'my active', status: 'Doing', assigneeIds: ['u1'] }];
  const { pool, inFlight } = composeReport(ctx, ready, mine);
  assert.deepEqual(pool.map((r) => r.handle), ['T-1']);
  const flight = new Map(inFlight.map((r) => [r.handle, r.canonical]));
  assert.equal(inFlight.length, 2);
  assert.equal(flight.get('T-2'), 'claimed'); // overlay: assigned Ready = mine
  assert.equal(flight.get('T-3'), 'active');
});

// ── composeDigest (ROS-152) ──────────────────────────────────────────────────

test('composeDigest: full board — total partition by stage, attention = assigned/claimed/blocked', () => {
  const ctx = makeCtx(FULL, new FakeAdapter());
  const ready: TaskSummary[] = [
    { id: 'a', handle: 'T-1', title: 'pool one', status: 'Ready', assigneeIds: [] },
    { id: 'b', handle: 'T-2', title: 'assigned ready', status: 'Ready', assigneeIds: ['u1'] },
  ];
  const mine: TaskSummary[] = [
    { id: 'c', handle: 'T-3', title: 'claimed', status: 'Claimed', assigneeIds: ['u1'] },
    { id: 'd', handle: 'T-4', title: 'doing', status: 'In progress', assigneeIds: ['u1'] },
    { id: 'e', handle: 'T-5', title: 'stuck', status: 'Blocked', assigneeIds: ['u1'] },
    { id: 'f', handle: 'T-6', title: 'in review', status: 'In review', assigneeIds: ['u1'] },
  ];
  const d = composeDigest(ctx, ready, mine);
  assert.deepEqual(d.pool.map((r) => r.handle), ['T-1']);
  // T-2 derives canonical `ready` (claimed is mapped, so no overlay) but is mine —
  // it buckets under claimed/assigned so the partition stays total.
  assert.deepEqual(d.groups.claimed.map((r) => r.handle), ['T-2', 'T-3']);
  assert.equal(d.groups.claimed[0]!.canonical, 'ready');
  assert.deepEqual(d.groups.active.map((r) => r.handle), ['T-4']);
  assert.deepEqual(d.groups.blocked.map((r) => r.handle), ['T-5']);
  assert.deepEqual(d.groups.review.map((r) => r.handle), ['T-6']);
  const grouped = Object.values(d.groups).reduce((n, g) => n + g.length, 0);
  assert.equal(grouped, d.inFlight.length); // partition totality
  assert.deepEqual(
    d.attention.map((r) => [r.handle, r.why]),
    [
      ['T-2', 'assigned to you — not claimed'],
      ['T-3', 'claimed — not started'],
      ['T-5', 'blocked — see board comments'],
    ],
  );
});

test('composeDigest: minimal board — assigned-Ready overlays to claimed and lands in attention', () => {
  const ctx = makeCtx(MINIMAL, new FakeAdapter());
  const ready: TaskSummary[] = [
    { id: 'a', handle: 'T-1', title: 'pool', status: 'To do', assigneeIds: [] },
    { id: 'b', handle: 'T-2', title: 'mine', status: 'To do', assigneeIds: ['u1'] },
  ];
  const mine: TaskSummary[] = [{ id: 'c', handle: 'T-3', title: 'doing', status: 'Doing', assigneeIds: ['u1'] }];
  const d = composeDigest(ctx, ready, mine);
  assert.deepEqual(d.groups.claimed.map((r) => [r.handle, r.canonical]), [['T-2', 'claimed']]);
  assert.deepEqual(d.groups.active.map((r) => r.handle), ['T-3']);
  assert.deepEqual(d.groups.blocked, []);
  assert.deepEqual(d.attention.map((r) => [r.handle, r.why]), [['T-2', 'claimed — not started']]);
});

test('composeDigest: empty board — every section empty, no attention', () => {
  const d = composeDigest(makeCtx(FULL, new FakeAdapter()), [], []);
  assert.deepEqual(d, { pool: [], inFlight: [], groups: { claimed: [], active: [], blocked: [], review: [] }, attention: [] });
});

test('composeDigest: dedup — a task in both ready(assigned) and mine appears once', () => {
  const ctx = makeCtx(MINIMAL, new FakeAdapter());
  const row: TaskSummary = { id: 'x', handle: 'T-9', title: 'dup', status: 'To do', assigneeIds: ['u1'] };
  const d = composeDigest(ctx, [row], [row]);
  assert.equal(d.inFlight.length, 1);
  assert.deepEqual(d.groups.claimed.map((r) => r.handle), ['T-9']);
});

test('composeReport row shape is the stable flat API (ROS-151 pin)', () => {
  const ctx = makeCtx(MINIMAL, new FakeAdapter());
  const { pool, inFlight } = composeReport(
    ctx,
    [{ id: 'a', handle: 'T-1', title: 'pool one', status: 'To do', assigneeIds: [] }],
    [{ id: 'c', handle: 'T-3', title: 'my active', status: 'Doing', assigneeIds: ['u1'] }],
  );
  assert.deepEqual(pool, [{ handle: 'T-1', title: 'pool one', status: 'To do', canonical: 'ready' }]);
  assert.deepEqual(inFlight, [{ handle: 'T-3', title: 'my active', status: 'Doing', canonical: 'active' }]);
});

test('resolveSelector: fuzzy title unique / ambiguous / not-found', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(FULL, a);
  a.ready = [
    { id: 'p1', handle: 'TASK-1', title: 'Wire the widget', status: 'Ready', assigneeIds: [] },
    { id: 'p2', handle: 'TASK-2', title: 'Paint the fence', status: 'Ready', assigneeIds: [] },
  ];
  a.assigned = [{ id: 'p3', handle: 'TASK-3', title: 'Wire the harness', status: 'In progress', assigneeIds: ['u1'] }];
  assert.equal((await resolveSelector(ctx, 'fence')).id, 'p2');
  await assert.rejects(resolveSelector(ctx, 'wire'), (e: unknown) => e instanceof RosterError && /ambiguous/.test((e as RosterError).header));
  await assert.rejects(resolveSelector(ctx, 'zzz'), (e: unknown) => e instanceof RosterError && /no task matches/.test((e as RosterError).header));
});

// ── applyVerb side effects ───────────────────────────────────────────────────

test('claim: full board self-assigns + sets claimed status', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(FULL, a);
  const t = a.add(task({ id: 'p', handle: 'TASK-9', status: 'Ready', assigneeIds: [] }));
  const out = await applyVerb(ctx, 'claim', t, 'ready', undefined);
  assert.equal(out.to, 'claimed');
  assert.equal(out.changed, true);
  assert.deepEqual(a.assigneeCalls, [{ id: 'p', userId: 'u1' }]);
  assert.deepEqual(a.statusCalls, [{ id: 'p', name: 'Claimed' }]);
});

test('claim: minimal board self-assigns only (claimed unmapped)', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(MINIMAL, a);
  const t = a.add(task({ id: 'p', status: 'To do', assigneeIds: [] }));
  const out = await applyVerb(ctx, 'claim', t, 'ready', undefined);
  assert.equal(out.to, 'claimed');
  assert.deepEqual(a.assigneeCalls, [{ id: 'p', userId: 'u1' }]);
  assert.deepEqual(a.statusCalls, []);
});

test('claim: already mine is a no-op; other-assigned is a reassign', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(FULL, a);
  const mine = a.add(task({ id: 'm', status: 'Claimed', assigneeIds: ['u1'] }));
  const out1 = await applyVerb(ctx, 'claim', mine, deriveCurrentState(ctx, mine), undefined);
  assert.equal(out1.changed, false);
  assert.match(out1.note ?? '', /already claimed by you/);
  assert.deepEqual(a.assigneeCalls, []);

  const theirs = a.add(task({ id: 'o', status: 'Ready', assigneeIds: ['u2'] }));
  const out2 = await applyVerb(ctx, 'claim', theirs, deriveCurrentState(ctx, theirs), undefined);
  assert.equal(out2.changed, true);
  assert.match(out2.effects.join(','), /reassigned to you/);
  assert.deepEqual(a.assigneeCalls, [{ id: 'o', userId: 'u1' }]);
});

test('block: full board sets blocked + posts comment; minimal posts comment only', async () => {
  const full = new FakeAdapter();
  const fctx = makeCtx(FULL, full);
  const t1 = full.add(task({ id: 'b', status: 'In progress', assigneeIds: ['u1'] }));
  const o1 = await applyVerb(fctx, 'block', t1, 'active', 'waiting on keys');
  assert.deepEqual(full.statusCalls, [{ id: 'b', name: 'Blocked' }]);
  assert.deepEqual(full.comments, [{ id: 'b', text: '🚧 Blocked: waiting on keys' }]);
  assert.equal(o1.to, 'blocked');

  const min = new FakeAdapter();
  const mctx = makeCtx(MINIMAL, min);
  const t2 = min.add(task({ id: 'b2', status: 'Doing', assigneeIds: ['u1'] }));
  const o2 = await applyVerb(mctx, 'block', t2, 'active', 'waiting');
  assert.deepEqual(min.statusCalls, []);
  assert.deepEqual(min.comments, [{ id: 'b2', text: '🚧 Blocked: waiting' }]);
  assert.match(o2.note ?? '', /no 'blocked' stage/);
});

test('block on an already-blocked task posts the comment, no status write, correct note', async () => {
  const a = new FakeAdapter();
  const ctx = makeCtx(FULL, a);
  const t = a.add(task({ id: 'b', status: 'Blocked', assigneeIds: ['u1'] }));
  const out = await applyVerb(ctx, 'block', t, 'blocked', 'still waiting');
  assert.deepEqual(a.statusCalls, []); // already blocked — no status change
  assert.deepEqual(a.comments, [{ id: 'b', text: '🚧 Blocked: still waiting' }]);
  assert.equal(out.to, 'blocked');
  assert.equal(out.note, undefined); // not the "no 'blocked' stage" note
});

test('start/submit/done happy path writes; done bridges on minimal board', async () => {
  const full = new FakeAdapter();
  const fctx = makeCtx(FULL, full);
  const t = full.add(task({ id: 'x', status: 'Claimed', assigneeIds: ['u1'] }));
  await applyVerb(fctx, 'start', t, 'claimed', undefined);
  await applyVerb(fctx, 'submit', t, deriveCurrentState(fctx, t), undefined);
  await applyVerb(fctx, 'done', t, deriveCurrentState(fctx, t), undefined);
  assert.deepEqual(full.statusCalls.map((c) => c.name), ['In progress', 'In review', 'Done']);

  const min = new FakeAdapter();
  const mctx = makeCtx(MINIMAL, min);
  const t2 = min.add(task({ id: 'y', status: 'Doing', assigneeIds: ['u1'] }));
  const out = await applyVerb(mctx, 'done', t2, 'active', undefined);
  assert.deepEqual(min.statusCalls, [{ id: 'y', name: 'Done' }]);
  assert.equal(out.to, 'done');
  assert.match(out.effects.join(','), /skipped unmapped review/);
});

test('submit/cancel are guided no-ops on a minimal board', async () => {
  const min = new FakeAdapter();
  const ctx = makeCtx(MINIMAL, min);
  const t = min.add(task({ id: 'z', status: 'Doing', assigneeIds: ['u1'] }));
  const s = await applyVerb(ctx, 'submit', t, 'active', undefined);
  assert.equal(s.changed, false);
  assert.match(s.note ?? '', /run `roster task done`/);
  const c = await applyVerb(ctx, 'cancel', t, 'active', undefined);
  assert.equal(c.changed, false);
  assert.match(c.note ?? '', /no 'cancelled' status mapped/);
  assert.deepEqual(min.statusCalls, []);
});

test('applyVerb rejects an illegal transition with allowed events', async () => {
  const full = new FakeAdapter();
  const ctx = makeCtx(FULL, full);
  const t = full.add(task({ id: 'r', status: 'Ready', assigneeIds: [] }));
  await assert.rejects(
    applyVerb(ctx, 'start', t, 'ready', undefined),
    (e: unknown) => e instanceof RosterError && /can't start/.test((e as RosterError).header),
  );
});
