import type { ToolKey } from './tools.ts';
import type { Scope } from './install-scope.ts';

export const KNOWN_TOOL_KEYS: readonly ToolKey[] = ['claude', 'codex', 'gemini'];

export type InstallTarget =
  | { mode: 'all' }
  | { mode: 'tools'; keys: ToolKey[] }
  | { mode: 'interactive' };

export type ParsedInstallArgs =
  | {
      kind: 'ok';
      silent: boolean;
      verbose: boolean;
      yes: boolean;
      scope: Scope | null;
      target: InstallTarget;
    }
  | { kind: 'err'; message: string };

const TOOL_LIST = KNOWN_TOOL_KEYS.join(' | ');
const SCOPE_LIST = '(project | user)';

function isToolKey(value: string): value is ToolKey {
  return (KNOWN_TOOL_KEYS as readonly string[]).includes(value);
}

function isScope(value: string): value is Scope {
  return value === 'project' || value === 'user';
}

// Parse `--tool <value>` payload. `<value>` is one tool name, or several
// comma-separated. Whitespace around commas is tolerated; duplicates collapse;
// the empty string and bare commas ("claude,,codex") fail validation.
function parseToolValue(
  value: string,
): { ok: true; keys: ToolKey[] } | { ok: false; message: string } {
  const parts = value.split(',').map((s) => s.trim());
  if (parts.some((p) => p.length === 0)) {
    return { ok: false, message: `--tool received an empty value (check for stray commas)` };
  }
  const keys: ToolKey[] = [];
  for (const part of parts) {
    if (!isToolKey(part)) {
      return {
        ok: false,
        message: `unknown tool '${part}'; expected one of: ${TOOL_LIST}`,
      };
    }
    if (!keys.includes(part)) keys.push(part);
  }
  return { ok: true, keys };
}

export function parseInstallArgs(args: readonly string[]): ParsedInstallArgs {
  let silent = false;
  let verbose = false;
  let yes = false;
  let all = false;
  let toolValue: string | null = null;
  let toolFlagSeen = false;
  let scopeValue: string | null = null;
  let scopeFlagSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--silent') {
      silent = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--tool') {
      toolFlagSeen = true;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { kind: 'err', message: `--tool requires a tool name (${TOOL_LIST})` };
      }
      toolValue = next;
      i++;
    } else if (arg.startsWith('--tool=')) {
      toolFlagSeen = true;
      const value = arg.slice('--tool='.length);
      if (value === '') {
        return { kind: 'err', message: `--tool requires a tool name (${TOOL_LIST})` };
      }
      toolValue = value;
    } else if (arg === '--scope') {
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

  if (all && toolFlagSeen) {
    return { kind: 'err', message: 'flags --all and --tool are mutually exclusive' };
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

  let target: InstallTarget;
  if (toolFlagSeen && toolValue !== null) {
    const parsed = parseToolValue(toolValue);
    if (!parsed.ok) return { kind: 'err', message: parsed.message };
    target = { mode: 'tools', keys: parsed.keys };
  } else if (all) {
    target = { mode: 'all' };
  } else {
    target = { mode: 'interactive' };
  }

  return { kind: 'ok', silent, verbose, yes, scope, target };
}
