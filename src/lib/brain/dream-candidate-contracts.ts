import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import { assertRecordId, qualifiedRecordId, type WorkspaceScope } from '../workspace-layout.ts';
import { canonicalSourceJson, normalizeSourceActor, type SourceActorInput, type SourceJsonObject, type SourceJsonValue } from './source-contracts.ts';
import { looksSecretShaped } from './evidence-contracts.ts';
import { evidenceDigest } from './evidence-identity.ts';
import { DREAM_SCHEMA_VERSION, DREAM_SCOPE_KEY_PATTERN, dreamReadinessKey } from './dream-contracts.ts';

export const DREAM_CANDIDATE_DOMAIN = 'roster.brain.dream.candidate.v1';
export const DREAM_CANDIDATE_CONTENT_DOMAIN = 'roster.brain.dream.candidate-content.v1';
export const DREAM_LESSON_DECISION_DOMAIN = 'roster.brain.dream.lesson-decision.v1';

export const DREAM_SUBJECT_LOCK_DOMAIN = 'roster.brain.dream.lock.subject.v1';
export const DREAM_CANDIDATE_LOCK_DOMAIN = 'roster.brain.dream.lock.candidate.v1';

export const MAX_DREAM_CANDIDATE_BYTES = 65_536;
export const MAX_DREAM_LESSON_BODY_BYTES = 16_384;
export const MAX_DREAM_TEXT_BYTES = 4_096;
export const MAX_DREAM_CITATIONS = 64;

export const DREAM_CITATION_ROLES = ['supporting', 'conflicting', 'counterexample'] as const;
export type DreamCitationRole = (typeof DREAM_CITATION_ROLES)[number];

export const DREAM_CITATION_KINDS = ['completed-run', 'feedback'] as const;
export type DreamCitationKind = (typeof DREAM_CITATION_KINDS)[number];

export const DREAM_SURVEYS = ['none-found', 'cited'] as const;
export type DreamSurvey = (typeof DREAM_SURVEYS)[number];

export const LESSON_DECISIONS = ['promote', 'reject', 'retire'] as const;
export type LessonDecisionVerb = (typeof LESSON_DECISIONS)[number];

// Agent- and plan-spelled targets both materialize to ONE physical file, which is
// why the durable subject identity is the normalized `<function>/<agent>` pair
// and not the declared scope key.
export const LESSON_SCOPE_KEY_PATTERN =
  /^(?:agent:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*|plan:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*)$/u;

const RECORD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function dreamCandidateFailure(
  code: string,
  body: string,
  remedy: string,
  details: Record<string, JsonValue> = {},
): RosterError {
  return new RosterError({
    header: 'Invalid Dreamer candidate input',
    body,
    remedy,
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

function invalid(field: string, reason: string, details: Record<string, JsonValue> = {}): never {
  throw dreamCandidateFailure(
    'BRAIN_DREAM_INPUT_INVALID',
    `The '${field}' field is invalid: ${reason}.`,
    'Correct the candidate field and retry; the durable schema refuses the same shape.',
    { field, reason, ...details },
  );
}

// LF is the ONE control character an authored lesson body may carry, matching
// assert_safe_multiline_text in 015. Everything else -- CR included -- is refused
// on both sides, so a body cannot smuggle terminal control sequences into a file
// a human reviews in a diff.
function hasForbiddenControl(value: string, allowLineFeed: boolean): boolean {
  const scanned = allowLineFeed ? value.replace(/\n/gu, '') : value;
  return /[\u0000-\u001f\u007f-\u009f]/u.test(scanned);
}

function boundedText(
  field: string,
  value: unknown,
  maximum: number,
  options: { pattern?: RegExp; allowLineFeed?: boolean; secretScan?: boolean } = {},
): string {
  if (typeof value !== 'string') invalid(field, 'it must be a string');
  const text = value;
  if (text.length === 0) invalid(field, 'it must not be empty');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maximum) invalid(field, `it exceeds ${maximum} UTF-8 bytes`, { bytes });
  if (hasForbiddenControl(text, options.allowLineFeed === true)) {
    invalid(field, 'it contains a control character');
  }
  if (options.pattern !== undefined && !options.pattern.test(text)) {
    invalid(field, 'it does not match its required shape');
  }
  if (options.secretScan === true && looksSecretShaped(text)) {
    invalid(field, 'it looks like a credential and must never enter durable evidence');
  }
  return text;
}

function boundedOrdinal(field: string, value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(field, `it must be a whole number of at least ${minimum}`, { value: String(value) });
  }
  return value as number;
}

function boundedJsonObject(field: string, value: unknown, maximum: number): SourceJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, 'it must be a JSON object');
  }
  const canonical = canonicalSourceJson(value as SourceJsonValue);
  if (Buffer.byteLength(canonical, 'utf8') > maximum) {
    invalid(field, `it exceeds ${maximum} canonical JSON bytes`);
  }
  return value as SourceJsonObject;
}

export type LessonSubject = Readonly<{
  agentKey: string;
  functionId: string;
  agentId: string;
  planId: string | null;
  qualifiedIdOf: (lessonId: string) => string;
}>;

// The ONE normalization: strip the scope-kind prefix, then strip a plan
// fragment. `agent:f/a` and `plan:f/a#p` collapse to `f/a`, which is exactly what
// the 015 generated column derives and what the subject advisory lock frames.
export function lessonSubjectOf(lessonScopeKey: string): LessonSubject {
  if (!LESSON_SCOPE_KEY_PATTERN.test(lessonScopeKey)) {
    invalid('lesson_scope_key', 'it is not an agent- or plan-scoped lesson target', {
      lesson_scope_key: lessonScopeKey,
    });
  }
  const withoutKind = lessonScopeKey.replace(/^(?:agent|plan):/u, '');
  const agentKey = withoutKind.replace(/#[a-z0-9-]+$/u, '');
  const [functionId, agentId] = agentKey.split('/') as [string, string];
  const hash = withoutKind.indexOf('#');
  const planId = hash < 0 ? null : withoutKind.slice(hash + 1);
  return Object.freeze({
    agentKey,
    functionId,
    agentId,
    planId,
    qualifiedIdOf: (lessonId: string) =>
      qualifiedRecordId('lesson', { functionId, agentId, localId: assertRecordId(lessonId) }),
  });
}

// The scaffold scope for the lesson target. The physical PATH ignores the plan
// component, but the registered record scope does not -- a plan-spelled target
// registers with its plan, which is what the promote repair arms authenticate
// against.
export function lessonTargetScope(lessonScopeKey: string): WorkspaceScope {
  const subject = lessonSubjectOf(lessonScopeKey);
  return subject.planId === null
    ? { function: subject.functionId, agent: subject.agentId }
    : { function: subject.functionId, agent: subject.agentId, plan: subject.planId };
}

export type DreamCandidateCitation = Readonly<{
  role: DreamCitationRole;
  evidenceKind: DreamCitationKind;
  runId: string | null;
  feedbackId: string | null;
  observationOrdinal: number;
}>;

export type DreamCandidateDraft = Readonly<{
  scopeKey: string;
  lessonScopeKey: string;
  lessonId: string;
  draftedByAgentId: string;
  lessonPurpose: string;
  lessonBody: string;
  expectedEffect: string;
  conflictingSurvey: DreamSurvey;
  counterexampleSurvey: DreamSurvey;
  policyVersion: string;
  policyFingerprint: string;
  watermarkOrdinal: number;
  frontierOrdinal: number;
  consumedCompletedRuns: number;
  consumedFeedbackRecords: number;
  supersedesCandidateId: string | null;
  privacyClass: 'public' | 'internal';
  citations: readonly DreamCandidateCitation[];
  actor: SourceActorInput;
  provenance: unknown;
}>;

export type NormalizedDreamCandidate = Readonly<{
  candidateId: string;
  contentDigest: string;
  readinessKey: string;
  canonical: string;
  subject: LessonSubject;
  lessonQualifiedId: string;
}>;

function normalizeCitations(
  citations: readonly DreamCandidateCitation[],
): readonly SourceJsonObject[] {
  if (!Array.isArray(citations)) invalid('citations', 'it must be an array');
  if (citations.length === 0) invalid('citations', 'a candidate needs at least one citation');
  if (citations.length > MAX_DREAM_CITATIONS) {
    invalid('citations', `it holds more than ${MAX_DREAM_CITATIONS} citations`);
  }
  const seen = new Set<number>();
  const normalized: SourceJsonObject[] = [];
  for (const [index, citation] of citations.entries()) {
    const field = `citations[${index}]`;
    if (citation === null || typeof citation !== 'object' || Array.isArray(citation)) {
      invalid(field, 'it must be a citation mapping');
    }
    if (!(DREAM_CITATION_ROLES as readonly string[]).includes(citation.role)) {
      invalid(`${field}.role`, 'it is not a supported citation role');
    }
    if (!(DREAM_CITATION_KINDS as readonly string[]).includes(citation.evidenceKind)) {
      invalid(`${field}.evidenceKind`, 'it is not a supported evidence kind');
    }
    const ordinal = boundedOrdinal(`${field}.observationOrdinal`, citation.observationOrdinal, 1);
    // The observation ordinal is the commit-ordered identity of one evidence
    // item, so a repeated ordinal is a duplicated citation however it is spelled.
    if (seen.has(ordinal)) invalid(`${field}.observationOrdinal`, 'it duplicates another citation');
    seen.add(ordinal);
    const runId = citation.runId === null || citation.runId === undefined
      ? null
      : boundedText(`${field}.runId`, citation.runId, 256, { pattern: STABLE_ID });
    const feedbackId = citation.feedbackId === null || citation.feedbackId === undefined
      ? null
      : boundedText(`${field}.feedbackId`, citation.feedbackId, 256, { pattern: STABLE_ID });
    if (citation.evidenceKind === 'completed-run' && (runId === null || feedbackId !== null)) {
      invalid(field, 'a completed-run citation needs a run id and no feedback id');
    }
    if (citation.evidenceKind === 'feedback' && (feedbackId === null || runId !== null)) {
      invalid(field, 'a feedback citation needs a feedback id and no run id');
    }
    normalized.push({
      role: citation.role,
      evidence_kind: citation.evidenceKind,
      run_id: runId,
      feedback_id: feedbackId,
      observation_ordinal: ordinal,
    });
  }
  return normalized;
}

// The CONTENT digest covers everything a human reviews and everything the
// materialized file derives from, so two hosts drafting the same lesson over the
// same snapshot collapse onto one row while any edit opens a new identity.
function dreamCandidateContentValue(
  draft: DreamCandidateDraft,
  citations: readonly SourceJsonObject[],
): SourceJsonValue {
  return {
    scope_key: draft.scopeKey,
    lesson_scope_key: draft.lessonScopeKey,
    lesson_id: draft.lessonId,
    drafted_by_agent_id: draft.draftedByAgentId,
    lesson_purpose: draft.lessonPurpose,
    lesson_body: draft.lessonBody,
    expected_effect: draft.expectedEffect,
    conflicting_survey: draft.conflictingSurvey,
    counterexample_survey: draft.counterexampleSurvey,
    supersedes_candidate_id: draft.supersedesCandidateId,
    consumed_completed_runs: draft.consumedCompletedRuns,
    consumed_feedback_records: draft.consumedFeedbackRecords,
    citations: citations as unknown as SourceJsonValue,
  };
}

export function normalizeDreamCandidate(
  workspaceId: string,
  readinessKey: string,
  draft: DreamCandidateDraft,
): NormalizedDreamCandidate {
  if (draft === null || typeof draft !== 'object') invalid('candidate', 'it must be a candidate mapping');
  if (!DREAM_SCOPE_KEY_PATTERN.test(draft.scopeKey)) {
    invalid('scope_key', 'it is not a durable Dreamer scope key', { scope_key: draft.scopeKey });
  }
  const subject = lessonSubjectOf(draft.lessonScopeKey);
  const lessonId = boundedText('lesson_id', draft.lessonId, 80, { pattern: RECORD_ID });
  const draftedBy = boundedText('drafted_by_agent_id', draft.draftedByAgentId, 80, { pattern: RECORD_ID });
  const purpose = boundedText('lesson_purpose', draft.lessonPurpose, MAX_DREAM_TEXT_BYTES, { secretScan: true });
  const body = boundedText('lesson_body', draft.lessonBody, MAX_DREAM_LESSON_BODY_BYTES, {
    allowLineFeed: true,
    secretScan: true,
  });
  const effect = boundedText('expected_effect', draft.expectedEffect, MAX_DREAM_TEXT_BYTES, { secretScan: true });
  if (!(DREAM_SURVEYS as readonly string[]).includes(draft.conflictingSurvey)) {
    invalid('conflicting_survey', 'it is not a supported survey verdict');
  }
  if (!(DREAM_SURVEYS as readonly string[]).includes(draft.counterexampleSurvey)) {
    invalid('counterexample_survey', 'it is not a supported survey verdict');
  }
  if (draft.privacyClass !== 'public' && draft.privacyClass !== 'internal') {
    invalid('privacy_class', 'a promoted lesson becomes a plaintext file, so only public or internal is representable');
  }
  const policyVersion = boundedText('policy_version', draft.policyVersion, 256, {
    pattern: /^[a-z0-9]+(?:\.[a-z0-9]+)*\.v[0-9]+$/u,
  });
  const policyFingerprint = boundedText('policy_fingerprint', draft.policyFingerprint, 256, { pattern: SHA256_ID });
  const watermarkOrdinal = boundedOrdinal('watermark_ordinal', draft.watermarkOrdinal, 0);
  const frontierOrdinal = boundedOrdinal('frontier_ordinal', draft.frontierOrdinal, 1);
  const consumedRuns = boundedOrdinal('consumed_completed_runs', draft.consumedCompletedRuns, 0);
  const consumedFeedback = boundedOrdinal('consumed_feedback_records', draft.consumedFeedbackRecords, 0);
  const supersedes = draft.supersedesCandidateId === null || draft.supersedesCandidateId === undefined
    ? null
    : boundedText('supersedes_candidate_id', draft.supersedesCandidateId, 256, { pattern: SHA256_ID });
  const citations = normalizeCitations(draft.citations);

  if ((draft.conflictingSurvey === 'cited')
    !== citations.some((citation) => citation.role === 'conflicting')) {
    invalid('conflicting_survey', 'it must say cited exactly when a conflicting citation is present');
  }
  if ((draft.counterexampleSurvey === 'cited')
    !== citations.some((citation) => citation.role === 'counterexample')) {
    invalid('counterexample_survey', 'it must say cited exactly when a counterexample citation is present');
  }
  if (!citations.some((citation) => citation.role === 'supporting')) {
    invalid('citations', 'a candidate needs at least one supporting citation');
  }

  const actor = normalizeSourceActor(draft.actor);
  if (actor.assurance !== 'host-attested' && actor.assurance !== 'human-confirmed') {
    invalid('actor.assurance', 'a dream candidate needs host or human actor assurance');
  }
  const provenance = boundedJsonObject('provenance', draft.provenance, 65_536);

  // The readiness key is RECOMPUTED from the snapshot the candidate binds, never
  // taken on trust: a candidate whose key does not follow from its own policy and
  // cursors would bind a snapshot it never proved.
  const derivedReadinessKey = dreamReadinessKey({
    workspaceId,
    scopeKey: draft.scopeKey,
    policyVersion,
    policyFingerprint,
    watermarkOrdinal,
    frontierOrdinal,
  });
  if (derivedReadinessKey !== readinessKey) {
    invalid('readiness_key', 'it does not follow from the snapshot this candidate binds', {
      expected: derivedReadinessKey,
      supplied: readinessKey,
    });
  }

  const normalizedDraft: DreamCandidateDraft = {
    ...draft,
    lessonId,
    draftedByAgentId: draftedBy,
    lessonPurpose: purpose,
    lessonBody: body,
    expectedEffect: effect,
    policyVersion,
    policyFingerprint,
    watermarkOrdinal,
    frontierOrdinal,
    consumedCompletedRuns: consumedRuns,
    consumedFeedbackRecords: consumedFeedback,
    supersedesCandidateId: supersedes,
  };
  const contentDigest = evidenceDigest(
    DREAM_CANDIDATE_CONTENT_DOMAIN,
    dreamCandidateContentValue(normalizedDraft, citations),
  );
  const candidateId = evidenceDigest(DREAM_CANDIDATE_DOMAIN, {
    workspace_id: workspaceId,
    readiness_key: readinessKey,
    content_digest: contentDigest,
  });
  const record: SourceJsonObject = {
    kind: 'dream-candidate',
    schema_version: DREAM_SCHEMA_VERSION,
    candidate_id: candidateId,
    readiness_key: readinessKey,
    content_digest: contentDigest,
    scope_key: draft.scopeKey,
    lesson_scope_key: draft.lessonScopeKey,
    lesson_id: lessonId,
    drafted_by_agent_id: draftedBy,
    lesson_purpose: purpose,
    lesson_body: body,
    expected_effect: effect,
    conflicting_survey: draft.conflictingSurvey,
    counterexample_survey: draft.counterexampleSurvey,
    policy_version: policyVersion,
    policy_fingerprint: policyFingerprint,
    watermark_ordinal: watermarkOrdinal,
    frontier_ordinal: frontierOrdinal,
    consumed_completed_runs: consumedRuns,
    consumed_feedback_records: consumedFeedback,
    supersedes_candidate_id: supersedes,
    privacy_class: draft.privacyClass,
    trust_class: 'host-asserted',
    actor: actor as unknown as SourceJsonValue,
    provenance: provenance as unknown as SourceJsonValue,
    citations: citations as unknown as SourceJsonValue,
  };
  const canonical = canonicalSourceJson(record as unknown as SourceJsonValue);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_DREAM_CANDIDATE_BYTES) {
    invalid('candidate', `it exceeds ${MAX_DREAM_CANDIDATE_BYTES} canonical JSON bytes`);
  }
  return Object.freeze({
    candidateId,
    contentDigest,
    readinessKey,
    canonical,
    subject,
    lessonQualifiedId: subject.qualifiedIdOf(lessonId),
  });
}

export type LessonDecisionDraft = Readonly<{
  decision: LessonDecisionVerb;
  candidateId: string;
  humanDecisionId: string;
  actionDigest: string;
  frontierOrdinal: number;
  decidedAt: string;
  lessonQualifiedId: string | null;
  lessonContentHash: string | null;
  watermarkCanonical: string | null;
}>;

export type NormalizedLessonDecision = Readonly<{
  lessonDecisionId: string;
  canonical: string;
}>;

export function lessonDecisionIdOf(
  workspaceId: string,
  candidateId: string,
  decision: LessonDecisionVerb,
  humanDecisionId: string,
): string {
  return evidenceDigest(DREAM_LESSON_DECISION_DOMAIN, {
    workspace_id: workspaceId,
    candidate_id: candidateId,
    decision,
    human_decision_id: humanDecisionId,
  });
}

export function normalizeLessonDecision(
  workspaceId: string,
  draft: LessonDecisionDraft,
): NormalizedLessonDecision {
  if (draft === null || typeof draft !== 'object') invalid('decision', 'it must be a decision mapping');
  if (!(LESSON_DECISIONS as readonly string[]).includes(draft.decision)) {
    invalid('decision', 'it is not a supported lesson decision');
  }
  const candidateId = boundedText('candidate_id', draft.candidateId, 256, { pattern: SHA256_ID });
  const humanDecisionId = boundedText('human_decision_id', draft.humanDecisionId, 256, { pattern: STABLE_ID });
  const actionDigest = boundedText('action_digest', draft.actionDigest, 256, { pattern: SHA256_ID });
  const frontierOrdinal = boundedOrdinal('frontier_ordinal', draft.frontierOrdinal, 1);
  const decidedAt = boundedText('decided_at', draft.decidedAt, 64, { pattern: RFC3339 });
  const qualifiedId = draft.lessonQualifiedId === null || draft.lessonQualifiedId === undefined
    ? null
    : boundedText('lesson_qualified_id', draft.lessonQualifiedId, 256, {
      pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/playbook\/[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    });
  const contentHash = draft.lessonContentHash === null || draft.lessonContentHash === undefined
    ? null
    : boundedText('lesson_content_hash', draft.lessonContentHash, 256, { pattern: SHA256_ID });
  const watermarkCanonical = draft.watermarkCanonical === null || draft.watermarkCanonical === undefined
    ? null
    : boundedText('watermark_canonical', draft.watermarkCanonical, 16_384);
  if (draft.decision === 'promote'
    && (qualifiedId === null || contentHash === null || watermarkCanonical === null)) {
    invalid('decision', 'a promote decision carries the lesson identity and the watermark advance');
  }
  if (draft.decision === 'retire'
    && (qualifiedId === null || contentHash === null || watermarkCanonical !== null)) {
    invalid('decision', 'a retire decision carries the promoted lesson identity and no watermark advance');
  }
  if (draft.decision === 'reject'
    && (qualifiedId !== null || contentHash !== null || watermarkCanonical !== null)) {
    invalid('decision', 'a reject decision carries no lesson identity and no watermark advance');
  }
  const lessonDecisionId = lessonDecisionIdOf(workspaceId, candidateId, draft.decision, humanDecisionId);
  const record: SourceJsonObject = {
    kind: 'lesson-decision',
    schema_version: DREAM_SCHEMA_VERSION,
    lesson_decision_id: lessonDecisionId,
    candidate_id: candidateId,
    decision: draft.decision,
    human_decision_id: humanDecisionId,
    action_digest: actionDigest,
    lesson_qualified_id: qualifiedId,
    lesson_content_hash: contentHash,
    watermark_canonical: watermarkCanonical,
    frontier_ordinal: frontierOrdinal,
    actor_assurance: 'human-confirmed',
    decided_at: decidedAt,
  };
  const canonical = canonicalSourceJson(record as unknown as SourceJsonValue);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_DREAM_CANDIDATE_BYTES) {
    invalid('decision', `it exceeds ${MAX_DREAM_CANDIDATE_BYTES} canonical JSON bytes`);
  }
  return Object.freeze({ lessonDecisionId, canonical });
}

// A human decision's `action.target` is FREE TEXT and is credential-scanned on
// both sides (evidence-contracts.ts and 013's assert_no_credential_shape), and
// the generic long-hex rule refuses any run of 32+ hex characters -- which a bare
// `sha256:` candidate id is. So the decision target carries the candidate's
// digest in a group-separated spelling: injective, still exact, and provably
// free of a 32-character hex run. 015 recomputes the identical spelling.
export function dreamDecisionTarget(candidateId: string): string {
  if (!SHA256_ID.test(candidateId)) {
    invalid('candidate_id', 'it must be a lowercase sha256 digest', { candidate_id: candidateId });
  }
  return `dream-candidate:${candidateId.slice('sha256:'.length).replace(/(.{4})/gu, '$1-')}`;
}

// The exact action a human decision must be bound to. Roster never asks and
// never waits: it verifies that this exact triple was already answered.
export function lessonDecisionAction(
  decision: LessonDecisionVerb,
  candidateId: string,
  lessonScopeKey: string,
): Readonly<{ target: string; effect: string; scope: string }> {
  return Object.freeze({
    target: dreamDecisionTarget(candidateId),
    effect: `dream-candidate-${decision}`,
    scope: lessonScopeKey,
  });
}
