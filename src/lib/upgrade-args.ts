export type ParsedUpgradeArgs =
  | { kind: 'ok'; dryRun: boolean; json: boolean; cwd: string | undefined }
  | { kind: 'err'; message: string };

export function parseUpgradeArgs(args: readonly string[]): ParsedUpgradeArgs {
  let dryRun = false;
  let json = false;
  let cwd: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--cwd') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--cwd requires a value' };
      cwd = v;
      i++;
    } else {
      return { kind: 'err', message: `unknown flag '${arg}' for 'upgrade'` };
    }
  }

  return { kind: 'ok', dryRun, json, cwd };
}
