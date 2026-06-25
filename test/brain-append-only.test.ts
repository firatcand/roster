import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
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
    assert.ok(role.password, 'role should be created with a password');
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

test('runtime role rejected on UPDATE / DELETE / TRUNCATE / DROP (case 1)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const admin = new pg.Client({ connectionString: fresh.url });
  await admin.connect();
  await admin.query(`INSERT INTO brain.entities (kind, slug, title) VALUES ('person', 'a', 't')`);
  await admin.end();

  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(rt.query(`UPDATE brain.entities SET title = 'x'`), /permission denied/i);
    await assert.rejects(rt.query(`DELETE FROM brain.entities`), /permission denied/i);
    await assert.rejects(rt.query(`TRUNCATE brain.entities`), /(permission denied|must be owner)/i);
    await assert.rejects(rt.query(`DROP TABLE brain.entities`), /(permission denied|must be owner)/i);
  } finally {
    await rt.end();
    await teardown();
  }
});

test('runtime cannot CREATE TABLE brain.evil (case 2)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(rt.query(`CREATE TABLE brain.evil (id int)`), /permission denied/i);
  } finally {
    await rt.end();
    await teardown();
  }
});

test('UNIQUE(kind, slug) rejects duplicate entity insert (case 5)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await rt.query(`INSERT INTO brain.entities (kind, slug, title) VALUES ('person', 'dup', 'one')`);
    await assert.rejects(
      rt.query(`INSERT INTO brain.entities (kind, slug, title) VALUES ('person', 'dup', 'two')`),
      /duplicate key|unique/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('runtime cannot spoof id / recorded_at (case 6)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(
      rt.query(`INSERT INTO brain.entities (id, kind, slug) VALUES (999, 'person', 'spoof')`),
      /permission denied|cannot insert|GENERATED ALWAYS/i,
    );
    await assert.rejects(
      rt.query(`INSERT INTO brain.entities (recorded_at, kind, slug) VALUES (now(), 'person', 'spoof2')`),
      /permission denied/i,
    );
    const ok = await rt.query(`INSERT INTO brain.entities (kind, slug) VALUES ('person', 'clean') RETURNING id, recorded_at`);
    assert.ok(ok.rows[0]!.id);
    assert.ok(ok.rows[0]!.recorded_at);
  } finally {
    await rt.end();
    await teardown();
  }
});

test('runtime cannot read/write brain_meta.schema_migrations (case 7)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(rt.query(`SELECT * FROM brain_meta.schema_migrations`), /permission denied/i);
    await assert.rejects(
      rt.query(`INSERT INTO brain_meta.schema_migrations (filename, sha256) VALUES ('x', 'y')`),
      /permission denied/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('runtime can INSERT + SELECT facts and read current_facts view', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const e = await rt.query(`INSERT INTO brain.entities (kind, slug) VALUES ('person', 'v') RETURNING id`);
    const eid = e.rows[0]!.id;
    await rt.query(`INSERT INTO brain.facts (entity_id, key, value) VALUES ($1, 'role', '"a"'::jsonb)`, [eid]);
    await rt.query(`INSERT INTO brain.facts (entity_id, key, value) VALUES ($1, 'role', '"b"'::jsonb)`, [eid]);
    const cur = await rt.query(`SELECT value FROM brain.current_facts WHERE entity_id = $1 AND key = 'role'`, [eid]);
    assert.equal(cur.rows[0]!.value, 'b');
  } finally {
    await rt.end();
    await teardown();
  }
});
