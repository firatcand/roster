import { EXIT_ERROR, RosterError } from '../errors.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';
import {
  LESSON_DECISIONS,
  lessonDecisionAction,
  type LessonDecisionVerb,
} from './dream-candidate-contracts.ts';

export type DreamLifecycleErrorCode =
  | 'BRAIN_DREAM_INPUT_INVALID'
  | 'BRAIN_DREAM_IDEMPOTENCY_CONFLICT'
  | 'BRAIN_DREAM_REF_NOT_FOUND'
  | 'BRAIN_DREAM_INTEGRITY'
  | 'BRAIN_DREAM_WATERMARK_REWIND'
  | 'BRAIN_DREAM_SELF_EVIDENCE'
  | 'BRAIN_DREAM_SNAPSHOT_STALE'
  | 'BRAIN_DREAM_DECISION_UNBOUND'
  | 'BRAIN_DREAM_DAMPED'
  | 'BRAIN_DREAM_STATE_INVALID'
  | 'BRAIN_DREAM_PRIVACY_INCOMPATIBLE'
  | 'BRAIN_DREAM_ISOLATION_UNSUPPORTED';

// RBE01-RBE05 keep their 013/014 meanings; RBE06-RBE12 are 015's. An unknown
// SQLSTATE is rethrown RAW rather than mapped to a nearby code, so a genuine
// driver or server fault never masquerades as a lifecycle refusal.
const DREAM_LIFECYCLE_ERROR_CODES: Readonly<Record<string, DreamLifecycleErrorCode>> = {
  RBE01: 'BRAIN_DREAM_INPUT_INVALID',
  RBE02: 'BRAIN_DREAM_IDEMPOTENCY_CONFLICT',
  RBE03: 'BRAIN_DREAM_REF_NOT_FOUND',
  RBE04: 'BRAIN_DREAM_INTEGRITY',
  RBE05: 'BRAIN_DREAM_WATERMARK_REWIND',
  RBE06: 'BRAIN_DREAM_SELF_EVIDENCE',
  RBE07: 'BRAIN_DREAM_SNAPSHOT_STALE',
  RBE08: 'BRAIN_DREAM_DECISION_UNBOUND',
  RBE09: 'BRAIN_DREAM_DAMPED',
  RBE10: 'BRAIN_DREAM_STATE_INVALID',
  RBE11: 'BRAIN_DREAM_PRIVACY_INCOMPATIBLE',
  RBE12: 'BRAIN_DREAM_ISOLATION_UNSUPPORTED',
};

const DREAM_LIFECYCLE_REMEDIES: Readonly<Record<DreamLifecycleErrorCode, string>> = {
  BRAIN_DREAM_INPUT_INVALID: 'Correct the candidate or decision field the message names and retry.',
  BRAIN_DREAM_IDEMPOTENCY_CONFLICT:
    'This identity already holds different bytes. Re-run roster dream candidates list and re-draft.',
  BRAIN_DREAM_REF_NOT_FOUND: 'Record the referenced run, feedback, decision, or candidate first.',
  BRAIN_DREAM_INTEGRITY: 'Run roster brain doctor; the durable Dreamer state disagrees with itself.',
  BRAIN_DREAM_WATERMARK_REWIND:
    'This snapshot was already consumed; re-run roster dream status and re-draft.',
  BRAIN_DREAM_SELF_EVIDENCE: 'Cite evidence independent of the drafter and of the reflection agent.',
  BRAIN_DREAM_SNAPSHOT_STALE: 'Re-run roster dream status and re-draft against the current snapshot.',
  BRAIN_DREAM_DECISION_UNBOUND:
    'Record a human decision bound to this exact candidate, effect, and scope, then retry.',
  BRAIN_DREAM_DAMPED: 'Gather the policy minimum of new evidence before re-proposing this lesson.',
  BRAIN_DREAM_STATE_INVALID:
    'Inspect roster dream candidates list and retire or reject per the message.',
  BRAIN_DREAM_PRIVACY_INCOMPATIBLE: 'Cite evidence compatible with the candidate privacy class.',
  BRAIN_DREAM_ISOLATION_UNSUPPORTED:
    'Re-run the command in a READ COMMITTED transaction (the default); do not wrap Roster broker calls in REPEATABLE READ or SERIALIZABLE.',
};

export function dreamLifecycleError(
  code: DreamLifecycleErrorCode,
  body: string,
  details: Record<string, string> = {},
): RosterError {
  return new RosterError({
    header: 'Brain Dreamer lifecycle refused the operation',
    body,
    remedy: DREAM_LIFECYCLE_REMEDIES[code],
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

export function rethrowDreamLifecycleError(error: unknown): never {
  const sqlState = (error as { code?: unknown }).code;
  if (typeof sqlState === 'string' && sqlState in DREAM_LIFECYCLE_ERROR_CODES) {
    const code = DREAM_LIFECYCLE_ERROR_CODES[sqlState]!;
    throw new RosterError({
      header: 'Brain Dreamer lifecycle refused the operation',
      body: (error as { message?: string }).message
        ?? 'The Dreamer lifecycle broker refused the record.',
      remedy: DREAM_LIFECYCLE_REMEDIES[code],
      exitCode: EXIT_ERROR,
      code,
      details: { sqlstate: sqlState },
    });
  }
  throw error;
}

export type DreamCandidateWriteResult = Readonly<{
  status: 'created' | 'existing';
  candidateId: string;
}>;

export async function recordDreamCandidate(
  pool: VerifiedBrainPool,
  canonical: string,
): Promise<DreamCandidateWriteResult> {
  let rows: { status: string; candidate_id: string }[];
  try {
    rows = (await pool.query<{ status: string; candidate_id: string }>(
      `SELECT status, candidate_id FROM brain_evidence.record_dream_candidate($1)`,
      [canonical],
    )).rows;
  } catch (error) {
    rethrowDreamLifecycleError(error);
  }
  const row = rows![0];
  if (row === undefined || (row.status !== 'created' && row.status !== 'existing')) {
    throw dreamLifecycleError(
      'BRAIN_DREAM_INTEGRITY',
      'The Dreamer candidate broker returned no durable outcome.',
    );
  }
  return Object.freeze({ status: row.status, candidateId: row.candidate_id });
}

export type LessonDecisionResult = Readonly<{
  status: 'created' | 'existing';
  sequence: number;
  subjectSequence: number;
  subjectCurrent: boolean;
  watermarkScopeKey: string | null;
  watermarkSequence: number | null;
}>;

export async function decideLessonCandidate(
  pool: VerifiedBrainPool,
  canonical: string,
): Promise<LessonDecisionResult> {
  type DecisionRow = {
    status: string;
    sequence: number;
    subject_sequence: string;
    subject_current: boolean;
    watermark_scope_key: string | null;
    watermark_sequence: string | null;
  };
  let rows: DecisionRow[];
  try {
    rows = (await pool.query<DecisionRow>(
      `SELECT status, sequence, subject_sequence, subject_current, watermark_scope_key, watermark_sequence
         FROM brain_evidence.decide_lesson_candidate($1)`,
      [canonical],
    )).rows;
  } catch (error) {
    rethrowDreamLifecycleError(error);
  }
  const row = rows![0];
  if (row === undefined || (row.status !== 'created' && row.status !== 'existing')) {
    throw dreamLifecycleError(
      'BRAIN_DREAM_INTEGRITY',
      'The lesson decision broker returned no durable outcome.',
    );
  }
  return Object.freeze({
    status: row.status,
    sequence: Number(row.sequence),
    subjectSequence: Number(row.subject_sequence),
    subjectCurrent: row.subject_current,
    watermarkScopeKey: row.watermark_scope_key,
    watermarkSequence: row.watermark_sequence === null ? null : Number(row.watermark_sequence),
  });
}

export type DreamCandidateState = 'open' | 'promoted' | 'rejected' | 'retired' | 'superseded';

export type DreamCandidateBinding = Readonly<{
  candidateId: string;
  scopeKey: string;
  lessonScopeKey: string;
  lessonAgentKey: string;
  lessonId: string;
  lessonPurpose: string;
  lessonBody: string;
  policyVersion: string;
  watermarkOrdinal: number;
  frontierOrdinal: number;
  consumedCompletedRuns: number;
  consumedFeedbackRecords: number;
  state: DreamCandidateState;
}>;

// The decide verbs read the candidate's SERVER-held identity rather than
// accepting it on the command line: every field the decision and the
// materialization derive from is a column, so a caller cannot name a lesson file
// the candidate does not materialize.
export async function loadDreamCandidate(
  pool: VerifiedBrainPool,
  candidateId: string,
): Promise<DreamCandidateBinding> {
  type Row = {
    candidate_id: string;
    scope_key: string;
    lesson_scope_key: string;
    lesson_agent_key: string;
    lesson_id: string;
    lesson_purpose: string;
    lesson_body: string;
    policy_version: string;
    watermark_ordinal: string;
    frontier_ordinal: string;
    consumed_completed_runs: string;
    consumed_feedback_records: string;
    state: DreamCandidateState;
  };
  const rows = (await pool.query<Row>(
    `SELECT c.candidate_id, c.scope_key, c.lesson_scope_key, c.lesson_agent_key, c.lesson_id,
            c.lesson_purpose, c.lesson_body, c.policy_version,
            c.watermark_ordinal::text AS watermark_ordinal,
            c.frontier_ordinal::text AS frontier_ordinal,
            c.consumed_completed_runs::text AS consumed_completed_runs,
            c.consumed_feedback_records::text AS consumed_feedback_records,
            s.state
       FROM brain_evidence.dream_candidates c
       JOIN brain_evidence.dream_candidate_state s ON s.candidate_id = c.candidate_id
      WHERE c.candidate_id = $1`,
    [candidateId],
  )).rows;
  const row = rows[0];
  if (row === undefined) {
    throw dreamLifecycleError(
      'BRAIN_DREAM_REF_NOT_FOUND',
      `No Dreamer candidate is recorded under '${candidateId}'.`,
      { candidate_id: candidateId },
    );
  }
  return Object.freeze({
    candidateId: row.candidate_id,
    scopeKey: row.scope_key,
    lessonScopeKey: row.lesson_scope_key,
    lessonAgentKey: row.lesson_agent_key,
    lessonId: row.lesson_id,
    lessonPurpose: row.lesson_purpose,
    lessonBody: row.lesson_body,
    policyVersion: row.policy_version,
    watermarkOrdinal: Number(row.watermark_ordinal),
    frontierOrdinal: Number(row.frontier_ordinal),
    consumedCompletedRuns: Number(row.consumed_completed_runs),
    consumedFeedbackRecords: Number(row.consumed_feedback_records),
    state: row.state,
  });
}

// `decided_at` is read from the human decision itself rather than stamped now:
// the decision canonical carries it, so a clock-derived value would make a
// convergent re-run produce different bytes under the same decision identity and
// turn an idempotent replay into an idempotency conflict.
export async function loadHumanDecisionInstant(
  pool: VerifiedBrainPool,
  humanDecisionId: string,
): Promise<string> {
  const rows = (await pool.query<{ decided_at: string }>(
    `SELECT to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
       FROM brain_evidence.human_decisions WHERE decision_id = $1`,
    [humanDecisionId],
  )).rows;
  const row = rows[0];
  if (row === undefined) {
    throw dreamLifecycleError(
      'BRAIN_DREAM_REF_NOT_FOUND',
      `No human decision is recorded under '${humanDecisionId}'.`,
      { human_decision_id: humanDecisionId },
    );
  }
  return row.decided_at;
}

export type DreamCandidateListRow = Readonly<{
  candidate_id: string;
  state: DreamCandidateState;
  scope_key: string;
  lesson_scope_key: string;
  lesson_agent_key: string;
  lesson_id: string;
  lesson_qualified_id: string;
  drafted_by_agent_id: string;
  lesson_purpose: string;
  privacy_class: string;
  policy_version: string;
  readiness_key: string;
  watermark_ordinal: number;
  frontier_ordinal: number;
  recorded_at: string;
  supersedes_candidate_id: string | null;
  // The EXACT `action` a human decision must carry for each verb. The target is
  // a grouped spelling of the candidate digest, not the raw id -- a bare sha256
  // is credential-shaped and the evidence contract refuses it in free text -- so
  // a host that cannot read it here cannot record an acceptable decision at all.
  decision_action: Readonly<Record<LessonDecisionVerb, Readonly<{
    target: string;
    effect: string;
    scope: string;
    params: Readonly<Record<string, never>>;
    action_digest: string;
  }>>>;
  warnings: readonly DreamCandidateWarning[];
}>;

export type DreamCandidateWarning = Readonly<{ code: string; detail: string }>;

type ListRow = {
  candidate_id: string;
  state: DreamCandidateState;
  scope_key: string;
  lesson_scope_key: string;
  lesson_agent_key: string;
  lesson_id: string;
  drafted_by_agent_id: string;
  lesson_purpose: string;
  privacy_class: string;
  policy_version: string;
  readiness_key: string;
  watermark_ordinal: string;
  frontier_ordinal: string;
  recorded_at: string;
  supersedes_candidate_id: string | null;
  sibling_candidate_id: string | null;
  sibling_state: DreamCandidateState | null;
  sibling_same_tuple: boolean | null;
  other_agent_key: string | null;
  other_agent_state: DreamCandidateState | null;
  damping_frontier: string | null;
};

// Deterministic, ORDERED, and non-blocking: every warning is derived from one
// query's own columns, so the same durable state always renders the same text
// and a warning can never fail a command.
const LIST_SQL = `
SELECT s.candidate_id,
       s.state,
       s.scope_key,
       s.lesson_scope_key,
       s.lesson_agent_key,
       s.lesson_id,
       s.drafted_by_agent_id,
       c.lesson_purpose,
       c.privacy_class,
       c.policy_version,
       s.readiness_key,
       s.watermark_ordinal::text AS watermark_ordinal,
       s.frontier_ordinal::text AS frontier_ordinal,
       to_char(s.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
       c.supersedes_candidate_id,
       sibling.candidate_id AS sibling_candidate_id,
       sibling.state AS sibling_state,
       sibling.same_tuple AS sibling_same_tuple,
       other.lesson_agent_key AS other_agent_key,
       other.state AS other_agent_state,
       (SELECT max(d.frontier_ordinal)::text
          FROM brain_evidence.lesson_decisions d
         WHERE d.lesson_agent_key = s.lesson_agent_key
           AND d.lesson_id = s.lesson_id
           AND d.decision IN ('reject', 'retire')) AS damping_frontier
  FROM brain_evidence.dream_candidate_state s
  JOIN brain_evidence.dream_candidates c ON c.candidate_id = s.candidate_id
  LEFT JOIN LATERAL (
    SELECT o.candidate_id, o.state,
           (o.scope_key = s.scope_key AND o.lesson_scope_key = s.lesson_scope_key) AS same_tuple
      FROM brain_evidence.dream_candidate_state o
     WHERE o.lesson_agent_key = s.lesson_agent_key
       AND o.lesson_id = s.lesson_id
       AND o.candidate_id <> s.candidate_id
       AND o.state IN ('open', 'promoted')
     ORDER BY o.state DESC, o.candidate_id
     LIMIT 1
  ) sibling ON true
  LEFT JOIN LATERAL (
    SELECT o.lesson_agent_key, o.state
      FROM brain_evidence.dream_candidate_state o
     WHERE o.lesson_id = s.lesson_id
       AND o.lesson_agent_key <> s.lesson_agent_key
       AND o.state IN ('open', 'promoted')
     ORDER BY o.lesson_agent_key
     LIMIT 1
  ) other ON true
 WHERE ($1::text IS NULL OR s.state = $1::text)
   AND ($2::text IS NULL OR s.lesson_agent_key = $2::text)
   AND ($4::text IS NULL OR s.candidate_id = $4::text)
   AND ($5::text IS NULL OR s.readiness_key = $5::text)
 ORDER BY s.recorded_at DESC, s.candidate_id
 LIMIT $3::integer
`;

function composeWarnings(row: ListRow): DreamCandidateWarning[] {
  const warnings: DreamCandidateWarning[] = [];
  if (row.sibling_candidate_id !== null) {
    const remedy = row.sibling_state === 'open' && row.sibling_same_tuple === true
      ? 'supersede it with roster dream candidates create --supersedes'
      : row.sibling_state === 'promoted'
        ? 'retire the promoted one first'
        : 'reject one of the siblings';
    warnings.push({
      code: 'SAME_LESSON_FILE',
      detail: `this candidate targets the same playbook file as ${row.sibling_candidate_id}`
        + ` (state ${row.sibling_state}); both cannot be promoted — ${remedy}.`,
    });
  }
  if (row.other_agent_key !== null) {
    warnings.push({
      code: 'SAME_LESSON_ID_OTHER_AGENT',
      detail: `lesson id '${row.lesson_id}' is also claimed by ${row.other_agent_key}`
        + ` (state ${row.other_agent_state}); these are different files and the narrower scope wins at selection.`,
    });
  }
  if (row.damping_frontier !== null) {
    warnings.push({
      code: 'SUBJECT_PREVIOUSLY_DECIDED_AGAINST',
      detail: `this lesson was rejected or retired at observation ${row.damping_frontier};`
        + ' a re-create needs the policy minimum of newer evidence.',
    });
  }
  return warnings;
}

export function decisionActionsFor(
  candidateId: string,
  lessonScopeKey: string,
): DreamCandidateListRow['decision_action'] {
  return Object.freeze(Object.fromEntries(
    LESSON_DECISIONS.map((verb) => [verb, lessonDecisionAction(verb, candidateId, lessonScopeKey)]),
  )) as DreamCandidateListRow['decision_action'];
}

export async function listDreamCandidates(
  pool: VerifiedBrainPool,
  filter: {
    state?: string;
    lessonAgentKey?: string;
    candidateId?: string;
    readinessKey?: string;
    limit?: number;
  } = {},
): Promise<readonly DreamCandidateListRow[]> {
  let rows: ListRow[];
  try {
    rows = (await pool.query<ListRow>(LIST_SQL, [
      filter.state ?? null,
      filter.lessonAgentKey ?? null,
      filter.limit ?? 50,
      filter.candidateId ?? null,
      filter.readinessKey ?? null,
    ])).rows;
  } catch (error) {
    rethrowDreamLifecycleError(error);
  }
  return Object.freeze(rows!.map((row) => Object.freeze({
    candidate_id: row.candidate_id,
    state: row.state,
    scope_key: row.scope_key,
    lesson_scope_key: row.lesson_scope_key,
    lesson_agent_key: row.lesson_agent_key,
    lesson_id: row.lesson_id,
    lesson_qualified_id: `${row.lesson_agent_key}/playbook/${row.lesson_id}`,
    drafted_by_agent_id: row.drafted_by_agent_id,
    lesson_purpose: row.lesson_purpose,
    privacy_class: row.privacy_class,
    policy_version: row.policy_version,
    readiness_key: row.readiness_key,
    watermark_ordinal: Number(row.watermark_ordinal),
    frontier_ordinal: Number(row.frontier_ordinal),
    recorded_at: row.recorded_at,
    supersedes_candidate_id: row.supersedes_candidate_id,
    decision_action: decisionActionsFor(row.candidate_id, row.lesson_scope_key),
    warnings: Object.freeze(composeWarnings(row)),
  })));
}

export type LessonGovernor = Readonly<{
  candidateId: string;
  decision: LessonDecisionVerb;
  subjectSequence: number;
  lessonAgentKey: string;
  lessonId: string;
  lessonContentHash: string;
  lessonQualifiedId: string;
}>;

// The report-only governor listing the doctor audit walks: one row per
// materialized subject, taken at max(subject_sequence). Deliberately unfenced --
// it diagnoses and never mutates, so a torn read can only mis-report transiently.
export async function listLessonGovernors(
  pool: VerifiedBrainPool,
): Promise<readonly LessonGovernor[]> {
  type Row = {
    candidate_id: string;
    decision: LessonDecisionVerb;
    subject_sequence: string;
    lesson_agent_key: string;
    lesson_id: string;
    lesson_content_hash: string;
    lesson_qualified_id: string;
  };
  const rows = (await pool.query<Row>(
    `SELECT DISTINCT ON (d.lesson_agent_key, d.lesson_id)
            d.candidate_id, d.decision, d.subject_sequence::text AS subject_sequence,
            d.lesson_agent_key, d.lesson_id, d.lesson_content_hash, d.lesson_qualified_id
       FROM brain_evidence.lesson_decisions d
      WHERE d.decision IN ('promote', 'retire')
      ORDER BY d.lesson_agent_key, d.lesson_id, d.subject_sequence DESC`,
  )).rows;
  return Object.freeze(rows.map((row) => Object.freeze({
    candidateId: row.candidate_id,
    decision: row.decision,
    subjectSequence: Number(row.subject_sequence),
    lessonAgentKey: row.lesson_agent_key,
    lessonId: row.lesson_id,
    lessonContentHash: row.lesson_content_hash,
    lessonQualifiedId: row.lesson_qualified_id,
  })));
}

// The governor's own target scope, needed by the drift audit to tell a
// registration under the wrong scope from a correct one.
export async function loadGovernorTargetScopes(
  pool: VerifiedBrainPool,
  candidateIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (candidateIds.length === 0) return new Map();
  const rows = (await pool.query<{ candidate_id: string; lesson_scope_key: string }>(
    `SELECT candidate_id, lesson_scope_key FROM brain_evidence.dream_candidates
      WHERE candidate_id = ANY ($1::text[])`,
    [[...candidateIds]],
  )).rows;
  return new Map(rows.map((row) => [row.candidate_id, row.lesson_scope_key]));
}
