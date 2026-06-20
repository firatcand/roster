export type ParsedUpdateArgs =
  | { kind: 'ok'; json: boolean; cwd: string | undefined; excludes: string[] }
  | { kind: 'err'; message: string };

export function parseUpdateArgs(args: readonly string[]): ParsedUpdateArgs {
  let json = false;
  let cwd: string | undefined;
  const excludes: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--cwd') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--cwd requires a value' };
      cwd = v;
      i++;
    } else if (arg === '--exclude') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--exclude requires a value' };
      for (const p of v.split(',').map((s) => s.trim()).filter(Boolean)) excludes.push(p);
      i++;
    } else {
      return { kind: 'err', message: `unknown flag '${arg}' for 'update'` };
    }
  }

  return { kind: 'ok', json, cwd, excludes };
}
