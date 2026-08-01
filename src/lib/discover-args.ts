import {
  isWorkspaceRecordKind,
  normalizeScopeAlias,
  parseScope,
  type WorkspaceRecordKind,
} from './workspace-layout.ts';
import { isWorkspaceFailure } from './workspace-diagnostics.ts';

export type ParsedDiscoverArgs =
  | {
      kind: 'ok';
      query?: string;
      recordKind?: WorkspaceRecordKind;
      scope?: string;
      exact: boolean;
      full: boolean;
      json: boolean;
    }
  | { kind: 'err'; message: string };

export function parseDiscoverArgs(args: readonly string[]): ParsedDiscoverArgs {
  let query: string | undefined;
  let recordKind: WorkspaceRecordKind | undefined;
  let scope: string | undefined;
  let functionId: string | undefined;
  let agent: string | undefined;
  let exact = false;
  let full = false;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--exact') exact = true;
    else if (arg === '--full') full = true;
    else if (arg === '--json') json = true;
    else if (arg === '--kind' || arg === '--scope' || arg === '--function' || arg === '--agent') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) return { kind: 'err', message: `${arg} requires a value` };
      if (arg === '--kind') {
        if (!isWorkspaceRecordKind(value)) return { kind: 'err', message: `unknown discovery kind '${value}'` };
        recordKind = value;
      } else if (arg === '--scope') scope = value;
      else if (arg === '--function') functionId = value;
      else agent = value;
      index++;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag '${arg}' for 'discover'` };
    } else if (query === undefined) {
      query = arg;
    } else {
      return { kind: 'err', message: `'discover' accepts at most one query` };
    }
  }
  if (exact && (query === undefined || query.length === 0)) {
    return { kind: 'err', message: `'discover --exact' requires a non-empty query` };
  }
  try {
    const normalizedScope = normalizeScopeAlias({ scope, functionId, agent });
    if (normalizedScope !== undefined) parseScope(normalizedScope);
    return {
      kind: 'ok',
      ...(query === undefined ? {} : { query }),
      ...(recordKind === undefined ? {} : { recordKind }),
      ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
      exact,
      full,
      json,
    };
  } catch (error) {
    if (isWorkspaceFailure(error)) {
      return { kind: 'err', message: error.header.replace(/^roster:\s*/, '') };
    }
    throw error;
  }
}
