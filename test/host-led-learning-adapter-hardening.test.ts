import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CONTEXT_ESTIMATOR } from '../src/lib/workspace-context.ts';
import { hostLedLearningAdapterTestApi } from './support/host-led-learning-adapter.ts';
import {
  SeededLearningStoreError,
  renderSeededCandidateMeaning,
  type SeededCandidateMeaning,
} from './support/seeded-learning-store.ts';

const contract = {
  schema_version: 2,
  fixture_id: 'host-led-learning',
  runtime: {
    state_path: '.fixture/learning-state.json',
    adapter_log_path: '.fixture/adapter-calls.jsonl',
    adapter_directory: '.fixture/bin',
  },
  roster: {
    target: 'gtm/social-manager#opportunity-discovery',
    allowed_model_invocations: [],
  },
  adapters: [],
} as const;

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'roster-350-adapter-test-'));
  mkdirSync(join(root, '.fixture'), { recursive: true });
  return root;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function contextScope(level: 'workspace' | 'function' | 'agent' | 'plan'): Record<string, string | null> {
  return {
    workspace: 'company',
    function: level === 'workspace' ? null : 'gtm',
    agent: level === 'workspace' || level === 'function' ? null : 'social-manager',
    plan: level === 'plan' ? 'opportunity-discovery' : null,
  };
}

function contextFragment(options: {
  id: string;
  kind: string;
  scope: 'workspace' | 'function' | 'agent' | 'plan';
  trust: string;
  inclusionReason: string;
  required: boolean;
  content: unknown;
}): Record<string, unknown> {
  const serialized = JSON.stringify(options.content);
  const contentBytes = Buffer.byteLength(serialized, 'utf8');
  return {
    fragment_id: options.id,
    kind: options.kind,
    scope: contextScope(options.scope),
    source_content_hash: sha256(`source:${options.id}`),
    fragment_hash: sha256(serialized),
    trust: options.trust,
    inclusion_reason: options.inclusionReason,
    required: options.required,
    content_bytes: contentBytes,
    content_tokens: Math.ceil(contentBytes / 4),
    content: options.content,
  };
}

function refreshFragmentIntegrity(fragment: Record<string, unknown>): void {
  const serialized = JSON.stringify(fragment['content']);
  const contentBytes = Buffer.byteLength(serialized, 'utf8');
  fragment['fragment_hash'] = sha256(serialized);
  fragment['content_bytes'] = contentBytes;
  fragment['content_tokens'] = Math.ceil(contentBytes / 4);
}

function sourceHashDigest(value: string): string {
  return Buffer.from(value.slice('sha256:'.length), 'hex').toString('base64url');
}

function toolContent(): Record<string, unknown> {
  const effective = {
    schema_version: 2,
    id: 'social-search',
    scope: { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
    purpose: 'Find attributable discussions worth answering.',
    skill_ref: 'exa:search',
    when: ['During opportunity discovery.'],
    capabilities: ['Search public discussions.'],
    filters: ['Keep attributable practitioner posts.'],
    rules: ['Reject previously used URLs.'],
    how: ['Derive a short query from the request.'],
    output_expectations: { required: ['url'], guidance: ['Explain every rejection.'] },
    brain: { read: ['historical-opportunities'], write: [] },
    approval: { requirement: 'none', guidance: [] },
    evidence: { required: ['selected-url'], guidance: ['Record policy reasons.'] },
    effects: { allowed: ['external-read'] },
  };
  return {
    effective,
    contributors: [{
      qualified_id: 'gtm/social-manager#opportunity-discovery/tools/social-search',
      path: 'functions/gtm/agents/social-manager/plans/opportunity-discovery/tools/social-search.yaml',
      scope: { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
      content_hash: sha256('tool-contributor'),
    }],
    field_sources: {
      filters: [{
        qualified_id: 'gtm/social-manager#opportunity-discovery/tools/social-search',
        path: 'functions/gtm/agents/social-manager/plans/opportunity-discovery/tools/social-search.yaml',
        entry: 'Keep attributable practitioner posts.',
      }],
    },
    semantic_hash: canonicalSha256(effective),
    references: [{ plan_id: 'gtm/social-manager#opportunity-discovery', step_id: 'search' }],
  };
}

function rawContextFixture(): Record<string, unknown> {
  const functionFragment = contextFragment({
    id: 'function:gtm',
    kind: 'function',
    scope: 'function',
    trust: 'authored-policy',
    inclusionReason: 'target-function',
    required: true,
    content: { schema_version: 2, id: 'gtm', purpose: 'Go to market.', agents: ['social-manager'], guidelines: [], tool_uses: [] },
  });
  const agentFragment = contextFragment({
    id: 'agent:gtm/social-manager',
    kind: 'agent',
    scope: 'agent',
    trust: 'authored-policy',
    inclusionReason: 'target-agent',
    required: true,
    content: {
      schema_version: 2,
      id: 'social-manager',
      function: 'gtm',
      purpose: 'Find discussions.',
      plans: ['opportunity-discovery'],
      subagents: [],
      guidelines: ['discovery-policy'],
      default_guidelines: [],
      tool_uses: ['social-search'],
      lessons: ['prior'],
    },
  });
  const planFragment = contextFragment({
    id: 'plan:gtm/social-manager#opportunity-discovery',
    kind: 'plan',
    scope: 'plan',
    trust: 'authored-policy',
    inclusionReason: 'selected-plan-root',
    required: true,
    content: {
      schema_version: 2,
      id: 'opportunity-discovery',
      qualified_id: 'gtm/social-manager#opportunity-discovery',
      agent: 'gtm/social-manager',
      purpose: 'Find attributable discussions.',
      inputs: { request: { description: 'The human discovery request.', required: true } },
      brain_selectors: { positioning: { description: 'Current company positioning.', required: false } },
      guidelines: ['gtm/social-manager/guidelines/discovery-policy'],
      tool_uses: ['social-search'],
      artifacts: { shortlist: { description: 'Cited opportunities.' } },
      caps: { candidates: { maximum: 10, guidance: 'Keep only relevant discussions.' } },
      steps: [{
        id: 'search',
        kind: 'tool',
        instruction: 'Search using the authored tool policy.',
        tool_use: 'social-search',
      }],
      completion: {
        artifacts: ['shortlist'],
        output_guidance: 'Return a cited shortlist.',
        criteria: ['Every result has an attributable source.'],
      },
    },
  });
  const guidelineFragment = contextFragment({
    id: 'guideline:gtm/social-manager/guidelines/discovery-policy',
    kind: 'guideline',
    scope: 'agent',
    trust: 'authored-policy',
    inclusionReason: 'agent-default-guideline',
    required: true,
    content: { id: 'discovery-policy', kind: 'guideline', purpose: 'Apply opportunity policy.', scope: { function: 'gtm', agent: 'social-manager' }, body: 'Prefer attributable practitioner posts.' },
  });
  const lessonFragment = contextFragment({
    id: 'lesson:gtm/social-manager/playbook/prior',
    kind: 'lesson',
    scope: 'agent',
    trust: 'approved-lesson',
    inclusionReason: 'applicable-lesson',
    required: false,
    content: { id: 'prior', kind: 'lesson', purpose: 'Remember a validated pattern.', scope: { function: 'gtm', agent: 'social-manager' }, body: 'Prefer posts with an attributable author.' },
  });
  const brainFragment = {
    ...contextFragment({
      id: 'brain-evidence:positioning',
      kind: 'brain-evidence',
      scope: 'plan',
      trust: 'brain-extract-untrusted',
      inclusionReason: 'required-selector-match',
      required: false,
      content: 'Company positioning emphasizes operator control.',
    }),
    privacy: 'internal',
    candidate_scope: contextScope('plan'),
    retrieval_reason: 'required-selector-match',
    retrieval_modes: ['lexical'],
    citation: {
      logical_source_id: 'company-positioning',
      source_version_id: 'version-1',
      object_id: 'object-1',
      extractor_id: 'plain-text',
      extractor_version: '1',
      locator: 'fixture://positioning',
      content_hash: sha256('Company positioning emphasizes operator control.'),
    },
  };
  const toolFragment = contextFragment({
    id: 'tool-use:social-search',
    kind: 'tool-use',
    scope: 'plan',
    trust: 'authored-policy',
    inclusionReason: 'plan-tool-step',
    required: true,
    content: toolContent(),
  });
  const skillFragment = contextFragment({
    id: 'skill-ref:exa:search',
    kind: 'skill-ref',
    scope: 'workspace',
    trust: 'vendor-instruction',
    inclusionReason: 'tool-skill-ref',
    required: true,
    content: {
      skill_ref: 'exa:search',
      generator_version: '1',
      map_hash: sha256('map'),
      authored_paths: ['tools/social-search.yaml'],
      hosts: { claude: { kind: 'host-native', identity: 'exa:search', assurance: 'host-resolved' } },
    },
  });
  const fragments: readonly Record<string, unknown>[] = [
    functionFragment,
    agentFragment,
    planFragment,
    guidelineFragment,
    toolFragment,
    skillFragment,
    lessonFragment,
    brainFragment,
  ];
  const provenance = fragments.map((fragment) => ({
    fragment_id: fragment['fragment_id'],
    source_id: `source:${fragment['fragment_id']}`,
    trust: fragment['trust'],
    inclusion_reason: fragment['inclusion_reason'],
    required: fragment['required'],
    source_content_hash: fragment['source_content_hash'],
    fragment_hash: fragment['fragment_hash'],
  }));
  const exclusions = Object.fromEntries([
    'budget-exhausted', 'workspace-mismatch', 'scope-ineligible', 'duplicate', 'invalid-rank', 'low-trust',
    'malformed', 'privacy-incompatible', 'secret-material', 'stale', 'tombstoned', 'unauthorized',
    'uncited', 'unrequested-selector',
  ].map((reason) => [reason, reason === 'low-trust' ? 1 : 0]));
  return {
    schema_version: 2,
    workspace: { schema_version: 2, workspace_id: 'company', source_hash: sha256('workspace'), brain_configured: true },
    target: { function_id: 'gtm', agent_id: 'social-manager', plan_id: 'opportunity-discovery' },
    request: {
      query: 'reliable ai practitioners',
      step_hint: null,
      budget_tokens: 12_000,
      explain: false,
      include_legacy_unverified: false,
    },
    agent: { function: functionFragment, agent: agentFragment },
    plan: { root_id: 'gtm/social-manager#opportunity-discovery', definitions: [planFragment] },
    guidelines: [guidelineFragment],
    lessons: [lessonFragment],
    brain_evidence: [brainFragment],
    tool_uses: [toolFragment],
    skill_refs: [skillFragment],
    provenance,
    budget: {
      estimator: CONTEXT_ESTIMATOR,
      limit_tokens: 12_000,
      mandatory_bytes: 100,
      mandatory_tokens: 25,
      optional_bytes: 40,
      optional_tokens: 10,
      reserve_bytes: 20,
      reserve_tokens: 5,
      total_bytes: 160,
      total_tokens: 40,
      remaining_tokens: 11_960,
      exclusions,
      lessons_budget_exhausted: 0,
      required_selectors_unmatched: 0,
      required_selectors_truncated: 0,
      candidate_diagnostics_omitted: 0,
    },
    diagnostics: [{ code: 'CONTEXT_EVIDENCE_EXCLUDED', severity: 'info', message: 'One unsafe candidate was excluded.', details: { reason: 'low-trust' } }],
  };
}

test('compact context retains actionable policy, flattened scope, and closed provenance digests', () => {
  const raw = rawContextFixture();
  const compact = hostLedLearningAdapterTestApi.compactContextForHost(raw);
  assert.deepEqual(Object.keys(compact).sort(), [
    'agent', 'brain', 'budget', 'diagnostics', 'guidelines', 'hash_prefix', 'lessons', 'plans',
    'raw_context_sha256', 'request', 'schema', 'skills', 'source_hash_encoding', 'target', 'tools', 'workspace',
  ]);
  assert.equal(compact['schema'], 'host-context.v2');
  assert.equal(compact['hash_prefix'], 'sha256:');
  assert.equal(compact['source_hash_encoding'], 'sha256-base64url');
  assert.deepEqual(compact['workspace'], [
    'company',
    sha256('workspace').slice('sha256:'.length),
    1,
  ]);
  const rawAgent = raw['agent'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(compact['target'], [
    'gtm/social-manager#opportunity-discovery',
    String(rawAgent['agent']!['fragment_hash']).slice('sha256:'.length),
  ]);
  assert.deepEqual(compact['request'], ['reliable ai practitioners', 12_000]);
  const agent = compact['agent'] as readonly (readonly unknown[])[];
  assert.deepEqual(agent[0], [
    'Go to market.', ['social-manager'], [], [],
    sourceHashDigest(String(rawAgent['function']!['source_content_hash'])),
  ]);
  assert.deepEqual(agent[1], [
    'Find discussions.', ['opportunity-discovery'], [], ['discovery-policy'], [], ['social-search'], ['prior'],
    sourceHashDigest(String(rawAgent['agent']!['source_content_hash'])),
  ]);
  const plan = (compact['plans'] as readonly (readonly unknown[])[])[0]!;
  assert.equal(plan[0], 'opportunity-discovery');
  assert.equal(plan[1], String(((raw['plan'] as Record<string, unknown>)['definitions'] as Record<string, unknown>[])[0]!['fragment_hash']).slice('sha256:'.length));
  assert.equal(plan[3], 'Find attributable discussions.');
  assert.deepEqual(plan[4], [[
    'search', 4, 'Search using the authored tool policy.', 'social-search',
  ]]);
  assert.deepEqual(plan[5], [
    'Return a cited shortlist.', ['Every result has an attributable source.'], ['shortlist'],
  ]);
  assert.deepEqual(plan[6], {
    i: [['request', 'The human discovery request.', 1]],
    b: [['positioning', 'Current company positioning.', 0]],
    g: ['2:discovery-policy'],
    t: ['social-search'],
    a: [['shortlist', 'Cited opportunities.']],
    c: [['candidates', 10, 'Keep only relevant discussions.']],
  });
  assert.deepEqual(compact['guidelines'], [[
    'discovery-policy', 'Apply opportunity policy.', 2, 'Prefer attributable practitioner posts.',
    sourceHashDigest(String((raw['guidelines'] as Record<string, unknown>[])[0]!['source_content_hash'])), 0,
  ]]);
  assert.deepEqual(compact['lessons'], [[
    'prior', 'Remember a validated pattern.', 2, 'Prefer posts with an attributable author.',
    sourceHashDigest(String((raw['lessons'] as Record<string, unknown>[])[0]!['source_content_hash'])),
  ]]);
  const brain = compact['brain'] as readonly unknown[];
  assert.deepEqual(brain[0], ['internal', 'opportunity-discovery', 'plain-text', '1']);
  assert.deepEqual(brain[1], ['', '', '', '', '']);
  assert.deepEqual((brain[2] as readonly (readonly unknown[])[])[0]!.slice(0, 3), [
    'positioning', 'Company positioning emphasizes operator control.', 1,
  ]);
  const rawTool = ((raw['tool_uses'] as Record<string, unknown>[])[0]!['content']) as Record<string, unknown>;
  const tool = (compact['tools'] as readonly (readonly unknown[])[])[0]!;
  assert.deepEqual(tool.slice(0, 4), [
    'social-search', null, 'Find attributable discussions worth answering.', 'exa:search',
  ]);
  assert.deepEqual(tool[14], ['search']);
  assert.equal(tool[15], String(rawTool['semantic_hash']).slice('sha256:'.length));
  assert.equal(tool[16], canonicalSha256({
    contributors: rawTool['contributors'],
    field_sources: rawTool['field_sources'],
  }).slice('sha256:'.length));
  assert.deepEqual((compact['skills'] as readonly (readonly unknown[])[])[0]!.slice(0, 2), ['exa:search', '1']);
  assert.deepEqual(compact['budget'], [12_000, 40, 11_960, [['low-trust', 1]], [0, 0, 0]]);
  assert.equal(compact['raw_context_sha256'], canonicalSha256(raw));

  const changedOmittedProvenance = structuredClone(raw);
  ((changedOmittedProvenance['provenance'] as Record<string, unknown>[])[0]!)['source_id'] = 'source:changed';
  const changedCompact = hostLedLearningAdapterTestApi.compactContextForHost(changedOmittedProvenance);
  assert.notEqual(changedCompact['raw_context_sha256'], compact['raw_context_sha256']);
  assert.deepEqual(
    { ...changedCompact, raw_context_sha256: compact['raw_context_sha256'] },
    compact,
  );

  const changedResolution = structuredClone(raw);
  const changedTool = (changedResolution['tool_uses'] as Record<string, unknown>[])[0]!;
  const changedToolContent = changedTool['content'] as Record<string, unknown>;
  ((changedToolContent['contributors'] as Record<string, unknown>[])[0]!)['path'] = 'changed/tool-source.yaml';
  refreshFragmentIntegrity(changedTool);
  const changedToolProvenance = (changedResolution['provenance'] as Record<string, unknown>[])
    .find((entry) => entry['fragment_id'] === changedTool['fragment_id'])!;
  changedToolProvenance['fragment_hash'] = changedTool['fragment_hash'];
  const changedResolutionCompact = hostLedLearningAdapterTestApi.compactContextForHost(changedResolution);
  assert.notEqual(
    ((changedResolutionCompact['tools'] as readonly (readonly unknown[])[])[0]!)[16],
    tool[16],
  );
  assert.throws(
    () => hostLedLearningAdapterTestApi.compactContextForHost({ ...raw, surplus: true }),
    /closed raw context contract/iu,
  );
});

test('compact context preserves exact request bytes and sparse tool policy states', () => {
  const toolRow = (update: (effective: Record<string, unknown>) => void): readonly unknown[] => {
    const raw = rawContextFixture();
    const fragment = (raw['tool_uses'] as Record<string, unknown>[])[0]!;
    const content = fragment['content'] as Record<string, unknown>;
    const effective = content['effective'] as Record<string, unknown>;
    update(effective);
    content['semantic_hash'] = canonicalSha256(effective);
    refreshFragmentIntegrity(fragment);
    const provenance = (raw['provenance'] as Record<string, unknown>[])
      .find((entry) => entry['fragment_id'] === fragment['fragment_id'])!;
    provenance['fragment_hash'] = fragment['fragment_hash'];
    return (hostLedLearningAdapterTestApi.compactContextForHost(raw)['tools'] as readonly (readonly unknown[])[])[0]!;
  };

  const undeclaredEffects = toolRow((effective) => {
    delete effective['effects'];
  });
  const denyAllEffects = toolRow((effective) => {
    effective['effects'] = { allowed: [] };
    effective['output_expectations'] = { required: [], guidance: [] };
    effective['brain'] = { read: [], write: [] };
    effective['evidence'] = { required: [], guidance: [] };
  });
  assert.equal(JSON.parse(JSON.stringify(undeclaredEffects))[13], null);
  assert.deepEqual(denyAllEffects[9], [[], []]);
  assert.deepEqual(denyAllEffects[10], [[], []]);
  assert.deepEqual(denyAllEffects[12], [[], []]);
  assert.deepEqual(denyAllEffects[13], []);

  const raw = rawContextFixture();
  (raw['request'] as Record<string, unknown>)['query'] = 'reliable ai practitioners  ';
  const projectedRequest = hostLedLearningAdapterTestApi.compactContextForHost(raw)['request'] as readonly unknown[];
  assert.equal(projectedRequest[0], 'reliable ai practitioners  ');
});

test('compact Brain rows remain unambiguous when every shared default is mixed', () => {
  const raw = rawContextFixture();
  const second: Record<string, unknown> = {
    ...contextFragment({
      id: 'brain-evidence:positioning-two',
      kind: 'brain-evidence',
      scope: 'agent',
      trust: 'brain-extract-untrusted',
      inclusionReason: 'selector-match',
      required: false,
      content: 'A second public source uses a different extractor.',
    }),
    privacy: 'public',
    candidate_scope: contextScope('agent'),
    retrieval_reason: 'selector-match',
    retrieval_modes: ['structured', 'lexical'],
    citation: {
      logical_source_id: 'company-positioning-two',
      source_version_id: 'version-2',
      object_id: 'object-2',
      extractor_id: 'html',
      extractor_version: '2',
      locator: 'fixture://positioning/two',
      content_hash: sha256('A second public source uses a different extractor.'),
    },
  };
  (raw['brain_evidence'] as Record<string, unknown>[]).push(second);
  (raw['provenance'] as Record<string, unknown>[]).push({
    fragment_id: second['fragment_id'],
    source_id: `source:${second['fragment_id']}`,
    trust: second['trust'],
    inclusion_reason: second['inclusion_reason'],
    required: second['required'],
    source_content_hash: second['source_content_hash'],
    fragment_hash: second['fragment_hash'],
  });

  const compact = hostLedLearningAdapterTestApi.compactContextForHost(raw);
  const brain = compact['brain'] as readonly [
    readonly unknown[],
    readonly string[],
    readonly (readonly unknown[])[],
  ];
  assert.deepEqual(brain[0], [false, false, false, false]);
  assert.deepEqual(brain[1], [
    'positioning', 'company-positioning', 'version-', 'object-', 'fixture://positioning',
  ]);
  assert.deepEqual(brain[2][0], [
    '',
    'Company positioning emphasizes operator control.',
    1,
    'internal',
    'opportunity-discovery',
    '',
    '1',
    '1',
    'plain-text',
    '1',
    '',
    sha256('Company positioning emphasizes operator control.').slice('sha256:'.length),
  ]);
  assert.deepEqual(brain[2][1], [
    '-two',
    'A second public source uses a different extractor.',
    0,
    'public',
    2,
    '-two',
    '2',
    '2',
    'html',
    '2',
    '/two',
    sha256('A second public source uses a different extractor.').slice('sha256:'.length),
  ]);
});

test('authored policy and approved lessons require source revisions while Brain may remain source-less', () => {
  const authoredFragments = [
    (raw: Record<string, unknown>) => (raw['agent'] as Record<string, Record<string, unknown>>)['function']!,
    (raw: Record<string, unknown>) => (raw['agent'] as Record<string, Record<string, unknown>>)['agent']!,
    (raw: Record<string, unknown>) => ((raw['plan'] as Record<string, unknown>)['definitions'] as Record<string, unknown>[])[0]!,
    (raw: Record<string, unknown>) => (raw['guidelines'] as Record<string, unknown>[])[0]!,
    (raw: Record<string, unknown>) => (raw['lessons'] as Record<string, unknown>[])[0]!,
  ];
  const removeSourceRevision = (
    raw: Record<string, unknown>,
    fragment: Record<string, unknown>,
  ): void => {
    fragment['source_content_hash'] = null;
    const provenance = (raw['provenance'] as Record<string, unknown>[])
      .find((entry) => entry['fragment_id'] === fragment['fragment_id'])!;
    provenance['source_content_hash'] = null;
  };

  for (const select of authoredFragments) {
    const raw = rawContextFixture();
    removeSourceRevision(raw, select(raw));
    assert.throws(
      () => hostLedLearningAdapterTestApi.compactContextForHost(raw),
      /must retain its authored source revision/iu,
    );
  }

  const raw = rawContextFixture();
  removeSourceRevision(raw, (raw['brain_evidence'] as Record<string, unknown>[])[0]!);
  assert.doesNotThrow(() => hostLedLearningAdapterTestApi.compactContextForHost(raw));
});

test('compact context rejects fragment, scope, Brain, and tool shape or integrity tampering', () => {
  const raw = rawContextFixture();
  const mutate = (update: (copy: Record<string, unknown>) => void): Record<string, unknown> => {
    const copy = structuredClone(raw);
    update(copy);
    return copy;
  };
  const refresh = (copy: Record<string, unknown>, fragment: Record<string, unknown>): void => {
    refreshFragmentIntegrity(fragment);
    const provenance = (copy['provenance'] as Record<string, unknown>[])
      .find((entry) => entry['fragment_id'] === fragment['fragment_id'])!;
    provenance['fragment_hash'] = fragment['fragment_hash'];
  };
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    (copy['request'] as Record<string, unknown>)['explain'] = true;
  })), /does not support explain requests/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    (copy['budget'] as Record<string, unknown>)['estimator'] = 'unknown-estimator';
  })), /fixed host-context\.v2 estimator/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    fragment['unexpected'] = true;
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    fragment['content'] = { changed: true };
  })), /fragment_hash does not match its content|content_bytes does not match its content/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    fragment['content_bytes'] = (fragment['content_bytes'] as number) + 1;
  })), /content_bytes does not match its content/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    fragment['content_tokens'] = (fragment['content_tokens'] as number) + 1;
  })), /content_tokens does not match its content/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    (fragment['scope'] as Record<string, unknown>)['function'] = null;
    (fragment['scope'] as Record<string, unknown>)['agent'] = 'orphan';
  })), /invalid hierarchy/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    (fragment['scope'] as Record<string, unknown>)['extra'] = null;
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['agent'] as Record<string, unknown>)['function']) as Record<string, unknown>;
    (fragment['scope'] as Record<string, unknown>)['workspace'] = 'different-company';
  })), /does not match the context workspace/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const brain = (copy['brain_evidence'] as Record<string, unknown>[])[0]!;
    (brain['citation'] as Record<string, unknown>)['extra'] = 'not allowed';
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const brain = (copy['brain_evidence'] as Record<string, unknown>[])[0]!;
    (brain['candidate_scope'] as Record<string, unknown>)['function'] = null;
  })), /invalid hierarchy/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const brain = (copy['brain_evidence'] as Record<string, unknown>[])[0]!;
    (brain['candidate_scope'] as Record<string, unknown>)['workspace'] = 'different-company';
  })), /does not match the context workspace/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const tool = (copy['tool_uses'] as Record<string, unknown>[])[0]!;
    (tool['content'] as Record<string, unknown>)['extra'] = 'not allowed';
    const serialized = JSON.stringify(tool['content']);
    tool['fragment_hash'] = sha256(serialized);
    tool['content_bytes'] = Buffer.byteLength(serialized, 'utf8');
    tool['content_tokens'] = Math.ceil((tool['content_bytes'] as number) / 4);
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const tool = (copy['tool_uses'] as Record<string, unknown>[])[0]!;
    const content = tool['content'] as Record<string, unknown>;
    (content['references'] as Record<string, unknown>[])[0]!['extra'] = 'not allowed';
    const serialized = JSON.stringify(content);
    tool['fragment_hash'] = sha256(serialized);
    tool['content_bytes'] = Buffer.byteLength(serialized, 'utf8');
    tool['content_tokens'] = Math.ceil((tool['content_bytes'] as number) / 4);
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = (copy['agent'] as Record<string, Record<string, unknown>>)['function']!;
    (fragment['content'] as Record<string, unknown>)['surplus'] = true;
    refresh(copy, fragment);
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = ((copy['plan'] as Record<string, unknown>)['definitions'] as Record<string, unknown>[])[0]!;
    (fragment['content'] as Record<string, unknown>)['surplus'] = true;
    refresh(copy, fragment);
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = (copy['guidelines'] as Record<string, unknown>[])[0]!;
    (fragment['content'] as Record<string, unknown>)['surplus'] = true;
    refresh(copy, fragment);
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = (copy['skill_refs'] as Record<string, unknown>[])[0]!;
    (fragment['content'] as Record<string, unknown>)['surplus'] = true;
    refresh(copy, fragment);
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    ((copy['provenance'] as Record<string, unknown>[])[0]!)['surplus'] = true;
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    (copy['budget'] as Record<string, unknown>)['surplus'] = true;
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.compactContextForHost(mutate((copy) => {
    const fragment = (copy['tool_uses'] as Record<string, unknown>[])[0]!;
    (fragment['content'] as Record<string, unknown>)['semantic_hash'] = sha256('wrong-semantic-policy');
    refresh(copy, fragment);
  })), /semantic_hash is invalid/iu);
});

test('model-visible adapter JSON fails closed above 8,000 JavaScript characters', () => {
  assert.equal(hostLedLearningAdapterTestApi.assertModelVisibleJsonCharacterLimit({ ok: true }, 'small'), 11);
  assert.throws(
    () => hostLedLearningAdapterTestApi.assertModelVisibleJsonCharacterLimit({ value: 'x'.repeat(8_000) }, 'large'),
    /8000-character model-visible JSON limit/iu,
  );
});

test('fixture search v2 projection is lossless, self-describing, and exactly 2,136 characters', () => {
  const raw = JSON.parse(readFileSync(
    new URL('./fixtures/host-led-learning/common/fake-search-results.json', import.meta.url),
    'utf8',
  )) as unknown;
  const requestHash = sha256('natural fixture search request');
  const projection = hostLedLearningAdapterTestApi.projectFixtureSearchForHost(raw, requestHash);
  assert.deepEqual(projection, {
    schema_version: 2,
    provider: 'roster-350-fixture-search',
    request_hash: requestHash,
    columns: [
      'id', 'url', 'author', 'published', 'title', 'excerpt', 'topics', 'source', 'source_id',
      'prior_runs', 'untrusted_marker',
    ],
    rows: (raw as { results: readonly Record<string, unknown>[] }).results.map((result) => {
      const attribution = result['attribution'] as Record<string, unknown>;
      return [
        result['result_id'],
        result['canonical_url'],
        result['author'],
        result['published_at'],
        result['title'],
        result['excerpt'],
        result['topics'],
        attribution['source'],
        attribution['source_record_id'],
        result['observed_run_ids'],
        result['transient_marker'],
      ];
    }),
  });
  assert.equal(JSON.stringify(canonicalValue(projection)).length, 2_136);
  assert.equal(
    hostLedLearningAdapterTestApi.assertModelVisibleJsonCharacterLimit(projection, 'fixture search'),
    2_136,
  );
  assert.deepEqual(hostLedLearningAdapterTestApi.fixtureSearchCorpusFromProjection(projection), raw);

  const reorderedColumns = structuredClone(projection) as unknown as { columns: string[] };
  [reorderedColumns.columns[0], reorderedColumns.columns[1]] = [
    reorderedColumns.columns[1]!,
    reorderedColumns.columns[0]!,
  ];
  assert.throws(
    () => hostLedLearningAdapterTestApi.fixtureSearchCorpusFromProjection(reorderedColumns),
    /projection identity is invalid/iu,
  );
  assert.throws(
    () => hostLedLearningAdapterTestApi.fixtureSearchCorpusFromProjection({ ...projection, surplus: true }),
    /closed shape/iu,
  );
});

test('fixture search parser rejects unknown, malformed, duplicate, control, oversized, and invalid URL data', () => {
  const source = JSON.parse(readFileSync(
    new URL('./fixtures/host-led-learning/common/fake-search-results.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  const mutate = (change: (copy: Record<string, unknown>, rows: Record<string, unknown>[]) => void) => {
    const copy = structuredClone(source);
    const rows = copy['results'] as Record<string, unknown>[];
    change(copy, rows);
    return copy;
  };

  assert.throws(
    () => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus({ ...source, surplus: true }),
    /closed shape/iu,
  );
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['surplus'] = true;
  })), /closed shape/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    (rows[0]!['attribution'] as Record<string, unknown>)['surplus'] = true;
  })), /closed shape/iu);
  assert.throws(
    () => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus({ ...source, schema_version: 9 }),
    /identity or result count is invalid/iu,
  );
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[1]!['result_id'] = rows[0]!['result_id'];
  })), /duplicate result IDs/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[1]!['canonical_url'] = rows[0]!['canonical_url'];
  })), /duplicate canonical URLs/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    const firstAttribution = rows[0]!['attribution'] as Record<string, unknown>;
    const secondAttribution = rows[1]!['attribution'] as Record<string, unknown>;
    secondAttribution['source_record_id'] = firstAttribution['source_record_id'];
  })), /duplicate source record IDs/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['topics'] = ['professional-profile', 'professional-profile'];
  })), /contains duplicates/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['observed_run_ids'] = ['run-observation-004', 'run-observation-004'];
  })), /contains duplicates/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['author'] = 'Mina\u0000Patel';
  })), /bounded string/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['excerpt'] = 'x'.repeat(4_097);
  })), /bounded string/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['canonical_url'] = 'file:///private/fixture';
  })), /HTTPS URL/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['canonical_url'] = 'https://user:password@social.example.test/posts/private';
  })), /HTTPS URL/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus(mutate((_copy, rows) => {
    rows[0]!['published_at'] = '2026-02-31T09:00:00Z';
  })), /UTC timestamp/iu);
  assert.throws(() => hostLedLearningAdapterTestApi.parseFixtureSearchCorpus({
    ...source,
    results: Array.from({ length: 33 }, () => structuredClone(
      (source['results'] as Record<string, unknown>[])[0],
    )),
  }), /identity or result count is invalid/iu);
});

test('run-record result selection validates the complete fixture corpus', () => {
  const source = JSON.parse(readFileSync(
    new URL('./fixtures/host-led-learning/common/fake-search-results.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(
    hostLedLearningAdapterTestApi.requireFixtureSearchResult(source, 'result-c77f').result_id,
    'result-c77f',
  );
  const corrupted = structuredClone(source);
  ((corrupted['results'] as Record<string, unknown>[])[0]!)['surplus'] = true;
  assert.throws(
    () => hostLedLearningAdapterTestApi.requireFixtureSearchResult(corrupted, 'result-c77f'),
    /closed shape/iu,
  );
  assert.throws(
    () => hostLedLearningAdapterTestApi.requireFixtureSearchResult(source, 'result-missing'),
    /does not exist in the controlled corpus/iu,
  );
});

test('prepared Roster invocation kills a hung child and exposes only hashed stderr', () => {
  const root = temporaryWorkspace();
  const privateStderr = 'private-timeout-detail-must-not-escape';
  try {
    mkdirSync(join(root, '.fixture', 'runtime'), { recursive: true });
    writeFileSync(join(root, '.fixture', 'runtime', 'roster.js'), [
      `process.stderr.write(${JSON.stringify(privateStderr)});`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    const startedAt = Date.now();
    let captured: Error | undefined;
    assert.throws(() => hostLedLearningAdapterTestApi.invokePreparedRoster({
      workspace: root,
      argv: [],
      verb: 'context',
      timeoutMs: 50,
    }), (error: unknown) => {
      captured = error as Error;
      return error instanceof Error && /timed out \(sha256:[a-f0-9]{64}\)/u.test(error.message);
    });
    assert.equal(Date.now() - startedAt < 2_000, true);
    assert.doesNotMatch(captured!.message, new RegExp(privateStderr, 'u'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapter workspace paths reject every symlinked component and leaf', () => {
  const root = temporaryWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'roster-350-adapter-outside-'));
  try {
    writeFileSync(join(outside, 'input.json'), '{}\n');
    symlinkSync(outside, join(root, '.fixture', 'linked-input'));
    assert.throws(() => hostLedLearningAdapterTestApi.workspacePath({
      root,
      relativePath: '.fixture/linked-input/input.json',
      label: 'fixture input',
      leaf: 'regular-file',
    }), /contains a symbolic link/u);

    writeFileSync(join(root, '.fixture', 'real.json'), '{}\n');
    symlinkSync(join(root, '.fixture', 'real.json'), join(root, '.fixture', 'linked-leaf.json'));
    assert.throws(() => hostLedLearningAdapterTestApi.workspacePath({
      root,
      relativePath: '.fixture/linked-leaf.json',
      label: 'fixture state',
      leaf: 'regular-file',
    }), /contains a symbolic link/u);

    assert.throws(() => hostLedLearningAdapterTestApi.workspacePath({
      root,
      relativePath: '.fixture/missing-parent/lesson.md',
      label: 'lesson path',
      leaf: 'regular-file-or-missing',
    }), /missing or unreadable path component/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Roster required_argv is live contract data and must match exactly', () => {
  const target = 'gtm/social-manager#opportunity-discovery';
  const discover = {
    verb: 'discover',
    required_argv: ['$TARGET', '--json'],
    log_category: 'roster.discover',
  } as const;
  assert.deepEqual(
    hostLedLearningAdapterTestApi.requireContractedRosterArgv(
      discover,
      target,
      [target, '--json'],
    ).expected,
    [target, '--json'],
  );
  assert.throws(() => hostLedLearningAdapterTestApi.requireContractedRosterArgv(
    discover,
    target,
    [target, '--exact', '--json'],
  ), /does not exactly match required_argv/u);

  const context = {
    verb: 'context',
    required_argv: ['$TARGET', '--query', '$DERIVED_QUERY', '--json'],
    log_category: 'roster.context',
  } as const;
  const derived = 'reliable AI operations';
  assert.deepEqual(
    hostLedLearningAdapterTestApi.requireContractedRosterArgv(
      context,
      target,
      [target, '--query', derived, '--json'],
    ),
    { expected: [target, '--query', derived, '--json'], derivedQuery: derived },
  );
  assert.throws(() => hostLedLearningAdapterTestApi.requireContractedRosterArgv(
    context,
    target,
    [target, '--query', derived, '--json', '--explain'],
  ), /does not exactly match required_argv/u);
});

test('repeatable required adapter flags accept one or more distinct values', () => {
  const definition = {
    command: 'roster-350-fixture-run-record',
    log_category: 'evidence.run-record',
    allowed_turns: ['discover'],
    required_flags: ['--request-hash', '--selected-result', '--brain-citation'],
    repeatable_flags: ['--brain-citation'],
  } as const;
  const fixed = [
    '--request-hash', `sha256:${'a'.repeat(64)}`,
    '--selected-result', 'result-a17f',
  ];
  const parsed = hostLedLearningAdapterTestApi.parseArguments([
    ...fixed,
    '--brain-citation', 'brain-record-a17f',
    '--brain-citation', 'brain-record-b62c',
    '--brain-citation', 'brain-record-d91e',
  ], definition);
  assert.deepEqual(parsed.values.get('--brain-citation'), [
    'brain-record-a17f', 'brain-record-b62c', 'brain-record-d91e',
  ]);
  assert.throws(
    () => hostLedLearningAdapterTestApi.parseArguments(fixed, definition),
    /required flag --brain-citation is missing/u,
  );
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    ...fixed,
    '--selected-result', 'result-a17f',
    '--brain-citation', 'brain-record-a17f',
  ], definition), /non-repeatable flag --selected-result was repeated/u);
});

test('completed-run query is recovered from one exact context/search log pair', () => {
  const root = temporaryWorkspace();
  const query = 'reliable AI content operations practitioner discussions';
  const requestHash = `sha256:${'a'.repeat(64)}`;
  const proof = {
    bytes: Buffer.byteLength(query, 'utf8'),
    differs_from_request: true,
    leading_option: false,
    control_characters: false,
    query,
    query_sha256: sha256(query),
  };
  const records: Record<string, unknown>[] = [
    { sequence: 1, turn: 'discover', log_category: 'roster.discover' },
    { sequence: 2, turn: 'discover', log_category: 'roster.context', query_proof: proof },
    { sequence: 3, turn: 'discover', log_category: 'tool.search', query_proof: proof },
  ];
  const logPath = join(root, contract.runtime.adapter_log_path);
  try {
    writeFileSync(logPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.deepEqual(
      hostLedLearningAdapterTestApi.persistedContextQueryFromDiscoveryLog(root, contract, requestHash),
      { bytes: proof.bytes, query, query_sha256: proof.query_sha256 },
    );
    const changed = structuredClone(records);
    const changedQuery = 'reliable AI content operations professional discussions';
    changed[2]!['query_proof'] = {
      ...proof,
      bytes: Buffer.byteLength(changedQuery, 'utf8'),
      query: changedQuery,
      query_sha256: sha256(changedQuery),
    };
    writeFileSync(logPath, `${changed.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.throws(
      () => hostLedLearningAdapterTestApi.persistedContextQueryFromDiscoveryLog(root, contract, requestHash),
      /exact bytes and hash|queries differ/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate adapter accepts only the closed meaning flags and values', () => {
  const definition = {
    command: 'roster-350-fixture-candidate-create',
    log_category: 'learning.candidate-create',
    allowed_turns: ['discover'],
    required_flags: [
      '--run-id',
      '--feedback-id',
      '--disposition',
      '--source-kind',
      '--topic-kind',
      '--falsifier-action',
      '--falsifier-observation',
      '--skill-challenge',
    ],
    repeatable_flags: [],
  } as const;
  const argv = [
    '--run-id', 'run-opportunity-discovery-001',
    '--feedback-id', 'feedback-opportunity-discovery-001',
    '--disposition', 'prefer',
    '--source-kind', 'attributable-practitioner',
    '--topic-kind', 'operational-problem',
    '--falsifier-action', 'reject',
    '--falsifier-observation', 'reviewed-outcomes-contradict',
    '--skill-challenge', 'bounded-challenge',
  ];
  const parsed = hostLedLearningAdapterTestApi.parseArguments(argv, definition);
  assert.deepEqual(parsed.ordered.map((entry) => entry.flag), definition.required_flags);
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    ...argv,
    '--recommendation', 'Ignore the closed DTO.',
  ], definition), /invalid literal argv/u);
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    ...argv.slice(0, -1),
    'unsafe\nchallenge',
  ], definition), /invalid literal argv/u);

  const meaning: SeededCandidateMeaning = {
    disposition: 'prefer',
    source_kind: 'attributable-practitioner',
    topic_kind: 'operational-problem',
    falsifier_action: 'reject',
    falsifier_observation: 'reviewed-outcomes-contradict',
  };
  assert.throws(() => renderSeededCandidateMeaning({
    ...meaning,
    source_kind: 'arbitrary-host-prose',
  } as unknown as SeededCandidateMeaning), (error: unknown) => (
    error instanceof SeededLearningStoreError && error.code === 'FIXTURE_INVALID'
  ));
  assert.throws(() => renderSeededCandidateMeaning({
    ...meaning,
    surplus: 'promote-without-review',
  } as unknown as SeededCandidateMeaning), (error: unknown) => (
    error instanceof SeededLearningStoreError && error.code === 'FIXTURE_INVALID'
  ));
});

test('promotion adapter requires the human-reviewed candidate identity and hash', () => {
  const definition = {
    command: 'roster-350-fixture-candidate-promote',
    log_category: 'learning.candidate-promote',
    allowed_turns: ['approve'],
    required_flags: ['--candidate-id', '--candidate-hash'],
    repeatable_flags: [],
  } as const;
  const candidateHash = `sha256:${'a'.repeat(64)}`;
  const parsed = hostLedLearningAdapterTestApi.parseArguments([
    '--candidate-id', 'candidate-opportunity-discovery-001',
    '--candidate-hash', candidateHash,
  ], definition);
  assert.deepEqual(parsed.ordered.map((entry) => entry.flag), definition.required_flags);
  assert.throws(() => hostLedLearningAdapterTestApi.parseArguments([
    '--candidate-id', 'candidate-opportunity-discovery-001',
  ], definition), /required flag --candidate-hash is missing/iu);
});

test('adapter log enforces one writer and validates contiguous sequences', () => {
  const root = temporaryWorkspace();
  try {
    const append = (category: string) => {
      const rawContextHash = `sha256:${'4'.repeat(64)}`;
      return hostLedLearningAdapterTestApi.appendLog({
        workspace: root,
        contract,
        turn: 'discover',
        command: 'roster',
        category,
        flags: ['--json'],
        output: category === 'roster.context' ? { ok: true, raw_context_sha256: rawContextHash } : { ok: true },
        rosterProof: {
          argvHash: `sha256:${'1'.repeat(64)}`,
          contractArgvHash: `sha256:${'1'.repeat(64)}`,
          bundleHash: `sha256:${'3'.repeat(64)}`,
          ...(category === 'roster.context' ? { rawContextHash } : {}),
        },
      });
    };
    append('roster.discover');
    append('roster.context');
    const logPath = join(root, contract.runtime.adapter_log_path);
    const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
    assert.equal(records[0].roster_bundle_sha256, `sha256:${'3'.repeat(64)}`);
    assert.equal(records[0].roster_argv_sha256, records[0].roster_contract_argv_sha256);
    assert.equal(records[0].roster_argv_exact, true);
    assert.equal(records[0].roster_invocation_status, 'prepared-bundle-success');
    assert.equal(records[1].raw_context_sha256, `sha256:${'4'.repeat(64)}`);

    const lockPath = `${logPath}.lock`;
    writeFileSync(lockPath, '', { flag: 'wx' });
    assert.throws(() => append('roster.context'), /active or stale writer lock/u);
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
    rmSync(lockPath);

    records[1].sequence = 1;
    writeFileSync(logPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.throws(() => append('roster.context'), /log sequence is invalid/u);
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
