import { RUNTIME_ROLE } from './brain/roles.ts';

type BrainSubcommand = 'init' | 'doctor';

const BRAIN_SUBCOMMANDS: ReadonlySet<BrainSubcommand> = new Set<BrainSubcommand>([
  'init',
  'doctor',
]);

const SUBCOMMAND_LIST = Array.from(BRAIN_SUBCOMMANDS).join(' | ');

export type ParsedBrainArgs =
  | { kind: 'ok'; subcommand: 'init'; json: boolean; silent: boolean; embeddings: boolean; role: string }
  | { kind: 'ok'; subcommand: 'doctor'; json: boolean; silent: boolean; role: string }
  | { kind: 'err'; message: string };

function isBrainSubcommand(value: string): value is BrainSubcommand {
  return BRAIN_SUBCOMMANDS.has(value as BrainSubcommand);
}

export function parseBrainArgs(args: readonly string[]): ParsedBrainArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return { kind: 'err', message: `missing subcommand for 'brain' (available: ${SUBCOMMAND_LIST})` };
  }
  if (!isBrainSubcommand(first)) {
    return { kind: 'err', message: `unknown 'brain' subcommand '${first}' (available: ${SUBCOMMAND_LIST})` };
  }

  let json = false;
  let silent = false;
  let embeddings = false;
  let role = RUNTIME_ROLE;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--embeddings' && first === 'init') embeddings = true;
    else if (arg === '--role') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'err', message: `'brain ${first}': --role requires a value` };
      }
      role = value;
      i++;
    } else if (arg.startsWith('--role=')) {
      role = arg.slice('--role='.length);
    } else if (arg.startsWith('-')) return { kind: 'err', message: `unknown flag for 'brain ${first}': ${arg}` };
    else return { kind: 'err', message: `'brain ${first}' takes no positional arguments` };
  }

  if (first === 'init') return { kind: 'ok', subcommand: 'init', json, silent, embeddings, role };
  return { kind: 'ok', subcommand: 'doctor', json, silent, role };
}
