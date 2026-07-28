import { resolve } from 'node:path';
import { invalidFunctionNameMessage, isFunctionName } from './workspace-path.ts';

// Hand-rolled argv parser for `roster run` (#323 section C). Mirrors the
// ops/task parsing style: no dep, a discriminated union out. Semantic
// validation (which flags a given verb requires) lives in the command module —
// this layer only decodes syntax and rejects unknown flags.

export const RUN_VERBS = [
  'start',
  'end',
  'event',
  'report',
  'declare-artifact',
  'show',
  'list',
  'doctor',
  'repair',
] as const;
export type RunVerb = (typeof RUN_VERBS)[number];

const RUN_VERB_SET: ReadonlySet<string> = new Set(RUN_VERBS);

export type RunOptions = {
  cwd: string | undefined;
  json: boolean;
  allowPartial: boolean;
  // positional or --run
  runId: string | undefined;
  // event
  eventKind: string | undefined;
  correlationId: string | undefined;
  data: string | undefined;
  // shared semantic metadata
  agent: string | undefined;
  skill: string | undefined;
  trigger: string | undefined;
  parentRun: string | undefined;
  originTask: string | undefined;
  // start only: also stamp the fire's run-id + timestamp into the per-fire
  // schedule sidecar (logs/cron/<function>/<name>/<fireId>.run-id) atomically,
  // for delayed failure correlation. --schedule needs --function; --fire-id
  // overrides ROSTER_FIRE_ID (the cron wrapper's minted token) for tests.
  schedule: string | undefined;
  functionName: string | undefined;
  fireId: string | undefined;
  // report + declare-artifact byte input
  file: string | undefined;
  stdin: boolean;
  // declare-artifact
  digest: string | undefined;
  role: string | undefined;
  filename: string | undefined;
  artifactType: string | undefined;
  mediaType: string | undefined;
  text: string | undefined;
  external: string | undefined;
  url: string | undefined;
  // list
  task: string | undefined;
  limit: number | undefined;
  // repair
  fillVersionIds: boolean;
  yes: boolean;
};

export type ParsedRunArgs =
  | { kind: 'ok'; verb: RunVerb; opts: RunOptions }
  | { kind: 'usage' }
  | { kind: 'err'; message: string };

const VALUE_FLAGS = new Set([
  '--cwd',
  '--run',
  '--kind',
  '--correlation-id',
  '--data',
  '--agent',
  '--skill',
  '--trigger',
  '--parent-run',
  '--origin-task',
  '--schedule',
  '--function',
  '--fire-id',
  '--file',
  '--digest',
  '--role',
  '--filename',
  '--type',
  '--media-type',
  '--text',
  '--external',
  '--url',
  '--task',
  '--limit',
]);

export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  const [sub, ...rest] = args;
  if (sub === undefined || !RUN_VERB_SET.has(sub)) return { kind: 'usage' };
  const verb = sub as RunVerb;

  const opts: RunOptions = {
    cwd: undefined,
    json: false,
    allowPartial: false,
    runId: undefined,
    eventKind: undefined,
    correlationId: undefined,
    data: undefined,
    agent: undefined,
    skill: undefined,
    trigger: undefined,
    parentRun: undefined,
    originTask: undefined,
    schedule: undefined,
    functionName: undefined,
    fireId: undefined,
    file: undefined,
    stdin: false,
    digest: undefined,
    role: undefined,
    filename: undefined,
    artifactType: undefined,
    mediaType: undefined,
    text: undefined,
    external: undefined,
    url: undefined,
    task: undefined,
    limit: undefined,
    fillVersionIds: false,
    yes: false,
  };

  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--allow-partial') {
      opts.allowPartial = true;
      continue;
    }
    if (arg === '--stdin') {
      opts.stdin = true;
      continue;
    }
    if (arg === '--fill-version-ids') {
      opts.fillVersionIds = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      opts.yes = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      return { kind: 'err', message: `unknown flag '${arg}' for 'run ${verb}'` };
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('-')) {
      return { kind: 'err', message: `${arg} requires a value` };
    }
    i++;
    switch (arg) {
      case '--cwd':
        // Round-13 finding 1: the workspace root becomes a confinement boundary,
        // and confinement requires an ABSOLUTE one — a relative `--cwd repo`
        // used to make the walk inspect `<pwd>/repo/repo/…`.
        opts.cwd = resolve(value);
        break;
      case '--run':
        opts.runId = value;
        break;
      case '--kind':
        opts.eventKind = value;
        break;
      case '--correlation-id':
        opts.correlationId = value;
        break;
      case '--data':
        opts.data = value;
        break;
      case '--agent':
        opts.agent = value;
        break;
      case '--skill':
        opts.skill = value;
        break;
      case '--trigger':
        opts.trigger = value;
        break;
      case '--parent-run':
        opts.parentRun = value;
        break;
      case '--origin-task':
        opts.originTask = value;
        break;
      case '--schedule':
        opts.schedule = value;
        break;
      case '--function':
        // ARGUMENT boundary (round-11 finding 1): the value becomes a path
        // segment in the per-fire correlation channel.
        if (!isFunctionName(value)) {
          return { kind: 'err', message: `--function: ${invalidFunctionNameMessage(value)}` };
        }
        opts.functionName = value;
        break;
      case '--fire-id':
        opts.fireId = value;
        break;
      case '--file':
        opts.file = value;
        break;
      case '--digest':
        opts.digest = value;
        break;
      case '--role':
        opts.role = value;
        break;
      case '--filename':
        opts.filename = value;
        break;
      case '--type':
        opts.artifactType = value;
        break;
      case '--media-type':
        opts.mediaType = value;
        break;
      case '--text':
        opts.text = value;
        break;
      case '--external':
        opts.external = value;
        break;
      case '--url':
        opts.url = value;
        break;
      case '--task':
        opts.task = value;
        break;
      case '--limit': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { kind: 'err', message: `--limit must be a positive integer (got '${value}')` };
        }
        opts.limit = n;
        break;
      }
    }
  }

  // A leading positional names the run for the run-centric verbs; --run wins if
  // both are given for the same verb.
  if (opts.runId === undefined && positionals.length > 0) opts.runId = positionals[0];
  if (positionals.length > 1) {
    return { kind: 'err', message: `unexpected extra argument '${positionals[1]}' for 'run ${verb}'` };
  }

  return { kind: 'ok', verb, opts };
}
