import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalOutbox,
  SpoolQuotaError,
  payloadHashOf,
  type DeliverResult,
  type ObjectTarget,
  type OutboxRecord,
  type RemoteTarget,
} from '../src/lib/persistence/outbox.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  VersionSkewError,
  WorkspaceMismatchError,
  sha256Hex,
} from '../src/lib/persistence/contracts.ts';

// #318 stage 3 section G: outbox fold correctness, backlog barrier, ordered
// idempotent replay, poison/Conflict-advance, crash-after-commit-before-ack,
// overlay union, artifact spool crash matrix (fault-injecting targets — more
// deterministic than child-process kills for network-boundary faults; the
// fs-tear boundaries are already covered by the stage-2 child-process matrix),
// object-first/index-last invariant, torn checkpoint, quotas, fail-closed
// decisions.

class MemoryObjectTarget implements ObjectTarget {
  readonly store = new Map<string, Buffer>();
  readonly puts: string[] = [];
  down = false;
  failAfterStore = false;

  async deliver(digest: string, bytes: Buffer): Promise<'stored' | 'exists'> {
    this.puts.push(digest);
    // Transport-coded so it classifies as a genuine retryable outage (a bare
    // Error is now 'unknown' and would fail closed / halt).
    if (this.down) throw Object.assign(new Error('object store down'), { code: 'ECONNREFUSED' });
    if (sha256Hex(bytes) !== digest) throw new ConflictError(digest, 'bytes do not match digest');
    if (this.store.has(digest)) return 'exists';
    this.store.set(digest, Buffer.from(bytes));
    if (this.failAfterStore) {
      this.failAfterStore = false;
      throw Object.assign(new Error('connection dropped after object store'), { code: 'ECONNRESET' });
    }
    return 'stored';
  }
}

// The stage-4 stand-in: dedups by id + payload hash like the PG delivery
// ledger. With `objects` wired it records (never throws) an invariant
// violation whenever an index record arrives before its bytes.
class MemoryRemoteTarget implements RemoteTarget {
  readonly committed = new Map<string, string>();
  readonly deliveries: string[] = [];
  readonly commits: string[] = [];
  readonly invariantViolations: string[] = [];
  down = false;
  // When set, deliver throws a KNOWN config halt (PG SQLSTATE) — surfaced, no
  // attempt consumed toward the poison cap, no backoff recorded.
  haltCode: string | null = null;
  failNextCommitBeforeAck = false;
  objects: MemoryObjectTarget | null = null;

  async deliver(record: OutboxRecord): Promise<DeliverResult> {
    this.deliveries.push(record.id);
    if (this.haltCode !== null) throw Object.assign(new Error('permission denied'), { code: this.haltCode });
    // Transport-coded: a genuine retryable outage (a bare Error is 'unknown').
    if (this.down) throw Object.assign(new Error('network down'), { code: 'ECONNREFUSED' });
    if (this.objects && record.artifact && !this.objects.store.has(record.artifact.digest)) {
      this.invariantViolations.push(record.id);
    }
    const existing = this.committed.get(record.id);
    if (existing !== undefined) {
      if (existing === record.payloadHash) return 'duplicate';
      throw new ConflictError(record.id, 'server holds this id with a different payload hash');
    }
    this.committed.set(record.id, record.payloadHash);
    this.commits.push(record.id);
    if (this.failNextCommitBeforeAck) {
      this.failNextCommitBeforeAck = false;
      throw Object.assign(new Error('connection dropped after commit, before ack'), { code: 'ECONNRESET' });
    }
    return 'committed';
  }
}

type Env = { dir: string; opsRoot: string; ws: string; clock: { t: number } };

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'roster-outbox-'));
  return { dir, opsRoot: join(dir, 'ops'), ws: randomUUID(), clock: { t: 1_000_000 } };
}

function cleanup(env: Env): void {
  rmSync(env.dir, { recursive: true, force: true });
}

type OutboxOverrides = {
  attemptCap?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitterRatio?: number;
  maxSpoolBytes?: number;
  rng?: () => number;
};

function makeOutbox(env: Env, over: OutboxOverrides = {}): LocalOutbox {
  const ledger = new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws, now: () => env.clock.t });
  return new LocalOutbox({
    ledger,
    now: () => env.clock.t,
    rng: () => 0,
    backoffBaseMs: 100,
    backoffMaxMs: 10_000,
    jitterRatio: 0,
    attemptCap: 3,
    ...over,
  });
}

function entry(id: string, n = 1) {
  return { namespace: 'runs' as const, id, kind: 'run-event', payload: { n } };
}

// ---------------- fold-state correctness ----------------

test('fold: enqueued entries appear queued in producerSeq order with producer identity', () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const a = outbox.enqueue({ namespace: 'hitl', id: 'h1', kind: 'hitl-request', payload: { p: 1 } });
    const b = outbox.enqueue({ namespace: 'hitl', id: 'h2', kind: 'hitl-request', payload: { p: 2 } });
    const c = outbox.enqueue(entry('r1'));
    assert.equal(a.outcome, 'queued');
    assert.ok(a.producerSeq < b.producerSeq && b.producerSeq < c.producerSeq);
    const fold = outbox.fold();
    const hitl = fold.namespaces.hitl!;
    assert.deepEqual(hitl.pending.map((e) => e.entryId), ['h1', 'h2']);
    assert.equal(hitl.parked, false);
    assert.equal(hitl.poisonEntryId, null);
    assert.equal(fold.namespaces.runs!.pending.length, 1);
    const e1 = fold.entries.get('h1')!;
    assert.equal(e1.status, 'queued');
    assert.equal(e1.attempts, 0);
    assert.equal(e1.payloadHash, payloadHashOf({ p: 1 }));
    assert.equal(e1.enqueuedAt, env.clock.t);
    assert.match(e1.producerId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(fold.spool, { activeBytes: 0, maxBytes: 256 * 1024 * 1024 });
  } finally {
    cleanup(env);
  }
});

test('fold: enqueue is idempotent by id+payload; different payload is a Conflict', () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const first = outbox.enqueue(entry('r1'));
    const replay = outbox.enqueue(entry('r1'));
    assert.equal(replay.producerSeq, first.producerSeq);
    assert.equal(outbox.fold().namespaces.runs!.pending.length, 1);
    assert.throws(() => outbox.enqueue({ ...entry('r1'), payload: { n: 999 } }), ConflictError);
  } finally {
    cleanup(env);
  }
});

test('fold: attempt/failed/acked events fold into per-entry state', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.down = true;
    outbox.enqueue(entry('r1'));
    await outbox.drain(target);
    let e = outbox.fold().entries.get('r1')!;
    assert.equal(e.status, 'queued');
    assert.equal(e.attempts, 1);
    assert.equal(e.lastAttemptAt, env.clock.t);
    assert.equal(e.nextRetryAt, env.clock.t + 100);
    assert.deepEqual(e.failure, { class: 'transient', kind: null, reason: 'network down' });
    target.down = false;
    env.clock.t += 100;
    await outbox.drain(target);
    e = outbox.fold().entries.get('r1')!;
    assert.equal(e.status, 'acked');
    assert.equal(e.ackResult, 'committed');
    assert.equal(e.failure, null);
    assert.equal(outbox.fold().namespaces.runs!.ackedCount, 1);
  } finally {
    cleanup(env);
  }
});

test('backoff: delay doubles per attempt and jitter comes from the injected rng', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 5, jitterRatio: 0.5, rng: () => 1 });
    const target = new MemoryRemoteTarget();
    target.down = true;
    outbox.enqueue(entry('r1'));
    await outbox.drain(target);
    assert.equal(outbox.fold().entries.get('r1')!.nextRetryAt, env.clock.t + 150);
    env.clock.t += 150;
    await outbox.drain(target);
    assert.equal(outbox.fold().entries.get('r1')!.nextRetryAt, env.clock.t + 300);
  } finally {
    cleanup(env);
  }
});

// R5 should-fix: surfaced config/unknown halts record an attempt but must NOT
// inflate the next genuine transport retry's backoff — backoff scales with
// TRANSIENT failures, not total attempts. Otherwise a namespace that saw many
// operator-fixable halts would, on its first real outage, wait minutes.
test('backoff: surfaced halts do not inflate the first transport retry delay', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 5, jitterRatio: 0, backoffBaseMs: 100 });
    const target = new MemoryRemoteTarget();
    outbox.enqueue(entry('r1'));
    // Ten surfaced config halts (PG 42501): each records an attempt, none a
    // transient failure. drain() reports the halt without parking.
    target.haltCode = '42501';
    for (let i = 0; i < 10; i++) {
      const report = await outbox.drain(target);
      assert.equal(report.namespaces.runs?.halted?.kind, 'config');
    }
    assert.equal(outbox.fold().entries.get('r1')!.attempts, 10);
    assert.equal(outbox.fold().entries.get('r1')!.transientFailures, 0);
    // Now a genuine outage: this is the FIRST transient failure, so the delay is
    // the base (100 · 2^0), not 100 · 2^10.
    target.haltCode = null;
    target.down = true;
    await outbox.drain(target);
    assert.equal(outbox.fold().entries.get('r1')!.nextRetryAt, env.clock.t + 100);
  } finally {
    cleanup(env);
  }
});

// ---------------- backlog barrier ----------------

test('barrier: with connectivity restored mid-backlog, a live write queues behind and cannot overtake', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.down = true;
    const a = await outbox.writeThrough(entry('A'), target);
    assert.equal(a.outcome, 'queued');
    // Connectivity restored — but A is still queued (in backoff). B must NOT
    // be attempted while A heads the line.
    target.down = false;
    const b = await outbox.writeThrough(entry('B', 2), target);
    assert.equal(b.outcome, 'queued');
    assert.deepEqual(target.commits, []);
    assert.deepEqual(target.deliveries, ['A']); // only A's first (failed) attempt
    // Once A's backoff elapses, the drain delivers strictly in seq order.
    env.clock.t += 100;
    const c = await outbox.writeThrough(entry('C', 3), target);
    assert.equal(c.outcome, 'committed');
    assert.deepEqual(target.commits, ['A', 'B', 'C']);
  } finally {
    cleanup(env);
  }
});

test('barrier: writeThrough on a healthy namespace commits immediately (tri-state happy path)', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    const res = await outbox.writeThrough(entry('A'), target);
    assert.deepEqual(res, { outcome: 'committed', id: 'A' });
    assert.deepEqual(target.commits, ['A']);
    assert.equal(outbox.fold().entries.get('A')!.status, 'acked');
  } finally {
    cleanup(env);
  }
});

test('barrier: a parked namespace still accepts new writes behind the poison entry', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 1 });
    const target = new MemoryRemoteTarget();
    target.down = true;
    await outbox.writeThrough(entry('A'), target);
    target.down = false;
    const b = await outbox.writeThrough(entry('B', 2), target);
    assert.equal(b.outcome, 'queued');
    const ns = outbox.fold().namespaces.runs!;
    assert.equal(ns.parked, true);
    assert.equal(ns.poisonEntryId, 'A');
    assert.deepEqual(ns.pending.map((e) => e.entryId), ['A', 'B']);
    assert.deepEqual(target.commits, []);
  } finally {
    cleanup(env);
  }
});

// ---------------- ordered idempotent replay ----------------

test('replay: draining twice delivers each record once; a second process replays without double delivery', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    for (let i = 1; i <= 3; i++) outbox.enqueue(entry(`r${i}`, i));
    const target = new MemoryRemoteTarget();
    await outbox.drain(target);
    assert.deepEqual(target.commits, ['r1', 'r2', 'r3']);
    await outbox.drain(target);
    assert.deepEqual(target.deliveries, ['r1', 'r2', 'r3']);
    // fresh instance over the same tree (process restart): fold recovers acked
    // state from the segments — nothing re-sent
    const restarted = makeOutbox(env);
    await restarted.drain(target);
    assert.deepEqual(target.deliveries, ['r1', 'r2', 'r3']);
  } finally {
    cleanup(env);
  }
});

test('replay: crash-after-commit-before-ack — replay re-sends, server dedup answers duplicate, no double delivery', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.failNextCommitBeforeAck = true;
    outbox.enqueue(entry('A'));
    const res = await outbox.writeThrough(entry('B', 2), target);
    // A committed remotely but the ack was lost: both entries still queued locally
    assert.equal(res.outcome, 'queued');
    assert.deepEqual(target.commits, ['A']);
    assert.equal(outbox.fold().entries.get('A')!.status, 'queued');
    // process restart + retry window elapsed: replay re-sends A, gets
    // 'duplicate', acks, then B flows — exactly one commit per record
    env.clock.t += 100;
    const restarted = makeOutbox(env);
    await restarted.drain(target);
    assert.deepEqual(target.commits, ['A', 'B']);
    const fold = restarted.fold();
    assert.equal(fold.entries.get('A')!.ackResult, 'duplicate');
    assert.equal(fold.entries.get('B')!.ackResult, 'committed');
    assert.equal(fold.namespaces.runs!.pending.length, 0);
  } finally {
    cleanup(env);
  }
});

// ---------------- poison / conflict-advance ----------------

test('poison: transient failures retry to the attempt cap, then failed-permanent parks the namespace with the poison entry named', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.down = true;
    outbox.enqueue(entry('bad'));
    outbox.enqueue(entry('behind', 2));
    outbox.enqueue({ namespace: 'hitl', id: 'h1', kind: 'hitl-request', payload: {} });
    for (let i = 0; i < 3; i++) {
      await outbox.drain(target, { namespace: 'runs' });
      env.clock.t += 100_000;
    }
    const fold = outbox.fold();
    const runs = fold.namespaces.runs!;
    assert.equal(runs.parked, true);
    assert.equal(runs.poisonEntryId, 'bad');
    const bad = fold.entries.get('bad')!;
    assert.equal(bad.status, 'failed-permanent');
    assert.equal(bad.attempts, 3);
    assert.deepEqual(bad.failure, { class: 'permanent', kind: 'attempts-exhausted', reason: 'network down' });
    // order never violated by skipping: 'behind' was never attempted
    assert.equal(fold.entries.get('behind')!.attempts, 0);
    // an unaffected namespace still drains
    target.down = false;
    const report = await outbox.drain(target);
    assert.equal(report.namespaces.hitl!.delivered, 1);
    assert.equal(report.namespaces.runs!.delivered, 0);
    assert.equal(report.namespaces.runs!.parked, true);
    assert.equal(report.namespaces.runs!.poisonEntryId, 'bad');
    assert.deepEqual(target.commits, ['h1']);
  } finally {
    cleanup(env);
  }
});

test('conflict-advance: identical hash on the server answers duplicate and the queue advances', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.committed.set('A', payloadHashOf({ n: 1 }));
    outbox.enqueue(entry('A'));
    outbox.enqueue(entry('B', 2));
    const report = await outbox.drain(target);
    assert.equal(report.namespaces.runs!.delivered, 2);
    assert.equal(outbox.fold().entries.get('A')!.ackResult, 'duplicate');
    assert.deepEqual(target.commits, ['B']);
  } finally {
    cleanup(env);
  }
});

test('conflict-park: a different hash on the server is a genuine Conflict — parked, not retried, not skipped', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.committed.set('A', payloadHashOf({ n: 999 }));
    outbox.enqueue(entry('A'));
    outbox.enqueue(entry('B', 2));
    const report = await outbox.drain(target);
    assert.equal(report.namespaces.runs!.parked, true);
    assert.equal(report.namespaces.runs!.poisonEntryId, 'A');
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'failed-permanent');
    assert.equal(a.failure!.kind, 'conflict');
    assert.equal(a.attempts, 1);
    assert.deepEqual(target.commits, []);
    // parked means parked: further drains never re-attempt
    await outbox.drain(target);
    assert.equal(outbox.fold().entries.get('A')!.attempts, 1);
    assert.equal(outbox.fold().entries.get('B')!.attempts, 0);
  } finally {
    cleanup(env);
  }
});

// ---------------- overlay reads ----------------

test('overlay: union by id — identical hash excluded, different hash surfaced as Conflict and durably parked', () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue(entry('same'));
    outbox.enqueue(entry('diff', 2));
    outbox.enqueue(entry('fresh', 3));
    const { queued, conflicts } = outbox.overlay('runs', [
      { id: 'same', payloadHash: payloadHashOf({ n: 1 }) },
      { id: 'diff', payloadHash: payloadHashOf({ n: 777 }) },
      { id: 'other-committed', payloadHash: payloadHashOf({ x: 0 }) },
    ]);
    assert.deepEqual(queued.map((e) => e.entryId), ['fresh']);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.entry.entryId, 'diff');
    assert.equal(conflicts[0]!.committedHash, payloadHashOf({ n: 777 }));
    // the conflict is durably parked and doctor-visible, never dropped
    const ns = outbox.fold().namespaces.runs!;
    assert.equal(ns.parked, true);
    assert.equal(ns.poisonEntryId, 'diff');
    assert.equal(outbox.fold().entries.get('diff')!.status, 'failed-permanent');
    assert.equal(outbox.fold().entries.get('diff')!.failure!.kind, 'conflict');
    // repeated overlay detection is idempotent (deterministic event identity)
    const again = outbox.overlay('runs', [{ id: 'diff', payloadHash: payloadHashOf({ n: 777 }) }]);
    assert.equal(again.conflicts.length, 1);
  } finally {
    cleanup(env);
  }
});

test('overlay: countWithOverlay strict mode surfaces remote failure as BackendUnavailableError', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue(entry('A'));
    await assert.rejects(
      () => outbox.countWithOverlay('runs', async () => Promise.reject(new Error('conn refused'))),
      BackendUnavailableError,
    );
  } finally {
    cleanup(env);
  }
});

test('overlay: countWithOverlay allowPartial degrades ONLY on a classified transport outage', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue(entry('A'));
    outbox.enqueue(entry('B', 2));
    // A genuine transport outage → overlay-only partial answer.
    const res = await outbox.countWithOverlay(
      'runs',
      async () => Promise.reject(Object.assign(new Error('conn refused'), { code: 'ECONNREFUSED' })),
      { allowPartial: true },
    );
    assert.deepEqual(res, { committed: 0, queued: 2, partial: true });
    // #318 R4 finding 2: a BARE Error is now classified 'unknown' (a
    // programming/schema-shaped defect) and must FAIL CLOSED even under
    // allowPartial — never a benign-looking partial count.
    await assert.rejects(
      () => outbox.countWithOverlay('runs', async () => Promise.reject(new Error('conn refused')), { allowPartial: true }),
      BackendUnavailableError,
    );
    // A PG 42703 (undefined_column) programming defect likewise fails closed.
    await assert.rejects(
      () =>
        outbox.countWithOverlay(
          'runs',
          async () => Promise.reject(Object.assign(new Error('column "nope" does not exist'), { code: '42703' })),
          { allowPartial: true },
        ),
      BackendUnavailableError,
    );
    // a KNOWN mismatch still fails hard even in allowPartial mode
    await assert.rejects(
      () =>
        outbox.countWithOverlay('runs', async () => Promise.reject(new WorkspaceMismatchError('wrong workspace')), {
          allowPartial: true,
        }),
      WorkspaceMismatchError,
    );
  } finally {
    cleanup(env);
  }
});

test('overlay: countWithOverlay merges committed + queued; conflicts stay counted', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue(entry('same'));
    outbox.enqueue(entry('diff', 2));
    outbox.enqueue(entry('fresh', 3));
    const committed = [
      { id: 'same', payloadHash: payloadHashOf({ n: 1 }) },
      { id: 'diff', payloadHash: payloadHashOf({ n: 777 }) },
    ];
    const res = await outbox.countWithOverlay('runs', async () => committed);
    // committed: same + diff; queued: fresh + the conflicted diff (never dropped)
    assert.deepEqual(res, { committed: 2, queued: 2, partial: false });
  } finally {
    cleanup(env);
  }
});

// ---------------- artifact spool ----------------

function artifactInput(id: string) {
  return { namespace: 'artifacts' as const, id, kind: 'artifact', payload: { digestOf: id } };
}

test('spool: artifact bytes are staged content-addressed and delivered object-first / index-last', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const objects = new MemoryObjectTarget();
    const target = new MemoryRemoteTarget();
    target.objects = objects;
    const bytes = Buffer.from('artifact-bytes-1');
    const digest = sha256Hex(bytes);
    const res = await outbox.writeThroughArtifact(artifactInput('a1'), bytes, target, { objects });
    assert.equal(res.outcome, 'committed');
    assert.equal(res.digest, digest);
    assert.ok(existsSync(join(outbox.spoolDir(), digest)));
    assert.deepEqual(objects.puts, [digest]);
    assert.deepEqual(target.commits, ['a1']);
    assert.deepEqual(target.invariantViolations, []);
    // the delivered index record references the digest
    assert.equal(outbox.fold().entries.get('a1')!.spoolDigest, digest);
  } finally {
    cleanup(env);
  }
});

test('spool crash matrix: fault at every boundary — staging/object/index/ack — replays to exactly-once with bytes always first', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const objects = new MemoryObjectTarget();
    const target = new MemoryRemoteTarget();
    target.objects = objects;

    // (a) crash after staging, before enqueue: orphan spool file re-adopted
    const bytesA = Buffer.from('boundary-a');
    const digestA = sha256Hex(bytesA);
    // simulate the orphan: stage bytes with no enqueued event
    mkdirSync(outbox.spoolDir(), { recursive: true });
    writeFileSync(join(outbox.spoolDir(), digestA), bytesA);
    assert.equal(outbox.fold().spool.activeBytes, 0); // orphan is not active
    const resA = await outbox.writeThroughArtifact(artifactInput('a'), bytesA, target, { objects });
    assert.equal(resA.outcome, 'committed');

    // (b) crash between objectTarget.deliver (stored) and index deliver
    const bytesB = Buffer.from('boundary-b');
    objects.failAfterStore = true;
    const resB = await outbox.writeThroughArtifact(artifactInput('b'), bytesB, target, { objects });
    assert.equal(resB.outcome, 'queued');
    assert.ok(objects.store.has(sha256Hex(bytesB))); // bytes landed
    assert.ok(!target.committed.has('b')); // index never saw the record
    env.clock.t += 100;
    await outbox.drain(target, { objects });
    assert.equal(outbox.fold().entries.get('b')!.status, 'acked');
    assert.equal(target.committed.has('b'), true);

    // (c) crash between index deliver (committed) and ack
    const bytesC = Buffer.from('boundary-c');
    target.failNextCommitBeforeAck = true;
    const resC = await outbox.writeThroughArtifact(artifactInput('c'), bytesC, target, { objects });
    assert.equal(resC.outcome, 'queued');
    assert.equal(target.committed.has('c'), true); // committed remotely, unacked locally
    env.clock.t += 100;
    const restarted = makeOutbox(env);
    await restarted.drain(target, { objects });
    assert.equal(restarted.fold().entries.get('c')!.ackResult, 'duplicate');
    assert.equal(target.commits.filter((id) => id === 'c').length, 1);

    // invariant across the whole matrix: the index target NEVER saw a record
    // whose bytes had not been delivered
    assert.deepEqual(target.invariantViolations, []);
  } finally {
    cleanup(env);
  }
});

test('spool: object store down queues the artifact and the index target never sees it', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const objects = new MemoryObjectTarget();
    const target = new MemoryRemoteTarget();
    target.objects = objects;
    objects.down = true;
    const res = await outbox.writeThroughArtifact(artifactInput('a1'), Buffer.from('x'), target, { objects });
    assert.equal(res.outcome, 'queued');
    assert.deepEqual(target.deliveries, []);
    assert.deepEqual(target.invariantViolations, []);
    objects.down = false;
    env.clock.t += 100;
    await outbox.drain(target, { objects });
    assert.equal(outbox.fold().entries.get('a1')!.status, 'acked');
    assert.deepEqual(target.invariantViolations, []);
  } finally {
    cleanup(env);
  }
});

test('spool: draining an artifact entry without an object target is a hard error, not a silent skip', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueueArtifact(artifactInput('a1'), Buffer.from('x'));
    await assert.rejects(() => outbox.drain(new MemoryRemoteTarget()), InvalidRecordError);
  } finally {
    cleanup(env);
  }
});

test('spool: missing or corrupt spooled bytes for a queued entry refuse loudly naming the path', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const bytes = Buffer.from('will-vanish');
    const { digest } = outbox.enqueueArtifact(artifactInput('a1'), bytes);
    writeFileSync(join(outbox.spoolDir(), digest), 'tampered');
    const objects = new MemoryObjectTarget();
    await assert.rejects(
      () => outbox.drain(new MemoryRemoteTarget(), { objects }),
      (err: unknown) => err instanceof InvalidRecordError && /does not match its digest/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

// ---------------- quotas ----------------

test('quota: max spool bytes refuses with a typed error before staging or enqueuing anything', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { maxSpoolBytes: 10 });
    outbox.enqueueArtifact(artifactInput('a1'), Buffer.from('123456'));
    assert.throws(() => outbox.enqueueArtifact(artifactInput('a2'), Buffer.from('7890123')), SpoolQuotaError);
    const fold = outbox.fold();
    assert.equal(fold.spool.activeBytes, 6);
    assert.equal([...fold.entries.keys()].length, 1);
    assert.deepEqual(readdirSync(outbox.spoolDir()).sort(), [sha256Hex(Buffer.from('123456'))]);
    // re-enqueueing the SAME digest does not double-count the quota
    outbox.enqueueArtifact(artifactInput('a1'), Buffer.from('123456'));
    assert.equal(outbox.fold().spool.activeBytes, 6);
    // once the backlog is acked the quota frees up
    const objects = new MemoryObjectTarget();
    const target = new MemoryRemoteTarget();
    target.objects = objects;
    await outbox.drain(target, { objects });
    assert.equal(outbox.fold().spool.activeBytes, 0);
    const after = outbox.enqueueArtifact(artifactInput('a3'), Buffer.from('7890123'));
    assert.equal(after.outcome, 'queued');
  } finally {
    cleanup(env);
  }
});

test('quota: an unwritable spool surfaces as BackendUnavailableError (disk-full class)', { skip: process.platform === 'win32' }, () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueueArtifact(artifactInput('a1'), Buffer.from('first'));
    chmodSync(outbox.spoolDir(), 0o500);
    try {
      assert.throws(
        () => outbox.enqueueArtifact(artifactInput('a2'), Buffer.from('second')),
        BackendUnavailableError,
      );
    } finally {
      chmodSync(outbox.spoolDir(), 0o700);
    }
  } finally {
    cleanup(env);
  }
});

// ---------------- fail-closed decisions (owner decision 8) ----------------

test('fail-closed: HITL decisions are never spooled — enqueue refuses with an actionable error', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    assert.throws(
      () => outbox.enqueue({ namespace: 'hitl', id: 'd1', kind: 'hitl-decision', payload: { status: 'approved' } }),
      (err: unknown) =>
        err instanceof BackendUnavailableError && /never spooled/.test((err as Error).message),
    );
    await assert.rejects(
      () =>
        outbox.writeThrough(
          { namespace: 'hitl', id: 'd1', kind: 'hitl-decision', payload: { status: 'approved' } },
          new MemoryRemoteTarget(),
        ),
      BackendUnavailableError,
    );
    assert.equal(outbox.fold().entries.size, 0);
  } finally {
    cleanup(env);
  }
});

test('enqueue: the outbox namespace itself and unknown namespaces are refused', () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    assert.throws(
      () => outbox.enqueue({ namespace: 'outbox' as never, id: 'x', kind: 'k', payload: {} }),
      InvalidRecordError,
    );
    assert.throws(
      () => outbox.enqueue({ namespace: 'nope' as never, id: 'x', kind: 'k', payload: {} }),
      InvalidRecordError,
    );
  } finally {
    cleanup(env);
  }
});

// ---------------- record shape ----------------

test('record: delivered records carry workspace, producer identity, seq, hash, and enqueue time', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const seen: OutboxRecord[] = [];
    const target: RemoteTarget = {
      async deliver(record) {
        seen.push(record);
        return 'committed';
      },
    };
    const enq = outbox.enqueue(entry('r1', 42));
    await outbox.drain(target);
    assert.equal(seen.length, 1);
    const rec = seen[0]!;
    assert.equal(rec.id, 'r1');
    assert.equal(rec.workspaceId, env.ws);
    assert.equal(rec.namespace, 'runs');
    assert.equal(rec.kind, 'run-event');
    assert.deepEqual(rec.payload, { n: 42 });
    assert.equal(rec.payloadHash, payloadHashOf({ n: 42 }));
    assert.equal(rec.producerSeq, enq.producerSeq);
    assert.match(rec.producerId, /^[0-9a-f-]{36}$/);
    assert.equal(rec.enqueuedAt, env.clock.t);
    assert.equal(rec.artifact, null);
  } finally {
    cleanup(env);
  }
});

// ---------------- single serialization ----------------

test('serialization: enqueue snapshots the payload once — stored value and payloadHash always agree (stateful toJSON)', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    let calls = 0;
    const payload = {
      toJSON() {
        calls += 1;
        return { n: calls };
      },
    };
    outbox.enqueue({ namespace: 'runs', id: 'sj', kind: 'run-event', payload });
    const entry = outbox.fold().entries.get('sj')!;
    assert.deepEqual(entry.payload, { n: 1 }, 'the stored envelope value is the once-captured snapshot');
    assert.equal(entry.payloadHash, payloadHashOf(entry.payload), 'stored value and payloadHash agree');
    assert.equal(entry.payloadHash, payloadHashOf({ n: 1 }));
    // and the delivered record carries the same agreeing value + hash
    const seen: OutboxRecord[] = [];
    const target: RemoteTarget = {
      async deliver(record) {
        seen.push(record);
        return 'committed';
      },
    };
    await outbox.drain(target);
    const rec = seen[0]!;
    assert.deepEqual(rec.payload, { n: 1 });
    assert.equal(rec.payloadHash, payloadHashOf(rec.payload));
  } finally {
    cleanup(env);
  }
});

// ---------------- checkpoint ----------------

test('checkpoint: written after drain, checksummed, and reflects last-acked producerSeq per namespace', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    const r1 = outbox.enqueue(entry('r1'));
    const r2 = outbox.enqueue(entry('r2', 2));
    const h1 = outbox.enqueue({ namespace: 'hitl', id: 'h1', kind: 'hitl-request', payload: {} });
    await outbox.drain(target);
    assert.ok(r1.producerSeq < r2.producerSeq);
    const cp = outbox.checkpoint();
    assert.equal(cp.lastAcked.runs, r2.producerSeq);
    assert.equal(cp.lastAcked.hitl, h1.producerSeq);
    const onDisk = JSON.parse(
      readFileSync(join(env.opsRoot, env.ws, 'outbox', 'checkpoint.json'), 'utf8'),
    ) as { checksum: string; lastAcked: Record<string, number> };
    assert.equal(onDisk.checksum, cp.checksum);
    assert.deepEqual(onDisk.lastAcked, cp.lastAcked);
  } finally {
    cleanup(env);
  }
});

// ---------------- semantic halts (no retry-into-poison) ----------------

class MismatchingTarget implements RemoteTarget {
  err: Error = new WorkspaceMismatchError('this database belongs to workspace someone-else');
  readonly deliveries: string[] = [];

  async deliver(record: OutboxRecord): Promise<DeliverResult> {
    this.deliveries.push(record.id);
    throw this.err;
  }
}

test('halt: WorkspaceMismatch from the remote halts the drain — no failed event, nothing parked, queue intact', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    outbox.enqueue(entry('A'));
    outbox.enqueue(entry('B', 2));
    const wrong = new MismatchingTarget();
    // Halt far more times than the attempt cap: a semantic refusal must never
    // burn attempts toward failed-permanent.
    for (let i = 0; i < 5; i++) {
      const report = await outbox.drain(wrong);
      assert.equal(report.namespaces.runs!.delivered, 0);
      assert.equal(report.namespaces.runs!.parked, false);
      assert.equal(report.namespaces.runs!.poisonEntryId, null);
      assert.ok(report.namespaces.runs!.halted);
      assert.equal(report.namespaces.runs!.halted!.entryId, 'A');
      assert.match(report.namespaces.runs!.halted!.reason, /belongs to workspace/);
    }
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'queued');
    assert.equal(a.failure, null, 'no failed event for a semantic halt');
    assert.equal(a.transientFailures, 0);
    // Restoring the correct target heals the queue completely.
    const right = new MemoryRemoteTarget();
    const healed = await outbox.drain(right);
    assert.equal(healed.namespaces.runs!.delivered, 2);
    assert.deepEqual(right.commits, ['A', 'B']);
    assert.equal(outbox.fold().namespaces.runs!.pending.length, 0);
  } finally {
    cleanup(env);
  }
});

test('halt: a permanent authorization error (PG 42501) halts — never burns attempts into failed-permanent', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    outbox.enqueue(entry('A'));
    // The remote refuses with insufficient_privilege (INSERT revoked) — a
    // permanent authorization failure, not a transient outage.
    let revoked = true;
    const committed = new Set<string>();
    const target: RemoteTarget = {
      async deliver(record) {
        if (revoked) throw Object.assign(new Error('permission denied for table run_events'), { code: '42501' });
        committed.add(record.id);
        return 'committed';
      },
    };
    // Drain far past the attempt cap: a config/auth failure must never poison.
    for (let i = 0; i < 5; i++) {
      const report = await outbox.drain(target);
      assert.ok(report.namespaces.runs!.halted, 'a 42501 must halt the drain, not fail it');
      assert.equal(report.namespaces.runs!.parked, false, 'never parked');
      assert.equal(report.namespaces.runs!.poisonEntryId, null);
      env.clock.t += 100_000;
    }
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'queued', 'still queued, not failed-permanent');
    assert.equal(a.failure, null, 'no failed event for an authorization halt');
    assert.equal(a.transientFailures, 0);
    // Restore the grant: the queue drains cleanly.
    revoked = false;
    const report = await outbox.drain(target);
    assert.equal(report.namespaces.runs!.delivered, 1);
    assert.equal(committed.has('A'), true);
  } finally {
    cleanup(env);
  }
});

test('halt: S3 AccessDenied from the object leg halts the drain (no poison, no attempt burned)', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    const bytes = Buffer.from('locked-out');
    const digest = sha256Hex(bytes);
    outbox.enqueueArtifact(artifactInput('a1'), bytes);
    // Point the artifact entry's payload spool at the right digest.
    const target = new MemoryRemoteTarget();
    let denied = true;
    const objects: ObjectTarget = {
      async deliver(d, b) {
        if (denied) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
        assert.equal(sha256Hex(b), d);
        return 'stored';
      },
    };
    for (let i = 0; i < 4; i++) {
      const report = await outbox.drain(target, { objects });
      assert.ok(report.namespaces.artifacts!.halted, 'AccessDenied must halt');
      assert.equal(report.namespaces.artifacts!.parked, false);
      env.clock.t += 100_000;
    }
    const a = outbox.fold().entries.get('a1')!;
    assert.equal(a.status, 'queued');
    assert.equal(a.failure, null);
    assert.equal(a.transientFailures, 0);
    void digest;
  } finally {
    cleanup(env);
  }
});

test('unknown: a PG 42703 (undefined_column) programming defect halts fail-closed (kind unknown), never retried into poison', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    outbox.enqueue(entry('A'));
    // A schema/programming defect surfaced by the driver — NOT an outage.
    const target: RemoteTarget = {
      async deliver() {
        throw Object.assign(new Error('column "nope" does not exist'), { code: '42703' });
      },
    };
    for (let i = 0; i < 5; i++) {
      const report = await outbox.drain(target);
      assert.ok(report.namespaces.runs!.halted, '42703 must halt the drain');
      assert.equal(report.namespaces.runs!.halted!.kind, 'unknown', 'a programming defect is an unknown halt');
      assert.equal(report.namespaces.runs!.parked, false, 'never parked (no poison)');
      assert.equal(report.namespaces.runs!.poisonEntryId, null);
      env.clock.t += 100_000;
    }
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'queued', 'still queued, not failed-permanent');
    assert.equal(a.failure, null, 'no failed event for an unknown halt');
    assert.equal(a.transientFailures, 0, 'unknown never burns a transient attempt');
  } finally {
    cleanup(env);
  }
});

test('unknown: an arbitrary TypeError halts fail-closed (kind unknown), never poison', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    outbox.enqueue(entry('A'));
    const target: RemoteTarget = {
      async deliver() {
        throw new TypeError('bad internal value');
      },
    };
    for (let i = 0; i < 4; i++) {
      const report = await outbox.drain(target);
      assert.equal(report.namespaces.runs!.halted!.kind, 'unknown');
      assert.equal(report.namespaces.runs!.poisonEntryId, null);
      env.clock.t += 100_000;
    }
    assert.equal(outbox.fold().entries.get('A')!.transientFailures, 0);
  } finally {
    cleanup(env);
  }
});

test('transport: a real ECONNREFUSED / 503 retries (transient), and poisons at the attempt cap', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    outbox.enqueue(entry('A'));
    let mode: 'econn' | '503' = 'econn';
    const target: RemoteTarget = {
      async deliver() {
        if (mode === 'econn') throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
        throw Object.assign(new Error('slow down'), { $metadata: { httpStatusCode: 503 } });
      },
    };
    // First attempt: a real transport fault → transient (retry scheduled), NOT halted.
    const r1 = await outbox.drain(target);
    assert.equal(r1.namespaces.runs!.halted, null, 'transport is not a halt');
    assert.equal(r1.namespaces.runs!.parked, false);
    assert.deepEqual(outbox.fold().entries.get('A')!.failure, { class: 'transient', kind: null, reason: 'connection refused' });
    // Second transport fault (a 503 this time) reaches the cap → poison.
    env.clock.t += 100_000;
    mode = '503';
    const r2 = await outbox.drain(target);
    assert.equal(r2.namespaces.runs!.parked, true, 'transport poisons at the cap');
    assert.equal(r2.namespaces.runs!.poisonEntryId, 'A');
    assert.equal(outbox.fold().entries.get('A')!.status, 'failed-permanent');
  } finally {
    cleanup(env);
  }
});

test('halt: a KNOWN config/auth refusal reports kind "config" (distinct from a fail-closed unknown)', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 2 });
    outbox.enqueue(entry('A'));
    const wrong = new MismatchingTarget();
    const report = await outbox.drain(wrong);
    assert.equal(report.namespaces.runs!.halted!.kind, 'config');
  } finally {
    cleanup(env);
  }
});

test('halt: VersionSkew halts identically; only transport failures count toward the poison cap', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env, { attemptCap: 3 });
    outbox.enqueue(entry('A'));
    const skewed = new MismatchingTarget();
    skewed.err = new VersionSkewError('component hitl: backend reports version 9');
    const r1 = await outbox.drain(skewed);
    assert.equal(r1.namespaces.runs!.halted!.entryId, 'A');
    assert.equal(outbox.fold().entries.get('A')!.transientFailures, 0);
    // Two TRANSPORT failures + the cap of 3 → the third transport failure is
    // permanent; the earlier semantic halts never counted.
    const flaky = new MemoryRemoteTarget();
    flaky.down = true;
    await outbox.drain(flaky);
    env.clock.t += 100_000;
    await outbox.drain(flaky);
    env.clock.t += 100_000;
    assert.equal(outbox.fold().entries.get('A')!.transientFailures, 2);
    assert.equal(outbox.fold().entries.get('A')!.status, 'queued');
    await outbox.drain(flaky);
    assert.equal(outbox.fold().entries.get('A')!.status, 'failed-permanent');
  } finally {
    cleanup(env);
  }
});

// ---------------- batch preflight ----------------

test('preflight: runs once per drain batch BEFORE any delivery; a refusal leaves the queue untouched', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue(entry('A'));
    const events: string[] = [];
    const target = new MemoryRemoteTarget();
    const guarded: RemoteTarget = {
      preflight: async () => {
        events.push('preflight');
        throw new WorkspaceMismatchError('marker swapped');
      },
      deliver: async (record) => {
        events.push(`deliver:${record.id}`);
        return await target.deliver(record);
      },
    };
    await assert.rejects(outbox.drain(guarded), WorkspaceMismatchError);
    assert.deepEqual(events, ['preflight'], 'no delivery may precede the preflight');
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'queued');
    assert.equal(a.attempts, 0, 'nothing consumed: not even an attempt event');
    // writeThrough surfaces the same refusal but the entry stays durably queued.
    await assert.rejects(outbox.writeThrough(entry('B', 2), guarded), WorkspaceMismatchError);
    assert.equal(outbox.fold().entries.get('B')!.status, 'queued');
    // A passing preflight lets the batch drain normally.
    const healthy: RemoteTarget = {
      preflight: async () => {
        events.push('preflight-ok');
      },
      deliver: target.deliver.bind(target),
    };
    const res = await outbox.drain(healthy);
    assert.equal(res.namespaces.runs!.delivered, 2);
    assert.equal(events.filter((e) => e === 'preflight-ok').length, 1, 'once per batch, not per record');
  } finally {
    cleanup(env);
  }
});

test('preflight: skipped entirely when nothing is due', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    let calls = 0;
    const target: RemoteTarget = {
      preflight: async () => {
        calls += 1;
      },
      deliver: async () => 'committed',
    };
    await outbox.drain(target);
    assert.equal(calls, 0, 'an empty queue must not trigger remote verification');
    outbox.enqueue(entry('A'));
    await outbox.drain(target);
    assert.equal(calls, 1);
    await outbox.drain(target);
    assert.equal(calls, 1, 'a fully-acked queue is not due either');
  } finally {
    cleanup(env);
  }
});

// ---------------- #318 R4 finding 2: settle surfaces a fail-closed halt ----------------

test('settle: writeThrough SURFACES a per-entry unknown/config halt AND keeps the entry queued', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    // (a) a PG 42703 (unknown, fail-closed) halt during delivery surfaces AND keeps queued.
    const unknownTarget: RemoteTarget = {
      async deliver() {
        throw Object.assign(new Error('column "nope" does not exist'), { code: '42703' });
      },
    };
    await assert.rejects(
      outbox.writeThrough(entry('A'), unknownTarget),
      (err: unknown) => err instanceof Error && /column "nope"/.test((err as Error).message),
    );
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'queued', 'the durable queue entry is preserved after a surfaced halt');
    assert.equal(a.failure, null, 'an unknown halt never poisons');
    assert.equal(a.transientFailures, 0);

    // (b) a TypeError (unknown) surfaces the same way.
    const typeTarget: RemoteTarget = {
      async deliver() {
        throw new TypeError('bad internal value');
      },
    };
    await assert.rejects(outbox.writeThrough(entry('B', 2), typeTarget), TypeError);
    assert.equal(outbox.fold().entries.get('B')!.status, 'queued');

    // (c) a config halt (WorkspaceMismatch) surfaces the typed error, keeps queued.
    await assert.rejects(outbox.writeThrough(entry('C', 3), new MismatchingTarget()), WorkspaceMismatchError);
    assert.equal(outbox.fold().entries.get('C')!.status, 'queued');
  } finally {
    cleanup(env);
  }
});

test('settle: a plain transport outage still degrades silently to {outcome:queued}', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    target.down = true; // ECONNREFUSED — a genuine transport outage
    const res = await outbox.writeThrough(entry('A'), target);
    assert.deepEqual(res, { outcome: 'queued', id: 'A' }, 'transport ⇒ silent queue, never a throw');
    assert.equal(outbox.fold().entries.get('A')!.status, 'queued');
  } finally {
    cleanup(env);
  }
});

// ---------------- #318 R4 finding 3: transport-unverified preflight skips the batch ----------------

test('preflight: a TRANSPORT-classified refusal skips the batch (nothing delivered, entries stay queued) — not a hard error', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue(entry('A'));
    const target = new MemoryRemoteTarget();
    const events: string[] = [];
    const guarded: RemoteTarget = {
      preflight: async () => {
        events.push('preflight');
        // The marker/binding revalidation hit a transport blip: the store is
        // simply unreachable right now. A PG-only (hitl/run) delivery must NOT
        // commit while the marker went unverified — deliver nothing.
        throw Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' });
      },
      deliver: async (record) => {
        events.push(`deliver:${record.id}`);
        return await target.deliver(record);
      },
    };
    const report = await outbox.drain(guarded);
    assert.deepEqual(events, ['preflight'], 'a transport-unverified preflight delivers nothing');
    assert.equal(report.namespaces.runs!.delivered, 0);
    assert.equal(report.namespaces.runs!.remaining, 1);
    assert.equal(report.namespaces.runs!.halted, null, 'a transport skip is NOT a fail-closed halt');
    const a = outbox.fold().entries.get('A')!;
    assert.equal(a.status, 'queued');
    assert.equal(a.attempts, 0, 'nothing consumed: not even an attempt event');
    assert.deepEqual(target.commits, [], 'no PG-leg commit across a transport-unverified preflight');
    // Through the write front door: transport-unverified ⇒ silent queue, never a throw.
    const res = await outbox.writeThrough(entry('B', 2), guarded);
    assert.equal(res.outcome, 'queued');
    assert.equal(outbox.fold().entries.get('B')!.status, 'queued');
  } finally {
    cleanup(env);
  }
});

// ---------------- checkpoint write failure after commit ----------------

test('checkpoint: a checkpoint write failure after successful commits is a doctor-visible warning, never an exception', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    outbox.enqueue(entry('A'));
    // Make checkpoint.json unwritable: occupy its path with a directory.
    mkdirSync(join(env.opsRoot, env.ws, 'outbox', 'checkpoint.json'), { recursive: true });
    const res = await outbox.writeThrough(entry('B', 2), target);
    assert.deepEqual(res, { outcome: 'committed', id: 'B' }, 'the durable remote commit is still committed');
    assert.deepEqual(target.commits, ['A', 'B']);
    const report = await outbox.drain(target);
    assert.ok(report.checkpointWarning !== null && /checkpoint/.test(report.checkpointWarning));
  } finally {
    cleanup(env);
  }
});

// ---------------- cross-process quota enforcement ----------------

const OUTBOX_URL = new URL('../src/lib/persistence/outbox.ts', import.meta.url).href;
const LEDGER_URL_Q = new URL('../src/lib/persistence/local/ledger.ts', import.meta.url).href;

const QUOTA_CHILD = `
import { LocalLedger } from ${JSON.stringify(LEDGER_URL_Q)};
import { LocalOutbox, SpoolQuotaError } from ${JSON.stringify(OUTBOX_URL)};
import { appendFileSync } from 'node:fs';
const [opsRoot, ws, payload, ackFile] = process.argv.slice(2);
const outbox = new LocalOutbox({
  ledger: new LocalLedger({ opsRoot, workspaceId: ws, lockTimeoutMs: 30000 }),
  maxSpoolBytes: 10,
});
try {
  outbox.enqueueArtifact(
    { namespace: 'artifacts', id: 'art-' + payload, kind: 'artifact', payload: { p: payload } },
    Buffer.from(payload),
  );
  appendFileSync(ackFile, 'ok:' + payload + '\\n');
} catch (err) {
  const tag = err instanceof SpoolQuotaError ? 'quota:' : 'err:';
  appendFileSync(ackFile, tag + payload + ' ' + String(err && err.message).replace(/\\n/g, ' ') + '\\n');
  process.exit(err instanceof SpoolQuotaError ? 3 : 4);
}
`;

test('quota: two processes cannot jointly exceed the spool cap (fold+check+stage serialized under the quota lock)', async () => {
  const env = makeEnv();
  try {
    const script = join(env.dir, 'quota-child.ts');
    const ackFile = join(env.dir, 'quota-acks.txt');
    writeFileSync(script, QUOTA_CHILD);
    const spawnChild = (payload: string) =>
      spawn(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', script, env.opsRoot, env.ws, payload, ackFile],
        { stdio: 'ignore' },
      );
    const a = spawnChild('123456');
    const b = spawnChild('abcdef');
    const [[codeA], [codeB]] = await Promise.all([once(a, 'exit'), once(b, 'exit')]);
    const acks = readFileSync(ackFile, 'utf8').split('\n').filter((l) => l.length > 0).sort();
    assert.equal(acks.filter((l) => l.startsWith('ok:')).length, 1, `exactly one staging wins: ${acks.join(', ')}`);
    assert.equal(acks.filter((l) => l.startsWith('quota:')).length, 1, `the loser gets SpoolQuotaError: ${acks.join(', ')}`);
    assert.deepEqual([codeA, codeB].sort(), [0, 3]);
    const outbox = makeOutbox(env, { maxSpoolBytes: 10 });
    const fold = outbox.fold();
    assert.equal(fold.spool.activeBytes, 6, 'active spool bytes stay within the cap');
    assert.equal(readdirSync(outbox.spoolDir()).length, 1, 'only the winner staged bytes');
  } finally {
    cleanup(env);
  }
});

test('checkpoint: torn or checksum-invalid checkpoint.json is discarded and recomputed from the segments', async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const target = new MemoryRemoteTarget();
    outbox.enqueue(entry('r1'));
    await outbox.drain(target);
    const path = join(env.opsRoot, env.ws, 'outbox', 'checkpoint.json');
    const good = readFileSync(path, 'utf8');
    // torn (not JSON)
    writeFileSync(path, good.slice(0, 20));
    let cp = makeOutbox(env).checkpoint();
    assert.equal(cp.lastAcked.runs, 1);
    assert.equal(readFileSync(path, 'utf8'), good);
    // valid JSON, wrong checksum (stale/forged derived state)
    writeFileSync(path, JSON.stringify({ producerId: cp.producerId, lastAcked: { runs: 99 }, checksum: 'beef' }));
    cp = makeOutbox(env).checkpoint();
    assert.equal(cp.lastAcked.runs, 1);
    assert.equal(readFileSync(path, 'utf8'), good);
  } finally {
    cleanup(env);
  }
});
