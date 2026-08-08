import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type pg from 'pg';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { loadMigrations, runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { createFreshDb, HAS_DB, runtimeClient, type FreshDb } from './brain-helpers.ts';

const dbOpts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const SOURCE_ID = `sha256:${HASH_A}`;
const VERSION_ID = `sha256:${HASH_B}`;
const TOMBSTONE_ID = `sha256:${HASH_C}`;
const INTENT_ID = `sha256:${HASH_D}`;
const OBJECT_ID = `sha256:${HASH_B}`;
const OBJECT_KEY = `objects/${HASH_B.slice(0, 2)}/${HASH_B}`;
const FINGERPRINT_A = `sha256:${HASH_A}`;
const FINGERPRINT_B = `sha256:${HASH_B}`;

const PROTECTED_TABLES = [
  'ingest_intents',
  'logical_sources',
  'source_objects',
  'source_tombstones',
  'source_version_labels',
  'source_versions',
] as const;

type Provisioned = {
  fresh: FreshDb;
  pool: pg.Pool;
  password: string;
  teardown: () => Promise<void>;
};

async function provision(): Promise<Provisioned> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, (client) => ensureRuntimeRole(client, fresh.role));
    assert.ok(role.password);
    return {
      fresh,
      pool,
      password: role.password,
      teardown: async () => {
        await pool.end();
        await fresh.drop();
      },
    };
  } catch (error) {
    await pool.end();
    await fresh.drop();
    throw error;
  }
}

async function seedVersion(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO brain.source_objects
       (object_id, sha256, object_key, size_bytes, etag, s3_version_id)
     VALUES ($1, $2, $3, 5, 'opaque-etag', 'version-one')`,
    [OBJECT_ID, HASH_B, OBJECT_KEY],
  );
  await pool.query(
    `INSERT INTO brain.logical_sources
       (source_id, source_kind, origin_fingerprint, origin, next_sequence)
     VALUES ($1, 'inline-text', $2, '{"stable_key":"example"}'::jsonb, 1)`,
    [SOURCE_ID, FINGERPRINT_A],
  );
  await pool.query(
    `INSERT INTO brain.source_versions
       (source_version_id, source_id, version_fingerprint, object_id,
        first_prepared_sequence, media_type, privacy_class, trust_class,
        actor_assurance, assurance_evidence, metadata, provenance, locators)
     VALUES ($1, $2, $3, $4, 1, 'text/plain', 'internal', 'host-asserted',
             'host-attested', '{"host":"codex"}'::jsonb, '{}'::jsonb,
             '{"selected_by":"host"}'::jsonb, '[]'::jsonb)`,
    [VERSION_ID, SOURCE_ID, FINGERPRINT_B, OBJECT_ID],
  );
  await pool.query(
    `UPDATE brain.logical_sources
        SET current_sequence = 1, current_version_id = $2
      WHERE source_id = $1`,
    [SOURCE_ID, VERSION_ID],
  );
  await pool.query(
    `INSERT INTO brain.source_version_labels
       (source_version_id, function_id, agent_id, plan_id)
     VALUES ($1, NULL, NULL, NULL),
            ($1, 'social-media', NULL, NULL),
            ($1, 'social-media', 'manager', 'discover')`,
    [VERSION_ID],
  );
}

async function seedTombstoneAndIntent(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE brain.logical_sources SET next_sequence = 3 WHERE source_id = $1`,
    [SOURCE_ID],
  );
  await pool.query(
    `INSERT INTO brain.source_tombstones
       (tombstone_id, source_id, sequence, prior_version_id, request_key,
        request_fingerprint, reason, actor_assurance, assurance_evidence, provenance)
     VALUES ($1, $2, 2, $3, 'tombstone-one', $4, 'superseded source',
             'human-confirmed', '{"confirmation_id":"confirm-one"}'::jsonb,
             '{"host":"codex"}'::jsonb)`,
    [TOMBSTONE_ID, SOURCE_ID, VERSION_ID, FINGERPRINT_A],
  );
  await pool.query(
    `UPDATE brain.logical_sources
        SET current_sequence = 2, active_tombstone_id = $2
      WHERE source_id = $1`,
    [SOURCE_ID, TOMBSTONE_ID],
  );
  await pool.query(
    `INSERT INTO brain.ingest_intents
       (intent_id, request_key, request_fingerprint, source_id, prepared_sequence,
        source_version_id, version_fingerprint, object_id, object_sha256,
        object_key, size_bytes, expected_tombstone_id, request_payload, state)
     VALUES ($1, 'ingest-one', $2, $3, 3, $4, $5, $6, $7, $8, 5, $9,
             '{"kind":"inline-text"}'::jsonb, 'prepared')`,
    [
      INTENT_ID,
      FINGERPRINT_B,
      SOURCE_ID,
      VERSION_ID,
      FINGERPRINT_B,
      OBJECT_ID,
      HASH_B,
      OBJECT_KEY,
      TOMBSTONE_ID,
    ],
  );
}

test('source lifecycle migration is ordered, transaction-safe, and contains no tenancy/RLS surface', () => {
  const migration = loadMigrations().find((entry) => entry.filename === '011_source_lifecycle.sql');
  assert.ok(migration);
  assert.equal(migration.prefix, 11);
  assert.doesNotMatch(
    migration.sql,
    /\b(?:brain_spaces?|workspace_bindings?|workspace_id|CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY)\b/iu,
  );
  const source = readFileSync(new URL('../data/brain/schema/011_source_lifecycle.sql', import.meta.url), 'utf8');
  for (const table of PROTECTED_TABLES) {
    assert.match(source, new RegExp(`\\('${table.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\'\\)`));
  }
});

test('source lifecycle schema installs the six protected tables without RLS or tenancy columns', dbOpts, async () => {
  const { pool, teardown } = await provision();
  try {
    const registered = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM brain_meta.runtime_protected_tables
        WHERE table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...PROTECTED_TABLES]],
    );
    assert.deepEqual(registered.rows.map((row) => row.table_name), [...PROTECTED_TABLES]);

    const relations = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'brain' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [[...PROTECTED_TABLES]],
    );
    assert.deepEqual(relations.rows.map((row) => row.relname), [...PROTECTED_TABLES]);
    assert.equal(relations.rows.every((row) => !row.relrowsecurity && !row.relforcerowsecurity), true);

    const tenancy = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'brain'
          AND table_name = ANY($1::text[])
          AND column_name IN ('workspace_id', 'brain_space_id', 'workspace_binding_id')`,
      [[...PROTECTED_TABLES]],
    );
    assert.equal(tenancy.rowCount, 0);

    const cyclicConstraints = [
      'logical_sources_active_tombstone_fkey',
      'logical_sources_current_version_fkey',
      'source_tombstones_restored_intent_fkey',
    ];
    const deferred = await pool.query<{
      conname: string;
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `SELECT conname, condeferrable, condeferred
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [cyclicConstraints],
    );
    assert.deepEqual(deferred.rows.map((row) => row.conname), cyclicConstraints);
    assert.equal(deferred.rows.every((row) => row.condeferrable && !row.condeferred), true);
  } finally {
    await teardown();
  }
});

test('source lifecycle schema enforces identities, closed vocabularies, and complete label hierarchies', dbOpts, async () => {
  const { pool, teardown } = await provision();
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO brain.source_objects (object_id, sha256, object_key, size_bytes)
         VALUES ('sha256:${HASH_A}', '${HASH_B}', '${OBJECT_KEY}', 5)`,
      ),
      /identity_matches_hash|check constraint/iu,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO brain.source_objects (object_id, sha256, object_key, size_bytes)
         VALUES ($1, $2, $3, 67108865)`,
        [`sha256:${HASH_C}`, HASH_C, `objects/${HASH_C.slice(0, 2)}/${HASH_C}`],
      ),
      /check constraint/iu,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO brain.logical_sources
           (source_id, source_kind, origin_fingerprint, origin)
         VALUES ('sha256:${HASH_C}', 'unknown-kind', $1, '{}'::jsonb)`,
        [FINGERPRINT_A],
      ),
      /check constraint/iu,
    );

    await seedVersion(pool);
    const labels = await pool.query<{ label_key: string }>(
      `SELECT label_key FROM brain.source_version_labels
        WHERE source_version_id = $1 ORDER BY label_key`,
      [VERSION_ID],
    );
    assert.deepEqual(labels.rows.map((row) => row.label_key), [
      'function:social-media',
      'plan:social-media/manager#discover',
      'workspace',
    ]);
    await assert.rejects(
      pool.query(
        `INSERT INTO brain.source_version_labels
           (source_version_id, function_id, agent_id, plan_id)
         VALUES ($1, 'social-media', NULL, 'discover')`,
        [VERSION_ID],
      ),
      /complete_hierarchy|check constraint/iu,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO brain.source_versions
           (source_version_id, source_id, version_fingerprint, object_id,
            first_prepared_sequence, media_type, privacy_class, trust_class,
            actor_assurance, assurance_evidence, metadata, provenance, locators)
         VALUES ('sha256:${HASH_C}', $1, $2, $3, 2, 'text/plain', 'restricted',
                 'host-asserted', 'caller-asserted', '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '[]'::jsonb)`,
        [SOURCE_ID, `sha256:${HASH_C}`, OBJECT_ID],
      ),
      /check constraint/iu,
    );
    const invalidIntent = (requestKey: string, sizeBytes: number) => pool.query(
      `INSERT INTO brain.ingest_intents
         (intent_id, request_key, request_fingerprint, source_id, prepared_sequence,
          source_version_id, version_fingerprint, object_id, object_sha256,
          object_key, size_bytes, request_payload, state)
       VALUES ($1, $2, $3, $4, 2, $5, $6, $7, $8, $9, $10, '{}'::jsonb, 'prepared')`,
      [
        `sha256:${HASH_C}`,
        requestKey,
        `sha256:${HASH_C}`,
        SOURCE_ID,
        `sha256:${HASH_C}`,
        `sha256:${HASH_C}`,
        OBJECT_ID,
        HASH_B,
        OBJECT_KEY,
        sizeBytes,
      ],
    );
    await assert.rejects(invalidIntent('r'.repeat(257), 5), /check constraint/iu);
    await assert.rejects(invalidIntent('invalid?key', 5), /check constraint/iu);
    await assert.rejects(invalidIntent('valid-key', 67108865), /check constraint/iu);
  } finally {
    await teardown();
  }
});

test('source lifecycle immutable rows and state transitions fail closed', dbOpts, async () => {
  const { pool, teardown } = await provision();
  try {
    await seedVersion(pool);
    await seedTombstoneAndIntent(pool);

    await assert.rejects(
      pool.query(`UPDATE brain.source_objects SET etag = 'changed' WHERE object_id = $1`, [OBJECT_ID]),
      /immutable/iu,
    );
    await assert.rejects(
      pool.query(`DELETE FROM brain.source_versions WHERE source_version_id = $1`, [VERSION_ID]),
      /immutable/iu,
    );
    await assert.rejects(
      pool.query(`DELETE FROM brain.source_version_labels WHERE source_version_id = $1`, [VERSION_ID]),
      /immutable/iu,
    );
    await assert.rejects(pool.query(`TRUNCATE brain.source_version_labels`), /immutable/iu);
    await assert.rejects(
      pool.query(`UPDATE brain.logical_sources SET origin = '{"changed":true}'::jsonb WHERE source_id = $1`, [SOURCE_ID]),
      /identity is immutable/iu,
    );
    await assert.rejects(
      pool.query(`UPDATE brain.logical_sources SET next_sequence = 1 WHERE source_id = $1`, [SOURCE_ID]),
      /cannot rewind/iu,
    );

    await assert.rejects(
      pool.query(
        `UPDATE brain.source_tombstones
            SET restored_version_id = $2,
                restore_request_key = 'restore-without-sequence',
                restore_request_fingerprint = $3,
                restored_at = now()
          WHERE tombstone_id = $1`,
        [TOMBSTONE_ID, VERSION_ID, FINGERPRINT_B],
      ),
      /restoration_shape|check constraint/iu,
    );
    await pool.query(
      `UPDATE brain.source_tombstones
          SET restored_sequence = 3,
              restored_version_id = $2,
              restore_request_key = 'restore-one',
              restore_request_fingerprint = $3,
              restored_at = now()
        WHERE tombstone_id = $1`,
      [TOMBSTONE_ID, VERSION_ID, FINGERPRINT_B],
    );
    await assert.rejects(
      pool.query(`UPDATE brain.source_tombstones SET reason = 'rewritten' WHERE tombstone_id = $1`, [TOMBSTONE_ID]),
      /only transition once/iu,
    );

    await assert.rejects(
      pool.query(
        `UPDATE brain.ingest_intents
            SET state = 'complete',
                published_as_current = false,
                completed_at = now()
          WHERE intent_id = $1`,
        [INTENT_ID],
      ),
      /state_shape|check constraint/iu,
    );
    await pool.query(
      `UPDATE brain.ingest_intents
          SET state = 'complete',
              published_version_id = source_version_id,
              published_object_id = object_id,
              published_as_current = false,
              completed_at = now()
        WHERE intent_id = $1`,
      [INTENT_ID],
    );
    await assert.rejects(
      pool.query(`UPDATE brain.ingest_intents SET published_as_current = true WHERE intent_id = $1`, [INTENT_ID]),
      /prepared to complete/iu,
    );
    await assert.rejects(
      pool.query(`DELETE FROM brain.ingest_intents WHERE intent_id = $1`, [INTENT_ID]),
      /immutable/iu,
    );
    await assert.rejects(
      pool.query(`DELETE FROM brain_meta.runtime_protected_tables WHERE table_name = 'source_objects'`),
      /immutable/iu,
    );
    await assert.rejects(
      pool.query(`TRUNCATE brain_meta.runtime_protected_tables`),
      /immutable/iu,
    );
  } finally {
    await teardown();
  }
});

test('runtime can inspect but cannot directly mutate lifecycle state or its protected registry', dbOpts, async () => {
  const { fresh, pool, password, teardown } = await provision();
  const runtime = await runtimeClient(fresh.url, password, fresh.role);
  try {
    for (const table of PROTECTED_TABLES) {
      const selected = await runtime.query(`SELECT count(*)::int AS count FROM brain.${table}`);
      assert.equal(selected.rows[0]?.count, 0);
      await assert.rejects(runtime.query(`INSERT INTO brain.${table} DEFAULT VALUES`), /permission denied/iu);
      await assert.rejects(runtime.query(`UPDATE brain.${table} SET created_at = created_at`), /permission denied/iu);
      await assert.rejects(runtime.query(`DELETE FROM brain.${table}`), /permission denied/iu);
      await assert.rejects(runtime.query(`TRUNCATE brain.${table}`), /permission denied|must be owner/iu);
    }
    await assert.rejects(
      runtime.query(`SELECT table_name FROM brain_meta.runtime_protected_tables`),
      /permission denied/iu,
    );
    await assert.rejects(
      runtime.query(`INSERT INTO brain_meta.runtime_protected_tables VALUES ('entities')`),
      /permission denied/iu,
    );

    const publicAccess = await pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.table_privileges
          WHERE table_schema = 'brain_meta'
            AND table_name = 'runtime_protected_tables'
            AND grantee = 'PUBLIC'
            AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       ) AS allowed`,
    );
    assert.equal(publicAccess.rows[0]?.allowed, false);
  } finally {
    await runtime.end();
    await teardown();
  }
});
