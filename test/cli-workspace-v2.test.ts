import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  const root = mkdtempSync(join(tmpdir(), 'roster-cli-v2-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function json(result: CliResult): Record<string, unknown> {
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout was not JSON: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function init(root: string): void {
  const result = runCli(root, ['init', 'cli-test', '--silent']);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

test('spawned CLI dispatches scaffold, discover, and validate with stable JSON envelopes', () => {
  const fx = fixture();
  try {
    init(fx.root);
    const scaffold = runCli(fx.root, ['scaffold', 'function', 'gtm', '--purpose', 'Grow demand.', '--json']);
    assert.equal(scaffold.status, 0, scaffold.stderr);
    assert.deepEqual(
      { ok: json(scaffold)['ok'], status: json(scaffold)['status'] },
      { ok: true, status: 'created' },
    );
    const discover = runCli(fx.root, ['discover', 'gtm', '--kind', 'function', '--exact', '--json']);
    assert.equal(discover.status, 0, discover.stderr);
    const records = json(discover)['records'] as Array<Record<string, unknown>>;
    assert.equal(records[0]?.['qualified_id'], 'gtm');
    const validate = runCli(fx.root, ['validate', '--json']);
    assert.equal(validate.status, 0, `stdout: ${validate.stdout}\nstderr: ${validate.stderr}`);
    assert.equal(json(validate)['ok'], true);
  } finally {
    fx.cleanup();
  }
});

test('spawned CLI emits global JSON failure outside a workspace', () => {
  const fx = fixture();
  try {
    const result = runCli(fx.root, ['discover', '--json']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.equal(envelope['code'], 'WORKSPACE_NOT_FOUND');
    assert.equal(typeof envelope['details'], 'object');
  } finally {
    fx.cleanup();
  }
});

test('spawned CLI reports invalid scaffold arguments as JSON', () => {
  const fx = fixture();
  try {
    init(fx.root);
    const result = runCli(fx.root, ['scaffold', 'agent', 'social', '--json']);
    assert.equal(result.status, 1);
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.equal(envelope['code'], 'INVALID_ARGS');
  } finally {
    fx.cleanup();
  }
});

test('spawned CLI scaffolds tool-use guidance at all four explicit scopes', () => {
  const fx = fixture();
  try {
    init(fx.root);
    assert.equal(runCli(fx.root, ['scaffold', 'function', 'gtm', '--json']).status, 0);
    assert.equal(runCli(fx.root, [
      'scaffold',
      'agent',
      'social',
      '--scope',
      'function:gtm',
      '--json',
    ]).status, 0);
    assert.equal(runCli(fx.root, [
      'scaffold',
      'plan',
      'discover',
      '--scope',
      'agent:gtm/social',
      '--json',
    ]).status, 0);
    for (const scope of [
      'workspace',
      'function:gtm',
      'agent:gtm/social',
      'plan:gtm/social#discover',
    ]) {
      const result = runCli(fx.root, [
        'scaffold',
        'tool-use',
        'opportunity-research',
        '--scope',
        scope,
        '--purpose',
        `Guidance owned by ${scope}.`,
        '--json',
      ]);
      assert.equal(result.status, 0, `scope ${scope}: ${result.stdout}\n${result.stderr}`);
    }
    for (const path of [
      'tools/opportunity-research.yaml',
      'functions/gtm/tools/opportunity-research.yaml',
      'functions/gtm/agents/social/tools/opportunity-research.yaml',
      'functions/gtm/agents/social/plans/discover/tools/opportunity-research.yaml',
    ]) {
      assert.equal(existsSync(join(fx.root, path)), true, `${path} should exist`);
    }
    const discovered = runCli(fx.root, ['discover', '--kind', 'tool-use', '--json']);
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.deepEqual(
      (json(discovered)['records'] as Array<{ qualified_id: string }>).map((record) => record.qualified_id),
      [
        'gtm/social/tools/opportunity-research',
        'gtm/social#discover/tools/opportunity-research',
        'gtm/tools/opportunity-research',
        'tools/opportunity-research',
      ],
    );
  } finally {
    fx.cleanup();
  }
});

test('spawned discovery surfaces escaped secret diagnostics without bytes or digests', () => {
  const fx = fixture();
  try {
    init(fx.root);
    assert.equal(runCli(fx.root, [
      'scaffold',
      'tool-use',
      'research',
      '--scope',
      'workspace',
      '--purpose',
      'Research public opportunities.',
      '--json',
    ]).status, 0);
    const canary = `sk-${'Ab9_'.repeat(7)}`;
    writeFileSync(join(fx.root, 'tools', 'research.yaml'), [
      'schema_version: 2',
      'id: research',
      'scope: {}',
      `purpose: "\\u0073k-${'Ab9_'.repeat(7)}"`,
      'skill_ref: exa:search',
      '',
    ].join('\n'));

    const jsonResult = runCli(fx.root, [
      'discover',
      'tools/research',
      '--kind',
      'tool-use',
      '--exact',
      '--full',
      '--json',
    ]);
    assert.equal(jsonResult.status, 1, jsonResult.stderr);
    const envelope = json(jsonResult);
    assert.equal(envelope['ok'], false);
    assert.deepEqual(envelope['records'], []);
    assert.equal((envelope['diagnostics'] as Array<{ code: string }>)[0]?.code, 'SECRET_MATERIAL_FORBIDDEN');
    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes(canary), false);
    assert.equal(serialized.includes('content_hash'), false);
    assert.equal(serialized.includes('sha256:'), false);

    const human = runCli(fx.root, [
      'discover',
      'tools/research',
      '--kind',
      'tool-use',
      '--exact',
      '--full',
    ]);
    assert.equal(human.status, 1);
    assert.match(human.stderr, /SECRET_MATERIAL_FORBIDDEN/);
    assert.match(human.stderr, /Remove the credential/);
    assert.doesNotMatch(human.stdout, /No matching Roster records/);
    assert.equal(`${human.stdout}${human.stderr}`.includes(canary), false);
    assert.doesNotMatch(`${human.stdout}${human.stderr}`, /content_hash|sha256:/);
  } finally {
    fx.cleanup();
  }
});

test('spawned doctor rejects unknown arguments with the global JSON envelope', () => {
  const fx = fixture();
  try {
    const result = runCli(fx.root, ['doctor', '--bogus', '--json']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.equal(envelope['code'], 'INVALID_ARGS');
    assert.match(String(envelope['message']), /unknown flag '--bogus'/);
  } finally {
    fx.cleanup();
  }
});

test('public help documents ratified v2 aliases without advertising --tool all', () => {
  const fx = fixture();
  try {
    const result = runCli(fx.root, ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /init \[workspace-id\] \[--name <workspace-id>\]/);
    assert.match(result.stdout, /--function <function-id>/);
    assert.match(result.stdout, /--agent <function\/agent>/);
    assert.match(result.stdout, /--scope <owner>\s+Select workspace, function, agent, or plan ownership/);
    assert.match(result.stdout, /roster update\s+Synchronize v2 activation and the derived vendor-skill map/);
    assert.doesNotMatch(result.stdout, /alias of --tool all/);
  } finally {
    fx.cleanup();
  }
});

test('spawned exact discovery fails closed on ambiguous bare identities', () => {
  const fx = fixture();
  try {
    init(fx.root);
    for (const functionId of ['gtm', 'support']) {
      assert.equal(runCli(fx.root, ['scaffold', 'function', functionId, '--json']).status, 0);
      assert.equal(runCli(fx.root, [
        'scaffold',
        'agent',
        'manager',
        '--scope',
        `function:${functionId}`,
        '--json',
      ]).status, 0);
    }
    const result = runCli(fx.root, ['discover', 'manager', '--kind', 'agent', '--exact', '--json']);
    assert.equal(result.status, 1);
    const envelope = json(result);
    assert.equal(envelope['code'], 'IDENTITY_AMBIGUOUS');
    assert.equal((envelope['details'] as { candidates: unknown[] }).candidates.length, 2);
  } finally {
    fx.cleanup();
  }
});

test('spawned validate returns nonzero for structural orphan diagnostics', () => {
  const fx = fixture();
  try {
    init(fx.root);
    assert.equal(runCli(fx.root, ['scaffold', 'function', 'gtm', '--json']).status, 0);
    mkdirSync(join(fx.root, 'functions', 'rogue'), { recursive: true });
    const result = runCli(fx.root, ['validate', '--json']);
    assert.equal(result.status, 1);
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.ok((envelope['diagnostics'] as Array<{ code: string }>).some((entry) => entry.code === 'UNREGISTERED_RECORD'));
  } finally {
    fx.cleanup();
  }
});

test('spawned CLI returns complete authored plans while validate enforces semantic readiness', () => {
  const fx = fixture();
  try {
    init(fx.root);
    assert.equal(runCli(fx.root, ['scaffold', 'function', 'gtm', '--json']).status, 0);
    assert.equal(runCli(fx.root, ['scaffold', 'agent', 'social', '--scope', 'function:gtm', '--json']).status, 0);
    assert.equal(runCli(fx.root, [
      'scaffold',
      'plan',
      'discover',
      '--scope',
      'agent:gtm/social',
      '--purpose',
      'Discover opportunities.',
      '--json',
    ]).status, 0);

    const draft = runCli(fx.root, ['validate', 'gtm/social#discover', '--json']);
    assert.equal(draft.status, 1);
    assert.ok((json(draft)['diagnostics'] as Array<{ code: string }>).some((entry) => entry.code === 'PLAN_DRAFT_INCOMPLETE'));

    const path = join(fx.root, 'functions', 'gtm', 'agents', 'social', 'plans', 'discover.yaml');
    const invalid = [
      'schema_version: 2',
      'id: discover',
      'agent: gtm/social',
      'purpose: Discover opportunities.',
      'inputs: {}',
      'brain_selectors: {}',
      'guidelines: []',
      'tool_uses: []',
      'artifacts: {}',
      'caps: {}',
      'steps:',
      '  - id: prepare',
      '    kind: reasoning',
      '    instruction: Prepare filters.',
      '    command: hidden-runtime',
      'completion:',
      '  artifacts: []',
      '  output_guidance: Return the filters.',
      '  criteria:',
      '    - Filters match the request.',
      '',
    ].join('\n');
    writeFileSync(path, invalid);
    const discovered = runCli(fx.root, ['discover', 'gtm/social#discover', '--exact', '--full', '--json']);
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.equal(((json(discovered)['records'] as Array<{ content: string }>)[0]?.content), invalid);
    const rejected = runCli(fx.root, ['validate', 'gtm/social#discover', '--json']);
    assert.equal(rejected.status, 1);
    assert.ok((json(rejected)['diagnostics'] as Array<{ code: string }>).some((entry) => entry.code === 'PLAN_FIELD_FORBIDDEN'));

    writeFileSync(path, invalid.replace('    command: hidden-runtime\n', ''));
    const valid = runCli(fx.root, ['validate', 'gtm/social#discover', '--json']);
    assert.equal(valid.status, 0, `stdout: ${valid.stdout}\nstderr: ${valid.stderr}`);
    const structured = (json(valid)['checks'] as Array<{ name: string; details: Record<string, unknown> }>).find((check) => check.name === 'structured-plans');
    assert.deepEqual(structured?.details, { plans: 1, diagnostics: 0 });
  } finally {
    fx.cleanup();
  }
});
