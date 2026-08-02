import {
  diagnosticFromFailure,
  isWorkspaceFailure,
  workspaceDiagnostic,
  workspaceFailure,
  type JsonValue,
  type WorkspaceDiagnostic,
} from './workspace-diagnostics.ts';
import { isRecordId } from './workspace-layout.ts';
import { parsePlanEnvelope, type PlanEnvelope } from './workspace-record.ts';
import {
  assertCompleteWorkspaceSnapshot,
  resolveToolUse,
  type CompleteWorkspaceSnapshot,
} from './workspace-tool-use.ts';

export const MAX_PLAN_COLLECTION_ITEMS = 256;
export const MAX_PLAN_RETRY_ATTEMPTS = 256;

export type PlanInputDefinition = {
  description: string;
  required: boolean;
  shape?: string;
};

export type PlanBrainSelector = {
  description: string;
  required: boolean;
};

export type PlanArtifactDefinition = {
  description: string;
  shape?: string;
};

export type PlanCapDefinition = {
  maximum: number;
  guidance: string;
};

export type PlanStepContext = {
  brain?: string[];
  guidelines?: string[];
};

export type PlanStepExpected = {
  artifacts: string[];
  output_guidance: string;
};

export type PlanRetryGuidance = {
  max_attempts: number;
  instruction: string;
};

type PlanStepCommon = {
  id: string;
  instruction: string;
  context?: PlanStepContext;
  expected?: PlanStepExpected;
  condition_guidance?: string;
  retry_guidance?: PlanRetryGuidance;
};

export type PlanStep = PlanStepCommon & (
  | { kind: 'reasoning' }
  | { kind: 'subagent'; subagent: string }
  | { kind: 'cross-agent'; agent: string }
  | { kind: 'nested-plan'; plan: string }
  | { kind: 'tool'; tool_use: string }
  | { kind: 'approval'; approval_guidance: string }
  | { kind: 'artifact'; artifact: string }
);

export type PlanCompletion = {
  artifacts: string[];
  output_guidance: string;
  criteria: string[];
};

export type StructuredPlan = {
  schema_version: 2;
  id: string;
  qualified_id: string;
  path: string;
  agent: string;
  purpose: string;
  inputs: Record<string, PlanInputDefinition>;
  brain_selectors: Record<string, PlanBrainSelector>;
  guidelines: string[];
  tool_uses: string[];
  artifacts: Record<string, PlanArtifactDefinition>;
  caps: Record<string, PlanCapDefinition>;
  steps: PlanStep[];
  completion: PlanCompletion;
};

export type PlanWorkspaceRecord = {
  qualified_id: string;
  kind: 'function' | 'agent' | 'plan' | 'subagent' | 'guideline' | 'tool-use' | 'lesson';
  path: string;
  scope: Record<string, string>;
  content?: string;
};

export type StructuredPlanValidationResult = {
  plans: StructuredPlan[];
  selected_plan_ids: string[];
  diagnostics: WorkspaceDiagnostic[];
};

export type ValidatedPlanClosure = {
  readonly root: StructuredPlan;
  readonly definitions: readonly StructuredPlan[];
};

const FORBIDDEN_FIELDS = new Set([
  'args',
  'binding',
  'bindings',
  'code',
  'command',
  'current_step',
  'depends_on',
  'expression',
  'goto',
  'input_from',
  'next',
  'output_from',
  'queue',
  'script',
  'shell',
  'template',
  'transition',
  'when',
  'worker',
  'workers',
]);

const COMMON_STEP_FIELDS = [
  'id',
  'kind',
  'instruction',
  'context',
  'expected',
  'condition_guidance',
  'retry_guidance',
] as const;

function planFailure(
  code: 'PLAN_SCHEMA_INVALID' | 'PLAN_FIELD_FORBIDDEN' | 'PLAN_DRAFT_INCOMPLETE' | 'DUPLICATE_IDENTITY',
  path: string,
  message: string,
  fieldPath: string,
  details: Record<string, JsonValue> = {},
): never {
  throw workspaceFailure(
    code,
    `${path}: ${message}`,
    code === 'PLAN_DRAFT_INCOMPLETE'
      ? 'Author at least one step and actionable completion criteria before validation.'
      : 'Fix the structured plan to match the version 2 authored-plan schema.',
    { path, field_path: fieldPath, ...details },
  );
}

function requireMapping(value: unknown, path: string, fieldPath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a mapping.`, fieldPath);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  fieldPath: string,
): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field)).sort((a, b) => a.localeCompare(b, 'en'));
  if (unknown.length === 0) return;
  const forbidden = unknown.find((field) => FORBIDDEN_FIELDS.has(field));
  const field = forbidden ?? unknown[0]!;
  const fullPath = fieldPath.length === 0 ? field : `${fieldPath}.${field}`;
  if (forbidden !== undefined) {
    planFailure('PLAN_FIELD_FORBIDDEN', path, `field '${fullPath}' introduces runtime or control grammar.`, fullPath, { field });
  }
  planFailure('PLAN_SCHEMA_INVALID', path, `unknown field '${fullPath}'.`, fullPath, { field });
}

function requireString(value: unknown, path: string, fieldPath: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`, fieldPath);
  }
  return value as string;
}

function requireBoolean(value: unknown, path: string, fieldPath: string): boolean {
  if (typeof value !== 'boolean') planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a boolean.`, fieldPath);
  return value as boolean;
}

function requirePositiveSafeInteger(value: unknown, path: string, fieldPath: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (maximum !== undefined && (value as number) > maximum)) {
    const suffix = maximum === undefined ? '' : ` no larger than ${maximum}`;
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a positive safe integer${suffix}.`, fieldPath);
  }
  return value as number;
}

function assertCollectionLimit(length: number, path: string, fieldPath: string): void {
  if (length > MAX_PLAN_COLLECTION_ITEMS) {
    planFailure(
      'PLAN_SCHEMA_INVALID',
      path,
      `'${fieldPath}' exceeds the ${MAX_PLAN_COLLECTION_ITEMS}-item plan limit.`,
      fieldPath,
      { maximum: MAX_PLAN_COLLECTION_ITEMS, actual: length },
    );
  }
}

function requireLocalId(value: unknown, path: string, fieldPath: string): string {
  const id = requireString(value, path, fieldPath);
  if (!isRecordId(id)) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a valid lowercase kebab-case record ID.`, fieldPath, { value: id });
  }
  return id;
}

function requireAgentId(value: unknown, path: string, fieldPath: string): string {
  const id = requireString(value, path, fieldPath);
  const parts = id.split('/');
  if (parts.length !== 2 || parts.some((part) => !isRecordId(part))) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a qualified function/agent identity.`, fieldPath, { reference: id });
  }
  return id;
}

function requirePlanId(value: unknown, path: string, fieldPath: string): string {
  const id = requireString(value, path, fieldPath);
  const [agent, plan, extra] = id.split('#');
  if (extra !== undefined || plan === undefined || !isRecordId(plan) || agent.split('/').length !== 2 || agent.split('/').some((part) => !isRecordId(part))) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a qualified function/agent#plan identity.`, fieldPath, { reference: id });
  }
  return id;
}

function requireGuidelineId(value: unknown, path: string, fieldPath: string): string {
  const id = requireString(value, path, fieldPath);
  const parts = id.split('/');
  const valid = parts.length === 3
    ? isRecordId(parts[0]!) && parts[1] === 'guidelines' && isRecordId(parts[2]!)
    : parts.length === 4
      && isRecordId(parts[0]!)
      && isRecordId(parts[1]!)
      && parts[2] === 'guidelines'
      && isRecordId(parts[3]!);
  if (!valid) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be a qualified guideline identity.`, fieldPath, { reference: id });
  }
  return id;
}

function requireArray(value: unknown, path: string, fieldPath: string): unknown[] {
  if (!Array.isArray(value)) planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}' must be an array.`, fieldPath);
  assertCollectionLimit((value as unknown[]).length, path, fieldPath);
  return value as unknown[];
}

function requireUniqueReferences(
  value: unknown,
  path: string,
  fieldPath: string,
  parse: (entry: unknown, path: string, fieldPath: string) => string,
): string[] {
  const entries = requireArray(value, path, fieldPath).map((entry, index) => parse(entry, path, `${fieldPath}[${index}]`));
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const folded = entries[index]!.toLocaleLowerCase('en-US');
    if (seen.has(folded)) {
      planFailure('DUPLICATE_IDENTITY', path, `'${fieldPath}' contains a duplicate or case-only reference.`, `${fieldPath}[${index}]`);
    }
    seen.add(folded);
  }
  return entries;
}

function parseCatalog<T>(
  value: unknown,
  path: string,
  fieldPath: string,
  parse: (entry: Record<string, unknown>, entryPath: string) => T,
): Record<string, T> {
  const mapping = requireMapping(value, path, fieldPath);
  const entries = Object.entries(mapping);
  assertCollectionLimit(entries.length, path, fieldPath);
  const result = Object.create(null) as Record<string, T>;
  const seen = new Set<string>();
  for (const [rawId, rawValue] of entries) {
    const entryPath = `${fieldPath}.${rawId}`;
    const folded = rawId.toLocaleLowerCase('en-US');
    if (seen.has(folded)) {
      planFailure('DUPLICATE_IDENTITY', path, `'${fieldPath}' contains duplicate or case-only ID '${rawId}'.`, entryPath, { id: rawId });
    }
    seen.add(folded);
    const id = requireLocalId(rawId, path, entryPath);
    result[id] = parse(requireMapping(rawValue, path, entryPath), entryPath);
  }
  return result;
}

function parseInputs(value: unknown, path: string): Record<string, PlanInputDefinition> {
  return parseCatalog(value, path, 'inputs', (entry, entryPath) => {
    assertKnownFields(entry, ['description', 'required', 'shape'], path, entryPath);
    const shape = entry.shape === undefined ? undefined : requireString(entry.shape, path, `${entryPath}.shape`);
    return {
      description: requireString(entry.description, path, `${entryPath}.description`),
      required: requireBoolean(entry.required, path, `${entryPath}.required`),
      ...(shape === undefined ? {} : { shape }),
    };
  });
}

function parseBrainSelectors(value: unknown, path: string): Record<string, PlanBrainSelector> {
  return parseCatalog(value, path, 'brain_selectors', (entry, entryPath) => {
    assertKnownFields(entry, ['description', 'required'], path, entryPath);
    return {
      description: requireString(entry.description, path, `${entryPath}.description`),
      required: requireBoolean(entry.required, path, `${entryPath}.required`),
    };
  });
}

function parseArtifacts(value: unknown, path: string): Record<string, PlanArtifactDefinition> {
  return parseCatalog(value, path, 'artifacts', (entry, entryPath) => {
    assertKnownFields(entry, ['description', 'shape'], path, entryPath);
    const shape = entry.shape === undefined ? undefined : requireString(entry.shape, path, `${entryPath}.shape`);
    return {
      description: requireString(entry.description, path, `${entryPath}.description`),
      ...(shape === undefined ? {} : { shape }),
    };
  });
}

function parseCaps(value: unknown, path: string): Record<string, PlanCapDefinition> {
  return parseCatalog(value, path, 'caps', (entry, entryPath) => {
    assertKnownFields(entry, ['maximum', 'guidance'], path, entryPath);
    return {
      maximum: requirePositiveSafeInteger(entry.maximum, path, `${entryPath}.maximum`),
      guidance: requireString(entry.guidance, path, `${entryPath}.guidance`),
    };
  });
}

function parseContext(value: unknown, path: string, fieldPath: string): PlanStepContext {
  const mapping = requireMapping(value, path, fieldPath);
  assertKnownFields(mapping, ['brain', 'guidelines'], path, fieldPath);
  const brain = mapping.brain === undefined
    ? undefined
    : requireUniqueReferences(mapping.brain, path, `${fieldPath}.brain`, requireLocalId);
  const guidelines = mapping.guidelines === undefined
    ? undefined
    : requireUniqueReferences(mapping.guidelines, path, `${fieldPath}.guidelines`, requireGuidelineId);
  return {
    ...(brain === undefined ? {} : { brain }),
    ...(guidelines === undefined ? {} : { guidelines }),
  };
}

function parseExpected(value: unknown, path: string, fieldPath: string): PlanStepExpected {
  const mapping = requireMapping(value, path, fieldPath);
  assertKnownFields(mapping, ['artifacts', 'output_guidance'], path, fieldPath);
  return {
    artifacts: requireUniqueReferences(mapping.artifacts, path, `${fieldPath}.artifacts`, requireLocalId),
    output_guidance: requireString(mapping.output_guidance, path, `${fieldPath}.output_guidance`),
  };
}

function parseRetry(value: unknown, path: string, fieldPath: string): PlanRetryGuidance {
  const mapping = requireMapping(value, path, fieldPath);
  assertKnownFields(mapping, ['max_attempts', 'instruction'], path, fieldPath);
  return {
    max_attempts: requirePositiveSafeInteger(mapping.max_attempts, path, `${fieldPath}.max_attempts`, MAX_PLAN_RETRY_ATTEMPTS),
    instruction: requireString(mapping.instruction, path, `${fieldPath}.instruction`),
  };
}

function parseStep(value: unknown, path: string, index: number): PlanStep {
  const fieldPath = `steps[${index}]`;
  const mapping = requireMapping(value, path, fieldPath);
  const kind = requireString(mapping.kind, path, `${fieldPath}.kind`);
  const requiredTarget = kind === 'reasoning'
    ? undefined
    : kind === 'subagent'
      ? 'subagent'
      : kind === 'cross-agent'
        ? 'agent'
        : kind === 'nested-plan'
          ? 'plan'
          : kind === 'tool'
            ? 'tool_use'
            : kind === 'approval'
              ? 'approval_guidance'
              : kind === 'artifact'
                ? 'artifact'
                : null;
  if (requiredTarget === null) {
    planFailure('PLAN_SCHEMA_INVALID', path, `'${fieldPath}.kind' is unsupported.`, `${fieldPath}.kind`, { kind });
  }
  assertKnownFields(mapping, [...COMMON_STEP_FIELDS, ...(requiredTarget === undefined ? [] : [requiredTarget])], path, fieldPath);
  const id = requireLocalId(mapping.id, path, `${fieldPath}.id`);
  const instruction = requireString(mapping.instruction, path, `${fieldPath}.instruction`);
  const context = mapping.context === undefined ? undefined : parseContext(mapping.context, path, `${fieldPath}.context`);
  const expected = mapping.expected === undefined ? undefined : parseExpected(mapping.expected, path, `${fieldPath}.expected`);
  const conditionGuidance = mapping.condition_guidance === undefined
    ? undefined
    : requireString(mapping.condition_guidance, path, `${fieldPath}.condition_guidance`);
  const retryGuidance = mapping.retry_guidance === undefined
    ? undefined
    : parseRetry(mapping.retry_guidance, path, `${fieldPath}.retry_guidance`);
  const common = {
    id,
    instruction,
    ...(context === undefined ? {} : { context }),
    ...(expected === undefined ? {} : { expected }),
    ...(conditionGuidance === undefined ? {} : { condition_guidance: conditionGuidance }),
    ...(retryGuidance === undefined ? {} : { retry_guidance: retryGuidance }),
  };
  if (kind === 'reasoning') return { ...common, kind };
  if (kind === 'subagent') return { ...common, kind, subagent: requireLocalId(mapping.subagent, path, `${fieldPath}.subagent`) };
  if (kind === 'cross-agent') return { ...common, kind, agent: requireAgentId(mapping.agent, path, `${fieldPath}.agent`) };
  if (kind === 'nested-plan') return { ...common, kind, plan: requirePlanId(mapping.plan, path, `${fieldPath}.plan`) };
  if (kind === 'tool') return { ...common, kind, tool_use: requireLocalId(mapping.tool_use, path, `${fieldPath}.tool_use`) };
  if (kind === 'approval') return { ...common, kind, approval_guidance: requireString(mapping.approval_guidance, path, `${fieldPath}.approval_guidance`) };
  return { ...common, kind: 'artifact', artifact: requireLocalId(mapping.artifact, path, `${fieldPath}.artifact`) };
}

function parseCompletion(value: unknown, path: string): PlanCompletion {
  const mapping = requireMapping(value, path, 'completion');
  assertKnownFields(mapping, ['artifacts', 'output_guidance', 'criteria'], path, 'completion');
  const criteria = requireArray(mapping.criteria, path, 'completion.criteria')
    .map((entry, index) => requireString(entry, path, `completion.criteria[${index}]`));
  return {
    artifacts: requireUniqueReferences(mapping.artifacts, path, 'completion.artifacts', requireLocalId),
    output_guidance: requireString(mapping.output_guidance, path, 'completion.output_guidance', true),
    criteria,
  };
}

function parseStructuredPlanEnvelope(envelope: PlanEnvelope, path: string): StructuredPlan {
  const value = envelope.value;
  assertKnownFields(value, [
    'schema_version',
    'id',
    'agent',
    'purpose',
    'inputs',
    'brain_selectors',
    'guidelines',
    'tool_uses',
    'artifacts',
    'caps',
    'steps',
    'completion',
  ], path, '');
  const agent = requireAgentId(envelope.agent, path, 'agent');
  const purpose = requireString(envelope.purpose, path, 'purpose');
  const inputs = parseInputs(value.inputs, path);
  const brainSelectors = parseBrainSelectors(value.brain_selectors, path);
  const guidelines = requireUniqueReferences(value.guidelines, path, 'guidelines', requireGuidelineId);
  const toolUses = requireUniqueReferences(value.tool_uses, path, 'tool_uses', requireLocalId);
  const artifacts = parseArtifacts(value.artifacts, path);
  const caps = parseCaps(value.caps, path);
  const rawSteps = requireArray(value.steps, path, 'steps');
  const seenSteps = new Set<string>();
  for (let index = 0; index < rawSteps.length; index++) {
    const mapping = requireMapping(rawSteps[index], path, `steps[${index}]`);
    if (typeof mapping.id !== 'string') continue;
    const folded = mapping.id.toLocaleLowerCase('en-US');
    if (seenSteps.has(folded)) {
      planFailure('DUPLICATE_IDENTITY', path, `steps contains duplicate or case-only ID '${mapping.id}'.`, `steps[${index}].id`, { id: mapping.id });
    }
    seenSteps.add(folded);
  }
  const steps = rawSteps.map((step, index) => parseStep(step, path, index));
  const completion = parseCompletion(value.completion, path);
  const incompleteFields = [
    ...(steps.length === 0 ? ['steps'] : []),
    ...(completion.criteria.length === 0 ? ['completion.criteria'] : []),
    ...(completion.artifacts.length === 0 && completion.output_guidance.trim().length === 0 ? ['completion'] : []),
  ];
  if (incompleteFields.length > 0) {
    planFailure(
      'PLAN_DRAFT_INCOMPLETE',
      path,
      'structured plan is still an incomplete scaffold draft.',
      incompleteFields[0]!,
      { incomplete_fields: incompleteFields },
    );
  }
  return {
    schema_version: 2,
    id: envelope.id,
    qualified_id: `${agent}#${envelope.id}`,
    path,
    agent,
    purpose,
    inputs,
    brain_selectors: brainSelectors,
    guidelines,
    tool_uses: toolUses,
    artifacts,
    caps,
    steps,
    completion,
  };
}

export function parseStructuredPlan(text: string, path: string): StructuredPlan {
  return parseStructuredPlanEnvelope(parsePlanEnvelope(text, path), path);
}

function referenceDiagnostic(
  code: 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_APPLICABLE',
  plan: StructuredPlan,
  fieldPath: string,
  reference: string,
  expectedKind: string,
  stepId?: string,
): WorkspaceDiagnostic {
  return workspaceDiagnostic(code, `${plan.path}: '${reference}' does not resolve to an applicable ${expectedKind}.`, {
    path: plan.path,
    remedy: code === 'REFERENCE_NOT_APPLICABLE'
      ? 'Use a definition whose declared scope applies to this plan.'
      : `Register or declare the referenced ${expectedKind} before validating this plan.`,
    details: {
      source_plan: plan.qualified_id,
      field_path: fieldPath,
      reference,
      expected_kind: expectedKind,
      ...(stepId === undefined ? {} : { step_id: stepId }),
    },
  });
}

type NestedEdge = { from: string; to: string; stepId: string };

function nestedEdges(plan: StructuredPlan): NestedEdge[] {
  return plan.steps
    .filter((step): step is PlanStep & { kind: 'nested-plan'; plan: string } => step.kind === 'nested-plan')
    .map((step) => ({ from: plan.qualified_id, to: step.plan, stepId: step.id }));
}

function selectedClosure(
  roots: readonly string[] | undefined,
  planIds: readonly string[],
  parsed: ReadonlyMap<string, StructuredPlan>,
): Set<string> {
  const registered = new Set(planIds);
  const selected = new Set<string>(roots === undefined ? planIds : roots.filter((root) => registered.has(root)));
  const queue = [...selected].sort((a, b) => a.localeCompare(b, 'en'));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const plan = parsed.get(queue[cursor]!);
    if (plan === undefined) continue;
    for (const edge of nestedEdges(plan).sort((a, b) => a.to.localeCompare(b.to, 'en') || a.stepId.localeCompare(b.stepId, 'en'))) {
      if (registered.has(edge.to) && !selected.has(edge.to)) {
        selected.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return selected;
}

function stronglyConnectedComponents(nodes: readonly string[], adjacency: ReadonlyMap<string, NestedEdge[]>): string[][] {
  const orderedNodes = [...nodes].sort((a, b) => a.localeCompare(b, 'en'));
  const nodeSet = new Set(orderedNodes);
  const neighbors = new Map(orderedNodes.map((node) => [
    node,
    (adjacency.get(node) ?? []).map((edge) => edge.to).filter((target) => nodeSet.has(target)),
  ] as const));
  const reverse = new Map(orderedNodes.map((node) => [node, [] as string[]] as const));
  for (const [node, targets] of neighbors) {
    for (const target of targets) reverse.get(target)!.push(node);
  }
  for (const sources of reverse.values()) sources.sort((a, b) => a.localeCompare(b, 'en'));

  const visited = new Set<string>();
  const finished: string[] = [];
  for (const root of orderedNodes) {
    if (visited.has(root)) continue;
    visited.add(root);
    const frames: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = neighbors.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!visited.has(target)) {
          visited.add(target);
          frames.push({ node: target, next: 0 });
        }
        continue;
      }
      finished.push(frame.node);
      frames.pop();
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let index = finished.length - 1; index >= 0; index--) {
    const root = finished[index]!;
    if (assigned.has(root)) continue;
    assigned.add(root);
    const component: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      const sources = reverse.get(node) ?? [];
      for (let sourceIndex = sources.length - 1; sourceIndex >= 0; sourceIndex--) {
        const source = sources[sourceIndex]!;
        if (!assigned.has(source)) {
          assigned.add(source);
          stack.push(source);
        }
      }
    }
    components.push(component.sort((a, b) => a.localeCompare(b, 'en')));
  }
  return components;
}

function canonicalCycle(component: readonly string[], adjacency: ReadonlyMap<string, NestedEdge[]>): NestedEdge[] {
  const start = component[0]!;
  const members = new Set(component);
  const edgesFor = (node: string): NestedEdge[] => (adjacency.get(node) ?? [])
    .filter((edge) => members.has(edge.to))
    .sort((a, b) => a.to.localeCompare(b.to, 'en') || a.stepId.localeCompare(b.stepId, 'en'));

  const visited = new Set([start]);
  const path: NestedEdge[] = [];
  const frames: Array<{ node: string; edges: NestedEdge[]; next: number }> = [{
    node: start,
    edges: edgesFor(start),
    next: 0,
  }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.next >= frame.edges.length) {
      frames.pop();
      if (frames.length > 0) path.pop();
      continue;
    }
    const edge = frame.edges[frame.next++]!;
    if (edge.to === start) return [...path, edge];
    if (visited.has(edge.to)) continue;
    visited.add(edge.to);
    path.push(edge);
    frames.push({ node: edge.to, edges: edgesFor(edge.to), next: 0 });
  }
  return [];
}

function cycleDiagnostics(
  selected: ReadonlySet<string>,
  parsed: ReadonlyMap<string, StructuredPlan>,
  planRecords: ReadonlySet<string>,
): WorkspaceDiagnostic[] {
  const adjacency = new Map<string, NestedEdge[]>();
  for (const planId of [...selected].sort((a, b) => a.localeCompare(b, 'en'))) {
    const plan = parsed.get(planId);
    if (plan === undefined) continue;
    const hopByTarget = new Map<string, NestedEdge>();
    for (const edge of nestedEdges(plan)) {
      if (!selected.has(edge.to) || !parsed.has(edge.to) || !planRecords.has(edge.to)) continue;
      const prior = hopByTarget.get(edge.to);
      if (prior === undefined || edge.stepId.localeCompare(prior.stepId, 'en') < 0) hopByTarget.set(edge.to, edge);
    }
    adjacency.set(planId, [...hopByTarget.values()].sort((a, b) => a.to.localeCompare(b.to, 'en') || a.stepId.localeCompare(b.stepId, 'en')));
  }
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const component of stronglyConnectedComponents([...adjacency.keys()], adjacency)) {
    const selfEdge = component.length === 1 && (adjacency.get(component[0]!) ?? []).some((edge) => edge.to === component[0]);
    if (component.length === 1 && !selfEdge) continue;
    const edges = canonicalCycle(component, adjacency);
    if (edges.length === 0) continue;
    const source = parsed.get(component[0]!)!;
    const cycle = [component[0]!, ...edges.map((edge) => edge.to)];
    diagnostics.push(workspaceDiagnostic('REFERENCE_CYCLE', `${source.path}: nested plans form a cycle.`, {
      path: source.path,
      remedy: 'Remove at least one nested-plan edge so the authored plan graph is acyclic.',
      details: {
        source_plan: source.qualified_id,
        field_path: 'steps',
        cycle,
        step_ids: edges.map((edge) => edge.stepId),
      },
    }));
  }
  return diagnostics;
}

function validatePlanReferences(
  plan: StructuredPlan,
  catalogs: {
    agents: ReadonlySet<string>;
    plans: ReadonlySet<string>;
    subagents: ReadonlySet<string>;
    guidelines: ReadonlySet<string>;
    toolSnapshot?: CompleteWorkspaceSnapshot;
  },
): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (let index = 0; index < plan.guidelines.length; index++) {
    const reference = plan.guidelines[index]!;
    if (!catalogs.guidelines.has(reference)) {
      diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, `guidelines[${index}]`, reference, 'guideline'));
    }
  }
  const declaredGuidelines = new Set(plan.guidelines);
  const artifacts = new Set(Object.keys(plan.artifacts));
  const selectors = new Set(Object.keys(plan.brain_selectors));
  const checkArtifact = (reference: string, fieldPath: string, stepId?: string): void => {
    if (!artifacts.has(reference)) diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, fieldPath, reference, 'artifact', stepId));
  };
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index]!;
    const stepPath = `steps[${index}]`;
    if (step.kind === 'subagent') {
      const qualified = `${plan.agent}/subagents/${step.subagent}`;
      if (!catalogs.subagents.has(qualified)) diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, `${stepPath}.subagent`, step.subagent, 'subagent', step.id));
    } else if (step.kind === 'cross-agent') {
      if (!catalogs.agents.has(step.agent)) diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, `${stepPath}.agent`, step.agent, 'agent', step.id));
    } else if (step.kind === 'nested-plan') {
      if (!catalogs.plans.has(step.plan)) diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, `${stepPath}.plan`, step.plan, 'plan', step.id));
    } else if (step.kind === 'tool') {
      if (catalogs.toolSnapshot === undefined) {
        diagnostics.push(workspaceDiagnostic(
          'TOOL_USE_SNAPSHOT_INCOMPLETE',
          `${plan.path}: tool-use references require a complete attested workspace snapshot.`,
          {
            path: plan.path,
            remedy: 'Collect the unfiltered full workspace snapshot before validating tool steps.',
            details: {
              source_plan: plan.qualified_id,
              field_path: `${stepPath}.tool_use`,
              reference: step.tool_use,
              step_id: step.id,
            },
          },
        ));
      } else {
        const [functionId, agentId] = plan.agent.split('/');
        try {
          resolveToolUse(catalogs.toolSnapshot, {
            function: functionId!,
            agent: agentId!,
            plan: plan.id,
          }, step.tool_use);
        } catch (error) {
          if (!isWorkspaceFailure(error)) throw error;
          if (error.code === 'REFERENCE_NOT_FOUND' || error.code === 'REFERENCE_NOT_APPLICABLE') {
            diagnostics.push(referenceDiagnostic(error.code, plan, `${stepPath}.tool_use`, step.tool_use, 'tool-use', step.id));
          } else {
            diagnostics.push(workspaceDiagnostic(error.code, error.header.replace(/^roster:\s*/, ''), {
              path: plan.path,
              remedy: error.remedy,
              details: {
                ...error.details,
                source_plan: plan.qualified_id,
                field_path: `${stepPath}.tool_use`,
                reference: step.tool_use,
                step_id: step.id,
              },
            }));
          }
        }
      }
    } else if (step.kind === 'artifact') {
      checkArtifact(step.artifact, `${stepPath}.artifact`, step.id);
    }
    const brainReferences = step.context?.brain ?? [];
    for (let refIndex = 0; refIndex < brainReferences.length; refIndex++) {
      const reference = brainReferences[refIndex]!;
      if (!selectors.has(reference)) diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, `${stepPath}.context.brain[${refIndex}]`, reference, 'Brain selector', step.id));
    }
    const guidelineReferences = step.context?.guidelines ?? [];
    for (let refIndex = 0; refIndex < guidelineReferences.length; refIndex++) {
      const reference = guidelineReferences[refIndex]!;
      if (!catalogs.guidelines.has(reference)) {
        diagnostics.push(referenceDiagnostic('REFERENCE_NOT_FOUND', plan, `${stepPath}.context.guidelines[${refIndex}]`, reference, 'guideline', step.id));
      } else if (!declaredGuidelines.has(reference)) {
        diagnostics.push(referenceDiagnostic('REFERENCE_NOT_APPLICABLE', plan, `${stepPath}.context.guidelines[${refIndex}]`, reference, 'declared guideline', step.id));
      }
    }
    for (let refIndex = 0; refIndex < (step.expected?.artifacts.length ?? 0); refIndex++) {
      checkArtifact(step.expected!.artifacts[refIndex]!, `${stepPath}.expected.artifacts[${refIndex}]`, step.id);
    }
  }
  for (let index = 0; index < plan.completion.artifacts.length; index++) {
    checkArtifact(plan.completion.artifacts[index]!, `completion.artifacts[${index}]`);
  }
  return diagnostics;
}

export function validateStructuredPlans(
  records: readonly PlanWorkspaceRecord[],
  selectedRoots?: readonly string[],
  toolSnapshot?: CompleteWorkspaceSnapshot,
): StructuredPlanValidationResult {
  if (toolSnapshot !== undefined) {
    try {
      assertCompleteWorkspaceSnapshot(toolSnapshot);
    } catch (error) {
      if (!isWorkspaceFailure(error)) throw error;
      return { plans: [], selected_plan_ids: [], diagnostics: [diagnosticFromFailure(error)] };
    }
    if (records !== toolSnapshot.records) {
      return {
        plans: [],
        selected_plan_ids: [],
        diagnostics: [workspaceDiagnostic(
          'TOOL_USE_SNAPSHOT_INCOMPLETE',
          'Structured-plan validation and tool resolution require the same attested record collection.',
          {
            remedy: 'Pass the exact records array from the complete workspace snapshot.',
            details: { requirement: 'snapshot-record-identity' },
          },
        )],
      };
    }
  }
  const validationRecords = toolSnapshot?.records ?? records;
  const planRecords = validationRecords.filter((record) => record.kind === 'plan');
  const parsed = new Map<string, StructuredPlan>();
  const failures = new Map<string, WorkspaceDiagnostic>();
  for (const record of [...planRecords].sort((a, b) => a.qualified_id.localeCompare(b.qualified_id, 'en'))) {
    try {
      if (record.content === undefined) {
        throw workspaceFailure('PLAN_SCHEMA_INVALID', `${record.path}: full plan content is unavailable.`, 'Collect a full workspace snapshot before plan validation.', { path: record.path, field_path: '' });
      }
      const plan = parseStructuredPlan(record.content, record.path);
      if (plan.qualified_id !== record.qualified_id) {
        throw workspaceFailure(
          'IDENTITY_PATH_MISMATCH',
          `${record.path}: embedded identity '${plan.qualified_id}' does not match '${record.qualified_id}'.`,
          'Make the authored plan identity agree with its registered record identity.',
          { path: record.path, expected: record.qualified_id, actual: plan.qualified_id },
        );
      }
      parsed.set(record.qualified_id, plan);
    } catch (error) {
      if (!isWorkspaceFailure(error)) throw error;
      failures.set(record.qualified_id, diagnosticFromFailure(error));
    }
  }
  const planIds = planRecords.map((record) => record.qualified_id).sort((a, b) => a.localeCompare(b, 'en'));
  const selected = selectedClosure(selectedRoots, planIds, parsed);
  const registeredPlans = new Set(planIds);
  const diagnostics = (selectedRoots ?? [])
    .filter((root) => !registeredPlans.has(root))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((root) => workspaceDiagnostic('REFERENCE_NOT_FOUND', `Plan '${root}' is not registered.`, {
      remedy: 'Register the plan before requesting validated content.',
      details: { reference: root, expected_kind: 'plan', field_path: 'selected_roots' },
    }));
  diagnostics.push(...[...selected]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .flatMap((planId) => failures.get(planId) === undefined ? [] : [failures.get(planId)!]));
  const catalogs = {
    agents: new Set(validationRecords.filter((record) => record.kind === 'agent').map((record) => record.qualified_id)),
    plans: new Set(planIds),
    subagents: new Set(validationRecords.filter((record) => record.kind === 'subagent').map((record) => record.qualified_id)),
    guidelines: new Set(validationRecords.filter((record) => record.kind === 'guideline').map((record) => record.qualified_id)),
    ...(toolSnapshot === undefined ? {} : { toolSnapshot }),
  };
  for (const planId of [...selected].sort((a, b) => a.localeCompare(b, 'en'))) {
    const plan = parsed.get(planId);
    if (plan !== undefined) diagnostics.push(...validatePlanReferences(plan, catalogs));
  }
  diagnostics.push(...cycleDiagnostics(selected, parsed, catalogs.plans));
  diagnostics.sort((a, b) => a.code.localeCompare(b.code, 'en')
    || (a.path ?? '').localeCompare(b.path ?? '', 'en')
    || String(a.details['field_path'] ?? '').localeCompare(String(b.details['field_path'] ?? ''), 'en')
    || a.message.localeCompare(b.message, 'en'));
  return {
    plans: [...selected]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .flatMap((planId) => parsed.get(planId) === undefined ? [] : [parsed.get(planId)!]),
    selected_plan_ids: [...selected].sort((a, b) => a.localeCompare(b, 'en')),
    diagnostics,
  };
}

export function resolveValidatedPlan(
  records: readonly PlanWorkspaceRecord[],
  qualifiedId: string,
  toolSnapshot?: CompleteWorkspaceSnapshot,
): StructuredPlan {
  const result = validateStructuredPlans(records, [qualifiedId], toolSnapshot);
  if (result.diagnostics.length > 0) {
    const first = result.diagnostics.find((diagnostic) => diagnostic.details['source_plan'] === qualifiedId)
      ?? result.diagnostics[0]!;
    throw workspaceFailure(first.code, first.message, first.remedy ?? 'Fix the structured plan before retrying.', {
      ...first.details,
      ...(first.path === undefined ? {} : { path: first.path }),
    });
  }
  const plan = result.plans.find((entry) => entry.qualified_id === qualifiedId);
  if (plan === undefined) {
    throw workspaceFailure('REFERENCE_NOT_FOUND', `Plan '${qualifiedId}' is not registered.`, 'Register the plan before requesting validated content.', { reference: qualifiedId, expected_kind: 'plan' });
  }
  return plan;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = left[Symbol.iterator]();
  const rightCodePoints = right[Symbol.iterator]();
  while (true) {
    const leftEntry = leftCodePoints.next();
    const rightEntry = rightCodePoints.next();
    if (leftEntry.done || rightEntry.done) {
      if (leftEntry.done === rightEntry.done) return 0;
      return leftEntry.done ? -1 : 1;
    }
    const difference = leftEntry.value.codePointAt(0)! - rightEntry.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

function comparePlanDiagnostics(left: WorkspaceDiagnostic, right: WorkspaceDiagnostic): number {
  return compareUnicodeCodePoints(left.code, right.code)
    || compareUnicodeCodePoints(left.path ?? '', right.path ?? '')
    || compareUnicodeCodePoints(
      typeof left.details['field_path'] === 'string' ? left.details['field_path'] : '',
      typeof right.details['field_path'] === 'string' ? right.details['field_path'] : '',
    )
    || compareUnicodeCodePoints(left.message, right.message);
}

export function resolveValidatedPlanClosure(
  snapshot: CompleteWorkspaceSnapshot,
  rootId: string,
): ValidatedPlanClosure {
  const result = validateStructuredPlans(snapshot.records, [rootId], snapshot);
  if (result.diagnostics.length > 0) {
    const first = [...result.diagnostics].sort(comparePlanDiagnostics)[0]!;
    throw workspaceFailure(
      first.code,
      first.message,
      first.remedy ?? 'Fix the structured plan closure before retrying.',
      {
        ...first.details,
        ...(first.path === undefined ? {} : { path: first.path }),
      },
    );
  }
  const plans = new Map(result.plans.map((plan) => [plan.qualified_id, plan]));
  const root = plans.get(rootId);
  if (root === undefined) {
    throw workspaceFailure(
      'REFERENCE_NOT_FOUND',
      `Plan '${rootId}' is not registered.`,
      'Register the plan before requesting validated content.',
      { reference: rootId, expected_kind: 'plan' },
    );
  }
  const definitions = Object.freeze([
    root,
    ...result.selected_plan_ids
      .filter((planId) => planId !== rootId)
      .sort(compareUnicodeCodePoints)
      .map((planId) => plans.get(planId)!),
  ]);
  return Object.freeze({ root, definitions });
}
