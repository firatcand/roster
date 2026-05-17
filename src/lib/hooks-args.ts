export type HooksTarget = 'claude' | 'codex' | 'all';

export type HooksArgs =
  | { kind: 'ok'; subcommand: 'install'; target: HooksTarget; silent: boolean }
  | { kind: 'err'; message: string };

export function parseHooksArgs(args: readonly string[]): HooksArgs {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    return { kind: 'err', message: "missing subcommand: 'hooks install'" };
  }
  if (sub !== 'install') {
    return { kind: 'err', message: `unknown hooks subcommand '${sub}' (expected 'install')` };
  }

  let target: HooksTarget = 'all';
  let silent = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--silent') {
      silent = true;
    } else if (arg === '--tool') {
      const next = rest[i + 1];
      if (next === undefined) {
        return { kind: 'err', message: '--tool requires a value (claude | codex | all)' };
      }
      if (next !== 'claude' && next !== 'codex' && next !== 'all') {
        return { kind: 'err', message: `--tool must be one of: claude, codex, all (got '${next}')` };
      }
      target = next;
      i++;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for hooks install: ${arg}` };
    } else {
      return { kind: 'err', message: `unexpected positional arg for hooks install: ${arg}` };
    }
  }

  return { kind: 'ok', subcommand: 'install', target, silent };
}
