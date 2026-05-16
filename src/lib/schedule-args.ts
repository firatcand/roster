export type ScheduleSubcommand = 'validate';

export const SCHEDULE_SUBCOMMANDS: ReadonlySet<ScheduleSubcommand> = new Set<ScheduleSubcommand>([
  'validate',
]);

export type ParsedScheduleArgs =
  | { kind: 'ok'; subcommand: ScheduleSubcommand; json: boolean; silent: boolean; cwd: string | undefined }
  | { kind: 'err'; message: string };

export function parseScheduleArgs(args: readonly string[]): ParsedScheduleArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return { kind: 'err', message: "missing subcommand for 'schedule' (available: validate)" };
  }
  if (!SCHEDULE_SUBCOMMANDS.has(first as ScheduleSubcommand)) {
    return { kind: 'err', message: `unknown 'schedule' subcommand '${first}' (available: validate)` };
  }

  let json = false;
  let silent = false;
  let cwd: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--cwd') {
      const next = rest[i + 1];
      if (next === undefined) return { kind: 'err', message: '--cwd requires a path argument' };
      cwd = next;
      i++;
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'schedule ${first}': ${arg}` };
    } else {
      return { kind: 'err', message: `unexpected positional argument for 'schedule ${first}': ${arg}` };
    }
  }

  return { kind: 'ok', subcommand: first as ScheduleSubcommand, json, silent, cwd };
}
