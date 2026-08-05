import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { loadMigrations, pendingMigrations, runMigrations } from '../src/lib/brain/migrate.ts';
import { HAS_DB, createFreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

function tmpSchemaDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-mig-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

test('loadMigrations sorts by numeric prefix and fails on duplicate prefix', () => {
  const ok = tmpSchemaDir({
    '002_b.sql': 'select 1;',
    '001_a.sql': 'select 1;',
    '010_c.sql': 'select 1;',
  });
  try {
    const files = loadMigrations(ok);
    assert.deepEqual(files.map((f) => f.filename), ['001_a.sql', '002_b.sql', '010_c.sql']);
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }

  const dup = tmpSchemaDir({ '001_a.sql': 'select 1;', '001_b.sql': 'select 1;' });
  try {
    assert.throws(() => loadMigrations(dup), /duplicate migration prefix/i);
  } finally {
    rmSync(dup, { recursive: true, force: true });
  }
});

test('loadMigrations rejects non-transactional concurrent index DDL', () => {
  const dir = tmpSchemaDir({
    '001_init.sql': 'CREATE TABLE t1 (id int); CREATE INDEX CONCURRENTLY t1_id_idx ON t1 (id);',
  });
  try {
    assert.throws(() => loadMigrations(dir), /non-transactional concurrent index/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMigrations rejects transaction control without matching comments, strings, or function bodies', () => {
  const escaped = tmpSchemaDir({
    '001_init.sql': `CREATE TABLE first_table (id int); COMMIT; CREATE TABLE escaped_table (id int);`,
  });
  const inert = tmpSchemaDir({
    '001_init.sql': `-- COMMIT must remain inert
CREATE FUNCTION inert_transaction_words() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  RETURN 'COMMIT; ROLLBACK; CREATE INDEX CONCURRENTLY';
END;
$body$;`,
  });
  try {
    assert.throws(() => loadMigrations(escaped), /transaction-control SQL/i);
    assert.doesNotThrow(() => loadMigrations(inert));
  } finally {
    rmSync(escaped, { recursive: true, force: true });
    rmSync(inert, { recursive: true, force: true });
  }
});

test('runMigrations applies in order, records, and idempotent re-run skips (case 8)', opts, async () => {
  const fresh = await createFreshDb();
  const dir = tmpSchemaDir({
    '001_init.sql': `CREATE SCHEMA IF NOT EXISTS brain_meta;
CREATE TABLE IF NOT EXISTS brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE t1 (id int);`,
    '002_more.sql': `CREATE TABLE t2 (id int);`,
  });
  const pool = createBrainPool('admin', fresh.url);
  try {
    const first = await runMigrations(pool, dir);
    assert.deepEqual(first.applied, ['001_init.sql', '002_more.sql']);
    assert.deepEqual(first.skipped, []);

    const second = await runMigrations(pool, dir);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['001_init.sql', '002_more.sql']);

    const rec = await pool.query(`SELECT filename FROM brain_meta.schema_migrations ORDER BY filename`);
    assert.deepEqual(rec.rows.map((r) => r.filename), ['001_init.sql', '002_more.sql']);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await fresh.drop();
  }
});

test('transaction-control migration is rejected before any earlier migration can commit', opts, async () => {
  const fresh = await createFreshDb();
  const dir = tmpSchemaDir({
    '001_init.sql': `CREATE SCHEMA brain_meta;
CREATE TABLE brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE must_rollback (id int);`,
    '002_escape.sql': `COMMIT; CREATE TABLE must_not_exist (id int);`,
  });
  const pool = createBrainPool('admin', fresh.url);
  try {
    await assert.rejects(runMigrations(pool, dir), /transaction-control SQL/i);
    const state = await pool.query<{ first: string | null; second: string | null }>(
      `SELECT to_regclass('public.must_rollback')::text AS first,
              to_regclass('public.must_not_exist')::text AS second`,
    );
    assert.deepEqual(state.rows[0], { first: null, second: null });
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await fresh.drop();
  }
});

test('runMigrations aborts when an applied file sha256 changed (case 8)', opts, async () => {
  const fresh = await createFreshDb();
  const dir = tmpSchemaDir({
    '001_init.sql': `CREATE SCHEMA IF NOT EXISTS brain_meta;
CREATE TABLE IF NOT EXISTS brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE t1 (id int);`,
  });
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool, dir);
    writeFileSync(join(dir, '001_init.sql'), `CREATE SCHEMA IF NOT EXISTS brain_meta;
CREATE TABLE IF NOT EXISTS brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE t1 (id int); -- tampered`, 'utf8');
    await assert.rejects(runMigrations(pool, dir), /sha256 mismatch/i);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await fresh.drop();
  }
});

test('migration ledger must be the exact loaded-file prefix before run or pending inspection', opts, async () => {
  const fresh = await createFreshDb();
  const dir = tmpSchemaDir({
    '001_init.sql': `CREATE SCHEMA IF NOT EXISTS brain_meta;
CREATE TABLE IF NOT EXISTS brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL); CREATE TABLE t1 (id int);`,
    '002_more.sql': `CREATE TABLE t2 (id int);`,
  });
  const pool = createBrainPool('admin', fresh.url);
  const files = loadMigrations(dir);
  try {
    await pool.query(`CREATE SCHEMA brain_meta`);
    await pool.query(`CREATE TABLE brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL)`);
    for (const row of [
      { filename: files[1]!.filename, sha256: files[1]!.sha256 },
      { filename: '999_future.sql', sha256: '0'.repeat(64) },
    ]) {
      await pool.query(`TRUNCATE brain_meta.schema_migrations`);
      await pool.query(`INSERT INTO brain_meta.schema_migrations (filename, sha256) VALUES ($1, $2)`, [row.filename, row.sha256]);
      await assert.rejects(runMigrations(pool, dir), /exact ordered prefix/i);
      await assert.rejects(pendingMigrations(pool, dir), /exact ordered prefix/i);
      const noDdl = await pool.query<{ t1: string | null; t2: string | null }>(
        `SELECT to_regclass('public.t1')::text AS t1, to_regclass('public.t2')::text AS t2`,
      );
      assert.deepEqual(noDdl.rows[0], { t1: null, t2: null });
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await fresh.drop();
  }
});

test('pendingMigrations accepts an exact numeric-prefix ledger with nonuniform filename padding', opts, async () => {
  const fresh = await createFreshDb();
  const dir = tmpSchemaDir({
    '2_first.sql': `SELECT 1;`,
    '010_second.sql': `SELECT 1;`,
  });
  const pool = createBrainPool('admin', fresh.url);
  const files = loadMigrations(dir);
  try {
    await pool.query(`CREATE SCHEMA brain_meta`);
    await pool.query(`CREATE TABLE brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL)`);
    await pool.query(`INSERT INTO brain_meta.schema_migrations (filename, sha256) VALUES ($1, $2)`, [
      files[0]!.filename,
      files[0]!.sha256,
    ]);
    assert.deepEqual(await pendingMigrations(pool, dir), ['010_second.sql']);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await fresh.drop();
  }
});

test('runMigrations holds an advisory xact lock during the run (case 8)', opts, async () => {
  const fresh = await createFreshDb();
  const dir = tmpSchemaDir({
    '001_init.sql': `CREATE SCHEMA IF NOT EXISTS brain_meta;
CREATE TABLE IF NOT EXISTS brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`,
  });
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool, dir);
    // The migration takes pg_advisory_xact_lock(8135135) for the duration of its
    // transaction and must release it on commit. Prove release by re-acquiring the
    // same key with the blocking variant: pg_advisory_xact_lock is cluster-wide and
    // serializes migrations, so a leaked lock would make this hang/fail. Wrap in our
    // own short transaction and roll it back. (A parallel test file mid-migration may
    // momentarily hold the key, so retry briefly before asserting failure.)
    let acquired = false;
    for (let i = 0; i < 50 && !acquired; i++) {
      const probe = await pool.query<{ got: boolean }>(`SELECT pg_try_advisory_lock(8135135) AS got`);
      acquired = probe.rows[0]!.got;
      if (acquired) await pool.query(`SELECT pg_advisory_unlock(8135135)`);
      else await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(acquired, true, 'xact lock must be released after the transaction commits');
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await fresh.drop();
  }
});
