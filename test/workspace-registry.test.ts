import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { getPackageVersion } from '../src/lib/paths.ts';
import { parseChildDefinition } from '../src/lib/workspace-record.ts';
import {
  discoverWorkspace,
  prepareVendorSkillMap,
  scaffoldWorkspace,
  validateWorkspace,
} from '../src/lib/workspace-registry.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import { realWorkspaceDurabilityFs, replaceWorkspaceFile } from '../src/lib/workspace-io.ts';
import {
  buildVendorSkillMap,
  serializeVendorSkillMap,
  VENDOR_SKILL_MAP_PATH,
} from '../src/lib/vendor-skills/adapter-map.ts';
import { parseSkillRef } from '../src/lib/vendor-skills/skill-ref.ts';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-registry-'));
  writeFileSync(join(root, 'roster.yaml'), [
    '# workspace comment',
    'schema_version: 2',
    'workspace_id: registry-test # keep-workspace-id',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

function authorPlan(
  root: string,
  functionId: string,
  agentId: string,
  planId: string,
  steps: Array<Record<string, unknown>> = [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the work.' }],
): void {
  writeFileSync(join(root, 'functions', functionId, 'agents', agentId, 'plans', `${planId}.yaml`), YAML.stringify({
    schema_version: 2,
    id: planId,
    agent: `${functionId}/${agentId}`,
    purpose: `Run ${planId}.`,
    inputs: {},
    brain_selectors: {},
    guidelines: [],
    tool_uses: [],
    artifacts: {},
    caps: {},
    steps,
    completion: {
      artifacts: [],
      output_guidance: 'Return the result.',
      criteria: ['The work is complete.'],
    },
  }));
}

function authorToolUse(
  root: string,
  path: string,
  id: string,
  scope: Record<string, string>,
  skillRef = 'exa:search',
): void {
  writeFileSync(join(root, path), YAML.stringify({
    schema_version: 2,
    id,
    scope,
    purpose: `Use ${id} for this scope.`,
    skill_ref: skillRef,
    effects: { allowed: ['external-read'] },
  }));
}

test('vendor-map preparation changes with valid authored refs and rejects invalidated inputs', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'search',
      scope: 'workspace',
      purpose: 'Search public sources.',
    });
    authorToolUse(fx.root, 'tools/search.yaml', 'search', {}, 'exa:search');
    const first = prepareVendorSkillMap(fx.root).content;

    authorToolUse(fx.root, 'tools/search.yaml', 'search', {}, 'exa:deep-search');
    const second = prepareVendorSkillMap(fx.root).content;
    assert.notEqual(second, first);
    assert.match(second, /exa:deep-search/);

    authorToolUse(fx.root, 'tools/search.yaml', 'search', {}, 'not-canonical');
    assert.equal(failureCode(() => prepareVendorSkillMap(fx.root)), 'SKILL_REF_INVALID');
  } finally {
    fx.cleanup();
  }
});

test('scaffold creates only requested ancestors, preserves comments, and is idempotent', () => {
  const fx = fixture();
  try {
    const fn = scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm', purpose: 'Grow demand.' });
    assert.equal(fn.status, 'created');
    assert.equal(fn.record.path, 'functions/gtm/function.yaml');
    assert.match(readFileSync(join(fx.root, 'roster.yaml'), 'utf8'), /# workspace comment/);
    assert.match(readFileSync(join(fx.root, 'roster.yaml'), 'utf8'), /# keep-workspace-id/);
    assert.equal(scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' }).status, 'existing');
    assert.equal(readFileSync(join(fx.root, '.roster/.gitignore'), 'utf8'), 'state/\n');
    assert.equal(existsSync(join(fx.root, 'functions/gtm/agents')), false);
  } finally {
    fx.cleanup();
  }
});

test('inline YAML comments retain semantics and authored placement during scaffolding', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm', purpose: 'Grow demand.' });
    const fn = join(fx.root, 'functions/gtm/function.yaml');
    writeFileSync(fn, readFileSync(fn, 'utf8').replace('purpose: Grow demand.', 'purpose: Grow demand. # keep-function-purpose'));
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm', purpose: 'Reply well.' });
    const agent = join(fx.root, 'functions/gtm/agents/social/agent.yaml');
    writeFileSync(agent, readFileSync(agent, 'utf8').replace('purpose: Reply well.', 'purpose: "Reply # well" # keep-agent-purpose'));
    scaffoldWorkspace(fx.root, { kind: 'plan', id: 'discover', scope: 'agent:gtm/social' });

    const records = discoverWorkspace(fx.root).records;
    assert.equal(records.find((record) => record.qualified_id === 'gtm')?.purpose, 'Grow demand.');
    assert.equal(records.find((record) => record.qualified_id === 'gtm/social')?.purpose, 'Reply # well');
    assert.match(readFileSync(fn, 'utf8'), /# keep-function-purpose/);
    assert.match(readFileSync(agent, 'utf8'), /# keep-agent-purpose/);
  } finally {
    fx.cleanup();
  }
});

test('numeric-looking plain purpose values use YAML typing and fail string validation', () => {
  for (const purpose of ['1.5', 'True', 'FALSE', 'NULL']) {
    assert.equal(failureCode(() => parseChildDefinition('subagent', [
      'schema_version: 2',
      'id: researcher',
      'agent: gtm/social',
      `purpose: ${purpose}`,
      '',
    ].join('\n'), 'x.yaml')), 'YAML_INVALID', purpose);
  }
});

test('scaffold accepts ordinary anchor-like scalar text and ignores unrelated malformed records', () => {
  const fx = fixture();
  try {
    const first = scaffoldWorkspace(fx.root, {
      kind: 'function',
      id: 'first',
      purpose: 'Use &anchor syntax as ordinary prose.',
    });
    assert.equal(first.record.purpose, 'Use &anchor syntax as ordinary prose.');
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'broken' });
    writeFileSync(join(fx.root, 'functions/broken/function.yaml'), 'not: [valid\n');
    const independent = scaffoldWorkspace(fx.root, { kind: 'function', id: 'independent' });
    assert.equal(independent.status, 'created');
    assert.equal(independent.record.qualified_id, 'independent');
  } finally {
    fx.cleanup();
  }
});

test('membership updates append without reordering authored parent entries', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    const parent = join(fx.root, 'functions/gtm/function.yaml');
    writeFileSync(parent, readFileSync(parent, 'utf8').replace(
      'agents: []',
      'agents:\n  - zeta # keep-zeta\n  # before-alpha\n  - alpha',
    ));
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'middle', scope: 'function:gtm' });
    assert.match(
      readFileSync(parent, 'utf8'),
      /agents:\n  - zeta # keep-zeta\n  # before-alpha\n  - alpha\n  - middle/,
    );
  } finally {
    fx.cleanup();
  }
});

test('same-named agents remain qualified and bare exact discovery is ambiguous', () => {
  const fx = fixture();
  try {
    for (const functionId of ['gtm', 'support']) {
      scaffoldWorkspace(fx.root, { kind: 'function', id: functionId });
      scaffoldWorkspace(fx.root, { kind: 'agent', id: 'manager', scope: `function:${functionId}` });
    }
    assert.deepEqual(
      discoverWorkspace(fx.root, { kind: 'agent' }).records.map((record) => record.qualified_id),
      ['gtm/manager', 'support/manager'],
    );
    assert.equal(
      failureCode(() => discoverWorkspace(fx.root, { query: 'manager', kind: 'agent', exact: true })),
      'IDENTITY_AMBIGUOUS',
    );
    assert.equal(
      discoverWorkspace(fx.root, { query: 'gtm/manager', kind: 'agent', exact: true }).records[0]!.qualified_id,
      'gtm/manager',
    );
  } finally {
    fx.cleanup();
  }
});

test('all owned kinds scaffold at canonical paths and discovery stays compact unless full', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'guideline', id: 'voice', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, { kind: 'plan', id: 'discover', scope: 'agent:gtm/social' });
    scaffoldWorkspace(fx.root, { kind: 'subagent', id: 'researcher', scope: 'agent:gtm/social' });
    scaffoldWorkspace(fx.root, { kind: 'guideline', id: 'review', scope: 'agent:gtm/social' });
    scaffoldWorkspace(fx.root, { kind: 'tool-use', id: 'search', scope: 'plan:gtm/social#discover' });
    scaffoldWorkspace(fx.root, { kind: 'lesson', id: 'strong-hook', scope: 'plan:gtm/social#discover' });
    const existingPlan = scaffoldWorkspace(fx.root, {
      kind: 'plan',
      id: 'discover',
      scope: 'agent:gtm/social',
    });
    const exactPlan = discoverWorkspace(fx.root, {
      query: 'gtm/social#discover',
      kind: 'plan',
      exact: true,
    }).records[0]!;
    assert.equal(existingPlan.status, 'existing');
    assert.deepEqual(existingPlan.record, exactPlan);
    assert.deepEqual(exactPlan.references, { tool_uses: 1 });
    const compact = discoverWorkspace(fx.root).records;
    assert.equal(compact.length, 8);
    assert.ok(compact.every((record) => record.content === undefined));
    assert.deepEqual(compact.map((record) => record.kind), [...compact.map((record) => record.kind)].sort());
    const tool = compact.find((record) => record.kind === 'tool-use')!;
    assert.equal(tool.path, 'functions/gtm/agents/social/plans/discover/tools/search.yaml');
    assert.deepEqual(tool.scope, { function: 'gtm', agent: 'social', plan: 'discover' });
    const lesson = compact.find((record) => record.kind === 'lesson')!;
    assert.equal(lesson.path, 'functions/gtm/agents/social/playbook/strong-hook.md');
    assert.match(discoverWorkspace(fx.root, { query: lesson.qualified_id, exact: true, full: true }).records[0]!.content!, /kind: lesson/);
  } finally {
    fx.cleanup();
  }
});

test('differing orphan collision never mutates parent membership', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    const parent = join(fx.root, 'functions/gtm/function.yaml');
    const before = readFileSync(parent, 'utf8');
    mkdirSync(join(fx.root, 'functions/gtm/agents/orphan'), { recursive: true });
    writeFileSync(join(fx.root, 'functions/gtm/agents/orphan/agent.yaml'), 'unrelated\n');
    assert.equal(
      failureCode(() => scaffoldWorkspace(fx.root, { kind: 'agent', id: 'orphan', scope: 'function:gtm' })),
      'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(parent, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});

test('post-rename parent durability failure restores parent and rolls back invocation-owned child', () => {
  const fx = fixture();
  try {
    assert.equal(failureCode(() => scaffoldWorkspace(
      fx.root,
      { kind: 'function', id: 'gtm' },
      {
        replaceParent(targetRoot, relativePath, content, options) {
          replaceWorkspaceFile(targetRoot, relativePath, content, {
            ...options,
            durabilityFs: {
              ...realWorkspaceDurabilityFs,
              fsyncSync() {
                const error = new Error('sync failed') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
              },
            },
          });
        },
      },
    )), 'WRITE_CONFLICT');
    assert.equal(existsSync(join(fx.root, 'functions/gtm/function.yaml')), false);
    assert.doesNotMatch(readFileSync(join(fx.root, 'roster.yaml'), 'utf8'), /gtm:/);
    assert.ok(readFileSync(join(fx.root, 'roster.yaml'), 'utf8').includes('# workspace comment'));
    assert.equal(scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' }).status, 'created');
  } finally {
    fx.cleanup();
  }
});

test('validation reports undeclared slot entries and generated drift without adopting them', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    mkdirSync(join(fx.root, 'functions/gtm/agents/rogue'), { recursive: true });
    const validation = validateWorkspace(fx.root);
    assert.equal(validation.ok, false);
    assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === 'UNREGISTERED_RECORD'));
    assert.equal(discoverWorkspace(fx.root).records.some((record) => record.qualified_id.includes('rogue')), false);
    writeFileSync(join(fx.root, 'ROSTER.md'), 'edited\n');
    assert.ok(validateWorkspace(fx.root).diagnostics.some((diagnostic) => diagnostic.code === 'GENERATED_FILE_EDITED'));
  } finally {
    fx.cleanup();
  }
});

test('scaffolded plans remain discoverable drafts until semantic validation succeeds', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, { kind: 'plan', id: 'discover', scope: 'agent:gtm/social', purpose: 'Discover opportunities.' });
    const discovered = discoverWorkspace(fx.root, { query: 'gtm/social#discover', exact: true, full: true }).records[0]!;
    assert.match(discovered.content!, /brain_selectors: \{\}/);
    assert.match(discovered.content!, /output_guidance: ""/);
    const invalid = validateWorkspace(fx.root, { target: 'gtm/social#discover' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.checks.find((check) => check.name === 'structured-plans')?.status, 'fail');
    assert.ok(invalid.diagnostics.some((entry) => entry.code === 'PLAN_DRAFT_INCOMPLETE'));
    assert.equal(discoverWorkspace(fx.root, { query: discovered.path, exact: true, full: true }).records[0]!.content, discovered.content);

    authorPlan(fx.root, 'gtm', 'social', 'discover');
    const valid = validateWorkspace(fx.root, { target: 'gtm/social#discover' });
    assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
    assert.deepEqual(valid.checks.find((check) => check.name === 'structured-plans')?.details, { plans: 1, diagnostics: 0 });
  } finally {
    fx.cleanup();
  }
});

test('empty-purpose plan drafts remain discoverable but fail semantic readiness', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, { kind: 'plan', id: 'discover', scope: 'agent:gtm/social' });

    assert.equal(
      discoverWorkspace(fx.root, { query: 'gtm/social#discover', exact: true }).records[0]?.qualified_id,
      'gtm/social#discover',
    );
    const validation = validateWorkspace(fx.root, { target: 'gtm/social#discover' });
    assert.ok(validation.diagnostics.some((entry) => (
      entry.code === 'PLAN_SCHEMA_INVALID' && entry.details['field_path'] === 'purpose'
    )));
  } finally {
    fx.cleanup();
  }
});

test('targeted plan validation follows nested closure and ignores unrelated drafts', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'guideline', id: 'voice', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    for (const planId of ['primary', 'nested', 'draft']) {
      scaffoldWorkspace(fx.root, {
        kind: 'plan',
        id: planId,
        scope: 'agent:gtm/social',
        purpose: `Run ${planId}.`,
      });
    }
    authorPlan(fx.root, 'gtm', 'social', 'primary', [
      { id: 'nested', kind: 'nested-plan', instruction: 'Use the nested guide.', plan: 'gtm/social#nested' },
    ]);
    authorPlan(fx.root, 'gtm', 'social', 'nested');

    const targeted = validateWorkspace(fx.root, { target: 'gtm/social#primary' });
    assert.equal(targeted.ok, true, JSON.stringify(targeted.diagnostics));
    assert.deepEqual(targeted.checks.find((check) => check.name === 'structured-plans')?.details, { plans: 2, diagnostics: 0 });
    assert.equal(validateWorkspace(fx.root).diagnostics.some((entry) => entry.code === 'PLAN_DRAFT_INCOMPLETE'), true);
    assert.equal(validateWorkspace(fx.root, { target: 'gtm/social' }).diagnostics.some((entry) => entry.code === 'PLAN_DRAFT_INCOMPLETE'), true);
    assert.equal(validateWorkspace(fx.root, { target: 'gtm' }).diagnostics.some((entry) => entry.code === 'PLAN_DRAFT_INCOMPLETE'), true);
    assert.deepEqual(validateWorkspace(fx.root, { target: 'gtm/guidelines/voice' }).checks.find((check) => check.name === 'structured-plans')?.details, { plans: 0, diagnostics: 0 });
  } finally {
    fx.cleanup();
  }
});

test('targeted validation ignores only unrelated tool-use drafts', () => {
  const fx = fixture();
  try {
    for (const functionId of ['gtm', 'support']) {
      scaffoldWorkspace(fx.root, { kind: 'function', id: functionId });
      scaffoldWorkspace(fx.root, { kind: 'agent', id: 'manager', scope: `function:${functionId}` });
    }
    scaffoldWorkspace(fx.root, {
      kind: 'plan',
      id: 'discover',
      scope: 'agent:gtm/manager',
      purpose: 'Discover opportunities.',
    });
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'research',
      scope: 'agent:gtm/manager',
      purpose: 'Research public opportunities.',
    });
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'unfinished',
      scope: 'agent:support/manager',
    });
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'unused-draft',
      scope: 'agent:gtm/manager',
    });
    writeFileSync(
      join(fx.root, 'functions', 'gtm', 'agents', 'manager', 'tools', 'research.yaml'),
      YAML.stringify({
        schema_version: 2,
        id: 'research',
        scope: { function: 'gtm', agent: 'manager' },
        purpose: 'Research public opportunities.',
        skill_ref: 'exa:search',
        effects: { allowed: ['external-read'] },
      }),
    );
    writeFileSync(
      join(fx.root, 'functions', 'gtm', 'agents', 'manager', 'plans', 'discover.yaml'),
      YAML.stringify({
        schema_version: 2,
        id: 'discover',
        agent: 'gtm/manager',
        purpose: 'Discover opportunities.',
        inputs: {},
        brain_selectors: {},
        guidelines: [],
        tool_uses: [],
        artifacts: {},
        caps: {},
        steps: [{ id: 'research', kind: 'tool', instruction: 'Research opportunities.', tool_use: 'research' }],
        completion: {
          artifacts: [],
          output_guidance: 'Return the opportunities.',
          criteria: ['Every opportunity has a source.'],
        },
      }),
    );
    writeFileSync(
      join(fx.root, VENDOR_SKILL_MAP_PATH),
      serializeVendorSkillMap(buildVendorSkillMap({
        workspaceRoot: fx.root,
        skillRefs: [parseSkillRef('exa:search')],
        enabledHosts: [],
        manifest: null,
        lockfile: null,
        generatorVersion: getPackageVersion(),
      })),
    );

    const targeted = validateWorkspace(fx.root, { target: 'gtm/manager#discover' });
    assert.equal(
      targeted.diagnostics.some((entry) => entry.code === 'TOOL_USE_DRAFT_INCOMPLETE'),
      false,
      JSON.stringify(targeted.diagnostics),
    );
    assert.equal(targeted.checks.find((check) => check.name === 'tool-use-lattice')?.status, 'pass');
    assert.equal(targeted.checks.find((check) => check.name === 'structured-plans')?.status, 'pass');

    const global = validateWorkspace(fx.root);
    assert.equal(global.diagnostics.some((entry) => entry.code === 'TOOL_USE_DRAFT_INCOMPLETE'), true);
    const applicable = validateWorkspace(fx.root, { target: 'support/manager' });
    assert.equal(applicable.diagnostics.some((entry) => entry.code === 'TOOL_USE_DRAFT_INCOMPLETE'), true);
  } finally {
    fx.cleanup();
  }
});

test('targeted nested-plan relevance preserves plan and tool pairs instead of cross-producting them', () => {
  const fx = fixture();
  try {
    for (const functionId of ['gtm', 'support']) {
      scaffoldWorkspace(fx.root, { kind: 'function', id: functionId });
      scaffoldWorkspace(fx.root, { kind: 'agent', id: 'manager', scope: `function:${functionId}` });
    }
    scaffoldWorkspace(fx.root, {
      kind: 'plan',
      id: 'primary',
      scope: 'agent:gtm/manager',
      purpose: 'Run primary.',
    });
    scaffoldWorkspace(fx.root, {
      kind: 'plan',
      id: 'nested',
      scope: 'agent:support/manager',
      purpose: 'Run nested.',
    });
    const primaryFoo = scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'foo',
      scope: 'agent:gtm/manager',
      purpose: 'Use root foo.',
    });
    const nestedBar = scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'bar',
      scope: 'agent:support/manager',
      purpose: 'Use nested bar.',
    });
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'foo',
      scope: 'agent:support/manager',
    });
    authorToolUse(fx.root, primaryFoo.record.path, 'foo', { function: 'gtm', agent: 'manager' });
    authorToolUse(fx.root, nestedBar.record.path, 'bar', { function: 'support', agent: 'manager' });
    authorPlan(fx.root, 'gtm', 'manager', 'primary', [
      { id: 'foo', kind: 'tool', instruction: 'Use root foo.', tool_use: 'foo' },
      { id: 'nested', kind: 'nested-plan', instruction: 'Run support nested.', plan: 'support/manager#nested' },
    ]);
    authorPlan(fx.root, 'support', 'manager', 'nested', [
      { id: 'bar', kind: 'tool', instruction: 'Use nested bar.', tool_use: 'bar' },
    ]);

    const targeted = validateWorkspace(fx.root, {
      target: 'gtm/manager#primary',
      skipVendorSkillMap: true,
    });
    assert.equal(
      targeted.diagnostics.some((entry) => entry.code === 'TOOL_USE_DRAFT_INCOMPLETE'),
      false,
      JSON.stringify(targeted.diagnostics),
    );
    assert.equal(targeted.checks.find((check) => check.name === 'tool-use-lattice')?.status, 'pass');
    assert.equal(targeted.checks.find((check) => check.name === 'structured-plans')?.status, 'pass');
  } finally {
    fx.cleanup();
  }
});

test('targeted plan validation cannot ignore a same-ID ancestor draft', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'manager', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, {
      kind: 'plan',
      id: 'discover',
      scope: 'agent:gtm/manager',
      purpose: 'Discover opportunities.',
    });
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'research',
      scope: 'workspace',
    });
    const agentResearch = scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'research',
      scope: 'agent:gtm/manager',
      purpose: 'Research opportunities.',
    });
    authorToolUse(
      fx.root,
      agentResearch.record.path,
      'research',
      { function: 'gtm', agent: 'manager' },
    );
    authorPlan(fx.root, 'gtm', 'manager', 'discover', [
      { id: 'research', kind: 'tool', instruction: 'Research.', tool_use: 'research' },
    ]);

    const targeted = validateWorkspace(fx.root, {
      target: 'gtm/manager#discover',
      skipVendorSkillMap: true,
    });
    assert.equal(targeted.diagnostics.some((entry) => (
      entry.code === 'TOOL_USE_DRAFT_INCOMPLETE' && entry.path === 'tools/research.yaml'
    )), true, JSON.stringify(targeted.diagnostics));
    assert.equal(targeted.checks.find((check) => check.name === 'tool-use-lattice')?.status, 'fail');
  } finally {
    fx.cleanup();
  }
});

test('secret-bearing tool-use discovery exposes neither authored bytes nor a content digest', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, {
      kind: 'tool-use',
      id: 'research',
      scope: 'workspace',
      purpose: 'Research public opportunities.',
    });
    const canary = `sk-${'Ab9_'.repeat(7)}`;
    const variants = [
      `# accidental credential: ${canary}\nschema_version: 2\nid: research\nscope: {}\npurpose: Research public opportunities.\nskill_ref: exa:search\n`,
      `schema_version: 2\nid: research\nscope: {}\npurpose: "\\u0073k-${'Ab9_'.repeat(7)}"\nskill_ref: exa:search\n`,
    ];
    for (const authored of variants) {
      writeFileSync(join(fx.root, 'tools', 'research.yaml'), authored);
      for (const full of [false, true]) {
        for (const exact of [false, true]) {
          const result = discoverWorkspace(fx.root, {
            full,
            ...(exact ? { query: 'tools/research', kind: 'tool-use' as const, exact: true } : {}),
          });
          assert.equal(result.ok, false);
          assert.deepEqual(result.records, []);
          assert.equal(result.diagnostics.length, 1);
          assert.equal(result.diagnostics[0]?.code, 'SECRET_MATERIAL_FORBIDDEN');
          const serialized = JSON.stringify(result);
          assert.equal(serialized.includes(canary), false);
          assert.equal(serialized.includes('content_hash'), false);
          assert.equal(serialized.includes('sha256:'), false);
        }
      }
    }
  } finally {
    fx.cleanup();
  }
});

test('targeted validation preserves exact not-found and ambiguity diagnostics', () => {
  const fx = fixture();
  try {
    for (const functionId of ['gtm', 'support']) {
      scaffoldWorkspace(fx.root, { kind: 'function', id: functionId });
      scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: `function:${functionId}` });
      scaffoldWorkspace(fx.root, { kind: 'plan', id: 'discover', scope: `agent:${functionId}/social` });
      authorPlan(fx.root, functionId, 'social', 'discover');
    }
    const missing = validateWorkspace(fx.root, { target: 'missing' });
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostics[0]?.code, 'PARENT_NOT_FOUND');
    assert.deepEqual(missing.checks.find((check) => check.name === 'structured-plans')?.details, { blocked_by: 'declared-registry', diagnostics: 0 });
    const ambiguous = validateWorkspace(fx.root, { target: 'discover' });
    assert.equal(ambiguous.ok, false);
    assert.ok(ambiguous.diagnostics.some((entry) => entry.code === 'IDENTITY_AMBIGUOUS'));
  } finally {
    fx.cleanup();
  }
});

test('semantic plan failures aggregate one schema failure per plan and every valid reference failure', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    for (const planId of ['bad-one', 'bad-two', 'references']) {
      scaffoldWorkspace(fx.root, { kind: 'plan', id: planId, scope: 'agent:gtm/social' });
    }
    const badOne = join(fx.root, 'functions/gtm/agents/social/plans/bad-one.yaml');
    writeFileSync(badOne, readFileSync(badOne, 'utf8').replace('steps: []', 'steps: wrong'));
    const badTwo = join(fx.root, 'functions/gtm/agents/social/plans/bad-two.yaml');
    writeFileSync(badTwo, readFileSync(badTwo, 'utf8').replace('brain_selectors: {}', 'brain_selectors: []'));
    authorPlan(fx.root, 'gtm', 'social', 'references', [
      { id: 'first', kind: 'subagent', instruction: 'Delegate.', subagent: 'missing-one' },
      { id: 'second', kind: 'subagent', instruction: 'Delegate.', subagent: 'missing-two' },
    ]);
    const validation = validateWorkspace(fx.root);
    assert.equal(validation.diagnostics.filter((entry) => entry.code === 'PLAN_SCHEMA_INVALID').length, 2);
    assert.equal(validation.diagnostics.filter((entry) => entry.code === 'REFERENCE_NOT_FOUND').length, 2);
  } finally {
    fx.cleanup();
  }
});

test('record collection failure does not turn registered roots into false orphans', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    scaffoldWorkspace(fx.root, { kind: 'plan', id: 'broken', scope: 'agent:gtm/social' });
    writeFileSync(join(fx.root, 'functions/gtm/agents/social/plans/broken.yaml'), 'not: [valid\n');

    const validation = validateWorkspace(fx.root);
    assert.ok(validation.diagnostics.some((entry) => entry.code === 'YAML_INVALID'));
    assert.equal(
      validation.diagnostics.some((entry) => entry.code === 'UNREGISTERED_RECORD' && entry.path === 'functions/gtm'),
      false,
    );
    assert.deepEqual(
      validation.checks.find((check) => check.name === 'registered-slots')?.details,
      { diagnostics: 0 },
    );
  } finally {
    fx.cleanup();
  }
});

test('orphan validation preserves nonstandard roots when record collection fails', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.root, 'roster.yaml'), [
      'schema_version: 2',
      'workspace_id: registry-test',
      'tool_uses: []',
      'functions:',
      '  gtm:',
      '    path: teams/gtm',
      'hosts: {}',
      '',
    ].join('\n'));
    mkdirSync(join(fx.root, 'teams/gtm/agents/social/plans'), { recursive: true });
    mkdirSync(join(fx.root, 'teams/gtm/agents/rogue'), { recursive: true });
    writeFileSync(join(fx.root, 'teams/gtm/function.yaml'), YAML.stringify({
      schema_version: 2,
      id: 'gtm',
      purpose: 'Grow demand.',
      agents: ['social'],
      guidelines: [],
      tool_uses: [],
    }));
    writeFileSync(join(fx.root, 'teams/gtm/agents/social/agent.yaml'), YAML.stringify({
      schema_version: 2,
      id: 'social',
      function: 'gtm',
      purpose: 'Manage social.',
      plans: ['broken'],
      subagents: [],
      guidelines: [],
      tool_uses: [],
      lessons: [],
      default_guidelines: [],
    }));
    writeFileSync(join(fx.root, 'teams/gtm/agents/social/plans/broken.yaml'), 'not: [valid\n');

    const validation = validateWorkspace(fx.root);
    assert.ok(validation.diagnostics.some((entry) => entry.code === 'YAML_INVALID'));
    assert.ok(validation.diagnostics.some((entry) => (
      entry.code === 'UNREGISTERED_RECORD' && entry.path === 'teams/gtm/agents/rogue'
    )));
  } finally {
    fx.cleanup();
  }
});

test('validation reports unregistered function roots but accepts registered nested root prefixes', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'functions/rogue'), { recursive: true });
    writeFileSync(join(fx.root, 'functions/rogue/function.yaml'), 'unregistered\n');
    assert.ok(validateWorkspace(fx.root).diagnostics.some((diagnostic) => diagnostic.path === 'functions/rogue'));

    rmSync(join(fx.root, 'functions'), { recursive: true, force: true });
    writeFileSync(join(fx.root, 'roster.yaml'), [
      'schema_version: 2',
      'workspace_id: registry-test',
      'functions:',
      '  gtm:',
      '    path: functions/team/gtm',
      'hosts: {}',
      '',
    ].join('\n'));
    mkdirSync(join(fx.root, 'functions/team/gtm'), { recursive: true });
    writeFileSync(join(fx.root, 'functions/team/gtm/function.yaml'), [
      'schema_version: 2',
      'id: gtm',
      'purpose: Nested root.',
      'agents: []',
      'guidelines: []',
      '',
    ].join('\n'));
    assert.equal(validateWorkspace(fx.root).diagnostics.some((diagnostic) => diagnostic.path === 'functions/team'), false);
  } finally {
    fx.cleanup();
  }
});

test('default guideline references must resolve exactly one owning scope', () => {
  const missing = fixture();
  try {
    scaffoldWorkspace(missing.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(missing.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    const agent = join(missing.root, 'functions/gtm/agents/social/agent.yaml');
    writeFileSync(agent, readFileSync(agent, 'utf8').replace('default_guidelines: []', 'default_guidelines:\n  - missing'));
    assert.equal(failureCode(() => discoverWorkspace(missing.root)), 'PARENT_NOT_FOUND');
  } finally {
    missing.cleanup();
  }

  const ambiguous = fixture();
  try {
    scaffoldWorkspace(ambiguous.root, { kind: 'function', id: 'gtm' });
    scaffoldWorkspace(ambiguous.root, { kind: 'guideline', id: 'voice', scope: 'function:gtm' });
    scaffoldWorkspace(ambiguous.root, { kind: 'agent', id: 'social', scope: 'function:gtm' });
    scaffoldWorkspace(ambiguous.root, { kind: 'guideline', id: 'voice', scope: 'agent:gtm/social' });
    const agent = join(ambiguous.root, 'functions/gtm/agents/social/agent.yaml');
    writeFileSync(agent, readFileSync(agent, 'utf8').replace('default_guidelines: []', 'default_guidelines:\n  - voice'));
    assert.equal(failureCode(() => discoverWorkspace(ambiguous.root)), 'IDENTITY_AMBIGUOUS');
  } finally {
    ambiguous.cleanup();
  }
});

test('YAML aliases are disabled even though anchor-like scalar prose remains valid', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    writeFileSync(join(fx.root, 'functions/gtm/function.yaml'), [
      'schema_version: 2',
      'id: gtm',
      'purpose: &shared Shared',
      'agents: []',
      'guidelines: [*shared]',
      '',
    ].join('\n'));
    assert.equal(failureCode(() => discoverWorkspace(fx.root)), 'YAML_INVALID');
  } finally {
    fx.cleanup();
  }
});

test('validation promotes authored failure paths into stable diagnostic paths', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    const path = 'functions/gtm/function.yaml';
    writeFileSync(join(fx.root, path), 'not: [valid\n');
    const diagnostic = validateWorkspace(fx.root).diagnostics.find((entry) => entry.code === 'YAML_INVALID');
    assert.equal(diagnostic?.path, path);
  } finally {
    fx.cleanup();
  }
});

test('component-wise symlink safety rejects even in-workspace diversion', () => {
  const fx = fixture();
  try {
    scaffoldWorkspace(fx.root, { kind: 'function', id: 'gtm' });
    mkdirSync(join(fx.root, 'elsewhere'));
    rmSync(join(fx.root, 'functions/gtm/agents'), { recursive: true, force: true });
    symlinkSync(join(fx.root, 'elsewhere'), join(fx.root, 'functions/gtm/agents'));
    assert.equal(
      failureCode(() => scaffoldWorkspace(fx.root, { kind: 'agent', id: 'social', scope: 'function:gtm' })),
      'SYMLINK_COMPONENT',
    );
  } finally {
    fx.cleanup();
  }
});
