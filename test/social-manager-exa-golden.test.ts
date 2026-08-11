import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
} from '../src/lib/context-args.ts';
import { resolveWorkspaceContext } from '../src/lib/workspace-context.ts';
import {
  collectCompleteWorkspaceSnapshot,
} from '../src/lib/workspace-registry.ts';
import {
  resolveValidatedPlanClosure,
  validateStructuredPlans,
} from '../src/lib/workspace-plan.ts';
import { resolveToolUse } from '../src/lib/workspace-tool-use.ts';
import { buildSocialManagerContextFixture } from './fixtures/social-manager-context/_setup.ts';

test('Social Manager Exa discovery resolves one host-neutral context bundle for Claude and Codex', () => {
  const fx = buildSocialManagerContextFixture();
  try {
    const snapshot = collectCompleteWorkspaceSnapshot(fx.root);
    assert.deepEqual(validateStructuredPlans(snapshot.records, undefined, snapshot).diagnostics, []);
    const closure = resolveValidatedPlanClosure(
      snapshot,
      'gtm/social-manager#opportunity-discovery',
    );
    assert.deepEqual(
      closure.definitions.map((plan) => plan.qualified_id),
      [
        'gtm/social-manager#opportunity-discovery',
        'gtm/social-manager#scan-linkedin',
        'gtm/social-manager#scan-web',
        'gtm/social-manager#score-opportunities',
      ],
    );

    const tool = resolveToolUse(
      snapshot,
      { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
      'social-search',
    );
    assert.equal(tool.effective.skill_ref, 'exa:search');
    assert.deepEqual(tool.effective.filters, [
      'require a canonical public URL',
      'exclude cryptocurrency topics',
      'reject profile and company-homepage URLs',
      'exclude URLs presented in prior discovery runs',
    ]);
    assert.deepEqual(tool.effective.brain, {
      read: ['historical-opportunities'],
      write: ['discovered-opportunity', 'retrieval-provenance'],
    });
    assert.deepEqual(tool.effective.output_expectations.required, [
      'canonical_url',
      'author',
      'published_at',
      'relevance_reason',
    ]);

    const request = {
      root: fx.root,
      target: 'gtm/social-manager#opportunity-discovery',
      query: 'Find timely conversations where our experience with reliable AI operations is relevant.',
      stepHint: 'The host is preparing the discovery shortlist.',
      budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
      explain: true,
      includeLegacyUnverified: false,
    } as const;
    const claudeBundle = resolveWorkspaceContext(request);
    const codexBundle = resolveWorkspaceContext(request);
    assert.deepEqual(claudeBundle, codexBundle);
    assert.deepEqual(
      claudeBundle.plan.definitions.map((fragment) => fragment.content.qualified_id),
      closure.definitions.map((plan) => plan.qualified_id),
    );
    assert.deepEqual(claudeBundle.skill_refs.map((entry) => entry.content.skill_ref), ['exa:search']);
    assert.equal(claudeBundle.skill_refs[0]!.content.hosts.claude?.kind, 'host-native');
    assert.deepEqual(
      claudeBundle.skill_refs[0]!.content.hosts.codex,
      claudeBundle.skill_refs[0]!.content.hosts.claude,
    );
    assert.deepEqual(claudeBundle.brain_evidence, []);
    assert.equal(
      claudeBundle.diagnostics.some((entry) => entry.code === 'CONTEXT_REQUIRED_EVIDENCE_MISSING'),
      true,
    );
    assert.equal(claudeBundle.budget.mandatory_tokens <= DEFAULT_CONTEXT_BUDGET_TOKENS / 2, true);
    assert.equal(claudeBundle.budget.total_tokens <= DEFAULT_CONTEXT_BUDGET_TOKENS, true);
    assert.equal(JSON.stringify(claudeBundle).includes('bright-data:scrape'), false);
    assert.equal(JSON.stringify(claudeBundle).includes('provider_route'), false);
    assert.equal(JSON.stringify(claudeBundle).includes('current_step'), false);
    assert.equal(JSON.stringify(claudeBundle).includes('next_action'), false);
  } finally {
    fx.cleanup();
  }
});
