import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPersistenceConfig,
  persistenceConfigPath,
  hitlExpiryOf,
  DEFAULT_HITL_EXPIRY_CONFIG,
  PERSISTENCE_YAML_VERSION,
  isUuidV4,
} from '../src/lib/persistence/config-schema.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  NotConfiguredError,
  PersistenceError,
  VersionSkewError,
  WorkspaceMismatchError,
  canonicalJson,
  computeRecordId,
  sha256Hex,
  type Cursor,
  type HitlRequestInput,
  type OpsBackend,
} from '../src/lib/persistence/contracts.ts';
import { createLocalBackend } from '../src/lib/persistence/local/stores.ts';
import { runOpsMigrations } from '../src/lib/persistence/postgres/migrate.ts';
import { BoundPool, finalizeBinding, stampPending } from '../src/lib/persistence/postgres/binding.ts';
import { createPgBackend } from '../src/lib/persistence/postgres/stores.ts';
import { CreateOnlyFileStore, workspaceMarkerSha256 } from '../src/lib/persistence/objects.ts';
import { MemoryFileStore } from '../src/lib/persistence/s3-core.ts';
import { RosterError, EXIT_ERROR } from '../src/lib/errors.ts';

// #318 stage 2: section A config loader tests + the backend-agnostic store
// contract suite (section C) run against the local backend (section D).
// Stage 4 adds a postgres-s3 factory to the same `factories` list.

// ---------------- section A: persistence.yaml ----------------

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'roster-pcfg-'));
}

function writeConfig(cwd: string, yaml: string): void {
  mkdirSync(join(cwd, 'roster'), { recursive: true });
  writeFileSync(persistenceConfigPath(cwd), yaml);
}

const WS_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const VALID_LOCAL = `version: 1
workspace:
  id: ${WS_ID}
  name: acme
backend: local
`;

const VALID_PG = `version: 1
workspace:
  id: ${WS_ID}
  name: acme
backend: postgres-s3
postgres:
  database: brain
objects:
  bucket: acme-ops
  region: us-east-1
  endpoint: https://minio.example:9000
  force_path_style: true
`;

function expectConfigError(cwd: string, ...needles: string[]): RosterError {
  try {
    loadPersistenceConfig(cwd);
  } catch (err) {
    assert.ok(err instanceof RosterError, `expected RosterError, got ${String(err)}`);
    assert.equal(err.exitCode, EXIT_ERROR);
    const text = `${err.header}\n${err.body}\n${err.remedy}`;
    for (const needle of needles) {
      assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    return err;
  }
  assert.fail('expected loadPersistenceConfig to throw');
}

test('config: absent file resolves legacy-implicit local default', () => {
  const cwd = tmpWorkspace();
  try {
    const loaded = loadPersistenceConfig(cwd);
    assert.deepEqual(loaded, { state: 'legacy-implicit', backend: 'local', legacy: true, config: null });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: valid local file resolves configured-local with parsed workspace', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_LOCAL);
    const loaded = loadPersistenceConfig(cwd);
    assert.equal(loaded.state, 'configured-local');
    assert.equal(loaded.backend, 'local');
    assert.equal(loaded.legacy, false);
    assert.ok(loaded.config);
    assert.equal(loaded.config.workspace.id, WS_ID);
    assert.equal(loaded.config.workspace.name, 'acme');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: valid postgres-s3 file resolves postgres-s3 state with objects tuple', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_PG);
    const loaded = loadPersistenceConfig(cwd);
    assert.equal(loaded.state, 'postgres-s3');
    assert.equal(loaded.backend, 'postgres-s3');
    assert.ok(loaded.config);
    assert.equal(loaded.config.postgres.database, 'brain');
    assert.deepEqual(loaded.config.objects, {
      bucket: 'acme-ops',
      region: 'us-east-1',
      endpoint: 'https://minio.example:9000',
      force_path_style: true,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: omitted region/endpoint default to null, force_path_style to false', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(
      cwd,
      `version: 1\nworkspace:\n  id: ${WS_ID}\n  name: acme\nbackend: postgres-s3\npostgres:\n  database: dedicated\nobjects:\n  bucket: acme-ops\n`,
    );
    const loaded = loadPersistenceConfig(cwd);
    assert.equal(loaded.state, 'postgres-s3');
    assert.ok(loaded.config);
    assert.deepEqual(loaded.config.objects, {
      bucket: 'acme-ops',
      region: null,
      endpoint: null,
      force_path_style: false,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: non-v4 workspace id rejected naming workspace.id', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_LOCAL.replace(WS_ID, 'not-a-uuid'));
    expectConfigError(cwd, 'workspace.id', 'UUID v4');
    // a v1 UUID (version nibble 1) must also fail
    writeConfig(cwd, VALID_LOCAL.replace(WS_ID, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'));
    expectConfigError(cwd, 'workspace.id');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: unknown keys rejected at top level and nested', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_LOCAL + 'mystery: true\n');
    expectConfigError(cwd, 'mystery');
    writeConfig(cwd, VALID_LOCAL.replace('  name: acme\n', '  name: acme\n  secret: hunter2\n'));
    expectConfigError(cwd, 'secret');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: postgres/objects blocks forbidden when backend is local', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_LOCAL + 'postgres:\n  database: brain\n');
    expectConfigError(cwd, 'postgres');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: postgres-s3 requires postgres and objects blocks', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, `version: 1\nworkspace:\n  id: ${WS_ID}\n  name: acme\nbackend: postgres-s3\n`);
    const err = expectConfigError(cwd, 'postgres');
    assert.match(`${err.body}`, /objects/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: endpoint rejects userinfo and non-http(s) schemes', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_PG.replace('https://minio.example:9000', 'https://user:pass@minio.example:9000'));
    expectConfigError(cwd, 'objects.endpoint', 'env-only');
    writeConfig(cwd, VALID_PG.replace('https://minio.example:9000', 'ftp://minio.example'));
    expectConfigError(cwd, 'objects.endpoint', 'http(s)');
    writeConfig(cwd, VALID_PG.replace('https://minio.example:9000', 'not a url'));
    expectConfigError(cwd, 'objects.endpoint');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: bucket name rules enforced', () => {
  const cwd = tmpWorkspace();
  try {
    for (const bad of ['ab', 'A-Upper', 'has_underscore', '-leading', 'trailing-', 'a'.repeat(64)]) {
      writeConfig(cwd, VALID_PG.replace('bucket: acme-ops', `bucket: "${bad}"`));
      expectConfigError(cwd, 'objects.bucket');
    }
    writeConfig(cwd, VALID_PG.replace('bucket: acme-ops', 'bucket: a.b-3'));
    assert.equal(loadPersistenceConfig(cwd).state, 'postgres-s3');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: future version yields actionable upgrade error, not field errors', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_LOCAL.replace('version: 1', 'version: 2') + 'field_from_the_future: yes\n');
    const err = expectConfigError(cwd, 'newer roster', 'version: 2', 'npm install -g @firatcand/roster@latest');
    assert.doesNotMatch(`${err.body}`, /field_from_the_future/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: missing or non-integer version rejected naming version', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_LOCAL.replace('version: 1\n', ''));
    expectConfigError(cwd, 'version');
    writeConfig(cwd, VALID_LOCAL.replace('version: 1', 'version: one'));
    expectConfigError(cwd, 'version');
    writeConfig(cwd, VALID_LOCAL.replace('version: 1', 'version: 0'));
    expectConfigError(cwd, 'version');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: malformed YAML and non-mapping documents rejected', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, 'version: [unclosed\n');
    expectConfigError(cwd, 'YAML');
    writeConfig(cwd, '- just\n- a\n- list\n');
    expectConfigError(cwd, 'mapping');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: postgres.database restricted to brain|dedicated', () => {
  const cwd = tmpWorkspace();
  try {
    writeConfig(cwd, VALID_PG.replace('database: brain', 'database: sqlite'));
    expectConfigError(cwd, 'postgres.database');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: the optional hitl.expiry block parses, defaults, and refuses incoherent bounds', () => {
  const cwd = tmpWorkspace();
  try {
    // Absent → the built-in policy (24h TTL, 1h..7d bounds).
    writeConfig(cwd, VALID_LOCAL);
    assert.deepEqual(hitlExpiryOf(loadPersistenceConfig(cwd).config), DEFAULT_HITL_EXPIRY_CONFIG);

    writeConfig(cwd, `${VALID_LOCAL}\nhitl:\n  expiry:\n    default_ttl_ms: 7200000\n    min_ttl_ms: 3600000\n    max_ttl_ms: 14400000\n`);
    assert.deepEqual(hitlExpiryOf(loadPersistenceConfig(cwd).config), {
      defaultTtlMs: 7_200_000,
      minTtlMs: 3_600_000,
      maxTtlMs: 14_400_000,
    });

    // Partial blocks fall back to the per-field defaults.
    writeConfig(cwd, `${VALID_LOCAL}\nhitl:\n  expiry:\n    default_ttl_ms: 7200000\n`);
    assert.deepEqual(hitlExpiryOf(loadPersistenceConfig(cwd).config), {
      defaultTtlMs: 7_200_000,
      minTtlMs: DEFAULT_HITL_EXPIRY_CONFIG.minTtlMs,
      maxTtlMs: DEFAULT_HITL_EXPIRY_CONFIG.maxTtlMs,
    });

    // Incoherent bounds are a config error, not a silent clamp.
    writeConfig(cwd, `${VALID_LOCAL}\nhitl:\n  expiry:\n    min_ttl_ms: 100000\n    max_ttl_ms: 1000\n`);
    expectConfigError(cwd, 'hitl.expiry.min_ttl_ms');
    writeConfig(cwd, `${VALID_LOCAL}\nhitl:\n  expiry:\n    default_ttl_ms: 999\n    min_ttl_ms: 1000\n    max_ttl_ms: 2000\n`);
    expectConfigError(cwd, 'hitl.expiry.default_ttl_ms');
    writeConfig(cwd, `${VALID_LOCAL}\nhitl:\n  expiry:\n    default_ttl_ms: -5\n`);
    expectConfigError(cwd, 'hitl.expiry.default_ttl_ms');
    // Unknown keys inside the block are rejected like everywhere else.
    writeConfig(cwd, `${VALID_LOCAL}\nhitl:\n  expiry:\n    ttl: 5\n`);
    expectConfigError(cwd, 'Unrecognized key');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config: version constant and uuid helper exported', () => {
  assert.equal(PERSISTENCE_YAML_VERSION, 1);
  assert.equal(isUuidV4(WS_ID), true);
  assert.equal(isUuidV4('nope'), false);
});

// ---------------- section C contracts (parameterized suite) ----------------

test('contracts: error taxonomy classes extend PersistenceError', () => {
  const errors = [
    new NotConfiguredError('x'),
    new BackendUnavailableError('x'),
    new WorkspaceMismatchError('x'),
    new ConflictError('id', 'x'),
    new VersionSkewError('x'),
    new InvalidRecordError('x'),
  ];
  for (const err of errors) {
    assert.ok(err instanceof PersistenceError);
    assert.ok(err instanceof Error);
  }
  assert.equal(new ConflictError('abc', 'x').id, 'abc');
  assert.equal(new NotConfiguredError('x').name, 'NotConfiguredError');
});

test('contracts: computeRecordId is deterministic, key-order-insensitive, workspace+namespace scoped', () => {
  const a = computeRecordId('ws-1', 'hitl', { b: 2, a: 1 });
  const b = computeRecordId('ws-1', 'hitl', { a: 1, b: 2 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, computeRecordId('ws-2', 'hitl', { a: 1, b: 2 }));
  assert.notEqual(a, computeRecordId('ws-1', 'runs', { a: 1, b: 2 }));
  assert.equal(canonicalJson({ b: [1, { d: 4, c: 3 }], a: null }), '{"a":null,"b":[1,{"c":3,"d":4}]}');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('canonicalJson resolves toJSON BEFORE sorting keys (multi-key toJSON output is canonicalized)', () => {
  // The round-trip must collapse toJSON to plain data first, THEN recursively
  // sort — otherwise a toJSON-returned object is stringified in its own order
  // and its checksum breaks on re-canonicalization after recovery.
  const value = { toJSON() { return { z: 1, a: 2 }; } };
  assert.equal(canonicalJson(value), '{"a":2,"z":1}');
  // nested toJSON is sorted too
  const nested = { outer: { toJSON() { return { y: 2, x: 1 }; } }, a: 0 };
  assert.equal(canonicalJson(nested), '{"a":0,"outer":{"x":1,"y":2}}');
  // idempotence across a round-trip (what ledger recovery relies on)
  const canonical = canonicalJson(value);
  assert.equal(canonicalJson(JSON.parse(canonical)), canonical);
});

test('canonicalJson preserves an own __proto__ member as data (no prototype-pollution drop, no hash collision)', () => {
  // Parsed JSON can carry an own "__proto__" key (JSON.parse creates it as an
  // own data property). Re-keying it into a plain {} would hit Object.prototype's
  // setter and silently DROP it — payload loss + a hash collision with {a:1}.
  const parsed = JSON.parse('{"__proto__":{"admin":true},"a":1}');
  const canonical = canonicalJson(parsed);
  // The member survives (sorted: __proto__ < a) and differs from a bare {a:1}.
  assert.equal(canonical, '{"__proto__":{"admin":true},"a":1}');
  assert.notEqual(canonical, canonicalJson({ a: 1 }));
  // No actual prototype pollution occurred.
  assert.equal(({} as Record<string, unknown>).admin, undefined);
  // Sibling prototype-polluting keys are preserved as data too.
  assert.equal(
    canonicalJson(JSON.parse('{"constructor":{"x":1},"b":2}')),
    '{"b":2,"constructor":{"x":1}}',
  );
  // A record id / payload hash therefore CANNOT collide across payloads that
  // differ only by the polluting member — a replay is a Conflict, not a dedup.
  assert.notEqual(
    computeRecordId('ws', 'runs', JSON.parse('{"__proto__":{"admin":true}}')),
    computeRecordId('ws', 'runs', {}),
  );
  assert.equal(({} as Record<string, unknown>).admin, undefined);
});

type ContractHarness = {
  backend: OpsBackend;
  workspaceId: string;
  sibling: () => Promise<OpsBackend>;
  cleanup: () => void | Promise<void>;
};

type Factory = { name: string; skip: string | false; create: () => Promise<ContractHarness> };

const localFactory: Factory = {
  name: 'local',
  skip: false,
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-contract-'));
    const opsRoot = join(dir, '.roster', 'ops');
    const workspaceId = randomUUID();
    // #319: HITL expiry is evaluated against the REAL clock on the postgres
    // backend (hitl.now_ms() = clock_timestamp(), inside the view + the decision
    // trigger), so a fixed 2023 test clock would mint requests that are already
    // expired. Both factories therefore tick from real time.
    const clock = { t: Date.now() };
    const backend = createLocalBackend({ opsRoot, workspaceId, now: () => ++clock.t });
    return {
      backend,
      workspaceId,
      sibling: async () => createLocalBackend({ opsRoot, workspaceId: randomUUID(), now: () => ++clock.t }),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
};

// postgres-s3: one throwaway database + one memory-backed object store per
// workspace (strict 1:1 binding — a sibling is a wholly separate database, the
// physical-isolation model of owner decision 5).
const OPS_ADMIN_URL = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';

type PgWorkspace = { backend: OpsBackend; workspaceId: string; pool: BoundPool; db: string };

async function rootOpsQuery(sql: string): Promise<void> {
  const { default: pg } = await import('pg');
  const root = new pg.Client({ connectionString: OPS_ADMIN_URL });
  await root.connect();
  try {
    await root.query(sql);
  } finally {
    await root.end();
  }
}

async function makePgWorkspace(clock: { t: number }): Promise<PgWorkspace> {
  const { default: pg } = await import('pg');
  const workspaceId = randomUUID();
  const db = `ops_contract_${randomUUID().slice(0, 8)}${Date.now().toString(36)}`;
  await rootOpsQuery(`CREATE DATABASE ${db}`);
  const url = new URL(OPS_ADMIN_URL);
  url.pathname = '/' + db;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
  try {
    await runOpsMigrations(admin);
    await stampPending(admin, {
      workspaceId,
      workspaceName: 'contract',
      objects: {
        bucket: 'contract-ops',
        region: null,
        endpoint: null,
        forcePathStyle: false,
        markerSha256: workspaceMarkerSha256({ workspaceId, name: 'contract' }),
      },
    });
    await finalizeBinding(admin, { workspaceId });
  } finally {
    await admin.end();
  }
  const pool = new BoundPool({ connectionString: url.toString(), workspaceId, max: 2 });
  const objects = new CreateOnlyFileStore(new MemoryFileStore());
  const backend = createPgBackend({ pool, objects, now: () => ++clock.t });
  return { backend, workspaceId, pool, db };
}

async function dropPgWorkspace(w: PgWorkspace): Promise<void> {
  await w.pool.end().catch(() => {});
  await rootOpsQuery(`DROP DATABASE IF EXISTS ${w.db} WITH (FORCE)`).catch(() => {});
}

const pgFactory: Factory = {
  name: 'postgres-s3',
  skip: OPS_ADMIN_URL.length > 0 ? false : 'ROSTER_OPS_TEST_ADMIN_URL not set',
  create: async () => {
    const clock = { t: Date.now() };
    const primary = await makePgWorkspace(clock);
    const extras: PgWorkspace[] = [];
    return {
      backend: primary.backend,
      workspaceId: primary.workspaceId,
      sibling: async () => {
        const w = await makePgWorkspace(clock);
        extras.push(w);
        return w.backend;
      },
      cleanup: async () => {
        for (const w of [primary, ...extras]) await dropPgWorkspace(w);
      },
    };
  },
};

// Every test below must stay backend-agnostic (no ledger/file assertions —
// those live in persistence-ledger.test.ts).
const factories: Factory[] = [localFactory, pgFactory];

// #319: identity is (functionName, action, target) — the CONTENT is not in the
// key, so a changed body revises the same group. The content hash is verified
// server-side, so the fixture always derives it from the body it ships.
function requestInput(overrides: Partial<HitlRequestInput> = {}): HitlRequestInput {
  const base: HitlRequestInput = {
    functionName: 'marketing',
    title: 'Approve launch post',
    action: 'publish-post',
    target: 'blog/launch.md',
    contentHash: '',
    body: 'Please review the launch post draft.',
    expiresAt: null,
    // D1: every submission states the head it observed (null = no history).
    expectedHead: null,
    ...overrides,
  };
  return { ...base, contentHash: overrides.contentHash ?? sha256Hex(base.body) };
}

for (const factory of factories) {
  const t = (name: string) => `contracts[${factory.name}]: ${name}`;

  test(t('createRequest commits with a deterministic full-length id and round-trips'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const outcome = await h.backend.hitl.createRequest(requestInput());
      assert.equal(outcome.outcome, 'committed');
      assert.match(outcome.id, /^[0-9a-f]{64}$/);
      const env = await h.backend.hitl.getRequest(outcome.id);
      assert.ok(env);
      assert.equal(env.workspaceId, h.workspaceId);
      assert.equal(env.status, 'awaiting');
      assert.equal(env.functionName, 'marketing');
      assert.equal(env.action, 'publish-post');
      assert.equal(env.target, 'blog/launch.md');
      assert.equal(typeof env.createdAt, 'number');
      assert.ok(env.seq !== null && env.seq >= 1);
      assert.equal(await h.backend.hitl.getRequest(sha256Hex('missing')), null);
    } finally {
      await h.cleanup();
    }
  });

  test(t('createRequest replay with identical input is idempotent (no duplicate, same id)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const first = await h.backend.hitl.createRequest(requestInput());
      // A BLIND at-least-once retry: the caller re-sends the same packet with
      // the same "no history" expectation. `expiresAt` is packet identity and
      // this fixture leaves it to the server, so the retry must pin the head's
      // own deadline — a freshly derived default TTL is a genuinely different
      // packet, and the store says so instead of silently re-versioning.
      const head = await h.backend.hitl.getRequest(first.requestId);
      assert.ok(head !== null);
      const second = await h.backend.hitl.createRequest(requestInput({ expiresAt: head.expiresAt }));
      assert.equal(second.id, first.id);
      assert.equal(second.outcome, 'committed');
      assert.equal(second.idempotent, true, 'the retry is an idempotent no-op, not a second version');
      assert.deepEqual([second.generation, second.version], [first.generation, first.version]);
      assert.equal((await h.backend.hitl.listVersions(first.requestId)).length, 1);
      // ...and a retry whose packet actually DIFFERS is refused, not silently
      // applied on top of a head the caller never read.
      await assert.rejects(
        h.backend.hitl.createRequest(requestInput({ expiresAt: (head.expiresAt ?? 0) + 1000 })),
        ConflictError,
      );
      const page = await h.backend.hitl.listRequests({});
      assert.equal(page.items.length, 1);
      assert.deepEqual(await h.backend.hitl.count(), { committed: 1, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('a same-key packet change revises in place; a stale expectedHead conflicts synchronously'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const first = await h.backend.hitl.createRequest(requestInput());
      assert.equal(first.generation, 1);
      assert.equal(first.version, 1);
      const head = await h.backend.hitl.getRequest(first.requestId);
      assert.ok(head !== null);
      // A revised packet is version 2 of the SAME group, never a second request.
      // The revision states the head it observed (D1) — a DIFFERENT packet can
      // never ride a "no history" expectation.
      const revised = await h.backend.hitl.createRequest(
        requestInput({
          body: 'A revised packet.',
          expectedHead: {
            generation: head.generation,
            version: head.version,
            packetHash: head.packetHash,
            sealed: head.sealed,
          },
        }),
      );
      assert.equal(revised.requestId, first.requestId);
      assert.equal(revised.generation, 1);
      assert.equal(revised.version, 2);
      assert.equal(revised.idempotent, false);
      // ...and a caller that still believes v1 is current is refused under the
      // lock rather than silently forking the history.
      await assert.rejects(
        h.backend.hitl.createRequest(
          requestInput({
            body: 'Another edit from a stale reader.',
            expectedHead: { generation: 1, version: 1, packetHash: head.packetHash, sealed: false },
          }),
        ),
        ConflictError,
      );
      // A different TARGET is a different group.
      const other = await h.backend.hitl.createRequest(requestInput({ target: 'blog/other.md' }));
      assert.notEqual(other.requestId, first.requestId);
      assert.deepEqual(await h.backend.hitl.count(), { committed: 2, queued: 0, partial: false });
      const versions = await h.backend.hitl.listVersions(first.requestId);
      assert.deepEqual(versions.map((v) => [v.generation, v.version]), [[1, 1], [1, 2]]);
    } finally {
      await h.cleanup();
    }
  });

  test(t('appendDecision commits (never queued) and rejects the awaiting status'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const req = await h.backend.hitl.createRequest(requestInput());
      const outcome = await h.backend.hitl.appendDecision({
        requestId: req.requestId,
        generation: req.generation,
        requestVersion: req.version,
        status: 'approved',
        decidedBy: 'firat',
        note: null,
      });
      assert.equal(outcome.outcome, 'committed');
      assert.match(outcome.id, /^[0-9a-f]{64}$/);
      await assert.rejects(
        h.backend.hitl.appendDecision({
          requestId: req.requestId,
          generation: req.generation,
          requestVersion: req.version,
          // deliberately illegal at runtime — awaiting is not a decision
          status: 'awaiting' as never,
          decidedBy: 'firat',
          note: null,
        }),
        InvalidRecordError,
      );
      // An approved head is sealed AND authoritative, and leaves the queue.
      const decided = await h.backend.hitl.getRequest(req.requestId);
      assert.ok(decided !== null);
      assert.equal(decided.status, 'approved');
      assert.equal(decided.sealed, true);
      assert.equal(decided.authoritative, true);
      assert.deepEqual(await h.backend.hitl.count(), { committed: 0, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('listRequests pages in seq order with a stable committed-seq watermark'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      for (let i = 1; i <= 5; i++) {
        await h.backend.hitl.createRequest(requestInput({ target: `blog/draft-${i}.md` }));
      }
      const page1 = await h.backend.hitl.listRequests({ limit: 2 });
      assert.equal(page1.items.length, 2);
      assert.equal(page1.partial, false);
      assert.ok(page1.cursor);
      const watermark = page1.cursor.watermark;
      assert.ok(watermark >= 5);
      // a request created mid-pagination must NOT leak into later pages…
      await h.backend.hitl.createRequest(requestInput({ target: 'blog/draft-6.md' }));
      const page2 = await h.backend.hitl.listRequests({ limit: 2 }, page1.cursor);
      assert.equal(page2.items.length, 2);
      assert.ok(page2.cursor);
      assert.equal(page2.cursor.watermark, watermark);
      const page3 = await h.backend.hitl.listRequests({ limit: 2 }, page2.cursor);
      assert.equal(page3.items.length, 1);
      assert.equal(page3.cursor, null);
      const seqs = [...page1.items, ...page2.items, ...page3.items].map((r) => r.seq!);
      assert.deepEqual(
        seqs,
        [...seqs].sort((a, b) => a - b),
      );
      assert.equal(new Set(seqs).size, 5);
      // …while a fresh listing observes the new state
      const fresh = await h.backend.hitl.listRequests({});
      assert.equal(fresh.items.length, 6);
    } finally {
      await h.cleanup();
    }
  });

  test(t('count() has the explicit {committed, queued, partial} shape and honors filters'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      await h.backend.hitl.createRequest(requestInput());
      await h.backend.hitl.createRequest(requestInput({ functionName: 'sales' }));
      assert.deepEqual(await h.backend.hitl.count(), { committed: 2, queued: 0, partial: false });
      assert.deepEqual(await h.backend.hitl.count({ functionName: 'sales' }), {
        committed: 1,
        queued: 0,
        partial: false,
      });
      assert.deepEqual(await h.backend.hitl.count({ status: 'approved' }), {
        committed: 0,
        queued: 0,
        partial: false,
      });
      assert.deepEqual(await h.backend.runs.count(), { committed: 0, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('run events: ordered reads, idempotent replay, conflict on dedupeKey reuse with different data'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      for (let i = 1; i <= 3; i++) {
        const outcome = await h.backend.runs.appendEvent({
          runId: 'run-a',
          kind: 'tool-call',
          correlationId: `evt-${i}`,
          data: { n: i },
        });
        assert.equal(outcome.outcome, 'committed');
      }
      const replay = await h.backend.runs.appendEvent({
        runId: 'run-a',
        kind: 'tool-call',
        correlationId: 'evt-2',
        data: { n: 2 },
      });
      assert.equal(replay.outcome, 'committed');
      await assert.rejects(
        h.backend.runs.appendEvent({ runId: 'run-a', kind: 'tool-call', correlationId: 'evt-2', data: { n: 99 } }),
        ConflictError,
      );
      const run = await h.backend.runs.getRun('run-a');
      assert.ok(run);
      assert.equal(run.events.length, 3);
      assert.deepEqual(
        run.events.map((e) => (e.data as { n: number }).n),
        [1, 2, 3],
      );
      const seqs = run.events.map((e) => e.seq!);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      assert.equal(await h.backend.runs.getRun('run-missing'), null);
      const runs = await h.backend.runs.listRuns({});
      assert.equal(runs.items.length, 1);
      assert.equal(runs.items[0]!.events, 3);
      assert.equal(runs.items[0]!.runId, 'run-a');
      assert.deepEqual(await h.backend.runs.count(), { committed: 1, queued: 0, partial: false });
    } finally {
      await h.cleanup();
    }
  });

  test(t('run events: observation columns (source default cli, agent override, lifecycle timestamps, sanitized report)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      // A lifecycle event written through the store defaults to the trusted 'cli'
      // source and stamps a pid + started_at (Rev3-R2-1 / R2-2).
      await h.backend.runs.appendEvent({ runId: 'obs', kind: 'run-start', data: null });
      // An agent-authored report stamps 'agent' (DERIVED from the report kind,
      // not caller-supplied) and its prose is sanitized into sanitized_report — a
      // planted secret never lands in the projection column.
      await h.backend.runs.appendEvent({
        runId: 'obs',
        kind: 'report',
        data: 'published; the token is ghp_1234567890abcdefghijABCDEFGHIJ1234 fyi',
      });
      await h.backend.runs.appendEvent({ runId: 'obs', kind: 'run-end', data: null });

      const run = await h.backend.runs.getRun('obs');
      assert.ok(run);
      const start = run.events.find((e) => e.kind === 'run-start')!;
      const report = run.events.find((e) => e.kind === 'report')!;
      const end = run.events.find((e) => e.kind === 'run-end')!;

      assert.equal(start.source, 'cli', 'the RunStore write path defaults to the trusted cli source');
      assert.ok(typeof start.pid === 'string' && start.pid.length > 0, 'pid is stamped');
      assert.ok(typeof start.startedAt === 'number', 'run-start stamps started_at');
      assert.equal(start.sanitizedReport, null);

      assert.equal(report.source, 'agent', 'the agent report path stamps agent');
      assert.ok(report.sanitizedReport !== null, 'report prose is sanitized at write');
      assert.ok(
        !report.sanitizedReport.includes('ghp_1234567890abcdefghijABCDEFGHIJ1234'),
        'the secret never reaches sanitized_report',
      );

      assert.ok(typeof end.endedAt === 'number', 'run-end stamps ended_at');
    } finally {
      await h.cleanup();
    }
  });

  test(t('artifacts: content-addressed put/get/head, idempotent replay, identical-bytes/different-meta DEDUP (content-only identity), no delete'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const bytes = Buffer.from('artifact bytes v1');
      const meta = { filename: 'report.md', contentType: 'text/markdown', runId: null };
      const put = await h.backend.artifacts.putArtifact(meta, bytes);
      assert.equal(put.outcome, 'committed');
      assert.equal(put.digest, sha256Hex(bytes));
      const got = await h.backend.artifacts.getArtifact(put.digest);
      assert.ok(got);
      assert.deepEqual(got.bytes, bytes);
      assert.deepEqual(got.record.meta, meta);
      assert.equal(got.record.size, bytes.length);
      const headed = await h.backend.artifacts.head(put.digest);
      assert.ok(headed);
      assert.equal(headed.digest, put.digest);
      const replay = await h.backend.artifacts.putArtifact(meta, bytes);
      assert.equal(replay.id, put.id);
      // Finding 4: the blob identity is CONTENT-ONLY (digest+size). Re-declaring
      // identical bytes with DIFFERENT meta is NOT a conflict — it dedups to one
      // blob (first writer's meta wins); run metadata belongs on declarations.
      const renamed = await h.backend.artifacts.putArtifact({ ...meta, filename: 'renamed.md' }, bytes);
      assert.equal(renamed.id, put.id, 'identical bytes reuse the one blob id');
      assert.equal(renamed.digest, put.digest);
      const afterRename = await h.backend.artifacts.getArtifact(put.digest);
      assert.deepEqual(afterRename!.record.meta, meta, 'the first writer meta is retained (no clobber, no conflict)');
      assert.equal(await h.backend.artifacts.getArtifact(sha256Hex('missing')), null);
      assert.equal(await h.backend.artifacts.head(sha256Hex('missing')), null);
      for (const forbidden of ['del', 'delete', 'remove', 'deleteArtifact']) {
        assert.ok(
          !(forbidden in (h.backend.artifacts as unknown as Record<string, unknown>)),
          `ArtifactStore must not expose ${forbidden}()`,
        );
      }
    } finally {
      await h.cleanup();
    }
  });

  test(t('artifact declarations: internal put writes a declaration, getByRun + getDeclaration round-trip (parity)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const bytes = Buffer.from('report body v1');
      const meta = { filename: 'r.md', contentType: 'text/markdown', runId: null };
      const put = await h.backend.artifacts.putArtifact(meta, bytes, {
        runId: 'run-a',
        declaringAgent: 'sdr',
        role: 'produced',
        artifactType: 'report',
        mediaType: 'text/markdown',
        text: 'the api_key=SUPERsecretVALUE123456 is in here',
      });
      assert.equal(put.digest, sha256Hex(bytes));
      assert.ok(put.declarationId, 'an internal put with a declaration context returns a declarationId');
      // objectVersionId is a string on a versioned object store, null on local.
      assert.ok(put.objectVersionId === null || typeof put.objectVersionId === 'string');

      const decl = await h.backend.artifacts.getDeclaration(put.declarationId!);
      assert.ok(decl);
      assert.equal(decl.kind, 'internal');
      assert.equal(decl.digest, put.digest);
      assert.equal(decl.runId, 'run-a');
      assert.equal(decl.declaringAgent, 'sdr');
      assert.equal(decl.role, 'produced');
      assert.equal(decl.verified, true, 'internal (digest-verified) content is verified');
      assert.equal(decl.artifactType, 'report');
      // the declaration prose is sanitized — the planted secret never lands
      assert.ok(decl.sanitizedText !== null);
      assert.ok(!decl.sanitizedText.includes('SUPERsecretVALUE123456'), 'declaration text is sanitized at write');

      const byRun = await h.backend.artifacts.getByRun('run-a');
      assert.equal(byRun.length, 1);
      assert.equal(byRun[0]!.id, put.declarationId);
      assert.equal(await h.backend.artifacts.getDeclaration(sha256Hex('missing')), null);
      assert.deepEqual(await h.backend.artifacts.getByRun('run-none'), []);
    } finally {
      await h.cleanup();
    }
  });

  test(t('artifact declarations: two runs, identical bytes → one blob + two declarations; produced+used → two rows'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const bytes = Buffer.from('shared bytes');
      const digest = sha256Hex(bytes);

      // Finding 4: run A and run B declare IDENTICAL bytes with DIFFERENT meta.
      // The blob identity is content-only, so this must NOT ConflictError — it
      // yields ONE blob row (first meta wins) + TWO declarations.
      const a = await h.backend.artifacts.putArtifact(
        { filename: 'a-report.bin', contentType: 'application/octet-stream', runId: 'run-a' },
        bytes,
        { runId: 'run-a', declaringAgent: 'sdr' },
      );
      const b = await h.backend.artifacts.putArtifact(
        { filename: 'b-DIFFERENT.bin', contentType: 'text/plain', runId: 'run-b' },
        bytes,
        { runId: 'run-b', declaringAgent: 'sdr' },
      );
      assert.equal(a.digest, digest);
      assert.equal(b.digest, digest);
      assert.equal(a.blobOutcome, 'committed');
      assert.equal(b.blobOutcome, 'committed', 'the second identical-bytes/different-meta blob dedups, never conflicts');
      assert.notEqual(a.declarationId, b.declarationId, 'different runs → different declaration ids');
      // ONE content blob for the identical bytes (deduped by digest); first meta wins.
      const head = await h.backend.artifacts.head(digest);
      assert.ok(head);
      assert.equal(head.meta.filename, 'a-report.bin', 'the first writer meta is retained');
      assert.equal((await h.backend.artifacts.getByRun('run-a')).length, 1);
      assert.equal((await h.backend.artifacts.getByRun('run-b')).length, 1);

      // produced + used of the SAME ref by the SAME run/agent → two rows (role in id).
      const cMeta = { filename: 'x.bin', contentType: 'application/octet-stream', runId: null };
      const produced = await h.backend.artifacts.putArtifact(cMeta, bytes, { runId: 'run-c', declaringAgent: 'sdr', role: 'produced' });
      const used = await h.backend.artifacts.putArtifact(cMeta, bytes, { runId: 'run-c', declaringAgent: 'sdr', role: 'used' });
      assert.notEqual(produced.declarationId, used.declarationId, 'produced vs used of the same ref are distinct declarations');
      const runC = await h.backend.artifacts.getByRun('run-c');
      assert.equal(runC.length, 2);
      assert.deepEqual(new Set(runC.map((d) => d.role)), new Set(['produced', 'used']));
    } finally {
      await h.cleanup();
    }
  });

  test(t('artifact declarations: unserializable (circular) provenance throws BEFORE any blob write (no orphan)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const bytes = Buffer.from('provenance-guard bytes');
      const digest = sha256Hex(bytes);
      const circular: Record<string, unknown> = {};
      circular.self = circular; // JSON.stringify throws on this
      await assert.rejects(
        h.backend.artifacts.putArtifact(
          { filename: 'p.md', contentType: 'text/markdown', runId: 'run-p' },
          bytes,
          { runId: 'run-p', declaringAgent: 'sdr', role: 'produced', provenance: circular },
        ),
        InvalidRecordError,
      );
      // The complete declaration is snapshotted before any upload/spool/blob
      // append, so the failure leaves NO blob and NO declaration (finding: the
      // blob committed, THEN provenance serialization threw — orphaning the blob).
      assert.equal(await h.backend.artifacts.head(digest), null, 'no blob written / uploaded');
      assert.deepEqual(await h.backend.artifacts.getByRun('run-p'), [], 'no declaration');
    } finally {
      await h.cleanup();
    }
  });

  test(t('putExternal: delimiter-ambiguous provider:externalId pairs get DISTINCT declaration ids (framed, not colon-joined)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      // provider='a:b',id='c' and provider='a',id='b:c' both colon-join to 'a:b:c'
      // — a raw join collided. A length-prefixed frame keeps them distinct.
      const one = await h.backend.artifacts.putExternal({ runId: 'run-amb', declaringAgent: 'sdr', role: 'used', provider: 'a:b', externalId: 'c' });
      const two = await h.backend.artifacts.putExternal({ runId: 'run-amb', declaringAgent: 'sdr', role: 'used', provider: 'a', externalId: 'b:c' });
      assert.notEqual(one.id, two.id, 'the two ambiguous pairs produce DIFFERENT declaration ids');
      const decls = await h.backend.artifacts.getByRun('run-amb');
      assert.equal(decls.length, 2, 'both external declarations coexist (no false payload conflict)');
    } finally {
      await h.cleanup();
    }
  });

  test(t('artifact declarations: putExternal writes a declaration-only row (no digest, unverified)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const res = await h.backend.artifacts.putExternal({
        runId: 'run-x',
        declaringAgent: 'sdr',
        provider: 'notion',
        externalId: 'page-42',
        externalUrl: 'https://notion.so/page-42',
        artifactType: 'doc',
        text: 'the doc lives at token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      });
      assert.match(res.id, /^[0-9a-f]{64}$/);
      const decl = await h.backend.artifacts.getDeclaration(res.id);
      assert.ok(decl);
      assert.equal(decl.kind, 'external');
      assert.equal(decl.digest, null, 'external declarations carry no digest');
      assert.equal(decl.provider, 'notion');
      assert.equal(decl.externalId, 'page-42');
      assert.equal(decl.verified, false, 'external stays unverified until a host attestation exists');
      assert.equal(decl.versionState, null);
      assert.ok(decl.sanitizedText !== null && !decl.sanitizedText.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
      const byRun = await h.backend.artifacts.getByRun('run-x');
      assert.equal(byRun.length, 1);
      assert.equal(byRun[0]!.kind, 'external');
    } finally {
      await h.cleanup();
    }
  });

  test(t('artifact declarations: a bare put (no declaration context) writes only a blob'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const bytes = Buffer.from('no declaration bytes');
      const put = await h.backend.artifacts.putArtifact(
        { filename: 'b.txt', contentType: 'text/plain', runId: null },
        bytes,
      );
      assert.equal(put.declarationId, null, 'no declaration context → no declaration');
      assert.ok(await h.backend.artifacts.head(put.digest), 'the blob still lands');
      assert.deepEqual(await h.backend.artifacts.getByRun('anything'), []);
    } finally {
      await h.cleanup();
    }
  });

  test(t('workspace scoping: a sibling workspace on the same infrastructure sees nothing'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      await h.backend.hitl.createRequest(requestInput());
      await h.backend.runs.appendEvent({ runId: 'run-a', kind: 'tool-call', correlationId: 'e1', data: null });
      const bytes = Buffer.from('scoped');
      await h.backend.artifacts.putArtifact(
        { filename: 'a.txt', contentType: 'text/plain', runId: null },
        bytes,
      );
      const other = await h.sibling();
      assert.notEqual(other.workspaceId, h.backend.workspaceId);
      assert.deepEqual(await other.hitl.count(), { committed: 0, queued: 0, partial: false });
      assert.equal((await other.hitl.listRequests({})).items.length, 0);
      assert.equal(await other.runs.getRun('run-a'), null);
      assert.equal(await other.artifacts.head(sha256Hex(bytes)), null);
      // same input in the sibling workspace yields a DIFFERENT id (workspace-scoped ids)
      const own = await other.hitl.createRequest(requestInput());
      const original = await h.backend.hitl.listRequests({});
      assert.notEqual(own.requestId, original.items[0]!.id);
    } finally {
      await h.cleanup();
    }
  });

  test(t('cursors carry the composite shape (watermark, committed, overlay)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      await h.backend.hitl.createRequest(requestInput());
      await h.backend.hitl.createRequest(requestInput({ target: 'blog/two.md' }));
      const page = await h.backend.hitl.listRequests({ limit: 1 });
      assert.ok(page.cursor);
      const cursor: Cursor = page.cursor;
      assert.equal(typeof cursor.watermark, 'number');
      assert.equal(typeof cursor.committed, 'number');
      assert.ok(cursor.overlay === null || typeof cursor.overlay === 'object');
      assert.equal(typeof page.partial, 'boolean');
    } finally {
      await h.cleanup();
    }
  });

  test(t('canonical payload hashing: reordered-but-equivalent payloads dedup identically (never conflict)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const first = await h.backend.runs.appendEvent({
        runId: 'run-a',
        kind: 'tool-call',
        correlationId: 'evt-1',
        data: { b: 2, a: 1, nested: { z: 9, y: 8 } },
      });
      const replay = await h.backend.runs.appendEvent({
        runId: 'run-a',
        kind: 'tool-call',
        correlationId: 'evt-1',
        data: { nested: { y: 8, z: 9 }, a: 1, b: 2 },
      });
      assert.equal(replay.id, first.id);
      assert.equal(replay.outcome, 'committed');
      const run = await h.backend.runs.getRun('run-a');
      assert.ok(run);
      assert.equal(run.events.length, 1, 'key order must never fork or duplicate a record');
    } finally {
      await h.cleanup();
    }
  });

  test(t('single serialization: a stateful toJSON in run event data is captured exactly once (stored == hashed)'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      // A toJSON that changes on each call: the value that gets HASHED must be
      // the value that gets STORED — the payload is snapshotted once, so both
      // see {n:1}. The bug: hash sees {n:1}, storage re-invokes → {n:2}.
      let calls = 0;
      const data = {
        toJSON() {
          calls += 1;
          return { n: calls };
        },
      };
      const first = await h.backend.runs.appendEvent({ runId: 'stateful', kind: 'tool-call', correlationId: 'k', data });
      assert.equal(first.outcome, 'committed');
      const run = await h.backend.runs.getRun('stateful');
      assert.ok(run);
      assert.deepEqual(
        run.events[0]!.data,
        { n: 1 },
        'the stored value is the once-captured snapshot, not a re-invoked toJSON',
      );
      // Replay with an equivalent (fresh) payload dedups — proving the stored
      // hash agrees with the stored content (else replay would Conflict).
      const replay = await h.backend.runs.appendEvent({
        runId: 'stateful',
        kind: 'tool-call',
        correlationId: 'k',
        data: { toJSON: () => ({ n: 1 }) },
      });
      assert.equal(replay.outcome, 'committed');
      assert.equal(replay.id, first.id);
      const after = await h.backend.runs.getRun('stateful');
      assert.equal(after!.events.length, 1, 'no fork or duplicate from a stateful toJSON');
    } finally {
      await h.cleanup();
    }
  });

  test(t('reads report queued: false when healthy and accept the allowPartial opt-in unchanged'), { skip: factory.skip }, async () => {
    const h = await factory.create();
    try {
      const req = await h.backend.hitl.createRequest(requestInput());
      await h.backend.runs.appendEvent({ runId: 'run-a', kind: 'tool-call', correlationId: 'e1', data: null });
      const bytes = Buffer.from('flagged');
      const art = await h.backend.artifacts.putArtifact(
        { filename: 'f.txt', contentType: 'text/plain', runId: null },
        bytes,
      );
      for (const opts of [undefined, { allowPartial: true as const }]) {
        const got = await h.backend.hitl.getRequest(req.id, opts);
        assert.ok(got !== null && got.queued === false && got.seq !== null);
        const listed = await h.backend.hitl.listRequests({}, undefined, opts);
        assert.equal(listed.partial, false, 'allowPartial never degrades a healthy read');
        assert.ok(listed.items.every((i) => i.queued === false));
        const run = await h.backend.runs.getRun('run-a', opts);
        assert.ok(run !== null && run.events.every((e) => e.queued === false && e.seq !== null));
        const runs = await h.backend.runs.listRuns({}, undefined, opts);
        assert.ok(runs.items.every((r) => r.queued === false));
        const headed = await h.backend.artifacts.head(art.digest, opts);
        assert.ok(headed !== null && headed.queued === false);
        assert.deepEqual(await h.backend.hitl.count(undefined, opts), { committed: 1, queued: 0, partial: false });
      }
    } finally {
      await h.cleanup();
    }
  });
}
