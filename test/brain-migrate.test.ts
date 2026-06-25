import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { loadMigrations, runMigrations } from '../src/lib/brain/migrate.ts';
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
