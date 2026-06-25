import { test } from 'node:test';
import assert from 'node:assert/strict';
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
