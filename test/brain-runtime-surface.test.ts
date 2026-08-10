import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redactBrainProviderFailure } from '../src/commands/brain.ts';
import { ConditionalWriteUnsupported } from '../src/lib/brain/s3.ts';
import { RosterError } from '../src/lib/errors.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const PROJECT_ROOT = process.cwd();

const LEGACY_INVOCATIONS: Array<{ verb: string; argv: string[] }> = [
  { verb: 'mount', argv: ['mount', '/path/that/must-not-be-read'] },
  { verb: 'table', argv: ['table', 'create', 'notes', '--col', 'body:text'] },
  { verb: 'sql', argv: ['sql', 'SELECT 1'] },
  { verb: 'config', argv: ['config', 'set', 'files.bucket', 'must-not-be-set'] },
  { verb: 'reindex', argv: ['reindex', '--yes'] },
  { verb: 'gc', argv: ['gc', '--yes'] },
  { verb: 'export', argv: ['export', '--out', '/path/that/must-not-be-written'] },
  { verb: 'import', argv: ['import', '/path/that/must-not-be-read'] },
];

// A workspace-less cwd with every ambient Brain and object-storage credential
// removed: a refusal here provably precedes the workspace read, the environment
// read, pool creation, and any filesystem access to the path on the command line.
function sealedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'ROSTER_BRAIN_URL',
    'ROSTER_BRAIN_ADMIN_URL',
    'ROSTER_BRAIN_URL_NEXT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) delete env[name];
  return env;
}

function runBrain(argv: string[], cwd: string) {
  return spawnSync(process.execPath, [BIN, 'brain', ...argv], {
    encoding: 'utf8',
    env: sealedEnv(),
    cwd,
  });
}

function withEmptyCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-surface-'));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('every legacy Brain spelling stays recognized and fails closed before any I/O', () => {
  withEmptyCwd((cwd) => {
    for (const { verb, argv } of LEGACY_INVOCATIONS) {
      const result = runBrain([...argv, '--json'], cwd);
      assert.equal(result.status, 1, `${verb}: ${result.stderr}`);
      assert.equal(result.stderr, '', verb);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        code: string;
        details: { command: string };
      };
      assert.equal(payload.ok, false, verb);
      assert.equal(payload.code, 'BRAIN_LEGACY_COMMAND_DISABLED', verb);
      assert.deepEqual(payload.details, { command: `brain ${verb}` }, verb);
    }
  });
});

test('brain query fails closed before reading the workspace or the environment', () => {
  withEmptyCwd((cwd) => {
    const result = runBrain(['query', 'anything at all', '--json'], cwd);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout) as {
      code: string;
      details: { command: string; blocked_by: string[] };
    };
    assert.equal(payload.code, 'BRAIN_RETRIEVAL_NOT_READY');
    assert.deepEqual(payload.details, { command: 'brain query', blocked_by: ['352'] });
  });
});

test('the canonical Brain surface is exactly the spec verb list', () => {
  const specContext = readFileSync(join(PROJECT_ROOT, 'spec/CONTEXT.md'), 'utf8');
  const readme = readFileSync(join(PROJECT_ROOT, 'README.md'), 'utf8');
  const canonical = 'roster brain init|doctor|ingest|save|get|query|event|link|merge|fs';
  const record = 'roster brain record run|feedback|artifact|decision';
  for (const line of [canonical, record]) {
    assert.ok(specContext.includes(line), `spec/CONTEXT.md must declare: ${line}`);
    assert.ok(readme.includes(line), `README.md must mirror the spec surface: ${line}`);
  }
});

test('shipped guidance never instructs an agent to run a disabled Brain verb', () => {
  const documents = [
    'README.md',
    'docs/API.md',
    'docs/HOWTO.md',
    'skills/brain/SKILL.md',
    'templates/scaffold/brain/RESOLVER.md',
    'templates/CONTEXT.template.md',
    'templates/env.example',
  ];
  const disabled = /roster brain (mount|table|sql|config|reindex|gc|export|import|query)\b/gu;
  const offenders: string[] = [];
  for (const relative of documents) {
    const text = readFileSync(join(PROJECT_ROOT, relative), 'utf8');
    // Only fenced command blocks are instructions to RUN something; prose that
    // names a disabled verb in order to say it refuses is required, not a bug.
    const blocks = text.split(/^```/mu).filter((_, index) => index % 2 === 1);
    for (const block of [...blocks, ...(relative.endsWith('.example') ? [text] : [])]) {
      for (const match of block.matchAll(disabled)) offenders.push(`${relative}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// #383 §6.5: `record --file` may not touch caller-supplied content until the
// declaration and the runtime credential have both been accepted. A path that
// does not exist proves it: if the file were read first the failure would be a
// workspace-io PARENT_NOT_FOUND, not the activation refusal.
test('brain record --file refuses on configuration before reading the named file', () => {
  const unreadable = 'no-such-dir/must-not-be-read.json';
  const cases: Array<{ brain: string[]; code: string }> = [
    { brain: [], code: 'BRAIN_NOT_CONFIGURED' },
    {
      brain: ['brain:', '  secrets_path: /roster-brain-surface'],
      code: 'BRAIN_CONFIGURATION_INCOMPLETE',
    },
    {
      brain: [
        'brain:',
        '  secrets_path: /roster-brain-surface',
        '  storage:',
        '    bucket: roster-brain-surface-vault',
        '    region: eu-central-1',
      ],
      code: 'BRAIN_RUNTIME_CREDENTIAL_INVALID',
    },
  ];
  for (const entry of cases) {
    const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-record-order-'));
    try {
      writeFileSync(join(cwd, 'roster.yaml'), [
        'schema_version: 2',
        'workspace_id: roster-brain-surface',
        ...entry.brain,
        'functions: {}',
        'hosts:',
        '  codex: enabled',
        'tool_uses: []',
        '',
      ].join('\n'), 'utf8');
      const result = runBrain(['record', 'run', '--file', unreadable, '--json'], cwd);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, '');
      const payload = JSON.parse(result.stdout) as { code: string };
      assert.equal(payload.code, entry.code, `${entry.code}: ${result.stdout}`);
      assert.equal(result.stdout.includes(unreadable), false, 'the unread path must not be echoed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

// #383 §6.5 step 6 precedes step 7: an invalid runtime credential must refuse
// before an object-storage client exists. The tracked endpoint points at an
// unroutable host, so a constructed client would stall instead of exiting fast.
test('brain fs refuses a malformed runtime credential before constructing a store', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-brain-fs-order-'));
  try {
    writeFileSync(join(cwd, 'roster.yaml'), [
      'schema_version: 2',
      'workspace_id: roster-brain-surface',
      'brain:',
      '  secrets_path: /roster-brain-surface',
      '  storage:',
      '    bucket: roster-brain-surface-vault',
      '    region: eu-central-1',
      '    endpoint: https://unroutable-fixture.example.com',
      'functions: {}',
      'hosts:',
      '  codex: enabled',
      'tool_uses: []',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(cwd, 'payload.md'), '# payload\n', 'utf8');
    const env = sealedEnv();
    env['ROSTER_BRAIN_URL'] = 'postgresql://wrong_role:short@127.0.0.1:1/brain';
    env['AWS_ACCESS_KEY_ID'] = 'AKIAORDERINGFIXTURE0';
    env['AWS_SECRET_ACCESS_KEY'] = 'ordering-fixture-secret';
    for (const argv of [
      ['fs', 'put', '--kind', 'concept', '--slug', 'x', 'payload.md'],
      ['fs', 'get', '--kind', 'concept', '--slug', 'x', 'payload.md'],
      ['fs', 'rm', '--kind', 'concept', '--slug', 'x', 'payload.md'],
    ]) {
      const started = Date.now();
      const result = spawnSync(process.execPath, [BIN, 'brain', ...argv, '--json'], {
        encoding: 'utf8', env, cwd, timeout: 10_000,
      });
      assert.ok(Date.now() - started < 10_000, `${argv.join(' ')} must refuse before dialing`);
      assert.equal(result.status, 1, `${argv.join(' ')}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout) as { code: string; details: { reason: string } };
      assert.equal(payload.code, 'BRAIN_RUNTIME_CREDENTIAL_INVALID', argv.join(' '));
      assert.equal(payload.details.reason, 'role-mismatch', argv.join(' '));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// #383 B2(b): the provider-failure redactor must classify NARROWLY. A network
// syscall or a pg/AWS marker is a provider failure; a local filesystem error is
// a Roster bug and must keep its own identity rather than hiding behind a stable
// Brain code.
test('the provider-failure redactor narrows to network and pg/AWS shapes', () => {
  const connectFailure = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
    syscall: 'connect',
    code: 'ECONNREFUSED',
    address: '127.0.0.1',
    port: 1,
  });
  const redactedConnect = redactBrainProviderFailure(connectFailure);
  assert.ok(redactedConnect instanceof RosterError);
  assert.equal(redactedConnect.code, 'BRAIN_CONNECTION_FAILED');
  assert.deepEqual(redactedConnect.details, { reason: 'connect-failed' });
  assert.doesNotMatch(
    `${redactedConnect.header}${redactedConnect.body}${redactedConnect.remedy}`,
    /127\.0\.0\.1|:1\b/u,
  );

  const sqlFailure = Object.assign(new Error('permission denied for schema brain_meta'), {
    severity: 'ERROR',
    code: '42501',
    routine: 'aclcheck_error',
  });
  const redactedSql = redactBrainProviderFailure(sqlFailure);
  assert.ok(redactedSql instanceof RosterError);
  assert.equal(redactedSql.code, 'BRAIN_CONNECTION_FAILED');
  assert.deepEqual(redactedSql.details, { reason: 'query-failed' });

  const awsFailure = Object.assign(new Error('Access Denied for bucket private-vault'), {
    $metadata: { httpStatusCode: 403 },
  });
  assert.equal((redactBrainProviderFailure(awsFailure) as RosterError).code, 'BRAIN_CONNECTION_FAILED');

  // A local filesystem failure propagates unchanged: `open` is not a network
  // syscall and ENOENT is not a SQLSTATE.
  const localFailure = Object.assign(new Error("ENOENT: no such file or directory, open 'x.json'"), {
    syscall: 'open',
    code: 'ENOENT',
    errno: -2,
    path: 'x.json',
  });
  assert.equal(redactBrainProviderFailure(localFailure), localFailure);

  const bug = new TypeError('cannot read properties of undefined');
  assert.equal(redactBrainProviderFailure(bug), bug);

  // A RosterError is authored output and is never reclassified.
  const authored = new RosterError({
    header: 'h', body: 'b', remedy: 'r', exitCode: 1, code: 'BRAIN_NOT_CONFIGURED', details: {},
  });
  assert.equal(redactBrainProviderFailure(authored), authored);
});

// #383 B2(a): the object key embeds the tracked root prefix, so a store failure
// may never carry it.
test('an unsupported conditional write reports no object key', () => {
  const failure = new ConditionalWriteUnsupported();
  assert.equal(failure.name, 'ConditionalWriteUnsupported');
  assert.doesNotMatch(failure.message, /files\/|objects\/|team\/|'/u);
  assert.match(failure.message, /conditional writes/u);
});

// #383: a TLS handshake failure carries NO syscall, NO severity/SQLSTATE, and NO
// $metadata — but it DOES name the private host in its own message. Without an
// explicit TLS class it fell through the classifier and errors.ts printed it
// verbatim.
test('a TLS handshake failure is classified and never echoes the private host', () => {
  const PRIVATE_HOST = 'db.private.example';
  const altname = Object.assign(
    new Error(
      `Hostname/IP does not match certificate's altnames: Host: ${PRIVATE_HOST}. `
      + `is not in the cert's altnames: DNS:*.other.example`,
    ),
    {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      host: PRIVATE_HOST,
      cert: { subject: { CN: '*.other.example' } },
    },
  );
  const redacted = redactBrainProviderFailure(altname);
  assert.ok(redacted instanceof RosterError);
  assert.equal(redacted.code, 'BRAIN_CONNECTION_FAILED');
  assert.deepEqual(redacted.details, { reason: 'tls-failed' });

  // Both output modes are built from exactly these fields: the human renderer
  // from header/body/remedy, the --json envelope from those plus details.
  const human = `${redacted.header}${redacted.body}${redacted.remedy}`;
  const json = JSON.stringify({
    ok: false,
    code: redacted.code,
    message: `${redacted.header}\n${redacted.body}`,
    remedy: redacted.remedy,
    details: redacted.details,
  });
  for (const [mode, rendered] of [['human', human], ['json', json]] as Array<[string, string]>) {
    assert.equal(rendered.includes(PRIVATE_HOST), false, `${mode}: leaked the private host`);
    assert.equal(rendered.includes('altnames'), false, `${mode}: echoed the TLS message`);
    assert.equal(rendered.includes('other.example'), false, `${mode}: echoed the certificate subject`);
  }

  // Every ERR_TLS_* code, plus the OpenSSL verification verdicts that surface on
  // err.code without one.
  for (const code of [
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_TLS_INVALID_PROTOCOL_VERSION',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]) {
    const failure = Object.assign(new Error(`tls failure naming ${PRIVATE_HOST}`), { code });
    const result = redactBrainProviderFailure(failure);
    assert.ok(result instanceof RosterError, code);
    assert.equal(result.code, 'BRAIN_CONNECTION_FAILED', code);
    assert.deepEqual(result.details, { reason: 'tls-failed' }, code);
    assert.equal(
      `${result.header}${result.body}${result.remedy}`.includes(PRIVATE_HOST),
      false,
      code,
    );
  }

  // A TLS failure that ALSO carries a network syscall keeps the precise verdict.
  const duringRead = Object.assign(new Error(`read failure naming ${PRIVATE_HOST}`), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    syscall: 'read',
  });
  assert.deepEqual(
    (redactBrainProviderFailure(duringRead) as RosterError).details,
    { reason: 'tls-failed' },
  );

  // A non-TLS error whose code merely starts with ERR_ is still not a provider
  // failure — the narrowing from round 3 must hold.
  const notTls = Object.assign(new Error('bad argument'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(redactBrainProviderFailure(notTls), notTls);
});
