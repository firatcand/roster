import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  runOpsMigrations,
  opsSchemaDir,
  HITL_MIGRATION_TARGET,
  ROSTER_OPS_MIGRATION_TARGET,
} from '../src/lib/persistence/postgres/migrate.ts';
import {
  BoundPool,
  auditRowStamps,
  finalizeBinding,
  poolSupportsOnConnect,
  recordMarkerEtag,
  stampPending,
  verifyBinding,
  type CanonicalObjectTuple,
} from '../src/lib/persistence/postgres/binding.ts';
import {
  applyOpsGrants,
  checkOpsRoleInvariants,
  ensureOpsRuntimeRole,
} from '../src/lib/persistence/postgres/roles.ts';
import {
  PgRemoteTarget,
  createPgBackend,
  hitlRequestParts,
  pgBackendInfo,
} from '../src/lib/persistence/postgres/stores.ts';
import {
  CreateOnlyFileStore,
  S3ObjectTarget,
  workspaceMarkerSha256,
} from '../src/lib/persistence/objects.ts';
import { MemoryFileStore } from '../src/lib/persistence/s3-core.ts';
import { sealRunEvent } from '../src/lib/persistence/run-events.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  NotConfiguredError,
  VersionSkewError,
  WorkspaceMismatchError,
  canonicalJson,
  computeRecordId,
  sha256Hex,
  type Cursor,
} from '../src/lib/persistence/contracts.ts';
import { assertBackendSupported, assertComponentSupported } from '../src/lib/persistence/capabilities.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import {
  LocalOutbox,
  payloadHashOf,
  type DeliverResult,
  type OutboxRecord,
  type RemoteTarget,
} from '../src/lib/persistence/outbox.ts';
import { resolveOpsBackend } from '../src/lib/persistence/resolve.ts';
import { RosterError } from '../src/lib/errors.ts';

// #318 stage 4 PG integration: migrations, the binding protocol, per-physical-
// connection verification gating, the grant matrix + invariant checker, the
// delivery-ledger dedup, capabilities, and the outbox composition. Env-gated:
// set ROSTER_OPS_TEST_ADMIN_URL to a superuser URL of a throwaway Postgres 16
// (locally postgresql://postgres@localhost:55433/postgres).

const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const opts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };

function urlForDb(db: string): string {
  const u = new URL(ADMIN);
  u.pathname = '/' + db;
  return u.toString();
}

type Harness = {
  db: string;
  url: string;
  suffix: string;
  pool: pg.Pool;
  roles: string[];
  close: () => Promise<void>;
};

async function makeDb(migrate = true): Promise<Harness> {
  const suffix = randomBytes(6).toString('hex');
  const db = `ops_test_${suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const url = urlForDb(db);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  if (migrate) await runOpsMigrations(pool);
  const roles: string[] = [];
  return {
    db,
    url,
    suffix,
    pool,
    roles,
    close: async () => {
      await pool.end().catch(() => {});
      const root2 = new pg.Client({ connectionString: ADMIN });
      await root2.connect();
      try {
        await root2.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [db],
        );
        await root2.query(`DROP DATABASE IF EXISTS ${db}`);
        for (const role of roles) {
          await root2.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
        }
      } finally {
        await root2.end();
      }
    },
  };
}

function tupleFor(workspaceId: string, name = 'acme', overrides: Partial<CanonicalObjectTuple> = {}): CanonicalObjectTuple {
  return {
    bucket: 'acme-ops',
    region: 'us-east-1',
    endpoint: null,
    forcePathStyle: false,
    markerSha256: workspaceMarkerSha256({ workspaceId, name }),
    ...overrides,
  };
}

async function stampAndFinalize(h: Harness, workspaceId: string, name = 'acme'): Promise<void> {
  await stampPending(h.pool, { workspaceId, workspaceName: name, objects: tupleFor(workspaceId, name) });
  await finalizeBinding(h.pool, { workspaceId });
}

async function metaRow(h: Harness, schema: 'hitl' | 'roster_ops'): Promise<Record<string, unknown>> {
  const res = await h.pool.query(`SELECT * FROM ${schema}.meta WHERE singleton`);
  return res.rows[0] as Record<string, unknown>;
}

async function runtimeClient(h: Harness, role: string, password: string): Promise<pg.Client> {
  const u = new URL(h.url);
  u.username = role;
  u.password = password;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

async function withAdminClient<T>(h: Harness, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await h.pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function memObjects(): CreateOnlyFileStore {
  return new CreateOnlyFileStore(new MemoryFileStore());
}

// ---------------- migrations ----------------

test('pg: migrations apply fresh and re-run as a no-op for both schemas', opts, async () => {
  const h = await makeDb(false);
  try {
    const first = await runOpsMigrations(h.pool);
    assert.deepEqual(first.hitl.applied, ['001_init.sql']);
    assert.deepEqual(first.roster_ops.applied, ['001_init.sql', '002_run_ledger.sql']);
    const second = await runOpsMigrations(h.pool);
    assert.deepEqual(second.hitl.applied, []);
    assert.deepEqual(second.hitl.skipped, ['001_init.sql']);
    assert.deepEqual(second.roster_ops.applied, []);
    assert.deepEqual(second.roster_ops.skipped, ['001_init.sql', '002_run_ledger.sql']);

    assert.notEqual(HITL_MIGRATION_TARGET.advisoryLockKey, ROSTER_OPS_MIGRATION_TARGET.advisoryLockKey);
    const hitlMeta = await metaRow(h, 'hitl');
    assert.equal(hitlMeta.component_version, 1);
    assert.equal(hitlMeta.workspace_id, null);
    // #323 bumps roster_ops + objects to v2 (the run-ledger migration).
    const opsMeta = await metaRow(h, 'roster_ops');
    assert.equal(opsMeta.component_version, 2);
    assert.equal(opsMeta.objects_component_version, 2);
  } finally {
    await h.close();
  }
});

// ---------------- binding protocol ----------------

test('pg: stamp pending → finalize → verifyBinding round-trip', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    const stamped = await stampPending(h.pool, {
      workspaceId: ws,
      workspaceName: 'acme',
      objects: tupleFor(ws),
    });
    assert.deepEqual(stamped, { resumed: false, state: 'pending' });
    for (const schema of ['hitl', 'roster_ops'] as const) {
      const row = await metaRow(h, schema);
      assert.equal(row.workspace_id, ws);
      assert.equal(row.workspace_name, 'acme');
      assert.equal(row.state, 'pending');
      assert.equal(row.bucket, 'acme-ops');
      assert.equal(row.marker_sha256, workspaceMarkerSha256({ workspaceId: ws, name: 'acme' }));
      assert.equal(row.marker_etag, null);
      assert.ok(row.bound_at !== null);
    }

    // pending is NOT enough for runtime access — fail closed
    await assert.rejects(
      withAdminClient(h, (c) => verifyBinding(c, ws)),
      (err) => {
        assert.ok(err instanceof WorkspaceMismatchError);
        assert.match(err.message, /pending/);
        return true;
      },
    );

    await recordMarkerEtag(h.pool, { workspaceId: ws, markerEtag: 'etag-123' });
    assert.equal((await metaRow(h, 'hitl')).marker_etag, 'etag-123');

    assert.deepEqual(await finalizeBinding(h.pool, { workspaceId: ws }), { alreadyFinalized: false });
    const binding = await withAdminClient(h, (c) => verifyBinding(c, ws));
    assert.equal(binding.workspaceId, ws);
    assert.equal(binding.state, 'finalized');
    assert.equal(binding.tuple?.bucket, 'acme-ops');
    assert.deepEqual(await finalizeBinding(h.pool, { workspaceId: ws }), { alreadyFinalized: true });

    // same-UUID exact-tuple re-stamp is a resume, not a refusal
    const resumed = await stampPending(h.pool, {
      workspaceId: ws,
      workspaceName: 'acme',
      objects: tupleFor(ws),
    });
    assert.deepEqual(resumed, { resumed: true, state: 'finalized' });
  } finally {
    await h.close();
  }
});

test('pg: same-UUID resume with a different tuple refuses BEFORE any bucket claim', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampPending(h.pool, { workspaceId: ws, workspaceName: 'acme', objects: tupleFor(ws) });
    await assert.rejects(
      stampPending(h.pool, {
        workspaceId: ws,
        workspaceName: 'acme',
        objects: tupleFor(ws, 'acme', { bucket: 'other-bucket' }),
      }),
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.match(err.message, /before any bucket claim/);
        return true;
      },
    );
    // a renamed workspace changes the marker sha — also a tuple mismatch
    await assert.rejects(
      stampPending(h.pool, { workspaceId: ws, workspaceName: 'renamed', objects: tupleFor(ws, 'renamed') }),
      ConflictError,
    );
    // nothing changed under the refusals
    assert.equal((await metaRow(h, 'hitl')).bucket, 'acme-ops');
    assert.equal((await metaRow(h, 'hitl')).workspace_name, 'acme');
  } finally {
    await h.close();
  }
});

test('pg: different-UUID claims refuse — stale-pending remedy vs belongs-to', opts, async () => {
  const h = await makeDb();
  const owner = randomUUID();
  const intruder = randomUUID();
  try {
    await stampPending(h.pool, { workspaceId: owner, workspaceName: 'owner-ws', objects: tupleFor(owner, 'owner-ws') });
    await assert.rejects(
      stampPending(h.pool, { workspaceId: intruder, workspaceName: 'thief', objects: tupleFor(intruder, 'thief') }),
      (err) => {
        assert.ok(err instanceof WorkspaceMismatchError);
        assert.match(err.message, /pending/);
        assert.match(err.message, /owner-ws/);
        assert.match(err.message, new RegExp(owner));
        assert.match(err.message, /never auto-unclaims/);
        return true;
      },
    );
    await finalizeBinding(h.pool, { workspaceId: owner });
    await assert.rejects(
      stampPending(h.pool, { workspaceId: intruder, workspaceName: 'thief', objects: tupleFor(intruder, 'thief') }),
      (err) => {
        assert.ok(err instanceof WorkspaceMismatchError);
        assert.match(err.message, /belongs to workspace owner-ws/);
        assert.match(err.message, new RegExp(owner));
        return true;
      },
    );
    // verification as the wrong workspace names the owner
    await assert.rejects(
      withAdminClient(h, (c) => verifyBinding(c, intruder)),
      /belongs to workspace owner-ws/,
    );
    // finalize by the wrong workspace refuses too
    await assert.rejects(finalizeBinding(h.pool, { workspaceId: intruder }), WorkspaceMismatchError);
  } finally {
    await h.close();
  }
});

test('pg: verifyBinding refuses unbound and unmigrated databases', opts, async () => {
  const migrated = await makeDb();
  const bare = await makeDb(false);
  try {
    await assert.rejects(
      withAdminClient(migrated, (c) => verifyBinding(c, randomUUID())),
      (err) => {
        assert.ok(err instanceof WorkspaceMismatchError);
        assert.match(err.message, /not bound/);
        return true;
      },
    );
    await assert.rejects(
      withAdminClient(bare, (c) => verifyBinding(c, randomUUID())),
      NotConfiguredError,
    );
  } finally {
    await migrated.close();
    await bare.close();
  }
});

// ---------------- per-connection verification gating ----------------

test('pg: every new physical client is verified once; idle reuse hits the per-client cache', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    assert.equal(poolSupportsOnConnect(), true, 'installed pg is expected to support PoolConfig.onConnect');
    let verifies = 0;
    const bp = new BoundPool({
      connectionString: h.url,
      workspaceId: ws,
      max: 2,
      verify: async (client, workspaceId) => {
        verifies += 1;
        await verifyBinding(client as pg.PoolClient, workspaceId);
      },
    });
    try {
      await bp.query('SELECT 1');
      await bp.query('SELECT 1');
      await bp.query('SELECT 1');
      assert.equal(verifies, 1, 'sequential queries reuse the verified idle client');
      const [a, b] = await Promise.all([bp.connect(), bp.connect()]);
      a.release();
      b.release();
      assert.equal(verifies, 2, 'a second physical client triggers its own verification');
      await bp.query('SELECT 1');
      assert.equal(verifies, 2, 'released clients stay verified (cache per client object)');
    } finally {
      await bp.end();
    }
  } finally {
    await h.close();
  }
});

test('pg: first query cannot precede verification (checkout-wrapper path) and pending binding blocks all queries', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const events: string[] = [];
    const bp = new BoundPool({
      connectionString: h.url,
      workspaceId: ws,
      forceCheckoutGating: true,
      verify: async (client, workspaceId) => {
        events.push('verify');
        await verifyBinding(client as pg.PoolClient, workspaceId);
      },
    });
    try {
      const client = await bp.connect();
      events.push('client-exposed');
      await client.query('SELECT 1');
      events.push('query');
      client.release();
      assert.deepEqual(events, ['verify', 'client-exposed', 'query']);
    } finally {
      await bp.end();
    }

    // a NOT-finalized database: the client is never exposed, so the write
    // cannot possibly run — proven by the row staying absent
    const pendingDb = await makeDb();
    const pendingWs = randomUUID();
    try {
      await stampPending(pendingDb.pool, {
        workspaceId: pendingWs,
        workspaceName: 'pending-ws',
        objects: tupleFor(pendingWs, 'pending-ws'),
      });
      for (const forceCheckoutGating of [false, true]) {
        const blocked = new BoundPool({
          connectionString: pendingDb.url,
          workspaceId: pendingWs,
          forceCheckoutGating,
        });
        try {
          await assert.rejects(
            blocked.query(
              `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
               VALUES ('smuggled', $1::uuid, 'r', 'k', 'step', '{}'::jsonb, 0)`,
              [pendingWs],
            ),
            WorkspaceMismatchError,
          );
        } finally {
          await blocked.end();
        }
      }
      const rows = await pendingDb.pool.query(`SELECT count(*)::int AS n FROM roster_ops.run_events`);
      assert.equal((rows.rows[0] as { n: number }).n, 0, 'no query ran before verification failed');
    } finally {
      await pendingDb.close();
    }
  } finally {
    await h.close();
  }
});

// ---------------- finding 5: v1 artifact reads never execute v2-only SQL ------

test('finding 5: getArtifact/head on a finalized v1 PG backend read version-less, not undefined_column', opts, async () => {
  const h = await makeDb(false); // no auto-migrate: build a genuine v1 backend
  const ws = randomUUID();
  const v1Dir = mkdtempSync(join(tmpdir(), 'roster-ops-v1b-'));
  try {
    copyFileSync(join(opsSchemaDir('roster_ops'), '001_init.sql'), join(v1Dir, '001_init.sql'));
    // hitl fully (001) + roster_ops v1 ONLY (001, no 002) → a finalized v1 DB
    // whose artifacts table has NO object_version_id column.
    await runOpsMigrations(h.pool, { roster_ops: v1Dir });
    const opsMeta = await metaRow(h, 'roster_ops');
    assert.equal(opsMeta.component_version, 1, 'the backend is genuinely roster_ops v1');
    await stampAndFinalize(h, ws);

    const bytes = Buffer.from('v1 backend artifact bytes');
    const digest = sha256Hex(bytes);
    await h.pool.query(
      `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
       VALUES ('blob1', $1::uuid, $2, $3, $4::jsonb, 1)`,
      [ws, digest, bytes.byteLength, JSON.stringify({ filename: 'v1.txt', contentType: 'text/plain', runId: null })],
    );
    const objects = memObjects();
    await objects.putIfAbsent({ prefix: 'artifacts', segments: [digest] }, bytes);

    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      // The gate ALLOWS getArtifact/head on a v1 backend (base `artifacts`). With
      // opsVersion=1 the read must NOT select the v2-only object_version_id column
      // (before the fix this failed with `undefined_column`).
      const backend = createPgBackend({ pool, objects, opsVersion: 1 });
      const got = await backend.artifacts.getArtifact(digest);
      assert.ok(got, 'the v1 blob reads back (not a SQL column error)');
      assert.ok(got!.bytes.equals(bytes), 'bytes are digest-verified and returned');
      assert.equal(got!.record.objectVersionId, null, 'a v1 read is version-less');
      const head = await backend.artifacts.head(digest); // sibling read path
      assert.ok(head);
      assert.equal(head!.objectVersionId, null);
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(v1Dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---------------- row-stamp invariant ----------------

test('pg: auditRowStamps passes on own rows and flags foreign workspace_ids', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects: memObjects() });
      await backend.hitl.createRequest({
        functionName: 'ops',
        title: 'T',
        action: 'a',
        target: 't',
        contentHash: sha256Hex('c'),
        body: 'b',
        expiresAt: null,
      });
      await backend.runs.appendEvent({ runId: 'r1', kind: 'tool-call', correlationId: 'k1', data: null });
      await backend.artifacts.putArtifact(
        { filename: 'a.txt', contentType: 'text/plain', runId: null },
        Buffer.from('bytes'),
      );
      assert.deepEqual(await auditRowStamps(pool, ws), { ok: true, violations: [] });

      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ('foreign', $1::uuid, 'r', 'k', 'step', '{}'::jsonb, 0)`,
        [randomUUID()],
      );
      // #323: artifact_declarations is a stamped table too — a foreign row is flagged.
      await h.pool.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, created_at)
         VALUES ('foreign-decl', $1::uuid, 'r', 'a', 'produced', 'internal', $2, '{}'::jsonb, 0)`,
        [randomUUID(), sha256Hex('d')],
      );
      const report = await auditRowStamps(pool, ws);
      assert.equal(report.ok, false);
      assert.deepEqual(report.violations, [
        { table: 'roster_ops.run_events', foreignRows: 1 },
        { table: 'roster_ops.artifact_declarations', foreignRows: 1 },
      ]);
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

// ---------------- grants: runtime matrix ----------------

test('pg: dedicated runtime role — can append events, cannot touch meta or mutate anything', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const role = `ops_rt_${h.suffix}`;
  h.roles.push(role);
  try {
    await stampAndFinalize(h, ws);
    await withAdminClient(h, async (c) => {
      await c.query(
        `CREATE ROLE ${role} LOGIN PASSWORD 'pw-${h.suffix}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
    });
    const rt = await runtimeClient(h, role, `pw-${h.suffix}`);
    try {
      // positive: INSERT on the append tables (bigserial seq → sequence USAGE)
      await rt.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
         VALUES ('rq1', $1::uuid, 1, 'a', 't', $2, '{}'::jsonb, 'awaiting', 0)`,
        [ws, sha256Hex('x')],
      );
      await rt.query(
        `INSERT INTO hitl.decisions (id, workspace_id, request_id, request_version, status, payload, created_at)
         VALUES ('dc1', $1::uuid, 'rq1', 1, 'approved', '{}'::jsonb, 0)`,
        [ws],
      );
      await rt.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ('ev1', $1::uuid, 'r', 'k', 'step', '{}'::jsonb, 0)`,
        [ws],
      );
      await rt.query(
        `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
         VALUES ('ar1', $1::uuid, $2, 1, '{}'::jsonb, 0)`,
        [ws, sha256Hex('y')],
      );
      // #323: the runtime INSERTs declarations (append-only), including the
      // append-value version_state/verified columns.
      await rt.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, verified, version_state, created_at)
         VALUES ('decl1', $1::uuid, 'r', 'sdr', 'produced', 'internal', $2, '{}'::jsonb, true, 'verified', 0)`,
        [ws, sha256Hex('y')],
      );
      await rt.query(
        `INSERT INTO roster_ops.delivery_ledger (workspace_id, namespace, record_id, payload_hash)
         VALUES ($1::uuid, 'runs', 'ev1', $2)`,
        [ws, sha256Hex('z')],
      );
      // positive: SELECT everywhere, including meta (binding verification needs it)
      await rt.query(`SELECT * FROM hitl.meta`);
      await rt.query(`SELECT * FROM roster_ops.meta`);
      await rt.query(`SELECT * FROM hitl.schema_migrations`);
      // positive: SELECT the sanitized projection views (safe index inputs).
      await rt.query(`SELECT run_id, agent, status, sanitized_report FROM roster_ops.run_index`);
      await rt.query(`SELECT run_id, artifact_type, media_type, external_url_host, sanitized_text FROM roster_ops.artifact_index`);

      // negative: meta immutability
      await assert.rejects(rt.query(`INSERT INTO hitl.meta (singleton, component_version) VALUES (false, 9)`), /permission denied/);
      await assert.rejects(rt.query(`INSERT INTO hitl.schema_migrations (filename, sha256) VALUES ('evil.sql', 'x')`), /permission denied/);
      await assert.rejects(rt.query(`UPDATE roster_ops.meta SET component_version = 99`), /permission denied/);
      await assert.rejects(rt.query(`UPDATE hitl.meta SET workspace_id = NULL, state = NULL`), /permission denied/);
      // negative: append-only — no UPDATE/DELETE/TRUNCATE anywhere
      await assert.rejects(rt.query(`UPDATE hitl.requests SET status = 'approved'`), /permission denied/);
      await assert.rejects(rt.query(`DELETE FROM hitl.requests`), /permission denied/);
      await assert.rejects(rt.query(`DELETE FROM roster_ops.delivery_ledger`), /permission denied/);
      await assert.rejects(rt.query(`TRUNCATE roster_ops.run_events`), /permission denied/);
      // #323: declarations are append-only — the runtime cannot flip verified /
      // version_state (that is the admin-repair path) or delete a declaration.
      await assert.rejects(rt.query(`UPDATE roster_ops.artifact_declarations SET verified = false`), /permission denied/);
      await assert.rejects(rt.query(`UPDATE roster_ops.artifact_declarations SET version_state = 'verified'`), /permission denied/);
      await assert.rejects(rt.query(`DELETE FROM roster_ops.artifact_declarations`), /permission denied/);
      await assert.rejects(rt.query(`TRUNCATE roster_ops.artifact_declarations`), /permission denied/);
      // negative: no DDL, no sequence resets
      await assert.rejects(rt.query(`CREATE TABLE hitl.evil (id int)`), /permission denied/);
      await assert.rejects(rt.query(`CREATE TABLE roster_ops.evil (id int)`), /permission denied/);
      await assert.rejects(rt.query(`SELECT setval(pg_get_serial_sequence('hitl.requests', 'seq'), 1000)`), /permission denied/);
      await assert.rejects(rt.query(`DROP TABLE hitl.requests`), /must be owner/);
    } finally {
      await rt.end();
    }
    // grants are idempotent — re-apply and the runtime still works
    await withAdminClient(h, (c) => applyOpsGrants(c, role));
    const rt2 = await runtimeClient(h, role, `pw-${h.suffix}`);
    try {
      await rt2.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ('ev2', $1::uuid, 'r', 'k2', 'step', '{}'::jsonb, 0)`,
        [ws],
      );
    } finally {
      await rt2.end();
    }
  } finally {
    await h.close();
  }
});

test('pg: role-mode errors — brain missing role, dedicated missing role, dedicated without role', opts, async () => {
  const h = await makeDb();
  try {
    const absent = `absent_${h.suffix}`;
    await withAdminClient(h, async (c) => {
      await assert.rejects(ensureOpsRuntimeRole(c, 'brain', { role: absent }), (err) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.remedy, /roster brain setup/);
        return true;
      });
      await assert.rejects(ensureOpsRuntimeRole(c, 'dedicated', { role: absent }), (err) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.remedy, new RegExp(`CREATE ROLE "${absent}"`));
        assert.match(err.remedy, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/);
        return true;
      });
      await assert.rejects(ensureOpsRuntimeRole(c, 'dedicated'), (err) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.remedy, /ROSTER_OPS_URL/);
        return true;
      });
    });
    // brain mode with an existing role extends it with exactly the ops set
    const brainish = `brainish_${h.suffix}`;
    h.roles.push(brainish);
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${brainish} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      const res = await ensureOpsRuntimeRole(c, 'brain', { role: brainish });
      assert.equal(res.role, brainish);
      const can = await c.query(`SELECT has_table_privilege($1, 'roster_ops.run_events', 'INSERT') AS ok`, [brainish]);
      assert.equal((can.rows[0] as { ok: boolean }).ok, true);
      const cannot = await c.query(`SELECT has_table_privilege($1, 'roster_ops.meta', 'INSERT') AS ok`, [brainish]);
      assert.equal((cannot.rows[0] as { ok: boolean }).ok, false);
    });
  } finally {
    await h.close();
  }
});

// ---------------- invariant checker ----------------

test('pg: invariant checker — clean role passes; every violation class fires with a remedy', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  const parent = `ops_parent_${h.suffix}`;
  h.roles.push(role, parent);
  try {
    await withAdminClient(h, async (c) => {
      // INHERIT on purpose: the inherited-grant probe below flows through it
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      const clean = await checkOpsRoleInvariants(c, role);
      assert.deepEqual(clean, { ok: true, violations: [] });

      const missing = await checkOpsRoleInvariants(c, `no_such_${h.suffix}`);
      assert.equal(missing.ok, false);
      assert.equal(missing.violations[0]!.kind, 'missing-role');

      // unsafe attribute
      await c.query(`ALTER ROLE ${role} CREATEDB`);
      // direct destructive grant
      await c.query(`GRANT UPDATE ON hitl.requests TO ${role}`);
      // inherited destructive grant via a parent role
      await c.query(`CREATE ROLE ${parent} NOLOGIN`);
      await c.query(`GRANT DELETE ON roster_ops.run_events TO ${parent}`);
      await c.query(`GRANT ${parent} TO ${role}`);
      // PUBLIC grant
      await c.query(`GRANT UPDATE ON hitl.decisions TO PUBLIC`);
      // meta write
      await c.query(`GRANT INSERT ON hitl.meta TO ${role}`);
      // schema create
      await c.query(`GRANT CREATE ON SCHEMA roster_ops TO ${role}`);
      // default privileges for future tables
      await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA roster_ops GRANT INSERT ON TABLES TO ${role}`);
      // sequence setval
      await c.query(`GRANT UPDATE ON SEQUENCE hitl.requests_seq_seq TO ${role}`);

      const dirty = await checkOpsRoleInvariants(c, role);
      assert.equal(dirty.ok, false);
      const kinds = new Set(dirty.violations.map((v) => v.kind));
      for (const expected of [
        'unsafe-attribute',
        'destructive-privilege',
        'public-grant',
        'meta-writable',
        'schema-create',
        'default-privilege',
        'sequence-privilege',
      ]) {
        assert.ok(kinds.has(expected as never), `expected a ${expected} violation`);
      }
      const details = dirty.violations.map((v) => `${v.kind}: ${v.detail}`).join('\n');
      assert.match(details, /CREATEDB/);
      assert.match(details, /UPDATE .*hitl\.requests/);
      assert.match(details, /DELETE .*roster_ops\.run_events/, 'inherited grant must be detected');
      assert.match(details, /PUBLIC/);
      for (const v of dirty.violations) {
        assert.ok(v.remedy.length > 0, `violation ${v.kind} must carry remedy SQL`);
      }

      // clean everything back up and re-verify
      await c.query(`ALTER ROLE ${role} NOCREATEDB`);
      await c.query(`REVOKE ${parent} FROM ${role}`);
      await c.query(`REVOKE UPDATE ON hitl.decisions FROM PUBLIC`);
      await c.query(`REVOKE CREATE ON SCHEMA roster_ops FROM ${role}`);
      await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA roster_ops REVOKE INSERT ON TABLES FROM ${role}`);
      await applyOpsGrants(c, role);
      const rechecked = await checkOpsRoleInvariants(c, role);
      assert.deepEqual(rechecked, { ok: true, violations: [] });
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker — SET ROLE escalation into a privileged parent is flagged (NOINHERIT included)', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  const parent = `ops_esc_${h.suffix}`;
  h.roles.push(role, parent);
  try {
    await withAdminClient(h, async (c) => {
      // NOINHERIT: no inherited privileges — but SET ROLE still reaches the parent.
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);

      await c.query(`CREATE ROLE ${parent} NOLOGIN CREATEDB CREATEROLE`);
      await c.query(`GRANT ${parent} TO ${role}`);
      const report = await checkOpsRoleInvariants(c, role);
      assert.equal(report.ok, false);
      const settable = report.violations.filter((v) => v.kind === 'settable-role');
      assert.ok(settable.length >= 2, 'CREATEDB and CREATEROLE on the parent must both be flagged');
      const details = settable.map((v) => v.detail).join('\n');
      assert.match(details, new RegExp(`SET ROLE into '${parent}'`));
      assert.match(details, /CREATEDB/);
      assert.match(details, /CREATEROLE/);
      for (const v of settable) assert.match(v.remedy, new RegExp(`REVOKE "${parent}" FROM`));

      // Transitive membership is caught too (grandparent via an intermediate).
      const mid = `ops_mid_${h.suffix}`;
      h.roles.push(mid);
      await c.query(`REVOKE ${parent} FROM ${role}`);
      await c.query(`CREATE ROLE ${mid} NOLOGIN`);
      await c.query(`GRANT ${parent} TO ${mid}`);
      await c.query(`GRANT ${mid} TO ${role}`);
      const indirect = await checkOpsRoleInvariants(c, role);
      assert.ok(
        indirect.violations.some((v) => v.kind === 'settable-role' && v.detail.includes(parent)),
        'transitive SET ROLE membership must be flagged',
      );

      await c.query(`REVOKE ${mid} FROM ${role}`);
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker — an executable SECURITY DEFINER function in the ops schemas is flagged with a REVOKE remedy', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  h.roles.push(role);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      // Admin-owned definer-rights function; PostgreSQL grants PUBLIC EXECUTE
      // by default — the classic silent escalation the direct-grant probes miss.
      await c.query(
        `CREATE FUNCTION hitl.escalate() RETURNS void LANGUAGE sql SECURITY DEFINER
         AS 'UPDATE hitl.meta SET workspace_name = workspace_name'`,
      );
      const report = await checkOpsRoleInvariants(c, role);
      assert.equal(report.ok, false);
      const definer = report.violations.find((v) => v.kind === 'security-definer');
      assert.ok(definer, 'the SECURITY DEFINER function must be flagged');
      assert.match(definer.detail, /hitl\.escalate\(\)/);
      assert.match(definer.remedy, /REVOKE EXECUTE ON FUNCTION "hitl"\."escalate"\(\) FROM PUBLIC;/);

      // Applying the remedy clears the violation.
      await c.query(`REVOKE EXECUTE ON FUNCTION hitl.escalate() FROM PUBLIC`);
      await c.query(`REVOKE EXECUTE ON FUNCTION hitl.escalate() FROM ${role}`);
      const after = await checkOpsRoleInvariants(c, role);
      assert.ok(!after.violations.some((v) => v.kind === 'security-definer'));
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker flags a table privilege reachable ONLY via SET ROLE (NOINHERIT runtime → parent grant)', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  const parent = `ops_tblparent_${h.suffix}`;
  h.roles.push(role, parent);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(
        `CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true, 'clean before the parent grant');

      // The parent holds DELETE on an ops table; the NOINHERIT runtime does NOT
      // inherit it — has_table_privilege(runtime, …, DELETE) is false — but the
      // runtime can SET ROLE into the parent and delete. Must be flagged.
      await c.query(`CREATE ROLE ${parent} NOLOGIN`);
      await c.query(`GRANT DELETE ON roster_ops.run_events TO ${parent}`);
      await c.query(`GRANT ${parent} TO ${role}`);
      // sanity: the direct/inherited probe alone would MISS this
      const direct = await c.query(`SELECT has_table_privilege($1, 'roster_ops.run_events', 'DELETE') AS ok`, [role]);
      assert.equal((direct.rows[0] as { ok: boolean }).ok, false, 'NOINHERIT hides the DELETE from the direct probe');

      const report = await checkOpsRoleInvariants(c, role);
      assert.equal(report.ok, false, 'a SET ROLE-reachable DELETE must be flagged');
      assert.ok(
        report.violations.some(
          (v) => v.kind === 'destructive-privilege' && /DELETE/.test(v.detail) && /roster_ops\.run_events/.test(v.detail),
        ),
        'the reachable DELETE on run_events must be flagged',
      );
      await c.query(`REVOKE ${parent} FROM ${role}`);
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker flags a column-level UPDATE grant on an ops table (naming the column)', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  h.roles.push(role);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);

      // Column-level UPDATE — table-level has_table_privilege(UPDATE) stays false,
      // so the table probe alone would MISS it.
      await c.query(`GRANT UPDATE (status) ON hitl.requests TO ${role}`);
      const tableLevel = await c.query(`SELECT has_table_privilege($1, 'hitl.requests', 'UPDATE') AS ok`, [role]);
      assert.equal((tableLevel.rows[0] as { ok: boolean }).ok, false, 'table-level UPDATE probe misses a column grant');

      const report = await checkOpsRoleInvariants(c, role);
      assert.equal(report.ok, false, 'a column UPDATE must be flagged');
      assert.ok(
        report.violations.some(
          (v) => /UPDATE/.test(v.detail) && /hitl\.requests/.test(v.detail) && /status/.test(v.detail),
        ),
        'the column-level UPDATE must be flagged naming the column',
      );
      await c.query(`REVOKE UPDATE (status) ON hitl.requests FROM ${role}`);
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker flags an admin-owned SECURITY DEFINER in ANOTHER schema that can write ops (public.escalate)', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  h.roles.push(role);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);

      // public.escalate() — SECURITY DEFINER owned by the admin (who can write
      // hitl.meta), PUBLIC EXECUTE by default, in the PUBLIC schema (NOT an ops
      // schema). The ops-schema-only scan would MISS it.
      await c.query(
        `CREATE FUNCTION public.escalate() RETURNS void LANGUAGE sql SECURITY DEFINER
         AS 'UPDATE hitl.meta SET workspace_name = workspace_name'`,
      );
      const report = await checkOpsRoleInvariants(c, role);
      const definer = report.violations.find((v) => v.kind === 'security-definer' && /public\.escalate/.test(v.detail));
      assert.ok(definer, 'a definer function in ANOTHER schema that can write ops must be flagged');
      assert.match(definer.remedy, /REVOKE EXECUTE ON FUNCTION "public"\."escalate"\(\) FROM PUBLIC;/);

      await c.query(`REVOKE EXECUTE ON FUNCTION public.escalate() FROM PUBLIC`);
      await c.query(`REVOKE EXECUTE ON FUNCTION public.escalate() FROM ${role}`);
      const after = await checkOpsRoleInvariants(c, role);
      assert.ok(!after.violations.some((v) => v.kind === 'security-definer' && /escalate/.test(v.detail)));
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker flags a SECURITY DEFINER whose owner has ONLY column-level UPDATE on ops (owner_can_write column companion)', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  const definerOwner = `ops_defowner_${h.suffix}`;
  h.roles.push(role, definerOwner);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true, 'clean before the definer is introduced');

      // A non-privileged role that will own a definer function. Its ONLY write
      // reach into ops is a COLUMN-level UPDATE on hitl.meta — table-level
      // has_table_privilege(UPDATE) stays FALSE, exactly the gap the old
      // owner_can_write (has_table_privilege only) missed.
      await c.query(
        `CREATE ROLE ${definerOwner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await c.query(`GRANT USAGE ON SCHEMA hitl TO ${definerOwner}`);
      await c.query(`GRANT UPDATE (workspace_name) ON hitl.meta TO ${definerOwner}`);
      await c.query(`GRANT CREATE ON SCHEMA public TO ${definerOwner}`);
      // sanity: the table-level probe the old owner_can_write used returns FALSE,
      // while the column-level companion (the fix) returns TRUE.
      const probe = await c.query(
        `SELECT has_table_privilege($1, 'hitl.meta', 'UPDATE') AS tbl,
                has_any_column_privilege($1, 'hitl.meta', 'UPDATE') AS col`,
        [definerOwner],
      );
      assert.equal((probe.rows[0] as { tbl: boolean }).tbl, false, 'table-level UPDATE is false (column grant only)');
      assert.equal((probe.rows[0] as { col: boolean }).col, true, 'column-level UPDATE is present');

      // Admin-created SECURITY DEFINER function (PUBLIC EXECUTE by default),
      // reassigned to definerOwner; it mutates hitl.meta via the column grant.
      await c.query(
        `CREATE FUNCTION public.colwrite() RETURNS void LANGUAGE sql SECURITY DEFINER
         AS 'UPDATE hitl.meta SET workspace_name = workspace_name'`,
      );
      await c.query(`ALTER FUNCTION public.colwrite() OWNER TO ${definerOwner}`);

      const report = await checkOpsRoleInvariants(c, role);
      const definer = report.violations.find(
        (v) => v.kind === 'security-definer' && /public\.colwrite/.test(v.detail),
      );
      assert.ok(definer, 'a definer whose owner has ONLY column-level UPDATE on ops must be flagged');
      assert.match(definer.remedy, /REVOKE EXECUTE ON FUNCTION "public"\."colwrite"\(\) FROM PUBLIC;/);

      await c.query(`REVOKE EXECUTE ON FUNCTION public.colwrite() FROM PUBLIC`);
      await c.query(`REVOKE EXECUTE ON FUNCTION public.colwrite() FROM ${role}`);
      const after = await checkOpsRoleInvariants(c, role);
      assert.ok(!after.violations.some((v) => v.kind === 'security-definer' && /colwrite/.test(v.detail)));
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker flags a column-level INSERT grant on a meta table (candidate INSERT column companion)', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  h.roles.push(role);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);

      // Column-level INSERT on meta — table-level has_table_privilege(INSERT)
      // stays false, so the table probe alone (pre-fix) would MISS it. meta is
      // admin-authored / runtime-read-only, so ANY insert grain is a violation.
      await c.query(`GRANT INSERT (workspace_name) ON hitl.meta TO ${role}`);
      const tableLevel = await c.query(`SELECT has_table_privilege($1, 'hitl.meta', 'INSERT') AS ok`, [role]);
      assert.equal((tableLevel.rows[0] as { ok: boolean }).ok, false, 'table-level INSERT probe misses a column grant');

      const report = await checkOpsRoleInvariants(c, role);
      assert.ok(
        report.violations.some((v) => v.kind === 'meta-writable' && /hitl\.meta/.test(v.detail)),
        'a column-level INSERT on meta must be flagged meta-writable',
      );
      await c.query(`REVOKE INSERT (workspace_name) ON hitl.meta FROM ${role}`);
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);

      // Sibling: column-level INSERT on a NON-append, non-meta table is
      // insert-not-allowlisted.
      await c.query(`CREATE TABLE roster_ops.rogue (id int, note text)`);
      await c.query(`GRANT INSERT (note) ON roster_ops.rogue TO ${role}`);
      const rogue = await checkOpsRoleInvariants(c, role);
      assert.ok(
        rogue.violations.some((v) => v.kind === 'insert-not-allowlisted' && /roster_ops\.rogue/.test(v.detail)),
        'a column-level INSERT on a non-append table must be flagged',
      );
    });
  } finally {
    await h.close();
  }
});

test('pg: invariant checker — any sequence privilege outside the append-table allowlist is flagged', opts, async () => {
  const h = await makeDb();
  const role = `ops_rt_${h.suffix}`;
  h.roles.push(role);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await ensureOpsRuntimeRole(c, 'dedicated', { role });
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true, 'allowlisted USAGE on the bigserial sequences is clean');

      await c.query(`CREATE SEQUENCE roster_ops.rogue_seq`);
      await c.query(`GRANT USAGE ON SEQUENCE roster_ops.rogue_seq TO ${role}`);
      const usage = await checkOpsRoleInvariants(c, role);
      const rogue = usage.violations.find((v) => v.kind === 'sequence-privilege' && /rogue_seq/.test(v.detail));
      assert.ok(rogue, 'USAGE on a non-allowlisted sequence must be flagged');
      assert.match(rogue.detail, /USAGE/);
      assert.match(rogue.remedy, /REVOKE USAGE ON SEQUENCE "roster_ops"\."rogue_seq"/);

      await c.query(`REVOKE USAGE ON SEQUENCE roster_ops.rogue_seq FROM ${role}`);
      await c.query(`GRANT SELECT ON SEQUENCE roster_ops.rogue_seq TO ${role}`);
      const select = await checkOpsRoleInvariants(c, role);
      assert.ok(
        select.violations.some((v) => v.kind === 'sequence-privilege' && /SELECT/.test(v.detail) && /rogue_seq/.test(v.detail)),
        'SELECT outside the allowlist must be flagged too',
      );

      await c.query(`DROP SEQUENCE roster_ops.rogue_seq`);
      assert.equal((await checkOpsRoleInvariants(c, role)).ok, true);
    });
  } finally {
    await h.close();
  }
});

test('pg: binding divergence — ANY out-of-band drift between the two meta rows fails hard naming both', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    await withAdminClient(h, (c) => verifyBinding(c, ws));
    // Tuple drift: roster_ops.meta re-pointed at a different bucket.
    await h.pool.query(`UPDATE roster_ops.meta SET bucket = 'other-bucket' WHERE singleton`);
    await assert.rejects(
      withAdminClient(h, (c) => verifyBinding(c, ws)),
      (err) => {
        assert.ok(err instanceof InvalidRecordError);
        assert.match(err.message, /diverge/);
        assert.match(err.message, /hitl:/);
        assert.match(err.message, /roster_ops:/);
        assert.match(err.message, /other-bucket/);
        return true;
      },
    );
    await h.pool.query(`UPDATE roster_ops.meta SET bucket = 'acme-ops' WHERE singleton`);
    // Name drift.
    await h.pool.query(`UPDATE hitl.meta SET workspace_name = 'impostor' WHERE singleton`);
    await assert.rejects(withAdminClient(h, (c) => verifyBinding(c, ws)), /diverge/);
    await h.pool.query(`UPDATE hitl.meta SET workspace_name = 'acme' WHERE singleton`);
    // Marker digest drift.
    await h.pool.query(`UPDATE hitl.meta SET marker_sha256 = repeat('0', 64) WHERE singleton`);
    await assert.rejects(withAdminClient(h, (c) => verifyBinding(c, ws)), /diverge/);
    await h.pool.query(
      `UPDATE hitl.meta SET marker_sha256 = (SELECT marker_sha256 FROM roster_ops.meta WHERE singleton) WHERE singleton`,
    );
    // Marker etag drift (advisory field, still part of the one-transaction row).
    await h.pool.query(`UPDATE roster_ops.meta SET marker_etag = 'stray' WHERE singleton`);
    await assert.rejects(withAdminClient(h, (c) => verifyBinding(c, ws)), /diverge/);
    await h.pool.query(`UPDATE roster_ops.meta SET marker_etag = NULL WHERE singleton`);
    await withAdminClient(h, (c) => verifyBinding(c, ws));
  } finally {
    await h.close();
  }
});

test('pg: NULL force_path_style in a stamped tuple is corrupt metadata — never coerced to false', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    await h.pool.query(`UPDATE hitl.meta SET force_path_style = NULL WHERE singleton`);
    await assert.rejects(
      withAdminClient(h, (c) => verifyBinding(c, ws)),
      (err) => {
        assert.ok(err instanceof InvalidRecordError);
        assert.match(err.message, /force_path_style/);
        assert.match(err.message, /NULL/);
        return true;
      },
    );
  } finally {
    await h.close();
  }
});

test('pg: invariant checker flags ownership and superuser', opts, async () => {
  const h = await makeDb();
  const owner = `ops_owner_${h.suffix}`;
  h.roles.push(owner);
  try {
    await withAdminClient(h, async (c) => {
      await c.query(`CREATE ROLE ${owner} LOGIN PASSWORD 'pw' SUPERUSER`);
      await c.query(`CREATE TABLE roster_ops.owned_probe (id int)`);
      await c.query(`ALTER TABLE roster_ops.owned_probe OWNER TO ${owner}`);
      const report = await checkOpsRoleInvariants(c, owner);
      assert.equal(report.ok, false);
      const kinds = new Set(report.violations.map((v) => v.kind));
      assert.ok(kinds.has('unsafe-attribute'));
      assert.ok(kinds.has('ownership'));
      const ownership = report.violations.find((v) => v.kind === 'ownership' && /owned_probe/.test(v.detail));
      assert.ok(ownership, 'table ownership must be reported');
      assert.match(ownership.remedy, /OWNER TO/);
    });
  } finally {
    await h.close();
  }
});

// ---------------- delivery ledger / PgRemoteTarget ----------------

function mkRecord(workspaceId: string, overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  // Default to a properly SEALED run-event payload so the run-event
  // materialization (insertDataRow) sees the {runId, kind, dedupeKey, ...} shape.
  const payload = overrides.payload ?? sealRunEvent(workspaceId, { runId: 'r1', kind: 'tool-call', correlationId: 'k1', data: { n: 1 } }).payload;
  return {
    id: overrides.id ?? sha256Hex(`rec-${JSON.stringify(payload)}`),
    workspaceId,
    namespace: 'runs',
    kind: 'run-event',
    payload,
    canonical: canonicalJson(payload),
    payloadHash: payloadHashOf(payload),
    producerId: randomUUID(),
    producerSeq: 1,
    enqueuedAt: 1_700_000_000_000,
    artifact: null,
    observations: null,
    objectVersionId: null,
    ...overrides,
  };
}

test('pg: delivery ledger — committed, identical-hash duplicate, different-hash Conflict', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const target = new PgRemoteTarget(pool);
      const record = mkRecord(ws);
      assert.equal(await target.deliver(record), 'committed');
      const rows = await h.pool.query(`SELECT run_id, producer_id, producer_seq, created_at FROM roster_ops.run_events`);
      assert.equal(rows.rowCount, 1);
      assert.equal((rows.rows[0] as { run_id: string }).run_id, 'r1');
      assert.equal((rows.rows[0] as { producer_id: string }).producer_id, record.producerId);
      assert.equal(Number((rows.rows[0] as { created_at: string }).created_at), record.enqueuedAt);

      assert.equal(await target.deliver(record), 'duplicate');
      assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM roster_ops.run_events`)).rows[0]!.n, 1);

      const tampered = mkRecord(ws, { id: record.id, payload: { runId: 'r1', kind: 'tool-call', correlationId: 'k1', data: { n: 999 } } });
      await assert.rejects(target.deliver(tampered), (err) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.id, record.id);
        return true;
      });

      await assert.rejects(target.deliver(mkRecord(randomUUID())), WorkspaceMismatchError);
      await assert.rejects(target.deliver(mkRecord(ws, { kind: 'mystery-kind', id: sha256Hex('mystery') })), InvalidRecordError);

      // hitl materialization: request row lands, decision references its version
      const reqPayload = {
        functionName: 'ops',
        title: 'T',
        action: 'a',
        target: 't',
        contentHash: sha256Hex('c'),
        body: 'b',
        expiresAt: null,
        status: 'awaiting',
      };
      const reqId = sha256Hex('req-1');
      assert.equal(
        await target.deliver(mkRecord(ws, { namespace: 'hitl', kind: 'hitl-request', id: reqId, payload: reqPayload })),
        'committed',
      );
      const decPayload = { requestId: reqId, status: 'approved', decidedBy: 'firat', note: null };
      assert.equal(
        await target.deliver(mkRecord(ws, { namespace: 'hitl', kind: 'hitl-decision', id: sha256Hex('dec-1'), payload: decPayload })),
        'committed',
      );
      const dec = await h.pool.query(`SELECT request_id, request_version, status FROM hitl.decisions`);
      assert.deepEqual(dec.rows[0], { request_id: reqId, request_version: 1, status: 'approved' });

      // a failed apply leaves no half-written state: ledger row count matches data rows
      const ledger = await h.pool.query(
        `SELECT namespace, count(*)::int AS n FROM roster_ops.delivery_ledger GROUP BY namespace ORDER BY namespace`,
      );
      assert.deepEqual(ledger.rows, [
        { namespace: 'hitl', n: 2 },
        { namespace: 'runs', n: 1 },
      ]);
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

// ---------------- partially-committed overlay consistency ----------------

test('pg: a run with 1 committed + 1 queued event shows 2 in BOTH getRun and listRuns (event-granular union)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-partial-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      // Commit 1 event on run R with NO outbox (straight to PG) — models
      // another producer's already-delivered event.
      const direct = createPgBackend({ pool, objects, now: () => clock.t });
      const c1 = await direct.runs.appendEvent({ runId: 'R', kind: 'tool-call', correlationId: 'k-committed', data: { n: 1 } });
      assert.equal(c1.outcome, 'committed');

      // Read through a backend wired with an outbox carrying 1 queued event on
      // the SAME run (this producer's undelivered spool).
      const reader = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const q = runEventParts(ws, { runId: 'R', kind: 'tool-call', correlationId: 'k-queued', data: { n: 2 } }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      const run = await reader.runs.getRun('R');
      assert.ok(run);
      assert.equal(run.events.length, 2, 'getRun unions committed + queued events');

      const list = await reader.runs.listRuns({});
      const summary = list.items.find((r) => r.runId === 'R');
      assert.ok(summary, 'run R must appear in listRuns');
      assert.equal(summary.events, 2, 'listRuns must AGREE with getRun (committed + queued, not committed-only)');
      assert.equal(summary.queued, false, 'a run with a committed event is not overlay-only');

      // count() still counts the run once (run-granular), never double.
      assert.deepEqual(await reader.runs.count(), { committed: 1, queued: 0, partial: false });

      // Same-id / different-hash queued event on an already-committed record must
      // SURFACE as a Conflict — durably parked AND raised by the read. Round-6
      // finding 7: listRuns now raises the SAME ConflictError getRun does for
      // this divergence (previously it completed silently after parking).
      const collide = runEventParts(ws, { runId: 'R', kind: 'tool-call', correlationId: 'k-committed', data: { n: 999 } }, { now: clock.t, pid: 'test' });
      assert.equal(collide.id, c1.id, 'same run/dedupeKey → same record id');
      outbox.enqueue({ namespace: 'runs', id: collide.id, kind: 'run-event', payload: collide.payload });
      await assert.rejects(() => reader.runs.listRuns({}), ConflictError, 'listRuns raises the divergence');
      await assert.rejects(() => reader.runs.getRun('R'), ConflictError, 'consistent with getRun');
      const parked = [...outbox.fold().entries.values()].find((e) => e.entryId === collide.id);
      assert.ok(parked, 'the colliding entry must be tracked');
      assert.equal(parked.status, 'failed-permanent', 'a same-id/different-hash conflict is parked, never hidden');
      assert.equal(parked.failure?.kind, 'conflict');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---------------- R6 finding 4: listRuns surfaces committed canonical conflicts (local↔PG parity) ----------------

test('pg (R6 finding 4): listRuns surfaces a v1/v2 committed canonical conflict the SAME as getRun; a benign retry still collapses', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects: memObjects() });

      async function seedV1(runId: string, phase: string): Promise<void> {
        // A REAL v1 (#318) run-start: physical id under the LITERAL kind:'run-event'
        // scheme, payload uses `type` (not `kind`) and stores {phase}.
        const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId, dedupeKey: 'start' });
        await h.pool.query(
          `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
           VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
          [v1Id, ws, runId, JSON.stringify({ runId, dedupeKey: 'start', type: 'run-start', data: { phase } })],
        );
      }

      // Conflict run: v1 {phase:'old'} + a v2 replay {phase:'new'} — same canonical
      // id, DIFFERENT stable payload. getRun raises (dedupRunEvents); the SQL
      // COUNT(DISTINCT (type,dedupe_key)) summary previously returned a clean
      // one-event count → parity break. listRuns must now raise the SAME conflict.
      await seedV1('r-conflict', 'old');
      await backend.runs.appendEvent({ runId: 'r-conflict', kind: 'run-start', data: { phase: 'new' } });

      // Benign run: v1 {phase:'same'} + a v2 replay {phase:'same'} — same canonical
      // id AND identical stable payload → a true retry that must collapse to ONE
      // event, NEVER a false ConflictError (the candidate detector fires on ANY
      // physical>distinct, so this proves the benign path is not over-eager).
      await seedV1('r-benign', 'same');
      await backend.runs.appendEvent({ runId: 'r-benign', kind: 'run-start', data: { phase: 'same' } });

      // Parity anchor: getRun raises for the conflict run.
      await assert.rejects(() => backend.runs.getRun('r-conflict'), ConflictError);
      // The fix: listRuns raises the SAME conflict (scoped and unscoped).
      await assert.rejects(() => backend.runs.listRuns({ runId: 'r-conflict' }), ConflictError);
      await assert.rejects(() => backend.runs.listRuns({}), ConflictError);

      // The benign retry still collapses to ONE event in both getRun and listRuns.
      const benignRun = await backend.runs.getRun('r-benign');
      assert.ok(benignRun);
      assert.equal(benignRun.events.length, 1, 'benign v1+v2 retry collapses to one event in getRun');
      const benignList = await backend.runs.listRuns({ runId: 'r-benign' });
      const summary = benignList.items.find((r) => r.runId === 'r-benign');
      assert.ok(summary);
      assert.equal(summary.events, 1, 'benign v1+v2 retry counts as ONE canonical event in listRuns (no false conflict)');
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

// ---------------- round-6 finding 7: the listRuns committed/queued overlay merge compares stable hashes ----------------

test('pg (round-6 finding 7): a QUEUED event sharing a committed canonical id with a DIFFERENT stable payload makes listRuns raise ConflictError (not silently suppress)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r6f7-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      // Committed v1 run-start {phase:'old'}: physical id under the LITERAL
      // 'run-event' scheme, so it does NOT collide with the v2 id — only the
      // CANONICAL id (kind, runId, dedupeKey) matches the queued retry below.
      const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'r-div', dedupeKey: 'start' });
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
        [v1Id, ws, 'r-div', JSON.stringify({ runId: 'r-div', dedupeKey: 'start', type: 'run-start', data: { phase: 'old' } })],
      );
      const reader = createPgBackend({ pool, objects: memObjects(), outbox, now: () => clock.t });
      // Queued v2 retry with a DIVERGENT stable payload.
      const q = runEventParts(ws, { runId: 'r-div', kind: 'run-start', data: { phase: 'new' } }, { now: clock.t, pid: 'test' });
      assert.notEqual(q.id, v1Id, 'distinct physical ids — the overlay id/hash union cannot catch this pair');
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      // getRun raises (the parity anchor) — and listRuns must raise the SAME
      // conflict instead of silently suppressing the queued event by canonical id.
      await assert.rejects(() => reader.runs.getRun('r-div'), ConflictError);
      await assert.rejects(() => reader.runs.listRuns({}), ConflictError);
      await assert.rejects(() => reader.runs.listRuns({ runId: 'r-div' }), ConflictError);
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-6 finding 7): a queued BENIGN retry of a committed v1 event (identical stable payload) still merges to one event, no false conflict', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r6f7b-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'r-same', dedupeKey: 'start' });
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
        [v1Id, ws, 'r-same', JSON.stringify({ runId: 'r-same', dedupeKey: 'start', type: 'run-start', data: { phase: 'same' } })],
      );
      const reader = createPgBackend({ pool, objects: memObjects(), outbox, now: () => clock.t });
      const q = runEventParts(ws, { runId: 'r-same', kind: 'run-start', data: { phase: 'same' } }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      const list = await reader.runs.listRuns({});
      const summary = list.items.find((r) => r.runId === 'r-same');
      assert.ok(summary, 'the run appears');
      assert.equal(summary.events, 1, 'the queued benign retry is suppressed by matching stable hash — counted once');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ── round-7 finding 1: the committed↔queued arbiter is watermark-INDEPENDENT ──
//
// The committed-side canonical map was bounded by the pagination watermark, so a
// committed row that landed ABOVE it (an outage recovering mid-pagination) was
// invisible to the arbiter: listRuns reported a clean one-event queued summary
// while getRun raised the ConflictError. Identity/divergence is not a snapshot
// concern — the arbiter now reads every committed row of the runs that carry
// queued events, exactly as getRun and readRunThrough do.

test('pg (round-7 finding 1): a committed row landing ABOVE the pagination watermark is still arbitrated against its queued retry', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f1-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      // One committed anchor run so page 1 fills its limit and freezes a watermark.
      const direct = createPgBackend({ pool, objects: memObjects(), now: () => clock.t });
      await direct.runs.appendEvent({ runId: 'r-anchor', kind: 'run-start', data: { n: 1 } });

      const reader = createPgBackend({ pool, objects: memObjects(), outbox, now: () => clock.t });
      // r-div has ONLY a queued v2 retry when the cursor is minted.
      const q = runEventParts(ws, { runId: 'r-div', kind: 'run-start', data: { phase: 'new' } }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      const page1 = await reader.runs.listRuns({ limit: 1 });
      assert.deepEqual(page1.items.map((i) => i.runId), ['r-anchor']);
      assert.ok(page1.cursor, 'the queued run is carried to page 2');

      // The outage heals mid-pagination: r-div's DIVERGENT v1 row commits at a
      // seq ABOVE the frozen watermark.
      const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'r-div', dedupeKey: 'start' });
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
        [v1Id, ws, 'r-div', JSON.stringify({ runId: 'r-div', dedupeKey: 'start', type: 'run-start', data: { phase: 'old' } })],
      );

      // Parity anchor: getRun raises for the divergence.
      await assert.rejects(() => reader.runs.getRun('r-div'), ConflictError);
      // The fix: page 2 raises the SAME conflict instead of a clean summary.
      await assert.rejects(() => reader.runs.listRuns({ limit: 1 }, page1.cursor!), ConflictError);
      await assert.rejects(() => reader.runs.listRuns({ runId: 'r-div' }), ConflictError);
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 1): a BENIGN retry of a row committed above the watermark still merges to one event (no false conflict)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f1b-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const direct = createPgBackend({ pool, objects: memObjects(), now: () => clock.t });
      await direct.runs.appendEvent({ runId: 'r-anchor', kind: 'run-start', data: { n: 1 } });

      const reader = createPgBackend({ pool, objects: memObjects(), outbox, now: () => clock.t });
      const q = runEventParts(ws, { runId: 'r-same', kind: 'run-start', data: { phase: 'same' } }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      const page1 = await reader.runs.listRuns({ limit: 1 });
      assert.deepEqual(page1.items.map((i) => i.runId), ['r-anchor']);
      assert.ok(page1.cursor);

      const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'r-same', dedupeKey: 'start' });
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
        [v1Id, ws, 'r-same', JSON.stringify({ runId: 'r-same', dedupeKey: 'start', type: 'run-start', data: { phase: 'same' } })],
      );

      const page2 = await reader.runs.listRuns({ limit: 1 }, page1.cursor!);
      const summary = page2.items.find((r) => r.runId === 'r-same');
      assert.ok(summary, 'the run still appears exactly once');
      assert.equal(summary.events, 1, 'the identical-payload retry dedups — no false conflict, no double count');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---------------- finding 6: point reads surface queued conflicts ----------------

test('pg finding 6: getRequest surfaces + parks a queued same-id/different-hash conflict (never silently returns the committed row)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f6-req-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { hitlRequestParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const identity = { functionName: 'growth', action: 'publish', target: 'x.com/roster', contentHash: sha256Hex('c') };
      // Commit request X 'old' straight to PG (no outbox).
      const direct = createPgBackend({ pool, objects, now: () => clock.t });
      const committed = await direct.hitl.createRequest({ ...identity, title: 'old', body: 'old-body', expiresAt: null });
      assert.equal(committed.outcome, 'committed');

      // Enqueue the SAME id 'new' via the outbox (same identity → same id; the
      // different title/body → a different payload hash).
      const reader = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const q = hitlRequestParts(ws, { ...identity, title: 'new', body: 'new-body', expiresAt: null });
      assert.equal(q.id, committed.id, 'same identity → same record id');
      outbox.enqueue({ namespace: 'hitl', id: q.id, kind: 'hitl-request', payload: q.payload });

      // getRequest MUST surface the conflict, not silently return 'old'.
      await assert.rejects(reader.hitl.getRequest(committed.id), ConflictError);
      // ...and PARK the conflicting queued entry.
      const parked = outbox.fold().entries.get(q.id);
      assert.ok(parked);
      assert.equal(parked.status, 'failed-permanent');
      assert.equal(parked.failure?.kind, 'conflict');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg finding 4: identical bytes with DIFFERENT meta DEDUP to one blob (content-only identity) — no queued conflict', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f4-art-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { artifactParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const bytes = Buffer.from('artifact-bytes');
      const direct = createPgBackend({ pool, objects, now: () => clock.t });
      const committed = await direct.artifacts.putArtifact({ filename: 'a.txt', contentType: 'text/plain', runId: null }, bytes);
      assert.equal(committed.outcome, 'committed');

      // Same bytes → same id. Under content-only identity the meta is a store
      // observation (NOT hashed), so a re-put with DIFFERENT meta derives the
      // SAME payload hash — a clean DUPLICATE, never a ConflictError (finding:
      // blob identity must not include run metadata).
      const reader = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const q = artifactParts(ws, { filename: 'DIFFERENT.txt', contentType: 'text/plain', runId: null }, bytes);
      assert.equal(q.digest, committed.digest, 'same bytes → same digest');
      assert.equal(q.id, committed.id, 'same bytes → same content-only blob id');
      assert.equal(payloadHashOf(q.payload), payloadHashOf(artifactParts(ws, { filename: 'a.txt', contentType: 'text/plain', runId: null }, bytes).payload), 'meta is excluded from the hash → identical payload hash');
      outbox.enqueueArtifact(
        { namespace: 'artifacts', id: q.id, kind: 'artifact', payload: q.payload, observations: q.observations },
        bytes,
      );

      // The point reads return the committed row normally — NO conflict surfaced.
      const head = await reader.artifacts.head(committed.digest);
      assert.ok(head, 'head returns the committed blob (no conflict)');
      const got = await reader.artifacts.getArtifact(committed.digest);
      assert.ok(got, 'getArtifact returns the committed blob (no conflict)');
      // The queued entry is a clean duplicate on overlay — never parked as conflict.
      const overlaid = outbox.overlay('artifacts', [{ id: committed.id, payloadHash: payloadHashOf(q.payload) }]);
      assert.equal(overlaid.conflicts.length, 0, 'no conflict — same id + same hash is a duplicate');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---------------- finding 5: grouped run cursor stability across a partial drain ----------------

test('pg finding 5: listRuns yields each run exactly once when a run event acks between pages (no omission/duplication)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f5-runs-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const reader = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      // All queued (offline). S first (anchor seq1); R twice (seq2, seq3).
      const s = runEventParts(ws, { runId: 'S', kind: 'run-start', data: null }, { now: clock.t, pid: 'test' });
      const r2 = runEventParts(ws, { runId: 'R', kind: 'run-start', data: null }, { now: clock.t, pid: 'test' });
      const r3 = runEventParts(ws, { runId: 'R', kind: 'tool-call', correlationId: 'k3', data: null }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: s.id, kind: 'run-event', payload: s.payload });
      outbox.enqueue({ namespace: 'runs', id: r2.id, kind: 'run-event', payload: r2.payload });
      outbox.enqueue({ namespace: 'runs', id: r3.id, kind: 'run-event', payload: r3.payload });

      // Page 1 (limit 1): S (anchor seq1 sorts first).
      const page1 = await reader.runs.listRuns({ limit: 1 });
      assert.deepEqual(page1.items.map((r) => r.runId), ['S']);
      assert.ok(page1.cursor !== null);

      // Partial drain: ack S/seq1 AND R/seq2 (commit to PG); R/seq3 delivery fails.
      const flaky: RemoteTarget = {
        async deliver(record: OutboxRecord): Promise<DeliverResult> {
          if (record.id === r3.id) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
          return await reader.remote.deliver(record);
        },
      };
      await outbox.drain(flaky, { objects: new S3ObjectTarget(objects) });
      assert.equal(outbox.fold().entries.get(s.id)!.status, 'acked');
      assert.equal(outbox.fold().entries.get(r2.id)!.status, 'acked');
      assert.equal(outbox.fold().entries.get(r3.id)!.status, 'queued');

      // Page 2 must still reach R (pre-fix it was OMITTED: R had a committed
      // event and the unbounded committed-run filter skipped it).
      const page2 = await reader.runs.listRuns({ limit: 10 }, page1.cursor!);
      assert.ok(page2.items.some((r) => r.runId === 'R'), 'R must remain reachable after an earlier event committed');

      // Full pagination yields each logical run exactly once.
      const seen: string[] = [...page1.items.map((r) => r.runId)];
      let cursor: Cursor | null = page1.cursor;
      let guard = 0;
      while (cursor !== null) {
        const page: Awaited<ReturnType<typeof reader.runs.listRuns>> = await reader.runs.listRuns({ limit: 1 }, cursor);
        for (const r of page.items) seen.push(r.runId);
        cursor = page.cursor;
        if (++guard > 20) assert.fail('pagination did not terminate');
      }
      assert.deepEqual(seen.sort(), ['R', 'S'], 'each run appears exactly once across the whole pagination');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 4): a run queued at page 1 that FULLY commits+acks before page 2 is still returned exactly once', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f4-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const reader = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      // Both runs queued (offline); watermark at page 1 is 0.
      const s = runEventParts(ws, { runId: 'S', kind: 'run-start', data: null }, { now: clock.t, pid: 'test' });
      const r = runEventParts(ws, { runId: 'R', kind: 'run-start', data: null }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: s.id, kind: 'run-event', payload: s.payload });
      outbox.enqueue({ namespace: 'runs', id: r.id, kind: 'run-event', payload: r.payload });

      const page1 = await reader.runs.listRuns({ limit: 1 });
      assert.deepEqual(page1.items.map((x) => x.runId), ['S']);
      assert.ok(page1.cursor !== null);

      // FULL drain between pages: every queued event commits (at seq > 0) and
      // acks — R is no longer pending AND its committed rows sit above the
      // frozen watermark. Pre-fix R vanished from the traversal entirely.
      await outbox.drain(reader.remote, { objects: new S3ObjectTarget(objects) });
      assert.equal(outbox.fold().entries.get(s.id)!.status, 'acked');
      assert.equal(outbox.fold().entries.get(r.id)!.status, 'acked');

      const page2 = await reader.runs.listRuns({ limit: 10 }, page1.cursor!);
      assert.deepEqual(page2.items.map((x) => x.runId), ['R'], 'the frozen cursor reads R through by id');
      assert.equal(page2.items[0]!.events, 1, 'the read-through summary counts canonical events');

      // Whole traversal (limit 1 per page): each run exactly once, terminates.
      const seen: string[] = [];
      let cursor: Cursor | null = null;
      let guard = 0;
      do {
        const page: Awaited<ReturnType<typeof reader.runs.listRuns>> = await reader.runs.listRuns({ limit: 1 }, cursor ?? undefined);
        for (const x of page.items) seen.push(x.runId);
        cursor = page.cursor;
        if (++guard > 20) assert.fail('pagination did not terminate');
      } while (cursor !== null);
      const counts = new Map<string, number>();
      for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
      assert.deepEqual([...counts.entries()].sort(), [['R', 1], ['S', 1]], 'no omission, no duplication');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 3): a conflicting queued retry on a run OUTSIDE the requested page still raises ConflictError (after the page)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f3a-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      // Committed: 'a-first' (seq 1, clean) then a v1-form 'z-div' (seq 2) whose
      // physical id differs from the v2 id — only the CANONICAL id collides with
      // the queued retry, so the overlay id/hash union cannot catch it.
      const direct = createPgBackend({ pool, objects: memObjects(), now: () => clock.t });
      await direct.runs.appendEvent({ runId: 'a-first', kind: 'run-start', data: { phase: 'ok' } });
      const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'z-div', dedupeKey: 'start' });
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
        [v1Id, ws, 'z-div', JSON.stringify({ runId: 'z-div', dedupeKey: 'start', type: 'run-start', data: { phase: 'old' } })],
      );
      const reader = createPgBackend({ pool, objects: memObjects(), outbox, now: () => clock.t });
      const q = runEventParts(ws, { runId: 'z-div', kind: 'run-start', data: { phase: 'DIVERGENT' } }, { now: clock.t, pid: 'test' });
      assert.notEqual(q.id, v1Id, 'distinct physical ids — only the canonical check can see the divergence');
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      // Page 1 (limit 1) contains only 'a-first' — z-div is BEYOND the page.
      // Pre-fix the check ran only for in-page items, so this call completed
      // silently and the divergence was discarded at the committed-run skip.
      await assert.rejects(() => reader.runs.listRuns({ limit: 1 }), ConflictError, 'off-page divergence must still raise');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 3): a conflicting queued retry on a run BEFORE the requested page (already returned) still raises ConflictError', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f3b-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      // v1-form 'a-div' at seq 1, clean 'b-second' at seq 2.
      const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'a-div', dedupeKey: 'start' });
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
         VALUES ($1, $2::uuid, $3, 'start', 'run-start', $4::jsonb, 0)`,
        [v1Id, ws, 'a-div', JSON.stringify({ runId: 'a-div', dedupeKey: 'start', type: 'run-start', data: { phase: 'old' } })],
      );
      const direct = createPgBackend({ pool, objects: memObjects(), now: () => clock.t });
      await direct.runs.appendEvent({ runId: 'b-second', kind: 'run-start', data: { phase: 'ok' } });

      const reader = createPgBackend({ pool, objects: memObjects(), outbox, now: () => clock.t });
      // Page 1 BEFORE any divergence exists — clean, returns 'a-div'.
      const page1 = await reader.runs.listRuns({ limit: 1 });
      assert.deepEqual(page1.items.map((x) => x.runId), ['a-div']);
      assert.ok(page1.cursor !== null);

      // NOW a divergent retry of the already-returned 'a-div' is queued.
      const q = runEventParts(ws, { runId: 'a-div', kind: 'run-start', data: { phase: 'DIVERGENT' } }, { now: clock.t, pid: 'test' });
      outbox.enqueue({ namespace: 'runs', id: q.id, kind: 'run-event', payload: q.payload });

      // Page 2 contains only 'b-second' — a-div is BEFORE the page and will
      // never re-enter items. Pre-fix its conflicting retry was silently
      // discarded; the divergence must raise here.
      await assert.rejects(() => reader.runs.listRuns({ limit: 10 }, page1.cursor!), ConflictError);
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 6): a v1 blob with NULL object_version_id redeclared while the store returns a VersionId is NOT marked verified', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const bytes = Buffer.from('v1 blob, versionless row, round-7 finding 6');
    const digest = sha256Hex(bytes);
    const meta = { filename: 'old.md', contentType: 'text/markdown', runId: 'run-old' };
    const id = computeRecordId(ws, 'artifacts', { kind: 'artifact', digest });
    // A REAL v1 blob row (object_version_id NULL) + its delivery-ledger row, so
    // the v2 re-put dedups the row instead of inserting a fresh one.
    const v1Hash = sha256Hex(canonicalJson({ digest, size: bytes.byteLength, meta }));
    await h.pool.query(
      `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 0)`,
      [id, ws, digest, bytes.byteLength, JSON.stringify(meta)],
    );
    await h.pool.query(
      `INSERT INTO roster_ops.delivery_ledger (workspace_id, namespace, record_id, payload_hash)
       VALUES ($1::uuid, 'artifacts', $2, $3)`,
      [ws, id, v1Hash],
    );
    const objects = memObjects(); // fresh store: putIfAbsent WILL return a VersionId for the object
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects });
      const put = await backend.artifacts.putArtifact(
        { filename: 'new.md', contentType: 'text/markdown', runId: 'run-new' },
        bytes,
        { runId: 'run-new', declaringAgent: 'writer', role: 'produced' },
      );
      assert.equal(put.blobOutcome, 'committed', 'the v1 row dedups');
      // The op DID observe a VersionId (it stored/found the latest object) — but
      // the committed ROW records none, and the row is the verification
      // authority: reads pin to the row's version (NULL → latest fallback), so
      // blessing the declaration against the op's observation verifies the
      // wrong thing.
      assert.equal(put.objectVersionId, null, 'the result reports the ROW authority, not the latest-object observation');
      const decl = (
        await h.pool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [put.declarationId])
      ).rows[0] as { version_state: string };
      assert.equal(decl.version_state, 'unverified', 'only the explicit admin repair may bless a versionless row');
      const blob = (
        await h.pool.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE workspace_id = $1::uuid AND digest = $2`, [ws, digest])
      ).rows[0] as { object_version_id: string | null };
      assert.equal(blob.object_version_id, null, 'the committed row is untouched (admin repair is the only writer)');
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

test('pg finding 13: a healthy outbox artifact write returns a VersionId → declaration version_state=verified (no repair)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f13-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      // The healthy write-through path (outbox drains immediately).
      const backend = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const bytes = randomBytes(48);
      const res = await backend.artifacts.putArtifact(
        { filename: 'r.md', contentType: 'text/markdown', runId: 'run-13' },
        bytes,
        { runId: 'run-13', declaringAgent: 'writer', role: 'produced' },
      );
      assert.equal(res.blobOutcome, 'committed');
      assert.equal(res.declarationOutcome, 'committed');
      // The immutable VersionId is threaded back (was discarded before the fix).
      assert.ok(res.objectVersionId !== null, 'putArtifact surfaces the drained object version id');
      // The blob row records the version…
      const blob = (await pool.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE digest = $1`, [res.digest])).rows[0] as { object_version_id: string | null };
      assert.equal(blob.object_version_id, res.objectVersionId);
      // …and the declaration is version_state='verified' WITHOUT any admin repair.
      const decl = (await pool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [res.declarationId])).rows[0] as { version_state: string };
      assert.equal(decl.version_state, 'verified', 'a normal artifact needs no repair to be verified');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ── round-7 finding 5: an OFFLINE artifact converges to version_state=verified ──
//
// A declaration queued during an outage snapshots version_state='unverified'
// (the immutable object version cannot be observed yet). On drain the blob
// commits WITH its objectVersionId, but the declaration used to materialize from
// the stale observation and stay 'unverified' forever — a silently unconverged
// artifact that only an operator-initiated repair would fix. The declaration now
// derives its verified state at ORDERED materialization (its blob commits first
// in the same namespace), and doctor reports any residual.

test('pg (round-7 finding 5): an artifact queued OFFLINE drains to version_state=verified without any repair', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f5-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const livePool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const deadPool = new BoundPool({ connectionString: 'postgresql://nobody@127.0.0.1:9/nope', workspaceId: ws });
    try {
      const dead = createPgBackend({ pool: deadPool, objects, outbox, now: () => clock.t });
      const live = createPgBackend({ pool: livePool, objects, outbox, now: () => clock.t });

      const bytes = randomBytes(32);
      const queued = await dead.artifacts.putArtifact(
        { filename: 'offline.md', contentType: 'text/markdown', runId: 'run-off' },
        bytes,
        { runId: 'run-off', declaringAgent: 'writer', role: 'produced' },
      );
      assert.equal(queued.outcome, 'queued');
      assert.equal(queued.declarationOutcome, 'queued');

      clock.t += 120_000; // past the transient-failure backoff
      const report = await outbox.drain(live.remote, { objects: new S3ObjectTarget(objects) });
      assert.equal(report.namespaces.artifacts?.remaining ?? 0, 0, 'the artifact namespace fully drains');

      const blob = (
        await livePool.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE digest = $1`, [queued.digest])
      ).rows[0] as { object_version_id: string | null };
      assert.ok(blob.object_version_id !== null, 'the drained blob records its immutable version');
      const decl = (
        await livePool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [
          queued.declarationId,
        ])
      ).rows[0] as { version_state: string };
      assert.equal(decl.version_state, 'verified', 'convergence is not left for a manual repair');
    } finally {
      await livePool.end();
      await deadPool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 5): the DEGRADED backend spool converges the same way (sibling path parity)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), 'roster-pg-r7f5c-'));
  try {
    await stampAndFinalize(h, ws);
    // The store a REAL outage uses: resolveOpsBackend returns the degraded
    // backend (it never reaches PG), so its spool is the sibling of the healthy
    // write-through path above and must carry the same version-pending marker.
    mkdirSync(join(cwd, 'roster'), { recursive: true });
    writeFileSync(
      join(cwd, 'roster', 'persistence.yaml'),
      [
        'version: 1',
        'workspace:',
        `  id: ${ws}`,
        '  name: acme',
        'backend: postgres-s3',
        'postgres:',
        '  database: dedicated',
        'objects:',
        '  bucket: acme-ops',
        '  region: null',
        '  endpoint: null',
        '  force_path_style: false',
      ].join('\n') + '\n',
    );
    const files = new MemoryFileStore();
    const resolved = await resolveOpsBackend(cwd, {
      env: { ROSTER_OPS_URL: 'postgresql://nobody@127.0.0.1:9/nope' } as NodeJS.ProcessEnv,
      files,
    });
    assert.equal(resolved.state, 'degraded');
    if (resolved.state !== 'degraded') return;
    const queued = await resolved.backend.artifacts.putArtifact(
      { filename: 'degraded.md', contentType: 'text/markdown', runId: 'run-deg' },
      randomBytes(24),
      { runId: 'run-deg', declaringAgent: 'writer', role: 'produced' },
    );
    assert.equal(queued.outcome, 'queued');

    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const objects = new CreateOnlyFileStore(files);
      const live = createPgBackend({ pool, objects, outbox: resolved.outbox });
      await resolved.outbox.drain(live.remote, { objects: new S3ObjectTarget(objects) });
      const decl = (
        await pool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [
          queued.declarationId,
        ])
      ).rows[0] as { version_state: string };
      assert.equal(decl.version_state, 'verified', 'the degraded spool converges without a manual repair too');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('pg (round-7 finding 5): a drained declaration whose blob row has NO version id stays unverified (never falsely blessed)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-r7f5b-'));
  try {
    await stampAndFinalize(h, ws);
    // A REAL v1 blob row (object_version_id NULL) + its delivery-ledger row, so
    // the queued blob DEDUPS on drain and the row keeps its NULL version. The
    // drained declaration must NOT be blessed against an object version the ROW
    // does not record (the round-7 finding 6 authority rule).
    const bytes = Buffer.from('v1 versionless row + an offline redeclare');
    const digest = sha256Hex(bytes);
    const meta = { filename: 'old.md', contentType: 'text/markdown', runId: 'run-old' };
    const blobId = computeRecordId(ws, 'artifacts', { kind: 'artifact', digest });
    const v1Hash = sha256Hex(canonicalJson({ digest, size: bytes.byteLength, meta }));
    await h.pool.query(
      `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 0)`,
      [blobId, ws, digest, bytes.byteLength, JSON.stringify(meta)],
    );
    await h.pool.query(
      `INSERT INTO roster_ops.delivery_ledger (workspace_id, namespace, record_id, payload_hash)
       VALUES ($1::uuid, 'artifacts', $2, $3)`,
      [ws, blobId, v1Hash],
    );
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const livePool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const deadPool = new BoundPool({ connectionString: 'postgresql://nobody@127.0.0.1:9/nope', workspaceId: ws });
    try {
      const dead = createPgBackend({ pool: deadPool, objects, outbox, now: () => clock.t });
      const live = createPgBackend({ pool: livePool, objects, outbox, now: () => clock.t });
      const queued = await dead.artifacts.putArtifact(meta, bytes, {
        runId: 'run-old',
        declaringAgent: 'writer',
        role: 'produced',
      });
      assert.equal(queued.outcome, 'queued');
      clock.t += 120_000;
      await outbox.drain(live.remote, { objects: new S3ObjectTarget(objects) });

      const blob = (
        await livePool.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE digest = $1`, [digest])
      ).rows[0] as { object_version_id: string | null };
      assert.equal(blob.object_version_id, null, 'the v1 row is untouched — admin repair is its only writer');
      const decl = (
        await livePool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [
          queued.declarationId,
        ])
      ).rows[0] as { version_state: string };
      assert.equal(decl.version_state, 'unverified', 'no version id on the ROW → no blessing on drain either');
    } finally {
      await livePool.end();
      await deadPool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg finding 14: declare-artifact with an invalid role writes NO blob and queues NO upload', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f14-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const bytes = randomBytes(32);
      const digest = sha256Hex(bytes);
      await assert.rejects(
        backend.artifacts.putArtifact({ filename: 'x', contentType: 'text/plain', runId: 'r' }, bytes, {
          runId: 'r',
          declaringAgent: 'a',
          role: 'nope' as never,
        }),
        InvalidRecordError,
      );
      // No object was uploaded and nothing was queued (validation ran first).
      assert.equal(await objects.head({ prefix: 'artifacts', segments: [digest] }), null, 'no object uploaded');
      assert.equal(outbox.fold().entries.size, 0, 'no queued blob/upload');
      const blobRows = await pool.query(`SELECT 1 FROM roster_ops.artifacts WHERE workspace_id = $1::uuid`, [ws]);
      assert.equal(blobRows.rowCount, 0, 'no blob row committed');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg finding 16: getDeclaration/getByRun surface a committed-vs-queued same-id declaration conflict', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f16-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { externalDeclarationParts } = await import('../src/lib/persistence/artifact-declarations.ts');
    try {
      // Machine A commits an external declaration directly → it lands in PG.
      const direct = createPgBackend({ pool, objects, now: () => clock.t });
      const committed = await direct.artifacts.putExternal({
        runId: 'run-x',
        declaringAgent: 'agent-1',
        role: 'used',
        provider: 'github',
        externalId: 'issue-7',
        externalUrl: 'https://github.com/a',
      });
      assert.equal(committed.outcome, 'committed');
      // Machine B (a SEPARATE outbox) queues a CONFLICTING declaration: SAME
      // identity (same run/agent/role/ref), DIFFERENT payload (a different url).
      const ledgerB = new LocalLedger({ opsRoot: join(dir, 'opsB'), workspaceId: ws, now: () => ++clock.t });
      const outboxB = new LocalOutbox({ ledger: ledgerB, now: () => clock.t, rng: () => 0 });
      const conflicting = externalDeclarationParts(ws, {
        runId: 'run-x',
        declaringAgent: 'agent-1',
        role: 'used',
        provider: 'github',
        externalId: 'issue-7',
        externalUrl: 'https://github.com/b',
      });
      assert.equal(conflicting.id, committed.id, 'same declaration identity');
      outboxB.enqueue({
        namespace: 'artifacts',
        id: conflicting.id,
        kind: 'artifact-declaration',
        payload: conflicting.payload,
        observations: conflicting.observations,
      });
      const readerB = createPgBackend({ pool, objects, outbox: outboxB, now: () => clock.t });
      // getByRun surfaces (parks) the conflict — the conflicting entry appears
      // rather than being silently dropped by a committed-id filter.
      const byRun = await readerB.artifacts.getByRun('run-x');
      assert.ok(
        byRun.some((d) => d.id === conflicting.id && d.queued),
        'getByRun surfaces the queued conflicting declaration',
      );
      // getDeclaration must NOT silently return the committed row — it surfaces
      // the conflict as a ConflictError.
      await assert.rejects(readerB.artifacts.getDeclaration(conflicting.id), ConflictError);
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('pg finding 5 sweep: listRequests stays cursor-stable when a queued request acks between pages', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-f5-req-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    const { hitlRequestParts } = await import('../src/lib/persistence/postgres/stores.ts');
    try {
      const reader = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const a = hitlRequestParts(ws, { functionName: 'g', title: 'A', action: 'publish', target: 't', contentHash: sha256Hex('a'), body: 'a', expiresAt: null });
      const b = hitlRequestParts(ws, { functionName: 'g', title: 'B', action: 'publish', target: 't', contentHash: sha256Hex('b'), body: 'b', expiresAt: null });
      outbox.enqueue({ namespace: 'hitl', id: a.id, kind: 'hitl-request', payload: a.payload });
      outbox.enqueue({ namespace: 'hitl', id: b.id, kind: 'hitl-request', payload: b.payload });

      const page1 = await reader.hitl.listRequests({ limit: 1 });
      assert.equal(page1.items.length, 1);
      const firstId = page1.items[0]!.id;
      assert.ok(page1.cursor !== null);

      // Ack the first queued request (commit to PG); the other stays queued.
      const flaky: RemoteTarget = {
        async deliver(record: OutboxRecord): Promise<DeliverResult> {
          if (record.id === firstId) return await reader.remote.deliver(record);
          throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        },
      };
      await outbox.drain(flaky);
      assert.equal(outbox.fold().entries.get(firstId)!.status, 'acked');

      // Page 2 must not re-emit the already-returned (now committed) request.
      const page2 = await reader.hitl.listRequests({ limit: 10 }, page1.cursor!);
      assert.ok(!page2.items.some((i) => i.id === firstId), 'the acked request must not reappear');

      const seen = new Set<string>([firstId, ...page2.items.map((i) => i.id)]);
      assert.equal(seen.size, 2, 'both requests are reachable exactly once across pagination');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---------------- capabilities ----------------

test('pg: backendInfo from the two meta tables; future component refuses before any write', opts, async () => {
  const h = await makeDb();
  const bare = await makeDb(false);
  try {
    const info = await pgBackendInfo(h.pool);
    assert.equal(info.backend, 'postgres-s3');
    assert.equal(info.components.hitl.version, 1);
    assert.deepEqual([...info.components.hitl.capabilities], ['requests', 'decisions']);
    // #323: roster_ops + objects migrate to v2 (run-ledger + object versioning).
    assert.equal(info.components.roster_ops.version, 2);
    assert.deepEqual([...info.components.roster_ops.capabilities], ['runs', 'artifacts', 'outbox', 'checkpoint', 'run-ledger']);
    assert.equal(info.components.objects.version, 2);
    assert.deepEqual([...info.components.objects.capabilities], ['content-addressed', 'create-only', 'version-id', 'list-prefix']);
    assertBackendSupported(info);

    // admin-authored skew: a future hitl version must refuse before writes
    await h.pool.query(`UPDATE hitl.meta SET component_version = 99 WHERE singleton`);
    const skewed = await pgBackendInfo(h.pool);
    assert.throws(() => assertComponentSupported(skewed, 'hitl'), VersionSkewError);
    // the other components stay independently negotiable
    assertComponentSupported(skewed, 'roster_ops');

    await assert.rejects(pgBackendInfo(bare.pool), NotConfiguredError);
  } finally {
    await h.close();
    await bare.close();
  }
});

// ---------------- outbox composition (tri-state + overlay counts) ----------------

test('pg: stores writeThrough the outbox — queued offline, drained in order, overlay counts', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-outbox-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();

    const livePool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    // port 9 (discard) refuses immediately — a pure transport outage
    const deadPool = new BoundPool({ connectionString: 'postgresql://nobody@127.0.0.1:9/nope', workspaceId: ws });
    try {
      const live = createPgBackend({ pool: livePool, objects, outbox, now: () => clock.t });
      const dead = createPgBackend({ pool: deadPool, objects, outbox, now: () => clock.t });

      // online write: committed straight through the ledger transaction
      const first = await live.hitl.createRequest({
        functionName: 'ops',
        title: 'first',
        action: 'a',
        target: 't1',
        contentHash: sha256Hex('one'),
        body: 'b',
        expiresAt: null,
      });
      assert.equal(first.outcome, 'committed');

      // offline writes: durably queued, tri-state honest
      const second = await dead.hitl.createRequest({
        functionName: 'ops',
        title: 'second',
        action: 'a',
        target: 't2',
        contentHash: sha256Hex('two'),
        body: 'b',
        expiresAt: null,
      });
      assert.equal(second.outcome, 'queued');
      const evt = await dead.runs.appendEvent({ runId: 'r1', kind: 'tool-call', correlationId: 'k1', data: null });
      assert.equal(evt.outcome, 'queued');
      const art = await dead.artifacts.putArtifact(
        { filename: 'a.bin', contentType: 'application/octet-stream', runId: 'r1' },
        Buffer.from('artifact-bytes'),
      );
      assert.equal(art.outcome, 'queued');
      assert.equal(art.digest, sha256Hex(Buffer.from('artifact-bytes')));

      // decisions are fail-closed: never spooled, actionable error instead
      await assert.rejects(
        dead.hitl.appendDecision({ requestId: second.id, status: 'approved', decidedBy: 'firat', note: null }),
        BackendUnavailableError,
      );
      assert.ok(![...outbox.fold().entries.values()].some((e) => e.kind === 'hitl-decision'));

      // live count overlays the queued entries without double-counting
      const count = await live.hitl.count();
      assert.deepEqual(count, { committed: 1, queued: 1, partial: false });
      assert.deepEqual(await live.runs.count(), { committed: 0, queued: 1, partial: false });

      // The outage window: queued records are VISIBLE in get/list, flagged
      // queued: true with seq null — reads and counts agree.
      const gotQueued = await live.hitl.getRequest(second.id);
      assert.ok(gotQueued !== null, 'a queued request is visible to getRequest');
      assert.equal(gotQueued.queued, true);
      assert.equal(gotQueued.seq, null);
      assert.equal(gotQueued.title, 'second');
      const listing = await live.hitl.listRequests({});
      assert.equal(listing.items.length, 2);
      assert.deepEqual(
        listing.items.map((i) => [i.title, i.queued]),
        [['first', false], ['second', true]],
        'queued entries order after committed rows',
      );
      const gotCommitted = await live.hitl.getRequest(first.id);
      assert.ok(gotCommitted !== null && gotCommitted.queued === false && gotCommitted.seq !== null);
      const queuedRun = await live.runs.getRun('r1');
      assert.ok(queuedRun !== null, 'a queued run is visible to getRun');
      assert.deepEqual(queuedRun.events.map((e) => [e.dedupeKey, e.queued, e.seq]), [['k1', true, null]]);
      const runList = await live.runs.listRuns({});
      assert.deepEqual(runList.items.map((r) => [r.runId, r.queued]), [['r1', true]]);
      const queuedArt = await live.artifacts.getArtifact(art.digest);
      assert.ok(queuedArt !== null, 'a queued artifact is readable (spool bytes)');
      assert.equal(queuedArt.record.queued, true);
      assert.deepEqual(queuedArt.bytes, Buffer.from('artifact-bytes'));
      const queuedHead = await live.artifacts.head(art.digest);
      assert.ok(queuedHead !== null && queuedHead.queued === true);

      // a live write BEHIND queued entries cannot overtake them: it lands
      // queued and the whole namespace drains in order
      clock.t += 120_000; // past the transient-failure backoff
      const third = await live.hitl.createRequest({
        functionName: 'ops',
        title: 'third',
        action: 'a',
        target: 't3',
        contentHash: sha256Hex('three'),
        body: 'b',
        expiresAt: null,
      });
      assert.equal(third.outcome, 'committed', 'the barrier drains queued entries first, then commits');
      const hitlAfter = await live.hitl.count();
      assert.deepEqual(hitlAfter, { committed: 3, queued: 0, partial: false });

      // drain the remaining namespaces object-first
      const report = await outbox.drain(live.remote, { objects: new S3ObjectTarget(objects) });
      assert.equal(report.namespaces.runs?.remaining ?? 0, 0);
      assert.equal(report.namespaces.artifacts?.remaining ?? 0, 0);
      assert.deepEqual(await live.runs.count(), { committed: 1, queued: 0, partial: false });

      // object-first invariant: the committed index row has readable bytes
      const fetched = await live.artifacts.getArtifact(art.digest);
      assert.ok(fetched);
      assert.deepEqual(fetched.bytes, Buffer.from('artifact-bytes'));
      assert.equal(fetched.record.meta.filename, 'a.bin');
      assert.equal(fetched.record.queued, false, 'the drained artifact flips to committed');
      const drained = await live.hitl.getRequest(second.id);
      assert.ok(drained !== null && drained.queued === false && drained.seq !== null, 'the drained request flips to committed');

      // idempotent replay across paths: the drained request now dedups direct
      const replay = await live.hitl.createRequest({
        functionName: 'ops',
        title: 'second',
        action: 'a',
        target: 't2',
        contentHash: sha256Hex('two'),
        body: 'b',
        expiresAt: null,
      });
      assert.equal(replay.outcome, 'committed');
      assert.equal(replay.id, second.id);
      assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests`)).rows[0]!.n, 3);
    } finally {
      await livePool.end();
      await deadPool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---------------- #318 R4 finding 1 + 4: healthy-store allowPartial gating (hermetic) ----------------

// A fake BoundPool whose queries always throw a chosen error — lets us exercise
// the read/count catch classification without a live database (runs in BOTH env
// modes). Only the read boundaries are hit, so deliver()/connect() are never
// reached in these tests.
function throwingBoundPool(workspaceId: string, err: unknown): BoundPool {
  return {
    workspaceId,
    query: async () => {
      throw err;
    },
    connect: async () => {
      throw err;
    },
    end: async () => {},
  } as unknown as BoundPool;
}

function queuedHitlOutbox(dir: string, workspaceId: string, count: number): LocalOutbox {
  const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId });
  const outbox = new LocalOutbox({ ledger });
  for (let i = 0; i < count; i++) {
    const parts = hitlRequestParts(workspaceId, {
      functionName: 'growth',
      title: `Approve ${i}`,
      action: 'publish',
      target: `x.com/roster/${i}`,
      contentHash: sha256Hex(`body-${i}`),
      body: `body ${i}`,
      expiresAt: null,
    });
    outbox.enqueue({ namespace: 'hitl', id: parts.id, kind: 'hitl-request', payload: parts.payload });
  }
  return outbox;
}

test('pg store finding 1: allowPartial reads FAIL CLOSED on unknown/halt, degrade ONLY on transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-partial-'));
  try {
    const ws = randomUUID();
    const outbox = queuedHitlOutbox(dir, ws, 1);
    const queuedId = [...outbox.fold().entries.values()][0]!.entryId;
    const build = (err: unknown) => createPgBackend({ pool: throwingBoundPool(ws, err), objects: memObjects(), outbox });

    // PG 42703 (undefined_column) — an UNKNOWN programming/schema defect — must
    // THROW under allowPartial, never return an overlay-only partial.
    const undef = build(Object.assign(new Error('column "nope" does not exist'), { code: '42703' }));
    await assert.rejects(undef.hitl.listRequests({}, undefined, { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.hitl.getRequest(queuedId, { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.hitl.count(undefined, { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.runs.listRuns({}, undefined, { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.runs.getRun('r1', { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.runs.count(undefined, { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.artifacts.getArtifact(sha256Hex('x'), { allowPartial: true }), BackendUnavailableError);
    await assert.rejects(undef.artifacts.head(sha256Hex('x'), { allowPartial: true }), BackendUnavailableError);

    // A config/auth halt (PG 42501 insufficient_privilege) likewise fails closed.
    const halt = build(Object.assign(new Error('permission denied for table hitl.requests'), { code: '42501' }));
    await assert.rejects(halt.hitl.listRequests({}, undefined, { allowPartial: true }), BackendUnavailableError);

    // A typed semantic error rethrows as-is (never softened to a partial).
    const skew = build(new VersionSkewError('component hitl: backend reports version 9'));
    await assert.rejects(skew.hitl.listRequests({}, undefined, { allowPartial: true }), VersionSkewError);
    await assert.rejects(skew.runs.count(undefined, { allowPartial: true }), VersionSkewError);

    // A genuine transport outage (ECONNRESET) DOES degrade to the overlay-only partial.
    const down = build(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    const page = await down.hitl.listRequests({}, undefined, { allowPartial: true });
    assert.equal(page.partial, true);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.queued, true);
    const one = await down.hitl.getRequest(queuedId, { allowPartial: true });
    assert.ok(one !== null && one.queued === true);
    assert.deepEqual(await down.hitl.count(undefined, { allowPartial: true }), { committed: 0, queued: 1, partial: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pg store finding 4: a transport partial listing paginates the overlay (cursor + limit), not truncate-and-done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-pg-page-'));
  try {
    const ws = randomUUID();
    const outbox = queuedHitlOutbox(dir, ws, 150);
    const down = createPgBackend({
      pool: throwingBoundPool(ws, Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })),
      objects: memObjects(),
      outbox,
    });
    const p1 = await down.hitl.listRequests({ limit: 100 }, undefined, { allowPartial: true });
    assert.equal(p1.items.length, 100, 'first page returns the full limit');
    assert.equal(p1.partial, true);
    assert.ok(p1.cursor !== null, 'a non-null cursor signals the remaining 50 queued records are reachable');
    const p2 = await down.hitl.listRequests({ limit: 100 }, p1.cursor!, { allowPartial: true });
    assert.equal(p2.items.length, 50, 'the second page yields the remaining queued records');
    assert.equal(p2.cursor, null, 'and only then signals done');
    const ids = new Set([...p1.items, ...p2.items].map((r) => r.id));
    assert.equal(ids.size, 150, 'every queued record surfaces exactly once across the pages');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── finding 1: queued retries must not conflict on store observations ────────

test('finding 1: a run-start re-enqueued with a new pid/started_at is idempotent (QUEUED path); a changed STABLE field conflicts', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-f1-'));
  try {
    await stampAndFinalize(h, ws);
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws });
    const outbox = new LocalOutbox({ ledger });
    const { runEventParts } = await import('../src/lib/persistence/postgres/stores.ts');

    // Two seals of the SAME stable run-start with DIFFERENT observations (pid/now).
    const a = runEventParts(ws, { runId: 'r1', kind: 'run-start', data: null }, { now: 1000, pid: 'pid-A' });
    const b = runEventParts(ws, { runId: 'r1', kind: 'run-start', data: null }, { now: 2000, pid: 'pid-B' });
    assert.equal(a.id, b.id, 'same stable inputs → same id');
    assert.equal(payloadHashOf(a.payload), payloadHashOf(b.payload), 'pid/started_at are NOT in the payload hash');
    assert.notEqual((a.observations as { pid: string }).pid, (b.observations as { pid: string }).pid);

    outbox.enqueue({ namespace: 'runs', id: a.id, kind: 'run-event', payload: a.payload, observations: a.observations });
    // The retry with new observations must NOT throw a ConflictError on the queued path.
    assert.doesNotThrow(() =>
      outbox.enqueue({ namespace: 'runs', id: b.id, kind: 'run-event', payload: b.payload, observations: b.observations }),
    );
    // First-write observations win (idempotent ledger replay).
    const entry = outbox.fold().entries.get(a.id);
    assert.equal((entry!.observations as { pid: string }).pid, 'pid-A');

    // A changed STABLE field (agent) shares the id but differs in the hashed
    // payload → a genuine ConflictError.
    const c = runEventParts(ws, { runId: 'r1', kind: 'run-start', data: null, agent: 'gtm.sdr' }, { now: 1000, pid: 'pid-A' });
    assert.equal(c.id, a.id, 'agent is not part of the id');
    assert.notEqual(payloadHashOf(c.payload), payloadHashOf(a.payload), 'agent IS a hashed stable field');
    assert.throws(
      () => outbox.enqueue({ namespace: 'runs', id: c.id, kind: 'run-event', payload: c.payload, observations: c.observations }),
      ConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('finding 1: a run-start re-appended with a new pid is idempotent (DIRECT path); a changed STABLE field conflicts', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const clock = { t: 1000 };
      const bA = createPgBackend({ pool, objects: memObjects(), now: () => clock.t, pid: () => 'pid-A' });
      const first = await bA.runs.appendEvent({ runId: 'r1', kind: 'run-start', data: null });
      assert.equal(first.outcome, 'committed');

      // Same stable run-start, DIFFERENT pid/clock → idempotent duplicate (no conflict).
      clock.t = 5000;
      const bB = createPgBackend({ pool, objects: memObjects(), now: () => clock.t, pid: () => 'pid-B' });
      const replay = await bB.runs.appendEvent({ runId: 'r1', kind: 'run-start', data: null });
      assert.equal(replay.outcome, 'committed');
      assert.equal(replay.id, first.id, 'same id — a clean idempotent replay');
      // The stored observations are the FIRST write's (pid-A / started_at 1000).
      const stored = await bA.runs.getRun('r1');
      const start = stored!.events.find((e) => e.kind === 'run-start')!;
      assert.equal(start.pid, 'pid-A');
      assert.equal(start.startedAt, 1000);

      // A changed STABLE field (agent) on the same id → ConflictError.
      await assert.rejects(
        bA.runs.appendEvent({ runId: 'r1', kind: 'run-start', data: null, agent: 'gtm.sdr' }),
        ConflictError,
      );
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

// ── finding 2: the DB rejects forged trust / verification state ──────────────

test('finding 2: run_events CHECK rejects a raw host-attested INSERT; artifact_declarations CHECK rejects external verified=true', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    // A raw runtime INSERT cannot forge the host-attested trust level.
    await assert.rejects(
      h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, created_at)
         VALUES ('forged', $1::uuid, 'r', 'k', 'run-start', '{}'::jsonb, 'host-attested', 0)`,
        [ws],
      ),
      /run_events_source_check|check constraint/,
    );
    // cli/agent/unverified are accepted.
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, created_at)
       VALUES ('ok', $1::uuid, 'r', 'k', 'run-start', '{}'::jsonb, 'cli', 0)`,
      [ws],
    );
    // An external declaration cannot forge verified=true.
    await assert.rejects(
      h.pool.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, provider, external_id, provenance, verified, created_at)
         VALUES ('extv', $1::uuid, 'r', 'a', 'produced', 'external', 'github', 'pr-1', '{}'::jsonb, true, 0)`,
        [ws],
      ),
      /check constraint/,
    );
    // An internal declaration MAY be verified=true (digest-verified by the store).
    await h.pool.query(
      `INSERT INTO roster_ops.artifact_declarations
         (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, verified, created_at)
       VALUES ('intv', $1::uuid, 'r', 'a', 'produced', 'internal', $2, '{}'::jsonb, true, 0)`,
      [ws, sha256Hex('bytes')],
    );
  } finally {
    await h.close();
  }
});

// ── finding 6: projections never leak a secret-shaped identifier / prose ─────

test('finding 6: a planted secret as run_id, agent, and sanitized_report never appears verbatim in run_index/artifact_index', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  try {
    await stampAndFinalize(h, ws);
    // Raw runtime INSERTs planting the secret in every projected field + the
    // DB-owned sanitized_report column (the trigger scrubs it).
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, agent, sanitized_report, created_at)
       VALUES ('r1', $1::uuid, $2, 'report', 'report', '{}'::jsonb, 'agent', $2, $3, 0)`,
      [ws, secret, `token ${secret} here`],
    );
    await h.pool.query(
      `INSERT INTO roster_ops.artifact_declarations
         (id, workspace_id, run_id, declaring_agent, role, kind, digest, artifact_type, media_type, provenance, sanitized_text, created_at)
       VALUES ('d1', $1::uuid, $2, 'a', 'produced', 'internal', $3, $2, $2, '{}'::jsonb, $4, 0)`,
      [ws, secret, sha256Hex('x'), `see ${secret}`],
    );

    const runIdx = await h.pool.query(`SELECT run_id, agent, sanitized_report FROM roster_ops.run_index WHERE workspace_id = $1::uuid`, [ws]);
    const runRow = runIdx.rows[0] as { run_id: string; agent: string; sanitized_report: string };
    assert.ok(!runRow.run_id.includes(secret), 'run_index run_id is sentinel-normalized');
    assert.match(runRow.run_id, /^legacy-/);
    assert.ok(!runRow.agent.includes(secret), 'run_index agent is sentinel-normalized');
    assert.ok(!runRow.sanitized_report.includes(secret), 'run_index sanitized_report is scrubbed');

    const artIdx = await h.pool.query(`SELECT run_id, artifact_type, media_type, sanitized_text FROM roster_ops.artifact_index WHERE workspace_id = $1::uuid`, [ws]);
    const artRow = artIdx.rows[0] as { run_id: string; artifact_type: string | null; media_type: string | null; sanitized_text: string };
    assert.ok(!artRow.run_id.includes(secret), 'artifact_index run_id is sentinel-normalized');
    assert.equal(artRow.artifact_type, null, 'a secret-shaped artifact_type is nulled');
    assert.ok(!artRow.sanitized_text.includes(secret), 'artifact_index sanitized_text is scrubbed');
  } finally {
    await h.close();
  }
});

test('finding 6: the backfill normalizer (safe_ident) sentinels a secret-shaped OR charset-invalid runId, passes a safe one', opts, async () => {
  // safe_ident is the exact function the v1→v2 backfill applies to meta.runId
  // (roster_ops.safe_ident(coalesce(a.meta->>'runId','unknown'))) AND the second
  // defensive layer in the views. A secret SHAPE (even when charset-valid) and a
  // charset-invalid value both normalize to a deterministic sentinel; a safe id
  // passes through unchanged.
  const h = await makeDb();
  try {
    const q = await h.pool.query(`SELECT
      roster_ops.safe_ident('ghp_abcdefghijklmnopqrstuvwxyz0123456789') AS ghp,
      roster_ops.safe_ident('AKIAIOSFODNN7EXAMPLE') AS akia,
      roster_ops.safe_ident('deadbeefdeadbeefdeadbeefdeadbeef') AS hex,
      roster_ops.safe_ident('has spaces') AS invalid,
      roster_ops.safe_ident('run-2026-07-23.gtm:sdr') AS safe,
      roster_ops.safe_ident(NULL) AS nul`);
    const r = q.rows[0] as Record<string, string | null>;
    for (const key of ['ghp', 'akia', 'hex', 'invalid']) {
      assert.match(r[key]!, /^legacy-[0-9a-f]{12}$/, `${key} sentinels`);
    }
    assert.equal(r.safe, 'run-2026-07-23.gtm:sdr', 'a safe identifier passes through');
    assert.equal(r.nul, null, 'null → null');
  } finally {
    await h.close();
  }
});

// ── finding 7: a v1 artifact outbox entry drains into blob + declaration ──────

test('finding 7: a v1 artifact outbox entry (meta in payload) drains into a blob AND a synthesized declaration', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-f7-'));
  try {
    await stampAndFinalize(h, ws);
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws });
    const outbox = new LocalOutbox({ ledger });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects, outbox });
      const bytes = Buffer.from('v1 artifact bytes');
      const digest = sha256Hex(bytes);
      // A v1 (#318) combined artifact outbox entry: meta lives INSIDE the payload,
      // and there is no declaration entry.
      const { computeRecordId } = await import('../src/lib/persistence/contracts.ts');
      const id = computeRecordId(ws, 'artifacts', { kind: 'artifact', digest });
      outbox.enqueueArtifact(
        {
          namespace: 'artifacts',
          id,
          kind: 'artifact',
          payload: { digest, size: bytes.byteLength, meta: { filename: 'old', contentType: 'text/plain', runId: 'run-legacy' } },
        },
        bytes,
      );
      // Drain it into PG.
      await outbox.drain(backend.remote, { objects: new S3ObjectTarget(objects) });

      const blob = await h.pool.query(`SELECT digest, meta FROM roster_ops.artifacts WHERE workspace_id = $1::uuid AND digest = $2`, [ws, digest]);
      assert.equal(blob.rows.length, 1, 'the blob materialized (v1 meta preserved)');
      assert.equal((blob.rows[0] as { meta: { runId: string } }).meta.runId, 'run-legacy');
      const decl = await h.pool.query(
        `SELECT declaring_agent, role, digest, run_id FROM roster_ops.artifact_declarations WHERE workspace_id = $1::uuid AND digest = $2`,
        [ws, digest],
      );
      assert.equal(decl.rows.length, 1, 'the v1 outbox entry also synthesized a declaration');
      assert.equal((decl.rows[0] as { declaring_agent: string }).declaring_agent, 'legacy');
      assert.equal((decl.rows[0] as { run_id: string }).run_id, 'run-legacy');
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ── round-3 findings: v1 blob dedup, VersionId recovery, SQL scrub, canonical
//    counts, admin-mutation binding + positive confirmation ─────────────────────

test('finding 1: a v2 putArtifact of a REAL v1 blob\'s identical bytes does NOT conflict (delivery-ledger dedups the blob on digest)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const { computeRecordId } = await import('../src/lib/persistence/contracts.ts');
    const bytes = Buffer.from('v1 pg blob identical bytes');
    const digest = sha256Hex(bytes);
    const meta = { filename: 'old.md', contentType: 'text/markdown', runId: 'run-old' };
    const id = computeRecordId(ws, 'artifacts', { kind: 'artifact', digest });
    // A REAL v1 blob: the artifacts row (meta in the row) + a delivery-ledger row
    // whose payload hash covers {digest,size,meta} (the #318 content hash).
    const v1Hash = sha256Hex(canonicalJson({ digest, size: bytes.byteLength, meta }));
    await h.pool.query(
      `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 0)`,
      [id, ws, digest, bytes.byteLength, JSON.stringify(meta)],
    );
    await h.pool.query(
      `INSERT INTO roster_ops.delivery_ledger (workspace_id, namespace, record_id, payload_hash)
       VALUES ($1::uuid, 'artifacts', $2, $3)`,
      [ws, id, v1Hash],
    );
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects }); // direct path, no outbox
      // A NEW run declares IDENTICAL bytes through v2 — the delivery-ledger sees the
      // same record_id with a DIFFERENT payload hash; before the fix this was a
      // ConflictError (and parked the queue on the outbox path).
      const put = await backend.artifacts.putArtifact(
        { filename: 'new.md', contentType: 'text/markdown', runId: 'run-new' },
        bytes,
        { runId: 'run-new', declaringAgent: 'writer', role: 'produced' },
      );
      assert.equal(put.digest, digest);
      assert.equal(put.blobOutcome, 'committed', 'the already-present v1 blob dedups — no conflict');
      assert.ok(put.declarationId, 'the new declaration is added on top of the existing blob');
      const blobs = await h.pool.query(
        `SELECT count(*)::int AS n FROM roster_ops.artifacts WHERE workspace_id = $1::uuid AND digest = $2`,
        [ws, digest],
      );
      assert.equal((blobs.rows[0] as { n: number }).n, 1, 'exactly one blob row (deduped by digest, first meta wins)');
      const decls = await backend.artifacts.getByRun('run-new');
      assert.equal(decls.length, 1);
      assert.equal(decls[0]!.declaringAgent, 'writer');
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

test('finding 6: healthy same-content reuse recovers the committed VersionId → the second run\'s declaration is verified (no repair)', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'roster-f6r-'));
  try {
    await stampAndFinalize(h, ws);
    const clock = { t: 1_700_000_000_000 };
    const ledger = new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: ws, now: () => ++clock.t });
    const outbox = new LocalOutbox({ ledger, now: () => clock.t, rng: () => 0 });
    const objects = memObjects();
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects, outbox, now: () => clock.t });
      const bytes = randomBytes(40);
      // Run A stores the bytes (healthy write-through drains immediately).
      const a = await backend.artifacts.putArtifact(
        { filename: 'a.md', contentType: 'text/markdown', runId: 'run-A' },
        bytes,
        { runId: 'run-A', declaringAgent: 'writer', role: 'produced' },
      );
      assert.ok(a.objectVersionId, 'run A captured the immutable version');
      const declA = (await pool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [a.declarationId])).rows[0] as { version_state: string };
      assert.equal(declA.version_state, 'verified');

      // Run B declares IDENTICAL bytes. The blob entry is already ACKED, so the
      // drain delivers nothing new (empty deliveredVersions); before the fix run B's
      // declaration was left version_state='unverified'.
      const b = await backend.artifacts.putArtifact(
        { filename: 'b.md', contentType: 'text/markdown', runId: 'run-B' },
        bytes,
        { runId: 'run-B', declaringAgent: 'reviewer', role: 'used' },
      );
      assert.equal(b.digest, a.digest);
      assert.equal(b.objectVersionId, a.objectVersionId, 'run B recovers the SAME committed object version');
      const declB = (await pool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE id = $1`, [b.declarationId])).rows[0] as { version_state: string };
      assert.equal(declB.version_state, 'verified', "run B's declaration is verified without any admin repair");
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

test('finding 2: the SQL scrub redacts QUOTED assignment values (with spaces) — no tail leaks into run_index / artifact_index', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    // Raw-insert (bypassing the TS sanitizer) secret-class values that are QUOTED
    // and contain SPACES. The BEFORE INSERT trigger scrub must redact the WHOLE
    // quoted span; before the fix only the first token was replaced, leaking the tail.
    const report = "password: \"correct horse battery staple\" then api_key: 'multi word secret value'";
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, sanitized_report, created_at)
       VALUES ('ev-scrub', $1::uuid, 'run-scrub', 'report', 'report', '{}'::jsonb, $2, 0)`,
      [ws, report],
    );
    const idx = (await h.pool.query(
      `SELECT sanitized_report FROM roster_ops.run_index WHERE workspace_id = $1::uuid AND run_id = 'run-scrub'`,
      [ws],
    )).rows[0] as { sanitized_report: string };
    assert.ok(!idx.sanitized_report.includes('horse battery staple'), `no double-quoted tail leaks: ${idx.sanitized_report}`);
    assert.ok(!idx.sanitized_report.includes('multi word secret value'), `no single-quoted tail leaks: ${idx.sanitized_report}`);
    assert.ok(idx.sanitized_report.includes('[REDACTED]'), 'the quoted values are redacted');

    // Same for the artifact declaration sanitized_text projection.
    const declText = 'token: "abc def ghi jkl"';
    await h.pool.query(
      `INSERT INTO roster_ops.artifact_declarations
         (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, verified, version_state, sanitized_text, created_at)
       VALUES ('decl-scrub', $1::uuid, 'run-scrub', 'sdr', 'produced', 'internal', $2, '{}'::jsonb, true, 'verified', $3, 0)`,
      [ws, sha256Hex('scrub-bytes'), declText],
    );
    const aidx = (await h.pool.query(
      `SELECT sanitized_text FROM roster_ops.artifact_index WHERE workspace_id = $1::uuid AND run_id = 'run-scrub'`,
      [ws],
    )).rows[0] as { sanitized_text: string };
    assert.ok(!aidx.sanitized_text.includes('abc def ghi jkl'), `no tail in artifact_index: ${aidx.sanitized_text}`);
    assert.ok(aidx.sanitized_text.includes('[REDACTED]'));
  } finally {
    await h.close();
  }
});

test('finding 2 (real API, PG): appendEvent report with a JSON {password} object → run_index has no secret', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects: memObjects() });
      const secret = 'correct horse battery staple';
      // The real write path: a report whose data is a credential OBJECT. The TS
      // sanitizer runs at write; the DB trigger is the second layer. Neither may
      // leak the quoted-key JSON value into the safe projection view.
      await backend.runs.appendEvent({ runId: 'r-json-pw', kind: 'report', data: { password: secret } });
      const idx = (await pool.query(
        `SELECT sanitized_report FROM roster_ops.run_index WHERE run_id = 'r-json-pw'`,
      )).rows[0] as { sanitized_report: string };
      assert.ok(idx.sanitized_report !== null, 'the report projected a sanitized column');
      assert.ok(!idx.sanitized_report.includes(secret), `run_index leaked the JSON password: ${idx.sanitized_report}`);
      assert.ok(idx.sanitized_report.includes('[REDACTED]'));
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

test('finding 8: PG listRuns counts CANONICAL events — a v1 run-start + v2 retry is ONE event', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const { computeRecordId } = await import('../src/lib/persistence/contracts.ts');
    // A REAL v1 run-start row: LITERAL 'run-event' id scheme, payload.type.
    const v1Id = computeRecordId(ws, 'runs', { kind: 'run-event', runId: 'r-cnt', dedupeKey: 'start' });
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
       VALUES ($1, $2::uuid, 'r-cnt', 'start', 'run-start', $3::jsonb, 0)`,
      [v1Id, ws, JSON.stringify({ runId: 'r-cnt', dedupeKey: 'start', type: 'run-start', data: null })],
    );
    const pool = new BoundPool({ connectionString: h.url, workspaceId: ws });
    try {
      const backend = createPgBackend({ pool, objects: memObjects() });
      await backend.runs.appendEvent({ runId: 'r-cnt', kind: 'run-start', data: null }); // v2 retry (distinct physical id)
      const run = await backend.runs.getRun('r-cnt');
      assert.equal(run!.events.length, 1, 'getRun collapses the v1 record + its v2 retry to one event');
      const page = await backend.runs.listRuns({});
      const summary = page.items.find((s) => s.runId === 'r-cnt');
      assert.ok(summary);
      assert.equal(summary.events, 1, 'run list shows 1 canonical event, not 2 physical rows');
    } finally {
      await pool.end();
    }
  } finally {
    await h.close();
  }
});

test('finding 4: repair bless on a no-op (blob/declarations absent on this DB) ERRORS — never a false success', opts, async () => {
  const h = await makeDb();
  const ws = randomUUID();
  try {
    await stampAndFinalize(h, ws);
    const { PgRunLedgerSource } = await import('../src/lib/persistence/run-repair.ts');
    const source = new PgRunLedgerSource({ db: h.pool, workspaceId: ws, objects: memObjects(), admin: h.pool });
    // No artifacts row and no declarations for this digest → bless changes 0 rows.
    await assert.rejects(source.bless(sha256Hex('absent-blob'), 'v-any'), /changed 0 rows/i);
  } finally {
    await h.close();
  }
});

test('finding 4: the admin-mutation binding guard refuses a DB stamped for a DIFFERENT workspace (repair path)', opts, async () => {
  const h = await makeDb();
  const wsA = randomUUID();
  const wsB = randomUUID();
  try {
    await stampAndFinalize(h, wsA); // the DB belongs to A
    // verbRepair verifies the admin connection's binding this way BEFORE fillVersionIds.
    await assert.rejects(verifyBinding(h.pool, wsB), WorkspaceMismatchError);
  } finally {
    await h.close();
  }
});
