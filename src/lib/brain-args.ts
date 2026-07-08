import { RUNTIME_ROLE } from './brain/roles.ts';

type BrainSubcommand =
  | 'init'
  | 'doctor'
  | 'save'
  | 'event'
  | 'link'
  | 'merge'
  | 'get'
  | 'table'
  | 'sql'
  | 'mount'
  | 'export'
  | 'import'
  | 'query'
  | 'config'
  | 'reindex'
  | 'gc'
  | 'fs';

const BRAIN_SUBCOMMANDS: ReadonlySet<BrainSubcommand> = new Set<BrainSubcommand>([
  'init',
  'doctor',
  'save',
  'event',
  'link',
  'merge',
  'get',
  'table',
  'sql',
  'mount',
  'export',
  'import',
  'query',
  'config',
  'reindex',
  'gc',
  'fs',
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
  | {
      kind: 'ok';
      subcommand: 'merge';
      json: boolean;
      fromSlug: string;
      intoSlug: string;
      entKind?: string;
      actor?: string;
    }
  | { kind: 'ok'; subcommand: 'get'; json: boolean; entKind: string; slug: string }
  | { kind: 'ok'; subcommand: 'table'; json: boolean; op: 'create'; name: string; columns: { name: string; type: string }[] }
  | { kind: 'ok'; subcommand: 'table'; json: boolean; op: 'list' }
  | { kind: 'ok'; subcommand: 'sql'; json: boolean; query: string }
  | { kind: 'ok'; subcommand: 'mount'; json: boolean; file: string }
  | { kind: 'ok'; subcommand: 'export'; json: boolean; outDir?: string; format: 'jsonl' | 'sql' }
  | { kind: 'ok'; subcommand: 'import'; json: boolean; dir: string }
  | { kind: 'ok'; subcommand: 'query'; json: boolean; text: string; entKind?: string; limit?: number }
  | { kind: 'ok'; subcommand: 'config'; json: boolean; op: 'get'; key?: string }
  | { kind: 'ok'; subcommand: 'config'; json: boolean; op: 'set'; key: string; value: string }
  | { kind: 'ok'; subcommand: 'reindex'; json: boolean; all: boolean; since?: string; model?: string; yes: boolean }
  | { kind: 'ok'; subcommand: 'gc'; json: boolean; olderThan?: string; yes: boolean }
  | { kind: 'ok'; subcommand: 'fs'; op: 'put'; json: boolean; entKind: string; slug: string; file: string; filename?: string; actor?: string }
  | { kind: 'ok'; subcommand: 'fs'; op: 'get'; json: boolean; entKind: string; slug: string; filename: string; out?: string }
  | { kind: 'ok'; subcommand: 'fs'; op: 'ls'; json: boolean; entKind?: string; slug?: string }
  | { kind: 'ok'; subcommand: 'fs'; op: 'rm'; json: boolean; entKind: string; slug: string; filename: string; actor?: string }
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
  if (first === 'merge') return parseMerge(rest);
  if (first === 'get') return parseGet(rest);
  if (first === 'table') return parseTable(rest);
  if (first === 'mount') return parseMount(rest);
  if (first === 'export') return parseExport(rest);
  if (first === 'import') return parseImport(rest);
  if (first === 'query') return parseQuery(rest);
  if (first === 'config') return parseConfig(rest);
  if (first === 'reindex') return parseReindex(rest);
  if (first === 'gc') return parseGc(rest);
  if (first === 'fs') return parseFs(rest);
  return parseSql(rest);
}

function parseFs(rest: readonly string[]): ParsedBrainArgs {
  const [op, ...tail] = rest;
  if (op !== 'put' && op !== 'get' && op !== 'ls' && op !== 'rm') {
    return err(`'brain fs' requires an op: put | get | ls | rm`);
  }
  let json = false;
  let entKind: string | undefined;
  let slug: string | undefined;
  let filename: string | undefined;
  let out: string | undefined;
  let actor: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind') {
      const v = readValue(tail, i, `fs ${op}`, '--kind'); if ('kind' in v) return v; entKind = v.value; i = v.next;
    } else if (arg === '--slug') {
      const v = readValue(tail, i, `fs ${op}`, '--slug'); if ('kind' in v) return v; slug = v.value; i = v.next;
    } else if (arg === '--filename' && op === 'put') {
      const v = readValue(tail, i, `fs ${op}`, '--filename'); if ('kind' in v) return v; filename = v.value; i = v.next;
    } else if (arg === '--out' && op === 'get') {
      const v = readValue(tail, i, `fs ${op}`, '--out'); if ('kind' in v) return v; out = v.value; i = v.next;
    } else if (arg === '--actor' && (op === 'put' || op === 'rm')) {
      const v = readValue(tail, i, `fs ${op}`, '--actor'); if ('kind' in v) return v; actor = v.value; i = v.next;
    } else if (arg.startsWith('-')) {
      return err(`unknown flag for 'brain fs ${op}': ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (op === 'ls') {
    if (positionals.length > 0) return err(`'brain fs ls' takes no positional arguments`);
    if (slug !== undefined && entKind === undefined) return err(`'brain fs ls': --slug requires --kind`);
    return { kind: 'ok', subcommand: 'fs', op: 'ls', json, entKind, slug };
  }

  // put/get/rm all require an entity address.
  if (entKind === undefined) return err(`'brain fs ${op}' requires --kind`);
  if (slug === undefined) return err(`'brain fs ${op}' requires --slug`);

  if (op === 'put') {
    if (positionals.length !== 1) return err(`'brain fs put' takes exactly one <file> argument`);
    return { kind: 'ok', subcommand: 'fs', op: 'put', json, entKind, slug, file: positionals[0]!, filename, actor };
  }
  // get | rm both take a single <filename> positional.
  if (positionals.length !== 1) return err(`'brain fs ${op}' takes exactly one <filename> argument`);
  if (op === 'get') {
    return { kind: 'ok', subcommand: 'fs', op: 'get', json, entKind, slug, filename: positionals[0]!, out };
  }
  return { kind: 'ok', subcommand: 'fs', op: 'rm', json, entKind, slug, filename: positionals[0]!, actor };
}

function parseReindex(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let all = false;
  let yes = false;
  let since: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--all') all = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--since') {
      const v = readValue(rest, i, 'reindex', '--since'); if ('kind' in v) return v; since = v.value; i = v.next;
    } else if (arg === '--model') {
      const v = readValue(rest, i, 'reindex', '--model'); if ('kind' in v) return v; model = v.value; i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain reindex': ${arg}`);
    else return err(`'brain reindex' takes no positional arguments`);
  }
  if (all && since !== undefined) {
    return err(`'brain reindex': --all and --since are mutually exclusive`);
  }
  return { kind: 'ok', subcommand: 'reindex', json, all, since, model, yes };
}

function parseGc(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let yes = false;
  let olderThan: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--older-than') {
      const v = readValue(rest, i, 'gc', '--older-than'); if ('kind' in v) return v; olderThan = v.value; i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain gc': ${arg}`);
    else return err(`'brain gc' takes no positional arguments`);
  }
  return { kind: 'ok', subcommand: 'gc', json, olderThan, yes };
}

function parseQuery(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let entKind: string | undefined;
  let limit: number | undefined;
  let text: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind') {
      const v = readValue(rest, i, 'query', '--kind'); if ('kind' in v) return v; entKind = v.value; i = v.next;
    } else if (arg === '--limit') {
      const v = readValue(rest, i, 'query', '--limit'); if ('kind' in v) return v;
      const n = Number(v.value);
      if (!Number.isInteger(n) || n < 1) return err(`'brain query': --limit must be a positive integer`);
      limit = n; i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain query': ${arg}`);
    else if (text === undefined) text = arg;
    else return err(`'brain query' takes a single quoted query string`);
  }
  if (text === undefined || text.trim().length === 0) return err(`'brain query' requires a non-empty query string`);
  return { kind: 'ok', subcommand: 'query', json, text, entKind, limit };
}

function parseConfig(rest: readonly string[]): ParsedBrainArgs {
  const [op, ...tail] = rest;
  if (op !== 'get' && op !== 'set') {
    return err(`'brain config' requires an op: get | set`);
  }
  let json = false;
  const positionals: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i]!;
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) return err(`unknown flag for 'brain config ${op}': ${arg}`);
    else positionals.push(arg);
  }
  if (op === 'get') {
    if (positionals.length > 1) return err(`'brain config get' takes an optional single key`);
    return { kind: 'ok', subcommand: 'config', json, op: 'get', key: positionals[0] };
  }
  if (positionals.length !== 2) return err(`'brain config set' takes <key> <value>`);
  return { kind: 'ok', subcommand: 'config', json, op: 'set', key: positionals[0]!, value: positionals[1]! };
}

function parseExport(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let outDir: string | undefined;
  let format: 'jsonl' | 'sql' = 'jsonl';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--out') {
      const v = readValue(rest, i, 'export', '--out'); if ('kind' in v) return v; outDir = v.value; i = v.next;
    } else if (arg === '--format') {
      const v = readValue(rest, i, 'export', '--format'); if ('kind' in v) return v;
      if (v.value !== 'jsonl' && v.value !== 'sql') {
        return err(`'brain export': --format must be 'jsonl' or 'sql'`);
      }
      format = v.value;
      i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain export': ${arg}`);
    else return err(`'brain export': unexpected positional argument '${arg}'`);
  }
  return { kind: 'ok', subcommand: 'export', json, outDir, format };
}

function parseImport(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let dir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) return err(`unknown flag for 'brain import': ${arg}`);
    else if (dir === undefined) dir = arg;
    else return err(`'brain import' takes a single directory argument`);
  }
  if (dir === undefined) return err(`'brain import' requires a backup directory argument`);
  return { kind: 'ok', subcommand: 'import', json, dir };
}

function parseMount(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let file: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) return err(`unknown flag for 'brain mount': ${arg}`);
    else if (file === undefined) file = arg;
    else return err(`'brain mount' takes a single file argument`);
  }
  if (file === undefined) return err(`'brain mount' requires a file argument`);
  return { kind: 'ok', subcommand: 'mount', json, file };
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

function parseMerge(rest: readonly string[]): ParsedBrainArgs {
  let json = false;
  let entKind: string | undefined;
  let actor: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--kind') {
      const v = readValue(rest, i, 'merge', '--kind'); if ('kind' in v) return v; entKind = v.value; i = v.next;
    } else if (arg === '--actor') {
      const v = readValue(rest, i, 'merge', '--actor'); if ('kind' in v) return v; actor = v.value; i = v.next;
    } else if (arg.startsWith('-')) return err(`unknown flag for 'brain merge': ${arg}`);
    else positionals.push(arg);
  }

  if (positionals.length !== 2) {
    return err(`'brain merge' takes 2 positional args: <from-slug> <into-slug>`);
  }
  return {
    kind: 'ok',
    subcommand: 'merge',
    json,
    fromSlug: positionals[0]!,
    intoSlug: positionals[1]!,
    entKind,
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
