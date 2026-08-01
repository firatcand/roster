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
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { parseChildDefinition } from '../src/lib/workspace-record.ts';
import {
  discoverWorkspace,
  scaffoldWorkspace,
  validateWorkspace,
} from '../src/lib/workspace-registry.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import { realWorkspaceDurabilityFs, replaceWorkspaceFile } from '../src/lib/workspace-io.ts';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-registry-'));
  writeFileSync(join(root, 'roster.yaml'), [
    '# workspace comment',
    'schema_version: 2',
    'workspace_id: registry-test # keep-workspace-id',
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
    const compact = discoverWorkspace(fx.root).records;
    assert.equal(compact.length, 8);
    assert.ok(compact.every((record) => record.content === undefined));
    assert.deepEqual(compact.map((record) => record.kind), [...compact.map((record) => record.kind)].sort());
    const tool = compact.find((record) => record.kind === 'tool-use')!;
    assert.equal(tool.path, 'functions/gtm/agents/social/tools/search.yaml');
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
