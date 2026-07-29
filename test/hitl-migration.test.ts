import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { canonicalJson } from '../src/lib/persistence/contracts.ts';
import { runMigrations } from '../src/lib/persistence/migrate-core.ts';
import { HITL_MIGRATION_TARGET, opsSchemaDir } from '../src/lib/persistence/postgres/migrate.ts';
import {
  EDITORIAL_ACTIONS,
  classifyAction,
  packetHashOf,
  requestIdOf,
  requestKeyOf,
  targetHashOf,
} from '../src/lib/persistence/hitl-machine.ts';

// #319 stage 1: the hitl 002 state-machine migration — fresh apply, the seeded
// v1->v2 upgrade (generation partitioning, legacy expiry, hash exemption), the
// preflight refusals, the Node<->SQL byte-equality vectors, and the DB-enforced
// decision machine against RAW runtime INSERTs. Env-gated on a throwaway
// Postgres 16 superuser URL (locally postgresql://postgres@localhost:55433/postgres).

const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const opts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };

const WS = '11111111-1111-4111-8111-111111111111';
const HITL_DIR = opsSchemaDir('hitl');
const DAY_MS = 86_400_000;
// A v1/v2 payload whose functionName is what the derived request_key is built from.
const MARKETING_PAYLOAD = JSON.stringify({ functionName: 'marketing', body: 'b' });
// ...and the digest that COVERS that body: canonicalization_version 1 asserts
// exactly this relation, and the fill trigger verifies it (round-3 finding 1).
const MARKETING_CONTENT_HASH = sha256Of('b');

async function makeDb(): Promise<{ pool: pg.Pool; close: () => Promise<void> }> {
  const db = `hitl_mig_${randomBytes(6).toString('hex')}`;
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

// A dir holding ONLY 001, so we can materialize the v1 schema, seed v1 rows, and
// then apply 002 as a genuine 1->2 upgrade (001's recorded sha256 matches the
// real file, so runMigrations skips it and applies 002).
function v1OnlyDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'roster-hitl-v1-'));
  copyFileSync(join(HITL_DIR, '001_init.sql'), join(dir, '001_init.sql'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type V1Request = {
  id: string;
  action: string;
  target: string;
  contentHash: string;
  functionName?: string;
  body?: string;
  expiresAt?: number | null;
  createdAt: number;
  // v1's UNIQUE is (workspace_id, id, version): ONE legacy id can carry several
  // versions, and decisions name the exact one through request_version.
  version?: number;
};

async function seedV1Request(pool: pg.Pool, r: V1Request): Promise<void> {
  const payload: Record<string, unknown> = { title: r.id };
  if (r.functionName !== undefined) payload.functionName = r.functionName;
  if (r.body !== undefined) payload.body = r.body;
  payload.expiresAt = r.expiresAt ?? null;
  await pool.query(
    `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
     VALUES ($1, $2::uuid, $8, $3, $4, $5, $6::jsonb, 'awaiting', $7)`,
    [r.id, WS, r.action, r.target, r.contentHash, JSON.stringify(payload), r.createdAt, r.version ?? 1],
  );
}

async function seedV1Decision(
  pool: pg.Pool,
  d: { id: string; requestId: string; status: string; createdAt: number; requestVersion?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO hitl.decisions (id, workspace_id, request_id, request_version, status, payload, created_at)
     VALUES ($1, $2::uuid, $3, $6, $4, '{}'::jsonb, $5)`,
    [d.id, WS, d.requestId, d.status, d.createdAt, d.requestVersion ?? 1],
  );
}

// The v2 INSERT shape the stage-2 store will use: every identity column
// supplied by the caller, nothing derived by the fill trigger.
//
// The row's CONTENT is the fixture's `body` and its content_hash is derived from
// it, because canonicalization_version 1 is the row asserting exactly that
// relation and the fill trigger now verifies it (round-3 finding 1). A fixture
// that wants the legacy shape passes an explicit mismatching `contentHash`
// together with `canonicalizationVersion: 0`.
async function insertV2Request(
  pool: pg.Pool | pg.PoolClient,
  r: {
    functionName: string;
    action: string;
    target: string;
    body?: string;
    contentHash?: string;
    generation?: number;
    version?: number;
    expiresAt: number | null;
    createdAt: number;
    canonicalizationVersion?: number;
    summary?: string | null;
    title?: string;
    supersedes?: { requestId: string; generation: number; version: number };
  },
): Promise<{ id: string; requestKey: string; packetHash: string }> {
  const requestKey = requestKeyOf(r);
  const id = requestIdOf(WS, requestKey);
  const actionKind = classifyAction(r.action);
  const canonicalizationVersion = r.canonicalizationVersion ?? 1;
  const title = r.title ?? '';
  const body = r.body ?? 'b';
  const contentHash = r.contentHash ?? sha256Of(body);
  const packetHash = packetHashOf({
    action: r.action,
    actionKind,
    target: r.target,
    contentHash,
    payloadRef: null,
    expiresAt: r.expiresAt,
    canonicalizationVersion,
    title,
    summary: r.summary ?? null,
  });
  await pool.query(
    `INSERT INTO hitl.requests
       (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
        request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at,
        summary, sanitized_summary, supersedes_request_id, supersedes_generation, supersedes_version)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'awaiting', $14, $15, $16, $16, $17, $18, $19)`,
    [
      id,
      WS,
      r.version ?? 1,
      r.generation ?? 1,
      r.action,
      actionKind,
      r.target,
      targetHashOf(r.target),
      packetHash,
      requestKey,
      canonicalizationVersion,
      contentHash,
      JSON.stringify({ functionName: r.functionName, title, body }),
      r.createdAt,
      r.expiresAt,
      r.summary ?? null,
      r.supersedes?.requestId ?? null,
      r.supersedes?.generation ?? null,
      r.supersedes?.version ?? null,
    ],
  );
  return { id, requestKey, packetHash };
}

async function insertDecision(
  q: pg.Pool | pg.PoolClient,
  d: {
    id: string;
    requestId: string;
    generation: number;
    version: number;
    status: string;
    createdAt: number;
    onConflict?: boolean;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO hitl.decisions
       (id, workspace_id, request_id, generation, request_version, status, payload, created_at)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, '{}'::jsonb, $7)
     ${d.onConflict ? 'ON CONFLICT (workspace_id, id) DO NOTHING' : ''}`,
    [d.id, WS, d.requestId, d.generation, d.version, d.status, d.createdAt],
  );
}

// ---------------- fresh apply + rerun ----------------

test('hitl-migration: fresh apply creates the v2 surface and rerun is a no-op', opts, async () => {
  const h = await makeDb();
  try {
    const first = await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    assert.deepEqual(first.applied, ['001_init.sql', '002_state_machine.sql']);

    const second = await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    assert.deepEqual(second.applied, [], 'the checksum ledger skips an already-applied migration');
    assert.deepEqual(second.skipped, ['001_init.sql', '002_state_machine.sql']);

    const views = new Set(
      (
        await h.pool.query(`SELECT table_name FROM information_schema.views WHERE table_schema = 'hitl'`)
      ).rows.map((r) => (r as { table_name: string }).table_name),
    );
    assert.ok(views.has('request_state'), 'request_state view');
    assert.ok(views.has('request_index'), 'request_index view');

    const cols = new Set(
      (
        await h.pool.query(
          `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'hitl'`,
        )
      ).rows.map((r) => (r as { c: string }).c),
    );
    for (const c of [
      'requests.request_key',
      'requests.generation',
      'requests.target_hash',
      'requests.packet_hash',
      'requests.canonicalization_version',
      'requests.action_kind',
      'requests.expires_at',
      'requests.origin_run_id',
      'requests.origin_task_id',
      'requests.requesting_agent',
      'requests.summary',
      'requests.warnings',
      'requests.side_effects',
      'requests.choices',
      'requests.payload_ref',
      'requests.supersedes_request_id',
      'requests.supersedes_generation',
      'requests.supersedes_version',
      'requests.sanitized_summary',
      'decisions.decided_at',
      'decisions.feedback',
      'decisions.generation',
      'decisions.terminal',
    ]) {
      assert.ok(cols.has(c), `${c} exists`);
    }

    // the v1 unique is gone, the generation-aware one is in place
    const uniques = (
      await h.pool.query(
        `SELECT conname, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname='hitl' AND t.relname='requests' AND c.contype='u'`,
      )
    ).rows.map((r) => (r as { def: string }).def);
    assert.ok(
      uniques.some((d) => /UNIQUE \(workspace_id, id, generation, "?version"?\)/.test(d)),
      `expected the generation-aware unique, got ${JSON.stringify(uniques)}`,
    );
    assert.ok(
      !uniques.some((d) => /UNIQUE \(workspace_id, id, "?version"?\)$/.test(d)),
      'the v1 UNIQUE (workspace_id, id, version) must be dropped',
    );

    const meta = (await h.pool.query(`SELECT component_version, capabilities FROM hitl.meta WHERE singleton`))
      .rows[0] as { component_version: number; capabilities: string[] };
    assert.equal(meta.component_version, 2);
    assert.deepEqual(meta.capabilities, ['requests', 'decisions', 'state-machine']);

    // the decision trigger is admin-owned and PLAIN (a SECURITY DEFINER
    // function would be an escape hatch the ops role invariant checker flags)
    const secdef = await h.pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='hitl' AND p.prosecdef`,
    );
    assert.equal(secdef.rowCount, 0, 'no SECURITY DEFINER functions in the hitl schema');
  } finally {
    await h.close();
  }
});

// ---------------- Node <-> SQL byte equality ----------------

test('hitl-migration: the SQL identity functions reproduce the Node digests byte for byte', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);

    const vectors = [
      { fn: 'marketing', action: 'publish-post', target: 'blog/launch.md' },
      // leading/trailing ASCII whitespace must normalize identically on both sides
      { fn: 'content', action: 'approve-draft', target: '  drafts/y.md \t\n\r\v\f' },
      { fn: 'ünïcodé', action: 'delete-artifact', target: '路径/文件.md' },
      { fn: '', action: '', target: '' },
      // separator-shaped payloads: the length prefix must keep framing injective
      { fn: 'a:b', action: 'x\ty', target: 'p\nq' },
      { fn: '12:a', action: '0:', target: '1:1' },
    ];

    for (const v of vectors) {
      const key = requestKeyOf({ functionName: v.fn, action: v.action, target: v.target });
      const row = (
        await h.pool.query(
          `SELECT hitl.request_key($1,$2,$3) AS key,
                  hitl.target_hash($3) AS target_hash,
                  hitl.request_id($4::uuid, hitl.request_key($1,$2,$3)) AS request_id,
                  hitl.classify_action($2) AS action_kind,
                  hitl.normalize_target($3) AS normalized`,
          [v.fn, v.action, v.target, WS],
        )
      ).rows[0] as Record<string, string>;
      assert.equal(row.key, key, `request_key for ${JSON.stringify(v)}`);
      assert.equal(row.target_hash, targetHashOf(v.target), `target_hash for ${JSON.stringify(v)}`);
      assert.equal(row.request_id, requestIdOf(WS, key), `request_id for ${JSON.stringify(v)}`);
      assert.equal(row.action_kind, classifyAction(v.action), `action_kind for ${JSON.stringify(v)}`);

      // packet_hash: the inline channel, with and without the optional fields.
      const bare = (
        await h.pool.query(
          `SELECT hitl.packet_hash_v1($1, hitl.classify_action($1), $2, 'inline', $3, $4::bigint, $5::int,
                                      '', NULL, NULL, NULL, NULL, NULL, NULL, NULL) AS h`,
          [v.action, v.target, 'a'.repeat(64), 1_700_000_000_000, 1],
        )
      ).rows[0] as { h: string };
      assert.equal(
        bare.h,
        packetHashOf({
          action: v.action,
          actionKind: classifyAction(v.action),
          target: v.target,
          contentHash: 'a'.repeat(64),
          payloadRef: null,
          expiresAt: 1_700_000_000_000,
          canonicalizationVersion: 1,
          title: '',
        }),
        `packet_hash (bare) for ${JSON.stringify(v)}`,
      );

      // ...and with EVERY optional field populated, including the presentation
      // + attribution fields the packet must cover (title / origin ids / agent).
      const rich = (
        await h.pool.query(
          `SELECT hitl.packet_hash_v1($1, hitl.classify_action($1), $2, 'inline', $3, NULL, $4::int,
                                      $5, $6, $7, $8, $9, $10, $11, $12) AS h`,
          [
            v.action,
            v.target,
            'b'.repeat(64),
            0,
            `title for ${v.action}`,
            'a summary',
            canonicalJson(['w']),
            canonicalJson([]),
            canonicalJson(['x', 'y']),
            'run-7',
            'task-9',
            'sdr',
          ],
        )
      ).rows[0] as { h: string };
      assert.equal(
        rich.h,
        packetHashOf({
          action: v.action,
          actionKind: classifyAction(v.action),
          target: v.target,
          contentHash: 'b'.repeat(64),
          payloadRef: null,
          expiresAt: null,
          canonicalizationVersion: 0,
          title: `title for ${v.action}`,
          summary: 'a summary',
          warnings: ['w'],
          sideEffects: [],
          choices: ['x', 'y'],
          originRunId: 'run-7',
          originTaskId: 'task-9',
          requestingAgent: 'sdr',
        }),
        `packet_hash (rich) for ${JSON.stringify(v)}`,
      );

      // Each newly-included field is load-bearing on the SQL side too: mutate
      // one, and the two implementations must BOTH move to the same new digest.
      for (const [label, sqlArgs, packet] of [
        ['title', [`other title`, 'a summary', canonicalJson(['w']), canonicalJson([]), canonicalJson(['x', 'y']), 'run-7', 'task-9', 'sdr'], { title: 'other title' }],
        ['originRunId', [`title for ${v.action}`, 'a summary', canonicalJson(['w']), canonicalJson([]), canonicalJson(['x', 'y']), 'run-8', 'task-9', 'sdr'], { originRunId: 'run-8' }],
        ['originTaskId', [`title for ${v.action}`, 'a summary', canonicalJson(['w']), canonicalJson([]), canonicalJson(['x', 'y']), 'run-7', null, 'sdr'], { originTaskId: null }],
        ['requestingAgent', [`title for ${v.action}`, 'a summary', canonicalJson(['w']), canonicalJson([]), canonicalJson(['x', 'y']), 'run-7', 'task-9', 'chief-of-staff'], { requestingAgent: 'chief-of-staff' }],
      ] as Array<[string, unknown[], Record<string, unknown>]>) {
        const mutatedSql = (
          await h.pool.query(
            `SELECT hitl.packet_hash_v1($1, hitl.classify_action($1), $2, 'inline', $3, NULL, $4::int,
                                        $5, $6, $7, $8, $9, $10, $11, $12) AS h`,
            [v.action, v.target, 'b'.repeat(64), 0, ...sqlArgs],
          )
        ).rows[0] as { h: string };
        const mutatedNode = packetHashOf({
          action: v.action,
          actionKind: classifyAction(v.action),
          target: v.target,
          contentHash: 'b'.repeat(64),
          payloadRef: null,
          expiresAt: null,
          canonicalizationVersion: 0,
          title: `title for ${v.action}`,
          summary: 'a summary',
          warnings: ['w'],
          sideEffects: [],
          choices: ['x', 'y'],
          originRunId: 'run-7',
          originTaskId: 'task-9',
          requestingAgent: 'sdr',
          ...packet,
        });
        assert.equal(mutatedSql.h, mutatedNode, `packet_hash (${label} mutated) for ${JSON.stringify(v)}`);
        assert.notEqual(mutatedNode, rich.h, `${label} must change the packet hash`);
      }
    }

    // the editorial allowlist is byte-identical on both sides
    for (const action of EDITORIAL_ACTIONS) {
      const kind = (await h.pool.query(`SELECT hitl.classify_action($1) AS k`, [action])).rows[0] as { k: string };
      assert.equal(kind.k, 'editorial', `${action} is editorial in SQL too`);
    }
    const unknown = (await h.pool.query(`SELECT hitl.classify_action('wire-transfer-funds') AS k`)).rows[0] as { k: string };
    assert.equal(unknown.k, 'execution', 'an unknown action fails safe to execution in SQL');

    // a NULL field must fail loud rather than silently vanish from the framing
    await assert.rejects(
      h.pool.query(`SELECT hitl.frame(ARRAY['a', NULL, 'b'])`),
      /NULL field/,
      'hitl.frame refuses a NULL field',
    );
  } finally {
    await h.close();
  }
});

// ---------------- seeded 1 -> 2 upgrade ----------------

test('hitl-migration: the seeded upgrade partitions generations at terminal boundaries', opts, async () => {
  const h = await makeDb();
  const v1 = v1OnlyDir();
  try {
    const applied = await runMigrations(h.pool, v1.dir, HITL_MIGRATION_TARGET);
    assert.deepEqual(applied.applied, ['001_init.sql']);

    // key A: three same-key rows. a2 carries a TERMINAL decision at t=3000,
    // strictly before a3 is created at t=4000 -> the boundary is unambiguous.
    //   a1 (t=1000) deferred      -> generation 1 version 1
    //   a2 (t=2000) approved      -> generation 1 version 2 (seals gen 1)
    //   a3 (t=4000) undecided     -> generation 2 version 1
    await seedV1Request(h.pool, {
      id: 'a1', action: 'publish-post', target: 'blog/x.md', functionName: 'marketing',
      body: 'body1', contentHash: sha256Of('body1'), createdAt: 1000,
    });
    await seedV1Request(h.pool, {
      id: 'a2', action: 'publish-post', target: 'blog/x.md', functionName: 'marketing',
      // content_hash does NOT match sha256(body) -> hash-exempt legacy row
      body: 'body2', contentHash: 'f'.repeat(64), createdAt: 2000,
    });
    await seedV1Request(h.pool, {
      id: 'a3', action: 'publish-post', target: 'blog/x.md', functionName: 'marketing',
      body: 'body3', contentHash: sha256Of('body3'), createdAt: 4000, expiresAt: 9_999_999_999_999,
    });
    await seedV1Decision(h.pool, { id: 'd1', requestId: 'a1', status: 'deferred', createdAt: 1500 });
    await seedV1Decision(h.pool, { id: 'd2', requestId: 'a2', status: 'approved', createdAt: 3000 });
    // key B: an editorial request with no expiry at all.
    await seedV1Request(h.pool, {
      id: 'b1', action: 'approve-draft', target: '  drafts/y.md  ', functionName: 'content',
      body: 'bodyb', contentHash: sha256Of('bodyb'), createdAt: 5000,
    });

    const upgrade = await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    assert.deepEqual(upgrade.applied, ['002_state_machine.sql']);
    assert.deepEqual(upgrade.skipped, ['001_init.sql']);

    const rows = (
      await h.pool.query(
        `SELECT legacy_id, id, request_key, generation, version, action_kind,
                canonicalization_version, expires_at, target_hash, packet_hash
           FROM hitl.requests ORDER BY seq`,
      )
    ).rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 4);
    const [a1, a2, a3, b1] = rows as Array<Record<string, string | number | null>>;

    // GENERATION PARTITION at the terminal boundary
    assert.deepEqual([a1.generation, a1.version], [1, 1]);
    assert.deepEqual([a2.generation, a2.version], [1, 2]);
    assert.deepEqual([a3.generation, a3.version], [2, 1], 'a post-terminal same-key row opens a new generation');
    assert.deepEqual([b1.generation, b1.version], [1, 1]);

    // RE-KEY: all three key-A rows now live under ONE derived request_id, and
    // the pre-v2 id is preserved for auditability.
    const keyA = requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/x.md' });
    assert.equal(a1.request_key, keyA);
    assert.equal(a1.id, requestIdOf(WS, keyA));
    assert.equal(a2.id, a1.id);
    assert.equal(a3.id, a1.id);
    assert.deepEqual([a1.legacy_id, a2.legacy_id, a3.legacy_id], ['a1', 'a2', 'a3']);
    assert.notEqual(b1.id, a1.id);
    assert.equal(
      b1.request_key,
      requestKeyOf({ functionName: 'content', action: 'approve-draft', target: 'drafts/y.md' }),
      'the request key is over the NORMALIZED target',
    );
    assert.equal(b1.target_hash, targetHashOf('drafts/y.md'));

    // HASH EXEMPTION: only the row whose content_hash matched sha256(body) is
    // canonicalization_version 1; the mismatching one is the legacy 0.
    assert.deepEqual(
      [a1.canonicalization_version, a2.canonicalization_version, a3.canonicalization_version, b1.canonicalization_version],
      [1, 0, 1, 1],
    );

    // LEGACY EXPIRY: an execution row with no recorded expiry gets created_at +
    // the default TTL; a recorded expiry is preserved; editorial stays open.
    // pg returns bigint as a string; compare numerically.
    assert.equal(Number(a1.expires_at), 1000 + DAY_MS);
    assert.equal(Number(a2.expires_at), 2000 + DAY_MS);
    assert.equal(Number(a3.expires_at), 9_999_999_999_999, 'a recorded legacy expiry is preserved verbatim');
    assert.equal(b1.expires_at, null, 'an editorial request may stay open-ended');
    assert.deepEqual([a1.action_kind, b1.action_kind], ['execution', 'editorial']);

    // the backfilled packet hash equals what Node derives for the same packet
    assert.equal(
      a1.packet_hash,
      packetHashOf({
        action: 'publish-post',
        actionKind: 'execution',
        target: 'blog/x.md',
        contentHash: sha256Of('body1'),
        payloadRef: null,
        expiresAt: 1000 + DAY_MS,
        canonicalizationVersion: 1,
        // seedV1Request stores `title: <legacy id>` in the v1 payload, and the
        // title is packet identity — the backfill hashes exactly those bytes.
        title: 'a1',
      }),
    );

    // DECISIONS were remapped onto the new (request_id, generation, version)
    const decisions = (
      await h.pool.query(
        `SELECT id, request_id, generation, request_version, terminal, decided_at FROM hitl.decisions ORDER BY seq`,
      )
    ).rows as Array<Record<string, unknown>>;
    assert.deepEqual(
      decisions.map((d) => [d.id, d.request_id, d.generation, d.request_version, d.terminal, Number(d.decided_at)]),
      [
        ['d1', a1.id, 1, 1, false, 1500],
        ['d2', a1.id, 1, 2, true, 3000],
      ],
    );

    // TIMESTAMP PRESERVATION (round-2 finding 3): the backfill NEVER restamps a
    // row with the migration's own clock — created_at stays the v1 creation
    // time, and decided_at is the legacy decision's stamp. The local conversion
    // preserves exactly the same values (test/hitl-local-migrate.test.ts R2-3),
    // which is what makes converted history auditable and the two backends
    // agree.
    const stamps = (
      await h.pool.query(`SELECT legacy_id, created_at FROM hitl.requests ORDER BY seq`)
    ).rows as Array<{ legacy_id: string; created_at: string }>;
    assert.deepEqual(
      stamps.map((r) => [r.legacy_id, Number(r.created_at)]),
      [['a1', 1000], ['a2', 2000], ['a3', 4000], ['b1', 5000]],
    );

    // PROJECTION: one row per group, at the highest generation's head.
    const state = (
      await h.pool.query(
        `SELECT request_id, generation, version, effective_status, sealed, superseded, authoritative
           FROM hitl.request_state ORDER BY request_id`,
      )
    ).rows as Array<Record<string, unknown>>;
    assert.equal(state.length, 2, 'one projected row per request group');
    const groupA = state.find((s) => s.request_id === a1.id)!;
    assert.deepEqual([groupA.generation, groupA.version], [2, 1]);
    assert.equal(groupA.effective_status, 'awaiting');
    assert.equal(groupA.sealed, false);
    assert.equal(groupA.authoritative, false);
  } finally {
    v1.cleanup();
    await h.close();
  }
});

// ---------------- preflight refusals ----------------

for (const scenario of [
  {
    name: 'ambiguous chronology (the next same-key request predates the terminal decision)',
    match: /generation boundary is ambiguous/,
    seed: async (pool: pg.Pool) => {
      await seedV1Request(pool, { id: 'c1', action: 'publish-post', target: 't', functionName: 'f', body: 'b', contentHash: sha256Of('b'), createdAt: 1000 });
      await seedV1Request(pool, { id: 'c2', action: 'publish-post', target: 't', functionName: 'f', body: 'b2', contentHash: sha256Of('b2'), createdAt: 2000 });
      // c1's terminal decision lands AFTER c2 already existed: was c2 a
      // revision inside the open generation, or a fresh post-terminal one?
      await seedV1Decision(pool, { id: 'cd1', requestId: 'c1', status: 'approved', createdAt: 3000 });
    },
  },
  {
    name: 'duplicate terminal decisions on one request',
    match: /carries 2 terminal decisions/,
    seed: async (pool: pg.Pool) => {
      await seedV1Request(pool, { id: 'e1', action: 'publish-post', target: 't', functionName: 'f', body: 'b', contentHash: sha256Of('b'), createdAt: 1000 });
      await seedV1Decision(pool, { id: 'ed1', requestId: 'e1', status: 'approved', createdAt: 2000 });
      await seedV1Decision(pool, { id: 'ed2', requestId: 'e1', status: 'rejected', createdAt: 2100 });
    },
  },
  {
    name: 'duplicate same-status decisions on one request',
    match: /carries 2 'deferred' decisions/,
    seed: async (pool: pg.Pool) => {
      await seedV1Request(pool, { id: 'g1', action: 'publish-post', target: 't', functionName: 'f', body: 'b', contentHash: sha256Of('b'), createdAt: 1000 });
      await seedV1Decision(pool, { id: 'gd1', requestId: 'g1', status: 'deferred', createdAt: 2000 });
      await seedV1Decision(pool, { id: 'gd2', requestId: 'g1', status: 'deferred', createdAt: 2100 });
    },
  },
  {
    name: 'an orphan decision',
    match: /references request missing-req version 1 which does not exist/,
    seed: async (pool: pg.Pool) => {
      await seedV1Decision(pool, { id: 'od1', requestId: 'missing-req', status: 'approved', createdAt: 2000 });
    },
  },
  {
    name: 'a decision stamped before its request',
    match: /before its request/,
    seed: async (pool: pg.Pool) => {
      await seedV1Request(pool, { id: 'h1', action: 'publish-post', target: 't', functionName: 'f', body: 'b', contentHash: sha256Of('b'), createdAt: 5000 });
      await seedV1Decision(pool, { id: 'hd1', requestId: 'h1', status: 'approved', createdAt: 100 });
    },
  },
  {
    name: 'an unknown decision status',
    match: /is not a decision status/,
    seed: async (pool: pg.Pool) => {
      await seedV1Request(pool, { id: 'i1', action: 'publish-post', target: 't', functionName: 'f', body: 'b', contentHash: sha256Of('b'), createdAt: 1000 });
      await seedV1Decision(pool, { id: 'id1', requestId: 'i1', status: 'maybe', createdAt: 2000 });
    },
  },
]) {
  test(`hitl-migration: the preflight refuses ${scenario.name}`, opts, async () => {
    const h = await makeDb();
    const v1 = v1OnlyDir();
    try {
      await runMigrations(h.pool, v1.dir, HITL_MIGRATION_TARGET);
      await scenario.seed(h.pool);
      await assert.rejects(
        runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET),
        (err: Error) => {
          assert.match(err.message, /preflight refused the v1->v2 upgrade/);
          assert.match(err.message, scenario.match, `actionable per-key detail: ${err.message}`);
          return true;
        },
      );
      // the refusal rolls the WHOLE upgrade back: v1 is intact and unrecorded
      const cols = await h.pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema='hitl' AND table_name='requests' AND column_name='request_key'`,
      );
      assert.equal(cols.rowCount, 0, 'no v2 column survives a refused upgrade');
      const ledger = await h.pool.query(`SELECT filename FROM hitl.schema_migrations ORDER BY filename`);
      assert.deepEqual(
        ledger.rows.map((r) => (r as { filename: string }).filename),
        ['001_init.sql'],
        '002 must not be recorded as applied',
      );
    } finally {
      v1.cleanup();
      await h.close();
    }
  });
}

// ---------------- the DB-enforced decision machine ----------------

test('hitl-migration: the decision trigger refuses a BARE runtime INSERT that reopens a terminal version', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    // generation 1 with a revision: v1 (superseded by v2), v2 (the head).
    const req = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/x.md',
      body: 'body-a', expiresAt: now + DAY_MS, createdAt: now,
    });
    await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/x.md',
      body: 'body-b', version: 2, expiresAt: now + DAY_MS, createdAt: now + 1,
    });
    // an older VERSION of the open generation is not decidable
    await assert.rejects(
      insertDecision(h.pool, { id: 'dec-old-ver', requestId: req.id, generation: 1, version: 1, status: 'approved', createdAt: now + 2 }),
      /generation 1 version 1 is not the current head \(head is .* generation 1 version 2\)/,
    );

    await insertDecision(h.pool, { id: 'dec-approve', requestId: req.id, generation: 1, version: 2, status: 'approved', createdAt: now + 3 });

    // a raw INSERT trying to overturn the terminal decision
    await assert.rejects(
      insertDecision(h.pool, { id: 'dec-reject', requestId: req.id, generation: 1, version: 2, status: 'rejected', createdAt: now + 4 }),
      /already carries the terminal decision 'approved'/,
    );
    // ...and a second decision of the SAME status
    await assert.rejects(
      insertDecision(h.pool, { id: 'dec-approve-2', requestId: req.id, generation: 1, version: 2, status: 'approved', createdAt: now + 4 }),
      /already carries the terminal decision/,
    );

    // open generation 2; the sealed generation 1 is now unreachable entirely
    await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/x.md',
      body: 'body-c', generation: 2, version: 1, expiresAt: now + DAY_MS, createdAt: now + 10,
    });
    await assert.rejects(
      insertDecision(h.pool, { id: 'dec-old-gen', requestId: req.id, generation: 1, version: 1, status: 'cancelled', createdAt: now + 11 }),
      /is not the current head \(head is .* generation 2 version 1\)/,
    );
    // the new generation IS decidable
    await insertDecision(h.pool, { id: 'dec-g2', requestId: req.id, generation: 2, version: 1, status: 'deferred', createdAt: now + 12 });
    // ...but only once with the same status
    await assert.rejects(
      insertDecision(h.pool, { id: 'dec-g2-dup', requestId: req.id, generation: 2, version: 1, status: 'deferred', createdAt: now + 13 }),
      /decisions_status_once_idx/,
    );

    // a decision naming a version that does not exist is refused outright
    await assert.rejects(
      insertDecision(h.pool, { id: 'dec-ghost', requestId: req.id, generation: 9, version: 9, status: 'approved', createdAt: now + 14 }),
      /which does not exist/,
    );

    const state = (
      await h.pool.query(`SELECT generation, version, effective_status, authoritative FROM hitl.request_state WHERE request_id = $1`, [req.id])
    ).rows[0] as Record<string, unknown>;
    assert.deepEqual([state.generation, state.version], [2, 1]);
    assert.equal(state.effective_status, 'deferred');
    assert.equal(state.authoritative, false, 'authority never falls back to the approved older generation');
  } finally {
    await h.close();
  }
});

test('hitl-migration: the decision trigger enforces expiry direction and converges concurrent sweeps', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();

    const live = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/live.md',
      body: 'body-a', expiresAt: now + DAY_MS, createdAt: now,
    });
    // an expiry cannot be recorded before the deadline
    await assert.rejects(
      insertDecision(h.pool, { id: 'early-exp', requestId: live.id, generation: 1, version: 1, status: 'expired', createdAt: now }),
      /it does not expire until/,
    );

    const stale = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/stale.md',
      body: 'body-b', expiresAt: now - 1, createdAt: now - DAY_MS,
    });
    // effective status is 'expired' with NO durable decision yet (sweep-independent)
    const preSweep = (
      await h.pool.query(
        `SELECT effective_status, sealed, authoritative FROM hitl.request_state WHERE request_id = $1`,
        [stale.id],
      )
    ).rows[0] as Record<string, unknown>;
    assert.equal(preSweep.effective_status, 'expired');
    assert.equal(preSweep.sealed, true);
    assert.equal(preSweep.authoritative, false);

    // a USER decision on an expired request is refused
    await assert.rejects(
      insertDecision(h.pool, { id: 'late-approve', requestId: stale.id, generation: 1, version: 1, status: 'approved', createdAt: now }),
      /record the expiry, not a 'approved' decision/,
    );

    // the sweep's deterministic system expiry lands...
    const sysId = 'sys-expiry-deterministic-id';
    await insertDecision(h.pool, { id: sysId, requestId: stale.id, generation: 1, version: 1, status: 'expired', createdAt: now, onConflict: true });
    // ...and a CONCURRENT sweep replaying the identical row converges to a
    // no-op instead of raising (D-should(a)).
    await insertDecision(h.pool, { id: sysId, requestId: stale.id, generation: 1, version: 1, status: 'expired', createdAt: now + 5, onConflict: true });
    const count = await h.pool.query(`SELECT count(*)::int AS n FROM hitl.decisions WHERE request_id = $1`, [stale.id]);
    assert.equal((count.rows[0] as { n: number }).n, 1, 'exactly one durable expiry decision');

    // a DIFFERENT id on the same terminal version is still a conflict
    await assert.rejects(
      insertDecision(h.pool, { id: 'other-expiry', requestId: stale.id, generation: 1, version: 1, status: 'expired', createdAt: now + 6 }),
      /already carries the terminal decision 'expired'/,
    );
  } finally {
    await h.close();
  }
});

test('hitl-migration: the decision trigger refuses any isolation level above READ COMMITTED', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const req = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/iso.md',
      body: 'body-a', expiresAt: now + DAY_MS, createdAt: now,
    });

    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      const client = await h.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        await assert.rejects(
          insertDecision(client, { id: `iso-${level}`, requestId: req.id, generation: 1, version: 1, status: 'approved', createdAt: now }),
          /must be written at READ COMMITTED/,
          `${level} must be refused`,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    }

    // explicit READ COMMITTED is accepted
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await insertDecision(client, { id: 'iso-ok', requestId: req.id, generation: 1, version: 1, status: 'approved', createdAt: now });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const ok = await h.pool.query(`SELECT count(*)::int AS n FROM hitl.decisions WHERE request_id = $1`, [req.id]);
    assert.equal((ok.rows[0] as { n: number }).n, 1);
  } finally {
    await h.close();
  }
});

test('hitl-migration: a superseded head is neither decidable nor authoritative', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const source = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/source.md',
      body: 'body-a', expiresAt: now + DAY_MS, createdAt: now,
    });
    await insertDecision(h.pool, { id: 'src-approve', requestId: source.id, generation: 1, version: 1, status: 'approved', createdAt: now });
    const before = (
      await h.pool.query(`SELECT superseded, authoritative FROM hitl.request_state WHERE request_id = $1`, [source.id])
    ).rows[0] as Record<string, unknown>;
    assert.deepEqual([before.superseded, before.authoritative], [false, true], 'an approved terminal head IS authoritative');

    // the cross-group `replaces` row
    await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/dest.md',
      body: 'body-b', expiresAt: now + DAY_MS, createdAt: now + 1,
      supersedes: { requestId: source.id, generation: 1, version: 1 },
    });
    const after = (
      await h.pool.query(`SELECT superseded, authoritative FROM hitl.request_state WHERE request_id = $1`, [source.id])
    ).rows[0] as Record<string, unknown>;
    assert.deepEqual([after.superseded, after.authoritative], [true, false], 'the superseded approval loses authority');

    // an incoherent partial supersession pointer is refused
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, generation, action, target, content_hash, payload, status, created_at, supersedes_request_id)
         VALUES ('partial', $1::uuid, 1, 1, 'publish-post', 't', $2, '{}'::jsonb, 'awaiting', $3, 'x')`,
        [WS, 'a'.repeat(64), now],
      ),
      /requests_supersedes_coherent_check/,
    );
  } finally {
    await h.close();
  }
});

// R5 finding 2: the runtime keeps INSERT on hitl.requests, and the fill trigger
// only ever validated ROW-LOCAL derivations. ALLOCATION — which (generation,
// version) a row may claim within its group, and which head a supersession
// pointer may name — was application-enforced only, so a raw runtime INSERT
// could add G2/V1 to a superseded group (the existing pointer names G1/V1, so
// the new head read as unsuperseded) and later be approved.
test('R5-2: the requests trigger enforces ALLOCATION, not just derivation', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const req = (
      r: Parameters<typeof insertV2Request>[1],
    ): Promise<{ id: string; requestKey: string; packetHash: string }> => insertV2Request(h.pool, r);
    const base = { functionName: 'marketing', action: 'publish-post', expiresAt: now + DAY_MS } as const;

    // ---- (a) permanent closure: a superseded group takes no further row ----
    const closed = await req({ ...base, target: 'blog/closed.md', body: 'a', createdAt: now });
    await req({
      ...base, target: 'blog/successor.md', body: 'b', createdAt: now + 1,
      supersedes: { requestId: closed.id, generation: 1, version: 1 },
    });
    await assert.rejects(
      req({ ...base, target: 'blog/closed.md', body: 'resurrected', createdAt: now + 2, generation: 2, version: 1 }),
      /superseded/,
      'G2/V1 into a superseded group must be refused',
    );
    await assert.rejects(
      req({ ...base, target: 'blog/closed.md', body: 'resurrected', createdAt: now + 2, version: 2 }),
      /superseded/,
      'a revision of a superseded group must be refused too',
    );
    assert.equal(
      (await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE id = $1`, [closed.id])).rows[0]!.n,
      1,
      'the superseded group never grew a row',
    );

    // ---- (b) legal allocation only: no gaps, no reuse, no early G+1 ----
    const open = await req({ ...base, target: 'blog/open.md', body: 'a', createdAt: now });
    await assert.rejects(
      req({ ...base, target: 'blog/open.md', body: 'gap', createdAt: now + 1, version: 3 }),
      /version/,
      'a version gap must be refused',
    );
    await assert.rejects(
      req({ ...base, target: 'blog/open.md', body: 'reuse', createdAt: now + 1, version: 1 }),
      /version/,
      'reusing the head version must be refused',
    );
    await assert.rejects(
      req({ ...base, target: 'blog/open.md', body: 'early', createdAt: now + 1, generation: 2, version: 1 }),
      /still open/,
      'opening G+1 while generation 1 is open must be refused',
    );
    await assert.rejects(
      req({ ...base, target: 'blog/open.md', body: 'skip', createdAt: now + 1, generation: 3, version: 1 }),
      /generation/,
      'skipping a generation must be refused',
    );
    // ...and the LEGAL next steps still land.
    await req({ ...base, target: 'blog/open.md', body: 'revision', createdAt: now + 2, version: 2 });
    await insertDecision(h.pool, {
      id: 'open-approve', requestId: open.id, generation: 1, version: 2, status: 'approved', createdAt: now + 3,
    });
    await req({ ...base, target: 'blog/open.md', body: 'next gen', createdAt: now + 4, generation: 2, version: 1 });
    const head = (
      await h.pool.query(`SELECT generation, version FROM hitl.request_state WHERE request_id = $1`, [open.id])
    ).rows[0] as Record<string, number>;
    assert.deepEqual([Number(head.generation), Number(head.version)], [2, 1]);

    // ---- (c) a supersession pointer must name the CURRENT, unsuperseded head ----
    await assert.rejects(
      req({
        ...base, target: 'blog/stale-pointer.md', body: 'p', createdAt: now + 5,
        supersedes: { requestId: open.id, generation: 1, version: 1 },
      }),
      /current head/,
      'a pointer at a non-current version must be refused',
    );
    await assert.rejects(
      req({
        ...base, target: 'blog/ghost-pointer.md', body: 'p', createdAt: now + 5,
        supersedes: { requestId: open.id, generation: 9, version: 9 },
      }),
      /current head/,
      'a pointer at a version that does not exist must be refused',
    );
    await assert.rejects(
      req({
        ...base, target: 'blog/nogroup-pointer.md', body: 'p', createdAt: now + 5,
        supersedes: { requestId: 'no-such-group', generation: 1, version: 1 },
      }),
      /current head/,
      'a pointer at a group that does not exist must be refused',
    );
    await assert.rejects(
      req({
        ...base, target: 'blog/double-pointer.md', body: 'p', createdAt: now + 5,
        supersedes: { requestId: closed.id, generation: 1, version: 1 },
      }),
      /already superseded/,
      'a second replacement of one superseded head must be refused',
    );
    // ...and a pointer at the CURRENT head still lands.
    await req({
      ...base, target: 'blog/live-pointer.md', body: 'p', createdAt: now + 6,
      supersedes: { requestId: open.id, generation: 2, version: 1 },
    });

    // ---- (d) the legacy/v1-shaped drain shape is untouched ----
    await h.pool.query(
      `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
       VALUES ('r5-legacy', $1::uuid, 1, 'publish-post', 'blog/legacy-alloc.md', $2, $3::jsonb, 'awaiting', 0)`,
      [WS, sha256Of('the body'), JSON.stringify({ functionName: 'marketing', body: 'the body' })],
    );
    assert.equal(
      (await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE legacy_id = 'r5-legacy'`)).rows[0]!.n,
      1,
      'a v1-shaped first row of a group still lands',
    );

    const authoritative = (
      await h.pool.query(
        `SELECT count(*)::int AS n FROM hitl.request_state WHERE workspace_id = $1::uuid AND authoritative`,
        [WS],
      )
    ).rows[0] as { n: number };
    assert.equal(authoritative.n, 0, 'no resurrected group ever became authoritative');
  } finally {
    await h.close();
  }
});

// ---------------- v1-shaped compatibility + projections ----------------

test('hitl-migration: a v1-shaped INSERT still lands, fully derived and coherent', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    // exactly the #318 store's INSERT: none of the v2 identity columns.
    await h.pool.query(
      `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
       VALUES ('v1shape', $1::uuid, 1, 'publish-post', 'blog/v1.md', $2, $3::jsonb, 'awaiting', 0)`,
      [WS, sha256Of('the body'), JSON.stringify({ functionName: 'marketing', body: 'the body' })],
    );
    // The insert named an arbitrary id; the fill trigger RE-KEYS a v1-shaped row
    // onto the canonical sha256(workspace_id, request_key) and preserves the old
    // value in legacy_id, so one request_key can never own two groups (#319
    // finding 4).
    const row = (
      await h.pool.query(
        `SELECT id, legacy_id, request_key, target_hash, packet_hash, action_kind, canonicalization_version,
                generation, expires_at
           FROM hitl.requests WHERE legacy_id = 'v1shape'`,
      )
    ).rows[0] as Record<string, string | number>;
    assert.equal(
      row.id,
      requestIdOf(WS, requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/v1.md' })),
      'a v1-shaped insert is re-keyed onto the canonical request id',
    );
    assert.equal(row.request_key, requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/v1.md' }));
    assert.equal(row.target_hash, targetHashOf('blog/v1.md'));
    assert.equal(row.action_kind, 'execution');
    assert.equal(row.canonicalization_version, 1, 'content_hash matched sha256(body)');
    assert.equal(row.generation, 1);
    // created_at was 0; the default TTL runs from the SERVER clock so the row
    // is not born expired and stays decidable.
    assert.ok(Number(row.expires_at) > Date.now(), `expiry ${row.expires_at} must be in the future`);
    assert.equal(
      row.packet_hash,
      packetHashOf({
        action: 'publish-post',
        actionKind: 'execution',
        target: 'blog/v1.md',
        contentHash: sha256Of('the body'),
        payloadRef: null,
        expiresAt: Number(row.expires_at),
        canonicalizationVersion: 1,
        // no title in the v1 payload -> '' on both sides
        title: '',
      }),
    );

    // a v1-shaped row with an unverifiable content hash is canonicalization 0
    await h.pool.query(
      `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
       VALUES ('v1exempt', $1::uuid, 1, 'publish-post', 'blog/v2.md', $2, '{}'::jsonb, 'awaiting', 0)`,
      [WS, 'f'.repeat(64)],
    );
    const exempt = (
      await h.pool.query(`SELECT canonicalization_version FROM hitl.requests WHERE legacy_id = 'v1exempt'`)
    ).rows[0] as { canonicalization_version: number };
    assert.equal(exempt.canonicalization_version, 0);

    // a writer that supplies packet-visible fields WITHOUT a packet hash is
    // refused rather than silently hashed with those fields absent.
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, summary, status, created_at)
         VALUES ('nohash', $1::uuid, 1, 'publish-post', 't', $2, '{}'::jsonb, 'a summary', 'awaiting', 0)`,
        [WS, 'a'.repeat(64)],
      ),
      /packet_hash must be supplied/,
    );

    // an execution request that names its own packet hash must name its expiry
    // too. Every DERIVED column is asserted correctly here (round 2: they are
    // recomputed and a mismatch is refused first), so this isolates the CHECK.
    const noexpKey = requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'noexp' });
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, generation, action, action_kind, target, target_hash,
                                    packet_hash, request_key, canonicalization_version, content_hash, payload, status, created_at)
         VALUES ($3, $1::uuid, 1, 1, 'publish-post', 'execution', 'noexp', $5, $2, $4, 1, $2, $6::jsonb, 'awaiting', 0)`,
        [WS, MARKETING_CONTENT_HASH, requestIdOf(WS, noexpKey), noexpKey, targetHashOf('noexp'), MARKETING_PAYLOAD],
      ),
      /requests_execution_expiry_check/,
    );

    // ...and a row whose id disagrees with its OWN request_key is refused
    // outright rather than opening a rival group.
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, generation, action, action_kind, target, target_hash,
                                    packet_hash, request_key, canonicalization_version, content_hash, payload, status,
                                    created_at, expires_at)
         VALUES ('not-canonical', $1::uuid, 1, 1, 'publish-post', 'execution', 'rival', $4, $2, $3, 1, $2,
                 $5::jsonb, 'awaiting', 0, 99999999999999)`,
        [
          WS,
          MARKETING_CONTENT_HASH,
          requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'rival' }),
          targetHashOf('rival'),
          MARKETING_PAYLOAD,
        ],
      ),
      /canonical request id/,
    );
  } finally {
    await h.close();
  }
});

test('hitl-migration: request_index projects only validated ids and DB-scrubbed summary text', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: `blog/${secret}.md`,
      body: 'body-a', expiresAt: now + DAY_MS, createdAt: now,
      summary: `deploy with token ${secret}`,
    });

    const idx = (await h.pool.query(`SELECT * FROM hitl.request_index`)).rows[0] as Record<string, unknown>;
    const blob = JSON.stringify(idx);
    assert.ok(!blob.includes(secret), `the index leaked a planted secret: ${blob}`);
    assert.ok(String(idx.sanitized_summary).includes('[REDACTED]'), 'the DB scrub redacted the summary');
    // the raw target and summary are NOT projected at all
    assert.ok(!('target' in idx), 'request_index must not expose the raw target');
    assert.ok(!('summary' in idx), 'request_index must not expose the raw summary');
    assert.match(String(idx.request_id), /^[0-9a-f]{64}$/);
    assert.match(String(idx.packet_hash), /^[0-9a-f]{64}$/);
    assert.equal(idx.action, 'publish-post');
    assert.equal(idx.action_kind, 'execution');
    assert.equal(idx.effective_status, 'awaiting');

    // a raw INSERT planting an unredacted secret straight into the projection
    // column is scrubbed by the trigger before it lands.
    await h.pool.query(
      `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, sanitized_summary, status, created_at)
       VALUES ('raw', $1::uuid, 1, 'publish-post', 't', $2, '{}'::jsonb, $3, 'awaiting', 0)`,
      [WS, 'a'.repeat(64), `AKIAIOSFODNN7EXAMPLE and password=hunter2SuperSecret`],
    );
    const raw = (
      await h.pool.query(`SELECT sanitized_summary FROM hitl.requests WHERE legacy_id = 'raw'`)
    ).rows[0] as { sanitized_summary: string };
    assert.ok(!raw.sanitized_summary.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!raw.sanitized_summary.includes('hunter2SuperSecret'));
    assert.ok(raw.sanitized_summary.includes('[REDACTED]'));

    // an action whose SHAPE looks like a credential is sentinelled, never raw
    await h.pool.query(
      `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
       VALUES ('shady', $1::uuid, 1, $2, 't2', $3, '{}'::jsonb, 'awaiting', 0)`,
      [WS, secret, 'a'.repeat(64)],
    );
    const shady = (
      await h.pool.query(`SELECT action FROM hitl.request_index`)
    ).rows.map((r) => (r as { action: string }).action);
    assert.ok(!shady.includes(secret), 'a secret-shaped action never surfaces verbatim');
    assert.ok(shady.some((a) => /^legacy-[0-9a-f]{12}$/.test(a)), 'it is projected as a deterministic sentinel');
  } finally {
    await h.close();
  }
});

// ---------------- round-1 review repros ----------------

// Finding 3: every migration join is keyed by (workspace_id, id, request_version).
test('R3: a multi-version legacy request maps each decision to ITS OWN version', opts, async () => {
  const h = await makeDb();
  const v1 = v1OnlyDir();
  try {
    await runMigrations(h.pool, v1.dir, HITL_MIGRATION_TARGET);
    // ONE legacy id, TWO versions. The approval targets version 2 only.
    await seedV1Request(h.pool, {
      id: 'm1', version: 1, action: 'publish-post', target: 'blog/m.md', functionName: 'marketing',
      body: 'first', contentHash: sha256Of('first'), createdAt: 1000,
    });
    await seedV1Request(h.pool, {
      id: 'm1', version: 2, action: 'publish-post', target: 'blog/m.md', functionName: 'marketing',
      body: 'second', contentHash: sha256Of('second'), createdAt: 2000,
    });
    await seedV1Decision(h.pool, { id: 'md1', requestId: 'm1', requestVersion: 2, status: 'approved', createdAt: 3000 });

    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);

    const rows = (
      await h.pool.query(`SELECT id, generation, version, legacy_id FROM hitl.requests ORDER BY seq`)
    ).rows as Array<Record<string, unknown>>;
    // The undecided version 1 and the terminally-decided version 2 are versions
    // of ONE open generation — only the row that CARRIES the terminal decision
    // seals, and it is the last of the key.
    assert.deepEqual(
      rows.map((r) => [r.generation, r.version]),
      [[1, 1], [1, 2]],
      'a decision on legacy version 2 must not seal legacy version 1',
    );
    const decision = (
      await h.pool.query(`SELECT request_id, generation, request_version FROM hitl.decisions`)
    ).rows[0] as Record<string, unknown>;
    assert.equal(decision.request_id, rows[1]!.id);
    assert.deepEqual(
      [decision.generation, decision.request_version],
      [rows[1]!.generation, rows[1]!.version],
      'the decision lands on the generation/version derived from the version it named',
    );
  } finally {
    v1.cleanup();
    await h.close();
  }
});

test('R3: an orphan decision naming a version that does not exist hits the preflight refusal', opts, async () => {
  const h = await makeDb();
  const v1 = v1OnlyDir();
  try {
    await runMigrations(h.pool, v1.dir, HITL_MIGRATION_TARGET);
    await seedV1Request(h.pool, {
      id: 'o1', version: 1, action: 'publish-post', target: 'blog/o.md', functionName: 'marketing',
      body: 'b', contentHash: sha256Of('b'), createdAt: 1000,
    });
    // The request id exists — the VERSION does not.
    await seedV1Decision(h.pool, { id: 'od99', requestId: 'o1', requestVersion: 99, status: 'approved', createdAt: 2000 });

    await assert.rejects(runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET), (err: Error) => {
      assert.match(err.message, /preflight refused the v1->v2 upgrade/);
      assert.match(err.message, /version 99/, `actionable per-row detail: ${err.message}`);
      return true;
    });
    const cols = await h.pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='hitl' AND table_name='requests' AND column_name='request_key'`,
    );
    assert.equal(cols.rowCount, 0, 'the refusal rolled the whole upgrade back');
  } finally {
    v1.cleanup();
    await h.close();
  }
});

// Finding 4: one group per request_key, enforced by the database.
test('R4: the database refuses a SECOND request group for one request_key', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const canonical = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'publish-post', target: 'blog/x.md',
      body: 'body-a', expiresAt: now + DAY_MS, createdAt: now,
    });
    await insertDecision(h.pool, {
      id: 'canonical-approve', requestId: canonical.id, generation: 1, version: 1, status: 'approved', createdAt: now,
    });

    // (a) a v1-SHAPED insert under an arbitrary id: re-keyed onto the canonical
    // group (and therefore refused by the identity unique), never a second group.
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
         VALUES ('attacker-x', $1::uuid, 1, 'publish-post', 'blog/x.md', $2, $3::jsonb, 'awaiting', $4)`,
        [WS, 'c'.repeat(64), JSON.stringify({ functionName: 'marketing', body: 'b' }), now + 1],
      ),
    );

    // (b) a v2-SHAPED insert that names the canonical request_key under a
    // different id is refused outright.
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
         VALUES ('attacker-y', $1::uuid, 1, 1, 'publish-post', 'execution', 'blog/x.md', $2, $3, $4, 1, $5, $6::jsonb, 'awaiting', $7, $8)`,
        [
          WS,
          targetHashOf('blog/x.md'),
          'd'.repeat(64),
          canonical.requestKey,
          'e'.repeat(64),
          JSON.stringify({ functionName: 'marketing', body: 'b' }),
          now + 2,
          now + DAY_MS,
        ],
      ),
      /canonical request id/,
    );

    const groups = (
      await h.pool.query(
        `SELECT count(*)::int AS n FROM hitl.request_state WHERE workspace_id = $1::uuid AND request_key = $2`,
        [WS, canonical.requestKey],
      )
    ).rows[0] as { n: number };
    assert.equal(groups.n, 1, 'exactly ONE group per request_key');
    const authoritative = (
      await h.pool.query(
        `SELECT count(*)::int AS n FROM hitl.request_state WHERE workspace_id = $1::uuid AND authoritative`,
        [WS],
      )
    ).rows[0] as { n: number };
    assert.equal(authoritative.n, 1, 'never two authoritative groups for one request');
  } finally {
    await h.close();
  }
});

// ---------------- round-2 review repros ----------------

// R2 finding 1: `fill_request_derived` TRUSTED the caller's action_kind /
// request_key / target_hash and only proved the id matched the SUPPLIED key —
// so a writer holding plain INSERT could mint an expiry-free "editorial"
// execution request, or open a second group for one real (function, action,
// target) by naming a different key. All three derivations are now RECOMPUTED
// from their true inputs and a disagreement is refused.
test('R2-1: the fill trigger recomputes every derivation and REFUSES an asserted mismatch', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const payload = JSON.stringify({ functionName: 'marketing', title: 't', body: 'b' });

    // (a) THE SPOOF: an execution action asserted as 'editorial' with NO expiry,
    // under an id that matches its own supplied key. Approving it used to make
    // hitl.request_state.authoritative true for an expiry-free execution.
    const spoofKey = requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/spoof.md' });
    const spoofId = requestIdOf(WS, spoofKey);
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, 'publish-post', 'editorial', 'blog/spoof.md', $3, $4, $5, 1, $6, $7::jsonb,
                 'awaiting', 1000, NULL)`,
        [spoofId, WS, targetHashOf('blog/spoof.md'), 'a'.repeat(64), spoofKey, MARKETING_CONTENT_HASH, payload],
      ),
      /action_kind/,
      'an asserted action_kind that is not the classification of the action must be refused',
    );
    const spoofed = await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE id = $1`, [spoofId]);
    assert.equal((spoofed.rows[0] as { n: number }).n, 0, 'nothing may land from the spoof');

    // (b) a WRONG request_key (a key derived from a different functionName) —
    // self-consistent with its own id, which is exactly why the id check alone
    // could not catch it.
    const foreignKey = requestKeyOf({ functionName: 'attacker', action: 'publish-post', target: 'blog/x.md' });
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, 'publish-post', 'execution', 'blog/x.md', $3, $4, $5, 1, $6, $7::jsonb,
                 'awaiting', 1000, 99999999999999)`,
        [requestIdOf(WS, foreignKey), WS, targetHashOf('blog/x.md'), 'a'.repeat(64), foreignKey, MARKETING_CONTENT_HASH, payload],
      ),
      /request_key/,
    );

    // (c) a WRONG target_hash
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, 'publish-post', 'execution', 'blog/y.md', $3, $4, $5, 1, $6, $7::jsonb,
                 'awaiting', 1000, 99999999999999)`,
        [
          requestIdOf(WS, requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/y.md' })),
          WS,
          targetHashOf('a different target'),
          'a'.repeat(64),
          requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/y.md' }),
          MARKETING_CONTENT_HASH,
          payload,
        ],
      ),
      /target_hash/,
    );

    // (d) two DIFFERENT supplied keys for one real (function, action, target)
    // can no longer mint two groups: the second is refused, and the first is
    // only accepted because it asserts the derivation the trigger computes.
    const realKey = requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/one.md' });
    await h.pool.query(
      `INSERT INTO hitl.requests
         (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
          request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
       VALUES ($1, $2::uuid, 1, 1, 'publish-post', 'execution', 'blog/one.md', $3, $4, $5, 1, $6, $7::jsonb,
               'awaiting', 1000, 99999999999999)`,
      [requestIdOf(WS, realKey), WS, targetHashOf('blog/one.md'), 'a'.repeat(64), realKey, MARKETING_CONTENT_HASH, payload],
    );
    const rivalKey = requestKeyOf({ functionName: 'attacker', action: 'publish-post', target: 'blog/one.md' });
    assert.notEqual(rivalKey, realKey, 'the rival key must be a genuinely different string');
    await assert.rejects(
      h.pool.query(
        `INSERT INTO hitl.requests
           (id, workspace_id, version, generation, action, action_kind, target, target_hash, packet_hash,
            request_key, canonicalization_version, content_hash, payload, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 1, 1, 'publish-post', 'execution', 'blog/one.md', $3, $4, $5, 1, $6, $7::jsonb,
                 'awaiting', 2000, 99999999999999)`,
        [requestIdOf(WS, rivalKey), WS, targetHashOf('blog/one.md'), 'a'.repeat(64), rivalKey, MARKETING_CONTENT_HASH, payload],
      ),
      /request_key/,
    );
    const groups = (
      await h.pool.query(
        `SELECT count(DISTINCT id)::int AS n FROM hitl.requests WHERE workspace_id = $1::uuid AND target = 'blog/one.md'`,
        [WS],
      )
    ).rows[0] as { n: number };
    assert.equal(groups.n, 1, 'one real (function, action, target) owns exactly ONE group');
  } finally {
    await h.close();
  }
});

// The legacy/v1-shaped drain path supplies NONE of the three derivations, so
// recomputation is its normal path: it must still land, re-keyed canonically.
test('R2-1: the legacy drain shape still lands and is re-keyed canonically', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    await h.pool.query(
      `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
       VALUES ('legacy-drain', $1::uuid, 1, 'publish-post', 'blog/legacy.md', $2, $3::jsonb, 'awaiting', 0)`,
      [WS, sha256Of('the body'), JSON.stringify({ functionName: 'marketing', body: 'the body' })],
    );
    const key = requestKeyOf({ functionName: 'marketing', action: 'publish-post', target: 'blog/legacy.md' });
    const row = (
      await h.pool.query(
        `SELECT id, legacy_id, request_key, target_hash, action_kind FROM hitl.requests WHERE legacy_id = 'legacy-drain'`,
      )
    ).rows[0] as Record<string, string>;
    assert.equal(row.request_key, key);
    assert.equal(row.id, requestIdOf(WS, key));
    assert.equal(row.target_hash, targetHashOf('blog/legacy.md'));
    assert.equal(row.action_kind, 'execution');

    // A v1-shaped row whose functionName is anything but a NON-EMPTY STRING
    // resolves to the same 'unknown' sentinel the TS side uses — otherwise the
    // drain would compute one key in TS and the trigger another, and the row
    // (which asserts the TS key) would be refused forever.
    const sentinelKey = (target: string): string =>
      requestKeyOf({ functionName: 'unknown', action: 'publish-post', target });
    for (const [id, target, fn] of [
      ['legacy-empty-fn', 'blog/empty.md', '""'],
      ['legacy-null-fn', 'blog/null.md', 'null'],
      ['legacy-number-fn', 'blog/number.md', '5'],
      ['legacy-absent-fn', 'blog/absent.md', undefined],
    ] as Array<[string, string, string | undefined]>) {
      const payloadJson = fn === undefined ? '{"body":"x"}' : `{"functionName":${fn},"body":"x"}`;
      await h.pool.query(
        `INSERT INTO hitl.requests (id, workspace_id, version, action, target, content_hash, payload, status, created_at)
         VALUES ($4, $1::uuid, 1, 'publish-post', $5, $2, $3::jsonb, 'awaiting', 0)`,
        [WS, sha256Of('x'), payloadJson, id, target],
      );
      const row2 = (
        await h.pool.query(`SELECT request_key FROM hitl.requests WHERE legacy_id = $1`, [id])
      ).rows[0] as { request_key: string };
      assert.equal(row2.request_key, sentinelKey(target), `${id} must resolve the 'unknown' sentinel`);
    }
  } finally {
    await h.close();
  }
});

// ---------------- round 6 ----------------

// R6 finding 1: the ALLOCATION gate the requests trigger runs is the same
// lock-then-read serialization the decisions trigger uses, and it is sound for
// the same reason and under the same condition: only READ COMMITTED gives each
// post-lock statement a FRESH snapshot. Under REPEATABLE READ / SERIALIZABLE the
// snapshot predates the lock, so a writer that queues behind a `replaces` reads
// the pre-supersession group state and allocates a head next to the replacement.
test('R6-1: the requests trigger refuses any isolation level above READ COMMITTED', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const base = { functionName: 'marketing', action: 'publish-post', expiresAt: now + DAY_MS } as const;
    const source = await insertV2Request(h.pool, { ...base, target: 'blog/iso.md', body: 'a', createdAt: now });

    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      const client = await h.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        // The stale snapshot the gate would read group state through.
        await client.query(`SELECT count(*) FROM hitl.requests`);
        await assert.rejects(
          insertV2Request(client, {
            ...base, target: 'blog/iso.md', body: 'revision', createdAt: now + 1, version: 2,
          }),
          /must be written at READ COMMITTED/,
          `${level} must be refused`,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    }
    assert.equal(
      (await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE id = $1`, [source.id])).rows[0]!.n,
      1,
      'nothing was allocated under the refused isolations',
    );

    // ...and an explicit READ COMMITTED transaction still allocates normally.
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await insertV2Request(client, {
        ...base, target: 'blog/iso.md', body: 'revision', createdAt: now + 1, version: 2,
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const head = (
      await h.pool.query(`SELECT generation, version FROM hitl.request_state WHERE request_id = $1`, [source.id])
    ).rows[0] as Record<string, number>;
    assert.deepEqual([Number(head.generation), Number(head.version)], [1, 2]);
  } finally {
    await h.close();
  }
});

// R6 finding 2: sealing for G+1 is judged by the DURABLE terminal decision
// (round 5), which is immune to a clock that crosses the deadline mid-write —
// but it left the in-place REVISION door open: an effectively-expired head with
// no materialized decision took a raw G/V+1, and that new version hid the
// expired one from every future sweep, so its expiry was never recorded at all.
test('R6-2: a raw insert cannot revise an EFFECTIVELY EXPIRED head', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const base = { functionName: 'marketing', action: 'publish-post' } as const;
    const dead = await insertV2Request(h.pool, {
      ...base, target: 'blog/dead.md', body: 'a', expiresAt: now - 1000, createdAt: now - DAY_MS,
    });
    const state = (
      await h.pool.query(
        `SELECT effective_status, sealed, terminal_status FROM hitl.request_state WHERE request_id = $1`,
        [dead.id],
      )
    ).rows[0] as Record<string, unknown>;
    assert.deepEqual(
      [state.effective_status, state.sealed, state.terminal_status],
      ['expired', true, null],
      'the head is effectively expired with NO durable decision yet',
    );

    await assert.rejects(
      insertV2Request(h.pool, {
        ...base, target: 'blog/dead.md', body: 'revised', expiresAt: now + DAY_MS, createdAt: now, version: 2,
      }),
      /expired/,
      'a revision of an effectively-expired head must be refused',
    );
    // ...and G+1 stays refused until the expiry is DURABLE (round 5's rule), so
    // an expired head accepts nothing at all until its decision is recorded.
    await assert.rejects(
      insertV2Request(h.pool, {
        ...base, target: 'blog/dead.md', body: 'next', expiresAt: now + DAY_MS, createdAt: now,
        generation: 2, version: 1,
      }),
      /still open/,
      'G+1 over an unmaterialized expiry must stay refused',
    );
    assert.equal(
      (await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE id = $1`, [dead.id])).rows[0]!.n,
      1,
      'the expired generation never grew a version',
    );

    // The one legal way forward, and the one the store takes: materialize the
    // expiry, THEN open the next generation.
    await insertDecision(h.pool, {
      id: 'dead-expired', requestId: dead.id, generation: 1, version: 1, status: 'expired', createdAt: now,
    });
    await assert.rejects(
      insertV2Request(h.pool, {
        ...base, target: 'blog/dead.md', body: 'revised', expiresAt: now + DAY_MS, createdAt: now, version: 2,
      }),
      /sealed/,
      'a decided generation is sealed against a revision',
    );
    await insertV2Request(h.pool, {
      ...base, target: 'blog/dead.md', body: 'next', expiresAt: now + DAY_MS, createdAt: now,
      generation: 2, version: 1,
    });
    const head = (
      await h.pool.query(`SELECT generation, version FROM hitl.request_state WHERE request_id = $1`, [dead.id])
    ).rows[0] as Record<string, number>;
    assert.deepEqual([Number(head.generation), Number(head.version)], [2, 1]);

    // A LIVE head is still revisable — the block is effective expiry, not age.
    const live = await insertV2Request(h.pool, {
      ...base, target: 'blog/live.md', body: 'a', expiresAt: now + DAY_MS, createdAt: now,
    });
    await insertV2Request(h.pool, {
      ...base, target: 'blog/live.md', body: 'b', expiresAt: now + DAY_MS, createdAt: now + 1, version: 2,
    });
    const liveHead = (
      await h.pool.query(`SELECT generation, version FROM hitl.request_state WHERE request_id = $1`, [live.id])
    ).rows[0] as Record<string, number>;
    assert.deepEqual([Number(liveHead.generation), Number(liveHead.version)], [1, 2]);

    // ...and an EDITORIAL request may be open-ended (expires_at NULL), so the
    // expiry rule never applies to it.
    const editorial = await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'approve-draft', target: 'blog/editorial.md', body: 'a',
      expiresAt: null, createdAt: now,
    });
    await insertV2Request(h.pool, {
      functionName: 'marketing', action: 'approve-draft', target: 'blog/editorial.md', body: 'b',
      expiresAt: null, createdAt: now + 1, version: 2,
    });
    const editorialHead = (
      await h.pool.query(`SELECT generation, version FROM hitl.request_state WHERE request_id = $1`, [editorial.id])
    ).rows[0] as Record<string, number>;
    assert.deepEqual([Number(editorialHead.generation), Number(editorialHead.version)], [1, 2]);
  } finally {
    await h.close();
  }
});

// R6 finding 3: canonicalization_version is DERIVED like every other identity
// column — the stored value must EQUAL the value the row's own content proves
// (1 when the content hash covers the content, else 0). Accepting any positive
// value a writer chose, or a 0 over verified content, made the column a label
// rather than a derivation, and the docs already promised the derivation.
test('R6-3: canonicalization_version must EQUAL the derived value, not merely be plausible', opts, async () => {
  const h = await makeDb();
  try {
    await runMigrations(h.pool, HITL_DIR, HITL_MIGRATION_TARGET);
    const now = Date.now();
    const base = { functionName: 'marketing', action: 'publish-post', expiresAt: now + DAY_MS } as const;

    // A verified row may not understate itself...
    await assert.rejects(
      insertV2Request(h.pool, {
        ...base, target: 'blog/understated.md', body: 'a', createdAt: now, canonicalizationVersion: 0,
      }),
      /canonicalization_version/,
      'version 0 over VERIFIED content must be refused',
    );
    // ...nor claim a version this schema does not derive (the TS side ships
    // exactly one, so a "forward-compatible" 2 is an unverifiable assertion).
    await assert.rejects(
      insertV2Request(h.pool, {
        ...base, target: 'blog/forward.md', body: 'a', createdAt: now, canonicalizationVersion: 2,
      }),
      /canonicalization_version/,
      'a positive version other than the derived 1 must be refused',
    );
    // ...and an unverified row may not claim verification (round 3).
    await assert.rejects(
      insertV2Request(h.pool, {
        ...base, target: 'blog/liar.md', body: 'a', contentHash: 'f'.repeat(64), createdAt: now,
        canonicalizationVersion: 1,
      }),
      /canonicalization_version/,
      'version 1 over UNVERIFIED content must be refused',
    );
    assert.equal(
      (await h.pool.query(`SELECT count(*)::int AS n FROM hitl.requests WHERE workspace_id = $1::uuid`, [WS]))
        .rows[0]!.n,
      0,
      'nothing landed',
    );

    // Both DERIVED values still land: verified => 1, legacy-exempt => 0.
    const verified = await insertV2Request(h.pool, {
      ...base, target: 'blog/verified.md', body: 'a', createdAt: now, canonicalizationVersion: 1,
    });
    const exempt = await insertV2Request(h.pool, {
      ...base, target: 'blog/exempt.md', body: 'a', contentHash: 'f'.repeat(64), createdAt: now,
      canonicalizationVersion: 0,
    });
    const stored = (
      await h.pool.query(
        `SELECT id, canonicalization_version FROM hitl.requests WHERE workspace_id = $1::uuid ORDER BY id`,
        [WS],
      )
    ).rows as Array<{ id: string; canonicalization_version: number }>;
    assert.deepEqual(
      new Map(stored.map((r) => [r.id, r.canonicalization_version])),
      new Map([
        [verified.id, 1],
        [exempt.id, 0],
      ]),
    );
  } finally {
    await h.close();
  }
});
