import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { executeRun } from '../src/lib/schedule-run.ts';

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-run-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSchedules(root: string, fn: string, body: string): void {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), body, 'utf8');
}

function captureStdout(fn: () => Promise<unknown>): Promise<{ out: string; result: unknown }> {
  const buf: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => buf.push(args.map(String).join(' '));
  return fn()
    .then((result) => ({ out: buf.join('\n'), result }))
    .finally(() => {
      console.log = orig;
    });
}

const yamlClaude = `version: 1
schedules:
  - name: nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: claude
    install_mode: ui-handoff
    status: pending-ui-install
`;

const yamlCodex = `version: 1
schedules:
  - name: heartbeat
    agent: noop
    plan: noop
    cron: "*/5 * * * *"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

test('executeRun (claude): prints the orchestrator prompt, does NOT spawn anything', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'gtm', yamlClaude);
    let spawnCalls = 0;
    const { out, result } = await captureStdout(() =>
      executeRun({
        cwd: root,
        name: 'nightly',
        functionName: undefined,
        silent: false,
        spawn: (() => {
          spawnCalls++;
          throw new Error('spawn should not be called for claude');
        }) as never,
      }),
    );
    assert.equal(spawnCalls, 0);
    const r = result as { tool: string; exitCode: number; prompt: string };
    assert.equal(r.tool, 'claude');
    assert.equal(r.exitCode, 0);
    assert.match(r.prompt, /Use the roster-orchestrator skill/);
    assert.match(r.prompt, /plan cold-outreach for agent sdr/);
    assert.match(out, /Manual fire for nightly/);
    assert.match(out, /Use the roster-orchestrator skill/);
  } finally {
    cleanup();
  }
});

test('executeRun (claude) --silent: prints nothing, still returns prompt for caller use', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'gtm', yamlClaude);
    const { out, result } = await captureStdout(() =>
      executeRun({
        cwd: root,
        name: 'nightly',
        functionName: undefined,
        silent: true,
      }),
    );
    assert.equal(out, '');
    const r = result as { tool: string; prompt: string };
    assert.match(r.prompt, /plan cold-outreach for agent sdr/);
  } finally {
    cleanup();
  }
});

test('executeRun (codex): spawns codex exec with workspace + prompt, uses NON-scrubbed env', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    let captured: { cmd: string; args: readonly string[]; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined } | null = null;
    const fakeSpawn = ((cmd: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      captured = { cmd, args, cwd: options?.cwd, env: options?.env };
      const ee = new EventEmitter() as EventEmitter & { kill: (sig?: string) => void };
      ee.kill = () => undefined;
      // Simulate child exit on next tick.
      setImmediate(() => ee.emit('exit', 0, null));
      return ee as never;
    }) as never;

    const interactiveEnv = {
      HOME: '/Users/test',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/zsh',
      USER_CUSTOM: 'value',
      ROSTER_CODEX_PATH: '/opt/test/codex',
    };

    const result = await executeRun({
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      silent: true,
      spawn: fakeSpawn,
      env: interactiveEnv,
    });

    assert.ok(captured, 'spawn must have been called');
    const c = captured as { cmd: string; args: readonly string[]; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined };
    assert.equal(c.cmd, '/opt/test/codex');
    assert.deepEqual(c.args.slice(0, 2), ['exec', '-C']);
    // The cwd argument resolves through realpath on darwin (/tmp → /private/tmp);
    // assert that it points at this workspace and ends with the expected name.
    assert.ok(c.args[2]!.endsWith(root.split('/').pop()!), `expected workspace path, got ${c.args[2]}`);
    assert.match(c.args[3]!, /Use the roster-orchestrator skill/);
    // env passthrough — interactive env, not env -i.
    assert.equal(c.env?.USER_CUSTOM, 'value');
    assert.equal(c.env?.SHELL, '/bin/zsh');
    assert.equal(result.tool, 'codex');
    assert.equal(result.exitCode, 0);
  } finally {
    cleanup();
  }
});

test('executeRun (codex): child non-zero exit propagates to result.exitCode', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    const fakeSpawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { kill: () => void };
      ee.kill = () => undefined;
      setImmediate(() => ee.emit('exit', 42, null));
      return ee as never;
    }) as never;
    const result = await executeRun({
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      silent: true,
      spawn: fakeSpawn,
      env: { ROSTER_CODEX_PATH: '/opt/test/codex' },
    });
    assert.equal(result.exitCode, 42);
  } finally {
    cleanup();
  }
});
