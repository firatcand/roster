import { EXIT_ERROR, RosterError } from '../errors.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';
import {
  DEFAULT_DREAM_POLICY,
  DREAM_SCHEMA_VERSION,
  brainNotConfiguredReadiness,
  dreamDurationSeconds,
  dreamDurationText,
  dreamPolicyCanonical,
  dreamPolicyFingerprint,
  dreamReadinessKey,
  dreamReadinessReasons,
  dreamScopeResolutionChain,
  dreamWatermarkCanonical,
  type DreamPolicy,
  type DreamPolicyRegistration,
  type DreamPolicySource,
  type DreamReadinessResult,
  type DreamScope,
  type DreamWatermarkAdvance,
} from './dream-contracts.ts';

export { brainNotConfiguredReadiness };

export type DreamErrorCode =
  | 'BRAIN_DREAM_INPUT_INVALID'
  | 'BRAIN_DREAM_IDEMPOTENCY_CONFLICT'
  | 'BRAIN_DREAM_REF_NOT_FOUND'
  | 'BRAIN_DREAM_INTEGRITY'
  | 'BRAIN_DREAM_WATERMARK_REWIND';

const DREAM_ERROR_CODES: Readonly<Record<string, DreamErrorCode>> = {
  RBE01: 'BRAIN_DREAM_INPUT_INVALID',
  RBE02: 'BRAIN_DREAM_IDEMPOTENCY_CONFLICT',
  RBE03: 'BRAIN_DREAM_REF_NOT_FOUND',
  RBE04: 'BRAIN_DREAM_INTEGRITY',
  RBE05: 'BRAIN_DREAM_WATERMARK_REWIND',
};

export function dreamError(code: DreamErrorCode, body: string): RosterError {
  return new RosterError({
    header: 'Brain Dreamer state refused the operation',
    body,
    remedy: 'Inspect the durable Dreamer row and retry with byte-identical portable evidence.',
    exitCode: EXIT_ERROR,
    code,
    details: {},
  });
}

function rethrowDreamError(error: unknown): never {
  const sqlState = (error as { code?: unknown }).code;
  if (typeof sqlState === 'string' && sqlState in DREAM_ERROR_CODES) {
    throw new RosterError({
      header: 'Brain Dreamer state refused the operation',
      body: (error as { message?: string }).message ?? 'The Dreamer state function refused the record.',
      remedy: 'Inspect the durable Dreamer row and retry with byte-identical portable evidence.',
      exitCode: EXIT_ERROR,
      code: DREAM_ERROR_CODES[sqlState]!,
      details: { sqlstate: sqlState },
    });
  }
  throw error;
}

type ReadinessRow = {
  evaluated_at: string;
  policy_source: DreamPolicySource;
  policy_version: string;
  policy_scope_key: string;
  min_completed_runs: string;
  min_feedback_records: string;
  min_signal_mix: string;
  evidence_window_seconds: string;
  cooldown_seconds: string;
  excluded_agent_ids: string[];
  watermark_sequence: string;
  watermark_ordinal: string;
  watermark_reason: string | null;
  watermark_advanced_at: string | null;
  watermark_policy_version: string | null;
  frontier_ordinal: string;
  eligible_observations: string;
  completed_runs: string;
  feedback_records: string;
  signal_mix: string;
  outcome_succeeded: string;
  outcome_failed: string;
  outcome_partial: string;
  outcome_aborted: string;
  signal_positive: string;
  signal_negative: string;
  signal_mixed: string;
  window_start: string;
  window_end: string;
  cooldown_active: boolean;
  cooldown_until: string | null;
  cooldown_remaining_seconds: string | null;
};

// ONE statement, ONE snapshot, ZERO writes.
//
// Every step -- capture instant, resolve the specificity-ordered policy, read the
// scope watermark, scan eligible observations over BOTH evidence kinds, count,
// and take the frontier maximum -- happens inside this single CTE, so a
// concurrent evidence write can never land between two of them. `dream status`
// never writes: an advancing read would recreate v1's loss-of-eligibility bug
// (host reads `due`, the read advances, the host crashes before invoking).
//
// Feedback carries no scope columns of its own, so every observation is joined
// to ITS RUN -- directly for a completed-run observation, through the NOT NULL
// feedback.run_id foreign key for a feedback observation. Feedback therefore
// inherits scope AND exclusion from its run while keeping its own recorded_at
// and its own ordinal for the window and the frontier.
const READINESS_SQL = `
WITH captured AS (
  SELECT now() AS evaluated_at
), requested AS (
  SELECT $1::text AS scope_key,
         $2::text AS scope_kind,
         $3::text AS function_id,
         $4::text AS agent_id,
         $5::text AS plan_id
), policy_scopes AS (
  SELECT chain.key, chain.rank
    FROM unnest($6::text[]) WITH ORDINALITY AS chain(key, rank)
), stored_policy AS (
  SELECT resolved.*
    FROM policy_scopes c
    JOIN LATERAL (
      SELECT 'brain'::text AS policy_source,
             dp.policy_version,
             dp.scope_key AS policy_scope_key,
             dp.min_completed_runs,
             dp.min_feedback_records,
             dp.min_signal_mix,
             dp.evidence_window,
             dp.cooldown,
             dp.excluded_agent_ids
        FROM brain_evidence.dream_policies dp
       WHERE dp.scope_key = c.key
       ORDER BY dp.recorded_at DESC, dp.policy_version DESC
       LIMIT 1
    ) AS resolved ON true
   ORDER BY c.rank
   LIMIT 1
), policy AS (
  SELECT * FROM stored_policy
   UNION ALL
  SELECT 'built-in'::text,
         $7::text,
         $8::text,
         $9::integer,
         $10::integer,
         $11::integer,
         make_interval(secs => $12::double precision),
         make_interval(secs => $13::double precision),
         $14::text[]
   WHERE NOT EXISTS (SELECT 1 FROM stored_policy)
), watermark AS (
  SELECT w.sequence, w.cursor_ordinal, w.reason, w.advanced_at, w.policy_version
    FROM brain_evidence.dream_watermarks w, requested r
   WHERE w.scope_key = r.scope_key
   ORDER BY w.sequence DESC
   LIMIT 1
), floor_ordinal AS (
  SELECT coalesce((SELECT cursor_ordinal FROM watermark), 0) AS ordinal
), eligible AS (
  SELECT o.ordinal, o.evidence_kind, r.outcome, f.signal
    FROM brain_evidence.evidence_observations o
    LEFT JOIN brain_evidence.feedback f
      ON o.evidence_kind = 'feedback' AND f.feedback_id = o.evidence_id
    JOIN brain_evidence.completed_runs r
      ON r.run_id = CASE WHEN o.evidence_kind = 'completed-run' THEN o.evidence_id ELSE f.run_id END
   CROSS JOIN captured n
   CROSS JOIN policy p
   CROSS JOIN requested q
   CROSS JOIN floor_ordinal fl
   WHERE o.ordinal > fl.ordinal
     AND o.recorded_at > n.evaluated_at - p.evidence_window
     AND o.recorded_at <= n.evaluated_at
     AND (
       q.scope_kind = 'workspace'
       OR (q.scope_kind = 'function' AND r.function_id = q.function_id)
       OR (q.scope_kind = 'agent' AND r.function_id = q.function_id AND r.agent_id = q.agent_id)
       OR (q.scope_kind = 'plan' AND r.function_id = q.function_id
           AND r.agent_id = q.agent_id AND r.plan_id = q.plan_id)
     )
     AND NOT (r.agent_id = ANY (p.excluded_agent_ids))
), counted AS (
  SELECT coalesce(max(e.ordinal), 0) AS frontier_ordinal,
         count(*) AS eligible_observations,
         count(*) FILTER (WHERE e.evidence_kind = 'completed-run') AS completed_runs,
         count(*) FILTER (WHERE e.evidence_kind = 'feedback') AS feedback_records,
         count(*) FILTER (
           WHERE (e.evidence_kind = 'feedback' AND e.signal IN ('negative', 'mixed'))
              OR (e.evidence_kind = 'completed-run' AND e.outcome IN ('failed', 'partial', 'aborted'))
         ) AS signal_mix,
         count(*) FILTER (WHERE e.evidence_kind = 'completed-run' AND e.outcome = 'succeeded') AS outcome_succeeded,
         count(*) FILTER (WHERE e.evidence_kind = 'completed-run' AND e.outcome = 'failed') AS outcome_failed,
         count(*) FILTER (WHERE e.evidence_kind = 'completed-run' AND e.outcome = 'partial') AS outcome_partial,
         count(*) FILTER (WHERE e.evidence_kind = 'completed-run' AND e.outcome = 'aborted') AS outcome_aborted,
         count(*) FILTER (WHERE e.evidence_kind = 'feedback' AND e.signal = 'positive') AS signal_positive,
         count(*) FILTER (WHERE e.evidence_kind = 'feedback' AND e.signal = 'negative') AS signal_negative,
         count(*) FILTER (WHERE e.evidence_kind = 'feedback' AND e.signal = 'mixed') AS signal_mixed
    FROM eligible e
)
SELECT to_char(n.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS evaluated_at,
       p.policy_source,
       p.policy_version,
       p.policy_scope_key,
       p.min_completed_runs::text AS min_completed_runs,
       p.min_feedback_records::text AS min_feedback_records,
       p.min_signal_mix::text AS min_signal_mix,
       (extract(epoch FROM p.evidence_window)::bigint)::text AS evidence_window_seconds,
       (extract(epoch FROM p.cooldown)::bigint)::text AS cooldown_seconds,
       p.excluded_agent_ids,
       coalesce((SELECT sequence FROM watermark), 0)::text AS watermark_sequence,
       (SELECT ordinal FROM floor_ordinal)::text AS watermark_ordinal,
       (SELECT reason FROM watermark) AS watermark_reason,
       (SELECT to_char(advanced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM watermark)
         AS watermark_advanced_at,
       (SELECT policy_version FROM watermark) AS watermark_policy_version,
       c.frontier_ordinal::text AS frontier_ordinal,
       c.eligible_observations::text AS eligible_observations,
       c.completed_runs::text AS completed_runs,
       c.feedback_records::text AS feedback_records,
       c.signal_mix::text AS signal_mix,
       c.outcome_succeeded::text AS outcome_succeeded,
       c.outcome_failed::text AS outcome_failed,
       c.outcome_partial::text AS outcome_partial,
       c.outcome_aborted::text AS outcome_aborted,
       c.signal_positive::text AS signal_positive,
       c.signal_negative::text AS signal_negative,
       c.signal_mixed::text AS signal_mixed,
       to_char((n.evaluated_at - p.evidence_window) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AS window_start,
       to_char(n.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS window_end,
       coalesce(
         (SELECT n.evaluated_at < w.advanced_at + p.cooldown FROM watermark w), false
       ) AS cooldown_active,
       (SELECT to_char((w.advanced_at + p.cooldown) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          FROM watermark w WHERE n.evaluated_at < w.advanced_at + p.cooldown) AS cooldown_until,
       (SELECT (extract(epoch FROM (w.advanced_at + p.cooldown - n.evaluated_at))::bigint)::text
          FROM watermark w WHERE n.evaluated_at < w.advanced_at + p.cooldown)
         AS cooldown_remaining_seconds
  FROM captured n, policy p, counted c
`;

export async function computeDreamReadiness(
  pool: VerifiedBrainPool,
  scope: DreamScope,
): Promise<DreamReadinessResult> {
  const fallback = DEFAULT_DREAM_POLICY;
  const rows = (await pool.query<ReadinessRow>(READINESS_SQL, [
    scope.key,
    scope.kind,
    scope.functionId,
    scope.agentId,
    scope.planId,
    [...dreamScopeResolutionChain(scope)],
    fallback.policyVersion,
    fallback.scopeKey,
    fallback.minCompletedRuns,
    fallback.minFeedbackRecords,
    fallback.minSignalMix,
    dreamDurationSeconds(fallback.evidenceWindow),
    dreamDurationSeconds(fallback.cooldown),
    [...fallback.excludedAgentIds],
  ])).rows;
  const row = rows[0];
  if (row === undefined) {
    throw dreamError('BRAIN_DREAM_INTEGRITY', 'The Dreamer readiness query returned no snapshot.');
  }
  return composeDreamReadiness(pool.authority.workspaceId, scope, row);
}

function composeDreamReadiness(
  workspaceId: string,
  scope: DreamScope,
  row: ReadinessRow,
): DreamReadinessResult {
  const policy: DreamPolicy = {
    policyVersion: row.policy_version,
    scopeKey: row.policy_scope_key,
    minCompletedRuns: Number(row.min_completed_runs),
    minFeedbackRecords: Number(row.min_feedback_records),
    minSignalMix: Number(row.min_signal_mix),
    evidenceWindow: dreamDurationText(Number(row.evidence_window_seconds)),
    cooldown: dreamDurationText(Number(row.cooldown_seconds)),
    excludedAgentIds: Object.freeze([...row.excluded_agent_ids]),
  };
  const watermarkOrdinal = Number(row.watermark_ordinal);
  const watermarkSequence = Number(row.watermark_sequence);
  const frontierOrdinal = Number(row.frontier_ordinal);
  const eligibleObservations = Number(row.eligible_observations);
  const completedRuns = Number(row.completed_runs);
  const feedbackRecords = Number(row.feedback_records);
  const signalMix = Number(row.signal_mix);
  const cooldownActive = row.cooldown_active;
  const status = completedRuns >= policy.minCompletedRuns
    && feedbackRecords >= policy.minFeedbackRecords
    && signalMix >= policy.minSignalMix
    && !cooldownActive
    ? 'due'
    : 'not_due';
  const result: DreamReadinessResult = {
    ok: true,
    schema_version: DREAM_SCHEMA_VERSION,
    status,
    readiness_key: dreamReadinessKey({
      workspaceId,
      scopeKey: scope.key,
      policyVersion: policy.policyVersion,
      policyFingerprint: dreamPolicyFingerprint(policy),
      watermarkOrdinal,
      frontierOrdinal,
    }),
    evaluated_at: row.evaluated_at,
    workspace_id: workspaceId,
    scope: {
      key: scope.key,
      kind: scope.kind,
      function_id: scope.functionId,
      agent_id: scope.agentId,
      plan_id: scope.planId,
    },
    policy: {
      version: policy.policyVersion,
      source: row.policy_source,
      scope_key: policy.scopeKey,
      fingerprint: dreamPolicyFingerprint(policy),
      min_completed_runs: policy.minCompletedRuns,
      min_feedback_records: policy.minFeedbackRecords,
      min_signal_mix: policy.minSignalMix,
      evidence_window: policy.evidenceWindow,
      cooldown: policy.cooldown,
      excluded_agent_ids: [...policy.excludedAgentIds],
    },
    watermark: {
      state: watermarkSequence === 0 ? 'genesis' : 'advanced',
      sequence: watermarkSequence,
      ordinal: watermarkOrdinal,
      reason: row.watermark_reason,
      advanced_at: row.watermark_advanced_at,
      policy_version: row.watermark_policy_version,
    },
    // eligible_observations equals completed_runs + feedback_records by
    // construction; it is emitted so #358's snapshot-bound tuple is
    // self-checking against the counts it is derived from.
    frontier: { ordinal: frontierOrdinal, eligible_observations: eligibleObservations },
    evidence: {
      window_start: row.window_start,
      window_end: row.window_end,
      // The TIME bound is always `evaluated_at - evidence_window`. The label
      // reports whether an ORDINAL floor is additionally in force, which is what
      // a watermark contributes -- a watermark is not a timestamp bound, so
      // reporting its advanced_at as window_start would misstate the eligible set.
      window_start_bound: watermarkOrdinal > 0 ? 'watermark' : 'evidence-window',
      completed_runs: completedRuns,
      feedback_records: feedbackRecords,
      signal_mix: signalMix,
      outcomes: {
        succeeded: Number(row.outcome_succeeded),
        failed: Number(row.outcome_failed),
        partial: Number(row.outcome_partial),
        aborted: Number(row.outcome_aborted),
      },
      signals: {
        positive: Number(row.signal_positive),
        negative: Number(row.signal_negative),
        mixed: Number(row.signal_mixed),
      },
    },
    cooldown: {
      active: cooldownActive,
      until: row.cooldown_until,
      remaining: row.cooldown_remaining_seconds === null
        ? null
        : dreamDurationText(Number(row.cooldown_remaining_seconds)),
    },
    reasons: dreamReadinessReasons({
      eligibleObservations,
      completedRuns,
      feedbackRecords,
      signalMix,
      policy,
      cooldownActive,
    }),
  };
  return Object.freeze(result);
}

export type DreamWriteResult = Readonly<{ status: 'created' | 'existing' }>;

export type DreamPolicyWriteResult = DreamWriteResult & Readonly<{ policyVersion: string }>;

export type DreamWatermarkWriteResult = DreamWriteResult & Readonly<{
  scopeKey: string;
  sequence: number;
}>;

// ADMIN pool only. The runtime role holds EXECUTE on all four #356 record
// brokers and can therefore fabricate evidence; letting it also register the
// policy would let an agent lower the bar it must clear.
export async function registerDreamPolicy(
  pool: VerifiedBrainPool,
  registration: DreamPolicyRegistration,
): Promise<DreamPolicyWriteResult> {
  const canonical = dreamPolicyCanonical(registration);
  let rows: { status: string; policy_version: string }[];
  try {
    rows = (await pool.query<{ status: string; policy_version: string }>(
      `SELECT status, policy_version FROM brain_evidence.register_dream_policy($1)`,
      [canonical],
    )).rows;
  } catch (error) {
    rethrowDreamError(error);
  }
  const row = rows![0];
  if (row === undefined || (row.status !== 'created' && row.status !== 'existing')) {
    throw dreamError('BRAIN_DREAM_INTEGRITY', 'The Dreamer policy writer returned no durable outcome.');
  }
  return Object.freeze({ status: row.status, policyVersion: row.policy_version });
}

// ADMIN pool only, and deliberately unbound to a promotion identity: #358 owns
// the runtime grant plus the scope-eligibility, frontier-equality, and
// promotion-accompaniment checks that must precede it.
export async function advanceDreamWatermark(
  pool: VerifiedBrainPool,
  advance: DreamWatermarkAdvance,
): Promise<DreamWatermarkWriteResult> {
  const canonical = dreamWatermarkCanonical(advance);
  let rows: { status: string; scope_key: string; sequence: string }[];
  try {
    rows = (await pool.query<{ status: string; scope_key: string; sequence: string }>(
      `SELECT status, scope_key, sequence FROM brain_evidence.advance_dream_watermark($1)`,
      [canonical],
    )).rows;
  } catch (error) {
    rethrowDreamError(error);
  }
  const row = rows![0];
  if (row === undefined || (row.status !== 'created' && row.status !== 'existing')) {
    throw dreamError('BRAIN_DREAM_INTEGRITY', 'The Dreamer watermark writer returned no durable outcome.');
  }
  return Object.freeze({
    status: row.status,
    scopeKey: row.scope_key,
    sequence: Number(row.sequence),
  });
}
