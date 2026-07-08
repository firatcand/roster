import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { saveEntity } from '../src/lib/brain/save.ts';
import { appendEvent } from '../src/lib/brain/event.ts';
import { createLink } from '../src/lib/brain/link.ts';
import { getEntity } from '../src/lib/brain/get.ts';
import { createTable, listTables } from '../src/lib/brain/table.ts';
import { runReadOnlyQuery, isReadOnlyQuery } from '../src/lib/brain/sql.ts';

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

// ---------- arg parsing ----------

test('parseBrainArgs: save happy path with field + data + attribution', () => {
  const r = parseBrainArgs([
    'save', '--kind', 'person', '--slug', 'a', '--title', 'A',
    '--field', 'role=eng', '--data', '{"team":"infra","level":3}',
    '--source', 'slack', '--confidence', '0.8', '--actor', 'bot', '--json',
  ]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'save') throw new Error('wrong shape');
  assert.equal(r.entKind, 'person');
  assert.equal(r.slug, 'a');
  assert.equal(r.title, 'A');
  assert.equal(r.source, 'slack');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.actor, 'bot');
  assert.deepEqual(r.fields, [
    { key: 'role', value: 'eng' },
    { key: 'team', value: 'infra' },
    { key: 'level', value: 3 },
  ]);
});

test('parseBrainArgs: save requires --kind and --slug', () => {
  assert.equal(parseBrainArgs(['save', '--slug', 'x']).kind, 'err');
  assert.equal(parseBrainArgs(['save', '--kind', 'x']).kind, 'err');
});

test('parseBrainArgs: save --field without = errors', () => {
  assert.equal(parseBrainArgs(['save', '--kind', 'p', '--slug', 's', '--field', 'noeq']).kind, 'err');
});

test('parseBrainArgs: save --data non-object errors', () => {
  assert.equal(parseBrainArgs(['save', '--kind', 'p', '--slug', 's', '--data', '[1,2]']).kind, 'err');
  assert.equal(parseBrainArgs(['save', '--kind', 'p', '--slug', 's', '--data', 'notjson']).kind, 'err');
});

test('parseBrainArgs: save --confidence non-number errors', () => {
  assert.equal(parseBrainArgs(['save', '--kind', 'p', '--slug', 's', '--confidence', 'high']).kind, 'err');
});

test('parseBrainArgs: event requires --kind, slug optional', () => {
  const r = parseBrainArgs(['event', '--kind', 'login', '--slug', 'a', '--data', '{"ip":"1"}', '--actor', 'svc']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'event') throw new Error('wrong shape');
  assert.equal(r.entKind, 'login');
  assert.equal(r.slug, 'a');
  assert.deepEqual(r.payload, { ip: '1' });
  assert.equal(parseBrainArgs(['event', '--slug', 'a']).kind, 'err');
});

test('parseBrainArgs: link needs exactly 3 positionals', () => {
  const r = parseBrainArgs(['link', 'src', 'rel', 'dst', '--kind-src', 'person', '--props', '{"w":1}']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'link') throw new Error('wrong shape');
  assert.equal(r.srcSlug, 'src');
  assert.equal(r.rel, 'rel');
  assert.equal(r.dstSlug, 'dst');
  assert.equal(r.kindSrc, 'person');
  assert.deepEqual(r.props, { w: 1 });
  assert.equal(parseBrainArgs(['link', 'a', 'b']).kind, 'err');
});

test('parseBrainArgs: get requires --kind and --slug', () => {
  assert.equal(parseBrainArgs(['get', '--kind', 'p', '--slug', 's']).kind, 'ok');
  assert.equal(parseBrainArgs(['get', '--kind', 'p']).kind, 'err');
});

test('parseBrainArgs: table create / list', () => {
  const c = parseBrainArgs(['table', 'create', 'notes', '--col', 'body:text', '--col', 'n:int']);
  assert.equal(c.kind, 'ok');
  if (c.kind !== 'ok' || c.subcommand !== 'table' || c.op !== 'create') throw new Error('wrong shape');
  assert.equal(c.name, 'notes');
  assert.deepEqual(c.columns, [{ name: 'body', type: 'text' }, { name: 'n', type: 'int' }]);

  const l = parseBrainArgs(['table', 'list']);
  assert.equal(l.kind, 'ok');
  if (l.kind !== 'ok' || l.subcommand !== 'table' || l.op !== 'list') throw new Error('wrong shape');

  assert.equal(parseBrainArgs(['table', 'create', 'notes']).kind, 'err'); // no cols
  assert.equal(parseBrainArgs(['table', 'create']).kind, 'err'); // no name
  assert.equal(parseBrainArgs(['table', 'bogus']).kind, 'err');
});

test('parseBrainArgs: sql requires one query', () => {
  const r = parseBrainArgs(['sql', 'SELECT 1']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'sql') throw new Error('wrong shape');
  assert.equal(r.query, 'SELECT 1');
  assert.equal(parseBrainArgs(['sql']).kind, 'err');
});

test('isReadOnlyQuery guard: select/with pass, others rejected', () => {
  assert.equal(isReadOnlyQuery('SELECT 1'), true);
  assert.equal(isReadOnlyQuery('  select * from x'), true);
  assert.equal(isReadOnlyQuery('WITH t AS (SELECT 1) SELECT * FROM t'), true);
  assert.equal(isReadOnlyQuery('INSERT INTO x VALUES (1)'), false);
  assert.equal(isReadOnlyQuery('UPDATE x SET y=1'), false);
  assert.equal(isReadOnlyQuery('DELETE FROM x'), false);
  assert.equal(isReadOnlyQuery('DROP TABLE x'), false);
});


// ---------- save → get round trip ----------

test('save → get round trip returns latest fact (version/latest-wins)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const first = await saveEntity(rt, { kind: 'person', slug: 'alice', title: 'Alice', fields: [{ key: 'role', value: 'eng' }] });
    assert.equal(first.created, true);
    assert.equal(first.factIds.length, 1);

    const truth = await getEntity(rt, 'person', 'alice');
    assert.equal(truth.entity!.title, 'Alice');
    const role = truth.facts.find((f) => f.key === 'role');
    assert.equal(role!.value, 'eng');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('re-save same field appends a NEW fact row; get returns the newest; entity is create-once', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const a = await saveEntity(rt, { kind: 'person', slug: 'bob', title: 'Bob', fields: [{ key: 'role', value: 'ic' }] });
    assert.equal(a.created, true);
    const b = await saveEntity(rt, { kind: 'person', slug: 'bob', title: 'IGNORED', fields: [{ key: 'role', value: 'manager' }] });
    assert.equal(b.created, false, 'second save resolves the existing entity (ON CONFLICT DO NOTHING)');
    assert.equal(a.entityId, b.entityId, 'same entity id reused');

    // entity row immutable: title stays the original (no UPDATE)
    const truth = await getEntity(rt, 'person', 'bob');
    assert.equal(truth.entity!.title, 'Bob');

    const role = truth.facts.find((f) => f.key === 'role');
    assert.equal(role!.value, 'manager', 'current_facts returns newest fact');

    // two distinct fact rows exist for the key
    const allRoleFacts = await rt.query(
      `SELECT value FROM brain.facts WHERE entity_id = $1 AND key = 'role' ORDER BY id`,
      [a.entityId],
    );
    assert.equal(allRoleFacts.rowCount, 2, 'a new fact row is appended, not updated');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('attribution: source/confidence/actor persisted and surfaced by get', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, {
      kind: 'person', slug: 'carol', fields: [{ key: 'role', value: 'eng' }],
      source: 'slack', confidence: 0.75, actor: 'agent-x',
    });
    const truth = await getEntity(rt, 'person', 'carol');
    const f = truth.facts.find((x) => x.key === 'role')!;
    assert.equal(f.source, 'slack');
    assert.equal(f.confidence, 0.75);
    assert.equal(f.actor, 'agent-x');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('--data fans out to per-key facts; get shows each key', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const parsed = parseBrainArgs(['save', '--kind', 'person', '--slug', 'dave', '--data', '{"team":"infra","level":3,"nested":{"k":"v"}}']);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind !== 'ok' || parsed.subcommand !== 'save') throw new Error('bad');
    await saveEntity(rt, { kind: parsed.entKind, slug: parsed.slug, fields: parsed.fields });

    const truth = await getEntity(rt, 'person', 'dave');
    const keys = new Map(truth.facts.map((f) => [f.key, f.value]));
    assert.equal(keys.get('team'), 'infra');
    assert.equal(keys.get('level'), 3);
    assert.deepEqual(keys.get('nested'), { k: 'v' }, 'nested object stored whole, not deep-flattened');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('concurrent save of same slug (Promise.all of N) yields exactly one entity; facts all appended', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const N = 8;
  const clients = await Promise.all(
    Array.from({ length: N }, () => runtimeClient(fresh.url, password, fresh.role)),
  );
  try {
    const results = await Promise.all(
      clients.map((c, i) => saveEntity(c, { kind: 'person', slug: 'race', fields: [{ key: 'n', value: i }] })),
    );
    const entityIds = new Set(results.map((r) => r.entityId));
    assert.equal(entityIds.size, 1, 'all concurrent saves resolve to exactly one entity');

    const createdCount = results.filter((r) => r.created).length;
    assert.equal(createdCount, 1, 'exactly one save reports created=true');

    const admin = clients[0]!;
    const ents = await admin.query(`SELECT count(*)::int AS c FROM brain.entities WHERE kind='person' AND slug='race'`);
    assert.equal(ents.rows[0]!.c, 1, 'exactly one entity row exists');
    const facts = await admin.query(`SELECT count(*)::int AS c FROM brain.facts WHERE key='n'`);
    assert.equal(facts.rows[0]!.c, N, 'every concurrent save appended its fact');
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await teardown();
  }
});

// ---------- event + link ----------

test('event append (with and without slug); get shows it', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'person', slug: 'eve', fields: [] });
    const ev = await appendEvent(rt, { kind: 'login', slug: 'eve', payload: { ip: '10.0.0.1' }, actor: 'svc' });
    assert.ok(ev.entityId);
    assert.ok(ev.eventId);

    const detached = await appendEvent(rt, { kind: 'system-boot', payload: null });
    assert.equal(detached.entityId, null);

    const truth = await getEntity(rt, 'person', 'eve');
    assert.equal(truth.events.length, 1);
    assert.equal(truth.events[0]!.kind, 'login');
    assert.equal(truth.events[0]!.actor, 'svc');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('link creates an edge; get shows it on both endpoints', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'person', slug: 'frank', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'acme', fields: [] });
    const edge = await createLink(rt, { srcSlug: 'frank', rel: 'works_at', dstSlug: 'acme', actor: 'bot', props: { since: 2020 } });
    assert.ok(edge.edgeId);

    const src = await getEntity(rt, 'person', 'frank');
    assert.equal(src.edges.length, 1);
    assert.equal(src.edges[0]!.direction, 'out');
    assert.equal(src.edges[0]!.rel, 'works_at');
    assert.equal(src.edges[0]!.other_slug, 'acme');

    const dst = await getEntity(rt, 'org', 'acme');
    assert.equal(dst.edges.length, 1);
    assert.equal(dst.edges[0]!.direction, 'in');
    assert.equal(dst.edges[0]!.other_slug, 'frank');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('get on a missing entity returns null entity', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const truth = await getEntity(rt, 'person', 'nobody');
    assert.equal(truth.entity, null);
    assert.deepEqual(truth.facts, []);
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- sql ----------

test('sql "SELECT 1" works as runtime', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const r = await runReadOnlyQuery(rt, 'SELECT 1 AS one');
    assert.equal(r.rowCount, 1);
    assert.equal((r.rows[0] as { one: number }).one, 1);
  } finally {
    await rt.end();
    await teardown();
  }
});

test('sql rejects a plain non-SELECT via the keyword guard', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(
      runReadOnlyQuery(rt, "INSERT INTO brain.entities (kind, slug) VALUES ('person','x')"),
      /only SELECT\/WITH queries are allowed/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('sql rejects a CTE write via the READ ONLY transaction (passes keyword guard, blocked by txn)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const cteWrite =
      "WITH w AS (INSERT INTO brain.entities (kind, slug) VALUES ('person','cte') RETURNING id) SELECT * FROM w";
    // Leading keyword is WITH, so the guard lets it through; the read-only txn must block it.
    assert.equal(isReadOnlyQuery(cteWrite), true);
    await assert.rejects(runReadOnlyQuery(rt, cteWrite), /read-only transaction|cannot execute/i);

    // And nothing was written.
    const cnt = await rt.query(`SELECT count(*)::int AS c FROM brain.entities WHERE slug='cte'`);
    assert.equal(cnt.rows[0]!.c, 0, 'CTE write must have been rolled back');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('sql rejects a multi-statement COMMIT-injection (single-statement extended protocol)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    // Leading keyword is SELECT so the guard passes; the COMMIT would end the
    // read-only txn and the trailing INSERT would run unconstrained. The
    // extended protocol must reject multiple commands outright.
    const inject =
      "SELECT 1; COMMIT; INSERT INTO brain.entities (kind, slug) VALUES ('person','inj')";
    assert.equal(isReadOnlyQuery(inject), true);
    await assert.rejects(runReadOnlyQuery(rt, inject), /multiple commands/i);

    // Dollar-quote-identifier bypass: `a$tag$` is a valid identifier, NOT a
    // dollar-quote opener — a hand-rolled scanner mis-tokenizes it, but the
    // prepared-statement parser rejects the trailing commands.
    const dollarInject =
      "SELECT 1 AS a$tag$; COMMIT; INSERT INTO brain.entities (kind, slug) VALUES ('person','inj2')";
    assert.equal(isReadOnlyQuery(dollarInject), true);
    await assert.rejects(runReadOnlyQuery(rt, dollarInject), /multiple commands/i);

    const cnt = await rt.query(
      `SELECT count(*)::int AS c FROM brain.entities WHERE slug IN ('inj','inj2')`,
    );
    assert.equal(cnt.rows[0]!.c, 0, 'no row may be written via multi-statement injection');
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- table ----------

test('table create yields a brokered admin-owned table; table list shows it', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await createTable(rt, 'memos', [{ name: 'body', type: 'text' }, { name: 'score', type: 'int' }]);

    const owner = await rt.query(
      `SELECT o.rolname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles o ON o.oid = c.relowner
        WHERE n.nspname = 'brain' AND c.relname = 'memos'`,
    );
    assert.notEqual(owner.rows[0]!.rolname, fresh.role, 'brokered table is admin-owned, not runtime-owned');

    const tables = await listTables(rt);
    const memos = tables.find((t) => t.name === 'memos');
    assert.ok(memos, 'table list surfaces the new user table');
    assert.ok(memos!.columns.some((c) => c.name === 'body'));
    assert.ok(!tables.some((t) => t.name === 'entities'), 'core tables excluded from list by default');
    assert.ok(!tables.some((t) => t.name === 'files'), 'the file ledger is core, not an agent table');

    // runtime can INSERT + SELECT but not UPDATE the brokered table
    await rt.query(`INSERT INTO brain.memos (body, score) VALUES ('hi', 1)`);
    await assert.rejects(rt.query(`UPDATE brain.memos SET score = 9`), /permission denied/i);
  } finally {
    await rt.end();
    await teardown();
  }
});
