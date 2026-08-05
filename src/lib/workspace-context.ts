import { createHash } from 'node:crypto';
import {
  detectAuthoredSecretMaterial,
  hasCredentialShape,
  type AuthoredSecretDetectorId,
} from './authored-secret-detector.ts';
import type { ContextTrustClass } from './context-trust.ts';
import {
  assertPreparedContextSource,
  withContextReadCapability,
  type ContextVendorSkillProjection,
  type ContextVendorSkillSelection,
  type PreparedContextSource,
  type WorkspaceDiscoveryRecord,
} from './workspace-registry.ts';
import {
  isWorkspaceFailure,
  workspaceDiagnostic,
  workspaceFailure,
  type JsonValue,
  type WorkspaceDiagnostic,
  type WorkspaceDiagnosticCode,
  type WorkspaceRosterError,
} from './workspace-diagnostics.ts';
import {
  isRecordId,
  parseAgentQualifiedId,
  parsePlanQualifiedId,
  type WorkspaceScope,
} from './workspace-layout.ts';
import {
  parseAgentDefinition,
  parseFunctionDefinition,
  parseMarkdownDefinition,
  type AgentDefinition,
  type FunctionDefinition,
  type MarkdownDefinition,
} from './workspace-record.ts';
import {
  resolveValidatedPlanClosure,
  type StructuredPlan,
} from './workspace-plan.ts';
import {
  resolveToolUse,
  type EffectiveWorkspaceToolUse,
  type ToolUseContributor,
  type ToolUseFieldSource,
} from './workspace-tool-use.ts';
import { scanText } from './tripwire/scan.ts';
import type {
  VendorSkillHost,
  VendorSkillLocator,
} from './vendor-skills/adapter-map.ts';
import type { CanonicalSkillRef } from './vendor-skills/skill-ref.ts';

export const CONTEXT_SCHEMA_VERSION = 2 as const;
export const CONTEXT_ESTIMATOR = 'utf8-bytes-ceil-div-4/context-canonical-json-v1' as const;
export const MAX_CONTEXT_QUERY_BYTES = 16_384;
export const MAX_CONTEXT_STEP_BYTES = 4_096;
export const MAX_CONTEXT_BUDGET_TOKENS = 128_000;
export const MAX_CONTEXT_EVIDENCE_CANDIDATES = 4_096;
export const MAX_CONTEXT_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const MAX_CONTEXT_EVIDENCE_CONTENT_BYTES = 256 * 1024;
export const MAX_CONTEXT_SELECTORS = 4_096;
export const MAX_CONTEXT_MANDATORY_DIAGNOSTICS = 8;
export const MAX_CONTEXT_OPTIONAL_DIAGNOSTICS = 64;
export const BUDGET_BLOCK_RESERVE_BYTES = 740;
export const BUDGET_BLOCK_RESERVE_TOKENS = 185;
export const MIN_CONTEXT_BUDGET_TOKENS = BUDGET_BLOCK_RESERVE_TOKENS + 1;

export const CONTEXT_EXCLUSION_REASONS = [
  'budget-exhausted',
  'workspace-mismatch',
  'scope-ineligible',
  'duplicate',
  'invalid-rank',
  'low-trust',
  'malformed',
  'privacy-incompatible',
  'secret-material',
  'stale',
  'tombstoned',
  'unauthorized',
  'uncited',
  'unrequested-selector',
] as const;

export type ContextExclusionReason = (typeof CONTEXT_EXCLUSION_REASONS)[number];

export type { ContextTrustClass } from './context-trust.ts';

export type ContextInclusionReason =
  | 'target-function'
  | 'target-agent'
  | 'selected-plan-root'
  | 'nested-plan-closure'
  | 'agent-default-guideline'
  | 'plan-referenced-guideline'
  | 'applicable-lesson'
  | 'plan-tool-step'
  | 'tool-skill-ref'
  | 'selector-match'
  | 'required-selector-match'
  | 'host-query'
  | 'host-step-hint';

export type ContextFragmentKind =
  | 'function'
  | 'agent'
  | 'plan'
  | 'guideline'
  | 'lesson'
  | 'brain-evidence'
  | 'tool-use'
  | 'skill-ref';

export type ContextScope = {
  workspace: string;
  function: string | null;
  agent: string | null;
  plan: string | null;
};

export type ContextFragment<TContent> = {
  fragment_id: string;
  kind: ContextFragmentKind;
  scope: ContextScope;
  source_content_hash: string | null;
  fragment_hash: string;
  trust: ContextTrustClass;
  inclusion_reason: ContextInclusionReason;
  required: boolean;
  content_bytes: number;
  content_tokens: number;
  content: TContent;
};

export type ContextPlanContent = Omit<StructuredPlan, 'path'>;

export type ContextMarkdownContent = {
  id: string;
  kind: 'guideline' | 'lesson';
  purpose: string;
  scope: WorkspaceScope;
  body: string;
};

export type ContextToolUseContent = {
  effective: EffectiveWorkspaceToolUse;
  contributors: readonly ToolUseContributor[];
  field_sources: Readonly<Record<string, readonly ToolUseFieldSource[]>>;
  semantic_hash: string;
  references: readonly { plan_id: string; step_id: string }[];
};

export type ContextSkillRefContent = {
  skill_ref: string;
  generator_version: string;
  map_hash: string;
  authored_paths: readonly string[];
  hosts: Partial<Record<VendorSkillHost, VendorSkillLocator>>;
};

export type ContextBrainCitation = {
  logical_source_id: string;
  source_version_id: string;
  object_id: string | null;
  extractor_id: string | null;
  extractor_version: string | null;
  locator: string;
  content_hash: string;
};

export type ContextBrainEvidence = ContextFragment<string> & {
  kind: 'brain-evidence';
  privacy: 'public' | 'internal';
  candidate_scope: ContextScope;
  retrieval_reason: 'selector-match' | 'required-selector-match';
  citation: ContextBrainCitation;
};

export type ContextProvenance = {
  fragment_id: string;
  source_id: string;
  trust: ContextTrustClass;
  inclusion_reason: ContextInclusionReason;
  required: boolean;
  source_content_hash: string | null;
  fragment_hash: string;
  explanation?: string;
};

export type ContextBudgetExclusions = Record<ContextExclusionReason, number>;

export type ContextBudget = {
  estimator: typeof CONTEXT_ESTIMATOR;
  limit_tokens: number;
  mandatory_bytes: number;
  mandatory_tokens: number;
  optional_bytes: number;
  optional_tokens: number;
  reserve_bytes: number;
  reserve_tokens: number;
  total_bytes: number;
  total_tokens: number;
  remaining_tokens: number;
  exclusions: ContextBudgetExclusions;
  lessons_budget_exhausted: number;
  required_selectors_unmatched: number;
  candidate_diagnostics_omitted: number;
};

export type WorkspaceContext = {
  schema_version: typeof CONTEXT_SCHEMA_VERSION;
  workspace: {
    schema_version: 2;
    workspace_id: string;
    source_hash: string;
    brain_configured: boolean;
  };
  target: {
    function_id: string;
    agent_id: string;
    plan_id: string | null;
  };
  request: {
    query: string;
    step_hint: string | null;
    budget_tokens: number;
    explain: boolean;
  };
  agent: {
    function: ContextFragment<JsonValue>;
    agent: ContextFragment<JsonValue>;
  };
  plan: {
    root_id: string | null;
    definitions: readonly ContextFragment<ContextPlanContent>[];
  };
  guidelines: readonly ContextFragment<ContextMarkdownContent>[];
  lessons: readonly ContextFragment<ContextMarkdownContent>[];
  brain_evidence: readonly ContextBrainEvidence[];
  tool_uses: readonly ContextFragment<ContextToolUseContent>[];
  skill_refs: readonly ContextFragment<ContextSkillRefContent>[];
  provenance: readonly ContextProvenance[];
  budget: ContextBudget;
  diagnostics: readonly WorkspaceDiagnostic[];
};

export type SeedBrainCandidate = {
  candidate_id: string;
  selector: string;
  scope: {
    workspace: string;
    function?: string;
    agent?: string;
    plan?: string;
  };
  content: string;
  current: boolean;
  tombstoned: boolean;
  privacy: 'public' | 'internal' | 'secret';
  retrieval_rank: number;
  citation: ContextBrainCitation;
};

export type ContextEvidenceInput = {
  status: 'seeded' | 'unavailable';
  candidates: readonly SeedBrainCandidate[];
};

export type ContextRequest = {
  target: string;
  query: string;
  stepHint: string | null;
  budgetTokens: number;
  explain: boolean;
};

export type ResolveWorkspaceContextOptions = ContextRequest & {
  root: string;
};

export type ContextSelectorCatalogEntry = {
  selector: string;
  origins: readonly ('plan-selector' | 'tool-use-intent')[];
  required: boolean;
};

export type ContextAssemblyInstrumentation = {
  optional_content_serializations: number;
  optional_provenance_serializations: number;
  lesson_term_tokenizations: number;
  complete_domain_serializations: number;
};

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw workspaceFailure(
      'CONTEXT_RESOLUTION_FAILED',
      'Context resolution failed.',
      'Retry after validating the workspace context inputs.',
    );
  }
  return serialized;
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function cloneAndFreeze<T>(value: T): T {
  const clone = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(clone);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .map(([key, child]) => [key, clone(child)]));
    }
    return entry;
  };
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  const copied = clone(value) as T;
  freeze(copied);
  return copied;
}

function controlByteOffset(value: string): number | null {
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    if ((point >= 0 && point <= 0x1f) || (point >= 0x7f && point <= 0x9f)) {
      return Buffer.byteLength(value.slice(0, index), 'utf8');
    }
    index += point > 0xffff ? 2 : 1;
  }
  return null;
}

const CONTEXT_SECRET_DETECTOR_IDS = [
  'remote-url-userinfo',
  'password-assignment',
  'client-secret-assignment',
  'api-key-assignment',
  'aws-secret-access-key-assignment',
] as const;

type ContextSecretDetectorId = (typeof CONTEXT_SECRET_DETECTOR_IDS)[number];

type ContextSecretFinding = {
  field: string;
  detector_id: AuthoredSecretDetectorId | ContextSecretDetectorId;
  byte_offset: number;
  match_length: number;
};

function placeholderCredential(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  return normalized.length === 0
    || /^REPLACE_ME/i.test(normalized)
    || /^<[^>]+>$/.test(normalized)
    || /^\$\{[^}]+\}$/.test(normalized)
    || /^x{3,}$/i.test(normalized)
    || /^(?:changeme|example)$/i.test(normalized);
}

function localSecretFindings(source: string, field: string): ContextSecretFinding[] {
  const found: ContextSecretFinding[] = [];
  const userInfo = /\bhttps?:\/\/([^\s\/@:]+):([^\s\/@]+)@/giu;
  for (const match of source.matchAll(userInfo)) {
    const password = match[2]!;
    if (placeholderCredential(password) || !hasCredentialShape(password)) continue;
    const start = match.index + match[0].lastIndexOf(password);
    found.push({
      field,
      detector_id: 'remote-url-userinfo',
      byte_offset: Buffer.byteLength(source.slice(0, start), 'utf8'),
      match_length: Buffer.byteLength(password, 'utf8'),
    });
  }
  const assignments = /^(?:[ \t]*)(password|client_secret|api_key|aws_secret_access_key)[ \t]*[:=][ \t]*([^\r\n]*)$/gimu;
  const detectorByKey: Record<string, ContextSecretDetectorId> = {
    password: 'password-assignment',
    client_secret: 'client-secret-assignment',
    api_key: 'api-key-assignment',
    aws_secret_access_key: 'aws-secret-access-key-assignment',
  };
  for (const match of source.matchAll(assignments)) {
    const raw = match[2]!.trim();
    const value = raw.replace(/^['"]|['"]$/g, '');
    if (placeholderCredential(value) || !hasCredentialShape(value)) continue;
    const start = match.index + match[0].indexOf(raw) + Math.max(0, raw.indexOf(value));
    found.push({
      field,
      detector_id: detectorByKey[match[1]!.toLowerCase()]!,
      byte_offset: Buffer.byteLength(source.slice(0, start), 'utf8'),
      match_length: Buffer.byteLength(value, 'utf8'),
    });
  }
  return found;
}

function secretFindings(source: string, field: string): ContextSecretFinding[] {
  const findings: ContextSecretFinding[] = [
    ...detectAuthoredSecretMaterial(source).map((finding) => ({ field, ...finding })),
    ...localSecretFindings(source, field),
  ];
  findings.sort((left, right) => compareUnicodeCodePoints(left.field, right.field)
    || left.byte_offset - right.byte_offset
    || compareUnicodeCodePoints(left.detector_id, right.detector_id)
    || left.match_length - right.match_length);
  return findings.filter((finding, index) => index === 0
    || finding.field !== findings[index - 1]!.field
    || finding.byte_offset !== findings[index - 1]!.byte_offset
    || finding.detector_id !== findings[index - 1]!.detector_id
    || finding.match_length !== findings[index - 1]!.match_length);
}

function validateRequest(request: ContextRequest): void {
  const fields = [
    { name: 'query', value: request.query, maximum: MAX_CONTEXT_QUERY_BYTES },
    ...(request.stepHint === null
      ? []
      : [{ name: 'step_hint', value: request.stepHint, maximum: MAX_CONTEXT_STEP_BYTES }]),
  ];
  for (const field of fields) {
    const bytes = Buffer.byteLength(field.value, 'utf8');
    if (field.value.length === 0 || bytes > field.maximum || controlByteOffset(field.value) !== null) {
      throw workspaceFailure(
        'CONTEXT_EVIDENCE_INVALID',
        'Context request text is invalid.',
        'Pass non-empty, bounded, control-safe request text.',
        { field: field.name, observed_bytes: bytes, limit_bytes: field.maximum },
      );
    }
    const finding = secretFindings(field.value, field.name)[0];
    if (finding !== undefined) {
      throw workspaceFailure(
        'SECRET_MATERIAL_FORBIDDEN',
        'Secret material is forbidden in context request text.',
        'Replace the credential with a non-secret reference before retrying.',
        finding,
      );
    }
  }
  if (!Number.isSafeInteger(request.budgetTokens)
    || request.budgetTokens < MIN_CONTEXT_BUDGET_TOKENS
    || request.budgetTokens > MAX_CONTEXT_BUDGET_TOKENS
    || typeof request.explain !== 'boolean') {
    throw workspaceFailure(
      'CONTEXT_EVIDENCE_INVALID',
      'Context request options are invalid.',
      'Pass a supported integer token budget and a boolean explain flag.',
      { minimum_tokens: MIN_CONTEXT_BUDGET_TOKENS, maximum_tokens: MAX_CONTEXT_BUDGET_TOKENS },
    );
  }
}

type ResolvedToolUse = {
  content: ContextToolUseContent;
  references: Array<{ plan_id: string; step_id: string }>;
};

type ResolvedLocalContext = {
  functionId: string;
  agentId: string;
  planId: string | null;
  functionRecord: WorkspaceDiscoveryRecord;
  agentRecord: WorkspaceDiscoveryRecord;
  functionDefinition: FunctionDefinition;
  agentDefinition: AgentDefinition;
  plans: readonly StructuredPlan[];
  guidelineRecords: readonly { record: WorkspaceDiscoveryRecord; definition: MarkdownDefinition; reason: ContextInclusionReason }[];
  lessonRecords: readonly { record: WorkspaceDiscoveryRecord; definition: MarkdownDefinition; scopeRank: number }[];
  tools: readonly ResolvedToolUse[];
  selectors: readonly ContextSelectorCatalogEntry[];
  selection: ContextVendorSkillSelection;
  localRecordPaths: readonly string[];
};

function exactRecord(
  source: PreparedContextSource,
  kind: WorkspaceDiscoveryRecord['kind'],
  qualifiedId: string,
): WorkspaceDiscoveryRecord {
  const matches = source.snapshot.records.filter((record) => (
    record.kind === kind && record.qualified_id === qualifiedId
  ));
  if (matches.length !== 1 || matches[0]!.content === undefined) {
    throw workspaceFailure(
      matches.length > 1 ? 'IDENTITY_AMBIGUOUS' : 'REFERENCE_NOT_FOUND',
      'A selected workspace definition does not resolve exactly once.',
      'Repair the registered target identity before retrying context resolution.',
      { reference: qualifiedId, expected_kind: kind },
    );
  }
  return matches[0]!;
}

function guidelineQualifiedId(functionId: string, agentId: string, id: string, agentScoped: boolean): string {
  return agentScoped
    ? `${functionId}/${agentId}/guidelines/${id}`
    : `${functionId}/guidelines/${id}`;
}

function resolveLocalContext(source: PreparedContextSource, request: ContextRequest): ResolvedLocalContext {
  assertPreparedContextSource(source);
  validateRequest(request);
  const parsedTarget = request.target.includes('#')
    ? parsePlanQualifiedId(request.target)
    : { ...parseAgentQualifiedId(request.target), planId: null };
  const functionId = parsedTarget.functionId;
  const agentId = parsedTarget.agentId;
  const planId = parsedTarget.planId;
  const functionRecord = exactRecord(source, 'function', functionId);
  const agentRecord = exactRecord(source, 'agent', `${functionId}/${agentId}`);
  const functionDefinition = parseFunctionDefinition(functionRecord.content!, functionRecord.path);
  const agentDefinition = parseAgentDefinition(agentRecord.content!, agentRecord.path);
  if (functionDefinition.id !== functionId
    || agentDefinition.id !== agentId
    || agentDefinition.function !== functionId) {
    throw workspaceFailure(
      'IDENTITY_PATH_MISMATCH',
      'Selected workspace policy identity does not match its registered target.',
      'Repair the selected function or agent identity before retrying.',
      { function: functionId, agent: agentId },
    );
  }
  const plans = planId === null
    ? Object.freeze([] as StructuredPlan[])
    : resolveValidatedPlanClosure(source.snapshot, `${functionId}/${agentId}#${planId}`).definitions;

  const guidelineReasons = new Map<string, ContextInclusionReason>();
  for (const id of agentDefinition.default_guidelines) {
    const functionMatch = functionDefinition.guidelines.includes(id);
    const agentMatch = agentDefinition.guidelines.includes(id);
    if (functionMatch === agentMatch) {
      throw workspaceFailure(
        functionMatch ? 'IDENTITY_AMBIGUOUS' : 'REFERENCE_NOT_FOUND',
        'An agent default guideline does not resolve unambiguously.',
        'Register the default guideline at exactly one owning scope.',
        { reference: id, expected_kind: 'guideline' },
      );
    }
    guidelineReasons.set(
      guidelineQualifiedId(functionId, agentId, id, agentMatch),
      'agent-default-guideline',
    );
  }
  for (const plan of plans) {
    for (const qualifiedId of plan.guidelines) {
      if (!guidelineReasons.has(qualifiedId)) {
        guidelineReasons.set(qualifiedId, 'plan-referenced-guideline');
      }
    }
  }
  const guidelineRecords = [...guidelineReasons]
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([qualifiedId, reason]) => {
      const record = exactRecord(source, 'guideline', qualifiedId);
      const definition = parseMarkdownDefinition(record.content!, record.path);
      return { record, definition, reason };
    });

  const closureQualifiedPlanIds = new Set(plans.map((plan) => plan.qualified_id));
  const lessonRecords = source.snapshot.records
    .filter((record) => record.kind === 'lesson'
      && record.scope.function === functionId
      && record.scope.agent === agentId
      && (record.scope.plan === undefined
        || closureQualifiedPlanIds.has(`${functionId}/${agentId}#${record.scope.plan}`)))
    .map((record) => {
      const definition = parseMarkdownDefinition(record.content!, record.path);
      const scopeRank = definition.scope.plan === planId
        ? 3
        : definition.scope.plan === undefined
          ? 1
          : 2;
      return { record, definition, scopeRank };
    });

  const toolsByIdentity = new Map<string, ResolvedToolUse>();
  for (const plan of plans) {
    const [ownerFunction, ownerAgent] = plan.agent.split('/');
    for (const step of plan.steps) {
      if (step.kind !== 'tool') continue;
      const resolution = resolveToolUse(source.snapshot, {
        function: ownerFunction!,
        agent: ownerAgent!,
        plan: plan.id,
      }, step.tool_use);
      const identity = `${resolution.effective.skill_ref}\u0000${resolution.semantic_hash}`;
      const reference = { plan_id: plan.qualified_id, step_id: step.id };
      const existing = toolsByIdentity.get(identity);
      if (existing !== undefined) {
        if (!existing.references.some((entry) => (
          entry.plan_id === reference.plan_id && entry.step_id === reference.step_id
        ))) existing.references.push(reference);
        continue;
      }
      const references = [reference];
      toolsByIdentity.set(identity, {
        references,
        content: {
          effective: resolution.effective,
          contributors: resolution.contributors,
          field_sources: Object.fromEntries(Object.keys(resolution.field_sources)
            .sort(compareUnicodeCodePoints)
            .map((field) => [field, resolution.field_sources[field]!])),
          semantic_hash: resolution.semantic_hash,
          references,
        },
      });
    }
  }
  const tools = [...toolsByIdentity.values()].sort((left, right) => (
    compareUnicodeCodePoints(left.content.effective.id, right.content.effective.id)
    || compareUnicodeCodePoints(left.content.semantic_hash, right.content.semantic_hash)
  ));

  const selectorMap = new Map<string, { origins: Set<'plan-selector' | 'tool-use-intent'>; required: boolean }>();
  const addSelector = (
    selector: string,
    origin: 'plan-selector' | 'tool-use-intent',
    required: boolean,
  ): void => {
    const prior = selectorMap.get(selector) ?? { origins: new Set(), required: false };
    prior.origins.add(origin);
    prior.required ||= required;
    selectorMap.set(selector, prior);
  };
  for (const plan of plans) {
    for (const [selector, definition] of Object.entries(plan.brain_selectors)) {
      addSelector(selector, 'plan-selector', definition.required);
    }
  }
  for (const tool of tools) {
    for (const selector of tool.content.effective.brain.read) {
      addSelector(selector, 'tool-use-intent', false);
    }
  }
  if (selectorMap.size > MAX_CONTEXT_SELECTORS) {
    throw workspaceFailure(
      'READ_LIMIT_EXCEEDED',
      'The context selector catalog exceeds its bounded limit.',
      'Reduce selected plan selectors or tool-use Brain read intent.',
      { bound: 'context-selector-catalog', limit: MAX_CONTEXT_SELECTORS, entries: selectorMap.size },
    );
  }
  const selectors = [...selectorMap]
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([selector, value]) => ({
      selector,
      origins: [...value.origins].sort(compareUnicodeCodePoints),
      required: value.required,
    }));

  const skillRefPaths = new Map<CanonicalSkillRef, readonly string[]>();
  for (const tool of tools) {
    const skillRef = tool.content.effective.skill_ref;
    const paths = new Set(skillRefPaths.get(skillRef) ?? []);
    for (const contributor of tool.content.contributors) paths.add(contributor.path);
    skillRefPaths.set(skillRef, [...paths].sort(compareUnicodeCodePoints));
  }
  const skillRefs = [...skillRefPaths.keys()].sort(compareUnicodeCodePoints);
  const selection: ContextVendorSkillSelection = Object.freeze({
    skillRefs: Object.freeze(skillRefs),
    skillRefPaths,
  });
  const localRecordPaths = [...new Set([
    functionRecord.path,
    agentRecord.path,
    ...plans.map((plan) => plan.path),
    ...guidelineRecords.map((entry) => entry.record.path),
    ...lessonRecords.map((entry) => entry.record.path),
    ...tools.flatMap((tool) => tool.content.contributors.map((entry) => entry.path)),
  ])].sort(compareUnicodeCodePoints);
  return {
    functionId,
    agentId,
    planId,
    functionRecord,
    agentRecord,
    functionDefinition,
    agentDefinition,
    plans,
    guidelineRecords,
    lessonRecords,
    tools,
    selectors,
    selection,
    localRecordPaths,
  };
}

function sortedMapping<T, R>(
  value: Readonly<Record<string, T>>,
  project: (entry: T) => R,
): Record<string, R> {
  return Object.fromEntries(Object.keys(value)
    .sort(compareUnicodeCodePoints)
    .map((key) => [key, project(value[key]!) ]));
}

function projectPlan(plan: StructuredPlan): ContextPlanContent {
  const steps = plan.steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    instruction: step.instruction,
    ...(step.context === undefined ? {} : {
      context: {
        ...(step.context.brain === undefined ? {} : { brain: [...step.context.brain] }),
        ...(step.context.guidelines === undefined ? {} : { guidelines: [...step.context.guidelines] }),
      },
    }),
    ...(step.expected === undefined ? {} : {
      expected: {
        artifacts: [...step.expected.artifacts],
        output_guidance: step.expected.output_guidance,
      },
    }),
    ...(step.condition_guidance === undefined ? {} : { condition_guidance: step.condition_guidance }),
    ...(step.retry_guidance === undefined ? {} : {
      retry_guidance: {
        max_attempts: step.retry_guidance.max_attempts,
        instruction: step.retry_guidance.instruction,
      },
    }),
    ...(step.kind === 'subagent' ? { subagent: step.subagent } : {}),
    ...(step.kind === 'cross-agent' ? { agent: step.agent } : {}),
    ...(step.kind === 'nested-plan' ? { plan: step.plan } : {}),
    ...(step.kind === 'tool' ? { tool_use: step.tool_use } : {}),
    ...(step.kind === 'approval' ? { approval_guidance: step.approval_guidance } : {}),
    ...(step.kind === 'artifact' ? { artifact: step.artifact } : {}),
  })) as StructuredPlan['steps'];
  return {
    schema_version: 2,
    id: plan.id,
    qualified_id: plan.qualified_id,
    agent: plan.agent,
    purpose: plan.purpose,
    inputs: sortedMapping(plan.inputs, (entry) => ({
      description: entry.description,
      required: entry.required,
      ...(entry.shape === undefined ? {} : { shape: entry.shape }),
    })),
    brain_selectors: sortedMapping(plan.brain_selectors, (entry) => ({
      description: entry.description,
      required: entry.required,
    })),
    guidelines: [...plan.guidelines],
    tool_uses: [...plan.tool_uses],
    artifacts: sortedMapping(plan.artifacts, (entry) => ({
      description: entry.description,
      ...(entry.shape === undefined ? {} : { shape: entry.shape }),
    })),
    caps: sortedMapping(plan.caps, (entry) => ({
      maximum: entry.maximum,
      guidance: entry.guidance,
    })),
    steps,
    completion: {
      artifacts: [...plan.completion.artifacts],
      output_guidance: plan.completion.output_guidance,
      criteria: [...plan.completion.criteria],
    },
  };
}

function projectFunction(definition: FunctionDefinition): JsonValue {
  return {
    schema_version: 2,
    id: definition.id,
    purpose: definition.purpose,
    agents: [...definition.agents],
    guidelines: [...definition.guidelines],
    tool_uses: [...definition.tool_uses],
  };
}

function projectAgent(definition: AgentDefinition): JsonValue {
  return {
    schema_version: 2,
    id: definition.id,
    function: definition.function,
    purpose: definition.purpose,
    plans: [...definition.plans],
    subagents: [...definition.subagents],
    guidelines: [...definition.guidelines],
    default_guidelines: [...definition.default_guidelines],
    tool_uses: [...definition.tool_uses],
    lessons: [...definition.lessons],
  };
}

function projectMarkdown(definition: MarkdownDefinition): ContextMarkdownContent {
  return {
    id: definition.id,
    kind: definition.kind,
    purpose: definition.purpose,
    scope: {
      ...(definition.scope.function === undefined ? {} : { function: definition.scope.function }),
      ...(definition.scope.agent === undefined ? {} : { agent: definition.scope.agent }),
      ...(definition.scope.plan === undefined ? {} : { plan: definition.scope.plan }),
    },
    body: definition.body,
  };
}

function contextScope(
  workspace: string,
  scope: WorkspaceScope = {},
): ContextScope {
  return {
    workspace,
    function: scope.function ?? null,
    agent: scope.agent ?? null,
    plan: scope.plan ?? null,
  };
}

function makeFragment<TContent>(options: {
  fragmentId: string;
  kind: ContextFragmentKind;
  workspaceId: string;
  scope?: WorkspaceScope;
  sourceContentHash: string | null;
  trust: ContextTrustClass;
  inclusionReason: ContextInclusionReason;
  required: boolean;
  content: TContent;
}): ContextFragment<TContent> {
  const serialized = canonicalJson(options.content);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  return {
    fragment_id: options.fragmentId,
    kind: options.kind,
    scope: contextScope(options.workspaceId, options.scope),
    source_content_hash: options.sourceContentHash,
    fragment_hash: sha256(serialized),
    trust: options.trust,
    inclusion_reason: options.inclusionReason,
    required: options.required,
    content_bytes: bytes,
    content_tokens: estimatedTokens(bytes),
    content: options.content,
  };
}

const EXPLANATIONS: Readonly<Record<ContextInclusionReason, string>> = {
  'target-function': 'Selected function policy is mandatory for the exact target.',
  'target-agent': 'Selected agent policy is mandatory for the exact target.',
  'selected-plan-root': 'The host explicitly selected this complete root plan.',
  'nested-plan-closure': 'A selected plan statically references this nested plan.',
  'agent-default-guideline': 'The selected agent declares this default guideline.',
  'plan-referenced-guideline': 'A plan in the selected closure references this guideline.',
  'applicable-lesson': 'This approved lesson applies to the selected agent and plan closure.',
  'plan-tool-step': 'A tool step in the selected closure names this effective tool guidance.',
  'tool-skill-ref': 'Selected tool guidance names this canonical vendor skill reference.',
  'selector-match': 'This cited evidence matches an authored context selector.',
  'required-selector-match': 'This cited evidence matches a required-intent authored selector.',
  'host-query': 'The host supplied this bounded task query.',
  'host-step-hint': 'The host supplied this optional relevance hint.',
};

function provenanceForFragment(
  fragment: ContextFragment<unknown>,
  sourceId: string,
  explain: boolean,
): ContextProvenance {
  return {
    fragment_id: fragment.fragment_id,
    source_id: sourceId,
    trust: fragment.trust,
    inclusion_reason: fragment.inclusion_reason,
    required: fragment.required,
    source_content_hash: fragment.source_content_hash,
    fragment_hash: fragment.fragment_hash,
    ...(explain ? { explanation: EXPLANATIONS[fragment.inclusion_reason] } : {}),
  };
}

function requestProvenance(
  field: 'query' | 'step_hint',
  value: string,
  explain: boolean,
): ContextProvenance {
  const reason = field === 'query' ? 'host-query' : 'host-step-hint';
  return {
    fragment_id: `request:${field}`,
    source_id: `request.${field}`,
    trust: 'host-asserted',
    inclusion_reason: reason,
    required: field === 'query',
    source_content_hash: null,
    fragment_hash: sha256(canonicalJson(value)),
    ...(explain ? { explanation: EXPLANATIONS[reason] } : {}),
  };
}

type MandatoryContext = {
  workspace: WorkspaceContext['workspace'];
  target: WorkspaceContext['target'];
  request: WorkspaceContext['request'];
  agent: WorkspaceContext['agent'];
  plan: WorkspaceContext['plan'];
  guidelines: ContextFragment<ContextMarkdownContent>[];
  tool_uses: ContextFragment<ContextToolUseContent>[];
  skill_refs: ContextFragment<ContextSkillRefContent>[];
  provenance: ContextProvenance[];
  contributorSizes: Array<{ fragment_id: string; bytes: number; tokens: number }>;
};

function validateVendorProjection(
  local: ResolvedLocalContext,
  projection: ContextVendorSkillProjection | undefined,
): ContextVendorSkillProjection {
  if (local.selection.skillRefs.length === 0) {
    if (projection === undefined) {
      return { generator_version: 'unselected', map_hash: null, skills: [] };
    }
    if (projection.skills.length !== 0 || projection.map_hash !== null) {
      throw workspaceFailure(
        'SKILL_REF_DRIFTED',
        'Vendor-skill projection contains unselected entries.',
        'Pass the exact empty projection for a context with no selected tool steps.',
        { reason: 'unexpected-vendor-projection' },
      );
    }
    return projection;
  }
  if (projection === undefined || projection.map_hash === null) {
    throw workspaceFailure(
      'SKILL_REF_UNMAPPED',
      'Selected tool guidance has no attested vendor-skill projection.',
      'Resolve selected canonical skill refs through the registry capability.',
      { reason: 'selected-projection-missing' },
    );
  }
  const expected = local.selection.skillRefs;
  const actual = projection.skills.map((entry) => entry.skill_ref);
  const actualRefs = new Set(actual);
  if (expected.length !== actual.length
    || expected.some((skillRef) => !actualRefs.has(skillRef))) {
    throw workspaceFailure(
      'SKILL_REF_DRIFTED',
      'Vendor-skill projection does not match selected tool guidance.',
      'Regenerate and reselect the exact canonical vendor-skill map entries.',
      { reason: 'selected-ref-set' },
    );
  }
  for (const entry of projection.skills) {
    const expectedPaths = local.selection.skillRefPaths.get(entry.skill_ref) ?? [];
    const actualPaths = new Set(entry.authored_paths);
    if (entry.authored_paths.length !== expectedPaths.length
      || expectedPaths.some((path) => !actualPaths.has(path))) {
      throw workspaceFailure(
        'SKILL_REF_DRIFTED',
        'Vendor-skill projection provenance does not match selected contributors.',
        'Regenerate the vendor-skill map after repairing authored tool guidance.',
        { reason: 'selected-authored-paths' },
      );
    }
  }
  return projection;
}

function projectVendorSkillLocator(locator: VendorSkillLocator): VendorSkillLocator {
  if (locator.kind === 'host-native') {
    return {
      kind: locator.kind,
      identity: locator.identity,
      assurance: locator.assurance,
    };
  }
  return {
    kind: locator.kind,
    path: locator.path,
    content_hash: locator.content_hash,
    source: locator.source,
    revision: locator.revision,
    revision_immutable: locator.revision_immutable,
    assurance: locator.assurance,
  };
}

function projectVendorSkillHosts(
  hosts: Partial<Record<VendorSkillHost, VendorSkillLocator>>,
): Partial<Record<VendorSkillHost, VendorSkillLocator>> {
  return Object.fromEntries((Object.entries(hosts) as Array<[VendorSkillHost, VendorSkillLocator]>)
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([host, locator]) => [host, projectVendorSkillLocator(locator)]));
}

function buildMandatoryContext(
  source: PreparedContextSource,
  request: ContextRequest,
  local: ResolvedLocalContext,
  vendorProjection: ContextVendorSkillProjection | undefined,
): MandatoryContext {
  const workspaceId = source.registry_metadata.workspace_id;
  const functionFragment = makeFragment({
    fragmentId: `function:${local.functionId}`,
    kind: 'function',
    workspaceId,
    scope: { function: local.functionId },
    sourceContentHash: local.functionRecord.content_hash,
    trust: 'authored-policy',
    inclusionReason: 'target-function',
    required: true,
    content: projectFunction(local.functionDefinition),
  });
  const agentFragment = makeFragment({
    fragmentId: `agent:${local.functionId}/${local.agentId}`,
    kind: 'agent',
    workspaceId,
    scope: { function: local.functionId, agent: local.agentId },
    sourceContentHash: local.agentRecord.content_hash,
    trust: 'authored-policy',
    inclusionReason: 'target-agent',
    required: true,
    content: projectAgent(local.agentDefinition),
  });
  const planFragments = local.plans.map((plan, index) => makeFragment({
    fragmentId: `plan:${plan.qualified_id}`,
    kind: 'plan',
    workspaceId,
    scope: {
      function: plan.agent.split('/')[0]!,
      agent: plan.agent.split('/')[1]!,
      plan: plan.id,
    },
    sourceContentHash: exactRecord(source, 'plan', plan.qualified_id).content_hash,
    trust: 'authored-policy',
    inclusionReason: index === 0 ? 'selected-plan-root' : 'nested-plan-closure',
    required: true,
    content: projectPlan(plan),
  }));
  const guidelineFragments = local.guidelineRecords.map(({ record, definition, reason }) => makeFragment({
    fragmentId: `guideline:${record.qualified_id}`,
    kind: 'guideline',
    workspaceId,
    scope: definition.scope,
    sourceContentHash: record.content_hash,
    trust: 'authored-policy',
    inclusionReason: reason,
    required: true,
    content: projectMarkdown(definition),
  }));
  const toolFragments = local.tools.map((tool) => makeFragment({
    fragmentId: `tool-use:${tool.content.effective.id}:${tool.content.semantic_hash}`,
    kind: 'tool-use',
    workspaceId,
    scope: tool.content.effective.scope,
    sourceContentHash: null,
    trust: 'authored-policy',
    inclusionReason: 'plan-tool-step',
    required: true,
    content: tool.content,
  }));
  const projection = validateVendorProjection(local, vendorProjection);
  const skillFragments = [...projection.skills]
    .sort((left, right) => compareUnicodeCodePoints(left.skill_ref, right.skill_ref))
    .map((entry) => makeFragment({
      fragmentId: `skill-ref:${entry.skill_ref}`,
      kind: 'skill-ref',
      workspaceId,
      sourceContentHash: null,
      trust: 'vendor-instruction',
      inclusionReason: 'tool-skill-ref',
      required: true,
      content: {
        skill_ref: entry.skill_ref,
        generator_version: projection.generator_version,
        map_hash: projection.map_hash!,
        authored_paths: [...entry.authored_paths].sort(compareUnicodeCodePoints),
        hosts: projectVendorSkillHosts(entry.hosts),
      },
    }));
  const mandatoryFragments: Array<ContextFragment<unknown>> = [
    functionFragment,
    agentFragment,
    ...planFragments,
    ...guidelineFragments,
    ...toolFragments,
    ...skillFragments,
  ];
  const provenance = [
    requestProvenance('query', request.query, request.explain),
    ...(request.stepHint === null ? [] : [requestProvenance('step_hint', request.stepHint, request.explain)]),
    ...mandatoryFragments.map((fragment) => provenanceForFragment(
      fragment,
      fragment.fragment_id.replace(/^[^:]+:/, ''),
      request.explain,
    )),
  ];
  return {
    workspace: {
      schema_version: source.registry_metadata.schema_version,
      workspace_id: workspaceId,
      source_hash: source.registry_source_hash,
      brain_configured: source.registry_metadata.brain_configured,
    },
    target: {
      function_id: local.functionId,
      agent_id: local.agentId,
      plan_id: local.planId,
    },
    request: {
      query: request.query,
      step_hint: request.stepHint,
      budget_tokens: request.budgetTokens,
      explain: request.explain,
    },
    agent: { function: functionFragment, agent: agentFragment },
    plan: {
      root_id: local.planId === null ? null : `${local.functionId}/${local.agentId}#${local.planId}`,
      definitions: planFragments,
    },
    guidelines: guidelineFragments,
    tool_uses: toolFragments,
    skill_refs: skillFragments,
    provenance,
    contributorSizes: mandatoryFragments.map((fragment) => ({
      fragment_id: fragment.fragment_id,
      bytes: fragment.content_bytes,
      tokens: fragment.content_tokens,
    })),
  };
}

const SAFE_SEED_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_SEED_ID_BYTES = 256;
const MAX_SELECTOR_OR_LOCATOR_BYTES = 4_096;

function evidenceFailure(details: Record<string, JsonValue> = {}): never {
  throw workspaceFailure(
    'CONTEXT_EVIDENCE_INVALID',
    'Context evidence input is invalid.',
    'Materialize a bounded, recursively frozen, closed evidence candidate set.',
    details,
  );
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) return value.every((entry) => isDeepFrozen(entry, seen));
  return Object.values(value as Record<string, unknown>).every((entry) => isDeepFrozen(entry, seen));
}

export function freezeContextEvidenceInput(input: ContextEvidenceInput): ContextEvidenceInput {
  return cloneAndFreeze(input);
}

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${stableCanonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function boundedSeedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= maximum
    && controlByteOffset(value) === null;
}

function boundedNonemptySeedString(value: unknown, maximum: number): value is string {
  return boundedSeedString(value, maximum) && value.length > 0;
}

function boundedEvidenceContent(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_CONTEXT_EVIDENCE_CONTENT_BYTES) return false;
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const prohibited = ((point >= 0 && point <= 0x1f)
        && point !== 0x09
        && point !== 0x0a
        && point !== 0x0d)
      || (point >= 0x7f && point <= 0x9f);
    if (prohibited) return false;
    index += point > 0xffff ? 2 : 1;
  }
  return true;
}

function safeCitationLocator(value: unknown): value is string {
  return boundedNonemptySeedString(value, MAX_SELECTOR_OR_LOCATOR_BYTES)
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/\s/u.test(value)
    && !/^file:\/\//i.test(value)
    && !/^[A-Za-z]:[\\/]/.test(value);
}

function safeSeedId(value: unknown): value is string {
  return boundedSeedString(value, MAX_SEED_ID_BYTES) && SAFE_SEED_ID.test(value);
}

function candidateStrings(value: unknown): Array<{ field: string; value: string }> {
  const strings: Array<{ field: string; value: string }> = [];
  const visit = (entry: unknown, field: string): void => {
    if (typeof entry === 'string') {
      strings.push({ field, value: entry });
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${field}[${index}]`));
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      for (const key of Object.keys(entry as Record<string, unknown>).sort(compareUnicodeCodePoints)) {
        strings.push({ field: 'candidate.field-name', value: key });
        const logicalKey = /^[a-z][a-z0-9_]*$/.test(key) ? key : 'unknown-field';
        visit((entry as Record<string, unknown>)[key], `${field}.${logicalKey}`);
      }
    }
  };
  visit(value, 'candidate');
  return strings;
}

const HIGH_CONFIDENCE_INSTRUCTION_OVERRIDE =
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|everything)\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier)\s+(?:instructions?|directions?|prompts?|messages?)\b/iu;
const HIGH_CONFIDENCE_PRIVILEGED_ROLE_OVERRIDE =
  /\byou\s+are\s+now\s+(?:a|an|the)\s+(?:system|developer|root|administrator)\b/iu;
const EMOJI_SEQUENCE_LEFT = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?$/u;
const EMOJI_SEQUENCE_RIGHT = /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?/u;
const WORD_EDGE_LEFT = /[\p{L}\p{N}\p{M}]$/u;
const WORD_EDGE_RIGHT = /^[\p{L}\p{N}\p{M}]/u;

function isEmojiSequenceJoiner(
  content: string,
  span: { readonly start: number; readonly end: number },
): boolean {
  if (span.end !== span.start + 1 || content[span.start] !== '\u200d') return false;
  const left = content.slice(0, span.start);
  const right = content.slice(span.end);
  const leftEmoji = left.match(EMOJI_SEQUENCE_LEFT)?.[0];
  const rightEmoji = right.match(EMOJI_SEQUENCE_RIGHT)?.[0];
  if (leftEmoji === undefined || rightEmoji === undefined) return false;
  return !WORD_EDGE_LEFT.test(left.slice(0, -leftEmoji.length))
    && !WORD_EDGE_RIGHT.test(right.slice(rightEmoji.length));
}

function hasHostileBrainInstruction(content: string): boolean {
  const instructionView = content.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ');
  if (HIGH_CONFIDENCE_INSTRUCTION_OVERRIDE.test(instructionView)
    || HIGH_CONFIDENCE_PRIVILEGED_ROLE_OVERRIDE.test(instructionView)) return true;
  return scanText(content, 'brain_evidence').findings.some((finding) => (
    finding.severity === 'hostile'
      && ['secret_egress', 'encoded_payload', 'role_confusion'].includes(finding.rule)
      && !isEmojiSequenceJoiner(content, finding.span)
  ));
}

function validateEvidenceEnvelope(input: ContextEvidenceInput): void {
  if (input === null || typeof input !== 'object' || !isDeepFrozen(input)) {
    evidenceFailure({ reason: 'not-recursively-frozen' });
  }
  if ((input.status !== 'seeded' && input.status !== 'unavailable')
    || !Array.isArray(input.candidates)) {
    evidenceFailure({ reason: 'envelope-shape' });
  }
  if (input.candidates.length > MAX_CONTEXT_EVIDENCE_CANDIDATES) {
    evidenceFailure({
      reason: 'candidate-count',
      limit: MAX_CONTEXT_EVIDENCE_CANDIDATES,
      entries: input.candidates.length,
    });
  }
  if (input.status === 'unavailable' && input.candidates.length !== 0) {
    evidenceFailure({ reason: 'unavailable-with-candidates' });
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    evidenceFailure({ reason: 'not-json-safe' });
  }
  const encodedBytes = Buffer.byteLength(encoded!, 'utf8');
  if (encodedBytes > MAX_CONTEXT_EVIDENCE_BYTES) {
    evidenceFailure({ reason: 'encoded-bytes', limit_bytes: MAX_CONTEXT_EVIDENCE_BYTES, observed_bytes: encodedBytes });
  }
  for (const candidate of input.candidates as readonly unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const seedIds: Array<readonly [string, unknown]> = [
      ['candidate_id', record['candidate_id']],
    ];
    const scope = record['scope'];
    if (scope !== null && typeof scope === 'object' && !Array.isArray(scope)) {
      for (const field of ['workspace', 'function', 'agent', 'plan'] as const) {
        seedIds.push([`scope.${field}`, (scope as Record<string, unknown>)[field]]);
      }
    }
    const citation = record['citation'];
    if (citation !== null && typeof citation === 'object' && !Array.isArray(citation)) {
      for (const field of [
        'logical_source_id',
        'source_version_id',
        'object_id',
        'extractor_id',
        'extractor_version',
        'content_hash',
      ] as const) {
        seedIds.push([`citation.${field}`, (citation as Record<string, unknown>)[field]]);
      }
    }
    for (const [field, value] of seedIds) {
      if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_SEED_ID_BYTES) {
        evidenceFailure({ reason: 'seed-id-bytes', field, limit_bytes: MAX_SEED_ID_BYTES });
      }
    }
    if (typeof record['selector'] === 'string'
      && Buffer.byteLength(record['selector'], 'utf8') > MAX_SELECTOR_OR_LOCATOR_BYTES) {
      evidenceFailure({ reason: 'selector-bytes', limit_bytes: MAX_SELECTOR_OR_LOCATOR_BYTES });
    }
    if (typeof record['content'] === 'string'
      && Buffer.byteLength(record['content'], 'utf8') > MAX_CONTEXT_EVIDENCE_CONTENT_BYTES) {
      evidenceFailure({ reason: 'content-bytes', limit_bytes: MAX_CONTEXT_EVIDENCE_CONTENT_BYTES });
    }
    if (citation !== null && typeof citation === 'object' && !Array.isArray(citation)) {
      const locator = (citation as Record<string, unknown>)['locator'];
      if (typeof locator === 'string'
        && Buffer.byteLength(locator, 'utf8') > MAX_SELECTOR_OR_LOCATOR_BYTES) {
        evidenceFailure({ reason: 'locator-bytes', limit_bytes: MAX_SELECTOR_OR_LOCATOR_BYTES });
      }
    }
  }
}

function validCitation(value: unknown): value is ContextBrainCitation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const citation = value as Record<string, unknown>;
  if (!Object.keys(citation).every((field) => [
    'logical_source_id',
    'source_version_id',
    'object_id',
    'extractor_id',
    'extractor_version',
    'locator',
    'content_hash',
  ].includes(field))
    || !safeSeedId(citation['logical_source_id'])
    || !safeSeedId(citation['source_version_id'])
    || !(citation['object_id'] === null || safeSeedId(citation['object_id']))
    || !(citation['extractor_id'] === null || safeSeedId(citation['extractor_id']))
    || !(citation['extractor_version'] === null || safeSeedId(citation['extractor_version']))
    || !safeCitationLocator(citation['locator'])
    || typeof citation['content_hash'] !== 'string'
    || !SHA256.test(citation['content_hash'])) return false;
  return true;
}

function validScope(value: unknown): value is SeedBrainCandidate['scope'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (!safeSeedId(scope['workspace'])) return false;
  for (const field of ['function', 'agent', 'plan'] as const) {
    if (scope[field] !== undefined && (!safeSeedId(scope[field]) || !isRecordId(scope[field]))) return false;
  }
  if (scope['agent'] !== undefined && scope['function'] === undefined) return false;
  if (scope['plan'] !== undefined
    && (scope['function'] === undefined || scope['agent'] === undefined)) return false;
  return Object.keys(scope).every((field) => ['workspace', 'function', 'agent', 'plan'].includes(field));
}

type CandidateEvaluation = {
  candidate: SeedBrainCandidate | null;
  candidateKey: string;
  candidateId: string | null;
  reason: Exclude<ContextExclusionReason, 'budget-exhausted'> | null;
  finding: ContextSecretFinding | null;
  required: boolean;
  exact: number;
  overlap: number;
  scope: number;
};

function terms(value: string, maximum: number): readonly string[] {
  return [...new Set(value.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))]
    .sort(compareUnicodeCodePoints)
    .slice(0, maximum);
}

function termOverlap(requestTerms: ReadonlySet<string>, content: string): number {
  let overlap = 0;
  for (const term of terms(content, 512)) if (requestTerms.has(term)) overlap += 1;
  return overlap;
}

function candidateScopeScore(scope: SeedBrainCandidate['scope']): number {
  if (scope.plan !== undefined) return 3;
  if (scope.agent !== undefined) return 2;
  if (scope.function !== undefined) return 1;
  return 0;
}

function candidateMalformed(value: unknown): value is SeedBrainCandidate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  const candidate = value as Record<string, unknown>;
  const citation = candidate['citation'];
  const citationKeysValid = citation !== null
    && typeof citation === 'object'
    && !Array.isArray(citation)
    && Object.keys(citation as Record<string, unknown>).every((field) => [
      'logical_source_id',
      'source_version_id',
      'object_id',
      'extractor_id',
      'extractor_version',
      'locator',
      'content_hash',
    ].includes(field));
  return !Object.keys(candidate).every((field) => [
    'candidate_id',
    'selector',
    'scope',
    'content',
    'current',
    'tombstoned',
    'privacy',
    'retrieval_rank',
    'citation',
  ].includes(field))
    || !citationKeysValid
    || !safeSeedId(candidate['candidate_id'])
    || !boundedNonemptySeedString(candidate['selector'], MAX_SELECTOR_OR_LOCATOR_BYTES)
    || !validScope(candidate['scope'])
    || !boundedEvidenceContent(candidate['content'])
    || typeof candidate['current'] !== 'boolean'
    || typeof candidate['tombstoned'] !== 'boolean'
    || !['public', 'internal', 'secret'].includes(String(candidate['privacy']))
    || typeof candidate['retrieval_rank'] !== 'number';
}

function evaluateCandidates(
  input: ContextEvidenceInput,
  local: ResolvedLocalContext,
  workspaceId: string,
  request: ContextRequest,
): CandidateEvaluation[] {
  const candidateIds = new Map<string, number>();
  for (const raw of input.candidates as readonly unknown[]) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const id = (raw as Record<string, unknown>)['candidate_id'];
      if (safeSeedId(id)) candidateIds.set(id, (candidateIds.get(id) ?? 0) + 1);
    }
  }
  const selectorById = new Map(local.selectors.map((entry) => [entry.selector, entry]));
  const closureQualifiedPlans = new Set(local.plans.map((plan) => plan.qualified_id));
  const requestTermSet = new Set(terms(`${request.query} ${request.stepHint ?? ''}`, 64));
  const normalizedRequests = [request.query, request.stepHint ?? '']
    .map((value) => value.normalize('NFC').toLowerCase());
  const evaluated = (input.candidates as readonly unknown[]).map((raw): CandidateEvaluation => {
    let stable: string;
    try {
      stable = sha256(stableCanonicalJson(raw));
    } catch {
      stable = 'sha256:invalid';
    }
    const malformed = candidateMalformed(raw);
    const candidate = malformed ? null : raw as SeedBrainCandidate;
    const candidateId = candidate === null
      ? (raw !== null && typeof raw === 'object' && safeSeedId((raw as Record<string, unknown>)['candidate_id'])
          ? (raw as Record<string, unknown>)['candidate_id'] as string
          : null)
      : candidate.candidate_id;
    const findings = candidateStrings(raw).flatMap((entry) => secretFindings(entry.value, entry.field));
    findings.sort((left, right) => compareUnicodeCodePoints(left.field, right.field)
      || left.byte_offset - right.byte_offset
      || compareUnicodeCodePoints(left.detector_id, right.detector_id)
      || left.match_length - right.match_length);
    const selector = candidate === null ? undefined : selectorById.get(candidate.selector);
    const workspaceMismatch = candidate !== null && candidate.scope.workspace !== workspaceId;
    const scopeIneligible = candidate !== null && !workspaceMismatch && (
      candidate.scope.plan !== undefined
        ? !closureQualifiedPlans.has(
          `${candidate.scope.function}/${candidate.scope.agent}#${candidate.scope.plan}`,
        )
        : (candidate.scope.function !== undefined && candidate.scope.function !== local.functionId)
          || (candidate.scope.agent !== undefined && candidate.scope.agent !== local.agentId)
    );
    const invalidRank = candidate !== null && (!Number.isSafeInteger(candidate.retrieval_rank)
      || candidate.retrieval_rank < 0
      || candidate.retrieval_rank > 1_000_000);
    const uncited = candidate !== null && !validCitation(candidate.citation);
    const lowTrust = candidate !== null && (
      hasHostileBrainInstruction(candidate.content)
      || (typeof candidate.citation.locator === 'string'
        && hasHostileBrainInstruction(candidate.citation.locator))
    );
    const reason: CandidateEvaluation['reason'] = malformed
      ? 'malformed'
      : candidateIds.get(candidate!.candidate_id)! > 1
        ? 'duplicate'
        : findings.length > 0
          ? 'secret-material'
          : candidate!.privacy === 'secret'
            ? 'privacy-incompatible'
            : workspaceMismatch
              ? 'workspace-mismatch'
              : scopeIneligible
                ? 'scope-ineligible'
                : candidate!.tombstoned
                  ? 'tombstoned'
                  : !candidate!.current
                    ? 'stale'
                    : uncited
                      ? 'uncited'
                      : selector === undefined
                        ? 'unrequested-selector'
                        : invalidRank
                          ? 'invalid-rank'
                          : lowTrust
                            ? 'low-trust'
                            : null;
    return {
      candidate,
      candidateKey: candidateId ?? stable,
      candidateId,
      reason,
      finding: findings[0] ?? null,
      required: selector?.required ?? false,
      exact: candidate === null ? 0 : Number(normalizedRequests.includes(candidate.selector.normalize('NFC').toLowerCase())),
      overlap: candidate === null ? 0 : termOverlap(requestTermSet, candidate.content),
      scope: candidate === null ? 0 : candidateScopeScore(candidate.scope),
    };
  });
  evaluated.sort((left, right) => compareUnicodeCodePoints(left.candidateKey, right.candidateKey));
  return evaluated;
}

function emptyExclusions(): ContextBudgetExclusions {
  return Object.fromEntries(CONTEXT_EXCLUSION_REASONS.map((reason) => [reason, 0])) as ContextBudgetExclusions;
}

function candidateDiagnostic(evaluation: CandidateEvaluation, reason: ContextExclusionReason): WorkspaceDiagnostic {
  const finding = reason === 'secret-material' ? evaluation.finding : null;
  const diagnosticId = evaluation.candidateId !== null
    && secretFindings(evaluation.candidateId, 'candidate_id').length === 0
    ? evaluation.candidateId
    : 'invalid-candidate';
  return workspaceDiagnostic(
    'CONTEXT_EVIDENCE_EXCLUDED',
    'An optional Brain evidence candidate was excluded.',
    {
      severity: 'info',
      remedy: 'Inspect the closed exclusion reason and repair the candidate source if needed.',
      details: {
        candidate_id: diagnosticId,
        reason,
        ...(finding === null ? {} : {
          detector_id: finding.detector_id,
          field: finding.field,
          byte_offset: finding.byte_offset,
          match_length: finding.match_length,
        }),
      },
    },
  );
}

function compareEligibleCandidates(left: CandidateEvaluation, right: CandidateEvaluation): number {
  return Number(right.required) - Number(left.required)
    || right.exact - left.exact
    || right.overlap - left.overlap
    || left.candidate!.retrieval_rank - right.candidate!.retrieval_rank
    || right.scope - left.scope
    || compareUnicodeCodePoints(left.candidate!.candidate_id, right.candidate!.candidate_id);
}

type AccountedDomain = Omit<WorkspaceContext, 'budget'>;

function accountedDomain(options: {
  mandatory: MandatoryContext;
  requestBudget?: number;
  lessons: readonly ContextFragment<ContextMarkdownContent>[];
  brainEvidence: readonly ContextBrainEvidence[];
  provenance: readonly ContextProvenance[];
  diagnostics: readonly WorkspaceDiagnostic[];
}): AccountedDomain {
  return {
    schema_version: CONTEXT_SCHEMA_VERSION,
    workspace: options.mandatory.workspace,
    target: options.mandatory.target,
    request: {
      ...options.mandatory.request,
      budget_tokens: options.requestBudget ?? options.mandatory.request.budget_tokens,
    },
    agent: options.mandatory.agent,
    plan: options.mandatory.plan,
    guidelines: options.mandatory.guidelines,
    lessons: options.lessons,
    brain_evidence: options.brainEvidence,
    tool_uses: options.mandatory.tool_uses,
    skill_refs: options.mandatory.skill_refs,
    provenance: options.provenance,
    diagnostics: options.diagnostics,
  };
}

function mandatoryDiagnostics(
  brainConfigured: boolean,
  evidenceStatus: ContextEvidenceInput['status'] | null,
  requiredSelectorsUnmatched: number,
): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  if (!brainConfigured) {
    diagnostics.push(workspaceDiagnostic(
      'BRAIN_NOT_CONFIGURED',
      'The workspace has no Brain configuration; optional evidence was omitted.',
      {
        severity: 'warning',
        remedy: 'Configure a Brain only when company evidence is needed for this workspace.',
        details: {},
      },
    ));
  } else if (evidenceStatus === 'unavailable') {
    diagnostics.push(workspaceDiagnostic(
      'CONTEXT_EVIDENCE_UNAVAILABLE',
      'Optional Brain evidence is unavailable.',
      {
        severity: 'warning',
        remedy: 'Continue with local policy or retry evidence retrieval later.',
        details: {},
      },
    ));
  } else if (requiredSelectorsUnmatched > 0) {
    diagnostics.push(workspaceDiagnostic(
      'CONTEXT_REQUIRED_EVIDENCE_MISSING',
      'Required-intent Brain selectors have no eligible evidence.',
      {
        severity: 'warning',
        remedy: 'Continue with local policy or ingest current cited evidence for the authored selectors.',
        details: { unmatched_selectors: requiredSelectorsUnmatched },
      },
    ));
  }
  diagnostics.sort((left, right) => compareUnicodeCodePoints(left.code, right.code));
  if (diagnostics.length > MAX_CONTEXT_MANDATORY_DIAGNOSTICS) {
    throw workspaceFailure(
      'CONTEXT_RESOLUTION_FAILED',
      'Context resolution produced too many mandatory diagnostics.',
      'Retry after validating the workspace and evidence source.',
    );
  }
  return diagnostics;
}

function overflowDetails(
  mandatory: MandatoryContext,
  bytes: number,
  tokens: number,
): Record<string, JsonValue> {
  return {
    required_bytes: bytes + BUDGET_BLOCK_RESERVE_BYTES,
    required_tokens: tokens + BUDGET_BLOCK_RESERVE_TOKENS,
    mandatory_bytes: bytes,
    mandatory_tokens: tokens,
    reserve_bytes: BUDGET_BLOCK_RESERVE_BYTES,
    reserve_tokens: BUDGET_BLOCK_RESERVE_TOKENS,
    required_counts: {
      plans: mandatory.plan.definitions.length,
      guidelines: mandatory.guidelines.length,
      tool_uses: mandatory.tool_uses.length,
      skill_refs: mandatory.skill_refs.length,
      provenance: mandatory.provenance.length,
    },
  };
}

function assertMandatoryBudget(
  mandatory: MandatoryContext,
  diagnostics: readonly WorkspaceDiagnostic[],
): { bytes: number; tokens: number } {
  const bytesAt = (budgetTokens: number): number => utf8Bytes(accountedDomain({
    mandatory,
    requestBudget: budgetTokens,
    lessons: [],
    brainEvidence: [],
    provenance: mandatory.provenance,
    diagnostics,
  }));
  const ceilingBytes = bytesAt(MAX_CONTEXT_BUDGET_TOKENS);
  const ceilingTokens = estimatedTokens(ceilingBytes);
  if (ceilingTokens + BUDGET_BLOCK_RESERVE_TOKENS > MAX_CONTEXT_BUDGET_TOKENS) {
    const contributors = [...mandatory.contributorSizes]
      .sort((left, right) => right.bytes - left.bytes
        || compareUnicodeCodePoints(left.fragment_id, right.fragment_id))
      .slice(0, 16)
      .map((entry) => ({
        fragment_id: entry.fragment_id,
        bytes: entry.bytes,
        tokens: entry.tokens,
      }));
    throw workspaceFailure(
      'CONTEXT_MANDATORY_UNSERVABLE',
      'Mandatory context exceeds the supported host ceiling.',
      'Split or reduce the largest authored definitions before retrying.',
      {
        maximum_tokens: MAX_CONTEXT_BUDGET_TOKENS,
        ...overflowDetails(mandatory, ceilingBytes, ceilingTokens),
        contributors,
      },
    );
  }
  const requestedBytes = bytesAt(mandatory.request.budget_tokens);
  const requestedTokens = estimatedTokens(requestedBytes);
  if (requestedTokens + BUDGET_BLOCK_RESERVE_TOKENS <= mandatory.request.budget_tokens) {
    return { bytes: requestedBytes, tokens: requestedTokens };
  }
  let requiredTokens = requestedTokens + BUDGET_BLOCK_RESERVE_TOKENS;
  let requiredBytes = requestedBytes;
  for (let iteration = 0; iteration < 16; iteration++) {
    requiredBytes = bytesAt(requiredTokens);
    const next = estimatedTokens(requiredBytes) + BUDGET_BLOCK_RESERVE_TOKENS;
    if (next === requiredTokens) break;
    requiredTokens = next;
  }
  const requiredDomainTokens = estimatedTokens(requiredBytes);
  throw workspaceFailure(
    'CONTEXT_BUDGET_REQUIRED_OVERFLOW',
    'Mandatory context exceeds the requested token budget.',
    'Retry with the exact required token budget reported in details.',
    {
      limit: mandatory.request.budget_tokens,
      ...overflowDetails(mandatory, requiredBytes, requiredDomainTokens),
    },
  );
}

type OptionalAdmission<T> = {
  fragment: T;
  provenance: ContextProvenance;
  fragmentBytes: number;
  provenanceBytes: number;
};

function optionalAdmission<T extends ContextFragment<unknown>>(
  fragment: T,
  sourceId: string,
  explain: boolean,
  instrumentation?: ContextAssemblyInstrumentation,
): OptionalAdmission<T> {
  const provenance = provenanceForFragment(fragment, sourceId, explain);
  instrumentation && (instrumentation.optional_content_serializations += 1);
  const fragmentBytes = utf8Bytes(fragment);
  instrumentation && (instrumentation.optional_provenance_serializations += 1);
  const provenanceBytes = utf8Bytes(provenance);
  return { fragment, provenance, fragmentBytes, provenanceBytes };
}

function brainEvidenceFragment(
  workspaceId: string,
  evaluation: CandidateEvaluation,
): ContextBrainEvidence {
  const candidate = evaluation.candidate!;
  const reason = evaluation.required ? 'required-selector-match' : 'selector-match';
  const fragment = makeFragment({
    fragmentId: `brain-evidence:${candidate.candidate_id}`,
    kind: 'brain-evidence',
    workspaceId,
    scope: {
      ...(candidate.scope.function === undefined ? {} : { function: candidate.scope.function }),
      ...(candidate.scope.agent === undefined ? {} : { agent: candidate.scope.agent }),
      ...(candidate.scope.plan === undefined ? {} : { plan: candidate.scope.plan }),
    },
    sourceContentHash: null,
    trust: 'brain-extract-untrusted',
    inclusionReason: reason,
    required: false,
    content: candidate.content,
  });
  return {
    ...fragment,
    kind: 'brain-evidence',
    privacy: candidate.privacy as 'public' | 'internal',
    candidate_scope: contextScope(workspaceId, candidate.scope),
    retrieval_reason: reason,
    citation: {
      logical_source_id: candidate.citation.logical_source_id,
      source_version_id: candidate.citation.source_version_id,
      object_id: candidate.citation.object_id,
      extractor_id: candidate.citation.extractor_id,
      extractor_version: candidate.citation.extractor_version,
      locator: candidate.citation.locator,
      content_hash: candidate.citation.content_hash,
    },
  };
}

function forbiddenRuntimeKeyGuard(domain: AccountedDomain): void {
  const forbidden = new Set([
    'current_step',
    'selected_step',
    'execution_state',
    'prior_output',
    'output_binding',
    'provider_route',
    'approval_receipt',
    'next_action',
    'next_actions',
    'transition',
  ]);
  const wrappers: unknown[] = [
    domain,
    domain.workspace,
    domain.target,
    domain.request,
    domain.agent,
    domain.agent.function,
    domain.agent.agent,
    domain.plan,
    ...domain.plan.definitions,
    ...domain.guidelines,
    ...domain.lessons,
    ...domain.brain_evidence,
    ...domain.tool_uses,
    ...domain.skill_refs,
    ...domain.provenance,
    ...domain.diagnostics,
  ];
  for (const wrapper of wrappers) {
    if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) continue;
    if (Object.keys(wrapper as Record<string, unknown>).some((key) => forbidden.has(key))) {
      throw workspaceFailure(
        'CONTEXT_RESOLUTION_FAILED',
        'Context response contains a forbidden runtime field.',
        'Remove Roster-owned execution state from the context envelope.',
      );
    }
  }
}

function buildBudget(options: {
  limit: number;
  mandatoryBytes: number;
  finalBytes: number;
  exclusions: ContextBudgetExclusions;
  lessonsBudgetExhausted: number;
  requiredSelectorsUnmatched: number;
  candidateDiagnosticsOmitted: number;
}): ContextBudget {
  const mandatoryTokens = estimatedTokens(options.mandatoryBytes);
  const finalTokens = estimatedTokens(options.finalBytes);
  const optionalBytes = options.finalBytes - options.mandatoryBytes;
  const optionalTokens = finalTokens - mandatoryTokens;
  const totalBytes = options.finalBytes + BUDGET_BLOCK_RESERVE_BYTES;
  const totalTokens = finalTokens + BUDGET_BLOCK_RESERVE_TOKENS;
  return {
    estimator: CONTEXT_ESTIMATOR,
    limit_tokens: options.limit,
    mandatory_bytes: options.mandatoryBytes,
    mandatory_tokens: mandatoryTokens,
    optional_bytes: optionalBytes,
    optional_tokens: optionalTokens,
    reserve_bytes: BUDGET_BLOCK_RESERVE_BYTES,
    reserve_tokens: BUDGET_BLOCK_RESERVE_TOKENS,
    total_bytes: totalBytes,
    total_tokens: totalTokens,
    remaining_tokens: options.limit - totalTokens,
    exclusions: options.exclusions,
    lessons_budget_exhausted: options.lessonsBudgetExhausted,
    required_selectors_unmatched: options.requiredSelectorsUnmatched,
    candidate_diagnostics_omitted: options.candidateDiagnosticsOmitted,
  };
}

function assembleResolvedContext(
  source: PreparedContextSource,
  request: ContextRequest,
  evidenceInput: ContextEvidenceInput,
  vendorProjection: ContextVendorSkillProjection | undefined,
  local: ResolvedLocalContext,
  instrumentation?: ContextAssemblyInstrumentation,
): WorkspaceContext {
  const brainConfigured = source.registry_metadata.brain_configured;
  let evaluations: CandidateEvaluation[] = [];
  let evidenceStatus: ContextEvidenceInput['status'] | null = null;
  if (brainConfigured) {
    validateEvidenceEnvelope(evidenceInput);
    evidenceStatus = evidenceInput.status;
    if (evidenceInput.status === 'seeded') {
      evaluations = evaluateCandidates(
        evidenceInput,
        local,
        source.registry_metadata.workspace_id,
        request,
      );
    }
  }
  const eligible = evaluations.filter((evaluation) => evaluation.reason === null)
    .sort(compareEligibleCandidates);
  const matchedSelectors = new Set(eligible.map((evaluation) => evaluation.candidate!.selector));
  const requiredSelectorsUnmatched = !brainConfigured || evidenceStatus !== 'seeded'
    ? 0
    : local.selectors.filter((selector) => selector.required && !matchedSelectors.has(selector.selector)).length;
  const diagnostics = mandatoryDiagnostics(brainConfigured, evidenceStatus, requiredSelectorsUnmatched);
  const mandatory = buildMandatoryContext(source, request, local, vendorProjection);
  const mandatoryMetrics = assertMandatoryBudget(mandatory, diagnostics);
  let domainBytes = mandatoryMetrics.bytes;
  const lessons: ContextFragment<ContextMarkdownContent>[] = [];
  const brainEvidence: ContextBrainEvidence[] = [];
  const provenance = [...mandatory.provenance];
  const exclusions = emptyExclusions();
  const rejected: Array<{ evaluation: CandidateEvaluation; reason: ContextExclusionReason }> = [];
  for (const evaluation of evaluations) {
    if (evaluation.reason !== null) {
      exclusions[evaluation.reason] += 1;
      rejected.push({ evaluation, reason: evaluation.reason });
    }
  }
  let lessonsBudgetExhausted = 0;
  const requestTerms = new Set(terms(`${request.query} ${request.stepHint ?? ''}`, 64));
  const rankedLessons = local.lessonRecords.map((lesson) => {
    instrumentation && (instrumentation.lesson_term_tokenizations += 1);
    return {
      lesson,
      overlap: termOverlap(requestTerms, `${lesson.definition.purpose} ${lesson.definition.body}`),
    };
  }).sort((left, right) => (
    right.lesson.scopeRank - left.lesson.scopeRank
    || right.overlap - left.overlap
    || compareUnicodeCodePoints(left.lesson.record.qualified_id, right.lesson.record.qualified_id)
  ));
  for (const { lesson } of rankedLessons) {
    const fragment = makeFragment({
      fragmentId: `lesson:${lesson.record.qualified_id}`,
      kind: 'lesson',
      workspaceId: source.registry_metadata.workspace_id,
      scope: lesson.definition.scope,
      sourceContentHash: lesson.record.content_hash,
      trust: 'approved-lesson',
      inclusionReason: 'applicable-lesson',
      required: false,
      content: projectMarkdown(lesson.definition),
    });
    const admission = optionalAdmission(fragment, lesson.record.qualified_id, request.explain, instrumentation);
    const marginal = admission.fragmentBytes
      + (lessons.length === 0 ? 0 : 1)
      + admission.provenanceBytes
      + (provenance.length === 0 ? 0 : 1);
    if (estimatedTokens(domainBytes + marginal) + BUDGET_BLOCK_RESERVE_TOKENS <= request.budgetTokens) {
      lessons.push(admission.fragment);
      provenance.push(admission.provenance);
      domainBytes += marginal;
    } else {
      lessonsBudgetExhausted += 1;
    }
  }
  for (const evaluation of eligible) {
    const fragment = brainEvidenceFragment(source.registry_metadata.workspace_id, evaluation);
    const admission = optionalAdmission(
      fragment,
      evaluation.candidate!.citation.source_version_id,
      request.explain,
      instrumentation,
    );
    const marginal = admission.fragmentBytes
      + (brainEvidence.length === 0 ? 0 : 1)
      + admission.provenanceBytes
      + (provenance.length === 0 ? 0 : 1);
    if (estimatedTokens(domainBytes + marginal) + BUDGET_BLOCK_RESERVE_TOKENS <= request.budgetTokens) {
      brainEvidence.push(admission.fragment);
      provenance.push(admission.provenance);
      domainBytes += marginal;
    } else {
      exclusions['budget-exhausted'] += 1;
      rejected.push({ evaluation, reason: 'budget-exhausted' });
    }
  }
  const candidateDiagnostics = rejected
    .sort((left, right) => compareUnicodeCodePoints(left.evaluation.candidateKey, right.evaluation.candidateKey)
      || compareUnicodeCodePoints(left.reason, right.reason))
    .map(({ evaluation, reason }) => candidateDiagnostic(evaluation, reason));
  let admittedCandidateDiagnostics = 0;
  for (const diagnostic of candidateDiagnostics) {
    if (admittedCandidateDiagnostics >= MAX_CONTEXT_OPTIONAL_DIAGNOSTICS) break;
    instrumentation && (instrumentation.optional_content_serializations += 1);
    const diagnosticBytes = utf8Bytes(diagnostic);
    const marginal = diagnosticBytes + (diagnostics.length === 0 ? 0 : 1);
    if (estimatedTokens(domainBytes + marginal) + BUDGET_BLOCK_RESERVE_TOKENS <= request.budgetTokens) {
      diagnostics.push(diagnostic);
      domainBytes += marginal;
      admittedCandidateDiagnostics += 1;
    }
  }
  const candidateDiagnosticsOmitted = candidateDiagnostics.length - admittedCandidateDiagnostics;
  const finalDomain = accountedDomain({
    mandatory,
    lessons,
    brainEvidence,
    provenance,
    diagnostics,
  });
  instrumentation && (instrumentation.complete_domain_serializations += 1);
  const verifiedDomainBytes = utf8Bytes(finalDomain);
  if (verifiedDomainBytes !== domainBytes) {
    throw workspaceFailure(
      'CONTEXT_RESOLUTION_FAILED',
      'Context budget accounting did not match canonical serialization.',
      'Retry after validating the deterministic context assembler.',
      { expected_bytes: domainBytes, actual_bytes: verifiedDomainBytes },
    );
  }
  forbiddenRuntimeKeyGuard(finalDomain);
  const budget = buildBudget({
    limit: request.budgetTokens,
    mandatoryBytes: mandatoryMetrics.bytes,
    finalBytes: verifiedDomainBytes,
    exclusions,
    lessonsBudgetExhausted,
    requiredSelectorsUnmatched,
    candidateDiagnosticsOmitted,
  });
  if (budget.total_tokens > request.budgetTokens) {
    throw workspaceFailure(
      'CONTEXT_RESOLUTION_FAILED',
      'Context budget accounting exceeded the accepted limit.',
      'Retry after validating the deterministic context assembler.',
    );
  }
  const response: WorkspaceContext = {
    schema_version: finalDomain.schema_version,
    workspace: finalDomain.workspace,
    target: finalDomain.target,
    request: finalDomain.request,
    agent: finalDomain.agent,
    plan: finalDomain.plan,
    guidelines: finalDomain.guidelines,
    lessons: finalDomain.lessons,
    brain_evidence: finalDomain.brain_evidence,
    tool_uses: finalDomain.tool_uses,
    skill_refs: finalDomain.skill_refs,
    provenance: finalDomain.provenance,
    budget,
    diagnostics: finalDomain.diagnostics,
  };
  const actualTokens = estimatedTokens(Buffer.byteLength(canonicalJson(response), 'utf8'));
  if (actualTokens > budget.total_tokens) {
    throw workspaceFailure(
      'CONTEXT_RESOLUTION_FAILED',
      'Reserved context budget bytes are insufficient.',
      'Increase the pinned budget block reserve before retrying.',
      { actual_tokens: actualTokens, reported_tokens: budget.total_tokens },
    );
  }
  return cloneAndFreeze(response);
}

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done === rightPoint.done) return 0;
      return leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

export function deriveContextVendorSkillSelection(
  source: PreparedContextSource,
  request: ContextRequest,
): ContextVendorSkillSelection {
  return resolveLocalContext(source, request).selection;
}

export function assembleWorkspaceContext(
  source: PreparedContextSource,
  request: ContextRequest,
  evidenceInput: ContextEvidenceInput,
  vendorProjection?: ContextVendorSkillProjection,
  instrumentation?: ContextAssemblyInstrumentation,
): WorkspaceContext {
  const local = resolveLocalContext(source, request);
  return assembleResolvedContext(
    source,
    request,
    evidenceInput,
    vendorProjection,
    local,
    instrumentation,
  );
}

export function resolveWorkspaceContext(options: ResolveWorkspaceContextOptions): WorkspaceContext {
  return withContextReadCapability(options.root, (capability) => {
    const request: ContextRequest = {
      target: options.target,
      query: options.query,
      stepHint: options.stepHint,
      budgetTokens: options.budgetTokens,
      explain: options.explain,
    };
    const local = resolveLocalContext(capability.source, request);
    const projection = capability.selectVendorSkillMap(local.selection);
    const evidenceInput = Object.freeze({
      status: 'seeded' as const,
      candidates: Object.freeze([]),
    });
    const result = assembleResolvedContext(
      capability.source,
      request,
      evidenceInput,
      projection,
      local,
    );
    capability.verify(local.localRecordPaths);
    return result;
  });
}

const SANITIZED_CONTEXT_FAILURES: Readonly<Record<string, { message: string; remedy: string }>> = {
  WORKSPACE_NOT_FOUND: {
    message: 'A version 2 Roster workspace was not found.',
    remedy: 'Run context from the intended version 2 workspace.',
  },
  LEGACY_WORKSPACE: {
    message: 'The workspace uses a legacy Roster layout.',
    remedy: 'Migrate the workspace before requesting version 2 context.',
  },
  MIXED_WORKSPACE: {
    message: 'The workspace mixes legacy and version 2 Roster layouts.',
    remedy: 'Complete the explicit migration before requesting context.',
  },
  UNSAFE_WORKSPACE_MARKER: {
    message: 'The workspace marker is unsafe.',
    remedy: 'Repair the workspace marker without following links.',
  },
  IDENTITY_INVALID: {
    message: 'A context identity is invalid.',
    remedy: 'Use exact lowercase qualified workspace identities.',
  },
  IDENTITY_AMBIGUOUS: {
    message: 'A context identity is ambiguous.',
    remedy: 'Keep one unambiguous registered owner for the identity.',
  },
  PARENT_NOT_FOUND: {
    message: 'A selected context target is not registered.',
    remedy: 'Register the exact parent and selected definition before retrying.',
  },
  DUPLICATE_IDENTITY: {
    message: 'A context identity is registered more than once.',
    remedy: 'Keep one canonical registered definition for each identity.',
  },
  PATH_ESCAPE: {
    message: 'A workspace path escapes the confined root.',
    remedy: 'Use only canonical workspace-relative managed paths.',
  },
  PATH_OVERLAP: {
    message: 'Workspace paths overlap unsafely.',
    remedy: 'Repair the registered workspace path ownership.',
  },
  RESERVED_PATH: {
    message: 'A workspace path is reserved.',
    remedy: 'Move the authored definition to its canonical managed path.',
  },
  SYMLINK_COMPONENT: {
    message: 'A managed workspace path contains a symbolic link.',
    remedy: 'Replace the link with a confined regular file or directory.',
  },
  NOT_REGULAR_FILE: {
    message: 'A managed workspace definition is not a regular file.',
    remedy: 'Replace it with a confined regular authored file.',
  },
  READ_LIMIT_EXCEEDED: {
    message: 'A bounded context read limit was exceeded.',
    remedy: 'Reduce the reported bounded collection before retrying.',
  },
  SCHEMA_VERSION_UNSUPPORTED: {
    message: 'An authored schema version is unsupported.',
    remedy: 'Migrate the authored definition to schema version 2.',
  },
  UNKNOWN_FIELD: {
    message: 'An authored definition contains an unknown field.',
    remedy: 'Remove unsupported fields or migrate the definition.',
  },
  IDENTITY_PATH_MISMATCH: {
    message: 'An authored identity does not match its registered path.',
    remedy: 'Make the authored identity and registered owner agree.',
  },
  WRITE_CONFLICT: {
    message: 'The workspace changed during context resolution.',
    remedy: 'Stop the concurrent workspace mutation and retry.',
  },
  PLAN_DRAFT_INCOMPLETE: {
    message: 'A selected structured plan is incomplete.',
    remedy: 'Complete every plan in the selected nested closure.',
  },
  PLAN_SCHEMA_INVALID: {
    message: 'A selected structured plan is invalid.',
    remedy: 'Fix the selected plan closure to match the version 2 schema.',
  },
  PLAN_FIELD_FORBIDDEN: {
    message: 'A selected plan contains forbidden runtime grammar.',
    remedy: 'Keep plans as inert host guidance without execution state.',
  },
  TOOL_USE_DRAFT_INCOMPLETE: {
    message: 'Selected tool guidance is incomplete.',
    remedy: 'Complete the tool-use definition before retrying context.',
  },
  TOOL_USE_SCHEMA_INVALID: {
    message: 'Selected tool guidance is invalid.',
    remedy: 'Fix the tool-use definition to match the version 2 schema.',
  },
  TOOL_USE_SNAPSHOT_INCOMPLETE: {
    message: 'The context workspace snapshot is incomplete.',
    remedy: 'Resolve context through the registry-owned complete snapshot capability.',
  },
  TOOL_USE_PRECEDENCE_AMBIGUOUS: {
    message: 'Selected tool guidance has ambiguous precedence.',
    remedy: 'Keep one applicable definition at each ancestry scope.',
  },
  TOOL_USE_POLICY_RELAXATION: {
    message: 'Narrower tool guidance relaxes inherited policy.',
    remedy: 'Keep narrower effects and approval policy at least as strict.',
  },
  SKILL_REF_MISSING: {
    message: 'Selected tool guidance has no canonical skill reference.',
    remedy: 'Declare one reviewed canonical skill reference.',
  },
  SKILL_REF_INVALID: {
    message: 'A selected canonical skill reference is invalid.',
    remedy: 'Repair the reviewed skill reference metadata.',
  },
  SKILL_REF_CONFLICT: {
    message: 'Applicable tool guidance declares conflicting skill references.',
    remedy: 'Use one canonical skill reference throughout the ancestry.',
  },
  SKILL_REF_UNMAPPED: {
    message: 'A selected canonical skill reference is not mapped.',
    remedy: 'Regenerate the reviewed vendor-skill map before retrying.',
  },
  SKILL_REF_DRIFTED: {
    message: 'Selected vendor-skill provenance has drifted.',
    remedy: 'Review and regenerate the vendor-skill map before retrying.',
  },
  SECRET_MATERIAL_FORBIDDEN: {
    message: 'Secret material is forbidden in context input.',
    remedy: 'Replace the credential with a non-secret reference before retrying.',
  },
  REFERENCE_NOT_FOUND: {
    message: 'A selected context reference was not found.',
    remedy: 'Register the referenced definition before retrying.',
  },
  REFERENCE_NOT_APPLICABLE: {
    message: 'A selected context reference is not applicable.',
    remedy: 'Use a definition whose declared scope applies to the selected plan.',
  },
  REFERENCE_CYCLE: {
    message: 'Selected nested plans form a cycle.',
    remedy: 'Remove at least one nested-plan edge before retrying.',
  },
  BRAIN_NOT_CONFIGURED: {
    message: 'The workspace has no Brain configuration.',
    remedy: 'Configure the workspace Brain when company evidence is needed.',
  },
  CONTEXT_BUDGET_REQUIRED_OVERFLOW: {
    message: 'Mandatory context exceeds the requested token budget.',
    remedy: 'Retry with the exact required token budget reported in details.',
  },
  CONTEXT_MANDATORY_UNSERVABLE: {
    message: 'Mandatory context exceeds the supported host ceiling.',
    remedy: 'Split or reduce the largest authored definitions before retrying.',
  },
  CONTEXT_EVIDENCE_INVALID: {
    message: 'Context evidence input is invalid.',
    remedy: 'Materialize a bounded, closed evidence candidate set and retry.',
  },
  CONTEXT_EVIDENCE_UNAVAILABLE: {
    message: 'Optional Brain evidence is unavailable.',
    remedy: 'Retry later or continue with the complete local context bundle.',
  },
  CONTEXT_REQUIRED_EVIDENCE_MISSING: {
    message: 'Required-intent Brain selectors have no eligible evidence.',
    remedy: 'Continue with local policy or ingest matching cited evidence.',
  },
  CONTEXT_RESOLUTION_FAILED: {
    message: 'Context resolution failed.',
    remedy: 'Retry after validating and repairing the workspace.',
  },
  YAML_INVALID: {
    message: 'Authored YAML is invalid',
    remedy: 'Fix the authored YAML and retry context resolution.',
  },
};

const SAFE_DETAIL_KEYS = new Set([
  'actual_bytes',
  'actual_kind',
  'actual_tokens',
  'agent',
  'bound',
  'byte_offset',
  'contributors',
  'detector_id',
  'entries',
  'expected_bytes',
  'expected_kind',
  'field',
  'field_path',
  'function',
  'host',
  'limit',
  'limit_bytes',
  'mandatory_bytes',
  'mandatory_tokens',
  'match_length',
  'maximum_tokens',
  'minimum_tokens',
  'observed_bytes',
  'path',
  'plan',
  'reason',
  'reference',
  'reported_tokens',
  'required_bytes',
  'required_counts',
  'required_tokens',
  'reserve_bytes',
  'reserve_tokens',
  'source_plan',
  'step_id',
  'unmatched_selectors',
]);

function safeDetailString(value: string): boolean {
  return value.length <= 4_096
    && controlByteOffset(value) === null
    && secretFindings(value, 'detail').length === 0
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+#[\]-]{0,4095}$/.test(value)
    && !/^file:\/\//i.test(value)
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes('..')
    && !value.includes('\\');
}

function sanitizeDetailValue(value: JsonValue, depth: number): JsonValue | undefined {
  if (depth > 3) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === 'string') return safeDetailString(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 16) return undefined;
    const entries = value.map((entry) => sanitizeDetailValue(entry, depth + 1));
    return entries.some((entry) => entry === undefined) ? undefined : entries as JsonValue[];
  }
  const entries = Object.entries(value)
    .filter(([key]) => safeDetailString(key))
    .map(([key, entry]) => [key, sanitizeDetailValue(entry, depth + 1)] as const)
    .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function sanitizedDetails(error: WorkspaceRosterError): Record<string, JsonValue> {
  const details: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(error.details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    const sanitized = sanitizeDetailValue(value, 0);
    if (sanitized !== undefined) details[key] = sanitized;
  }
  return details;
}

export function sanitizeContextFailure(error: unknown): WorkspaceRosterError {
  if (!isWorkspaceFailure(error)) {
    return workspaceFailure(
      'CONTEXT_RESOLUTION_FAILED',
      SANITIZED_CONTEXT_FAILURES.CONTEXT_RESOLUTION_FAILED!.message,
      SANITIZED_CONTEXT_FAILURES.CONTEXT_RESOLUTION_FAILED!.remedy,
    );
  }
  const fixed = SANITIZED_CONTEXT_FAILURES[error.code];
  if (fixed === undefined) {
    return workspaceFailure(
      error.code as WorkspaceDiagnosticCode,
      'Workspace context could not be resolved.',
      'Validate and repair the workspace before retrying context resolution.',
      sanitizedDetails(error),
    );
  }
  return workspaceFailure(error.code, fixed.message, fixed.remedy, sanitizedDetails(error));
}
