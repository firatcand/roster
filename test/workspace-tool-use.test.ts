import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import {
  assertCompleteWorkspaceSnapshot,
  parseWorkspaceToolUseDefinition,
  resolveToolUse,
  TOOL_USE_EFFECT_CLASSES,
  validateToolUseLattice,
  type CompleteWorkspaceSnapshot,
  type ToolUseContext,
} from '../src/lib/workspace-tool-use.ts';
import {
  collectCompleteWorkspaceSnapshot,
  type WorkspaceDiscoveryRecord,
} from '../src/lib/workspace-registry.ts';

type DefinitionInput = {
  schema_version?: number;
  id?: string;
  scope?: ToolUseContext;
  purpose?: string;
  skill_ref?: unknown;
  when?: string[];
  capabilities?: string[];
  filters?: string[];
  rules?: string[];
  how?: string[];
  output_expectations?: { required?: string[]; guidance?: string[] };
  brain?: { read?: string[]; write?: string[] };
  effects?: { allowed?: string[] };
  approval?: { requirement?: string; guidance?: string[] };
  evidence?: { required?: string[]; guidance?: string[] };
  [key: string]: unknown;
};

function hash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function qualifiedId(scope: ToolUseContext, id: string): string {
  if (scope.function === undefined) return `tools/${id}`;
  if (scope.agent === undefined) return `${scope.function}/tools/${id}`;
  if (scope.plan === undefined) return `${scope.function}/${scope.agent}/tools/${id}`;
  return `${scope.function}/${scope.agent}#${scope.plan}/tools/${id}`;
}

function definition(scope: ToolUseContext, overrides: DefinitionInput = {}): string {
  return YAML.stringify({
    schema_version: 2,
    id: 'research-opportunities',
    scope,
    purpose: 'Find attributable public opportunities.',
    skill_ref: 'exa:search',
    ...overrides,
  });
}

function record(
  scope: ToolUseContext,
  overrides: DefinitionInput = {},
  options: { path?: string; content?: string } = {},
): WorkspaceDiscoveryRecord {
  const id = overrides.id ?? 'research-opportunities';
  const content = options.content ?? definition(scope, overrides);
  return {
    qualified_id: qualifiedId(scope, id),
    kind: 'tool-use',
    path: options.path ?? `${qualifiedId(scope, id)}.yaml`,
    purpose: typeof overrides.purpose === 'string' ? overrides.purpose : 'Find attributable public opportunities.',
    scope: { ...scope },
    schema_version: 2,
    content_hash: hash(content),
    references: {},
    content,
  };
}

type PlanFixture = {
  tools: Map<string, string>;
};

type AgentFixture = {
  tools: Map<string, string>;
  plans: Map<string, PlanFixture>;
};

type FunctionFixture = {
  tools: Map<string, string>;
  agents: Map<string, AgentFixture>;
};

function localId(recordValue: WorkspaceDiscoveryRecord): string {
  const marker = '/tools/';
  const index = recordValue.qualified_id.lastIndexOf(marker);
  return index < 0
    ? recordValue.qualified_id.slice('tools/'.length)
    : recordValue.qualified_id.slice(index + marker.length);
}

function materializeWorkspace(records: readonly WorkspaceDiscoveryRecord[]): string {
  const root = mkdtempSync(join(tmpdir(), 'roster-tool-use-'));
  const workspaceTools = new Map<string, string>();
  const functions = new Map<string, FunctionFixture>();
  const ensureFunction = (id: string): FunctionFixture => {
    const existing = functions.get(id);
    if (existing !== undefined) return existing;
    const created = { tools: new Map<string, string>(), agents: new Map<string, AgentFixture>() };
    functions.set(id, created);
    return created;
  };
  const ensureAgent = (fn: FunctionFixture, id: string): AgentFixture => {
    const existing = fn.agents.get(id);
    if (existing !== undefined) return existing;
    const created = { tools: new Map<string, string>(), plans: new Map<string, PlanFixture>() };
    fn.agents.set(id, created);
    return created;
  };
  const ensurePlan = (agent: AgentFixture, id: string): PlanFixture => {
    const existing = agent.plans.get(id);
    if (existing !== undefined) return existing;
    const created = { tools: new Map<string, string>() };
    agent.plans.set(id, created);
    return created;
  };
  for (const recordValue of records) {
    assert.equal(typeof recordValue.content, 'string');
    const id = localId(recordValue);
    const functionId = recordValue.scope.function;
    if (functionId === undefined) {
      workspaceTools.set(id, recordValue.content!);
      continue;
    }
    const fn = ensureFunction(functionId);
    const agentId = recordValue.scope.agent;
    if (agentId === undefined) {
      fn.tools.set(id, recordValue.content!);
      continue;
    }
    const agent = ensureAgent(fn, agentId);
    const planId = recordValue.scope.plan;
    if (planId === undefined) {
      agent.tools.set(id, recordValue.content!);
      continue;
    }
    ensurePlan(agent, planId).tools.set(id, recordValue.content!);
  }
  writeFileSync(join(root, 'roster.yaml'), YAML.stringify({
    schema_version: 2,
    workspace_id: 'tool-use-test',
    tool_uses: [...workspaceTools.keys()].sort(),
    functions: Object.fromEntries([...functions.keys()].sort().map((id) => [id, { path: `functions/${id}` }])),
    hosts: {},
  }));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  const writeTools = (base: string, tools: ReadonlyMap<string, string>): void => {
    if (tools.size === 0) return;
    mkdirSync(base, { recursive: true });
    for (const [id, content] of [...tools].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      writeFileSync(join(base, `${id}.yaml`), content);
    }
  };
  writeTools(join(root, 'tools'), workspaceTools);
  for (const [functionId, fn] of [...functions].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const functionRoot = join(root, 'functions', functionId);
    mkdirSync(functionRoot, { recursive: true });
    writeFileSync(join(functionRoot, 'function.yaml'), YAML.stringify({
      schema_version: 2,
      id: functionId,
      purpose: `Purpose for ${functionId}.`,
      agents: [...fn.agents.keys()].sort(),
      guidelines: [],
      tool_uses: [...fn.tools.keys()].sort(),
    }));
    writeTools(join(functionRoot, 'tools'), fn.tools);
    for (const [agentId, agent] of [...fn.agents].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const agentRoot = join(functionRoot, 'agents', agentId);
      mkdirSync(agentRoot, { recursive: true });
      writeFileSync(join(agentRoot, 'agent.yaml'), YAML.stringify({
        schema_version: 2,
        id: agentId,
        function: functionId,
        purpose: `Purpose for ${agentId}.`,
        plans: [...agent.plans.keys()].sort(),
        subagents: [],
        guidelines: [],
        default_guidelines: [],
        tool_uses: [...agent.tools.keys()].sort(),
        lessons: [],
      }));
      writeTools(join(agentRoot, 'tools'), agent.tools);
      for (const [planId, plan] of [...agent.plans].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        const plansRoot = join(agentRoot, 'plans');
        mkdirSync(plansRoot, { recursive: true });
        writeFileSync(join(plansRoot, `${planId}.yaml`), YAML.stringify({
          schema_version: 2,
          id: planId,
          agent: `${functionId}/${agentId}`,
          purpose: `Purpose for ${planId}.`,
          inputs: {},
          brain_selectors: {},
          guidelines: [],
          tool_uses: [...plan.tools.keys()].sort(),
          artifacts: {},
          caps: {},
          steps: [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the result.' }],
          completion: {
            artifacts: [],
            output_guidance: 'Return the result.',
            criteria: ['The work is complete.'],
          },
        }));
        writeTools(join(plansRoot, planId, 'tools'), plan.tools);
      }
    }
  }
  return root;
}

function snapshot(records: readonly WorkspaceDiscoveryRecord[]): CompleteWorkspaceSnapshot {
  const root = materializeWorkspace(records);
  try {
    return collectCompleteWorkspaceSnapshot(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => isWorkspaceFailure(error) && error.code === code);
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((rest) => [value, ...rest]));
}

function typescriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...typescriptFiles(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function importDeclarations(source: string): Array<{ clause: string; module: string }> {
  const declarations: Array<{ clause: string; module: string }> = [];
  const pattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
  for (const match of source.matchAll(pattern)) {
    declarations.push({ clause: match[1]!, module: match[2]! });
  }
  return declarations;
}

test('snapshot minting stays behind the sole registry-owned internal issuer boundary', () => {
  const projectRoot = process.cwd();
  const publicSource = readFileSync(join(projectRoot, 'src/lib/workspace-tool-use.ts'), 'utf8');
  assert.doesNotMatch(publicSource, /\bmintCompleteWorkspaceSnapshot\b/);

  const sourceImporters = typescriptFiles(join(projectRoot, 'src'))
    .filter((path) => importDeclarations(readFileSync(path, 'utf8')).some((declaration) => (
      declaration.module.endsWith('/internal/workspace-tool-use-snapshot.ts')
      && declaration.clause.includes('mintCompleteWorkspaceSnapshot')
    )))
    .map((path) => path.slice(projectRoot.length + 1));
  assert.deepEqual(sourceImporters, ['src/lib/workspace-registry.ts']);

  const forbiddenTestImporters = typescriptFiles(join(projectRoot, 'test'))
    .filter((path) => importDeclarations(readFileSync(path, 'utf8')).some((declaration) => (
      declaration.module.includes('/internal/workspace-tool-use-snapshot')
      || declaration.clause.includes('mintCompleteWorkspaceSnapshot')
    )))
    .map((path) => path.slice(projectRoot.length + 1));
  assert.deepEqual(forbiddenTestImporters, []);
});

test('strict parser accepts the complete closed schema and rejects recursive unknown fields', () => {
  const content = definition({ function: 'gtm', agent: 'social-manager' }, {
    when: ['discovering public reply opportunities'],
    capabilities: ['web-search'],
    filters: ['exclude previously presented URLs'],
    rules: ['use attributable sources'],
    how: ['search public sources'],
    output_expectations: { required: ['canonical_url'], guidance: [] },
    brain: { read: ['prior-opportunities'], write: [] },
    effects: { allowed: ['external-read', 'brain-read'] },
    approval: { requirement: 'human', guidance: [] },
    evidence: { required: ['source_url'], guidance: [] },
  });
  const parsed = parseWorkspaceToolUseDefinition(content, 'tool.yaml');
  assert.equal(parsed.skill_ref, 'exa:search');
  assert.deepEqual(parsed.scope, { function: 'gtm', agent: 'social-manager' });

  const unknown = definition({}, {
    output_expectations: { required: ['canonical_url'], provider_gate: true } as never,
  });
  assertCode(() => parseWorkspaceToolUseDefinition(unknown, 'tool.yaml'), 'UNKNOWN_FIELD');
});

test('minimal tool-use parsing matches YAML trimming semantics for trailing spaces', () => {
  const parsed = parseWorkspaceToolUseDefinition([
    'schema_version: 2',
    'id: research-opportunities',
    'scope: {}',
    'purpose: Find public opportunities. ',
    'skill_ref: exa:search ',
    '',
  ].join('\n'), 'tool.yaml');
  assert.equal(parsed.purpose, 'Find public opportunities.');
  assert.equal(parsed.skill_ref, 'exa:search');
});

test('YAML duplicate keys, aliases, hostile tags, and scalar type tricks fail closed', () => {
  const prefix = `schema_version: 2
id: research-opportunities
scope: {}
purpose: Find public opportunities.
skill_ref: exa:search
`;
  assertCode(
    () => parseWorkspaceToolUseDefinition(`${prefix}purpose: Duplicate.\n`, 'tool.yaml'),
    'YAML_INVALID',
  );
  assertCode(
    () => parseWorkspaceToolUseDefinition(`${prefix}rules: &rules\n  - cite sources\nhow: *rules\n`, 'tool.yaml'),
    'YAML_INVALID',
  );
  assertCode(
    () => parseWorkspaceToolUseDefinition(`${prefix}rules: !hostile [cite sources]\n`, 'tool.yaml'),
    'YAML_INVALID',
  );
  assertCode(
    () => parseWorkspaceToolUseDefinition(`schema_version: 2\nid: research-opportunities\nscope: {}\npurpose: null\nskill_ref: exa:search\n`, 'tool.yaml'),
    'TOOL_USE_SCHEMA_INVALID',
  );

  const canary = `sk-${'Ab9_'.repeat(7)}`;
  const escapedCanary = `\\u0073k-${'Ab9_'.repeat(7)}`;
  assert.equal(escapedCanary.includes(canary), false);
  assertCode(
    () => parseWorkspaceToolUseDefinition(
      `schema_version: 2\nid: research-opportunities\nscope: {}\npurpose: "${escapedCanary}"\nskill_ref: exa:search\n`,
      'tool.yaml',
    ),
    'SECRET_MATERIAL_FORBIDDEN',
  );
  assertCode(
    () => parseWorkspaceToolUseDefinition(
      `schema_version: 2\nid: research-opportunities\nscope: {}\npurpose: Safe purpose.\nskill_ref: exa:search\n"${escapedCanary}": value\n`,
      'tool.yaml',
    ),
    'SECRET_MATERIAL_FORBIDDEN',
  );
});

test('four-scope composition is cumulative, replaces purpose, and records deterministic provenance', () => {
  const records = [
    record({}, {
      purpose: 'Workspace purpose.',
      when: ['workspace condition'],
      how: ['workspace procedure'],
      filters: ['workspace filter'],
      effects: { allowed: ['external-read', 'brain-read', 'brain-write'] },
      approval: { requirement: 'none', guidance: ['workspace approval guidance'] },
    }),
    record({ function: 'gtm' }, {
      purpose: 'Function purpose.',
      when: ['function condition'],
      capabilities: ['content-retrieval'],
      evidence: { required: ['source_url'] },
    }),
    record({ function: 'gtm', agent: 'social-manager' }, {
      purpose: 'Agent purpose.',
      how: ['agent procedure'],
      brain: { read: ['prior-opportunities'] },
      approval: { requirement: 'human' },
    }),
    record({ function: 'gtm', agent: 'social-manager', plan: 'discovery' }, {
      purpose: 'Plan purpose.',
      when: ['workspace condition', 'plan condition'],
      filters: ['plan filter'],
      effects: { allowed: ['external-read', 'brain-read'] },
      output_expectations: { required: ['canonical_url'] },
    }),
  ];
  const result = resolveToolUse(snapshot(records), {
    function: 'gtm',
    agent: 'social-manager',
    plan: 'discovery',
  }, 'research-opportunities');

  assert.equal(result.effective.purpose, 'Plan purpose.');
  assert.deepEqual(result.effective.when, ['workspace condition', 'function condition', 'plan condition']);
  assert.deepEqual(result.effective.how, ['workspace procedure', 'agent procedure']);
  assert.deepEqual(result.effective.filters, ['workspace filter', 'plan filter']);
  assert.deepEqual(result.effective.effects?.allowed, ['external-read', 'brain-read']);
  assert.equal(result.effective.approval.requirement, 'human');
  assert.deepEqual(result.contributors.map((entry) => entry.scope), [
    {},
    { function: 'gtm' },
    { function: 'gtm', agent: 'social-manager' },
    { function: 'gtm', agent: 'social-manager', plan: 'discovery' },
  ]);
  assert.equal(result.field_sources.purpose?.[0]?.qualified_id, 'gtm/social-manager#discovery/tools/research-opportunities');
  assert.equal(result.field_sources.when?.length, 4);
  assert.match(result.semantic_hash, /^sha256:[a-f0-9]{64}$/);
});

test('bounded property: every record ordering resolves deterministically and cumulative composition is idempotent', () => {
  const records = [
    record({}, {
      purpose: 'Workspace purpose.',
      when: ['shared condition', 'workspace condition'],
      rules: ['shared rule'],
      effects: { allowed: ['external-read', 'external-write', 'brain-read', 'brain-write'] },
      approval: { requirement: 'none', guidance: ['shared approval'] },
    }),
    record({ function: 'gtm' }, {
      purpose: 'Function purpose.',
      when: ['shared condition', 'function condition'],
      rules: ['shared rule', 'function rule'],
      effects: { allowed: ['external-read', 'brain-read', 'brain-write'] },
    }),
    record({ function: 'gtm', agent: 'social-manager' }, {
      purpose: 'Agent purpose.',
      when: ['agent condition'],
      rules: ['function rule', 'agent rule'],
      effects: { allowed: ['external-read', 'brain-read'] },
      approval: { requirement: 'human', guidance: ['shared approval'] },
    }),
    record({ function: 'gtm', agent: 'social-manager', plan: 'discovery' }, {
      purpose: 'Plan purpose.',
      when: ['shared condition', 'plan condition'],
      rules: ['agent rule'],
      effects: { allowed: ['external-read'] },
      approval: { requirement: 'human', guidance: ['plan approval'] },
    }),
  ];
  let baseline: ReturnType<typeof resolveToolUse> | undefined;
  for (const ordered of permutations(records)) {
    const resolved = resolveToolUse(
      snapshot(ordered),
      { function: 'gtm', agent: 'social-manager', plan: 'discovery' },
      'research-opportunities',
    );
    baseline ??= resolved;
    assert.deepEqual(resolved, baseline);
  }
  assert.deepEqual(baseline?.effective.when, [
    'shared condition',
    'workspace condition',
    'function condition',
    'agent condition',
    'plan condition',
  ]);
  assert.deepEqual(baseline?.effective.rules, ['shared rule', 'function rule', 'agent rule']);
  assert.deepEqual(baseline?.effective.approval.guidance, ['shared approval', 'plan approval']);
});

test('bounded property: effects can only narrow and human approval can never relax', () => {
  const effectClasses = [...TOOL_USE_EFFECT_CLASSES];
  const subsets = Array.from({ length: 1 << effectClasses.length }, (_, bits) => (
    effectClasses.filter((_, index) => (bits & (1 << index)) !== 0)
  ));
  const effectCases = [
    ...subsets.map((narrow, index) => ({
      id: `effect-narrow-${index.toString(16)}`,
      broad: effectClasses,
      narrow,
      expands: false,
    })),
    ...subsets.slice(0, -1).map((broad, index) => ({
      id: `effect-expand-${index.toString(16)}`,
      broad,
      narrow: [...broad, effectClasses.find((effect) => !broad.includes(effect))!],
      expands: true,
    })),
  ];
  const effectSnapshot = snapshot(effectCases.flatMap(({ id, broad, narrow }) => [
    record({}, { id, effects: { allowed: broad } }),
    record({ function: 'gtm' }, { id, effects: { allowed: narrow } }),
  ]));
  for (const { id, narrow, expands } of effectCases) {
    if (expands) {
      assertCode(() => resolveToolUse(effectSnapshot, { function: 'gtm' }, id), 'TOOL_USE_POLICY_RELAXATION');
    } else {
      assert.deepEqual(resolveToolUse(effectSnapshot, { function: 'gtm' }, id).effective.effects?.allowed, narrow);
    }
  }

  const approvalCases = [
    { id: 'approval-none-none', broad: 'none', narrow: 'none', allowed: true },
    { id: 'approval-none-human', broad: 'none', narrow: 'human', allowed: true },
    { id: 'approval-human-human', broad: 'human', narrow: 'human', allowed: true },
    { id: 'approval-human-none', broad: 'human', narrow: 'none', allowed: false },
  ] as const;
  const approvalSnapshot = snapshot(approvalCases.flatMap(({ id, broad, narrow }) => [
    record({}, { id, approval: { requirement: broad } }),
    record({ function: 'gtm' }, { id, approval: { requirement: narrow } }),
  ]));
  for (const value of approvalCases) {
    if (!value.allowed) {
      assertCode(
        () => resolveToolUse(approvalSnapshot, { function: 'gtm' }, value.id),
        'TOOL_USE_POLICY_RELAXATION',
      );
    } else {
      assert.equal(
        resolveToolUse(approvalSnapshot, { function: 'gtm' }, value.id).effective.approval.requirement,
        value.narrow,
      );
    }
  }
});

test('narrower definitions cannot add effects or lower human approval', () => {
  const effectRelaxation = snapshot([
    record({}, { effects: { allowed: ['external-read'] } }),
    record({ function: 'gtm' }, { effects: { allowed: ['external-read', 'external-write'] } }),
  ]);
  assertCode(
    () => resolveToolUse(effectRelaxation, { function: 'gtm' }, 'research-opportunities'),
    'TOOL_USE_POLICY_RELAXATION',
  );

  const approvalRelaxation = snapshot([
    record({}, { approval: { requirement: 'human' } }),
    record({ function: 'gtm' }, { approval: { requirement: 'none' } }),
  ]);
  assertCode(
    () => resolveToolUse(approvalRelaxation, { function: 'gtm' }, 'research-opportunities'),
    'TOOL_USE_POLICY_RELAXATION',
  );
});

test('Brain selectors require their explicit effect classes, including after narrowing', () => {
  const absentEffect = snapshot([record({}, { brain: { read: ['company-context'] } })]);
  assert.throws(
    () => resolveToolUse(absentEffect, {}, 'research-opportunities'),
    (error: unknown) => {
      assert.equal(isWorkspaceFailure(error), true);
      if (!isWorkspaceFailure(error)) return false;
      assert.equal(error.code, 'TOOL_USE_POLICY_RELAXATION');
      assert.match(error.header, /brain\.read.*brain-read/);
      assert.equal(error.details.ancestor_path, undefined);
      assert.equal(error.details.descendant_path, 'tools/research-opportunities.yaml');
      return true;
    },
  );

  const droppedWrite = snapshot([
    record({}, {
      brain: { write: ['discovered-opportunity'] },
      effects: { allowed: ['brain-write', 'external-read'] },
    }),
    record({ function: 'gtm' }, { effects: { allowed: ['external-read'] } }),
  ]);
  assertCode(
    () => resolveToolUse(droppedWrite, { function: 'gtm' }, 'research-opportunities'),
    'TOOL_USE_POLICY_RELAXATION',
  );

  const valid = resolveToolUse(snapshot([record({}, {
    brain: { read: ['company-context'], write: ['run-evidence'] },
    effects: { allowed: ['brain-read', 'brain-write'] },
  })]), {}, 'research-opportunities');
  assert.deepEqual(valid.effective.brain, { read: ['company-context'], write: ['run-evidence'] });
});

test('sibling scopes are isolated and may use different canonical skills', () => {
  const records = [
    record({ function: 'gtm', agent: 'social-manager' }, { skill_ref: 'exa:search' }),
    record(
      { function: 'gtm', agent: 'sales-researcher' },
      { skill_ref: 'apollo:prospect-search' },
      { path: 'sales-researcher-tool.yaml' },
    ),
  ];
  const social = resolveToolUse(snapshot(records), { function: 'gtm', agent: 'social-manager' }, 'research-opportunities');
  const sales = resolveToolUse(snapshot(records), { function: 'gtm', agent: 'sales-researcher' }, 'research-opportunities');
  assert.equal(social.effective.skill_ref, 'exa:search');
  assert.equal(sales.effective.skill_ref, 'apollo:prospect-search');
  assertCode(
    () => resolveToolUse(snapshot(records), { function: 'product', agent: 'social-manager' }, 'research-opportunities'),
    'REFERENCE_NOT_APPLICABLE',
  );
});

test('semantic hashes ignore input order, YAML whitespace, paths, and content hashes', () => {
  const broad = record({}, { when: ['public request'] }, { path: 'one.yaml' });
  const narrowContent = definition({ function: 'gtm' }, { purpose: 'Narrow purpose.', rules: ['cite sources'] });
  const narrowA = record({ function: 'gtm' }, {}, { path: 'two.yaml', content: narrowContent });
  const narrowB = record({ function: 'gtm' }, {}, {
    path: 'different.yaml',
    content: `schema_version: 2\nid: research-opportunities\nscope: { function: gtm }\npurpose: Narrow purpose.\nskill_ref: exa:search\nrules:\n  - cite sources\n`,
  });
  const first = resolveToolUse(snapshot([broad, narrowA]), { function: 'gtm' }, 'research-opportunities');
  const second = resolveToolUse(snapshot([narrowB, { ...broad, path: 'elsewhere.yaml' }]), { function: 'gtm' }, 'research-opportunities');
  assert.equal(first.semantic_hash, second.semantic_hash);
  assert.notDeepEqual(first.contributors, second.contributors);

  const orderedEffects = resolveToolUse(snapshot([record({}, {
    effects: { allowed: ['external-read', 'brain-read'] },
  })]), {}, 'research-opportunities');
  const reorderedEffects = resolveToolUse(snapshot([record({}, {
    effects: { allowed: ['brain-read', 'external-read'] },
  })]), {}, 'research-opportunities');
  assert.deepEqual(orderedEffects.effective, reorderedEffects.effective);
  assert.equal(orderedEffects.semantic_hash, reorderedEffects.semantic_hash);
});

test('semantic hashes change with the resolved context scope or effective policy', () => {
  const workspace = resolveToolUse(snapshot([record({}, {})]), {}, 'research-opportunities');
  const functionScoped = resolveToolUse(
    snapshot([record({ function: 'gtm' }, {})]),
    { function: 'gtm' },
    'research-opportunities',
  );
  const changedPolicy = resolveToolUse(
    snapshot([record({}, { rules: ['require attributable evidence'] })]),
    {},
    'research-opportunities',
  );
  assert.notEqual(workspace.semantic_hash, functionScoped.semantic_hash);
  assert.notEqual(workspace.semantic_hash, changedPolicy.semantic_hash);
});

test('complete snapshots are cloned, recursively frozen, and privately attested', () => {
  const source = [record({}, { effects: { allowed: [] } })];
  const complete = snapshot(source);
  source[0]!.scope.function = 'mutated-source';
  assert.deepEqual(complete.records[0]!.scope, {});
  assert.ok(Object.isFrozen(complete));
  assert.ok(Object.isFrozen(complete.records));
  assert.ok(Object.isFrozen(complete.records[0]));
  assert.ok(Object.isFrozen(complete.records[0]!.scope));
  assert.throws(() => {
    (complete.records as WorkspaceDiscoveryRecord[]).push(record({}, {}));
  }, TypeError);
  assert.throws(() => {
    complete.records[0]!.scope.function = 'mutation';
  }, TypeError);
  assert.throws(() => {
    complete.records[0]!.path = 'mutation.yaml';
  }, TypeError);
  assert.throws(() => {
    complete.records[0]!.references['tool_uses'] = 1;
  }, TypeError);
  assertCode(
    () => assertCompleteWorkspaceSnapshot({ ...complete, records: [...complete.records] }),
    'TOOL_USE_SNAPSHOT_INCOMPLETE',
  );
  const compact = [{ ...source[0], content: undefined }];
  assertCode(() => assertCompleteWorkspaceSnapshot({ records: compact }), 'TOOL_USE_SNAPSHOT_INCOMPLETE');
});

test('lattice validation reports deterministic policy failures without folding siblings together', () => {
  const result = validateToolUseLattice(snapshot([
    record({ function: 'gtm', agent: 'social-manager' }, { effects: { allowed: ['external-read'] } }),
    record({ function: 'gtm', agent: 'sales-researcher' }, { effects: { allowed: ['external-write'] } }),
  ]));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.resolutions.length, 2);
});
