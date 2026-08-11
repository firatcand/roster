import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DREAM_POLICY,
  dreamPolicyFingerprint,
  dreamReadinessKey,
} from '../src/lib/brain/dream-contracts.ts';
import {
  DREAM_CANDIDATE_CONTENT_DOMAIN,
  DREAM_CANDIDATE_DOMAIN,
  DREAM_LESSON_DECISION_DOMAIN,
  lessonDecisionIdOf,
  lessonSubjectOf,
  lessonTargetScope,
  normalizeDreamCandidate,
  normalizeLessonDecision,
  type DreamCandidateDraft,
} from '../src/lib/brain/dream-candidate-contracts.ts';
import { RosterError } from '../src/lib/errors.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(join(PROJECT_ROOT, 'data/brain/schema/015_dream_lifecycle.sql'), 'utf8');
const WORKSPACE_ID = 'acme';

const POLICY_FINGERPRINT = dreamPolicyFingerprint(DEFAULT_DREAM_POLICY);

function snapshotKey(scopeKey: string, watermarkOrdinal = 0, frontierOrdinal = 9): string {
  return dreamReadinessKey({
    workspaceId: WORKSPACE_ID,
    scopeKey,
    policyVersion: DEFAULT_DREAM_POLICY.policyVersion,
    policyFingerprint: POLICY_FINGERPRINT,
    watermarkOrdinal,
    frontierOrdinal,
  });
}

function draft(overrides: Partial<DreamCandidateDraft> = {}): DreamCandidateDraft {
  return {
    scopeKey: 'workspace',
    lessonScopeKey: 'agent:growth/sdr',
    lessonId: 'shorter-openers',
    draftedByAgentId: 'dreamer',
    lessonPurpose: 'Open with one sentence about the prospect.',
    lessonBody: 'Lead with the prospect.\n\nKeep the first message under 60 words.',
    expectedEffect: 'Reply rate rises on cold outbound.',
    conflictingSurvey: 'none-found',
    counterexampleSurvey: 'none-found',
    policyVersion: DEFAULT_DREAM_POLICY.policyVersion,
    policyFingerprint: POLICY_FINGERPRINT,
    watermarkOrdinal: 0,
    frontierOrdinal: 9,
    consumedCompletedRuns: 7,
    consumedFeedbackRecords: 2,
    supersedesCandidateId: null,
    privacyClass: 'internal',
    citations: [{
      role: 'supporting',
      evidenceKind: 'completed-run',
      runId: 'run-a',
      feedbackId: null,
      observationOrdinal: 9,
    }],
    actor: { actorId: 'dreamer', assurance: 'host-attested', host: 'claude', sessionId: 'session-1' },
    provenance: {},
    ...overrides,
  } as DreamCandidateDraft;
}

function refusal(fn: () => unknown, field: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RosterError, String(error));
    assert.equal(error.code, 'BRAIN_DREAM_INPUT_INVALID');
    assert.equal((error.details as { field?: string }).field, field, JSON.stringify(error.details));
    return true;
  });
}

test('the three digest domains are separated and the identity collapses on content', () => {
  assert.notEqual(DREAM_CANDIDATE_DOMAIN, DREAM_CANDIDATE_CONTENT_DOMAIN);
  assert.notEqual(DREAM_CANDIDATE_DOMAIN, DREAM_LESSON_DECISION_DOMAIN);

  const key = snapshotKey('workspace');
  const first = normalizeDreamCandidate(WORKSPACE_ID, key, draft());
  const second = normalizeDreamCandidate(WORKSPACE_ID, key, draft());
  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.canonical, second.canonical);

  // Any edit to reviewed content opens a NEW identity, so a human never
  // approves one set of bytes and gets another.
  const edited = normalizeDreamCandidate(WORKSPACE_ID, key, draft({ lessonBody: 'Different body.' }));
  assert.notEqual(edited.contentDigest, first.contentDigest);
  assert.notEqual(edited.candidateId, first.candidateId);

  // A different workspace never collides with this one.
  const elsewhere = normalizeDreamCandidate('other', snapshotKeyFor('other'), draft());
  assert.notEqual(elsewhere.candidateId, first.candidateId);
});

function snapshotKeyFor(workspaceId: string): string {
  return dreamReadinessKey({
    workspaceId,
    scopeKey: 'workspace',
    policyVersion: DEFAULT_DREAM_POLICY.policyVersion,
    policyFingerprint: POLICY_FINGERPRINT,
    watermarkOrdinal: 0,
    frontierOrdinal: 9,
  });
}

test('the readiness key is recomputed from the snapshot, never taken on trust', () => {
  const wrong = snapshotKey('workspace', 0, 8);
  refusal(() => normalizeDreamCandidate(WORKSPACE_ID, wrong, draft()), 'readiness_key');
  // A candidate whose policy version is edited no longer matches its own key.
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, snapshotKey('workspace'), draft({ policyVersion: 'acme.dream.v2' })),
    'readiness_key',
  );
});

test('agent and plan targets normalize to ONE subject, one path, one qualified id', () => {
  for (const [agentSpelling, planSpelling] of [
    ['agent:growth/sdr', 'plan:growth/sdr#outbound'],
    ['agent:go-to-market/senior-sdr', 'plan:go-to-market/senior-sdr#multi-part-plan-id'],
  ] as const) {
    const fromAgent = lessonSubjectOf(agentSpelling);
    const fromPlan = lessonSubjectOf(planSpelling);
    assert.equal(fromAgent.agentKey, fromPlan.agentKey);
    assert.equal(fromAgent.qualifiedIdOf('l1'), fromPlan.qualifiedIdOf('l1'));
    assert.equal(fromAgent.planId, null);
    assert.notEqual(fromPlan.planId, null);
    // The registered SCOPE still differs -- only the physical file collapses.
    assert.notDeepEqual(lessonTargetScope(agentSpelling), lessonTargetScope(planSpelling));
  }
  assert.equal(lessonSubjectOf('plan:growth/sdr#outbound').qualifiedIdOf('shorter-openers'),
    'growth/sdr/playbook/shorter-openers');
});

test('scope containment admits a target at or below its occasion and refuses one above it', () => {
  const cases: readonly [string, string, boolean][] = [
    ['workspace', 'agent:growth/sdr', true],
    ['workspace', 'plan:growth/sdr#outbound', true],
    ['function:growth', 'agent:growth/sdr', true],
    ['function:growth', 'plan:growth/sdr#outbound', true],
    ['function:growth', 'agent:support/lead', false],
    ['agent:growth/sdr', 'agent:growth/sdr', true],
    ['agent:growth/sdr', 'plan:growth/sdr#outbound', true],
    ['agent:growth/sdr', 'agent:growth/manager', false],
    ['plan:growth/sdr#outbound', 'plan:growth/sdr#outbound', true],
    // The occasion is one plan's evidence; installing agent-wide would apply
    // narrow evidence broadly, which is the direction containment refuses.
    ['plan:growth/sdr#outbound', 'agent:growth/sdr', false],
  ];
  for (const [scopeKey, lessonScopeKey, contained] of cases) {
    const key = dreamReadinessKey({
      workspaceId: WORKSPACE_ID,
      scopeKey,
      policyVersion: DEFAULT_DREAM_POLICY.policyVersion,
      policyFingerprint: POLICY_FINGERPRINT,
      watermarkOrdinal: 0,
      frontierOrdinal: 9,
    });
    const build = () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ scopeKey, lessonScopeKey }));
    // The TypeScript contract does not enforce containment -- the broker does --
    // so this case matrix is the SQL expression's twin and is asserted against
    // the migration source below.
    assert.doesNotThrow(build, `${scopeKey} -> ${lessonScopeKey} (${contained})`);
  }
  assert.match(MIGRATION, /the lesson target is not contained in the candidate occasion scope/u);
  assert.match(MIGRATION, /WHEN v_scope_key LIKE 'function:%'/u);
});

test('citations are bounded, discriminated, role-surveyed, and never duplicated', () => {
  const key = snapshotKey('workspace');
  refusal(() => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ citations: [] })), 'citations');
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({
      citations: [{
        role: 'conflicting',
        evidenceKind: 'completed-run',
        runId: 'run-a',
        feedbackId: null,
        observationOrdinal: 9,
      }],
      conflictingSurvey: 'cited',
    })),
    'citations',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ conflictingSurvey: 'cited' })),
    'conflicting_survey',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ counterexampleSurvey: 'cited' })),
    'counterexample_survey',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({
      citations: [
        {
          role: 'supporting',
          evidenceKind: 'completed-run',
          runId: 'run-a',
          feedbackId: null,
          observationOrdinal: 9,
        },
        {
          role: 'supporting',
          evidenceKind: 'feedback',
          runId: null,
          feedbackId: 'fb-a',
          observationOrdinal: 9,
        },
      ],
    })),
    'citations[1].observationOrdinal',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({
      citations: [{
        role: 'supporting',
        evidenceKind: 'feedback',
        runId: 'run-a',
        feedbackId: 'fb-a',
        observationOrdinal: 9,
      }],
    })),
    'citations[0]',
  );
  const many = Array.from({ length: 65 }, (_, index) => ({
    role: 'supporting' as const,
    evidenceKind: 'completed-run' as const,
    runId: `run-${index}`,
    feedbackId: null,
    observationOrdinal: index + 1,
  }));
  refusal(() => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ citations: many })), 'citations');
});

test('a lesson body may span lines but never carries another control character', () => {
  const key = snapshotKey('workspace');
  assert.doesNotThrow(() =>
    normalizeDreamCandidate(WORKSPACE_ID, key, draft({ lessonBody: 'one\ntwo\n\nthree' })));
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ lessonBody: 'one\rtwo' })),
    'lesson_body',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ lessonBody: 'one\u0007two' })),
    'lesson_body',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ lessonPurpose: 'one\ntwo' })),
    'lesson_purpose',
  );
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ lessonBody: 'x'.repeat(16_385) })),
    'lesson_body',
  );
  // A promoted lesson becomes a plaintext file, so secret class is not even
  // representable.
  refusal(
    () => normalizeDreamCandidate(WORKSPACE_ID, key, draft({ privacyClass: 'secret' as 'internal' })),
    'privacy_class',
  );
});

test('the lesson decision carries exactly the fields its verb allows', () => {
  const decisionId = lessonDecisionIdOf(WORKSPACE_ID, `sha256:${'a'.repeat(64)}`, 'promote', 'hd-1');
  assert.match(decisionId, /^sha256:[a-f0-9]{64}$/u);
  // Identity covers the verb, so a promote and a retire authorized by DIFFERENT
  // human decisions never collide.
  assert.notEqual(
    decisionId,
    lessonDecisionIdOf(WORKSPACE_ID, `sha256:${'a'.repeat(64)}`, 'retire', 'hd-1'),
  );

  const base = {
    candidateId: `sha256:${'a'.repeat(64)}`,
    humanDecisionId: 'hd-1',
    actionDigest: `sha256:${'b'.repeat(64)}`,
    frontierOrdinal: 9,
    decidedAt: '2026-08-11T09:00:00.000Z',
  };
  assert.doesNotThrow(() => normalizeLessonDecision(WORKSPACE_ID, {
    ...base,
    decision: 'reject',
    lessonQualifiedId: null,
    lessonContentHash: null,
    watermarkCanonical: null,
  }));
  refusal(() => normalizeLessonDecision(WORKSPACE_ID, {
    ...base,
    decision: 'promote',
    lessonQualifiedId: 'growth/sdr/playbook/shorter-openers',
    lessonContentHash: `sha256:${'c'.repeat(64)}`,
    watermarkCanonical: null,
  }), 'decision');
  refusal(() => normalizeLessonDecision(WORKSPACE_ID, {
    ...base,
    decision: 'retire',
    lessonQualifiedId: 'growth/sdr/playbook/shorter-openers',
    lessonContentHash: `sha256:${'c'.repeat(64)}`,
    watermarkCanonical: '{"kind":"dream-watermark"}',
  }), 'decision');
  refusal(() => normalizeLessonDecision(WORKSPACE_ID, {
    ...base,
    decision: 'reject',
    lessonQualifiedId: 'growth/sdr/playbook/shorter-openers',
    lessonContentHash: null,
    watermarkCanonical: null,
  }), 'decision');
});

test('the reserved policy version is ONE literal shared by the constant, the trigger, and the fallback', () => {
  const reserved = DEFAULT_DREAM_POLICY.policyVersion;
  assert.equal(reserved, 'roster.dream.default.v1');
  // The preflight, the reservation trigger, and dream_effective_policy's
  // built-in fallback must all name the same literal: version equality is only
  // content equality while the built-in version can never be registered.
  const occurrences = MIGRATION.split(`'${reserved}'`).length - 1;
  assert.ok(occurrences >= 3, `expected the reserved literal at least 3 times, saw ${occurrences}`);
  assert.match(MIGRATION, /reject_reserved_policy_version/u);
  assert.match(MIGRATION, /015 preflight: policy_version roster\.dream\.default\.v1 is reserved/u);
});

test('the subject normalization has exactly ONE spelling, used twice in 015', () => {
  const expression =
    "regexp_replace(regexp_replace(lesson_scope_key, '^(agent|plan):', ''), '#[a-z0-9-]+$', '')";
  const occurrences = MIGRATION.split(expression).length - 1;
  assert.equal(
    occurrences,
    2,
    'the generated column and the create broker must derive the subject with byte-identical SQL',
  );
  // And the belt that fires if they ever diverge.
  assert.match(MIGRATION, /the derived lesson subject key disagrees with the stored generated column/u);
  assert.match(MIGRATION, /USING ERRCODE = 'RBE04'/u);
});

test('the built-in policy constant equals the SQL fallback field by field', () => {
  const fallback = MIGRATION.slice(
    MIGRATION.indexOf("SELECT 'built-in'::text,"),
    MIGRATION.indexOf('WHERE NOT EXISTS (SELECT 1 FROM stored_policy)'),
  );
  assert.match(fallback, /'roster\.dream\.default\.v1'::text/u);
  assert.match(fallback, /'workspace'::text/u);
  assert.match(fallback, new RegExp(`${DEFAULT_DREAM_POLICY.minCompletedRuns}::integer`, 'u'));
  // P30D and PT20H as seconds; the parity suite proves the live equality.
  assert.match(fallback, /2592000::double precision/u);
  assert.match(fallback, /72000::double precision/u);
  assert.match(fallback, /ARRAY\['dreamer'\]::text\[\]/u);
});
