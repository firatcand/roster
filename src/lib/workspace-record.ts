import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { detectAuthoredSecretMaterial } from './authored-secret-detector.ts';
import { isNonGlobalIpLiteral } from './network-address.ts';
import {
  WORKSPACE_SCHEMA_VERSION,
  assertFunctionId,
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
  brain?: WorkspaceBrainConfig;
  functions: Record<string, { path: string }>;
  hosts: Record<string, 'enabled'>;
  tool_uses: string[];
};

const BRAIN_NAMESPACE_FINGERPRINT_FORMAT_VERSION = 1;
const BRAIN_NAMESPACE_AWS_DEFAULT_ENDPOINT = 'aws-default';

export type WorkspaceBrainStorageConfig = {
  bucket: string;
  region: string;
  root_prefix?: string;
  endpoint?: string;
  force_path_style: boolean;
};

export type WorkspaceBrainConfig = {
  secrets_path: string;
  storage: WorkspaceBrainStorageConfig;
};

type BrainNamespaceFingerprint = {
  format_version: typeof BRAIN_NAMESPACE_FINGERPRINT_FORMAT_VERSION;
  fingerprint: string;
};

export type EnabledV2Host = 'claude' | 'codex';

export type FunctionDefinition = {
  schema_version: 2;
  id: string;
  purpose: string;
  agents: string[];
  guidelines: string[];
  tool_uses: string[];
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
  value: Record<string, unknown>;
};

export type PlanEnvelope = {
  schema_version: 2;
  id: string;
  purpose: string;
  agent: string;
  tool_uses: string[];
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
  if (text.includes('\r') || text.includes('\t')) return undefined;
  const sourceLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (sourceLines.length === 0 || sourceLines.some((line) => (
    line.length === 0
    || line.endsWith(' ')
    || line.trimStart().startsWith('#')
    || /[ ]#/.test(line)
  ))) return undefined;
  const lines: SimpleYamlLine[] = [];
  for (const line of sourceLines) {
    const whitespace = line.match(/^ */)![0].length;
    if (whitespace % 2 !== 0) return undefined;
    lines.push({ indent: whitespace, content: line.slice(whitespace) });
  }
  let cursor = 0;
  const parseBlock = (indent: number): unknown | typeof SIMPLE_YAML_UNSUPPORTED => (
    lines[cursor]?.content.startsWith('- ')
      ? parseList(indent)
      : parseMap(indent)
  );
  const assignPair = (
    result: Record<string, unknown>,
    content: string,
    childIndent: number,
  ): boolean => {
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(content);
    if (match === null || Object.hasOwn(result, match[1]!)) return false;
    const key = match[1]!;
    const remainder = match[2]!;
    if (remainder.length > 0) {
      if (!remainder.startsWith(' ')) return false;
      const value = parseSimpleScalar(remainder.slice(1));
      if (value === SIMPLE_YAML_UNSUPPORTED) return false;
      result[key] = value;
      return true;
    }
    const next = lines[cursor];
    if (next === undefined || next.indent !== childIndent) return false;
    const child = parseBlock(childIndent);
    if (child === SIMPLE_YAML_UNSUPPORTED) return false;
    result[key] = child;
    return true;
  };
  function parseList(indent: number): unknown[] | typeof SIMPLE_YAML_UNSUPPORTED {
    const result: unknown[] = [];
    while (cursor < lines.length && lines[cursor]!.indent === indent) {
      const content = lines[cursor]!.content;
      if (!content.startsWith('- ')) return SIMPLE_YAML_UNSUPPORTED;
      const item = content.slice(2);
      const pair = /^([A-Za-z0-9_-]+):(.*)$/.exec(item);
      if (pair !== null && (pair[2] === '' || pair[2]!.startsWith(' '))) {
        const mapping = Object.create(null) as Record<string, unknown>;
        cursor++;
        if (!assignPair(mapping, item, indent + 4)) return SIMPLE_YAML_UNSUPPORTED;
        while (cursor < lines.length && lines[cursor]!.indent === indent + 2) {
          const continuation = lines[cursor]!.content;
          if (continuation.startsWith('- ')) return SIMPLE_YAML_UNSUPPORTED;
          cursor++;
          if (!assignPair(mapping, continuation, indent + 4)) return SIMPLE_YAML_UNSUPPORTED;
        }
        result.push(mapping);
        continue;
      }
      const value = parseSimpleScalar(item);
      if (value === SIMPLE_YAML_UNSUPPORTED) return value;
      result.push(value);
      cursor++;
    }
    return result;
  }
  function parseMap(indent: number): Record<string, unknown> | typeof SIMPLE_YAML_UNSUPPORTED {
    const result = Object.create(null) as Record<string, unknown>;
    while (cursor < lines.length && lines[cursor]!.indent === indent) {
      const content = lines[cursor]!.content;
      if (content.startsWith('- ')) return SIMPLE_YAML_UNSUPPORTED;
      cursor++;
      if (!assignPair(result, content, indent + 2)) return SIMPLE_YAML_UNSUPPORTED;
    }
    return result;
  }
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

function boundedConfigString(value: unknown, path: string, field: string, maximum: number): string {
  const text = requireString(value, path, field);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.length === 0 || bytes > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    schemaFailure(path, `'${field}' must be a non-empty control-safe string no longer than ${maximum} bytes`, { field, maximum });
  }
  if (detectAuthoredSecretMaterial(text).length > 0) {
    throw workspaceFailure(
      'SECRET_MATERIAL_FORBIDDEN',
      `${path}: '${field}' must not contain secret material.`,
      'Store credentials only in Infisical and keep this tracked configuration non-secret.',
      { path, field },
    );
  }
  return text;
}

function parseSecretsPath(value: unknown, path: string): string {
  const secretsPath = boundedConfigString(value, path, 'brain.secrets_path', 512);
  if (!secretsPath.startsWith('/') || secretsPath === '/' || secretsPath.endsWith('/')) {
    schemaFailure(path, "'brain.secrets_path' must be an absolute Infisical path with one or more safe components");
  }
  const components = secretsPath.slice(1).split('/');
  if (components.some((component) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(component) || component === '.' || component === '..')) {
    schemaFailure(path, "'brain.secrets_path' contains an unsafe path component");
  }
  return secretsPath;
}

function parseBucket(value: unknown, path: string): string {
  const bucket = boundedConfigString(value, path, 'brain.storage.bucket', 63);
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/u.test(bucket)
    || bucket.includes('..')
    || /(?:^|\.)-|-\.|\.$/u.test(bucket)
    || /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)) {
    schemaFailure(path, "'brain.storage.bucket' must be a canonical S3 bucket name");
  }
  return bucket;
}

function parseRegion(value: unknown, path: string): string {
  const region = boundedConfigString(value, path, 'brain.storage.region', 128);
  if (region !== 'auto' && !/^[a-z0-9]+(?:-[a-z0-9]+){1,15}$/u.test(region)) {
    schemaFailure(path, "'brain.storage.region' must be a canonical region identifier");
  }
  return region;
}

function parseRootPrefix(value: unknown, path: string): string {
  const prefix = boundedConfigString(value, path, 'brain.storage.root_prefix', 757);
  if (prefix.startsWith('/') || prefix.endsWith('/') || prefix.includes('\\')) {
    schemaFailure(path, "'brain.storage.root_prefix' must be a relative slash-delimited prefix");
  }
  if (prefix.split('/').some((component) => component.length === 0 || component === '.' || component === '..')) {
    schemaFailure(path, "'brain.storage.root_prefix' must not contain empty or dot path components");
  }
  return prefix;
}

function parseEndpoint(value: unknown, path: string): string {
  const endpoint = boundedConfigString(value, path, 'brain.storage.endpoint', 512);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    schemaFailure(path, "'brain.storage.endpoint' must be a valid public HTTPS origin");
  }
  if (parsed!.protocol !== 'https:'
    || parsed!.username.length > 0
    || parsed!.password.length > 0
    || parsed!.pathname !== '/'
    || parsed!.search.length > 0
    || parsed!.hash.length > 0
    || endpoint !== parsed!.origin) {
    schemaFailure(path, "'brain.storage.endpoint' must be an exact HTTPS origin without userinfo, path, query, or fragment");
  }
  const hostname = parsed!.hostname.toLowerCase().replace(/\.$/u, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isNonGlobalIpLiteral(hostname)) {
    schemaFailure(path, "'brain.storage.endpoint' must not use a local, private, or link-local literal address");
  }
  return parsed!.origin;
}

function parseBrainConfig(value: unknown, path: string): WorkspaceBrainConfig {
  const brain = requireObject(value, path, 'brain');
  if (Object.hasOwn(brain, 'binding')) {
    throw workspaceFailure(
      'UNKNOWN_FIELD',
      `${path}: unknown field 'brain.binding'; the retired Brain binding format is no longer supported.`,
      "Replace 'brain.binding' with 'brain.secrets_path' and 'brain.storage', then retry.",
      { path, fields: ['binding'] },
    );
  }
  assertKnownFields(brain, ['secrets_path', 'storage'], path);
  const storage = requireObject(brain.storage, path, 'brain.storage');
  assertKnownFields(storage, ['bucket', 'region', 'root_prefix', 'endpoint', 'force_path_style'], path);
  if (storage.force_path_style !== undefined && typeof storage.force_path_style !== 'boolean') {
    schemaFailure(path, "'brain.storage.force_path_style' must be a boolean");
  }
  return {
    secrets_path: parseSecretsPath(brain.secrets_path, path),
    storage: {
      bucket: parseBucket(storage.bucket, path),
      region: parseRegion(storage.region, path),
      ...(storage.root_prefix === undefined ? {} : { root_prefix: parseRootPrefix(storage.root_prefix, path) }),
      ...(storage.endpoint === undefined ? {} : { endpoint: parseEndpoint(storage.endpoint, path) }),
      force_path_style: storage.force_path_style ?? false,
    },
  };
}

export type BrainDeclaration =
  | { status: 'absent' }
  | { status: 'partial'; missing: readonly ('postgresql' | 'object-storage')[] }
  | { status: 'declared' };

// Structural probe run BEFORE the strict parse: a half-declared brain block is
// an incomplete ACTIVATION, not a schema error, and only the Brain activation
// resolver consumes this. A present-but-invalid value stays `declared` so
// parseWorkspaceRegistry keeps raising YAML_INVALID for every other command.
export function classifyBrainDeclaration(text: string, path = 'roster.yaml'): BrainDeclaration {
  const brain = parseYaml(text, path).value['brain'];
  if (brain === undefined) return { status: 'absent' };
  if (brain === null || typeof brain !== 'object' || Array.isArray(brain)) return { status: 'declared' };
  const block = brain as Record<string, unknown>;
  const missing: ('postgresql' | 'object-storage')[] = [];
  if (!Object.hasOwn(block, 'secrets_path')) missing.push('postgresql');
  const storage = block['storage'];
  if (storage === undefined) {
    missing.push('object-storage');
  } else if (storage !== null && typeof storage === 'object' && !Array.isArray(storage)
    && (!Object.hasOwn(storage, 'bucket') || !Object.hasOwn(storage, 'region'))) {
    missing.push('object-storage');
  }
  return missing.length === 0 ? { status: 'declared' } : { status: 'partial', missing };
}

export function canonicalBrainNamespace(config: WorkspaceBrainConfig): string {
  return JSON.stringify({
    domain: 'roster.brain.s3-namespace.v1',
    provider: 's3',
    bucket: config.storage.bucket,
    region: config.storage.region,
    endpoint: config.storage.endpoint ?? BRAIN_NAMESPACE_AWS_DEFAULT_ENDPOINT,
    force_path_style: config.storage.force_path_style,
    root_prefix: config.storage.root_prefix ?? null,
  });
}

export function fingerprintBrainNamespace(config: WorkspaceBrainConfig): BrainNamespaceFingerprint {
  return {
    format_version: BRAIN_NAMESPACE_FINGERPRINT_FORMAT_VERSION,
    fingerprint: `sha256:${createHash('sha256').update(canonicalBrainNamespace(config)).digest('hex')}`,
  };
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
  trySimple = true,
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
      raw = (trySimple ? tryParseSimpleYaml(text) : undefined)
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
  assertKnownFields(value, ['schema_version', 'workspace_id', 'brain', 'functions', 'hosts', 'tool_uses'], path);
  const functionsRaw = requireObject(value.functions, path, 'functions');
  const functions: Record<string, { path: string }> = Object.create(null) as Record<string, { path: string }>;
  const caseFolded = new Set<string>();
  for (const [rawId, rawEntry] of Object.entries(functionsRaw)) {
    const id = assertFunctionId(rawId);
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
  let brain: WorkspaceBrainConfig | undefined;
  if (value.brain !== undefined) {
    brain = parseBrainConfig(value.brain, path);
  }
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    workspace_id: assertWorkspaceId(requireString(value.workspace_id, path, 'workspace_id')),
    ...(brain === undefined ? {} : { brain }),
    functions,
    hosts,
    tool_uses: requireStringArray(value.tool_uses, path, 'tool_uses'),
  };
}

export function enabledV2Hosts(registry: Pick<WorkspaceRegistry, 'hosts'>): EnabledV2Host[] {
  const hosts = Object.keys(registry.hosts);
  const unsupported = hosts.filter((host) => host !== 'claude' && host !== 'codex').sort((a, b) => a.localeCompare(b, 'en'));
  if (unsupported.length > 0) {
    throw workspaceFailure(
      'UNKNOWN_FIELD',
      `Host '${unsupported[0]}' has no v2 activation contract.`,
      'Use project activation only for claude or codex; Gemini remains quarantined.',
      { path: 'roster.yaml', hosts: unsupported },
    );
  }
  return hosts
    .filter((host): host is EnabledV2Host => host === 'claude' || host === 'codex')
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export function parseFunctionDefinition(text: string, path: string): FunctionDefinition {
  const { value } = parseYaml(text, path);
  assertKnownFields(value, ['schema_version', 'id', 'purpose', 'agents', 'guidelines', 'tool_uses'], path);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertFunctionId(requireString(value.id, path, 'id')),
    purpose: requireString(value.purpose, path, 'purpose'),
    agents: requireStringArray(value.agents, path, 'agents'),
    guidelines: requireStringArray(value.guidelines, path, 'guidelines'),
    tool_uses: requireStringArray(value.tool_uses, path, 'tool_uses'),
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
    function: assertFunctionId(requireString(value.function, path, 'function')),
    purpose: requireString(value.purpose, path, 'purpose'),
    plans: requireStringArray(value.plans, path, 'plans'),
    subagents: requireStringArray(value.subagents, path, 'subagents'),
    guidelines: requireStringArray(value.guidelines, path, 'guidelines'),
    default_guidelines: requireStringArray(value.default_guidelines, path, 'default_guidelines'),
    tool_uses: requireStringArray(value.tool_uses, path, 'tool_uses'),
    lessons: requireStringArray(value.lessons, path, 'lessons'),
  };
}

export function parseChildDefinition(
  kind: 'subagent',
  text: string,
  path: string,
): ChildDefinition {
  if (kind !== 'subagent') schemaFailure(path, `unsupported child kind '${String(kind)}'`);
  const { value } = parseYaml(text, path);
  assertKnownFields(value, ['schema_version', 'id', 'agent', 'purpose'], path);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertRecordId(requireString(value.id, path, 'id')),
    purpose: requireString(value.purpose, path, 'purpose'),
    agent: requireString(value.agent, path, 'agent'),
    value,
  };
}

export function parsePlanEnvelope(text: string, path: string): PlanEnvelope {
  const { value } = parseYaml(text, path, MAX_AUTHORED_YAML_BYTES);
  return {
    schema_version: requireSchemaVersion(value.schema_version, path),
    id: assertRecordId(requireString(value.id, path, 'id')),
    purpose: requireString(value.purpose, path, 'purpose'),
    agent: requireString(value.agent, path, 'agent'),
    tool_uses: requireStringArray(value.tool_uses, path, 'tool_uses'),
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
    id: assertFunctionId(id),
    purpose,
    agents: [],
    guidelines: [],
    tool_uses: [],
  });
}

export function renderAgentDefinition(functionId: string, id: string, purpose: string): string {
  return stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    id: assertRecordId(id),
    function: assertFunctionId(functionId),
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
  kind: 'plan' | 'subagent',
  functionId: string,
  agentId: string,
  id: string,
  purpose: string,
): string {
  const agent = `${assertFunctionId(functionId)}/${assertRecordId(agentId)}`;
  const localId = assertRecordId(id);
  if (kind === 'plan') {
    return stringify({
      schema_version: WORKSPACE_SCHEMA_VERSION,
      id: localId,
      agent,
      purpose,
      inputs: {},
      brain_selectors: {},
      guidelines: [],
      tool_uses: [],
      artifacts: {},
      caps: {},
      steps: [],
      completion: { artifacts: [], output_guidance: '', criteria: [] },
    });
  }
  if (kind === 'subagent') {
    return stringify({ schema_version: WORKSPACE_SCHEMA_VERSION, id: localId, agent, purpose });
  }
  return kind satisfies never;
}

function normalizedToolUseScope(scope: WorkspaceScope): WorkspaceScope {
  if (scope.function === undefined) {
    if (scope.agent !== undefined || scope.plan !== undefined) {
      throw workspaceFailure(
        'IDENTITY_INVALID',
        'Tool-use scope has an agent or plan without a function.',
        'Use workspace scope {}, or provide the complete function/agent/plan ancestry.',
      );
    }
    return {};
  }
  const functionId = assertFunctionId(scope.function);
  if (scope.agent === undefined) {
    if (scope.plan !== undefined) {
      throw workspaceFailure(
        'IDENTITY_INVALID',
        'Tool-use plan scope has no agent.',
        'Provide the complete function/agent/plan ancestry.',
      );
    }
    return { function: functionId };
  }
  const agentId = assertRecordId(scope.agent);
  if (scope.plan === undefined) return { function: functionId, agent: agentId };
  return { function: functionId, agent: agentId, plan: assertRecordId(scope.plan) };
}

export function renderToolUseDraft(id: string, purpose: string, scope: WorkspaceScope): string {
  return stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    id: assertRecordId(id),
    scope: normalizedToolUseScope(scope),
    purpose,
    skill_ref: '',
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
