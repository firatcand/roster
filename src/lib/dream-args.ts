// #357 ships exactly one Dreamer verb. `dream candidates` and the rest of the
// lifecycle are #358's; until then every other spelling is a usage error that
// names only `status`, so a host cannot believe a candidate surface exists.
export const DREAM_SUBCOMMANDS = ['status'] as const;

export type DreamSubcommand = (typeof DREAM_SUBCOMMANDS)[number];

export type ParsedDreamArgs =
  | {
      kind: 'ok';
      subcommand: 'status';
      json: boolean;
      scope?: string;
      functionId?: string;
      agent?: string;
    }
  | { kind: 'err'; message: string };

const SUBCOMMAND_LIST = DREAM_SUBCOMMANDS.join(' | ');

function err(message: string): ParsedDreamArgs {
  return { kind: 'err', message };
}

function readValue(
  rest: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } | ParsedDreamArgs {
  const value = rest[index + 1];
  if (value === undefined || value.startsWith('-')) {
    return err(`'dream status': ${flag} requires a value`);
  }
  return { value, next: index + 1 };
}

export function parseDreamArgs(args: readonly string[]): ParsedDreamArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return err(`missing subcommand for 'dream' (available: ${SUBCOMMAND_LIST})`);
  }
  if (!(DREAM_SUBCOMMANDS as readonly string[]).includes(first)) {
    return err(`unknown 'dream' subcommand '${first}' (available: ${SUBCOMMAND_LIST})`);
  }

  let json = false;
  let scope: string | undefined;
  let functionId: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--scope') {
      const v = readValue(rest, i, '--scope');
      if ('kind' in v) return v;
      scope = v.value;
      i = v.next;
    } else if (arg === '--function') {
      const v = readValue(rest, i, '--function');
      if ('kind' in v) return v;
      functionId = v.value;
      i = v.next;
    } else if (arg === '--agent') {
      const v = readValue(rest, i, '--agent');
      if ('kind' in v) return v;
      agent = v.value;
      i = v.next;
    } else if (arg.startsWith('-')) {
      return err(`unknown flag for 'dream status': ${arg}`);
    } else {
      return err(`'dream status': unexpected positional argument '${arg}'`);
    }
  }
  return { kind: 'ok', subcommand: 'status', json, scope, functionId, agent };
}
