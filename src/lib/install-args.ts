import type { ToolKey } from './tools.ts';

export const KNOWN_TOOL_KEYS: readonly ToolKey[] = ['claude', 'codex', 'gemini'];

export type InstallTarget =
  | { mode: 'all' }
  | { mode: 'tool'; key: ToolKey }
  | { mode: 'interactive' };

export type ParsedInstallArgs =
  | { kind: 'ok'; silent: boolean; verbose: boolean; target: InstallTarget }
  | { kind: 'err'; message: string };

const TOOL_LIST = KNOWN_TOOL_KEYS.join(' | ');

function isToolKey(value: string): value is ToolKey {
  return (KNOWN_TOOL_KEYS as readonly string[]).includes(value);
}

export function parseInstallArgs(args: readonly string[]): ParsedInstallArgs {
  let silent = false;
  let verbose = false;
  let all = false;
  let toolValue: string | null = null;
  let toolFlagSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--silent') {
      silent = true;
    } else if (arg === '--verbose') {
      verbose = true;
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
    }
  }

  if (all && toolFlagSeen) {
    return { kind: 'err', message: 'flags --all and --tool are mutually exclusive' };
  }

  if (toolFlagSeen && toolValue !== null) {
    if (!isToolKey(toolValue)) {
      return {
        kind: 'err',
        message: `unknown tool '${toolValue}'; expected one of: ${TOOL_LIST}`,
      };
    }
    return { kind: 'ok', silent, verbose, target: { mode: 'tool', key: toolValue } };
  }

  if (all) {
    return { kind: 'ok', silent, verbose, target: { mode: 'all' } };
  }

  return { kind: 'ok', silent, verbose, target: { mode: 'interactive' } };
}
