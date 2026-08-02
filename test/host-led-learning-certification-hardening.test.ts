import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildFileManifest,
  loadHostLedLearningLaunchContract,
  parseHostLedLearningLaunchContract,
  tokenizeLiteralHostCommand,
  validateHostTraceCommands,
  type CertificationHost,
  type NormalizedHostTrace,
} from './support/host-led-learning-certification.ts';

function trace(host: CertificationHost, commands: readonly string[]): NormalizedHostTrace {
  return {
    host,
    initialization: {},
    events: [],
    tool_calls: [],
    tool_results: [],
    commands,
    semantic_result: {},
    trace_sha256: '0'.repeat(64),
  };
}

function contractClone(): Record<string, unknown> {
  return structuredClone(loadHostLedLearningLaunchContract()) as unknown as Record<string, unknown>;
}

test('host launch contract rejects duplicate arrays, protocol drift, and version drift', () => {
  const duplicate = contractClone();
  const duplicateAdapters = duplicate['adapters'] as Array<Record<string, unknown>>;
  duplicateAdapters[0]!['required_flags'] = ['--query', '--query'];
  assert.throws(() => parseHostLedLearningLaunchContract(duplicate), /duplicate/iu);

  const protocolDrift = contractClone();
  const codex = protocolDrift['codex'] as Record<string, unknown>;
  const skillsList = codex['skills_list'] as Record<string, unknown>;
  const sequence = skillsList['request_sequence'] as Array<Record<string, unknown>>;
  sequence[0]!['params'] = { unexpected: true };
  assert.throws(() => parseHostLedLearningLaunchContract(protocolDrift), /exact phased protocol/iu);

  const versionDrift = contractClone();
  (versionDrift['claude'] as Record<string, unknown>)['version'] = '2.1.221 (Claude Code)';
  assert.throws(() => parseHostLedLearningLaunchContract(versionDrift), /exact certified CLI patches/iu);
});

test('literal host command parser rejects shell composition and preserves quoted argv', () => {
  assert.deepEqual(
    tokenizeLiteralHostCommand("roster-350-fixture-search --query 'reliable AI operations'"),
    ['roster-350-fixture-search', '--query', 'reliable AI operations'],
  );
  for (const command of [
    'roster discover target --json; cat /etc/passwd',
    'roster context target --query $(whoami) --json',
    'roster context target --query value > /tmp/output --json',
    'roster context target --query *.txt --json',
  ]) assert.throws(() => tokenizeLiteralHostCommand(command), /shell|expansion|glob/iu);
});

test('Codex trace audit permits one exact Dreamer read and rejects extra operands or Roster argv', () => {
  const contract = loadHostLedLearningLaunchContract();
  const required = contract.turn_expectations.discover.required_log_categories.map((category) => (
    contract.roster.allowed_model_invocations.find((entry) => entry.log_category === category) === undefined
      ? contract.adapters.find((entry) => entry.log_category === category)!.command
      : 'roster'
  ));
  const commands = [
    'roster discover gtm/social-manager#opportunity-discovery --exact --json',
    "roster context gtm/social-manager#opportunity-discovery --query 'reliable AI operations' --json",
    "roster-350-fixture-search --query 'reliable AI operations'",
    'roster-350-fixture-run-record --request-hash sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --selected-result result-a17f --brain-citation brain-record-a17f',
    'roster-350-fixture-feedback-record --run-id run-opportunity-discovery-001 --signal useful',
    'roster-350-fixture-dream-status',
    'cat .agents/skills/fixture-dreamer/SKILL.md',
    "roster-350-fixture-candidate-create --run-id run-opportunity-discovery-001 --feedback-id feedback-opportunity-discovery-001 --lesson-id host-authored-lesson --recommendation 'Prefer attributable practitioner operational problems' --falsifiable-by 'Reject if reviewed outcomes contradict it' --skill-challenge roster-350-dreamer-challenge:v1:9b6e2d47a5c183f0",
  ];
  validateHostTraceCommands({
    trace: trace('codex', commands),
    host: 'codex',
    turn: 'discover',
    contract,
    required,
    forbidden: ['roster-350-fixture-state-show', 'roster-350-fixture-candidate-promote'],
  });

  const extraRead = commands.map((command) => command.startsWith('cat ')
    ? `${command} /etc/passwd`
    : command);
  assert.throws(() => validateHostTraceCommands({
    trace: trace('codex', extraRead),
    host: 'codex',
    turn: 'discover',
    contract,
    required,
    forbidden: [],
  }), /unexpected|structurally invalid/iu);

  const extraRosterArg = commands.map((command) => command.startsWith('roster discover ')
    ? `${command} --verbose`
    : command);
  assert.throws(() => validateHostTraceCommands({
    trace: trace('codex', extraRosterArg),
    host: 'codex',
    turn: 'discover',
    contract,
    required,
    forbidden: [],
  }), /argv length/iu);
});

test('behavior manifests reject symbolic links instead of hashing targets outside the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-350-manifest-'));
  const outside = mkdtempSync(join(tmpdir(), 'roster-350-manifest-outside-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'nested', 'link.txt'));
    assert.throws(
      () => buildFileManifest([{ label: 'fixture', path: root }]),
      /symbolic link/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
