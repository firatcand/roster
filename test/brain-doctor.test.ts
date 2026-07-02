import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole, applyGrants } from '../src/lib/brain/roles.ts';
import { runDoctor } from '../src/lib/brain/doctor.ts';
import { HAS_DB, createFreshDb, type FreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

type Setup = { fresh: FreshDb; teardown: () => Promise<void> };

async function provision(): Promise<Setup> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
  } catch (err) {
    await fresh.drop();
    throw err;
  } finally {
    await pool.end();
  }
  return {
    fresh,
    teardown: async () => {
      await fresh.drop();
    },
  };
}

test('doctor green on a healthy DB (case 9)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    assert.equal(report.roleExists, true);
    assert.ok(report.tables.includes('entities'));
    assert.deepEqual(report.pending, []);
  } finally {
    await pool.end();
    await teardown();
  }
});

test('doctor red when an out-of-band GRANT DELETE is applied (case 9)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`GRANT DELETE ON brain.entities TO ${fresh.role}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const mutating = report.checks.find((c) => c.name === `no-mutating-table-privs [${fresh.role}]`);
    assert.equal(mutating!.ok, false);
  } finally {
    await pool.end();
    await teardown();
  }
});

test('doctor red when a schema CREATE grant is applied (case 9)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`GRANT CREATE ON SCHEMA brain TO ${fresh.role}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const create = report.checks.find((c) => c.name === `no-schema-create [${fresh.role}]`);
    assert.equal(create!.ok, false);
  } finally {
    await pool.end();
    await teardown();
  }
});

test('doctor red when out-of-band column-level GRANT UPDATE(title) is applied (case 2)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`GRANT UPDATE (title) ON brain.entities TO ${fresh.role}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const colUpdate = report.checks.find((c) => c.name === `no-column-update-privs [${fresh.role}]`);
    assert.equal(colUpdate!.ok, false);
  } finally {
    await pool.end();
    await teardown();
  }
});

test('doctor red when table-level GRANT INSERT is applied (case 2)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`GRANT INSERT ON brain.entities TO ${fresh.role}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const tableInsert = report.checks.find((c) => c.name === `no-table-insert-privs [${fresh.role}]`);
    assert.equal(tableInsert!.ok, false);
  } finally {
    await pool.end();
    await teardown();
  }
});

test('doctor red when sequence USAGE is granted (case 2)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    const seq = await pool.query<{ seq: string }>(
      `SELECT pg_get_serial_sequence('brain.entities', 'id') AS seq`,
    );
    await pool.query(`GRANT USAGE ON SEQUENCE ${seq.rows[0]!.seq} TO ${fresh.role}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const seqCheck = report.checks.find((c) => c.name === `no-sequence-privs [${fresh.role}]`);
    assert.equal(seqCheck!.ok, false);
  } finally {
    await pool.end();
    await teardown();
  }
});

test('doctor red when another role is granted membership of the runtime role (case 2/inbound)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  const intruder = `${fresh.role}_intruder`;
  try {
    await pool.query(`CREATE ROLE ${intruder} LOGIN`);
    await pool.query(`GRANT ${fresh.role} TO ${intruder}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const inbound = report.checks.find((c) => c.name === `no-inbound-members [${fresh.role}]`);
    assert.equal(inbound!.ok, false);
    assert.match(inbound!.detail, new RegExp(intruder));
  } finally {
    await pool.query(`DROP ROLE IF EXISTS ${intruder}`).catch(() => {});
    await pool.end();
    await teardown();
  }
});

test('doctor red when the runtime role is given REPLICATION (case 3/attrs)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`ALTER ROLE ${fresh.role} REPLICATION`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const attrs = report.checks.find((c) => c.name === `no-superuser-attrs [${fresh.role}]`);
    assert.equal(attrs!.ok, false);
  } finally {
    await pool.query(`ALTER ROLE ${fresh.role} NOREPLICATION`).catch(() => {});
    await pool.end();
    await teardown();
  }
});

test('doctor red when the runtime role owns a brain schema (case 3/ownership)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`ALTER SCHEMA brain OWNER TO ${fresh.role}`);
    const report = await runDoctor(pool, fresh.role);
    assert.equal(report.ok, false);
    const owned = report.checks.find((c) => c.name === `no-owned-objects [${fresh.role}]`);
    assert.equal(owned!.ok, false);
    assert.match(owned!.detail, /schema brain/);
  } finally {
    await pool.query(`ALTER SCHEMA brain OWNER TO CURRENT_USER`).catch(() => {});
    await pool.end();
    await teardown();
  }
});

test('applyGrants completely strips stale column-UPDATE + sequence USAGE from a reused role (case 1)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`GRANT UPDATE (title) ON brain.entities TO ${fresh.role}`);
    const seq = await pool.query<{ seq: string }>(
      `SELECT pg_get_serial_sequence('brain.entities', 'id') AS seq`,
    );
    await pool.query(`GRANT USAGE ON SEQUENCE ${seq.rows[0]!.seq} TO ${fresh.role}`);

    const dirty = await runDoctor(pool, fresh.role);
    assert.equal(dirty.ok, false, 'precondition: role should be dirty before applyGrants');

    await withBrainClient(pool, (c) => applyGrants(c, fresh.role));

    const clean = await runDoctor(pool, fresh.role);
    assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((c) => !c.ok)));
  } finally {
    await pool.end();
    await teardown();
  }
});

test('applyGrants revokes stale UPDATE/DELETE from a reused role (case 3)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`GRANT UPDATE, DELETE ON brain.entities TO ${fresh.role}`);
    const dirty = await runDoctor(pool, fresh.role);
    assert.equal(dirty.ok, false, 'precondition: role should be dirty before applyGrants');

    await withBrainClient(pool, (c) => applyGrants(c, fresh.role));

    const clean = await runDoctor(pool, fresh.role);
    assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((c) => !c.ok)));
  } finally {
    await pool.end();
    await teardown();
  }
});

// ROS-154: managed Postgres (Neon/PG16+) auto-grants a freshly created role
// back to the creator WITH ADMIN OPTION. The grant is reproduced OUT-OF-BAND
// BEFORE any strip runs (on Neon a re-grant after the strip is impossible, so
// provisioning first would test an unreachable state). The local test admin is
// typically a superuser, which is why the create path shows no auto-grant here;
// the strip code is identical on both paths. Note: on a real Neon backend this
// suite leaks rbrw_* login roles — the admin intentionally cannot drop them.
test('ensureRuntimeRole strips a Neon-style creator auto-grant; init self-heals to green (ROS-154)', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    await pool.query(
      `CREATE ROLE ${fresh.role} LOGIN
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await pool.query(`GRANT ${fresh.role} TO CURRENT_USER WITH ADMIN OPTION`);

    const dirty = await runDoctor(pool, fresh.role);
    assert.equal(dirty.ok, false, 'precondition: auto-grant must trip doctor');
    const inboundCheck = dirty.checks.find((c) => c.name === `no-inbound-members [${fresh.role}]`);
    assert.equal(inboundCheck!.ok, false);

    const result = await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    assert.equal(result.creatorGrantRemains, false, 'a same-grantor membership must be revocable');

    const healed = await runDoctor(pool, fresh.role);
    assert.equal(healed.ok, true, JSON.stringify(healed.checks.filter((c) => !c.ok)));
    const inbound = await pool.query(
      `SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid WHERE r.rolname = $1`,
      [fresh.role],
    );
    assert.equal(inbound.rowCount, 0, 'creator membership must be revoked');
    const pinned = await pool.query(
      `SELECT 1 FROM pg_roles
        WHERE rolname = $1 AND rolconfig @> ARRAY['pg_trgm.similarity_threshold=0.3']`,
      [fresh.role],
    );
    assert.equal(pinned.rowCount, 1, 'pg_trgm threshold must be pinned on the role');

    await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    const again = await runDoctor(pool, fresh.role);
    assert.equal(again.ok, true, 're-init on a stripped brain must stay green');
  } finally {
    await pool.end();
    await fresh.drop();
  }
});

// ROS-154: a local superuser admin can still ALTER ROLE after the strip, so a
// green re-init alone would not prove the guard exists. Record the SQL that
// applyGrants issues on a second run and assert the pg_trgm ALTER is skipped —
// on Neon that statement is the one that would throw once admin is gone.
test('applyGrants skips the pg_trgm ALTER when the threshold is already pinned (ROS-154)', opts, async () => {
  const { fresh, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  try {
    const recorded: string[] = [];
    await withBrainClient(pool, async (c) => {
      const recording = {
        query: (...args: unknown[]) => {
          if (typeof args[0] === 'string') recorded.push(args[0]);
          return (c.query as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as pg.PoolClient;
      await applyGrants(recording, fresh.role);
    });
    assert.equal(
      recorded.some((q) => q.includes('ALTER ROLE') && q.includes('pg_trgm')),
      false,
      'second applyGrants must not re-run the pg_trgm ALTER',
    );
    const pinned = await pool.query(
      `SELECT 1 FROM pg_roles
        WHERE rolname = $1 AND rolconfig @> ARRAY['pg_trgm.similarity_threshold=0.3']`,
      [fresh.role],
    );
    assert.equal(pinned.rowCount, 1, 'the pin from provision must persist');
  } finally {
    await pool.end();
    await teardown();
  }
});

// ROS-154 round 2 (Codex finding, verified empirically): stock PG16 records the
// CREATEROLE auto-grant with the BOOTSTRAP superuser as grantor, so the creator
// can neither REVOKE it directly (silent warning no-op) nor via GRANTED BY
// (permission denied). Reproduce with a real non-superuser CREATEROLE admin and
// assert init reports the truth: creatorGrantRemains=true, doctor honestly red.
test('stock-PG16 bootstrap-granted membership: init reports creatorGrantRemains, doctor stays red (ROS-154)', opts, async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const admin = `fadmin_${suffix}`;
  const db = `brain_fadmin_${suffix}`;
  const password = `pw_${suffix}`;
  const rootUrl = process.env.ROSTER_BRAIN_ADMIN_URL!;
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  const rootIsSuper = (await root.query<{ s: boolean }>(`SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`)).rows[0]!.s;
  const versionNum = Number((await root.query<{ v: string }>(`SHOW server_version_num`)).rows[0]!.v);
  if (!rootIsSuper || versionNum < 160000) {
    // Needs a superuser to stage the scenario (managed backends like Neon have
    // none — their path is the self-heal test above) and PG16+ semantics for
    // the CREATEROLE auto-grant (PG15 records no bootstrap-granted membership).
    await root.end();
    return;
  }
  try {
    await root.query(`CREATE ROLE ${admin} LOGIN CREATEROLE PASSWORD '${password}'`);
    await root.query(`CREATE DATABASE ${db} OWNER ${admin}`);
    const dbUrl = new URL(rootUrl);
    dbUrl.pathname = '/' + db;
    // vector is not a trusted extension — pre-create both as superuser so the
    // non-superuser admin's migrations pass the IF NOT EXISTS checks.
    const rootOnDb = new pg.Client({ connectionString: dbUrl.toString() });
    await rootOnDb.connect();
    try {
      await rootOnDb.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await rootOnDb.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    } finally {
      await rootOnDb.end();
    }

    const adminUrl = new URL(dbUrl.toString());
    adminUrl.username = admin;
    adminUrl.password = password;
    const runtimeRole = `rbrw_${suffix}`;
    const pool = createBrainPool('admin', adminUrl.toString());
    try {
      await runMigrations(pool);
      const result = await withBrainClient(pool, (c) => ensureRuntimeRole(c, runtimeRole));
      assert.equal(result.created, true);
      assert.equal(result.creatorGrantRemains, true, 'bootstrap-granted membership must be reported as remaining');

      const grantor = await pool.query<{ g: string }>(
        `SELECT g.rolname AS g FROM pg_auth_members am
           JOIN pg_roles r ON r.oid = am.roleid
           JOIN pg_roles g ON g.oid = am.grantor
          WHERE r.rolname = $1`,
        [runtimeRole],
      );
      assert.notEqual(grantor.rows[0]?.g, admin, 'precondition: the auto-grant grantor is not the creator');

      const report = await runDoctor(pool, runtimeRole);
      assert.equal(report.ok, false, 'doctor must stay honestly red while the membership remains');
      const inbound = report.checks.find((c) => c.name === `no-inbound-members [${runtimeRole}]`);
      assert.equal(inbound!.ok, false);

      const again = await withBrainClient(pool, (c) => ensureRuntimeRole(c, runtimeRole));
      assert.equal(again.creatorGrantRemains, true, 're-init keeps reporting the truth without throwing');
    } finally {
      await pool.end();
    }
  } finally {
    try {
      await root.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      );
      await root.query(`DROP DATABASE IF EXISTS ${db}`);
      await root.query(`DROP ROLE IF EXISTS rbrw_${suffix}`);
      await root.query(`DROP ROLE IF EXISTS ${admin}`);
    } finally {
      await root.end();
    }
  }
});
