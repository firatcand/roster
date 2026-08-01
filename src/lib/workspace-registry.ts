import { posix } from 'node:path';
import {
  childRecordPath,
  functionRecordPath,
  agentRecordPath,
  assertRecordId,
  parseScope,
  qualifiedRecordId,
  type WorkspaceRecordKind,
  type WorkspaceScope,
} from './workspace-layout.ts';
import {
  addWorkspaceFunction,
  addYamlMembership,
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
  type AgentDefinition,
  type FunctionDefinition,
  type WorkspaceRegistry,
  MAX_AUTHORED_MARKDOWN_BYTES,
  MAX_AUTHORED_YAML_BYTES,
} from './workspace-record.ts';
import { validateStructuredPlans } from './workspace-plan.ts';
import {
  ensureWorkspaceDirectory,
  enumerateWorkspaceSlot,
  createWorkspaceReadSession,
  hashWorkspaceBytes,
  publishCreateOnly,
  readWorkspaceFile,
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
  ok: true;
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

function assertV2Workspace(root: string): void {
  const probe = probeWorkspace(root);
  if (probe.kind === 'v2') return;
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

function pushRecord(target: WorkspaceDiscoveryRecord[], identities: Set<string>, value: WorkspaceDiscoveryRecord): void {
  const key = `${value.kind}\u0000${value.qualified_id}`;
  if (identities.has(key)) {
    throw workspaceFailure('DUPLICATE_IDENTITY', `Identity '${value.kind}:${value.qualified_id}' is registered more than once.`, 'Keep one canonical parent membership for the record.', { kind: value.kind, qualifiedId: value.qualified_id });
  }
  identities.add(key);
  target.push(value);
}

function collectWorkspaceRecords(root: string, full: boolean): WorkspaceDiscoveryRecord[] {
  const session = createWorkspaceReadSession(root, { deferParentChecks: true });
  const { registry } = readWorkspaceRegistry(root, session);
  const records: WorkspaceDiscoveryRecord[] = [];
  const identities = new Set<string>();
  const functionIds = Object.keys(registry.functions).sort((a, b) => a.localeCompare(b, 'en'));
  for (const functionId of functionIds) {
    const fn = loadFunction(root, registry, functionId, session);
    pushRecord(records, identities, record(
      'function',
      functionId,
      fn.path,
      fn.definition.purpose,
      {},
      fn.bytes,
      { agents: fn.definition.agents.length, guidelines: fn.definition.guidelines.length },
      full,
    ));

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
      ));
    }

    for (const agentId of fn.definition.agents) {
      const agent = loadAgent(root, registry, functionId, agentId, session, fn);
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
      ));

      for (const planId of agent.definition.plans) {
        const path = childRecordPath(fn.root, agentId, 'plan', planId);
        const file = readAuthored(root, path, false, session);
        const definition = parsePlanEnvelope(file.text, path);
        if (definition.id !== planId) identityMismatch(path, planId, definition.id);
        if (definition.agent !== agentQualified) identityMismatch(path, agentQualified, definition.agent);
        pushRecord(records, identities, record(
          'plan',
          qualifiedRecordId('plan', { functionId, agentId, localId: planId }),
          path,
          definition.purpose,
          { function: functionId, agent: agentId },
          file.bytes,
          {},
          full,
        ));
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
        ));
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
        ));
      }

      for (const toolId of agent.definition.tool_uses) {
        const path = childRecordPath(fn.root, agentId, 'tool-use', toolId);
        const file = readAuthored(root, path, false, session);
        const definition = parseChildDefinition('tool-use', file.text, path);
        if (definition.id !== toolId) identityMismatch(path, toolId, definition.id);
        if (definition.agent !== agentQualified) identityMismatch(path, agentQualified, definition.agent);
        if (definition.scope === undefined || definition.scope.function !== functionId || definition.scope.agent !== agentId) {
          identityMismatch(path, agentQualified, definition.scope === undefined ? '(none)' : `${definition.scope.function}/${definition.scope.agent ?? ''}`);
        }
        if (definition.scope.plan !== undefined && !agent.definition.plans.includes(definition.scope.plan)) {
          throw workspaceFailure('PARENT_NOT_FOUND', `${path}: plan scope '${definition.scope.plan}' is not registered.`, 'Scaffold the plan before using it as tool-use scope.', { path, plan: definition.scope.plan });
        }
        const scope = {
          function: functionId,
          agent: agentId,
          ...(definition.scope.plan === undefined ? {} : { plan: definition.scope.plan }),
        };
        pushRecord(records, identities, record(
          'tool-use',
          qualifiedRecordId('tool-use', { functionId, agentId, localId: toolId }),
          path,
          definition.purpose,
          scope,
          file.bytes,
          {},
          full,
        ));
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
        ));
      }
    }
  }
  session.verify();
  return records;
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
      { agents: fn.definition.agents.length, guidelines: fn.definition.guidelines.length },
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
        : kind === 'tool-use'
          ? agent.definition.tool_uses
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
    return record(kind, qualifiedRecordId(kind, { functionId, agentId, localId: id }), path, definition.purpose, { function: functionId, agent: agentId }, file.bytes, {}, full);
  }
  const definition = parseChildDefinition(kind, file.text, path);
  if (definition.id !== id) identityMismatch(path, id, definition.id);
  if (definition.agent !== agentQualified) identityMismatch(path, agentQualified, definition.agent);
  if (kind === 'tool-use') {
    if (definition.scope === undefined || definition.scope.function !== functionId || definition.scope.agent !== agentId) {
      identityMismatch(path, agentQualified, definition.scope === undefined ? '(none)' : `${definition.scope.function}/${definition.scope.agent ?? ''}`);
    }
    if (definition.scope.plan !== undefined && !agent.definition.plans.includes(definition.scope.plan)) {
      throw workspaceFailure('PARENT_NOT_FOUND', `${path}: plan scope '${definition.scope.plan}' is not registered.`, 'Scaffold the plan before using it as tool-use scope.', { path, plan: definition.scope.plan });
    }
  }
  const actualScope = {
    function: functionId,
    agent: agentId,
    ...(kind === 'tool-use' && definition.scope?.plan !== undefined ? { plan: definition.scope.plan } : {}),
  };
  return record(kind, qualifiedRecordId(kind, { functionId, agentId, localId: id }), path, definition.purpose, actualScope, file.bytes, {}, full);
}

function localId(recordValue: WorkspaceDiscoveryRecord): string {
  if (recordValue.kind === 'function') return recordValue.qualified_id;
  if (recordValue.kind === 'agent') return recordValue.qualified_id.split('/').at(-1)!;
  if (recordValue.kind === 'plan') return recordValue.qualified_id.split('#').at(-1)!;
  return recordValue.qualified_id.split('/').at(-1)!;
}

function scopeMatches(recordValue: WorkspaceDiscoveryRecord, scopeValue: string): boolean {
  const parsed = parseScope(scopeValue);
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
  records.sort((a, b) => a.kind.localeCompare(b.kind, 'en')
    || a.qualified_id.localeCompare(b.qualified_id, 'en')
    || a.path.localeCompare(b.path, 'en'));
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
  const records = filterWorkspaceRecords(collectWorkspaceRecords(root, options.full ?? false), options);
  return { ok: true, records, diagnostics: [] };
}

export function discoverWorkspace(root: string, options: DiscoverWorkspaceOptions = {}): DiscoverWorkspaceResult {
  assertV2Workspace(root);
  return discoverWorkspaceUnchecked(root, options);
}

function registeredForScaffold(
  kind: WorkspaceRecordKind,
  id: string,
  registry: WorkspaceRegistry,
  functionDefinition?: FunctionDefinition,
  agentDefinition?: AgentDefinition,
): boolean {
  if (kind === 'function') return registry.functions[id] !== undefined;
  if (kind === 'agent') return functionDefinition?.agents.includes(id) ?? false;
  if (kind === 'guideline' && agentDefinition === undefined) return functionDefinition?.guidelines.includes(id) ?? false;
  if (kind === 'plan') return agentDefinition?.plans.includes(id) ?? false;
  if (kind === 'subagent') return agentDefinition?.subagents.includes(id) ?? false;
  if (kind === 'guideline') return agentDefinition?.guidelines.includes(id) ?? false;
  if (kind === 'tool-use') return agentDefinition?.tool_uses.includes(id) ?? false;
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

function assertPlanScopeHealthy(root: string, fn: LoadedFunction, agent: LoadedAgent, planId: string): void {
  if (!agent.definition.plans.includes(planId)) {
    throw workspaceFailure('PARENT_NOT_FOUND', `Plan '${agent.definition.function}/${agent.definition.id}#${planId}' is not registered.`, 'Scaffold the plan before using it as a scope.', { plan: planId });
  }
  const path = childRecordPath(fn.root, agent.definition.id, 'plan', planId);
  const file = readAuthored(root, path);
  const definition = parsePlanEnvelope(file.text, path);
  const expectedAgent = `${agent.definition.function}/${agent.definition.id}`;
  if (definition.id !== planId) identityMismatch(path, planId, definition.id);
  if (definition.agent !== expectedAgent) identityMismatch(path, expectedAgent, definition.agent);
}

function requestedRecordScope(kind: WorkspaceRecordKind, scope: WorkspaceScope | undefined): Record<string, string> {
  if (kind === 'function') return {};
  if (kind === 'agent') return { function: scope!.function! };
  if (kind === 'tool-use' || kind === 'lesson') {
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
    if (scope?.function !== undefined) fn = loadFunction(root, loadedRegistry.registry, scope.function);
    if (scope?.agent !== undefined) agent = loadAgent(root, loadedRegistry.registry, scope.function!, scope.agent, undefined, fn);
    if (scope?.plan !== undefined) {
      if (agent === undefined || fn === undefined) {
        throw workspaceFailure('PARENT_NOT_FOUND', `Plan '${parsedScope!.qualifiedId}' is not registered.`, `Run roster scaffold plan ${scope.plan} --scope agent:${scope.function}/${scope.agent} first.`, { plan: parsedScope!.qualifiedId });
      }
      assertPlanScopeHealthy(root, fn, agent, scope.plan);
    }
    const alreadyRegistered = registeredForScaffold(
      options.kind,
      id,
      loadedRegistry.registry,
      fn?.definition,
      agent?.definition,
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
        rendered = renderChildDefinition(options.kind, scope.function, scope.agent!, id, purpose, scope);
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
      inspectSlot(root, posix.join(base, 'plans'), expectedSlotNames(agent.definition.plans, '.yaml'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'subagents'), expectedSlotNames(agent.definition.subagents, '.yaml'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'guidelines'), expectedSlotNames(agent.definition.guidelines, '.md'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'tools'), expectedSlotNames(agent.definition.tool_uses, '.yaml'), 'file', diagnostics);
      inspectSlot(root, posix.join(base, 'playbook'), expectedSlotNames(agent.definition.lessons, '.md'), 'file', diagnostics);
    }
  }
  return diagnostics;
}

export function validateWorkspace(root: string, options: { target?: string } = {}): ValidateWorkspaceResult {
  assertV2Workspace(root);
  const checks: StructuralCheck[] = [];
  const diagnostics: WorkspaceDiagnostic[] = [];
  let allRecords: WorkspaceDiscoveryRecord[] = [];
  let selectedRecords: WorkspaceDiscoveryRecord[] = [];
  let declaredRegistryPassed = false;
  try {
    allRecords = collectWorkspaceRecords(root, true);
    selectedRecords = filterWorkspaceRecords(allRecords, {
      ...(options.target === undefined ? {} : { query: options.target, exact: true }),
      full: true,
    });
    declaredRegistryPassed = true;
    checks.push({
      name: 'declared-registry',
      severity: 'error',
      status: 'pass',
      details: { records: selectedRecords.length },
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
  if (!declaredRegistryPassed) {
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
    const structured = validateStructuredPlans(allRecords, roots);
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
