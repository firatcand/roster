import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

type Setup = { fresh: FreshDb; password: string; teardown: () => Promise<void> };

async function provision(): Promise<Setup> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    return {
      fresh,
      password: role.password!,
      teardown: async () => {
        await fresh.drop();
      },
    };
  } catch (err) {
    await fresh.drop();
    throw err;
  } finally {
    await pool.end();
  }
}

test('brokered create_table yields admin-owned INSERT/SELECT-only table (case 3)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await rt.query(`SELECT brain.create_table('notes', '[{"name":"text_body","type":"text"},{"name":"score","type":"int"}]'::jsonb)`);

    const owner = await rt.query(
      `SELECT o.rolname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles o ON o.oid = c.relowner
        WHERE n.nspname = 'brain' AND c.relname = 'notes'`,
    );
    assert.notEqual(owner.rows[0]!.rolname, fresh.role, 'table must be admin-owned');

    await rt.query(`INSERT INTO brain.notes (text_body, score) VALUES ('hi', 5)`);
    const sel = await rt.query(`SELECT text_body, score FROM brain.notes`);
    assert.equal(sel.rows[0]!.text_body, 'hi');

    await assert.rejects(rt.query(`UPDATE brain.notes SET score = 9`), /permission denied/i);
    await assert.rejects(rt.query(`DELETE FROM brain.notes`), /permission denied/i);
    await assert.rejects(
      rt.query(`INSERT INTO brain.notes (id, text_body) VALUES (1, 'spoof')`),
      /permission denied|GENERATED ALWAYS|cannot insert/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('create_table rejects injection / schema-qualified name / non-whitelisted type (case 4)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(
      rt.query(`SELECT brain.create_table('foo; DROP TABLE brain.entities;--', '[]'::jsonb)`),
      /invalid table name/i,
    );
    await assert.rejects(
      rt.query(`SELECT brain.create_table('public.evil', '[]'::jsonb)`),
      /invalid table name/i,
    );
    await assert.rejects(
      rt.query(`SELECT brain.create_table('badtype', '[{"name":"x","type":"money"}]'::jsonb)`),
      /disallowed column type/i,
    );
    await assert.rejects(
      rt.query(`SELECT brain.create_table('badcol', '[{"name":"x; DROP","type":"text"}]'::jsonb)`),
      /invalid column name/i,
    );
    const stillThere = await rt.query(`SELECT count(*) FROM brain.entities`);
    assert.ok(stillThere.rowCount === 1);
  } finally {
    await rt.end();
    await teardown();
  }
});

test('create_table does not grant to a registered role that has dangerous attrs (case 4)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  const evil = `${fresh.role}_evil`;
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    // Poisoned/stale registry row: a login role registered but with CREATEROLE.
    await pool.query(`CREATE ROLE ${evil} LOGIN CREATEROLE`);
    await pool.query(`INSERT INTO brain_meta.runtime_roles (rolname) VALUES ($1) ON CONFLICT DO NOTHING`, [evil]);

    await rt.query(`SELECT brain.create_table('poisoned', '[{"name":"body","type":"text"}]'::jsonb)`);

    const sel = await pool.query<{ p: boolean }>(
      `SELECT has_table_privilege($1, 'brain.poisoned', 'SELECT') AS p`,
      [evil],
    );
    assert.equal(sel.rows[0]!.p, false, 'dangerous registered role must not receive SELECT on a new brain table');
    const ins = await pool.query<{ p: boolean }>(
      `SELECT has_table_privilege($1, 'brain.poisoned', 'INSERT') AS p`,
      [evil],
    );
    assert.equal(ins.rows[0]!.p, false, 'dangerous registered role must not receive INSERT on a new brain table');
  } finally {
    await rt.end();
    await pool.query(`DROP ROLE IF EXISTS ${evil}`).catch(() => {});
    await pool.end();
    await teardown();
  }
});

test('reserved-word table/column names are safely quoted in create_table and applyGrants', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const pool = createBrainPool('admin', fresh.url);
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    // "select" is a SQL keyword; passes the identifier regex but must be quoted.
    await rt.query(`SELECT brain.create_table('select', '[{"name":"order","type":"int"},{"name":"body","type":"text"}]'::jsonb)`);
    await rt.query(`INSERT INTO brain."select" ("order", body) VALUES (1, 'k')`);
    const sel = await rt.query(`SELECT "order", body FROM brain."select"`);
    assert.equal(sel.rows[0]!.body, 'k');

    // Re-running applyGrants (idempotent re-init) must handle the reserved-word
    // table name without a syntax error.
    await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    const still = await rt.query(`SELECT count(*) FROM brain."select"`);
    assert.equal(still.rowCount, 1);
  } finally {
    await rt.end();
    await pool.end();
    await teardown();
  }
});

test('EXECUTE on create_table revoked from PUBLIC (case 4)', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    const granted = await withBrainClient(pool, (c) =>
      c.query(
        `SELECT has_function_privilege('public', 'brain.create_table(text, jsonb)', 'EXECUTE') AS pub`,
      ),
    );
    assert.equal(granted.rows[0]!.pub, false, 'PUBLIC must not have EXECUTE');
  } finally {
    await pool.end();
    await fresh.drop();
  }
});
