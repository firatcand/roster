import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import {
  enabledV2Hosts,
  canonicalBrainNamespace,
  fingerprintBrainNamespace,
  parseChildDefinition,
  parseFunctionDefinition,
  parsePlanEnvelope,
  parseWorkspaceRegistry,
  renderChildDefinition,
  renderFunctionDefinition,
  renderToolUseDraft,
} from '../src/lib/workspace-record.ts';

function failureCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    return isWorkspaceFailure(error) ? error.code : undefined;
  }
}

test('registry, function, and plan envelopes expose scope-owned tool-use memberships', () => {
  const registry = parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: record-test',
    'functions: {}',
    'hosts:',
    '  codex: enabled',
    '  claude: enabled',
    'tool_uses:',
    '  - workspace-search',
    '',
  ].join('\n'));
  assert.deepEqual(registry.tool_uses, ['workspace-search']);
  assert.deepEqual(enabledV2Hosts(registry), ['claude', 'codex']);

  const fn = parseFunctionDefinition(renderFunctionDefinition('gtm', 'Grow demand.'), 'function.yaml');
  assert.deepEqual(fn.tool_uses, []);

  const plan = parsePlanEnvelope(
    renderChildDefinition('plan', 'gtm', 'social', 'discover', 'Find opportunities.'),
    'discover.yaml',
  );
  assert.deepEqual(plan.tool_uses, []);
});

test('Brain configuration is strict, normalized, and fingerprints only its S3 namespace', () => {
  const registry = parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: record-test',
    'brain:',
    '  secrets_path: /record-test/brain',
    '  storage:',
    '    bucket: record-test-vault',
    '    region: eu-central-1',
    '    root_prefix: evidence/current',
    '    endpoint: https://s3.example.test',
    'functions: {}',
    'hosts: {}',
    'tool_uses: []',
    '',
  ].join('\n'));
  assert.deepEqual(registry.brain, {
    secrets_path: '/record-test/brain',
    storage: {
      bucket: 'record-test-vault',
      region: 'eu-central-1',
      root_prefix: 'evidence/current',
      endpoint: 'https://s3.example.test',
      force_path_style: false,
    },
  });
  assert.equal(canonicalBrainNamespace(registry.brain!), JSON.stringify({
    domain: 'roster.brain.s3-namespace.v1',
    provider: 's3',
    bucket: 'record-test-vault',
    region: 'eu-central-1',
    endpoint: 'https://s3.example.test',
    force_path_style: false,
    root_prefix: 'evidence/current',
  }));
  const changedReference = { ...registry.brain!, secrets_path: '/other/brain' };
  assert.deepEqual(fingerprintBrainNamespace(registry.brain!), fingerprintBrainNamespace(changedReference));

  const omittedRoot = parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: elsewhere',
    'brain:',
    '  secrets_path: /elsewhere',
    '  storage:',
    '    bucket: record-test-vault',
    '    region: eu-central-1',
    'functions: {}',
    'hosts: {}',
    'tool_uses: []',
    '',
  ].join('\n'));
  assert.equal(omittedRoot.brain?.storage.root_prefix, undefined);
  assert.match(fingerprintBrainNamespace(omittedRoot.brain!).fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(canonicalBrainNamespace(omittedRoot.brain!), /"root_prefix":null/);

  const compatible = parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: compatible',
    'brain:',
    '  secrets_path: /compatible',
    '  storage:',
    '    bucket: compatible-vault',
    '    region: auto',
    '    endpoint: https://93.184.216.34',
    'functions: {}',
    'hosts: {}',
    'tool_uses: []',
    '',
  ].join('\n'));
  assert.equal(compatible.brain?.storage.region, 'auto');
  assert.equal(compatible.brain?.storage.endpoint, 'https://93.184.216.34');
});

test('Brain root prefixes reserve the durable suffix at the exact byte boundary', () => {
  const registry = (rootPrefix: string) => parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: prefix-boundary',
    'brain:',
    '  secrets_path: /prefix-boundary',
    '  storage:',
    '    bucket: prefix-boundary-vault',
    '    region: auto',
    `    root_prefix: ${rootPrefix}`,
    'functions: {}',
    'hosts: {}',
    'tool_uses: []',
    '',
  ].join('\n'));
  assert.equal(Buffer.byteLength(registry('a'.repeat(757)).brain!.storage.root_prefix!, 'utf8'), 757);
  assert.equal(failureCode(() => registry('a'.repeat(758))), 'YAML_INVALID');
});

test('retired brain.binding fails as unknown with its v2 migration fields', () => {
  assert.throws(
    () => parseWorkspaceRegistry([
      'schema_version: 2',
      'workspace_id: retired-binding',
      'brain:',
      '  binding: company-brain',
      'functions: {}',
      'hosts: {}',
      'tool_uses: []',
      '',
    ].join('\n')),
    (error: unknown) => {
      assert.equal(isWorkspaceFailure(error), true);
      if (!isWorkspaceFailure(error)) return false;
      assert.equal(error.code, 'UNKNOWN_FIELD');
      assert.match(error.header, /unknown field 'brain\.binding'/u);
      assert.match(error.remedy, /brain\.secrets_path/u);
      assert.match(error.remedy, /brain\.storage/u);
      return true;
    },
  );
});

test('Brain configuration rejects unknown, secret, unsafe path, and unsafe endpoint inputs', () => {
  const registry = (brain: string) => [
    'schema_version: 2',
    'workspace_id: record-test',
    brain,
    'functions: {}',
    'hosts: {}',
    'tool_uses: []',
    '',
  ].join('\n');
  for (const brain of [
    'brain:\n  binding: retired',
    'brain:\n  secrets_path: relative\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: RECORD-TEST\n    region: eu-central-1',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    root_prefix: ../escape',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: http://s3.example.test',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://user:password@s3.example.test',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://127.0.0.1',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    root_prefix: "safe\\u0085unsafe"',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://localhost.',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://foo.localhost.',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://[fe90::1]',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://[::ffff:127.0.0.1]',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://[::ffff:7f00:1]',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://[ff00::1]',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://[2001:db8::1]',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://100.64.0.1',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://198.18.0.1',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://192.0.2.1',
    'brain:\n  secrets_path: /record-test\n  storage:\n    bucket: record-test-vault\n    region: eu-central-1\n    endpoint: https://s3.example.test/path',
  ]) {
    assert.notEqual(failureCode(() => parseWorkspaceRegistry(registry(brain))), undefined);
  }
});

test('plan envelope parsing matches YAML trimming semantics for trailing spaces', () => {
  const plan = parsePlanEnvelope([
    'schema_version: 2',
    'id: discover',
    'agent: gtm/social',
    'purpose: Find opportunities. ',
    'tool_uses:',
    '  - opportunity-search ',
    '',
  ].join('\n'), 'discover.yaml');
  assert.equal(plan.purpose, 'Find opportunities.');
  assert.deepEqual(plan.tool_uses, ['opportunity-search']);
});

test('tool-use drafts contain only the bounded identity envelope at all four scopes', () => {
  const scopes = [
    {},
    { function: 'gtm' },
    { function: 'gtm', agent: 'social' },
    { function: 'gtm', agent: 'social', plan: 'discover' },
  ];
  for (const scope of scopes) {
    const rendered = renderToolUseDraft('opportunity-search', 'Find public opportunities.', scope);
    const parsed = YAML.parse(rendered) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['schema_version', 'id', 'scope', 'purpose', 'skill_ref']);
    assert.deepEqual(parsed, {
      schema_version: 2,
      id: 'opportunity-search',
      scope,
      purpose: 'Find public opportunities.',
      skill_ref: '',
    });
    assert.equal(Object.hasOwn(parsed, 'agent'), false);
    assert.equal(Object.hasOwn(parsed, 'why'), false);
  }
});

test('generic child parsing is subagent-only and logical function tools is reserved', () => {
  assert.equal(failureCode(() => parseChildDefinition('subagent', [
    'schema_version: 2',
    'id: search',
    'scope: {}',
    'purpose: Search.',
    'skill_ref: ""',
    '',
  ].join('\n'), 'tool.yaml')), 'UNKNOWN_FIELD');

  assert.equal(failureCode(() => parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: record-test',
    'functions:',
    '  tools:',
    '    path: functions/tools',
    'hosts: {}',
    'tool_uses: []',
    '',
  ].join('\n'))), 'IDENTITY_INVALID');

  const unsupported = parseWorkspaceRegistry([
    'schema_version: 2',
    'workspace_id: record-test',
    'functions: {}',
    'hosts:',
    '  gemini: enabled',
    'tool_uses: []',
    '',
  ].join('\n'));
  assert.equal(failureCode(() => enabledV2Hosts(unsupported)), 'UNKNOWN_FIELD');
});

test('tool-use draft rendering rejects incomplete ancestry', () => {
  assert.equal(
    failureCode(() => renderToolUseDraft('search', 'Search.', { agent: 'social' })),
    'IDENTITY_INVALID',
  );
  assert.equal(
    failureCode(() => renderToolUseDraft('search', 'Search.', { function: 'gtm', plan: 'discover' })),
    'IDENTITY_INVALID',
  );
});
