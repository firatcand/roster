import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { detectAuthoredSecretMaterial } from './authored-secret-detector.ts';
import {
  diagnosticFromFailure,
  isWorkspaceFailure,
  workspaceFailure,
  type JsonValue,
  type WorkspaceDiagnostic,
} from './workspace-diagnostics.ts';
import { isRecordId } from './workspace-layout.ts';
import {
  MAX_AUTHORED_YAML_BYTES,
  MAX_YAML_DEPTH,
  MAX_YAML_NODES,
  MAX_YAML_SCALAR_BYTES,
} from './workspace-record.ts';
import { parseSkillRef, type CanonicalSkillRef } from './vendor-skills/skill-ref.ts';
import type { WorkspaceDiscoveryRecord } from './workspace-registry.ts';
import {
  assertCompleteWorkspaceSnapshot,
  type CompleteWorkspaceSnapshot,
} from './internal/workspace-tool-use-snapshot.ts';

export {
  assertCompleteWorkspaceSnapshot,
  type CompleteWorkspaceSnapshot,
} from './internal/workspace-tool-use-snapshot.ts';

export const MAX_TOOL_USE_COLLECTION_ITEMS = 256;

export const TOOL_USE_EFFECT_CLASSES = [
  'local-read',
  'external-read',
  'local-write',
  'external-write',
  'irreversible-write',
  'brain-read',
  'brain-write',
] as const;

export type ToolUseEffectClass = (typeof TOOL_USE_EFFECT_CLASSES)[number];
export type ToolUseApprovalRequirement = 'none' | 'human';

export type WorkspaceToolUseScope = {
  function?: string;
  agent?: string;
  plan?: string;
};

export type ToolUseContext = WorkspaceToolUseScope;

export type ToolUseOutputExpectations = {
  required?: string[];
  guidance?: string[];
};

export type ToolUseBrainIntent = {
  read?: string[];
  write?: string[];
};

export type ToolUseEffects = {
  allowed?: ToolUseEffectClass[];
};

export type ToolUseApproval = {
  requirement?: ToolUseApprovalRequirement;
  guidance?: string[];
};

export type ToolUseEvidence = {
  required?: string[];
  guidance?: string[];
};

export type WorkspaceToolUseEnvelope = {
  schema_version: 2;
  id: string;
  scope: WorkspaceToolUseScope;
  purpose: string;
  skill_ref?: string;
};

export type WorkspaceToolUseDefinition = WorkspaceToolUseEnvelope & {
  skill_ref: CanonicalSkillRef;
  when?: string[];
  capabilities?: string[];
  filters?: string[];
  rules?: string[];
  how?: string[];
  output_expectations?: ToolUseOutputExpectations;
  brain?: ToolUseBrainIntent;
  effects?: ToolUseEffects;
  approval?: ToolUseApproval;
  evidence?: ToolUseEvidence;
};

export type EffectiveWorkspaceToolUse = {
  schema_version: 2;
  id: string;
  scope: WorkspaceToolUseScope;
  purpose: string;
  skill_ref: CanonicalSkillRef;
  when: string[];
  capabilities: string[];
  filters: string[];
  rules: string[];
  how: string[];
  output_expectations: Required<ToolUseOutputExpectations>;
  brain: Required<ToolUseBrainIntent>;
  approval: Required<ToolUseApproval>;
  evidence: Required<ToolUseEvidence>;
  effects?: { allowed: ToolUseEffectClass[] };
};

export type ToolUseContributor = {
  qualified_id: string;
  path: string;
  scope: WorkspaceToolUseScope;
  content_hash: string;
};

export type ToolUseFieldSource = {
  qualified_id: string;
  path: string;
  entry?: string;
};

export type ToolUseResolution = {
  effective: EffectiveWorkspaceToolUse;
  contributors: ToolUseContributor[];
  field_sources: Record<string, ToolUseFieldSource[]>;
  semantic_hash: string;
  diagnostics: WorkspaceDiagnostic[];
};

export type ToolUseLatticeValidationResult = {
  definitions: WorkspaceToolUseDefinition[];
  resolutions: ToolUseResolution[];
  diagnostics: WorkspaceDiagnostic[];
};

const SNAPSHOT_TOOL_INDEX = new WeakMap<CompleteWorkspaceSnapshot, ReadonlyMap<string, readonly WorkspaceDiscoveryRecord[]>>();
const TOP_LEVEL_FIELDS = [
  'schema_version',
  'id',
  'scope',
  'purpose',
  'skill_ref',
  'when',
  'capabilities',
  'filters',
  'rules',
  'how',
  'output_expectations',
  'brain',
  'effects',
  'approval',
  'evidence',
] as const;
const EFFECT_SET = new Set<string>(TOOL_USE_EFFECT_CLASSES);
const FIELD_PATH_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

function toolUseFailure(
  code: 'TOOL_USE_DRAFT_INCOMPLETE' | 'TOOL_USE_SCHEMA_INVALID',
  path: string,
  message: string,
  fieldPath: string,
  details: Record<string, JsonValue> = {},
): never {
  throw workspaceFailure(
    code,
    `${path}: ${message}`,
    code === 'TOOL_USE_DRAFT_INCOMPLETE'
      ? 'Complete the authored tool-use draft before validating or resolving it.'
      : 'Fix the tool-use definition to match the closed version 2 schema.',
    { path, field_path: fieldPath, ...details },
  );
}

function requireMapping(value: unknown, path: string, fieldPath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' must be a mapping.`, fieldPath);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  fieldPath: string,
): void {
  const unknown = Object.keys(value)
    .filter((field) => !allowed.includes(field))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (unknown.length === 0) return;
  const field = unknown[0]!;
  const fullPath = fieldPath.length === 0 ? field : `${fieldPath}.${field}`;
  throw workspaceFailure(
    'UNKNOWN_FIELD',
    `${path}: unknown field '${fullPath}'.`,
    'Remove provider, runtime, credential, or other fields outside the closed tool-use schema.',
    { path, field_path: fullPath, fields: unknown },
  );
}

function requireString(value: unknown, path: string, fieldPath: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`, fieldPath);
  }
  return value as string;
}

function requireLocalId(value: unknown, path: string, fieldPath: string): string {
  const id = requireString(value, path, fieldPath);
  if (!isRecordId(id)) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' must be a lowercase kebab-case ID.`, fieldPath);
  }
  return id;
}

function requireFieldPath(value: unknown, path: string, fieldPath: string): string {
  const field = requireString(value, path, fieldPath);
  if (Buffer.byteLength(field, 'utf8') > 128 || !FIELD_PATH_PATTERN.test(field)) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' must be a lowercase snake-case or dotted field path.`, fieldPath);
  }
  return field;
}

function requireUniqueList(
  value: unknown,
  path: string,
  fieldPath: string,
  options: {
    allowEmpty: boolean;
    parse?: (entry: unknown, path: string, fieldPath: string) => string;
  },
): string[] {
  if (!Array.isArray(value)) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' must be an array.`, fieldPath);
  }
  const entries = value as unknown[];
  if (entries.length > MAX_TOOL_USE_COLLECTION_ITEMS) {
    toolUseFailure(
      'TOOL_USE_SCHEMA_INVALID',
      path,
      `'${fieldPath}' exceeds the ${MAX_TOOL_USE_COLLECTION_ITEMS}-item limit.`,
      fieldPath,
      { maximum: MAX_TOOL_USE_COLLECTION_ITEMS, actual: entries.length },
    );
  }
  if (!options.allowEmpty && entries.length === 0) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' must not be empty when present.`, fieldPath);
  }
  const parse = options.parse ?? requireString;
  const result = entries.map((entry, index) => parse(entry, path, `${fieldPath}[${index}]`));
  const seen = new Set<string>();
  for (let index = 0; index < result.length; index++) {
    if (seen.has(result[index]!)) {
      toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'${fieldPath}' contains a duplicate entry.`, `${fieldPath}[${index}]`);
    }
    seen.add(result[index]!);
  }
  return result;
}

function validateShapeLimits(value: unknown, path: string): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes++;
    if (nodes > MAX_YAML_NODES) {
      toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `document exceeds the ${MAX_YAML_NODES}-node limit.`, '', { maximum: MAX_YAML_NODES });
    }
    if (depth > MAX_YAML_DEPTH) {
      toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `document exceeds the ${MAX_YAML_DEPTH}-level depth limit.`, '', { maximum: MAX_YAML_DEPTH });
    }
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > MAX_YAML_SCALAR_BYTES) {
      toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `document contains a scalar larger than ${MAX_YAML_SCALAR_BYTES} bytes.`, '', { maximum: MAX_YAML_SCALAR_BYTES });
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        visit(key, depth + 1);
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}

function assertSecretFree(text: string, path: string): void {
  const finding = detectAuthoredSecretMaterial(text)[0];
  if (finding === undefined) return;
  throw workspaceFailure(
    'SECRET_MATERIAL_FORBIDDEN',
    `${path}: authored tool-use content contains forbidden secret material.`,
    'Remove the credential and reference only its non-secret configuration key name.',
    { path, ...finding },
  );
}

function assertDecodedSecretFree(value: unknown, path: string): void {
  const visit = (item: unknown, fieldPath: string): void => {
    if (typeof item === 'string') {
      const finding = detectAuthoredSecretMaterial(item)[0];
      if (finding !== undefined) {
        throw workspaceFailure(
          'SECRET_MATERIAL_FORBIDDEN',
          `${path}: authored tool-use content contains forbidden secret material.`,
          'Remove the credential and reference only its non-secret configuration key name.',
          { path, field_path: fieldPath, ...finding },
        );
      }
      return;
    }
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index], `${fieldPath}[${index}]`);
      return;
    }
    if (item === null || typeof item !== 'object') return;
    let index = 0;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      const keyFinding = detectAuthoredSecretMaterial(key)[0];
      if (keyFinding !== undefined) {
        throw workspaceFailure(
          'SECRET_MATERIAL_FORBIDDEN',
          `${path}: authored tool-use content contains forbidden secret material.`,
          'Remove the credential and reference only its non-secret configuration key name.',
          { path, field_path: `${fieldPath}.<key:${index}>`, ...keyFinding },
        );
      }
      const safeSegment = /^[a-z][a-z0-9_]*$/.test(key) ? key : `<field:${index}>`;
      visit(child, fieldPath === '' ? safeSegment : `${fieldPath}.${safeSegment}`);
      index++;
    }
  };
  visit(value, '');
}

const SIMPLE_SCALAR_UNSUPPORTED = Symbol('simple-scalar-unsupported');

function parseSimpleScalar(value: string): string | number | typeof SIMPLE_SCALAR_UNSUPPORTED {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed : SIMPLE_SCALAR_UNSUPPORTED;
    } catch {
      return SIMPLE_SCALAR_UNSUPPORTED;
    }
  }
  if (value === '2') return 2;
  if (/^(?:true|false|null|~)$/i.test(value) || /^[+\-.0-9]/.test(value)) {
    return SIMPLE_SCALAR_UNSUPPORTED;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/.test(value)) return value;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return value;
  return SIMPLE_SCALAR_UNSUPPORTED;
}

function tryParseMinimalToolUseYaml(text: string): Record<string, unknown> | undefined {
  if (text.includes('\r') || text.includes('\t')) return undefined;
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  if (lines.length < 5
    || lines.some((line) => line.endsWith(' '))
    || lines[0] !== 'schema_version: 2') return undefined;
  const idLine = /^id: (.+)$/.exec(lines[1] ?? '');
  if (idLine === null) return undefined;
  const id = parseSimpleScalar(idLine[1]!);
  if (typeof id !== 'string') return undefined;
  let cursor = 2;
  const scope = Object.create(null) as Record<string, string>;
  if (lines[cursor] === 'scope: {}') {
    cursor++;
  } else if (lines[cursor] === 'scope:') {
    cursor++;
    let scopeFields = 0;
    for (const field of ['function', 'agent', 'plan'] as const) {
      const prefix = `  ${field}: `;
      const line = lines[cursor] ?? '';
      if (!line.startsWith(prefix)) continue;
      const parsed = parseSimpleScalar(line.slice(prefix.length));
      if (typeof parsed !== 'string') return undefined;
      scope[field] = parsed;
      scopeFields++;
      cursor++;
    }
    if (scopeFields === 0) return undefined;
  } else {
    return undefined;
  }
  const purposeLine = /^purpose: (.*)$/.exec(lines[cursor] ?? '');
  const skillLine = /^skill_ref: (.*)$/.exec(lines[cursor + 1] ?? '');
  if (purposeLine === null || skillLine === null || cursor + 2 !== lines.length) return undefined;
  const purpose = parseSimpleScalar(purposeLine[1]!);
  const skillRef = parseSimpleScalar(skillLine[1]!);
  if (typeof purpose !== 'string' || typeof skillRef !== 'string') return undefined;
  return {
    schema_version: 2,
    id,
    scope,
    purpose,
    skill_ref: skillRef,
  };
}

function parseYaml(text: string, path: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_AUTHORED_YAML_BYTES) {
    throw workspaceFailure(
      'READ_LIMIT_EXCEEDED',
      `${path}: exceeds the ${MAX_AUTHORED_YAML_BYTES}-byte YAML limit.`,
      'Reduce the authored tool-use definition before retrying.',
      { path, maxBytes: MAX_AUTHORED_YAML_BYTES },
    );
  }
  assertSecretFree(text, path);
  let raw: unknown = tryParseMinimalToolUseYaml(text);
  if (raw === undefined) {
    try {
      const document = YAML.parseDocument(text, { strict: true, uniqueKeys: true });
      if (document.errors.length > 0) throw document.errors[0];
      if (document.warnings.length > 0) throw document.warnings[0];
      raw = document.toJS({ maxAliasCount: 0 });
    } catch {
      throw workspaceFailure(
        'YAML_INVALID',
        `${path}: authored tool-use YAML is invalid.`,
        'Fix duplicate keys, aliases, tags, or malformed YAML before retrying.',
        { path },
      );
    }
  }
  validateShapeLimits(raw, path);
  if (text.includes('\\')) assertDecodedSecretFree(raw, path);
  return requireMapping(raw, path, 'document');
}

function parseScope(value: unknown, path: string): WorkspaceToolUseScope {
  const scope = requireMapping(value, path, 'scope');
  assertKnownFields(scope, ['function', 'agent', 'plan'], path, 'scope');
  const functionId = scope.function === undefined ? undefined : requireLocalId(scope.function, path, 'scope.function');
  const agentId = scope.agent === undefined ? undefined : requireLocalId(scope.agent, path, 'scope.agent');
  const planId = scope.plan === undefined ? undefined : requireLocalId(scope.plan, path, 'scope.plan');
  if (agentId !== undefined && functionId === undefined) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'scope.agent' requires 'scope.function'.`, 'scope.agent');
  }
  if (planId !== undefined && agentId === undefined) {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'scope.plan' requires 'scope.agent'.`, 'scope.plan');
  }
  return {
    ...(functionId === undefined ? {} : { function: functionId }),
    ...(agentId === undefined ? {} : { agent: agentId }),
    ...(planId === undefined ? {} : { plan: planId }),
  };
}

function parseEnvelopeValue(value: Record<string, unknown>, path: string): WorkspaceToolUseEnvelope {
  if (value.schema_version !== 2) {
    throw workspaceFailure(
      'SCHEMA_VERSION_UNSUPPORTED',
      `${path}: schema_version must be 2.`,
      'Migrate the workspace through the explicit Roster migration command.',
      { path, expected: 2, actual_type: typeof value.schema_version },
    );
  }
  const skillRef = typeof value.skill_ref === 'string' ? value.skill_ref : undefined;
  return {
    schema_version: 2,
    id: requireLocalId(value.id, path, 'id'),
    scope: parseScope(value.scope, path),
    purpose: requireString(value.purpose, path, 'purpose', true),
    ...(skillRef === undefined ? {} : { skill_ref: skillRef }),
  };
}

export function parseWorkspaceToolUseEnvelope(text: string, path: string): WorkspaceToolUseEnvelope {
  return parseEnvelopeValue(parseYaml(text, path), path);
}

function parseOutputExpectations(value: unknown, path: string): ToolUseOutputExpectations {
  const mapping = requireMapping(value, path, 'output_expectations');
  assertKnownFields(mapping, ['required', 'guidance'], path, 'output_expectations');
  return {
    ...(mapping.required === undefined ? {} : {
      required: requireUniqueList(mapping.required, path, 'output_expectations.required', { allowEmpty: true, parse: requireFieldPath }),
    }),
    ...(mapping.guidance === undefined ? {} : {
      guidance: requireUniqueList(mapping.guidance, path, 'output_expectations.guidance', { allowEmpty: true }),
    }),
  };
}

function parseBrain(value: unknown, path: string): ToolUseBrainIntent {
  const mapping = requireMapping(value, path, 'brain');
  assertKnownFields(mapping, ['read', 'write'], path, 'brain');
  return {
    ...(mapping.read === undefined ? {} : {
      read: requireUniqueList(mapping.read, path, 'brain.read', { allowEmpty: true, parse: requireLocalId }),
    }),
    ...(mapping.write === undefined ? {} : {
      write: requireUniqueList(mapping.write, path, 'brain.write', { allowEmpty: true, parse: requireLocalId }),
    }),
  };
}

function parseEffects(value: unknown, path: string): ToolUseEffects {
  const mapping = requireMapping(value, path, 'effects');
  assertKnownFields(mapping, ['allowed'], path, 'effects');
  if (mapping.allowed === undefined) return {};
  const allowed = requireUniqueList(mapping.allowed, path, 'effects.allowed', { allowEmpty: true });
  for (let index = 0; index < allowed.length; index++) {
    if (!EFFECT_SET.has(allowed[index]!)) {
      toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'effects.allowed[${index}]' is not a recognized effect class.`, `effects.allowed[${index}]`);
    }
  }
  return { allowed: allowed as ToolUseEffectClass[] };
}

function parseApproval(value: unknown, path: string): ToolUseApproval {
  const mapping = requireMapping(value, path, 'approval');
  assertKnownFields(mapping, ['requirement', 'guidance'], path, 'approval');
  const requirement = mapping.requirement;
  if (requirement !== undefined && requirement !== 'none' && requirement !== 'human') {
    toolUseFailure('TOOL_USE_SCHEMA_INVALID', path, `'approval.requirement' must be 'none' or 'human'.`, 'approval.requirement');
  }
  return {
    ...(requirement === undefined ? {} : { requirement }),
    ...(mapping.guidance === undefined ? {} : {
      guidance: requireUniqueList(mapping.guidance, path, 'approval.guidance', { allowEmpty: true }),
    }),
  };
}

function parseEvidence(value: unknown, path: string): ToolUseEvidence {
  const mapping = requireMapping(value, path, 'evidence');
  assertKnownFields(mapping, ['required', 'guidance'], path, 'evidence');
  return {
    ...(mapping.required === undefined ? {} : {
      required: requireUniqueList(mapping.required, path, 'evidence.required', { allowEmpty: true, parse: requireFieldPath }),
    }),
    ...(mapping.guidance === undefined ? {} : {
      guidance: requireUniqueList(mapping.guidance, path, 'evidence.guidance', { allowEmpty: true }),
    }),
  };
}

export function parseWorkspaceToolUseDefinition(text: string, path: string): WorkspaceToolUseDefinition {
  const value = parseYaml(text, path);
  assertKnownFields(value, TOP_LEVEL_FIELDS, path, '');
  const envelope = parseEnvelopeValue(value, path);
  if (value.skill_ref === undefined) {
    throw workspaceFailure(
      'SKILL_REF_MISSING',
      `${path}: required skill_ref is missing.`,
      'Add one canonical package:skill identity.',
      { path, field_path: 'skill_ref' },
    );
  }
  const incompleteFields = [
    ...(value.skill_ref === '' ? ['skill_ref'] : []),
    ...(envelope.purpose.trim().length === 0 ? ['purpose'] : []),
  ];
  if (incompleteFields.length > 0) {
    toolUseFailure(
      'TOOL_USE_DRAFT_INCOMPLETE',
      path,
      'tool-use definition is still an incomplete scaffold draft.',
      incompleteFields[0]!,
      { incomplete_fields: incompleteFields },
    );
  }
  const skillRef = parseSkillRef(value.skill_ref, { path });
  const topList = (field: 'when' | 'capabilities' | 'filters' | 'rules' | 'how'): string[] | undefined => {
    if (value[field] === undefined) return undefined;
    return requireUniqueList(value[field], path, field, {
      allowEmpty: false,
      ...(field === 'capabilities' ? { parse: requireLocalId } : {}),
    });
  };
  const when = topList('when');
  const capabilities = topList('capabilities');
  const filters = topList('filters');
  const rules = topList('rules');
  const how = topList('how');
  return {
    ...envelope,
    skill_ref: skillRef,
    ...(when === undefined ? {} : { when }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(filters === undefined ? {} : { filters }),
    ...(rules === undefined ? {} : { rules }),
    ...(how === undefined ? {} : { how }),
    ...(value.output_expectations === undefined ? {} : { output_expectations: parseOutputExpectations(value.output_expectations, path) }),
    ...(value.brain === undefined ? {} : { brain: parseBrain(value.brain, path) }),
    ...(value.effects === undefined ? {} : { effects: parseEffects(value.effects, path) }),
    ...(value.approval === undefined ? {} : { approval: parseApproval(value.approval, path) }),
    ...(value.evidence === undefined ? {} : { evidence: parseEvidence(value.evidence, path) }),
  };
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) freezeValue(entry);
    Object.freeze(value);
  }
  return value;
}

function assertContext(context: ToolUseContext): void {
  const unknown = Object.keys(context).filter((field) => !['function', 'agent', 'plan'].includes(field));
  if (unknown.length > 0
    || (context.function !== undefined && !isRecordId(context.function))
    || (context.agent !== undefined && !isRecordId(context.agent))
    || (context.plan !== undefined && !isRecordId(context.plan))
    || (context.agent !== undefined && context.function === undefined)
    || (context.plan !== undefined && context.agent === undefined)) {
    throw workspaceFailure(
      'IDENTITY_INVALID',
      'Tool-use resolver context is not a valid workspace/function/agent/plan ancestry.',
      'Pass {}, {function}, {function, agent}, or {function, agent, plan} with lowercase kebab-case IDs.',
      { fields: Object.keys(context).sort() },
    );
  }
}

function scopeKey(scope: WorkspaceToolUseScope): string {
  return `${scope.function ?? ''}\u0000${scope.agent ?? ''}\u0000${scope.plan ?? ''}`;
}

function scopeEquals(a: WorkspaceToolUseScope, b: WorkspaceToolUseScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

function ancestry(context: ToolUseContext): WorkspaceToolUseScope[] {
  return [
    {},
    ...(context.function === undefined ? [] : [{ function: context.function }]),
    ...(context.agent === undefined ? [] : [{ function: context.function!, agent: context.agent }]),
    ...(context.plan === undefined ? [] : [{ function: context.function!, agent: context.agent!, plan: context.plan }]),
  ];
}

function localIdFromRecord(record: WorkspaceDiscoveryRecord): string | undefined {
  const marker = '/tools/';
  const index = record.qualified_id.lastIndexOf(marker);
  if (index >= 0) return record.qualified_id.slice(index + marker.length);
  return record.qualified_id.startsWith('tools/') ? record.qualified_id.slice('tools/'.length) : undefined;
}

function toolIndexForSnapshot(
  snapshot: CompleteWorkspaceSnapshot,
): ReadonlyMap<string, readonly WorkspaceDiscoveryRecord[]> {
  const existing = SNAPSHOT_TOOL_INDEX.get(snapshot);
  if (existing !== undefined) return existing;
  const index = new Map<string, WorkspaceDiscoveryRecord[]>();
  for (const record of snapshot.records) {
    if (record.kind !== 'tool-use') continue;
    const id = localIdFromRecord(record);
    if (id === undefined) continue;
    const entries = index.get(id) ?? [];
    entries.push(record);
    index.set(id, entries);
  }
  for (const entries of index.values()) Object.freeze(entries);
  SNAPSHOT_TOOL_INDEX.set(snapshot, index);
  return index;
}

function expectedQualifiedId(scope: WorkspaceToolUseScope, id: string): string {
  if (scope.function === undefined) return `tools/${id}`;
  if (scope.agent === undefined) return `${scope.function}/tools/${id}`;
  if (scope.plan === undefined) return `${scope.function}/${scope.agent}/tools/${id}`;
  return `${scope.function}/${scope.agent}#${scope.plan}/tools/${id}`;
}

function assertRecordIdentity(record: WorkspaceDiscoveryRecord, definition: WorkspaceToolUseDefinition): void {
  const recordScope = record.scope as WorkspaceToolUseScope;
  const expected = expectedQualifiedId(recordScope, definition.id);
  if (!scopeEquals(recordScope, definition.scope)
    || record.qualified_id !== expected
    || record.schema_version !== definition.schema_version) {
    throw workspaceFailure(
      'IDENTITY_PATH_MISMATCH',
      `${record.path}: embedded tool-use identity does not match its registered owner.`,
      'Make id and scope exactly match the registered physical owner.',
      { path: record.path, expected_qualified_id: expected, actual_qualified_id: record.qualified_id },
    );
  }
}

function contributor(record: WorkspaceDiscoveryRecord): ToolUseContributor {
  return {
    qualified_id: record.qualified_id,
    path: record.path,
    scope: { ...record.scope },
    content_hash: record.content_hash,
  };
}

function fieldSource(record: WorkspaceDiscoveryRecord, entry?: string): ToolUseFieldSource {
  return {
    qualified_id: record.qualified_id,
    path: record.path,
    ...(entry === undefined ? {} : { entry }),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function semanticHash(effective: EffectiveWorkspaceToolUse): string {
  return `sha256:${createHash('sha256').update(canonicalJson(effective)).digest('hex')}`;
}

function policyRelaxation(
  fieldPath: string,
  ancestor: WorkspaceDiscoveryRecord,
  descendant: WorkspaceDiscoveryRecord,
  details: Record<string, JsonValue> = {},
): never {
  throw workspaceFailure(
    'TOOL_USE_POLICY_RELAXATION',
    `${descendant.path}: narrower tool-use policy relaxes '${fieldPath}' from '${ancestor.path}'.`,
    'Keep narrower effects within the inherited ceiling and approval requirements at least as strict.',
    {
      path: descendant.path,
      field_path: fieldPath,
      ancestor_path: ancestor.path,
      descendant_path: descendant.path,
      ...details,
    },
  );
}

function lastBrainSource(
  layers: Array<{ record: WorkspaceDiscoveryRecord; definition: WorkspaceToolUseDefinition }>,
  operation: 'read' | 'write',
): WorkspaceDiscoveryRecord {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    if ((layer.definition.brain?.[operation]?.length ?? 0) > 0) return layer.record;
  }
  return layers[0]!.record;
}

function brainEffectCouplingFailure(
  layers: Array<{ record: WorkspaceDiscoveryRecord; definition: WorkspaceToolUseDefinition }>,
  fieldPath: 'brain.read' | 'brain.write',
  source: WorkspaceDiscoveryRecord,
  effectsRecord: WorkspaceDiscoveryRecord | undefined,
  requiredEffect: 'brain-read' | 'brain-write',
): never {
  if (effectsRecord === undefined) {
    throw workspaceFailure(
      'TOOL_USE_POLICY_RELAXATION',
      `${source.path}: '${fieldPath}' requires '${requiredEffect}' in effects.allowed.`,
      `Declare '${requiredEffect}' in the applicable effects.allowed policy or remove the Brain intent.`,
      {
        path: source.path,
        field_path: fieldPath,
        descendant_path: source.path,
        required_effect: requiredEffect,
      },
    );
  }
  const sourceIndex = layers.findIndex((layer) => layer.record === source);
  const effectsIndex = layers.findIndex((layer) => layer.record === effectsRecord);
  const ancestor = sourceIndex <= effectsIndex ? source : effectsRecord;
  const descendant = sourceIndex <= effectsIndex ? effectsRecord : source;
  policyRelaxation(fieldPath, ancestor, descendant, { required_effect: requiredEffect });
}

function compose(
  context: ToolUseContext,
  localId: string,
  layers: Array<{ record: WorkspaceDiscoveryRecord; definition: WorkspaceToolUseDefinition }>,
): ToolUseResolution {
  const first = layers[0]!;
  let purpose = first.definition.purpose;
  const skillRef = first.definition.skill_ref;
  let effects: ToolUseEffectClass[] | undefined;
  let effectsRecord: WorkspaceDiscoveryRecord | undefined;
  let approvalRequirement: ToolUseApprovalRequirement = 'none';
  let approvalRecord: WorkspaceDiscoveryRecord | undefined;
  const fieldSources: Record<string, ToolUseFieldSource[]> = Object.create(null) as Record<string, ToolUseFieldSource[]>;
  const additive: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const additiveFields = [
    'when',
    'capabilities',
    'filters',
    'rules',
    'how',
    'output_expectations.required',
    'output_expectations.guidance',
    'brain.read',
    'brain.write',
    'approval.guidance',
    'evidence.required',
    'evidence.guidance',
  ] as const;
  for (const field of additiveFields) additive[field] = [];
  const add = (field: typeof additiveFields[number], values: readonly string[] | undefined, record: WorkspaceDiscoveryRecord): void => {
    if (values === undefined) return;
    fieldSources[field] ??= [];
    for (const entry of values) {
      fieldSources[field]!.push(fieldSource(record, entry));
      if (!additive[field]!.includes(entry)) additive[field]!.push(entry);
    }
  };
  for (const layer of layers) {
    const { definition, record } = layer;
    if (definition.skill_ref !== skillRef) {
      throw workspaceFailure(
        'SKILL_REF_CONFLICT',
        `${record.path}: applicable tool-use layers declare conflicting canonical skill refs.`,
        'Use one identical package:skill reference throughout an ancestry.',
        { path: record.path, ancestor_path: first.record.path, descendant_path: record.path, field_path: 'skill_ref' },
      );
    }
    purpose = definition.purpose;
    fieldSources.purpose = [fieldSource(record)];
    fieldSources.skill_ref ??= [];
    fieldSources.skill_ref.push(fieldSource(record));
    add('when', definition.when, record);
    add('capabilities', definition.capabilities, record);
    add('filters', definition.filters, record);
    add('rules', definition.rules, record);
    add('how', definition.how, record);
    add('output_expectations.required', definition.output_expectations?.required, record);
    add('output_expectations.guidance', definition.output_expectations?.guidance, record);
    add('brain.read', definition.brain?.read, record);
    add('brain.write', definition.brain?.write, record);
    add('approval.guidance', definition.approval?.guidance, record);
    add('evidence.required', definition.evidence?.required, record);
    add('evidence.guidance', definition.evidence?.guidance, record);
    const authoredEffects = definition.effects?.allowed;
    if (authoredEffects !== undefined) {
      const declaredEffects = [...authoredEffects].sort((left, right) => (
        TOOL_USE_EFFECT_CLASSES.indexOf(left) - TOOL_USE_EFFECT_CLASSES.indexOf(right)
      ));
      if (effects !== undefined) {
        const added = declaredEffects.filter((effect) => !effects!.includes(effect));
        if (added.length > 0) policyRelaxation('effects.allowed', effectsRecord!, record, { added_effects: added });
      }
      effects = [...declaredEffects];
      effectsRecord = record;
      fieldSources['effects.allowed'] = declaredEffects.map((entry) => fieldSource(record, entry));
    }
    const declaredApproval = definition.approval?.requirement;
    if (declaredApproval !== undefined) {
      if (approvalRequirement === 'human' && declaredApproval === 'none') {
        policyRelaxation('approval.requirement', approvalRecord!, record);
      }
      approvalRequirement = declaredApproval;
      approvalRecord = record;
      fieldSources['approval.requirement'] = [fieldSource(record)];
    }
  }
  const brainRead = additive['brain.read']!;
  const brainWrite = additive['brain.write']!;
  if (brainRead.length > 0 && !effects?.includes('brain-read')) {
    const source = lastBrainSource(layers, 'read');
    brainEffectCouplingFailure(layers, 'brain.read', source, effectsRecord, 'brain-read');
  }
  if (brainWrite.length > 0 && !effects?.includes('brain-write')) {
    const source = lastBrainSource(layers, 'write');
    brainEffectCouplingFailure(layers, 'brain.write', source, effectsRecord, 'brain-write');
  }
  const effective: EffectiveWorkspaceToolUse = {
    schema_version: 2,
    id: localId,
    scope: { ...context },
    purpose,
    skill_ref: skillRef,
    when: additive.when!,
    capabilities: additive.capabilities!,
    filters: additive.filters!,
    rules: additive.rules!,
    how: additive.how!,
    output_expectations: {
      required: additive['output_expectations.required']!,
      guidance: additive['output_expectations.guidance']!,
    },
    brain: { read: brainRead, write: brainWrite },
    approval: { requirement: approvalRequirement, guidance: additive['approval.guidance']! },
    evidence: {
      required: additive['evidence.required']!,
      guidance: additive['evidence.guidance']!,
    },
    ...(effects === undefined ? {} : { effects: { allowed: effects } }),
  };
  return freezeValue({
    effective,
    contributors: layers.map((layer) => contributor(layer.record)),
    field_sources: fieldSources,
    semantic_hash: semanticHash(effective),
    diagnostics: [],
  });
}

export function resolveToolUse(
  snapshot: CompleteWorkspaceSnapshot,
  context: ToolUseContext,
  localId: string,
): ToolUseResolution {
  assertCompleteWorkspaceSnapshot(snapshot);
  assertContext(context);
  if (!isRecordId(localId)) {
    throw workspaceFailure('IDENTITY_INVALID', 'Tool-use local ID is invalid.', 'Pass a lowercase kebab-case local ID.', { field: 'local_id' });
  }
  const sameId = toolIndexForSnapshot(snapshot).get(localId) ?? [];
  const scopes = ancestry(context);
  const layers: Array<{ record: WorkspaceDiscoveryRecord; definition: WorkspaceToolUseDefinition }> = [];
  for (const scope of scopes) {
    const matches = sameId.filter((record) => scopeEquals(record.scope, scope));
    if (matches.length > 1) {
      throw workspaceFailure(
        'TOOL_USE_PRECEDENCE_AMBIGUOUS',
        `Tool-use '${localId}' has more than one definition at the same applicable scope.`,
        'Keep one registered definition for each local ID and owner scope.',
        { local_id: localId, scope: { ...scope }, paths: matches.map((record) => record.path).sort() },
      );
    }
    const record = matches[0];
    if (record === undefined) continue;
    const definition = parseWorkspaceToolUseDefinition(record.content!, record.path);
    assertRecordIdentity(record, definition);
    layers.push({ record, definition });
  }
  if (layers.length === 0) {
    const code = sameId.length === 0 ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_NOT_APPLICABLE';
    throw workspaceFailure(
      code,
      `Tool-use '${localId}' does not resolve in the requested ancestry.`,
      code === 'REFERENCE_NOT_FOUND'
        ? 'Register the referenced tool-use before resolving it.'
        : 'Use a tool-use definition owned by the workspace or an ancestor of the requested context.',
      { reference: localId, expected_kind: 'tool-use', context: { ...context } },
    );
  }
  return compose(context, localId, layers);
}

function diagnosticKey(diagnostic: WorkspaceDiagnostic): string {
  return canonicalJson({
    code: diagnostic.code,
    path: diagnostic.path ?? '',
    message: diagnostic.message,
    details: diagnostic.details,
  });
}

function sortDiagnostics(diagnostics: WorkspaceDiagnostic[]): void {
  diagnostics.sort((a, b) => a.code.localeCompare(b.code, 'en')
    || (a.path ?? '').localeCompare(b.path ?? '', 'en')
    || String(a.details.field_path ?? '').localeCompare(String(b.details.field_path ?? ''), 'en')
    || a.message.localeCompare(b.message, 'en'));
}

export function validateToolUseLattice(snapshot: CompleteWorkspaceSnapshot): ToolUseLatticeValidationResult {
  assertCompleteWorkspaceSnapshot(snapshot);
  const records = snapshot.records
    .filter((record) => record.kind === 'tool-use')
    .sort((a, b) => a.qualified_id.localeCompare(b.qualified_id, 'en') || a.path.localeCompare(b.path, 'en'));
  const definitions: WorkspaceToolUseDefinition[] = [];
  const diagnostics: WorkspaceDiagnostic[] = [];
  const contexts = new Map<string, { context: ToolUseContext; id: string }>();
  for (const record of records) {
    try {
      const definition = parseWorkspaceToolUseDefinition(record.content!, record.path);
      assertRecordIdentity(record, definition);
      definitions.push(definition);
      contexts.set(`${scopeKey(definition.scope)}\u0000${definition.id}`, { context: definition.scope, id: definition.id });
    } catch (error) {
      if (!isWorkspaceFailure(error)) throw error;
      diagnostics.push(diagnosticFromFailure(error));
    }
  }
  const resolutions: ToolUseResolution[] = [];
  for (const entry of [...contexts.values()].sort((a, b) => scopeKey(a.context).localeCompare(scopeKey(b.context), 'en') || a.id.localeCompare(b.id, 'en'))) {
    try {
      resolutions.push(resolveToolUse(snapshot, entry.context, entry.id));
    } catch (error) {
      if (!isWorkspaceFailure(error)) throw error;
      diagnostics.push(diagnosticFromFailure(error));
    }
  }
  const uniqueDiagnostics = [...new Map(diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])).values()];
  sortDiagnostics(uniqueDiagnostics);
  definitions.sort((a, b) => scopeKey(a.scope).localeCompare(scopeKey(b.scope), 'en') || a.id.localeCompare(b.id, 'en'));
  resolutions.sort((a, b) => scopeKey(a.effective.scope).localeCompare(scopeKey(b.effective.scope), 'en') || a.effective.id.localeCompare(b.effective.id, 'en'));
  return { definitions, resolutions, diagnostics: uniqueDiagnostics };
}
