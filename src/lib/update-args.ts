import { resolve } from 'node:path';
export type ParsedUpdateArgs =
  | { kind: 'ok'; json: boolean; cwd: string | undefined }
  | { kind: 'err'; message: string };

export function parseUpdateArgs(args: readonly string[]): ParsedUpdateArgs {
  let json = false;
  let cwd: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--cwd') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--cwd requires a value' };
      cwd = resolve(v);
      i++;
    } else {
      return { kind: 'err', message: `unknown flag '${arg}' for 'update'` };
    }
  }

  return { kind: 'ok', json, cwd };
}
