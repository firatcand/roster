import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../src/lib/persistence/migrate-core.ts';
import { ROSTER_OPS_MIGRATION_TARGET, opsSchemaDir, runOpsMigrations } from '../src/lib/persistence/postgres/migrate.ts';

// #323 stage 1: the roster_ops 002 run-ledger migration + deterministic
// backfill. Env-gated on a throwaway Postgres 16 superuser URL
// (locally postgresql://postgres@localhost:55433/postgres). Uses core-only
// crypto (sha256(bytea) / gen_random_uuid) — no pgcrypto.

const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const opts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };

// A fixed workspace + a planted secret that must never reach a projection view.
const WS = '11111111-1111-4111-8111-111111111111';
const SECRET = 'sk-live-PLANTED-SECRET-TOKEN';
const OPS_DIR = opsSchemaDir('roster_ops');

async function makeDb(): Promise<{ url: string; pool: pg.Pool; close: () => Promise<void> }> {
  const db = `ledger_test_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const url = new URL(ADMIN);
  url.pathname = '/' + db;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return {
    url: url.toString(),
    pool,
    close: async () => {
      await pool.end().catch(() => {});
      const r = new pg.Client({ connectionString: ADMIN });
      await r.connect();
      try {
        await r.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [db],
        );
        await r.query(`DROP DATABASE IF EXISTS ${db}`);
      } finally {
        await r.end();
      }
    },
  };
}

// A dir holding ONLY 001 so we can materialize the v1 schema, seed v1 rows, and
// then apply 002 as a genuine 1->2 upgrade (001's recorded sha256 matches the
// real file, so runMigrations skips it and applies 002).
function v1OnlyDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'roster-ops-v1-'));
  copyFileSync(join(OPS_DIR, '001_init.sql'), join(dir, '001_init.sql'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function views(pool: pg.Pool): Promise<Set<string>> {
  const res = await pool.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = 'roster_ops'`,
  );
  return new Set((res.rows as { table_name: string }[]).map((r) => r.table_name));
}

async function columnExists(pool: pg.Pool, table: string, column: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'roster_ops' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------- fresh apply + rerun no-op ----------------

test('pg-run-ledger: fresh apply creates the v2 objects and rerun is a no-op', opts, async () => {
  const h = await makeDb();
  try {
    const first = await runOpsMigrations(h.pool);
    assert.deepEqual(first.roster_ops.applied, ['001_init.sql', '002_run_ledger.sql']);

    const second = await runOpsMigrations(h.pool);
    assert.deepEqual(second.roster_ops.applied, []);
    assert.deepEqual(second.roster_ops.skipped, ['001_init.sql', '002_run_ledger.sql']);

    // the v2 surface exists
    const v = await views(h.pool);
    assert.ok(v.has('run_index'), 'run_index view');
    assert.ok(v.has('artifact_index'), 'artifact_index view');
    const decl = await h.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='roster_ops' AND table_name='artifact_declarations'`,
    );
    assert.equal(decl.rowCount, 1, 'artifact_declarations table');
    assert.ok(await columnExists(h.pool, 'run_events', 'source'), 'run_events.source');
    assert.ok(await columnExists(h.pool, 'run_events', 'sanitized_report'), 'run_events.sanitized_report');
    assert.ok(await columnExists(h.pool, 'artifacts', 'object_version_id'), 'artifacts.object_version_id');

    const meta = (await h.pool.query(`SELECT * FROM roster_ops.meta WHERE singleton`)).rows[0] as Record<string, unknown>;
    assert.equal(meta.component_version, 2);
    assert.equal(meta.objects_component_version, 2);
    assert.deepEqual(meta.capabilities, ['runs', 'artifacts', 'outbox', 'checkpoint', 'run-ledger']);
    assert.deepEqual(meta.objects_capabilities, ['content-addressed', 'create-only', 'version-id', 'list-prefix']);

    // fail-closed: the new source column defaults to 'unverified'
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
       VALUES ('freshev', $1::uuid, 'run-a', 'start', 'run-start', '{}'::jsonb, 1)`,
      [WS],
    );
    const src = await h.pool.query(`SELECT source FROM roster_ops.run_events WHERE id = 'freshev'`);
    assert.equal((src.rows[0] as { source: string }).source, 'unverified');
  } finally {
    await h.close();
  }
});

// ---------------- finding 10: SQL scrubber covers every secret class ----------

test('pg-run-ledger (finding 10): the BEFORE INSERT scrub redacts every secret class in sanitized projections', opts, async () => {
  const h = await makeDb();
  try {
    await runOpsMigrations(h.pool);
    // Each planted secret is inserted via a RAW runtime-shaped INSERT directly
    // into sanitized_report / sanitized_text — the BEFORE INSERT trigger must
    // scrub it before it lands, so the safe views never expose it.
    const classes: Array<{ label: string; text: string; sentinel: RegExp }> = [
      { label: 'assignment', text: 'DATABASE_PASSWORD=hunter2SuperSecretValue', sentinel: /hunter2SuperSecretValue/ },
      { label: 'auth-header', text: 'Authorization: Bearer abcDEF123456ghiJKL789xyz', sentinel: /abcDEF123456ghiJKL789xyz/ },
      { label: 'url-creds', text: 'db postgres://user:s3cretPassw0rd@h.example.com/x', sentinel: /s3cretPassw0rd/ },
      { label: 'pem', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIabcDEF\nGHIjkl\n-----END RSA PRIVATE KEY-----', sentinel: /MIIabcDEF/ },
      { label: 'github', text: 'token ghp_abcdefghijklmnopqrstuvwxyz012345', sentinel: /ghp_abcdefghijklmnopqrstuvwxyz012345/ },
      { label: 'slack', text: 'slack xoxb-1234567890-abcdefghij24', sentinel: /xoxb-1234567890-abcdefghij24/ },
      { label: 'jwt', text: 'jwt eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM', sentinel: /eyJhbGciOi\.eyJzdWIiOi\.SflKxwRJSM/ },
      { label: 'aws', text: 'key AKIAIOSFODNN7EXAMPLE here', sentinel: /AKIAIOSFODNN7EXAMPLE/ },
      { label: 'hex', text: 'digest 0123456789abcdef0123456789abcdef', sentinel: /0123456789abcdef0123456789abcdef/ },
    ];
    let i = 0;
    for (const c of classes) {
      i += 1;
      const runId = `scrub-${i}`;
      // run_events.sanitized_report via a raw INSERT (runtime holds column INSERT).
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, sanitized_report, created_at)
         VALUES ($1, $2::uuid, $3, 'report', 'report', '{}'::jsonb, 'agent', $4, $5)`,
        [`ev-${i}`, WS, runId, c.text, i],
      );
      // artifact_declarations.sanitized_text via a raw INSERT.
      await h.pool.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, version_state, sanitized_text, created_at)
         VALUES ($1, $2::uuid, $3, 'a', 'produced', 'internal', $4, '{}'::jsonb, 'unverified', $5, $6)`,
        [`decl-${i}`, WS, runId, String(i).padStart(64, '0'), c.text, i],
      );
    }
    const runIdx = JSON.stringify((await h.pool.query(`SELECT sanitized_report FROM roster_ops.run_index`)).rows);
    const artIdx = JSON.stringify((await h.pool.query(`SELECT sanitized_text FROM roster_ops.artifact_index`)).rows);
    for (const c of classes) {
      assert.ok(!c.sentinel.test(runIdx), `run_index leaked the ${c.label} secret`);
      assert.ok(!c.sentinel.test(artIdx), `artifact_index leaked the ${c.label} secret`);
    }
    assert.ok(runIdx.includes('[REDACTED]'), 'the scrub produced redaction placeholders');
  } finally {
    await h.close();
  }
});

// ------- finding 2: SQL scrub handles quoted JSON keys + escaped-quote values --

test('pg-run-ledger (finding 2): the BEFORE INSERT scrub redacts quoted-key + escaped-quote credential assignments', opts, async () => {
  const h = await makeDb();
  try {
    await runOpsMigrations(h.pool);
    const cases: Array<{ label: string; text: string; leak: RegExp }> = [
      // The exact JSON shape appendEvent({data:{password:'…'}}) serializes to —
      // quoted KEY, which the old unquoted-key rule could not match.
      { label: 'json-quoted-key', text: '{"password":"correct horse battery staple"}', leak: /correct horse battery staple/ },
      { label: 'json-token-key', text: '{"api_token":"tok-LEAK-VALUE-123"}', leak: /tok-LEAK-VALUE-123/ },
      // Escaped double-quote inside the value: the old "[^"\n]*" stopped at the
      // first \" and leaked the tail.
      { label: 'escaped-quote', text: 'password="correct horse \\"battery\\" staple"', leak: /battery|staple/ },
    ];
    let i = 0;
    for (const c of cases) {
      i += 1;
      await h.pool.query(
        `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, sanitized_report, created_at)
         VALUES ($1, $2::uuid, $3, 'report', 'report', '{}'::jsonb, 'agent', $4, $5)`,
        [`f2-ev-${i}`, WS, `f2-${i}`, c.text, i],
      );
      await h.pool.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, version_state, sanitized_text, created_at)
         VALUES ($1, $2::uuid, $3, 'a', 'produced', 'internal', $4, '{}'::jsonb, 'unverified', $5, $6)`,
        [`f2-decl-${i}`, WS, `f2-${i}`, String(i).padStart(64, '0'), c.text, i],
      );
    }
    const runIdx = JSON.stringify((await h.pool.query(`SELECT sanitized_report FROM roster_ops.run_index`)).rows);
    const artIdx = JSON.stringify((await h.pool.query(`SELECT sanitized_text FROM roster_ops.artifact_index`)).rows);
    for (const c of cases) {
      assert.ok(!c.leak.test(runIdx), `run_index leaked ${c.label}: ${runIdx}`);
      assert.ok(!c.leak.test(artIdx), `artifact_index leaked ${c.label}: ${artIdx}`);
    }
    assert.ok(runIdx.includes('[REDACTED]'), 'redaction placeholders present');
  } finally {
    await h.close();
  }
});

// ------- finding 6: the SQL scrub caps sanitized text on a UTF-8 BYTE boundary --

test('pg-run-ledger (finding 6): the scrub caps sanitized_* at ≤16384 BYTES (multibyte safe)', opts, async () => {
  const h = await makeDb();
  try {
    await runOpsMigrations(h.pool);
    // 16384 CJK chars = 16384 code units but ~49 KiB UTF-8. The DB cap must land
    // ≤16384 bytes without splitting a multibyte char (convert_from would error).
    const cjk = '好'.repeat(16_384);
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, sanitized_report, created_at)
       VALUES ('f6-ev', $1::uuid, 'f6', 'report', 'report', '{}'::jsonb, 'agent', $2, 1)`,
      [WS, cjk],
    );
    const row = (await h.pool.query(
      `SELECT octet_length(sanitized_report) AS bytes, sanitized_report AS txt FROM roster_ops.run_events WHERE id = 'f6-ev'`,
    )).rows[0] as { bytes: number; txt: string };
    assert.ok(row.bytes <= 16_384, `capped to ≤16384 bytes, got ${row.bytes}`);
    assert.ok(row.txt.endsWith('…[truncated]'), 'a truncation marker is appended');
  } finally {
    await h.close();
  }
});

// ---------------- finding 12: artifact_declaration DB invariants --------------

test('pg-run-ledger (finding 12): the DB rejects malformed artifact declarations', opts, async () => {
  const h = await makeDb();
  try {
    await runOpsMigrations(h.pool);
    const digest = 'c'.repeat(64);
    const insert = (cols: string, vals: string, params: unknown[]) =>
      h.pool.query(
        `INSERT INTO roster_ops.artifact_declarations
           (id, workspace_id, run_id, declaring_agent, role, kind, provenance, created_at${cols}) VALUES
           ($1, $2::uuid, 'r', 'a', 'produced', $3, '{}'::jsonb, 1${vals})`,
        params,
      );
    // an internal declaration with external columns set is rejected (coherence).
    await assert.rejects(
      insert(', digest, provider', ', $4, $5', ['d-ext', WS, 'internal', digest, 'github']),
      /violates check constraint/i,
      'internal declaration with a provider must be rejected',
    );
    await assert.rejects(
      insert(', digest, external_url', ', $4, $5', ['d-url', WS, 'internal', digest, 'https://x']),
      /violates check constraint/i,
      'internal declaration with an external_url must be rejected',
    );
    // version_state outside the enum is rejected.
    await assert.rejects(
      insert(', digest, version_state', ', $4, $5', ['d-vs', WS, 'internal', digest, 'garbage']),
      /violates check constraint/i,
      'a version_state outside verified/unverified must be rejected',
    );
    // an external declaration claiming verified=true is rejected.
    await assert.rejects(
      insert(', external_id, provider, verified', ', $4, $5, true', ['d-v', WS, 'external', 'ext-1', 'github']),
      /violates check constraint/i,
      'an external declaration cannot be verified=true',
    );
    // a well-formed internal declaration IS accepted.
    await insert(', digest, version_state', ", $4, 'unverified'", ['d-ok', WS, 'internal', digest]);
    const ok = await h.pool.query(`SELECT 1 FROM roster_ops.artifact_declarations WHERE id = 'd-ok'`);
    assert.equal(ok.rowCount, 1);
  } finally {
    await h.close();
  }
});

// ---------------- seeded 1->2 upgrade with backfill ----------------

test('pg-run-ledger: seeded 1->2 upgrade backfills declarations + source, and a planted-secret legacy runId never reaches a view', opts, async () => {
  const h = await makeDb();
  const v1 = v1OnlyDir();
  try {
    // materialize v1 only
    const applied = await runMigrations(h.pool, v1.dir, ROSTER_OPS_MIGRATION_TARGET);
    assert.deepEqual(applied.applied, ['001_init.sql']);
    assert.equal(await columnExists(h.pool, 'run_events', 'source'), false, 'v1 has no source column yet');

    const digestUnsafe = 'a'.repeat(64);
    const digestSafe = 'b'.repeat(64);
    // v1 artifact whose meta.runId carries a planted secret (unsafe charset)
    await h.pool.query(
      `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
       VALUES ('art-unsafe', $1::uuid, $2, 3, $3::jsonb, 100)`,
      [WS, digestUnsafe, JSON.stringify({ filename: 'x.txt', contentType: 'text/plain', runId: `${SECRET} with spaces` })],
    );
    // v1 artifact with a clean runId that must pass through unchanged
    await h.pool.query(
      `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, created_at)
       VALUES ('art-safe', $1::uuid, $2, 3, $3::jsonb, 200)`,
      [WS, digestSafe, JSON.stringify({ filename: 'y.md', contentType: 'text/markdown', runId: 'safe-run-1' })],
    );
    // v1 run_events row whose run_id carries a planted secret
    await h.pool.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
       VALUES ('ev-unsafe', $1::uuid, $2, 'start', 'run-start', '{}'::jsonb, 300)`,
      [WS, `evil ${SECRET}`],
    );

    // now the 1->2 upgrade (001 skipped, 002 applied)
    const upgrade = await runMigrations(h.pool, OPS_DIR, ROSTER_OPS_MIGRATION_TARGET);
    assert.deepEqual(upgrade.applied, ['002_run_ledger.sql']);
    assert.deepEqual(upgrade.skipped, ['001_init.sql']);

    // one internal declaration per legacy blob
    const decls = (
      await h.pool.query(
        `SELECT id, run_id, declaring_agent, role, kind, digest, media_type, version_state, verified,
                provenance->>'origin' AS origin
           FROM roster_ops.artifact_declarations ORDER BY digest`,
      )
    ).rows as Record<string, unknown>[];
    assert.equal(decls.length, 2);
    const [unsafe, safe] = decls; // ordered by digest: 'aaa..' then 'bbb..'
    for (const d of decls) {
      assert.equal(d.declaring_agent, 'legacy');
      assert.equal(d.role, 'produced');
      assert.equal(d.kind, 'internal');
      assert.equal(d.version_state, 'unverified');
      assert.equal(d.verified, false);
      assert.equal(d.origin, 'legacy-backfill');
    }
    assert.equal(unsafe.digest, digestUnsafe);
    assert.equal(safe.digest, digestSafe);
    // the safe legacy runId passes through; the unsafe one becomes a sentinel
    assert.equal(safe.run_id, 'safe-run-1');
    assert.match(unsafe.run_id as string, /^legacy-[0-9a-f]{12}$/);
    assert.notEqual(unsafe.run_id, `${SECRET} with spaces`);
    // media type preserved
    assert.equal(unsafe.media_type, 'text/plain');
    assert.equal(safe.media_type, 'text/markdown');
    // declaration id is deterministic sha256hex
    assert.match(unsafe.id as string, /^[0-9a-f]{64}$/);

    // the raw secret is preserved ONLY in the non-projected provenance column
    const rawMeta = await h.pool.query(
      `SELECT provenance->'legacy_meta'->>'runId' AS raw FROM roster_ops.artifact_declarations WHERE digest = $1`,
      [digestUnsafe],
    );
    assert.equal((rawMeta.rows[0] as { raw: string }).raw, `${SECRET} with spaces`);

    // source backfilled to 'unverified' on the legacy run_events row
    const src = await h.pool.query(`SELECT source FROM roster_ops.run_events WHERE id = 'ev-unsafe'`);
    assert.equal((src.rows[0] as { source: string }).source, 'unverified');

    // THE SECRET NEVER REACHES A PROJECTION VIEW
    const runIdx = (await h.pool.query(`SELECT run_id, agent, status FROM roster_ops.run_index`)).rows as Record<string, unknown>[];
    const artIdx = (await h.pool.query(`SELECT run_id, media_type, external_url_host FROM roster_ops.artifact_index`)).rows as Record<string, unknown>[];
    const runBlob = JSON.stringify(runIdx);
    const artBlob = JSON.stringify(artIdx);
    assert.ok(!runBlob.includes(SECRET), `run_index leaked the secret: ${runBlob}`);
    assert.ok(!artBlob.includes(SECRET), `artifact_index leaked the secret: ${artBlob}`);
    // and the normalized identifiers ARE present as sentinels
    assert.ok(runIdx.some((r) => /^legacy-[0-9a-f]{12}$/.test(r.run_id as string)));
    assert.equal((runIdx[0] as { status: string }).status, 'unknown', 'unverified lifecycle => status unknown');
    assert.ok(artIdx.some((r) => r.run_id === 'safe-run-1'));
    assert.ok(artIdx.some((r) => /^legacy-[0-9a-f]{12}$/.test(r.run_id as string)));
  } finally {
    v1.cleanup();
    await h.close();
  }
});
