import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import {
  resolveValidatedPlan,
  validateStructuredPlans,
} from '../src/lib/workspace-plan.ts';
import { collectCompleteWorkspaceSnapshot } from '../src/lib/workspace-registry.ts';
import { resolveToolUse } from '../src/lib/workspace-tool-use.ts';
import { buildVendorSkillMap } from '../src/lib/vendor-skills/adapter-map.ts';
import { parseSkillRef } from '../src/lib/vendor-skills/skill-ref.ts';

function writeYaml(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, YAML.stringify(value));
}

test('Social Manager resolves agent and plan Exa guidance identically for Claude and Codex without provider execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-social-exa-'));
  try {
    writeYaml(root, 'roster.yaml', {
      schema_version: 2,
      workspace_id: 'social-exa-golden',
      functions: { gtm: { path: 'functions/gtm' } },
      hosts: { claude: 'enabled', codex: 'enabled' },
      tool_uses: [],
    });
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
    writeYaml(root, 'functions/gtm/function.yaml', {
      schema_version: 2,
      id: 'gtm',
      purpose: 'Go-to-market policy.',
      agents: ['social-manager'],
      guidelines: [],
      tool_uses: [],
    });
    writeYaml(root, 'functions/gtm/agents/social-manager/agent.yaml', {
      schema_version: 2,
      id: 'social-manager',
      function: 'gtm',
      purpose: 'Find evidence-backed social opportunities.',
      plans: ['opportunity-discovery'],
      subagents: [],
      guidelines: [],
      default_guidelines: [],
      tool_uses: ['social-opportunity-research'],
      lessons: [],
    });
    writeYaml(root, 'functions/gtm/agents/social-manager/plans/opportunity-discovery.yaml', {
      schema_version: 2,
      id: 'opportunity-discovery',
      agent: 'gtm/social-manager',
      purpose: 'Produce an evidence-backed opportunity shortlist.',
      inputs: {},
      brain_selectors: {},
      guidelines: [],
      tool_uses: ['social-opportunity-research'],
      artifacts: {},
      caps: {},
      steps: [{
        id: 'search',
        kind: 'tool',
        instruction: 'Use the company-defined opportunity research guidance.',
        tool_use: 'social-opportunity-research',
      }],
      completion: {
        artifacts: [],
        output_guidance: 'Return cited opportunities with relevance reasons.',
        criteria: ['Every opportunity has attributable evidence.'],
      },
    });
    writeYaml(root, 'functions/gtm/agents/social-manager/tools/social-opportunity-research.yaml', {
      schema_version: 2,
      id: 'social-opportunity-research',
      scope: { function: 'gtm', agent: 'social-manager' },
      purpose: 'Find timely public posts matching company positioning.',
      skill_ref: 'exa:search',
      when: ['discovering public reply opportunities'],
      capabilities: ['web-search', 'content-retrieval'],
      filters: [
        'exclude previously presented canonical URLs',
        'exclude cryptocurrency topics',
      ],
      rules: [
        'require canonical URLs and attributable provenance',
        'never perform an external write',
      ],
      brain: { read: ['previously-presented-opportunities'] },
      effects: { allowed: ['external-read', 'brain-read', 'brain-write'] },
      approval: { requirement: 'none', guidance: [] },
      evidence: {
        required: ['source_url', 'retrieved_at', 'skill_revision'],
        guidance: ['preserve query and filter summaries without secret material'],
      },
    });
    writeYaml(
      root,
      'functions/gtm/agents/social-manager/plans/opportunity-discovery/tools/social-opportunity-research.yaml',
      {
        schema_version: 2,
        id: 'social-opportunity-research',
        scope: { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
        purpose: 'Rank timely LinkedIn and public-web opportunities for this request.',
        skill_ref: 'exa:search',
        when: ['running opportunity discovery for the social manager'],
        how: [
          'start with a 24-hour lookback and expand only as far as 72 hours',
          'rank candidates by ICP relevance',
        ],
        filters: ['reject profile and company-homepage URLs as candidate post URLs'],
        output_expectations: {
          required: ['canonical_url', 'author', 'published_at', 'relevance_reason'],
          guidance: ['return evidence rather than drafting a reply'],
        },
        brain: { write: ['discovered-opportunity', 'retrieval-provenance'] },
        effects: { allowed: ['external-read', 'brain-read', 'brain-write'] },
        approval: { requirement: 'none', guidance: [] },
      },
    );

    const snapshot = collectCompleteWorkspaceSnapshot(root);
    assert.deepEqual(validateStructuredPlans(snapshot.records, undefined, snapshot).diagnostics, []);
    assert.equal(
      resolveValidatedPlan(
        snapshot.records,
        'gtm/social-manager#opportunity-discovery',
        snapshot,
      ).completion.criteria[0],
      'Every opportunity has attributable evidence.',
    );
    const mutatedReferences = snapshot.records.map((record) => (
      record.kind === 'plan'
        ? { ...record, references: { ...record.references, tool_uses: 999 } }
        : record
    ));
    for (const substituted of [
      [...snapshot.records],
      snapshot.records.filter((record) => record.kind !== 'tool-use'),
      snapshot.records.map((record) => ({ ...record })),
      mutatedReferences,
    ]) {
      assert.equal(
        validateStructuredPlans(substituted, undefined, snapshot).diagnostics[0]?.code,
        'TOOL_USE_SNAPSHOT_INCOMPLETE',
      );
    }
    const resolution = resolveToolUse(
      snapshot,
      { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
      'social-opportunity-research',
    );
    assert.deepEqual(
      resolution.contributors.map((entry) => entry.qualified_id),
      [
        'gtm/social-manager/tools/social-opportunity-research',
        'gtm/social-manager#opportunity-discovery/tools/social-opportunity-research',
      ],
    );
    assert.equal(resolution.effective.skill_ref, 'exa:search');
    assert.equal(resolution.effective.purpose, 'Rank timely LinkedIn and public-web opportunities for this request.');
    assert.deepEqual(resolution.effective.filters, [
      'exclude previously presented canonical URLs',
      'exclude cryptocurrency topics',
      'reject profile and company-homepage URLs as candidate post URLs',
    ]);
    assert.deepEqual(resolution.effective.output_expectations.required, [
      'canonical_url',
      'author',
      'published_at',
      'relevance_reason',
    ]);
    assert.deepEqual(resolution.effective.brain, {
      read: ['previously-presented-opportunities'],
      write: ['discovered-opportunity', 'retrieval-provenance'],
    });
    assert.deepEqual(resolution.effective.effects?.allowed, [
      'external-read',
      'brain-read',
      'brain-write',
    ]);

    const map = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [parseSkillRef('exa:search')],
      enabledHosts: ['claude', 'codex'],
      manifest: null,
      lockfile: null,
      generatorVersion: '2.0.0',
    });
    const exa = map.skills[0]!;
    assert.deepEqual(exa.hosts.claude, {
      kind: 'host-native',
      identity: 'exa:search',
      assurance: 'host-resolved',
    });
    assert.deepEqual(exa.hosts.codex, exa.hosts.claude);
    assert.equal(Object.isFrozen(resolution), true);
    assert.equal(Object.isFrozen(resolution.effective), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
