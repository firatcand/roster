import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertBrainActivationComplete,
  resolveBrainActivationConfig,
  type BrainActivationConfig,
} from '../src/lib/brain-activation-config.ts';
import { classifyBrainDeclaration } from '../src/lib/workspace-record.ts';
import { RosterError } from '../src/lib/errors.ts';
import { deriveWorkspaceRuntimeRoleName, RUNTIME_ROLE } from '../src/lib/brain/roles.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const WORKSPACE_ID = 'roster-brain-activation';
const RUNTIME_ROLE_NAME = deriveWorkspaceRuntimeRoleName(WORKSPACE_ID, RUNTIME_ROLE);
const RUNTIME_PASSWORD = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
// TEST-NET-1 is unroutable: any verb that opened a socket would hang far past
// the per-case budget instead of refusing.
const UNROUTABLE = '192.0.2.1:5432';
const RUNTIME_URL = `postgresql://${RUNTIME_ROLE_NAME}:${RUNTIME_PASSWORD}@${UNROUTABLE}/brain`;
const ADMIN_URL = `postgresql://owner:${RUNTIME_PASSWORD}@${UNROUTABLE}/brain`;
// Port 1 refuses immediately, so a verb that gets PAST activation fails fast
// instead of burning the unroutable budget the refusal cases rely on.
const REFUSED = '127.0.0.1:1';
const RUNTIME_URL_REFUSED = `postgresql://${RUNTIME_ROLE_NAME}:${RUNTIME_PASSWORD}@${REFUSED}/brain`;
const ADMIN_URL_REFUSED = `postgresql://owner:${RUNTIME_PASSWORD}@${REFUSED}/brain`;
const CASE_BUDGET_MS = 10_000;

type BrainBlock = 'none' | 'secrets-only' | 'storage-only' | 'storage-without-bucket' | 'complete';

function registry(block: BrainBlock): string {
  const brain: Record<BrainBlock, string[]> = {
    none: [],
    'secrets-only': ['brain:', '  secrets_path: /roster-brain-activation'],
    'storage-only': [
      'brain:',
      '  storage:',
      '    bucket: roster-brain-activation-vault',
      '    region: eu-central-1',
    ],
    'storage-without-bucket': [
      'brain:',
      '  secrets_path: /roster-brain-activation',
      '  storage:',
      '    region: eu-central-1',
    ],
    complete: [
      'brain:',
      '  secrets_path: /roster-brain-activation',
      '  storage:',
      '    bucket: roster-brain-activation-vault',
      '    region: eu-central-1',
    ],
  };
  return [
    'schema_version: 2',
    `workspace_id: ${WORKSPACE_ID}`,
    ...brain[block],
    'functions: {}',
    'hosts:',
    '  codex: enabled',
    'tool_uses: []',
    '',
  ].join('\n');
}

function workspace(block: BrainBlock): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-activation-'));
  writeFileSync(join(cwd, 'roster.yaml'), registry(block), 'utf8');
  writeFileSync(join(cwd, 'payload.md'), '# payload\n', 'utf8');
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

type CredentialState = {
  runtime?: boolean;
  admin?: boolean;
  objectStorage?: boolean;
};

function envFor(state: CredentialState, reachable = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'ROSTER_BRAIN_URL',
    'ROSTER_BRAIN_ADMIN_URL',
    'ROSTER_BRAIN_URL_NEXT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) delete env[name];
  if (state.runtime) env['ROSTER_BRAIN_URL'] = reachable ? RUNTIME_URL_REFUSED : RUNTIME_URL;
  if (state.admin) env['ROSTER_BRAIN_ADMIN_URL'] = reachable ? ADMIN_URL_REFUSED : ADMIN_URL;
  if (state.objectStorage) {
    env['AWS_ACCESS_KEY_ID'] = 'AKIAACTIVATIONFIXTURE';
    env['AWS_SECRET_ACCESS_KEY'] = 'activation-fixture-secret';
  }
  return env;
}

const ACTIVATION_VERBS: Array<{ name: string; argv: string[]; s3: 'declared' | 'live'; pg: 'admin' | 'runtime' | 'admin+runtime' }> = [
  { name: 'init', argv: ['init'], s3: 'declared', pg: 'admin+runtime' },
  { name: 'doctor', argv: ['doctor'], s3: 'declared', pg: 'admin' },
  { name: 'ingest', argv: ['ingest', '--manifest', '{"source":{"kind":"workspace-file","workspacePath":"payload.md"}}'], s3: 'live', pg: 'admin' },
  { name: 'save', argv: ['save', '--kind', 'concept', '--slug', 'x'], s3: 'declared', pg: 'runtime' },
  { name: 'get', argv: ['get', '--kind', 'concept', '--slug', 'x'], s3: 'declared', pg: 'runtime' },
  { name: 'event', argv: ['event', '--kind', 'note'], s3: 'declared', pg: 'runtime' },
  { name: 'link', argv: ['link', 'a', 'rel', 'b'], s3: 'declared', pg: 'runtime' },
  { name: 'merge', argv: ['merge', 'a', 'b'], s3: 'declared', pg: 'runtime' },
  { name: 'record', argv: ['record', 'run', '--payload', '{}'], s3: 'declared', pg: 'runtime' },
  { name: 'fs put', argv: ['fs', 'put', '--kind', 'concept', '--slug', 'x', 'payload.md'], s3: 'live', pg: 'runtime' },
  { name: 'fs get', argv: ['fs', 'get', '--kind', 'concept', '--slug', 'x', 'payload.md'], s3: 'live', pg: 'runtime' },
  { name: 'fs ls', argv: ['fs', 'ls'], s3: 'declared', pg: 'runtime' },
  { name: 'fs rm', argv: ['fs', 'rm', '--kind', 'concept', '--slug', 'x', 'payload.md'], s3: 'live', pg: 'runtime' },
];

type Refusal = { ok: boolean; code: string; details: Record<string, unknown> };

function refuse(argv: string[], cwd: string, state: CredentialState): Refusal {
  const started = Date.now();
  const result = spawnSync(process.execPath, [BIN, 'brain', ...argv, '--json'], {
    encoding: 'utf8',
    env: envFor(state),
    cwd,
    timeout: CASE_BUDGET_MS,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1, `${argv.join(' ')}: ${result.stderr}`);
  assert.equal(result.stderr, '', argv.join(' '));
  assert.ok(elapsed < CASE_BUDGET_MS, `${argv.join(' ')} must refuse before opening a socket`);
  return JSON.parse(result.stdout) as Refusal;
}

test('an absent brain block refuses every activation-bearing verb before any I/O', () => {
  const ws = workspace('none');
  try {
    for (const verb of ACTIVATION_VERBS) {
      const payload = refuse(verb.argv, ws.cwd, { runtime: true, admin: true, objectStorage: true });
      assert.equal(payload.code, 'BRAIN_NOT_CONFIGURED', verb.name);
      assert.deepEqual(payload.details, { path: 'roster.yaml' }, verb.name);
    }
  } finally {
    ws.cleanup();
  }
});

test('a half-declared brain block is incomplete activation, not a schema error', () => {
  const cases: Array<{ block: BrainBlock; missing: string[] }> = [
    { block: 'secrets-only', missing: ['object-storage'] },
    { block: 'storage-only', missing: ['postgresql'] },
    { block: 'storage-without-bucket', missing: ['object-storage'] },
  ];
  for (const entry of cases) {
    const ws = workspace(entry.block);
    try {
      for (const verb of ACTIVATION_VERBS) {
        const payload = refuse(verb.argv, ws.cwd, { runtime: true, admin: true, objectStorage: true });
        assert.equal(payload.code, 'BRAIN_CONFIGURATION_INCOMPLETE', `${entry.block} ${verb.name}`);
        assert.deepEqual(
          payload.details,
          { path: 'roster.yaml', axis: 'declaration', missing: entry.missing },
          `${entry.block} ${verb.name}`,
        );
      }
    } finally {
      ws.cleanup();
    }
  }
});

test('a complete declaration gates each verb on exactly its own credential axes', () => {
  const ws = workspace('complete');
  try {
    for (const verb of ACTIVATION_VERBS) {
      if (verb.pg !== 'admin') {
        const payload = refuse(verb.argv, ws.cwd, { admin: true, objectStorage: true });
        assert.equal(payload.code, 'BRAIN_RUNTIME_CREDENTIAL_INVALID', verb.name);
        assert.deepEqual(payload.details, {
          reason: 'missing',
          role_name: RUNTIME_ROLE_NAME,
          secrets_path: '/roster-brain-activation',
        }, verb.name);
      }
      if (verb.pg !== 'runtime') {
        const payload = refuse(verb.argv, ws.cwd, { runtime: true, objectStorage: true });
        assert.equal(payload.code, 'BRAIN_ADMIN_CREDENTIAL_INVALID', verb.name);
        assert.deepEqual(payload.details, {
          reason: 'missing',
          env: 'ROSTER_BRAIN_ADMIN_URL',
          secrets_path: '/roster-brain-activation',
        }, verb.name);
      }
      if (verb.s3 === 'live') {
        const payload = refuse(verb.argv, ws.cwd, { runtime: true, admin: true });
        assert.equal(payload.code, 'BRAIN_CONFIGURATION_INCOMPLETE', verb.name);
        assert.deepEqual(payload.details, {
          path: 'roster.yaml',
          axis: 'ambient',
          missing: ['object-storage'],
        }, verb.name);
      }
    }
  } finally {
    ws.cleanup();
  }
});

test('declared-only verbs never require an ambient object-storage credential', () => {
  const ws = workspace('complete');
  try {
    for (const verb of ACTIVATION_VERBS.filter((entry) => entry.s3 === 'declared')) {
      const state: CredentialState = verb.pg === 'admin'
        ? { admin: true }
        : verb.pg === 'runtime' ? { runtime: true } : { runtime: true, admin: true };
      const result = spawnSync(process.execPath, [BIN, 'brain', ...verb.argv, '--json'], {
        encoding: 'utf8',
        env: envFor(state, true),
        cwd: ws.cwd,
        timeout: CASE_BUDGET_MS,
      });
      // The verb gets past activation and dies on the unroutable database
      // instead — the object-storage axis must not have refused it.
      const code = result.stdout.length > 0
        ? (JSON.parse(result.stdout) as Refusal).code
        : '';
      assert.notEqual(code, 'BRAIN_CONFIGURATION_INCOMPLETE', verb.name);
    }
  } finally {
    ws.cleanup();
  }
});

test('classifyBrainDeclaration separates incompleteness from a malformed value', () => {
  const declaration = (block: BrainBlock) => classifyBrainDeclaration(registry(block));
  assert.deepEqual(declaration('none'), { status: 'absent' });
  assert.deepEqual(declaration('complete'), { status: 'declared' });
  assert.deepEqual(declaration('secrets-only'), { status: 'partial', missing: ['object-storage'] });
  assert.deepEqual(declaration('storage-only'), { status: 'partial', missing: ['postgresql'] });
  assert.deepEqual(declaration('storage-without-bucket'), { status: 'partial', missing: ['object-storage'] });
  assert.deepEqual(
    classifyBrainDeclaration('schema_version: 2\nworkspace_id: w\nbrain:\n  storage:\n    region: eu-central-1\n'),
    { status: 'partial', missing: ['postgresql', 'object-storage'] },
  );
  // Present-but-invalid values stay a schema error: only the strict parser owns them.
  assert.deepEqual(
    classifyBrainDeclaration('schema_version: 2\nworkspace_id: w\nbrain: not-a-mapping\n'),
    { status: 'declared' },
  );
  assert.deepEqual(
    classifyBrainDeclaration('schema_version: 2\nworkspace_id: w\nbrain:\n  secrets_path: /p\n  storage: 5\n'),
    { status: 'declared' },
  );
});

test('resolveBrainActivationConfig is a pure predicate over declaration and ambient state', () => {
  const declared = { postgres: 'runtime', objectStorage: 'declared' } as const;
  const live = { postgres: 'admin', objectStorage: 'live' } as const;
  const ws = workspace('complete');
  const partial = workspace('secrets-only');
  const absent = workspace('none');
  try {
    assert.deepEqual(resolveBrainActivationConfig(absent.cwd, declared, {}), { status: 'absent' });
    assert.deepEqual(resolveBrainActivationConfig(partial.cwd, declared, {}), {
      status: 'incomplete',
      axis: 'declaration',
      missing: ['object-storage'],
    });
    assert.deepEqual(resolveBrainActivationConfig(ws.cwd, live, {}), {
      status: 'incomplete',
      axis: 'ambient',
      missing: ['object-storage'],
    });
    const complete = resolveBrainActivationConfig(ws.cwd, declared, {}) as Extract<
      BrainActivationConfig,
      { status: 'complete' }
    >;
    assert.equal(complete.status, 'complete');
    assert.equal(complete.workspaceId, WORKSPACE_ID);
    assert.equal(complete.brain.storage.bucket, 'roster-brain-activation-vault');

    assert.throws(
      () => assertBrainActivationComplete(ws.cwd, 'admin', {}),
      (error: unknown) => error instanceof RosterError && error.code === 'BRAIN_ADMIN_CREDENTIAL_INVALID',
    );
    assert.throws(
      () => assertBrainActivationComplete(ws.cwd, 'admin', { ROSTER_BRAIN_ADMIN_URL: 'not-a-url' }),
      (error: unknown) => error instanceof RosterError
        && error.code === 'BRAIN_ADMIN_CREDENTIAL_INVALID'
        && error.details['reason'] === 'malformed',
    );
    assert.deepEqual(
      assertBrainActivationComplete(ws.cwd, 'admin', { ROSTER_BRAIN_ADMIN_URL: ADMIN_URL }).workspaceId,
      WORKSPACE_ID,
    );
    // `admin+runtime` defers the admin check to the shipped runtime-first ordering.
    assert.equal(
      assertBrainActivationComplete(ws.cwd, 'admin+runtime', {}).workspaceId,
      WORKSPACE_ID,
    );
  } finally {
    ws.cleanup();
    partial.cleanup();
    absent.cleanup();
  }
});
