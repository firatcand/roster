import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { executeBrainIngest } from '../src/commands/brain.ts';
import { deriveWorkspaceRuntimeRoleName, RUNTIME_ROLE } from '../src/lib/brain/roles.ts';
import { deriveBrainWorkspaceAuthority } from '../src/lib/brain/workspace-authority.ts';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { bootstrapBrainWorkspaceAuthority } from '../src/lib/brain/workspace-authority.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { WorkspaceBrainConfig } from '../src/lib/workspace-record.ts';
import { ADMIN_URL, HAS_DB, createFreshDb, type FreshDb } from './brain-helpers.ts';
import { MemoryBrainObjectStore } from './support/brain-memory-object-store.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };
const WORKSPACE_ID = 'runtime-ingest-test';
const BUCKET = 'runtime-ingest-vault';
const RUNTIME_PASSWORD = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;

function brainConfig(): WorkspaceBrainConfig {
  return {
    secrets_path: `/${WORKSPACE_ID}`,
    storage: { bucket: BUCKET, region: 'eu-central-1', force_path_style: false },
  };
}

type Fixture = {
  cwd: string;
  store: MemoryBrainObjectStore;
  env: NodeJS.ProcessEnv;
  teardown: () => Promise<void>;
};

async function provision(): Promise<Fixture> {
  const fresh: FreshDb = await createFreshDb();
  const roleName = deriveWorkspaceRuntimeRoleName(WORKSPACE_ID, RUNTIME_ROLE);
  const authority = deriveBrainWorkspaceAuthority(WORKSPACE_ID, brainConfig());
  const bootstrapPool = createBrainPool('admin', fresh.url);
  try {
    await bootstrapBrainWorkspaceAuthority(bootstrapPool, authority, {
      runtimeRole: RUNTIME_ROLE,
      runtimePassword: RUNTIME_PASSWORD,
    });
  } finally {
    await bootstrapPool.end();
  }

  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-ingest-'));
  writeFileSync(join(cwd, 'roster.yaml'), [
    'schema_version: 2',
    `workspace_id: ${WORKSPACE_ID}`,
    'brain:',
    `  secrets_path: /${WORKSPACE_ID}`,
    '  storage:',
    `    bucket: ${BUCKET}`,
    '    region: eu-central-1',
    'functions: {}',
    'hosts:',
    '  codex: enabled',
    'tool_uses: []',
    '',
  ].join('\n'), 'utf8');

  const previous = { ...process.env };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROSTER_BRAIN_ADMIN_URL: fresh.url,
    AWS_ACCESS_KEY_ID: 'AKIAINGESTFIXTURE001',
    AWS_SECRET_ACCESS_KEY: 'ingest-fixture-secret',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);

  return {
    cwd,
    store: new MemoryBrainObjectStore(authority.namespaceFingerprint),
    env,
    teardown: async () => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(cwd, { recursive: true, force: true });
      try {
        await fresh.drop();
      } finally {
        const admin = new pg.Client({ connectionString: ADMIN_URL });
        await admin.connect();
        try {
          const exists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
          if ((exists.rowCount ?? 0) > 0) {
            await admin.query(`REVOKE "${roleName}" FROM CURRENT_USER`);
            await admin.query(`DROP ROLE "${roleName}"`);
          }
        } finally {
          await admin.end();
        }
      }
    },
  };
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestKey: 'ingest-request-1',
    source: { kind: 'structured-record', stableKey: 'acme-brief' },
    labels: [{ workspace: WORKSPACE_ID }],
    privacy: 'internal',
    trust: 'brain-extract-untrusted',
    actor: { actorId: 'ingest-fixture', assurance: 'caller-asserted' },
    mediaType: 'text/markdown',
    provenance: { origin: 'fixture' },
    ...overrides,
  });
}

type IngestPayload = {
  ok: boolean;
  verb: string;
  ingest: {
    intent_id: string;
    source_id: string;
    source_version_id: string;
    object_id: string;
    published_as_current: boolean;
  };
  extraction: { status: string; chunk_count: number; outcome: string };
};

async function ingest(
  fixture: Fixture,
  manifestJson: string,
  bytesFile: string,
): Promise<IngestPayload> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  try {
    const code = await executeBrainIngest({
      cwd: fixture.cwd,
      json: true,
      manifest: manifestJson,
      bytesFile,
      makeObjectStore: () => fixture.store,
    });
    assert.equal(code, 0);
  } finally {
    console.log = log;
  }
  return JSON.parse(lines.at(-1)!) as IngestPayload;
}

// P3: real Postgres, hermetic object store, no network.
test('brain ingest mints an immutable source version and its extraction end to end', opts, async () => {
  const fixture = await provision();
  try {
    writeFileSync(join(fixture.cwd, 'brief.md'), '# Acme\n\nAlpha body.\n\n## Second\n\nBeta body.\n', 'utf8');
    const payload = await ingest(fixture, manifest(), 'brief.md');

    assert.equal(payload.ok, true);
    assert.equal(payload.verb, 'ingest');
    for (const id of [
      payload.ingest.intent_id,
      payload.ingest.source_id,
      payload.ingest.source_version_id,
      payload.ingest.object_id,
    ]) assert.match(id, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(payload.ingest.published_as_current, true);
    assert.equal(payload.extraction.status, 'complete');
    assert.equal(payload.extraction.outcome, 'extracted');
    assert.ok(payload.extraction.chunk_count > 0);

    // The bytes went to the double, and the version is durable and structured.
    assert.equal(fixture.store.createCalls.length, 1);
    const admin = new pg.Client({ connectionString: process.env['ROSTER_BRAIN_ADMIN_URL']! });
    await admin.connect();
    try {
      const version = await admin.query<{ source_kind: string }>(
        `SELECT s.source_kind FROM brain.source_versions v
           JOIN brain.logical_sources s ON s.source_id = v.source_id
          WHERE v.source_version_id = $1`,
        [payload.ingest.source_version_id],
      );
      assert.equal(version.rows[0]!.source_kind, 'structured-record');
    } finally {
      await admin.end();
    }

    // §10: no manifest echo, no chunk text, no object key, no bucket.
    assert.equal(Object.hasOwn(payload.ingest, 'object_key'), false);
    assert.equal(JSON.stringify(payload).includes(BUCKET), false);
    assert.equal(JSON.stringify(payload).includes('Alpha body'), false);
  } finally {
    await fixture.teardown();
  }
});

// P4: idempotency matrix.
test('brain ingest is idempotent on its request key and fails closed on a conflicting replay', opts, async () => {
  const fixture = await provision();
  try {
    writeFileSync(join(fixture.cwd, 'brief.md'), '# Acme\n\nFirst body.\n', 'utf8');
    const first = await ingest(fixture, manifest(), 'brief.md');

    // Identical manifest + identical bytes: same version, nothing new stored.
    const replay = await ingest(fixture, manifest(), 'brief.md');
    assert.equal(replay.ingest.source_version_id, first.ingest.source_version_id);
    assert.equal(replay.ingest.intent_id, first.ingest.intent_id);
    assert.equal(replay.extraction.outcome, 'unchanged');

    // Changed bytes under a NEW request key: a new version becomes current.
    writeFileSync(join(fixture.cwd, 'brief-v2.md'), '# Acme\n\nSecond body, revised.\n', 'utf8');
    const revised = await ingest(
      fixture,
      manifest({ requestKey: 'ingest-request-2' }),
      'brief-v2.md',
    );
    assert.notEqual(revised.ingest.source_version_id, first.ingest.source_version_id);
    assert.equal(revised.ingest.source_id, first.ingest.source_id, 'same logical source');
    assert.equal(revised.ingest.published_as_current, true);

    // Same request key, different content: refused, with no mutation.
    const admin = new pg.Client({ connectionString: process.env['ROSTER_BRAIN_ADMIN_URL']! });
    await admin.connect();
    let before: number;
    try {
      before = Number((await admin.query<{ c: string }>(
        `SELECT count(*) AS c FROM brain.source_versions`,
      )).rows[0]!.c);
    } finally {
      await admin.end();
    }

    writeFileSync(join(fixture.cwd, 'conflict.md'), '# Acme\n\nConflicting body.\n', 'utf8');
    await assert.rejects(
      executeBrainIngest({
        cwd: fixture.cwd,
        json: true,
        manifest: manifest(),
        bytesFile: 'conflict.md',
        makeObjectStore: () => fixture.store,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RosterError, String(error));
        assert.equal(error.code, 'BRAIN_SOURCE_IDEMPOTENCY_CONFLICT');
        return true;
      },
    );

    const after = new pg.Client({ connectionString: process.env['ROSTER_BRAIN_ADMIN_URL']! });
    await after.connect();
    try {
      const count = Number((await after.query<{ c: string }>(
        `SELECT count(*) AS c FROM brain.source_versions`,
      )).rows[0]!.c);
      assert.equal(count, before, 'a conflicting replay mutates nothing');
    } finally {
      await after.end();
    }
  } finally {
    await fixture.teardown();
  }
});

// P5 at the CLI seam: the runtime credential structurally cannot ingest.
test('brain ingest refuses a runtime-credential admin URL before any object write', opts, async () => {
  const fixture = await provision();
  try {
    writeFileSync(join(fixture.cwd, 'brief.md'), '# Acme\n\nBody.\n', 'utf8');
    const roleName = deriveWorkspaceRuntimeRoleName(WORKSPACE_ID, RUNTIME_ROLE);
    const runtimeUrl = new URL(process.env['ROSTER_BRAIN_ADMIN_URL']!);
    runtimeUrl.username = roleName;
    runtimeUrl.password = RUNTIME_PASSWORD;
    process.env['ROSTER_BRAIN_ADMIN_URL'] = runtimeUrl.toString();

    await assert.rejects(
      executeBrainIngest({
        cwd: fixture.cwd,
        json: true,
        manifest: manifest(),
        bytesFile: 'brief.md',
        makeObjectStore: () => fixture.store,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RosterError, String(error));
        assert.equal(error.code, 'BRAIN_EXTRACTION_ADMIN_REQUIRED');
        return true;
      },
    );
    assert.deepEqual(fixture.store.createCalls, [], 'no object was written');
  } finally {
    await fixture.teardown();
  }
});
