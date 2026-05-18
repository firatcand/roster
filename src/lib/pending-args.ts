export type PendingArgs =
  | { kind: 'ok'; subcommand: 'sync'; cwd: string | undefined; silent: boolean; json: boolean; dryRun: boolean }
  | { kind: 'err'; message: string };

export function parsePendingArgs(args: readonly string[]): PendingArgs {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    return { kind: 'err', message: "missing subcommand: 'pending sync'" };
  }
  if (sub !== 'sync') {
    return { kind: 'err', message: `unknown pending subcommand '${sub}' (expected 'sync')` };
  }

  let cwd: string | undefined;
  let silent = false;
  let json = false;
  let dryRun = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--silent') silent = true;
    else if (arg === '--json') json = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--cwd') {
      const next = rest[i + 1];
      if (next === undefined) {
        return { kind: 'err', message: '--cwd requires a value' };
      }
      cwd = next;
      i++;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for pending sync: ${arg}` };
    } else {
      return { kind: 'err', message: `unexpected positional arg for pending sync: ${arg}` };
    }
  }

  return { kind: 'ok', subcommand: 'sync', cwd, silent, json, dryRun };
}
