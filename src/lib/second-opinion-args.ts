import type { ToolKey } from './tools.ts';

const HOSTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini']);

export const DEFAULT_TIMEOUT_SEC = 180;

export type SecondOpinionArgsErrorCode = 'NO_INPUT' | 'HOST_UNKNOWN' | 'INVALID_ARGS';

export type SecondOpinionArgs =
  | {
      kind: 'ok';
      files: string[];
      host?: ToolKey;
      message?: string;
      stdin: boolean;
      // undefined = no --diff; otherwise the ref to diff against ('HEAD' default).
      diff?: string;
      timeoutSec: number;
      json: boolean;
    }
  | { kind: 'err'; code: SecondOpinionArgsErrorCode; message: string };

export function parseSecondOpinionArgs(args: readonly string[]): SecondOpinionArgs {
  const files: string[] = [];
  let host: ToolKey | undefined;
  let message: string | undefined;
  let stdin = false;
  let diff: string | undefined;
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--stdin') {
      stdin = true;
    } else if (arg === '--diff') {
      // Optional value: `--diff` alone means diff against HEAD.
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) {
        diff = 'HEAD';
      } else {
        diff = v;
        i++;
      }
    } else if (arg === '--host') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', code: 'INVALID_ARGS', message: '--host requires a value' };
      if (!HOSTS.has(v)) return { kind: 'err', code: 'HOST_UNKNOWN', message: `--host must be one of claude | codex | gemini (got '${v}')` };
      host = v as ToolKey;
      i++;
    } else if (arg === '--message') {
      const v = args[i + 1];
      if (v === undefined) return { kind: 'err', code: 'INVALID_ARGS', message: '--message requires a value' };
      message = v;
      i++;
    } else if (arg === '--timeout') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', code: 'INVALID_ARGS', message: '--timeout requires a value in seconds' };
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { kind: 'err', code: 'INVALID_ARGS', message: `--timeout must be a positive number of seconds (got '${v}')` };
      timeoutSec = n;
      i++;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', code: 'INVALID_ARGS', message: `unknown flag for second-opinion: ${arg}` };
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0 && !stdin && diff === undefined) {
    return {
      kind: 'err',
      code: 'NO_INPUT',
      message: 'at least one input required: file paths, --stdin, or --diff',
    };
  }

  return {
    kind: 'ok',
    files,
    ...(host !== undefined ? { host } : {}),
    ...(message !== undefined ? { message } : {}),
    stdin,
    ...(diff !== undefined ? { diff } : {}),
    timeoutSec,
    json,
  };
}
