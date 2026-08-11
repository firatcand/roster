// #357 shipped `status`; #358 adds the candidate lifecycle. Every other spelling
// stays a usage error that names only the verbs that exist, so a host can never
// believe in a surface Roster does not have.
export const DREAM_SUBCOMMANDS = ['status', 'candidates'] as const;

export type DreamSubcommand = (typeof DREAM_SUBCOMMANDS)[number];

export const DREAM_CANDIDATE_VERBS = ['list', 'create', 'promote', 'reject', 'retire'] as const;

export type DreamCandidateVerb = (typeof DREAM_CANDIDATE_VERBS)[number];

export type ParsedDreamArgs =
  | {
      kind: 'ok';
      subcommand: 'status';
      json: boolean;
      scope?: string;
      functionId?: string;
      agent?: string;
    }
  | {
      kind: 'ok';
      subcommand: 'candidates';
      verb: 'list';
      json: boolean;
      state?: string;
      target?: string;
      limit?: number;
    }
  | {
      kind: 'ok';
      subcommand: 'candidates';
      verb: 'create';
      json: boolean;
      file?: string;
      stdin: boolean;
    }
  | {
      kind: 'ok';
      subcommand: 'candidates';
      verb: 'promote' | 'reject' | 'retire';
      json: boolean;
      candidateId: string;
      decisionId: string;
      actionDigest: string;
    }
  | { kind: 'err'; message: string };

const SUBCOMMAND_LIST = DREAM_SUBCOMMANDS.join(' | ');
const VERB_LIST = DREAM_CANDIDATE_VERBS.join(' | ');
const CANDIDATE_STATES = ['open', 'promoted', 'rejected', 'retired', 'superseded'] as const;

function err(message: string): ParsedDreamArgs {
  return { kind: 'err', message };
}

function readValue(
  rest: readonly string[],
  index: number,
  flag: string,
  context: string,
): { value: string; next: number } | ParsedDreamArgs {
  const value = rest[index + 1];
  if (value === undefined || value.startsWith('-')) {
    return err(`'${context}': ${flag} requires a value`);
  }
  return { value, next: index + 1 };
}

function parseStatus(rest: readonly string[]): ParsedDreamArgs {
  let json = false;
  let scope: string | undefined;
  let functionId: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--scope') {
      const v = readValue(rest, i, '--scope', 'dream status');
      if ('kind' in v) return v;
      scope = v.value;
      i = v.next;
    } else if (arg === '--function') {
      const v = readValue(rest, i, '--function', 'dream status');
      if ('kind' in v) return v;
      functionId = v.value;
      i = v.next;
    } else if (arg === '--agent') {
      const v = readValue(rest, i, '--agent', 'dream status');
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

function parseList(rest: readonly string[]): ParsedDreamArgs {
  let json = false;
  let state: string | undefined;
  let target: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--state') {
      const v = readValue(rest, i, '--state', 'dream candidates list');
      if ('kind' in v) return v;
      if (!(CANDIDATE_STATES as readonly string[]).includes(v.value)) {
        return err(`'dream candidates list': unknown --state '${v.value}' (available: ${CANDIDATE_STATES.join(' | ')})`);
      }
      state = v.value;
      i = v.next;
    } else if (arg === '--target') {
      const v = readValue(rest, i, '--target', 'dream candidates list');
      if ('kind' in v) return v;
      target = v.value;
      i = v.next;
    } else if (arg === '--limit') {
      const v = readValue(rest, i, '--limit', 'dream candidates list');
      if ('kind' in v) return v;
      const parsed = Number(v.value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
        return err(`'dream candidates list': --limit must be a whole number between 1 and 500`);
      }
      limit = parsed;
      i = v.next;
    } else if (arg.startsWith('-')) {
      return err(`unknown flag for 'dream candidates list': ${arg}`);
    } else {
      return err(`'dream candidates list': unexpected positional argument '${arg}'`);
    }
  }
  return { kind: 'ok', subcommand: 'candidates', verb: 'list', json, state, target, limit };
}

// The draft arrives as a JSON document rather than a flag matrix: it carries a
// multiline lesson body and up to 64 citations, and keeping it off argv is what
// stops a candidate's prose from landing in a process listing or a shell history.
function parseCreate(rest: readonly string[]): ParsedDreamArgs {
  let json = false;
  let file: string | undefined;
  let stdin = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--stdin') stdin = true;
    else if (arg === '--file') {
      const v = readValue(rest, i, '--file', 'dream candidates create');
      if ('kind' in v) return v;
      file = v.value;
      i = v.next;
    } else if (arg.startsWith('-')) {
      return err(`unknown flag for 'dream candidates create': ${arg}`);
    } else {
      return err(`'dream candidates create': unexpected positional argument '${arg}'`);
    }
  }
  if ((file === undefined) === (stdin === false)) {
    return err(`'dream candidates create': pass exactly one of --file <path> or --stdin`);
  }
  return { kind: 'ok', subcommand: 'candidates', verb: 'create', json, file, stdin };
}

function parseDecision(
  verb: 'promote' | 'reject' | 'retire',
  rest: readonly string[],
): ParsedDreamArgs {
  const context = `dream candidates ${verb}`;
  let json = false;
  let candidateId: string | undefined;
  let decisionId: string | undefined;
  let actionDigest: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--decision') {
      const v = readValue(rest, i, '--decision', context);
      if ('kind' in v) return v;
      decisionId = v.value;
      i = v.next;
    } else if (arg === '--action-digest') {
      const v = readValue(rest, i, '--action-digest', context);
      if ('kind' in v) return v;
      actionDigest = v.value;
      i = v.next;
    } else if (arg.startsWith('-')) {
      return err(`unknown flag for '${context}': ${arg}`);
    } else if (candidateId === undefined) {
      candidateId = arg;
    } else {
      return err(`'${context}': unexpected positional argument '${arg}'`);
    }
  }
  if (candidateId === undefined) return err(`'${context}': a candidate id is required`);
  if (decisionId === undefined) return err(`'${context}': --decision <human-decision-id> is required`);
  if (actionDigest === undefined) return err(`'${context}': --action-digest <sha256:...> is required`);
  return { kind: 'ok', subcommand: 'candidates', verb, json, candidateId, decisionId, actionDigest };
}

export function parseDreamArgs(args: readonly string[]): ParsedDreamArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return err(`missing subcommand for 'dream' (available: ${SUBCOMMAND_LIST})`);
  }
  if (!(DREAM_SUBCOMMANDS as readonly string[]).includes(first)) {
    return err(`unknown 'dream' subcommand '${first}' (available: ${SUBCOMMAND_LIST})`);
  }
  if (first === 'status') return parseStatus(rest);

  const [verb, ...verbArgs] = rest;
  if (verb === undefined) {
    return err(`missing verb for 'dream candidates' (available: ${VERB_LIST})`);
  }
  if (!(DREAM_CANDIDATE_VERBS as readonly string[]).includes(verb)) {
    return err(`unknown 'dream candidates' verb '${verb}' (available: ${VERB_LIST})`);
  }
  if (verb === 'list') return parseList(verbArgs);
  if (verb === 'create') return parseCreate(verbArgs);
  return parseDecision(verb as 'promote' | 'reject' | 'retire', verbArgs);
}
