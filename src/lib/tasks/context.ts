import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import chalk from 'chalk';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { NotionAdapter } from './adapters/notion.ts';
import type {
  AssignedScope,
  ReadyScope,
  Task,
  TaskIdentity,
  TaskSummary,
  TrackerAdapter,
} from './adapters/types.ts';
import {
  parseTrackerConfig,
  TrackerConfigError,
  type TrackerConfig,
} from './tracker-schema.ts';
import {
  allowedEvents,
  CANONICAL_STATES,
  transition,
  type CanonicalState,
  type TaskEvent,
} from './machine.ts';

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface TaskContext {
  config: TrackerConfig;
  adapter: TrackerAdapter;
  self: TaskIdentity;
  // canonical → board status name (only states the user mapped).
  forward: Map<CanonicalState, string>;
  // board status name → canonical (inverse of forward).
  reverse: Map<string, CanonicalState>;
}

export interface LoadTaskContextOptions {
  cwd: string;
  // Injected in tests; when absent a NotionAdapter is built from the config.
  adapter?: TrackerAdapter;
  token?: string;
  fetchImpl?: FetchImpl;
}

function rosterError(header: string, body: string, remedy: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ${header}`,
    body,
    remedy,
    exitCode: EXIT_ERROR,
  });
}

export function trackerConfigPath(cwd: string): string {
  return join(cwd, 'roster', 'tracker.yaml');
}

export function loadTrackerConfig(cwd: string): TrackerConfig {
  const path = trackerConfigPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw rosterError(
      'no roster/tracker.yaml found',
      `  Looked for ${path}`,
      `  Run ${chalk.bold('roster task setup --data-source <id>')} to configure it.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw rosterError('roster/tracker.yaml is not valid YAML', `  ${(err as Error).message}`, '  Fix the file or re-run roster task setup.');
  }
  try {
    return parseTrackerConfig(parsed);
  } catch (err) {
    if (err instanceof TrackerConfigError) {
      throw rosterError(
        'roster/tracker.yaml is invalid',
        err.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'),
        `  Re-run ${chalk.bold('roster task setup')} to regenerate it.`,
      );
    }
    throw err;
  }
}

// Invert status_map into forward + reverse. tracker.yaml can be hand-edited, so
// re-check that no board status backs two canonical states (setup guaranteed it
// at write time, but a manual edit may not).
export function buildMaps(config: TrackerConfig): Pick<TaskContext, 'forward' | 'reverse'> {
  const forward = new Map<CanonicalState, string>();
  const reverse = new Map<string, CanonicalState>();
  for (const [state, name] of Object.entries(config.status_map)) {
    if (!name) continue;
    forward.set(state as CanonicalState, name);
    const existing = reverse.get(name);
    if (existing) {
      throw rosterError(
        'roster/tracker.yaml maps one status to two states',
        `  status "${name}" backs both ${existing} and ${state}`,
        '  Give each canonical state a distinct status, then retry.',
      );
    }
    reverse.set(name, state as CanonicalState);
  }
  return { forward, reverse };
}

export async function loadTaskContext(opts: LoadTaskContextOptions): Promise<TaskContext> {
  const config = loadTrackerConfig(opts.cwd);
  const adapter =
    opts.adapter ??
    new NotionAdapter({
      dataSourceId: config.data_source_id,
      statusProp: config.status_property,
      assigneeProp: config.assignee_property,
      projectProp: config.project_property,
      uniqueIdProp: config.unique_id_property,
      token: opts.token,
      fetchImpl: opts.fetchImpl,
    });
  const self = await adapter.self();
  const { forward, reverse } = buildMaps(config);
  return { config, adapter, self, forward, reverse };
}

// A canonical state we can rest at: the three required states, `claimed` (mapped,
// or reconstructed from assignment since `ready` is always mapped), and any other
// optional state the user actually mapped. Unmapped optional states are
// pass-throughs — traversable but not restable.
export function isStop(ctx: TaskContext, state: CanonicalState): boolean {
  if (state === 'ready' || state === 'active' || state === 'done') return true;
  if (state === 'claimed') return true;
  return ctx.forward.has(state);
}

// Map a live board status back to a canonical state. The self-relative assignment
// overlay encodes the hybrid model ("a Ready task assigned to me is mine") — but
// only when `claimed` is unmapped, since a real claimed status already carries it.
export function deriveCurrentState(ctx: TaskContext, task: TaskSummary): CanonicalState {
  const base = ctx.reverse.get(task.status);
  if (!base) {
    throw rosterError(
      `task ${task.handle} is in an unmapped status`,
      `  status "${task.status}" is not in roster/tracker.yaml's status_map`,
      `  Map it with ${chalk.bold('roster task setup')} or move the task to a mapped status.`,
    );
  }
  if (base === 'ready' && !ctx.forward.has('claimed') && task.assigneeIds.includes(ctx.self.id)) {
    return 'claimed';
  }
  return base;
}

export type VerbName =
  | 'claim'
  | 'start'
  | 'block'
  | 'unblock'
  | 'submit'
  | 'done'
  | 'revise'
  | 'cancel';

interface VerbSpec {
  event: TaskEvent;
  target: CanonicalState;
}

const VERB_SPEC: Record<VerbName, VerbSpec> = {
  claim: { event: 'claim', target: 'claimed' },
  start: { event: 'start', target: 'active' },
  block: { event: 'block', target: 'blocked' },
  unblock: { event: 'unblock', target: 'active' },
  submit: { event: 'submit', target: 'review' },
  done: { event: 'signoff', target: 'done' },
  revise: { event: 'revise', target: 'active' },
  cancel: { event: 'cancel', target: 'cancelled' },
};

export type VerbPlan =
  | { kind: 'move'; to: CanonicalState; statusName?: string }
  | { kind: 'noop'; state: CanonicalState }
  | { kind: 'passthrough'; state: CanonicalState }
  | { kind: 'bridge'; to: CanonicalState; statusName: string; through: CanonicalState }
  | { kind: 'illegal'; current: CanonicalState; allowed: TaskEvent[] };

// Resolve a verb against the machine, collapsing over unmapped pass-through
// states (the owner chose "collapse"):
//  - move:        the target is a stop → persist its status (if mapped).
//  - noop:        idempotent — already at the target.
//  - passthrough: the target is an unmapped pass-through (submit→review, cancel→
//                 cancelled, block→blocked) → no status change; the caller applies
//                 the verb's durable side effect (block's comment) or a guided no-op.
//  - bridge:      the direct event is illegal but a single unmapped pass-through
//                 bridges to a real stop (done from active when review is unmapped).
//  - illegal:     no legal path.
export function planVerb(ctx: TaskContext, current: CanonicalState, verb: VerbName): VerbPlan {
  const { event, target } = VERB_SPEC[verb];
  const t = transition(current, event);
  if (!t.illegal) {
    if (t.next === current) return { kind: 'noop', state: current };
    if (isStop(ctx, t.next)) return { kind: 'move', to: t.next, statusName: ctx.forward.get(t.next) };
    return { kind: 'passthrough', state: t.next };
  }
  // One-level bridge: is there an unmapped pass-through X reachable from `current`
  // by a single forward event, from which `event` reaches the target stop?
  for (const x of CANONICAL_STATES) {
    if (isStop(ctx, x)) continue;
    const reachable = allowedEvents(current).some((e) => transition(current, e).next === x);
    if (!reachable) continue;
    const via = transition(x, event);
    if (!via.illegal && via.next === target && isStop(ctx, via.next)) {
      return { kind: 'bridge', to: via.next, statusName: ctx.forward.get(via.next)!, through: x };
    }
  }
  return { kind: 'illegal', current, allowed: allowedEvents(current) };
}

// The mapped statuses a user's in-flight task can sit in (claimed/active/blocked/
// review). Bounds listAssigned so reverse-mapping never hits an unmapped status
// and terminal/backlog tasks stay out of the selector pool + status report.
export function inflightStatusNames(ctx: TaskContext): string[] {
  const states: CanonicalState[] = ['claimed', 'active', 'blocked', 'review'];
  const names: string[] = [];
  for (const s of states) {
    const name = ctx.forward.get(s);
    if (name) names.push(name);
  }
  return names;
}

function projectValues(ctx: TaskContext): string[] | undefined {
  return ctx.config.project_property ? ctx.config.project_filter : undefined;
}

export function readyScope(ctx: TaskContext): ReadyScope {
  const ready = ctx.forward.get('ready')!;
  const scope: ReadyScope = { readyStatuses: [ready], assigneeId: ctx.self.id };
  const pv = projectValues(ctx);
  if (pv?.length) scope.projectValues = pv;
  return scope;
}

export function assignedScope(ctx: TaskContext): AssignedScope {
  const scope: AssignedScope = { assigneeId: ctx.self.id, statusNames: inflightStatusNames(ctx) };
  const pv = projectValues(ctx);
  if (pv?.length) scope.projectValues = pv;
  return scope;
}

const PAGE_ID_RE = /^[0-9a-f]{32}$/i;
const PREFIXED_ID_RE = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;
const BARE_NUM_RE = /^\d+$/;

// A selector resolves directly (getTask) only when it unambiguously identifies one
// task: a 32-hex page id, a bare number, or a PREFIX-number whose prefix matches
// the board's configured unique-id prefix. A mismatched or unknown prefix (e.g.
// "ROS-151" on a "TASK" board) falls back to fuzzy so we never resolve by number
// across prefixes and mutate the wrong task.
function selectorKind(ctx: TaskContext, sel: string): 'direct' | 'fuzzy' {
  const s = sel.trim();
  if (PAGE_ID_RE.test(s.replace(/-/g, ''))) return 'direct';
  if (!ctx.config.unique_id_property) return 'fuzzy';
  if (BARE_NUM_RE.test(s)) return 'direct';
  const m = PREFIXED_ID_RE.exec(s);
  if (m) {
    const prefix = ctx.config.unique_id_prefix;
    return prefix && m[1]!.toLowerCase() === prefix.toLowerCase() ? 'direct' : 'fuzzy';
  }
  return 'fuzzy';
}

function rank(title: string, needle: string): number {
  const t = title.toLowerCase();
  const n = needle.toLowerCase();
  if (t === n) return 3;
  if (t.startsWith(n)) return 2;
  if (t.includes(n)) return 1;
  return 0;
}

// Resolve a selector to a task. Direct (unique-id / page-id) hits getTask; a fuzzy
// title matches within a bounded pool (my Ready + unassigned Ready + my in-flight).
// Ambiguity is reported as numbered candidates (no TTY prompt — the /tasks skill
// re-invokes with the chosen handle).
//
// A direct selector is an intentional escape hatch: an exact handle is an
// unambiguous reference, so it addresses that task even if it falls outside the
// configured project_filter. Only the discovery paths (list/status/fuzzy) are
// project-scoped.
export async function resolveSelector(ctx: TaskContext, selector: string): Promise<Task> {
  const sel = selector.trim();
  if (sel.length === 0) throw rosterError('a task selector is required', '  Pass a unique id (TASK-123), a page id, or part of the title.', '  e.g. roster task claim TASK-123');
  if (selectorKind(ctx, sel) === 'direct') {
    return ctx.adapter.getTask(sel);
  }
  const [ready, mine] = await Promise.all([
    ctx.adapter.listReady(readyScope(ctx)),
    ctx.adapter.listAssigned(assignedScope(ctx)),
  ]);
  const byId = new Map<string, TaskSummary>();
  for (const t of [...ready, ...mine]) byId.set(t.id, t);
  const scored = [...byId.values()]
    .map((t) => ({ t, score: rank(t.title, sel) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    throw rosterError(`no task matches "${selector}"`, '  Searched your Ready + in-flight tasks by title.', '  Try the unique id (TASK-123) or a distinctive word from the title.');
  }
  const top = scored[0]!;
  const tied = scored.filter((r) => r.score === top.score);
  if (tied.length > 1) {
    const lines = tied.map((r, i) => `  ${i + 1}. ${r.t.handle}  ${r.t.title}`).join('\n');
    throw rosterError(`"${selector}" is ambiguous — ${tied.length} matches`, lines, '  Re-run with the exact handle (e.g. the leftmost id above).');
  }
  return top.t;
}
