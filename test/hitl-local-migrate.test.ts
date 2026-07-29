import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendUnavailableError, InvalidRecordError, sha256Hex } from '../src/lib/persistence/contracts.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import { createLocalBackend } from '../src/lib/persistence/local/stores.ts';
import { LocalOutbox } from '../src/lib/persistence/outbox.ts';
import {
  HITL_MIGRATION_MARKER,
  ensureLocalHitlV2,
  planLocalHitlConversion,
  readHitlMarker,
  type HitlMigrationMarker,
} from '../src/lib/persistence/hitl-local-migrate.ts';
import { HITL_DECISION_KIND, HITL_VERSION_KIND } from '../src/lib/persistence/hitl-local-records.ts';
import { requestIdOf, requestKeyOf } from '../src/lib/persistence/hitl-machine.ts';

// #319 F / D6: the local v1 → v2 HITL conversion, its migration barrier, and its
// crash-injection roll-forward.

type Env = { dir: string; opsRoot: string; ws: string };

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'roster-hitl-mig-'));
  return { dir, opsRoot: join(dir, '.roster', 'ops'), ws: randomUUID() };
}

function ledgerOf(env: Env): LocalLedger {
  return new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws });
}

// The #318 v1 shapes, written straight into the ledger the way the v1 store did.
function seedV1(ledger: LocalLedger, rows: Array<{ id: string; fn?: string; action?: string; target?: string; body: string; contentHash?: string }>): void {
  for (const row of rows) {
    ledger.append('hitl', {
      id: row.id,
      kind: 'hitl-request',
      payload: {
        functionName: row.fn ?? 'growth',
        title: `Approve ${row.id}`,
        action: row.action ?? 'publish-post',
        target: row.target ?? 'x.com/roster',
        contentHash: row.contentHash ?? sha256Hex(row.body),
        body: row.body,
        expiresAt: null,
        status: 'awaiting',
      },
    });
  }
}

function seedV1Decision(ledger: LocalLedger, id: string, requestId: string, status: string): void {
  ledger.append('hitl', {
    id,
    kind: 'hitl-decision',
    payload: { requestId, status, decidedBy: 'firat', note: null },
  });
}

function markerPath(env: Env): string {
  return join(env.opsRoot, env.ws, 'hitl', HITL_MIGRATION_MARKER);
}

test('conversion: a fresh tree converts to a DONE marker with zero records', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    const res = ensureLocalHitlV2(ledger, 1000);
    assert.equal(res.converted, true);
    assert.equal(res.records, 0);
    const marker = readHitlMarker(ledger)!;
    assert.equal(marker.state, 'done');
    assert.equal(marker.epoch, res.epoch);
    // ...and it is a lock-free no-op afterwards.
    const again = ensureLocalHitlV2(ledger, 2000);
    assert.deepEqual([again.converted, again.epoch], [false, res.epoch]);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('conversion: v1 history is partitioned into generations at terminal boundaries', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    // Three same-key rows in REAL chronological order: r1 is terminally decided
    // BEFORE r2 exists, so r2 opens generation 2 and r3 is generation 2 v2.
    // (An overlap — a same-key row created before the prior terminal landed —
    // is ambiguous and refuses; see the preflight test below.)
    seedV1(ledger, [{ id: 'r1', body: 'draft one' }]);
    seedV1Decision(ledger, 'd1', 'r1', 'approved');
    seedV1(ledger, [
      { id: 'r2', body: 'draft two' },
      { id: 'r3', body: 'draft three' },
    ]);
    // ...plus an unrelated key that stays a single generation.
    seedV1(ledger, [{ id: 'r4', target: 'x.com/other', body: 'other draft' }]);

    const res = ensureLocalHitlV2(ledger, 5000);
    assert.equal(res.converted, true);
    assert.equal(res.records, 5, '4 versions + 1 decision');

    const { records } = ledger.scan('hitl');
    const versions = records.filter((r) => r.kind === HITL_VERSION_KIND).map((r) => r.payload as Record<string, unknown>);
    const key = requestKeyOf({ functionName: 'growth', action: 'publish-post', target: 'x.com/roster' });
    const id = requestIdOf(env.ws, key);
    assert.deepEqual(
      versions.filter((v) => v.requestId === id).map((v) => [v.generation, v.version]),
      [[1, 1], [2, 1], [2, 2]],
    );
    // The decision is re-keyed onto the derived id + its generation/version.
    const decisions = records.filter((r) => r.kind === HITL_DECISION_KIND).map((r) => r.payload as Record<string, unknown>);
    assert.deepEqual(decisions, [
      { requestId: id, generation: 1, requestVersion: 1, status: 'approved', decidedBy: 'firat', note: null, feedback: null },
    ]);
    // A legacy row whose stored hash covers its body keeps canonicalization 1.
    assert.equal(versions[0]!.canonicalizationVersion, 1);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('conversion: a legacy row whose content hash does NOT cover its body is hash-exempt (canonicalization 0)', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'the real body', contentHash: sha256Hex('something else') }]);
    ensureLocalHitlV2(ledger, 1000);
    const version = ledger
      .scan('hitl')
      .records.find((r) => r.kind === HITL_VERSION_KIND)!.payload as Record<string, unknown>;
    assert.equal(version.canonicalizationVersion, 0);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('conversion: an ambiguous legacy history REFUSES with a per-row report instead of guessing', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'one' }]);
    seedV1Decision(ledger, 'd1', 'r1', 'approved');
    seedV1Decision(ledger, 'd2', 'r1', 'rejected');
    assert.throws(
      () => planLocalHitlConversion(env.ws, ledger.scan('hitl').records),
      (err: unknown) => err instanceof InvalidRecordError && /terminal decisions/.test((err as Error).message),
    );
    // An orphan decision is refused too.
    const env2 = makeEnv();
    const l2 = ledgerOf(env2);
    seedV1Decision(l2, 'd9', 'nonexistent', 'approved');
    assert.throws(
      () => planLocalHitlConversion(env2.ws, l2.scan('hitl').records),
      (err: unknown) => err instanceof InvalidRecordError && /does not exist/.test((err as Error).message),
    );
    rmSync(env2.dir, { recursive: true, force: true });
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('conversion: a crash between the segment fsync and the marker bump rolls forward with no duplicates or loss', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'one' }]);
    seedV1Decision(ledger, 'd1', 'r1', 'approved');
    seedV1(ledger, [{ id: 'r2', target: 'x.com/two', body: 'two' }]);

    // Crash exactly at the segment-fsync / marker-bump boundary.
    assert.throws(
      () => ensureLocalHitlV2(ledger, 1000, { afterAppend: () => { throw new Error('SIGKILL'); } }),
      /SIGKILL/,
    );
    const mid = readHitlMarker(ledger)!;
    assert.equal(mid.state, 'converting', 'the durable CONVERTING marker survives the crash');
    const afterCrash = ledger.scan('hitl').records;
    const convertedOnce = afterCrash.filter((r) => r.kind === HITL_VERSION_KIND).length;
    assert.equal(convertedOnce, 2, 'the conversion segment IS durable — the crash was after its fsync');

    // Roll forward: deterministic ids make the re-append an idempotent replay.
    const rolled = ensureLocalHitlV2(ledger, 2000);
    assert.equal(rolled.converted, true);
    assert.equal(rolled.epoch, mid.epoch, 'the epoch is carried forward, not re-minted');
    const done = readHitlMarker(ledger)!;
    assert.equal(done.state, 'done');

    const records = ledger.scan('hitl').records;
    assert.equal(records.filter((r) => r.kind === HITL_VERSION_KIND).length, 2, 'no duplicate versions');
    assert.equal(records.filter((r) => r.kind === HITL_DECISION_KIND).length, 1, 'no duplicate decisions');
    // ...and the v1 records are untouched (the ledger is append-only).
    assert.equal(records.filter((r) => r.kind === 'hitl-request').length, 2);
    assert.equal(records.filter((r) => r.kind === 'hitl-decision').length, 1);

    // A third run changes nothing.
    const third = ensureLocalHitlV2(ledger, 3000);
    assert.deepEqual([third.converted, third.epoch], [false, mid.epoch]);
    assert.equal(ledger.scan('hitl').records.length, records.length);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('conversion: a crash BEFORE the append leaves a CONVERTING marker and the next run writes everything', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'one' }]);
    // Simulate the crash by planting the CONVERTING marker directly (the state a
    // process that died between the marker write and the append leaves behind).
    ensureLocalHitlV2(ledger, 500, { afterAppend: () => { throw new Error('boom'); } });
  } catch {
    // expected
  } finally {
    // no-op: the assertions live in the block below
  }
  try {
    const ledger = ledgerOf(env);
    const marker = readHitlMarker(ledger);
    assert.ok(marker !== null && marker.state === 'converting');
    const res = ensureLocalHitlV2(ledger, 1500);
    assert.equal(res.converted, true);
    assert.equal(readHitlMarker(ledger)!.state, 'done');
    assert.equal(ledger.scan('hitl').records.filter((r) => r.kind === HITL_VERSION_KIND).length, 1);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('barrier: a backend resolved BEFORE a conversion refuses to write afterwards (D6 epoch check)', async () => {
  const env = makeEnv();
  try {
    // Writer A resolves while the tree is still v1 (no marker at all).
    const a = createLocalBackend({ opsRoot: env.opsRoot, workspaceId: env.ws });
    seedV1(ledgerOf(env), [{ id: 'r1', body: 'one' }]);

    // Process B converts.
    const b = ledgerOf(env);
    const converted = ensureLocalHitlV2(b, 1000);
    assert.equal(converted.converted, true);

    // A's write is refused: its view of the on-disk format predates B's epoch.
    await assert.rejects(
      a.hitl.createRequest({
        functionName: 'growth',
        title: 'T',
        action: 'publish-post',
        target: 'x.com/new',
        contentHash: sha256Hex('body'),
        body: 'body',
        expiresAt: null,
        expectedHead: null,
      }),
      (err: unknown) => err instanceof BackendUnavailableError && /re-resolve/.test((err as Error).message),
    );

    // Re-resolving adopts the current epoch and the same write succeeds.
    const a2 = createLocalBackend({ opsRoot: env.opsRoot, workspaceId: env.ws });
    const out = await a2.hitl.createRequest({
      functionName: 'growth',
      title: 'T',
      action: 'publish-post',
      target: 'x.com/new',
      contentHash: sha256Hex('body'),
      body: 'body',
      expiresAt: null,
      expectedHead: null,
    });
    assert.equal(out.outcome, 'committed');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('barrier: the conversion holds the SAME hitl/.lock v1 writers respect', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'one' }]);
    let sawLock = false;
    // Inside the conversion (which holds hitl/.lock), a v1-style append cannot
    // acquire the lock: a short-timeout ledger gives up rather than interleaving.
    const impatient = new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws, lockTimeoutMs: 50 });
    ensureLocalHitlV2(ledger, 1000, {
      afterAppend: () => {
        assert.throws(
          () => impatient.append('hitl', { id: 'racer', kind: 'hitl-request', payload: { functionName: 'x' } }),
          (err: unknown) => err instanceof BackendUnavailableError && /lock held/.test((err as Error).message),
        );
        sawLock = true;
      },
    });
    assert.equal(sawLock, true);
    assert.ok(existsSync(markerPath(env)));
    const marker = JSON.parse(readFileSync(markerPath(env), 'utf8')) as HitlMigrationMarker;
    assert.equal(marker.state, 'done');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('converted v1 history is readable through the v2 store surface', async () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'draft one' }]);
    seedV1Decision(ledger, 'd1', 'r1', 'approved');
    seedV1(ledger, [{ id: 'r2', body: 'draft two' }]);

    const backend = createLocalBackend({ opsRoot: env.opsRoot, workspaceId: env.ws });
    const id = requestIdOf(env.ws, requestKeyOf({ functionName: 'growth', action: 'publish-post', target: 'x.com/roster' }));
    const head = await backend.hitl.getRequest(id);
    assert.ok(head !== null);
    assert.deepEqual([head.generation, head.version, head.status], [2, 1, 'awaiting']);
    assert.deepEqual(
      (await backend.hitl.listGenerations(id)).map((g) => [g.generation, g.status]),
      [[1, 'approved'], [2, 'awaiting']],
    );
    // The legacy generation is sealed; its approval is NOT authoritative for the
    // group (authority never falls back).
    assert.equal(head.authoritative, false);
    assert.deepEqual(await backend.hitl.count(), { committed: 1, queued: 0, partial: false });
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('D8: a converted legacy head whose hash was never verified can NEVER authorize execution', async () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    // A legacy row whose stored content hash does not cover its body: the
    // migration EXEMPTS it from write-time verification (canonicalization 0) so
    // the upgrade is not refused — but that exemption grants no authority.
    seedV1(ledger, [{ id: 'r1', body: 'the real body', contentHash: sha256Hex('never verified') }]);
    seedV1Decision(ledger, 'd1', 'r1', 'approved');

    const backend = createLocalBackend({ opsRoot: env.opsRoot, workspaceId: env.ws });
    const id = requestIdOf(env.ws, requestKeyOf({ functionName: 'growth', action: 'publish-post', target: 'x.com/roster' }));
    const head = await backend.hitl.getRequest(id);
    assert.ok(head !== null);
    assert.equal(head.canonicalizationVersion, 0);
    assert.equal(head.status, 'approved', 'the decision itself is preserved');
    assert.equal(head.sealed, true);
    assert.equal(head.authoritative, false, 'a legacy unverifiable approval is categorically non-authoritative');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('decision 6: a v1 workspace has no spooled HITL entries to convert', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    const outbox = new LocalOutbox({ ledger });
    // The pre-#319 spool could only ever hold hitl-request entries, and #319
    // refuses them at enqueue — so after the upgrade the invariant is simply
    // "there are none", which the conversion relies on (it converts the LEDGER,
    // not the spool).
    assert.throws(
      () => outbox.enqueue({ namespace: 'hitl', id: 'q1', kind: 'hitl-request', payload: {} }),
      BackendUnavailableError,
    );
    ensureLocalHitlV2(ledger, 1000);
    const spooled = [...outbox.fold().entries.values()].filter((e) => e.namespace === 'hitl');
    assert.deepEqual(spooled, []);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// ---------- round-1 review repros ----------

// Finding 7: the barrier must fence a v1 writer that appends AFTER the
// conversion completed, not merely one that races it while the lock is held.
test('R7: a v1-format HITL append AFTER the conversion is refused by the append primitive', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    seedV1(ledger, [{ id: 'r1', body: 'one' }]);
    ensureLocalHitlV2(ledger, 1000);

    // A shipped v1 writer that resolved BEFORE the migration, waited for the
    // lock, and only now gets to append.
    const late = new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws });
    assert.throws(
      () =>
        late.append('hitl', {
          id: 'late-v1',
          kind: 'hitl-request',
          payload: {
            functionName: 'growth',
            title: 'late',
            action: 'publish-post',
            target: 'x.com/late',
            contentHash: sha256Hex('late body'),
            body: 'late body',
          },
        }),
      (err: unknown) => err instanceof InvalidRecordError && /v1/.test((err as Error).message),
    );
    assert.equal(
      ledger.scan('hitl').records.filter((r) => r.id === 'late-v1').length,
      0,
      'a post-conversion v1 record must never become durable (the v2 projection would ignore it forever)',
    );
    // A v1 decision is fenced the same way.
    assert.throws(
      () => late.append('hitl', { id: 'late-d', kind: 'hitl-decision', payload: { requestId: 'r1', status: 'approved' } }),
      InvalidRecordError,
    );
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// Finding 9: a large-but-valid v1 history must not exceed the ledger's
// per-record limit — the conversion writes bounded, resumable chunks.
test('R9: a v1 history larger than the ledger record limit converts in bounded chunks', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    const filler = 'y'.repeat(48 * 1024);
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      target: `x.com/${i}`,
      body: `${i}-${filler}`,
    }));
    seedV1(ledger, rows);

    const res = ensureLocalHitlV2(ledger, 1000);
    assert.equal(res.converted, true);
    assert.equal(res.records, rows.length);
    assert.equal(
      ledger.scan('hitl').records.filter((r) => r.kind === HITL_VERSION_KIND).length,
      rows.length,
      'every converted version is durable',
    );
    // ...and a re-run is still an idempotent no-op.
    const again = ensureLocalHitlV2(ledger, 2000);
    assert.equal(again.converted, false);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// ---------- round-2 review repros ----------

// R2 finding 2: every record of a conversion batch shares ONE ledger seq, so a
// scalar `seq >` cursor skipped every sibling but the last one it returned —
// a converted request became permanently unreachable through pagination.
test('R2-2: two v1 requests converted in ONE batch are BOTH reachable by paginated listRequests', async () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    // Editorial (never expires) so both stay actionable after the conversion.
    seedV1(ledger, [
      { id: 'r1', action: 'approve-draft', target: 'doc/one', body: 'one' },
      { id: 'r2', action: 'approve-draft', target: 'doc/two', body: 'two' },
    ]);
    const converted = ensureLocalHitlV2(ledger, 5000);
    assert.equal(converted.records, 2);
    const envelopes = ledger.scan('hitl').records.filter((r) => r.kind === HITL_VERSION_KIND);
    assert.equal(
      new Set(envelopes.map((r) => r.seq)).size,
      1,
      'the fixture is only a repro while both converted versions share one physical seq',
    );

    const backend = createLocalBackend({ opsRoot: env.opsRoot, workspaceId: env.ws });
    const seen: string[] = [];
    let cursor = undefined as undefined | NonNullable<Awaited<ReturnType<typeof backend.hitl.listRequests>>['cursor']>;
    for (let page = 0; page < 5; page++) {
      const res = await backend.hitl.listRequests({ limit: 1 }, cursor);
      seen.push(...res.items.map((i) => i.id));
      if (res.cursor === null) break;
      cursor = res.cursor;
    }
    assert.equal(new Set(seen).size, seen.length, 'pagination must never repeat a request');
    assert.deepEqual(
      seen.slice().sort(),
      [
        requestIdOf(env.ws, requestKeyOf({ functionName: 'growth', action: 'approve-draft', target: 'doc/one' })),
        requestIdOf(env.ws, requestKeyOf({ functionName: 'growth', action: 'approve-draft', target: 'doc/two' })),
      ].sort(),
      'pagination must reach every batch sibling exactly once',
    );
    assert.deepEqual(await backend.hitl.count(), { committed: 2, queued: 0, partial: false });
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// R2 finding 3: a converted record must report the time the REQUEST was
// created, not the time the conversion ran — the postgres backfill preserves
// v1 created_at, so anything else is both an audit lie and a parity break.
test('R2-3: conversion preserves each legacy record original createdAt on every read path', async () => {
  const env = makeEnv();
  try {
    const seedClock = { t: 1000 };
    const seeder = new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws, now: () => seedClock.t });
    seedV1(seeder, [{ id: 'r1', action: 'approve-draft', target: 'doc/one', body: 'one' }]);
    seedClock.t = 2000;
    seedV1Decision(seeder, 'd1', 'r1', 'deferred');

    const backend = createLocalBackend({ opsRoot: env.opsRoot, workspaceId: env.ws, now: () => 5000 });
    const id = requestIdOf(env.ws, requestKeyOf({ functionName: 'growth', action: 'approve-draft', target: 'doc/one' }));
    const head = await backend.hitl.getRequest(id);
    assert.ok(head !== null);
    assert.equal(head.createdAt, 1000, 'getRequest must report the ORIGINAL creation time');
    assert.deepEqual(
      (await backend.hitl.listVersions(id)).map((v) => v.createdAt),
      [1000],
      'listVersions must report the ORIGINAL creation time',
    );
    assert.deepEqual(
      (await backend.hitl.listGenerations(id)).map((g) => g.createdAt),
      [1000],
      'generation history must report the ORIGINAL creation time',
    );
    assert.deepEqual(
      (await backend.hitl.listDecisions(id)).map((d) => d.decidedAt),
      [2000],
      'a converted decision keeps its own legacy stamp',
    );
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// Finding 9 (resume): a crash between chunks rolls forward without duplicates.
test('R9: a crash BETWEEN conversion chunks rolls forward with no duplicates', () => {
  const env = makeEnv();
  try {
    const ledger = ledgerOf(env);
    const filler = 'z'.repeat(48 * 1024);
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      target: `x.com/c${i}`,
      body: `${i}-${filler}`,
    }));
    seedV1(ledger, rows);
    let chunks = 0;
    assert.throws(
      () =>
        ensureLocalHitlV2(ledger, 1000, {
          afterChunk: () => {
            chunks += 1;
            if (chunks === 1) throw new Error('SIGKILL');
          },
        }),
      /SIGKILL/,
    );
    assert.equal(readHitlMarker(ledger)!.state, 'converting');
    const rolled = ensureLocalHitlV2(ledger, 2000);
    assert.equal(rolled.converted, true);
    assert.equal(readHitlMarker(ledger)!.state, 'done');
    assert.equal(
      ledger.scan('hitl').records.filter((r) => r.kind === HITL_VERSION_KIND).length,
      rows.length,
      'no duplicates, no loss',
    );
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});
