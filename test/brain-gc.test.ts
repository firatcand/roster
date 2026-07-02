import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole, buildRuntimeUrl } from '../src/lib/brain/roles.ts';
import {
  DEFAULT_RETENTION,
  countEligible,
  parseRetention,
  preflightGc,
  resolveRetention,
  runGc,
} from '../src/lib/brain/gc.ts';
import { parseConfigValue, setConfig } from '../src/lib/brain/config.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { executeBrainGc } from '../src/commands/brain.ts';
import { RosterError } from '../src/lib/errors.ts';
import { ADMIN_URL, HAS_DB, createFreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

// --- hermetic: duration grammar + parser + config allowlist -------------------

test('parseRetention accepts <N>d|<N>mo|<N>y and rejects everything else', () => {
  assert.equal(parseRetention('730d'), '730 days');
  assert.equal(parseRetention('18mo'), '18 months');
  assert.equal(parseRetention('2y'), '2 years');
  for (const bad of ['2w', 'd', '0d', '-3d', '1.5y', '2 years', '', '99999999999999999999d']) {
    assert.throws(() => parseRetention(bad), /invalid retention/);
  }
});

test('parseBrainArgs: gc flags', () => {
  assert.deepEqual(parseBrainArgs(['gc']), {
    kind: 'ok', subcommand: 'gc', json: false, olderThan: undefined, yes: false,
  });
  assert.deepEqual(parseBrainArgs(['gc', '--older-than', '18mo', '--yes', '--json']), {
    kind: 'ok', subcommand: 'gc', json: true, olderThan: '18mo', yes: true,
  });
  assert.equal(parseBrainArgs(['gc', '--older-than']).kind, 'err');
  assert.equal(parseBrainArgs(['gc', '--nope']).kind, 'err');
  assert.equal(parseBrainArgs(['gc', 'positional']).kind, 'err');
});

test('config allowlist: gc.retention validates the duration grammar', () => {
  assert.equal(parseConfigValue('gc.retention', '2y'), '2y');
  assert.throws(() => parseConfigValue('gc.retention', '2w'), /invalid retention/);
});

// --- DB fixtures ---------------------------------------------------------------

type Fixture = { pool: pg.Pool; drop: () => Promise<void>; url: string; role: string };

async function provision(): Promise<Fixture> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
  } catch (err) {
    await pool.end();
    await fresh.drop();
    throw err;
  }
  return {
    pool,
    url: fresh.url,
    role: fresh.role,
    drop: async () => {
      await pool.end();
      await fresh.drop();
    },
  };
}

async function insertEntity(pool: pg.Pool, slug: string): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO brain.entities (kind, slug) VALUES ('t', $1) RETURNING id`,
    [slug],
  );
  return Number(r.rows[0]!.id);
}

async function insertFact(
  pool: pg.Pool,
  entityId: number,
  key: string,
  value: string,
  age: string,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO brain.facts (recorded_at, entity_id, key, value)
     VALUES (now() - $4::interval, $1, $2, to_jsonb($3::text)) RETURNING id`,
    [entityId, key, value, age],
  );
  return Number(r.rows[0]!.id);
}

async function insertMount(
  pool: pg.Pool,
  sourcePath: string,
  age: string,
  chunks: string[],
): Promise<{ mountId: number; chunkIds: number[] }> {
  const m = await pool.query<{ id: number }>(
    `INSERT INTO brain.mounts (recorded_at, source_path, file_hash)
     VALUES (now() - $2::interval, $1, md5($1 || $2)) RETURNING id`,
    [sourcePath, age],
  );
  const mountId = Number(m.rows[0]!.id);
  const chunkIds: number[] = [];
  for (const [i, content] of chunks.entries()) {
    const d = await pool.query<{ id: number }>(
      `INSERT INTO brain.documents (recorded_at, source_path, chunk_index, content, content_hash, mount_id)
       VALUES (now() - $5::interval, $1, $2, $3, md5($3), $4) RETURNING id`,
      [sourcePath, i, content, mountId, age],
    );
    chunkIds.push(Number(d.rows[0]!.id));
  }
  return { mountId, chunkIds };
}

async function factIds(pool: pg.Pool): Promise<number[]> {
  const r = await pool.query<{ id: number }>(`SELECT id FROM brain.facts ORDER BY id`);
  return r.rows.map((row) => Number(row.id));
}

// --- the load-bearing invariant --------------------------------------------------

test('gc deletes only superseded-long-ago rows; current and recently-superseded survive', opts, async () => {
  const fx = await provision();
  try {
    const e1 = await insertEntity(fx.pool, 'e1');
    const v1 = await insertFact(fx.pool, e1, 'k', 'v1', '4 years'); // superseded 3y ago -> eligible
    const v2 = await insertFact(fx.pool, e1, 'k', 'v2', '3 years'); // superseded yesterday -> SURVIVES (age since superseded)
    const v3 = await insertFact(fx.pool, e1, 'k', 'v3', '1 day'); // current -> survives

    const e2 = await insertEntity(fx.pool, 'e2');
    const ancientCurrent = await insertFact(fx.pool, e2, 'k', 'only', '5 years'); // current-but-ancient -> SURVIVES

    const eligible = await withBrainClient(fx.pool, (c) => countEligible(c, '2 years'));
    assert.equal(eligible.facts, 1);

    const deleted = await runGc(fx.pool, { interval: '2 years' });
    assert.equal(deleted.facts, 1);
    assert.deepEqual(await factIds(fx.pool), [v2, v3, ancientCurrent].sort((a, b) => a - b));
    assert.ok(!(await factIds(fx.pool)).includes(v1));

    const again = await runGc(fx.pool, { interval: '2 years' });
    assert.equal(again.facts, 0, 're-run must be a no-op');
  } finally {
    await fx.drop();
  }
});

test('gc never touches edges or events even when superseded/ancient (design: visible history)', opts, async () => {
  const fx = await provision();
  try {
    const a = await insertEntity(fx.pool, 'a');
    const b = await insertEntity(fx.pool, 'b');
    await fx.pool.query(
      `INSERT INTO brain.edges (recorded_at, src_id, dst_id, rel)
       VALUES (now() - interval '5 years', $1, $2, 'r'), (now() - interval '4 years', $1, $2, 'r')`,
      [a, b],
    );
    await fx.pool.query(
      `INSERT INTO brain.events (recorded_at, entity_id, kind)
       VALUES (now() - interval '5 years', $1, 'ev')`,
      [a],
    );
    await runGc(fx.pool, { interval: '2 years' });
    const edges = await fx.pool.query(`SELECT count(*) AS n FROM brain.edges`);
    const events = await fx.pool.query(`SELECT count(*) AS n FROM brain.events`);
    assert.equal(Number(edges.rows[0]!.n), 2);
    assert.equal(Number(events.rows[0]!.n), 1);
  } finally {
    await fx.drop();
  }
});

test('gc prunes chunks of long-superseded mounts; empty mounts never supersede', opts, async () => {
  const fx = await provision();
  try {
    // A: m1 (5y, chunks) superseded by m2 (3y, chunks) -> m1 chunks eligible;
    //    m2 superseded by m3 (1 day, chunks) -> m2 chunks survive; m3 current.
    const m1 = await insertMount(fx.pool, 'a.md', '5 years', ['a-old-1', 'a-old-2']);
    const m2 = await insertMount(fx.pool, 'a.md', '3 years', ['a-mid']);
    const m3 = await insertMount(fx.pool, 'a.md', '1 day', ['a-new']);

    // B: only mount with chunks (4y) then a LATEST EMPTY mount -> chunks survive
    //    (mirrors current_documents' with-chunks guard).
    const b1 = await insertMount(fx.pool, 'b.md', '4 years', ['b-only']);
    await insertMount(fx.pool, 'b.md', '1 day', []);

    // C: chunks (4y), then an EMPTY mount (3y), then chunks (1y). The empty
    //    mount must not provide the supersession timestamp: real supersession
    //    was 1y ago < 2y retention, so c1 chunks SURVIVE. A wrong implementation
    //    keyed on any later mount would delete them (3y > 2y).
    const c1 = await insertMount(fx.pool, 'c.md', '4 years', ['c-old']);
    await insertMount(fx.pool, 'c.md', '3 years', []);
    await insertMount(fx.pool, 'c.md', '1 year', ['c-new']);

    const eligible = await withBrainClient(fx.pool, (c) => countEligible(c, '2 years'));
    assert.equal(eligible.documents, m1.chunkIds.length);

    const deleted = await runGc(fx.pool, { interval: '2 years' });
    assert.equal(deleted.documents, 2);

    const left = await fx.pool.query<{ id: number }>(`SELECT id FROM brain.documents ORDER BY id`);
    const leftIds = left.rows.map((r) => Number(r.id));
    for (const id of m1.chunkIds) assert.ok(!leftIds.includes(id), 'm1 chunks must be pruned');
    for (const id of [...m2.chunkIds, ...m3.chunkIds, ...b1.chunkIds, ...c1.chunkIds]) {
      assert.ok(leftIds.includes(id), `chunk ${id} must survive`);
    }
    const mounts = await fx.pool.query(`SELECT count(*) AS n FROM brain.mounts`);
    assert.equal(Number(mounts.rows[0]!.n), 8, 'mounts rows are never deleted');
  } finally {
    await fx.drop();
  }
});

test('read-time results are identical before and after gc (incl. merged entities)', opts, async () => {
  const fx = await provision();
  try {
    const e1 = await insertEntity(fx.pool, 'm-from');
    const e2 = await insertEntity(fx.pool, 'm-into');
    await insertFact(fx.pool, e1, 'shared', 'from-old', '4 years');
    await insertFact(fx.pool, e1, 'shared', 'from-new', '3 years');
    await insertFact(fx.pool, e2, 'shared', 'into-current', '1 day');
    await fx.pool.query(`SELECT * FROM brain.merge_entities($1, $2, 'test')`, [e1, e2]);
    await insertMount(fx.pool, 'x.md', '5 years', ['x-old']);
    await insertMount(fx.pool, 'x.md', '3 years', ['x-new']);

    const snapshot = async () => ({
      currentFacts: (await fx.pool.query(`SELECT * FROM brain.current_facts ORDER BY id`)).rows,
      resolved: (await fx.pool.query(`SELECT * FROM brain.resolved_current_facts ORDER BY id`)).rows,
      currentDocs: (await fx.pool.query(`SELECT * FROM brain.current_documents ORDER BY id`)).rows,
      canonical: (await fx.pool.query(`SELECT id, brain.canonical_id(id) AS cid FROM brain.entities ORDER BY id`)).rows,
    });

    const before = await snapshot();
    const deleted = await runGc(fx.pool, { interval: '2 years' });
    assert.ok(deleted.facts + deleted.documents > 0, 'fixture must actually delete something');
    const after = await snapshot();
    assert.deepEqual(after, before);
  } finally {
    await fx.drop();
  }
});

// --- batching, locking, retention resolution ----------------------------------

test('gc drains eligible rows across multiple batches', opts, async () => {
  const fx = await provision();
  try {
    const e = await insertEntity(fx.pool, 'bulk');
    for (let i = 0; i < 12; i++) {
      await insertFact(fx.pool, e, `k${i}`, 'old', '4 years');
      await insertFact(fx.pool, e, `k${i}`, 'new', '3 years');
    }
    const deleted = await runGc(fx.pool, { interval: '2 years', batchSize: 5 });
    assert.equal(deleted.facts, 12);
  } finally {
    await fx.drop();
  }
});

test('non-monotonic recorded_at cannot widen the delete set — within a run or across reruns', opts, async () => {
  const fx = await provision();
  try {
    const e = await insertEntity(fx.pool, 'nm');
    const id1 = await insertFact(fx.pool, e, 'k', 'v1', '5 years');
    const id2 = await insertFact(fx.pool, e, 'k', 'v2', '1 day'); // recent ts, mid id
    const id3 = await insertFact(fx.pool, e, 'k', 'v3', '3 years'); // highest id, old ts
    // id1's immediate superseder (id2) is 1 day old -> id1 must survive. id2 is
    // itself 1 day old -> the own-age arm protects it even though its successor
    // (id3) carries an old timestamp. So NOTHING here is deletable — and that
    // must hold on a rerun too: deleting id2 would re-anchor id1 to id3 and
    // wrongly widen the set on the next run (Codex rounds 1-2).
    for (let run = 0; run < 2; run++) {
      const deleted = await runGc(fx.pool, { interval: '2 years', batchSize: 1 });
      assert.equal(deleted.facts, 0, `run ${run + 1} must delete nothing`);
    }
    assert.deepEqual(await factIds(fx.pool), [id1, id2, id3]);
  } finally {
    await fx.drop();
  }
});

test('non-monotonic mount timestamps cannot over-delete document chunks, incl. reruns', opts, async () => {
  const fx = await provision();
  try {
    // m1 (5y) superseded by m2 whose ts is RECENT (1d) even though a later
    // mount m3 carries an old ts (3y). m1's actual superseder is m2 -> m1's
    // chunks survive; m2's chunks are 1 day old -> own-age arm protects them.
    const m1 = await insertMount(fx.pool, 'nm.md', '5 years', ['nm-old']);
    const m2 = await insertMount(fx.pool, 'nm.md', '1 day', ['nm-mid']);
    const m3 = await insertMount(fx.pool, 'nm.md', '3 years', ['nm-new']);
    for (let run = 0; run < 2; run++) {
      const deleted = await runGc(fx.pool, { interval: '2 years' });
      assert.equal(deleted.documents, 0, `run ${run + 1} must delete nothing`);
    }
    const left = await fx.pool.query<{ id: number }>(`SELECT id FROM brain.documents ORDER BY id`);
    assert.deepEqual(
      left.rows.map((r) => Number(r.id)),
      [...m1.chunkIds, ...m2.chunkIds, ...m3.chunkIds],
    );
  } finally {
    await fx.drop();
  }
});

test('gc refuses to run concurrently (advisory lock)', opts, async () => {
  const fx = await provision();
  try {
    const holder = new pg.Client({ connectionString: fx.url });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(8135136)`);
      await assert.rejects(
        () => runGc(fx.pool, { interval: '2 years' }),
        /another brain gc run holds the lock/,
      );
    } finally {
      await holder.end();
    }
  } finally {
    await fx.drop();
  }
});

test('retention precedence: flag > gc.retention config > 730d default', opts, async () => {
  const fx = await provision();
  try {
    await withBrainClient(fx.pool, async (c) => {
      assert.deepEqual(await resolveRetention(c), { raw: DEFAULT_RETENTION, interval: '730 days' });
      await setConfig(c, 'gc.retention', '1y');
      assert.deepEqual(await resolveRetention(c), { raw: '1y', interval: '1 years' });
      assert.deepEqual(await resolveRetention(c, '30d'), { raw: '30d', interval: '30 days' });
      await assert.rejects(() => resolveRetention(c, 'nope'), /invalid retention/);
    });
  } finally {
    await fx.drop();
  }
});

// --- CLI surface ----------------------------------------------------------------

function captureLogs(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return lines;
}

test('executeBrainGc: preview by default writes nothing; --yes deletes; re-run no-ops', opts, async (t) => {
  const fx = await provision();
  try {
    const e = await insertEntity(fx.pool, 'cli');
    await insertFact(fx.pool, e, 'k', 'old', '4 years');
    await insertFact(fx.pool, e, 'k', 'new', '3 years');

    const lines = captureLogs(t);
    assert.equal(await executeBrainGc({ json: true, yes: false, adminUrl: fx.url }), 0);
    const preview = JSON.parse(lines.at(-1)!);
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.retention, DEFAULT_RETENTION);
    assert.equal(preview.eligible.facts, 1);
    assert.equal((await factIds(fx.pool)).length, 2, 'preview must not delete');

    assert.equal(await executeBrainGc({ json: true, yes: true, adminUrl: fx.url }), 0);
    const ran = JSON.parse(lines.at(-1)!);
    assert.equal(ran.mode, 'delete');
    assert.equal(ran.deleted.facts, 1);
    assert.equal((await factIds(fx.pool)).length, 1);

    assert.equal(await executeBrainGc({ json: true, yes: true, adminUrl: fx.url }), 0);
    const rerun = JSON.parse(lines.at(-1)!);
    assert.equal(rerun.mode, 'preview');
    assert.equal(rerun.eligible.facts, 0);
  } finally {
    await fx.drop();
  }
});

test('executeBrainGc: refuses a runtime-role URL with a clear message', opts, async () => {
  const fx = await provision();
  try {
    const role = await withBrainClient(fx.pool, (c) => ensureRuntimeRole(c, fx.role));
    assert.ok(role.password);
    const runtimeUrl = buildRuntimeUrl(fx.url, role.password!, fx.role);
    await assert.rejects(
      () => executeBrainGc({ json: false, yes: true, adminUrl: runtimeUrl }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /brain gc refused/);
        return true;
      },
    );
  } finally {
    await fx.drop();
  }
});

test('preflightGc: missing schema is refused', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    const pre = await withBrainClient(pool, (c) => preflightGc(c));
    assert.deepEqual(pre, {
      ok: false,
      reason: 'missing-schema',
      detail: 'brain schema not found — run roster brain init first',
    });
  } finally {
    await pool.end();
    await fresh.drop();
  }
});

test('preflightGc: a role with DELETE on facts but not documents is refused', opts, async () => {
  const fx = await provision();
  const suffix = Math.random().toString(36).slice(2, 10);
  const partial = `gcp_${suffix}`;
  const password = `pw_${suffix}`;
  try {
    await fx.pool.query(`CREATE ROLE ${partial} LOGIN PASSWORD '${password}'`);
    await fx.pool.query(`GRANT USAGE ON SCHEMA brain, brain_meta TO ${partial}`);
    await fx.pool.query(`GRANT SELECT ON brain_meta.runtime_roles TO ${partial}`);
    await fx.pool.query(`GRANT SELECT, DELETE ON brain.facts TO ${partial}`);

    const partialUrl = new URL(fx.url);
    partialUrl.username = partial;
    partialUrl.password = password;
    const client = new pg.Client({ connectionString: partialUrl.toString() });
    await client.connect();
    try {
      const pre = await preflightGc(client);
      assert.deepEqual(pre, {
        ok: false,
        reason: 'missing-delete',
        detail: 'role lacks DELETE on brain.documents',
      });
    } finally {
      await client.end();
    }
  } finally {
    const dbName = new URL(fx.url).pathname.slice(1);
    await fx.drop();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    try {
      await root.query(`DROP ROLE IF EXISTS ${partial}`);
    } finally {
      await root.end();
    }
    void dbName;
  }
});
