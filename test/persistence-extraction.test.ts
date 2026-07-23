import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createBrainPool, resolveBrainUrl, withBrainClient } from '../src/lib/brain/connect.ts';
import {
  loadMigrations,
  pendingMigrations,
  runMigrations,
  schemaDir,
  type MigrationFile,
} from '../src/lib/brain/migrate.ts';
import {
  ConditionalWriteFailed,
  MemoryFileStore,
  createS3FileStore,
  filesConfig,
  type FileStore,
  type FilesConfig,
} from '../src/lib/brain/s3.ts';
import { assertSafeSegment } from '../src/lib/brain/fs.ts';
import { DEFAULT_CONFIG, type BrainConfig } from '../src/lib/brain/config.ts';
import { ROSTER_ROOT } from '../src/lib/paths.ts';
import { RosterError, EXIT_ERROR } from '../src/lib/errors.ts';

// Characterization suite for #318 stage 1: pins the public API surface and
// observable behavior of brain/connect.ts, brain/migrate.ts, brain/s3.ts, and
// brain/fs.ts#assertSafeSegment BEFORE the persistence/ extraction, and must
// stay green unchanged after it. Everything here is hermetic (no DB, no S3).

const ENV_KEYS = ['ROSTER_BRAIN_ADMIN_URL', 'ROSTER_BRAIN_URL'] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function clearBrainEnv(): Record<string, undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])) as Record<string, undefined>;
}

// ---------- brain/connect.ts ----------

test('connect: exported surface is resolveBrainUrl + createBrainPool + withBrainClient', () => {
  assert.equal(typeof resolveBrainUrl, 'function');
  assert.equal(typeof createBrainPool, 'function');
  assert.equal(typeof withBrainClient, 'function');
});

test('connect: resolveBrainUrl maps admin → ROSTER_BRAIN_ADMIN_URL, runtime → ROSTER_BRAIN_URL', () => {
  withEnv(
    {
      ROSTER_BRAIN_ADMIN_URL: 'postgresql://admin@example/db',
      ROSTER_BRAIN_URL: 'postgresql://runtime@example/db',
    },
    () => {
      assert.equal(resolveBrainUrl('admin'), 'postgresql://admin@example/db');
      assert.equal(resolveBrainUrl('runtime'), 'postgresql://runtime@example/db');
    },
  );
});

test('connect: resolveBrainUrl throws "<VAR> is not set" when unset or empty', () => {
  withEnv(clearBrainEnv(), () => {
    assert.throws(() => resolveBrainUrl('admin'), /^Error: ROSTER_BRAIN_ADMIN_URL is not set$/);
    assert.throws(() => resolveBrainUrl('runtime'), /^Error: ROSTER_BRAIN_URL is not set$/);
  });
  withEnv({ ROSTER_BRAIN_ADMIN_URL: '' }, () => {
    assert.throws(() => resolveBrainUrl('admin'), /ROSTER_BRAIN_ADMIN_URL is not set/);
  });
});

test('connect: createBrainPool uses the override URL verbatim and max 4 connections', async () => {
  const pool = withEnv(clearBrainEnv(), () =>
    createBrainPool('admin', 'postgresql://override@localhost:1/db'),
  );
  try {
    assert.equal(pool.options.connectionString, 'postgresql://override@localhost:1/db');
    assert.equal(pool.options.max, 4);
  } finally {
    await pool.end();
  }
});

test('connect: createBrainPool without override resolves the role env URL', async () => {
  const pool = withEnv(
    { ...clearBrainEnv(), ROSTER_BRAIN_URL: 'postgresql://rt@localhost:1/db' },
    () => createBrainPool('runtime'),
  );
  try {
    assert.equal(pool.options.connectionString, 'postgresql://rt@localhost:1/db');
  } finally {
    await pool.end();
  }
  withEnv(clearBrainEnv(), () => {
    assert.throws(() => createBrainPool('runtime'), /ROSTER_BRAIN_URL is not set/);
  });
});

function stubPool(events: string[]): pg.Pool {
  const client = {
    release: () => {
      events.push('release');
    },
  };
  return {
    connect: async () => {
      events.push('connect');
      return client;
    },
  } as unknown as pg.Pool;
}

test('connect: withBrainClient passes a connected client through and releases on success', async () => {
  const events: string[] = [];
  const result = await withBrainClient(stubPool(events), async (client) => {
    events.push('fn');
    assert.equal(typeof client.release, 'function');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(events, ['connect', 'fn', 'release']);
});

test('connect: withBrainClient releases the client when fn throws', async () => {
  const events: string[] = [];
  await assert.rejects(
    withBrainClient(stubPool(events), async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(events, ['connect', 'release']);
});

// ---------- brain/migrate.ts ----------

function tmpSchemaDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'persist-char-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

test('migrate: exported surface is schemaDir + loadMigrations + runMigrations + pendingMigrations', () => {
  assert.equal(typeof schemaDir, 'function');
  assert.equal(typeof loadMigrations, 'function');
  assert.equal(typeof runMigrations, 'function');
  assert.equal(typeof pendingMigrations, 'function');
});

test('migrate: schemaDir points at the shipped brain schema dir', () => {
  assert.equal(schemaDir(), join(ROSTER_ROOT, 'data', 'brain', 'schema'));
  assert.ok(existsSync(schemaDir()), 'shipped schema dir exists');
});

test('migrate: loadMigrations defaults to schemaDir() and finds shipped migrations', () => {
  const viaDefault = loadMigrations().map((f) => f.filename);
  const viaExplicit = loadMigrations(schemaDir()).map((f) => f.filename);
  assert.deepEqual(viaDefault, viaExplicit);
  assert.ok(viaDefault.length > 0, 'shipped schema dir has at least one migration');
  for (const filename of viaDefault) assert.match(filename, /^\d+_.*\.sql$/);
});

test('migrate: loadMigrations sorts by numeric prefix, not lexically', () => {
  const dir = tmpSchemaDir({
    '10_second.sql': 'select 10;',
    '2_first.sql': 'select 2;',
    '001_zeroth.sql': 'select 1;',
  });
  try {
    const files = loadMigrations(dir);
    assert.deepEqual(
      files.map((f) => f.filename),
      ['001_zeroth.sql', '2_first.sql', '10_second.sql'],
    );
    assert.deepEqual(files.map((f) => f.prefix), [1, 2, 10]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: loadMigrations ignores files not matching NNN_*.sql', () => {
  const dir = tmpSchemaDir({
    '001_real.sql': 'select 1;',
    'README.md': 'not sql',
    'x_nope.sql': 'select 0;',
    '01a_nope.sql': 'select 0;',
    'noext': 'nope',
  });
  try {
    assert.deepEqual(loadMigrations(dir).map((f) => f.filename), ['001_real.sql']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: loadMigrations rejects duplicate numeric prefixes (even different widths)', () => {
  const dir = tmpSchemaDir({ '001_a.sql': 'select 1;', '1_b.sql': 'select 1;' });
  try {
    assert.throws(() => loadMigrations(dir), /duplicate migration prefix 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: MigrationFile carries prefix, filename, sql, and sha256 of the content', () => {
  const sql = 'CREATE TABLE t (id int);\n';
  const dir = tmpSchemaDir({ '007_t.sql': sql });
  try {
    const files: MigrationFile[] = loadMigrations(dir);
    assert.equal(files.length, 1);
    const f = files[0]!;
    assert.equal(f.prefix, 7);
    assert.equal(f.filename, '007_t.sql');
    assert.equal(f.sql, sql);
    assert.equal(f.sha256, createHash('sha256').update(sql, 'utf8').digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- brain/s3.ts ----------

test('s3: exported surface is filesConfig + createS3FileStore + MemoryFileStore + ConditionalWriteFailed', () => {
  assert.equal(typeof filesConfig, 'function');
  assert.equal(typeof createS3FileStore, 'function');
  assert.equal(typeof MemoryFileStore, 'function');
  assert.equal(typeof ConditionalWriteFailed, 'function');
  assert.ok(ConditionalWriteFailed.prototype instanceof Error);
});

test('s3: ConditionalWriteFailed carries name, key, and the key in its message', () => {
  const err = new ConditionalWriteFailed('some/key.txt');
  assert.equal(err.name, 'ConditionalWriteFailed');
  assert.equal(err.key, 'some/key.txt');
  assert.match(err.message, /some\/key\.txt/);
  assert.ok(err instanceof Error);
});

test('s3: MemoryFileStore etag is the md5 hex of the body (matches single-part S3)', async () => {
  const store: FileStore = new MemoryFileStore();
  const body = Buffer.from('hello ledger world');
  const { etag } = await store.put('k.txt', body);
  assert.equal(etag, createHash('md5').update(body).digest('hex'));
  const got = await store.get('k.txt');
  assert.equal(got!.etag, etag);
  const head = await store.head('k.txt');
  assert.equal(head!.etag, etag);
  assert.equal(head!.size, body.length);
});

test('s3: MemoryFileStore round-trips bytes; missing keys are null; del is idempotent', async () => {
  const store = new MemoryFileStore();
  const body = Buffer.from([0, 1, 2, 254, 255]);
  await store.put('bin', body);
  const got = await store.get('bin');
  assert.deepEqual(got!.body, body);

  assert.equal(await store.get('missing'), null);
  assert.equal(await store.head('missing'), null);

  await store.del('missing');
  await store.del('bin');
  assert.equal(await store.get('bin'), null);
});

test("s3: MemoryFileStore ifNoneMatch:'*' is create-only", async () => {
  const store = new MemoryFileStore();
  await store.put('k', Buffer.from('a'), { ifNoneMatch: '*' });
  await assert.rejects(
    store.put('k', Buffer.from('b'), { ifNoneMatch: '*' }),
    (err: unknown) => err instanceof ConditionalWriteFailed && err.key === 'k',
  );
  const got = await store.get('k');
  assert.equal(got!.body.toString(), 'a');
});

test('s3: MemoryFileStore ifMatch is compare-and-swap', async () => {
  const store = new MemoryFileStore();
  await assert.rejects(
    store.put('k', Buffer.from('x'), { ifMatch: 'deadbeef' }),
    ConditionalWriteFailed,
  );
  const { etag } = await store.put('k', Buffer.from('v1'));
  await assert.rejects(store.put('k', Buffer.from('v2'), { ifMatch: 'wrong' }), ConditionalWriteFailed);
  const { etag: etag2 } = await store.put('k', Buffer.from('v2'), { ifMatch: etag });
  assert.notEqual(etag2, etag);
  const got = await store.get('k');
  assert.equal(got!.body.toString(), 'v2');
});

test('s3: MemoryFileStore stores and returns copies (caller mutation cannot corrupt it)', async () => {
  const store = new MemoryFileStore();
  const input = Buffer.from('original');
  await store.put('k', input);
  input.fill(0);
  const got1 = await store.get('k');
  assert.equal(got1!.body.toString(), 'original');
  got1!.body.fill(0);
  const got2 = await store.get('k');
  assert.equal(got2!.body.toString(), 'original');
});

function cfgWith(overrides: Partial<BrainConfig>): BrainConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const FULL_AWS_ENV = {
  AWS_ACCESS_KEY_ID: 'AKIA_TEST',
  AWS_SECRET_ACCESS_KEY: 'secret',
} satisfies NodeJS.ProcessEnv;

test('s3: filesConfig returns null without a bucket or without env credentials', () => {
  assert.equal(filesConfig(cfgWith({}), FULL_AWS_ENV), null);
  const cfg = cfgWith({ filesBucket: 'b' });
  assert.equal(filesConfig(cfg, { AWS_SECRET_ACCESS_KEY: 'secret' }), null);
  assert.equal(filesConfig(cfg, { AWS_ACCESS_KEY_ID: 'AKIA_TEST' }), null);
  assert.equal(filesConfig(cfg, {}), null);
});

test('s3: filesConfig maps config fields through and prefers config region over env', () => {
  const cfg = cfgWith({
    filesBucket: 'bkt',
    filesRegion: 'eu-west-1',
    filesEndpoint: 'https://minio.local:9000',
    filesPrefix: 'team/',
    filesForcePathStyle: true,
  });
  const fc: FilesConfig | null = filesConfig(cfg, { ...FULL_AWS_ENV, AWS_REGION: 'us-east-2' });
  assert.deepEqual(fc, {
    bucket: 'bkt',
    region: 'eu-west-1',
    endpoint: 'https://minio.local:9000',
    prefix: 'team/',
    forcePathStyle: true,
  });
});

test('s3: filesConfig region falls back to AWS_REGION, then null', () => {
  const cfg = cfgWith({ filesBucket: 'bkt' });
  const withEnvRegion = filesConfig(cfg, { ...FULL_AWS_ENV, AWS_REGION: 'ap-south-1' });
  assert.equal(withEnvRegion!.region, 'ap-south-1');
  const noRegion = filesConfig(cfg, FULL_AWS_ENV);
  assert.equal(noRegion!.region, null);
  assert.equal(noRegion!.endpoint, null);
  assert.equal(noRegion!.prefix, '');
  assert.equal(noRegion!.forcePathStyle, false);
});

// ---------- brain/fs.ts assertSafeSegment ----------

test('fs: assertSafeSegment accepts alnum-led segments with . - _ up to 128 chars', () => {
  for (const ok of ['notes', 'a', 'file.txt', 'A1_b-c.d', '0start', 'x'.repeat(128)]) {
    assertSafeSegment('slug', ok);
  }
});

test('fs: assertSafeSegment rejects traversal, separators, bad leads, and oversized values', () => {
  const bad = ['', 'x'.repeat(129), '../etc', 'a/b', 'a\\b', '.hidden', '-lead', '_lead', 'a b', 'a..b'];
  for (const value of bad) {
    assert.throws(
      () => assertSafeSegment('kind', value),
      (err: unknown) => {
        assert.ok(err instanceof RosterError, `RosterError for ${JSON.stringify(value)}`);
        assert.equal(err.name, 'RosterError');
        assert.equal(err.header, 'Invalid kind');
        assert.equal(err.exitCode, EXIT_ERROR);
        assert.match(err.body, /not a valid kind/);
        return true;
      },
    );
  }
});

test('fs: assertSafeSegment names the offending label and value in the error', () => {
  assert.throws(
    () => assertSafeSegment('filename', '../x'),
    (err: unknown) => err instanceof RosterError && err.body.includes("'../x'") && err.header === 'Invalid filename',
  );
});
