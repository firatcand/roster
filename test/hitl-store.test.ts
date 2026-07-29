import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  canonicalJson,
  sha256Hex,
  type Cursor,
  type HitlRequestInput,
  type HitlStore,
  type HitlWriteOutcome,
} from '../src/lib/persistence/contracts.ts';
import {
  canAuthorizeExecution,
  classifyAction,
  deriveRequestState,
  packetHashOf,
  requestIdOf,
  requestKeyOf,
  targetHashOf,
  validateApproval,
  type HitlDecisionRow,
  type HitlVersionRow,
} from '../src/lib/persistence/hitl-machine.ts';
import {
  DEFAULT_HITL_EXPIRY_POLICY,
  HITL_INLINE_MAX_BYTES,
  finalizeSubmissionPlan,
  resolveExpiry,
  systemExpiryId,
  type HitlExpiryPolicy,
} from '../src/lib/persistence/hitl-store.ts';
import { sweepExpired, maybeSweep, resetSweepThrottle } from '../src/lib/persistence/hitl-sweep.ts';
import { createLocalBackend, type LocalOpsBackend } from '../src/lib/persistence/local/stores.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import { HITL_VERSION_KIND, hitlVersionRecordId } from '../src/lib/persistence/hitl-local-records.ts';
import { LocalOutbox } from '../src/lib/persistence/outbox.ts';
import { runOpsMigrations } from '../src/lib/persistence/postgres/migrate.ts';
import { BoundPool, finalizeBinding, stampPending } from '../src/lib/persistence/postgres/binding.ts';
import { applyRecord, createPgBackend, type PgOpsBackend } from '../src/lib/persistence/postgres/stores.ts';
import { CreateOnlyFileStore, workspaceMarkerSha256 } from '../src/lib/persistence/objects.ts';
import { MemoryFileStore } from '../src/lib/persistence/s3-core.ts';

// #319 stage 2: the HITL state machine as the STORES implement it — versioning,
// sealed generations, authority, expiry sweeping, cross-group supersession, the
// fail-closed live-store posture, and local↔postgres projection parity.
//
// Clocks: the postgres projection and the decision trigger evaluate expiry
// against the DB's own clock_timestamp(), so every clock here tracks real time.
// Expiry cases are driven by choosing an `expiresAt` relative to Date.now(),
// never by rewinding a fake clock the database cannot see.

const OPS_ADMIN_URL = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const PG_SKIP: string | false = OPS_ADMIN_URL.length > 0 ? false : 'ROSTER_OPS_TEST_ADMIN_URL not set';
const pgOpts = { skip: PG_SKIP };
const HOUR = 60 * 60 * 1000;

function input(overrides: Partial<HitlRequestInput> = {}): HitlRequestInput {
  const base: HitlRequestInput = {
    functionName: 'growth',
    title: 'Approve the launch post',
    action: 'publish-post',
    target: 'x.com/roster',
    contentHash: '',
    body: 'the draft body',
    // D1: an expectation is mandatory. `null` is the honest default for a
    // fixture that has not read a head; `submit()` supplies the real one.
    expectedHead: null,
    ...overrides,
  };
  return { ...base, contentHash: overrides.contentHash ?? sha256Hex(base.body) };
}

// ---------- harnesses ----------

// A stored row in the backend's OWN shape, carrying an identity a well-behaved
// store never writes: a functionName that is absent, empty, or not a string
// (`functionName: undefined` here means "the key is absent"). Postgres keeps the
// caller's payload jsonb verbatim and derives functionName at read; the local
// ledger stores the derived field — so this is the one seam where the two
// backends' identity normalization can drift apart.
type SeedIdentityRow = { target: string; functionName: unknown; channel: 'inline' | 'ref' };

// A v2-shaped row written straight into the backend's own storage: the ONE way
// to observe an effectively-expired head whose durable `expired` decision has
// not been materialized yet, because every store write runs the throttled sweep
// behind it.
type ExpiredSeed = {
  functionName: string;
  title: string;
  action: string;
  target: string;
  body: string;
  expiresAt: number;
};

type Harness = {
  hitl: HitlStore;
  workspaceId: string;
  cleanup: () => Promise<void>;
  seedStoredIdentity: (row: SeedIdentityRow) => Promise<void>;
  // The #318 v1 request record, exactly as the shipped v1 writer produced it.
  seedLegacyV1: (id: string, payload: Record<string, unknown>) => Promise<void>;
  seedExpiredHead: (row: ExpiredSeed) => Promise<string>;
};

// The identity a seeded row must carry, derived exactly the way the store
// derives it, so the row is indistinguishable from one the store wrote.
function seedIdentityFields(
  workspaceId: string,
  r: ExpiredSeed,
): { requestKey: string; requestId: string; actionKind: ReturnType<typeof classifyAction>; contentHash: string; packetHash: string } {
  const requestKey = requestKeyOf(r);
  const contentHash = sha256Hex(r.body);
  const actionKind = classifyAction(r.action);
  return {
    requestKey,
    requestId: requestIdOf(workspaceId, requestKey),
    actionKind,
    contentHash,
    packetHash: packetHashOf({
      action: r.action,
      actionKind,
      target: r.target,
      contentHash,
      payloadRef: null,
      expiresAt: r.expiresAt,
      canonicalizationVersion: 1,
      title: r.title,
    } as never),
  };
}

const SEED_ACTION = 'publish-post';
const SEED_BODY = 'the seeded body';

function withFunctionName(base: Record<string, unknown>, functionName: unknown): Record<string, unknown> {
  return functionName === undefined ? base : { ...base, functionName };
}

// The identity a normalizing backend must derive for a degenerate row: the key
// is computed over the 'unknown' sentinel, never over the raw value.
function seededIdentity(workspaceId: string, target: string): { requestKey: string; requestId: string } {
  const requestKey = requestKeyOf({ functionName: 'unknown', action: SEED_ACTION, target });
  return { requestKey, requestId: requestIdOf(workspaceId, requestKey) };
}

function seededPacketHash(target: string, expiresAt: number, contentHash: string): string {
  return packetHashOf({
    action: SEED_ACTION,
    actionKind: classifyAction(SEED_ACTION),
    target,
    contentHash,
    payloadRef: null,
    expiresAt,
    canonicalizationVersion: 1,
    title: 'seeded',
  } as never);
}

type HarnessOptions = { hitlExpiry?: HitlExpiryPolicy; now?: () => number };

function localHarness(opts: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'roster-hitl-local-'));
  const workspaceId = randomUUID();
  const opsRoot = join(dir, '.roster', 'ops');
  const clock = { t: Date.now() };
  const backend: LocalOpsBackend = createLocalBackend({
    opsRoot,
    workspaceId,
    now: opts.now ?? (() => ++clock.t),
    ...(opts.hitlExpiry === undefined ? {} : { hitlExpiry: opts.hitlExpiry }),
  });
  const seedLedger = () => new LocalLedger({ opsRoot, workspaceId });
  return {
    hitl: backend.hitl,
    workspaceId,
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
    seedStoredIdentity: async (row) => {
      const { requestKey, requestId } = seededIdentity(workspaceId, row.target);
      const contentHash = sha256Hex(SEED_BODY);
      const expiresAt = Date.now() + 6 * HOUR;
      seedLedger().append('hitl', {
        id: hitlVersionRecordId(workspaceId, requestId, 1, 1),
        kind: HITL_VERSION_KIND,
        payload: withFunctionName(
          {
            requestId,
            requestKey,
            generation: 1,
            version: 1,
            title: 'seeded',
            action: SEED_ACTION,
            actionKind: classifyAction(SEED_ACTION),
            target: row.target,
            targetHash: targetHashOf(row.target),
            packetHash: seededPacketHash(row.target, expiresAt, contentHash),
            canonicalizationVersion: 1,
            contentHash,
            body: row.channel === 'inline' ? SEED_BODY : null,
            payloadRef:
              row.channel === 'inline'
                ? null
                : {
                    digest: contentHash,
                    size: Buffer.byteLength(SEED_BODY),
                    mediaType: 'text/plain; charset=utf-8',
                    uri: null,
                    objectVersionId: null,
                  },
            expiresAt,
            summary: null,
            warnings: null,
            sideEffects: null,
            choices: null,
            originRunId: null,
            originTaskId: null,
            requestingAgent: null,
            sanitizedSummary: null,
            supersedes: null,
          },
          row.functionName,
        ),
      });
    },
    seedLegacyV1: async (id, payload) => {
      seedLedger().append('hitl', { id, kind: 'hitl-request', payload });
    },
    seedExpiredHead: async (r) => {
      const f = seedIdentityFields(workspaceId, r);
      seedLedger().append('hitl', {
        id: hitlVersionRecordId(workspaceId, f.requestId, 1, 1),
        kind: HITL_VERSION_KIND,
        payload: {
          requestId: f.requestId,
          requestKey: f.requestKey,
          generation: 1,
          version: 1,
          functionName: r.functionName,
          title: r.title,
          action: r.action,
          actionKind: f.actionKind,
          target: r.target,
          targetHash: targetHashOf(r.target),
          packetHash: f.packetHash,
          canonicalizationVersion: 1,
          contentHash: f.contentHash,
          body: r.body,
          payloadRef: null,
          expiresAt: r.expiresAt,
          summary: null,
          warnings: null,
          sideEffects: null,
          choices: null,
          originRunId: null,
          originTaskId: null,
          requestingAgent: null,
          sanitizedSummary: null,
          supersedes: null,
        },
      });
      return f.requestId;
    },
  };
}

type PgHarness = Harness & { pool: BoundPool; backend: PgOpsBackend; db: string };

async function rootQuery(sql: string): Promise<void> {
  const { default: pg } = await import('pg');
  const root = new pg.Client({ connectionString: OPS_ADMIN_URL });
  await root.connect();
  try {
    await root.query(sql);
  } finally {
    await root.end();
  }
}

async function pgHarness(opts: HarnessOptions = {}): Promise<PgHarness> {
  const { default: pg } = await import('pg');
  const workspaceId = randomUUID();
  const db = `hitl_store_${randomUUID().slice(0, 8)}${Date.now().toString(36)}`;
  await rootQuery(`CREATE DATABASE ${db}`);
  const url = new URL(OPS_ADMIN_URL);
  url.pathname = '/' + db;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
  try {
    await runOpsMigrations(admin);
    await stampPending(admin, {
      workspaceId,
      workspaceName: 'hitl',
      objects: {
        bucket: 'hitl-ops',
        region: null,
        endpoint: null,
        forcePathStyle: false,
        markerSha256: workspaceMarkerSha256({ workspaceId, name: 'hitl' }),
      },
    });
    await finalizeBinding(admin, { workspaceId });
  } finally {
    await admin.end();
  }
  const pool = new BoundPool({ connectionString: url.toString(), workspaceId, max: 6 });
  const backend = createPgBackend({
    pool,
    objects: new CreateOnlyFileStore(new MemoryFileStore()),
    ...(opts.hitlExpiry === undefined ? {} : { hitlExpiry: opts.hitlExpiry }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  let seeded = 0;
  return {
    hitl: backend.hitl,
    backend,
    pool,
    workspaceId,
    db,
    seedStoredIdentity: async (row) => {
      const contentHash = sha256Hex(SEED_BODY);
      const expiresAt = Date.now() + 6 * HOUR;
      seeded += 1;
      // v1-SHAPED: no request_key / action_kind / canonicalization_version, so
      // the fill trigger derives them and re-keys the id — the same path a
      // migrated #318 row travels. The payload jsonb keeps the raw identity.
      await pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, target, content_hash, payload, payload_ref,
            packet_hash, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, $3, $4, $5, $6::jsonb, $7::jsonb, $8, 'awaiting', $9, $10)`,
        [
          `seed-${seeded}`,
          workspaceId,
          SEED_ACTION,
          row.target,
          contentHash,
          row.channel === 'inline'
            ? JSON.stringify(withFunctionName({ title: 'seeded', body: SEED_BODY }, row.functionName))
            : null,
          row.channel === 'ref'
            ? JSON.stringify({
                digest: contentHash,
                size: Buffer.byteLength(SEED_BODY),
                mediaType: 'text/plain; charset=utf-8',
                uri: null,
                objectVersionId: null,
                meta: withFunctionName({ title: 'seeded' }, row.functionName),
              })
            : null,
          seededPacketHash(row.target, expiresAt, contentHash),
          Date.now(),
          expiresAt,
        ],
      );
    },
    seedLegacyV1: async (id, payload) => {
      const canonical = canonicalJson(payload);
      const client = await pool.connect();
      try {
        await applyRecord(client, {
          namespace: 'hitl',
          kind: 'hitl-request',
          id,
          workspaceId,
          payload,
          canonical,
          payloadHash: sha256Hex(canonical),
          producerId: null,
          producerSeq: null,
          createdAt: Date.now(),
        });
      } finally {
        client.release();
      }
    },
    seedExpiredHead: async (r) => {
      const f = seedIdentityFields(workspaceId, r);
      await pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, $3, $4, $5, $6, $7, $8, 1, $9, $10::jsonb, 'awaiting', $11, $12)`,
        [
          f.requestId,
          workspaceId,
          r.action,
          f.actionKind,
          r.target,
          targetHashOf(r.target),
          f.packetHash,
          f.requestKey,
          f.contentHash,
          JSON.stringify({ functionName: r.functionName, title: r.title, body: r.body }),
          r.expiresAt - 6 * HOUR,
          r.expiresAt,
        ],
      );
      return f.requestId;
    },
    cleanup: async () => {
      await pool.end().catch(() => {});
      await rootQuery(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    },
  };
}

type Factory = { name: string; skip: string | false; create: (opts?: HarnessOptions) => Promise<Harness> };
const factories: Factory[] = [
  { name: 'local', skip: false, create: async (opts) => localHarness(opts) },
  { name: 'postgres-s3', skip: PG_SKIP, create: async (opts) => await pgHarness(opts) },
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A well-behaved client: read the current head, then submit against it. D1
// makes `expectedHead` mandatory precisely so a caller cannot skip this step —
// an approval can land between a read and a write, and only the fingerprint
// (including `sealed`) can tell.
function fingerprintOf(env: {
  generation: number;
  version: number;
  packetHash: string;
  sealed: boolean;
}): { generation: number; version: number; packetHash: string; sealed: boolean } {
  return {
    generation: env.generation,
    version: env.version,
    packetHash: env.packetHash,
    sealed: env.sealed,
  };
}

async function submitTo(
  store: HitlStore,
  workspaceId: string,
  overrides: Partial<HitlRequestInput> = {},
): Promise<HitlWriteOutcome> {
  const req = input(overrides);
  if ('expectedHead' in overrides) return await store.createRequest(req);
  const id = requestIdOf(workspaceId, requestKeyOf(req));
  const head = await store.getRequest(id);
  return await store.createRequest({ ...req, expectedHead: head === null ? null : fingerprintOf(head) });
}

function submit(
  h: { hitl: HitlStore; workspaceId: string },
  overrides: Partial<HitlRequestInput> = {},
): Promise<HitlWriteOutcome> {
  return submitTo(h.hitl, h.workspaceId, overrides);
}

// ---------- backend-agnostic behavior ----------

for (const factory of factories) {
  const t = (name: string) => `hitl[${factory.name}]: ${name}`;

  test(t('ANY packet-field change opens a new version; an identical packet is idempotent'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const first = await submit(h, { expiresAt, summary: 'ship it' });
      assert.deepEqual([first.generation, first.version, first.idempotent], [1, 1, false]);

      const same = await submit(h, { expiresAt, summary: 'ship it' });
      assert.deepEqual([same.generation, same.version, same.idempotent], [1, 1, true]);

      // Every approval-visible field is in the packet hash — including the ones
      // a naive identity would have ignored.
      const mutations: Partial<HitlRequestInput>[] = [
        { body: 'a different draft' },
        { summary: 'ship it now' },
        { warnings: ['this posts publicly'] },
        { sideEffects: { publishes: true } },
        { choices: ['now', 'later'] },
        { expiresAt: expiresAt + 1000 },
      ];
      let expected = 1;
      for (const mutation of mutations) {
        expected += 1;
        const out = await submit(h, { expiresAt, summary: 'ship it', ...mutation });
        assert.equal(out.requestId, first.requestId, `${JSON.stringify(mutation)} must stay in the same group`);
        assert.equal(out.version, expected, `${JSON.stringify(mutation)} must open a new version`);
        assert.equal(out.generation, 1);
      }
      const versions = await h.hitl.listVersions(first.requestId);
      assert.equal(versions.length, expected);
      assert.equal(new Set(versions.map((v) => v.packetHash)).size, expected, 'every version has its own packet hash');
      // Only the head is actionable — the superseded versions are gone from the queue.
      assert.deepEqual(await h.hitl.count(), { committed: 1, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('approve seals the generation AND is authoritative; a same-key resubmit opens generation 2'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const first = await submit(h, { expiresAt });
      await h.hitl.appendDecision({
        requestId: first.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'approved',
        decidedBy: 'firat',
        note: null,
      });
      const approved = await h.hitl.getRequest(first.requestId);
      assert.ok(approved !== null);
      assert.equal(approved.status, 'approved');
      assert.equal(approved.sealed, true, 'a terminal decision seals the generation');
      assert.equal(approved.authoritative, true, 'a sealed APPROVED head is exactly the execute-now case (D1)');
      assert.equal(approved.terminalStatus, 'approved');

      // A sealed generation accepts no further decision.
      await assert.rejects(
        h.hitl.appendDecision({
          requestId: first.requestId,
          generation: 1,
          requestVersion: 1,
          status: 'rejected',
          decidedBy: 'firat',
          note: null,
        }),
        ConflictError,
      );

      // The same key submitted again opens an INDEPENDENT generation.
      const second = await submit(h, { expiresAt, body: 'a follow-up ask' });
      assert.deepEqual([second.generation, second.version], [2, 1]);
      const head = await h.hitl.getRequest(first.requestId);
      assert.ok(head !== null);
      assert.equal(head.generation, 2);
      assert.equal(head.status, 'awaiting', 'authority NEVER falls back to the approved generation 1');
      assert.equal(head.authoritative, false);
      const generations = await h.hitl.listGenerations(first.requestId);
      assert.deepEqual(
        generations.map((g) => [g.generation, g.status, g.sealed]),
        [[1, 'approved', true], [2, 'awaiting', false]],
      );
    } finally {
      await h.cleanup();
    }
  });

  test(t('D1: a caller that observed a sealed G1 cannot silently mint G3 after an intervening G2'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const g1 = await submit(h, { expiresAt });
      await h.hitl.appendDecision({
        requestId: g1.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'approved',
        decidedBy: 'a',
        note: null,
      });
      const observedByB = await h.hitl.getRequest(g1.requestId);
      assert.ok(observedByB !== null);
      // Caller A opens + seals G2 while B is still holding its G1 observation.
      const g2 = await submit(h, { expiresAt, body: 'A opens g2' });
      assert.equal(g2.generation, 2);
      await h.hitl.appendDecision({
        requestId: g1.requestId,
        generation: 2,
        requestVersion: 1,
        status: 'rejected',
        decidedBy: 'a',
        note: null,
      });
      // B submits against the head it saw → Conflict, not a silent G3.
      await assert.rejects(
        h.hitl.createRequest(
          input({
            expiresAt,
            body: 'B never saw g2',
            expectedHead: fingerprintOf(observedByB),
          }),
        ),
        ConflictError,
      );
      const generations = await h.hitl.listGenerations(g1.requestId);
      assert.equal(generations.length, 2, 'no third generation was minted');
    } finally {
      await h.cleanup();
    }
  });

  test(t('deferred stays actionable and non-terminal; a duplicate deferred is refused'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const req = await submit(h, { expiresAt });
      await h.hitl.appendDecision({
        requestId: req.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'deferred',
        decidedBy: 'firat',
        note: 'later',
      });
      const head = await h.hitl.getRequest(req.requestId);
      assert.ok(head !== null);
      assert.equal(head.status, 'deferred');
      assert.equal(head.deferred, true);
      assert.equal(head.sealed, false);
      assert.deepEqual(await h.hitl.count(), { committed: 1, queued: 0, partial: false }, 'deferred stays in the queue');
      const listed = await h.hitl.listRequests({});
      assert.deepEqual(listed.items.map((i) => i.status), ['deferred']);

      await assert.rejects(
        h.hitl.appendDecision({
          requestId: req.requestId,
          generation: 1,
          requestVersion: 1,
          status: 'deferred',
          decidedBy: 'firat',
          note: 'later again',
        }),
        ConflictError,
      );
      // ...but a terminal decision on a deferred head is still allowed.
      await h.hitl.appendDecision({
        requestId: req.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'rejected',
        decidedBy: 'firat',
        note: null,
      });
      const done = await h.hitl.getRequest(req.requestId);
      assert.equal(done!.status, 'rejected');
      assert.deepEqual(await h.hitl.count(), { committed: 0, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('a decision must name the CURRENT head version'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const v1 = await submit(h, { expiresAt });
      const v2 = await submit(h, { expiresAt, body: 'revised' });
      assert.equal(v2.version, 2);
      await assert.rejects(
        h.hitl.appendDecision({
          requestId: v1.requestId,
          generation: 1,
          requestVersion: 1,
          status: 'approved',
          decidedBy: 'firat',
          note: null,
        }),
        ConflictError,
      );
      const ok = await h.hitl.appendDecision({
        requestId: v1.requestId,
        generation: 1,
        requestVersion: 2,
        status: 'approved',
        decidedBy: 'firat',
        note: null,
      });
      assert.equal(ok.outcome, 'committed');
    } finally {
      await h.cleanup();
    }
  });

  test(t('replaces: a cross-group edit cancels the source head atomically'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const source = await submit(h, { expiresAt, target: 'x.com/old' });
      const sourceHead = await h.hitl.getRequest(source.requestId);
      assert.ok(sourceHead !== null);
      const dest = await h.hitl.replaces({
        sourceRequestId: source.requestId,
        sourceExpectedHead: fingerprintOf(sourceHead),
        request: input({ expiresAt, target: 'x.com/new', expectedHead: null }),
      });
      assert.notEqual(dest.requestId, source.requestId);
      assert.deepEqual([dest.generation, dest.version], [1, 1]);

      const superseded = await h.hitl.getRequest(source.requestId);
      assert.ok(superseded !== null);
      assert.equal(superseded.superseded, true, 'the source head is pointed at by a live supersession row');
      assert.equal(superseded.authoritative, false);
      // ...and it is no longer decidable.
      await assert.rejects(
        h.hitl.appendDecision({
          requestId: source.requestId,
          generation: 1,
          requestVersion: 1,
          status: 'approved',
          decidedBy: 'firat',
          note: null,
        }),
        ConflictError,
      );
      const destVersions = await h.hitl.listVersions(dest.requestId);
      assert.deepEqual(destVersions[0]!.supersedes, {
        requestId: source.requestId,
        generation: 1,
        version: 1,
      });

      // A stale source expectation is refused before anything is written.
      const other = await submit(h, { expiresAt, target: 'x.com/third' });
      await assert.rejects(
        h.hitl.replaces({
          sourceRequestId: other.requestId,
          sourceExpectedHead: { generation: 9, version: 9, packetHash: sha256Hex('nope'), sealed: false },
          request: input({ expiresAt, target: 'x.com/fourth', expectedHead: null }),
        }),
        ConflictError,
      );
      assert.equal(await h.hitl.getRequest(sha256Hex('x.com/fourth')), null);
    } finally {
      await h.cleanup();
    }
  });

  test(t('replaces refuses a same-key target (that is a revision, not a supersession)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const req = await submit(h, { expiresAt });
      const head = await h.hitl.getRequest(req.requestId);
      await assert.rejects(
        h.hitl.replaces({
          sourceRequestId: req.requestId,
          sourceExpectedHead: fingerprintOf(head!),
          request: input({ expiresAt, body: 'edited', expectedHead: null }),
        }),
        InvalidRecordError,
      );
    } finally {
      await h.cleanup();
    }
  });

  // R7 finding: `replaces` read the SOURCE head but only ever materialized an
  // expired DESTINATION's expiry, so replacing an ALREADY-EXPIRED source closed
  // it with no durable `expired` decision — and closed it forever: a superseded
  // head is excluded from both backends' expiry-candidate scans and the decision
  // trigger refuses every decision on it, so listDecisions stayed empty and the
  // audit trail claimed "replaced while open" about a request that had expired
  // first.
  test(t('R7: replaces materializes an effectively-expired SOURCE expiry before superseding it'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const sourceId = await h.seedExpiredHead({
        functionName: 'growth',
        title: 'Approve the launch post',
        action: 'publish-post',
        target: 'x.com/old',
        body: 'the draft body',
        expiresAt: Date.now() - 1000,
      });
      const sourceHead = await h.hitl.getRequest(sourceId);
      assert.deepEqual(
        [sourceHead!.status, sourceHead!.terminalStatus, sourceHead!.superseded],
        ['expired', null, false],
        'effectively expired, nothing materialized, not yet replaced',
      );

      const dest = await h.hitl.replaces({
        sourceRequestId: sourceId,
        sourceExpectedHead: fingerprintOf(sourceHead!),
        request: input({ expiresAt: Date.now() + 6 * HOUR, target: 'x.com/new', expectedHead: null }),
      });
      assert.deepEqual([dest.generation, dest.version], [1, 1]);

      assert.deepEqual(
        (await h.hitl.listDecisions(sourceId)).map((d) => [d.generation, d.requestVersion, d.status, d.decidedBy]),
        [[1, 1, 'expired', 'system']],
        'the expiry the supersession would otherwise have erased is durable',
      );
      const replaced = await h.hitl.getRequest(sourceId);
      assert.deepEqual(
        [replaced!.status, replaced!.terminalStatus, replaced!.superseded, replaced!.authoritative],
        ['expired', 'expired', true, false],
      );
      const destHead = await h.hitl.getRequest(dest.requestId);
      assert.deepEqual([destHead!.status, destHead!.superseded], ['awaiting', false]);
      // Nothing is left for a later sweep, and the durable decision stays ONE.
      await sweepExpired(h.hitl, Date.now());
      assert.equal((await h.hitl.listDecisions(sourceId)).length, 1);

      // The regression guard: a LIVE source takes no expiry decision at all.
      const live = await submit(h, { expiresAt: Date.now() + 6 * HOUR, target: 'x.com/live' });
      const liveHead = await h.hitl.getRequest(live.requestId);
      await h.hitl.replaces({
        sourceRequestId: live.requestId,
        sourceExpectedHead: fingerprintOf(liveHead!),
        request: input({ expiresAt: Date.now() + 6 * HOUR, target: 'x.com/live-2', expectedHead: null }),
      });
      assert.deepEqual(await h.hitl.listDecisions(live.requestId), []);
    } finally {
      await h.cleanup();
    }
  });

  // The sibling case: both heads owe an expiry, and both must get one — in one
  // stated order (sorted request_key, the same order the two group locks are
  // taken in), before the destination row that closes the source lands.
  test(t('R7: replaces with BOTH heads effectively expired materializes both durable expiries'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const seed = {
        functionName: 'growth',
        title: 'Approve the launch post',
        action: 'publish-post',
        body: 'the draft body',
        expiresAt: Date.now() - 1000,
      };
      const sourceId = await h.seedExpiredHead({ ...seed, target: 'x.com/old' });
      const destId = await h.seedExpiredHead({ ...seed, target: 'x.com/new' });
      const sourceHead = await h.hitl.getRequest(sourceId);
      const destHead = await h.hitl.getRequest(destId);
      assert.deepEqual(
        [sourceHead!.status, sourceHead!.terminalStatus, destHead!.status, destHead!.terminalStatus],
        ['expired', null, 'expired', null],
      );

      const out = await h.hitl.replaces({
        sourceRequestId: sourceId,
        sourceExpectedHead: fingerprintOf(sourceHead!),
        request: input({
          expiresAt: Date.now() + 6 * HOUR,
          target: 'x.com/new',
          body: 'the replacement draft',
          expectedHead: fingerprintOf(destHead!),
        }),
      });
      assert.deepEqual([out.requestId, out.generation, out.version], [destId, 2, 1]);
      for (const id of [sourceId, destId]) {
        assert.deepEqual(
          (await h.hitl.listDecisions(id)).map((d) => [d.generation, d.requestVersion, d.status]),
          [[1, 1, 'expired']],
          `${id} must carry exactly one durable expiry`,
        );
      }
      assert.equal((await h.hitl.getRequest(sourceId))!.superseded, true);
      assert.equal((await h.hitl.getRequest(destId))!.generation, 2);
    } finally {
      await h.cleanup();
    }
  });

  test(t('the content hash is verified SERVER-SIDE (the caller hex is checked, not trusted)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      await assert.rejects(
        h.hitl.createRequest({
          functionName: 'growth',
          title: 'T',
          action: 'publish-post',
          target: 'x.com/roster',
          contentHash: sha256Hex('some other content'),
          body: 'the real body',
          expiresAt: Date.now() + 6 * HOUR,
          expectedHead: null,
        }),
        InvalidRecordError,
      );
      assert.deepEqual(await h.hitl.count(), { committed: 0, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('a body over the inline cap is offloaded to the object store and read back by its recorded reference'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const body = 'x'.repeat(HITL_INLINE_MAX_BYTES + 1024);
      const out = await submit(h, { body, expiresAt: Date.now() + 6 * HOUR });
      const head = await h.hitl.getRequest(out.requestId);
      assert.ok(head !== null);
      assert.ok(head.payloadRef !== null, 'an oversized body becomes a payload reference');
      assert.equal(head.payloadRef.digest, sha256Hex(body));
      assert.equal(head.payloadRef.size, Buffer.byteLength(body, 'utf8'));
      assert.equal(head.body, body, 'getRequest materializes the referenced bytes');
      // The listing deliberately does NOT fan out into object reads.
      const listed = await h.hitl.listRequests({});
      assert.equal(listed.items[0]!.body, null);
      assert.ok(listed.items[0]!.payloadRef !== null);
      // The reference (including its version handle) is inside the packet hash.
      const replay = await submit(h, { body, expiresAt: head.expiresAt });
      assert.equal(replay.idempotent, true);
    } finally {
      await h.cleanup();
    }
  });

  test(t('actionable listing/count exclude decided heads and include deferred ones'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const a = await submit(h, { target: 'a', expiresAt });
      const b = await submit(h, { target: 'b', expiresAt });
      const c = await submit(h, { target: 'c', expiresAt });
      await h.hitl.appendDecision({ requestId: a.requestId, generation: 1, requestVersion: 1, status: 'approved', decidedBy: 'x', note: null });
      await h.hitl.appendDecision({ requestId: b.requestId, generation: 1, requestVersion: 1, status: 'deferred', decidedBy: 'x', note: null });
      assert.deepEqual(await h.hitl.count(), { committed: 2, queued: 0, partial: false });
      const actionable = new Set((await h.hitl.listRequests({})).items.map((i) => i.id));
      assert.deepEqual(actionable, new Set([b.requestId, c.requestId]));
      // An explicit status filter reaches the decided history.
      const approved = await h.hitl.listRequests({ status: 'approved' });
      assert.deepEqual(approved.items.map((i) => i.id), [a.requestId]);
      assert.deepEqual(await h.hitl.count({ status: 'approved' }), { committed: 1, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('listDecisions returns the append-only decision history across generations'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const req = await submit(h, { expiresAt });
      await h.hitl.appendDecision({ requestId: req.requestId, generation: 1, requestVersion: 1, status: 'deferred', decidedBy: 'x', note: 'later' });
      await h.hitl.appendDecision({ requestId: req.requestId, generation: 1, requestVersion: 1, status: 'changes-requested', decidedBy: 'x', note: null, feedback: 'tighten the hook' });
      await submit(h, { expiresAt, body: 'v2 after changes-requested' });
      const decisions = await h.hitl.listDecisions(req.requestId);
      assert.deepEqual(
        decisions.map((d) => [d.generation, d.requestVersion, d.status, d.terminal]),
        [[1, 1, 'deferred', false], [1, 1, 'changes-requested', true]],
      );
      assert.equal(decisions[1]!.feedback, 'tighten the hook');
      // changes-requested is terminal on the version → the continuation is a new
      // GENERATION (owner decision 4 + sealed generations).
      const head = await h.hitl.getRequest(req.requestId);
      assert.equal(head!.generation, 2);
    } finally {
      await h.cleanup();
    }
  });
}

// ---------- expiry (drives real deadlines, so only a fast local clock) ----------

function localWithClock(nowRef: { t: number }): {
  hitl: HitlStore;
  workspaceId: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'roster-hitl-exp-'));
  const workspaceId = randomUUID();
  const backend = createLocalBackend({
    opsRoot: join(dir, '.roster', 'ops'),
    workspaceId,
    now: () => nowRef.t,
  });
  return { hitl: backend.hitl, workspaceId, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('expiry: an un-swept expired head is never awaiting, actionable, or authoritative', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    const req = await submit(h, { expiresAt });
    assert.deepEqual(await h.hitl.count(), { committed: 1, queued: 0, partial: false });

    // Time passes; NOTHING sweeps.
    nowRef.t = expiresAt + 1;
    const head = await h.hitl.getRequest(req.requestId);
    assert.ok(head !== null);
    assert.equal(head.status, 'expired', 'the projection is sweep-INDEPENDENT');
    assert.equal(head.terminalStatus, null, 'no durable decision exists yet');
    assert.equal(head.sealed, true);
    assert.equal(head.authoritative, false);
    assert.deepEqual(await h.hitl.count(), { committed: 0, queued: 0, partial: false });
    assert.deepEqual((await h.hitl.listRequests({})).items, []);
    // ...and it cannot take a user decision either.
    await assert.rejects(
      h.hitl.appendDecision({ requestId: req.requestId, generation: 1, requestVersion: 1, status: 'approved', decidedBy: 'x', note: null }),
      ConflictError,
    );
  } finally {
    h.cleanup();
  }
});

test('expiry: the sweep materializes exactly one durable decision and is idempotent under concurrency', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    const req = await submit(h, { expiresAt });
    nowRef.t = expiresAt + 1;

    const [a, b] = await Promise.all([
      sweepExpired(h.hitl, nowRef.t),
      sweepExpired(h.hitl, nowRef.t),
    ]);
    assert.equal(a.expired + b.expired, 1, 'exactly one sweep writes the decision');
    assert.equal(a.conflicts + b.conflicts, 1, 'the loser reports a conflict, never an error');

    const decisions = await h.hitl.listDecisions(req.requestId);
    assert.deepEqual(decisions.map((d) => [d.status, d.decidedBy]), [['expired', 'system']]);
    assert.equal(decisions[0]!.id, systemExpiryId(decisions[0]!.workspaceId, req.requestId, 1, 1));

    // A third sweep is a clean no-op — the candidate set is now empty.
    const third = await sweepExpired(h.hitl, nowRef.t);
    assert.deepEqual(third, { expired: 0, conflicts: 0, remaining: false });
    // The head's observable status is unchanged by materialization.
    const head = await h.hitl.getRequest(req.requestId);
    assert.equal(head!.status, 'expired');
    assert.equal(head!.terminalStatus, 'expired');
  } finally {
    h.cleanup();
  }
});

test('expiry: a NEW generation opening over an unswept expired head materializes gen-N expiry in the same write', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    const g1 = await submit(h, { expiresAt });
    nowRef.t = expiresAt + 1;
    // No sweep has run. Submitting the same key opens generation 2...
    const g2 = await submit(h, { expiresAt: nowRef.t + 2 * HOUR, body: 'a fresh ask' });
    assert.deepEqual([g2.generation, g2.version], [2, 1]);
    // ...and generation 1's expiry is durable, not hidden behind it.
    const decisions = await h.hitl.listDecisions(g1.requestId);
    assert.deepEqual(decisions.map((d) => [d.generation, d.requestVersion, d.status]), [[1, 1, 'expired']]);
    const generations = await h.hitl.listGenerations(g1.requestId);
    assert.deepEqual(generations.map((g) => [g.generation, g.status]), [[1, 'expired'], [2, 'awaiting']]);
    // A later sweep finds nothing to do — exactly ONE durable expired decision.
    const sweep = await sweepExpired(h.hitl, nowRef.t);
    assert.equal(sweep.expired, 0);
    assert.equal((await h.hitl.listDecisions(g1.requestId)).length, 1);
  } finally {
    h.cleanup();
  }
});

test('expiry: the sweep is bounded and paginates; correctness never depends on it having run', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    for (let i = 0; i < 5; i++) await submit(h, { target: `t${i}`, expiresAt });
    nowRef.t = expiresAt + 1;
    // Correctness first: with ZERO sweeps every request is already out of the
    // actionable queue. (An explicit status filter is used because the ACTIONABLE
    // list/count deliberately trigger the throttled sweep.)
    assert.deepEqual((await h.hitl.listRequests({ status: 'awaiting' })).items, []);
    assert.deepEqual(await h.hitl.count({ status: 'awaiting' }), { committed: 0, queued: 0, partial: false });
    assert.equal((await h.hitl.listExpiryCandidates(nowRef.t, 100)).length, 5, 'nothing has been materialized yet');

    const first = await sweepExpired(h.hitl, nowRef.t, { limit: 2 });
    assert.deepEqual([first.expired, first.remaining], [2, true]);
    const second = await sweepExpired(h.hitl, nowRef.t, { limit: 2 });
    assert.deepEqual([second.expired, second.remaining], [2, true]);
    const third = await sweepExpired(h.hitl, nowRef.t, { limit: 2 });
    assert.deepEqual([third.expired, third.remaining], [1, false]);
    assert.deepEqual(await sweepExpired(h.hitl, nowRef.t, { limit: 2 }), { expired: 0, conflicts: 0, remaining: false });
    await assert.rejects(sweepExpired(h.hitl, nowRef.t, { limit: 0 }), InvalidRecordError);
  } finally {
    h.cleanup();
  }
});

test('maybeSweep throttles per process and never propagates a sweep failure', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    await submit(h, { expiresAt });
    nowRef.t = expiresAt + 1;
    const first = await maybeSweep(h.hitl, nowRef.t);
    assert.equal(first?.expired, 1);
    assert.equal(await maybeSweep(h.hitl, nowRef.t + 100), null, 'inside the throttle window it is a no-op');
    resetSweepThrottle(h.hitl);
    assert.notEqual(await maybeSweep(h.hitl, nowRef.t + 100), null);

    const broken: HitlStore = {
      ...h.hitl,
      listExpiryCandidates: async () => {
        throw new Error('store down');
      },
    } as HitlStore;
    assert.equal(await maybeSweep(broken, nowRef.t), null, 'a sweep is never load-bearing');
  } finally {
    h.cleanup();
  }
});

test('the actionable list/count and every mutating verb run the throttled sweep', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    await submit(h, { expiresAt });
    nowRef.t = expiresAt + 1;
    resetSweepThrottle(h.hitl);
    // A point read does NOT sweep (it is not the actionable queue)...
    const id = (await h.hitl.listExpiryCandidates(nowRef.t, 10))[0]!.requestId;
    await h.hitl.getRequest(id);
    assert.equal((await h.hitl.listExpiryCandidates(nowRef.t, 10)).length, 1);
    // ...the actionable count does.
    await h.hitl.count();
    assert.deepEqual(await h.hitl.listExpiryCandidates(nowRef.t, 10), []);
    assert.deepEqual((await h.hitl.listDecisions(id)).map((d) => d.status), ['expired']);

    // A mutating verb sweeps too.
    const second = await submit(h, { target: 'other', expiresAt: nowRef.t + 2 * HOUR });
    nowRef.t += 3 * HOUR;
    resetSweepThrottle(h.hitl);
    await submit(h, { target: 'third', expiresAt: nowRef.t + 2 * HOUR });
    assert.deepEqual((await h.hitl.listDecisions(second.requestId)).map((d) => d.status), ['expired']);
  } finally {
    h.cleanup();
  }
});

// ---------- projection parity ----------

test('parity: the postgres request_state view and the local deriveRequestState agree on a generated history', pgOpts, async () => {
  const pg = await pgHarness();
  const localDir = mkdtempSync(join(tmpdir(), 'roster-hitl-parity-'));
  try {
    const localWs = randomUUID();
    const local = createLocalBackend({
      opsRoot: join(localDir, '.roster', 'ops'),
      workspaceId: localWs,
      now: () => Date.now(),
    });
    // One script, applied identically to both backends. The request IDs differ
    // (they are workspace-scoped) but every PROJECTED field must agree — that is
    // the point of one shared machine with a SQL mirror.
    type Step =
      | { op: 'submit'; body: string }
      | { op: 'decide'; status: 'approved' | 'rejected' | 'deferred' | 'changes-requested' };
    const script: Step[] = [
      { op: 'submit', body: 'v1' },
      { op: 'submit', body: 'v2' },
      { op: 'decide', status: 'deferred' },
      { op: 'submit', body: 'v3' },
      { op: 'decide', status: 'changes-requested' },
      { op: 'submit', body: 'g2v1' },
      { op: 'decide', status: 'deferred' },
      { op: 'decide', status: 'approved' },
      { op: 'submit', body: 'g3v1' },
      { op: 'submit', body: 'g3v2' },
      { op: 'decide', status: 'rejected' },
      { op: 'submit', body: 'g4v1' },
    ];
    const expiresAt = Date.now() + 6 * HOUR;
    let localId = '';
    let pgId = '';
    let at = { generation: 1, version: 1 };
    for (const step of script) {
      if (step.op === 'submit') {
        const a = await submitTo(local.hitl, localWs, { expiresAt, body: step.body });
        const b = await submit(pg, { expiresAt, body: step.body });
        assert.deepEqual(
          [a.generation, a.version, a.idempotent],
          [b.generation, b.version, b.idempotent],
          `submit ${step.body}`,
        );
        localId = a.requestId;
        pgId = b.requestId;
        at = { generation: a.generation, version: a.version };
        continue;
      }
      const decision = { ...at, requestVersion: at.version, status: step.status, decidedBy: 'firat', note: null };
      await local.hitl.appendDecision({ requestId: localId, ...decision });
      await pg.hitl.appendDecision({ requestId: pgId, ...decision });
    }

    const projected = (e: { generation: number; version: number; status: string; nodeStatus: string; terminalStatus: string | null; deferred: boolean; sealed: boolean; superseded: boolean; authoritative: boolean; actionKind: string; canonicalizationVersion: number; packetHash: string; targetHash: string; requestKey: string }) => ({
      generation: e.generation,
      version: e.version,
      status: e.status,
      nodeStatus: e.nodeStatus,
      terminalStatus: e.terminalStatus,
      deferred: e.deferred,
      sealed: e.sealed,
      superseded: e.superseded,
      authoritative: e.authoritative,
      actionKind: e.actionKind,
      canonicalizationVersion: e.canonicalizationVersion,
      packetHash: e.packetHash,
      targetHash: e.targetHash,
      requestKey: e.requestKey,
    });
    const localHead = await local.hitl.getRequest(localId);
    const pgHead = await pg.hitl.getRequest(pgId);
    assert.ok(localHead !== null && pgHead !== null);
    assert.deepEqual(projected(localHead), projected(pgHead), 'the head projection must be identical');

    assert.deepEqual(
      (await local.hitl.listGenerations(localId)).map((g) => [g.generation, g.versions, g.headVersion, g.status, g.sealed]),
      (await pg.hitl.listGenerations(pgId)).map((g) => [g.generation, g.versions, g.headVersion, g.status, g.sealed]),
    );
    assert.deepEqual(
      (await local.hitl.listVersions(localId)).map((v) => [v.generation, v.version, v.packetHash]),
      (await pg.hitl.listVersions(pgId)).map((v) => [v.generation, v.version, v.packetHash]),
    );
    assert.deepEqual(
      (await local.hitl.listDecisions(localId)).map((d) => [d.generation, d.requestVersion, d.status, d.terminal]),
      (await pg.hitl.listDecisions(pgId)).map((d) => [d.generation, d.requestVersion, d.status, d.terminal]),
    );
    assert.deepEqual(await local.hitl.count(), await pg.hitl.count(), 'actionable counts agree');
    // A terminal decision DOMINATES a later non-terminal row on the same version
    // (the deferred that preceded the approval in generation 2).
    const g2 = (await local.hitl.listGenerations(localId)).find((g) => g.generation === 2)!;
    assert.deepEqual([g2.status, g2.sealed], ['approved', true]);
  } finally {
    rmSync(localDir, { recursive: true, force: true });
    await pg.cleanup();
  }
});

// ---------- postgres-only: the DB is the backstop ----------

test('pg: two concurrent terminal decisions on one version produce exactly one winner', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const req = await submit(h, { expiresAt: Date.now() + 6 * HOUR });
    const decide = (status: 'approved' | 'rejected') =>
      h.hitl.appendDecision({
        requestId: req.requestId,
        generation: 1,
        requestVersion: 1,
        status,
        decidedBy: `${status}-decider`,
        note: null,
      });
    const results = await Promise.allSettled([decide('approved'), decide('rejected')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one decision commits');
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConflictError);
    const decisions = await h.hitl.listDecisions(req.requestId);
    assert.equal(decisions.filter((d) => d.terminal).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('pg: two concurrent live revisions of one head → one wins, the other conflicts synchronously', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const expiresAt = Date.now() + 6 * HOUR;
    const base = await submit(h, { expiresAt });
    const head = await h.hitl.getRequest(base.requestId);
    assert.ok(head !== null);
    const expectedHead = fingerprintOf(head);
    const results = await Promise.allSettled([
      submit(h, { expiresAt, body: 'edit A', expectedHead }),
      submit(h, { expiresAt, body: 'edit B', expectedHead }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof ConflictError, 'the loser is refused SYNCHRONOUSLY, not queued');
    const versions = await h.hitl.listVersions(base.requestId);
    assert.equal(versions.length, 2, 'only one revision landed');
  } finally {
    await h.cleanup();
  }
});

test('pg: a BARE runtime INSERT cannot reopen a terminal version, decide a non-head, or invert an expiry', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const expiresAt = Date.now() + 6 * HOUR;
    const req = await submit(h, { expiresAt });
    await h.hitl.appendDecision({
      requestId: req.requestId,
      generation: 1,
      requestVersion: 1,
      status: 'approved',
      decidedBy: 'firat',
      note: null,
    });
    const rawDecision = (id: string, generation: number, version: number, status: string) =>
      h.pool.query(
        `INSERT INTO hitl.decisions (id, workspace_id, request_id, generation, request_version, status, payload, decided_at, created_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, '{}'::jsonb, $7, $7)`,
        [id, h.workspaceId, req.requestId, generation, version, status, Date.now()],
      );
    // prior terminal → the trigger RAISEs unique_violation (23505)
    await assert.rejects(rawDecision('raw-1', 1, 1, 'rejected'), (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23505');
      return /already carries the terminal decision/.test((err as Error).message);
    });
    // a version that does not exist → foreign_key_violation from the trigger
    await assert.rejects(rawDecision('raw-2', 1, 99, 'approved'), (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23503');
      return true;
    });
    // expiry direction: an `expired` decision before the deadline (23514)
    const fresh = await submit(h, { expiresAt, target: 'x.com/fresh' });
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.decisions (id, workspace_id, request_id, generation, request_version, status, payload, decided_at, created_at)
         VALUES ('raw-3', $1::uuid, $2, 1, 1, 'expired', '{}'::jsonb, $3, $3)`,
        [h.workspaceId, fresh.requestId, Date.now()],
      ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '23514');
        return /does not expire until/.test((err as Error).message);
      },
    );
  } finally {
    await h.cleanup();
  }
});

test('pg: the decision trigger REFUSES a higher isolation level (D4)', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const req = await submit(h, { expiresAt: Date.now() + 6 * HOUR });
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(
        client.query(
          `INSERT INTO hitl.decisions (id, workspace_id, request_id, generation, request_version, status, payload, decided_at, created_at)
           VALUES ('iso-1', $1::uuid, $2, 1, 1, 'approved', '{}'::jsonb, $3, $3)`,
          [h.workspaceId, req.requestId, Date.now()],
        ),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, 'P0001');
          return /READ COMMITTED/.test((err as Error).message);
        },
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    // ...while the store's own path (explicit READ COMMITTED) succeeds.
    const ok = await h.hitl.appendDecision({
      requestId: req.requestId,
      generation: 1,
      requestVersion: 1,
      status: 'approved',
      decidedBy: 'firat',
      note: null,
    });
    assert.equal(ok.outcome, 'committed');
  } finally {
    await h.cleanup();
  }
});

test('pg: request_index projects only sanitized text and validated digests', pgOpts, async () => {
  const h = await pgHarness();
  try {
    await h.hitl.createRequest(
      input({
        expiresAt: Date.now() + 6 * HOUR,
        summary: 'deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    );
    const res = await h.pool.query(`SELECT request_id, request_key, action, sanitized_summary FROM hitl.request_index`);
    const row = res.rows[0] as Record<string, string>;
    assert.match(row.request_id!, /^[0-9a-f]{64}$/);
    assert.match(row.request_key!, /^[0-9a-f]{64}$/);
    assert.equal(row.action, 'publish-post');
    assert.ok(!row.sanitized_summary!.includes('ghp_'), 'the secret never reaches the projection');
    assert.match(row.sanitized_summary!, /REDACTED/);
    // The raw target/body are NOT columns of the index view.
    const columns = await h.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'hitl' AND table_name = 'request_index'`,
    );
    const names = new Set((columns.rows as { column_name: string }[]).map((r) => r.column_name));
    assert.ok(!names.has('target'));
    assert.ok(!names.has('payload'));
    assert.ok(!names.has('summary'));
  } finally {
    await h.cleanup();
  }
});

// ---------- D7: the whole hitl namespace is non-spoolable ----------

test('D7: a direct hitl enqueue is refused at the outbox boundary (request AND decision)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-hitl-spool-'));
  try {
    const ledger = new LocalLedger({ opsRoot: join(dir, '.roster', 'ops'), workspaceId: randomUUID() });
    const outbox = new LocalOutbox({ ledger });
    assert.throws(
      () => outbox.enqueue({ namespace: 'hitl', id: 'r1', kind: 'hitl-request', payload: {} }),
      BackendUnavailableError,
    );
    assert.throws(
      () => outbox.enqueue({ namespace: 'hitl', id: 'd1', kind: 'hitl-decision', payload: {} }),
      BackendUnavailableError,
    );
    // ...and a made-up hitl kind is refused too — the guard is on the NAMESPACE.
    assert.throws(
      () => outbox.enqueue({ namespace: 'hitl', id: 'x1', kind: 'anything-at-all', payload: {} }),
      BackendUnavailableError,
    );
    assert.equal(outbox.fold().entries.size, 0, 'nothing HITL-shaped may become durable in the spool');
    // The spoolable namespaces are unaffected.
    assert.doesNotThrow(() => outbox.enqueue({ namespace: 'runs', id: 'e1', kind: 'run-event', payload: {} }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- R5 finding 1: the post-plan gate, hermetically ----------

test('R5-1: finalizeSubmissionPlan re-checks closure on the plan it UPGRADES', () => {
  const idempotent = { kind: 'idempotent', generation: 1, version: 1 } as const;
  const link = { requestId: 'src', generation: 1, version: 1 };
  const open = { generation: 1, version: 1, superseded: false };
  const closed = { generation: 1, version: 1, superseded: true };

  // No supersession requested: the plan passes through untouched, on an open
  // head AND on a superseded one (a no-write plan resurrects nothing).
  assert.deepEqual(finalizeSubmissionPlan(idempotent, open, null), idempotent);
  assert.deepEqual(finalizeSubmissionPlan(idempotent, closed, null), idempotent);

  // The link is already recorded — a genuine replay stays a no-op.
  assert.deepEqual(
    finalizeSubmissionPlan(idempotent, closed, { requested: link, recorded: { ...link } }),
    idempotent,
  );

  // The link is NOT recorded, so the no-write plan becomes a WRITE...
  assert.deepEqual(finalizeSubmissionPlan(idempotent, open, { requested: link, recorded: null }), {
    kind: 'revise',
    generation: 1,
    version: 2,
  });
  // ...and that upgraded write is exactly what permanent closure must refuse.
  const refused = finalizeSubmissionPlan(idempotent, closed, { requested: link, recorded: null });
  assert.equal(refused.kind, 'conflict');
  assert.equal((refused as { reason: string }).reason, 'superseded-head');

  // A plan that already WRITES is refused on a closed head whether or not a
  // supersession is in play (planSubmission also refuses it — this is the belt).
  for (const writing of [
    { kind: 'revise', generation: 1, version: 2 } as const,
    { kind: 'open-generation', generation: 2, version: 1 } as const,
  ]) {
    assert.equal(finalizeSubmissionPlan(writing, closed, null).kind, 'conflict');
    assert.deepEqual(finalizeSubmissionPlan(writing, open, null), writing);
  }

  // A conflict is never widened back into a write.
  const conflict = { kind: 'conflict', reason: 'stale-expected-head', detail: 'x' } as const;
  assert.deepEqual(finalizeSubmissionPlan(conflict, open, { requested: link, recorded: null }), conflict);
});

// ---------- expiry policy ----------

test('expiry policy: a per-request expiry is clamped to the bounds with a warning', () => {
  const now = 1_800_000_000_000;
  const policy = DEFAULT_HITL_EXPIRY_POLICY;
  const belowMin = resolveExpiry('execution', now + 60_000, policy, now);
  assert.equal(belowMin.expiresAt, now + policy.minTtlMs);
  assert.match(belowMin.warnings[0]!, /below the minimum TTL/);

  const aboveMax = resolveExpiry('execution', now + 30 * 24 * HOUR, policy, now);
  assert.equal(aboveMax.expiresAt, now + policy.maxTtlMs);
  assert.match(aboveMax.warnings[0]!, /above the maximum TTL/);

  const inBounds = resolveExpiry('execution', now + 6 * HOUR, policy, now);
  assert.equal(inBounds.expiresAt, now + 6 * HOUR);
  assert.deepEqual(inBounds.warnings, []);

  // An execution request ALWAYS ends up with an expiry (the DB CHECK demands it).
  const nulled = resolveExpiry('execution', null, policy, now);
  assert.equal(nulled.expiresAt, now + policy.defaultTtlMs);
  assert.match(nulled.warnings[0]!, /must expire/);
  // Editorial may stay open-ended.
  assert.deepEqual(resolveExpiry('editorial', null, policy, now), { expiresAt: null, warnings: [] });
  assert.equal(resolveExpiry('editorial', undefined, policy, now).expiresAt, null);
  assert.throws(() => resolveExpiry('execution', 1.5, policy, now), InvalidRecordError);
});

test('a configured expiry policy is honored by the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-hitl-policy-'));
  try {
    const nowRef = { t: Date.now() };
    const policyWs = randomUUID();
    const backend = createLocalBackend({
      opsRoot: join(dir, '.roster', 'ops'),
      workspaceId: policyWs,
      now: () => nowRef.t,
      hitlExpiry: { defaultTtlMs: 2 * HOUR, minTtlMs: HOUR, maxTtlMs: 4 * HOUR },
    });
    const out = await submitTo(backend.hitl, policyWs, { expiresAt: null });
    assert.match(out.warnings[0]!, /must expire/);
    const head = await backend.hitl.getRequest(out.requestId);
    assert.equal(head!.expiresAt, nowRef.t + 2 * HOUR, 'the configured default TTL, not the built-in 24h');
    const clamped = await submitTo(backend.hitl, policyWs, {
      target: 'other',
      expiresAt: nowRef.t + 10 * HOUR,
    });
    assert.match(clamped.warnings[0]!, /above the maximum TTL/);
    const clampedHead = await backend.hitl.getRequest(clamped.requestId);
    assert.equal(clampedHead!.expiresAt, nowRef.t + 4 * HOUR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- authority predicates over a store-derived head ----------

test('authority: an approval validated AFTER its expiry is refused; a matching one passes', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    const req = await submit(h, { expiresAt });
    await h.hitl.appendDecision({
      requestId: req.requestId,
      generation: 1,
      requestVersion: 1,
      status: 'approved',
      decidedBy: 'firat',
      note: null,
    });
    const head = await h.hitl.getRequest(req.requestId);
    assert.ok(head !== null);
    const versions: HitlVersionRow[] = [
      {
        requestId: head.id,
        requestKey: head.requestKey,
        generation: head.generation,
        version: head.version,
        action: head.action,
        actionKind: head.actionKind,
        target: head.target,
        targetHash: head.targetHash,
        packetHash: head.packetHash,
        canonicalizationVersion: head.canonicalizationVersion,
        expiresAt: head.expiresAt,
        createdAt: head.createdAt,
      },
    ];
    const decisions: HitlDecisionRow[] = [
      { id: 'd1', generation: 1, version: 1, status: 'approved', decidedAt: nowRef.t },
    ];
    const before = deriveRequestState(versions, decisions, nowRef.t);
    assert.equal(canAuthorizeExecution(before.head!, nowRef.t).authorized, true);
    const expectation = {
      action: head.action,
      actionKind: head.actionKind,
      target: head.target,
      targetHash: head.targetHash,
      packetHash: head.packetHash,
      canonicalizationVersion: head.canonicalizationVersion,
      expiresAt: head.expiresAt,
    };
    assert.equal(validateApproval(before.head!, expectation, nowRef.t).authorized, true);

    const after = deriveRequestState(versions, decisions, expiresAt + 1);
    const denial = validateApproval(after.head!, expectation, expiresAt + 1);
    assert.equal(denial.authorized, false);
    assert.equal(denial.authorized === false ? denial.reason : null, 'expired');
  } finally {
    h.cleanup();
  }
});

// ---------- round-1 review repros ----------

for (const factory of factories) {
  const t = (name: string) => `hitl[${factory.name}]: ${name}`;

  // Finding 1: the expected-head fingerprint must bind `sealed`, so an approval
  // that changes NOTHING ELSE is still an observable head change.
  test(t('R1: a sealing race is a synchronous Conflict, never a silent generation 2'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const created = await submit(h, { expiresAt, expectedHead: null });
      // Client B observes the OPEN head and composes its packet against it.
      const observed = await h.hitl.getRequest(created.requestId);
      assert.ok(observed !== null);
      assert.equal(observed.sealed, false);
      const staleFingerprint = fingerprintOf(observed);
      // Client A approves it. The ONLY field of the head that changes is `sealed`.
      await h.hitl.appendDecision({
        requestId: created.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'approved',
        decidedBy: 'a',
        note: null,
      });
      await assert.rejects(
        h.hitl.createRequest(
          input({ expiresAt, body: 'B never saw the approval', expectedHead: staleFingerprint }),
        ),
        ConflictError,
      );
      assert.equal(
        (await h.hitl.listGenerations(created.requestId)).length,
        1,
        'no generation 2 was minted behind the approval',
      );
      // Re-reading the head is what unblocks the caller.
      const refreshed = await h.hitl.getRequest(created.requestId);
      assert.equal(refreshed!.sealed, true);
      const opened = await h.hitl.createRequest(
        input({ expiresAt, body: 'B never saw the approval', expectedHead: fingerprintOf(refreshed!) }),
      );
      assert.deepEqual([opened.generation, opened.version], [2, 1]);
    } finally {
      await h.cleanup();
    }
  });

  // Finding 2: an idempotent DESTINATION packet must not let a replace report
  // success while the source approval is still authoritative.
  test(t('R2: replaces never succeeds while the source head stays authoritative'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const source = await submit(h, { expiresAt, target: 'x.com/old', expectedHead: null });
      await h.hitl.appendDecision({
        requestId: source.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'approved',
        decidedBy: 'firat',
        note: null,
      });
      const approved = await h.hitl.getRequest(source.requestId);
      assert.ok(approved !== null);
      assert.equal(approved.authoritative, true, 'the source approval starts authoritative');

      // The destination group ALREADY holds exactly the packet the replace asks for.
      const destPacket = input({ expiresAt, target: 'x.com/new' });
      const dest = await h.hitl.createRequest({ ...destPacket, expectedHead: null });
      const destHead = await h.hitl.getRequest(dest.requestId);
      assert.ok(destHead !== null);

      let refused = false;
      try {
        await h.hitl.replaces({
          sourceRequestId: source.requestId,
          sourceExpectedHead: fingerprintOf(approved),
          request: { ...destPacket, expectedHead: fingerprintOf(destHead) },
        });
      } catch (err) {
        refused = true;
        assert.ok(err instanceof ConflictError || err instanceof InvalidRecordError, String(err));
      }
      const after = await h.hitl.getRequest(source.requestId);
      assert.ok(after !== null);
      assert.equal(
        after.authoritative,
        false,
        'never "success + source authoritative": the replace either supersedes the source or fails',
      );
      if (!refused) {
        assert.equal(after.superseded, true, 'a successful replace records the supersession');
        // ...and re-running the identical replace is a true idempotent no-op.
        const again = await h.hitl.replaces({
          sourceRequestId: source.requestId,
          sourceExpectedHead: fingerprintOf(approved),
          request: { ...destPacket, expectedHead: fingerprintOf((await h.hitl.getRequest(dest.requestId))!) },
        });
        assert.equal(again.idempotent, true);
      }
    } finally {
      await h.cleanup();
    }
  });

  // Finding 8: every approval-VISIBLE field is packet identity.
  test(t('R8: title, origin ids and the requesting agent are packet identity'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const base = {
        expiresAt,
        title: 'Approve the launch post',
        originRunId: 'run-1',
        originTaskId: 'task-1',
        requestingAgent: 'sdr',
      };
      const first = await submit(h, { ...base, expectedHead: null });
      assert.deepEqual([first.generation, first.version], [1, 1]);
      const mutations: Partial<HitlRequestInput>[] = [
        { title: 'A different label' },
        { originRunId: 'run-2' },
        { originTaskId: 'task-2' },
        { requestingAgent: 'chief-of-staff' },
      ];
      let expected = 1;
      for (const mutation of mutations) {
        const head = await h.hitl.getRequest(first.requestId);
        expected += 1;
        const out = await h.hitl.createRequest(
          input({ ...base, ...mutation, expectedHead: fingerprintOf(head!) }),
        );
        assert.equal(out.requestId, first.requestId, `${JSON.stringify(mutation)} stays in the group`);
        assert.equal(out.version, expected, `${JSON.stringify(mutation)} must open a new version`);
      }
      const versions = await h.hitl.listVersions(first.requestId);
      assert.equal(
        new Set(versions.map((v) => v.packetHash)).size,
        expected,
        'every approval-visible mutation has its own packet hash',
      );
      // ...and the stored presentation follows the head, never a stale replay.
      const head = await h.hitl.getRequest(first.requestId);
      assert.equal(head!.requestingAgent, 'chief-of-staff');
    } finally {
      await h.cleanup();
    }
  });
}

// Finding 6: the state-machine clock must be read INSIDE the locked commit.
test('R6: an expiry that elapses during the payload offload is seen by the commit', async () => {
  const nowRef = { t: Date.now() };
  const h = localWithClock(nowRef);
  try {
    const expiresAt = nowRef.t + 2 * HOUR;
    // An oversized body makes prepareSubmission await the object offload, which
    // is exactly the window in which the pre-lock clock goes stale.
    const body = 'x'.repeat(HITL_INLINE_MAX_BYTES + 512);
    const g1 = await submit(h, { expiresAt, body, expectedHead: null });
    const head = await h.hitl.getRequest(g1.requestId);
    assert.ok(head !== null);
    assert.equal(head.sealed, false);

    nowRef.t = expiresAt - 1;
    const pending = h.hitl.createRequest(
      input({
        expiresAt: nowRef.t + 2 * HOUR,
        body: `${body}-edited`,
        expectedHead: { generation: 1, version: 1, packetHash: head.packetHash, sealed: false },
      }),
    );
    // The head expires WHILE the offload is in flight.
    nowRef.t = expiresAt + 1;
    await assert.rejects(pending, ConflictError, 'the commit must plan against the post-offload clock');
    assert.equal(
      (await h.hitl.listVersions(g1.requestId)).length,
      1,
      'an expired generation is never revised in place',
    );

    // Re-reading shows the sealed head; the next submit opens generation 2 AND
    // materializes generation 1's durable expiry.
    const refreshed = await h.hitl.getRequest(g1.requestId);
    assert.equal(refreshed!.sealed, true);
    const g2 = await h.hitl.createRequest(
      input({
        expiresAt: nowRef.t + 2 * HOUR,
        body: `${body}-edited`,
        expectedHead: {
          generation: refreshed!.generation,
          version: refreshed!.version,
          packetHash: refreshed!.packetHash,
          sealed: true,
        },
      }),
    );
    assert.deepEqual([g2.generation, g2.version], [2, 1]);
    assert.deepEqual(
      (await h.hitl.listDecisions(g1.requestId)).map((d) => [d.generation, d.requestVersion, d.status]),
      [[1, 1, 'expired']],
    );
  } finally {
    h.cleanup();
  }
});


// Finding 5: the pre-#319 outbox drain path must materialize the previous
// generation's durable expiry in the SAME locked transaction that opens G+1.
test('R5: a legacy spool entry draining after G1 expired materializes G1s expiry before opening G2', pgOpts, async () => {
  const h = await pgHarness();
  try {
    // G1 is seeded DIRECTLY (already past its deadline, nothing swept): the
    // store's own post-write sweep would otherwise materialize the expiry and
    // hide the drain path's obligation.
    const requestId = await h.seedExpiredHead({
      functionName: 'growth',
      title: 'Approve the launch post',
      action: 'publish-post',
      target: 'x.com/roster',
      body: 'the draft body',
      expiresAt: Date.now() - 1000,
    });
    const expired = await h.hitl.getRequest(requestId);
    assert.equal(expired!.status, 'expired', 'the head is effectively expired, with no durable decision yet');
    assert.equal(expired!.terminalStatus, null);
    const g1 = { requestId };

    // Exactly what a pre-#319 spool holds for this key.
    const payload = {
      functionName: 'growth',
      title: 'Approve the launch post',
      action: 'publish-post',
      target: 'x.com/roster',
      contentHash: sha256Hex('a queued legacy body'),
      body: 'a queued legacy body',
      expiresAt: Date.now() + 6 * HOUR,
      status: 'awaiting',
    };
    const canonical = canonicalJson(payload);
    const client = await h.pool.connect();
    try {
      await applyRecord(client, {
        namespace: 'hitl',
        kind: 'hitl-request',
        id: 'legacy-spool-1',
        workspaceId: h.workspaceId,
        payload,
        canonical,
        payloadHash: sha256Hex(canonical),
        producerId: null,
        producerSeq: null,
        createdAt: Date.now(),
      });
    } finally {
      client.release();
    }

    assert.deepEqual(
      (await h.hitl.listDecisions(g1.requestId)).map((d) => [d.generation, d.requestVersion, d.status]),
      [[1, 1, 'expired']],
      'exactly one durable expiry decision on generation 1',
    );
    assert.deepEqual(
      (await h.hitl.listGenerations(g1.requestId)).map((g) => [g.generation, g.status]),
      [[1, 'expired'], [2, 'awaiting']],
    );
  } finally {
    await h.cleanup();
  }
});

// R6 finding 2, the other half: the database now refuses an in-place revision of
// an EFFECTIVELY expired head (an unmaterialized expiry would otherwise be
// hidden by the new version forever). That rule must not touch a LEGAL store
// allocation — and it cannot, because the store never plans a revision against
// an expired head (`sealed` includes the clock) and materializes the expired
// head's durable decision in the SAME locked transaction before it inserts G+1,
// so the row the gate sees is governed by the durable-decision rule instead.
test('R6-2: the store still opens a generation over an effectively-expired head', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const seed = {
      functionName: 'growth',
      title: 'Approve the launch post',
      action: 'publish-post',
      body: 'the draft body',
      expiresAt: Date.now() - 1000,
    };
    const requestId = await h.seedExpiredHead({ ...seed, target: 'x.com/roster' });
    const head = await h.hitl.getRequest(requestId);
    assert.deepEqual(
      [head!.status, head!.terminalStatus, head!.sealed],
      ['expired', null, true],
      'effectively expired, nothing materialized',
    );

    // createRequest: the plan is open-generation, the expiry is materialized in
    // the same transaction, and G2 lands.
    const g2 = await submit(h, { body: 'a fresh ask' });
    assert.deepEqual([g2.generation, g2.version], [2, 1]);
    assert.deepEqual(
      (await h.hitl.listDecisions(requestId)).map((d) => [d.generation, d.requestVersion, d.status]),
      [[1, 1, 'expired']],
    );
    assert.deepEqual(
      (await h.hitl.listGenerations(requestId)).map((g) => [g.generation, g.status]),
      [[1, 'expired'], [2, 'awaiting']],
    );

    // replaces: same composition on the DESTINATION group, whose head is also an
    // unmaterialized expiry.
    const destId = await h.seedExpiredHead({ ...seed, target: 'x.com/dest' });
    const destHead = await h.hitl.getRequest(destId);
    const sourceHead = await h.hitl.getRequest(g2.requestId);
    const dest = await h.hitl.replaces({
      sourceRequestId: g2.requestId,
      sourceExpectedHead: fingerprintOf(sourceHead!),
      request: input({
        target: 'x.com/dest',
        body: 'the replacement draft',
        expectedHead: fingerprintOf(destHead!),
      }),
    });
    assert.deepEqual([dest.requestId, dest.generation, dest.version], [destId, 2, 1]);
    assert.deepEqual(
      (await h.hitl.listDecisions(destId)).map((d) => [d.generation, d.requestVersion, d.status]),
      [[1, 1, 'expired']],
      'the destination generation 1 expiry is durable before generation 2 opens',
    );
    assert.equal((await h.hitl.getRequest(g2.requestId))!.superseded, true);
  } finally {
    await h.cleanup();
  }
});

// R7, the raw-INSERT half. Allocation branch (c) validated only the supersession
// target's IDENTITY and its existing supersession state, so a direct INSERT
// could close an effectively-expired head with no durable expiry — the same
// permanent loss the store path had, reachable by anyone holding INSERT.
test('R7: a raw supersession pointer at an effectively-expired head is refused until that expiry is durable', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const sourceId = await h.seedExpiredHead({
      functionName: 'growth',
      title: 'Approve the launch post',
      action: 'publish-post',
      target: 'x.com/old',
      body: 'the draft body',
      expiresAt: Date.now() - 1000,
    });
    const destSeed: ExpiredSeed = {
      functionName: 'growth',
      title: 'Approve the launch post',
      action: 'publish-post',
      target: 'x.com/new',
      body: 'the replacement draft',
      expiresAt: Date.now() + 6 * HOUR,
    };
    const f = seedIdentityFields(h.workspaceId, destSeed);
    const rawSupersede = (): Promise<unknown> =>
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at,
            supersedes_request_id, supersedes_generation, supersedes_version)
         VALUES ($1, $2::uuid, 1, 1, $3, $4, $5, $6, $7, $8, 1, $9, $10::jsonb, 'awaiting', $11, $12, $13, 1, 1)`,
        [
          f.requestId,
          h.workspaceId,
          destSeed.action,
          f.actionKind,
          destSeed.target,
          targetHashOf(destSeed.target),
          f.packetHash,
          f.requestKey,
          f.contentHash,
          JSON.stringify({ functionName: destSeed.functionName, title: destSeed.title, body: destSeed.body }),
          Date.now(),
          destSeed.expiresAt,
          sourceId,
        ],
      );

    await assert.rejects(rawSupersede(), (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514');
      return /record its expiry decision/.test((err as Error).message);
    });
    assert.equal(await h.hitl.getRequest(f.requestId), null, 'nothing landed');
    assert.equal((await h.hitl.getRequest(sourceId))!.superseded, false);

    // Materialize exactly what the store would have written first, and the SAME
    // insert lands.
    await h.pool.query(
      `INSERT INTO hitl.decisions
         (id, workspace_id, request_id, generation, request_version, status, payload, decided_at, created_at)
       VALUES ($1, $2::uuid, $3, 1, 1, 'expired', '{}'::jsonb, $4, $4)`,
      [systemExpiryId(h.workspaceId, sourceId, 1, 1), h.workspaceId, sourceId, Date.now()],
    );
    await rawSupersede();
    assert.equal((await h.hitl.getRequest(sourceId))!.superseded, true);
    assert.deepEqual(
      (await h.hitl.listDecisions(sourceId)).map((d) => [d.generation, d.requestVersion, d.status]),
      [[1, 1, 'expired']],
    );
  } finally {
    await h.cleanup();
  }
});

// Finding 1 (contract): there is no "adopt whatever head you find" mode for a
// CALLER. A missing observation is a caller bug, refused before any lock.
test('R1: a submission without an expectedHead is refused (no adopt-whatever mode)', async () => {
  const h = localHarness();
  try {
    const req = input({ expiresAt: Date.now() + 6 * HOUR });
    delete (req as { expectedHead?: unknown }).expectedHead;
    await assert.rejects(h.hitl.createRequest(req), (err: unknown) => {
      assert.ok(err instanceof InvalidRecordError);
      return /expectedHead is required/.test((err as Error).message);
    });
    // ...and an expectation missing `sealed` is refused too: it cannot detect a
    // sealing race, which is the whole point of the fingerprint.
    const created = await submit(h, { expiresAt: Date.now() + 6 * HOUR });
    const head = await h.hitl.getRequest(created.requestId);
    await assert.rejects(
      h.hitl.createRequest(
        input({
          expiresAt: Date.now() + 6 * HOUR,
          body: 'edited',
          expectedHead: {
            generation: head!.generation,
            version: head!.version,
            packetHash: head!.packetHash,
          } as never,
        }),
      ),
      (err: unknown) => err instanceof InvalidRecordError && /sealed/.test((err as Error).message),
    );
    assert.deepEqual(await h.hitl.count(), { committed: 1, queued: 0, partial: false });
  } finally {
    await h.cleanup();
  }
});

// ---------- round-2 review repros ----------

// R2 finding 4: expiry ELIGIBILITY is decided by the database (clock_timestamp()
// through hitl.request_state), so the durable decision must be stamped by that
// same clock. Stamping it with a skewed application clock produced an audit
// record claiming the request expired at a moment it had not yet expired.
test('R2-4: a system expiry is stamped by the DB clock, never a skewed application clock', pgOpts, async () => {
  const skew = 2 * HOUR;
  const appNow = () => Date.now() - skew;
  const h = await pgHarness({ now: appNow });
  try {
    // DB clock: now. App clock: now - 2h. Expiry: now - 1h — expired for the
    // database (which selects the candidate), NOT yet for the application.
    const expiresAt = Date.now() - HOUR;
    const requestId = await h.seedExpiredHead({
      functionName: 'growth',
      title: 'Approve the launch post',
      action: 'publish-post',
      target: 'x.com/roster',
      body: 'the draft body',
      expiresAt,
    });
    const swept = await sweepExpired(h.hitl, appNow());
    assert.deepEqual([swept.expired, swept.conflicts], [1, 0]);

    const row = (
      await h.pool.query(
        `SELECT decided_at, created_at FROM hitl.decisions WHERE workspace_id = $1::uuid AND request_id = $2`,
        [h.workspaceId, requestId],
      )
    ).rows[0] as { decided_at: string; created_at: string };
    const decidedAt = Number(row.decided_at);
    assert.equal(Number(row.created_at), decidedAt, 'both audit stamps come from the same clock');
    assert.ok(
      decidedAt >= expiresAt,
      `the durable expiry must not be stamped BEFORE the deadline it records (stamped ${decidedAt}, deadline ${expiresAt})`,
    );
    assert.ok(
      decidedAt > appNow(),
      `the stamp must be the DB clock, not the caller's (stamped ${decidedAt}, app clock ${appNow()})`,
    );
    // ...and the projection still reports the durable decision, unchanged.
    const head = await h.hitl.getRequest(requestId);
    assert.deepEqual([head!.status, head!.terminalStatus], ['expired', 'expired']);
    // A second sweep converges on the same deterministic id rather than writing
    // a second (differently-stamped) row.
    const again = await sweepExpired(h.hitl, appNow());
    assert.deepEqual([again.expired, again.conflicts], [0, 0]);
    assert.equal((await h.hitl.listDecisions(requestId)).length, 1);
  } finally {
    await h.cleanup();
  }
});

// R4 finding 2: the postgres expiry POLICY ran on the application clock, while
// eligibility (hitl.request_state, the decision trigger) runs on the database's.
// Behind the DB clock, a default-TTL request was BORN expired; ahead of it, the
// expiry sailed past the DB-relative maximum the policy bounds promise.
test('R4-2: postgres expiry is resolved against the DATABASE clock in both skew directions', pgOpts, async () => {
  const DAY = 24 * HOUR;
  const packetOf = (env: { expiresAt: number | null }): string =>
    packetHashOf({
      action: 'publish-post',
      actionKind: classifyAction('publish-post'),
      target: 'x.com/roster',
      contentHash: sha256Hex('the draft body'),
      payloadRef: null,
      expiresAt: env.expiresAt,
      canonicalizationVersion: 1,
      title: 'Approve the launch post',
      summary: null,
      warnings: null,
      sideEffects: null,
      choices: null,
      originRunId: null,
      originTaskId: null,
      requestingAgent: null,
    });

  // App clock two days BEHIND the database.
  const behind = await pgHarness({ now: () => Date.now() - 2 * DAY });
  try {
    const out = await submitTo(behind.hitl, behind.workspaceId, {});
    const head = await behind.hitl.getRequest(out.requestId);
    assert.ok(head !== null);
    assert.equal(head.status, 'awaiting', 'a default-TTL request is never BORN expired');
    assert.ok(
      head.expiresAt !== null && head.expiresAt > Date.now(),
      `the expiry must be ahead of the DB clock (stored ${String(head.expiresAt)}, db now ~${Date.now()})`,
    );
    assert.equal(head.packetHash, packetOf(head), 'the stored packet hash covers the STORED expiry');
  } finally {
    await behind.cleanup();
  }

  // App clock ten days AHEAD of the database: both the default TTL and an
  // explicit request must stay inside the DB-relative 7-day maximum.
  const ahead = await pgHarness({ now: () => Date.now() + 10 * DAY });
  try {
    const max = () => Date.now() + DEFAULT_HITL_EXPIRY_POLICY.maxTtlMs;
    const defaulted = await submitTo(ahead.hitl, ahead.workspaceId, {});
    const defaultedHead = await ahead.hitl.getRequest(defaulted.requestId);
    assert.ok(
      defaultedHead!.expiresAt !== null && defaultedHead!.expiresAt <= max(),
      `the default TTL must not exceed the DB-relative maximum (stored ${String(defaultedHead!.expiresAt)}, max ~${max()})`,
    );
    assert.equal(defaultedHead!.packetHash, packetOf(defaultedHead!));

    const explicit = await submitTo(ahead.hitl, ahead.workspaceId, {
      target: 'x.com/explicit',
      expiresAt: Date.now() + 10 * DAY + 6 * HOUR,
      expectedHead: null,
    });
    const explicitHead = await ahead.hitl.getRequest(explicit.requestId);
    assert.ok(
      explicitHead!.expiresAt !== null && explicitHead!.expiresAt <= max(),
      `an explicit expiry is clamped against the DB clock (stored ${String(explicitHead!.expiresAt)}, max ~${max()})`,
    );
    assert.ok(
      explicit.warnings.some((w) => /maximum TTL/.test(w)),
      `the clamp is reported to the caller (warnings: ${JSON.stringify(explicit.warnings)})`,
    );
  } finally {
    await ahead.cleanup();
  }
});

// R2 finding 2 (parity): pagination must traverse every actionable request
// exactly once on BOTH backends, whatever physical ordering position the
// records happen to share.
for (const factory of factories) {
  test(`hitl[${factory.name}]: paginated listing reaches every actionable request exactly once`, { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const ids: string[] = [];
      for (const target of ['x.com/a', 'x.com/b', 'x.com/c']) {
        ids.push((await submit(h, { target, expiresAt })).requestId);
      }
      const seen: string[] = [];
      let cursor: Awaited<ReturnType<typeof h.hitl.listRequests>>['cursor'] = null;
      for (let page = 0; page < 6; page++) {
        const res = await h.hitl.listRequests({ limit: 1 }, cursor ?? undefined);
        seen.push(...res.items.map((i) => i.id));
        if (res.cursor === null) break;
        cursor = res.cursor;
      }
      assert.equal(new Set(seen).size, seen.length, 'no repeats');
      assert.deepEqual(seen.slice().sort(), ids.slice().sort());
    } finally {
      await h.cleanup();
    }
  });
}

// ---------- round-3 review repros ----------

// R3 finding 2 (parity): functionName has no column of its own — it rides in
// whichever content channel is live — so BOTH backends must derive it by the
// SAME rule (anything that is not a NON-EMPTY string is 'unknown'). Postgres
// kept the raw payload and compared it raw in the filter, so a migrated row
// with functionName 5 / '' / absent was invisible to the 'unknown' query that
// its own envelope told the caller to use.
for (const factory of factories) {
  const t = (name: string) => `hitl[${factory.name}]: ${name}`;

  test(t('R3-2: a degenerate stored functionName reads AND filters as `unknown`'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const rows: SeedIdentityRow[] = [
        { target: 'x.com/number', functionName: 5, channel: 'inline' },
        { target: 'x.com/empty', functionName: '', channel: 'inline' },
        { target: 'x.com/absent', functionName: undefined, channel: 'inline' },
        { target: 'x.com/ref', functionName: undefined, channel: 'ref' },
      ];
      for (const row of rows) await h.seedStoredIdentity(row);
      const ids = rows.map((r) => seededIdentity(h.workspaceId, r.target).requestId);

      const unknown = await h.hitl.listRequests({ functionName: 'unknown' });
      assert.deepEqual(
        unknown.items.map((i) => i.id).sort(),
        ids.slice().sort(),
        'every degenerate row is reachable through the sentinel its own envelope reports',
      );
      for (const item of unknown.items) assert.equal(item.functionName, 'unknown');
      assert.deepEqual(await h.hitl.count({ functionName: 'unknown' }), { committed: 4, queued: 0, partial: false });

      // The unfiltered actionable queue reports the same sentinel...
      const all = await h.hitl.listRequests({});
      assert.deepEqual(all.items.map((i) => i.functionName).sort(), ['unknown', 'unknown', 'unknown', 'unknown']);
      // ...and so does the single-request read.
      const one = await h.hitl.getRequest(ids[0]!);
      assert.equal(one!.functionName, 'unknown');

      // Filtering for the RAW stored value finds nothing: '5' and '' are not
      // identities, they are the absence of one.
      for (const raw of ['5', '']) {
        assert.deepEqual((await h.hitl.listRequests({ functionName: raw })).items, [], `raw filter '${raw}'`);
        assert.equal((await h.hitl.count({ functionName: raw })).committed, 0, `raw count '${raw}'`);
      }

      // A real functionName still filters exactly.
      await submit(h, { target: 'x.com/real', expiresAt: Date.now() + 6 * HOUR });
      const growth = await h.hitl.listRequests({ functionName: 'growth' });
      assert.deepEqual(growth.items.map((i) => i.functionName), ['growth']);
    } finally {
      await h.cleanup();
    }
  });

  // R3 finding 4 (parity): the watermark contract. Both backends projected each
  // group's LATEST head and then applied `seq <= watermark`, so revising a
  // request mid-traversal pushed its head PAST the watermark and the request
  // vanished from the whole listing — while a fresh listing found it.
  test(t('R3-4: a revision DURING pagination never hides an actionable request'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const ids: string[] = [];
      for (const target of ['x.com/p1', 'x.com/p2', 'x.com/p3']) {
        ids.push((await submit(h, { target, expiresAt })).requestId);
      }
      const seen: string[] = [];
      const first = await h.hitl.listRequests({ limit: 1 });
      seen.push(...first.items.map((i) => i.id));
      assert.equal(first.items.length, 1);
      assert.ok(first.cursor !== null);

      // A request that page one did NOT return is revised while the traversal
      // is in flight: same group, new head, new physical position.
      const revisedTarget = ['x.com/p1', 'x.com/p2', 'x.com/p3'].find(
        (target) => seededTargetId(h.workspaceId, target) !== seen[0],
      )!;
      const revised = await submit(h, { target: revisedTarget, expiresAt, body: 'a mid-traversal revision' });
      assert.equal(revised.version, 2);

      let cursor: Cursor | null = first.cursor;
      for (let page = 0; page < 8 && cursor !== null; page++) {
        const res: Awaited<ReturnType<typeof h.hitl.listRequests>> = await h.hitl.listRequests({ limit: 1 }, cursor);
        seen.push(...res.items.map((i) => i.id));
        cursor = res.cursor;
      }
      assert.equal(new Set(seen).size, seen.length, 'no repeats');
      assert.deepEqual(
        seen.slice().sort(),
        ids.slice().sort(),
        'a request that exists throughout the traversal appears exactly once',
      );
    } finally {
      await h.cleanup();
    }
  });

  // R3 finding 5 (parity): SQL accepts an EXISTING empty body whose stored hash
  // is sha256('') as verifiable; the local conversion demanded a non-empty body
  // and permanently marked the same row legacy (canonicalization 0 = never
  // authoritative). Verifiable is verifiable.
  test(t('R3-5: a legacy row with an empty but VERIFIABLE body converts as canonicalization 1'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      // BOTH legacy rows are seeded before the first store read: on the local
      // backend that read converts the ledger, and the format fence then
      // refuses any further v1-format append.
      await h.seedLegacyV1('legacy-empty-body', {
        functionName: 'growth',
        title: 'Approve the empty draft',
        action: SEED_ACTION,
        target: 'x.com/empty-body',
        contentHash: sha256Hex(''),
        body: '',
        expiresAt: Date.now() + 6 * HOUR,
        status: 'awaiting',
      });
      // ...while a body the stored hash does NOT cover stays legacy-exempt.
      await h.seedLegacyV1('legacy-mismatch', {
        functionName: 'growth',
        title: 'Approve the mismatched draft',
        action: SEED_ACTION,
        target: 'x.com/mismatch',
        contentHash: sha256Hex('what the approver never saw'),
        body: 'what the approver saw',
        expiresAt: Date.now() + 6 * HOUR,
        status: 'awaiting',
      });
      const verifiable = await h.hitl.getRequest(
        requestIdOf(h.workspaceId, requestKeyOf({ functionName: 'growth', action: SEED_ACTION, target: 'x.com/empty-body' })),
      );
      assert.ok(verifiable !== null);
      assert.equal(verifiable.canonicalizationVersion, 1, 'an empty body that hashes to its stored digest IS verified');

      const exempt = await h.hitl.getRequest(
        requestIdOf(h.workspaceId, requestKeyOf({ functionName: 'growth', action: SEED_ACTION, target: 'x.com/mismatch' })),
      );
      assert.equal(exempt!.canonicalizationVersion, 0);
    } finally {
      await h.cleanup();
    }
  });

  // ---------- round-4 review repros ----------

  // R4 finding 1a: a SUPERSEDED head can be resurrected by a stale-but-accurate
  // submission. `replaces` records the supersession on the DESTINATION row, so
  // the source head's own {generation, version, packetHash, sealed} fingerprint
  // is unchanged — a caller that read it before the replace still passes the
  // optimistic-concurrency check and its revision (or new generation) becomes a
  // head no supersession row points at: two authoritative approvals for what is
  // meant to be ONE superseded decision.
  test(t('R4-1a: a stale same-key submission can never resurrect a superseded group'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      // Caller B observes source S at generation 1 version 1...
      const source = await submit(h, { expiresAt, target: 'x.com/old', expectedHead: null });
      const observed = await h.hitl.getRequest(source.requestId);
      assert.ok(observed !== null);
      const staleFingerprint = fingerprintOf(observed);

      // ...caller A supersedes S with destination D...
      const dest = await h.hitl.replaces({
        sourceRequestId: source.requestId,
        sourceExpectedHead: staleFingerprint,
        request: input({ expiresAt, target: 'x.com/new', expectedHead: null }),
      });

      // ...and B now submits a same-key revision with its UNCHANGED fingerprint,
      // which is still an accurate description of S's head.
      await assert.rejects(
        h.hitl.createRequest(
          input({ expiresAt, target: 'x.com/old', body: 'a stale revision', expectedHead: staleFingerprint }),
        ),
        ConflictError,
      );
      assert.equal(
        (await h.hitl.listVersions(source.requestId)).length,
        1,
        'the superseded group never grew a version',
      );

      // Exactly ONE group is authoritative afterwards: the destination.
      await h.hitl.appendDecision({
        requestId: dest.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'approved',
        decidedBy: 'firat',
        note: null,
      });
      assert.equal((await h.hitl.getRequest(dest.requestId))!.authoritative, true);
      const stillSuperseded = await h.hitl.getRequest(source.requestId);
      assert.equal(stillSuperseded!.superseded, true);
      assert.equal(stillSuperseded!.authoritative, false);

      // The SEALED flavour of the same race: a terminal decision leaves the
      // fingerprint just as accurate, so the stale caller would open G+1 on a
      // head that was already replaced.
      const sealedSource = await submit(h, { expiresAt, target: 'x.com/sealed', expectedHead: null });
      await h.hitl.appendDecision({
        requestId: sealedSource.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'rejected',
        decidedBy: 'firat',
        note: null,
      });
      const sealedObserved = await h.hitl.getRequest(sealedSource.requestId);
      assert.equal(sealedObserved!.sealed, true);
      await h.hitl.replaces({
        sourceRequestId: sealedSource.requestId,
        sourceExpectedHead: fingerprintOf(sealedObserved!),
        request: input({ expiresAt, target: 'x.com/sealed-successor', expectedHead: null }),
      });
      await assert.rejects(
        h.hitl.createRequest(
          input({
            expiresAt,
            target: 'x.com/sealed',
            body: 'a fresh ask on a replaced group',
            expectedHead: fingerprintOf(sealedObserved!),
          }),
        ),
        ConflictError,
      );
      assert.equal((await h.hitl.listGenerations(sealedSource.requestId)).length, 1, 'no generation 2 was opened');
    } finally {
      await h.cleanup();
    }
  });

  // R4 finding 1a (source side): the same fingerprint blindness lets a second
  // `replaces` run against an ALREADY superseded source, minting a second
  // destination that also claims to cancel it.
  test(t('R4-1a: replaces refuses an already-superseded source head'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const source = await submit(h, { expiresAt, target: 'x.com/old', expectedHead: null });
      const observed = await h.hitl.getRequest(source.requestId);
      const fingerprint = fingerprintOf(observed!);
      await h.hitl.replaces({
        sourceRequestId: source.requestId,
        sourceExpectedHead: fingerprint,
        request: input({ expiresAt, target: 'x.com/new', expectedHead: null }),
      });
      await assert.rejects(
        h.hitl.replaces({
          sourceRequestId: source.requestId,
          sourceExpectedHead: fingerprint,
          request: input({ expiresAt, target: 'x.com/second', expectedHead: null }),
        }),
        ConflictError,
      );
      assert.equal(
        await h.hitl.getRequest(requestIdOf(h.workspaceId, requestKeyOf(input({ target: 'x.com/second' })))),
        null,
        'the rival destination was never written',
      );
      // ...while replaying the ORIGINAL replace stays a true idempotent no-op.
      const destId = requestIdOf(h.workspaceId, requestKeyOf(input({ target: 'x.com/new' })));
      const replay = await h.hitl.replaces({
        sourceRequestId: source.requestId,
        sourceExpectedHead: fingerprint,
        request: input({ expiresAt, target: 'x.com/new', expectedHead: fingerprintOf((await h.hitl.getRequest(destId))!) }),
      });
      assert.equal(replay.idempotent, true);
    } finally {
      await h.cleanup();
    }
  });

  // R5 finding 1: the SIBLING door to R4-1a. Round 4 closed resurrection when
  // the superseded group is the SOURCE of a `replaces`; it stayed open when the
  // superseded group is the DESTINATION. A byte-identical packet against an
  // open head plans as `idempotent` (a no-write result the closure rule
  // deliberately lets through), and BOTH stores then UPGRADE that plan to a
  // writing revision because the requested supersession link differs from the
  // one the head records — without re-checking the destination's own closure.
  // A→B, B→C, then X→B with B's exact fingerprint and packet committed B v2,
  // which C's supersession pointer (naming B v1) does not cover: B v2 came back
  // unsuperseded, actionable and approvable ALONGSIDE C.
  test(t('R5-1: a superseded DESTINATION cannot be resurrected through replaces'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const a = await submit(h, { expiresAt, target: 'x.com/a', expectedHead: null });
      // The destination packet, kept VERBATIM so the resurrection attempt below
      // is byte-identical to the head it targets.
      const bPacket = input({ expiresAt, target: 'x.com/b', expectedHead: null });

      // A → B
      const b = await h.hitl.replaces({
        sourceRequestId: a.requestId,
        sourceExpectedHead: fingerprintOf((await h.hitl.getRequest(a.requestId))!),
        request: bPacket,
      });
      const bHead = await h.hitl.getRequest(b.requestId);
      assert.ok(bHead !== null);
      assert.equal(bHead.superseded, false);

      // B → C: B's group is now permanently closed.
      const c = await h.hitl.replaces({
        sourceRequestId: b.requestId,
        sourceExpectedHead: fingerprintOf(bHead),
        request: input({ expiresAt, target: 'x.com/c', expectedHead: null }),
      });
      assert.equal((await h.hitl.getRequest(b.requestId))!.superseded, true);

      // X exists and is NOT superseded — the source-side closure rule (R4-1a)
      // has nothing to say here. Only the DESTINATION is closed.
      const x = await submit(h, { expiresAt, target: 'x.com/x', expectedHead: null });

      await assert.rejects(
        h.hitl.replaces({
          sourceRequestId: x.requestId,
          sourceExpectedHead: fingerprintOf((await h.hitl.getRequest(x.requestId))!),
          request: { ...bPacket, expectedHead: fingerprintOf(bHead) },
        }),
        (err: unknown) => {
          assert.ok(err instanceof ConflictError, `expected ConflictError, got ${String(err)}`);
          assert.match(err.message, /superseded-head/);
          return true;
        },
      );
      assert.equal(
        (await h.hitl.listVersions(b.requestId)).length,
        1,
        'the superseded destination never grew a version',
      );
      assert.equal((await h.hitl.getRequest(b.requestId))!.superseded, true);

      // Exactly ONE authoritative group after approving the live head of each
      // group that can still take a decision.
      await h.hitl.appendDecision({
        requestId: c.requestId,
        generation: 1,
        requestVersion: 1,
        status: 'approved',
        decidedBy: 'firat',
        note: null,
      });
      for (const closed of [a.requestId, b.requestId]) {
        await assert.rejects(
          h.hitl.appendDecision({
            requestId: closed,
            generation: 1,
            requestVersion: 1,
            status: 'approved',
            decidedBy: 'firat',
            note: null,
          }),
          ConflictError,
          'a superseded head takes no decision at all',
        );
      }
      const groups = await Promise.all(
        [a.requestId, b.requestId, c.requestId, x.requestId].map((id) => h.hitl.getRequest(id)),
      );
      assert.deepEqual(
        groups.filter((g) => g!.authoritative).map((g) => g!.id),
        [c.requestId],
        'exactly one authoritative group survives',
      );
    } finally {
      await h.cleanup();
    }
  });

  // R4 finding 1b: a superseded head was REPLACED — it is not actionable, so it
  // must not sit in the default queue a human drains.
  test(t('R4-1b: a superseded head is out of the default actionable listing and count'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const expiresAt = Date.now() + 6 * HOUR;
      const source = await submit(h, { expiresAt, target: 'x.com/old', expectedHead: null });
      assert.deepEqual(await h.hitl.count(), { committed: 1, queued: 0, partial: false });
      const observed = await h.hitl.getRequest(source.requestId);
      const dest = await h.hitl.replaces({
        sourceRequestId: source.requestId,
        sourceExpectedHead: fingerprintOf(observed!),
        request: input({ expiresAt, target: 'x.com/new', expectedHead: null }),
      });

      assert.deepEqual(
        await h.hitl.count(),
        { committed: 1, queued: 0, partial: false },
        'the replacement is actionable, the head it replaced is not',
      );
      assert.deepEqual(
        (await h.hitl.listRequests({})).items.map((i) => i.id),
        [dest.requestId],
      );
      // An EXPLICIT status filter is history, not the queue — it still finds it.
      assert.ok(
        (await h.hitl.listRequests({ status: 'awaiting' })).items.some((i) => i.id === source.requestId),
        'an explicit status query still reaches the superseded head',
      );
    } finally {
      await h.cleanup();
    }
  });

  // R4 finding 1c: the two backends disagreed about the expiry of a SUPERSEDED
  // head — postgres refuses the durable decision outright (the decision trigger
  // rejects any decision on a superseded version), while the local ledger wrote
  // one. The candidate set and the insert must behave identically.
  test(t('R4-1c: a superseded head is never an expiry candidate, on either backend'), { skip: factory.skip }, async () => {
    const h = await factory.create({
      hitlExpiry: { defaultTtlMs: 500, minTtlMs: 1, maxTtlMs: 7 * 24 * HOUR },
      now: () => Date.now(),
    });
    try {
      const source = await submit(h, {
        expiresAt: Date.now() + 400,
        target: 'x.com/old',
        expectedHead: null,
      });
      const observed = await h.hitl.getRequest(source.requestId);
      await h.hitl.replaces({
        sourceRequestId: source.requestId,
        sourceExpectedHead: fingerprintOf(observed!),
        request: input({ expiresAt: Date.now() + 6 * HOUR, target: 'x.com/new', expectedHead: null }),
      });
      await sleep(800);

      const head = await h.hitl.getRequest(source.requestId);
      assert.ok(head !== null);
      assert.deepEqual(
        [head.superseded, head.status, head.terminalStatus],
        [true, 'expired', null],
        'the head is superseded AND effectively expired, with nothing materialized',
      );

      assert.deepEqual(
        (await h.hitl.listExpiryCandidates(Date.now(), 100)).filter((c) => c.requestId === source.requestId),
        [],
        'a superseded head is not an expiry candidate',
      );
      assert.equal(
        await h.hitl.insertSystemExpiry(
          {
            requestId: source.requestId,
            requestKey: head.requestKey,
            generation: head.generation,
            version: head.version,
            expiresAt: head.expiresAt!,
          },
          Date.now(),
        ),
        'conflict',
        'insertSystemExpiry reports a conflict — never a throw, never a write',
      );
      assert.deepEqual(await h.hitl.listDecisions(source.requestId), []);
      const swept = await sweepExpired(h.hitl, Date.now());
      assert.deepEqual([swept.expired, swept.conflicts], [0, 0], 'the sweep is clean on both backends');
    } finally {
      await h.cleanup();
    }
  });

  // R4 finding 3 (nit): a legacy row with an absent or non-string body is
  // canonicalization 0 on both backends, but the local conversion projected its
  // body as '' while postgres projects null — the same row, two audit outputs.
  test(t('R4-3: a legacy row with no usable body projects a NULL body on both backends'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      await h.seedLegacyV1('legacy-absent-body', {
        functionName: 'growth',
        title: 'Approve the bodyless draft',
        action: SEED_ACTION,
        target: 'x.com/no-body',
        contentHash: sha256Hex('what the approver never saw'),
        expiresAt: Date.now() + 6 * HOUR,
        status: 'awaiting',
      });
      await h.seedLegacyV1('legacy-nonstring-body', {
        functionName: 'growth',
        title: 'Approve the numeric draft',
        action: SEED_ACTION,
        target: 'x.com/numeric-body',
        contentHash: sha256Hex('what the approver never saw'),
        body: 42,
        expiresAt: Date.now() + 6 * HOUR,
        status: 'awaiting',
      });
      for (const target of ['x.com/no-body', 'x.com/numeric-body']) {
        const env = await h.hitl.getRequest(seededTargetId(h.workspaceId, target));
        assert.ok(env !== null, target);
        assert.equal(env.canonicalizationVersion, 0, `${target} stays legacy-exempt`);
        assert.equal(env.body, null, `${target}: a missing/non-string body projects as null`);
      }
    } finally {
      await h.cleanup();
    }
  });
}

function seededTargetId(workspaceId: string, target: string): string {
  return requestIdOf(workspaceId, requestKeyOf({ functionName: 'growth', action: SEED_ACTION, target }));
}

// R3 finding 1: `canonicalization_version > 0` is the assertion "this row's
// stored content hash covers its stored content" — the assertion D8 and
// validateApproval rely on. The fill trigger only ever DERIVED it, so a plain
// INSERT could assert 1 over a body that hashes to something else and hold an
// authoritative approval for a packet the approver never saw.
test('R3-1: a positive canonicalization version cannot be ASSERTED over content that does not hash to it', pgOpts, async () => {
  const h = await pgHarness();
  try {
    const expiresAt = Date.now() + 6 * HOUR;
    const insert = (
      id: string,
      target: string,
      contentHash: string,
      payload: unknown,
      payloadRef: unknown,
      canonicalizationVersion: number | null,
    ) =>
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, target, content_hash, payload, payload_ref,
            packet_hash, canonicalization_version, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, 'awaiting', $10, $11)`,
        [
          id,
          h.workspaceId,
          SEED_ACTION,
          target,
          contentHash,
          payload === null ? null : JSON.stringify(payload),
          payloadRef === null ? null : JSON.stringify(payloadRef),
          seededPacketHash(target, expiresAt, contentHash),
          canonicalizationVersion,
          Date.now(),
          expiresAt,
        ],
      );

    // The spoof: the approver reads 'benign text', the packet binds the hash of
    // something else entirely, and the row claims to be verified.
    await assert.rejects(
      insert(
        'spoof-1',
        'x.com/spoof',
        sha256Hex('different executable text'),
        { functionName: 'growth', title: 'seeded', body: 'benign text' },
        null,
        1,
      ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '23514');
        return /canonicalization_version/.test((err as Error).message);
      },
    );
    assert.equal(
      (await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE workspace_id = $1::uuid`, [h.workspaceId]))
        .rows[0]!.n,
      0,
      'nothing landed',
    );

    // A correct inline row at version 1 is accepted...
    await insert(
      'good-1',
      'x.com/good',
      sha256Hex('benign text'),
      { functionName: 'growth', title: 'seeded', body: 'benign text' },
      null,
      1,
    );
    const good = seededTargetId(h.workspaceId, 'x.com/good');
    assert.equal((await h.hitl.getRequest(good))!.canonicalizationVersion, 1);

    // ...a legacy version-0 row is still accepted and still non-authoritative
    // once approved (D8), which is what makes the exemption safe.
    await insert(
      'legacy-1',
      'x.com/legacy',
      sha256Hex('what the approver never saw'),
      { functionName: 'growth', title: 'seeded', body: 'what the approver saw' },
      null,
      0,
    );
    const legacy = seededTargetId(h.workspaceId, 'x.com/legacy');
    await h.hitl.appendDecision({
      requestId: legacy,
      generation: 1,
      requestVersion: 1,
      status: 'approved',
      decidedBy: 'firat',
      note: null,
    });
    const legacyHead = await h.hitl.getRequest(legacy);
    assert.deepEqual(
      [legacyHead!.canonicalizationVersion, legacyHead!.status, legacyHead!.authoritative],
      [0, 'approved', false],
      'a legacy unverified approval can never authorize execution',
    );

    // ...and the payload_ref channel is unaffected: the row has no inline body,
    // so what it binds is the REFERENCE digest, which SQL can and does check.
    // (Its meta is empty, so its identity is the 'unknown' sentinel's.)
    const refDigest = sha256Hex('an offloaded body');
    await insert('ref-1', 'x.com/ref', refDigest, null, { digest: refDigest, size: 17, meta: {} }, 1);
    // (read through listVersions — materializing the body would fan out into an
    // object store that never received these seeded bytes)
    const refId = seededIdentity(h.workspaceId, 'x.com/ref').requestId;
    assert.deepEqual((await h.hitl.listVersions(refId)).map((v) => v.canonicalizationVersion), [1]);
    await assert.rejects(
      insert('ref-2', 'x.com/ref-liar', refDigest, null, { digest: sha256Hex('other bytes'), size: 11, meta: {} }, 1),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '23514');
        return /canonicalization_version/.test((err as Error).message);
      },
    );

    // A row that asserts NOTHING still gets the derived answer per channel.
    await insert(
      'derived-1',
      'x.com/derived',
      sha256Hex('benign text'),
      { functionName: 'growth', title: 'seeded', body: 'benign text' },
      null,
      null,
    );
    assert.equal((await h.hitl.getRequest(seededTargetId(h.workspaceId, 'x.com/derived')))!.canonicalizationVersion, 1);
  } finally {
    await h.cleanup();
  }
});

// R3 finding 3: expiry eligibility is decided by the DATABASE clock (the view's
// clock_timestamp() and the decision trigger's), so the store's own
// prevalidation must read that clock too — a skewed application clock refused a
// decision the database considered perfectly decidable.
test('R3-3: a user decision is prevalidated with the DB clock, not the application clock', pgOpts, async () => {
  const h = await pgHarness();
  try {
    // DB clock: now. Expiry: now + 1h + a minute. Application clock: now + 2h —
    // past the deadline the database has not reached yet.
    const expiresAt = Date.now() + HOUR + 60_000;
    const req = await submit(h, { expiresAt });
    const skew = 2 * HOUR;
    const skewed = createPgBackend({
      pool: h.pool,
      objects: new CreateOnlyFileStore(new MemoryFileStore()),
      now: () => Date.now() + skew,
    });
    const decided = await skewed.hitl.appendDecision({
      requestId: req.requestId,
      generation: 1,
      requestVersion: 1,
      status: 'approved',
      decidedBy: 'firat',
      note: null,
    });
    assert.equal(decided.status, 'approved');
    const head = await h.hitl.getRequest(req.requestId);
    assert.deepEqual([head!.status, head!.authoritative], ['approved', true]);
    const decisions = await h.hitl.listDecisions(req.requestId);
    assert.equal(decisions.length, 1);
    assert.ok(
      decisions[0]!.decidedAt < Date.now() + skew - HOUR,
      `the durable stamp must be the DB clock, not the skewed caller's (stamped ${decisions[0]!.decidedAt})`,
    );
  } finally {
    await h.cleanup();
  }
});
