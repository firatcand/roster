import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { RosterError } from '../src/lib/errors.ts';
import {
  DEFAULT_DREAM_POLICY,
  DREAM_READINESS_REASONS,
  DREAM_SCOPE_KEY_PATTERN,
  assertDreamPolicy,
  canonicalizeDreamScope,
  dreamDurationSeconds,
  dreamDurationText,
  dreamPolicyCanonical,
  dreamPolicyFingerprint,
  dreamReadinessKey,
  dreamReadinessReasons,
  dreamScopeResolutionChain,
  dreamWatermarkCanonical,
  type DreamPolicy,
} from '../src/lib/brain/dream-contracts.ts';

const MIGRATION = join(process.cwd(), 'data/brain/schema/014_dream_readiness.sql');

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

test('the built-in dream policy is pinned', () => {
  assert.deepEqual({ ...DEFAULT_DREAM_POLICY, excludedAgentIds: [...DEFAULT_DREAM_POLICY.excludedAgentIds] }, {
    policyVersion: 'roster.dream.default.v1',
    scopeKey: 'workspace',
    minCompletedRuns: 5,
    minFeedbackRecords: 0,
    minSignalMix: 0,
    evidenceWindow: 'P30D',
    cooldown: 'PT20H',
    excludedAgentIds: ['dreamer'],
  });
  // A literal, not a recomputation: an accidental field rename or reordering of
  // the fingerprint preimage would re-key every open occasion in every workspace.
  assert.equal(
    dreamPolicyFingerprint(DEFAULT_DREAM_POLICY),
    'sha256:c86534ae1980fee23030c279bd21b42797ffcf5675a9c918d15963181bd3a524',
  );
  assert.equal(assertDreamPolicy(DEFAULT_DREAM_POLICY), DEFAULT_DREAM_POLICY);
});

test('the dream scope grammar matches the durable scope_key CHECK', () => {
  const accepted = [
    'workspace',
    'function:social-media',
    'agent:social-media/manager',
    'plan:social-media/manager#discovery',
  ];
  const refused = [
    'function:Social',
    'agent:social-media',
    'plan:social-media/manager',
    'agent:social-media/manager#discovery',
    'workspace:extra',
    '',
  ];
  const migration = readFileSync(MIGRATION, 'utf8');
  // The SQL literal is the authority; the TS pattern is its transcription, so
  // the two are compared over the SAME vectors rather than by string equality.
  const sqlPattern = /scope_key ~ '(\^\(workspace\|[^']+)'/u.exec(migration)?.[1];
  assert.notEqual(sqlPattern, undefined);
  const transcribed = new RegExp(sqlPattern!.replaceAll('(?', '('), 'u');
  for (const value of accepted) {
    assert.equal(DREAM_SCOPE_KEY_PATTERN.test(value), true, value);
    assert.equal(transcribed.test(value), true, `sql ${value}`);
  }
  for (const value of refused) {
    assert.equal(DREAM_SCOPE_KEY_PATTERN.test(value), false, value);
    assert.equal(transcribed.test(value), false, `sql ${value}`);
  }
  // Every scope_key CHECK in 014 uses the identical literal.
  const occurrences = migration.split(sqlPattern!).length - 1;
  assert.equal(occurrences >= 4, true, `scope_key grammar appears ${occurrences} times`);
});

test('dream scopes canonicalize and resolve most-specific first', () => {
  assert.deepEqual({ ...canonicalizeDreamScope(undefined) }, {
    key: 'workspace', kind: 'workspace', functionId: null, agentId: null, planId: null,
  });
  assert.deepEqual({ ...canonicalizeDreamScope('plan:social-media/manager#discovery') }, {
    key: 'plan:social-media/manager#discovery',
    kind: 'plan',
    functionId: 'social-media',
    agentId: 'manager',
    planId: 'discovery',
  });
  assert.deepEqual([...dreamScopeResolutionChain(canonicalizeDreamScope('plan:social-media/manager#discovery'))], [
    'plan:social-media/manager#discovery',
    'agent:social-media/manager',
    'function:social-media',
    'workspace',
  ]);
  assert.deepEqual([...dreamScopeResolutionChain(canonicalizeDreamScope('agent:social-media/manager'))], [
    'agent:social-media/manager',
    'function:social-media',
    'workspace',
  ]);
  assert.deepEqual([...dreamScopeResolutionChain(canonicalizeDreamScope('function:social-media'))], [
    'function:social-media',
    'workspace',
  ]);
  assert.deepEqual([...dreamScopeResolutionChain(canonicalizeDreamScope('workspace'))], ['workspace']);
});

test('dream durations round-trip and refuse out-of-range values', () => {
  for (const [text, seconds] of [
    ['P30D', 2_592_000],
    ['PT20H', 72_000],
    ['PT0S', 0],
    ['P1DT2H3M4S', 93_784],
    ['PT45M', 2_700],
  ] as const) {
    assert.equal(dreamDurationSeconds(text), seconds, text);
    assert.equal(dreamDurationText(seconds), text, text);
  }
  for (const bad of ['P', 'PT', '30D', 'P30', 'P1W', 'PT1H30', '']) {
    assert.throws(() => dreamDurationSeconds(bad), hasCode('BRAIN_DREAM_INPUT_INVALID'), bad);
  }
  const base = DEFAULT_DREAM_POLICY;
  for (const override of [
    { evidenceWindow: 'PT59M' },
    { evidenceWindow: 'P366D' },
    { cooldown: 'P31D' },
    { minCompletedRuns: 0 },
    { minCompletedRuns: 10_001 },
    { minFeedbackRecords: -1 },
    { minSignalMix: 10_001 },
    { policyVersion: 'Bad.V1' },
    { scopeKey: 'agent:social-media' },
    { excludedAgentIds: ['dreamer', 'dreamer'] },
    { excludedAgentIds: ['Dreamer'] },
    { excludedAgentIds: Array.from({ length: 65 }, (_, i) => `a${i}`) },
  ] as Partial<DreamPolicy>[]) {
    assert.throws(
      () => assertDreamPolicy({ ...base, ...override } as DreamPolicy),
      hasCode('BRAIN_DREAM_INPUT_INVALID'),
      JSON.stringify(override),
    );
  }
});

test('the readiness key digests the snapshot, not the clock', () => {
  const base = {
    workspaceId: 'acme',
    scopeKey: 'workspace',
    policyVersion: DEFAULT_DREAM_POLICY.policyVersion,
    policyFingerprint: dreamPolicyFingerprint(DEFAULT_DREAM_POLICY),
    watermarkOrdinal: 4,
    frontierOrdinal: 27,
  };
  assert.equal(dreamReadinessKey(base), dreamReadinessKey({ ...base }));
  for (const override of [
    { frontierOrdinal: 28 },
    { watermarkOrdinal: 5 },
    { policyVersion: 'acme.dream.v2' },
    { scopeKey: 'function:social-media' },
    { workspaceId: 'other' },
    { policyFingerprint: dreamPolicyFingerprint({ ...DEFAULT_DREAM_POLICY, minCompletedRuns: 6 }) },
  ]) {
    assert.notEqual(dreamReadinessKey({ ...base, ...override }), dreamReadinessKey(base), JSON.stringify(override));
  }
});

// B1's exact reported defect, at the contract layer: with min 1/1 a lone run is
// not_due and the feedback that flips it to due MUST re-key the occasion.
test('a feedback-only arrival re-keys the occasion', () => {
  const policy: DreamPolicy = { ...DEFAULT_DREAM_POLICY, minCompletedRuns: 1, minFeedbackRecords: 1 };
  const shared = {
    workspaceId: 'acme',
    scopeKey: 'workspace',
    policyVersion: policy.policyVersion,
    policyFingerprint: dreamPolicyFingerprint(policy),
    watermarkOrdinal: 0,
  };
  const afterRun = dreamReadinessKey({ ...shared, frontierOrdinal: 1 });
  const afterFeedback = dreamReadinessKey({ ...shared, frontierOrdinal: 2 });
  assert.notEqual(afterRun, afterFeedback);
});

test('the reason vocabulary is closed and fixed-order', () => {
  assert.deepEqual([...DREAM_READINESS_REASONS], [
    'BRAIN_NOT_CONFIGURED',
    'NO_ELIGIBLE_EVIDENCE',
    'MIN_RUNS_MET',
    'MIN_RUNS_NOT_MET',
    'MIN_FEEDBACK_MET',
    'MIN_FEEDBACK_NOT_MET',
    'SIGNAL_MIX_MET',
    'SIGNAL_MIX_NOT_MET',
    'COOLDOWN_ACTIVE',
    'COOLDOWN_INACTIVE',
  ]);
  const policy: DreamPolicy = { ...DEFAULT_DREAM_POLICY, minCompletedRuns: 2, minFeedbackRecords: 1, minSignalMix: 1 };
  assert.deepEqual(
    dreamReadinessReasons({
      eligibleObservations: 0,
      completedRuns: 0,
      feedbackRecords: 0,
      signalMix: 0,
      policy,
      cooldownActive: true,
    }).map((reason) => reason.code),
    ['NO_ELIGIBLE_EVIDENCE', 'MIN_RUNS_NOT_MET', 'MIN_FEEDBACK_NOT_MET', 'SIGNAL_MIX_NOT_MET', 'COOLDOWN_ACTIVE'],
  );
  assert.deepEqual(
    dreamReadinessReasons({
      eligibleObservations: 4,
      completedRuns: 2,
      feedbackRecords: 1,
      signalMix: 1,
      policy,
      cooldownActive: false,
    }).map((reason) => reason.code),
    ['MIN_RUNS_MET', 'MIN_FEEDBACK_MET', 'SIGNAL_MIX_MET', 'COOLDOWN_INACTIVE'],
  );
  for (const reason of dreamReadinessReasons({
    eligibleObservations: 0,
    completedRuns: 0,
    feedbackRecords: 0,
    signalMix: 0,
    policy,
    cooldownActive: true,
  })) {
    assert.equal((DREAM_READINESS_REASONS as readonly string[]).includes(reason.code), true, reason.code);
  }
});

test('canonical policy and watermark payloads carry exactly their durable fields', () => {
  const canonical = dreamPolicyCanonical({
    ...DEFAULT_DREAM_POLICY,
    policyVersion: 'acme.dream.v1',
    activationAssurance: 'human-confirmed',
    registeredBy: 'owner',
  });
  assert.deepEqual(Object.keys(JSON.parse(canonical) as object).sort(), [
    'activation_assurance',
    'cooldown_seconds',
    'evidence_window_seconds',
    'excluded_agent_ids',
    'kind',
    'min_completed_runs',
    'min_feedback_records',
    'min_signal_mix',
    'policy_version',
    'registered_by',
    'schema_version',
    'scope_key',
  ]);
  assert.equal(canonical.includes('workspace_id'), false);
  assert.equal(canonical.includes('recorded_at'), false);

  const watermark = dreamWatermarkCanonical({
    scopeKey: 'workspace',
    cursorOrdinal: 12,
    policyVersion: 'acme.dream.v1',
    reason: 'promotion',
    consumedCompletedRuns: 5,
    consumedFeedbackRecords: 2,
    actorAssurance: 'human-confirmed',
  });
  assert.deepEqual(Object.keys(JSON.parse(watermark) as object).sort(), [
    'actor_assurance',
    'consumed_completed_runs',
    'consumed_feedback_records',
    'cursor_ordinal',
    'kind',
    'policy_version',
    'reason',
    'schema_version',
    'scope_key',
  ]);
  assert.equal(watermark.includes('advanced_at'), false);
  assert.equal(watermark.includes('workspace_id'), false);
  assert.throws(
    () => dreamWatermarkCanonical({
      scopeKey: 'workspace',
      cursorOrdinal: 0,
      policyVersion: 'acme.dream.v1',
      reason: 'promotion',
      consumedCompletedRuns: 0,
      consumedFeedbackRecords: 0,
      actorAssurance: 'human-confirmed',
    }),
    hasCode('BRAIN_DREAM_INPUT_INVALID'),
  );
});
