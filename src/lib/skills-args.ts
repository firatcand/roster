type SkillsSubcommand = 'sync' | 'update';

const SKILLS_SUBCOMMANDS: ReadonlySet<SkillsSubcommand> = new Set<SkillsSubcommand>([
  'sync',
  'update',
]);

const SUBCOMMAND_LIST = Array.from(SKILLS_SUBCOMMANDS).join(' | ');

function isSkillsSubcommand(value: string): value is SkillsSubcommand {
  return SKILLS_SUBCOMMANDS.has(value as SkillsSubcommand);
}

export type ParsedSkillsArgs =
  | {
      kind: 'ok';
      subcommand: 'sync';
      json: boolean;
      cwd: string | undefined;
    }
  | {
      kind: 'ok';
      subcommand: 'update';
      latest: boolean;
      json: boolean;
      cwd: string | undefined;
    }
  | { kind: 'err'; message: string };

function takeValue(args: readonly string[], i: number, flag: string): string | { err: string } {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) return { err: `${flag} requires a value` };
  return v;
}

export function parseSkillsArgs(args: readonly string[]): ParsedSkillsArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return { kind: 'err', message: `missing subcommand for 'skills' (available: ${SUBCOMMAND_LIST})` };
  }
  if (!isSkillsSubcommand(first)) {
    return { kind: 'err', message: `unknown 'skills' subcommand '${first}' (available: ${SUBCOMMAND_LIST})` };
  }

  let json = false;
  let latest = false;
  let cwd: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--latest') {
      latest = true;
    } else if (arg === '--cwd') {
      const v = takeValue(rest, i, '--cwd');
      if (typeof v === 'object') return { kind: 'err', message: v.err };
      cwd = v;
      i++;
    } else {
      return { kind: 'err', message: `unknown flag '${arg}' for 'skills ${first}'` };
    }
  }

  if (first === 'sync') {
    if (latest) return { kind: 'err', message: `--latest is only valid for 'skills update'` };
    return { kind: 'ok', subcommand: 'sync', json, cwd };
  }
  return { kind: 'ok', subcommand: 'update', latest, json, cwd };
}
