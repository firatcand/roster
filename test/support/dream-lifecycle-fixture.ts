import { evidenceActionDigest } from '../../src/lib/brain/evidence-identity.ts';
import { recordFeedback, recordCompletedRun, recordHumanDecision } from '../../src/lib/brain/evidence-store.ts';
import { computeDreamReadiness } from '../../src/lib/brain/dream-readiness.ts';
import {
  canonicalizeDreamScope,
  dreamWatermarkCanonical,
  type DreamReadinessResult,
} from '../../src/lib/brain/dream-contracts.ts';
import {
  lessonDecisionAction,
  normalizeDreamCandidate,
  normalizeLessonDecision,
  type DreamCandidateCitation,
  type DreamCandidateDraft,
  type LessonDecisionVerb,
} from '../../src/lib/brain/dream-candidate-contracts.ts';
import {
  decideLessonCandidate,
  recordDreamCandidate,
  type LessonDecisionResult,
} from '../../src/lib/brain/dream-candidates.ts';
import type { VerifiedBrainPool } from '../../src/lib/brain/workspace-authority.ts';
import { SEED_ACTOR, seedFeedbackInput, seedRunInput, type EvidenceFixture } from './brain-evidence-fixture.ts';

export const DREAM_ACTOR = Object.freeze({
  actorId: 'dreamer-session',
  assurance: 'host-attested',
  host: 'claude',
  sessionId: 'dream-lifecycle',
} as const);

export async function seedRuns(
  fixture: EvidenceFixture,
  count: number,
  overrides: Parameters<typeof seedRunInput>[1] = {},
  prefix = 'run',
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const runId = `${prefix}-${index}`;
    await recordCompletedRun(fixture.admin, seedRunInput(runId, overrides));
    ids.push(runId);
  }
  return ids;
}

export async function seedFeedback(
  fixture: EvidenceFixture,
  feedbackId: string,
  runId: string,
  overrides: Parameters<typeof seedFeedbackInput>[2] = {},
): Promise<string> {
  await recordFeedback(fixture.admin, seedFeedbackInput(feedbackId, runId, overrides));
  return feedbackId;
}

export async function observationOrdinal(
  pool: VerifiedBrainPool,
  evidenceKind: 'completed-run' | 'feedback',
  evidenceId: string,
): Promise<number> {
  const rows = (await pool.query<{ ordinal: string }>(
    `SELECT ordinal::text AS ordinal FROM brain_evidence.evidence_observations
      WHERE evidence_kind = $1 AND evidence_id = $2`,
    [evidenceKind, evidenceId],
  )).rows;
  if (rows[0] === undefined) throw new Error(`no observation for ${evidenceKind}:${evidenceId}`);
  return Number(rows[0].ordinal);
}

export async function readiness(
  fixture: EvidenceFixture,
  scopeKey = 'workspace',
): Promise<DreamReadinessResult> {
  return await computeDreamReadiness(fixture.admin, canonicalizeDreamScope(scopeKey));
}

export type DraftOverrides = Partial<DreamCandidateDraft> & {
  citations?: readonly DreamCandidateCitation[];
};

export function draftFrom(
  snapshot: DreamReadinessResult,
  citations: readonly DreamCandidateCitation[],
  overrides: DraftOverrides = {},
): DreamCandidateDraft {
  return {
    scopeKey: snapshot.scope.key,
    lessonScopeKey: 'agent:social-media/manager',
    lessonId: 'shorter-openers',
    draftedByAgentId: 'dreamer',
    lessonPurpose: 'Open with one sentence about the prospect.',
    lessonBody: 'Lead with the prospect.\n\nKeep the first message under 60 words.',
    expectedEffect: 'Reply rate rises on cold outbound.',
    conflictingSurvey: 'none-found',
    counterexampleSurvey: 'none-found',
    policyVersion: snapshot.policy.version,
    policyFingerprint: snapshot.policy.fingerprint,
    watermarkOrdinal: snapshot.watermark.ordinal,
    frontierOrdinal: snapshot.frontier.ordinal,
    consumedCompletedRuns: snapshot.evidence.completed_runs,
    consumedFeedbackRecords: snapshot.evidence.feedback_records,
    supersedesCandidateId: null,
    privacyClass: 'internal',
    citations,
    actor: DREAM_ACTOR,
    provenance: {},
    ...overrides,
  } as DreamCandidateDraft;
}

export async function createCandidate(
  fixture: EvidenceFixture,
  snapshot: DreamReadinessResult,
  citations: readonly DreamCandidateCitation[],
  overrides: DraftOverrides = {},
): Promise<{ candidateId: string; canonical: string; status: 'created' | 'existing' }> {
  const draft = draftFrom(snapshot, citations, overrides);
  const normalized = normalizeDreamCandidate(fixture.workspaceId, snapshot.readiness_key, draft);
  const result = await recordDreamCandidate(fixture.runtime, normalized.canonical);
  return { candidateId: result.candidateId, canonical: normalized.canonical, status: result.status };
}

export async function recordDecision(
  fixture: EvidenceFixture,
  decisionId: string,
  verb: LessonDecisionVerb,
  candidateId: string,
  lessonScopeKey: string,
  answer: 'approved' | 'rejected' = verb === 'reject' ? 'rejected' : 'approved',
): Promise<{ decisionId: string; actionDigest: string }> {
  // The CLI hands a host `target/effect/scope/params` PLUS the digest of that
  // action; only the first four are the action itself, and the evidence contract
  // refuses any fifth key.
  const published = lessonDecisionAction(verb, candidateId, lessonScopeKey);
  const action = {
    target: published.target,
    effect: published.effect,
    scope: published.scope,
    params: {},
  };
  await recordHumanDecision(fixture.admin, {
    decisionId,
    action,
    actionSummary: `${verb} the lesson candidate for ${lessonScopeKey}`,
    requestedDecision: 'approval',
    answer,
    privacy: 'internal',
    trust: 'host-asserted',
    actor: {
      actorId: 'human',
      assurance: 'human-confirmed',
      decisionId,
      actionDigest: published.action_digest,
    },
    decidedAt: '2026-08-11T09:00:00.000Z',
    hostProvenance: { host: 'claude' },
  });
  // The digest the CLI publishes and the digest of the action just recorded are
  // the same value by construction; asserting it here is what keeps them so.
  if (published.action_digest !== evidenceActionDigest(action)) {
    throw new Error('the published action digest does not match the recorded action');
  }
  return { decisionId, actionDigest: published.action_digest };
}

export async function decidedAtOf(
  pool: VerifiedBrainPool,
  decisionId: string,
): Promise<string> {
  const rows = (await pool.query<{ decided_at: string }>(
    `SELECT to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
       FROM brain_evidence.human_decisions WHERE decision_id = $1`,
    [decisionId],
  )).rows;
  // A decision that does not exist yet still has to REACH the broker, which is
  // the layer that refuses it: returning a fixed instant keeps the CLI-shaped
  // helper from throwing a TypeError before the durable refusal can happen.
  return rows[0]?.decided_at ?? '2026-08-11T09:00:00.000Z';
}

export type CandidateFacts = Readonly<{
  scopeKey: string;
  lessonScopeKey: string;
  lessonAgentKey: string;
  lessonId: string;
  policyVersion: string;
  frontierOrdinal: number;
  consumedCompletedRuns: number;
  consumedFeedbackRecords: number;
}>;

export async function candidateFacts(
  pool: VerifiedBrainPool,
  candidateId: string,
): Promise<CandidateFacts> {
  const rows = (await pool.query<{
    scope_key: string;
    lesson_scope_key: string;
    lesson_agent_key: string;
    lesson_id: string;
    policy_version: string;
    frontier_ordinal: string;
    consumed_completed_runs: string;
    consumed_feedback_records: string;
  }>(
    `SELECT scope_key, lesson_scope_key, lesson_agent_key, lesson_id, policy_version,
            frontier_ordinal::text AS frontier_ordinal,
            consumed_completed_runs::text AS consumed_completed_runs,
            consumed_feedback_records::text AS consumed_feedback_records
       FROM brain_evidence.dream_candidates WHERE candidate_id = $1`,
    [candidateId],
  )).rows;
  const row = rows[0]!;
  return Object.freeze({
    scopeKey: row.scope_key,
    lessonScopeKey: row.lesson_scope_key,
    lessonAgentKey: row.lesson_agent_key,
    lessonId: row.lesson_id,
    policyVersion: row.policy_version,
    frontierOrdinal: Number(row.frontier_ordinal),
    consumedCompletedRuns: Number(row.consumed_completed_runs),
    consumedFeedbackRecords: Number(row.consumed_feedback_records),
  });
}

// The decision canonical the CLI builds, assembled from SERVER-held candidate
// facts exactly as `roster dream candidates <verb>` does.
export async function decide(
  fixture: EvidenceFixture,
  verb: LessonDecisionVerb,
  candidateId: string,
  decision: { decisionId: string; actionDigest: string },
  options: { contentHash?: string; pool?: VerifiedBrainPool } = {},
): Promise<LessonDecisionResult> {
  const facts = await candidateFacts(fixture.admin, candidateId);
  const decidedAt = await decidedAtOf(fixture.admin, decision.decisionId);
  const canonical = normalizeLessonDecision(fixture.workspaceId, {
    decision: verb,
    candidateId,
    humanDecisionId: decision.decisionId,
    actionDigest: decision.actionDigest,
    frontierOrdinal: facts.frontierOrdinal,
    decidedAt,
    lessonQualifiedId: verb === 'reject'
      ? null
      : `${facts.lessonAgentKey}/playbook/${facts.lessonId}`,
    lessonContentHash: verb === 'reject'
      ? null
      : options.contentHash ?? `sha256:${'c'.repeat(64)}`,
    watermarkCanonical: verb === 'promote'
      ? dreamWatermarkCanonical({
        scopeKey: facts.scopeKey,
        cursorOrdinal: facts.frontierOrdinal,
        policyVersion: facts.policyVersion,
        reason: 'promotion',
        consumedCompletedRuns: facts.consumedCompletedRuns,
        consumedFeedbackRecords: facts.consumedFeedbackRecords,
        actorAssurance: 'human-confirmed',
      })
      : null,
  }).canonical;
  return await decideLessonCandidate(options.pool ?? fixture.runtime, canonical);
}

export { SEED_ACTOR };
