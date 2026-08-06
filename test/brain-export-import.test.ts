import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { saveEntity } from '../src/lib/brain/save.ts';
import { appendEvent } from '../src/lib/brain/event.ts';
import { createLink } from '../src/lib/brain/link.ts';
import { mountFile } from '../src/lib/brain/mount.ts';
import { createTable } from '../src/lib/brain/table.ts';
import { exportBrain } from '../src/lib/brain/export.ts';
import { importBrain } from '../src/lib/brain/import.ts';
import { snapshotTable } from '../src/lib/brain/backup-shared.ts';
import { HAS_DB, createFreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

const LIFECYCLE_OBJECT_HASH = 'a'.repeat(64);
const LIFECYCLE_OBJECT_ID = `sha256:${LIFECYCLE_OBJECT_HASH}`;
const LIFECYCLE_SOURCE_ID = `sha256:${'b'.repeat(64)}`;
const LIFECYCLE_VERSION_ID = `sha256:${'c'.repeat(64)}`;
const LIFECYCLE_VERSION_FINGERPRINT = `sha256:${'d'.repeat(64)}`;
const LIFECYCLE_INTENT_ID = `sha256:${'e'.repeat(64)}`;
const LIFECYCLE_REQUEST_FINGERPRINT = `sha256:${'f'.repeat(64)}`;
const LIFECYCLE_ORIGIN_FINGERPRINT = `sha256:${'1'.repeat(64)}`;
const LIFECYCLE_TABLES = [
  'source_objects',
  'logical_sources',
  'source_versions',
  'source_version_labels',
  'source_tombstones',
  'ingest_intents',
] as const;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'brain-backup-'));
}

async function initBrain(url: string): Promise<pg.Pool> {
  const pool = createBrainPool('admin', url);
  await runMigrations(pool);
  return pool;
}

// Populate a brain with a representative mix: core entities/facts/events/edges,
// a mounted document, an agent-created table, and fidelity edge cases
// (SQL NULL vs JSONB null, bigint/jsonb numbers > 2^53).
async function populate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const acme = await saveEntity(client, {
      kind: 'company',
      slug: 'acme',
      title: 'Acme AI',
      fields: [{ key: 'hq', value: 'SF' }, { key: 'employees', value: 42 }],
      source: 'test',
      confidence: 0.9,
      actor: 'tester',
    });
    await saveEntity(client, { kind: 'company', slug: 'globex', title: 'Globex', fields: [] });
    await appendEvent(client, { kind: 'metric', slug: 'acme', payload: { mrr: 1000 }, actor: 'tester' });
    await createLink(client, { srcSlug: 'acme', rel: 'competes_with', dstSlug: 'globex' });

    // Fidelity edge cases inserted raw so JS number limits don't corrupt them.
    const entId = acme.entityId ?? (await client.query(`SELECT id FROM brain.entities WHERE slug='acme'`)).rows[0]!.id;
    await client.query(`INSERT INTO brain.facts (entity_id, key, value) VALUES ($1, 'sqlnull', NULL)`, [entId]);
    await client.query(`INSERT INTO brain.facts (entity_id, key, value) VALUES ($1, 'jsonnull', 'null'::jsonb)`, [entId]);
    await client.query(`INSERT INTO brain.facts (entity_id, key, value) VALUES ($1, 'bignum', '9007199254740993'::jsonb)`, [entId]);

    // Agent-created table through the broker, with all broker types + a bigint > 2^53.
    await createTable(client, 'metrics', [
      { name: 'label', type: 'text' },
      { name: 'n', type: 'bigint' },
      { name: 'ratio', type: 'numeric' },
      { name: 'flag', type: 'boolean' },
      { name: 'meta', type: 'jsonb' },
      { name: 'uid', type: 'uuid' },
      { name: 'at', type: 'timestamptz' },
    ]);
    await client.query(
      `INSERT INTO brain.metrics (label, n, ratio, flag, meta, uid, at)
       VALUES ('big', 9007199254740993, 3.141592653589793, true, '{"k":"v","z":null}'::jsonb,
               '11111111-2222-3333-4444-555555555555'::uuid, '2026-06-25T03:10:00.123456+00'::timestamptz),
              ('empty', NULL, NULL, NULL, NULL, NULL, NULL)`,
    );

    // entity_aliases + entity_merges rows so both core tables are exercised.
    const globexId = (await client.query(`SELECT id FROM brain.entities WHERE slug='globex'`)).rows[0]!.id;
    await client.query(
      `INSERT INTO brain.entity_aliases (entity_id, alias, source, actor) VALUES ($1, 'ACME Inc', 'test', 'tester')`,
      [entId],
    );
    await client.query(
      `INSERT INTO brain.entity_merges (from_id, into_id, actor) VALUES ($1, $2, 'tester')`,
      [globexId, entId],
    );

    // File-ledger rows (ROS-157): a put + a tombstone, so both ops round-trip.
    await client.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, size_bytes, content_hash, etag, content_type)
       VALUES ('company','acme','deck.pdf','put','s3://bkt/files/company/acme/deck.pdf','bkt','files/company/acme/deck.pdf',
               9007199254740993, 'abc123', 'etag-1', 'application/pdf')`,
    );
    await client.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, actor)
       VALUES ('company','acme','old.md','rm','s3://bkt/files/company/acme/old.md','bkt','files/company/acme/old.md','tester')`,
    );
  } finally {
    client.release();
  }

  // Mount a markdown file as append-only document chunks.
  const md = join(tmpDir(), 'note.md');
  writeFileSync(md, '# Title\n\nfirst para\n\n## Section\n\nsecond para\n');
  const mc = await pool.connect();
  try {
    await mountFile(mc, md);
  } finally {
    mc.release();
  }
}

async function populateLifecycle(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO brain.source_objects
         (object_id, sha256, object_key, size_bytes)
       VALUES ($1, $2, $3, 5)`,
      [
        LIFECYCLE_OBJECT_ID,
        LIFECYCLE_OBJECT_HASH,
        `objects/${LIFECYCLE_OBJECT_HASH.slice(0, 2)}/${LIFECYCLE_OBJECT_HASH}`,
      ],
    );
    await client.query(
      `INSERT INTO brain.logical_sources
         (source_id, source_kind, origin_fingerprint, origin, next_sequence)
       VALUES ($1, 'inline-text', $2, $3::jsonb, 1)`,
      [
        LIFECYCLE_SOURCE_ID,
        LIFECYCLE_ORIGIN_FINGERPRINT,
        JSON.stringify({ kind: 'inline-text', stableKey: 'backup-lifecycle' }),
      ],
    );
    await client.query(
      `INSERT INTO brain.source_versions
         (source_version_id, source_id, version_fingerprint, object_id,
          first_prepared_sequence, media_type, privacy_class, trust_class,
          actor_assurance, assurance_evidence, metadata, provenance, locators)
       VALUES ($1, $2, $3, $4, 1, 'text/plain', 'internal', 'host-asserted',
               'host-attested', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      [
        LIFECYCLE_VERSION_ID,
        LIFECYCLE_SOURCE_ID,
        LIFECYCLE_VERSION_FINGERPRINT,
        LIFECYCLE_OBJECT_ID,
      ],
    );
    await client.query(
      `INSERT INTO brain.source_version_labels
         (source_version_id, function_id, agent_id, plan_id)
       VALUES ($1, NULL, NULL, NULL),
              ($1, 'social-media', 'manager', NULL),
              ($1, 'social-media', 'manager', 'discovery')`,
      [LIFECYCLE_VERSION_ID],
    );
    await client.query(
      `UPDATE brain.logical_sources
          SET current_sequence = 1, current_version_id = $2
        WHERE source_id = $1`,
      [LIFECYCLE_SOURCE_ID, LIFECYCLE_VERSION_ID],
    );
    await client.query(
      `INSERT INTO brain.ingest_intents
         (intent_id, request_key, request_fingerprint, source_id, prepared_sequence,
          source_version_id, version_fingerprint, object_id, object_sha256,
          object_key, size_bytes, request_payload, state, published_version_id,
          published_object_id, published_as_current, completed_at)
       VALUES ($1, 'backup-lifecycle-v1', $2, $3, 1, $4, $5, $6, $7, $8,
               5, '{}'::jsonb, 'complete', $4, $6, true, now())`,
      [
        LIFECYCLE_INTENT_ID,
        LIFECYCLE_REQUEST_FINGERPRINT,
        LIFECYCLE_SOURCE_ID,
        LIFECYCLE_VERSION_ID,
        LIFECYCLE_VERSION_FINGERPRINT,
        LIFECYCLE_OBJECT_ID,
        LIFECYCLE_OBJECT_HASH,
        `objects/${LIFECYCLE_OBJECT_HASH.slice(0, 2)}/${LIFECYCLE_OBJECT_HASH}`,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function tableRows(pool: pg.Pool, name: string): Promise<(string | null)[][]> {
  const client = await pool.connect();
  try {
    return (await snapshotTable(client, name)).rows;
  } finally {
    client.release();
  }
}

async function currentFacts(pool: pg.Pool): Promise<unknown[]> {
  const r = await pool.query(
    `SELECT entity_id, key, value::text AS value FROM brain.current_facts ORDER BY entity_id, key`,
  );
  return r.rows;
}

const BACKUP_TABLES = [
  'entities',
  'facts',
  'events',
  'edges',
  'mounts',
  'documents',
  'files',
  'entity_aliases',
  'entity_merges',
  'metrics',
];

async function assertParity(src: pg.Pool, dst: pg.Pool): Promise<void> {
  for (const name of BACKUP_TABLES) {
    assert.deepEqual(await tableRows(dst, name), await tableRows(src, name), `table ${name} parity`);
  }
  assert.deepEqual(await currentFacts(dst), await currentFacts(src), 'current_facts parity');
}

for (const format of ['jsonl', 'sql'] as const) {
  test(`brain export/import round-trips a populated brain (${format})`, opts, async () => {
    const srcDb = await createFreshDb();
    const dstDb = await createFreshDb();
    const dir = tmpDir();
    const src = await initBrain(srcDb.url);
    const dst = await initBrain(dstDb.url);
    try {
      await populate(src);
      const exp = await exportBrain(src, { outDir: dir, format, exportedAt: '2026-06-26T00:00:00.000Z' });
      assert.equal(exp.format, format);
      assert.ok(exp.totalRows > 0);

      // JSONL is always written; --format sql adds a standalone dump.sql artifact.
      assert.ok(existsSync(join(dir, 'entities.jsonl')), 'jsonl data files always present');
      assert.equal(existsSync(join(dir, 'dump.sql')), format === 'sql', 'dump.sql only for sql format');

      const imp = await importBrain(dst, dir);
      assert.equal(imp.format, format);
      assert.equal(imp.totalRows, exp.totalRows);

      await assertParity(src, dst);

      // SQL NULL vs JSONB null vs big number survive distinctly.
      const facts = await dst.query(
        `SELECT key, value, value::text AS vtext FROM brain.facts WHERE key IN ('sqlnull','jsonnull','bignum')`,
      );
      const byKey = Object.fromEntries(facts.rows.map((r) => [r.key, r]));
      assert.equal(byKey['sqlnull']!.value, null, 'SQL NULL preserved as NULL');
      assert.equal(byKey['jsonnull']!.vtext, 'null', 'JSONB null preserved as null literal');
      assert.equal(byKey['bignum']!.vtext, '9007199254740993', 'bigint jsonb > 2^53 preserved');

      // Identity continuity: a fresh insert after restore must not collide.
      const maxId = (await dst.query(`SELECT max(id)::text AS m FROM brain.entities`)).rows[0]!.m as string;
      const next = await dst.query(
        `INSERT INTO brain.entities (kind, slug, title) VALUES ('company','newco','New') RETURNING id::text AS id`,
      );
      assert.equal(BigInt(next.rows[0]!.id), BigInt(maxId) + 1n, 'sequence resumes at max(id)+1');
    } finally {
      await src.end();
      await dst.end();
      rmSync(dir, { recursive: true, force: true });
      await srcDb.drop();
      await dstDb.drop();
    }
  });
}

test('brain backup is stable across source and target session formatting settings', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const srcInit = await initBrain(srcDb.url);
  const dstInit = await initBrain(dstDb.url);
  await srcInit.end();
  await dstInit.end();
  const src = new pg.Pool({ connectionString: srcDb.url, max: 1 });
  const dst = new pg.Pool({ connectionString: dstDb.url, max: 1 });
  try {
    await src.query(`SET TIME ZONE 'Pacific/Honolulu'`);
    await src.query(`SET DateStyle = 'SQL, DMY'`);
    await src.query(`SET extra_float_digits = 0`);
    await dst.query(`SET TIME ZONE 'Europe/Istanbul'`);
    await dst.query(`SET DateStyle = 'German, DMY'`);
    await dst.query(`SET extra_float_digits = 1`);
    await populate(src);

    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    await importBrain(dst, dir);
    await src.query(`SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, YMD'; SET extra_float_digits = 3`);
    await dst.query(`SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, YMD'; SET extra_float_digits = 3`);
    await assertParity(src, dst);
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain backup round-trips lifecycle tables with semantic primary keys', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const sqlDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  const sqlDst = await initBrain(sqlDb.url);
  try {
    await populate(src);
    await populateLifecycle(src);
    const capture = await src.connect();
    const statements: string[] = [];
    try {
      await snapshotTable({
        query: async (text: string, values?: unknown[]) => {
          statements.push(text);
          return capture.query(text, values as never[]);
        },
      } as unknown as pg.PoolClient, 'source_version_labels');
    } finally {
      capture.release();
    }
    assert.match(
      statements.find((statement) => statement.includes('FROM brain."source_version_labels" ORDER BY')) ?? '',
      /ORDER BY "source_version_id" COLLATE pg_catalog\."C", "label_key" COLLATE pg_catalog\."C"$/u,
    );

    const exp = await exportBrain(src, {
      outDir: dir,
      format: 'sql',
      exportedAt: '2026-08-06T00:00:00.000Z',
    });
    const counts = new Map(exp.tables.map((table) => [table.name, table.rowCount]));
    assert.equal(counts.get('source_objects'), 1);
    assert.equal(counts.get('logical_sources'), 1);
    assert.equal(counts.get('source_versions'), 1);
    assert.equal(counts.get('source_version_labels'), 3);
    assert.equal(counts.get('source_tombstones'), 0);
    assert.equal(counts.get('ingest_intents'), 1);

    const sql = readFileSync(join(dir, 'dump.sql'), 'utf8');
    assert.doesNotMatch(sql, /\bsetval\s*\(/iu);
    assert.match(sql, /SET CONSTRAINTS .* DEFERRED;/u);
    assert.match(sql, /SET CONSTRAINTS .* IMMEDIATE;/u);
    assert.match(sql, /ALTER SEQUENCE %I\.%I RESTART WITH 3/u);
    for (const name of LIFECYCLE_TABLES) {
      assert.equal(
        sql.includes(`pg_get_serial_sequence('brain."${name}"', 'id')`),
        false,
        `brain.${name} must not emit an id sequence reset`,
      );
    }

    const sqlClient = await sqlDst.connect();
    try {
      await sqlClient.query('BEGIN');
      await sqlClient.query(sql);
      await assert.rejects(sqlClient.query('SELECT 1 / 0'), /division by zero/iu);
      await sqlClient.query('ROLLBACK');
      const identity = await sqlClient.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value::text, is_called FROM brain.entities_id_seq`,
      );
      assert.deepEqual(identity.rows, [{ last_value: '1', is_called: false }]);
      const rolledBack = await sqlClient.query(`SELECT count(*)::int AS count FROM brain.logical_sources`);
      assert.equal(rolledBack.rows[0]!.count, 0);

      await sqlClient.query('BEGIN');
      await sqlClient.query(sql);
      await sqlClient.query('COMMIT');
    } catch (error) {
      await sqlClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      sqlClient.release();
    }

    await importBrain(dst, dir);
    for (const name of LIFECYCLE_TABLES) {
      assert.deepEqual(await tableRows(dst, name), await tableRows(src, name), `table ${name} parity`);
      assert.deepEqual(await tableRows(sqlDst, name), await tableRows(src, name), `dump table ${name} parity`);
    }
    const labels = await tableRows(dst, 'source_version_labels');
    assert.deepEqual(
      labels.map((row) => row.slice(1, 4)),
      [
        ['social-media', 'manager', null],
        ['social-media', 'manager', 'discovery'],
        [null, null, null],
      ],
      'compound generated primary key controls deterministic label order',
    );
  } finally {
    await src.end();
    await dst.end();
    await sqlDst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
    await sqlDb.drop();
  }
});

test('brain import refuses a non-empty target', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    // Seed the target with a row.
    await dst.query(`INSERT INTO brain.entities (kind, slug, title) VALUES ('company','pre','Pre')`);
    await assert.rejects(importBrain(dst, dir), /not empty/i);
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain import refuses a schema-version mismatch', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    // Tamper the manifest to look like a different (newer) schema.
    const mpath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
    manifest.schema_migrations.push({ filename: '999_future.sql', sha256: 'deadbeef' });
    writeFileSync(mpath, JSON.stringify(manifest, null, 2));
    await assert.rejects(importBrain(dst, dir), /schema version mismatch/i);
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain import never executes dump.sql — a corrupt dump.sql cannot affect the restore', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'sql', exportedAt: '2026-06-26T00:00:00.000Z' });
    // Sabotage dump.sql with a statement that would DROP data if executed.
    const dumpPath = join(dir, 'dump.sql');
    writeFileSync(dumpPath, readFileSync(dumpPath, 'utf8') + '\nDROP TABLE brain.entities CASCADE;\n');
    // Import reads JSONL only, so it succeeds and restores faithfully.
    await importBrain(dst, dir);
    await assertParity(src, dst);
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain import rejects a manifest with an injected column cast', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    const mpath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
    const entities = manifest.tables.find((t: { name: string }) => t.name === 'entities');
    entities.columns[2].cast = 'text); DROP TABLE brain.entities; --';
    writeFileSync(mpath, JSON.stringify(manifest, null, 2));
    await assert.rejects(importBrain(dst, dir), /invalid backup manifest|unsupported cast/i);
    // The malicious cast never reached the database.
    const present = await dst.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='brain' AND table_name='entities'`,
    );
    assert.equal(present.rowCount, 1, 'entities table must still exist');
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain.create_table serializes on the import advisory lock (migration 006)', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  const holder = new pg.Client({ connectionString: db.url });
  const broker = new pg.Client({ connectionString: db.url });
  await holder.connect();
  await broker.connect();
  try {
    // Simulate an in-flight import holding the lock.
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(8135141)');

    // A concurrent broker call must block on the same lock before creating anything.
    let created = false;
    const pending = broker
      .query(`SELECT brain.create_table('t_blocked', '[]'::jsonb)`)
      .then(() => {
        created = true;
      });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(created, false, 'create_table must block while the import lock is held');
    const mid = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='brain' AND table_name='t_blocked'`,
    );
    assert.equal(mid.rowCount, 0, 'no table is materialized while blocked');

    await holder.query('COMMIT'); // release the lock
    await pending; // broker now proceeds
    assert.equal(created, true);
    const after = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='brain' AND table_name='t_blocked'`,
    );
    assert.equal(after.rowCount, 1);
  } finally {
    await holder.end();
    await broker.end();
    await pool.end();
    await db.drop();
  }
});

test('brain export refuses a brain whose schema is not current', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    // Simulate a brain at an older/diverged schema than the bundled set.
    await pool.query(`DELETE FROM brain_meta.schema_migrations WHERE filename = '006_create_table_import_lock.sql'`);
    await assert.rejects(
      exportBrain(pool, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' }),
      /schema is not current/i,
    );
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('brain import rejects an incomplete backup (missing data file)', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    rmSync(join(dir, 'facts.jsonl'));
    await assert.rejects(importBrain(dst, dir), /incomplete backup/i);
    const n = await dst.query(`SELECT count(*)::int AS c FROM brain.entities`);
    assert.equal(n.rows[0]!.c, 0, 'rejected import leaves the target empty');
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain import rejects malformed JSONL rows', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    // A row with the wrong arity.
    writeFileSync(join(dir, 'entities.jsonl'), '["1","2026-01-01T00:00:00Z"]\n');
    await assert.rejects(importBrain(dst, dir), /corrupt backup data/i);
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('rejected brain import rolls identity sequence restarts back atomically', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await populate(src);
    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const files = manifest.tables.find((table: { name: string }) => table.name === 'files');
    files.checksum = '0'.repeat(32);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    await assert.rejects(importBrain(dst, dir), /import verification failed/iu);
    const next = await dst.query(
      `INSERT INTO brain.entities (kind, slug) VALUES ('company', 'after-reject') RETURNING id::text AS id`,
    );
    assert.equal(next.rows[0]!.id, '1');
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain export of an empty brain imports cleanly (empty-table sequence reset)', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    const exp = await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-26T00:00:00.000Z' });
    assert.equal(exp.totalRows, 0);
    const imp = await importBrain(dst, dir);
    assert.equal(imp.totalRows, 0);
    // First insert into a restored-empty table starts at 1.
    const r = await dst.query(`INSERT INTO brain.entities (kind, slug) VALUES ('company','first') RETURNING id::text AS id`);
    assert.equal(r.rows[0]!.id, '1');
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});
