import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import {
  canonicalSourceJson,
  type SourceActorInput,
  type SourceJsonObject,
  type SourceJsonValue,
  type SourcePrivacyClass,
  type SourceRetrievalLabelInput,
  type SourceTrustClass,
} from './source-contracts.ts';
import {
  EVIDENCE_RECORD_KINDS,
  evidenceFailure,
  normalizeCompletedRun,
  normalizeFeedback,
  normalizeHumanDecision,
  normalizeRunArtifact,
  type CompletedRunInput,
  type EvidenceRecordKind,
  type FeedbackInput,
  type HumanDecisionInput,
  type NormalizedEvidenceRecord,
  type RunArtifactInput,
} from './evidence-contracts.ts';
import {
  EVIDENCE_LOCK_DOMAINS,
  derivePromotionId,
  evidenceActionDigest,
  evidenceRecordFingerprint,
  evidenceSummaryHash,
  derivePromotionSourceKey,
  promotionContentValue,
  promotionLockComponents,
  type PromotionIdentity,
  type PromotionSubjectIdentity,
} from './evidence-identity.ts';
import { prepareSourceIdentity } from './source-identity.ts';
import { ingestBrainSource } from './source-lifecycle.ts';
import type { BrainObjectStore } from './object-store.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';

export type EvidenceErrorCode =
  | 'BRAIN_EVIDENCE_INPUT_INVALID'
  | 'BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT'
  | 'BRAIN_EVIDENCE_REF_NOT_FOUND'
  | 'BRAIN_EVIDENCE_INTEGRITY';

const BROKER_ERROR_CODES: Readonly<Record<string, EvidenceErrorCode>> = {
  RBE01: 'BRAIN_EVIDENCE_INPUT_INVALID',
  RBE02: 'BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT',
  RBE03: 'BRAIN_EVIDENCE_REF_NOT_FOUND',
  RBE04: 'BRAIN_EVIDENCE_INTEGRITY',
};

const PROMOTION_PROBE_REQUEST_KEY = 'evidence-promotion-probe';

export function evidenceError(
  code: EvidenceErrorCode,
  body: string,
  details: Record<string, JsonValue> = {},
): RosterError {
  return new RosterError({
    header: 'Brain evidence refused the operation',
    body,
    remedy: 'Inspect the durable evidence row and retry with byte-identical portable evidence.',
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

function rethrowBrokerError(error: unknown): never {
  const sqlState = (error as { code?: unknown }).code;
  if (typeof sqlState === 'string' && sqlState in BROKER_ERROR_CODES) {
    throw evidenceError(
      BROKER_ERROR_CODES[sqlState]!,
      (error as { message?: string }).message ?? 'The Brain evidence broker refused the record.',
      { sqlstate: sqlState },
    );
  }
  throw error;
}

export type EvidenceWriteResult = Readonly<{
  status: 'created' | 'existing';
  id: string;
  recordFingerprint: string;
}>;

async function callBroker(
  pool: VerifiedBrainPool,
  broker: string,
  normalized: NormalizedEvidenceRecord,
): Promise<EvidenceWriteResult> {
  let rows: { status: string; id: string }[];
  try {
    rows = (await pool.query<{ status: string; id: string }>(
      `SELECT status, id FROM brain_evidence.${broker}($1)`,
      [normalized.canonical],
    )).rows;
  } catch (error) {
    rethrowBrokerError(error);
  }
  const row = rows![0];
  if (row === undefined || (row.status !== 'created' && row.status !== 'existing')) {
    throw evidenceError('BRAIN_EVIDENCE_INTEGRITY', 'The evidence broker returned no durable outcome.');
  }
  return Object.freeze({
    status: row.status,
    id: row.id,
    recordFingerprint: evidenceRecordFingerprint(normalized.kind, normalized.canonical),
  });
}

export async function recordCompletedRun(
  pool: VerifiedBrainPool,
  input: CompletedRunInput,
): Promise<EvidenceWriteResult> {
  return await callBroker(pool, 'record_completed_run', normalizeCompletedRun(input));
}

export async function recordRunArtifact(
  pool: VerifiedBrainPool,
  input: RunArtifactInput,
): Promise<EvidenceWriteResult> {
  return await callBroker(pool, 'record_run_artifact', normalizeRunArtifact(input));
}

export async function recordFeedback(
  pool: VerifiedBrainPool,
  input: FeedbackInput,
): Promise<EvidenceWriteResult> {
  return await callBroker(pool, 'record_feedback', normalizeFeedback(input));
}

export async function recordHumanDecision(
  pool: VerifiedBrainPool,
  input: HumanDecisionInput,
): Promise<EvidenceWriteResult> {
  return await callBroker(pool, 'record_human_decision', normalizeHumanDecision(input));
}

export type RunSourceRow = Readonly<{
  ordinal: number;
  sourceKind: 'brain-source-version' | 'external';
  sourceVersionId: string | null;
  externalLocator: SourceJsonObject | null;
  summary: string | null;
}>;

export type RunToolRow = Readonly<{
  ordinal: number;
  toolUseId: string;
  skillRef: string | null;
  summary: string | null;
}>;

export type RunArtifactEnvelope = Readonly<{
  kind: 'run-artifact';
  runId: string;
  artifactId: string;
  recordCanonical: string;
  recordFingerprint: string;
  workspaceId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  pointerKind: string;
  externalLocator: SourceJsonObject;
  privacyClass: string;
  trustClass: string;
  actorAssurance: string;
  assuranceEvidence: SourceJsonObject;
  provenance: SourceJsonObject;
  recordedAt: string;
}>;

export type CompletedRunEnvelope = Readonly<{
  kind: 'completed-run';
  runId: string;
  recordCanonical: string;
  recordFingerprint: string;
  workspaceId: string;
  functionId: string;
  agentId: string;
  planId: string | null;
  host: string;
  hostVersion: string;
  rosterVersion: string;
  requestSummary: string;
  requestHash: string;
  startedAt: string;
  completedAt: string;
  outcome: string;
  privacyClass: string;
  trustClass: string;
  actorAssurance: string;
  assuranceEvidence: SourceJsonObject;
  provenance: SourceJsonObject;
  recordedAt: string;
  sources: readonly RunSourceRow[];
  tools: readonly RunToolRow[];
  artifacts: readonly RunArtifactEnvelope[];
  feedbackIds: readonly string[];
}>;

export type FeedbackEnvelope = Readonly<{
  kind: 'feedback';
  feedbackId: string;
  recordCanonical: string;
  recordFingerprint: string;
  workspaceId: string;
  runId: string;
  signal: string;
  summary: string;
  summaryHash: string;
  privacyClass: string;
  trustClass: string;
  actorAssurance: string;
  assuranceEvidence: SourceJsonObject;
  provenance: SourceJsonObject;
  recordedAt: string;
}>;

export type HumanDecisionEnvelope = Readonly<{
  kind: 'human-decision';
  decisionId: string;
  recordCanonical: string;
  recordFingerprint: string;
  workspaceId: string;
  action: SourceJsonObject;
  actionSummary: string;
  actionDigest: string;
  requestedDecision: string;
  answer: string;
  privacyClass: string;
  trustClass: string;
  actorAssurance: string;
  assuranceEvidence: SourceJsonObject;
  decidedAt: string;
  hostProvenance: SourceJsonObject;
  relatedRunId: string | null;
  relatedArtifactId: string | null;
  recordedAt: string;
}>;

export type EvidenceEnvelope =
  | CompletedRunEnvelope
  | RunArtifactEnvelope
  | FeedbackEnvelope
  | HumanDecisionEnvelope;

function asJsonObject(value: unknown): SourceJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw evidenceError('BRAIN_EVIDENCE_INTEGRITY', 'A durable evidence column is not a JSON object.');
  }
  return value as SourceJsonObject;
}

function artifactEnvelope(row: Record<string, unknown>): RunArtifactEnvelope {
  const recordCanonical = String(row.record_canonical);
  return Object.freeze({
    kind: 'run-artifact' as const,
    runId: String(row.run_id),
    artifactId: String(row.artifact_id),
    recordCanonical,
    recordFingerprint: evidenceRecordFingerprint('run-artifact', recordCanonical),
    workspaceId: String(row.workspace_id),
    sha256: String(row.sha256),
    byteLength: Number(row.byte_length),
    mediaType: String(row.media_type),
    pointerKind: String(row.pointer_kind),
    externalLocator: asJsonObject(row.external_locator),
    privacyClass: String(row.privacy_class),
    trustClass: String(row.trust_class),
    actorAssurance: String(row.actor_assurance),
    assuranceEvidence: asJsonObject(row.assurance_evidence),
    provenance: asJsonObject(row.provenance),
    recordedAt: String(row.recorded_at),
  });
}

export async function readCompletedRun(
  pool: VerifiedBrainPool,
  runId: string,
): Promise<CompletedRunEnvelope | null> {
  const runResult = await pool.query<Record<string, unknown>>(
    `SELECT run_id, record_canonical, workspace_id, function_id, agent_id, plan_id,
            host, host_version, roster_version, request_summary, request_hash,
            to_json(started_at) #>> '{}' AS started_at,
            to_json(completed_at) #>> '{}' AS completed_at,
            outcome, privacy_class, trust_class, actor_assurance,
            assurance_evidence, provenance,
            to_json(recorded_at) #>> '{}' AS recorded_at
       FROM brain_evidence.completed_runs WHERE run_id = $1`,
    [runId],
  );
  const row = runResult.rows[0];
  if (row === undefined) return null;

  const sources = await pool.query<Record<string, unknown>>(
    `SELECT ordinal, source_kind, source_version_id, external_locator, summary
       FROM brain_evidence.run_sources WHERE run_id = $1 ORDER BY ordinal`,
    [runId],
  );
  const tools = await pool.query<Record<string, unknown>>(
    `SELECT ordinal, tool_use_id, skill_ref, summary
       FROM brain_evidence.run_tools WHERE run_id = $1 ORDER BY ordinal`,
    [runId],
  );
  const artifacts = await pool.query<Record<string, unknown>>(
    `SELECT run_id, artifact_id, record_canonical, workspace_id, sha256, byte_length,
            media_type, pointer_kind, external_locator, privacy_class, trust_class,
            actor_assurance, assurance_evidence, provenance,
            to_json(recorded_at) #>> '{}' AS recorded_at
       FROM brain_evidence.run_artifacts WHERE run_id = $1 ORDER BY artifact_id`,
    [runId],
  );
  const feedback = await pool.query<{ feedback_id: string }>(
    `SELECT feedback_id FROM brain_evidence.feedback WHERE run_id = $1 ORDER BY feedback_id`,
    [runId],
  );

  const recordCanonical = String(row.record_canonical);
  return Object.freeze({
    kind: 'completed-run' as const,
    runId: String(row.run_id),
    recordCanonical,
    recordFingerprint: evidenceRecordFingerprint('completed-run', recordCanonical),
    workspaceId: String(row.workspace_id),
    functionId: String(row.function_id),
    agentId: String(row.agent_id),
    planId: row.plan_id === null ? null : String(row.plan_id),
    host: String(row.host),
    hostVersion: String(row.host_version),
    rosterVersion: String(row.roster_version),
    requestSummary: String(row.request_summary),
    requestHash: String(row.request_hash),
    startedAt: String(row.started_at),
    completedAt: String(row.completed_at),
    outcome: String(row.outcome),
    privacyClass: String(row.privacy_class),
    trustClass: String(row.trust_class),
    actorAssurance: String(row.actor_assurance),
    assuranceEvidence: asJsonObject(row.assurance_evidence),
    provenance: asJsonObject(row.provenance),
    recordedAt: String(row.recorded_at),
    sources: Object.freeze(sources.rows.map((entry) => Object.freeze({
      ordinal: Number(entry.ordinal),
      sourceKind: String(entry.source_kind) as RunSourceRow['sourceKind'],
      sourceVersionId: entry.source_version_id === null ? null : String(entry.source_version_id),
      externalLocator: entry.external_locator === null ? null : asJsonObject(entry.external_locator),
      summary: entry.summary === null ? null : String(entry.summary),
    }))),
    tools: Object.freeze(tools.rows.map((entry) => Object.freeze({
      ordinal: Number(entry.ordinal),
      toolUseId: String(entry.tool_use_id),
      skillRef: entry.skill_ref === null ? null : String(entry.skill_ref),
      summary: entry.summary === null ? null : String(entry.summary),
    }))),
    artifacts: Object.freeze(artifacts.rows.map(artifactEnvelope)),
    feedbackIds: Object.freeze(feedback.rows.map((entry) => entry.feedback_id)),
  });
}

export async function readFeedback(
  pool: VerifiedBrainPool,
  feedbackId: string,
): Promise<FeedbackEnvelope | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT feedback_id, record_canonical, workspace_id, run_id, signal, summary,
            summary_hash, privacy_class, trust_class, actor_assurance,
            assurance_evidence, provenance,
            to_json(recorded_at) #>> '{}' AS recorded_at
       FROM brain_evidence.feedback WHERE feedback_id = $1`,
    [feedbackId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const recordCanonical = String(row.record_canonical);
  return Object.freeze({
    kind: 'feedback' as const,
    feedbackId: String(row.feedback_id),
    recordCanonical,
    recordFingerprint: evidenceRecordFingerprint('feedback', recordCanonical),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    signal: String(row.signal),
    summary: String(row.summary),
    summaryHash: String(row.summary_hash),
    privacyClass: String(row.privacy_class),
    trustClass: String(row.trust_class),
    actorAssurance: String(row.actor_assurance),
    assuranceEvidence: asJsonObject(row.assurance_evidence),
    provenance: asJsonObject(row.provenance),
    recordedAt: String(row.recorded_at),
  });
}

export async function readHumanDecision(
  pool: VerifiedBrainPool,
  decisionId: string,
): Promise<HumanDecisionEnvelope | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT decision_id, record_canonical, workspace_id, action, action_summary,
            action_digest, requested_decision, answer, privacy_class, trust_class,
            actor_assurance, assurance_evidence,
            to_json(decided_at) #>> '{}' AS decided_at,
            host_provenance, related_run_id, related_artifact_id,
            to_json(recorded_at) #>> '{}' AS recorded_at
       FROM brain_evidence.human_decisions WHERE decision_id = $1`,
    [decisionId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const recordCanonical = String(row.record_canonical);
  return Object.freeze({
    kind: 'human-decision' as const,
    decisionId: String(row.decision_id),
    recordCanonical,
    recordFingerprint: evidenceRecordFingerprint('human-decision', recordCanonical),
    workspaceId: String(row.workspace_id),
    action: asJsonObject(row.action),
    actionSummary: String(row.action_summary),
    actionDigest: String(row.action_digest),
    requestedDecision: String(row.requested_decision),
    answer: String(row.answer),
    privacyClass: String(row.privacy_class),
    trustClass: String(row.trust_class),
    actorAssurance: String(row.actor_assurance),
    assuranceEvidence: asJsonObject(row.assurance_evidence),
    decidedAt: String(row.decided_at),
    hostProvenance: asJsonObject(row.host_provenance),
    relatedRunId: row.related_run_id === null ? null : String(row.related_run_id),
    relatedArtifactId: row.related_artifact_id === null ? null : String(row.related_artifact_id),
    recordedAt: String(row.recorded_at),
  });
}

export type EvidenceVerification = Readonly<{
  kind: EvidenceRecordKind;
  verified: boolean;
  recordFingerprint: string;
  findings: readonly string[];
}>;

function sameInstant(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalSourceJson(left as SourceJsonValue) === canonicalSourceJson(right as SourceJsonValue);
}

// Recomputes every derived value from the STORED canonical text: a caller that
// reached the broker directly with a forged action digest or summary hash mints
// a detectably invalid record instead of one that silently collides with the
// honest record (whose replay byte-compares canonical text and conflicts loudly).
export function verifyEvidenceRecord(
  kind: EvidenceRecordKind,
  envelope: EvidenceEnvelope,
): EvidenceVerification {
  if (!(EVIDENCE_RECORD_KINDS as readonly string[]).includes(kind)) {
    evidenceFailure('kind', 'it is not a supported evidence record kind');
  }
  const findings: string[] = [];
  if (envelope.kind !== kind) findings.push('envelope kind disagrees with the requested kind');
  const recordFingerprint = evidenceRecordFingerprint(kind, envelope.recordCanonical);
  if (envelope.recordFingerprint !== recordFingerprint) {
    findings.push('record fingerprint disagrees with the stored canonical text');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(envelope.recordCanonical) as Record<string, unknown>;
  } catch {
    return Object.freeze({ kind, verified: false, recordFingerprint, findings: Object.freeze([...findings, 'stored canonical text is not JSON']) });
  }
  if (canonicalSourceJson(parsed as SourceJsonValue) !== envelope.recordCanonical) {
    findings.push('stored canonical text is not in canonical form');
  }
  if (parsed.kind !== kind) findings.push('canonical record kind disagrees with the row');

  const expectText = (field: string, canonicalKey: string, column: unknown): void => {
    if (parsed[canonicalKey] !== column) findings.push(`${field} disagrees with the canonical record`);
  };
  const expectJson = (field: string, canonicalKey: string, column: unknown): void => {
    if (!canonicalEqual(parsed[canonicalKey], column)) {
      findings.push(`${field} disagrees with the canonical record`);
    }
  };
  const expectInstant = (field: string, canonicalKey: string, column: string): void => {
    if (typeof parsed[canonicalKey] !== 'string' || !sameInstant(parsed[canonicalKey], column)) {
      findings.push(`${field} disagrees with the canonical record`);
    }
  };

  if (kind === 'completed-run') {
    const run = envelope as CompletedRunEnvelope;
    expectText('run_id', 'run_id', run.runId);
    expectText('function_id', 'function_id', run.functionId);
    expectText('agent_id', 'agent_id', run.agentId);
    expectText('plan_id', 'plan_id', run.planId);
    expectText('host', 'host', run.host);
    expectText('host_version', 'host_version', run.hostVersion);
    expectText('roster_version', 'roster_version', run.rosterVersion);
    expectText('request_summary', 'request_summary', run.requestSummary);
    expectText('request_hash', 'request_hash', run.requestHash);
    expectInstant('started_at', 'started_at', run.startedAt);
    expectInstant('completed_at', 'completed_at', run.completedAt);
    expectText('outcome', 'outcome', run.outcome);
    expectText('privacy_class', 'privacy_class', run.privacyClass);
    expectText('trust_class', 'trust_class', run.trustClass);
    expectJson('assurance_evidence', 'actor', run.assuranceEvidence);
    expectJson('provenance', 'provenance', run.provenance);
    const citations = Array.isArray(parsed.sources) ? parsed.sources : [];
    if (citations.length !== run.sources.length) findings.push('cited sources disagree with the canonical record');
    else {
      citations.forEach((entry, index) => {
        const stored = run.sources[index]!;
        const value = entry as Record<string, unknown>;
        if (value.kind !== stored.sourceKind
          || (value.source_version_id ?? null) !== stored.sourceVersionId
          || !canonicalEqual(value.locator ?? null, stored.externalLocator)
          || (value.summary ?? null) !== stored.summary) {
          findings.push(`cited source ${index} disagrees with the canonical record`);
        }
      });
    }
    const uses = Array.isArray(parsed.tools) ? parsed.tools : [];
    if (uses.length !== run.tools.length) findings.push('tool uses disagree with the canonical record');
    else {
      uses.forEach((entry, index) => {
        const stored = run.tools[index]!;
        const value = entry as Record<string, unknown>;
        if (value.tool_use_id !== stored.toolUseId
          || (value.skill_ref ?? null) !== stored.skillRef
          || (value.summary ?? null) !== stored.summary) {
          findings.push(`tool use ${index} disagrees with the canonical record`);
        }
      });
    }
  } else if (kind === 'run-artifact') {
    const artifact = envelope as RunArtifactEnvelope;
    expectText('run_id', 'run_id', artifact.runId);
    expectText('artifact_id', 'artifact_id', artifact.artifactId);
    expectText('sha256', 'sha256', artifact.sha256);
    if (parsed.byte_length !== artifact.byteLength) findings.push('byte_length disagrees with the canonical record');
    expectText('media_type', 'media_type', artifact.mediaType);
    expectText('pointer_kind', 'pointer_kind', artifact.pointerKind);
    expectJson('external_locator', 'external_locator', artifact.externalLocator);
    expectText('privacy_class', 'privacy_class', artifact.privacyClass);
    expectText('trust_class', 'trust_class', artifact.trustClass);
    expectJson('assurance_evidence', 'actor', artifact.assuranceEvidence);
    expectJson('provenance', 'provenance', artifact.provenance);
  } else if (kind === 'feedback') {
    const entry = envelope as FeedbackEnvelope;
    expectText('feedback_id', 'feedback_id', entry.feedbackId);
    expectText('run_id', 'run_id', entry.runId);
    expectText('signal', 'signal', entry.signal);
    expectText('summary', 'summary', entry.summary);
    expectText('summary_hash', 'summary_hash', entry.summaryHash);
    expectText('privacy_class', 'privacy_class', entry.privacyClass);
    expectText('trust_class', 'trust_class', entry.trustClass);
    expectJson('assurance_evidence', 'actor', entry.assuranceEvidence);
    expectJson('provenance', 'provenance', entry.provenance);
    if (typeof parsed.summary === 'string'
      && evidenceSummaryHash(parsed.summary) !== entry.summaryHash) {
      findings.push('summary_hash is not the digest of the recorded summary');
    }
  } else {
    const decision = envelope as HumanDecisionEnvelope;
    expectText('decision_id', 'decision_id', decision.decisionId);
    expectJson('action', 'action', decision.action);
    expectText('action_summary', 'action_summary', decision.actionSummary);
    expectText('action_digest', 'action_digest', decision.actionDigest);
    expectText('requested_decision', 'requested_decision', decision.requestedDecision);
    expectText('answer', 'answer', decision.answer);
    expectText('privacy_class', 'privacy_class', decision.privacyClass);
    expectText('trust_class', 'trust_class', decision.trustClass);
    expectJson('assurance_evidence', 'actor', decision.assuranceEvidence);
    expectInstant('decided_at', 'decided_at', decision.decidedAt);
    expectJson('host_provenance', 'host_provenance', decision.hostProvenance);
    expectText('related_run_id', 'related_run_id', decision.relatedRunId);
    expectText('related_artifact_id', 'related_artifact_id', decision.relatedArtifactId);
    if (parsed.action !== undefined
      && evidenceActionDigest(parsed.action as SourceJsonValue) !== decision.actionDigest) {
      findings.push('action_digest is not the digest of the recorded action');
    }
  }

  return Object.freeze({
    kind,
    verified: findings.length === 0,
    recordFingerprint,
    findings: Object.freeze(findings),
  });
}

export type EvidenceReference = Readonly<{
  evidenceKind: EvidenceRecordKind;
  runId?: string | null;
  artifactId?: string | null;
  feedbackId?: string | null;
  decisionId?: string | null;
}>;

export type PromotionRow = Readonly<{
  promotionId: string;
  evidenceKind: EvidenceRecordKind;
  runId: string | null;
  artifactId: string | null;
  feedbackId: string | null;
  decisionId: string | null;
  promotedSourceVersionId: string;
  recordCanonical: string;
  recordFingerprint: string;
  recordedAt: string;
}>;

function subjectIdentity(reference: EvidenceReference): PromotionSubjectIdentity {
  const runId = reference.runId ?? null;
  const artifactId = reference.artifactId ?? null;
  const feedbackId = reference.feedbackId ?? null;
  const decisionId = reference.decisionId ?? null;
  const shapes: Record<EvidenceRecordKind, boolean> = {
    'completed-run': runId !== null && artifactId === null && feedbackId === null && decisionId === null,
    'run-artifact': runId !== null && artifactId !== null && feedbackId === null && decisionId === null,
    feedback: runId === null && artifactId === null && feedbackId !== null && decisionId === null,
    'human-decision': runId === null && artifactId === null && feedbackId === null && decisionId !== null,
  };
  if (shapes[reference.evidenceKind] !== true) {
    evidenceFailure('evidenceKind', 'the promotion identity does not match its evidence kind');
  }
  return Object.freeze({
    evidenceKind: reference.evidenceKind,
    runId,
    artifactId,
    feedbackId,
    decisionId,
  });
}

export async function readPromotions(
  pool: VerifiedBrainPool,
  reference: EvidenceReference,
): Promise<readonly PromotionRow[]> {
  const identity = subjectIdentity(reference);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT promotion_id, evidence_kind, run_id, artifact_id, feedback_id, decision_id,
            promoted_source_version_id, record_canonical,
            to_json(recorded_at) #>> '{}' AS recorded_at
       FROM brain_evidence.evidence_promotions
      WHERE evidence_kind = $1
        AND run_id IS NOT DISTINCT FROM $2
        AND artifact_id IS NOT DISTINCT FROM $3
        AND feedback_id IS NOT DISTINCT FROM $4
        AND decision_id IS NOT DISTINCT FROM $5
      ORDER BY recorded_at, promotion_id`,
    [identity.evidenceKind, identity.runId, identity.artifactId, identity.feedbackId, identity.decisionId],
  );
  return Object.freeze(result.rows.map((row) => {
    const recordCanonical = String(row.record_canonical);
    return Object.freeze({
      promotionId: String(row.promotion_id),
      evidenceKind: String(row.evidence_kind) as EvidenceRecordKind,
      runId: row.run_id === null ? null : String(row.run_id),
      artifactId: row.artifact_id === null ? null : String(row.artifact_id),
      feedbackId: row.feedback_id === null ? null : String(row.feedback_id),
      decisionId: row.decision_id === null ? null : String(row.decision_id),
      promotedSourceVersionId: String(row.promoted_source_version_id),
      recordCanonical,
      recordFingerprint: evidenceRecordFingerprint('promotion', recordCanonical),
      recordedAt: String(row.recorded_at),
    });
  }));
}

export type PromoteEvidenceRequest = EvidenceReference & Readonly<{
  labels: readonly SourceRetrievalLabelInput[];
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  actor: SourceActorInput;
  provenance: unknown;
}>;

export type PromoteEvidenceResult = Readonly<{
  status: 'created' | 'existing';
  promotionId: string;
  sourceId: string;
  sourceVersionId: string;
  objectId: string;
}>;

export type PromoteEvidenceDeps = {
  pool: VerifiedBrainPool;
  objectStore: BrainObjectStore;
  // Failure-injection seam: the promotion recovery contract is only meaningful
  // if a crash BETWEEN the two effects can be exercised.
  afterIngest?: () => Promise<void>;
};

async function readPromotionSubject(
  pool: VerifiedBrainPool,
  reference: EvidenceReference,
): Promise<string> {
  const queries: Record<EvidenceRecordKind, { sql: string; values: unknown[] }> = {
    'completed-run': {
      sql: `SELECT record_canonical FROM brain_evidence.completed_runs WHERE run_id = $1`,
      values: [reference.runId],
    },
    'run-artifact': {
      sql: `SELECT record_canonical FROM brain_evidence.run_artifacts WHERE run_id = $1 AND artifact_id = $2`,
      values: [reference.runId, reference.artifactId],
    },
    feedback: {
      sql: `SELECT record_canonical FROM brain_evidence.feedback WHERE feedback_id = $1`,
      values: [reference.feedbackId],
    },
    'human-decision': {
      sql: `SELECT record_canonical FROM brain_evidence.human_decisions WHERE decision_id = $1`,
      values: [reference.decisionId],
    },
  };
  const plan = queries[reference.evidenceKind];
  if (plan === undefined) evidenceFailure('evidenceKind', 'it is not a supported evidence record kind');
  const result = await pool.query<{ record_canonical: string }>(plan.sql, plan.values);
  const row = result.rows[0];
  if (row === undefined) {
    throw evidenceError('BRAIN_EVIDENCE_REF_NOT_FOUND', 'The referenced evidence record does not exist.');
  }
  return row.record_canonical;
}

// The ONE evidence -> semantic path. Ingest-first, then lineage: both effects are
// individually idempotent under derived identities, so a crash between them
// converges on re-run. A session-scoped advisory lock spans both effects.
export async function promoteEvidence(
  deps: PromoteEvidenceDeps,
  request: PromoteEvidenceRequest,
): Promise<PromoteEvidenceResult> {
  const { pool, objectStore } = deps;
  const workspaceId = pool.authority.workspaceId;
  const subjectRef = subjectIdentity(request);
  const subjectCanonical = await readPromotionSubject(pool, request);
  const subject = JSON.parse(subjectCanonical) as SourceJsonValue;
  const promotionBytes = Buffer.from(
    canonicalSourceJson(promotionContentValue(subjectRef, subject)),
    'utf8',
  );
  const stableKey = derivePromotionSourceKey(subjectRef);
  const ingestBase = {
    source: { kind: 'structured-record' as const, stableKey },
    bytes: promotionBytes,
    labels: request.labels,
    privacy: request.privacy,
    trust: request.trust,
    actor: request.actor,
    mediaType: 'application/json',
    provenance: {
      ...(request.provenance === null || typeof request.provenance !== 'object' || Array.isArray(request.provenance)
        ? {}
        : (request.provenance as Record<string, unknown>)),
      promoted_from: {
        evidence_kind: subjectRef.evidenceKind,
        run_id: subjectRef.runId,
        artifact_id: subjectRef.artifactId,
        feedback_id: subjectRef.feedbackId,
        decision_id: subjectRef.decisionId,
      },
    },
  };
  // The source version id does not depend on the request key, so a probe pass
  // derives it, the promotion id derives from that, and the real request key
  // derives from the promotion id. The second pass re-proves the derivation.
  const probe = prepareSourceIdentity(workspaceId, { ...ingestBase, requestKey: PROMOTION_PROBE_REQUEST_KEY });
  const identity: PromotionIdentity = Object.freeze({ ...subjectRef, promotedSourceVersionId: probe.sourceVersionId });
  const promotionId = derivePromotionId(identity);
  const requestKey = `evidence-promotion:${promotionId.slice('sha256:'.length)}`;
  const ingestInput = { ...ingestBase, requestKey };
  const prepared = prepareSourceIdentity(workspaceId, ingestInput);
  if (prepared.sourceVersionId !== probe.sourceVersionId) {
    throw evidenceError('BRAIN_EVIDENCE_INTEGRITY', 'The promoted source version identity is not request-stable.');
  }

  const promotionRecord: SourceJsonObject = {
    schema_version: 1,
    kind: 'promotion',
    evidence_kind: identity.evidenceKind,
    run_id: identity.runId,
    artifact_id: identity.artifactId,
    feedback_id: identity.feedbackId,
    decision_id: identity.decisionId,
    promoted_source_version_id: identity.promotedSourceVersionId,
    labels: prepared.normalized.labels as unknown as SourceJsonValue,
    privacy_class: prepared.normalized.privacy,
    trust_class: prepared.normalized.trust,
    actor: prepared.normalized.actor as unknown as SourceJsonValue,
    provenance: prepared.normalized.provenance,
  };
  const promotionCanonical = canonicalSourceJson(promotionRecord as unknown as SourceJsonValue);

  const client = await pool.connect();
  let locked = false;
  let unlockFailure: Error | undefined;
  let primaryFailure: unknown;
  try {
    await client.query(
      'SELECT pg_advisory_lock(brain_evidence.lock_key($1, $2::text[]))',
      [EVIDENCE_LOCK_DOMAINS.promotion, promotionLockComponents(identity)],
    );
    locked = true;

    const ingested = await ingestBrainSource({ pool, objectStore }, ingestInput);
    if (ingested.sourceVersionId !== identity.promotedSourceVersionId) {
      throw evidenceError('BRAIN_EVIDENCE_INTEGRITY', 'The ingested source version disagrees with the derived promotion identity.');
    }
    if (deps.afterIngest !== undefined) await deps.afterIngest();

    const inserted = await client.query(
      `INSERT INTO brain_evidence.evidence_promotions (
         promotion_id, record_canonical, workspace_id, evidence_kind, run_id,
         artifact_id, feedback_id, decision_id, promoted_source_version_id,
         actor_assurance, assurance_evidence, provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
       ON CONFLICT (promotion_id) DO NOTHING`,
      [
        promotionId,
        promotionCanonical,
        workspaceId,
        identity.evidenceKind,
        identity.runId,
        identity.artifactId,
        identity.feedbackId,
        identity.decisionId,
        identity.promotedSourceVersionId,
        prepared.normalized.actor.assurance,
        JSON.stringify(prepared.normalized.actor),
        JSON.stringify(prepared.normalized.provenance),
      ],
    );
    if ((inserted.rowCount ?? 0) === 1) {
      return Object.freeze({
        status: 'created' as const,
        promotionId,
        sourceId: ingested.sourceId,
        sourceVersionId: ingested.sourceVersionId,
        objectId: ingested.objectId,
      });
    }
    const stored = await client.query<{ record_canonical: string }>(
      `SELECT record_canonical FROM brain_evidence.evidence_promotions WHERE promotion_id = $1`,
      [promotionId],
    );
    if (stored.rows[0]?.record_canonical !== promotionCanonical) {
      throw evidenceError(
        'BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT',
        'A different promotion request is already recorded under this promotion identity.',
        { promotion_id: promotionId },
      );
    }
    return Object.freeze({
      status: 'existing' as const,
      promotionId,
      sourceId: ingested.sourceId,
      sourceVersionId: ingested.sourceVersionId,
      objectId: ingested.objectId,
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (locked) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(brain_evidence.lock_key($1, $2::text[])) AS unlocked',
          [EVIDENCE_LOCK_DOMAINS.promotion, promotionLockComponents(identity)],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          unlockFailure = new Error('Brain evidence promotion lock was not released');
        }
      } catch (error) {
        unlockFailure = error instanceof Error ? error : new Error('Brain evidence promotion unlock failed');
      }
    }
    client.release(unlockFailure);
    // A session lock that outlives the promotion silently serializes every later
    // promotion of the same identity behind a dead holder, so an unreleased lock
    // must never be reported as success.
    if (unlockFailure !== undefined && primaryFailure === undefined) throw unlockFailure;
  }
}
