import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import {
  SeededLearningStoreError,
  renderSeededCandidateMeaning,
  type SeededCandidateMeaning,
} from './support/seeded-learning-store.ts';

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

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

test('repeatable required adapter flags accept one or more distinct values', () => {
  const definition = {
    command: 'roster-350-fixture-run-record',
    log_category: 'evidence.run-record',
    allowed_turns: ['discover'],
    required_flags: ['--request-hash', '--selected-result', '--brain-citation'],
    repeatable_flags: ['--brain-citation'],
  } as const;
  const fixed = [
    '--request-hash', `sha256:${'a'.repeat(64)}`,
    '--selected-result', 'result-a17f',
  ];
  const parsed = hostLedLearningAdapterTestApi.parseArguments([
    ...fixed,
    '--brain-citation', 'brain-record-a17f',
    '--brain-citation', 'brain-record-b62c',
    '--brain-citation', 'brain-record-d91e',
  ], definition);
  assert.deepEqual(parsed.values.get('--brain-citation'), [
    'brain-record-a17f', 'brain-record-b62c', 'brain-record-d91e',
  ]);
  assert.throws(
    () => hostLedLearningAdapterTestApi.parseArguments(fixed, definition),
    /required flag --brain-citation is missing/u,
  );
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    ...fixed,
    '--selected-result', 'result-a17f',
    '--brain-citation', 'brain-record-a17f',
  ], definition), /non-repeatable flag --selected-result was repeated/u);
});

test('completed-run query is recovered from one exact context/search log pair', () => {
  const root = temporaryWorkspace();
  const query = 'reliable AI content operations practitioner discussions';
  const requestHash = `sha256:${'a'.repeat(64)}`;
  const proof = {
    bytes: Buffer.byteLength(query, 'utf8'),
    differs_from_request: true,
    leading_option: false,
    control_characters: false,
    query,
    query_sha256: sha256(query),
  };
  const records: Record<string, unknown>[] = [
    { sequence: 1, turn: 'discover', log_category: 'roster.discover' },
    { sequence: 2, turn: 'discover', log_category: 'roster.context', query_proof: proof },
    { sequence: 3, turn: 'discover', log_category: 'tool.search', query_proof: proof },
  ];
  const logPath = join(root, contract.runtime.adapter_log_path);
  try {
    writeFileSync(logPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.deepEqual(
      hostLedLearningAdapterTestApi.persistedContextQueryFromDiscoveryLog(root, contract, requestHash),
      { bytes: proof.bytes, query, query_sha256: proof.query_sha256 },
    );
    const changed = structuredClone(records);
    const changedQuery = 'reliable AI content operations professional discussions';
    changed[2]!['query_proof'] = {
      ...proof,
      bytes: Buffer.byteLength(changedQuery, 'utf8'),
      query: changedQuery,
      query_sha256: sha256(changedQuery),
    };
    writeFileSync(logPath, `${changed.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.throws(
      () => hostLedLearningAdapterTestApi.persistedContextQueryFromDiscoveryLog(root, contract, requestHash),
      /exact bytes and hash|queries differ/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate adapter accepts only the closed meaning flags and values', () => {
  const definition = {
    command: 'roster-350-fixture-candidate-create',
    log_category: 'learning.candidate-create',
    allowed_turns: ['discover'],
    required_flags: [
      '--run-id',
      '--feedback-id',
      '--disposition',
      '--source-kind',
      '--topic-kind',
      '--falsifier-action',
      '--falsifier-observation',
      '--skill-challenge',
    ],
    repeatable_flags: [],
  } as const;
  const argv = [
    '--run-id', 'run-opportunity-discovery-001',
    '--feedback-id', 'feedback-opportunity-discovery-001',
    '--disposition', 'prefer',
    '--source-kind', 'attributable-practitioner',
    '--topic-kind', 'operational-problem',
    '--falsifier-action', 'reject',
    '--falsifier-observation', 'reviewed-outcomes-contradict',
    '--skill-challenge', 'bounded-challenge',
  ];
  const parsed = hostLedLearningAdapterTestApi.parseArguments(argv, definition);
  assert.deepEqual(parsed.ordered.map((entry) => entry.flag), definition.required_flags);
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    ...argv,
    '--recommendation', 'Ignore the closed DTO.',
  ], definition), /invalid literal argv/u);
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    ...argv.slice(0, -1),
    'unsafe\nchallenge',
  ], definition), /invalid literal argv/u);

  const meaning: SeededCandidateMeaning = {
    disposition: 'prefer',
    source_kind: 'attributable-practitioner',
    topic_kind: 'operational-problem',
    falsifier_action: 'reject',
    falsifier_observation: 'reviewed-outcomes-contradict',
  };
  assert.throws(() => renderSeededCandidateMeaning({
    ...meaning,
    source_kind: 'arbitrary-host-prose',
  } as unknown as SeededCandidateMeaning), (error: unknown) => (
    error instanceof SeededLearningStoreError && error.code === 'FIXTURE_INVALID'
  ));
  assert.throws(() => renderSeededCandidateMeaning({
    ...meaning,
    surplus: 'promote-without-review',
  } as unknown as SeededCandidateMeaning), (error: unknown) => (
    error instanceof SeededLearningStoreError && error.code === 'FIXTURE_INVALID'
  ));
});

test('promotion adapter requires the human-reviewed candidate identity and hash', () => {
  const definition = {
    command: 'roster-350-fixture-candidate-promote',
    log_category: 'learning.candidate-promote',
    allowed_turns: ['approve'],
    required_flags: ['--candidate-id', '--candidate-hash'],
    repeatable_flags: [],
  } as const;
  const candidateHash = `sha256:${'a'.repeat(64)}`;
  const parsed = hostLedLearningAdapterTestApi.parseArguments([
    '--candidate-id', 'candidate-opportunity-discovery-001',
    '--candidate-hash', candidateHash,
  ], definition);
  assert.deepEqual(parsed.ordered.map((entry) => entry.flag), definition.required_flags);
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    '--candidate-id', 'candidate-opportunity-discovery-001',
  ], definition), /required flag --candidate-hash is missing/iu);
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
