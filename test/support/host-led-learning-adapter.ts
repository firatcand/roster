#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../../src/lib/context-args.ts';
import {
  CONTEXT_ESTIMATOR,
  type SeedBrainCandidate,
} from '../../src/lib/workspace-context.ts';
import {
  hashSeededLearningValue,
  materializeSeededLesson,
  openSeededLearningStore,
  renderSeededCandidateLessonId,
  renderSeededCandidateMeaning,
  validateSeededContextQueryMeaning,
  type SeededCandidateMeaning,
  type SeededCompletedRun,
  type SeededContextQueryEvidence,
  type SeededFeedback,
  type SeededLessonCandidate,
} from './seeded-learning-store.ts';
import { resolveSeededWorkspaceContext } from './seeded-workspace-context.ts';

const RUN_ID = 'run-opportunity-discovery-001';
const FEEDBACK_ID = 'feedback-opportunity-discovery-001';
const CANDIDATE_ID = 'candidate-opportunity-discovery-001';
const FIXTURE_STARTED_AT = '2026-08-02T09:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-08-02T09:01:00.000Z';
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_FIXTURE_SEARCH_INPUT_BYTES = 64 * 1024;
const MAX_FIXTURE_SEARCH_RESULTS = 32;
const ROSTER_INVOCATION_TIMEOUT_MS = 30_000;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CONTEXT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FIXTURE_SEARCH_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FIXTURE_SEARCH_RESULT_ID = /^result-[a-z0-9]+$/u;
const FIXTURE_SEARCH_PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MARKDOWN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
export const HOST_LED_LEARNING_MODEL_VISIBLE_JSON_CHAR_LIMIT = 8_000;

const FIXTURE_SEARCH_PROVIDER = 'roster-350-fixture-search';
const FIXTURE_SEARCH_COLUMNS = [
  'id',
  'url',
  'author',
  'published',
  'title',
  'excerpt',
  'topics',
  'source',
  'source_id',
  'prior_runs',
  'untrusted_marker',
] as const;
const FIXTURE_SEARCH_CORPUS_KEYS = ['schema_version', 'provider', 'results'] as const;
const FIXTURE_SEARCH_RESULT_KEYS = [
  'result_id',
  'canonical_url',
  'author',
  'published_at',
  'title',
  'excerpt',
  'topics',
  'attribution',
  'observed_run_ids',
  'transient_marker',
] as const;

const CONTEXT_HOST_PROJECTION_KEYS = [
  'schema_version',
  'target',
  'request',
  'agent',
  'plan',
  'guidelines',
  'lessons',
  'brain_evidence',
  'tool_uses',
  'skill_refs',
  'diagnostics',
] as const;
const CONTEXT_HOST_OMITTED_KEYS = ['workspace', 'provenance', 'budget'] as const;
const CONTEXT_FRAGMENT_KEYS = [
  'fragment_id',
  'kind',
  'scope',
  'source_content_hash',
  'fragment_hash',
  'trust',
  'inclusion_reason',
  'required',
  'content_bytes',
  'content_tokens',
  'content',
] as const;
const CONTEXT_FRAGMENT_KINDS = new Set([
  'function',
  'agent',
  'plan',
  'guideline',
  'lesson',
  'brain-evidence',
  'tool-use',
  'skill-ref',
]);
const CONTEXT_TRUST_CLASSES = new Set([
  'authored-policy',
  'approved-lesson',
  'vendor-instruction',
  'brain-structured',
  'brain-extract-untrusted',
  'tool-output-untrusted',
  'host-asserted',
  'legacy-unverified',
  'diagnostic',
]);
const CONTEXT_INCLUSION_REASONS = new Set([
  'target-function',
  'target-agent',
  'selected-plan-root',
  'nested-plan-closure',
  'agent-default-guideline',
  'plan-referenced-guideline',
  'applicable-lesson',
  'plan-tool-step',
  'tool-skill-ref',
  'selector-match',
  'required-selector-match',
  'host-query',
  'host-step-hint',
]);
const TOOL_EFFECT_CLASSES = new Set([
  'local-read',
  'external-read',
  'local-write',
  'external-write',
  'irreversible-write',
  'brain-read',
  'brain-write',
]);
const CONTEXT_BUDGET_EXCLUSION_REASONS = [
  'budget-exhausted',
  'cross-binding',
  'cross-scope',
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

type Turn = 'discover' | 'approve';

type AdapterDefinition = {
  command: string;
  log_category: string;
  allowed_turns: readonly Turn[];
  required_flags: readonly string[];
  repeatable_flags: readonly string[];
};

type Contract = {
  schema_version: 2;
  fixture_id: string;
  runtime: {
    state_path: string;
    adapter_log_path: string;
    adapter_directory: string;
  };
  roster: {
    target: string;
    allowed_model_invocations: readonly {
      verb: string;
      required_argv: readonly string[];
      log_category: string;
    }[];
  };
  adapters: readonly AdapterDefinition[];
};

type ParsedArguments = {
  ordered: readonly { flag: string; value: string }[];
  values: ReadonlyMap<string, readonly string[]>;
};

type FixtureSearchResult = Readonly<{
  result_id: string;
  canonical_url: string;
  author: string;
  published_at: string;
  title: string;
  excerpt: string;
  topics: readonly string[];
  attribution: Readonly<{
    source: string;
    source_record_id: string;
  }>;
  observed_run_ids: readonly string[];
  transient_marker: string | null;
}>;

type FixtureSearchCorpus = Readonly<{
  schema_version: 1;
  provider: typeof FIXTURE_SEARCH_PROVIDER;
  results: readonly FixtureSearchResult[];
}>;

type FixtureSearchRow = readonly [
  id: string,
  url: string,
  author: string,
  published: string,
  title: string,
  excerpt: string,
  topics: readonly string[],
  source: string,
  sourceId: string,
  priorRuns: readonly string[],
  untrustedMarker: string | null,
];

type FixtureSearchProjection = Readonly<{
  schema_version: 2;
  provider: typeof FIXTURE_SEARCH_PROVIDER;
  request_hash: string;
  columns: typeof FIXTURE_SEARCH_COLUMNS;
  rows: readonly FixtureSearchRow[];
}>;

function fail(message: string): never {
  throw new Error(`Roster 350 fixture adapter rejected the call: ${message}`);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sourceHashDigest(value: unknown): string | null {
  return value === null ? null : Buffer.from(String(value).slice('sha256:'.length), 'hex').toString('base64url');
}

function requiredSourceHashDigest(value: unknown, label: string): string {
  const digest = sourceHashDigest(value);
  if (digest === null) fail(`${label} must retain its authored source revision`);
  return digest;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

export function assertModelVisibleJsonCharacterLimit(value: unknown, label: string): number {
  const characters = canonicalJson(value).length;
  if (characters > HOST_LED_LEARNING_MODEL_VISIBLE_JSON_CHAR_LIMIT) {
    fail(`${label} exceeds the ${HOST_LED_LEARNING_MODEL_VISIBLE_JSON_CHAR_LIMIT}-character model-visible JSON limit`);
  }
  return characters;
}

function contextObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function assertExactContextKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  if (!sameStrings(Object.keys(record), expected)) fail(`${label} escaped its closed shape`);
}

function contextString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 512 * 1024
    || CONTROL_CHARACTERS.test(value)) fail(`${label} is not a non-empty bounded string`);
  return value;
}

function contextMarkdown(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 512 * 1024
    || MARKDOWN_CONTROL_CHARACTERS.test(value)) fail(`${label} is not bounded Markdown`);
  return value;
}

function contextNullableString(value: unknown, label: string): string | null {
  return value === null ? null : contextString(value, label);
}

function contextId(value: unknown, label: string): string {
  const id = contextString(value, label);
  if (Buffer.byteLength(id, 'utf8') > 80 || !CONTEXT_ID.test(id)) fail(`${label} is not a canonical ID`);
  return id;
}

function contextNullableId(value: unknown, label: string): string | null {
  return value === null ? null : contextId(value, label);
}

function assertStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) fail(`${label} is not a bounded array`);
  const result = value.map((entry, index) => contextString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return result;
}

function compactObject(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => (
    entry !== null
    && entry !== false
    && !(Array.isArray(entry) && entry.length === 0)
    && !(entry !== null && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 0)
  ))));
}

function canonicalContextScope(value: unknown, label: string, expectedWorkspace?: string): string {
  const scope = contextObject(value, label);
  assertExactContextKeys(scope, ['workspace', 'function', 'agent', 'plan'], label);
  const workspace = contextId(scope['workspace'], `${label}.workspace`);
  if (expectedWorkspace !== undefined && workspace !== expectedWorkspace) {
    fail(`${label}.workspace does not match the context workspace`);
  }
  const functionId = contextNullableId(scope['function'], `${label}.function`);
  const agentId = contextNullableId(scope['agent'], `${label}.agent`);
  const planId = contextNullableId(scope['plan'], `${label}.plan`);
  if ((functionId === null && (agentId !== null || planId !== null)) || (agentId === null && planId !== null)) {
    fail(`${label} has an invalid hierarchy`);
  }
  if (planId !== null) return `${functionId!}/${agentId!}#${planId}`;
  if (agentId !== null) return `${functionId!}/${agentId}`;
  return functionId ?? workspace;
}

function assertToolScope(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const scope = contextObject(value, label);
  if (Object.keys(scope).some((key) => !['function', 'agent', 'plan'].includes(key))) {
    fail(`${label} escaped its closed shape`);
  }
  for (const key of Object.keys(scope)) contextId(scope[key], `${label}.${key}`);
  if ((!Object.hasOwn(scope, 'function') && (Object.hasOwn(scope, 'agent') || Object.hasOwn(scope, 'plan')))
    || (!Object.hasOwn(scope, 'agent') && Object.hasOwn(scope, 'plan'))) fail(`${label} has an invalid hierarchy`);
  return scope;
}

function canonicalToolScope(value: unknown, label: string, workspace: string): string {
  const scope = assertToolScope(value, label);
  if (Object.hasOwn(scope, 'plan')) return `${scope['function']}/${scope['agent']}#${scope['plan']}`;
  if (Object.hasOwn(scope, 'agent')) return `${scope['function']}/${scope['agent']}`;
  return typeof scope['function'] === 'string' ? scope['function'] : workspace;
}

function serializedFragmentContent(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail(`${label} is not JSON serializable`);
    return serialized;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Roster 350 fixture adapter rejected')) throw error;
    fail(`${label} is not JSON serializable`);
  }
}

function assertFragmentIntegrity(
  value: unknown,
  label: string,
  expectedKeys: readonly string[] = CONTEXT_FRAGMENT_KEYS,
  expectedWorkspace?: string,
): Record<string, unknown> {
  const fragment = contextObject(value, label);
  assertExactContextKeys(fragment, expectedKeys, label);
  contextString(fragment['fragment_id'], `${label}.fragment_id`);
  if (typeof fragment['kind'] !== 'string' || !CONTEXT_FRAGMENT_KINDS.has(fragment['kind'])) {
    fail(`${label}.kind is invalid`);
  }
  canonicalContextScope(fragment['scope'], `${label}.scope`, expectedWorkspace);
  if (fragment['source_content_hash'] !== null
    && (typeof fragment['source_content_hash'] !== 'string' || !SHA256.test(fragment['source_content_hash']))) {
    fail(`${label}.source_content_hash is invalid`);
  }
  if (typeof fragment['fragment_hash'] !== 'string' || !SHA256.test(fragment['fragment_hash'])) {
    fail(`${label}.fragment_hash is invalid`);
  }
  if (typeof fragment['trust'] !== 'string' || !CONTEXT_TRUST_CLASSES.has(fragment['trust'])) {
    fail(`${label}.trust is invalid`);
  }
  if (typeof fragment['inclusion_reason'] !== 'string'
    || !CONTEXT_INCLUSION_REASONS.has(fragment['inclusion_reason'])) fail(`${label}.inclusion_reason is invalid`);
  if (typeof fragment['required'] !== 'boolean') fail(`${label}.required is invalid`);
  const serialized = serializedFragmentContent(fragment['content'], `${label}.content`);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (!Number.isSafeInteger(fragment['content_bytes']) || fragment['content_bytes'] !== bytes) {
    fail(`${label}.content_bytes does not match its content`);
  }
  if (!Number.isSafeInteger(fragment['content_tokens']) || fragment['content_tokens'] !== Math.ceil(bytes / 4)) {
    fail(`${label}.content_tokens does not match its content`);
  }
  if (fragment['fragment_hash'] !== sha256(serialized)) fail(`${label}.fragment_hash does not match its content`);
  return fragment;
}

function assertFragmentPolicy(
  fragment: Readonly<Record<string, unknown>>,
  expected: Readonly<{ kind: string; trust: string; reason: string | readonly string[]; required: boolean }>,
  label: string,
): void {
  const reasons = typeof expected.reason === 'string' ? [expected.reason] : expected.reason;
  if (fragment['kind'] !== expected.kind || fragment['trust'] !== expected.trust
    || !reasons.includes(fragment['inclusion_reason'] as string) || fragment['required'] !== expected.required) {
    fail(`${label} has invalid collection policy metadata`);
  }
}

function projectFunctionFragment(
  value: unknown,
  workspace: string,
  targetFunction: string,
): Readonly<Record<string, unknown>> {
  const label = 'Roster context agent.function';
  const fragment = assertFragmentIntegrity(value, label, CONTEXT_FRAGMENT_KEYS, workspace);
  assertFragmentPolicy(fragment, { kind: 'function', trust: 'authored-policy', reason: 'target-function', required: true }, label);
  const content = contextObject(fragment['content'], `${label}.content`);
  assertExactContextKeys(content, ['schema_version', 'id', 'purpose', 'agents', 'guidelines', 'tool_uses'], `${label}.content`);
  if (content['schema_version'] !== 2 || contextId(content['id'], `${label}.content.id`) !== targetFunction) {
    fail(`${label}.content identity is invalid`);
  }
  const purpose = contextString(content['purpose'], `${label}.content.purpose`);
  for (const key of ['agents', 'guidelines', 'tool_uses']) assertStringArray(content[key], `${label}.content.${key}`);
  if (canonicalContextScope(fragment['scope'], `${label}.scope`, workspace) !== targetFunction
    || fragment['fragment_id'] !== `function:${targetFunction}`) fail(`${label} scope or fragment identity is invalid`);
  return Object.freeze({
    purpose,
    memberships: Object.freeze({
      agents: content['agents'],
      guidelines: content['guidelines'],
      tool_uses: content['tool_uses'],
    }),
    source_content_hash: requiredSourceHashDigest(fragment['source_content_hash'], label),
  });
}

function projectAgentFragment(
  value: unknown,
  workspace: string,
  targetFunction: string,
  targetAgent: string,
): Readonly<Record<string, unknown>> {
  const label = 'Roster context agent.agent';
  const fragment = assertFragmentIntegrity(value, label, CONTEXT_FRAGMENT_KEYS, workspace);
  assertFragmentPolicy(fragment, { kind: 'agent', trust: 'authored-policy', reason: 'target-agent', required: true }, label);
  const content = contextObject(fragment['content'], `${label}.content`);
  assertExactContextKeys(content, [
    'schema_version', 'id', 'function', 'purpose', 'plans', 'subagents', 'guidelines',
    'default_guidelines', 'tool_uses', 'lessons',
  ], `${label}.content`);
  if (content['schema_version'] !== 2 || contextId(content['id'], `${label}.content.id`) !== targetAgent
    || contextId(content['function'], `${label}.content.function`) !== targetFunction) {
    fail(`${label}.content identity is invalid`);
  }
  const purpose = contextString(content['purpose'], `${label}.content.purpose`);
  for (const key of ['plans', 'subagents', 'guidelines', 'default_guidelines', 'tool_uses', 'lessons']) {
    assertStringArray(content[key], `${label}.content.${key}`);
  }
  const qualified = `${targetFunction}/${targetAgent}`;
  if (canonicalContextScope(fragment['scope'], `${label}.scope`, workspace) !== qualified
    || fragment['fragment_id'] !== `agent:${qualified}`) fail(`${label} scope or fragment identity is invalid`);
  return Object.freeze({
    purpose,
    memberships: Object.freeze({
      plans: content['plans'],
      subagents: content['subagents'],
      guidelines: content['guidelines'],
      default_guidelines: content['default_guidelines'],
      tool_uses: content['tool_uses'],
      lessons: content['lessons'],
    }),
    source_content_hash: requiredSourceHashDigest(fragment['source_content_hash'], label),
    fragment_hash: fragment['fragment_hash'],
  });
}

function assertDefinitionMap(
  value: unknown,
  label: string,
  fields: readonly string[],
  validate: (entry: Readonly<Record<string, unknown>>, label: string) => void,
): Readonly<Record<string, unknown>> {
  const mapping = contextObject(value, label);
  if (Object.keys(mapping).length > 256) fail(`${label} exceeds its bounded collection`);
  for (const [key, raw] of Object.entries(mapping)) {
    contextId(key, `${label} key`);
    const entry = contextObject(raw, `${label}.${key}`);
    const expected = Object.hasOwn(entry, 'shape') ? [...fields, 'shape'] : fields;
    assertExactContextKeys(entry, expected, `${label}.${key}`);
    validate(entry, `${label}.${key}`);
  }
  return mapping;
}

function projectPlanStep(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const step = contextObject(value, label);
  const kind = contextString(step['kind'], `${label}.kind`);
  const targetField = ({
    reasoning: null,
    subagent: 'subagent',
    'cross-agent': 'agent',
    'nested-plan': 'plan',
    tool: 'tool_use',
    approval: 'approval_guidance',
    artifact: 'artifact',
  } as const)[kind as 'reasoning'];
  if (targetField === undefined) fail(`${label}.kind is invalid`);
  const optionalFields = ['context', 'expected', 'condition_guidance', 'retry_guidance']
    .filter((field) => Object.hasOwn(step, field));
  assertExactContextKeys(step, [
    'id', 'kind', 'instruction', ...optionalFields, ...(targetField === null ? [] : [targetField]),
  ], label);
  contextId(step['id'], `${label}.id`);
  contextString(step['instruction'], `${label}.instruction`);
  if (targetField !== null) contextString(step[targetField], `${label}.${targetField}`);
  let projectedContext: Readonly<Record<string, unknown>> | undefined;
  if (Object.hasOwn(step, 'context')) {
    const context = contextObject(step['context'], `${label}.context`);
    const fields = ['brain', 'guidelines'].filter((field) => Object.hasOwn(context, field));
    assertExactContextKeys(context, fields, `${label}.context`);
    projectedContext = compactObject(Object.fromEntries(fields.map((field) => [
      field,
      assertStringArray(context[field], `${label}.context.${field}`),
    ])));
  }
  let projectedExpected: Readonly<Record<string, unknown>> | undefined;
  if (Object.hasOwn(step, 'expected')) {
    const expected = contextObject(step['expected'], `${label}.expected`);
    assertExactContextKeys(expected, ['artifacts', 'output_guidance'], `${label}.expected`);
    projectedExpected = compactObject({
      artifacts: assertStringArray(expected['artifacts'], `${label}.expected.artifacts`),
      output_guidance: contextString(expected['output_guidance'], `${label}.expected.output_guidance`),
    });
  }
  let projectedRetry: Readonly<Record<string, unknown>> | undefined;
  if (Object.hasOwn(step, 'retry_guidance')) {
    const retry = contextObject(step['retry_guidance'], `${label}.retry_guidance`);
    assertExactContextKeys(retry, ['max_attempts', 'instruction'], `${label}.retry_guidance`);
    if (!Number.isSafeInteger(retry['max_attempts']) || (retry['max_attempts'] as number) <= 0) {
      fail(`${label}.retry_guidance.max_attempts is invalid`);
    }
    projectedRetry = Object.freeze({
      max_attempts: retry['max_attempts'],
      instruction: contextString(retry['instruction'], `${label}.retry_guidance.instruction`),
    });
  }
  if (Object.hasOwn(step, 'condition_guidance')) {
    contextString(step['condition_guidance'], `${label}.condition_guidance`);
  }
  return compactObject({
    id: step['id'],
    kind,
    instruction: step['instruction'],
    ...(targetField === null ? {} : { [targetField]: step[targetField] }),
    context: projectedContext,
    expected: projectedExpected,
    condition_guidance: step['condition_guidance'] ?? null,
    retry_guidance: projectedRetry,
  });
}

function projectPlanFragment(
  value: unknown,
  label: string,
  workspace: string,
  targetAgent: string,
  expectedReason: 'selected-plan-root' | 'nested-plan-closure',
): readonly [string, Readonly<Record<string, unknown>>] {
  const fragment = assertFragmentIntegrity(value, label, CONTEXT_FRAGMENT_KEYS, workspace);
  assertFragmentPolicy(fragment, { kind: 'plan', trust: 'authored-policy', reason: expectedReason, required: true }, label);
  const content = contextObject(fragment['content'], `${label}.content`);
  assertExactContextKeys(content, [
    'schema_version', 'id', 'qualified_id', 'agent', 'purpose', 'inputs', 'brain_selectors',
    'guidelines', 'tool_uses', 'artifacts', 'caps', 'steps', 'completion',
  ], `${label}.content`);
  const id = contextId(content['id'], `${label}.content.id`);
  const qualifiedId = `${targetAgent}#${id}`;
  if (content['schema_version'] !== 2 || content['agent'] !== targetAgent || content['qualified_id'] !== qualifiedId
    || fragment['fragment_id'] !== `plan:${qualifiedId}`
    || canonicalContextScope(fragment['scope'], `${label}.scope`, workspace) !== qualifiedId) {
    fail(`${label} identity or scope is invalid`);
  }
  const purpose = contextString(content['purpose'], `${label}.content.purpose`);
  assertDefinitionMap(content['inputs'], `${label}.content.inputs`, ['description', 'required'], (entry, entryLabel) => {
    contextString(entry['description'], `${entryLabel}.description`);
    if (typeof entry['required'] !== 'boolean') fail(`${entryLabel}.required is invalid`);
    if (Object.hasOwn(entry, 'shape')) contextString(entry['shape'], `${entryLabel}.shape`);
  });
  assertDefinitionMap(content['brain_selectors'], `${label}.content.brain_selectors`, ['description', 'required'], (entry, entryLabel) => {
    contextString(entry['description'], `${entryLabel}.description`);
    if (typeof entry['required'] !== 'boolean') fail(`${entryLabel}.required is invalid`);
  });
  for (const key of ['guidelines', 'tool_uses']) assertStringArray(content[key], `${label}.content.${key}`);
  assertDefinitionMap(content['artifacts'], `${label}.content.artifacts`, ['description'], (entry, entryLabel) => {
    contextString(entry['description'], `${entryLabel}.description`);
    if (Object.hasOwn(entry, 'shape')) contextString(entry['shape'], `${entryLabel}.shape`);
  });
  const caps = assertDefinitionMap(content['caps'], `${label}.content.caps`, ['maximum', 'guidance'], (entry, entryLabel) => {
    if (!Number.isSafeInteger(entry['maximum']) || (entry['maximum'] as number) <= 0) fail(`${entryLabel}.maximum is invalid`);
    contextString(entry['guidance'], `${entryLabel}.guidance`);
  });
  if (!Array.isArray(content['steps']) || content['steps'].length === 0 || content['steps'].length > 256) {
    fail(`${label}.content.steps is not a bounded non-empty array`);
  }
  const steps = content['steps'].map((step, index) => projectPlanStep(step, `${label}.content.steps[${index}]`));
  const stepIds = steps.map((step) => step['id']);
  if (new Set(stepIds).size !== stepIds.length) fail(`${label}.content.steps contains duplicate IDs`);
  const completion = contextObject(content['completion'], `${label}.content.completion`);
  assertExactContextKeys(completion, ['artifacts', 'output_guidance', 'criteria'], `${label}.content.completion`);
  const projectedCompletion = compactObject({
    artifacts: assertStringArray(completion['artifacts'], `${label}.content.completion.artifacts`),
    output_guidance: contextString(completion['output_guidance'], `${label}.content.completion.output_guidance`),
    criteria: assertStringArray(completion['criteria'], `${label}.content.completion.criteria`),
  });
  return Object.freeze([id, compactObject({
    fragment_hash: fragment['fragment_hash'],
    source_content_hash: requiredSourceHashDigest(fragment['source_content_hash'], label),
    purpose,
    inputs: content['inputs'],
    brain_selectors: content['brain_selectors'],
    guideline_refs: content['guidelines'],
    tool_refs: content['tool_uses'],
    artifacts: content['artifacts'],
    caps,
    steps,
    completion: projectedCompletion,
  })]);
}

function projectMarkdownFragment(
  value: unknown,
  label: string,
  workspace: string,
  kind: 'guideline' | 'lesson',
): Readonly<Record<string, unknown>> {
  const fragment = assertFragmentIntegrity(value, label, CONTEXT_FRAGMENT_KEYS, workspace);
  assertFragmentPolicy(fragment, kind === 'guideline'
    ? { kind, trust: 'authored-policy', reason: ['agent-default-guideline', 'plan-referenced-guideline'], required: true }
    : { kind, trust: 'approved-lesson', reason: 'applicable-lesson', required: false }, label);
  const content = contextObject(fragment['content'], `${label}.content`);
  assertExactContextKeys(content, ['id', 'kind', 'purpose', 'scope', 'body'], `${label}.content`);
  const id = contextId(content['id'], `${label}.content.id`);
  if (content['kind'] !== kind || !String(fragment['fragment_id']).startsWith(`${kind}:`)) {
    fail(`${label}.content kind or fragment identity is invalid`);
  }
  const scope = canonicalToolScope(content['scope'], `${label}.content.scope`, workspace);
  if (canonicalContextScope(fragment['scope'], `${label}.scope`, workspace) !== scope) fail(`${label}.scope is inconsistent`);
  return Object.freeze({
    id,
    purpose: contextString(content['purpose'], `${label}.content.purpose`),
    scope,
    body: contextMarkdown(content['body'], `${label}.content.body`),
    source_content_hash: requiredSourceHashDigest(fragment['source_content_hash'], label),
    inclusion_reason: fragment['inclusion_reason'],
  });
}

function assertToolEffective(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const effective = contextObject(value, label);
  const required = [
    'schema_version', 'id', 'scope', 'purpose', 'skill_ref', 'when', 'capabilities', 'filters', 'rules',
    'how', 'output_expectations', 'brain', 'approval', 'evidence',
  ];
  assertExactContextKeys(effective, Object.hasOwn(effective, 'effects') ? [...required, 'effects'] : required, label);
  if (effective['schema_version'] !== 2) fail(`${label}.schema_version is invalid`);
  contextId(effective['id'], `${label}.id`);
  for (const key of ['purpose', 'skill_ref']) contextString(effective[key], `${label}.${key}`);
  assertToolScope(effective['scope'], `${label}.scope`);
  for (const key of ['when', 'capabilities', 'filters', 'rules', 'how']) assertStringArray(effective[key], `${label}.${key}`);
  for (const [key, fields] of [
    ['output_expectations', ['required', 'guidance']],
    ['brain', ['read', 'write']],
    ['evidence', ['required', 'guidance']],
  ] as const) {
    const nested = contextObject(effective[key], `${label}.${key}`);
    assertExactContextKeys(nested, fields, `${label}.${key}`);
    for (const field of fields) assertStringArray(nested[field], `${label}.${key}.${field}`);
  }
  const approval = contextObject(effective['approval'], `${label}.approval`);
  assertExactContextKeys(approval, ['requirement', 'guidance'], `${label}.approval`);
  if (!['none', 'human'].includes(String(approval['requirement']))) fail(`${label}.approval.requirement is invalid`);
  assertStringArray(approval['guidance'], `${label}.approval.guidance`);
  if (Object.hasOwn(effective, 'effects')) {
    const effects = contextObject(effective['effects'], `${label}.effects`);
    assertExactContextKeys(effects, ['allowed'], `${label}.effects`);
    const allowed = assertStringArray(effects['allowed'], `${label}.effects.allowed`);
    if (allowed.some((entry) => !TOOL_EFFECT_CLASSES.has(entry))) fail(`${label}.effects.allowed is invalid`);
  }
  return effective;
}

function assertToolReferences(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 256) fail(`${label} is not a bounded array`);
  for (const [index, entry] of value.entries()) {
    const reference = contextObject(entry, `${label}[${index}]`);
    assertExactContextKeys(reference, ['plan_id', 'step_id'], `${label}[${index}]`);
    contextString(reference['plan_id'], `${label}[${index}].plan_id`);
    contextId(reference['step_id'], `${label}[${index}].step_id`);
  }
}

function projectToolFragment(
  value: unknown,
  label: string,
  workspace: string,
  target: string,
): Readonly<Record<string, unknown>> {
  const fragment = assertFragmentIntegrity(value, label, CONTEXT_FRAGMENT_KEYS, workspace);
  assertFragmentPolicy(fragment, { kind: 'tool-use', trust: 'authored-policy', reason: 'plan-tool-step', required: true }, label);
  const content = contextObject(fragment['content'], `${label}.content`);
  assertExactContextKeys(content, ['effective', 'contributors', 'field_sources', 'semantic_hash', 'references'], `${label}.content`);
  const effective = assertToolEffective(content['effective'], `${label}.content.effective`);
  if (typeof content['semantic_hash'] !== 'string' || !SHA256.test(content['semantic_hash'])
    || content['semantic_hash'] !== sha256(canonicalJson(effective))) fail(`${label}.content.semantic_hash is invalid`);
  assertToolReferences(content['references'], `${label}.content.references`);
  if (!Array.isArray(content['contributors']) || content['contributors'].length > 256) {
    fail(`${label}.content.contributors is not a bounded array`);
  }
  for (const [index, entry] of content['contributors'].entries()) {
    const contributorLabel = `${label}.content.contributors[${index}]`;
    const contributor = contextObject(entry, contributorLabel);
    assertExactContextKeys(contributor, ['qualified_id', 'path', 'scope', 'content_hash'], contributorLabel);
    contextString(contributor['qualified_id'], `${contributorLabel}.qualified_id`);
    contextString(contributor['path'], `${contributorLabel}.path`);
    assertToolScope(contributor['scope'], `${contributorLabel}.scope`);
    if (typeof contributor['content_hash'] !== 'string' || !SHA256.test(contributor['content_hash'])) {
      fail(`${contributorLabel}.content_hash is invalid`);
    }
  }
  const fieldSources = contextObject(content['field_sources'], `${label}.content.field_sources`);
  for (const [field, entries] of Object.entries(fieldSources)) {
    contextString(field, `${label}.content.field_sources key`);
    if (!Array.isArray(entries) || entries.length > 256) fail(`${label}.content.field_sources.${field} is invalid`);
    for (const [index, entry] of entries.entries()) {
      const sourceLabel = `${label}.content.field_sources.${field}[${index}]`;
      const source = contextObject(entry, sourceLabel);
      assertExactContextKeys(source, Object.hasOwn(source, 'entry')
        ? ['qualified_id', 'path', 'entry'] : ['qualified_id', 'path'], sourceLabel);
      contextString(source['qualified_id'], `${sourceLabel}.qualified_id`);
      contextString(source['path'], `${sourceLabel}.path`);
      if (Object.hasOwn(source, 'entry')) contextString(source['entry'], `${sourceLabel}.entry`);
    }
  }
  const scope = canonicalToolScope(effective['scope'], `${label}.content.effective.scope`, workspace);
  if (canonicalContextScope(fragment['scope'], `${label}.scope`, workspace) !== scope) fail(`${label}.scope is inconsistent`);
  const qualifiedIds = (content['contributors'] as Record<string, unknown>[])
    .filter((contributor) => canonicalToolScope(
      contributor['scope'],
      `${label}.content.contributors effective scope`,
      workspace,
    ) === scope)
    .map((contributor) => contributor['qualified_id']);
  if (qualifiedIds.length !== 1) fail(`${label}.content has no unique effective qualified identity`);
  const outputExpectations = effective['output_expectations'] as Record<string, unknown>;
  const brain = effective['brain'] as Record<string, unknown>;
  const approval = effective['approval'] as Record<string, unknown>;
  const evidence = effective['evidence'] as Record<string, unknown>;
  const effects = effective['effects'] as Record<string, unknown> | undefined;
  return compactObject({
    qualified_id: qualifiedIds[0],
    id: effective['id'],
    scope: scope === target ? null : scope,
    purpose: effective['purpose'],
    skill_ref: effective['skill_ref'],
    when: effective['when'],
    capabilities: effective['capabilities'],
    filters: effective['filters'],
    rules: effective['rules'],
    how: effective['how'],
    outputs: outputExpectations,
    brain,
    approval: (approval['guidance'] as readonly unknown[]).length === 0 ? approval['requirement'] : approval,
    evidence,
    effects: effects ?? null,
    references: content['references'],
    semantic_hash: content['semantic_hash'],
    resolution_provenance_sha256: sha256(canonicalJson({
      contributors: content['contributors'],
      field_sources: fieldSources,
    })),
  });
}

function projectBrainEvidence(value: unknown, label: string, workspace: string): Readonly<Record<string, unknown>> {
  const fragment = assertFragmentIntegrity(value, label, [
    ...CONTEXT_FRAGMENT_KEYS, 'privacy', 'candidate_scope', 'retrieval_reason', 'citation',
  ], workspace);
  assertFragmentPolicy(fragment, {
    kind: 'brain-evidence', trust: 'brain-extract-untrusted',
    reason: ['selector-match', 'required-selector-match'], required: false,
  }, label);
  const text = contextString(fragment['content'], `${label}.content`);
  if (!['public', 'internal'].includes(String(fragment['privacy']))) fail(`${label}.privacy is invalid`);
  const scope = canonicalContextScope(fragment['candidate_scope'], `${label}.candidate_scope`, workspace);
  if (canonicalContextScope(fragment['scope'], `${label}.scope`, workspace) !== scope) fail(`${label}.scope is inconsistent`);
  if (fragment['retrieval_reason'] !== fragment['inclusion_reason']) fail(`${label}.retrieval_reason is inconsistent`);
  const citation = contextObject(fragment['citation'], `${label}.citation`);
  assertExactContextKeys(citation, [
    'logical_source_id', 'source_version_id', 'object_id', 'extractor_id', 'extractor_version',
    'locator', 'content_hash',
  ], `${label}.citation`);
  for (const key of ['logical_source_id', 'source_version_id', 'locator']) contextString(citation[key], `${label}.citation.${key}`);
  for (const key of ['object_id', 'extractor_id', 'extractor_version']) contextNullableString(citation[key], `${label}.citation.${key}`);
  if (typeof citation['content_hash'] !== 'string' || !SHA256.test(citation['content_hash'])) {
    fail(`${label}.citation.content_hash is invalid`);
  }
  const prefix = 'brain-evidence:';
  if (!String(fragment['fragment_id']).startsWith(prefix)) fail(`${label}.fragment_id is invalid`);
  return Object.freeze({
    id: String(fragment['fragment_id']).slice(prefix.length),
    text,
    privacy: fragment['privacy'],
    scope,
    retrieval_reason: fragment['retrieval_reason'],
    citation,
  });
}

function projectSkillFragment(value: unknown, label: string, workspace: string): Readonly<Record<string, unknown>> {
  const fragment = assertFragmentIntegrity(value, label, CONTEXT_FRAGMENT_KEYS, workspace);
  assertFragmentPolicy(fragment, { kind: 'skill-ref', trust: 'vendor-instruction', reason: 'tool-skill-ref', required: true }, label);
  const content = contextObject(fragment['content'], `${label}.content`);
  assertExactContextKeys(content, ['skill_ref', 'generator_version', 'map_hash', 'authored_paths', 'hosts'], `${label}.content`);
  const skillRef = contextString(content['skill_ref'], `${label}.content.skill_ref`);
  contextString(content['generator_version'], `${label}.content.generator_version`);
  if (typeof content['map_hash'] !== 'string' || !SHA256.test(content['map_hash'])) fail(`${label}.content.map_hash is invalid`);
  assertStringArray(content['authored_paths'], `${label}.content.authored_paths`);
  const hosts = contextObject(content['hosts'], `${label}.content.hosts`);
  if (Object.keys(hosts).length === 0 || Object.keys(hosts).some((host) => !['claude', 'codex'].includes(host))) {
    fail(`${label}.content.hosts is invalid`);
  }
  const projectedHosts = Object.fromEntries(Object.entries(hosts).map(([host, raw]) => {
    const locator = contextObject(raw, `${label}.content.hosts.${host}`);
    if (locator['kind'] === 'host-native') {
      assertExactContextKeys(locator, ['kind', 'identity', 'assurance'], `${label}.content.hosts.${host}`);
      if (locator['identity'] !== skillRef || locator['assurance'] !== 'host-resolved') {
        fail(`${label}.content.hosts.${host} is not a valid host-native locator`);
      }
      return [host, Object.freeze({
        kind: locator['kind'],
        identity: locator['identity'],
        assurance: locator['assurance'],
      })];
    }
    assertExactContextKeys(locator, [
      'kind', 'path', 'content_hash', 'source', 'revision', 'revision_immutable', 'assurance',
    ], `${label}.content.hosts.${host}`);
    if (locator['kind'] !== 'workspace-relative' || locator['assurance'] !== 'verified'
      || typeof locator['content_hash'] !== 'string' || !SHA256.test(locator['content_hash'])
      || typeof locator['revision_immutable'] !== 'boolean') {
      fail(`${label}.content.hosts.${host} is not a valid workspace-relative locator`);
    }
    for (const key of ['path', 'source', 'revision']) contextString(locator[key], `${label}.content.hosts.${host}.${key}`);
    return [host, Object.freeze({
      kind: locator['kind'],
      path: locator['path'],
      content_hash: locator['content_hash'],
      source: locator['source'],
      revision: locator['revision'],
      revision_immutable: locator['revision_immutable'],
      assurance: locator['assurance'],
    })];
  }));
  if (fragment['fragment_id'] !== `skill-ref:${skillRef}`) fail(`${label}.fragment_id is inconsistent`);
  return Object.freeze({
    skill_ref: skillRef,
    generator_version: content['generator_version'],
    map_hash: content['map_hash'],
    authored_paths: content['authored_paths'],
    hosts: projectedHosts,
  });
}

function assertTarget(value: unknown): Readonly<{
  functionId: string; agentId: string; planId: string | null; qualified: string;
}> {
  const target = contextObject(value, 'Roster context target');
  assertExactContextKeys(target, ['function_id', 'agent_id', 'plan_id'], 'Roster context target');
  const functionId = contextId(target['function_id'], 'Roster context target.function_id');
  const agentId = contextId(target['agent_id'], 'Roster context target.agent_id');
  const planId = contextNullableId(target['plan_id'], 'Roster context target.plan_id');
  return Object.freeze({
    functionId,
    agentId,
    planId,
    qualified: planId === null ? `${functionId}/${agentId}` : `${functionId}/${agentId}#${planId}`,
  });
}

function projectRequest(value: unknown): Readonly<Record<string, unknown>> {
  const request = contextObject(value, 'Roster context request');
  assertExactContextKeys(request, ['query', 'step_hint', 'budget_tokens', 'explain'], 'Roster context request');
  const query = contextString(request['query'], 'Roster context request.query');
  const stepHint = contextNullableString(request['step_hint'], 'Roster context request.step_hint');
  if (!Number.isSafeInteger(request['budget_tokens']) || (request['budget_tokens'] as number) <= 0) {
    fail('Roster context request.budget_tokens is invalid');
  }
  if (typeof request['explain'] !== 'boolean') fail('Roster context request.explain is invalid');
  return compactObject({ query, step_hint: stepHint, budget_tokens: request['budget_tokens'], explain: request['explain'] });
}

function assertJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 32) fail(`${label} exceeds the JSON depth limit`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} is not a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) fail(`${label} exceeds the JSON array limit`);
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  const object = contextObject(value, label);
  if (Object.keys(object).length > 1_024) fail(`${label} exceeds the JSON object limit`);
  for (const [key, entry] of Object.entries(object)) {
    if (key.length === 0 || CONTROL_CHARACTERS.test(key)) fail(`${label} contains an invalid key`);
    assertJsonValue(entry, `${label}.${key}`, depth + 1);
  }
}

function assertDiagnostics(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 256) fail('Roster context diagnostics is not a bounded array');
  for (const [index, entry] of value.entries()) {
    const label = `Roster context diagnostics[${index}]`;
    const diagnostic = contextObject(entry, label);
    assertExactContextKeys(diagnostic, [
      'code', 'severity', 'message',
      ...(Object.hasOwn(diagnostic, 'path') ? ['path'] : []),
      ...(Object.hasOwn(diagnostic, 'remedy') ? ['remedy'] : []),
      'details',
    ], label);
    contextString(diagnostic['code'], `${label}.code`);
    if (!['error', 'warning', 'info'].includes(String(diagnostic['severity']))) fail(`${label}.severity is invalid`);
    contextString(diagnostic['message'], `${label}.message`);
    if (Object.hasOwn(diagnostic, 'path')) contextString(diagnostic['path'], `${label}.path`);
    if (Object.hasOwn(diagnostic, 'remedy')) contextString(diagnostic['remedy'], `${label}.remedy`);
    assertJsonValue(diagnostic['details'], `${label}.details`);
  }
  return value;
}

function projectBudget(value: unknown, requestBudget: unknown): Readonly<Record<string, unknown>> {
  const budget = contextObject(value, 'Roster context budget');
  assertExactContextKeys(budget, [
    'estimator', 'limit_tokens', 'mandatory_bytes', 'mandatory_tokens', 'optional_bytes', 'optional_tokens',
    'reserve_bytes', 'reserve_tokens', 'total_bytes', 'total_tokens', 'remaining_tokens', 'exclusions',
    'lessons_budget_exhausted', 'required_selectors_unmatched', 'candidate_diagnostics_omitted',
  ], 'Roster context budget');
  if (contextString(budget['estimator'], 'Roster context budget.estimator') !== CONTEXT_ESTIMATOR) {
    fail('Roster context budget estimator is not the fixed host-context.v2 estimator');
  }
  for (const key of Object.keys(budget).filter((key) => !['estimator', 'exclusions'].includes(key))) {
    if (!Number.isSafeInteger(budget[key]) || (budget[key] as number) < 0) fail(`Roster context budget.${key} is invalid`);
  }
  const exclusions = contextObject(budget['exclusions'], 'Roster context budget.exclusions');
  assertExactContextKeys(exclusions, CONTEXT_BUDGET_EXCLUSION_REASONS, 'Roster context budget.exclusions');
  for (const [reason, count] of Object.entries(exclusions)) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) fail(`Roster context budget.exclusions.${reason} is invalid`);
  }
  if (budget['limit_tokens'] !== requestBudget
    || budget['total_bytes'] !== (budget['mandatory_bytes'] as number) + (budget['optional_bytes'] as number) + (budget['reserve_bytes'] as number)
    || budget['total_tokens'] !== (budget['mandatory_tokens'] as number) + (budget['optional_tokens'] as number) + (budget['reserve_tokens'] as number)
    || budget['remaining_tokens'] !== (budget['limit_tokens'] as number) - (budget['total_tokens'] as number)) {
    fail('Roster context budget accounting is inconsistent');
  }
  const nonzeroExclusions = Object.fromEntries(Object.entries(exclusions).filter(([, count]) => count !== 0));
  const nonzeroOmissions = Object.fromEntries([
    'lessons_budget_exhausted',
    'required_selectors_unmatched',
    'candidate_diagnostics_omitted',
  ].filter((key) => budget[key] !== 0).map((key) => [key, budget[key]]));
  return Object.freeze({
    limit_tokens: budget['limit_tokens'],
    total_tokens: budget['total_tokens'],
    remaining_tokens: budget['remaining_tokens'],
    exclusions: Object.freeze({ default: 0, counts: nonzeroExclusions }),
    omission_counts: Object.freeze({ default: 0, counts: nonzeroOmissions }),
  });
}

function hashSuffix(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('validated context hash is invalid');
  return value.slice('sha256:'.length);
}

function trimTrailingNulls(value: readonly unknown[]): readonly unknown[] {
  const result = [...value];
  while (result.at(-1) === null || result.at(-1) === undefined) result.pop();
  return Object.freeze(result);
}

function projectedScopeCode(
  value: unknown,
  workspace: string,
  targetFunction: string,
  targetAgent: string,
): string | number {
  if (value === workspace) return 0;
  if (value === targetFunction) return 1;
  if (value === targetAgent) return 2;
  if (typeof value === 'string' && value.startsWith(`${targetAgent}#`)) {
    return value.slice(`${targetAgent}#`.length);
  }
  fail('validated context scope cannot be represented by host-context.v2');
}

function relativePlanReference(value: unknown, targetAgent: string): string {
  const reference = String(value);
  const prefix = `${targetAgent}#`;
  return reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
}

function relativeGuidelineReference(value: unknown, targetFunction: string, targetAgent: string): string {
  const reference = String(value);
  const agentPrefix = `${targetAgent}/guidelines/`;
  if (reference.startsWith(agentPrefix)) return `2:${reference.slice(agentPrefix.length)}`;
  const functionPrefix = `${targetFunction}/guidelines/`;
  if (reference.startsWith(functionPrefix)) return `1:${reference.slice(functionPrefix.length)}`;
  return reference;
}

function encodeDefinitionRows(
  value: unknown,
  kind: 'input' | 'selector' | 'artifact' | 'cap',
): readonly (readonly unknown[])[] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(Object.entries(value as Readonly<Record<string, Readonly<Record<string, unknown>>>>)
    .map(([id, entry]) => {
      if (kind === 'input' || kind === 'selector') {
        return trimTrailingNulls([
          id,
          entry['description'],
          entry['required'] === true ? 1 : 0,
          entry['shape'] ?? null,
        ]);
      }
      if (kind === 'artifact') {
        return trimTrailingNulls([id, entry['description'], entry['shape'] ?? null]);
      }
      return Object.freeze([id, entry['maximum'], entry['guidance']]);
    }));
}

const PLAN_STEP_KIND_CODES = Object.freeze({
  reasoning: 0,
  subagent: 1,
  'cross-agent': 2,
  'nested-plan': 3,
  tool: 4,
  approval: 5,
  artifact: 6,
} as const);

function encodePlanStep(
  step: Readonly<Record<string, unknown>>,
  targetAgent: string,
): readonly unknown[] {
  const kind = step['kind'] as keyof typeof PLAN_STEP_KIND_CODES;
  const targetField = ({
    reasoning: null,
    subagent: 'subagent',
    'cross-agent': 'agent',
    'nested-plan': 'plan',
    tool: 'tool_use',
    approval: 'approval_guidance',
    artifact: 'artifact',
  } as const)[kind];
  let reference = targetField === null ? null : step[targetField];
  if (kind === 'nested-plan') reference = relativePlanReference(reference, targetAgent);
  const context = step['context'] as Readonly<Record<string, unknown>> | undefined;
  const expected = step['expected'] as Readonly<Record<string, unknown>> | undefined;
  const retry = step['retry_guidance'] as Readonly<Record<string, unknown>> | undefined;
  const options = compactObject({
    x: context === undefined ? null : Object.freeze([context['brain'] ?? [], context['guidelines'] ?? []]),
    e: expected === undefined ? null : Object.freeze([expected['artifacts'] ?? [], expected['output_guidance']]),
    c: step['condition_guidance'] ?? null,
    r: retry === undefined ? null : Object.freeze([retry['max_attempts'], retry['instruction']]),
  });
  return trimTrailingNulls([
    step['id'],
    PLAN_STEP_KIND_CODES[kind],
    step['instruction'],
    reference,
    Object.keys(options).length === 0 ? null : options,
  ]);
}

function encodePlanDefinition(
  entry: readonly [string, Readonly<Record<string, unknown>>],
  targetFunction: string,
  targetAgent: string,
): readonly unknown[] {
  const [id, definition] = entry;
  const completion = definition['completion'] as Readonly<Record<string, unknown>>;
  const extras = compactObject({
    i: encodeDefinitionRows(definition['inputs'], 'input'),
    b: encodeDefinitionRows(definition['brain_selectors'], 'selector'),
    g: ((definition['guideline_refs'] ?? []) as readonly unknown[]).map((reference) => (
      relativeGuidelineReference(reference, targetFunction, targetAgent)
    )),
    t: definition['tool_refs'] ?? [],
    a: encodeDefinitionRows(definition['artifacts'], 'artifact'),
    c: encodeDefinitionRows(definition['caps'], 'cap'),
  });
  const artifacts = (completion['artifacts'] ?? []) as readonly unknown[];
  return trimTrailingNulls([
    id,
    hashSuffix(definition['fragment_hash']),
    definition['source_content_hash'],
    definition['purpose'],
    Object.freeze((definition['steps'] as readonly Readonly<Record<string, unknown>>[])
      .map((step) => encodePlanStep(step, targetAgent))),
    trimTrailingNulls([
      completion['output_guidance'],
      completion['criteria'],
      artifacts.length === 0 ? null : artifacts,
    ]),
    Object.keys(extras).length === 0 ? null : extras,
  ]);
}

function commonValue(values: readonly unknown[]): unknown | false {
  if (values.length === 0) return null;
  return values.every((value) => Object.is(value, values[0])) ? values[0] : false;
}

function usefulCommonPrefix(values: readonly unknown[]): string {
  if (values.length < 2 || values.some((value) => typeof value !== 'string')) return '';
  const strings = values as readonly string[];
  let prefix = strings[0]!;
  for (const value of strings.slice(1)) {
    let length = 0;
    while (length < prefix.length && prefix[length] === value[length]) length += 1;
    prefix = prefix.slice(0, length);
  }
  return prefix.length >= 4 ? prefix : '';
}

function withoutPrefix(value: unknown, prefix: string): unknown {
  return prefix.length > 0 && typeof value === 'string' ? value.slice(prefix.length) : value;
}

function encodeBrainEvidence(
  items: readonly Readonly<Record<string, unknown>>[],
  workspace: string,
  targetFunction: string,
  targetAgent: string,
): readonly unknown[] {
  const citations = items.map((entry) => entry['citation'] as Readonly<Record<string, unknown>>);
  const privacy = commonValue(items.map((entry) => entry['privacy']));
  const scope = commonValue(items.map((entry) => projectedScopeCode(
    entry['scope'], workspace, targetFunction, targetAgent,
  )));
  const extractorId = commonValue(citations.map((citation) => citation['extractor_id']));
  const extractorVersion = commonValue(citations.map((citation) => citation['extractor_version']));
  const prefixFields = ['id', 'logical_source_id', 'source_version_id', 'object_id', 'locator'] as const;
  const prefixes = prefixFields.map((field) => usefulCommonPrefix(field === 'id'
    ? items.map((entry) => entry['id'])
    : citations.map((citation) => citation[field])));
  const rows = items.map((entry, index) => {
    const citation = citations[index]!;
    const row: unknown[] = [
      withoutPrefix(entry['id'], prefixes[0]!),
      entry['text'],
      entry['retrieval_reason'] === 'required-selector-match' ? 1 : 0,
    ];
    if (privacy === false) row.push(entry['privacy']);
    if (scope === false) row.push(projectedScopeCode(entry['scope'], workspace, targetFunction, targetAgent));
    row.push(
      withoutPrefix(citation['logical_source_id'], prefixes[1]!),
      withoutPrefix(citation['source_version_id'], prefixes[2]!),
      withoutPrefix(citation['object_id'], prefixes[3]!),
    );
    if (extractorId === false) row.push(citation['extractor_id']);
    if (extractorVersion === false) row.push(citation['extractor_version']);
    row.push(
      withoutPrefix(citation['locator'], prefixes[4]!),
      hashSuffix(citation['content_hash']),
    );
    return Object.freeze(row);
  });
  return Object.freeze([
    Object.freeze([privacy, scope, extractorId, extractorVersion]),
    Object.freeze(prefixes),
    Object.freeze(rows),
  ]);
}

function encodeToolUse(
  entry: Readonly<Record<string, unknown>>,
  target: string,
): readonly unknown[] {
  const id = String(entry['id']);
  const scope = entry['scope'] === undefined ? target : String(entry['scope']);
  const expectedQualifiedId = `${scope}/tools/${id}`;
  if (entry['qualified_id'] !== expectedQualifiedId) {
    fail('validated tool-use qualified identity cannot be represented by host-context.v2');
  }
  const outputs = entry['outputs'] as Readonly<Record<string, unknown>>;
  const brain = entry['brain'] as Readonly<Record<string, unknown>>;
  const approval = typeof entry['approval'] === 'string'
    ? Object.freeze([entry['approval'], []])
    : Object.freeze([
      (entry['approval'] as Readonly<Record<string, unknown>>)['requirement'],
      (entry['approval'] as Readonly<Record<string, unknown>>)['guidance'],
    ]);
  const evidence = entry['evidence'] as Readonly<Record<string, unknown>>;
  const effects = entry['effects'] as Readonly<Record<string, unknown>> | undefined;
  const references = (entry['references'] as readonly Readonly<Record<string, unknown>>[]).map((reference) => (
    reference['plan_id'] === target
      ? reference['step_id']
      : Object.freeze([reference['plan_id'], reference['step_id']])
  ));
  return Object.freeze([
    id,
    scope === target ? null : scope,
    entry['purpose'],
    entry['skill_ref'],
    entry['when'],
    entry['capabilities'],
    entry['filters'],
    entry['rules'],
    entry['how'],
    Object.freeze([outputs['required'] ?? [], outputs['guidance'] ?? []]),
    Object.freeze([brain['read'] ?? [], brain['write'] ?? []]),
    approval,
    Object.freeze([evidence['required'] ?? [], evidence['guidance'] ?? []]),
    effects?.['allowed'],
    Object.freeze(references),
    hashSuffix(entry['semantic_hash']),
    hashSuffix(entry['resolution_provenance_sha256']),
  ]);
}

function encodeSkillRef(entry: Readonly<Record<string, unknown>>): readonly unknown[] {
  const hosts = Object.entries(entry['hosts'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>)
    .map(([host, locator]) => locator['kind'] === 'host-native'
      ? Object.freeze([host, 0])
      : Object.freeze([
        host,
        1,
        locator['path'],
        hashSuffix(locator['content_hash']),
        locator['source'],
        locator['revision'],
        locator['revision_immutable'] === true ? 1 : 0,
      ]));
  return Object.freeze([
    entry['skill_ref'],
    entry['generator_version'],
    hashSuffix(entry['map_hash']),
    entry['authored_paths'],
    Object.freeze(hosts),
  ]);
}

function assertProvenance(value: unknown, fragments: readonly Readonly<Record<string, unknown>>[]): void {
  if (!Array.isArray(value) || value.length < fragments.length || value.length > fragments.length + 2) {
    fail('Roster context provenance has an invalid bounded length');
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const label = `Roster context provenance[${index}]`;
    const provenance = contextObject(entry, label);
    assertExactContextKeys(provenance, Object.hasOwn(provenance, 'explanation')
      ? ['fragment_id', 'source_id', 'trust', 'inclusion_reason', 'required', 'source_content_hash', 'fragment_hash', 'explanation']
      : ['fragment_id', 'source_id', 'trust', 'inclusion_reason', 'required', 'source_content_hash', 'fragment_hash'], label);
    const id = contextString(provenance['fragment_id'], `${label}.fragment_id`);
    contextString(provenance['source_id'], `${label}.source_id`);
    if (seen.has(id)) fail(`${label}.fragment_id is duplicated`);
    seen.add(id);
    if (!CONTEXT_TRUST_CLASSES.has(String(provenance['trust']))
      || !CONTEXT_INCLUSION_REASONS.has(String(provenance['inclusion_reason']))
      || typeof provenance['required'] !== 'boolean') fail(`${label} policy metadata is invalid`);
    if (provenance['source_content_hash'] !== null
      && (typeof provenance['source_content_hash'] !== 'string' || !SHA256.test(provenance['source_content_hash']))) {
      fail(`${label}.source_content_hash is invalid`);
    }
    if (typeof provenance['fragment_hash'] !== 'string' || !SHA256.test(provenance['fragment_hash'])) {
      fail(`${label}.fragment_hash is invalid`);
    }
    if (Object.hasOwn(provenance, 'explanation')) contextString(provenance['explanation'], `${label}.explanation`);
  }
  for (const fragment of fragments) {
    const provenance = (value as Record<string, unknown>[]).find((entry) => entry['fragment_id'] === fragment['fragment_id']);
    if (provenance === undefined || provenance['trust'] !== fragment['trust']
      || provenance['inclusion_reason'] !== fragment['inclusion_reason']
      || provenance['required'] !== fragment['required']
      || provenance['source_content_hash'] !== fragment['source_content_hash']
      || provenance['fragment_hash'] !== fragment['fragment_hash']) fail('Roster context provenance is inconsistent with a fragment');
  }
}

export function compactContextForHost(value: unknown): Readonly<Record<string, unknown>> {
  const record = contextObject(value, 'Roster context output');
  if (!sameStrings(Object.keys(record), [...CONTEXT_HOST_PROJECTION_KEYS, ...CONTEXT_HOST_OMITTED_KEYS])) {
    fail('Roster context output escaped the closed raw context contract');
  }
  if (record['schema_version'] !== 2) fail('Roster context schema_version is invalid');
  const workspace = contextObject(record['workspace'], 'Roster context workspace');
  assertExactContextKeys(workspace, ['schema_version', 'workspace_id', 'source_hash', 'brain_binding'], 'Roster context workspace');
  if (workspace['schema_version'] !== 2) fail('Roster context workspace.schema_version is invalid');
  const workspaceId = contextId(workspace['workspace_id'], 'Roster context workspace.workspace_id');
  if (typeof workspace['source_hash'] !== 'string' || !SHA256.test(workspace['source_hash'])) {
    fail('Roster context workspace.source_hash is invalid');
  }
  contextNullableString(workspace['brain_binding'], 'Roster context workspace.brain_binding');
  const target = assertTarget(record['target']);
  const request = projectRequest(record['request']);
  if (request['explain'] === true) {
    fail('host-context.v2 does not support explain requests because detailed provenance is not model-visible');
  }
  const agent = contextObject(record['agent'], 'Roster context agent');
  assertExactContextKeys(agent, ['function', 'agent'], 'Roster context agent');
  const functionDefinition = projectFunctionFragment(agent['function'], workspaceId, target.functionId);
  const targetAgent = `${target.functionId}/${target.agentId}`;
  const agentDefinition = projectAgentFragment(agent['agent'], workspaceId, target.functionId, target.agentId);
  const plan = contextObject(record['plan'], 'Roster context plan');
  assertExactContextKeys(plan, ['root_id', 'definitions'], 'Roster context plan');
  const rootId = contextNullableString(plan['root_id'], 'Roster context plan.root_id');
  if (rootId !== (target.planId === null ? null : target.qualified)) fail('Roster context plan.root_id does not match target');
  if (!Array.isArray(plan['definitions']) || plan['definitions'].length > 256) {
    fail('Roster context plan.definitions is not a bounded array');
  }
  if ((rootId === null) !== (plan['definitions'].length === 0)) fail('Roster context plan closure does not match target');
  const planEntries = plan['definitions'].map((entry, index) => projectPlanFragment(
    entry,
    `Roster context plan.definitions[${index}]`,
    workspaceId,
    targetAgent,
    index === 0 ? 'selected-plan-root' : 'nested-plan-closure',
  ));
  if (rootId !== null && planEntries[0]?.[0] !== target.planId) fail('Roster context root plan definition is not first');
  if (new Set(planEntries.map(([id]) => id)).size !== planEntries.length) fail('Roster context plan IDs are duplicated');
  const projectCollection = <T>(key: string, project: (entry: unknown, label: string) => T): readonly T[] => {
    const collection = record[key];
    if (!Array.isArray(collection) || collection.length > 256) fail(`Roster context ${key} is not a bounded array`);
    return collection.map((entry, index) => project(entry, `Roster context ${key}[${index}]`));
  };
  const guidelines = projectCollection('guidelines', (entry, label) => (
    projectMarkdownFragment(entry, label, workspaceId, 'guideline')
  ));
  const lessons = projectCollection('lessons', (entry, label) => (
    projectMarkdownFragment(entry, label, workspaceId, 'lesson')
  ));
  const brainItems = projectCollection('brain_evidence', (entry, label) => projectBrainEvidence(entry, label, workspaceId));
  const toolUses = projectCollection('tool_uses', (entry, label) => (
    projectToolFragment(entry, label, workspaceId, target.qualified)
  ));
  const skillRefs = projectCollection('skill_refs', (entry, label) => projectSkillFragment(entry, label, workspaceId));
  const diagnostics = assertDiagnostics(record['diagnostics']);
  const budget = projectBudget(record['budget'], (record['request'] as Record<string, unknown>)['budget_tokens']);
  const fragmentCollections = [
    agent['function'], agent['agent'], ...plan['definitions'], ...(record['guidelines'] as unknown[]),
    ...(record['tool_uses'] as unknown[]), ...(record['skill_refs'] as unknown[]), ...(record['lessons'] as unknown[]),
    ...(record['brain_evidence'] as unknown[]),
  ] as Readonly<Record<string, unknown>>[];
  assertProvenance(record['provenance'], fragmentCollections);
  const markdownRows = (items: readonly Readonly<Record<string, unknown>>[], kind: 'guideline' | 'lesson') => (
    Object.freeze(items.map((entry) => Object.freeze([
      entry['id'],
      entry['purpose'],
      projectedScopeCode(entry['scope'], workspaceId, target.functionId, targetAgent),
      entry['body'],
      entry['source_content_hash'],
      ...(kind === 'guideline'
        ? [entry['inclusion_reason'] === 'plan-referenced-guideline' ? 1 : 0]
        : []),
    ])))
  );
  const functionMemberships = functionDefinition['memberships'] as Readonly<Record<string, unknown>>;
  const agentMemberships = agentDefinition['memberships'] as Readonly<Record<string, unknown>>;
  const budgetExclusions = (
    budget['exclusions'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>
  )['counts'];
  const omissionCounts = (
    budget['omission_counts'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>
  )['counts'];
  const result = Object.freeze({
    schema: 'host-context.v2',
    hash_prefix: 'sha256:',
    source_hash_encoding: 'sha256-base64url',
    workspace: Object.freeze([workspaceId, hashSuffix(workspace['source_hash']), workspace['brain_binding']]),
    target: Object.freeze([target.qualified, hashSuffix(agentDefinition['fragment_hash'])]),
    request: trimTrailingNulls([
      request['query'],
      request['budget_tokens'],
      request['step_hint'] ?? null,
      request['explain'] === true ? 1 : null,
    ]),
    agent: Object.freeze([
      Object.freeze([
        functionDefinition['purpose'],
        functionMemberships['agents'],
        functionMemberships['guidelines'],
        functionMemberships['tool_uses'],
        functionDefinition['source_content_hash'],
      ]),
      Object.freeze([
        agentDefinition['purpose'],
        agentMemberships['plans'],
        agentMemberships['subagents'],
        agentMemberships['guidelines'],
        agentMemberships['default_guidelines'],
        agentMemberships['tool_uses'],
        agentMemberships['lessons'],
        agentDefinition['source_content_hash'],
      ]),
    ]),
    plans: Object.freeze(planEntries.map((entry) => encodePlanDefinition(entry, target.functionId, targetAgent))),
    guidelines: markdownRows(guidelines, 'guideline'),
    lessons: markdownRows(lessons, 'lesson'),
    brain: encodeBrainEvidence(brainItems, workspaceId, target.functionId, targetAgent),
    tools: Object.freeze(toolUses.map((entry) => encodeToolUse(entry, target.qualified))),
    skills: Object.freeze(skillRefs.map(encodeSkillRef)),
    budget: Object.freeze([
      budget['limit_tokens'],
      budget['total_tokens'],
      budget['remaining_tokens'],
      Object.freeze(Object.entries(budgetExclusions)),
      Object.freeze([
        omissionCounts['lessons_budget_exhausted'] ?? 0,
        omissionCounts['required_selectors_unmatched'] ?? 0,
        omissionCounts['candidate_diagnostics_omitted'] ?? 0,
      ]),
    ]),
    diagnostics,
    raw_context_sha256: sha256(canonicalJson(record)),
  });
  assertModelVisibleJsonCharacterLimit(result, 'Roster context host projection');
  return result;
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_ARGUMENT_BYTES
    && !CONTROL_CHARACTERS.test(value);
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/') && rel !== '';
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function workspacePath(options: {
  root: string;
  relativePath: string;
  label: string;
  leaf: 'regular-file' | 'regular-file-or-missing' | 'directory';
}): string {
  if (!boundedString(options.relativePath) || isAbsolute(options.relativePath)) {
    fail(`${options.label} is not a bounded workspace-relative path`);
  }
  const root = resolve(options.root);
  const resolved = resolve(root, options.relativePath);
  if (!inside(root, resolved)) fail(`${options.label} escaped the workspace`);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('workspace root must be a non-symlink directory');
  }
  const components = relative(root, resolved).split(sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT'
        && index === components.length - 1
        && options.leaf === 'regular-file-or-missing') {
        return resolved;
      }
      fail(`${options.label} has a missing or unreadable path component`);
    }
    if (stat.isSymbolicLink()) fail(`${options.label} contains a symbolic link`);
    if (index < components.length - 1 && !stat.isDirectory()) {
      fail(`${options.label} has a non-directory path component`);
    }
    if (index === components.length - 1) {
      if (options.leaf === 'directory' && !stat.isDirectory()) {
        fail(`${options.label} must be a directory`);
      }
      if (options.leaf !== 'directory' && !stat.isFile()) {
        fail(`${options.label} must be a regular file`);
      }
    }
  }
  return resolved;
}

function readWorkspaceFile(root: string, relativePath: string, label: string, maxBytes?: number): Buffer {
  const path = workspacePath({ root, relativePath, label, leaf: 'regular-file' });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    fail(`${label} could not be opened without following symbolic links`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} must be a regular file`);
    if (maxBytes !== undefined && before.size > maxBytes) fail(`${label} exceeds its byte limit`);
    const bytes = readFileSync(descriptor);
    if (maxBytes !== undefined && bytes.length > maxBytes) fail(`${label} exceeds its byte limit`);
    const after = fstatSync(descriptor);
    const current = lstatSync(workspacePath({ root, relativePath, label, leaf: 'regular-file' }));
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.dev !== current.dev || before.ino !== current.ino) {
      fail(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readContract(workspace: string): Contract {
  const value = JSON.parse(readWorkspaceFile(
    workspace,
    '.fixture/runtime/host-launch-contract.json',
    'contract path',
  ).toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('contract is not an object');
  const record = value as Record<string, unknown>;
  if (record['schema_version'] !== 2 || typeof record['fixture_id'] !== 'string') fail('contract identity is invalid');
  if (record['runtime'] === null || typeof record['runtime'] !== 'object' || Array.isArray(record['runtime'])) {
    fail('contract runtime is invalid');
  }
  if (record['roster'] === null || typeof record['roster'] !== 'object' || Array.isArray(record['roster'])) {
    fail('contract roster is invalid');
  }
  if (!Array.isArray(record['adapters'])) fail('contract adapters are invalid');
  const contract = value as Contract;
  if (!boundedString(contract.runtime.state_path)
    || !boundedString(contract.runtime.adapter_log_path)
    || !boundedString(contract.runtime.adapter_directory)
    || !boundedString(contract.roster.target)
    || !Array.isArray(contract.roster.allowed_model_invocations)) {
    fail('contract runtime or Roster data is invalid');
  }
  const rosterVerbs = new Set<string>();
  for (const invocation of contract.roster.allowed_model_invocations) {
    if (!boundedString(invocation.verb) || !boundedString(invocation.log_category)
      || !Array.isArray(invocation.required_argv)
      || invocation.required_argv.length > 16
      || !invocation.required_argv.every(boundedString)
      || rosterVerbs.has(invocation.verb)) {
      fail('contract Roster invocation data is invalid');
    }
    rosterVerbs.add(invocation.verb);
  }
  const adapterCommands = new Set<string>();
  for (const adapter of contract.adapters) {
    if (!boundedString(adapter.command) || !boundedString(adapter.log_category)
      || !Array.isArray(adapter.allowed_turns)
      || adapter.allowed_turns.some((turn) => turn !== 'discover' && turn !== 'approve')
      || !Array.isArray(adapter.required_flags) || !adapter.required_flags.every(boundedString)
      || !Array.isArray(adapter.repeatable_flags) || !adapter.repeatable_flags.every(boundedString)
      || adapterCommands.has(adapter.command)) {
      fail('contract adapter data is invalid');
    }
    if (adapter.repeatable_flags.some((flag) => !adapter.required_flags.includes(flag))) {
      fail('contract repeatable adapter flags must also be required');
    }
    adapterCommands.add(adapter.command);
  }
  workspacePath({
    root: workspace,
    relativePath: contract.runtime.adapter_directory,
    label: 'adapter directory',
    leaf: 'directory',
  });
  return contract;
}

function parseArguments(argv: readonly string[], definition: AdapterDefinition): ParsedArguments {
  const allowed = new Set([...definition.required_flags, ...definition.repeatable_flags]);
  const values = new Map<string, string[]>();
  const ordered: { flag: string; value: string }[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !allowed.has(flag) || !boundedString(value)) {
      fail(`invalid literal argv for ${definition.command}`);
    }
    const existing = values.get(flag) ?? [];
    if (existing.length > 0 && !definition.repeatable_flags.includes(flag)) {
      fail(`non-repeatable flag ${flag} was repeated`);
    }
    existing.push(value);
    values.set(flag, existing);
    ordered.push({ flag, value });
  }
  for (const flag of definition.required_flags) {
    if (!values.has(flag)) fail(`required flag ${flag} is missing`);
  }
  return { ordered, values };
}

function one(arguments_: ParsedArguments, flag: string): string {
  const values = arguments_.values.get(flag);
  if (values === undefined || values.length !== 1) fail(`${flag} must occur exactly once`);
  return values[0]!;
}

function queryProof(query: string, requestHash: string): Record<string, unknown> {
  const bytes = Buffer.byteLength(query, 'utf8');
  if (bytes === 0 || bytes > 240 || /^-/u.test(query) || CONTROL_CHARACTERS.test(query)) {
    fail('derived query is not a bounded literal');
  }
  const queryHash = sha256(query);
  if (queryHash === requestHash) fail('derived query must differ from the natural request');
  try {
    validateSeededContextQueryMeaning(query);
  } catch {
    fail('derived query is outside the closed non-secret semantic grammar');
  }
  return {
    bytes,
    differs_from_request: true,
    leading_option: false,
    control_characters: false,
    query,
    query_sha256: queryHash,
  };
}

function persistedContextQueryFromDiscoveryLog(
  workspace: string,
  contract: Contract,
  requestHash: string,
): Readonly<SeededContextQueryEvidence> {
  const bytes = readWorkspaceFile(workspace, contract.runtime.adapter_log_path, 'adapter log');
  const records = bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.length > 0).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      fail('adapter log contains invalid JSON while binding the completed-run query');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (value as Record<string, unknown>)['sequence'] !== index + 1) {
      fail('adapter log sequence is invalid while binding the completed-run query');
    }
    return value as Record<string, unknown>;
  });
  const queryRecords = records.filter((record) => (
    record['log_category'] === 'roster.context' || record['log_category'] === 'tool.search'
  ));
  if (canonicalJson(queryRecords.map((record) => record['log_category']))
    !== canonicalJson(['roster.context', 'tool.search'])) {
    fail('completed run does not have one ordered context/search query pair');
  }
  const proofs = queryRecords.map((record) => {
    const proof = record['query_proof'];
    if (record['turn'] !== 'discover' || proof === null || typeof proof !== 'object' || Array.isArray(proof)) {
      fail('completed-run query proof is missing or outside discovery');
    }
    const query = (proof as Record<string, unknown>)['query'];
    if (typeof query !== 'string') fail('completed-run query proof omitted its exact query');
    const expected = queryProof(query, requestHash);
    if (canonicalJson(proof) !== canonicalJson(expected)) {
      fail('completed-run query proof does not match its exact bytes and hash');
    }
    return expected;
  });
  if (canonicalJson(proofs[0]) !== canonicalJson(proofs[1])) {
    fail('completed run context and search queries differ');
  }
  const proof = proofs[0]!;
  return Object.freeze({
    bytes: proof['bytes'] as number,
    query: proof['query'] as string,
    query_sha256: proof['query_sha256'] as string,
  });
}

function appendLog(options: {
  workspace: string;
  contract: Contract;
  turn: Turn;
  command: string;
  category: string;
  flags: readonly string[];
  output: unknown;
  query?: Record<string, unknown>;
  challengeHash?: string;
  rosterProof?: Readonly<{
    argvHash: string;
    contractArgvHash: string;
    bundleHash: string;
    rawContextHash?: string;
  }>;
}): void {
  const contextRawHash = options.rosterProof?.rawContextHash;
  if (options.rosterProof !== undefined
    && (!SHA256.test(options.rosterProof.argvHash)
      || options.rosterProof.argvHash !== options.rosterProof.contractArgvHash
      || !SHA256.test(options.rosterProof.bundleHash)
      || (options.rosterProof.rawContextHash !== undefined
        && !SHA256.test(options.rosterProof.rawContextHash)))) {
    fail('Roster invocation proof is invalid');
  }
  if (options.category === 'roster.context') {
    if (contextRawHash === undefined || options.output === null || typeof options.output !== 'object'
      || Array.isArray(options.output)
      || (options.output as Record<string, unknown>)['raw_context_sha256'] !== contextRawHash) {
      fail('Roster context log is not bound to its full raw context hash');
    }
  } else if (contextRawHash !== undefined) {
    fail('non-context log cannot carry a raw Roster context hash');
  }
  const relativePath = options.contract.runtime.adapter_log_path;
  const lockRelativePath = `${relativePath}.lock`;
  const lockPath = workspacePath({
    root: options.workspace,
    relativePath: lockRelativePath,
    label: 'adapter log lock',
    leaf: 'regular-file-or-missing',
  });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch {
    fail('adapter log already has an active or stale writer lock');
  }
  try {
    const lockStat = fstatSync(lockDescriptor);
    if (!lockStat.isFile()) fail('adapter log lock is not a regular file');
    const path = workspacePath({
      root: options.workspace,
      relativePath,
      label: 'adapter log',
      leaf: 'regular-file-or-missing',
    });
    const lines = existsSync(path)
      ? readWorkspaceFile(options.workspace, relativePath, 'adapter log')
        .toString('utf8').split(/\r?\n/u).filter((line) => line.length > 0)
      : [];
    for (const [index, line] of lines.entries()) {
      let previous: unknown;
      try {
        previous = JSON.parse(line) as unknown;
      } catch {
        fail('adapter log contains invalid JSON');
      }
      if (previous === null || typeof previous !== 'object' || Array.isArray(previous)
        || (previous as Record<string, unknown>)['sequence'] !== index + 1) {
        fail('adapter log sequence is invalid');
      }
    }
    const record = {
      schema_version: 1,
      sequence: lines.length + 1,
      turn: options.turn,
      command: options.command,
      log_category: options.category,
      flags: [...options.flags].sort(),
      output_sha256: sha256(canonicalJson(options.output)),
      ...(options.query === undefined ? {} : { query_proof: options.query }),
      ...(options.challengeHash === undefined ? {} : { skill_challenge_sha256: options.challengeHash }),
      ...(options.rosterProof === undefined ? {} : {
        roster_invocation_status: 'prepared-bundle-success',
        roster_argv_exact: true,
        roster_argv_sha256: options.rosterProof.argvHash,
        roster_contract_argv_sha256: options.rosterProof.contractArgvHash,
        roster_bundle_sha256: options.rosterProof.bundleHash,
        ...(options.rosterProof.rawContextHash === undefined
          ? {}
          : { raw_context_sha256: options.rosterProof.rawContextHash }),
      }),
    };
    let logDescriptor: number;
    try {
      logDescriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
        0o600,
      );
    } catch {
      fail('adapter log could not be opened without following symbolic links');
    }
    try {
      if (!fstatSync(logDescriptor).isFile()) fail('adapter log must be a regular file');
      writeFileSync(logDescriptor, `${canonicalJson(record)}\n`, { encoding: 'utf8' });
      fsyncSync(logDescriptor);
    } finally {
      closeSync(logDescriptor);
    }
    workspacePath({
      root: options.workspace,
      relativePath,
      label: 'adapter log',
      leaf: 'regular-file',
    });
  } finally {
    closeSync(lockDescriptor);
    const currentLockPath = workspacePath({
      root: options.workspace,
      relativePath: lockRelativePath,
      label: 'adapter log lock',
      leaf: 'regular-file',
    });
    const lockStat = lstatSync(currentLockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      fail('adapter log lock changed while held');
    }
    unlinkSync(currentLockPath);
  }
}

function emit(value: unknown): never {
  writeFileSync(1, `${canonicalJson(value)}\n`, { encoding: 'utf8' });
  process.exit(0);
}

function readJson(workspace: string, relativePath: string, label: string): unknown {
  return JSON.parse(readWorkspaceFile(workspace, relativePath, label).toString('utf8')) as unknown;
}

function fixtureSearchString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes || CONTROL_CHARACTERS.test(value)) {
    fail(`${label} is not a non-empty bounded string`);
  }
  return value;
}

function fixtureSearchId(value: unknown, label: string, pattern = FIXTURE_SEARCH_ID): string {
  const id = fixtureSearchString(value, label, 96);
  if (!pattern.test(id)) fail(`${label} is not a canonical ID`);
  return id;
}

function fixtureSearchStringArray(
  value: unknown,
  label: string,
  options: Readonly<{ maximum: number; allowEmpty: boolean }>,
): readonly string[] {
  if (!Array.isArray(value) || value.length > options.maximum || (!options.allowEmpty && value.length === 0)) {
    fail(`${label} is not a bounded array`);
  }
  const result = value.map((entry, index) => fixtureSearchId(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return Object.freeze(result);
}

function fixtureSearchUrl(value: unknown, label: string): string {
  const source = fixtureSearchString(value, label, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.hash !== '' || parsed.href !== source) {
    fail(`${label} is not a canonical credential-free HTTPS URL`);
  }
  return source;
}

function fixtureSearchPublishedAt(value: unknown, label: string): string {
  const publishedAt = fixtureSearchString(value, label, 32);
  const parsed = new Date(publishedAt);
  if (!FIXTURE_SEARCH_PUBLISHED_AT.test(publishedAt) || Number.isNaN(parsed.getTime())
    || parsed.toISOString().replace('.000Z', 'Z') !== publishedAt) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
  return publishedAt;
}

function parseFixtureSearchCorpus(value: unknown): FixtureSearchCorpus {
  const corpus = contextObject(value, 'fixture search corpus');
  assertExactContextKeys(corpus, FIXTURE_SEARCH_CORPUS_KEYS, 'fixture search corpus');
  if (corpus['schema_version'] !== 1 || corpus['provider'] !== FIXTURE_SEARCH_PROVIDER
    || !Array.isArray(corpus['results']) || corpus['results'].length === 0
    || corpus['results'].length > MAX_FIXTURE_SEARCH_RESULTS) {
    fail('fixture search corpus identity or result count is invalid');
  }
  const results = corpus['results'].map((value_, index): FixtureSearchResult => {
    const label = `fixture search result[${index}]`;
    const result = contextObject(value_, label);
    assertExactContextKeys(result, FIXTURE_SEARCH_RESULT_KEYS, label);
    const attribution = contextObject(result['attribution'], `${label}.attribution`);
    assertExactContextKeys(attribution, ['source', 'source_record_id'], `${label}.attribution`);
    const transientMarker = result['transient_marker'] === null
      ? null
      : fixtureSearchString(result['transient_marker'], `${label}.transient_marker`, 256);
    return Object.freeze({
      result_id: fixtureSearchId(result['result_id'], `${label}.result_id`, FIXTURE_SEARCH_RESULT_ID),
      canonical_url: fixtureSearchUrl(result['canonical_url'], `${label}.canonical_url`),
      author: fixtureSearchString(result['author'], `${label}.author`, 256),
      published_at: fixtureSearchPublishedAt(result['published_at'], `${label}.published_at`),
      title: fixtureSearchString(result['title'], `${label}.title`, 512),
      excerpt: fixtureSearchString(result['excerpt'], `${label}.excerpt`, 4_096),
      topics: fixtureSearchStringArray(result['topics'], `${label}.topics`, { maximum: 32, allowEmpty: false }),
      attribution: Object.freeze({
        source: fixtureSearchId(attribution['source'], `${label}.attribution.source`),
        source_record_id: fixtureSearchId(
          attribution['source_record_id'],
          `${label}.attribution.source_record_id`,
        ),
      }),
      observed_run_ids: fixtureSearchStringArray(
        result['observed_run_ids'],
        `${label}.observed_run_ids`,
        { maximum: 64, allowEmpty: true },
      ),
      transient_marker: transientMarker,
    });
  });
  const duplicateDimensions = [
    ['result IDs', results.map((entry) => entry.result_id)],
    ['canonical URLs', results.map((entry) => entry.canonical_url)],
    ['source record IDs', results.map((entry) => entry.attribution.source_record_id)],
  ] as const;
  for (const [label, values] of duplicateDimensions) {
    if (new Set(values).size !== values.length) fail(`fixture search corpus contains duplicate ${label}`);
  }
  const parsed = Object.freeze({
    schema_version: 1 as const,
    provider: FIXTURE_SEARCH_PROVIDER,
    results: Object.freeze(results),
  });
  if (Buffer.byteLength(canonicalJson(parsed), 'utf8') > MAX_FIXTURE_SEARCH_INPUT_BYTES) {
    fail('fixture search corpus exceeds its byte limit');
  }
  return parsed;
}

function projectFixtureSearchForHost(value: unknown, requestHash: string): FixtureSearchProjection {
  if (!SHA256.test(requestHash)) fail('fixture search request hash is invalid');
  const corpus = parseFixtureSearchCorpus(value);
  return Object.freeze({
    schema_version: 2 as const,
    provider: corpus.provider,
    request_hash: requestHash,
    columns: FIXTURE_SEARCH_COLUMNS,
    rows: Object.freeze(corpus.results.map((result): FixtureSearchRow => Object.freeze([
      result.result_id,
      result.canonical_url,
      result.author,
      result.published_at,
      result.title,
      result.excerpt,
      result.topics,
      result.attribution.source,
      result.attribution.source_record_id,
      result.observed_run_ids,
      result.transient_marker,
    ]))),
  });
}

function fixtureSearchCorpusFromProjection(value: unknown): FixtureSearchCorpus {
  const projection = contextObject(value, 'fixture search projection');
  assertExactContextKeys(
    projection,
    ['schema_version', 'provider', 'request_hash', 'columns', 'rows'],
    'fixture search projection',
  );
  if (projection['schema_version'] !== 2 || projection['provider'] !== FIXTURE_SEARCH_PROVIDER
    || typeof projection['request_hash'] !== 'string' || !SHA256.test(projection['request_hash'])
    || canonicalJson(projection['columns']) !== canonicalJson(FIXTURE_SEARCH_COLUMNS)
    || !Array.isArray(projection['rows'])) {
    fail('fixture search projection identity is invalid');
  }
  const results = projection['rows'].map((value_, index) => {
    if (!Array.isArray(value_) || value_.length !== FIXTURE_SEARCH_COLUMNS.length) {
      fail(`fixture search projection row[${index}] escaped its closed shape`);
    }
    return {
      result_id: value_[0],
      canonical_url: value_[1],
      author: value_[2],
      published_at: value_[3],
      title: value_[4],
      excerpt: value_[5],
      topics: value_[6],
      attribution: { source: value_[7], source_record_id: value_[8] },
      observed_run_ids: value_[9],
      transient_marker: value_[10],
    };
  });
  return parseFixtureSearchCorpus({
    schema_version: 1,
    provider: projection['provider'],
    results,
  });
}

function requireFixtureSearchResult(value: unknown, resultId: string): FixtureSearchResult {
  const canonicalResultId = fixtureSearchId(resultId, 'selected result', FIXTURE_SEARCH_RESULT_ID);
  const corpus = parseFixtureSearchCorpus(value);
  const result = corpus.results.find((entry) => entry.result_id === canonicalResultId);
  if (result === undefined) fail('selected result does not exist in the controlled corpus');
  return result;
}

function readFixtureSearchInput(workspace: string): unknown {
  const bytes = readWorkspaceFile(
    workspace,
    '.fixture/input/fake-search-results.json',
    'tool input',
    MAX_FIXTURE_SEARCH_INPUT_BYTES,
  );
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    fail('tool input is not valid JSON');
  }
}

function contextCandidates(workspace: string): readonly SeedBrainCandidate[] {
  const value = readJson(workspace, '.fixture/input/brain-evidence.json', 'Brain input');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Brain input is invalid');
  const candidates = (value as Record<string, unknown>)['candidates'];
  if (!Array.isArray(candidates)) fail('Brain candidates are invalid');
  return structuredClone(candidates) as SeedBrainCandidate[];
}

function expandedRosterArgv(
  invocation: Contract['roster']['allowed_model_invocations'][number],
  target: string,
  argv: readonly string[],
): Readonly<{ expected: readonly string[]; derivedQuery?: string }> {
  const queryIndexes = invocation.required_argv
    .map((entry, index) => entry === '$DERIVED_QUERY' ? index : -1)
    .filter((index) => index >= 0);
  if (queryIndexes.length > 1) fail('Roster contract has multiple derived-query placeholders');
  const derivedQuery = queryIndexes.length === 1 ? argv[queryIndexes[0]!] : undefined;
  if (queryIndexes.length === 1 && derivedQuery === undefined) {
    fail('Roster argv is missing its contracted derived query');
  }
  const expected = invocation.required_argv.map((entry) => {
    if (entry === '$TARGET') return target;
    if (entry === '$DERIVED_QUERY') return derivedQuery!;
    if (/^\$[A-Z][A-Z0-9_]*$/u.test(entry)) fail(`Roster contract has unsupported placeholder ${entry}`);
    return entry;
  });
  return derivedQuery === undefined ? { expected } : { expected, derivedQuery };
}

function requireContractedRosterArgv(
  invocation: Contract['roster']['allowed_model_invocations'][number],
  target: string,
  argv: readonly string[],
): Readonly<{ expected: readonly string[]; derivedQuery?: string }> {
  const contracted = expandedRosterArgv(invocation, target, argv);
  if (canonicalJson(argv) !== canonicalJson(contracted.expected)) {
    fail(`Roster ${invocation.verb} argv does not exactly match required_argv`);
  }
  return contracted;
}

export const hostLedLearningAdapterTestApi = Object.freeze({
  workspacePath,
  expandedRosterArgv,
  requireContractedRosterArgv,
  parseArguments,
  parseFixtureSearchCorpus,
  projectFixtureSearchForHost,
  fixtureSearchCorpusFromProjection,
  requireFixtureSearchResult,
  appendLog,
  persistedContextQueryFromDiscoveryLog,
  stateShowProjection,
  compactContextForHost,
  assertModelVisibleJsonCharacterLimit,
  invokePreparedRoster,
});

function invokePreparedRoster(options: {
  workspace: string;
  argv: readonly string[];
  verb: string;
  timeoutMs?: number;
}): Readonly<{ output: unknown; bundleHash: string }> {
  const bundleRelativePath = '.fixture/runtime/roster.js';
  const before = readWorkspaceFile(options.workspace, bundleRelativePath, 'Roster bundle');
  const bundle = workspacePath({
    root: options.workspace,
    relativePath: bundleRelativePath,
    label: 'Roster bundle',
    leaf: 'regular-file',
  });
  const timeoutMs = options.timeoutMs ?? ROSTER_INVOCATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > ROSTER_INVOCATION_TIMEOUT_MS) {
    fail('Roster invocation timeout is invalid');
  }
  const result = spawnSync(process.execPath, [bundle, options.verb, ...options.argv], {
    cwd: options.workspace,
    env: {
      HOME: process.env['HOME']!,
      PATH: process.env['PATH']!,
      TMPDIR: process.env['TMPDIR']!,
      LANG: process.env['LANG']!,
      LC_ALL: process.env['LC_ALL']!,
      NO_COLOR: '1',
      CI: '1',
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const after = readWorkspaceFile(options.workspace, bundleRelativePath, 'Roster bundle');
  if (sha256(before) !== sha256(after)) fail('Roster bundle changed during invocation');
  if (result.error !== undefined) {
    if (errorCode(result.error) === 'ETIMEDOUT') {
      fail(`Roster ${options.verb} timed out (${sha256(result.stderr ?? '')})`);
    }
    fail(`Roster ${options.verb} failed (${sha256(result.stderr ?? '')})`);
  }
  if (result.status !== 0) fail(`Roster ${options.verb} failed (${sha256(result.stderr ?? '')})`);
  try {
    return {
      output: JSON.parse(result.stdout) as unknown,
      bundleHash: sha256(after),
    };
  } catch {
    fail(`Roster ${options.verb} returned invalid JSON`);
  }
}

function localContextProjection(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('Roster context output is not an object');
  }
  const record = value as Record<string, unknown>;
  return {
    schema_version: record['schema_version'],
    workspace: record['workspace'],
    target: record['target'],
    request: record['request'],
    agent: record['agent'],
    plan: record['plan'],
    guidelines: record['guidelines'],
    lessons: record['lessons'],
    tool_uses: record['tool_uses'],
    skill_refs: record['skill_refs'],
  };
}

function stateShowProjection(store: ReturnType<typeof openSeededLearningStore>): Readonly<{
  status: ReturnType<typeof store.status>;
  pending_candidate: NonNullable<ReturnType<typeof store.candidate>>;
  reviewed_query: SeededContextQueryEvidence;
}> {
  const pendingCandidate = store.candidate(CANDIDATE_ID);
  if (pendingCandidate === null) fail('pending candidate does not exist');
  const state = store.snapshot();
  if (pendingCandidate.status !== 'existing'
    || state.completed_runs.length !== 1
    || state.candidates.length !== 1
    || canonicalJson(state.candidates[0]) !== canonicalJson(pendingCandidate.record)
    || hashSeededLearningValue(state.candidates[0]) !== pendingCandidate.content_hash) {
    fail('pending candidate projection does not match the bounded state');
  }
  return Object.freeze({
    status: store.status(),
    pending_candidate: pendingCandidate,
    reviewed_query: state.completed_runs[0]!.context_query,
  });
}

function runRoster(options: {
  workspace: string;
  contract: Contract;
  turn: Turn;
  argv: readonly string[];
  requestHash: string;
}): never {
  const verb = options.argv[0];
  const invocation = options.contract.roster.allowed_model_invocations.find((entry) => entry.verb === verb);
  if (invocation === undefined) fail('Roster verb is outside the launch contract');
  const contracted = requireContractedRosterArgv(
    invocation,
    options.contract.roster.target,
    options.argv.slice(1),
  );
  let output: unknown;
  let query: Record<string, unknown> | undefined;
  let rosterBundleHash: string;
  let rawContextHash: string | undefined;
  if (verb === 'discover') {
    if (contracted.derivedQuery !== undefined) fail('Roster discover contract cannot derive a query');
    const result = invokePreparedRoster({
      workspace: options.workspace,
      verb,
      argv: contracted.expected,
    });
    output = result.output;
    rosterBundleHash = result.bundleHash;
  } else if (verb === 'context') {
    const derivedQuery = contracted.derivedQuery;
    if (derivedQuery === undefined) fail('Roster context contract must contain one derived query');
    query = queryProof(derivedQuery, options.requestHash);
    const result = invokePreparedRoster({
      workspace: options.workspace,
      verb,
      argv: contracted.expected,
    });
    const realOutput = result.output;
    rosterBundleHash = result.bundleHash;
    const seededOutput = resolveSeededWorkspaceContext({
      root: options.workspace,
      request: {
        target: options.contract.roster.target,
        query: derivedQuery,
        stepHint: null,
        budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
        explain: false,
      },
      candidates: contextCandidates(options.workspace),
    });
    if (canonicalJson(localContextProjection(realOutput))
      !== canonicalJson(localContextProjection(seededOutput))) {
      fail('prepared Roster context diverged from the seeded local-policy projection');
    }
    output = compactContextForHost(seededOutput);
    rawContextHash = (output as Record<string, unknown>)['raw_context_sha256'] as string;
  } else {
    fail('Roster invocation has no fixture implementation');
  }
  assertModelVisibleJsonCharacterLimit(output, `Roster ${verb} output`);
  appendLog({
    workspace: options.workspace,
    contract: options.contract,
    turn: options.turn,
    command: 'roster',
    category: invocation.log_category,
    flags: options.argv.filter((entry) => entry.startsWith('--')),
    output,
    query,
    rosterProof: {
      argvHash: sha256(canonicalJson(options.argv)),
      contractArgvHash: sha256(canonicalJson([invocation.verb, ...contracted.expected])),
      bundleHash: rosterBundleHash,
      ...(rawContextHash === undefined ? {} : { rawContextHash }),
    },
  });
  emit(output);
}

function runAdapter(options: {
  workspace: string;
  contract: Contract;
  turn: Turn;
  command: string;
  argv: readonly string[];
  requestHash: string;
  challengeHash: string;
  host: string;
  rosterVersion: string;
}): never {
  const definition = options.contract.adapters.find((entry) => entry.command === options.command);
  if (definition === undefined || !definition.allowed_turns.includes(options.turn)) {
    fail('command is not allowed in this turn');
  }
  const parsed = parseArguments(options.argv, definition);
  const storePath = workspacePath({
    root: options.workspace,
    relativePath: options.contract.runtime.state_path,
    label: 'learning state',
    leaf: 'regular-file-or-missing',
  });
  const store = openSeededLearningStore(storePath);
  let output: unknown;
  let query: Record<string, unknown> | undefined;
  let challengeHash: string | undefined;
  switch (options.command) {
    case 'roster-350-fixture-search': {
      const derivedQuery = one(parsed, '--query');
      query = queryProof(derivedQuery, options.requestHash);
      output = projectFixtureSearchForHost(readFixtureSearchInput(options.workspace), options.requestHash);
      break;
    }
    case 'roster-350-fixture-run-record': {
      const selectedResult = one(parsed, '--selected-result');
      requireFixtureSearchResult(readFixtureSearchInput(options.workspace), selectedResult);
      const requestHash = one(parsed, '--request-hash');
      if (!SHA256.test(requestHash) || requestHash !== options.requestHash) fail('request hash is invalid');
      const citations = parsed.values.get('--brain-citation') ?? [];
      const record: SeededCompletedRun = {
        id: RUN_ID,
        target: options.contract.roster.target,
        request_hash: requestHash,
        context_query: persistedContextQueryFromDiscoveryLog(
          options.workspace,
          options.contract,
          requestHash,
        ),
        host: options.host,
        roster_version: options.rosterVersion,
        started_at: FIXTURE_STARTED_AT,
        completed_at: FIXTURE_COMPLETED_AT,
        outcome: 'completed',
        selected_result_id: selectedResult,
        tool_ids: ['social-search'],
        source_ids: [...citations],
        artifact_ids: ['artifact-opportunity-shortlist-001'],
      };
      output = store.recordCompletedRun(record);
      break;
    }
    case 'roster-350-fixture-feedback-record': {
      if (one(parsed, '--run-id') !== RUN_ID || one(parsed, '--signal') !== 'useful') {
        fail('feedback must cite the controlled run with the useful signal');
      }
      const summary = 'The completed observation was marked useful for the requested workflow.';
      const record: SeededFeedback = {
        id: FEEDBACK_ID,
        run_id: RUN_ID,
        signal: 'positive',
        summary,
        summary_hash: hashSeededLearningValue(summary),
      };
      output = store.recordFeedback(record);
      break;
    }
    case 'roster-350-fixture-dream-status':
      output = store.status();
      break;
    case 'roster-350-fixture-candidate-create': {
      if (one(parsed, '--run-id') !== RUN_ID || one(parsed, '--feedback-id') !== FEEDBACK_ID) {
        fail('candidate citations do not match the controlled evidence');
      }
      const skillChallenge = one(parsed, '--skill-challenge');
      challengeHash = sha256(skillChallenge);
      if (challengeHash !== options.challengeHash) fail('Dreamer challenge does not match the attested skill');
      const status = store.status();
      if (status.status !== 'due' || status.watermark === null) fail('candidate creation is not due');
      const meaning = {
        disposition: one(parsed, '--disposition'),
        source_kind: one(parsed, '--source-kind'),
        topic_kind: one(parsed, '--topic-kind'),
        falsifier_action: one(parsed, '--falsifier-action'),
        falsifier_observation: one(parsed, '--falsifier-observation'),
      } as SeededCandidateMeaning;
      const rendered = renderSeededCandidateMeaning(meaning);
      const candidate: SeededLessonCandidate = {
        id: CANDIDATE_ID,
        lesson_id: renderSeededCandidateLessonId(meaning),
        watermark: status.watermark,
        target: options.contract.roster.target,
        meaning,
        recommendation: rendered.recommendation,
        falsifiable_by: rendered.falsifiable_by,
        citations: { run_ids: [RUN_ID], feedback_ids: [FEEDBACK_ID] },
      };
      output = store.createCandidate(candidate);
      break;
    }
    case 'roster-350-fixture-state-show':
      output = stateShowProjection(store);
      break;
    case 'roster-350-fixture-candidate-promote': {
      const candidateId = one(parsed, '--candidate-id');
      const candidateHash = one(parsed, '--candidate-hash');
      if (!SHA256.test(candidateHash)) fail('candidate hash is not a canonical sha256 digest');
      const candidate = store.candidate(candidateId);
      if (candidate === null) fail('candidate does not exist');
      if (candidate.content_hash !== candidateHash) fail('candidate changed after human review');
      const lessonRelativePath = `functions/gtm/agents/social-manager/playbook/${candidate.record.lesson_id}.md`;
      workspacePath({
        root: options.workspace,
        relativePath: lessonRelativePath,
        label: 'lesson path',
        leaf: 'regular-file-or-missing',
      });
      const materialized = materializeSeededLesson({
        store,
        workspaceRoot: options.workspace,
        candidateId,
        expectedCandidateHash: candidateHash,
        lesson: {
          id: candidate.record.lesson_id,
          purpose: 'Preserve an approved discovery qualification lesson.',
          scope: { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
          body: [
            candidate.record.recommendation,
            '',
            `Evidence: ${RUN_ID} and ${FEEDBACK_ID}.`,
            '',
            candidate.record.falsifiable_by,
          ].join('\n'),
        },
      });
      if (materialized.path !== lessonRelativePath) fail('materialized lesson path is outside its contracted scope');
      workspacePath({
        root: options.workspace,
        relativePath: materialized.path,
        label: 'materialized lesson path',
        leaf: 'regular-file',
      });
      output = materialized;
      break;
    }
    default:
      fail('adapter command has no fixture implementation');
  }
  workspacePath({
    root: options.workspace,
    relativePath: options.contract.runtime.state_path,
    label: 'learning state',
    leaf: 'regular-file-or-missing',
  });
  assertModelVisibleJsonCharacterLimit(output, `${options.command} output`);
  appendLog({
    workspace: options.workspace,
    contract: options.contract,
    turn: options.turn,
    command: options.command,
    category: definition.log_category,
    flags: parsed.ordered.map((entry) => entry.flag),
    output,
    query,
    challengeHash,
  });
  emit(output);
}

function main(): never {
  const workspace = realpathSync(process.cwd());
  const contract = readContract(workspace);
  const adapterDirectory = workspacePath({
    root: workspace,
    relativePath: contract.runtime.adapter_directory,
    label: 'adapter directory',
    leaf: 'directory',
  });
  const invokedPath = realpathSync(resolve(process.argv[1] ?? ''));
  if (!inside(adapterDirectory, invokedPath)) fail('invoked adapter escaped the adapter directory');
  workspacePath({
    root: workspace,
    relativePath: relative(workspace, invokedPath),
    label: 'invoked adapter',
    leaf: 'regular-file',
  });
  const invokedName = basename(process.argv[1] ?? '');
  const command = invokedName === 'host-led-learning-adapter.js'
    ? process.argv[2] ?? ''
    : invokedName;
  const argv = invokedName === 'host-led-learning-adapter.js' ? process.argv.slice(3) : process.argv.slice(2);
  const turn = process.env['ROSTER_350_TURN'];
  const host = process.env['ROSTER_350_HOST'];
  const requestHash = process.env['ROSTER_350_REQUEST_SHA256'];
  const challengeHash = process.env['ROSTER_350_DREAMER_CHALLENGE_SHA256'];
  const rosterVersion = process.env['ROSTER_350_ROSTER_VERSION'];
  if ((turn !== 'discover' && turn !== 'approve') || !boundedString(host)
    || !SHA256.test(requestHash ?? '') || !SHA256.test(challengeHash ?? '')
    || !boundedString(rosterVersion)) fail('controlled runtime environment is incomplete');
  if (command === 'roster') {
    return runRoster({ workspace, contract, turn, argv, requestHash: requestHash! });
  }
  return runAdapter({
    workspace,
    contract,
    turn,
    command,
    argv,
    requestHash: requestHash!,
    challengeHash: challengeHash!,
    host: host!,
    rosterVersion: rosterVersion!,
  });
}

if (process.env['ROSTER_350_TURN'] !== undefined
  || (process.argv[1] !== undefined
    && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]))) {
  try {
    main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown adapter failure';
    process.stderr.write(`${detail}\n`);
    process.exit(1);
  }
}
