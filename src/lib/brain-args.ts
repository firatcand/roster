import { RUNTIME_ROLE } from './brain/roles.ts';

type BrainSubcommand =
  | 'init'
  | 'doctor'
  | 'save'
  | 'event'
  | 'link'
  | 'get'
  | 'table'
  | 'sql';

const BRAIN_SUBCOMMANDS: ReadonlySet<BrainSubcommand> = new Set<BrainSubcommand>([
  'init',
  'doctor',
  'save',
  'event',
  'link',
  'get',
  'table',
  'sql',
]);

const SUBCOMMAND_LIST = Array.from(BRAIN_SUBCOMMANDS).join(' | ');

export type FactPair = { key: string; value: unknown };

export type ParsedBrainArgs =
  | { kind: 'ok'; subcommand: 'init'; json: boolean; silent: boolean; embeddings: boolean; role: string }
  | { kind: 'ok'; subcommand: 'doctor'; json: boolean; silent: boolean; role: string }
  | {
      kind: 'ok';
      subcommand: 'save';
      json: boolean;
      entKind: string;
      slug: string;
      title?: string;
      fields: FactPair[];
      source?: string;
      confidence?: number;
      actor?: string;
    }
  | {
      kind: 'ok';
      subcommand: 'event';
      json: boolean;
      entKind: string;
      slug?: string;
      payload: unknown;
      actor?: string;
    }
  | {
      kind: 'ok';
      subcommand: 'link';
      json: boolean;
      srcSlug: string;
      rel: string;
      dstSlug: string;
      kindSrc?: string;
      kindDst?: string;
      props?: unknown;
      actor?: string;
    }
  | { kind: 'ok'; subcommand: 'get'; json: boolean; entKind: string; slug: string }
  | { kind: 'ok'; subcommand: 'table'; json: boolean; op: 'create'; name: string; columns: { name: string; type: string }[] }
  | { kind: 'ok'; subcommand: 'table'; json: boolean; op: 'list' }
  | { kind: 'ok'; subcommand: 'sql'; json: boolean; query: string }
  | { kind: 'err'; message: string };

function isBrainSubcommand(value: string): value is BrainSubcommand {
  return BRAIN_SUBCOMMANDS.has(value as BrainSubcommand);
}

function err(message: string): ParsedBrainArgs {
  return { kind: 'err', message };
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function fanOutData(verb: string, raw: string, into: FactPair[]): ParsedBrainArgs | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(`'brain ${verb}': --data must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(`'brain ${verb}': --data must be a JSON object`);
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    into.push({ key, value });
  }
  return null;
}

function readValue(rest: readonly string[], i: number, verb: string, flag: string): { value: string; next: number } | ParsedBrainArgs {
  const value = rest[i + 1];
  if (value === undefined || value.startsWith('-')) {
    return err(`'brain ${verb}': ${flag} requires a value`);
  }
  return { value, next: i + 1 };
}

export function parseBrainArgs(args: readonly string[]): ParsedBrainArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return err(`missing subcommand for 'brain' (available: ${SUBCOMMAND_LIST})`);
  }
  if (!isBrainSubcommand(first)) {
    return err(`unknown 'brain' subcommand '${first}' (available: ${SUBCOMMAND_LIST})`);
  }

  if (first === 'init' || first === 'doctor') return parseInitDoctor(first, rest);
  if (first === 'save') return parseSave(rest);
  if (first === 'event') return parseEvent(rest);
  if (first === 'link') return parseLink(rest);
  if (first === 'get') return parseGet(rest);
  if (first === 'table') return parseTable(rest);
  return parseSql(rest);
}

function parseInitDoctor(first: 'init' | 'doctor', rest: readonly string[]): ParsedBrainArgs {
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
      const v = readValue(rest, i, first, '--role');
      if ('kind' in v) return v;
      role = v.value;
      i = v.next;
    } else if (arg.startsWith('--role=')) {
      role = arg.slice('--role='.length);
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain ${first}': ${arg}`);
    else return err(`'brain ${first}' takes no positional arguments`);
  }
  if (first === 'init') return { kind: 'ok', subcommand: 'init', json, silent, embeddings, role };
  return { kind: 'ok', subcommand: 'doctor', json, silent, role };
}

function parseSave(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let entKind: string | undefined;
  let slug: string | undefined;
  let title: string | undefined;
  let source: string | undefined;
  let actor: string | undefined;
  let confidence: number | undefined;
  const fields: FactPair[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind') {
      const v = readValue(rest, i, 'save', '--kind'); if ('kind' in v) return v; entKind = v.value; i = v.next;
    } else if (arg === '--slug') {
      const v = readValue(rest, i, 'save', '--slug'); if ('kind' in v) return v; slug = v.value; i = v.next;
    } else if (arg === '--title') {
      const v = readValue(rest, i, 'save', '--title'); if ('kind' in v) return v; title = v.value; i = v.next;
    } else if (arg === '--source') {
      const v = readValue(rest, i, 'save', '--source'); if ('kind' in v) return v; source = v.value; i = v.next;
    } else if (arg === '--actor') {
      const v = readValue(rest, i, 'save', '--actor'); if ('kind' in v) return v; actor = v.value; i = v.next;
    } else if (arg === '--confidence') {
      const v = readValue(rest, i, 'save', '--confidence'); if ('kind' in v) return v;
      const n = Number(v.value);
      if (!Number.isFinite(n)) return err(`'brain save': --confidence must be a number`);
      confidence = n; i = v.next;
    } else if (arg === '--field') {
      const v = readValue(rest, i, 'save', '--field'); if ('kind' in v) return v;
      const eq = v.value.indexOf('=');
      if (eq <= 0) return err(`'brain save': --field must be key=value`);
      fields.push({ key: v.value.slice(0, eq), value: parseJsonValue(v.value.slice(eq + 1)) });
      i = v.next;
    } else if (arg === '--data') {
      const v = readValue(rest, i, 'save', '--data'); if ('kind' in v) return v;
      const fanErr = fanOutData('save', v.value, fields);
      if (fanErr) return fanErr;
      i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain save': ${arg}`);
    else return err(`'brain save': unexpected positional argument '${arg}'`);
  }

  if (entKind === undefined) return err(`'brain save': --kind is required`);
  if (slug === undefined) return err(`'brain save': --slug is required`);
  return { kind: 'ok', subcommand: 'save', json, entKind, slug, title, fields, source, confidence, actor };
}

function parseEvent(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let entKind: string | undefined;
  let slug: string | undefined;
  let actor: string | undefined;
  let payload: unknown = null;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind') {
      const v = readValue(rest, i, 'event', '--kind'); if ('kind' in v) return v; entKind = v.value; i = v.next;
    } else if (arg === '--slug') {
      const v = readValue(rest, i, 'event', '--slug'); if ('kind' in v) return v; slug = v.value; i = v.next;
    } else if (arg === '--actor') {
      const v = readValue(rest, i, 'event', '--actor'); if ('kind' in v) return v; actor = v.value; i = v.next;
    } else if (arg === '--data') {
      const v = readValue(rest, i, 'event', '--data'); if ('kind' in v) return v;
      try { payload = JSON.parse(v.value); } catch { return err(`'brain event': --data must be valid JSON`); }
      i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain event': ${arg}`);
    else return err(`'brain event': unexpected positional argument '${arg}'`);
  }

  if (entKind === undefined) return err(`'brain event': --kind is required`);
  return { kind: 'ok', subcommand: 'event', json, entKind, slug, payload, actor };
}

function parseLink(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let kindSrc: string | undefined;
  let kindDst: string | undefined;
  let actor: string | undefined;
  let props: unknown;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind-src') {
      const v = readValue(rest, i, 'link', '--kind-src'); if ('kind' in v) return v; kindSrc = v.value; i = v.next;
    } else if (arg === '--kind-dst') {
      const v = readValue(rest, i, 'link', '--kind-dst'); if ('kind' in v) return v; kindDst = v.value; i = v.next;
    } else if (arg === '--actor') {
      const v = readValue(rest, i, 'link', '--actor'); if ('kind' in v) return v; actor = v.value; i = v.next;
    } else if (arg === '--props') {
      const v = readValue(rest, i, 'link', '--props'); if ('kind' in v) return v;
      try { props = JSON.parse(v.value); } catch { return err(`'brain link': --props must be valid JSON`); }
      i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain link': ${arg}`);
    else positionals.push(arg);
  }

  if (positionals.length !== 3) {
    return err(`'brain link' takes 3 positional args: <src-slug> <rel> <dst-slug>`);
  }
  return {
    kind: 'ok',
    subcommand: 'link',
    json,
    srcSlug: positionals[0]!,
    rel: positionals[1]!,
    dstSlug: positionals[2]!,
    kindSrc,
    kindDst,
    props,
    actor,
  };
}

function parseGet(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let entKind: string | undefined;
  let slug: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind') {
      const v = readValue(rest, i, 'get', '--kind'); if ('kind' in v) return v; entKind = v.value; i = v.next;
    } else if (arg === '--slug') {
      const v = readValue(rest, i, 'get', '--slug'); if ('kind' in v) return v; slug = v.value; i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain get': ${arg}`);
    else return err(`'brain get': unexpected positional argument '${arg}'`);
  }
  if (entKind === undefined) return err(`'brain get': --kind is required`);
  if (slug === undefined) return err(`'brain get': --slug is required`);
  return { kind: 'ok', subcommand: 'get', json, entKind, slug };
}

function parseTable(rest: readonly string[]): ParsedBrainArgs {
  const [op, ...tail] = rest;
  if (op === undefined) return err(`'brain table' requires an op: create | list`);
  if (op !== 'create' && op !== 'list') {
    return err(`unknown 'brain table' op '${op}' (available: create | list)`);
  }

  let json = false;
  if (op === 'list') {
    for (let i = 0; i < tail.length; i++) {
      const arg = tail[i]!;
      if (arg === '--json') json = true;
      else return err(`unknown flag for 'brain table list': ${arg}`);
    }
    return { kind: 'ok', subcommand: 'table', json, op: 'list' };
  }

  let name: string | undefined;
  const columns: { name: string; type: string }[] = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--col') {
      const v = readValue(tail, i, 'table create', '--col'); if ('kind' in v) return v;
      const colon = v.value.indexOf(':');
      if (colon <= 0) return err(`'brain table create': --col must be name:type`);
      columns.push({ name: v.value.slice(0, colon), type: v.value.slice(colon + 1) });
      i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain table create': ${arg}`);
    else if (name === undefined) name = arg;
    else return err(`'brain table create': unexpected positional argument '${arg}'`);
  }
  if (name === undefined) return err(`'brain table create' requires a table name`);
  if (columns.length === 0) return err(`'brain table create' requires at least one --col name:type`);
  return { kind: 'ok', subcommand: 'table', json, op: 'create', name, columns };
}

function parseSql(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let query: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) return err(`unknown flag for 'brain sql': ${arg}`);
    else if (query === undefined) query = arg;
    else return err(`'brain sql' takes a single quoted query argument`);
  }
  if (query === undefined) return err(`'brain sql' requires a query argument`);
  return { kind: 'ok', subcommand: 'sql', json, query };
}
