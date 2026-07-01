import chalk from 'chalk';
import { EXIT_OK, EXIT_ERROR, RosterError } from '../lib/errors.ts';
import { CANONICAL_STATES, type CanonicalState } from '../lib/tasks/machine.ts';
import { runTaskSetup, type TaskSetupResult } from '../lib/tasks/setup.ts';
import {
  assignedScope,
  deriveCurrentState,
  loadTaskContext,
  planVerb,
  readyScope,
  resolveSelector,
  type TaskContext,
  type VerbName,
} from '../lib/tasks/context.ts';
import type { Task, TaskSummary } from '../lib/tasks/adapters/types.ts';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

// Positional args = tokens that are neither a flag nor a value consumed by one of
// the value-taking flags.
function positionals(argv: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('-')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function parseMap(spec: string): Partial<Record<CanonicalState, string>> {
  const out: Partial<Record<CanonicalState, string>> = {};
  const valid = new Set<string>(CANONICAL_STATES);
  for (const pair of spec.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw usageError(`bad --map segment '${pair.trim()}' — expected <state>=<StatusName>`);
    }
    const state = pair.slice(0, eq).trim();
    const name = pair.slice(eq + 1).trim();
    if (!valid.has(state)) {
      throw usageError(`--map: '${state}' is not a canonical state (${CANONICAL_STATES.join(', ')})`);
    }
    if (name.length === 0) {
      throw usageError(`--map: '${state}=' has an empty status name`);
    }
    out[state as CanonicalState] = name;
  }
  return out;
}

function usageError(detail: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ${detail}`,
    body: '  Usage: roster task setup --data-source <collection://…|uuid> [--map ready=…,active=…,done=…] [--status-property N] [--assignee-property N] [--yes] [--json]',
    remedy: `  Run ${chalk.bold('roster task --help')} for details.`,
    exitCode: EXIT_ERROR,
  });
}

function verbUsageError(detail: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ${detail}`,
    body: '  Usage: roster task <claim|start|submit|done|revise|block|unblock|cancel> <selector> [--reason <why>] [--json] [--cwd <dir>]',
    remedy: `  A selector is a unique id (TASK-123), a page id, or part of the title.`,
    exitCode: EXIT_ERROR,
  });
}

function renderPreview(result: TaskSetupResult): void {
  const map = result.config.status_map ?? {};
  console.log('');
  console.log(chalk.bold('roster task setup') + chalk.dim(result.written ? '  (wrote roster/tracker.yaml)' : '  (preview — nothing written)'));
  console.log(`  data source : ${chalk.cyan(result.config.data_source_id ?? '?')}`);
  console.log(`  status prop : ${result.config.status_property ?? '?'}`);
  console.log(`  assignee    : ${result.config.assignee_property ?? '?'}`);
  if (result.config.unique_id_property) console.log(`  unique id   : ${result.config.unique_id_property}`);
  console.log('  status map  :');
  for (const state of CANONICAL_STATES) {
    const v = (map as Record<string, string>)[state];
    if (v) console.log(`    ${state.padEnd(10)} → ${chalk.green(v)}`);
  }
  for (const w of result.warnings) console.log(`  ${chalk.yellow('⚠')} ${w}`);
  if (!result.written) console.log(chalk.dim('\n  Re-run with --yes to write roster/tracker.yaml.'));
  console.log('');
}

async function executeTaskSetup(argv: string[]): Promise<number> {
  const dataSource = flagValue(argv, '--data-source');
  if (!dataSource) throw usageError('--data-source is required');

  const mapSpec = flagValue(argv, '--map');
  const result = await runTaskSetup({
    cwd: flagValue(argv, '--cwd') ?? process.cwd(),
    dataSourceId: dataSource,
    overrides: mapSpec ? parseMap(mapSpec) : undefined,
    statusProperty: flagValue(argv, '--status-property'),
    assigneeProperty: flagValue(argv, '--assignee-property'),
    write: hasFlag(argv, '--yes'),
  });

  if (hasFlag(argv, '--json')) {
    console.log(
      JSON.stringify(
        { ok: true, written: result.written, path: result.path, config: result.config, warnings: result.warnings },
        null,
        2,
      ),
    );
  } else {
    renderPreview(result);
  }
  return EXIT_OK;
}

export interface VerbOutcome {
  verb: VerbName;
  handle: string;
  title: string;
  from: CanonicalState;
  to: CanonicalState;
  changed: boolean;
  effects: string[];
  note?: string;
}

// Apply a verb to a task: reject illegal transitions, converge claim/block
// side effects, and collapse over unmapped pass-through states. Exported for
// unit tests (the CLI path calls it through executeTaskVerb).
export async function applyVerb(
  ctx: TaskContext,
  verb: VerbName,
  task: Task,
  current: CanonicalState,
  reason: string | undefined,
): Promise<VerbOutcome> {
  const out: VerbOutcome = { verb, handle: task.handle, title: task.title, from: current, to: current, changed: false, effects: [] };
  const plan = planVerb(ctx, current, verb);

  if (plan.kind === 'illegal') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} can't ${verb} — ${task.handle} is ${current}`,
      body: `  Allowed from ${current}: ${plan.allowed.length ? plan.allowed.join(', ') : '(none)'}`,
      remedy: `  Run ${chalk.bold(`roster task status ${task.handle}`)} to inspect it.`,
      exitCode: EXIT_ERROR,
    });
  }

  // claim — convergent: ensure self-assigned + claimed-status (if mapped),
  // whether the transition is a move or an idempotent no-op.
  if (verb === 'claim') {
    const mine = task.assigneeIds.length === 1 && task.assigneeIds[0] === ctx.self.id;
    if (!mine) {
      await ctx.adapter.setAssignee(task.id, ctx.self.id);
      out.effects.push(task.assigneeIds.length > 0 ? 'reassigned to you' : 'assigned to you');
      out.changed = true;
    }
    const claimedName = ctx.forward.get('claimed');
    if (claimedName && task.status !== claimedName) {
      await ctx.adapter.setStatus(task.id, claimedName);
      out.effects.push(`status → ${claimedName}`);
      out.changed = true;
    }
    out.to = 'claimed';
    if (!out.changed) out.note = 'already claimed by you';
    return out;
  }

  // block — convergent comment; status only when `blocked` is a real stop. The
  // comment goes FIRST: if it fails the status is untouched (task stays where it
  // was) and a retry is clean; the reason — the signal teammates need — is never
  // lost to a status write that outlived it. A retry after a successful comment
  // can duplicate it (Notion comments have no idempotency key).
  if (verb === 'block') {
    await ctx.adapter.comment(task.id, `🚧 Blocked: ${reason}`);
    out.effects.push('comment posted');
    out.changed = true;
    if (plan.kind === 'move' && plan.statusName) {
      await ctx.adapter.setStatus(task.id, plan.statusName);
      out.to = plan.to;
      out.effects.push(`status → ${plan.statusName}`);
    } else if (plan.kind === 'noop') {
      out.to = 'blocked'; // already blocked (mapped) — the comment is the only change
    } else {
      out.note = "no 'blocked' stage on this board — recorded the reason as a comment";
    }
    return out;
  }

  switch (plan.kind) {
    case 'noop':
      out.note = `already ${current}`;
      return out;
    case 'move':
      if (plan.statusName) {
        await ctx.adapter.setStatus(task.id, plan.statusName);
        out.effects.push(`status → ${plan.statusName}`);
        out.changed = true;
      }
      out.to = plan.to;
      return out;
    case 'bridge':
      await ctx.adapter.setStatus(task.id, plan.statusName);
      out.effects.push(`status → ${plan.statusName} (skipped unmapped ${plan.through})`);
      out.changed = true;
      out.to = plan.to;
      return out;
    case 'passthrough':
      out.note = passthroughNote(verb);
      return out;
  }
}

function passthroughNote(verb: VerbName): string {
  if (verb === 'submit') return "no 'review' stage on this board — run `roster task done` when finished";
  if (verb === 'cancel') return "no 'cancelled' status mapped — add one with `roster task setup` to cancel on the board";
  return 'nothing to change on this board';
}

function renderOutcome(out: VerbOutcome): void {
  if (out.changed) {
    const arrow = out.from === out.to ? out.to : `${out.from} → ${out.to}`;
    console.log(`${chalk.green('✓')} ${chalk.bold(out.handle)}  ${arrow}${out.effects.length ? chalk.dim(`  (${out.effects.join(', ')})`) : ''}`);
  } else {
    console.log(`${chalk.yellow('•')} ${chalk.bold(out.handle)}  ${chalk.dim(out.note ?? 'no change')}`);
  }
}

async function executeTaskVerb(verb: VerbName, argv: string[]): Promise<number> {
  const cwd = flagValue(argv, '--cwd') ?? process.cwd();
  const json = hasFlag(argv, '--json');
  const reason = flagValue(argv, '--reason');
  const [selector] = positionals(argv, ['--reason', '--cwd']);
  if (!selector) throw verbUsageError(`roster task ${verb} needs a task selector`);
  if (verb === 'block' && !reason) throw verbUsageError('roster task block requires --reason "<why>"');

  const ctx = await loadTaskContext({ cwd });
  const task = await resolveSelector(ctx, selector);
  const current = deriveCurrentState(ctx, task);
  const out = await applyVerb(ctx, verb, task, current, reason);

  if (json) {
    console.log(JSON.stringify({ ok: true, ...out, note: out.note ?? null }, null, 2));
  } else {
    renderOutcome(out);
  }
  return EXIT_OK;
}

export interface ReportRow {
  handle: string;
  title: string;
  status: string;
  canonical: CanonicalState;
}

function summaryRow(ctx: TaskContext, t: TaskSummary): ReportRow {
  return { handle: t.handle, title: t.title, status: t.status, canonical: deriveCurrentState(ctx, t) };
}

// Split the Ready pool + my-assigned tasks into the claimable pool (unassigned
// Ready) and my in-flight tasks. A Ready task assigned to me belongs under
// in-flight (it derives to `claimed` via the overlay when `claimed` is unmapped),
// NOT the pool — otherwise claimed work vanishes from the report. Dedup by id so a
// task returned by both queries appears once.
export function composeReport(
  ctx: TaskContext,
  ready: TaskSummary[],
  mine: TaskSummary[],
): { pool: ReportRow[]; inFlight: ReportRow[] } {
  const pool = ready.filter((t) => t.assigneeIds.length === 0).map((t) => summaryRow(ctx, t));
  const byId = new Map<string, TaskSummary>();
  for (const t of ready.filter((t) => t.assigneeIds.includes(ctx.self.id))) byId.set(t.id, t);
  for (const t of mine) byId.set(t.id, t);
  const inFlight = [...byId.values()].map((t) => summaryRow(ctx, t));
  return { pool, inFlight };
}

async function executeTaskStatus(argv: string[]): Promise<number> {
  const cwd = flagValue(argv, '--cwd') ?? process.cwd();
  const json = hasFlag(argv, '--json');
  const [selector] = positionals(argv, ['--cwd']);
  const ctx = await loadTaskContext({ cwd });

  if (selector) {
    const task = await resolveSelector(ctx, selector);
    const canonical = deriveCurrentState(ctx, task);
    if (json) {
      console.log(JSON.stringify({ ok: true, handle: task.handle, title: task.title, status: task.status, canonical, assignees: task.assigneeIds }, null, 2));
    } else {
      console.log(`${chalk.bold(task.handle)}  ${task.title}`);
      console.log(`  stage : ${chalk.cyan(canonical)}  ${chalk.dim(`(status: ${task.status})`)}`);
      console.log(`  mine  : ${task.assigneeIds.includes(ctx.self.id) ? chalk.green('yes') : chalk.dim('no')}`);
    }
    return EXIT_OK;
  }

  const [ready, mine] = await Promise.all([
    ctx.adapter.listReady(readyScope(ctx)),
    ctx.adapter.listAssigned(assignedScope(ctx)),
  ]);
  const { pool, inFlight } = composeReport(ctx, ready, mine);

  if (json) {
    console.log(JSON.stringify({ ok: true, pool, in_flight: inFlight, self: ctx.self }, null, 2));
    return EXIT_OK;
  }

  console.log('');
  console.log(chalk.bold(`roster tasks`) + chalk.dim(`  (you: ${ctx.self.name ?? ctx.self.email ?? ctx.self.id})`));
  console.log(chalk.bold(`\n  Claimable pool (unassigned Ready)`));
  if (pool.length === 0) console.log(chalk.dim('    (none)'));
  for (const r of pool) console.log(`    ${r.handle.padEnd(10)} ${r.title}`);
  console.log(chalk.bold(`\n  Your in-flight tasks`));
  if (inFlight.length === 0) console.log(chalk.dim('    (none)'));
  for (const r of inFlight) console.log(`    ${chalk.cyan(r.canonical.padEnd(8))} ${r.handle.padEnd(10)} ${r.title}`);
  console.log('');
  return EXIT_OK;
}

const VERBS: readonly VerbName[] = ['claim', 'start', 'block', 'unblock', 'submit', 'done', 'revise', 'cancel'];

export async function runTask(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === 'setup') return executeTaskSetup(argv.slice(1));
  if (sub === 'list' || sub === 'status') return executeTaskStatus(argv.slice(1));
  if (sub && (VERBS as readonly string[]).includes(sub)) {
    return executeTaskVerb(sub as VerbName, argv.slice(1));
  }
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} unknown task subcommand ${sub ? chalk.yellow(`'${sub}'`) : '(none)'}`,
    body: `  Available: setup, list, status, ${VERBS.join(', ')}`,
    remedy: `  Run ${chalk.bold('roster task setup --data-source <id>')} to configure, then ${chalk.bold('roster task list')}.`,
    exitCode: EXIT_ERROR,
  });
}
