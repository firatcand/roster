import type { Scope } from './install-scope.ts';

export type ParsedDoctorArgs =
  | {
      kind: 'ok';
      json: boolean;
      silent: boolean;
      fix: boolean;
      dryRun: boolean;
      scope: Scope | null;
    }
  | { kind: 'err'; message: string };

const SCOPE_LIST = '(project | user)';

function isScope(value: string): value is Scope {
  return value === 'project' || value === 'user';
}

export function parseDoctorArgs(args: readonly string[]): ParsedDoctorArgs {
  let json = false;
  let silent = false;
  let fix = false;
  let dryRun = false;
  let scopeValue: string | null = null;
  let scopeFlagSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--fix') fix = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--scope') {
      scopeFlagSeen = true;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { kind: 'err', message: `--scope requires a value: ${SCOPE_LIST}` };
      }
      scopeValue = next;
      i++;
    } else if (arg.startsWith('--scope=')) {
      scopeFlagSeen = true;
      const value = arg.slice('--scope='.length);
      if (value === '') {
        return { kind: 'err', message: `--scope requires a value: ${SCOPE_LIST}` };
      }
      scopeValue = value;
    }
  }

  let scope: Scope | null = null;
  if (scopeFlagSeen) {
    if (scopeValue === null || !isScope(scopeValue)) {
      return {
        kind: 'err',
        message: `unknown scope '${scopeValue ?? ''}'; expected one of: ${SCOPE_LIST}`,
      };
    }
    scope = scopeValue;
  }

  return { kind: 'ok', json, silent, fix, dryRun, scope };
}
