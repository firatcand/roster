import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { workspaceFailure } from './workspace-diagnostics.ts';

export const WORKSPACE_SCHEMA_VERSION = 2 as const;
export const MAX_ID_BYTES = 80;

export const WORKSPACE_RECORD_KINDS = [
  'function',
  'agent',
  'plan',
  'subagent',
  'guideline',
  'tool-use',
  'lesson',
] as const;

export type WorkspaceRecordKind = (typeof WORKSPACE_RECORD_KINDS)[number];
export type ScopeKind = 'function' | 'agent' | 'plan';

export type WorkspaceScope = {
  function?: string;
  agent?: string;
  plan?: string;
};

export type ParsedScope = {
  kind: ScopeKind;
  qualifiedId: string;
  scope: Required<Pick<WorkspaceScope, 'function'>> & WorkspaceScope;
};

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ROSTER_RESERVED_PATHS = Object.freeze([
  '.agents',
  '.claude',
  '.codex',
  '.git',
  '.roster',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'ROSTER.md',
  'config/project.yaml',
  'roster.yaml',
  'roster',
] as const);

const RESERVED_FIRST_COMPONENTS = new Set(
  ROSTER_RESERVED_PATHS.map((path) => path.split('/')[0]!.toLocaleLowerCase('en-US')),
);

function identityFailure(value: string, label: string): never {
  throw workspaceFailure(
    'IDENTITY_INVALID',
    `Invalid ${label} '${value}'.`,
    `${label} must be lowercase kebab-case, at most ${MAX_ID_BYTES} UTF-8 bytes, and not a reserved platform name.`,
    { value, label },
  );
}

export function isRecordId(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
    && ID_PATTERN.test(value)
    && value !== '.'
    && value !== '..'
    && !WINDOWS_RESERVED.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function assertRecordId(value: string): string {
  if (!isRecordId(value)) identityFailure(value, 'record id');
  return value;
}

export function assertWorkspaceId(value: string): string {
  if (!isRecordId(value)) identityFailure(value, 'workspace id');
  return value;
}

export function isWorkspaceRecordKind(value: string): value is WorkspaceRecordKind {
  return (WORKSPACE_RECORD_KINDS as readonly string[]).includes(value);
}

export function parseAgentQualifiedId(value: string): { functionId: string; agentId: string } {
  const parts = value.split('/');
  if (parts.length !== 2) identityFailure(value, 'agent qualified id');
  return { functionId: assertRecordId(parts[0]!), agentId: assertRecordId(parts[1]!) };
}

export function parsePlanQualifiedId(value: string): {
  functionId: string;
  agentId: string;
  planId: string;
} {
  const hash = value.indexOf('#');
  if (hash <= 0 || hash !== value.lastIndexOf('#')) identityFailure(value, 'plan qualified id');
  const agent = parseAgentQualifiedId(value.slice(0, hash));
  return { ...agent, planId: assertRecordId(value.slice(hash + 1)) };
}

export function parseScope(value: string): ParsedScope {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator !== value.lastIndexOf(':')) identityFailure(value, 'scope');
  const kind = value.slice(0, separator);
  const qualifiedId = value.slice(separator + 1);
  if (kind === 'function') {
    const functionId = assertRecordId(qualifiedId);
    return { kind, qualifiedId: functionId, scope: { function: functionId } };
  }
  if (kind === 'agent') {
    const { functionId, agentId } = parseAgentQualifiedId(qualifiedId);
    return {
      kind,
      qualifiedId: `${functionId}/${agentId}`,
      scope: { function: functionId, agent: agentId },
    };
  }
  if (kind === 'plan') {
    const { functionId, agentId, planId } = parsePlanQualifiedId(qualifiedId);
    return {
      kind,
      qualifiedId: `${functionId}/${agentId}#${planId}`,
      scope: { function: functionId, agent: agentId, plan: planId },
    };
  }
  identityFailure(value, 'scope');
}

export function normalizeScopeAlias(options: {
  scope?: string;
  functionId?: string;
  agent?: string;
}): string | undefined {
  const aliases: string[] = [];
  if (options.scope !== undefined) aliases.push(options.scope);
  if (options.functionId !== undefined) aliases.push(`function:${assertRecordId(options.functionId)}`);
  if (options.agent !== undefined) {
    const parsed = parseAgentQualifiedId(options.agent);
    aliases.push(`agent:${parsed.functionId}/${parsed.agentId}`);
  }
  const distinct = [...new Set(aliases)];
  if (distinct.length > 1) {
    throw workspaceFailure(
      'IDENTITY_INVALID',
      'Conflicting scope flags.',
      'Pass one --scope value, or an equivalent --function/--agent convenience alias.',
      { scopes: distinct },
    );
  }
  return distinct[0];
}

export function functionRecordPath(functionRoot: string): string {
  return posix.join(functionRoot, 'function.yaml');
}

export function agentRecordPath(functionRoot: string, agentId: string): string {
  return posix.join(functionRoot, 'agents', assertRecordId(agentId), 'agent.yaml');
}

export function childRecordPath(
  functionRoot: string,
  agentId: string,
  kind: Exclude<WorkspaceRecordKind, 'function' | 'agent'>,
  id: string,
  scope?: WorkspaceScope,
): string {
  const safeId = assertRecordId(id);
  if (kind === 'guideline' && scope?.agent === undefined) {
    return posix.join(functionRoot, 'guidelines', `${safeId}.md`);
  }
  const base = posix.join(functionRoot, 'agents', assertRecordId(agentId));
  if (kind === 'plan') return posix.join(base, 'plans', `${safeId}.yaml`);
  if (kind === 'subagent') return posix.join(base, 'subagents', `${safeId}.yaml`);
  if (kind === 'tool-use') return posix.join(base, 'tools', `${safeId}.yaml`);
  if (kind === 'lesson') return posix.join(base, 'playbook', `${safeId}.md`);
  if (kind === 'guideline') {
    return posix.join(base, 'guidelines', `${safeId}.md`);
  }
  return kind satisfies never;
}

export function qualifiedRecordId(
  kind: WorkspaceRecordKind,
  ids: { functionId: string; agentId?: string; localId?: string },
): string {
  const functionId = assertRecordId(ids.functionId);
  if (kind === 'function') return functionId;
  if (kind === 'guideline' && ids.agentId === undefined) {
    const localId = assertRecordId(ids.localId ?? '');
    return `${functionId}/guidelines/${localId}`;
  }
  const agentId = assertRecordId(ids.agentId ?? '');
  if (kind === 'agent') return `${functionId}/${agentId}`;
  const localId = assertRecordId(ids.localId ?? '');
  if (kind === 'plan') return `${functionId}/${agentId}#${localId}`;
  if (kind === 'subagent') return `${functionId}/${agentId}/subagents/${localId}`;
  if (kind === 'guideline') {
    return `${functionId}/${agentId}/guidelines/${localId}`;
  }
  if (kind === 'tool-use') return `${functionId}/${agentId}/tools/${localId}`;
  return `${functionId}/${agentId}/playbook/${localId}`;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  if (value.length === 0 || isAbsolute(value) || value.includes('\\') || value.includes('\u0000')) {
    throw workspaceFailure('PATH_ESCAPE', `Path '${value}' is not workspace-relative.`, 'Use a relative POSIX path inside the workspace.', { path: value });
  }
  const rawParts = value.split('/');
  if (rawParts.some((part) => part === '' || part === '.' || part === '..')) {
    throw workspaceFailure('PATH_ESCAPE', `Path '${value}' is not canonical.`, 'Remove repeated separators and traversal components.', { path: value });
  }
  const normalized = posix.normalize(value);
  const parts = normalized.split('/');
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || parts.some((part) => part === '..' || part === '')) {
    throw workspaceFailure('PATH_ESCAPE', `Path '${value}' escapes the workspace.`, 'Use a relative POSIX path inside the workspace.', { path: value });
  }
  return normalized;
}

export function assertFunctionRootPath(value: string): string {
  const normalized = normalizeWorkspaceRelativePath(value);
  const parts = normalized.split('/');
  const lower = normalized.toLocaleLowerCase('en-US');
  const first = parts[0]!.toLocaleLowerCase('en-US');
  if (RESERVED_FIRST_COMPONENTS.has(first)
    || ROSTER_RESERVED_PATHS.some((reserved) => {
      const candidate = reserved.toLocaleLowerCase('en-US');
      return lower === candidate || lower.startsWith(`${candidate}/`) || candidate.startsWith(`${lower}/`);
    })) {
    throw workspaceFailure('RESERVED_PATH', `Function root '${value}' is reserved.`, 'Choose a function root beneath functions/<function-id>.', { path: value });
  }
  for (const part of parts) assertRecordId(part);
  return normalized;
}

export function assertNonOverlappingFunctionRoots(paths: readonly string[]): void {
  const normalized = paths.map(assertFunctionRootPath);
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      const al = a.toLocaleLowerCase('en-US');
      const bl = b.toLocaleLowerCase('en-US');
      if (al === bl || al.startsWith(`${bl}/`) || bl.startsWith(`${al}/`)) {
        throw workspaceFailure('PATH_OVERLAP', `Function roots '${a}' and '${b}' overlap.`, 'Give every function a disjoint root path.', { paths: [a, b] });
      }
    }
  }
}

export function resolveWorkspacePath(root: string, relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...normalized.split('/'));
  const rel = relative(absoluteRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw workspaceFailure('PATH_ESCAPE', `Path '${relativePath}' escapes the workspace.`, 'Use a path confined to the workspace.', { path: relativePath });
  }
  return absolute;
}
