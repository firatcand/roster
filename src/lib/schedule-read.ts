import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { scheduleEntrySchema, scheduleFileSchema, type ScheduleEntry } from './schedule-schema.ts';
import { readWorkspaceEvidenceFileSync } from './schedule-state.ts';
import { confinedFunctionDir, confinedWorkspaceDir } from './workspace-path.ts';

// The registry is a small YAML file; the cap only bounds a hostile/runaway one.
// Exported so every reader of roster/<fn>/schedules.yaml — including the ones
// outside this module (schedule-yaml's install/remove upsert, schedule-validate,
// doctor) — shares ONE bound (round-9 finding 1).
export const MAX_SCHEDULES_YAML_BYTES = 1024 * 1024;

// Shared schedule-reading helpers (ROS-121). Consolidates copies that lived in
// schedule-list.ts and schedule-resolve.ts.

// List roster/<fn> directories. When `only` is given, short-circuit to just that
// one (schedule-resolve's --function path); otherwise enumerate + sort.
export function listFunctionDirs(workspacePath: string, only?: string): string[] {
  // Round-11 finding 1: `only` is CALLER-SUPPLIED (`--function`) and used to be
  // returned verbatim, so `../archive` was joined under roster/ and resolved to
  // a sibling registry that remove/status/run then read and REWROTE. It is now
  // validated as a function name AND confined beneath <workspace>/roster/ — a
  // refused or absent function simply names no registry, which is the same
  // zero-entry shape a valid-but-empty function already produced (the
  // not-found / not-in-function errors are unchanged).
  if (only !== undefined) {
    return confinedFunctionDir(workspacePath, only) === null ? [] : [only];
  }
  // Round-10 finding 1: the plain statSync here FOLLOWED a symlinked function
  // dir, so `roster/gtm -> /elsewhere` put a foreign directory into every
  // schedule walk (list, resolve, the install/remove upsert). Confinement is
  // realpath-based, so the symlinked ancestor is refused, not followed.
  // Round-11 finding 1 narrows the boundary from the WORKSPACE to roster/: a
  // link that stays inside the workspace (`roster/gtm -> ../archive`) passed the
  // wider check and still diverted the whole walk to a sibling registry.
  const rosterDir = confinedWorkspaceDir(join(workspacePath, 'roster'), workspacePath);
  if (rosterDir === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(rosterDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (confinedFunctionDir(workspacePath, name) !== null) out.push(name);
  }
  return out.sort();
}

// Read + schema-validate the schedule entries in roster/<fn>/schedules.yaml.
// When a `warnings` array is supplied, problems (unreadable / malformed /
// missing list / per-entry invalid) are appended as user-facing strings — the
// schedule-list behavior. When it is omitted, problems are silent (malformed →
// []) and an unreadable existing file is allowed to throw — the schedule-resolve
// behavior, preserved exactly.
export function readScheduleEntries(
  workspacePath: string,
  functionName: string,
  warnings?: string[],
): ScheduleEntry[] {
  const path = join(workspacePath, 'roster', functionName, 'schedules.yaml');
  // Round-11 finding 1: the read is bounded by roster/, not by the WORKSPACE.
  // The wider boundary was satisfied by `roster/gtm -> ../archive` and by a
  // literal `--function ../archive`, so a sibling tree's registry was read as
  // if it were the function's own. Refusals keep the existing taxonomy — the
  // evidence reader folds them into `malformed`, so each caller's contract
  // (warning row for schedule list, throw for resolve) is untouched.
  const boundary = confinedWorkspaceDir(join(workspacePath, 'roster'), workspacePath) ?? workspacePath;

  // Hardened read (round-8 finding 1 sweep): the registry lives in the workspace
  // an agent can write, so a planted FIFO/symlink/oversized file must never block
  // or divert a reader (schedule list, resolve, doctor, pending sync). A hostile
  // shape reads exactly like the unreadable file it is. Round-10 finding 1 adds
  // the ANCESTOR half: a symlinked `roster/<fn>` is refused, not followed.
  const read = readWorkspaceEvidenceFileSync(path, boundary, MAX_SCHEDULES_YAML_BYTES);
  if (read.state === 'missing') return [];
  if (read.state === 'malformed') {
    const detail = `roster/${functionName}/schedules.yaml: cannot read (${read.reason})`;
    if (warnings) {
      warnings.push(detail);
      return [];
    }
    throw new Error(detail);
  }
  const content = read.content;

  if (content.trim().length === 0) return [];

  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) {
    warnings?.push(
      `roster/${functionName}/schedules.yaml: malformed (${doc.errors[0]!.message}) — run \`roster schedule validate\``,
    );
    return [];
  }

  const data = doc.toJS();
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { schedules?: unknown }).schedules)) {
    warnings?.push(`roster/${functionName}/schedules.yaml: missing 'schedules:' list`);
    return [];
  }

  const out: ScheduleEntry[] = [];
  const entries = (data as { schedules: unknown[] }).schedules;
  for (let i = 0; i < entries.length; i++) {
    const parsed = scheduleEntrySchema.safeParse(entries[i]);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      warnings?.push(
        `roster/${functionName}/schedules.yaml[${i}]: invalid (${parsed.error.issues[0]?.message ?? 'schema error'}) — run \`roster schedule validate\``,
      );
    }
  }
  return out;
}

// Every function in the workspace that registers a schedule under this name.
// The pre-#323 crontab marker was the BARE schedule name, so adopting such a
// block is only unambiguous when exactly one function claims the name; this is
// the registry-side half of that guard (codex-cron.ts holds the content-side
// ownership proof). Scans ALL functions, never just the caller's.
export function functionsRegisteringSchedule(workspacePath: string, scheduleName: string): string[] {
  const out = new Set<string>();
  for (const fn of listFunctionDirs(workspacePath)) {
    for (const entry of readScheduleEntries(workspacePath, fn, [])) {
      if (entry.name === scheduleName) out.add(fn);
    }
  }
  return [...out].sort();
}

export type LoadedSchedule = { entry: ScheduleEntry; functionName: string };

// Load + whole-file-validate (scheduleFileSchema) every schedule across
// roster/<fn>/schedules.yaml. Distinct from readScheduleEntries (which is
// per-entry + lenient + warning-collecting): this requires a valid file
// (version + shape) and silently skips a function whose file is missing /
// unreadable / malformed / schema-invalid. With `sort`, function dirs are
// visited in sorted (deterministic) order; without it, in raw readdir order.
// `filter` narrows which entries are kept.
export function loadSchedules(
  cwd: string,
  opts: { sort?: boolean; filter?: (entry: ScheduleEntry) => boolean } = {},
): LoadedSchedule[] {
  const root = confinedWorkspaceDir(join(cwd, 'roster'), cwd);
  if (root === null) return [];
  let fns: string[];
  try {
    fns = readdirSync(root);
  } catch {
    return [];
  }
  if (opts.sort) fns = fns.sort();

  const out: LoadedSchedule[] = [];
  for (const fn of fns) {
    const fnDir = confinedFunctionDir(cwd, fn);
    if (fnDir === null) continue;
    const read = readWorkspaceEvidenceFileSync(join(fnDir, 'schedules.yaml'), cwd, MAX_SCHEDULES_YAML_BYTES);
    if (read.state !== 'ok') continue;
    const raw = read.content;
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      continue;
    }
    const valid = scheduleFileSchema.safeParse(parsed);
    if (!valid.success) continue;
    for (const entry of valid.data.schedules) {
      if (!opts.filter || opts.filter(entry)) {
        out.push({ entry, functionName: fn });
      }
    }
  }
  return out;
}
