import {
  assertRecordId,
  isWorkspaceRecordKind,
  normalizeScopeAlias,
  parseScope,
  type WorkspaceRecordKind,
} from './workspace-layout.ts';
import { isWorkspaceFailure } from './workspace-diagnostics.ts';

export type ParsedScaffoldArgs =
  | {
      kind: 'ok';
      recordKind: WorkspaceRecordKind;
      id: string;
      scope?: string;
      purpose: string;
      json: boolean;
    }
  | { kind: 'err'; message: string };

function parseError(message: string): ParsedScaffoldArgs {
  return { kind: 'err', message };
}

function takeValue(args: readonly string[], index: number): { value: string; next: number } | null {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) return null;
  return { value, next: index + 1 };
}

function scopeAllowed(recordKind: WorkspaceRecordKind, scopeKind: string | undefined): boolean {
  if (recordKind === 'function') return scopeKind === undefined;
  if (recordKind === 'agent') return scopeKind === 'function';
  if (recordKind === 'plan' || recordKind === 'subagent') return scopeKind === 'agent';
  if (recordKind === 'guideline') return scopeKind === 'function' || scopeKind === 'agent';
  if (recordKind === 'tool-use') {
    return scopeKind === 'workspace'
      || scopeKind === 'function'
      || scopeKind === 'agent'
      || scopeKind === 'plan';
  }
  return scopeKind === 'agent' || scopeKind === 'plan';
}

export function parseScaffoldArgs(args: readonly string[]): ParsedScaffoldArgs {
  const [kindValue, idValue, ...rest] = args;
  if (kindValue === undefined) return parseError(`'scaffold' requires a kind`);
  if (!isWorkspaceRecordKind(kindValue)) {
    return parseError(`unknown scaffold kind '${kindValue}'`);
  }
  if (idValue === undefined || idValue.startsWith('-')) {
    return parseError(`'scaffold ${kindValue}' requires an <id>`);
  }
  let id: string;
  try {
    id = assertRecordId(idValue);
  } catch (error) {
    if (isWorkspaceFailure(error)) return parseError(error.header.replace(/^roster:\s*/, ''));
    throw error;
  }

  let scope: string | undefined;
  let functionId: string | undefined;
  let agent: string | undefined;
  let purpose = '';
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--scope' || arg === '--function' || arg === '--agent' || arg === '--purpose') {
      const taken = takeValue(rest, index);
      if (taken === null) return parseError(`${arg} requires a value`);
      if (arg === '--scope') scope = taken.value;
      else if (arg === '--function') functionId = taken.value;
      else if (arg === '--agent') agent = taken.value;
      else purpose = taken.value;
      index = taken.next;
      continue;
    }
    return parseError(`unknown flag '${arg}' for 'scaffold ${kindValue}'`);
  }

  try {
    const normalizedScope = normalizeScopeAlias({ scope, functionId, agent });
    const scopeKind = normalizedScope === undefined ? undefined : parseScope(normalizedScope).kind;
    if (!scopeAllowed(kindValue, scopeKind)) {
      if (kindValue === 'function') {
        return parseError(`'scaffold function' does not accept --scope`);
      }
      const expected = kindValue === 'agent'
        ? 'function:<function-id>'
        : kindValue === 'plan' || kindValue === 'subagent'
          ? 'agent:<function/agent>'
          : kindValue === 'guideline'
            ? 'function:<id> or agent:<function/agent>'
            : kindValue === 'tool-use'
              ? 'workspace, function:<id>, agent:<function/agent>, or plan:<function/agent#plan>'
              : 'agent:<function/agent> or plan:<function/agent#plan>';
      return parseError(`'scaffold ${kindValue}' requires --scope ${expected}`);
    }
    return {
      kind: 'ok',
      recordKind: kindValue,
      id,
      ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
      purpose,
      json,
    };
  } catch (error) {
    if (isWorkspaceFailure(error)) return parseError(error.header.replace(/^roster:\s*/, ''));
    throw error;
  }
}
