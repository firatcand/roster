import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import { getPackageVersion } from '../paths.ts';
import {
  ACTOR_ASSURANCES,
  SOURCE_PRIVACY_CLASSES,
  SOURCE_TRUST_CLASSES,
  canonicalSourceJson,
  normalizeSourceActor,
  normalizeSourceProvenance,
  type SourceActor,
  type SourceActorInput,
  type SourceJsonObject,
  type SourceJsonValue,
  type SourcePrivacyClass,
  type SourceTrustClass,
} from './source-contracts.ts';
import {
  evidenceActionDigest,
  evidenceCanonicalText,
  evidenceSummaryHash,
} from './evidence-identity.ts';

export const EVIDENCE_RECORD_KINDS = [
  'completed-run',
  'run-artifact',
  'feedback',
  'human-decision',
] as const;
export type EvidenceRecordKind = (typeof EVIDENCE_RECORD_KINDS)[number];

// Every outcome is terminal on purpose: no in-progress value exists, so a step
// machine is unrepresentable in durable evidence.
export const EVIDENCE_OUTCOMES = ['succeeded', 'failed', 'partial', 'aborted'] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export const EVIDENCE_SIGNALS = ['positive', 'negative', 'mixed'] as const;
export type EvidenceSignal = (typeof EVIDENCE_SIGNALS)[number];

export const EVIDENCE_REQUESTED_DECISIONS = ['approval', 'choice', 'confirmation'] as const;
export type EvidenceRequestedDecision = (typeof EVIDENCE_REQUESTED_DECISIONS)[number];

export const EVIDENCE_ANSWERS = ['approved', 'rejected', 'revised', 'deferred'] as const;
export type EvidenceAnswer = (typeof EVIDENCE_ANSWERS)[number];

export const EVIDENCE_SOURCE_KINDS = ['brain-source-version', 'external'] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

// The record verbs are host-asserted evidence only. Legacy import trust classes
// stay outside this path; the column vocabulary remains the shared closed set.
export const EVIDENCE_RECORD_TRUST_CLASSES = ['host-asserted'] as const satisfies readonly SourceTrustClass[];

export const EVIDENCE_SCHEMA_VERSION = 1;

export const MAX_RUN_RECORD_BYTES = 262_144;
export const MAX_EVIDENCE_RECORD_BYTES = 65_536;
export const MAX_EVIDENCE_SOURCES = 64;
export const MAX_EVIDENCE_TOOLS = 64;

const MAX_ID_BYTES = 256;
const MAX_SUMMARY_BYTES = 4_096;
const MAX_LABEL_BYTES = 80;
const MAX_VERSION_BYTES = 128;
const MAX_MEDIA_TYPE_BYTES = 128;
const MAX_LOCATOR_BYTES = 4_096;
const MAX_ACTION_BYTES = 8_192;
const MAX_ARTIFACT_BYTES = 67_108_864;

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u;
const RECORD_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-/]*$/u;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SEMVER_ISH = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

// Credential shapes that must never enter durable evidence. The generic long-hex
// rule applies to FREE TEXT and ARBITRARY JSON only: every typed digest field
// (requestHash, sha256, summaryHash, actionDigest, sourceVersionId, and the
// actor's actionDigest) is validated by its own exact regex and never routed
// through this scan, so a legitimate digest is accepted while a bare
// credential-shaped hex blob in prose or provenance is refused.
// Mirrored byte-for-byte by brain_evidence.assert_no_credential_shape (013).
const SECRET_SHAPES: readonly RegExp[] = [
  /gh[posur]_[A-Za-z0-9]{20,}/u,
  /(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}/u,
  /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  /(?:^|[^A-Za-z0-9])(?:sk|rk)-[A-Za-z0-9_-]{16,}/u,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/u,
  /[0-9a-fA-F]{32,}/u,
];

export type EvidenceSourceInput =
  | { kind: 'brain-source-version'; sourceVersionId: string; summary?: string | null }
  | { kind: 'external'; locator: unknown; summary?: string | null };

export type EvidenceToolInput = {
  toolUseId: string;
  skillRef?: string | null;
  summary?: string | null;
};

export type CompletedRunInput = {
  runId: string;
  functionId: string;
  agentId: string;
  planId?: string | null;
  host: string;
  hostVersion: string;
  requestSummary: string;
  requestHash: string;
  startedAt: string;
  completedAt: string;
  outcome: EvidenceOutcome;
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  sources: readonly EvidenceSourceInput[];
  tools: readonly EvidenceToolInput[];
  actor: SourceActorInput;
  provenance: unknown;
};

export type RunArtifactInput = {
  runId: string;
  artifactId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  pointer: { kind: 'external'; locator: unknown };
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  actor: SourceActorInput;
  provenance: unknown;
};

export type FeedbackInput = {
  feedbackId: string;
  runId: string;
  signal: EvidenceSignal;
  summary: string;
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  actor: SourceActorInput;
  provenance: unknown;
};

export type HumanDecisionActionInput = {
  target: string;
  effect: string;
  scope: string;
  params: unknown;
};

export type HumanDecisionInput = {
  decisionId: string;
  action: HumanDecisionActionInput;
  actionSummary: string;
  requestedDecision: EvidenceRequestedDecision;
  answer: EvidenceAnswer;
  privacy: SourcePrivacyClass;
  trust: SourceTrustClass;
  actor: SourceActorInput;
  decidedAt: string;
  hostProvenance: unknown;
  relatedRunId?: string | null;
  relatedArtifactId?: string | null;
};

export type NormalizedEvidenceRecord = Readonly<{
  kind: EvidenceRecordKind;
  record: SourceJsonObject;
  canonical: string;
}>;

export function evidenceFailure(
  field: string,
  reason: string,
  details: Record<string, JsonValue> = {},
): never {
  throw new RosterError({
    header: 'Invalid Brain evidence input',
    body: `The '${field}' field is invalid: ${reason}.`,
    remedy: 'Provide a bounded value that follows the documented Brain evidence contract.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_EVIDENCE_INPUT_INVALID',
    details: { field, reason, ...details },
  });
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function looksSecretShaped(value: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(value));
}

function boundedText(
  field: string,
  value: unknown,
  maximum: number,
  options: { pattern?: RegExp; secretScan?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    evidenceFailure(field, 'it must be a non-empty string');
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximum) {
    evidenceFailure(field, `it exceeds ${maximum} UTF-8 bytes`, { maximum, observed_bytes: bytes });
  }
  if (!isWellFormed(value) || hasControl(value)) {
    evidenceFailure(field, 'it contains invalid Unicode or control characters');
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    evidenceFailure(field, 'it contains unsupported characters');
  }
  if (options.secretScan === true && looksSecretShaped(value)) {
    evidenceFailure(field, 'it looks like a credential and must never enter durable evidence');
  }
  return value;
}

function optionalText(
  field: string,
  value: unknown,
  maximum: number,
  options: { pattern?: RegExp; secretScan?: boolean } = {},
): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(field, value, maximum, options);
}

// Shared normalizers report the source-contract code; an evidence verb must
// always answer with the evidence taxonomy.
function withEvidenceFailure<T>(field: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RosterError && error.code === 'BRAIN_SOURCE_INPUT_INVALID') {
      const reason = typeof error.details.reason === 'string'
        ? error.details.reason
        : 'it is not a supported evidence value';
      evidenceFailure(field, reason);
    }
    throw error;
  }
}

function boundedJsonObject(field: string, value: unknown, maximum: number): SourceJsonObject {
  const cloned = withEvidenceFailure(field, () => normalizeSourceProvenance(value));
  scanJsonLeaves(field, cloned);
  const bytes = Buffer.byteLength(canonicalSourceJson(cloned), 'utf8');
  if (bytes > maximum) {
    evidenceFailure(field, `it exceeds ${maximum} canonical JSON bytes`, {
      maximum,
      observed_bytes: bytes,
    });
  }
  return cloned;
}

function scanJsonLeaves(field: string, value: SourceJsonValue): void {
  if (typeof value === 'string') {
    if (hasControl(value)) evidenceFailure(field, 'it contains control characters');
    if (looksSecretShaped(value)) {
      evidenceFailure(field, 'it looks like a credential and must never enter durable evidence');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) scanJsonLeaves(field, entry);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (hasControl(key)) evidenceFailure(field, 'it contains a control character in a key');
      scanJsonLeaves(field, entry);
    }
  }
}

function normalizeInstant(field: string, value: unknown): string {
  const raw = boundedText(field, value, 64);
  if (!RFC3339.test(raw)) {
    evidenceFailure(field, 'it must be an RFC 3339 timestamp with at most millisecond precision');
  }
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) evidenceFailure(field, 'it is not a real timestamp');
  return new Date(time).toISOString();
}

function assertExactKeys(field: string, value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    evidenceFailure(field, 'it contains missing or unknown fields');
  }
}

function assertNoUnknownKeys(field: string, value: object, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) evidenceFailure(field, 'it contains unknown fields');
}

function assertVocabulary<T extends string>(
  field: string,
  value: unknown,
  vocabulary: readonly T[],
): T {
  if (typeof value !== 'string' || !(vocabulary as readonly string[]).includes(value)) {
    evidenceFailure(field, 'it is not a supported value');
  }
  return value as T;
}

function normalizeActor(input: SourceActorInput, trust: SourceTrustClass): SourceActor {
  const actor = withEvidenceFailure('actor', () => normalizeSourceActor(input));
  if (!(ACTOR_ASSURANCES as readonly string[]).includes(actor.assurance)) {
    evidenceFailure('actor.assurance', 'it is not a supported assurance');
  }
  if (trust === 'host-asserted'
    && actor.assurance !== 'host-attested'
    && actor.assurance !== 'human-confirmed') {
    evidenceFailure('trust', 'host-asserted evidence requires host-attested or human-confirmed actor evidence');
  }
  return actor;
}

function normalizeClasses(input: {
  privacy: unknown;
  trust: unknown;
}): { privacy: SourcePrivacyClass; trust: SourceTrustClass } {
  const privacy = assertVocabulary('privacy', input.privacy, SOURCE_PRIVACY_CLASSES);
  const trust = assertVocabulary('trust', input.trust, SOURCE_TRUST_CLASSES);
  if (!(EVIDENCE_RECORD_TRUST_CLASSES as readonly string[]).includes(trust)) {
    evidenceFailure('trust', 'the record verbs accept host-asserted evidence only');
  }
  return { privacy, trust };
}

function assertCanonicalBytes(kind: EvidenceRecordKind, canonical: string): void {
  const maximum = kind === 'completed-run' ? MAX_RUN_RECORD_BYTES : MAX_EVIDENCE_RECORD_BYTES;
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes > maximum) {
    evidenceFailure('record', `the canonical record exceeds ${maximum} UTF-8 bytes`, {
      maximum,
      observed_bytes: bytes,
    });
  }
}

function sealRecord(kind: EvidenceRecordKind, record: SourceJsonObject): NormalizedEvidenceRecord {
  const canonical = evidenceCanonicalText(record as unknown as SourceJsonValue);
  assertCanonicalBytes(kind, canonical);
  return Object.freeze({ kind, record, canonical });
}

function normalizeSourceEntry(input: EvidenceSourceInput, index: number): SourceJsonObject {
  const field = `sources[${index}]`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure(field, 'it must be a source mapping');
  }
  const kind = assertVocabulary(`${field}.kind`, input.kind, EVIDENCE_SOURCE_KINDS);
  if (kind === 'brain-source-version') {
    assertNoUnknownKeys(field, input, ['kind', 'sourceVersionId', 'summary']);
    const sourceVersionId = boundedText(
      `${field}.sourceVersionId`,
      (input as { sourceVersionId: unknown }).sourceVersionId,
      MAX_ID_BYTES,
      { pattern: SHA256_ID },
    );
    return {
      kind,
      source_version_id: sourceVersionId,
      locator: null,
      summary: optionalText(`${field}.summary`, input.summary, MAX_SUMMARY_BYTES, { secretScan: true }),
    };
  }
  assertNoUnknownKeys(field, input, ['kind', 'locator', 'summary']);
  return {
    kind,
    source_version_id: null,
    locator: boundedJsonObject(`${field}.locator`, (input as { locator: unknown }).locator, MAX_LOCATOR_BYTES),
    summary: optionalText(`${field}.summary`, input.summary, MAX_SUMMARY_BYTES, { secretScan: true }),
  };
}

function normalizeToolEntry(input: EvidenceToolInput, index: number): SourceJsonObject {
  const field = `tools[${index}]`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure(field, 'it must be a tool mapping');
  }
  assertNoUnknownKeys(field, input, ['toolUseId', 'skillRef', 'summary']);
  return {
    tool_use_id: boundedText(`${field}.toolUseId`, input.toolUseId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    skill_ref: optionalText(`${field}.skillRef`, input.skillRef, MAX_ID_BYTES, { pattern: STABLE_ID }),
    summary: optionalText(`${field}.summary`, input.summary, MAX_SUMMARY_BYTES, { secretScan: true }),
  };
}

export function normalizeCompletedRun(input: CompletedRunInput): NormalizedEvidenceRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure('input', 'it must be a completed-run mapping');
  }
  assertNoUnknownKeys('input', input, [
    'runId',
    'functionId',
    'agentId',
    'planId',
    'host',
    'hostVersion',
    'requestSummary',
    'requestHash',
    'startedAt',
    'completedAt',
    'outcome',
    'privacy',
    'trust',
    'sources',
    'tools',
    'actor',
    'provenance',
  ]);
  const { privacy, trust } = normalizeClasses(input);
  const startedAt = normalizeInstant('startedAt', input.startedAt);
  const completedAt = normalizeInstant('completedAt', input.completedAt);
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    evidenceFailure('completedAt', 'it precedes startedAt');
  }
  if (!Array.isArray(input.sources)) evidenceFailure('sources', 'it must be an array');
  if (input.sources.length > MAX_EVIDENCE_SOURCES) {
    evidenceFailure('sources', `it exceeds ${MAX_EVIDENCE_SOURCES} entries`);
  }
  if (!Array.isArray(input.tools)) evidenceFailure('tools', 'it must be an array');
  if (input.tools.length > MAX_EVIDENCE_TOOLS) {
    evidenceFailure('tools', `it exceeds ${MAX_EVIDENCE_TOOLS} entries`);
  }
  const record: SourceJsonObject = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    kind: 'completed-run',
    run_id: boundedText('runId', input.runId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    function_id: boundedText('functionId', input.functionId, MAX_LABEL_BYTES, { pattern: RECORD_ID }),
    agent_id: boundedText('agentId', input.agentId, MAX_LABEL_BYTES, { pattern: RECORD_ID }),
    plan_id: optionalText('planId', input.planId, MAX_LABEL_BYTES, { pattern: RECORD_ID }),
    host: assertVocabulary('host', input.host, ['claude', 'codex'] as const),
    host_version: boundedText('hostVersion', input.hostVersion, MAX_VERSION_BYTES, { pattern: SEMVER_ISH }),
    roster_version: boundedText('rosterVersion', getPackageVersion(), MAX_VERSION_BYTES, { pattern: SEMVER_ISH }),
    request_summary: boundedText('requestSummary', input.requestSummary, MAX_SUMMARY_BYTES, { secretScan: true }),
    request_hash: boundedText('requestHash', input.requestHash, MAX_ID_BYTES, { pattern: SHA256_ID }),
    started_at: startedAt,
    completed_at: completedAt,
    outcome: assertVocabulary('outcome', input.outcome, EVIDENCE_OUTCOMES),
    privacy_class: privacy,
    trust_class: trust,
    sources: input.sources.map((entry, index) => normalizeSourceEntry(entry, index)),
    tools: input.tools.map((entry, index) => normalizeToolEntry(entry, index)),
    actor: normalizeActor(input.actor, trust) as unknown as SourceJsonValue,
    provenance: boundedJsonObject('provenance', input.provenance, MAX_EVIDENCE_RECORD_BYTES),
  };
  return sealRecord('completed-run', record);
}

export function normalizeRunArtifact(input: RunArtifactInput): NormalizedEvidenceRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure('input', 'it must be a run-artifact mapping');
  }
  assertNoUnknownKeys('input', input, [
    'runId',
    'artifactId',
    'sha256',
    'byteLength',
    'mediaType',
    'pointer',
    'privacy',
    'trust',
    'actor',
    'provenance',
  ]);
  const { privacy, trust } = normalizeClasses(input);
  if (input.pointer === null || typeof input.pointer !== 'object' || Array.isArray(input.pointer)) {
    evidenceFailure('pointer', 'it must be a pointer mapping');
  }
  assertExactKeys('pointer', input.pointer, ['kind', 'locator']);
  if (input.pointer.kind !== 'external') {
    evidenceFailure('pointer.kind', 'artifact evidence is external-pointer-only in this contract');
  }
  if (!Number.isSafeInteger(input.byteLength)
    || input.byteLength < 0
    || input.byteLength > MAX_ARTIFACT_BYTES) {
    evidenceFailure('byteLength', `it must be an integer between 0 and ${MAX_ARTIFACT_BYTES}`);
  }
  const record: SourceJsonObject = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    kind: 'run-artifact',
    run_id: boundedText('runId', input.runId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    artifact_id: boundedText('artifactId', input.artifactId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    sha256: boundedText('sha256', input.sha256, 64, { pattern: SHA256_HEX }),
    byte_length: input.byteLength,
    media_type: boundedText('mediaType', input.mediaType, MAX_MEDIA_TYPE_BYTES, { pattern: MEDIA_TYPE }),
    pointer_kind: 'external',
    external_locator: boundedJsonObject('pointer.locator', input.pointer.locator, MAX_LOCATOR_BYTES),
    privacy_class: privacy,
    trust_class: trust,
    actor: normalizeActor(input.actor, trust) as unknown as SourceJsonValue,
    provenance: boundedJsonObject('provenance', input.provenance, MAX_EVIDENCE_RECORD_BYTES),
  };
  return sealRecord('run-artifact', record);
}

export function normalizeFeedback(input: FeedbackInput): NormalizedEvidenceRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure('input', 'it must be a feedback mapping');
  }
  assertNoUnknownKeys('input', input, [
    'feedbackId',
    'runId',
    'signal',
    'summary',
    'privacy',
    'trust',
    'actor',
    'provenance',
  ]);
  const { privacy, trust } = normalizeClasses(input);
  const summary = boundedText('summary', input.summary, MAX_SUMMARY_BYTES, { secretScan: true });
  const record: SourceJsonObject = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    kind: 'feedback',
    feedback_id: boundedText('feedbackId', input.feedbackId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    run_id: boundedText('runId', input.runId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    signal: assertVocabulary('signal', input.signal, EVIDENCE_SIGNALS),
    summary,
    summary_hash: evidenceSummaryHash(summary),
    privacy_class: privacy,
    trust_class: trust,
    actor: normalizeActor(input.actor, trust) as unknown as SourceJsonValue,
    provenance: boundedJsonObject('provenance', input.provenance, MAX_EVIDENCE_RECORD_BYTES),
  };
  return sealRecord('feedback', record);
}

export function normalizeDecisionAction(input: HumanDecisionActionInput): SourceJsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure('action', 'it must be an action mapping');
  }
  assertExactKeys('action', input, ['target', 'effect', 'scope', 'params']);
  const action: SourceJsonObject = {
    target: boundedText('action.target', input.target, MAX_ID_BYTES, { secretScan: true }),
    effect: boundedText('action.effect', input.effect, MAX_ID_BYTES, { secretScan: true }),
    scope: boundedText('action.scope', input.scope, MAX_ID_BYTES, { secretScan: true }),
    params: boundedJsonObject('action.params', input.params, MAX_ACTION_BYTES),
  };
  const bytes = Buffer.byteLength(canonicalSourceJson(action as unknown as SourceJsonValue), 'utf8');
  if (bytes > MAX_ACTION_BYTES) {
    evidenceFailure('action', `it exceeds ${MAX_ACTION_BYTES} canonical JSON bytes`);
  }
  return action;
}

export function normalizeHumanDecision(input: HumanDecisionInput): NormalizedEvidenceRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    evidenceFailure('input', 'it must be a human-decision mapping');
  }
  assertNoUnknownKeys('input', input, [
    'decisionId',
    'action',
    'actionSummary',
    'requestedDecision',
    'answer',
    'privacy',
    'trust',
    'actor',
    'decidedAt',
    'hostProvenance',
    'relatedRunId',
    'relatedArtifactId',
  ]);
  const { privacy, trust } = normalizeClasses(input);
  const action = normalizeDecisionAction(input.action);
  const relatedRunId = optionalText('relatedRunId', input.relatedRunId, MAX_ID_BYTES, { pattern: STABLE_ID });
  const relatedArtifactId = optionalText('relatedArtifactId', input.relatedArtifactId, MAX_ID_BYTES, {
    pattern: STABLE_ID,
  });
  if (relatedArtifactId !== null && relatedRunId === null) {
    evidenceFailure('relatedArtifactId', 'it requires its relatedRunId parent');
  }
  const record: SourceJsonObject = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    kind: 'human-decision',
    decision_id: boundedText('decisionId', input.decisionId, MAX_ID_BYTES, { pattern: STABLE_ID }),
    action,
    action_digest: evidenceActionDigest(action as unknown as SourceJsonValue),
    action_summary: boundedText('actionSummary', input.actionSummary, MAX_SUMMARY_BYTES, { secretScan: true }),
    requested_decision: assertVocabulary('requestedDecision', input.requestedDecision, EVIDENCE_REQUESTED_DECISIONS),
    answer: assertVocabulary('answer', input.answer, EVIDENCE_ANSWERS),
    privacy_class: privacy,
    trust_class: trust,
    actor: normalizeActor(input.actor, trust) as unknown as SourceJsonValue,
    decided_at: normalizeInstant('decidedAt', input.decidedAt),
    host_provenance: boundedJsonObject('hostProvenance', input.hostProvenance, MAX_EVIDENCE_RECORD_BYTES),
    related_run_id: relatedRunId,
    related_artifact_id: relatedArtifactId,
  };
  return sealRecord('human-decision', record);
}
