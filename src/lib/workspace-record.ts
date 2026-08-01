import YAML from 'yaml';
import {
  WORKSPACE_SCHEMA_VERSION,
  assertFunctionRootPath,
  assertNonOverlappingFunctionRoots,
  assertRecordId,
  assertWorkspaceId,
  type WorkspaceScope,
} from './workspace-layout.ts';
import { workspaceFailure } from './workspace-diagnostics.ts';

export const MAX_AUTHORED_YAML_BYTES = 256 * 1024;
export const MAX_AUTHORED_MARKDOWN_BYTES = 512 * 1024;
export const MAX_YAML_NODES = 10_000;
export const MAX_YAML_DEPTH = 32;
export const MAX_YAML_SCALAR_BYTES = 64 * 1024;

export type WorkspaceRegistry = {
  schema_version: 2;
  workspace_id: string;
  brain?: { binding: string };
  functions: Record<string, { path: string }>;
  hosts: Record<string, 'enabled'>;
};

export type FunctionDefinition = {
  schema_version: 2;
  id: string;
  purpose: string;
  agents: string[];
  guidelines: string[];
};

export type AgentDefinition = {
  schema_version: 2;
  id: string;
  function: string;
  purpose: string;
  plans: string[];
  subagents: string[];
  guidelines: string[];
  default_guidelines: string[];
  tool_uses: string[];
  lessons: string[];
};

export type ChildDefinition = {
  schema_version: 2;
  id: string;
  purpose: string;
  agent: string;
  scope?: WorkspaceScope;
  value: Record<string, unknown>;
};

export type MarkdownDefinition = {
  schema_version: 2;
  id: string;
  kind: 'guideline' | 'lesson';
  purpose: string;
  scope: WorkspaceScope;
  body: string;
  value: Record<string, unknown>;
};

type ParsedYaml = {
  document?: YAML.Document;
  value: Record<string, unknown>;
};

type SimpleYamlLine = {
  indent: number;
  content: string;
};

function parseSimpleScalar(source: string): unknown | typeof SIMPLE_YAML_UNSUPPORTED {
  if (source === '[]') return [];
  if (source === '{}') return Object.create(null) as Record<string, unknown>;
  if (source === 'true') return true;
  if (source === 'false') return false;
  if (source === 'null') return null;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(source)) return Number(source);
  if (source.startsWith('"') && source.endsWith('"')) {
    try {
      return JSON.parse(source) as unknown;
    } catch {
      return SIMPLE_YAML_UNSUPPORTED;
    }
  }
  if (/^(?:true|false|null)$/i.test(source)) return SIMPLE_YAML_UNSUPPORTED;
  if (/^[+\-.0-9]/.test(source)) return SIMPLE_YAML_UNSUPPORTED;
  if (/^[A-Za-z0-9][A-Za-z0-9 ./#_-]*$/.test(source)) return source;
  return SIMPLE_YAML_UNSUPPORTED;
}

const SIMPLE_YAML_UNSUPPORTED = Symbol('simple-yaml-unsupported');

function tryParseSimpleYaml(text: string): Record<string, unknown> | undefined {
  if (text.includes('\r') || text.includes('\t') || text.includes('#')) return undefined;
  const sourceLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (sourceLines.length === 0 || sourceLines.some((line) => line.length === 0)) return undefined;
  const lines: SimpleYamlLine[] = [];
  for (const line of sourceLines) {
    const whitespace = line.match(/^ */)![0].length;
    if (whitespace % 2 !== 0) return undefined;
    lines.push({ indent: whitespace, content: line.slice(whitespace) });
  }
  let cursor = 0;
  const parseList = (indent: number): unknown[] | typeof SIMPLE_YAML_UNSUPPORTED => {
    const result: unknown[] = [];
    while (cursor < lines.length && lines[cursor]!.indent === indent) {
      const content = lines[cursor]!.content;
      if (!content.startsWith('- ')) return SIMPLE_YAML_UNSUPPORTED;
      const value = parseSimpleScalar(content.slice(2));
      if (value === SIMPLE_YAML_UNSUPPORTED) return value;
      result.push(value);
      cursor++;
    }
    return result;
  };
  const parseMap = (indent: number): Record<string, unknown> | typeof SIMPLE_YAML_UNSUPPORTED => {
    const result = Object.create(null) as Record<string, unknown>;
    while (cursor < lines.length && lines[cursor]!.indent === indent) {
      const line = lines[cursor]!;
      const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line.content);
      if (match === null || Object.hasOwn(result, match[1]!)) return SIMPLE_YAML_UNSUPPORTED;
      const key = match[1]!;
      const remainder = match[2]!;
      cursor++;
      if (remainder.length > 0) {
        if (!remainder.startsWith(' ')) return SIMPLE_YAML_UNSUPPORTED;
        const value = parseSimpleScalar(remainder.slice(1));
        if (value === SIMPLE_YAML_UNSUPPORTED) return value;
        result[key] = value;
        continue;
      }
      const next = lines[cursor];
      if (next === undefined || next.indent !== indent + 2) return SIMPLE_YAML_UNSUPPORTED;
      const child = next.content.startsWith('- ')
        ? parseList(indent + 2)
        : parseMap(indent + 2);
      if (child === SIMPLE_YAML_UNSUPPORTED) return child;
      result[key] = child;
    }
    return result;
  };
  const parsed = parseMap(0);
  return parsed === SIMPLE_YAML_UNSUPPORTED || cursor !== lines.length ? undefined : parsed;
}

function schemaFailure(path: string, message: string, details: Record<string, string | number> = {}): never {
  throw workspaceFailure('YAML_INVALID', `${path}: ${message}`, 'Fix the authored YAML without changing its registered identity or path.', { path, ...details });
}

function requireObject(value: unknown, path: string, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    schemaFailure(path, `${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string, field: string): string {
  if (typeof value !== 'string') schemaFailure(path, `'${field}' must be a string`);
  return value as string;
}

function requireStringArray(value: unknown, path: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    schemaFailure(path, `'${field}' must be a string array`);
  }
  const ids = (value as string[]).map(assertRecordId);
  const lower = ids.map((id) => id.toLocaleLowerCase('en-US'));
  if (new Set(lower).size !== lower.length) {
    throw workspaceFailure('DUPLICATE_IDENTITY', `${path}: '${field}' contains a duplicate or case-only identity.`, 'Keep each local ID once in its owning registry.', { path, field });
  }
  return ids;
}

function requireSchemaVersion(value: unknown, path: string): 2 {
  if (value !== WORKSPACE_SCHEMA_VERSION) {
    throw workspaceFailure(
      'SCHEMA_VERSION_UNSUPPORTED',
      `${path}: schema_version must be ${WORKSPACE_SCHEMA_VERSION}.`,
      'Migrate the workspace through the explicit Roster migration command.',
      { path, expected: WORKSPACE_SCHEMA_VERSION, actual: typeof value === 'number' ? value : String(value) },
    );
  }
  return WORKSPACE_SCHEMA_VERSION;
}

function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field)).sort();
  if (unknown.length > 0) {
    throw workspaceFailure('UNKNOWN_FIELD', `${path}: unknown field '${unknown[0]}'.`, 'Remove unsupported fields or migrate them through a schema update.', { path, fields: unknown });
  }
}

function validateShapeLimits(value: unknown, path: string): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes++;
    if (nodes > MAX_YAML_NODES) schemaFailure(path, `exceeds the ${MAX_YAML_NODES}-node limit`, { maxNodes: MAX_YAML_NODES });
    if (depth > MAX_YAML_DEPTH) schemaFailure(path, `exceeds the ${MAX_YAML_DEPTH}-level nesting limit`, { maxDepth: MAX_YAML_DEPTH });
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > MAX_YAML_SCALAR_BYTES) {
      schemaFailure(path, `contains a scalar larger than ${MAX_YAML_SCALAR_BYTES} bytes`, { maxScalarBytes: MAX_YAML_SCALAR_BYTES });
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

function parseYaml(
  text: string,
  path: string,
  maxBytes: number = MAX_AUTHORED_YAML_BYTES,
  preserveDocument = false,
): ParsedYaml {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw workspaceFailure('READ_LIMIT_EXCEEDED', `${path}: exceeds the ${maxBytes}-byte YAML limit.`, 'Reduce the authored record before retrying.', { path, maxBytes });
  }
  let raw: unknown;
  let document: YAML.Document | undefined;
  try {
    if (preserveDocument) {
      document = YAML.parseDocument(text, { strict: true, uniqueKeys: true });
      if (document.errors.length > 0) schemaFailure(path, document.errors[0]!.message);
      raw = document.toJS({ maxAliasCount: 0 });
    } else {
      raw = tryParseSimpleYaml(text)
        ?? YAML.parse(text, { strict: true, uniqueKeys: true, maxAliasCount: 0 }) as unknown;
    }
  } catch (error) {
    schemaFailure(path, error instanceof Error ? error.message : String(error));
  }
  validateShapeLimits(raw, path);
  return { ...(document === undefined ? {} : { document }), value: requireObject(raw, path, 'document') };
}

function parseScopeMapping(value: unknown, path: string): WorkspaceScope {
  const scope = requireObject(value, path, 'scope');
  assertKnownFields(scope, ['function', 'agent', 'plan'], path);
  const functionId = assertRecordId(requireString(scope.function, path, 'scope.function'));
  const agentId = scope.agent === undefined ? undefined : assertRecordId(requireString(scope.agent, path, 'scope.agent'));
  const planId = scope.plan === undefined ? undefined : assertRecordId(requireString(scope.plan, path, 'scope.plan'));
  if (planId !== undefined && agentId === undefined) schemaFailure(path, `'scope.plan' requires 'scope.agent'`);
  return {
    function: functionId,
    ...(agentId === undefined ? {} : { agent: agentId }),
    ...(planId === undefined ? {} : { plan: planId }),
  };
}

export function parseWorkspaceRegistry(text: string, path = 'roster.yaml'): WorkspaceRegistry {
  const { value } = parseYaml(text, path);
  assertKnownFields(value, ['schema_version', 'workspace_id', 'brain', 'functions', 'hosts'], path);
  const functionsRaw = requireObject(value.functions, path, 'functions');
  const functions: Record<string, { path: string }> = Object.create(null) as Record<string, { path: string }>;
  const caseFolded = new Set<string>();
  for (const [rawId, rawEntry] of Object.entries(functionsRaw)) {
    const id = assertRecordId(rawId);
    const lower = id.toLocaleLowerCase('en-US');
    if (caseFolded.has(lower)) {
      throw workspaceFailure('DUPLICATE_IDENTITY', `${path}: function '${id}' is duplicated by case.`, 'Keep one canonical lowercase function identity.', { path, id });
    }
    caseFolded.add(lower);
    const entry = requireObject(rawEntry, path, `functions.${id}`);
    assertKnownFields(entry, ['path'], path);
    functions[id] = { path: assertFunctionRootPath(requireString(entry.path, path, `functions.${id}.path`)) };
  }
  assertNonOverlappingFunctionRoots(Object.values(functions).map((entry) => entry.path));

  const hostsRaw = requireObject(value.hosts, path, 'hosts');
  const hosts: Record<string, 'enabled'> = Object.create(null) as Record<string, 'enabled'>;
  for (const [host, state] of Object.entries(hostsRaw)) {
    assertRecordId(host);
    if (state !== 'enabled') schemaFailure(path, `hosts.${host} must equal 'enabled'`);
    hosts[host] = 'enabled';
  }
  let brain: { binding: string } | undefined;
  if (value.brain !== undefined) {
    const rawBrain = requireObject(value.brain, path, 'brain');
    assertKnownFields(rawBrain, ['binding'], path);
    brain = { binding: requireString(rawBrain.binding, path, 'brain.binding') };
  }
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    workspace_id: assertWorkspaceId(requireString(value.workspace_id, path, 'workspace_id')),
    ...(brain === undefined ? {} : { brain }),
    functions,
    hosts,
  };
}

export function parseFunctionDefinition(text: string, path: string): FunctionDefinition {
  const { value } = parseYaml(text, path);
  assertKnownFields(value, ['schema_version', 'id', 'purpose', 'agents', 'guidelines'], path);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertRecordId(requireString(value.id, path, 'id')),
    purpose: requireString(value.purpose, path, 'purpose'),
    agents: requireStringArray(value.agents, path, 'agents'),
    guidelines: requireStringArray(value.guidelines, path, 'guidelines'),
  };
}

export function parseAgentDefinition(text: string, path: string): AgentDefinition {
  const { value } = parseYaml(text, path);
  assertKnownFields(value, [
    'schema_version',
    'id',
    'function',
    'purpose',
    'plans',
    'subagents',
    'guidelines',
    'default_guidelines',
    'tool_uses',
    'lessons',
  ], path);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertRecordId(requireString(value.id, path, 'id')),
    function: assertRecordId(requireString(value.function, path, 'function')),
    purpose: requireString(value.purpose, path, 'purpose'),
    plans: requireStringArray(value.plans, path, 'plans'),
    subagents: requireStringArray(value.subagents, path, 'subagents'),
    guidelines: requireStringArray(value.guidelines, path, 'guidelines'),
    default_guidelines: requireStringArray(value.default_guidelines, path, 'default_guidelines'),
    tool_uses: requireStringArray(value.tool_uses, path, 'tool_uses'),
    lessons: requireStringArray(value.lessons, path, 'lessons'),
  };
}

const CHILD_FIELDS: Readonly<Record<'plan' | 'subagent' | 'tool-use', readonly string[]>> = {
  plan: ['schema_version', 'id', 'agent', 'purpose', 'inputs', 'steps', 'completion'],
  subagent: ['schema_version', 'id', 'agent', 'purpose'],
  'tool-use': [
    'schema_version',
    'id',
    'agent',
    'purpose',
    'scope',
    'skill_ref',
    'why',
    'when',
    'capabilities',
    'how',
    'output_expectations',
    'brain',
    'effects',
    'approval',
  ],
};

export function parseChildDefinition(
  kind: 'plan' | 'subagent' | 'tool-use',
  text: string,
  path: string,
): ChildDefinition {
  const { value } = parseYaml(text, path);
  assertKnownFields(value, CHILD_FIELDS[kind], path);
  const scope = value.scope === undefined ? undefined : parseScopeMapping(value.scope, path);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertRecordId(requireString(value.id, path, 'id')),
    purpose: requireString(value.purpose, path, 'purpose'),
    agent: requireString(value.agent, path, 'agent'),
    ...(scope === undefined ? {} : { scope }),
    value,
  };
}

export function parseMarkdownDefinition(text: string, path: string): MarkdownDefinition {
  if (Buffer.byteLength(text, 'utf8') > MAX_AUTHORED_MARKDOWN_BYTES) {
    throw workspaceFailure('READ_LIMIT_EXCEEDED', `${path}: exceeds the ${MAX_AUTHORED_MARKDOWN_BYTES}-byte Markdown limit.`, 'Reduce the authored record before retrying.', { path, maxBytes: MAX_AUTHORED_MARKDOWN_BYTES });
  }
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) schemaFailure(path, 'Markdown record must begin with YAML frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) schemaFailure(path, 'Markdown frontmatter is not terminated');
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const { value } = parseYaml(yaml, path, 32 * 1024);
  assertKnownFields(value, ['schema_version', 'id', 'kind', 'purpose', 'scope'], path);
  const kind = requireString(value.kind, path, 'kind');
  if (kind !== 'guideline' && kind !== 'lesson') schemaFailure(path, `'kind' must be guideline or lesson`);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertRecordId(requireString(value.id, path, 'id')),
    kind,
    purpose: requireString(value.purpose, path, 'purpose'),
    scope: parseScopeMapping(value.scope, path),
    body,
    value,
  };
}

function stringify(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

export function renderFunctionDefinition(id: string, purpose: string): string {
  return stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    id: assertRecordId(id),
    purpose,
    agents: [],
    guidelines: [],
  });
}

export function renderAgentDefinition(functionId: string, id: string, purpose: string): string {
  return stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    id: assertRecordId(id),
    function: assertRecordId(functionId),
    purpose,
    plans: [],
    subagents: [],
    guidelines: [],
    default_guidelines: [],
    tool_uses: [],
    lessons: [],
  });
}

export function renderChildDefinition(
  kind: 'plan' | 'subagent' | 'tool-use',
  functionId: string,
  agentId: string,
  id: string,
  purpose: string,
  scope?: WorkspaceScope,
): string {
  const agent = `${assertRecordId(functionId)}/${assertRecordId(agentId)}`;
  const localId = assertRecordId(id);
  if (kind === 'plan') {
    return stringify({
      schema_version: WORKSPACE_SCHEMA_VERSION,
      id: localId,
      agent,
      purpose,
      inputs: {},
      steps: [],
      completion: { artifacts: [], criteria: [] },
    });
  }
  if (kind === 'subagent') {
    return stringify({ schema_version: WORKSPACE_SCHEMA_VERSION, id: localId, agent, purpose });
  }
  return stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    id: localId,
    agent,
    purpose,
    scope: scope ?? { function: functionId, agent: agentId },
    skill_ref: '',
    why: purpose,
    when: [],
    capabilities: [],
    how: [],
    output_expectations: {},
    brain: { read: [], write: [] },
    effects: 'read-only',
    approval: 'none',
  });
}

export function renderMarkdownDefinition(
  kind: 'guideline' | 'lesson',
  id: string,
  purpose: string,
  scope: WorkspaceScope,
): string {
  const title = assertRecordId(id).split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
  const frontmatter = stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    id,
    kind,
    purpose,
    scope,
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n# ${title}\n`;
}

export function addYamlMembership(
  text: string,
  path: string,
  field: string,
  id: string,
): string {
  const { document, value } = parseYaml(text, path, MAX_AUTHORED_YAML_BYTES, true);
  const current = requireStringArray(value[field], path, field);
  const localId = assertRecordId(id);
  if (current.includes(localId)) return text;
  const sequence = document!.getIn([field], true);
  if (!YAML.isSeq(sequence)) schemaFailure(path, `'${field}' must remain a YAML sequence`);
  sequence.add(document!.createNode(localId));
  return document!.toString({ lineWidth: 0 });
}

export function addWorkspaceFunction(
  text: string,
  path: string,
  functionId: string,
  functionRoot: string,
): string {
  const parsed = parseWorkspaceRegistry(text, path);
  const id = assertRecordId(functionId);
  if (parsed.functions[id] !== undefined) return text;
  assertNonOverlappingFunctionRoots([...Object.values(parsed.functions).map((entry) => entry.path), functionRoot]);
  const { document } = parseYaml(text, path, MAX_AUTHORED_YAML_BYTES, true);
  document!.setIn(['functions', id], { path: assertFunctionRootPath(functionRoot) });
  return document!.toString({ lineWidth: 0 });
}

export function addWorkspaceHost(
  text: string,
  path: string,
  host: 'claude' | 'codex',
): string {
  const parsed = parseWorkspaceRegistry(text, path);
  if (parsed.hosts[host] === 'enabled') return text;
  const { document } = parseYaml(text, path, MAX_AUTHORED_YAML_BYTES, true);
  document!.setIn(['hosts', host], 'enabled');
  return document!.toString({ lineWidth: 0 });
}
