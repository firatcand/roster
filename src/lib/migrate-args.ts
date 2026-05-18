export type MigrateSubcommand = 'from-agent-team';

export const MIGRATE_SUBCOMMANDS: ReadonlySet<MigrateSubcommand> = new Set<MigrateSubcommand>([
  'from-agent-team',
]);

const SUBCOMMAND_LIST = Array.from(MIGRATE_SUBCOMMANDS).join(' | ');

export type ParsedMigrateArgs =
  | {
      kind: 'ok';
      subcommand: 'from-agent-team';
      sourceDir: string;
      dest: string | undefined;
      dryRun: boolean;
      forceResync: boolean;
      json: boolean;
      silent: boolean;
    }
  | { kind: 'err'; message: string };

function isMigrateSubcommand(value: string): value is MigrateSubcommand {
  return MIGRATE_SUBCOMMANDS.has(value as MigrateSubcommand);
}

export function parseMigrateArgs(args: readonly string[]): ParsedMigrateArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return { kind: 'err', message: `missing subcommand for 'migrate' (available: ${SUBCOMMAND_LIST})` };
  }
  if (!isMigrateSubcommand(first)) {
    return {
      kind: 'err',
      message: `unknown 'migrate' subcommand '${first}' (available: ${SUBCOMMAND_LIST})`,
    };
  }

  return parseFromAgentTeam(rest);
}

function parseFromAgentTeam(rest: readonly string[]): ParsedMigrateArgs {
  const positionals: string[] = [];
  let dest: string | undefined;
  let dryRun = false;
  let forceResync = false;
  let json = false;
  let silent = false;

  const consumeValue = (
    flag: string,
    current: string | undefined,
    next: string | undefined,
  ): { ok: true; value: string } | { ok: false; message: string } => {
    if (current !== undefined) return { ok: false, message: `flag ${flag} specified more than once` };
    if (next === undefined || next.startsWith('-')) return { ok: false, message: `${flag} requires a value` };
    return { ok: true, value: next };
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--dest') {
      const r = consumeValue('--dest', dest, rest[i + 1]);
      if (!r.ok) return { kind: 'err', message: r.message };
      dest = r.value;
      i++;
    } else if (arg.startsWith('--dest=')) {
      if (dest !== undefined) return { kind: 'err', message: 'flag --dest specified more than once' };
      dest = arg.slice('--dest='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force-resync') {
      forceResync = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'migrate from-agent-team': ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    return { kind: 'err', message: "missing positional <source-dir> for 'migrate from-agent-team'" };
  }
  if (positionals.length > 1) {
    return { kind: 'err', message: `'migrate from-agent-team' expected 1 positional argument (<source-dir>), got ${positionals.length}` };
  }

  return {
    kind: 'ok',
    subcommand: 'from-agent-team',
    sourceDir: positionals[0]!,
    dest,
    dryRun,
    forceResync,
    json,
    silent,
  };
}
