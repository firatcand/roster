import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostLedLearningAdapterTestApi } from './support/host-led-learning-adapter.ts';

const contract = {
  schema_version: 1,
  fixture_id: 'host-led-learning',
  runtime: {
    state_path: '.fixture/learning-state.json',
    adapter_log_path: '.fixture/adapter-calls.jsonl',
    adapter_directory: '.fixture/bin',
  },
  roster: {
    target: 'gtm/social-manager#opportunity-discovery',
    allowed_model_invocations: [],
  },
  adapters: [],
} as const;

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'roster-350-adapter-test-'));
  mkdirSync(join(root, '.fixture'), { recursive: true });
  return root;
}

test('adapter workspace paths reject every symlinked component and leaf', () => {
  const root = temporaryWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'roster-350-adapter-outside-'));
  try {
    writeFileSync(join(outside, 'input.json'), '{}\n');
    symlinkSync(outside, join(root, '.fixture', 'linked-input'));
    assert.throws(() => hostLedLearningAdapterTestApi.workspacePath({
      root,
      relativePath: '.fixture/linked-input/input.json',
      label: 'fixture input',
      leaf: 'regular-file',
    }), /contains a symbolic link/u);

    writeFileSync(join(root, '.fixture', 'real.json'), '{}\n');
    symlinkSync(join(root, '.fixture', 'real.json'), join(root, '.fixture', 'linked-leaf.json'));
    assert.throws(() => hostLedLearningAdapterTestApi.workspacePath({
      root,
      relativePath: '.fixture/linked-leaf.json',
      label: 'fixture state',
      leaf: 'regular-file',
    }), /contains a symbolic link/u);

    assert.throws(() => hostLedLearningAdapterTestApi.workspacePath({
      root,
      relativePath: '.fixture/missing-parent/lesson.md',
      label: 'lesson path',
      leaf: 'regular-file-or-missing',
    }), /missing or unreadable path component/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Roster required_argv is live contract data and must match exactly', () => {
  const target = 'gtm/social-manager#opportunity-discovery';
  const discover = {
    verb: 'discover',
    required_argv: ['$TARGET', '--json'],
    log_category: 'roster.discover',
  } as const;
  assert.deepEqual(
    hostLedLearningAdapterTestApi.requireContractedRosterArgv(
      discover,
      target,
      [target, '--json'],
    ).expected,
    [target, '--json'],
  );
  assert.throws(() => hostLedLearningAdapterTestApi.requireContractedRosterArgv(
    discover,
    target,
    [target, '--exact', '--json'],
  ), /does not exactly match required_argv/u);

  const context = {
    verb: 'context',
    required_argv: ['$TARGET', '--query', '$DERIVED_QUERY', '--json'],
    log_category: 'roster.context',
  } as const;
  const derived = 'reliable AI operations';
  assert.deepEqual(
    hostLedLearningAdapterTestApi.requireContractedRosterArgv(
      context,
      target,
      [target, '--query', derived, '--json'],
    ),
    { expected: [target, '--query', derived, '--json'], derivedQuery: derived },
  );
  assert.throws(() => hostLedLearningAdapterTestApi.requireContractedRosterArgv(
    context,
    target,
    [target, '--query', derived, '--json', '--explain'],
  ), /does not exactly match required_argv/u);
});

test('adapter log enforces one writer and validates contiguous sequences', () => {
  const root = temporaryWorkspace();
  try {
    const append = (category: string) => hostLedLearningAdapterTestApi.appendLog({
      workspace: root,
      contract,
      turn: 'discover',
      command: 'roster',
      category,
      flags: ['--json'],
      output: { ok: true },
      rosterProof: {
        argvHash: `sha256:${'1'.repeat(64)}`,
        contractArgvHash: `sha256:${'1'.repeat(64)}`,
        bundleHash: `sha256:${'3'.repeat(64)}`,
      },
    });
    append('roster.discover');
    append('roster.context');
    const logPath = join(root, contract.runtime.adapter_log_path);
    const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
    assert.equal(records[0].roster_bundle_sha256, `sha256:${'3'.repeat(64)}`);
    assert.equal(records[0].roster_argv_sha256, records[0].roster_contract_argv_sha256);
    assert.equal(records[0].roster_argv_exact, true);
    assert.equal(records[0].roster_invocation_status, 'prepared-bundle-success');

    const lockPath = `${logPath}.lock`;
    writeFileSync(lockPath, '', { flag: 'wx' });
    assert.throws(() => append('roster.context'), /active or stale writer lock/u);
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
    rmSync(lockPath);

    records[1].sequence = 1;
    writeFileSync(logPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.throws(() => append('roster.context'), /log sequence is invalid/u);
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
