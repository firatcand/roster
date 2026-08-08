import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type pg from 'pg';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { schemaDir } from '../src/lib/brain/migrate.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  deriveBrainWorkspaceAuthority,
} from '../src/lib/brain/workspace-authority.ts';
import type { WorkspaceBrainConfig } from '../src/lib/workspace-record.ts';
import { createFreshDb, HAS_DB, runtimeClient, type FreshDb } from './brain-helpers.ts';

const WORKSPACE_ID = 'extraction-schema-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const HASH_OBJECT = 'b'.repeat(64);
const SOURCE_ID = `sha256:${'a'.repeat(64)}`;
const VERSION_ID = `sha256:${'c'.repeat(64)}`;
const SECOND_VERSION_ID = `sha256:${'d'.repeat(64)}`;
const OBJECT_ID = `sha256:${HASH_OBJECT}`;
const OBJECT_KEY = `objects/${HASH_OBJECT.slice(0, 2)}/${HASH_OBJECT}`;
const EXTRACTION_ID = `sha256:${'1'.repeat(64)}`;
const SECOND_EXTRACTION_ID = `sha256:${'2'.repeat(64)}`;
const CHUNK_ID = `sha256:${'3'.repeat(64)}`;
const SECOND_CHUNK_ID = `sha256:${'4'.repeat(64)}`;
const SPEC_ID = `sha256:${'5'.repeat(64)}`;
const CONTENT_HASH = 'e'.repeat(64);

function config(): WorkspaceBrainConfig {
  return {
    secrets_path: '/extraction-schema-test',
    storage: { bucket: 'extraction-schema-test', region: 'eu-central-1', force_path_style: false },
  };
}

function digestOf(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function password(): string {
  return `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
}

function stagedMigrations(throughPrefix: number): { dir: string; cleanup: () => void } {
  const source = schemaDir();
  const dir = mkdtempSync(join(tmpdir(), 'roster-brain-schema-'));
  for (const filename of readdirSync(source).filter((entry) => /^\d+_.*\.sql$/u.test(entry))) {
    if (Number.parseInt(filename.split('_', 1)[0]!, 10) > throughPrefix) continue;
    copyFileSync(join(source, filename), join(dir, filename));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type Provisioned = {
  fresh: FreshDb;
  pool: pg.Pool;
  runtimeRole: string;
  runtimePassword: string;
  teardown: () => Promise<void>;
};

async function provision(migrationsDir?: string): Promise<Provisioned> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    const runtimePassword = password();
    const bootstrap = await bootstrapBrainWorkspaceAuthority(
      pool,
      deriveBrainWorkspaceAuthority(WORKSPACE_ID, config()),
      {
        runtimeRole: fresh.role,
        runtimePassword,
        ...(migrationsDir === undefined ? {} : { migrationsDir }),
      },
    );
    assert.equal(bootstrap.outcome, 'initialized');
    return {
      fresh,
      pool,
      runtimeRole: bootstrap.role.roleName,
      runtimePassword,
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

async function seedLifecycle(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO brain.source_objects (object_id, sha256, object_key, size_bytes, etag, s3_version_id)
     VALUES ($1, $2, $3, 11, 'opaque-etag', 'version-one')`,
    [OBJECT_ID, HASH_OBJECT, OBJECT_KEY],
  );
  await pool.query(
    `INSERT INTO brain.logical_sources (source_id, source_kind, origin_fingerprint, origin, next_sequence)
     VALUES ($1, 'inline-text', $1, '{"stable_key":"example"}'::jsonb, 2)`,
    [SOURCE_ID],
  );
  for (const [versionId, sequence, privacy] of [
    [VERSION_ID, 1, 'internal'],
    [SECOND_VERSION_ID, 2, 'secret'],
  ] as const) {
    await pool.query(
      `INSERT INTO brain.source_versions
         (source_version_id, source_id, version_fingerprint, object_id, first_prepared_sequence,
          media_type, privacy_class, trust_class, actor_assurance, assurance_evidence,
          metadata, provenance, locators)
       VALUES ($1, $2, $1, $3, $4, 'text/plain', $5, 'host-asserted', 'host-attested',
               '{"host":"codex"}'::jsonb, '{}'::jsonb, '{"selected_by":"host"}'::jsonb, '[]'::jsonb)`,
      [versionId, SOURCE_ID, OBJECT_ID, sequence, privacy],
    );
  }
  await pool.query(
    `UPDATE brain.logical_sources SET current_sequence = 1, current_version_id = $2 WHERE source_id = $1`,
    [SOURCE_ID, VERSION_ID],
  );
}

async function seedExtraction(pool: pg.Pool, versionId = VERSION_ID, extractionId = EXTRACTION_ID): Promise<void> {
  await pool.query(
    `INSERT INTO brain.source_extractions
       (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
        status, chunk_count, text_sha256, structured)
     VALUES ($1, $2, $3, 'roster-text', 1, 'complete', 1, $4,
             '{"headline":"quarterly revenue"}'::jsonb)`,
    [extractionId, SOURCE_ID, versionId, CONTENT_HASH],
  );
}

async function seedChunk(
  pool: pg.Pool,
  chunkId = CHUNK_ID,
  extractionId = EXTRACTION_ID,
  versionId = VERSION_ID,
  content = 'quarterly revenue rose sharply',
): Promise<void> {
  await pool.query(
    `INSERT INTO brain.source_chunks
       (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
        byte_start, byte_end, line_start, line_end)
     VALUES ($1, $2, $3, 0, $4, $5, 0, 30, 1, 1)`,
    [chunkId, extractionId, versionId, content, digestOf(content)],
  );
}

function vectorLiteral(dimensions: number, seed: number): string {
  return `[${Array.from({ length: dimensions }, (_unused, index) => (index + seed) / 100).join(',')}]`;
}

test('012 extraction schema enforces citation, immutability, and runtime denial', options, async (t) => {
  const provisioned = await provision();
  const { pool } = provisioned;
  try {
    await seedLifecycle(pool);

    await t.test('extractions cite exactly one immutable source version', async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_extractions
             (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
              status, chunk_count, text_sha256)
           VALUES ($1, $2, $3, 'roster-text', 1, 'complete', 0, $4)`,
          [EXTRACTION_ID, SOURCE_ID, `sha256:${'9'.repeat(64)}`, CONTENT_HASH],
        ),
        /source_extractions_source_id_source_version_id_fkey|violates foreign key/u,
      );
      await seedExtraction(pool);
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_extractions
             (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
              status, chunk_count, text_sha256)
           VALUES ($1, $2, $3, 'roster-text', 1, 'complete', 0, $4)`,
          [`sha256:${'7'.repeat(64)}`, SOURCE_ID, VERSION_ID, CONTENT_HASH],
        ),
        /duplicate key value/u,
      );
    });

    await t.test('the status shape and refusal reasons are closed', async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_extractions
             (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
              status, unsupported_reason, chunk_count, text_sha256)
           VALUES ($1, $2, $3, 'roster-text', 2, 'unsupported', 'not-a-reason', 0, NULL)`,
          [`sha256:${'8'.repeat(64)}`, SOURCE_ID, VERSION_ID],
        ),
        /unsupported_reason_check/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_extractions
             (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
              status, unsupported_reason, chunk_count, text_sha256)
           VALUES ($1, $2, $3, 'roster-text', 2, 'unsupported', 'binary', 1, NULL)`,
          [`sha256:${'8'.repeat(64)}`, SOURCE_ID, VERSION_ID],
        ),
        /source_extractions_status_shape/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_extractions
             (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
              status, chunk_count, text_sha256)
           VALUES ($1, $2, $3, 'roster-text', 2, 'complete', 0, NULL)`,
          [`sha256:${'8'.repeat(64)}`, SOURCE_ID, VERSION_ID],
        ),
        /source_extractions_status_shape/u,
      );
    });

    await t.test('chunks carry byte-exact locators bound to their extraction', async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_chunks
             (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
              byte_start, byte_end, line_start, line_end)
           VALUES ($1, $2, $3, 0, 'body', $4, 10, 10, 1, 1)`,
          [CHUNK_ID, EXTRACTION_ID, VERSION_ID, digestOf('body')],
        ),
        /relation "source_chunks" violates check constraint/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_chunks
             (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
              byte_start, byte_end, line_start, line_end)
           VALUES ($1, $2, $3, 0, 'body', $4, 0, 4, 1, 1)`,
          [CHUNK_ID, EXTRACTION_ID, SECOND_VERSION_ID, digestOf('body')],
        ),
        /violates foreign key/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.source_chunks
             (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
              byte_start, byte_end, line_start, line_end)
           VALUES ($1, $2, $3, 0, '', $4, 0, 4, 1, 1)`,
          [CHUNK_ID, EXTRACTION_ID, VERSION_ID, digestOf('')],
        ),
        /source_chunks_content_check/u,
      );
      await seedChunk(pool);
      const stored = await pool.query<{ tsv: string }>(
        `SELECT tsv::text AS tsv FROM brain.source_chunks WHERE chunk_id = $1`,
        [CHUNK_ID],
      );
      assert.match(stored.rows[0]!.tsv, /revenu/u);
    });

    await t.test('lexical and structured indexes answer without any embedding state', async () => {
      const lexical = await pool.query<{ chunk_id: string }>(
        `SELECT chunk_id FROM brain.source_chunks WHERE tsv @@ plainto_tsquery('english', 'revenue')`,
      );
      assert.deepEqual(lexical.rows.map((row) => row.chunk_id), [CHUNK_ID]);
      const structured = await pool.query<{ extraction_id: string }>(
        `SELECT extraction_id FROM brain.source_extractions
          WHERE structured @> '{"headline":"quarterly revenue"}'::jsonb`,
      );
      assert.deepEqual(structured.rows.map((row) => row.extraction_id), [EXTRACTION_ID]);
      const embeddings = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.chunk_embeddings`,
      );
      assert.equal(embeddings.rows[0]!.count, '0');
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'brain' AND tablename = 'source_extractions'`,
      );
      assert.ok(indexes.rows.some((row) => /USING gin \(structured jsonb_path_ops\)/u.test(row.indexdef)
        && /WHERE \(structured IS NOT NULL\)/u.test(row.indexdef)));
    });

    await t.test('no ANN index exists on chunk embeddings after 012', async () => {
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'brain' AND tablename = 'chunk_embeddings'`,
      );
      assert.equal(indexes.rows.some((row) => /USING (hnsw|ivfflat)/iu.test(row.indexdef)), false);
      const anyAnn = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_index index_row
           JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
           JOIN pg_am access ON access.oid = index_class.relam
           JOIN pg_class table_class ON table_class.oid = index_row.indrelid
           JOIN pg_namespace namespace_row ON namespace_row.oid = table_class.relnamespace
          WHERE access.amname IN ('hnsw', 'ivfflat')
            AND namespace_row.nspname = 'brain'
            AND table_class.relname IN
              ('source_extractions', 'source_chunks', 'embedding_indexes', 'chunk_embeddings')`,
      );
      assert.equal(anyAnn.rows[0]!.count, '0');
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'brain' AND table_name = 'embedding_indexes'`,
      );
      assert.equal(columns.rows.some((row) => row.column_name === 'ann_index_name'), false);
      const embeddingType = await pool.query<{ atttypmod: number }>(
        `SELECT atttypmod FROM pg_attribute
          WHERE attrelid = 'brain.chunk_embeddings'::regclass AND attname = 'embedding'`,
      );
      assert.equal(embeddingType.rows[0]!.atttypmod, -1, 'the vector column stays dimensionless');
    });

    await t.test('the embedding guard rejects unknown specs, dimension drift, and secret content', async () => {
      await pool.query(
        `INSERT INTO brain.embedding_indexes (embedding_spec_id, provider, model, dimensions, spec_version)
         VALUES ($1, 'fixture-provider', 'fixture-model', 4, 1)`,
        [SPEC_ID],
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
           VALUES ($1, $2, 4, $3::vector)`,
          [CHUNK_ID, `sha256:${'6'.repeat(64)}`, vectorLiteral(4, 1)],
        ),
        /names an unregistered embedding spec/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
           VALUES ($1, $2, 4, $3::vector)`,
          [`sha256:${'6'.repeat(64)}`, SPEC_ID, vectorLiteral(4, 1)],
        ),
        /names an unknown source chunk/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
           VALUES ($1, $2, 3, $3::vector)`,
          [CHUNK_ID, SPEC_ID, vectorLiteral(3, 1)],
        ),
        /dimensions disagree with the embedding spec/u,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
           VALUES ($1, $2, 4, $3::vector)`,
          [CHUNK_ID, SPEC_ID, vectorLiteral(5, 1)],
        ),
        /chunk_embeddings_dims_match/u,
      );

      await seedExtraction(pool, SECOND_VERSION_ID, SECOND_EXTRACTION_ID);
      await seedChunk(pool, SECOND_CHUNK_ID, SECOND_EXTRACTION_ID, SECOND_VERSION_ID, 'secret payroll ledger');
      await assert.rejects(
        pool.query(
          `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
           VALUES ($1, $2, 4, $3::vector)`,
          [SECOND_CHUNK_ID, SPEC_ID, vectorLiteral(4, 2)],
        ),
        /secret-class content is never embedded/u,
      );
      await pool.query(
        `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
         VALUES ($1, $2, 4, $3::vector)`,
        [CHUNK_ID, SPEC_ID, vectorLiteral(4, 1)],
      );
    });

    await t.test('every 012 table is immutable and registered as runtime protected', async () => {
      // A TRUNCATE on an FK-referenced table is refused by Postgres before any
      // trigger fires, so prove installation from the catalog rather than
      // inferring it from the refusal.
      const installed = await pool.query<{ relname: string; tgname: string }>(
        `SELECT relation.relname, trigger_row.tgname
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
          WHERE NOT trigger_row.tgisinternal
            AND ((namespace_row.nspname = 'brain'
                  AND relation.relname IN ('source_extractions', 'source_chunks',
                                           'embedding_indexes', 'chunk_embeddings'))
                 OR (namespace_row.nspname = 'brain_meta' AND relation.relname = 'active_extractors'))
          ORDER BY relation.relname, trigger_row.tgname`,
      );
      assert.deepEqual(installed.rows.map((row) => `${row.relname}.${row.tgname}`), [
        'active_extractors.active_extractors_guard_update',
        'active_extractors.active_extractors_no_delete',
        'active_extractors.active_extractors_no_truncate',
        'chunk_embeddings.chunk_embeddings_guard_insert',
        'chunk_embeddings.chunk_embeddings_immutable',
        'chunk_embeddings.chunk_embeddings_no_truncate',
        'embedding_indexes.embedding_indexes_immutable',
        'embedding_indexes.embedding_indexes_no_truncate',
        'source_chunks.source_chunks_guard_insert',
        'source_chunks.source_chunks_immutable',
        'source_chunks.source_chunks_no_truncate',
        'source_extractions.source_extractions_immutable',
        'source_extractions.source_extractions_no_truncate',
      ]);
      const enabled = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
          WHERE NOT trigger_row.tgisinternal
            AND trigger_row.tgenabled = 'D'
            AND namespace_row.nspname IN ('brain', 'brain_meta')`,
      );
      assert.equal(enabled.rows[0]!.count, '0', 'no 012 guard ships disabled');

      for (const table of ['source_extractions', 'source_chunks', 'embedding_indexes', 'chunk_embeddings']) {
        const populated = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM brain.${table}`);
        assert.notEqual(populated.rows[0]!.count, '0', `${table} must hold a row before the mutation attempts`);
        await assert.rejects(
          pool.query(`UPDATE brain.${table} SET created_at = now()`),
          new RegExp(`brain\\.${table} is immutable`, 'u'),
        );
        await assert.rejects(
          pool.query(`DELETE FROM brain.${table}`),
          new RegExp(`brain\\.${table} is immutable`, 'u'),
        );
        await assert.rejects(
          pool.query(`TRUNCATE brain.${table}`),
          new RegExp(`brain\\.${table} is immutable|cannot truncate a table referenced in a foreign key constraint`, 'u'),
        );
      }
      const registered = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM brain_meta.runtime_protected_tables
          WHERE table_name IN ('source_extractions', 'source_chunks', 'embedding_indexes', 'chunk_embeddings')
          ORDER BY table_name`,
      );
      assert.deepEqual(registered.rows.map((row) => row.table_name), [
        'chunk_embeddings',
        'embedding_indexes',
        'source_chunks',
        'source_extractions',
      ]);
    });

    await t.test('the active-extractor registry only accepts a monotone version bump', async () => {
      await assert.rejects(
        pool.query(`DELETE FROM brain_meta.active_extractors WHERE extractor_name = 'roster-text'`),
        /brain_meta\.active_extractors is immutable/u,
      );
      await assert.rejects(
        pool.query(`TRUNCATE brain_meta.active_extractors`),
        /brain_meta\.active_extractors is immutable/u,
      );
      await assert.rejects(
        pool.query(`UPDATE brain_meta.active_extractors SET active_version = 1 WHERE extractor_name = 'roster-text'`),
        /active extractor version may only increase/u,
      );
      await assert.rejects(
        pool.query(`UPDATE brain_meta.active_extractors SET extractor_name = 'roster-other' WHERE extractor_name = 'roster-text'`),
        /active extractor identity is immutable/u,
      );
    });

    await t.test('the current view selects the active version first, then completeness', async () => {
      const current = await pool.query<{ chunk_id: string; privacy_class: string; source_id: string }>(
        `SELECT chunk_id, privacy_class, source_id FROM brain.current_source_chunks ORDER BY chunk_id`,
      );
      assert.deepEqual(current.rows, [
        { chunk_id: CHUNK_ID, privacy_class: 'internal', source_id: SOURCE_ID },
      ]);

      await pool.query(
        `UPDATE brain_meta.active_extractors SET active_version = 2 WHERE extractor_name = 'roster-text'`,
      );
      const afterBump = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks`,
      );
      assert.equal(afterBump.rows[0]!.count, '0', 'a missing active-version extraction is an explicit gap');

      const unsupportedId = `sha256:${'f'.repeat(64)}`;
      await pool.query(
        `INSERT INTO brain.source_extractions
           (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
            status, unsupported_reason, chunk_count)
         VALUES ($1, $2, $3, 'roster-text', 2, 'unsupported', 'media-type', 0)`,
        [unsupportedId, SOURCE_ID, VERSION_ID],
      );
      const afterUnsupported = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM brain.current_source_chunks`,
      );
      assert.equal(afterUnsupported.rows[0]!.count, '0', 'an unsupported active version exposes nothing');
    });

    await t.test('the runtime role reads the view but can never write the 012 tables', async () => {
      const runtime = await runtimeClient(
        provisioned.fresh.url,
        provisioned.runtimePassword,
        provisioned.runtimeRole,
      );
      try {
        const readable = await runtime.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM brain.current_source_chunks`,
        );
        assert.equal(readable.rows[0]!.count, '0');
        await runtime.query(`SELECT count(*) FROM brain.source_chunks`);
        await runtime.query(`SELECT count(*) FROM brain.chunk_embeddings`);
        for (const [table, statement] of [
          ['source_extractions', `INSERT INTO brain.source_extractions (extraction_id, source_id, source_version_id, extractor_name, extractor_version, status, chunk_count, text_sha256) VALUES ('${`sha256:${'0'.repeat(64)}`}', '${SOURCE_ID}', '${VERSION_ID}', 'roster-text', 9, 'complete', 0, '${CONTENT_HASH}')`],
          ['source_chunks', `INSERT INTO brain.source_chunks (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256, byte_start, byte_end, line_start, line_end) VALUES ('${`sha256:${'0'.repeat(64)}`}', '${EXTRACTION_ID}', '${VERSION_ID}', 9, 'x', '${CONTENT_HASH}', 0, 1, 1, 1)`],
          ['embedding_indexes', `INSERT INTO brain.embedding_indexes (embedding_spec_id, provider, model, dimensions, spec_version) VALUES ('${`sha256:${'0'.repeat(64)}`}', 'p', 'm', 4, 1)`],
          ['chunk_embeddings', `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding) VALUES ('${CHUNK_ID}', '${SPEC_ID}', 4, '${vectorLiteral(4, 3)}'::vector)`],
        ] as const) {
          await assert.rejects(runtime.query(statement), /permission denied/u, `${table} must deny runtime INSERT`);
        }
        await assert.rejects(
          runtime.query(`SELECT count(*) FROM brain_meta.active_extractors`),
          /permission denied/u,
        );
      } finally {
        await runtime.end();
      }
    });
  } finally {
    await provisioned.teardown();
  }
});

test('an 011 brain upgrades through 012 exactly once and keeps runtime denial', options, async () => {
  const staged = stagedMigrations(11);
  let provisioned: Provisioned | undefined;
  try {
    provisioned = await provision(staged.dir);
    const { pool } = provisioned;
    const before = await pool.query<{ relation: string | null }>(
      `SELECT to_regclass('brain.source_chunks')::text AS relation`,
    );
    assert.equal(before.rows[0]!.relation, null);
    await seedLifecycle(pool);

    const authority = deriveBrainWorkspaceAuthority(WORKSPACE_ID, config());
    const upgraded = await bootstrapBrainWorkspaceAuthority(pool, authority, {
      runtimeRole: provisioned.fresh.role,
      runtimePassword: provisioned.runtimePassword,
    });
    assert.equal(upgraded.outcome, 'upgraded');
    // Membership, not exact equality: later tickets add their own migrations
    // above 011, and this test owns only the 012 leg of the upgrade.
    assert.ok(
      upgraded.migrations.applied.includes('012_extraction_indexing.sql'),
      `expected 012 in the upgrade set, got ${upgraded.migrations.applied.join(', ')}`,
    );

    const replay = await bootstrapBrainWorkspaceAuthority(pool, authority, {
      runtimeRole: provisioned.fresh.role,
      runtimePassword: provisioned.runtimePassword,
    });
    assert.equal(replay.outcome, 'current');
    assert.deepEqual(replay.migrations.applied, []);

    const backfill = await pool.query<{ source_version_id: string }>(
      `SELECT version_row.source_version_id
         FROM brain.source_versions version_row
         JOIN brain.logical_sources source_row
           ON source_row.source_id = version_row.source_id
          AND source_row.current_version_id = version_row.source_version_id
          AND source_row.active_tombstone_id IS NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM brain.source_extractions extraction_row
            JOIN brain_meta.active_extractors active_row
              ON active_row.extractor_name = extraction_row.extractor_name
             AND active_row.active_version = extraction_row.extractor_version
           WHERE extraction_row.source_version_id = version_row.source_version_id)
        ORDER BY version_row.source_version_id`,
    );
    assert.deepEqual(backfill.rows.map((row) => row.source_version_id), [VERSION_ID]);

    const runtime = await runtimeClient(
      provisioned.fresh.url,
      provisioned.runtimePassword,
      provisioned.runtimeRole,
    );
    try {
      await runtime.query(`SELECT count(*) FROM brain.current_source_chunks`);
      await assert.rejects(
        runtime.query(
          `INSERT INTO brain.source_extractions
             (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
              status, chunk_count, text_sha256)
           VALUES ($1, $2, $3, 'roster-text', 1, 'complete', 0, $4)`,
          [EXTRACTION_ID, SOURCE_ID, VERSION_ID, CONTENT_HASH],
        ),
        /permission denied/u,
      );
    } finally {
      await runtime.end();
    }
  } finally {
    staged.cleanup();
    if (provisioned !== undefined) await provisioned.teardown();
  }
});
