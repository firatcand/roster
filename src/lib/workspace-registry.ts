import { posix } from 'node:path';
import {
  childRecordPath,
  functionRecordPath,
  agentRecordPath,
  planCompanionPath,
  assertRecordId,
  parseScope,
  qualifiedRecordId,
  type WorkspaceRecordKind,
  type WorkspaceScope,
} from './workspace-layout.ts';
import {
  addWorkspaceFunction,
  addYamlMembership,
  enabledV2Hosts,
  parseAgentDefinition,
  parseChildDefinition,
  parseFunctionDefinition,
  parseMarkdownDefinition,
  parsePlanEnvelope,
  parseWorkspaceRegistry,
  renderAgentDefinition,
  renderChildDefinition,
  renderFunctionDefinition,
  renderMarkdownDefinition,
  renderToolUseDraft,
  type AgentDefinition,
  type FunctionDefinition,
  type PlanEnvelope,
  type WorkspaceRegistry,
  type EnabledV2Host,
  MAX_AUTHORED_MARKDOWN_BYTES,
  MAX_AUTHORED_YAML_BYTES,
} from './workspace-record.ts';
import {
  parseStructuredPlan,
  validateStructuredPlans,
  type StructuredPlan,
} from './workspace-plan.ts';
import {
  ensureWorkspaceDirectory,
  enumerateWorkspaceSlot,
  createWorkspaceReadSession,
  hashWorkspaceBytes,
  publishCreateOnly,
  readWorkspaceFile,
  tryReadWorkspaceFile,
  removeEmptyWorkspaceDirectories,
  removePublishedWorkspaceFile,
  replaceWorkspaceFile,
  withWorkspaceLock,
  type PublicationResult,
  type WorkspaceFileIdentityToken,
  type WorkspaceReadSession,
} from './workspace-io.ts';
import {
  diagnosticFromFailure,
  isWorkspaceFailure,
  workspaceDiagnostic,
  workspaceFailure,
  type JsonValue,
  type WorkspaceDiagnostic,
} from './workspace-diagnostics.ts';
import {
  parseWorkspaceToolUseEnvelope,
  validateToolUseLattice,
  assertCompleteWorkspaceSnapshot,
  type CompleteWorkspaceSnapshot,
  type ToolUseLatticeValidationResult,
} from './workspace-tool-use.ts';
import { mintCompleteWorkspaceSnapshot } from './internal/workspace-tool-use-snapshot.ts';
import { getPackageVersion } from './paths.ts';
import { readFounderSkillsManifest } from './founder-skills/manifest-schema.ts';
import { readLockfile } from './founder-skills/lockfile.ts';
import {
  VENDOR_SKILL_MAP_PATH,
  VENDOR_SKILL_MAP_MAX_BYTES,
  buildVendorSkillMap,
  parseVendorSkillMap,
  serializeVendorSkillMap,
  type VendorSkillMap,
  type VendorSkillMapEntry,
} from './vendor-skills/adapter-map.ts';
import { canonicalJson } from './vendor-skills/canonical-json.ts';
import type { CanonicalSkillRef } from './vendor-skills/skill-ref.ts';
import { validateGeneratedArtifacts } from './generated-artifacts.ts';
import { probeWorkspace } from './workspace-probe.ts';
import {
  legacyWorkspaceError,
  mixedWorkspaceError,
  unsafeWorkspaceMarkerError,
  workspaceRequiredError,
} from './errors.ts';

export type WorkspaceDiscoveryRecord = {
  qualified_id: string;
  kind: WorkspaceRecordKind;
  path: string;
  purpose: string;
  scope: Record<string, string>;
  schema_version: 2;
  content_hash: string;
  references: Record<string, number>;
  content?: string;
};

export type DiscoverWorkspaceOptions = {
  query?: string;
  kind?: WorkspaceRecordKind;
  scope?: string;
  exact?: boolean;
  full?: boolean;
};

export type DiscoverWorkspaceResult = {
  ok: boolean;
  records: WorkspaceDiscoveryRecord[];
  diagnostics: WorkspaceDiagnostic[];
};

export type ScaffoldWorkspaceOptions = {
  kind: WorkspaceRecordKind;
  id: string;
  scope?: string;
  purpose?: string;
};

export type ScaffoldWorkspaceResult = {
  ok: true;
  status: PublicationResult | 'existing';
  record: WorkspaceDiscoveryRecord;
  diagnostics: WorkspaceDiagnostic[];
};

export type ScaffoldWorkspaceIo = {
  replaceParent: typeof replaceWorkspaceFile;
};

const realScaffoldWorkspaceIo: ScaffoldWorkspaceIo = {
  replaceParent: replaceWorkspaceFile,
};

export type StructuralCheck = {
  name: string;
  severity: 'error' | 'warning' | 'info';
  status: 'pass' | 'fail';
  details: Record<string, JsonValue>;
};

export type ValidateWorkspaceResult = {
  ok: boolean;
  checks: StructuralCheck[];
  diagnostics: WorkspaceDiagnostic[];
};

export type LoadedWorkspaceRegistry = {
  registry: WorkspaceRegistry;
  bytes: Buffer;
  text: string;
  hash: string;
};

export const MAX_CONTEXT_REGISTERED_RECORDS = 8_192;
export const MAX_CONTEXT_REGISTERED_CONTENT_BYTES = 64 * 1024 * 1024;
export const MAX_CONTEXT_MEMBERSHIP_ENTRIES = 4_096;

const PREPARED_CONTEXT_SOURCE: unique symbol = Symbol('prepared-context-source');

export type PreparedContextRegistryMetadata = {
  readonly schema_version: 2;
  readonly workspace_id: string;
  readonly brain_binding: string | null;
  readonly enabled_hosts: readonly EnabledV2Host[];
};

export type PreparedContextSource = {
  readonly [PREPARED_CONTEXT_SOURCE]: true;
  readonly snapshot: CompleteWorkspaceSnapshot;
  readonly registry_metadata: PreparedContextRegistryMetadata;
  readonly registry_source_hash: string;
  readonly counts: {
    readonly records: number;
    readonly content_bytes: number;
  };
};

export type ContextVendorSkillSelection = {
  readonly skillRefs: readonly CanonicalSkillRef[];
  readonly skillRefPaths: ReadonlyMap<CanonicalSkillRef, readonly string[]>;
};

export type ContextVendorSkillProjection = {
  readonly generator_version: string;
  readonly map_hash: string | null;
  readonly skills: readonly VendorSkillMapEntry[];
};

export type ContextReadCapability = {
  readonly source: PreparedContextSource;
  readonly selectVendorSkillMap: (
    selection: ContextVendorSkillSelection,
  ) => ContextVendorSkillProjection;
  readonly verify: (localRecordPaths: readonly string[]) => void;
};

const PREPARED_CONTEXT_SOURCES = new WeakSet<object>();

function cloneContextValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneContextValue(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, cloneContextValue(entry)])) as T;
  }
  return value;
}

function freezeContextValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      freezeContextValue(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function preparedContextSourceFailure(): never {
  throw workspaceFailure(
    'TOOL_USE_SNAPSHOT_INCOMPLETE',
    'Context resolution requires a registry-attested one-generation workspace source.',
    'Collect context through the registry-owned read capability before assembling a bundle.',
    { requirement: 'prepared-context-source' },
  );
}

export function assertPreparedContextSource(
  value: unknown,
): asserts value is PreparedContextSource {
  if (value === null || typeof value !== 'object' || !PREPARED_CONTEXT_SOURCES.has(value)) {
    preparedContextSourceFailure();
  }
  const source = value as PreparedContextSource;
  assertCompleteWorkspaceSnapshot(source.snapshot);
  const contentBytes = source.snapshot.records.reduce(
    (total, record) => total + Buffer.byteLength(record.content ?? '', 'utf8'),
    0,
  );
  if (source[PREPARED_CONTEXT_SOURCE] !== true
    || !Object.isFrozen(source)
    || !Object.isFrozen(source.registry_metadata)
    || !Object.isFrozen(source.registry_metadata.enabled_hosts)
    || !Object.isFrozen(source.counts)
    || source.counts.records !== source.snapshot.records.length
    || source.counts.content_bytes !== contentBytes) {
    preparedContextSourceFailure();
  }
}

function assertV2Workspace(root: string): ReturnType<typeof probeWorkspace> {
  const probe = probeWorkspace(root);
  if (probe.kind === 'v2') return probe;
  if (probe.kind === 'legacy') throw legacyWorkspaceError(probe.legacySignals);
  if (probe.kind === 'mixed') throw mixedWorkspaceError(probe.v2Signals, probe.legacySignals);
  if (probe.kind === 'unsafe') throw unsafeWorkspaceMarkerError(probe.unsafeSignals);
  throw workspaceRequiredError(probe.root);
}

type LoadedFunction = {
  definition: FunctionDefinition;
  bytes: Buffer;
  text: string;
  path: string;
  root: string;
};

type LoadedAgent = {
  definition: AgentDefinition;
  bytes: Buffer;
  text: string;
  path: string;
  functionRoot: string;
};

type LoadedPlan = {
  definition: PlanEnvelope;
  bytes: Buffer;
  text: string;
  path: string;
};

function identityMismatch(path: string, expected: string, actual: string): never {
  throw workspaceFailure(
    'IDENTITY_PATH_MISMATCH',
    `${path}: embedded identity '${actual}' does not match '${expected}'.`,
    'Make the authored identity agree with its declared registry path.',
    { path, expected, actual },
  );
}

function readAuthored(
  root: string,
  path: string,
  markdown = false,
  session?: WorkspaceReadSession,
): { bytes: Buffer; text: string } {
  const bytes = (session?.readFile ?? ((relativePath, options) => readWorkspaceFile(root, relativePath, options)))(path, {
    maxBytes: markdown ? MAX_AUTHORED_MARKDOWN_BYTES : MAX_AUTHORED_YAML_BYTES,
  });
  return { bytes, text: bytes.toString('utf8') };
}

export function readWorkspaceRegistry(root: string, session?: WorkspaceReadSession): LoadedWorkspaceRegistry {
  let bytes: Buffer;
  try {
    bytes = session === undefined
      ? readWorkspaceFile(root, 'roster.yaml', { maxBytes: MAX_AUTHORED_YAML_BYTES })
      : session.readFile('roster.yaml', { maxBytes: MAX_AUTHORED_YAML_BYTES });
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') {
      throw workspaceFailure(
        'WORKSPACE_NOT_FOUND',
        'No schema-v2 roster.yaml exists in this directory.',
        'Run roster init in a new directory, or use the explicit migration command for a legacy workspace.',
        { root },
      );
    }
    throw error;
  }
  const text = bytes.toString('utf8');
  return { registry: parseWorkspaceRegistry(text), bytes, text, hash: hashWorkspaceBytes(bytes) };
}

function loadFunction(
  root: string,
  registry: WorkspaceRegistry,
  functionId: string,
  session?: WorkspaceReadSession,
): LoadedFunction {
  const entry = registry.functions[functionId];
  if (entry === undefined) {
    throw workspaceFailure('PARENT_NOT_FOUND', `Function '${functionId}' is not registered.`, `Run roster scaffold function ${functionId} first.`, { function: functionId });
  }
  const path = functionRecordPath(entry.path);
  const file = readAuthored(root, path, false, session);
  const definition = parseFunctionDefinition(file.text, path);
  if (definition.id !== functionId) identityMismatch(path, functionId, definition.id);
  return { definition, bytes: file.bytes, text: file.text, path, root: entry.path };
}

function loadAgent(
  root: string,
  registry: WorkspaceRegistry,
  functionId: string,
  agentId: string,
  session?: WorkspaceReadSession,
  loadedFunction?: LoadedFunction,
): LoadedAgent {
  const fn = loadedFunction ?? loadFunction(root, registry, functionId, session);
  if (!fn.definition.agents.includes(agentId)) {
    throw workspaceFailure('PARENT_NOT_FOUND', `Agent '${functionId}/${agentId}' is not registered.`, `Run roster scaffold agent ${agentId} --scope function:${functionId} first.`, { function: functionId, agent: agentId });
  }
  const path = agentRecordPath(fn.root, agentId);
  const file = readAuthored(root, path, false, session);
  const definition = parseAgentDefinition(file.text, path);
  if (definition.id !== agentId) identityMismatch(path, agentId, definition.id);
  if (definition.function !== functionId) identityMismatch(path, functionId, definition.function);
  for (const guidelineId of definition.default_guidelines) {
    const functionMatch = fn.definition.guidelines.includes(guidelineId);
    const agentMatch = definition.guidelines.includes(guidelineId);
    if (functionMatch && agentMatch) {
      throw workspaceFailure(
        'IDENTITY_AMBIGUOUS',
        `${path}: default guideline '${guidelineId}' is registered at both function and agent scope.`,
        'Use distinct local guideline IDs or remove the ambiguous default reference.',
        { path, guideline: guidelineId, function: functionId, agent: agentId },
      );
    }
    if (!functionMatch && !agentMatch) {
      throw workspaceFailure(
        'PARENT_NOT_FOUND',
        `${path}: default guideline '${guidelineId}' is not registered at function or agent scope.`,
        'Register the guideline in the function or agent before making it a default.',
        { path, guideline: guidelineId, function: functionId, agent: agentId },
      );
    }
  }
  return { definition, bytes: file.bytes, text: file.text, path, functionRoot: fn.root };
}

function loadPlan(
  root: string,
  fn: LoadedFunction,
  agent: LoadedAgent,
  planId: string,
  session?: WorkspaceReadSession,
): LoadedPlan {
  if (!agent.definition.plans.includes(planId)) {
    throw workspaceFailure(
      'PARENT_NOT_FOUND',
      `Plan '${agent.definition.function}/${agent.definition.id}#${planId}' is not registered.`,
      'Scaffold the plan before using it as a scope.',
      { plan: planId },
    );
  }
  const path = childRecordPath(fn.root, agent.definition.id, 'plan', planId);
  const file = readAuthored(root, path, false, session);
  const definition = parsePlanEnvelope(file.text, path);
  const expectedAgent = `${agent.definition.function}/${agent.definition.id}`;
  if (definition.id !== planId) identityMismatch(path, planId, definition.id);
  if (definition.agent !== expectedAgent) identityMismatch(path, expectedAgent, definition.agent);
  return { definition, bytes: file.bytes, text: file.text, path };
}

function record(
  kind: WorkspaceRecordKind,
  qualifiedId: string,
  path: string,
  purpose: string,
  scope: Record<string, string>,
  bytes: Buffer,
  references: Record<string, number>,
  full: boolean,
): WorkspaceDiscoveryRecord {
  return {
    qualified_id: qualifiedId,
    kind,
    path,
    purpose,
    scope,
    schema_version: 2,
    content_hash: hashWorkspaceBytes(bytes),
    references,
    ...(full ? { content: bytes.toString('utf8') } : {}),
  };
}

function assertMarkdownIdentity(
  path: string,
  expected: { id: string; kind: 'guideline' | 'lesson'; scope: WorkspaceScope },
  actual: ReturnType<typeof parseMarkdownDefinition>,
): void {
  if (actual.id !== expected.id) identityMismatch(path, expected.id, actual.id);
  if (actual.kind !== expected.kind) identityMismatch(path, expected.kind, actual.kind);
  for (const field of ['function', 'agent', 'plan'] as const) {
    if (actual.scope[field] !== expected.scope[field]) {
      identityMismatch(path, expected.scope[field] ?? '(none)', actual.scope[field] ?? '(none)');
    }
  }
}

type ContextCollectionBounds = {
  records: number;
  contentBytes: number;
};

function pushRecord(
  target: WorkspaceDiscoveryRecord[],
  identities: Set<string>,
  value: WorkspaceDiscoveryRecord,
  bounds?: ContextCollectionBounds,
): void {
  const key = `${value.kind}\u0000${value.qualified_id}`;
  if (identities.has(key)) {
    throw workspaceFailure('DUPLICATE_IDENTITY', `Identity '${value.kind}:${value.qualified_id}' is registered more than once.`, 'Keep one canonical parent membership for the record.', { kind: value.kind, qualifiedId: value.qualified_id });
  }
  if (bounds !== undefined) {
    const contentBytes = Buffer.byteLength(value.content ?? '', 'utf8');
    if (bounds.records === MAX_CONTEXT_REGISTERED_RECORDS) {
      throw workspaceFailure(
        'READ_LIMIT_EXCEEDED',
        'The complete registered record catalog exceeds the context collection limit.',
        'Reduce the number of registered workspace records before retrying context resolution.',
        {
          bound: 'context-registered-records',
          limit: MAX_CONTEXT_REGISTERED_RECORDS,
          records: bounds.records + 1,
        },
      );
    }
    if (contentBytes > MAX_CONTEXT_REGISTERED_CONTENT_BYTES - bounds.contentBytes) {
      throw workspaceFailure(
        'READ_LIMIT_EXCEEDED',
        'Registered record content exceeds the context collection byte limit.',
        'Reduce authored record content before retrying context resolution.',
        {
          bound: 'context-registered-content-bytes',
          limit: MAX_CONTEXT_REGISTERED_CONTENT_BYTES,
          bytes: bounds.contentBytes + contentBytes,
        },
      );
    }
    bounds.records += 1;
    bounds.contentBytes += contentBytes;
  }
  identities.add(key);
  target.push(value);
}

type CollectedWorkspaceRecords = {
  records: WorkspaceDiscoveryRecord[];
  diagnostics: WorkspaceDiagnostic[];
  loadedRegistry: LoadedWorkspaceRegistry;
  counts: {
    records: number;
    contentBytes: number;
  };
};

function assertContextMembershipBound(
  path: string,
  field: string,
  values: readonly unknown[],
  bounds: ContextCollectionBounds | undefined,
): void {
  if (bounds === undefined || values.length <= MAX_CONTEXT_MEMBERSHIP_ENTRIES) return;
  throw workspaceFailure(
    'READ_LIMIT_EXCEEDED',
    `Registry membership '${field}' exceeds the context collection limit.`,
    'Reduce the owning registry membership before retrying context resolution.',
    {
      path,
      field,
      bound: 'context-registry-membership',
      limit: MAX_CONTEXT_MEMBERSHIP_ENTRIES,
      entries: values.length,
    },
  );
}

function assertContextDefinitionMemberships(
  path: string,
  definition: WorkspaceRegistry | FunctionDefinition | AgentDefinition | PlanEnvelope,
  bounds: ContextCollectionBounds | undefined,
): void {
  if (bounds === undefined) return;
  if ('functions' in definition) {
    assertContextMembershipBound(path, 'tool_uses', definition.tool_uses, bounds);
    return;
  }
  if ('agents' in definition) {
    assertContextMembershipBound(path, 'agents', definition.agents, bounds);
    assertContextMembershipBound(path, 'guidelines', definition.guidelines, bounds);
    assertContextMembershipBound(path, 'tool_uses', definition.tool_uses, bounds);
    return;
  }
  if ('plans' in definition) {
    assertContextMembershipBound(path, 'plans', definition.plans, bounds);
    assertContextMembershipBound(path, 'subagents', definition.subagents, bounds);
    assertContextMembershipBound(path, 'guidelines', definition.guidelines, bounds);
    assertContextMembershipBound(path, 'default_guidelines', definition.default_guidelines, bounds);
    assertContextMembershipBound(path, 'tool_uses', definition.tool_uses, bounds);
    assertContextMembershipBound(path, 'lessons', definition.lessons, bounds);
    return;
  }
  assertContextMembershipBound(path, 'tool_uses', definition.tool_uses, bounds);
}

function toolUseScopeMatches(
  actual: Record<string, string>,
  expected: WorkspaceScope,
): boolean {
  return actual.function === expected.function
    && actual.agent === expected.agent
    && actual.plan === expected.plan
    && Number(actual.function !== undefined)
      + Number(actual.agent !== undefined)
      + Number(actual.plan !== undefined)
      === Number(expected.function !== undefined)
        + Number(expected.agent !== undefined)
        + Number(expected.plan !== undefined);
}

function collectToolUseRecord(options: {
  records: WorkspaceDiscoveryRecord[];
  identities: Set<string>;
  diagnostics: WorkspaceDiagnostic[];
  path: string;
  file: { bytes: Buffer; text: string };
  id: string;
  scope: WorkspaceScope;
  qualifiedId: string;
  full: boolean;
  bounds?: ContextCollectionBounds;
}): void {
  let definition;
  try {
    definition = parseWorkspaceToolUseEnvelope(options.file.text, options.path);
  } catch (error) {
    if (!isWorkspaceFailure(error) || error.code !== 'SECRET_MATERIAL_FORBIDDEN') throw error;
    const diagnostic = diagnosticFromFailure(error);
    options.diagnostics.push({
      ...diagnostic,
      details: {
        ...diagnostic.details,
        kind: 'tool-use',
        qualified_id: options.qualifiedId,
      },
    });
    return;
  }
  if (definition.id !== options.id) identityMismatch(options.path, options.id, definition.id);
  if (!toolUseScopeMatches(definition.scope, options.scope)) {
    throw workspaceFailure(
      'IDENTITY_PATH_MISMATCH',
      `${options.path}: embedded tool-use scope does not match its registered physical owner.`,
      'Make the authored scope exactly match the workspace, function, agent, or plan that owns this file.',
      { path: options.path, expected_scope: options.scope, actual_scope: definition.scope },
    );
  }
  pushRecord(options.records, options.identities, record(
    'tool-use',
    options.qualifiedId,
    options.path,
    definition.purpose,
    options.scope as Record<string, string>,
    options.file.bytes,
    {},
    options.full,
  ), options.bounds);
}

function collectWorkspaceRecords(
  root: string,
  full: boolean,
  options: {
    session?: WorkspaceReadSession;
    contextBounds?: boolean;
  } = {},
): CollectedWorkspaceRecords {
  const ownsSession = options.session === undefined;
  const session = options.session ?? createWorkspaceReadSession(root, { deferParentChecks: true });
  const loadedRegistry = readWorkspaceRegistry(root, session);
  const { registry } = loadedRegistry;
  const records: WorkspaceDiscoveryRecord[] = [];
  const diagnostics: WorkspaceDiagnostic[] = [];
  const identities = new Set<string>();
  const bounds = options.contextBounds ? { records: 0, contentBytes: 0 } : undefined;
  assertContextDefinitionMemberships('roster.yaml', registry, bounds);

  for (const toolId of registry.tool_uses) {
    const scope: WorkspaceScope = {};
    const path = childRecordPath('', '', 'tool-use', toolId, scope);
    collectToolUseRecord({
      records,
      identities,
      diagnostics,
      path,
      file: readAuthored(root, path, false, session),
      id: toolId,
      scope,
      qualifiedId: qualifiedRecordId('tool-use', { localId: toolId }),
      full,
      bounds,
    });
  }

  const functionIds = Object.keys(registry.functions).sort((a, b) => a.localeCompare(b, 'en'));
  for (const functionId of functionIds) {
    const fn = loadFunction(root, registry, functionId, session);
    assertContextDefinitionMemberships(fn.path, fn.definition, bounds);
    pushRecord(records, identities, record(
      'function',
      functionId,
      fn.path,
      fn.definition.purpose,
      {},
      fn.bytes,
      {
        agents: fn.definition.agents.length,
        guidelines: fn.definition.guidelines.length,
        tool_uses: fn.definition.tool_uses.length,
      },
      full,
    ), bounds);

    for (const toolId of fn.definition.tool_uses) {
      const scope: WorkspaceScope = { function: functionId };
      const path = childRecordPath(fn.root, '', 'tool-use', toolId, scope);
      collectToolUseRecord({
        records,
        identities,
        diagnostics,
        path,
        file: readAuthored(root, path, false, session),
        id: toolId,
        scope,
        qualifiedId: qualifiedRecordId('tool-use', { functionId, localId: toolId }),
        full,
        bounds,
      });
    }

    for (const guidelineId of fn.definition.guidelines) {
      const path = childRecordPath(fn.root, '', 'guideline', guidelineId, { function: functionId });
      const file = readAuthored(root, path, true, session);
      const definition = parseMarkdownDefinition(file.text, path);
      assertMarkdownIdentity(path, { id: guidelineId, kind: 'guideline', scope: { function: functionId } }, definition);
      pushRecord(records, identities, record(
        'guideline',
        qualifiedRecordId('guideline', { functionId, localId: guidelineId }),
        path,
        definition.purpose,
        { function: functionId },
        file.bytes,
        {},
        full,
      ), bounds);
    }

    for (const agentId of fn.definition.agents) {
      const agent = loadAgent(root, registry, functionId, agentId, session, fn);
      assertContextDefinitionMemberships(agent.path, agent.definition, bounds);
      const agentQualified = `${functionId}/${agentId}`;
      pushRecord(records, identities, record(
        'agent',
        agentQualified,
        agent.path,
        agent.definition.purpose,
        { function: functionId },
        agent.bytes,
        {
          plans: agent.definition.plans.length,
          subagents: agent.definition.subagents.length,
          guidelines: agent.definition.guidelines.length,
          tool_uses: agent.definition.tool_uses.length,
          lessons: agent.definition.lessons.length,
        },
        full,
      ), bounds);

      for (const planId of agent.definition.plans) {
        const plan = loadPlan(root, fn, agent, planId, session);
        assertContextDefinitionMemberships(plan.path, plan.definition, bounds);
        pushRecord(records, identities, record(
          'plan',
          qualifiedRecordId('plan', { functionId, agentId, localId: planId }),
          plan.path,
          plan.definition.purpose,
          { function: functionId, agent: agentId },
          plan.bytes,
          { tool_uses: plan.definition.tool_uses.length },
          full,
        ), bounds);

        for (const toolId of plan.definition.tool_uses) {
          const scope: WorkspaceScope = { function: functionId, agent: agentId, plan: planId };
          const path = childRecordPath(fn.root, agentId, 'tool-use', toolId, scope);
          collectToolUseRecord({
            records,
            identities,
            diagnostics,
            path,
            file: readAuthored(root, path, false, session),
            id: toolId,
            scope,
            qualifiedId: qualifiedRecordId('tool-use', {
              functionId,
              agentId,
              planId,
              localId: toolId,
            }),
            full,
            bounds,
          });
        }
      }

      for (const subagentId of agent.definition.subagents) {
        const path = childRecordPath(fn.root, agentId, 'subagent', subagentId);
        const file = readAuthored(root, path, false, session);
        const definition = parseChildDefinition('subagent', file.text, path);
        if (definition.id !== subagentId) identityMismatch(path, subagentId, definition.id);
        if (definition.agent !== agentQualified) identityMismatch(path, agentQualified, definition.agent);
        pushRecord(records, identities, record(
          'subagent',
          qualifiedRecordId('subagent', { functionId, agentId, localId: subagentId }),
          path,
          definition.purpose,
          { function: functionId, agent: agentId },
          file.bytes,
          {},
          full,
        ), bounds);
      }

      for (const guidelineId of agent.definition.guidelines) {
        const path = childRecordPath(fn.root, agentId, 'guideline', guidelineId, { function: functionId, agent: agentId });
        const file = readAuthored(root, path, true, session);
        const definition = parseMarkdownDefinition(file.text, path);
        assertMarkdownIdentity(path, { id: guidelineId, kind: 'guideline', scope: { function: functionId, agent: agentId } }, definition);
        pushRecord(records, identities, record(
          'guideline',
          qualifiedRecordId('guideline', { functionId, agentId, localId: guidelineId }),
          path,
          definition.purpose,
          { function: functionId, agent: agentId },
          file.bytes,
          {},
          full,
        ), bounds);
      }

      for (const toolId of agent.definition.tool_uses) {
        const scope: WorkspaceScope = { function: functionId, agent: agentId };
        const path = childRecordPath(fn.root, agentId, 'tool-use', toolId, scope);
        const file = readAuthored(root, path, false, session);
        collectToolUseRecord({
          records,
          identities,
          diagnostics,
          path,
          file,
          id: toolId,
          scope,
          qualifiedId: qualifiedRecordId('tool-use', { functionId, agentId, localId: toolId }),
          full,
          bounds,
        });
      }

      for (const lessonId of agent.definition.lessons) {
        const path = childRecordPath(fn.root, agentId, 'lesson', lessonId);
        const file = readAuthored(root, path, true, session);
        const definition = parseMarkdownDefinition(file.text, path);
        if (definition.scope.plan !== undefined && !agent.definition.plans.includes(definition.scope.plan)) {
          throw workspaceFailure('PARENT_NOT_FOUND', `${path}: plan scope '${definition.scope.plan}' is not registered.`, 'Scaffold the plan before using it as lesson scope.', { path, plan: definition.scope.plan });
        }
        assertMarkdownIdentity(path, {
          id: lessonId,
          kind: 'lesson',
          scope: { function: functionId, agent: agentId, ...(definition.scope.plan === undefined ? {} : { plan: definition.scope.plan }) },
        }, definition);
        const scope = {
          function: functionId,
          agent: agentId,
          ...(definition.scope.plan === undefined ? {} : { plan: definition.scope.plan }),
        };
        pushRecord(records, identities, record(
          'lesson',
          qualifiedRecordId('lesson', { functionId, agentId, localId: lessonId }),
          path,
          definition.purpose,
          scope,
          file.bytes,
          {},
          full,
        ), bounds);
      }
    }
  }
  if (ownsSession) session.verify();
  return {
    records,
    diagnostics,
    loadedRegistry,
    counts: {
      records: records.length,
      contentBytes: bounds?.contentBytes
        ?? records.reduce((total, entry) => total + Buffer.byteLength(entry.content ?? '', 'utf8'), 0),
    },
  };
}

function resolveRegisteredRecord(
  root: string,
  kind: WorkspaceRecordKind,
  id: string,
  scope: WorkspaceScope | undefined,
  full = false,
): WorkspaceDiscoveryRecord {
  const session = createWorkspaceReadSession(root);
  const { registry } = readWorkspaceRegistry(root, session);
  if (kind === 'function') {
    const fn = loadFunction(root, registry, id, session);
    return record(
      kind,
      id,
      fn.path,
      fn.definition.purpose,
      {},
      fn.bytes,
      {
        agents: fn.definition.agents.length,
        guidelines: fn.definition.guidelines.length,
        tool_uses: fn.definition.tool_uses.length,
      },
      full,
    );
  }
  if (kind === 'tool-use') {
    const expectedScope: WorkspaceScope = { ...(scope ?? {}) };
    const functionId = expectedScope.function;
    let functionRoot = '';
    let membership = registry.tool_uses;
    if (functionId !== undefined) {
      const fn = loadFunction(root, registry, functionId, session);
      functionRoot = fn.root;
      membership = fn.definition.tool_uses;
      if (expectedScope.agent !== undefined) {
        const agent = loadAgent(root, registry, functionId, expectedScope.agent, session, fn);
        membership = agent.definition.tool_uses;
        if (expectedScope.plan !== undefined) {
          membership = loadPlan(root, fn, agent, expectedScope.plan, session).definition.tool_uses;
        }
      }
    }
    if (!membership.includes(id)) {
      throw workspaceFailure(
        'PARENT_NOT_FOUND',
        `'tool-use:${expectedQualifiedId(kind, id, expectedScope)}' is not registered.`,
        'Scaffold the tool-use beneath its exact workspace, function, agent, or plan owner first.',
        { kind, id, scope: expectedScope },
      );
    }
    const path = childRecordPath(functionRoot, expectedScope.agent ?? '', kind, id, expectedScope);
    const file = readAuthored(root, path, false, session);
    const definition = parseWorkspaceToolUseEnvelope(file.text, path);
    if (definition.id !== id) identityMismatch(path, id, definition.id);
    if (!toolUseScopeMatches(definition.scope, expectedScope)) {
      throw workspaceFailure(
        'IDENTITY_PATH_MISMATCH',
        `${path}: embedded tool-use scope does not match its registered physical owner.`,
        'Make the authored scope exactly match the workspace, function, agent, or plan that owns this file.',
        { path, expected_scope: expectedScope, actual_scope: definition.scope },
      );
    }
    return record(
      kind,
      qualifiedRecordId(kind, {
        ...(functionId === undefined ? {} : { functionId }),
        ...(expectedScope.agent === undefined ? {} : { agentId: expectedScope.agent }),
        ...(expectedScope.plan === undefined ? {} : { planId: expectedScope.plan }),
        localId: id,
      }),
      path,
      definition.purpose,
      { ...expectedScope } as Record<string, string>,
      file.bytes,
      {},
      full,
    );
  }
  const functionId = scope?.function;
  if (functionId === undefined) {
    throw workspaceFailure('PARENT_NOT_FOUND', `'${kind}:${id}' has no registered function scope.`, 'Pass the required qualified scope.', { kind, id });
  }
  const fn = loadFunction(root, registry, functionId, session);
  if (kind === 'agent') {
    const agent = loadAgent(root, registry, functionId, id, session, fn);
    return record(
      kind,
      qualifiedRecordId(kind, { functionId, agentId: id }),
      agent.path,
      agent.definition.purpose,
      { function: functionId },
      agent.bytes,
      {
        plans: agent.definition.plans.length,
        subagents: agent.definition.subagents.length,
        guidelines: agent.definition.guidelines.length,
        tool_uses: agent.definition.tool_uses.length,
        lessons: agent.definition.lessons.length,
      },
      full,
    );
  }
  if (kind === 'guideline' && scope?.agent === undefined) {
    if (!fn.definition.guidelines.includes(id)) {
      throw workspaceFailure('PARENT_NOT_FOUND', `Guideline '${functionId}/guidelines/${id}' is not registered.`, 'Scaffold the function guideline first.', { function: functionId, guideline: id });
    }
    const path = childRecordPath(fn.root, '', kind, id, { function: functionId });
    const file = readAuthored(root, path, true, session);
    const definition = parseMarkdownDefinition(file.text, path);
    assertMarkdownIdentity(path, { id, kind, scope: { function: functionId } }, definition);
    return record(kind, qualifiedRecordId(kind, { functionId, localId: id }), path, definition.purpose, { function: functionId }, file.bytes, {}, full);
  }
  const agentId = scope?.agent;
  if (agentId === undefined) {
    throw workspaceFailure('PARENT_NOT_FOUND', `'${kind}:${id}' has no registered agent scope.`, 'Pass the required qualified agent or plan scope.', { kind, id, function: functionId });
  }
  const agent = loadAgent(root, registry, functionId, agentId, session, fn);
  const membership = kind === 'plan'
    ? agent.definition.plans
    : kind === 'subagent'
      ? agent.definition.subagents
      : kind === 'guideline'
        ? agent.definition.guidelines
        : agent.definition.lessons;
  if (!membership.includes(id)) {
    throw workspaceFailure('PARENT_NOT_FOUND', `'${kind}:${expectedQualifiedId(kind, id, scope)}' is not registered.`, 'Scaffold the record beneath its registered agent first.', { kind, id, function: functionId, agent: agentId });
  }
  const path = childRecordPath(fn.root, agentId, kind, id, scope);
  const agentQualified = `${functionId}/${agentId}`;
  if (kind === 'guideline' || kind === 'lesson') {
    const file = readAuthored(root, path, true, session);
    const definition = parseMarkdownDefinition(file.text, path);
    if (kind === 'lesson' && definition.scope.plan !== undefined && !agent.definition.plans.includes(definition.scope.plan)) {
      throw workspaceFailure('PARENT_NOT_FOUND', `${path}: plan scope '${definition.scope.plan}' is not registered.`, 'Scaffold the plan before using it as lesson scope.', { path, plan: definition.scope.plan });
    }
    assertMarkdownIdentity(path, {
      id,
      kind,
      scope: {
        function: functionId,
        agent: agentId,
        ...(definition.scope.plan === undefined ? {} : { plan: definition.scope.plan }),
      },
    }, definition);
    const actualScope = {
      function: functionId,
      agent: agentId,
      ...(definition.scope.plan === undefined ? {} : { plan: definition.scope.plan }),
    };
    return record(kind, qualifiedRecordId(kind, { functionId, agentId, localId: id }), path, definition.purpose, actualScope, file.bytes, {}, full);
  }
  const file = readAuthored(root, path, false, session);
  if (kind === 'plan') {
    const definition = parsePlanEnvelope(file.text, path);
    if (definition.id !== id) identityMismatch(path, id, definition.id);
    if (definition.agent !== agentQualified) identityMismatch(path, agentQualified, definition.agent);
    return record(
      kind,
      qualifiedRecordId(kind, { functionId, agentId, localId: id }),
      path,
      definition.purpose,
      { function: functionId, agent: agentId },
      file.bytes,
      { tool_uses: definition.tool_uses.length },
      full,
    );
  }
  const definition = parseChildDefinition(kind, file.text, path);
  if (definition.id !== id) identityMismatch(path, id, definition.id);
  if (definition.agent !== agentQualified) identityMismatch(path, agentQualified, definition.agent);
  const actualScope = { function: functionId, agent: agentId };
  return record(kind, qualifiedRecordId(kind, { functionId, agentId, localId: id }), path, definition.purpose, actualScope, file.bytes, {}, full);
}

function localId(recordValue: WorkspaceDiscoveryRecord): string {
  if (recordValue.kind === 'function') return recordValue.qualified_id;
  if (recordValue.kind === 'agent') return recordValue.qualified_id.split('/').at(-1)!;
  if (recordValue.kind === 'plan') return recordValue.qualified_id.split('#').at(-1)!;
  return recordValue.qualified_id.split('/').at(-1)!;
}

// Stable English punctuation order for the bounded ASCII identity/path alphabet.
function lexicalWeight(code: number): number {
  if (code === 95) return 1;
  if (code === 45) return 2;
  if (code === 46) return 3;
  if (code === 47) return 4;
  if (code === 35) return 5;
  if (code >= 48 && code <= 57) return code - 40;
  if (code >= 97 && code <= 122) return code - 79;
  return code + 256;
}

function lexical(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    const difference = lexicalWeight(leftCode) - lexicalWeight(rightCode);
    if (difference !== 0) return difference;
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return left.length - right.length;
}

function scopeMatches(recordValue: WorkspaceDiscoveryRecord, scopeValue: string): boolean {
  const parsed = parseScope(scopeValue);
  if (parsed.kind === 'workspace') {
    return recordValue.kind === 'tool-use'
      && recordValue.scope.function === undefined
      && recordValue.scope.agent === undefined
      && recordValue.scope.plan === undefined;
  }
  if (parsed.kind === 'function') {
    return recordValue.qualified_id === parsed.qualifiedId || recordValue.scope.function === parsed.scope.function;
  }
  if (parsed.kind === 'agent') {
    return recordValue.qualified_id === parsed.qualifiedId
      || (recordValue.scope.function === parsed.scope.function && recordValue.scope.agent === parsed.scope.agent);
  }
  return recordValue.qualified_id === parsed.qualifiedId
    || (recordValue.scope.function === parsed.scope.function
      && recordValue.scope.agent === parsed.scope.agent
      && recordValue.scope.plan === parsed.scope.plan);
}

function filterWorkspaceRecords(
  source: readonly WorkspaceDiscoveryRecord[],
  options: DiscoverWorkspaceOptions = {},
): WorkspaceDiscoveryRecord[] {
  let records = [...source];
  if (options.kind !== undefined) records = records.filter((entry) => entry.kind === options.kind);
  if (options.scope !== undefined) records = records.filter((entry) => scopeMatches(entry, options.scope!));
  const query = options.query;
  if (query !== undefined) {
    if (options.exact) {
      records = records.filter((entry) => entry.qualified_id === query || localId(entry) === query || entry.path === query);
    } else if (query.length > 0) {
      const needle = query.toLocaleLowerCase('en-US');
      records = records.filter((entry) => [
        entry.qualified_id,
        localId(entry),
        entry.path,
        entry.purpose,
      ].some((value) => value.toLocaleLowerCase('en-US').includes(needle)));
    }
  }
  records.sort((a, b) => lexical(a.kind, b.kind)
    || lexical(a.qualified_id, b.qualified_id)
    || lexical(a.path, b.path));
  if (options.exact) {
    if (records.length === 0) {
      throw workspaceFailure('PARENT_NOT_FOUND', `No record exactly matches '${query ?? ''}'.`, 'Use roster discover without --exact to inspect available qualified identities.', { query: query ?? '', kind: options.kind ?? null });
    }
    if (records.length > 1) {
      throw workspaceFailure('IDENTITY_AMBIGUOUS', `Exact query '${query ?? ''}' matches multiple records.`, 'Pass a qualified identity and, if necessary, --kind.', { query: query ?? '', candidates: records.map((entry) => ({ kind: entry.kind, qualified_id: entry.qualified_id })) });
    }
  }
  return records;
}

function discoverWorkspaceUnchecked(root: string, options: DiscoverWorkspaceOptions = {}): DiscoverWorkspaceResult {
  const collected = collectWorkspaceRecords(root, options.full ?? false);
  let records: WorkspaceDiscoveryRecord[];
  try {
    records = filterWorkspaceRecords(collected.records, options);
  } catch (error) {
    if (!isWorkspaceFailure(error) || error.code !== 'PARENT_NOT_FOUND' || !options.exact) throw error;
    const query = options.query ?? '';
    const rejected = collected.diagnostics.filter((diagnostic) => (
      diagnostic.code === 'SECRET_MATERIAL_FORBIDDEN'
      && (options.kind === undefined || options.kind === 'tool-use')
      && (diagnostic.path === query
        || diagnostic.details['qualified_id'] === query
        || (typeof diagnostic.details['qualified_id'] === 'string'
          && localId({
            qualified_id: diagnostic.details['qualified_id'],
            kind: 'tool-use',
            path: diagnostic.path ?? '',
            purpose: '',
            scope: {},
            schema_version: 2,
            content_hash: '',
            references: {},
          }) === query))
    ));
    if (rejected.length === 0) throw error;
    return { ok: false, records: [], diagnostics: rejected };
  }
  return {
    ok: !collected.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    records,
    diagnostics: collected.diagnostics,
  };
}

export function discoverWorkspace(root: string, options: DiscoverWorkspaceOptions = {}): DiscoverWorkspaceResult {
  assertV2Workspace(root);
  return discoverWorkspaceUnchecked(root, options);
}

export function collectCompleteWorkspaceSnapshot(root: string): CompleteWorkspaceSnapshot {
  assertV2Workspace(root);
  const collected = collectWorkspaceRecords(root, true);
  const failure = collected.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (failure !== undefined) {
    throw workspaceFailure(
      failure.code,
      failure.message,
      failure.remedy ?? 'Repair the complete workspace registry before resolving tool guidance.',
      {
        ...failure.details,
        ...(failure.path === undefined ? {} : { path: failure.path }),
      },
    );
  }
  return mintCompleteWorkspaceSnapshot(collected.records);
}

export type PreparedVendorSkillMap = {
  snapshot: CompleteWorkspaceSnapshot;
  map: VendorSkillMap;
  content: string;
};

function throwWorkspaceDiagnostic(diagnostic: WorkspaceDiagnostic): never {
  throw workspaceFailure(
    diagnostic.code,
    diagnostic.message,
    diagnostic.remedy ?? 'Repair the workspace before retrying.',
    {
      ...diagnostic.details,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    },
  );
}

function buildExpectedVendorSkillMap(
  root: string,
  snapshot: CompleteWorkspaceSnapshot,
  ignoredDraftPaths: ReadonlySet<string> = new Set(),
  lattice: ToolUseLatticeValidationResult = validateToolUseLattice(snapshot),
): { map: VendorSkillMap; content: string; definitionCount: number } {
  const failure = lattice.diagnostics.find((diagnostic) => diagnostic.severity === 'error'
    && !(diagnostic.code === 'TOOL_USE_DRAFT_INCOMPLETE'
      && diagnostic.path !== undefined
      && ignoredDraftPaths.has(diagnostic.path)));
  if (failure !== undefined) throwWorkspaceDiagnostic(failure);
  const { registry } = readWorkspaceRegistry(root);
  const skillRefPaths = new Map<CanonicalSkillRef, Set<string>>();
  for (const resolution of lattice.resolutions) {
    const paths = skillRefPaths.get(resolution.effective.skill_ref) ?? new Set<string>();
    for (const contributor of resolution.contributors) paths.add(contributor.path);
    skillRefPaths.set(resolution.effective.skill_ref, paths);
  }
  const map = buildVendorSkillMap({
    workspaceRoot: root,
    skillRefs: lattice.definitions.map((definition) => definition.skill_ref),
    skillRefPaths: new Map([...skillRefPaths].map(([skillRef, paths]) => [skillRef, [...paths]])),
    enabledHosts: enabledV2Hosts(registry),
    manifest: readFounderSkillsManifest(root),
    lockfile: readLockfile(root),
    generatorVersion: getPackageVersion(),
  });
  return { map, content: serializeVendorSkillMap(map), definitionCount: lattice.definitions.length };
}

type ContextVendorVerificationState = {
  selection: ContextVendorSkillSelection;
  expectedContent: string;
  storedContent: string;
};

function contextVendorFailure(
  code: 'SKILL_REF_UNMAPPED' | 'SKILL_REF_DRIFTED',
  reason: string,
): never {
  throw workspaceFailure(
    code,
    code === 'SKILL_REF_UNMAPPED'
      ? 'Selected tool guidance is missing a canonical vendor-skill locator.'
      : 'Selected vendor-skill provenance changed during context resolution.',
    'Repair the selected tool definitions and reviewed vendor-skill artifacts, then run roster update.',
    { path: VENDOR_SKILL_MAP_PATH, reason },
  );
}

function readCanonicalStoredVendorSkillMap(root: string): {
  content: string;
  map: VendorSkillMap;
} {
  let bytes: Buffer;
  try {
    bytes = readWorkspaceFile(root, VENDOR_SKILL_MAP_PATH, {
      maxBytes: VENDOR_SKILL_MAP_MAX_BYTES,
    });
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') {
      return contextVendorFailure('SKILL_REF_UNMAPPED', 'stored-map-missing');
    }
    throw error;
  }
  const content = bytes.toString('utf8');
  const map = parseVendorSkillMap(content);
  if (map === null) return contextVendorFailure('SKILL_REF_DRIFTED', 'stored-map-not-canonical');
  return { content, map };
}

function deriveRestrictedVendorSkillMap(
  root: string,
  metadata: PreparedContextRegistryMetadata,
  selection: ContextVendorSkillSelection,
): { map: VendorSkillMap; content: string; selection: ContextVendorSkillSelection } {
  const selectedRefs = [...selection.skillRefs];
  const restrictedPaths = new Map<CanonicalSkillRef, readonly string[]>();
  for (const skillRef of selectedRefs) {
    restrictedPaths.set(skillRef, [...(selection.skillRefPaths.get(skillRef) ?? [])]);
  }
  const map = buildVendorSkillMap({
    workspaceRoot: root,
    skillRefs: selectedRefs,
    skillRefPaths: restrictedPaths,
    enabledHosts: metadata.enabled_hosts,
    manifest: readFounderSkillsManifest(root),
    lockfile: readLockfile(root),
    generatorVersion: getPackageVersion(),
  });
  const normalizedPaths = new Map<CanonicalSkillRef, readonly string[]>(
    map.skills.map((entry) => [entry.skill_ref, [...entry.authored_paths]]),
  );
  return {
    map,
    content: serializeVendorSkillMap(map),
    selection: {
      skillRefs: map.skills.map((entry) => entry.skill_ref),
      skillRefPaths: normalizedPaths,
    },
  };
}

function validateSelectedVendorProjection(
  stored: VendorSkillMap,
  expected: VendorSkillMap,
): void {
  if (stored.generator_version !== expected.generator_version) {
    contextVendorFailure('SKILL_REF_DRIFTED', 'stored-map-generator-version');
  }
  const storedByRef = new Map(stored.skills.map((entry) => [entry.skill_ref, entry]));
  for (const selected of expected.skills) {
    const current = storedByRef.get(selected.skill_ref);
    if (current === undefined) contextVendorFailure('SKILL_REF_UNMAPPED', 'selected-ref-missing');
    if (canonicalJson(current.hosts) !== canonicalJson(selected.hosts)) {
      contextVendorFailure('SKILL_REF_DRIFTED', 'selected-host-locator');
    }
    const currentPaths = new Set(current.authored_paths);
    if (!selected.authored_paths.every((path) => currentPaths.has(path))) {
      contextVendorFailure('SKILL_REF_DRIFTED', 'selected-authored-path');
    }
  }
}

function mintPreparedContextSource(
  collected: CollectedWorkspaceRecords,
): PreparedContextSource {
  const snapshot = mintCompleteWorkspaceSnapshot(collected.records);
  const registry = collected.loadedRegistry.registry;
  const source = {
    [PREPARED_CONTEXT_SOURCE]: true as const,
    snapshot,
    registry_metadata: {
      schema_version: registry.schema_version,
      workspace_id: registry.workspace_id,
      brain_binding: registry.brain?.binding ?? null,
      enabled_hosts: [...enabledV2Hosts(registry)],
    },
    registry_source_hash: collected.loadedRegistry.hash,
    counts: {
      records: collected.counts.records,
      content_bytes: collected.counts.contentBytes,
    },
  };
  freezeContextValue(source);
  PREPARED_CONTEXT_SOURCES.add(source);
  assertPreparedContextSource(source);
  return source;
}

function throwCollectedContextFailure(collected: CollectedWorkspaceRecords): void {
  const failure = collected.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (failure !== undefined) throwWorkspaceDiagnostic(failure);
}

function contextCapabilityFailure(reason: string): never {
  throw workspaceFailure(
    'CONTEXT_RESOLUTION_FAILED',
    'Context read capability was not completed through its terminal verifier.',
    'Retry context resolution through the registry-owned capability wrapper.',
    { reason },
  );
}

export function withContextReadCapability<T>(
  root: string,
  operation: (capability: ContextReadCapability) => T,
): T {
  const initialProbe = assertV2Workspace(root);
  const rootIdentity = initialProbe.session?.root;
  if (rootIdentity === undefined) contextCapabilityFailure('initial-probe-session-missing');
  const session = createWorkspaceReadSession(root, {
    deferParentChecks: true,
    contextMode: true,
    rootIdentity,
  });
  const collected = collectWorkspaceRecords(root, true, {
    session,
    contextBounds: true,
  });
  throwCollectedContextFailure(collected);
  const source = mintPreparedContextSource(collected);
  const registeredPaths = new Set(source.snapshot.records.map((record) => record.path));
  let vendorSelectionCalls = 0;
  let vendorState: ContextVendorVerificationState | null = null;
  let verificationCalls = 0;
  let callbackActive = true;

  const selectVendorSkillMap = (
    selection: ContextVendorSkillSelection,
  ): ContextVendorSkillProjection => {
    if (!callbackActive || verificationCalls > 0) contextCapabilityFailure('vendor-selection-after-terminal');
    vendorSelectionCalls += 1;
    if (vendorSelectionCalls !== 1) contextCapabilityFailure('vendor-selection-call-count');
    if (selection.skillRefs.length === 0) {
      return freezeContextValue({
        generator_version: getPackageVersion(),
        map_hash: null,
        skills: [] as VendorSkillMapEntry[],
      });
    }
    const stored = readCanonicalStoredVendorSkillMap(root);
    const expected = deriveRestrictedVendorSkillMap(root, source.registry_metadata, selection);
    validateSelectedVendorProjection(stored.map, expected.map);
    vendorState = {
      selection: expected.selection,
      expectedContent: expected.content,
      storedContent: stored.content,
    };
    return freezeContextValue({
      generator_version: stored.map.generator_version,
      map_hash: stored.map.map_hash,
      skills: cloneContextValue(expected.map.skills),
    });
  };

  const verify = (localRecordPaths: readonly string[]): void => {
    if (!callbackActive) contextCapabilityFailure('terminal-outside-callback');
    verificationCalls += 1;
    if (verificationCalls !== 1) contextCapabilityFailure('terminal-call-count');
    const paths = [...new Set(localRecordPaths)];
    if (paths.some((path) => !registeredPaths.has(path))) {
      contextCapabilityFailure('terminal-path-not-registered');
    }

    const terminalProbe = probeWorkspace(root);
    const terminalRoot = terminalProbe.session?.root;
    if (terminalProbe.kind !== 'v2'
      || terminalRoot === undefined
      || terminalRoot.dev !== rootIdentity.dev
      || terminalRoot.ino !== rootIdentity.ino) {
      throw workspaceFailure(
        'WRITE_CONFLICT',
        'Workspace classification changed during context resolution.',
        'Stop the concurrent workspace mutation and retry context resolution.',
        { path: '.', expected_kind: 'v2', actual_kind: terminalProbe.kind },
      );
    }

    if (vendorState !== null) {
      const currentStored = readCanonicalStoredVendorSkillMap(root);
      if (currentStored.content !== vendorState.storedContent) {
        contextVendorFailure('SKILL_REF_DRIFTED', 'stored-map-changed');
      }
      const currentExpected = deriveRestrictedVendorSkillMap(
        root,
        source.registry_metadata,
        vendorState.selection,
      );
      if (currentExpected.content !== vendorState.expectedContent) {
        contextVendorFailure('SKILL_REF_DRIFTED', 'selected-provenance-changed');
      }
      validateSelectedVendorProjection(currentStored.map, currentExpected.map);
    }
    session.verify(['roster.yaml', ...paths]);
  };

  const capability = Object.freeze({ source, selectVendorSkillMap, verify });
  let result: T;
  try {
    result = operation(capability);
  } finally {
    callbackActive = false;
  }
  if (result !== null
    && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as { then?: unknown }).then === 'function') {
    contextCapabilityFailure('async-callback-result');
  }
  if (verificationCalls !== 1) contextCapabilityFailure('terminal-call-count');
  return result;
}

export function prepareVendorSkillMap(root: string): PreparedVendorSkillMap {
  const snapshot = collectCompleteWorkspaceSnapshot(root);
  const expected = buildExpectedVendorSkillMap(root, snapshot);
  return { snapshot, map: expected.map, content: expected.content };
}

function validateVendorSkillMap(
  root: string,
  snapshot: CompleteWorkspaceSnapshot,
  ignoredDraftPaths: ReadonlySet<string> = new Set(),
  lattice?: ToolUseLatticeValidationResult,
): WorkspaceDiagnostic[] {
  try {
    const expected = buildExpectedVendorSkillMap(root, snapshot, ignoredDraftPaths, lattice);
    const current = tryReadWorkspaceFile(root, VENDOR_SKILL_MAP_PATH, { maxBytes: VENDOR_SKILL_MAP_MAX_BYTES });
    if (current === null && expected.definitionCount === 0) return [];
    if (current === null) {
      return [workspaceDiagnostic(
        'SKILL_REF_UNMAPPED',
        'Authored tool guidance requires a generated vendor-skill map.',
        {
          path: VENDOR_SKILL_MAP_PATH,
          remedy: 'Run roster update after completing every authored tool-use definition.',
          details: { path: VENDOR_SKILL_MAP_PATH },
        },
      )];
    }
    if (current.toString('utf8') !== expected.content) {
      if (ignoredDraftPaths.size > 0) {
        const parsed = parseVendorSkillMap(current.toString('utf8'));
        if (parsed !== null && parsed.generator_version === expected.map.generator_version) {
          const currentByRef = new Map(parsed.skills.map((entry) => [entry.skill_ref, entry]));
          const requiredEntriesMatch = expected.map.skills.every((entry) => {
            const currentEntry = currentByRef.get(entry.skill_ref);
            if (currentEntry === undefined
              || canonicalJson(currentEntry.hosts) !== canonicalJson(entry.hosts)) return false;
            const relevantCurrentPaths = currentEntry.authored_paths
              .filter((path) => !ignoredDraftPaths.has(path));
            return canonicalJson(relevantCurrentPaths) === canonicalJson(entry.authored_paths);
          });
          const expectedRefs = new Set(expected.map.skills.map((entry) => entry.skill_ref));
          const extrasAreIgnoredDrafts = parsed.skills
            .filter((entry) => !expectedRefs.has(entry.skill_ref))
            .every((entry) => entry.authored_paths.length > 0
              && entry.authored_paths.every((path) => ignoredDraftPaths.has(path))
              && Object.values(entry.hosts).every((locator) => locator.kind === 'host-native'));
          if (requiredEntriesMatch && extrasAreIgnoredDrafts) return [];
        }
      }
      return [workspaceDiagnostic(
        'SKILL_REF_DRIFTED',
        'The generated vendor-skill map is missing canonical bytes or no longer matches authored guidance.',
        {
          path: VENDOR_SKILL_MAP_PATH,
          remedy: 'Run roster update after repairing tool definitions and reviewed founder-skill metadata.',
          details: { path: VENDOR_SKILL_MAP_PATH },
        },
      )];
    }
    return [];
  } catch (error) {
    if (!isWorkspaceFailure(error)) throw error;
    return [diagnosticFromFailure(error)];
  }
}

function registeredForScaffold(
  kind: WorkspaceRecordKind,
  id: string,
  registry: WorkspaceRegistry,
  functionDefinition?: FunctionDefinition,
  agentDefinition?: AgentDefinition,
  planDefinition?: PlanEnvelope,
  scope?: WorkspaceScope,
): boolean {
  if (kind === 'function') return registry.functions[id] !== undefined;
  if (kind === 'tool-use') {
    if (scope?.function === undefined) return registry.tool_uses.includes(id);
    if (scope.agent === undefined) return functionDefinition?.tool_uses.includes(id) ?? false;
    if (scope.plan === undefined) return agentDefinition?.tool_uses.includes(id) ?? false;
    return planDefinition?.tool_uses.includes(id) ?? false;
  }
  if (kind === 'agent') return functionDefinition?.agents.includes(id) ?? false;
  if (kind === 'guideline' && agentDefinition === undefined) return functionDefinition?.guidelines.includes(id) ?? false;
  if (kind === 'plan') return agentDefinition?.plans.includes(id) ?? false;
  if (kind === 'subagent') return agentDefinition?.subagents.includes(id) ?? false;
  if (kind === 'guideline') return agentDefinition?.guidelines.includes(id) ?? false;
  return agentDefinition?.lessons.includes(id) ?? false;
}

function membershipField(kind: Exclude<WorkspaceRecordKind, 'function' | 'agent'>): keyof AgentDefinition | 'guidelines' {
  if (kind === 'plan') return 'plans';
  if (kind === 'subagent') return 'subagents';
  if (kind === 'guideline') return 'guidelines';
  if (kind === 'tool-use') return 'tool_uses';
  return 'lessons';
}

function expectedQualifiedId(kind: WorkspaceRecordKind, id: string, scope?: WorkspaceScope): string {
  if (kind === 'function') return id;
  if (kind === 'tool-use') {
    return qualifiedRecordId(kind, {
      ...(scope?.function === undefined ? {} : { functionId: scope.function }),
      ...(scope?.agent === undefined ? {} : { agentId: scope.agent }),
      ...(scope?.plan === undefined ? {} : { planId: scope.plan }),
      localId: id,
    });
  }
  if (scope?.function === undefined) {
    throw workspaceFailure('IDENTITY_INVALID', `Missing scope for '${kind}:${id}'.`, 'Pass the scope required by the scaffold kind.', { kind, id });
  }
  if (kind === 'agent') return qualifiedRecordId(kind, { functionId: scope.function, agentId: id });
  if (kind === 'guideline' && scope.agent === undefined) {
    return qualifiedRecordId(kind, { functionId: scope.function, localId: id });
  }
  return qualifiedRecordId(kind, { functionId: scope.function, agentId: scope.agent, localId: id });
}

function assertScaffoldScope(kind: WorkspaceRecordKind, scope: ReturnType<typeof parseScope> | undefined): void {
  const scopeKind = scope?.kind;
  const valid = kind === 'function'
    ? scopeKind === undefined
    : kind === 'agent'
      ? scopeKind === 'function'
      : kind === 'plan' || kind === 'subagent'
        ? scopeKind === 'agent'
        : kind === 'guideline'
          ? scopeKind === 'function' || scopeKind === 'agent'
          : kind === 'tool-use'
            ? scopeKind === 'workspace' || scopeKind === 'function' || scopeKind === 'agent' || scopeKind === 'plan'
            : scopeKind === 'agent' || scopeKind === 'plan';
  if (!valid) {
    throw workspaceFailure(
      'IDENTITY_INVALID',
      `Scope '${scope?.kind ?? '(none)'}' is invalid for scaffold kind '${kind}'.`,
      'Use the kind-specific scope grammar shown by roster --help.',
      { kind, scope: scope?.qualifiedId ?? null },
    );
  }
}

function requestedRecordScope(kind: WorkspaceRecordKind, scope: WorkspaceScope | undefined): Record<string, string> {
  if (kind === 'function') return {};
  if (kind === 'agent') return { function: scope!.function! };
  if (kind === 'tool-use') return { ...(scope ?? {}) } as Record<string, string>;
  if (kind === 'lesson') {
    return {
      function: scope!.function!,
      agent: scope!.agent!,
      ...(scope!.plan === undefined ? {} : { plan: scope!.plan }),
    };
  }
  return {
    function: scope!.function!,
    ...(scope!.agent === undefined ? {} : { agent: scope!.agent }),
  };
}

function assertRenderedScaffold(
  kind: WorkspaceRecordKind,
  id: string,
  scope: WorkspaceScope | undefined,
  targetPath: string,
  rendered: string,
  parentPath: string,
  updatedParent: string,
): void {
  if (kind === 'function') {
    const child = parseFunctionDefinition(rendered, targetPath);
    if (child.id !== id) identityMismatch(targetPath, id, child.id);
    const parent = parseWorkspaceRegistry(updatedParent, parentPath);
    if (parent.functions[id]?.path !== posix.dirname(targetPath)) {
      identityMismatch(parentPath, posix.dirname(targetPath), parent.functions[id]?.path ?? '(none)');
    }
    return;
  }
  if (kind === 'agent') {
    const child = parseAgentDefinition(rendered, targetPath);
    if (child.id !== id) identityMismatch(targetPath, id, child.id);
    if (child.function !== scope!.function) identityMismatch(targetPath, scope!.function!, child.function);
    const parent = parseFunctionDefinition(updatedParent, parentPath);
    if (!parent.agents.includes(id)) identityMismatch(parentPath, id, '(none)');
    return;
  }
  if (kind === 'tool-use') {
    const child = parseWorkspaceToolUseEnvelope(rendered, targetPath);
    if (child.id !== id) identityMismatch(targetPath, id, child.id);
    if (!toolUseScopeMatches(child.scope, scope ?? {})) {
      throw workspaceFailure(
        'IDENTITY_PATH_MISMATCH',
        `${targetPath}: rendered tool-use scope does not match its requested owner.`,
        'Retry scaffolding with the exact workspace, function, agent, or plan scope.',
        { path: targetPath, expected_scope: scope ?? {}, actual_scope: child.scope },
      );
    }
    const parentMembership = scope?.function === undefined
      ? parseWorkspaceRegistry(updatedParent, parentPath).tool_uses
      : scope.agent === undefined
        ? parseFunctionDefinition(updatedParent, parentPath).tool_uses
        : scope.plan === undefined
          ? parseAgentDefinition(updatedParent, parentPath).tool_uses
          : parsePlanEnvelope(updatedParent, parentPath).tool_uses;
    if (!parentMembership.includes(id)) identityMismatch(parentPath, id, '(none)');
    return;
  }
  if (kind === 'guideline' || kind === 'lesson') {
    const child = parseMarkdownDefinition(rendered, targetPath);
    assertMarkdownIdentity(targetPath, { id, kind, scope: scope! }, child);
  } else {
    const child = kind === 'plan'
      ? parsePlanEnvelope(rendered, targetPath)
      : parseChildDefinition(kind, rendered, targetPath);
    if (child.id !== id) identityMismatch(targetPath, id, child.id);
    const expectedAgent = `${scope!.function}/${scope!.agent}`;
    if (child.agent !== expectedAgent) identityMismatch(targetPath, expectedAgent, child.agent);
  }
  if (kind === 'guideline' && scope?.agent === undefined) {
    const parent = parseFunctionDefinition(updatedParent, parentPath);
    if (!parent.guidelines.includes(id)) identityMismatch(parentPath, id, '(none)');
    return;
  }
  const parent = parseAgentDefinition(updatedParent, parentPath);
  const field = membershipField(kind);
  if (!(parent[field] as string[]).includes(id)) identityMismatch(parentPath, id, '(none)');
}

export function scaffoldWorkspace(
  root: string,
  options: ScaffoldWorkspaceOptions,
  io: ScaffoldWorkspaceIo = realScaffoldWorkspaceIo,
): ScaffoldWorkspaceResult {
  const id = assertRecordId(options.id);
  const parsedScope = options.scope === undefined ? undefined : parseScope(options.scope);
  assertScaffoldScope(options.kind, parsedScope);
  assertV2Workspace(root);
  readWorkspaceRegistry(root);
  return withWorkspaceLock(root, () => {
    const loadedRegistry = readWorkspaceRegistry(root);
    const scope = parsedScope?.scope;
    const purpose = options.purpose ?? '';
    let fn: LoadedFunction | undefined;
    let agent: LoadedAgent | undefined;
    let plan: LoadedPlan | undefined;
    if (scope?.function !== undefined) fn = loadFunction(root, loadedRegistry.registry, scope.function);
    if (scope?.agent !== undefined) agent = loadAgent(root, loadedRegistry.registry, scope.function!, scope.agent, undefined, fn);
    if (scope?.plan !== undefined) {
      if (agent === undefined || fn === undefined) {
        throw workspaceFailure('PARENT_NOT_FOUND', `Plan '${parsedScope!.qualifiedId}' is not registered.`, `Run roster scaffold plan ${scope.plan} --scope agent:${scope.function}/${scope.agent} first.`, { plan: parsedScope!.qualifiedId });
      }
      plan = loadPlan(root, fn, agent, scope.plan);
    }
    const alreadyRegistered = registeredForScaffold(
      options.kind,
      id,
      loadedRegistry.registry,
      fn?.definition,
      agent?.definition,
      plan?.definition,
      scope,
    );
    const qualifiedId = expectedQualifiedId(options.kind, id, scope);
    if (alreadyRegistered) {
      const existing = resolveRegisteredRecord(root, options.kind, id, scope);
      const requestedScope = requestedRecordScope(options.kind, scope);
      if (JSON.stringify(existing.scope) !== JSON.stringify(requestedScope)) {
        throw workspaceFailure(
          'DUPLICATE_IDENTITY',
          `Identity '${options.kind}:${qualifiedId}' is already registered at a different scope.`,
          'Choose another local ID or keep the existing canonical scope.',
          { kind: options.kind, qualifiedId, existingScope: existing.scope, requestedScope },
        );
      }
      return { ok: true, status: 'existing', record: existing, diagnostics: [] };
    }

    let targetPath: string;
    let parentPath: string;
    let parentText: string;
    let parentHash: string;
    let updatedParent: string;
    let rendered: string;
    if (options.kind === 'function') {
      const functionRoot = posix.join('functions', id);
      targetPath = functionRecordPath(functionRoot);
      parentPath = 'roster.yaml';
      parentText = loadedRegistry.text;
      parentHash = loadedRegistry.hash;
      updatedParent = addWorkspaceFunction(parentText, parentPath, id, functionRoot);
      rendered = renderFunctionDefinition(id, purpose);
    } else if (options.kind === 'agent') {
      if (fn === undefined || scope?.function === undefined) {
        throw workspaceFailure('PARENT_NOT_FOUND', 'Agent scope has no registered function.', 'Pass --scope function:<function-id>.');
      }
      targetPath = agentRecordPath(fn.root, id);
      parentPath = fn.path;
      parentText = fn.text;
      parentHash = hashWorkspaceBytes(fn.bytes);
      updatedParent = addYamlMembership(parentText, parentPath, 'agents', id);
      rendered = renderAgentDefinition(scope.function, id, purpose);
    } else if (options.kind === 'tool-use') {
      const ownerScope = scope ?? {};
      targetPath = childRecordPath(fn?.root ?? '', ownerScope.agent ?? '', options.kind, id, ownerScope);
      if (ownerScope.function === undefined) {
        parentPath = 'roster.yaml';
        parentText = loadedRegistry.text;
        parentHash = loadedRegistry.hash;
      } else if (ownerScope.agent === undefined) {
        if (fn === undefined) {
          throw workspaceFailure('PARENT_NOT_FOUND', 'Tool-use function scope is not registered.', 'Pass a registered function scope.');
        }
        parentPath = fn.path;
        parentText = fn.text;
        parentHash = hashWorkspaceBytes(fn.bytes);
      } else if (ownerScope.plan === undefined) {
        if (agent === undefined) {
          throw workspaceFailure('PARENT_NOT_FOUND', 'Tool-use agent scope is not registered.', 'Pass a registered agent scope.');
        }
        parentPath = agent.path;
        parentText = agent.text;
        parentHash = hashWorkspaceBytes(agent.bytes);
      } else {
        if (plan === undefined) {
          throw workspaceFailure('PARENT_NOT_FOUND', 'Tool-use plan scope is not registered.', 'Pass a registered plan scope.');
        }
        parentPath = plan.path;
        parentText = plan.text;
        parentHash = hashWorkspaceBytes(plan.bytes);
      }
      updatedParent = addYamlMembership(parentText, parentPath, 'tool_uses', id);
      rendered = renderToolUseDraft(id, purpose, ownerScope);
    } else {
      if (fn === undefined || scope?.function === undefined) {
        throw workspaceFailure('PARENT_NOT_FOUND', `'${options.kind}' scope has no registered function.`, 'Pass a registered function or agent scope.');
      }
      const functionGuideline = options.kind === 'guideline' && scope.agent === undefined;
      if (!functionGuideline && agent === undefined) {
        throw workspaceFailure('PARENT_NOT_FOUND', `'${options.kind}' scope has no registered agent.`, 'Pass --scope agent:<function/agent>.');
      }
      targetPath = childRecordPath(fn.root, scope.agent ?? '', options.kind, id, scope);
      if (functionGuideline) {
        parentPath = fn.path;
        parentText = fn.text;
        parentHash = hashWorkspaceBytes(fn.bytes);
        updatedParent = addYamlMembership(parentText, parentPath, 'guidelines', id);
      } else {
        parentPath = agent!.path;
        parentText = agent!.text;
        parentHash = hashWorkspaceBytes(agent!.bytes);
        updatedParent = addYamlMembership(parentText, parentPath, membershipField(options.kind), id);
      }
      if (options.kind === 'guideline' || options.kind === 'lesson') {
        rendered = renderMarkdownDefinition(options.kind, id, purpose, scope);
      } else {
        rendered = renderChildDefinition(options.kind, scope.function, scope.agent!, id, purpose);
      }
    }

    assertRenderedScaffold(options.kind, id, scope, targetPath, rendered, parentPath, updatedParent);

    const directories = ensureWorkspaceDirectory(root, posix.dirname(targetPath)).creationTokens;
    let publication: PublicationResult;
    let creationIdentity: WorkspaceFileIdentityToken | undefined;
    try {
      publication = publishCreateOnly(root, targetPath, rendered, {
        captureCreation(token) {
          creationIdentity = token;
        },
      });
      try {
        io.replaceParent(root, parentPath, updatedParent, { expectedHash: parentHash });
      } catch (error) {
        let parentIsProvenUnchanged = false;
        try {
          parentIsProvenUnchanged = hashWorkspaceBytes(readWorkspaceFile(root, parentPath)) === parentHash;
        } catch {
          // An unreadable parent has unknown commit state; preserve the child for exact-byte recovery.
        }
        if (parentIsProvenUnchanged) {
          if (publication === 'created') {
            if (creationIdentity !== undefined) {
              removePublishedWorkspaceFile(root, targetPath, creationIdentity);
            }
          }
          removeEmptyWorkspaceDirectories(root, directories);
        }
        throw error;
      }
    } catch (error) {
      removeEmptyWorkspaceDirectories(root, directories);
      throw error;
    }
    const createdRecord = resolveRegisteredRecord(root, options.kind, id, scope);
    return { ok: true, status: publication, record: createdRecord, diagnostics: [] };
  });
}

function expectedSlotNames(ids: readonly string[], extension: '' | '.yaml' | '.md'): Set<string> {
  return new Set(ids.map((id) => `${id}${extension}`));
}

function inspectSlot(
  root: string,
  path: string,
  expected: Set<string>,
  expectedKind: 'file' | 'directory',
  diagnostics: WorkspaceDiagnostic[],
): void {
  try {
    for (const entry of enumerateWorkspaceSlot(root, path)) {
      if (entry.kind !== expectedKind || !expected.has(entry.name)) {
        diagnostics.push(workspaceDiagnostic('UNREGISTERED_RECORD', `Unregistered entry '${posix.join(path, entry.name)}'.`, {
          path: posix.join(path, entry.name),
          remedy: 'Remove it or adopt it through the matching explicit scaffold command.',
        }));
      }
    }
  } catch (error) {
    if (isWorkspaceFailure(error)) diagnostics.push(diagnosticFromFailure(error));
    else throw error;
  }
}

function inspectPlanSlot(
  root: string,
  fn: LoadedFunction,
  agent: LoadedAgent,
  diagnostics: WorkspaceDiagnostic[],
): void {
  const slot = posix.join(posix.dirname(agent.path), 'plans');
  let entries;
  try {
    entries = enumerateWorkspaceSlot(root, slot);
  } catch (error) {
    if (isWorkspaceFailure(error)) {
      diagnostics.push(diagnosticFromFailure(error));
      return;
    }
    throw error;
  }
  const planIds = new Set(agent.definition.plans);
  const presentCompanions = new Set<string>();
  for (const entry of entries) {
    const fileMatch = /^(.*)\.yaml$/.exec(entry.name);
    const acceptedFile = entry.kind === 'file' && fileMatch !== null && planIds.has(fileMatch[1]!);
    const acceptedCompanion = entry.kind === 'directory' && planIds.has(entry.name);
    if (acceptedCompanion) presentCompanions.add(entry.name);
    if (!acceptedFile && !acceptedCompanion) {
      diagnostics.push(workspaceDiagnostic('UNREGISTERED_RECORD', `Unregistered entry '${posix.join(slot, entry.name)}'.`, {
        path: posix.join(slot, entry.name),
        remedy: 'Remove it or adopt it through the matching explicit scaffold command.',
      }));
    }
  }
  for (const planId of [...presentCompanions].sort((a, b) => a.localeCompare(b, 'en'))) {
    let plan: LoadedPlan;
    try {
      plan = loadPlan(root, fn, agent, planId);
    } catch (error) {
      if (isWorkspaceFailure(error)) {
        diagnostics.push(diagnosticFromFailure(error));
        continue;
      }
      throw error;
    }
    const companion = planCompanionPath(fn.root, agent.definition.id, planId);
    inspectSlot(root, companion, new Set(['tools']), 'directory', diagnostics);
    inspectSlot(
      root,
      posix.join(companion, 'tools'),
      expectedSlotNames(plan.definition.tool_uses, '.yaml'),
      'file',
      diagnostics,
    );
  }
}

function collectOrphanDiagnostics(root: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const { registry } = readWorkspaceRegistry(root);
  inspectSlot(
    root,
    'functions',
    new Set(Object.values(registry.functions)
      .filter((entry) => entry.path.startsWith('functions/'))
      .map((entry) => entry.path.split('/')[1]!)),
    'directory',
    diagnostics,
  );
  inspectSlot(root, 'tools', expectedSlotNames(registry.tool_uses, '.yaml'), 'file', diagnostics);
  for (const functionId of Object.keys(registry.functions).sort()) {
    let fn: LoadedFunction;
    try {
      fn = loadFunction(root, registry, functionId);
    } catch (error) {
      if (isWorkspaceFailure(error)) {
        diagnostics.push(diagnosticFromFailure(error));
        continue;
      }
      throw error;
    }
    inspectSlot(root, posix.join(fn.root, 'agents'), expectedSlotNames(fn.definition.agents, ''), 'directory', diagnostics);
    inspectSlot(root, posix.join(fn.root, 'guidelines'), expectedSlotNames(fn.definition.guidelines, '.md'), 'file', diagnostics);
    inspectSlot(root, posix.join(fn.root, 'tools'), expectedSlotNames(fn.definition.tool_uses, '.yaml'), 'file', diagnostics);
    for (const agentId of fn.definition.agents) {
      let agent: LoadedAgent;
      try {
        agent = loadAgent(root, registry, functionId, agentId, undefined, fn);
      } catch (error) {
        if (isWorkspaceFailure(error)) {
          diagnostics.push(diagnosticFromFailure(error));
          continue;
        }
        throw error;
      }
      const base = posix.dirname(agent.path);
      inspectPlanSlot(root, fn, agent, diagnostics);
      inspectSlot(root, posix.join(base, 'subagents'), expectedSlotNames(agent.definition.subagents, '.yaml'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'guidelines'), expectedSlotNames(agent.definition.guidelines, '.md'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'tools'), expectedSlotNames(agent.definition.tool_uses, '.yaml'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'playbook'), expectedSlotNames(agent.definition.lessons, '.md'), 'file', diagnostics);
    }
  }
  return diagnostics;
}

type TargetedPlanToolUseRelevance = ReadonlyArray<{
  localIds: ReadonlySet<string>;
  scope: WorkspaceScope;
}>;

function collectTargetedPlanToolUseRelevance(
  records: readonly WorkspaceDiscoveryRecord[],
  target: WorkspaceDiscoveryRecord,
): TargetedPlanToolUseRelevance | undefined {
  if (target.kind !== 'plan') return undefined;
  const parsed = new Map<string, StructuredPlan>();
  for (const recordValue of records) {
    if (recordValue.kind !== 'plan' || recordValue.content === undefined) continue;
    try {
      parsed.set(recordValue.qualified_id, parseStructuredPlan(recordValue.content, recordValue.path));
    } catch {
      continue;
    }
  }
  const contexts: Array<{ localIds: ReadonlySet<string>; scope: WorkspaceScope }> = [];
  const visited = new Set<string>();
  const pending = [target.qualified_id];
  while (pending.length > 0) {
    const qualifiedId = pending.pop()!;
    if (visited.has(qualifiedId)) continue;
    visited.add(qualifiedId);
    const plan = parsed.get(qualifiedId);
    if (plan === undefined) continue;
    const [functionId, agentId] = plan.agent.split('/');
    if (functionId === undefined || agentId === undefined) continue;
    const localIds = new Set(plan.tool_uses);
    for (const step of plan.steps) {
      if (step.kind === 'tool') localIds.add(step.tool_use);
      if (step.kind === 'nested-plan') pending.push(step.plan);
    }
    contexts.push({
      localIds,
      scope: { function: functionId, agent: agentId, plan: plan.id },
    });
  }
  return contexts;
}

function toolUseScopeAppliesToContext(
  draft: WorkspaceDiscoveryRecord,
  context: WorkspaceScope,
): boolean {
  return draft.scope.function === undefined
    || (draft.scope.function === context.function
      && (draft.scope.agent === undefined
        || (draft.scope.agent === context.agent
          && (draft.scope.plan === undefined || draft.scope.plan === context.plan))));
}

function toolDraftAppliesToTarget(
  draft: WorkspaceDiscoveryRecord,
  target: WorkspaceDiscoveryRecord,
  targetedPlanRelevance?: TargetedPlanToolUseRelevance,
): boolean {
  if (draft.kind !== 'tool-use') return false;
  if (target.kind === 'plan' && targetedPlanRelevance !== undefined) {
    const id = localId(draft);
    return targetedPlanRelevance.some((context) => (
      context.localIds.has(id) && toolUseScopeAppliesToContext(draft, context.scope)
    ));
  }
  if (target.kind === 'function') {
    return draft.scope.function === undefined || draft.scope.function === target.qualified_id;
  }
  if (target.kind === 'agent') {
    const [functionId, agentId] = target.qualified_id.split('/');
    return draft.scope.function === undefined
      || (draft.scope.function === functionId
        && (draft.scope.agent === undefined || draft.scope.agent === agentId));
  }
  if (target.kind === 'plan') {
    const [agentQualified, planId] = target.qualified_id.split('#');
    const [functionId, agentId] = agentQualified!.split('/');
    return draft.scope.function === undefined
      || (draft.scope.function === functionId
        && (draft.scope.agent === undefined
          || (draft.scope.agent === agentId
            && (draft.scope.plan === undefined || draft.scope.plan === planId))));
  }
  return target.kind === 'tool-use'
    && localId(draft) === localId(target)
    && toolUseScopeAppliesToContext(draft, target.scope);
}

export function validateWorkspace(
  root: string,
  options: { target?: string; skipVendorSkillMap?: boolean } = {},
): ValidateWorkspaceResult {
  assertV2Workspace(root);
  const checks: StructuralCheck[] = [];
  const diagnostics: WorkspaceDiagnostic[] = [];
  let allRecords: WorkspaceDiscoveryRecord[] = [];
  let selectedRecords: WorkspaceDiscoveryRecord[] = [];
  let completeSnapshot: CompleteWorkspaceSnapshot | undefined;
  let declaredRegistryPassed = false;
  let toolLatticePassed = false;
  let toolLattice: ToolUseLatticeValidationResult | undefined;
  const ignoredDraftPaths = new Set<string>();
  try {
    const collected = collectWorkspaceRecords(root, true);
    allRecords = collected.records;
    diagnostics.push(...collected.diagnostics);
    selectedRecords = filterWorkspaceRecords(allRecords, {
      ...(options.target === undefined ? {} : { query: options.target, exact: true }),
      full: true,
    });
    declaredRegistryPassed = !collected.diagnostics.some((entry) => entry.severity === 'error');
    if (declaredRegistryPassed) completeSnapshot = mintCompleteWorkspaceSnapshot(allRecords);
    checks.push({
      name: 'declared-registry',
      severity: 'error',
      status: declaredRegistryPassed ? 'pass' : 'fail',
      details: {
        records: selectedRecords.length,
        ...(declaredRegistryPassed ? {} : { diagnostics: collected.diagnostics.length }),
      },
    });
  } catch (error) {
    if (!isWorkspaceFailure(error)) throw error;
    diagnostics.push(diagnosticFromFailure(error));
    checks.push({
      name: 'declared-registry',
      severity: 'error',
      status: 'fail',
      details: { code: error.code },
    });
  }
  if (!declaredRegistryPassed || completeSnapshot === undefined) {
    checks.push({
      name: 'tool-use-lattice',
      severity: 'error',
      status: 'fail',
      details: { blocked_by: 'declared-registry', diagnostics: 0 },
    });
  } else {
    const lattice = validateToolUseLattice(completeSnapshot);
    toolLattice = lattice;
    const selectedTarget = options.target === undefined ? undefined : selectedRecords[0];
    const targetedPlanRelevance = selectedTarget === undefined
      ? undefined
      : collectTargetedPlanToolUseRelevance(completeSnapshot.records, selectedTarget);
    const latticeDiagnostics = lattice.diagnostics.filter((diagnostic) => {
      if (diagnostic.code !== 'TOOL_USE_DRAFT_INCOMPLETE'
        || diagnostic.path === undefined
        || selectedTarget === undefined) return true;
      const record = allRecords.find((candidate) => candidate.path === diagnostic.path);
      if (record === undefined || toolDraftAppliesToTarget(record, selectedTarget, targetedPlanRelevance)) return true;
      ignoredDraftPaths.add(diagnostic.path);
      return false;
    });
    diagnostics.push(...latticeDiagnostics);
    toolLatticePassed = !latticeDiagnostics.some((entry) => entry.severity === 'error');
    checks.push({
      name: 'tool-use-lattice',
      severity: 'error',
      status: toolLatticePassed ? 'pass' : 'fail',
      details: {
        definitions: lattice.definitions.length,
        resolutions: lattice.resolutions.length,
        diagnostics: latticeDiagnostics.length,
        ...(ignoredDraftPaths.size === 0 ? {} : { ignored_unrelated_drafts: ignoredDraftPaths.size }),
      },
    });
  }
  if (options.skipVendorSkillMap === true) {
    checks.push({
      name: 'vendor-skill-map',
      severity: 'error',
      status: 'pass',
      details: { skipped_for: 'founder-skills-sync', diagnostics: 0 },
    });
  } else if (!toolLatticePassed || completeSnapshot === undefined) {
    checks.push({
      name: 'vendor-skill-map',
      severity: 'error',
      status: 'fail',
      details: { blocked_by: declaredRegistryPassed ? 'tool-use-lattice' : 'declared-registry', diagnostics: 0 },
    });
  } else {
    const mapDiagnostics = validateVendorSkillMap(root, completeSnapshot, ignoredDraftPaths, toolLattice);
    diagnostics.push(...mapDiagnostics);
    checks.push({
      name: 'vendor-skill-map',
      severity: 'error',
      status: mapDiagnostics.some((entry) => entry.severity === 'error') ? 'fail' : 'pass',
      details: { diagnostics: mapDiagnostics.length },
    });
  }
  if (!declaredRegistryPassed || completeSnapshot === undefined) {
    checks.push({
      name: 'structured-plans',
      severity: 'error',
      status: 'fail',
      details: { blocked_by: 'declared-registry', diagnostics: 0 },
    });
  } else {
    let roots: string[] | undefined;
    if (options.target !== undefined) {
      const selected = selectedRecords[0]!;
      roots = selected.kind === 'plan'
        ? [selected.qualified_id]
        : selected.kind === 'agent'
          ? allRecords
            .filter((record) => record.kind === 'plan'
              && record.scope.function === selected.qualified_id.split('/')[0]
              && record.scope.agent === selected.qualified_id.split('/')[1])
            .map((record) => record.qualified_id)
          : selected.kind === 'function'
            ? allRecords
              .filter((record) => record.kind === 'plan' && record.scope.function === selected.qualified_id)
              .map((record) => record.qualified_id)
            : [];
    }
    const structured = validateStructuredPlans(completeSnapshot.records, roots, completeSnapshot);
    diagnostics.push(...structured.diagnostics);
    checks.push({
      name: 'structured-plans',
      severity: 'error',
      status: structured.diagnostics.some((entry) => entry.severity === 'error') ? 'fail' : 'pass',
      details: {
        plans: structured.selected_plan_ids.length,
        diagnostics: structured.diagnostics.length,
      },
    });
  }
  try {
    const orphanDiagnostics = collectOrphanDiagnostics(root);
    diagnostics.push(...orphanDiagnostics);
    checks.push({
      name: 'registered-slots',
      severity: 'error',
      status: orphanDiagnostics.some((entry) => entry.severity === 'error') ? 'fail' : 'pass',
      details: { diagnostics: orphanDiagnostics.length },
    });
  } catch (error) {
    if (!isWorkspaceFailure(error)) throw error;
    diagnostics.push(diagnosticFromFailure(error));
    checks.push({
      name: 'registered-slots',
      severity: 'error',
      status: 'fail',
      details: { code: error.code },
    });
  }
  const machinePathPattern = /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/;
  const machinePathDiagnostics = selectedRecords
    .filter((entry) => entry.content !== undefined && machinePathPattern.test(entry.content))
    .map((entry) => workspaceDiagnostic(
      'PATH_ESCAPE',
      `${entry.path}: contains a literal machine-specific absolute path.`,
      {
        path: entry.path,
        remedy: 'Use a workspace-relative path or an explicit runtime configuration reference.',
        details: { qualifiedId: entry.qualified_id },
      },
    ));
  diagnostics.push(...machinePathDiagnostics);
  checks.push({
    name: 'portable-authored-paths',
    severity: 'error',
    status: machinePathDiagnostics.length === 0 ? 'pass' : 'fail',
    details: { diagnostics: machinePathDiagnostics.length },
  });
  const generatedDiagnostics = validateGeneratedArtifacts(root);
  diagnostics.push(...generatedDiagnostics);
  checks.push({
    name: 'generated-artifacts',
    severity: 'error',
    status: generatedDiagnostics.some((entry) => entry.severity === 'error') ? 'fail' : 'pass',
    details: { diagnostics: generatedDiagnostics.length },
  });
  diagnostics.sort((a, b) => a.code.localeCompare(b.code, 'en')
    || (a.path ?? '').localeCompare(b.path ?? '', 'en')
    || a.message.localeCompare(b.message, 'en'));
  return {
    ok: !diagnostics.some((entry) => entry.severity === 'error'),
    checks,
    diagnostics,
  };
}
