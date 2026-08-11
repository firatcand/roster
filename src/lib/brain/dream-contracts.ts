import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import { parseScope } from '../workspace-layout.ts';
import { canonicalSourceJson, type SourceJsonValue } from './source-contracts.ts';
import { evidenceDigest } from './evidence-identity.ts';

export const DREAM_SCHEMA_VERSION = 1;

export const DREAM_POLICY_FINGERPRINT_DOMAIN = 'roster.brain.dream.policy.v1';
export const DREAM_READINESS_KEY_DOMAIN = 'roster.brain.dream.readiness-key.v1';

export const DREAM_POLICY_LOCK_DOMAIN = 'roster.brain.dream.lock.policy.v1';
export const DREAM_WATERMARK_LOCK_DOMAIN = 'roster.brain.dream.lock.watermark.v1';
export const DREAM_OBSERVATION_LOCK_DOMAIN = 'roster.brain.evidence.lock.observation.v1';

export type DreamScopeKind = 'workspace' | 'function' | 'agent' | 'plan';

export type DreamScope = Readonly<{
  key: string;
  kind: DreamScopeKind;
  functionId: string | null;
  agentId: string | null;
  planId: string | null;
}>;

// The exact grammar the 014 scope_key CHECK enforces. Kept as one literal so the
// TypeScript validator and the SQL constraint can be pinned against each other.
export const DREAM_SCOPE_KEY_PATTERN =
  /^(?:workspace|function:[a-z0-9]+(?:-[a-z0-9]+)*|agent:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*|plan:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*)$/u;

const DREAM_POLICY_VERSION_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)*\.v[0-9]+$/u;
const DREAM_AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const DREAM_EVIDENCE_WINDOW_SECONDS = Object.freeze({ minimum: 3_600, maximum: 31_536_000 });
export const DREAM_COOLDOWN_SECONDS = Object.freeze({ minimum: 0, maximum: 2_592_000 });
export const DREAM_MAX_EXCLUDED_AGENT_IDS = 64;

export type DreamPolicySource = 'built-in' | 'brain';

export type DreamPolicy = Readonly<{
  policyVersion: string;
  scopeKey: string;
  minCompletedRuns: number;
  minFeedbackRecords: number;
  minSignalMix: number;
  evidenceWindow: string;
  cooldown: string;
  excludedAgentIds: readonly string[];
}>;

// A code constant, not a seeded row: bootstrap runs migrations BEFORE the
// protected workspace identity exists, so a migration-time seed could not derive
// workspace_id. The constant also keeps a fresh Brain functional with zero rows.
export const DEFAULT_DREAM_POLICY: DreamPolicy = Object.freeze({
  policyVersion: 'roster.dream.default.v1',
  scopeKey: 'workspace',
  minCompletedRuns: 5,
  minFeedbackRecords: 0,
  minSignalMix: 0,
  evidenceWindow: 'P30D',
  cooldown: 'PT20H',
  excludedAgentIds: Object.freeze(['dreamer']) as readonly string[],
});

// 015 RESERVES this exact version string against registration, which is what
// makes "the candidate's policy version equals the effective version" imply
// "the same policy bytes": every other version is a stored, byte-immutable row,
// and this one can only ever be the code constant below. The SQL literal is
// pinned against this constant by the contracts suite.
export const RESERVED_DREAM_POLICY_VERSION: string = DEFAULT_DREAM_POLICY.policyVersion;

export const DREAM_READINESS_REASONS = [
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
] as const;

export type DreamReadinessReasonCode = (typeof DREAM_READINESS_REASONS)[number];

export type DreamReadinessReason = Readonly<{ code: DreamReadinessReasonCode; detail: string }>;

export type DreamWatermarkState = 'genesis' | 'advanced';

export type DreamReadinessStatus = 'due' | 'not_due';

export type DreamReadinessResult = Readonly<{
  ok: true;
  schema_version: number;
  status: DreamReadinessStatus;
  readiness_key: string;
  evaluated_at: string;
  workspace_id: string;
  scope: Readonly<{
    key: string;
    kind: DreamScopeKind;
    function_id: string | null;
    agent_id: string | null;
    plan_id: string | null;
  }>;
  policy: Readonly<{
    version: string;
    source: DreamPolicySource;
    scope_key: string;
    fingerprint: string;
    min_completed_runs: number;
    min_feedback_records: number;
    min_signal_mix: number;
    evidence_window: string;
    cooldown: string;
    excluded_agent_ids: readonly string[];
  }>;
  watermark: Readonly<{
    state: DreamWatermarkState;
    sequence: number;
    ordinal: number;
    reason: string | null;
    advanced_at: string | null;
    policy_version: string | null;
  }>;
  frontier: Readonly<{ ordinal: number; eligible_observations: number }>;
  evidence: Readonly<{
    window_start: string;
    window_end: string;
    window_start_bound: 'evidence-window' | 'watermark';
    completed_runs: number;
    feedback_records: number;
    signal_mix: number;
    outcomes: Readonly<{ succeeded: number; failed: number; partial: number; aborted: number }>;
    signals: Readonly<{ positive: number; negative: number; mixed: number }>;
  }>;
  cooldown: Readonly<{ active: boolean; until: string | null; remaining: string | null }>;
  reasons: readonly DreamReadinessReason[];
}>;

export function dreamFailure(
  code: string,
  body: string,
  remedy: string,
  details: Record<string, JsonValue> = {},
): RosterError {
  return new RosterError({
    header: 'Dreamer readiness refused the operation',
    body,
    remedy,
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

function invalid(body: string, details: Record<string, JsonValue> = {}): never {
  throw dreamFailure(
    'BRAIN_DREAM_INPUT_INVALID',
    body,
    'Correct the Dreamer policy or scope input and retry.',
    details,
  );
}

export function canonicalizeDreamScope(value?: string): DreamScope {
  if (value === undefined || value === 'workspace') {
    return Object.freeze({
      key: 'workspace',
      kind: 'workspace',
      functionId: null,
      agentId: null,
      planId: null,
    });
  }
  const parsed = parseScope(value);
  const scope: DreamScope = Object.freeze({
    key: parsed.kind === 'workspace' ? 'workspace' : `${parsed.kind}:${parsed.qualifiedId}`,
    kind: parsed.kind,
    functionId: parsed.scope.function ?? null,
    agentId: parsed.scope.agent ?? null,
    planId: parsed.scope.plan ?? null,
  });
  // parseScope accepts every record id, which is a wider alphabet than the
  // durable scope_key CHECK. Refusing here keeps the CLI and the column in step.
  if (!DREAM_SCOPE_KEY_PATTERN.test(scope.key)) {
    invalid(`The scope "${scope.key}" is not a durable Dreamer scope key.`, { scope: scope.key });
  }
  return scope;
}

// Specificity-ordered resolution chain: the requested scope first, then each
// broader ancestor, ending at the workspace. Position IS the precedence.
export function dreamScopeResolutionChain(scope: DreamScope): readonly string[] {
  const chain: string[] = [];
  if (scope.kind === 'plan') chain.push(scope.key);
  if (scope.kind === 'plan' || scope.kind === 'agent') {
    chain.push(`agent:${scope.functionId}/${scope.agentId}`);
  }
  if (scope.kind === 'plan' || scope.kind === 'agent' || scope.kind === 'function') {
    chain.push(`function:${scope.functionId}`);
  }
  chain.push('workspace');
  return Object.freeze([...new Set(chain)]);
}

// ISO-8601 durations are the wire format; PostgreSQL holds an `interval` and the
// readiness query reports EXTRACT(EPOCH). Seconds are the exchange unit, so no
// `intervalstyle` GUC is ever read and no calendar arithmetic is implied.
export function dreamDurationSeconds(value: string): number {
  const match =
    /^P(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/u.exec(value);
  if (match === null || value === 'P' || value === 'PT') {
    invalid(`The duration "${value}" is not a supported ISO-8601 day/time duration.`, {
      duration: value,
    });
  }
  const [, days, hours, minutes, seconds] = match;
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
    invalid(`The duration "${value}" is not a supported ISO-8601 day/time duration.`, {
      duration: value,
    });
  }
  return Number(days ?? 0) * 86_400
    + Number(hours ?? 0) * 3_600
    + Number(minutes ?? 0) * 60
    + Number(seconds ?? 0);
}

export function dreamDurationText(totalSeconds: number): string {
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 0) {
    invalid('A Dreamer duration must be a non-negative whole number of seconds.', {
      seconds: totalSeconds,
    });
  }
  if (totalSeconds === 0) return 'PT0S';
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const time = `${hours === 0 ? '' : `${hours}H`}${minutes === 0 ? '' : `${minutes}M`}${
    seconds === 0 ? '' : `${seconds}S`
  }`;
  return `P${days === 0 ? '' : `${days}D`}${time.length === 0 ? '' : `T${time}`}`;
}

function assertBoundedInteger(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a whole number between ${minimum} and ${maximum}.`, {
      field: label,
      value,
    });
  }
  return value;
}

export function assertDreamPolicy(policy: DreamPolicy): DreamPolicy {
  if (!DREAM_POLICY_VERSION_PATTERN.test(policy.policyVersion)) {
    invalid(`The policy version "${policy.policyVersion}" is not a dotted lowercase .vN identity.`, {
      policy_version: policy.policyVersion,
    });
  }
  if (!DREAM_SCOPE_KEY_PATTERN.test(policy.scopeKey)) {
    invalid(`The policy scope "${policy.scopeKey}" is not a durable Dreamer scope key.`, {
      scope: policy.scopeKey,
    });
  }
  assertBoundedInteger('min_completed_runs', policy.minCompletedRuns, 1, 10_000);
  assertBoundedInteger('min_feedback_records', policy.minFeedbackRecords, 0, 10_000);
  assertBoundedInteger('min_signal_mix', policy.minSignalMix, 0, 10_000);
  assertBoundedInteger(
    'evidence_window',
    dreamDurationSeconds(policy.evidenceWindow),
    DREAM_EVIDENCE_WINDOW_SECONDS.minimum,
    DREAM_EVIDENCE_WINDOW_SECONDS.maximum,
  );
  assertBoundedInteger(
    'cooldown',
    dreamDurationSeconds(policy.cooldown),
    DREAM_COOLDOWN_SECONDS.minimum,
    DREAM_COOLDOWN_SECONDS.maximum,
  );
  if (policy.excludedAgentIds.length > DREAM_MAX_EXCLUDED_AGENT_IDS) {
    invalid(`excluded_agent_ids holds more than ${DREAM_MAX_EXCLUDED_AGENT_IDS} entries.`, {
      count: policy.excludedAgentIds.length,
    });
  }
  const seen = new Set<string>();
  for (const agentId of policy.excludedAgentIds) {
    if (typeof agentId !== 'string' || !DREAM_AGENT_ID_PATTERN.test(agentId)) {
      invalid('excluded_agent_ids holds an unsupported agent id.', { agent_id: String(agentId) });
    }
    // A duplicate is refused rather than deduped: the durable CHECK refuses it,
    // and a silently deduped list would fingerprint differently from the row.
    if (seen.has(agentId)) invalid('excluded_agent_ids holds a duplicate agent id.', { agent_id: agentId });
    seen.add(agentId);
  }
  return policy;
}

function dreamPolicyValue(policy: DreamPolicy): SourceJsonValue {
  return {
    policy_version: policy.policyVersion,
    scope_key: policy.scopeKey,
    min_completed_runs: policy.minCompletedRuns,
    min_feedback_records: policy.minFeedbackRecords,
    min_signal_mix: policy.minSignalMix,
    evidence_window_seconds: dreamDurationSeconds(policy.evidenceWindow),
    cooldown_seconds: dreamDurationSeconds(policy.cooldown),
    excluded_agent_ids: [...policy.excludedAgentIds],
  };
}

// The fingerprint covers every threshold, so a threshold edit legitimately opens
// a new occasion even when the version string is reused.
export function dreamPolicyFingerprint(policy: DreamPolicy): string {
  return evidenceDigest(DREAM_POLICY_FINGERPRINT_DOMAIN, dreamPolicyValue(assertDreamPolicy(policy)));
}

export type DreamPolicyRegistration = DreamPolicy & Readonly<{
  activationAssurance: 'system-derived' | 'human-confirmed';
  registeredBy: string;
}>;

export function dreamPolicyCanonical(registration: DreamPolicyRegistration): string {
  assertDreamPolicy(registration);
  if (registration.registeredBy.length === 0
    || Buffer.byteLength(registration.registeredBy, 'utf8') > 256) {
    invalid('registered_by must be 1..256 UTF-8 bytes.', { registered_by: registration.registeredBy });
  }
  return canonicalSourceJson({
    kind: 'dream-policy',
    schema_version: DREAM_SCHEMA_VERSION,
    activation_assurance: registration.activationAssurance,
    registered_by: registration.registeredBy,
    ...(dreamPolicyValue(registration) as { [key: string]: SourceJsonValue }),
  });
}

export type DreamWatermarkAdvance = Readonly<{
  scopeKey: string;
  cursorOrdinal: number;
  policyVersion: string;
  reason: 'promotion';
  consumedCompletedRuns: number;
  consumedFeedbackRecords: number;
  actorAssurance: 'system-derived' | 'caller-asserted' | 'host-attested' | 'human-confirmed';
}>;

export function dreamWatermarkCanonical(advance: DreamWatermarkAdvance): string {
  if (!DREAM_SCOPE_KEY_PATTERN.test(advance.scopeKey)) {
    invalid(`The scope "${advance.scopeKey}" is not a durable Dreamer scope key.`, {
      scope: advance.scopeKey,
    });
  }
  if (!DREAM_POLICY_VERSION_PATTERN.test(advance.policyVersion)) {
    invalid(`The policy version "${advance.policyVersion}" is not a dotted lowercase .vN identity.`, {
      policy_version: advance.policyVersion,
    });
  }
  assertBoundedInteger('cursor_ordinal', advance.cursorOrdinal, 1, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger('consumed_completed_runs', advance.consumedCompletedRuns, 0, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger('consumed_feedback_records', advance.consumedFeedbackRecords, 0, Number.MAX_SAFE_INTEGER);
  return canonicalSourceJson({
    kind: 'dream-watermark',
    schema_version: DREAM_SCHEMA_VERSION,
    scope_key: advance.scopeKey,
    cursor_ordinal: advance.cursorOrdinal,
    policy_version: advance.policyVersion,
    reason: advance.reason,
    consumed_completed_runs: advance.consumedCompletedRuns,
    consumed_feedback_records: advance.consumedFeedbackRecords,
    actor_assurance: advance.actorAssurance,
  });
}

// The activation identity #358 keys candidates on. It digests BOTH cursors: the
// promotion-only watermark floor AND the observed-evidence frontier ceiling, so
// any later eligible arrival -- run OR feedback -- opens a new occasion, and two
// hosts reading the same snapshot collapse to one candidate on replay.
export function dreamReadinessKey(input: {
  workspaceId: string;
  scopeKey: string;
  policyVersion: string;
  policyFingerprint: string;
  watermarkOrdinal: number;
  frontierOrdinal: number;
}): string {
  return evidenceDigest(DREAM_READINESS_KEY_DOMAIN, {
    workspace_id: input.workspaceId,
    scope_key: input.scopeKey,
    policy_version: input.policyVersion,
    policy_fingerprint: input.policyFingerprint,
    watermark_ordinal: input.watermarkOrdinal,
    frontier_ordinal: input.frontierOrdinal,
  });
}

export function brainNotConfiguredReadiness(
  workspaceId: string,
  scope: DreamScope,
  evaluatedAt: string,
): DreamReadinessResult {
  const policy = DEFAULT_DREAM_POLICY;
  const result: DreamReadinessResult = {
    ok: true,
    schema_version: DREAM_SCHEMA_VERSION,
    status: 'not_due',
    readiness_key: dreamReadinessKey({
      workspaceId,
      scopeKey: scope.key,
      policyVersion: policy.policyVersion,
      policyFingerprint: dreamPolicyFingerprint(policy),
      watermarkOrdinal: 0,
      frontierOrdinal: 0,
    }),
    evaluated_at: evaluatedAt,
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
      source: 'built-in',
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
      state: 'genesis',
      sequence: 0,
      ordinal: 0,
      reason: null,
      advanced_at: null,
      policy_version: null,
    },
    frontier: { ordinal: 0, eligible_observations: 0 },
    evidence: {
      window_start: evaluatedAt,
      window_end: evaluatedAt,
      window_start_bound: 'evidence-window',
      completed_runs: 0,
      feedback_records: 0,
      signal_mix: 0,
      outcomes: { succeeded: 0, failed: 0, partial: 0, aborted: 0 },
      signals: { positive: 0, negative: 0, mixed: 0 },
    },
    cooldown: { active: false, until: null, remaining: null },
    reasons: [{
      code: 'BRAIN_NOT_CONFIGURED',
      detail: 'This workspace has no tracked Brain configuration, so no evidence can be observed.',
    }],
  };
  return Object.freeze(result);
}

export function dreamReadinessReasons(counts: {
  eligibleObservations: number;
  completedRuns: number;
  feedbackRecords: number;
  signalMix: number;
  policy: DreamPolicy;
  cooldownActive: boolean;
}): readonly DreamReadinessReason[] {
  const reasons: DreamReadinessReason[] = [];
  if (counts.eligibleObservations === 0) {
    reasons.push({
      code: 'NO_ELIGIBLE_EVIDENCE',
      detail: 'No eligible observation sits above the watermark inside the evidence window.',
    });
  }
  const runsMet = counts.completedRuns >= counts.policy.minCompletedRuns;
  reasons.push({
    code: runsMet ? 'MIN_RUNS_MET' : 'MIN_RUNS_NOT_MET',
    detail: `${counts.completedRuns} eligible completed runs against a minimum of ${counts.policy.minCompletedRuns}`,
  });
  const feedbackMet = counts.feedbackRecords >= counts.policy.minFeedbackRecords;
  reasons.push({
    code: feedbackMet ? 'MIN_FEEDBACK_MET' : 'MIN_FEEDBACK_NOT_MET',
    detail: `${counts.feedbackRecords} eligible feedback records against a minimum of ${counts.policy.minFeedbackRecords}`,
  });
  const mixMet = counts.signalMix >= counts.policy.minSignalMix;
  reasons.push({
    code: mixMet ? 'SIGNAL_MIX_MET' : 'SIGNAL_MIX_NOT_MET',
    detail: `${counts.signalMix} eligible negative/mixed signals against a minimum of ${counts.policy.minSignalMix}`,
  });
  reasons.push({
    code: counts.cooldownActive ? 'COOLDOWN_ACTIVE' : 'COOLDOWN_INACTIVE',
    detail: counts.cooldownActive
      ? `The promotion cooldown of ${counts.policy.cooldown} has not elapsed`
      : `The promotion cooldown of ${counts.policy.cooldown} is not holding this scope`,
  });
  return Object.freeze(reasons);
}
