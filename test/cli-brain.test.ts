import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { resolveBrainDoctorRoleName } from '../src/lib/brain/connect.ts';
import { RosterError } from '../src/lib/errors.ts';
import { deriveWorkspaceRuntimeRoleName, RUNTIME_ROLE } from '../src/lib/brain/roles.ts';
import { loadMigrations, schemaDir } from '../src/lib/brain/migrate.ts';
import { ADMIN_URL, HAS_DB, createFreshDb } from './brain-helpers.ts';

// Derived, never hardcoded: `brain init` applies (then skips) exactly the
// migration set on disk, in ledger order. A new numbered migration must not
// require an edit here.
function migrationFilenames(): string[] {
  return loadMigrations(schemaDir()).map((file) => file.filename);
}

const BIN = resolve(process.cwd(), 'bin/roster.js');
const dbOpts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };
const RUNTIME_PASSWORD_A = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
const RUNTIME_PASSWORD_B = `Bb1_${randomBytes(32).toString('base64url')}-B2_`;

function runBin(args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd });
}

function percentEncodeAscii(value: string): string {
  return [...Buffer.from(value, 'ascii')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('');
}

function runtimeUrl(
  adminUrl: string,
  roleName: string,
  password: string,
  percentEncoded = false,
): string {
  const parsed = new URL(adminUrl);
  const username = percentEncoded ? percentEncodeAscii(roleName) : roleName;
  const secret = percentEncoded ? percentEncodeAscii(password) : password;
  return `${parsed.protocol}//${username}:${secret}@${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function createBrainWorkspace(includeBrain = true): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-cli-'));
  const brain = includeBrain
    ? [
        'brain:',
        '  secrets_path: /roster-brain-cli',
        '  storage:',
        '    bucket: roster-brain-cli-vault',
        '    region: eu-central-1',
      ]
    : [];
  writeFileSync(join(cwd, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: roster-brain-cli',
    ...brain,
    'functions: {}',
    'hosts:',
    '  codex: enabled',
    'tool_uses: []',
    '',
  ].join('\n'), 'utf8');
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function dropDerivedRole(roleName: string): Promise<void> {
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

test('parseBrainArgs: missing subcommand errors', () => {
  const r = parseBrainArgs([]);
  assert.equal(r.kind, 'err');
});

test('parseBrainArgs: unknown subcommand errors', () => {
  const r = parseBrainArgs(['frobnicate']);
  assert.equal(r.kind, 'err');
});

test('parseBrainArgs: init flags', () => {
  const r = parseBrainArgs(['init', '--json', '--embeddings']);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r, { kind: 'ok', subcommand: 'init', json: true, silent: false, embeddings: true, role: 'roster_brain_rw' });
});

test('parseBrainArgs: doctor rejects --embeddings', () => {
  const r = parseBrainArgs(['doctor', '--embeddings']);
  assert.equal(r.kind, 'err');
});

test('parseBrainArgs: the canonical subcommand set is exactly the shipped spellings', () => {
  const canonical = ['init', 'doctor', 'ingest', 'save', 'get', 'event', 'link', 'merge', 'fs', 'record'];
  const legacy = ['mount', 'table', 'sql', 'config', 'reindex', 'gc', 'export', 'import', 'query'];
  const argv: Record<string, string[]> = {
    init: ['init'],
    doctor: ['doctor'],
    ingest: ['ingest', '--manifest', '{}'],
    save: ['save', '--kind', 'k', '--slug', 's'],
    get: ['get', '--kind', 'k', '--slug', 's'],
    event: ['event', '--kind', 'note'],
    link: ['link', 'a', 'rel', 'b'],
    merge: ['merge', 'a', 'b'],
    fs: ['fs', 'ls'],
    record: ['record', 'run', '--payload', '{}'],
    mount: ['mount', 'f.md'],
    table: ['table', 'list'],
    sql: ['sql', 'SELECT 1'],
    config: ['config', 'get'],
    reindex: ['reindex'],
    gc: ['gc'],
    export: ['export'],
    import: ['import', 'dir'],
    query: ['query', 'text'],
  };
  for (const verb of [...canonical, ...legacy]) {
    const parsed = parseBrainArgs(argv[verb]!);
    assert.equal(parsed.kind, 'ok', verb);
    assert.equal(parsed.kind === 'ok' && parsed.subcommand, verb);
  }
  assert.equal(parseBrainArgs(['promote']).kind, 'err');
});

test('parseBrainArgs: brain ingest envelope grammar', () => {
  const ok = parseBrainArgs(['ingest', '--manifest', '{"a":1}', '--bytes-file', 'src/x.md', '--json']);
  assert.deepEqual(ok, {
    kind: 'ok',
    subcommand: 'ingest',
    json: true,
    manifest: '{"a":1}',
    manifestFile: undefined,
    bytesFile: 'src/x.md',
  });
  const viaFile = parseBrainArgs(['ingest', '--manifest-file', 'ingest/a.json']);
  assert.deepEqual(viaFile, {
    kind: 'ok',
    subcommand: 'ingest',
    json: false,
    manifest: undefined,
    manifestFile: 'ingest/a.json',
    bytesFile: undefined,
  });

  const rejections: Array<[string[], string]> = [
    [['ingest'], `'brain ingest' requires exactly one of --manifest or --manifest-file`],
    [['ingest', '--manifest', '{}', '--manifest-file', 'a.json'], `'brain ingest' requires exactly one of --manifest or --manifest-file`],
    [['ingest', '--manifest'], `'brain ingest': --manifest requires a value`],
    [['ingest', '--manifest-file'], `'brain ingest': --manifest-file requires a value`],
    [['ingest', '--manifest', '{}', '--bytes-file'], `'brain ingest': --bytes-file requires a value`],
    [['ingest', '--manifest', '{}', 'stray'], `'brain ingest': unexpected positional argument 'stray'`],
    [['ingest', '--manifest', '{}', '--nope'], `unknown flag for 'brain ingest': --nope`],
  ];
  for (const [args, message] of rejections) {
    const parsed = parseBrainArgs(args);
    assert.equal(parsed.kind, 'err', args.join(' '));
    assert.equal(parsed.kind === 'err' && parsed.message, message);
  }
});

test('cli: brain import reports the stable disabled-command error without Brain credentials', () => {
  const env = { ...process.env };
  delete env['ROSTER_BRAIN_ADMIN_URL'];
  delete env['ROSTER_BRAIN_URL'];
  const r = runBin(['brain', 'import', '/path/that/must-not-be-read', '--json'], env);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, '');
  const payload = JSON.parse(r.stdout) as {
    ok: boolean;
    code: string;
    details: { command: string };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'BRAIN_LEGACY_COMMAND_DISABLED');
  assert.deepEqual(payload.details, { command: 'brain import' });
});

test('cli: brain init validates tracked Brain configuration before database credentials', () => {
  const workspace = createBrainWorkspace(false);
  const env = { ...process.env };
  delete env['ROSTER_BRAIN_ADMIN_URL'];
  delete env['ROSTER_BRAIN_URL'];
  try {
    const r = runBin(['brain', 'init', '--json'], env, workspace.cwd);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, '');
    const payload = JSON.parse(r.stdout) as { code: string; details: { path: string } };
    assert.equal(payload.code, 'BRAIN_NOT_CONFIGURED');
    assert.deepEqual(payload.details, { path: 'roster.yaml' });
  } finally {
    workspace.cleanup();
  }
});

test('cli: brain init rejects missing or malformed ambient runtime credentials before admin access', () => {
  const workspace = createBrainWorkspace();
  const roleName = deriveWorkspaceRuntimeRoleName('roster-brain-cli', RUNTIME_ROLE);
  const cases: Array<{ name: string; value?: string; reason: string }> = [
    { name: 'missing', reason: 'missing' },
    { name: 'not a URL', value: 'not-a-postgres-url', reason: 'malformed' },
    {
      name: 'wrong role',
      value: `postgresql://other_runtime:${RUNTIME_PASSWORD_A}@invalid.example/brain`,
      reason: 'role-mismatch',
    },
    {
      name: 'malformed percent escape',
      value: `postgresql://${roleName}:%ZZ@invalid.example/brain`,
      reason: 'malformed',
    },
    {
      name: 'decoded control byte',
      value: `postgresql://${roleName}:${'A'.repeat(42)}%00@invalid.example/brain`,
      reason: 'password-invalid',
    },
    {
      name: 'decoded non-base64url byte',
      value: `postgresql://${roleName}:${'A'.repeat(42)}%2F@invalid.example/brain`,
      reason: 'password-invalid',
    },
    {
      name: 'short password',
      value: `postgresql://${roleName}:${'A'.repeat(42)}@invalid.example/brain`,
      reason: 'password-invalid',
    },
    {
      name: 'long password',
      value: `postgresql://${roleName}:${'A'.repeat(129)}@invalid.example/brain`,
      reason: 'password-invalid',
    },
  ];
  try {
    for (const entry of cases) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ROSTER_BRAIN_ADMIN_URL: 'admin-url-must-not-be-resolved',
      };
      if (entry.value === undefined) delete env['ROSTER_BRAIN_URL'];
      else env['ROSTER_BRAIN_URL'] = entry.value;
      const result = runBin(['brain', 'init', '--json'], env, workspace.cwd);
      assert.equal(result.status, 1, `${entry.name}: ${result.stderr}`);
      assert.equal(result.stderr, '', entry.name);
      const payload = JSON.parse(result.stdout) as {
        code: string;
        details: { reason: string; role_name: string; secrets_path: string };
      };
      assert.equal(payload.code, 'BRAIN_RUNTIME_CREDENTIAL_INVALID', entry.name);
      assert.deepEqual(payload.details, {
        reason: entry.reason,
        role_name: roleName,
        secrets_path: '/roster-brain-cli',
      });
      assert.doesNotMatch(result.stdout, /invalid\.example|other_runtime|%00|%2F|%ZZ/u, entry.name);
      if (entry.value !== undefined) assert.equal(result.stdout.includes(entry.value), false, entry.name);
    }
  } finally {
    workspace.cleanup();
  }
});

test('cli: human brain init reports the non-secret role and Infisical path needed to prepare credentials', () => {
  const workspace = createBrainWorkspace();
  const roleName = deriveWorkspaceRuntimeRoleName('roster-brain-cli', RUNTIME_ROLE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROSTER_BRAIN_ADMIN_URL: 'admin-url-must-not-be-resolved',
  };
  delete env['ROSTER_BRAIN_URL'];
  try {
    const result = runBin(['brain', 'init'], env, workspace.cwd);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(roleName, 'u'));
    assert.match(result.stderr, /\/roster-brain-cli/u);
    assert.doesNotMatch(result.stderr, /admin-url-must-not-be-resolved|postgres(?:ql)?:\/\//iu);
  } finally {
    workspace.cleanup();
  }
});

test('brain doctor derives an explicit role base in a configured v2 workspace', () => {
  const workspace = createBrainWorkspace();
  try {
    assert.equal(
      resolveBrainDoctorRoleName(workspace.cwd, 'custom_brain_role'),
      deriveWorkspaceRuntimeRoleName('roster-brain-cli', 'custom_brain_role'),
    );
  } finally {
    workspace.cleanup();
  }
});

test('brain doctor uses the exact legacy role only when roster.yaml is absent', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-legacy-'));
  try {
    assert.equal(resolveBrainDoctorRoleName(cwd, 'legacy_brain_role'), 'legacy_brain_role');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('brain doctor rejects an existing invalid or unconfigured v2 roster.yaml', () => {
  const invalid = createBrainWorkspace();
  const unconfigured = createBrainWorkspace(false);
  try {
    writeFileSync(join(invalid.cwd, 'roster.yaml'), 'schema_version: [invalid\n', 'utf8');
    assert.throws(
      () => resolveBrainDoctorRoleName(invalid.cwd),
      (error: unknown) => error instanceof RosterError && error.code === 'YAML_INVALID',
    );
    assert.throws(
      () => resolveBrainDoctorRoleName(unconfigured.cwd),
      (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_NOT_CONFIGURED',
    );
  } finally {
    invalid.cleanup();
    unconfigured.cleanup();
  }
});

test('cli: brain unknown subcommand exits non-zero', () => {
  const r = runBin(['brain', 'nope'], { ...process.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown 'brain' subcommand/);
});

test('cli: brain init JSON returns non-secret credential metadata and explicit role bases derive consistently', dbOpts, async () => {
  const fresh = await createFreshDb();
  const workspace = createBrainWorkspace();
  const roleName = deriveWorkspaceRuntimeRoleName('roster-brain-cli', fresh.role);
  const encodedRuntimeUrl = runtimeUrl(fresh.url, roleName, RUNTIME_PASSWORD_A, true);
  const env = {
    ...process.env,
    ROSTER_BRAIN_ADMIN_URL: fresh.url,
    ROSTER_BRAIN_URL: encodedRuntimeUrl,
  };
  try {
    const first = runBin(['brain', 'init', '--json', '--role', fresh.role], env, workspace.cwd);
    assert.equal(first.status, 0, first.stderr);
    const p1 = JSON.parse(first.stdout);
    assert.equal(p1.roleCreated, true);
    assert.equal(p1.roleName, roleName);
    assert.equal(Object.hasOwn(p1, 'credentialCreated'), false);
    assert.equal(Object.hasOwn(p1, 'runtimeUrl'), false);
    assert.equal(Object.hasOwn(p1, 'databaseAuthorityId'), false);
    assert.doesNotMatch(first.stdout, /postgres(?:ql)?:\/\//iu);
    assert.doesNotMatch(first.stdout, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu);
    assert.equal(first.stdout.includes(RUNTIME_PASSWORD_A), false);
    assert.equal(first.stdout.includes(encodedRuntimeUrl), false);
    assert.doesNotMatch(first.stdout, /password|runtimeUrl/iu);
    assert.deepEqual(p1.applied, migrationFilenames());

    const doctor = runBin(['brain', 'doctor', '--json', '--role', fresh.role], env, workspace.cwd);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);

    const second = runBin(['brain', 'init', '--json', '--role', fresh.role], env, workspace.cwd);
    assert.equal(second.status, 0, second.stderr);
    const p2 = JSON.parse(second.stdout);
    assert.equal(p2.roleCreated, false);
    assert.equal(p2.roleName, roleName);
    assert.equal(Object.hasOwn(p2, 'credentialCreated'), false);
    assert.equal(Object.hasOwn(p2, 'runtimeUrl'), false);
    assert.equal(Object.hasOwn(p2, 'databaseAuthorityId'), false);
    assert.doesNotMatch(second.stdout, /postgres(?:ql)?:\/\/|password|runtimeUrl/iu);
    assert.doesNotMatch(second.stdout, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu);
    assert.deepEqual(p2.applied, []);
    assert.deepEqual(p2.skipped, migrationFilenames());

    const human = runBin(['brain', 'init', '--role', fresh.role], env, workspace.cwd);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /ambient runtime credential verified/u);
    assert.equal(`${human.stdout}${human.stderr}`.includes(RUNTIME_PASSWORD_A), false);
    assert.equal(`${human.stdout}${human.stderr}`.includes(encodedRuntimeUrl), false);
    assert.doesNotMatch(`${human.stdout}${human.stderr}`, /postgres(?:ql)?:\/\/|runtimeUrl|password/iu);
    assert.doesNotMatch(`${human.stdout}${human.stderr}`, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu);
  } finally {
    workspace.cleanup();
    try {
      await fresh.drop();
    } finally {
      await dropDerivedRole(roleName);
    }
  }
});

test('cli: a changed ambient password fails after commit without rotating the existing role', dbOpts, async () => {
  const fresh = await createFreshDb();
  const workspace = createBrainWorkspace();
  const roleName = deriveWorkspaceRuntimeRoleName('roster-brain-cli', fresh.role);
  const correctUrl = runtimeUrl(fresh.url, roleName, RUNTIME_PASSWORD_A);
  const wrongUrl = runtimeUrl(fresh.url, roleName, RUNTIME_PASSWORD_B);
  const baseEnv = { ...process.env, ROSTER_BRAIN_ADMIN_URL: fresh.url };
  try {
    const first = runBin(
      ['brain', 'init', '--json', '--role', fresh.role],
      { ...baseEnv, ROSTER_BRAIN_URL: correctUrl },
      workspace.cwd,
    );
    assert.equal(first.status, 0, first.stderr);

    const wrong = runBin(
      ['brain', 'init', '--json', '--role', fresh.role],
      { ...baseEnv, ROSTER_BRAIN_URL: wrongUrl },
      workspace.cwd,
    );
    assert.equal(wrong.status, 1, wrong.stderr);
    const failure = JSON.parse(wrong.stdout) as { code: string; details: { reason: string } };
    assert.equal(failure.code, 'BRAIN_RUNTIME_CREDENTIAL_INVALID');
    assert.equal(failure.details.reason, 'verification-failed');
    assert.equal(`${wrong.stdout}${wrong.stderr}`.includes(RUNTIME_PASSWORD_B), false);
    assert.equal(`${wrong.stdout}${wrong.stderr}`.includes(wrongUrl), false);

    const retry = runBin(
      ['brain', 'init', '--json', '--role', fresh.role],
      { ...baseEnv, ROSTER_BRAIN_URL: correctUrl },
      workspace.cwd,
    );
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).roleCreated, false);
  } finally {
    workspace.cleanup();
    try {
      await fresh.drop();
    } finally {
      await dropDerivedRole(roleName);
    }
  }
});

test('cli: brain doctor green after init (case 9/10)', dbOpts, async () => {
  const fresh = await createFreshDb();
  const workspace = createBrainWorkspace();
  const roleName = deriveWorkspaceRuntimeRoleName('roster-brain-cli', RUNTIME_ROLE);
  const env = {
    ...process.env,
    ROSTER_BRAIN_ADMIN_URL: fresh.url,
    ROSTER_BRAIN_URL: runtimeUrl(fresh.url, roleName, RUNTIME_PASSWORD_A),
  };
  try {
    runBin(['brain', 'init', '--silent'], env, workspace.cwd);
    const r = runBin(['brain', 'doctor', '--json'], env, workspace.cwd);
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(r.stdout);
    assert.equal(p.ok, true);
  } finally {
    workspace.cleanup();
    try {
      await fresh.drop();
    } finally {
      await dropDerivedRole(roleName);
    }
  }
});
