import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import {
  MAX_PLAN_COLLECTION_ITEMS,
  parseStructuredPlan,
  resolveValidatedPlan,
  resolveValidatedPlanClosure,
  validateStructuredPlans,
  type PlanWorkspaceRecord,
} from '../src/lib/workspace-plan.ts';
import { collectCompleteWorkspaceSnapshot } from '../src/lib/workspace-registry.ts';
import {
  WORKSPACE_DIAGNOSTIC_CODES,
  isWorkspaceFailure,
  workspaceFailure,
} from '../src/lib/workspace-diagnostics.ts';
import {
  MAX_AUTHORED_YAML_BYTES,
  MAX_YAML_DEPTH,
  MAX_YAML_NODES,
  MAX_YAML_SCALAR_BYTES,
} from '../src/lib/workspace-record.ts';

function definition(id: string, agent = 'gtm/social'): Record<string, unknown> {
  return {
    schema_version: 2,
    id,
    agent,
    purpose: `Run ${id}.`,
    inputs: {},
    brain_selectors: {},
    guidelines: [],
    tool_uses: [],
    artifacts: {},
    caps: {},
    steps: [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the work.' }],
    completion: {
      artifacts: [],
      output_guidance: 'Return the result.',
      criteria: ['The result is complete.'],
    },
  };
}

function planRecord(value: Record<string, unknown>): PlanWorkspaceRecord {
  const agent = String(value.agent);
  const id = String(value.id);
  return {
    kind: 'plan',
    qualified_id: `${agent}#${id}`,
    path: `functions/${agent.replace('/', '/agents/')}/plans/${id}.yaml`,
    scope: { function: agent.split('/')[0]!, agent: agent.split('/')[1]! },
    content: YAML.stringify(value),
  };
}

function record(
  kind: Exclude<PlanWorkspaceRecord['kind'], 'plan'>,
  qualifiedId: string,
  scope: Record<string, string> = {},
): PlanWorkspaceRecord {
  return { kind, qualified_id: qualifiedId, path: `${qualifiedId}.record`, scope };
}

function failureCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    return isWorkspaceFailure(error) ? error.code : undefined;
  }
}

function completePlanSnapshot(values: readonly Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), 'roster-plan-closure-'));
  try {
    writeFileSync(join(root, 'roster.yaml'), YAML.stringify({
      schema_version: 2,
      workspace_id: 'plan-closure-test',
      functions: { gtm: { path: 'functions/gtm' } },
      hosts: {},
      tool_uses: [],
    }));
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
    const functionRoot = join(root, 'functions', 'gtm');
    const agentRoot = join(functionRoot, 'agents', 'social');
    const planRoot = join(agentRoot, 'plans');
    mkdirSync(planRoot, { recursive: true });
    writeFileSync(join(functionRoot, 'function.yaml'), YAML.stringify({
      schema_version: 2,
      id: 'gtm',
      purpose: 'Test complete plan closure.',
      agents: ['social'],
      guidelines: [],
      tool_uses: [],
    }));
    writeFileSync(join(agentRoot, 'agent.yaml'), YAML.stringify({
      schema_version: 2,
      id: 'social',
      function: 'gtm',
      purpose: 'Test complete plan closure.',
      plans: values.map((value) => String(value.id)),
      subagents: [],
      guidelines: [],
      default_guidelines: [],
      tool_uses: [],
      lessons: [],
    }));
    for (const value of values) writeFileSync(join(planRoot, `${String(value.id)}.yaml`), YAML.stringify(value));
    return collectCompleteWorkspaceSnapshot(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('complete Social Media Manager plan validates all seven host-interpreted step kinds', () => {
  const history = definition('history-screen');
  const discovery = definition('opportunity-discovery');
  discovery.inputs = {
    request: { description: 'The human request.', required: true, shape: 'Plain text.' },
  };
  discovery.brain_selectors = {
    positioning: { description: 'Current company positioning.', required: true },
    replies: { description: 'Successful reply examples.', required: false },
  };
  discovery.guidelines = ['gtm/guidelines/voice', 'gtm/social/guidelines/review'];
  discovery.artifacts = {
    'search-brief': { description: 'The host-prepared search brief.', shape: 'Markdown.' },
    shortlist: { description: 'Reviewed opportunities.' },
  };
  discovery.caps = { candidates: { maximum: 25, guidance: 'Keep only relevant posts.' } };
  discovery.steps = [
    {
      id: 'prepare',
      kind: 'reasoning',
      instruction: 'Prepare filters; prose like ${request} remains literal guidance.',
      context: { brain: ['positioning'], guidelines: ['gtm/guidelines/voice'] },
      expected: { artifacts: ['search-brief'], output_guidance: 'Explain the filters.' },
    },
    { id: 'research', kind: 'subagent', instruction: 'Delegate research.', subagent: 'researcher' },
    { id: 'collaborate', kind: 'cross-agent', instruction: 'Ask the editor.', agent: 'content/editor' },
    { id: 'screen-history', kind: 'nested-plan', instruction: 'Screen history.', plan: 'gtm/social#history-screen' },
    {
      id: 'search',
      kind: 'tool',
      instruction: 'Use the company search guidance.',
      tool_use: 'social-search',
      retry_guidance: { max_attempts: 2, instruction: 'Narrow the query before retrying.' },
    },
    { id: 'approve', kind: 'approval', instruction: 'Wait.', approval_guidance: 'Ask the human to approve the shortlist.' },
    { id: 'publish', kind: 'artifact', instruction: 'Return the shortlist.', artifact: 'shortlist' },
  ];
  discovery.completion = {
    artifacts: ['shortlist'],
    output_guidance: 'Return the approved shortlist with rationale.',
    criteria: ['Every opportunity matches the request.', 'The human approved the shortlist.'],
  };
  const records: PlanWorkspaceRecord[] = [
    record('agent', 'gtm/social'),
    record('agent', 'content/editor'),
    record('subagent', 'gtm/social/subagents/researcher'),
    record('guideline', 'gtm/guidelines/voice'),
    record('guideline', 'gtm/social/guidelines/review'),
    record('tool-use', 'gtm/social/tools/social-search', { function: 'gtm', agent: 'social', plan: 'opportunity-discovery' }),
    planRecord(discovery),
    planRecord(history),
  ];

  const result = validateStructuredPlans(records, ['gtm/social#opportunity-discovery']);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, 'TOOL_USE_SNAPSHOT_INCOMPLETE');
  assert.deepEqual(result.selected_plan_ids, ['gtm/social#history-screen', 'gtm/social#opportunity-discovery']);
  assert.deepEqual(result.plans.find((plan) => plan.id === 'opportunity-discovery')?.steps.map((step) => step.kind), [
    'reasoning',
    'subagent',
    'cross-agent',
    'nested-plan',
    'tool',
    'approval',
    'artifact',
  ]);
  assert.throws(() => resolveValidatedPlan(records, 'gtm/social#opportunity-discovery'));
});

test('draft, forbidden runtime fields, unknown fields, and inert prose stay distinct', () => {
  const draft = definition('draft');
  draft.steps = [];
  draft.completion = { artifacts: [], output_guidance: '', criteria: [] };
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(draft), 'draft.yaml')), 'PLAN_DRAFT_INCOMPLETE');

  const forbidden = definition('forbidden');
  forbidden.steps = [{ id: 'run', kind: 'reasoning', instruction: 'Do work.', command: 'vendor run' }];
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(forbidden), 'forbidden.yaml')), 'PLAN_FIELD_FORBIDDEN');

  const unknown = definition('unknown');
  (unknown.completion as Record<string, unknown>).extra = true;
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(unknown), 'unknown.yaml')), 'PLAN_SCHEMA_INVALID');

  const prose = definition('prose');
  prose.steps = [{
    id: 'explain',
    kind: 'reasoning',
    instruction: 'Explain `${literal}`, {{ordinary prose}}, and $(text) without evaluating them.',
  }];
  assert.doesNotThrow(() => parseStructuredPlan(YAML.stringify(prose), 'prose.yaml'));
});

test('schema rejects empty authored guidance, invalid values, and wrong step targets', () => {
  const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['empty purpose', (value) => { value.purpose = '   '; }],
    ['missing input required flag', (value) => { value.inputs = { request: { description: 'The request.' } }; }],
    ['empty input description', (value) => { value.inputs = { request: { description: '', required: true } }; }],
    ['empty input shape', (value) => { value.inputs = { request: { description: 'The request.', required: true, shape: '' } }; }],
    ['empty Brain selector description', (value) => { value.brain_selectors = { context: { description: ' ', required: true } }; }],
    ['empty artifact shape', (value) => { value.artifacts = { output: { description: 'The output.', shape: '' } }; }],
    ['fractional cap', (value) => { value.caps = { results: { maximum: 1.5, guidance: 'Bound results.' } }; }],
    ['unsafe cap', (value) => { value.caps = { results: { maximum: Number.MAX_SAFE_INTEGER + 1, guidance: 'Bound results.' } }; }],
    ['empty cap guidance', (value) => { value.caps = { results: { maximum: 1, guidance: '' } }; }],
    ['missing expected output guidance', (value) => {
      value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', expected: { artifacts: [] } }];
    }],
    ['empty expected output guidance', (value) => {
      value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', expected: { artifacts: [], output_guidance: ' ' } }];
    }],
    ['empty condition guidance', (value) => {
      value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', condition_guidance: '' }];
    }],
    ['fractional retry count', (value) => {
      value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', retry_guidance: { max_attempts: 1.5, instruction: 'Try differently.' } }];
    }],
    ['empty retry instruction', (value) => {
      value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', retry_guidance: { max_attempts: 1, instruction: '' } }];
    }],
    ['missing approval guidance', (value) => {
      value.steps = [{ id: 'approve', kind: 'approval', instruction: 'Wait.' }];
    }],
    ['empty approval guidance', (value) => {
      value.steps = [{ id: 'approve', kind: 'approval', instruction: 'Wait.', approval_guidance: ' ' }];
    }],
    ['target on reasoning step', (value) => {
      value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', tool_use: 'search' }];
    }],
    ['multiple kind targets', (value) => {
      value.steps = [{ id: 'search', kind: 'tool', instruction: 'Search.', tool_use: 'search', agent: 'gtm/social' }];
    }],
    ['non-string completion criterion', (value) => {
      value.completion = { artifacts: [], output_guidance: 'Return it.', criteria: [42] };
    }],
  ];

  for (const [index, [label, mutate]] of cases.entries()) {
    const value = definition(`schema-case-${index}`);
    mutate(value);
    assert.equal(
      failureCode(() => parseStructuredPlan(YAML.stringify(value), `${label}.yaml`)),
      'PLAN_SCHEMA_INVALID',
      label,
    );
  }

  const duplicateCatalog = definition('duplicate-catalog');
  duplicateCatalog.inputs = {
    item: { description: 'First.', required: true },
    Item: { description: 'Second.', required: true },
  };
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(duplicateCatalog), 'duplicate-catalog.yaml')),
    'DUPLICATE_IDENTITY',
  );
});

test('executor-shaped fields are forbidden at every plan mapping depth', () => {
  const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['top', (value) => { value.command = 'run'; }],
    ['input', (value) => { value.inputs = { request: { description: 'Request.', required: true, command: 'run' } }; }],
    ['selector', (value) => { value.brain_selectors = { context: { description: 'Context.', required: true, command: 'run' } }; }],
    ['artifact', (value) => { value.artifacts = { output: { description: 'Output.', command: 'run' } }; }],
    ['cap', (value) => { value.caps = { results: { maximum: 1, guidance: 'Bound it.', command: 'run' } }; }],
    ['step', (value) => { value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', command: 'run' }]; }],
    ['context', (value) => { value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', context: { command: 'run' } }]; }],
    ['expected', (value) => { value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', expected: { artifacts: [], output_guidance: 'Return.', command: 'run' } }]; }],
    ['retry', (value) => { value.steps = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare.', retry_guidance: { max_attempts: 1, instruction: 'Retry.', command: 'run' } }]; }],
    ['completion', (value) => { value.completion = { artifacts: [], output_guidance: 'Return.', criteria: ['Done.'], command: 'run' }; }],
  ];
  for (const [label, mutate] of cases) {
    const value = definition(`forbidden-${label}`);
    mutate(value);
    assert.equal(
      failureCode(() => parseStructuredPlan(YAML.stringify(value), `forbidden-${label}.yaml`)),
      'PLAN_FIELD_FORBIDDEN',
      label,
    );
  }
});

test('reference validation aggregates missing and inapplicable references', () => {
  const value = definition('references');
  value.guidelines = ['gtm/guidelines/missing'];
  value.brain_selectors = {};
  value.artifacts = {};
  value.steps = [
    { id: 'sub', kind: 'subagent', instruction: 'Delegate.', subagent: 'missing' },
    { id: 'agent', kind: 'cross-agent', instruction: 'Collaborate.', agent: 'gtm/missing' },
    { id: 'plan', kind: 'nested-plan', instruction: 'Nest.', plan: 'gtm/social#missing' },
    { id: 'tool', kind: 'tool', instruction: 'Search.', tool_use: 'search' },
    {
      id: 'reason',
      kind: 'reasoning',
      instruction: 'Reason.',
      context: { brain: ['missing'], guidelines: ['gtm/guidelines/missing'] },
      expected: { artifacts: ['missing'], output_guidance: 'Return it.' },
    },
    { id: 'artifact', kind: 'artifact', instruction: 'Return it.', artifact: 'missing' },
  ];
  value.completion = { artifacts: ['missing'], output_guidance: '', criteria: ['Return it.'] };
  const result = validateStructuredPlans([
    record('agent', 'gtm/social'),
    record('tool-use', 'gtm/social/tools/search', { function: 'gtm', agent: 'social', plan: 'other' }),
    planRecord(value),
  ]);
  assert.ok(result.diagnostics.filter((entry) => entry.code === 'REFERENCE_NOT_FOUND').length >= 8);
  assert.equal(result.diagnostics.filter((entry) => entry.code === 'REFERENCE_NOT_APPLICABLE').length, 0);
  assert.equal(result.diagnostics.filter((entry) => entry.code === 'TOOL_USE_SNAPSHOT_INCOMPLETE').length, 1);
  assert.ok(result.diagnostics.every((entry) => entry.path?.endsWith('/references.yaml')));
});

test('local and qualified references use the complete bounded record-ID grammar', () => {
  const eighty = 'a'.repeat(80);
  const accepted = definition('bounded-identities');
  accepted.inputs = { [eighty]: { description: 'Maximum-length ID.', required: true } };
  accepted.steps = [{ id: 'collaborate', kind: 'cross-agent', instruction: 'Collaborate.', agent: `${eighty}/social` }];
  assert.doesNotThrow(() => parseStructuredPlan(YAML.stringify(accepted), 'bounded-identities.yaml'));

  const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['oversized local ID', (value) => { value.inputs = { ['a'.repeat(81)]: { description: 'Too long.', required: true } }; }],
    ['reserved local ID', (value) => { value.inputs = { con: { description: 'Reserved.', required: true } }; }],
    ['oversized agent component', (value) => {
      value.steps = [{ id: 'collaborate', kind: 'cross-agent', instruction: 'Collaborate.', agent: `${'a'.repeat(81)}/social` }];
    }],
    ['reserved nested-plan component', (value) => {
      value.steps = [{ id: 'nest', kind: 'nested-plan', instruction: 'Nest.', plan: 'gtm/social#con' }];
    }],
    ['guideline shorthand', (value) => { value.guidelines = ['gtm/voice']; }],
    ['oversized guideline component', (value) => { value.guidelines = [`gtm/guidelines/${'a'.repeat(81)}`]; }],
  ];
  for (const [index, [label, mutate]] of cases.entries()) {
    const value = definition(`identity-case-${index}`);
    mutate(value);
    assert.equal(
      failureCode(() => parseStructuredPlan(YAML.stringify(value), `${label}.yaml`)),
      'PLAN_SCHEMA_INVALID',
      label,
    );
  }
});

test('validated resolver rejects disagreement between record and authored plan identity', () => {
  const value = definition('authored');
  const mismatched = planRecord(value);
  mismatched.qualified_id = 'gtm/social#registered';
  const result = validateStructuredPlans([mismatched], ['gtm/social#registered']);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, 'IDENTITY_PATH_MISMATCH');
  assert.equal(result.diagnostics[0]?.details['expected'], 'gtm/social#registered');
  assert.equal(result.diagnostics[0]?.details['actual'], 'gtm/social#authored');
  assert.throws(() => resolveValidatedPlan([mismatched], 'gtm/social#registered'));
});

test('validated resolver always parses exact authored content and preserves diagnostic paths', () => {
  const malformed = planRecord(definition('malformed-content'));
  malformed.content = 'not: [valid\n';
  assert.equal(validateStructuredPlans([malformed]).diagnostics[0]?.code, 'YAML_INVALID');

  const missingReference = definition('missing-reference');
  missingReference.steps = [{ id: 'delegate', kind: 'subagent', instruction: 'Delegate.', subagent: 'missing' }];
  const missingRecord = planRecord(missingReference);
  try {
    resolveValidatedPlan([missingRecord], missingRecord.qualified_id);
    assert.fail('resolver should reject the missing reference');
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    if (isWorkspaceFailure(error)) {
      assert.equal(error.code, 'REFERENCE_NOT_FOUND');
      assert.equal(error.details['path'], missingRecord.path);
    }
  }
});

test('validated resolver prioritizes diagnostics authored by the requested plan', () => {
  const requested = definition('requested');
  requested.steps = [
    { id: 'delegate', kind: 'subagent', instruction: 'Delegate.', subagent: 'missing' },
    { id: 'nested', kind: 'nested-plan', instruction: 'Use the nested plan.', plan: 'gtm/social#nested' },
  ];
  const nested = definition('nested');
  nested.steps = [];
  nested.completion = { artifacts: [], output_guidance: '', criteria: [] };

  const records = [planRecord(requested), planRecord(nested)];
  assert.equal(validateStructuredPlans(records, ['gtm/social#requested']).diagnostics[0]?.code, 'PLAN_DRAFT_INCOMPLETE');
  try {
    resolveValidatedPlan(records, 'gtm/social#requested');
    assert.fail('resolver should reject the requested plan reference');
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    if (isWorkspaceFailure(error)) {
      assert.equal(error.code, 'REFERENCE_NOT_FOUND');
      assert.equal(error.details['source_plan'], 'gtm/social#requested');
    }
  }
});

test('selected roots and nested closure contain registered plans only', () => {
  const missingRoot = validateStructuredPlans([], ['gtm/social#missing']);
  assert.deepEqual(missingRoot.selected_plan_ids, []);
  assert.equal(missingRoot.diagnostics[0]?.code, 'REFERENCE_NOT_FOUND');

  const source = definition('source');
  source.steps = [{ id: 'missing', kind: 'nested-plan', instruction: 'Use it.', plan: 'gtm/social#missing' }];
  const missingNested = validateStructuredPlans([planRecord(source)], ['gtm/social#source']);
  assert.deepEqual(missingNested.selected_plan_ids, ['gtm/social#source']);
  assert.equal(missingNested.plans.length, 1);
  assert.equal(missingNested.diagnostics[0]?.code, 'REFERENCE_NOT_FOUND');
});

test('complete-snapshot resolver returns the root first and the full closure in code-point order', () => {
  const root = definition('root');
  root.steps = [
    { id: 'later', kind: 'nested-plan', instruction: 'Use AA.', plan: 'gtm/social#aa' },
    { id: 'earlier', kind: 'nested-plan', instruction: 'Use A-Z.', plan: 'gtm/social#a-z' },
  ];
  const unrelated = definition('unrelated');
  unrelated.steps = [];
  unrelated.completion = { artifacts: [], output_guidance: '', criteria: [] };
  const snapshot = completePlanSnapshot([
    unrelated,
    definition('aa'),
    root,
    definition('a-z'),
  ]);

  const closure = resolveValidatedPlanClosure(snapshot, 'gtm/social#root');
  assert.equal(closure.root.qualified_id, 'gtm/social#root');
  assert.deepEqual(
    closure.definitions.map((plan) => plan.qualified_id),
    ['gtm/social#root', 'gtm/social#a-z', 'gtm/social#aa'],
  );
  assert.equal(Object.isFrozen(closure), true);
  assert.equal(Object.isFrozen(closure.definitions), true);
});

test('complete-snapshot resolver fails on selected closure diagnostics but ignores unrelated drafts', () => {
  const root = definition('root');
  root.steps = [{ id: 'nested', kind: 'nested-plan', instruction: 'Use the draft.', plan: 'gtm/social#draft' }];
  const draft = definition('draft');
  draft.steps = [];
  draft.completion = { artifacts: [], output_guidance: '', criteria: [] };
  const snapshot = completePlanSnapshot([root, draft]);

  assert.equal(
    failureCode(() => resolveValidatedPlanClosure(snapshot, 'gtm/social#root')),
    'PLAN_DRAFT_INCOMPLETE',
  );
  assert.equal(
    failureCode(() => resolveValidatedPlanClosure(snapshot, 'gtm/social#missing')),
    'REFERENCE_NOT_FOUND',
  );
});

test('schema failures aggregate once per plan in stable authored-path order', () => {
  const first = definition('a-plan');
  first.steps = 'wrong';
  const second = definition('b-plan');
  second.brain_selectors = [];
  const result = validateStructuredPlans([planRecord(second), planRecord(first)]);
  assert.deepEqual(
    result.diagnostics.map((entry) => [entry.code, entry.path]),
    [
      ['PLAN_SCHEMA_INVALID', 'functions/gtm/agents/social/plans/a-plan.yaml'],
      ['PLAN_SCHEMA_INVALID', 'functions/gtm/agents/social/plans/b-plan.yaml'],
    ],
  );
});

test('targeted closure ignores unrelated drafts and emits one canonical SCC cycle', () => {
  const a = definition('a');
  a.steps = [
    { id: 'z-hop', kind: 'nested-plan', instruction: 'Call B.', plan: 'gtm/social#b' },
    { id: 'a-hop', kind: 'nested-plan', instruction: 'Call B again.', plan: 'gtm/social#b' },
  ];
  const b = definition('b');
  b.steps = [{ id: 'return', kind: 'nested-plan', instruction: 'Call A.', plan: 'gtm/social#a' }];
  const draft = definition('unrelated');
  draft.steps = [];
  draft.completion = { artifacts: [], output_guidance: '', criteria: [] };
  const records = [planRecord(a), planRecord(b), planRecord(draft)];

  const targeted = validateStructuredPlans(records, ['gtm/social#a']);
  assert.equal(targeted.diagnostics.length, 1);
  assert.equal(targeted.diagnostics[0]?.code, 'REFERENCE_CYCLE');
  assert.deepEqual(targeted.diagnostics[0]?.details['cycle'], ['gtm/social#a', 'gtm/social#b', 'gtm/social#a']);
  assert.deepEqual(targeted.diagnostics[0]?.details['step_ids'], ['a-hop', 'return']);

  const whole = validateStructuredPlans(records);
  assert.ok(whole.diagnostics.some((entry) => entry.code === 'PLAN_DRAFT_INCOMPLETE'));
  assert.deepEqual(
    whole.diagnostics.find((entry) => entry.code === 'REFERENCE_CYCLE')?.details,
    targeted.diagnostics[0]?.details,
  );
});

test('direct self-cycle emits one canonical closed path', () => {
  const value = definition('self');
  value.steps = [{ id: 'repeat', kind: 'nested-plan', instruction: 'Repeat.', plan: 'gtm/social#self' }];
  const result = validateStructuredPlans([planRecord(value)]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, 'REFERENCE_CYCLE');
  assert.deepEqual(result.diagnostics[0]?.details['cycle'], ['gtm/social#self', 'gtm/social#self']);
  assert.deepEqual(result.diagnostics[0]?.details['step_ids'], ['repeat']);
});

test('deep nested-plan cycle validation is iterative and stack-safe', { timeout: 30_000 }, () => {
  const count = 12_000;
  const records: PlanWorkspaceRecord[] = [];
  for (let index = 0; index < count; index++) {
    const id = `plan-${String(index).padStart(5, '0')}`;
    const next = `plan-${String((index + 1) % count).padStart(5, '0')}`;
    const value = definition(id);
    value.steps = [{ id: 'next', kind: 'nested-plan', instruction: 'Use the next plan.', plan: `gtm/social#${next}` }];
    records.push({
      kind: 'plan',
      qualified_id: `gtm/social#${id}`,
      path: `functions/gtm/agents/social/plans/${id}.yaml`,
      scope: { function: 'gtm', agent: 'social' },
      content: JSON.stringify(value),
    });
  }

  const result = validateStructuredPlans(records);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, 'REFERENCE_CYCLE');
  assert.equal((result.diagnostics[0]?.details['cycle'] as unknown[]).length, count + 1);
  assert.equal((result.diagnostics[0]?.details['step_ids'] as unknown[]).length, count);
});

test('plan collection, retry, cap, and duplicate identity bounds fail deterministically', () => {
  const tooMany = definition('too-many');
  tooMany.steps = Array.from({ length: MAX_PLAN_COLLECTION_ITEMS + 1 }, (_, index) => ({
    id: `step-${index}`,
    kind: 'reasoning',
    instruction: 'Work.',
  }));
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(tooMany), 'too-many.yaml')), 'PLAN_SCHEMA_INVALID');

  const retry = definition('retry');
  retry.steps = [{
    id: 'retry',
    kind: 'reasoning',
    instruction: 'Try.',
    retry_guidance: { max_attempts: 257, instruction: 'Try differently.' },
  }];
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(retry), 'retry.yaml')), 'PLAN_SCHEMA_INVALID');

  const cap = definition('cap');
  cap.caps = { candidates: { maximum: 0, guidance: 'Limit candidates.' } };
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(cap), 'cap.yaml')), 'PLAN_SCHEMA_INVALID');

  const tooManyCatalogEntries = definition('too-many-catalog-entries');
  tooManyCatalogEntries.artifacts = Object.fromEntries(Array.from(
    { length: MAX_PLAN_COLLECTION_ITEMS + 1 },
    (_, index) => [`artifact-${index}`, { description: `Artifact ${index}.` }],
  ));
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(tooManyCatalogEntries), 'too-many-catalog-entries.yaml')),
    'PLAN_SCHEMA_INVALID',
  );

  const tooManyReferences = definition('too-many-references');
  tooManyReferences.guidelines = Array.from(
    { length: MAX_PLAN_COLLECTION_ITEMS + 1 },
    (_, index) => `gtm/guidelines/guideline-${index}`,
  );
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(tooManyReferences), 'too-many-references.yaml')),
    'PLAN_SCHEMA_INVALID',
  );

  const duplicate = definition('duplicate');
  duplicate.steps = [
    { id: 'same', kind: 'reasoning', instruction: 'First.' },
    { id: 'Same', kind: 'reasoning', instruction: 'Second.' },
  ];
  assert.equal(failureCode(() => parseStructuredPlan(YAML.stringify(duplicate), 'duplicate.yaml')), 'DUPLICATE_IDENTITY');
});

test('structured plans inherit YAML byte, alias, node, scalar, and depth bounds', () => {
  const tooLarge = definition('too-large');
  tooLarge.purpose = 'x'.repeat(MAX_AUTHORED_YAML_BYTES + 1);
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(tooLarge), 'too-large.yaml')),
    'READ_LIMIT_EXCEEDED',
  );

  const aliased = YAML.stringify(definition('aliased')).replace(
    'inputs: {}\n',
    'inputs:\n  first: &shared\n    description: Shared input.\n    required: true\n  second: *shared\n',
  );
  assert.equal(failureCode(() => parseStructuredPlan(aliased, 'aliased.yaml')), 'YAML_INVALID');

  const tooManyNodes = definition('too-many-nodes');
  tooManyNodes.guidelines = Array.from({ length: MAX_YAML_NODES }, () => 'x');
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(tooManyNodes), 'too-many-nodes.yaml')),
    'YAML_INVALID',
  );

  const oversizedScalar = definition('oversized-scalar');
  oversizedScalar.purpose = 'x'.repeat(MAX_YAML_SCALAR_BYTES + 1);
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(oversizedScalar), 'oversized-scalar.yaml')),
    'YAML_INVALID',
  );

  const tooDeep = definition('too-deep');
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < MAX_YAML_DEPTH + 4; depth++) nested = { nested };
  tooDeep.extra = nested;
  assert.equal(
    failureCode(() => parseStructuredPlan(YAML.stringify(tooDeep), 'too-deep.yaml')),
    'YAML_INVALID',
  );
});

test('one canonical diagnostic tuple drives runtime workspace-failure recognition', () => {
  for (const code of WORKSPACE_DIAGNOSTIC_CODES) {
    assert.equal(isWorkspaceFailure(workspaceFailure(code, code, 'Fix it.')), true, code);
  }
});
