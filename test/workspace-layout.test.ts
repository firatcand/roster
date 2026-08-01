import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROSTER_RESERVED_PATHS,
  assertFunctionRootPath,
  assertNonOverlappingFunctionRoots,
  assertRecordId,
  childRecordPath,
  parseScope,
  qualifiedRecordId,
} from '../src/lib/workspace-layout.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import {
  CLAUDE_PROJECT_INSTRUCTIONS_PATH,
  CLAUDE_PROJECT_RULE_PATH,
  CODEX_PROJECT_INSTRUCTIONS_PATH,
  CODEX_ROSTER_SKILL_PATH,
  GENERATED_MANIFEST_PATH,
} from '../src/lib/generated-artifacts.ts';
import { LEGACY_PROJECT_CONTEXT_OWNED_PATHS } from '../src/lib/project-context.ts';

function codeFrom(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    return isWorkspaceFailure(error) ? error.code : undefined;
  }
}

test('record IDs and qualified scopes reject traversal, separators, controls, and platform names', () => {
  for (const invalid of ['', '.', '..', 'Bad-Case', 'two_words', 'a/b', 'a\\b', 'con', 'name\u0000']) {
    assert.equal(codeFrom(() => assertRecordId(invalid)), 'IDENTITY_INVALID', invalid);
  }
  assert.equal(assertRecordId('social-manager'), 'social-manager');
  assert.deepEqual(parseScope('function:gtm').scope, { function: 'gtm' });
  assert.deepEqual(parseScope('agent:gtm/social-manager').scope, { function: 'gtm', agent: 'social-manager' });
  assert.deepEqual(parseScope('plan:gtm/social-manager#discover').scope, {
    function: 'gtm',
    agent: 'social-manager',
    plan: 'discover',
  });
});

test('all seven qualified identity forms map to deterministic paths', () => {
  const root = 'functions/gtm';
  assert.equal(qualifiedRecordId('function', { functionId: 'gtm' }), 'gtm');
  assert.equal(qualifiedRecordId('agent', { functionId: 'gtm', agentId: 'social' }), 'gtm/social');
  assert.equal(qualifiedRecordId('plan', { functionId: 'gtm', agentId: 'social', localId: 'discover' }), 'gtm/social#discover');
  assert.equal(qualifiedRecordId('subagent', { functionId: 'gtm', agentId: 'social', localId: 'researcher' }), 'gtm/social/subagents/researcher');
  assert.equal(qualifiedRecordId('guideline', { functionId: 'gtm', localId: 'voice' }), 'gtm/guidelines/voice');
  assert.equal(qualifiedRecordId('tool-use', { functionId: 'gtm', agentId: 'social', localId: 'search' }), 'gtm/social/tools/search');
  assert.equal(qualifiedRecordId('lesson', { functionId: 'gtm', agentId: 'social', localId: 'hook' }), 'gtm/social/playbook/hook');
  assert.equal(childRecordPath(root, '', 'guideline', 'voice', { function: 'gtm' }), 'functions/gtm/guidelines/voice.md');
  assert.equal(childRecordPath(root, 'social', 'plan', 'discover'), 'functions/gtm/agents/social/plans/discover.yaml');
});

test('function roots reject every renderer-owned root and overlaps', () => {
  const rendererOwnedPaths = [
    'ROSTER.md',
    GENERATED_MANIFEST_PATH,
    CLAUDE_PROJECT_INSTRUCTIONS_PATH,
    CLAUDE_PROJECT_RULE_PATH,
    CODEX_PROJECT_INSTRUCTIONS_PATH,
    CODEX_ROSTER_SKILL_PATH,
    ...LEGACY_PROJECT_CONTEXT_OWNED_PATHS,
  ];
  for (const owned of rendererOwnedPaths) {
    assert.ok(
      ROSTER_RESERVED_PATHS.some((reserved) => owned === reserved || owned.startsWith(`${reserved}/`)),
      `${owned} is covered by the central reserved-path registry`,
    );
  }
  for (const reserved of ['.claude/functions', '.agents', 'config/team', 'roster/gtm']) {
    assert.equal(codeFrom(() => assertFunctionRootPath(reserved)), 'RESERVED_PATH', reserved);
  }
  for (const aliased of ['functions//gtm', 'functions/./gtm', 'functions/x/../gtm']) {
    assert.equal(codeFrom(() => assertFunctionRootPath(aliased)), 'PATH_ESCAPE', aliased);
  }
  assert.equal(assertFunctionRootPath('functions/gtm'), 'functions/gtm');
  assert.equal(
    codeFrom(() => assertNonOverlappingFunctionRoots(['functions/gtm', 'functions/gtm/social'])),
    'PATH_OVERLAP',
  );
});
