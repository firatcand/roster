import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { MAX_CONTEXT_QUERY_BYTES } from '../src/lib/context-args.ts';

const BIN = resolve('src/bin/roster.ts');

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function runCli(root: string, args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-cli-context-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function json(result: CliResult): Record<string, unknown> {
  assert.equal(result.stdout.trimEnd().split('\n').length, 1, `stdout was not one line: ${result.stdout}`);
  assert.doesNotThrow(
    () => JSON.parse(result.stdout),
    `stdout was not JSON: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectSuccess(result: CliResult): Record<string, unknown> {
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  return json(result);
}

function expectInvalidArgs(result: CliResult): Record<string, unknown> {
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  const envelope = json(result);
  assert.deepEqual(Object.keys(envelope), ['ok', 'code', 'message', 'remedy', 'details']);
  assert.equal(envelope['ok'], false);
  assert.equal(envelope['code'], 'INVALID_ARGS');
  return envelope;
}

function initializeAgent(root: string): void {
  const init = runCli(root, ['init', 'context-cli-test', '--silent']);
  assert.equal(init.status, 0, `stdout: ${init.stdout}\nstderr: ${init.stderr}`);
  const fn = runCli(root, [
    'scaffold',
    'function',
    'gtm',
    '--purpose',
    'Grow demand.',
    '--json',
  ]);
  assert.equal(fn.status, 0, `stdout: ${fn.stdout}\nstderr: ${fn.stderr}`);
  const agent = runCli(root, [
    'scaffold',
    'agent',
    'social-manager',
    '--scope',
    'function:gtm',
    '--purpose',
    'Find relevant public conversations.',
    '--json',
  ]);
  assert.equal(agent.status, 0, `stdout: ${agent.stdout}\nstderr: ${agent.stderr}`);
}

function authorPlan(root: string): void {
  const scaffold = runCli(root, [
    'scaffold',
    'plan',
    'opportunity-discovery',
    '--scope',
    'agent:gtm/social-manager',
    '--purpose',
    'Find relevant reply opportunities.',
    '--json',
  ]);
  assert.equal(scaffold.status, 0, `stdout: ${scaffold.stdout}\nstderr: ${scaffold.stderr}`);
  writeFileSync(
    join(root, 'functions/gtm/agents/social-manager/plans/opportunity-discovery.yaml'),
    YAML.stringify({
      schema_version: 2,
      id: 'opportunity-discovery',
      agent: 'gtm/social-manager',
      purpose: 'Find relevant reply opportunities.',
      inputs: {},
      brain_selectors: {},
      guidelines: [],
      tool_uses: [],
      artifacts: {},
      caps: {},
      steps: [
        { id: 'prepare', kind: 'reasoning', instruction: 'Derive task-specific filters.' },
        {
          id: 'review',
          kind: 'approval',
          instruction: 'Present the result to the human.',
          approval_guidance: 'Wait for the human in the host interface.',
        },
      ],
      completion: {
        artifacts: [],
        output_guidance: 'Return the reviewed result.',
        criteria: ['The result is supported by evidence.'],
      },
    }),
  );
}

test('context emits one closed JSON document for an exact agent-only target', () => {
  const fx = fixture();
  try {
    initializeAgent(fx.root);
    const bundle = expectSuccess(runCli(fx.root, [
      'context',
      'gtm/social-manager',
      '--query',
      'Find relevant opportunities',
      '--json',
    ]));
    assert.deepEqual(Object.keys(bundle), [
      'schema_version',
      'workspace',
      'target',
      'request',
      'agent',
      'plan',
      'guidelines',
      'lessons',
      'brain_evidence',
      'tool_uses',
      'skill_refs',
      'provenance',
      'budget',
      'diagnostics',
    ]);
    assert.equal(Object.hasOwn(bundle, 'ok'), false);
    assert.deepEqual(bundle['plan'], { root_id: null, definitions: [] });
    assert.deepEqual(bundle['brain_evidence'], []);
    const diagnostics = bundle['diagnostics'] as Array<{ code: string; severity: string }>;
    const missingBrain = diagnostics.filter((diagnostic) => diagnostic.code === 'BRAIN_NOT_BOUND');
    assert.equal(missingBrain.length, 1);
    assert.equal(missingBrain[0]?.severity, 'warning');
  } finally {
    fx.cleanup();
  }
});

test('context preserves an explicit plan and host step hint without selecting runtime state', () => {
  const fx = fixture();
  try {
    initializeAgent(fx.root);
    authorPlan(fx.root);
    const bundle = expectSuccess(runCli(fx.root, [
      'context',
      'gtm/social-manager#opportunity-discovery',
      '--query',
      'Find relevant opportunities',
      '--step',
      'prepare',
      '--explain',
      '--json',
    ]));
    const plan = bundle['plan'] as { root_id: string; definitions: Array<Record<string, unknown>> };
    assert.equal(plan.root_id, 'gtm/social-manager#opportunity-discovery');
    assert.equal(plan.definitions.length, 1);
    const steps = (plan.definitions[0]?.['content'] as { steps: Array<{ id: string }> }).steps;
    assert.deepEqual(steps.map((step) => step.id), ['prepare', 'review']);
    const request = bundle['request'] as Record<string, unknown>;
    assert.equal(request['step_hint'], 'prepare');
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ['current_step', 'selected_step', 'execution_state', 'next_action']) {
      assert.equal(serialized.includes(`\"${forbidden}\"`), false);
    }
  } finally {
    fx.cleanup();
  }
});

test('context dispatches before global help and version scanning', () => {
  const fx = fixture();
  try {
    const cases = [
      ['context', 'gtm/social-manager', '--query', '-v', '--json'],
      ['context', 'gtm/social-manager', '--query', '-h', '--json'],
      ['context', 'gtm/social-manager', '--query', '--version', '--json'],
      ['context', 'gtm/social-manager', '--query', 'task', '--step', '--help', '--json'],
      ['context', 'gtm/social-manager', '--query', '--debug', '--json'],
    ];
    for (const args of cases) expectInvalidArgs(runCli(fx.root, args));

    const globalHelp = runCli(fx.root, ['--help']);
    const longHelp = runCli(fx.root, ['context', '--help']);
    const shortHelp = runCli(fx.root, ['context', '-h']);
    assert.equal(globalHelp.status, 0);
    assert.equal(longHelp.status, 0);
    assert.equal(shortHelp.status, 0);
    assert.equal(longHelp.stdout, globalHelp.stdout);
    assert.equal(shortHelp.stdout, globalHelp.stdout);
    assert.equal(longHelp.stderr, '');
    assert.equal(shortHelp.stderr, '');
  } finally {
    fx.cleanup();
  }
});

test('context INVALID_ARGS envelopes never echo raw invalid values', () => {
  const fx = fixture();
  try {
    const canary = `sk-${'Ab9_'.repeat(8)}`;
    const cases = [
      ['context', `gtm/${canary}`, '--query', 'task', '--json'],
      ['context', 'gtm/social-manager', canary, '--query', 'task', '--json'],
      ['context', 'gtm/social-manager', '--query', 'task', `--${canary}`, '--json'],
      ['context', 'gtm/social-manager', '--query', 'task', '--budget', canary, '--json'],
      [
        'context',
        'gtm/social-manager',
        '--query',
        `${canary}${'x'.repeat(MAX_CONTEXT_QUERY_BYTES)}`,
        '--json',
      ],
      ['context', 'gtm/social-manager', '--query', 'task', '--step', `${canary}\n`, '--json'],
    ];
    for (const args of cases) {
      const result = runCli(fx.root, args);
      expectInvalidArgs(result);
      assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes('Ab9_'), false);
    }
  } finally {
    fx.cleanup();
  }
});

test('context sanitizes lower-layer workspace and YAML failures before serialization', () => {
  const outside = fixture();
  try {
    const missing = runCli(outside.root, [
      'context',
      'gtm/social-manager',
      '--query',
      'task',
      '--json',
    ]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, '');
    assert.equal(json(missing)['code'], 'WORKSPACE_NOT_FOUND');
    assert.equal(missing.stdout.includes(outside.root), false);
  } finally {
    outside.cleanup();
  }

  const malformed = fixture();
  try {
    initializeAgent(malformed.root);
    const canary = `sk-${'Cd7_'.repeat(8)}`;
    writeFileSync(
      join(malformed.root, 'functions/gtm/agents/social-manager/agent.yaml'),
      `schema_version: 2\npurpose: [${canary}\n`,
    );
    const result = runCli(malformed.root, [
      'context',
      'gtm/social-manager',
      '--query',
      'task',
      '--json',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = json(result);
    assert.equal(envelope['code'], 'YAML_INVALID');
    assert.equal(envelope['message'], 'Authored YAML is invalid');
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  } finally {
    malformed.cleanup();
  }
});
