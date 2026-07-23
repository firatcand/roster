import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  LegacyFilesAdapter,
  drainOutbox,
  opsRootFor,
  resolveOpsBackend,
  withCapabilityGate,
  type ResolvedOpsBackend,
} from '../src/lib/persistence/resolve.ts';
import { runSetup } from '../src/lib/persistence/setup.ts';
import { scanPending, countPending } from '../src/lib/pending.ts';
import { MemoryFileStore, type FileStore, type GetResult, type HeadResult, type PutOpts, type PutResult } from '../src/lib/persistence/s3-core.ts';
import {
  BackendUnavailableError,
  InvalidRecordError,
  VersionSkewError,
  WorkspaceMismatchError,
  sha256Hex,
  type Cursor,
  type HitlRequestInput,
  type OpsBackend,
} from '../src/lib/persistence/contracts.ts';
import { makeBackendInfo } from '../src/lib/persistence/capabilities.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import { LocalOutbox, type DeliverResult, type OutboxRecord, type RemoteTarget } from '../src/lib/persistence/outbox.ts';
import { WORKSPACE_MARKER_KEY, workspaceMarkerBody } from '../src/lib/persistence/objects.ts';
import { RosterError } from '../src/lib/errors.ts';

// #318 stage 5: the resolveOpsBackend factory — all five states, the legacy
// regression seam, degraded-on-transport-only semantics, known-mismatch
// fail-hard-without-queuing, capability-assert-before-write, and the drain
// revalidation path. PG parts are ROSTER_OPS_TEST_ADMIN_URL-gated.

const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const pgOpts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function hitlInput(overrides: Partial<HitlRequestInput> = {}): HitlRequestInput {
  return {
    functionName: 'growth',
    title: 'Approve the launch post',
    action: 'publish-post',
    target: 'x.com/roster',
    contentHash: sha256Hex('post body'),
    body: 'full body',
    expiresAt: null,
    ...overrides,
  };
}

function writePgConfig(
  cwd: string,
  ws: { id: string; name: string },
  objects: { bucket?: string; endpoint?: string | null } = {},
): void {
  mkdirSync(join(cwd, 'roster'), { recursive: true });
  writeFileSync(
    join(cwd, 'roster', 'persistence.yaml'),
    [
      'version: 1',
      'workspace:',
      `  id: ${ws.id}`,
      `  name: ${ws.name}`,
      'backend: postgres-s3',
      'postgres:',
      '  database: dedicated',
      'objects:',
      `  bucket: ${objects.bucket ?? 'acme-ops'}`,
      '  region: null',
      `  endpoint: ${objects.endpoint === undefined ? 'null' : objects.endpoint}`,
      '  force_path_style: false',
    ].join('\n') + '\n',
  );
}

function outboxOf(cwd: string, workspaceId: string): LocalOutbox {
  return new LocalOutbox({ ledger: new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId }) });
}

// A FileStore wrapper whose GETs can be flipped to throw an S3 AccessDenied — a
// permanent IAM/config failure, NOT a transport outage.
class DenyingFileStore implements FileStore {
  denyGet = false;
  // A GET that throws a bare Error carrying no transport code — an UNKNOWN
  // (programming/schema-shaped) failure that must fail closed, not degrade.
  unknownGet = false;
  // A GET that throws a transport-coded ECONNRESET — a genuine outage. The
  // marker cannot be POSITIVELY verified, so the drain must deliver nothing
  // (queue), NOT let a PG-only delivery commit with the marker unverified.
  transportGet = false;
  private readonly inner: FileStore;
  constructor(inner: FileStore) {
    this.inner = inner;
  }
  private accessDenied(): Error {
    return Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  }
  async put(key: string, body: Buffer, opts?: PutOpts): Promise<PutResult> {
    return await this.inner.put(key, body, opts);
  }
  async get(key: string): Promise<GetResult | null> {
    if (this.denyGet) throw this.accessDenied();
    if (this.transportGet) throw Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' });
    if (this.unknownGet) throw new TypeError('unexpected object-store response shape');
    return await this.inner.get(key);
  }
  async head(key: string): Promise<HeadResult | null> {
    return await this.inner.head(key);
  }
  async del(key: string): Promise<void> {
    return await this.inner.del(key);
  }
}

// ---------- legacy ----------

test('resolve: no persistence.yaml → legacy state; adapter is byte-identical to scanPending', async () => {
  const cwd = tmp('resolve-legacy-');
  try {
    const pendingDir = join(cwd, 'roster', 'growth', 'pending');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      join(pendingDir, 'plan-1.md'),
      '---\ntitle: Draft plan\ntarget_on_approve: growth/plans/plan-1.md\n---\nPlease review.\n',
    );
    writeFileSync(join(pendingDir, 'error-ab12cd34.md'), '---\nclass: error\n---\nSchedule failed.\n');
    const otherDir = join(cwd, 'roster', 'sales', 'pending');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'note.md'), 'no front matter body\n');

    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'legacy');
    if (resolved.state !== 'legacy') return;
    assert.ok(resolved.adapter instanceof LegacyFilesAdapter);
    assert.deepEqual(resolved.adapter.items(), scanPending(cwd));
    assert.deepEqual(resolved.adapter.items('growth'), scanPending(cwd, 'growth'));
    assert.equal(resolved.adapter.count(), countPending(cwd));
    assert.equal(resolved.adapter.count(), 3);
    // Read-only: the adapter exposes no mutation surface.
    assert.deepEqual(
      Object.keys(Object.getOwnPropertyDescriptors(LegacyFilesAdapter.prototype)).sort(),
      ['constructor', 'count', 'items'],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolve: legacy adapter on an empty dir behaves like scanPending (empty)', async () => {
  const cwd = tmp('resolve-legacy-empty-');
  try {
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'legacy');
    if (resolved.state !== 'legacy') return;
    assert.deepEqual(resolved.adapter.items(), []);
    assert.equal(resolved.adapter.count(), 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- local ----------

test('resolve: configured-local → local state with working gated stores', async () => {
  const cwd = tmp('resolve-local-');
  try {
    const setup = await runSetup({ cwd, backend: 'local', name: 'acme' });
    assert.equal(setup.status, 'created');
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state !== 'local') return;
    assert.equal(resolved.config.workspace.id, setup.workspace.id);
    const w = await resolved.backend.hitl.createRequest(hitlInput());
    assert.equal(w.outcome, 'committed');
    const count = await resolved.backend.hitl.count();
    assert.deepEqual(count, { committed: 1, queued: 0, partial: false });
    assert.equal(resolved.info.backend, 'local');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- setup-incomplete ----------

test('resolve: aborted setup → setup-incomplete with journal info', async () => {
  const cwd = tmp('resolve-incomplete-');
  try {
    await assert.rejects(
      runSetup({
        cwd,
        backend: 'local',
        name: 'acme',
        onPhase: (p, m) => {
          if (p === 'config-written' && m === 'begin') throw new Error('abort');
        },
      }),
      /abort/,
    );
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'setup-incomplete');
    if (resolved.state !== 'setup-incomplete') return;
    assert.equal(resolved.journal.backend, 'local');
    assert.equal(resolved.journal.phase, 'gitignore-ensured');
    assert.match(resolved.journal.remedy, /re-run 'roster ops setup'/);
    // Roll forward, then resolution heals.
    const setup = await runSetup({ cwd, backend: 'local', name: 'acme' });
    assert.equal(setup.status, 'resumed');
    assert.equal(setup.workspace.id, resolved.journal.workspaceId);
    assert.equal((await resolveOpsBackend(cwd)).state, 'local');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- degraded (transport failure only) ----------

test('resolve: postgres-s3 with unreachable DB → degraded; spoolable writes queue, reads refuse', async () => {
  const cwd = tmp('resolve-degraded-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const env = { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv;
    const resolved = await resolveOpsBackend(cwd, { env, files: new MemoryFileStore() });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;
    assert.match(resolved.reason, /database/);

    const req = await resolved.backend.hitl.createRequest(hitlInput());
    assert.equal(req.outcome, 'queued');
    const run = await resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k1', type: 'started', data: null });
    assert.equal(run.outcome, 'queued');
    const bytes = randomBytes(64);
    const art = await resolved.backend.artifacts.putArtifact(
      { filename: 'a.bin', contentType: 'application/octet-stream', runId: null },
      bytes,
    );
    assert.equal(art.outcome, 'queued');
    assert.equal(art.digest, sha256Hex(bytes));

    // HITL decisions are fail-closed — never spooled (owner decision 8).
    await assert.rejects(
      resolved.backend.hitl.appendDecision({ requestId: req.id, status: 'approved', decidedBy: 'firat', note: null }),
      BackendUnavailableError,
    );
    // Reads and counts refuse rather than answering local-only.
    await assert.rejects(resolved.backend.hitl.getRequest(req.id), BackendUnavailableError);
    await assert.rejects(resolved.backend.hitl.listRequests({}), BackendUnavailableError);
    await assert.rejects(resolved.backend.hitl.count(), BackendUnavailableError);
    await assert.rejects(resolved.backend.runs.getRun('r1'), BackendUnavailableError);
    await assert.rejects(resolved.backend.runs.count(), BackendUnavailableError);
    await assert.rejects(resolved.backend.artifacts.getArtifact(art.digest), BackendUnavailableError);

    // The queued entries are durable in the outbox, spool bytes staged.
    const fold = resolved.outbox.fold();
    assert.equal([...fold.entries.values()].filter((e) => e.status === 'queued').length, 3);
    assert.ok(existsSync(join(opsRootFor(cwd), ws.id, 'spool', art.digest)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolve: degraded allowPartial reads serve the queued overlay, flagged partial + queued', async () => {
  const cwd = tmp('resolve-partial-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const env = { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv;
    const resolved = await resolveOpsBackend(cwd, { env, files: new MemoryFileStore() });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;
    const req = await resolved.backend.hitl.createRequest(hitlInput({ title: 'queued offline' }));
    const run = await resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k1', type: 'started', data: null });
    const bytes = randomBytes(48);
    const art = await resolved.backend.artifacts.putArtifact(
      { filename: 'a.bin', contentType: 'application/octet-stream', runId: 'r1' },
      bytes,
    );

    // Without allowPartial degraded reads still throw (regression guard).
    await assert.rejects(resolved.backend.hitl.getRequest(req.id), BackendUnavailableError);
    await assert.rejects(resolved.backend.hitl.count(), BackendUnavailableError);

    // hitl: get/list/count from the overlay only, marked queued + partial.
    const got = await resolved.backend.hitl.getRequest(req.id, { allowPartial: true });
    assert.ok(got !== null);
    assert.equal(got.queued, true);
    assert.equal(got.seq, null);
    assert.equal(got.title, 'queued offline');
    const listed = await resolved.backend.hitl.listRequests({}, undefined, { allowPartial: true });
    assert.equal(listed.partial, true);
    assert.deepEqual(listed.items.map((i) => [i.id, i.queued]), [[req.id, true]]);
    assert.deepEqual(await resolved.backend.hitl.count(undefined, { allowPartial: true }), {
      committed: 0,
      queued: 1,
      partial: true,
    });
    assert.equal(await resolved.backend.hitl.getRequest(sha256Hex('missing'), { allowPartial: true }), null);

    // runs: overlay events + summaries.
    const gotRun = await resolved.backend.runs.getRun('r1', { allowPartial: true });
    assert.ok(gotRun !== null);
    assert.deepEqual(gotRun.events.map((e) => [e.id, e.queued, e.seq]), [[run.id, true, null]]);
    const runsPage = await resolved.backend.runs.listRuns({}, undefined, { allowPartial: true });
    assert.equal(runsPage.partial, true);
    assert.deepEqual(runsPage.items.map((r) => [r.runId, r.queued]), [['r1', true]]);
    assert.deepEqual(await resolved.backend.runs.count(undefined, { allowPartial: true }), {
      committed: 0,
      queued: 1,
      partial: true,
    });

    // artifacts: bytes served from the spool, digest-verified.
    const gotArt = await resolved.backend.artifacts.getArtifact(art.digest, { allowPartial: true });
    assert.ok(gotArt !== null && gotArt.bytes.equals(bytes));
    assert.equal(gotArt.record.queued, true);
    const headArt = await resolved.backend.artifacts.head(art.digest, { allowPartial: true });
    assert.ok(headArt !== null && headArt.queued);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// R5 nit: degraded point reads must reject bad input the same way local + PG
// stores do — an empty id / malformed digest throws InvalidRecordError, it does
// not quietly return null just because the backend is degraded.
test('resolve: degraded point reads validate arguments (parity with local/PG)', async () => {
  const cwd = tmp('resolve-degraded-validate-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const env = { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv;
    const resolved = await resolveOpsBackend(cwd, { env, files: new MemoryFileStore() });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;

    // Empty ids and malformed digests throw before the allowPartial gate.
    await assert.rejects(resolved.backend.hitl.getRequest('', { allowPartial: true }), InvalidRecordError);
    await assert.rejects(resolved.backend.runs.getRun('', { allowPartial: true }), InvalidRecordError);
    await assert.rejects(resolved.backend.artifacts.getArtifact('not-a-digest', { allowPartial: true }), InvalidRecordError);
    await assert.rejects(resolved.backend.artifacts.head('DEADBEEF', { allowPartial: true }), InvalidRecordError);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolve: degraded partial listings honor limit + cursor (paginate the queued overlay, not dump-all)', async () => {
  const cwd = tmp('resolve-degraded-page-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const env = { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv;
    const resolved = await resolveOpsBackend(cwd, { env, files: new MemoryFileStore() });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;
    const N = 200;
    const runIds: string[] = [];
    for (let i = 0; i < N; i++) {
      await resolved.backend.hitl.createRequest(hitlInput({ contentHash: sha256Hex(`draft-${i}`) }));
      const rid = `run-${i}`;
      runIds.push(rid);
      await resolved.backend.runs.appendEvent({ runId: rid, dedupeKey: 'k', type: 'started', data: null });
    }

    // hitl: limit 1 must return 1 item + a cursor, and pagination must reach all N.
    const first = await resolved.backend.hitl.listRequests({ limit: 1 }, undefined, { allowPartial: true });
    assert.equal(first.items.length, 1, 'limit is honored, not dumped');
    assert.ok(first.cursor !== null, 'a cursor is issued while more remain');
    assert.equal(first.partial, true);
    const seenHitl = new Set<string>(first.items.map((i) => i.id));
    let cursor: Cursor | null = first.cursor;
    let guard = 0;
    while (cursor !== null) {
      const page: typeof first = await resolved.backend.hitl.listRequests({ limit: 7 }, cursor, { allowPartial: true });
      assert.ok(page.items.length <= 7);
      for (const it of page.items) seenHitl.add(it.id);
      cursor = page.cursor;
      if (++guard > N + 10) assert.fail('hitl pagination did not terminate');
    }
    assert.equal(seenHitl.size, N, 'every queued request is reachable through pagination');

    // runs: same contract — limit 1 returns 1 with a cursor; drain all N runs.
    const rfirst = await resolved.backend.runs.listRuns({ limit: 1 }, undefined, { allowPartial: true });
    assert.equal(rfirst.items.length, 1);
    assert.ok(rfirst.cursor !== null);
    const seenRuns = new Set<string>(rfirst.items.map((r) => r.runId));
    let rcursor: Cursor | null = rfirst.cursor;
    guard = 0;
    while (rcursor !== null) {
      const page: typeof rfirst = await resolved.backend.runs.listRuns({ limit: 5 }, rcursor, { allowPartial: true });
      for (const r of page.items) seenRuns.add(r.runId);
      rcursor = page.cursor;
      if (++guard > N + 10) assert.fail('runs pagination did not terminate');
    }
    assert.equal(seenRuns.size, N, 'every queued run is reachable through pagination');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolve finding 5: degraded listRuns is cursor-stable when a run head event acks between pages (no duplicate run)', async () => {
  const cwd = tmp('resolve-degraded-stable-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const env = { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv;
    const resolved = await resolveOpsBackend(cwd, { env, files: new MemoryFileStore() });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;

    // Run R has two queued events (producerSeq 1, 2); run S one (producerSeq 3).
    const r1 = await resolved.backend.runs.appendEvent({ runId: 'R', dedupeKey: 'k1', type: 'started', data: null });
    await resolved.backend.runs.appendEvent({ runId: 'R', dedupeKey: 'k2', type: 'step', data: null });
    await resolved.backend.runs.appendEvent({ runId: 'S', dedupeKey: 'k3', type: 'started', data: null });

    // Page 1 (limit 1): R is returned (its anchor = producerSeq 1, sorts first).
    const page1 = await resolved.backend.runs.listRuns({ limit: 1 }, undefined, { allowPartial: true });
    assert.deepEqual(page1.items.map((r) => r.runId), ['R']);
    assert.ok(page1.cursor !== null);

    // Connectivity briefly returns: a drain ACKs R's FIRST event (producerSeq 1)
    // but R's second event's delivery fails (transport) — R's earliest QUEUED
    // event shifts to producerSeq 2. A first-pending group key would move with it.
    const flaky: RemoteTarget = {
      async deliver(record: OutboxRecord): Promise<DeliverResult> {
        if (record.id === r1.id) return 'committed';
        throw Object.assign(new Error('down again'), { code: 'ECONNREFUSED' });
      },
    };
    await resolved.outbox.drain(flaky, { namespace: 'runs' });
    assert.equal(resolved.outbox.fold().entries.get(r1.id)!.status, 'acked', 'R/seq1 acked');

    // Page 2 must NOT re-emit R (it was already returned on page 1) — the stable
    // anchor (min over ALL entries incl. the acked one) keeps R's key at seq 1.
    const page2 = await resolved.backend.runs.listRuns({ limit: 10 }, page1.cursor!, { allowPartial: true });
    assert.ok(!page2.items.some((r) => r.runId === 'R'), 'R must not reappear after its head event acks');
    assert.deepEqual(page2.items.map((r) => r.runId), ['S']);

    // Full pagination yields each logical run exactly once.
    const seen: string[] = [...page1.items.map((r) => r.runId)];
    let cursor: Cursor | null = page1.cursor;
    let guard = 0;
    while (cursor !== null) {
      const page: Awaited<ReturnType<typeof resolved.backend.runs.listRuns>> = await resolved.backend.runs.listRuns(
        { limit: 1 },
        cursor,
        { allowPartial: true },
      );
      for (const r of page.items) seen.push(r.runId);
      cursor = page.cursor;
      if (++guard > 20) assert.fail('pagination did not terminate');
    }
    assert.deepEqual(seen.sort(), ['R', 'S'], 'each run appears exactly once across the whole pagination');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolve: missing runtime env var → fails hard (config error, nothing queued)', async () => {
  const cwd = tmp('resolve-noenv-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    await assert.rejects(
      resolveOpsBackend(cwd, { env: {} as NodeJS.ProcessEnv, files: new MemoryFileStore() }),
      /ROSTER_OPS_URL/,
    );
    assert.equal(outboxOf(cwd, ws.id).fold().entries.size, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolve: future hitl version — hitl operations refuse per-component, runs still work, skew doctor-visible', async () => {
  const cwd = tmp('resolve-skew-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const treeDir = join(opsRootFor(cwd), ws.id);
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(
      join(treeDir, 'meta.json'),
      JSON.stringify({
        configVersion: 1,
        workspaceId: ws.id,
        producerId: randomUUID(),
        componentVersions: { hitl: 99, roster_ops: 1, objects: 1 },
      }),
    );
    // Unreachable env: resolution degrades on TRANSPORT; the hitl skew is
    // recorded, not a wholesale refusal — components negotiate independently.
    const resolved = await resolveOpsBackend(cwd, {
      env: { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv,
      files: new MemoryFileStore(),
    });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;
    assert.equal(resolved.skew.length, 1);
    assert.match(resolved.skew[0]!, /hitl/);
    // A future hitl version still allows runs.appendEvent (the exact finding).
    const run = await resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k1', type: 'started', data: null });
    assert.equal(run.outcome, 'queued');
    // hitl writes AND reads refuse with the skew, before any queueing.
    await assert.rejects(resolved.backend.hitl.createRequest(hitlInput()), VersionSkewError);
    await assert.rejects(resolved.backend.hitl.count(), VersionSkewError);
    await assert.rejects(resolved.backend.hitl.getRequest(sha256Hex('x')), VersionSkewError);
    const entries = [...outboxOf(cwd, ws.id).fold().entries.values()];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, 'run-event', 'nothing hitl-shaped may queue toward a skewed component');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- capability gate (assert-before-write proven) ----------

test('capability gate: missing required capability refuses BEFORE the store method runs', async () => {
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error('store method must not be reached');
  };
  const stub = {
    backend: 'local',
    workspaceId: randomUUID(),
    hitl: {
      createRequest: record('hitl.createRequest'),
      getRequest: record('hitl.getRequest'),
      listRequests: record('hitl.listRequests'),
      appendDecision: record('hitl.appendDecision'),
      count: record('hitl.count'),
    },
    runs: {
      appendEvent: record('runs.appendEvent'),
      getRun: record('runs.getRun'),
      listRuns: record('runs.listRuns'),
      count: record('runs.count'),
    },
    artifacts: {
      putArtifact: record('artifacts.putArtifact'),
      getArtifact: record('artifacts.getArtifact'),
      head: record('artifacts.head'),
    },
  } as unknown as OpsBackend;
  // roster_ops offers NO capabilities: every runs/artifacts/outbox op refuses.
  const info = makeBackendInfo('local', {
    roster_ops: { version: 1, capabilities: [] },
    hitl: { version: 1, capabilities: ['requests'] },
    objects: { version: 1 },
  });
  const gated = withCapabilityGate(stub, info);
  await assert.rejects(gated.runs.appendEvent({ runId: 'r', dedupeKey: 'k', type: 't', data: null }), VersionSkewError);
  await assert.rejects(
    gated.artifacts.putArtifact({ filename: 'a', contentType: 'b', runId: null }, Buffer.from('x')),
    VersionSkewError,
  );
  // hitl offers 'requests' but not 'decisions' → decision write refuses.
  await assert.rejects(
    gated.hitl.appendDecision({ requestId: 'x', status: 'approved', decidedBy: 'me', note: null }),
    VersionSkewError,
  );
  // READS are gated too: a missing capability blocks them before the store runs.
  await assert.rejects(gated.runs.getRun('r'), VersionSkewError);
  await assert.rejects(gated.runs.listRuns({}), VersionSkewError);
  await assert.rejects(gated.runs.count(), VersionSkewError);
  await assert.rejects(gated.artifacts.getArtifact(sha256Hex('x')), VersionSkewError);
  await assert.rejects(gated.artifacts.head(sha256Hex('x')), VersionSkewError);
  assert.deepEqual(calls, [], 'no gated store method may run when the capability assert fails');
  // A satisfied requirement reaches the store (and the stub then throws its own error).
  await assert.rejects(gated.hitl.createRequest(hitlInput()), /store method must not be reached/);
  // hitl offers 'requests', so hitl reads reach the store as well.
  await assert.rejects(gated.hitl.getRequest('some-id'), /store method must not be reached/);
  assert.deepEqual(calls, ['hitl.createRequest', 'hitl.getRequest']);
});

// ---------- PG-gated: healthy resolution, known mismatches, drain revalidation ----------

function urlForDb(db: string): string {
  const u = new URL(ADMIN);
  u.pathname = '/' + db;
  return u.toString();
}

type Harness = { db: string; url: string; suffix: string; roles: string[]; close: () => Promise<void> };

async function makeDb(): Promise<Harness> {
  const suffix = randomBytes(6).toString('hex');
  const db = `ops_resolve_${suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const roles: string[] = [];
  return {
    db,
    url: urlForDb(db),
    suffix,
    roles,
    close: async () => {
      const root2 = new pg.Client({ connectionString: ADMIN });
      await root2.connect();
      try {
        await root2.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [db],
        );
        await root2.query(`DROP DATABASE IF EXISTS ${db}`);
        for (const role of roles) await root2.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      } finally {
        await root2.end();
      }
    },
  };
}

async function createRuntimeRole(h: Harness): Promise<{ role: string; runtimeUrl: string }> {
  const role = `ops_rt_${h.suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(
      `CREATE ROLE ${role} LOGIN PASSWORD 'pw-${h.suffix}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  } finally {
    await root.end();
  }
  h.roles.push(role);
  const u = new URL(h.url);
  u.username = role;
  u.password = `pw-${h.suffix}`;
  return { role, runtimeUrl: u.toString() };
}

type PgWorkspace = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  store: MemoryFileStore;
  workspaceId: string;
};

async function setupPgWorkspace(h: Harness, overrides: { bucket?: string; store?: MemoryFileStore } = {}): Promise<PgWorkspace> {
  const cwd = tmp('resolve-pg-');
  const { runtimeUrl } = await createRuntimeRole(h);
  const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
  const store = overrides.store ?? new MemoryFileStore();
  const setup = await runSetup({
    cwd,
    backend: 'postgres-s3',
    database: 'dedicated',
    bucket: overrides.bucket ?? 'acme-ops',
    name: 'acme',
    env,
    adminFiles: store,
    validateBucket: async () => ({ objectLock: false }),
  });
  assert.equal(setup.status, 'created');
  return { cwd, env, store, workspaceId: setup.workspace.id };
}

async function resolvePg(w: PgWorkspace): Promise<ResolvedOpsBackend> {
  return await resolveOpsBackend(w.cwd, { env: w.env, files: w.store });
}

test('resolve: healthy postgres-s3 → stores committed writes + outbox-overlay count', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    const resolved = await resolvePg(w);
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state !== 'postgres-s3') return;
    try {
      const write = await resolved.backend.hitl.createRequest(hitlInput());
      assert.equal(write.outcome, 'committed');
      const count = await resolved.backend.hitl.count();
      assert.deepEqual(count, { committed: 1, queued: 0, partial: false });
      const bytes = randomBytes(32);
      const art = await resolved.backend.artifacts.putArtifact(
        { filename: 'r.bin', contentType: 'application/octet-stream', runId: null },
        bytes,
      );
      assert.equal(art.outcome, 'committed');
      const got = await resolved.backend.artifacts.getArtifact(art.digest);
      assert.ok(got !== null && got.bytes.equals(bytes));
      assert.equal(resolved.info.backend, 'postgres-s3');
      assert.equal(resolved.binding.state, 'finalized');
    } finally {
      await resolved.close();
    }
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: DB stamped for another workspace → fails hard, outbox stays empty', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  const foreign = tmp('resolve-foreign-');
  try {
    w = await setupPgWorkspace(h);
    // A second directory claims the same DB URL under a different UUID.
    const ws = { id: randomUUID(), name: 'intruder' };
    writePgConfig(foreign, ws);
    await assert.rejects(
      resolveOpsBackend(foreign, { env: w.env, files: w.store }),
      WorkspaceMismatchError,
    );
    assert.equal(outboxOf(foreign, ws.id).fold().entries.size, 0, 'known mismatch must not queue');
  } finally {
    rmSync(foreign, { recursive: true, force: true });
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: config-vs-DB tuple mismatch → fails hard, outbox stays empty', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    // Same workspace UUID, edited bucket in persistence.yaml.
    writePgConfig(w.cwd, { id: w.workspaceId, name: 'acme' }, { bucket: 'other-bucket' });
    await assert.rejects(resolvePg(w), WorkspaceMismatchError);
    assert.equal(
      [...outboxOf(w.cwd, w.workspaceId).fold().entries.values()].filter((e) => e.status === 'queued').length,
      0,
      'known mismatch must not queue',
    );
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: marker digest mismatch → fails hard, outbox stays empty', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    await w.store.del(WORKSPACE_MARKER_KEY);
    await w.store.put(WORKSPACE_MARKER_KEY, workspaceMarkerBody({ workspaceId: randomUUID(), name: 'evil' }));
    await assert.rejects(resolvePg(w), WorkspaceMismatchError);
    assert.equal(
      [...outboxOf(w.cwd, w.workspaceId).fold().entries.values()].filter((e) => e.status === 'queued').length,
      0,
    );
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: pg auth failure is a CONFIG error — fails hard, never degrades, nothing queued', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    // A role that exists but cannot log in: authentication (28000), not transport.
    const nologin = `ops_nologin_${h.suffix}`;
    h.roles.push(nologin);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(`CREATE ROLE ${nologin} NOLOGIN`);
    } finally {
      await root.end();
    }
    const badUrl = new URL(h.url);
    badUrl.username = nologin;
    badUrl.password = 'whatever';
    const badEnv = { ...w.env, ROSTER_OPS_URL: badUrl.toString() } as NodeJS.ProcessEnv;
    await assert.rejects(resolveOpsBackend(w.cwd, { env: badEnv, files: w.store }), (err) => {
      assert.ok(err instanceof RosterError, `expected a config error, got ${String(err)}`);
      assert.match(err.header, /authentication failed/);
      return true;
    });
    assert.equal(
      [...outboxOf(w.cwd, w.workspaceId).fold().entries.values()].filter((e) => e.status === 'queued').length,
      0,
      'auth misconfiguration must never queue writes',
    );
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: S3 AccessDenied at resolution is a CONFIG error — fails hard, never degrades, nothing queued', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    // The runtime marker GET (resolution-time verify) returns AccessDenied — an
    // IAM/policy misconfiguration, not a transport outage. Resolution must fail
    // hard (not degrade to a queue that can never drain).
    const denying = new DenyingFileStore(w.store);
    denying.denyGet = true;
    await assert.rejects(
      resolveOpsBackend(w.cwd, { env: w.env, files: denying }),
      (err) => {
        assert.ok(!(err instanceof BackendUnavailableError), 'AccessDenied is config, not an outage');
        assert.match((err as Error).message, /Access Denied|AccessDenied|access/i);
        return true;
      },
    );
    assert.equal(
      [...outboxOf(w.cwd, w.workspaceId).fold().entries.values()].length,
      0,
      'a permanent IAM failure must never queue writes',
    );
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve finding 2: an UNKNOWN object-store error at resolution fails closed — never degrades, nothing queued', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    // The runtime marker GET throws a bare, un-coded error (schema/programming
    // shaped). Resolution must fail CLOSED — never queue toward a target a bug
    // will never let a write reach.
    const failing = new DenyingFileStore(w.store);
    failing.unknownGet = true;
    await assert.rejects(
      resolveOpsBackend(w.cwd, { env: w.env, files: failing }),
      (err) => {
        assert.ok(!(err instanceof BackendUnavailableError), 'an unknown error is not a transport outage');
        assert.match((err as Error).message, /unexpected error from the ops object store|failing closed/i);
        return true;
      },
    );
    assert.equal(
      [...outboxOf(w.cwd, w.workspaceId).fold().entries.values()].length,
      0,
      'an unknown failure must never queue writes',
    );
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('writeThrough preflight: marker GET returning AccessDenied AFTER resolution refuses the write (no PG commit)', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    const denying = new DenyingFileStore(w.store);
    const resolved = await resolveOpsBackend(w.cwd, { env: w.env, files: denying });
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state !== 'postgres-s3') return;
    try {
      // Healthy resolution done; now the marker GET starts denying (IAM drift).
      denying.denyGet = true;
      await assert.rejects(
        resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k1', type: 'step', data: null }),
        (err) => {
          assert.ok(!(err instanceof BackendUnavailableError), 'a denied preflight must not silently degrade');
          return true;
        },
      );
      // Refused BEFORE any delivery: nothing committed to PG.
      const probe = new pg.Client({ connectionString: h.url });
      await probe.connect();
      try {
        const n = await probe.query(`SELECT count(*)::int AS n FROM roster_ops.delivery_ledger`);
        assert.equal((n.rows[0] as { n: number }).n, 0, 'no PG commit across the AccessDenied preflight');
      } finally {
        await probe.end();
      }
      // The record sits durably queued, unpoisoned; restoring access heals it.
      const queued = [...resolved.outbox.fold().entries.values()].filter((e) => e.status === 'queued');
      assert.equal(queued.length, 1);
      assert.ok(queued.every((e) => e.failure === null));
      denying.denyGet = false;
      const healed = await resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k2', type: 'step', data: null });
      assert.equal(healed.outcome, 'committed');
    } finally {
      await resolved.close();
    }
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('writeThrough preflight finding 3: a marker GET transport blip (ECONNRESET) queues the write silently — NO PG commit for a DB-only record', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    const flaky = new DenyingFileStore(w.store);
    const resolved = await resolveOpsBackend(w.cwd, { env: w.env, files: flaky });
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state !== 'postgres-s3') return;
    try {
      // Healthy resolution done; the marker GET now transport-fails (a blip).
      flaky.transportGet = true;
      // #318 R4 finding 3: runs.appendEvent's delivery only touches Postgres
      // (which is UP). If the marker preflight silently swallowed the transport
      // failure, the PG row would commit with the marker UNVERIFIED. It must
      // instead QUEUE — silently (round-2: transport ⇒ queue, never a hard
      // error), and never commit a row while the marker went unverified.
      const res = await resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k1', type: 'step', data: null });
      assert.equal(res.outcome, 'queued', 'transport-unverified marker ⇒ silent queue, not a commit');
      const probe = new pg.Client({ connectionString: h.url });
      await probe.connect();
      try {
        const n = await probe.query(`SELECT count(*)::int AS n FROM roster_ops.delivery_ledger`);
        assert.equal((n.rows[0] as { n: number }).n, 0, 'NO PG commit while the marker went unverified on transport');
      } finally {
        await probe.end();
      }
      const queued = [...resolved.outbox.fold().entries.values()].filter((e) => e.status === 'queued');
      assert.equal(queued.length, 1, 'the record sits durably queued');
      assert.ok(queued.every((e) => e.failure === null && e.attempts === 0), 'a transport skip consumes nothing');
      // Restoring connectivity heals: the queued write drains and commits.
      flaky.transportGet = false;
      const healed = await resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k2', type: 'step', data: null });
      assert.equal(healed.outcome, 'committed');
      // One run 'r1', both events committed (the queued k1 drained + the new k2).
      assert.deepEqual(await resolved.backend.runs.count(), { committed: 1, queued: 0, partial: false });
      const run = await resolved.backend.runs.getRun('r1');
      assert.equal(run?.events.length, 2, 'both the previously-queued and the new event committed');
    } finally {
      await resolved.close();
    }
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('writeThrough preflight: a marker swapped AFTER resolution refuses the write before any delivery; restoring it heals', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    const resolved = await resolvePg(w);
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state !== 'postgres-s3') return;
    try {
      const original = await w.store.get(WORKSPACE_MARKER_KEY);
      assert.ok(original !== null);
      // Swap the bucket marker underneath the already-resolved backend.
      await w.store.del(WORKSPACE_MARKER_KEY);
      await w.store.put(WORKSPACE_MARKER_KEY, workspaceMarkerBody({ workspaceId: randomUUID(), name: 'evil' }));

      // Ordinary store writeThrough (NOT the drain helper) must refuse.
      await assert.rejects(
        resolved.backend.runs.appendEvent({ runId: 'r1', dedupeKey: 'k1', type: 'step', data: null }),
        WorkspaceMismatchError,
      );
      const bytes = randomBytes(64);
      await assert.rejects(
        resolved.backend.artifacts.putArtifact(
          { filename: 'x.bin', contentType: 'application/octet-stream', runId: null },
          bytes,
        ),
        WorkspaceMismatchError,
      );
      // Refused BEFORE any delivery: no object bytes, no ledger rows — the
      // records sit durably queued, unpoisoned.
      assert.equal(await w.store.get(`artifacts/${sha256Hex(bytes)}`), null, 'no object delivery across the mismatch');
      const probe = new pg.Client({ connectionString: h.url });
      await probe.connect();
      try {
        const n = await probe.query(`SELECT count(*)::int AS n FROM roster_ops.delivery_ledger`);
        assert.equal((n.rows[0] as { n: number }).n, 0, 'nothing delivered to the database either');
      } finally {
        await probe.end();
      }
      const queued = [...resolved.outbox.fold().entries.values()].filter((e) => e.status === 'queued');
      assert.equal(queued.length, 2);
      assert.ok(queued.every((e) => e.failure === null), 'a semantic halt never poisons the queue');

      // Restoring the rightful marker heals: the next write drains everything.
      await w.store.del(WORKSPACE_MARKER_KEY);
      await w.store.put(WORKSPACE_MARKER_KEY, original.body);
      const healed = await resolved.backend.runs.appendEvent({
        runId: 'r1',
        dedupeKey: 'k2',
        type: 'step',
        data: null,
      });
      assert.equal(healed.outcome, 'committed');
      assert.deepEqual(await resolved.backend.runs.count(), { committed: 1, queued: 0, partial: false });
      const retried = await resolved.backend.artifacts.putArtifact(
        { filename: 'x.bin', contentType: 'application/octet-stream', runId: null },
        bytes,
      );
      assert.equal(retried.outcome, 'committed', 'the queued artifact drains after the heal');
      const art = await resolved.backend.artifacts.getArtifact(sha256Hex(bytes));
      assert.ok(art !== null && art.bytes.equals(bytes));
      assert.equal(art.record.queued, false);
      assert.ok(await w.store.get(`artifacts/${sha256Hex(bytes)}`), 'bytes delivered object-first after the heal');
    } finally {
      await resolved.close();
    }
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('drainOutbox: delivers queued entries after revalidating binding + marker', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    const resolved = await resolvePg(w);
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state !== 'postgres-s3') return;
    try {
      // Queue an entry directly (as a degraded session would have).
      const input = hitlInput({ title: 'queued offline' });
      const { hitlRequestParts } = await import('../src/lib/persistence/postgres/stores.ts');
      const parts = hitlRequestParts(w.workspaceId, input);
      resolved.outbox.enqueue({ namespace: 'hitl', id: parts.id, kind: 'hitl-request', payload: parts.payload });

      const report = await drainOutbox(resolved);
      assert.equal(report.namespaces.hitl?.delivered, 1);
      const count = await resolved.backend.hitl.count();
      assert.deepEqual(count, { committed: 1, queued: 0, partial: false });

      // Swap the marker → the drain path revalidates and refuses before I/O.
      const parts2 = hitlRequestParts(w.workspaceId, hitlInput({ title: 'second', action: 'other-action' }));
      resolved.outbox.enqueue({ namespace: 'hitl', id: parts2.id, kind: 'hitl-request', payload: parts2.payload });
      await w.store.del(WORKSPACE_MARKER_KEY);
      await w.store.put(WORKSPACE_MARKER_KEY, workspaceMarkerBody({ workspaceId: randomUUID(), name: 'evil' }));
      await assert.rejects(drainOutbox(resolved), WorkspaceMismatchError);
      const fold = resolved.outbox.fold();
      assert.equal(
        [...fold.entries.values()].filter((e) => e.status === 'queued').length,
        1,
        'the refused drain must leave the entry queued, undelivered',
      );
    } finally {
      await resolved.close();
    }
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: degraded workspace heals — queued entry drains once connectivity returns', pgOpts, async () => {
  const h = await makeDb();
  let w: PgWorkspace | null = null;
  try {
    w = await setupPgWorkspace(h);
    // Offline session: unreachable runtime URL → degraded → spooled write.
    const offlineEnv = { ...w.env, ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv;
    const offline = await resolveOpsBackend(w.cwd, { env: offlineEnv, files: w.store });
    assert.equal(offline.state, 'degraded');
    if (offline.state !== 'degraded') return;
    const queued = await offline.backend.hitl.createRequest(hitlInput({ title: 'offline write' }));
    assert.equal(queued.outcome, 'queued');

    // Connectivity restored: resolve healthy, drain, observe the commit.
    const healthy = await resolvePg(w);
    assert.equal(healthy.state, 'postgres-s3');
    if (healthy.state !== 'postgres-s3') return;
    try {
      const report = await drainOutbox(healthy);
      assert.equal(report.namespaces.hitl?.delivered, 1);
      const got = await healthy.backend.hitl.getRequest(queued.id);
      assert.ok(got !== null);
      assert.equal(got.title, 'offline write');
    } finally {
      await healthy.close();
    }
  } finally {
    if (w) rmSync(w.cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('resolve: gitignore rule is present in a set-up workspace', async () => {
  const cwd = tmp('resolve-gitignore-');
  try {
    await runSetup({ cwd, backend: 'local', name: 'acme' });
    const gitignore = readFileSync(join(cwd, '.gitignore'), 'utf8');
    assert.ok(gitignore.split('\n').some((l) => l.trim() === '/.roster/ops/'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
