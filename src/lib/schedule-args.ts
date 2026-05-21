import { TOOL_VALUES, type ToolValue } from './schedule-schema.ts';

export type ScheduleSubcommand = 'validate' | 'install' | 'list' | 'remove' | 'status' | 'run' | 'estimate-usage';

export const SCHEDULE_SUBCOMMANDS: ReadonlySet<ScheduleSubcommand> = new Set<ScheduleSubcommand>([
  'validate',
  'install',
  'list',
  'remove',
  'status',
  'run',
  'estimate-usage',
]);

const SUBCOMMAND_LIST = Array.from(SCHEDULE_SUBCOMMANDS).join(' | ');
const TOOL_LIST = TOOL_VALUES.join(' | ');

export type ViaMode = 'cron';
export const VIA_VALUES = ['cron'] as const;
const VIA_LIST = VIA_VALUES.join(' | ');

export type ParsedScheduleArgs =
  | {
      kind: 'ok';
      subcommand: 'validate';
      json: boolean;
      silent: boolean;
      cwd: string | undefined;
      dryRun: boolean;
    }
  | {
      kind: 'ok';
      subcommand: 'install';
      functionName: string;
      agent: string;
      plan: string;
      cron: string;
      tool: ToolValue;
      via: ViaMode | undefined;
      name: string | undefined;
      dryRun: boolean;
      cloudRoutine: boolean;
      json: boolean;
      silent: boolean;
      cwd: string | undefined;
    }
  | {
      kind: 'ok';
      subcommand: 'list';
      json: boolean;
      silent: boolean;
      cwd: string | undefined;
      dryRun: boolean;
    }
  | {
      kind: 'ok';
      subcommand: 'remove';
      name: string;
      functionName: string | undefined;
      dryRun: boolean;
      yes: boolean;
      json: boolean;
      silent: boolean;
      cwd: string | undefined;
    }
  | {
      kind: 'ok';
      subcommand: 'status';
      name: string;
      functionName: string | undefined;
      json: boolean;
      silent: boolean;
      cwd: string | undefined;
      dryRun: boolean;
    }
  | {
      kind: 'ok';
      subcommand: 'run';
      name: string;
      functionName: string | undefined;
      silent: boolean;
      cwd: string | undefined;
      dryRun: boolean;
    }
  | {
      kind: 'ok';
      subcommand: 'estimate-usage';
      json: boolean;
      silent: boolean;
      cwd: string | undefined;
      dryRun: boolean;
      plan: string | undefined;
      warnThreshold: number;
    }
  | { kind: 'err'; message: string };

function isScheduleSubcommand(value: string): value is ScheduleSubcommand {
  return SCHEDULE_SUBCOMMANDS.has(value as ScheduleSubcommand);
}

function isToolValue(value: string): value is ToolValue {
  return (TOOL_VALUES as readonly string[]).includes(value);
}

function isViaMode(value: string): value is ViaMode {
  return (VIA_VALUES as readonly string[]).includes(value);
}

export function parseScheduleArgs(args: readonly string[]): ParsedScheduleArgs {
  const [first, ...rest] = args;
  if (first === undefined) {
    return { kind: 'err', message: `missing subcommand for 'schedule' (available: ${SUBCOMMAND_LIST})` };
  }
  if (!isScheduleSubcommand(first)) {
    return {
      kind: 'err',
      message: `unknown 'schedule' subcommand '${first}' (available: ${SUBCOMMAND_LIST})`,
    };
  }

  if (first === 'validate') return parseValidate(rest);
  if (first === 'install') return parseInstall(rest);
  if (first === 'list') return parseList(rest);
  if (first === 'remove') return parseNamed(rest, 'remove');
  if (first === 'status') return parseNamed(rest, 'status');
  if (first === 'run') return parseNamed(rest, 'run');
  return parseEstimateUsage(rest);
}

function parseEstimateUsage(rest: readonly string[]): ParsedScheduleArgs {
  let json = false;
  let silent = false;
  let cwd: string | undefined;
  let dryRun = false;
  let plan: string | undefined;
  // ROS-44 default: 70% of any plan ceiling triggers a warning.
  let warnThreshold = 0.70;

  const parsePct = (raw: string): { ok: true; value: number } | { ok: false; message: string } => {
    const trimmed = raw.endsWith('%') ? raw.slice(0, -1) : raw;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return { ok: false, message: `--warn-threshold: expected a number (got '${raw}')` };
    }
    // Accept either 0..1 fraction or 1..100 percent. Treat n >= 2 as percent
    // (so `--warn-threshold 1` correctly means 100%, not 1%).
    const value = n >= 2 || raw.endsWith('%') ? n / 100 : n;
    if (value < 0 || value > 1) {
      return { ok: false, message: `--warn-threshold: must be between 0 and 100 (got '${raw}')` };
    }
    return { ok: true, value };
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--cwd') {
      const next = rest[i + 1];
      if (next === undefined) return { kind: 'err', message: '--cwd requires a path argument' };
      cwd = next;
      i++;
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length);
    } else if (arg === '--plan') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { kind: 'err', message: '--plan requires a plan id (e.g. claude-pro, chatgpt-plus)' };
      }
      plan = next;
      i++;
    } else if (arg.startsWith('--plan=')) {
      plan = arg.slice('--plan='.length);
    } else if (arg === '--warn-threshold') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { kind: 'err', message: '--warn-threshold requires a value (e.g. 70 or 0.7)' };
      }
      const r = parsePct(next);
      if (!r.ok) return { kind: 'err', message: r.message };
      warnThreshold = r.value;
      i++;
    } else if (arg.startsWith('--warn-threshold=')) {
      const r = parsePct(arg.slice('--warn-threshold='.length));
      if (!r.ok) return { kind: 'err', message: r.message };
      warnThreshold = r.value;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'schedule estimate-usage': ${arg}` };
    } else {
      return { kind: 'err', message: `unexpected positional argument for 'schedule estimate-usage': ${arg}` };
    }
  }

  return { kind: 'ok', subcommand: 'estimate-usage', json, silent, cwd, dryRun, plan, warnThreshold };
}

function parseValidate(rest: readonly string[]): ParsedScheduleArgs {
  let json = false;
  let silent = false;
  let cwd: string | undefined;
  let dryRun = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--cwd') {
      const next = rest[i + 1];
      if (next === undefined) return { kind: 'err', message: '--cwd requires a path argument' };
      cwd = next;
      i++;
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'schedule validate': ${arg}` };
    } else {
      return { kind: 'err', message: `unexpected positional argument for 'schedule validate': ${arg}` };
    }
  }

  return { kind: 'ok', subcommand: 'validate', json, silent, cwd, dryRun };
}

function parseInstall(rest: readonly string[]): ParsedScheduleArgs {
  const positionals: string[] = [];
  let cron: string | undefined;
  let toolRaw: string | undefined;
  let viaRaw: string | undefined;
  let name: string | undefined;
  let dryRun = false;
  let cloudRoutine = false;
  let json = false;
  let silent = false;
  let cwd: string | undefined;

  const consumeValue = (flag: string, current: string | undefined, next: string | undefined): { ok: true; value: string } | { ok: false; message: string } => {
    if (current !== undefined) {
      return { ok: false, message: `flag ${flag} specified more than once` };
    }
    if (next === undefined || next.startsWith('-')) {
      return { ok: false, message: `${flag} requires a value` };
    }
    return { ok: true, value: next };
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--cron') {
      const r = consumeValue('--cron', cron, rest[i + 1]);
      if (!r.ok) return { kind: 'err', message: r.message };
      cron = r.value;
      i++;
    } else if (arg.startsWith('--cron=')) {
      if (cron !== undefined) return { kind: 'err', message: 'flag --cron specified more than once' };
      cron = arg.slice('--cron='.length);
    } else if (arg === '--tool') {
      const r = consumeValue('--tool', toolRaw, rest[i + 1]);
      if (!r.ok) return { kind: 'err', message: r.message };
      toolRaw = r.value;
      i++;
    } else if (arg.startsWith('--tool=')) {
      if (toolRaw !== undefined) return { kind: 'err', message: 'flag --tool specified more than once' };
      toolRaw = arg.slice('--tool='.length);
    } else if (arg === '--via') {
      const r = consumeValue('--via', viaRaw, rest[i + 1]);
      if (!r.ok) return { kind: 'err', message: r.message };
      viaRaw = r.value;
      i++;
    } else if (arg.startsWith('--via=')) {
      if (viaRaw !== undefined) return { kind: 'err', message: 'flag --via specified more than once' };
      viaRaw = arg.slice('--via='.length);
    } else if (arg === '--name') {
      const r = consumeValue('--name', name, rest[i + 1]);
      if (!r.ok) return { kind: 'err', message: r.message };
      name = r.value;
      i++;
    } else if (arg.startsWith('--name=')) {
      if (name !== undefined) return { kind: 'err', message: 'flag --name specified more than once' };
      name = arg.slice('--name='.length);
    } else if (arg === '--project' || arg.startsWith('--project=')) {
      return { kind: 'err', message: '--project removed in v1.0 — see CHANGELOG' };
    } else if (arg === '--cwd') {
      const r = consumeValue('--cwd', cwd, rest[i + 1]);
      if (!r.ok) return { kind: 'err', message: r.message };
      cwd = r.value;
      i++;
    } else if (arg.startsWith('--cwd=')) {
      if (cwd !== undefined) return { kind: 'err', message: 'flag --cwd specified more than once' };
      cwd = arg.slice('--cwd='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--cloud-routine') {
      cloudRoutine = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'schedule install': ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 2) {
    return {
      kind: 'err',
      message:
        positionals.length === 0
          ? "missing positional arguments for 'schedule install' (expected: <function>/<agent> <plan>)"
          : `'schedule install' expected 2 positional arguments (<function>/<agent> <plan>), got ${positionals.length}`,
    };
  }

  const [fnAgent, plan] = positionals as [string, string];
  const slashIdx = fnAgent.indexOf('/');
  if (slashIdx <= 0 || slashIdx === fnAgent.length - 1) {
    return {
      kind: 'err',
      message: `first positional must be '<function>/<agent>' (got '${fnAgent}')`,
    };
  }
  const functionName = fnAgent.slice(0, slashIdx);
  const agent = fnAgent.slice(slashIdx + 1);
  if (agent.includes('/')) {
    return {
      kind: 'err',
      message: `first positional must be '<function>/<agent>' (got '${fnAgent}' — extra '/' in agent name)`,
    };
  }

  if (cron === undefined) return { kind: 'err', message: "missing required flag --cron for 'schedule install'" };
  if (toolRaw === undefined) return { kind: 'err', message: "missing required flag --tool for 'schedule install'" };
  if (!isToolValue(toolRaw)) {
    return { kind: 'err', message: `unknown tool '${toolRaw}' for --tool (expected: ${TOOL_LIST})` };
  }

  let via: ViaMode | undefined;
  if (viaRaw !== undefined) {
    if (!isViaMode(viaRaw)) {
      return { kind: 'err', message: `unknown --via mode '${viaRaw}' (expected: ${VIA_LIST})` };
    }
    via = viaRaw;
  }

  return {
    kind: 'ok',
    subcommand: 'install',
    functionName,
    agent,
    plan,
    cron,
    tool: toolRaw,
    via,
    name,
    dryRun,
    cloudRoutine,
    json,
    silent,
    cwd,
  };
}

function parseList(rest: readonly string[]): ParsedScheduleArgs {
  let json = false;
  let silent = false;
  let cwd: string | undefined;
  let dryRun = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--cwd') {
      const next = rest[i + 1];
      if (next === undefined) return { kind: 'err', message: '--cwd requires a path argument' };
      cwd = next;
      i++;
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'schedule list': ${arg}` };
    } else {
      return { kind: 'err', message: `unexpected positional argument for 'schedule list': ${arg}` };
    }
  }
  return { kind: 'ok', subcommand: 'list', json, silent, cwd, dryRun };
}

// Shared parser for remove/status/run — each takes a single positional <name>
// plus optional --function / --json / --silent / --cwd / (remove-only:
// --dry-run / --yes).
function parseNamed(rest: readonly string[], subcommand: 'remove' | 'status' | 'run'): ParsedScheduleArgs {
  const positionals: string[] = [];
  let functionName: string | undefined;
  let json = false;
  let silent = false;
  let cwd: string | undefined;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--function') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { kind: 'err', message: '--function requires a value' };
      }
      if (functionName !== undefined) return { kind: 'err', message: 'flag --function specified more than once' };
      functionName = next;
      i++;
    } else if (arg.startsWith('--function=')) {
      if (functionName !== undefined) return { kind: 'err', message: 'flag --function specified more than once' };
      functionName = arg.slice('--function='.length);
    } else if (arg === '--cwd') {
      const next = rest[i + 1];
      if (next === undefined) return { kind: 'err', message: '--cwd requires a path argument' };
      cwd = next;
      i++;
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length);
    } else if (arg === '--json') {
      if (subcommand === 'run') return { kind: 'err', message: "--json is not supported for 'schedule run' (streams child stdout)" };
      json = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      if (subcommand !== 'remove') return { kind: 'err', message: `--yes is only supported for 'schedule remove'` };
      yes = true;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for 'schedule ${subcommand}': ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) {
    return {
      kind: 'err',
      message:
        positionals.length === 0
          ? `missing positional <name> for 'schedule ${subcommand}'`
          : `'schedule ${subcommand}' expected 1 positional argument <name>, got ${positionals.length}`,
    };
  }

  const name = positionals[0]!;
  if (subcommand === 'remove') {
    return {
      kind: 'ok',
      subcommand: 'remove',
      name,
      functionName,
      dryRun,
      yes,
      json,
      silent,
      cwd,
    };
  }
  if (subcommand === 'status') {
    return {
      kind: 'ok',
      subcommand: 'status',
      name,
      functionName,
      json,
      silent,
      cwd,
      dryRun,
    };
  }
  return {
    kind: 'ok',
    subcommand: 'run',
    name,
    functionName,
    silent,
    cwd,
    dryRun,
  };
}
