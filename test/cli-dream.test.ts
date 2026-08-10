import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseDreamArgs } from '../src/lib/dream-args.ts';
import { executeDreamStatus } from '../src/commands/dream.ts';
import { RosterError } from '../src/lib/errors.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const WORKSPACE_ID = 'dream-cli-test';

function ok(args: string[]) {
  const parsed = parseDreamArgs(args);
  assert.equal(parsed.kind, 'ok', JSON.stringify(parsed));
  return parsed as Extract<ReturnType<typeof parseDreamArgs>, { kind: 'ok' }>;
}

function bad(args: string[]): string {
  const parsed = parseDreamArgs(args);
  assert.equal(parsed.kind, 'err', JSON.stringify(parsed));
  return (parsed as { kind: 'err'; message: string }).message;
}

function writeWorkspace(root: string, withBrain: boolean): void {
  writeFileSync(
    join(root, 'roster.yaml'),
    [
      'schema_version: 2',
      `workspace_id: ${WORKSPACE_ID}`,
      ...(withBrain
        ? [
            'brain:',
            `  secrets_path: /${WORKSPACE_ID}`,
            '  storage:',
            `    bucket: ${WORKSPACE_ID}`,
            '    region: eu-central-1',
          ]
        : []),
      'functions: {}',
      'hosts:',
      '  codex: enabled',
      'tool_uses: []',
      '',
    ].join('\n'),
    'utf8',
  );
}

test('dream status parses its scope aliases and refuses every other verb', () => {
  assert.deepEqual({ ...ok(['status']) }, {
    kind: 'ok', subcommand: 'status', json: false,
    scope: undefined, functionId: undefined, agent: undefined,
  });
  assert.deepEqual({ ...ok(['status', '--json', '--scope', 'agent:gtm/manager']) }, {
    kind: 'ok', subcommand: 'status', json: true,
    scope: 'agent:gtm/manager', functionId: undefined, agent: undefined,
  });
  assert.deepEqual({ ...ok(['status', '--function', 'gtm']) }, {
    kind: 'ok', subcommand: 'status', json: false,
    scope: undefined, functionId: 'gtm', agent: undefined,
  });
  assert.deepEqual({ ...ok(['status', '--agent', 'gtm/manager']) }, {
    kind: 'ok', subcommand: 'status', json: false,
    scope: undefined, functionId: undefined, agent: 'gtm/manager',
  });

  // #358 owns the candidate lifecycle; until it ships the usage error must name
  // only `status`, so a host never believes a candidate surface exists here.
  for (const verb of ['candidates', 'reflect', 'promote', 'status-all']) {
    const message = bad([verb]);
    assert.match(message, /unknown 'dream' subcommand/u, verb);
    assert.match(message, /available: status/u, verb);
    assert.equal(/candidate/u.test(message.replace(verb, '')), false, verb);
  }
  assert.match(bad([]), /missing subcommand for 'dream' \(available: status\)/u);
  assert.match(bad(['status', '--scope']), /--scope requires a value/u);
  assert.match(bad(['status', '--function', '--json']), /--function requires a value/u);
  assert.match(bad(['status', '--force']), /unknown flag for 'dream status'/u);
  assert.match(bad(['status', 'workspace']), /unexpected positional argument/u);
});

test('a workspace with no brain block answers not_due at exit 0 without a pool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-local-'));
  const originalUrl = process.env.ROSTER_BRAIN_URL;
  const originalAdminUrl = process.env.ROSTER_BRAIN_ADMIN_URL;
  const logged: string[] = [];
  const log = console.log;
  console.log = (value?: unknown) => { logged.push(String(value)); };
  try {
    writeWorkspace(root, false);
    // Both ambient credentials are removed: had a pool been constructed, the
    // runtime credential resolver would have thrown BRAIN_RUNTIME_CREDENTIAL_INVALID
    // instead of returning a verdict, so exit 0 IS the no-pool proof.
    delete process.env.ROSTER_BRAIN_URL;
    delete process.env.ROSTER_BRAIN_ADMIN_URL;
    const code = await executeDreamStatus({ cwd: root, json: true });
    assert.equal(code, 0);
    const result = JSON.parse(logged.join('\n')) as Record<string, never>;
    assert.equal(result['ok'], true);
    assert.equal(result['status'], 'not_due');
    assert.equal(result['workspace_id'], WORKSPACE_ID);
    assert.deepEqual(
      (result['reasons'] as unknown as { code: string }[]).map((reason) => reason.code),
      ['BRAIN_NOT_CONFIGURED'],
    );
    assert.equal((result['frontier'] as unknown as { ordinal: number }).ordinal, 0);
    assert.equal((result['watermark'] as unknown as { state: string }).state, 'genesis');
    assert.equal((result['policy'] as unknown as { source: string }).source, 'built-in');
  } finally {
    console.log = log;
    if (originalUrl === undefined) delete process.env.ROSTER_BRAIN_URL;
    else process.env.ROSTER_BRAIN_URL = originalUrl;
    if (originalAdminUrl === undefined) delete process.env.ROSTER_BRAIN_ADMIN_URL;
    else process.env.ROSTER_BRAIN_ADMIN_URL = originalAdminUrl;
    rmSync(root, { recursive: true, force: true });
  }
});

test('conflicting scope aliases are refused before any Brain contact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-scope-'));
  try {
    writeWorkspace(root, false);
    await assert.rejects(
      executeDreamStatus({ cwd: root, json: true, scope: 'function:gtm', agent: 'gtm/manager' }),
      (error: unknown) => error instanceof RosterError && error.code === 'IDENTITY_INVALID',
    );
    await assert.rejects(
      executeDreamStatus({ cwd: root, json: true, scope: 'agent:gtm' }),
      (error: unknown) => error instanceof RosterError && error.code === 'IDENTITY_INVALID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the built CLI routes dream status and reports it in --help', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-bin-'));
  try {
    writeWorkspace(root, false);
    const env = { ...process.env };
    delete env['ROSTER_BRAIN_URL'];
    delete env['ROSTER_BRAIN_ADMIN_URL'];
    const status = spawnSync(process.execPath, [BIN, 'dream', 'status', '--json'], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    assert.equal(status.status, 0, status.stderr);
    const parsed = JSON.parse(status.stdout) as { ok: boolean; status: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'not_due');

    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', cwd: root, env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /roster dream status/u);

    const unknown = spawnSync(process.execPath, [BIN, 'dream', 'candidates', '--json'], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    assert.notEqual(unknown.status, 0);
    assert.match(JSON.parse(unknown.stdout).message as string, /available: status/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
