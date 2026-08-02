import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import {
  enabledV2Hosts,
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
