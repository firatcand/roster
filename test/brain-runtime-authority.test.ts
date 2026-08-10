import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { deriveWorkspaceRuntimeRoleName, RUNTIME_ROLE } from '../src/lib/brain/roles.ts';
import { deriveBrainWorkspaceAuthority } from '../src/lib/brain/workspace-authority.ts';
import { ADMIN_URL, HAS_DB, createFreshDb, type FreshDb } from './brain-helpers.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };
const PASSWORD = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;

function brainConfig(bucket: string, workspaceId: string) {
  return {
    secrets_path: `/${workspaceId}`,
    storage: { bucket, region: 'eu-central-1', force_path_style: false },
  };
}

function registryText(workspaceId: string, bucket: string): string {
  return [
    'schema_version: 2',
    `workspace_id: ${workspaceId}`,
    'brain:',
    `  secrets_path: /${workspaceId}`,
    '  storage:',
    `    bucket: ${bucket}`,
    '    region: eu-central-1',
    'functions: {}',
    'hosts:',
    '  codex: enabled',
    'tool_uses: []',
    '',
  ].join('\n');
}

type Workspace = { cwd: string; write: (workspaceId: string, bucket: string) => void; cleanup: () => void };

function workspace(workspaceId: string, bucket: string): Workspace {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-authority-'));
  const write = (id: string, bucketName: string): void => {
    writeFileSync(join(cwd, 'roster.yaml'), registryText(id, bucketName), 'utf8');
  };
  write(workspaceId, bucket);
  return { cwd, write, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function runtimeUrl(databaseUrl: string, roleName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.username = roleName;
  parsed.password = PASSWORD;
  return parsed.toString();
}

// Deliberately object-storage-credential-free: doctor is an ADMIN + DECLARED
// verb and must never need one.
function env(adminUrl: string, runtime?: string): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ROSTER_BRAIN_ADMIN_URL: adminUrl };
  delete merged['AWS_ACCESS_KEY_ID'];
  delete merged['AWS_SECRET_ACCESS_KEY'];
  delete merged['AWS_SESSION_TOKEN'];
  if (runtime === undefined) delete merged['ROSTER_BRAIN_URL'];
  else merged['ROSTER_BRAIN_URL'] = runtime;
  return merged;
}

function runBrain(argv: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BIN, 'brain', ...argv, '--json'], {
    encoding: 'utf8',
    env: environment,
    cwd,
  });
}

function refusalCode(result: { stdout: string; stderr: string; status: number | null }): string {
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout) as { code: string; message?: string };
  if (payload.code === 'ROSTER_ERROR') throw new Error(`unexpected raw error: ${payload.message}`);
  return payload.code;
}

async function dropRole(roleName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) throw new Error('unsafe derived role fixture');
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
    if ((exists.rowCount ?? 0) === 0) return;
    await client.query(`REVOKE "${roleName}" FROM CURRENT_USER`);
    await client.query(`DROP ROLE "${roleName}"`);
  } finally {
    await client.end();
  }
}

test('doctor and the runtime verbs refuse a foreign workspace or namespace before any content read', opts, async () => {
  const alphaId = 'authority-alpha';
  const betaId = 'authority-beta';
  const alphaRole = deriveWorkspaceRuntimeRoleName(alphaId, RUNTIME_ROLE);
  const betaRole = deriveWorkspaceRuntimeRoleName(betaId, RUNTIME_ROLE);
  let alpha: FreshDb | undefined;
  let beta: FreshDb | undefined;
  const alphaWs = workspace(alphaId, 'authority-alpha-vault');
  const betaWs = workspace(betaId, 'authority-beta-vault');
  try {
    alpha = await createFreshDb();
    beta = await createFreshDb();
    const alphaInit = runBrain(['init'], alphaWs.cwd, env(alpha.url, runtimeUrl(alpha.url, alphaRole)));
    assert.equal(alphaInit.status, 0, alphaInit.stderr);
    const betaInit = runBrain(['init'], betaWs.cwd, env(beta.url, runtimeUrl(beta.url, betaRole)));
    assert.equal(betaInit.status, 0, betaInit.stderr);

    const healthy = runBrain(['doctor'], alphaWs.cwd, env(alpha.url));
    assert.equal(healthy.status, 0, healthy.stderr);
    const report = JSON.parse(healthy.stdout) as {
      ok: boolean;
      identity_state: string;
      object_storage_contacted: boolean;
      company_content_read: boolean;
      checks: Array<{ name: string }>;
    };
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(report.identity_state, 'ready');
    assert.equal(report.object_storage_contacted, false);
    assert.equal(report.company_content_read, false);

    // Beta's ambient credentials against alpha's database: PostgreSQL roles are
    // cluster-wide, so both connections succeed and the refusal is workspace
    // authority's, raised before any company content is read.
    assert.equal(
      refusalCode(runBrain(['doctor'], betaWs.cwd, env(alpha.url))),
      'BRAIN_WORKSPACE_MISMATCH',
    );
    // The runtime half is refused even harder: beta's role holds no privilege on
    // alpha's protected metadata, so the read fails before authority is even
    // consulted. Either way no company content is returned.
    const foreignRuntime = runBrain(
      ['get', '--kind', 'k', '--slug', 's'],
      betaWs.cwd,
      env(alpha.url, runtimeUrl(alpha.url, betaRole)),
    );
    assert.equal(foreignRuntime.status, 1, foreignRuntime.stderr);
    assert.equal((JSON.parse(foreignRuntime.stdout) as { ok: boolean }).ok, false);

    // A tracked namespace change is a different Brain namespace, on both paths.
    alphaWs.write(alphaId, 'authority-alpha-other-vault');
    assert.equal(refusalCode(runBrain(['doctor'], alphaWs.cwd, env(alpha.url))), 'BRAIN_NAMESPACE_MISMATCH');
    assert.equal(
      refusalCode(runBrain(
        ['get', '--kind', 'k', '--slug', 's'],
        alphaWs.cwd,
        env(alpha.url, runtimeUrl(alpha.url, alphaRole)),
      )),
      'BRAIN_NAMESPACE_MISMATCH',
    );
  } finally {
    alphaWs.cleanup();
    betaWs.cleanup();
    try {
      if (alpha !== undefined) await alpha.drop();
      if (beta !== undefined) await beta.drop();
    } finally {
      await dropRole(alphaRole);
      await dropRole(betaRole);
    }
  }
});

test('doctor inspects protected metadata before identity is ready', opts, async () => {
  const workspaceId = 'authority-early';
  let pristine: FreshDb | undefined;
  let migrating: FreshDb | undefined;
  const ws = workspace(workspaceId, 'authority-early-vault');
  try {
    pristine = await createFreshDb();
    // A cluster-wide role of the derived name EXISTS but the database holds no
    // protected identity: role existence is not identity, and doctor must not
    // fall through to checks that query absent brain/brain_meta relations.
    const strandedRole = deriveWorkspaceRuntimeRoleName(workspaceId, RUNTIME_ROLE);
    const cluster = new pg.Client({ connectionString: ADMIN_URL });
    await cluster.connect();
    try {
      const exists = await cluster.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [strandedRole]);
      if ((exists.rowCount ?? 0) === 0) {
        await cluster.query(`CREATE ROLE "${strandedRole}" LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      }
    } finally {
      await cluster.end();
    }

    const uninitialized = runBrain(['doctor'], ws.cwd, env(pristine.url));
    // AC-3's tolerance: the diagnostic pool PERMITS a database with no protected
    // identity and reports the state, instead of raising
    // BRAIN_IDENTITY_UNINITIALIZED the way a verified pool does. The report is
    // still unhealthy, because no runtime role exists yet.
    const uninitializedReport = JSON.parse(uninitialized.stdout) as {
      identity_state?: string;
      code?: string;
      ok?: boolean;
      roleExists?: boolean;
      checks?: Array<{ name: string }>;
    };
    assert.equal(uninitializedReport.code, undefined, uninitialized.stdout);
    assert.equal(uninitializedReport.identity_state, 'uninitialized');
    assert.equal(uninitializedReport.roleExists, true, 'the cluster-wide role is present');
    assert.deepEqual(
      uninitializedReport.checks?.map((c) => c.name),
      ['workspace-identity-initialized'],
      'no relation-dependent check ran',
    );
    assert.equal(uninitializedReport.ok, false);

    migrating = await createFreshDb();
    const authority = deriveBrainWorkspaceAuthority(workspaceId, brainConfig('authority-early-vault', workspaceId));
    const pool = createBrainPool('admin', migrating.url);
    try {
      await runMigrations(pool);
      await pool.query(
        `INSERT INTO brain_meta.workspace_identity (
           singleton, workspace_id, fingerprint_format_version, namespace_fingerprint,
           database_authority_id, migration_state
         ) VALUES (true, $1, $2, $3, gen_random_uuid(), 'migrating')`,
        [authority.workspaceId, authority.fingerprintFormatVersion, authority.namespaceFingerprint],
      );
    } finally {
      await pool.end();
    }
    const inFlight = runBrain(['doctor'], ws.cwd, env(migrating.url));
    const inFlightReport = JSON.parse(inFlight.stdout) as { identity_state?: string; code?: string };
    assert.equal(inFlightReport.code, undefined, inFlight.stdout);
    assert.equal(inFlightReport.identity_state, 'migrating');
  } finally {
    ws.cleanup();
    if (pristine !== undefined) await pristine.drop();
    if (migrating !== undefined) await migrating.drop();
    await dropRole(deriveWorkspaceRuntimeRoleName(workspaceId, RUNTIME_ROLE));
  }
});
