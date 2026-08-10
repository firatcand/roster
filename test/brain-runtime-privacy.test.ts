import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { deriveWorkspaceRuntimeRoleName, RUNTIME_ROLE } from '../src/lib/brain/roles.ts';
import { MemoryFileStore, type FileStore, type PutOpts } from '../src/lib/brain/s3.ts';
import { executeBrainFs } from '../src/commands/brain.ts';
import { RosterError } from '../src/lib/errors.ts';
import { ADMIN_URL, HAS_DB, createFreshDb } from './brain-helpers.ts';

const dbOpts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const BIN = resolve(process.cwd(), 'bin/roster.js');
const WORKSPACE_ID = 'roster-brain-privacy';
const RUNTIME_ROLE_NAME = deriveWorkspaceRuntimeRoleName(WORKSPACE_ID, RUNTIME_ROLE);

// Exact fixture values. (2) below — their literal absence — is the load-bearing
// half of the scan; the shape patterns only catch what the fixture cannot cover.
const FIXTURE = {
  runtimePassword: `Aa0_${randomBytes(32).toString('base64url')}-A1_`,
  adminPassword: `Bb1_${randomBytes(32).toString('base64url')}-B2_`,
  awsAccessKeyId: 'AKIAPRIVACYFIXTURE01',
  awsSecretAccessKey: 'privacy-fixture-secret-value',
  bucket: 'roster-brain-privacy-vault',
  endpointHost: 'privacy-fixture.example.com',
  // A refused TCP connect drives each verb past activation. The address is a
  // connection-string FRAGMENT, so it is scanned like every other one: a raw
  // driver message (`connect ECONNREFUSED <host>:<port>`) reaching stdout is
  // exactly the leak §10 forbids.
  dbHost: '127.0.0.1:1',
};

const FORBIDDEN_SHAPES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'connection string', pattern: /postgres(?:ql)?:\/\//iu },
  { name: 'url userinfo', pattern: /:\/\/[^/@\s]*:[^/@\s]*@/u },
  { name: 'password keyword', pattern: /\bPASSWORD\b/u },
  { name: 'aws long-term key id', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'aws session key id', pattern: /\bASIA[0-9A-Z]{16}\b/u },
  { name: 'aws credential env name', pattern: /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/u },
  { name: 's3 uri', pattern: /\bs3:\/\//u },
];

function workspace(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-privacy-'));
  writeFileSync(join(cwd, 'roster.yaml'), [
    'schema_version: 2',
    `workspace_id: ${WORKSPACE_ID}`,
    'brain:',
    `  secrets_path: /${WORKSPACE_ID}`,
    '  storage:',
    `    bucket: ${FIXTURE.bucket}`,
    '    region: eu-central-1',
    `    endpoint: https://${FIXTURE.endpointHost}`,
    '    root_prefix: team',
    'functions: {}',
    'hosts:',
    '  codex: enabled',
    'tool_uses: []',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(cwd, 'payload.md'), '# payload\n', 'utf8');
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'ROSTER_BRAIN_URL',
    'ROSTER_BRAIN_ADMIN_URL',
    'ROSTER_BRAIN_URL_NEXT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) delete env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const INVOCATIONS: string[][] = [
  ['init'],
  ['doctor'],
  ['ingest', '--manifest', '{"source":{"kind":"workspace-file","workspacePath":"payload.md"}}'],
  ['save', '--kind', 'concept', '--slug', 'x'],
  ['get', '--kind', 'concept', '--slug', 'x'],
  ['event', '--kind', 'note'],
  ['link', 'a', 'rel', 'b'],
  ['merge', 'a', 'b'],
  ['record', 'run', '--payload', '{}'],
  ['fs', 'put', '--kind', 'concept', '--slug', 'x', 'payload.md'],
  ['fs', 'get', '--kind', 'concept', '--slug', 'x', 'payload.md'],
  ['fs', 'ls'],
  ['fs', 'rm', '--kind', 'concept', '--slug', 'x', 'payload.md'],
  ['query', 'anything'],
  ['mount', 'payload.md'],
  ['config', 'set', 'files.bucket', 'nope'],
];

const CREDENTIAL_STATES: Array<{ name: string; env: Record<string, string | undefined> }> = [
  { name: 'no credentials', env: {} },
  {
    name: 'every credential present',
    env: {
      ROSTER_BRAIN_URL: `postgresql://${RUNTIME_ROLE_NAME}:${FIXTURE.runtimePassword}@${FIXTURE.dbHost}/brain`,
      ROSTER_BRAIN_ADMIN_URL: `postgresql://owner:${FIXTURE.adminPassword}@${FIXTURE.dbHost}/brain`,
      AWS_ACCESS_KEY_ID: FIXTURE.awsAccessKeyId,
      AWS_SECRET_ACCESS_KEY: FIXTURE.awsSecretAccessKey,
    },
  },
];

test('no Brain verb prints a credential, a namespace locator, or ingested content', () => {
  const ws = workspace();
  try {
    for (const state of CREDENTIAL_STATES) {
      for (const argv of INVOCATIONS) {
        for (const jsonMode of [true, false]) {
          const label = `${state.name} · roster brain ${argv.join(' ')}${jsonMode ? ' --json' : ''}`;
          const result = spawnSync(
            process.execPath,
            [BIN, 'brain', ...argv, ...(jsonMode ? ['--json'] : [])],
            { encoding: 'utf8', env: envWith(state.env), cwd: ws.cwd, timeout: 15_000 },
          );
          const output = `${result.stdout}${result.stderr}`;
          for (const shape of FORBIDDEN_SHAPES) {
            assert.doesNotMatch(output, shape.pattern, `${label}: leaked ${shape.name}`);
          }
          for (const [name, value] of Object.entries(FIXTURE)) {
            assert.equal(output.includes(value), false, `${label}: leaked fixture ${name}`);
          }
        }
      }
    }
  } finally {
    ws.cleanup();
  }
});

test('the redaction scan does not reject legal content-addressed output', () => {
  const legal = [
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    RUNTIME_ROLE_NAME,
    '/roster-brain-privacy',
  ].join(' ');
  for (const shape of FORBIDDEN_SHAPES) {
    assert.doesNotMatch(legal, shape.pattern, `false positive on ${shape.name}`);
  }
});

// #383 B2(c): the refusal scan above never reaches a SUCCESSFUL object-storage
// path, where the bucket, key, and s3:// URI actually exist — nor an S3 FAILURE,
// where the provider's own message carries them. Both run in-process against a
// real ledger and a store double so no network is touched.
class LeakyFileStore implements FileStore {
  private readonly failOn: 'put' | 'get' | 'del' | null;
  private readonly inner = new MemoryFileStore();

  constructor(failOn: 'put' | 'get' | 'del' | null) {
    this.failOn = failOn;
  }

  private leak(operation: string): Error {
    const error = new Error(
      `S3 ${operation} failed: https://${FIXTURE.endpointHost}/${FIXTURE.bucket}/team/files/concept/rrf/post.md `
      + `(bucket ${FIXTURE.bucket}, key s3://${FIXTURE.bucket}/team/files/concept/rrf/post.md, `
      + `credential ${FIXTURE.awsAccessKeyId})`,
    );
    // A real AWS SDK service exception always carries $metadata; the fixture
    // matches that shape so the redactor classifies it the same way.
    error.name = 'S3ServiceException';
    (error as Error & { $metadata: unknown }).$metadata = { httpStatusCode: 403, attempts: 1 };
    return error;
  }

  async head(key: string) {
    return await this.inner.head(key);
  }

  async put(key: string, body: Buffer, opts?: PutOpts) {
    if (this.failOn === 'put') throw this.leak('PutObject');
    return await this.inner.put(key, body, opts);
  }

  async get(key: string) {
    if (this.failOn === 'get') throw this.leak('GetObject');
    return await this.inner.get(key);
  }

  async del(key: string): Promise<void> {
    if (this.failOn === 'del') throw this.leak('DeleteObject');
    await this.inner.del(key);
  }
}

function captureOutput(): { restore: () => string } {
  const chunks: string[] = [];
  const log = console.log;
  const errorLog = console.error;
  const writeErr = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]): void => { chunks.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]): void => { chunks.push(args.map(String).join(' ')); };
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: (): string => {
      console.log = log;
      console.error = errorLog;
      process.stderr.write = writeErr;
      return chunks.join('\n');
    },
  };
}

function assertRedacted(output: string, label: string): void {
  for (const shape of FORBIDDEN_SHAPES) {
    assert.doesNotMatch(output, shape.pattern, `${label}: leaked ${shape.name}`);
  }
  for (const [name, value] of Object.entries(FIXTURE)) {
    assert.equal(output.includes(value), false, `${label}: leaked fixture ${name}`);
  }
}

test('successful and failing object-storage paths print no namespace locator', dbOpts, async () => {
  const fresh = await createFreshDb();
  const roleName = deriveWorkspaceRuntimeRoleName(WORKSPACE_ID, RUNTIME_ROLE);
  const ws = workspace();
  const runtimeUrl = (() => {
    const parsed = new URL(fresh.url);
    parsed.username = roleName;
    parsed.password = FIXTURE.runtimePassword;
    return parsed.toString();
  })();
  const liveEnv = envWith({
    ROSTER_BRAIN_ADMIN_URL: fresh.url,
    ROSTER_BRAIN_URL: runtimeUrl,
    AWS_ACCESS_KEY_ID: FIXTURE.awsAccessKeyId,
    AWS_SECRET_ACCESS_KEY: FIXTURE.awsSecretAccessKey,
  });
  const previous = { ...process.env };
  try {
    const init = spawnSync(process.execPath, [BIN, 'brain', 'init', '--json'], {
      encoding: 'utf8', env: liveEnv, cwd: ws.cwd,
    });
    assert.equal(init.status, 0, init.stderr);

    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, liveEnv);

    const filePath = join(ws.cwd, 'post.md');
    writeFileSync(filePath, '# RRF\nbody bytes\n', 'utf8');
    const healthy = new LeakyFileStore(null);
    const makeStore = async (): Promise<FileStore> => healthy;

    for (const [label, run] of [
      ['put', () => executeBrainFs({
        cwd: ws.cwd, json: true, makeStore, op: 'put', kind: 'concept', slug: 'rrf', file: filePath,
      })],
      ['ls', () => executeBrainFs({ cwd: ws.cwd, json: true, makeStore, op: 'ls' })],
      ['get', () => executeBrainFs({
        cwd: ws.cwd, json: true, makeStore, op: 'get', kind: 'concept', slug: 'rrf',
        filename: 'post.md', out: join(ws.cwd, 'fetched.md'),
      })],
      ['put human', () => executeBrainFs({
        cwd: ws.cwd, json: false, makeStore, op: 'put', kind: 'concept', slug: 'rrf', file: filePath,
      })],
    ] as Array<[string, () => Promise<number>]>) {
      const capture = captureOutput();
      let output = '';
      try {
        const code = await run();
        assert.equal(code, 0, label);
      } finally {
        output = capture.restore();
      }
      assertRedacted(output, `success ${label}`);
      assert.ok(output.length > 0, `${label} produced output`);
    }

    // An object-storage FAILURE: the provider message names the bucket, the key,
    // the endpoint, and the credential. None may survive to a transcript.
    for (const [label, failing, run] of [
      ['rm', new LeakyFileStore('del'), (store: FileStore) => executeBrainFs({
        cwd: ws.cwd, json: true, makeStore: async () => store, op: 'rm',
        kind: 'concept', slug: 'rrf', filename: 'post.md',
      })],
      ['put', new LeakyFileStore('put'), (store: FileStore) => executeBrainFs({
        cwd: ws.cwd, json: true, makeStore: async () => store, op: 'put',
        kind: 'concept', slug: 'leaky', file: filePath,
      })],
    ] as Array<[string, FileStore, (store: FileStore) => Promise<number>]>) {
      const capture = captureOutput();
      let output = '';
      let thrown: unknown;
      try {
        await run(failing);
      } catch (error) {
        thrown = error;
      } finally {
        output = capture.restore();
      }
      const rendered = thrown === undefined
        ? output
        : `${output}\n${thrown instanceof RosterError
          ? `${thrown.header}\n${thrown.body}\n${thrown.remedy}\n${JSON.stringify(thrown.details)}`
          : String(thrown)}`;
      assertRedacted(rendered, `failure ${label}`);
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    ws.cleanup();
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
  }
});
