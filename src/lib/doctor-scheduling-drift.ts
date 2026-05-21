import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import {
  defaultCrontabIO,
  findMarkerBlocks,
  getMarkerStrings,
  renderCronLine,
  resolveCodexBinaryPath,
  type CrontabIO,
} from './codex-cron.ts';
import { scheduleFileSchema, type ScheduleEntry } from './schedule-schema.ts';
import { buildOrchestratorPrompt } from './schedule-install.ts';
import { exitPathFor, eventsPathFor, logPathFor, readExitRecord } from './cron-exit-log.ts';
import { detectStale, findMostRecentRun, readStateMd } from './schedule-state.ts';

// =====================================================================
// Crontab ↔ schedules.yaml drift (check 3)
// =====================================================================

export type DriftItem =
  | { name: string; status: 'fail'; reason: 'registered-but-no-marker'; functionName: string }
  | { name: string; status: 'fail'; reason: 'cron-line-mismatch'; functionName: string; expected: string; actual: string }
  | { name: string; status: 'fail'; reason: 'orphan-marker-block' }
  | { name: string; status: 'ok'; functionName: string };

export type CronDriftAudit = {
  status: 'ok' | 'fail' | 'unreadable-crontab' | 'no-crontab';
  items: DriftItem[];
  crontabReason?: string;
};

type LoadedEntry = {
  entry: ScheduleEntry;
  functionName: string;
};

function loadCodexViaCronEntries(cwd: string): LoadedEntry[] {
  const root = join(cwd, 'roster');
  let fns: string[];
  try {
    fns = readdirSync(root);
  } catch {
    return [];
  }

  const out: LoadedEntry[] = [];
  for (const fn of fns) {
    const fnDir = join(root, fn);
    let st: Stats;
    try {
      st = statSync(fnDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const schedulesPath = join(fnDir, 'schedules.yaml');
    let raw: string;
    try {
      raw = readFileSync(schedulesPath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      continue;
    }
    const valid = scheduleFileSchema.safeParse(parsed);
    if (!valid.success) continue;
    for (const entry of valid.data.schedules) {
      if (entry.tool === 'codex' && entry.install_mode === 'via-cron') {
        out.push({ entry, functionName: fn });
      }
    }
  }
  return out;
}

// Scan crontab content for all roster-managed marker block names.
// Mirrors the markerBegin format `# roster:schedule:<name>:begin (...)`.
function listMarkerNames(content: string): string[] {
  const re = /^# roster:schedule:([^:\s]+):begin(?:\s|$)/mg;
  const names = new Set<string>();
  for (const m of content.matchAll(re)) {
    const name = m[1];
    if (name && name.length > 0) names.add(name);
  }
  return Array.from(names);
}

// Slice the managed block between :begin/:end markers; return the actual cron
// line (the single line between the markers). Empty string when the block is
// malformed or empty.
function extractActualCronLine(content: string, name: string): string {
  const { begin, end } = getMarkerStrings(name);
  const beginIdx = content.indexOf(begin);
  if (beginIdx < 0) return '';
  const endIdx = content.indexOf(end, beginIdx);
  if (endIdx < 0) return '';
  const between = content.slice(beginIdx + begin.length, endIdx);
  // The block has structure: "<begin>\n<cron-line>\n<end>".
  const lines = between.split('\n').filter((line) => line.length > 0);
  return lines[0] ?? '';
}

export type CronDriftOpts = {
  cwd: string;
  crontabIO?: CrontabIO;
  env?: NodeJS.ProcessEnv;
  codexBinaryPathOverride?: string;
};

export function auditCronDrift(opts: CronDriftOpts): CronDriftAudit {
  const io = opts.crontabIO ?? defaultCrontabIO();
  const env = opts.env ?? process.env;
  // Canonicalize cwd so re-rendered cron lines byte-match what
  // src/lib/codex-install.ts wrote (it calls resolve() at install time).
  // Codex review 2nd pass [MAJOR/9]: previously the raw opts.cwd was used,
  // causing false-positive cron-line-mismatch when doctor was invoked from
  // a relative-path or symlinked cwd.
  const workspacePath = resolve(opts.cwd);
  const codexBinaryPath = (() => {
    try {
      return resolveCodexBinaryPath(env, opts.codexBinaryPathOverride);
    } catch {
      return null;
    }
  })();

  const entries = loadCodexViaCronEntries(opts.cwd);
  // No codex via-cron entries registered → no drift possible; skip.
  if (entries.length === 0) {
    return { status: 'ok', items: [] };
  }

  const r = io.read();
  if (!r.ok && r.reason === 'no-crontab') {
    // Entries registered but no crontab at all → every entry is drifting.
    return {
      status: 'fail',
      items: entries.map(({ entry, functionName }) => ({
        name: entry.name,
        status: 'fail',
        reason: 'registered-but-no-marker',
        functionName,
      })),
    };
  }
  if (!r.ok) {
    return {
      status: 'unreadable-crontab',
      items: [],
      crontabReason: r.message,
    };
  }

  const content = r.content;
  const registeredNames = new Set(entries.map(({ entry }) => entry.name));
  const items: DriftItem[] = [];

  for (const { entry, functionName } of entries) {
    const blocks = findMarkerBlocks(content, entry.name);
    if (blocks.length === 0) {
      items.push({
        name: entry.name,
        status: 'fail',
        reason: 'registered-but-no-marker',
        functionName,
      });
      continue;
    }
    if (codexBinaryPath === null) {
      // Can't re-render to byte-compare; settle for "marker present" check.
      items.push({ name: entry.name, status: 'ok', functionName });
      continue;
    }
    const expected = renderCronLine({
      cron: entry.cron,
      workspacePath,
      codexBinaryPath,
      prompt: buildOrchestratorPrompt(entry.agent, entry.plan),
      logPath: logPathFor(workspacePath, entry.name),
      exitPath: exitPathFor(workspacePath, entry.name),
      ...(entry.capture_events === true
        ? { eventsPath: eventsPathFor(workspacePath, entry.name) }
        : {}),
    });
    const actual = extractActualCronLine(content, entry.name);
    if (actual !== expected) {
      items.push({
        name: entry.name,
        status: 'fail',
        reason: 'cron-line-mismatch',
        functionName,
        expected,
        actual,
      });
    } else {
      items.push({ name: entry.name, status: 'ok', functionName });
    }
  }

  // Orphan markers: marker blocks in crontab whose name is NOT in any
  // registered schedule.
  for (const name of listMarkerNames(content)) {
    if (!registeredNames.has(name)) {
      items.push({ name, status: 'fail', reason: 'orphan-marker-block' });
    }
  }

  const hasFailure = items.some((i) => i.status === 'fail');
  return { status: hasFailure ? 'fail' : 'ok', items };
}

// =====================================================================
// Alt-skill-path drift (check 5)
// =====================================================================

export type AltSkillPathAudit = {
  status: 'ok' | 'warn';
  items: Array<
    | { path: string; presence: 'absent' }
    | { path: string; presence: 'matches-canonical' }
    | { path: string; presence: 'only-alt-present'; canonicalPath: string }
    | { path: string; presence: 'content-diverged'; canonicalPath: string; reason: string }
  >;
};

// Compare bytes of every file under the alt path with its mirror under the
// canonical path. Returns null on equal content; an explanatory string on
// divergence.
function compareSkillTrees(altRoot: string, canonicalRoot: string): string | null {
  const altFiles = collectRelativeFiles(altRoot);
  const canonicalFiles = collectRelativeFiles(canonicalRoot);
  const altSet = new Set(altFiles);
  const canonicalSet = new Set(canonicalFiles);

  const onlyAlt = altFiles.filter((f) => !canonicalSet.has(f));
  const onlyCanonical = canonicalFiles.filter((f) => !altSet.has(f));
  if (onlyAlt.length > 0) return `extra files at alt path: ${onlyAlt.slice(0, 3).join(', ')}`;
  if (onlyCanonical.length > 0) return `missing files at alt path: ${onlyCanonical.slice(0, 3).join(', ')}`;

  for (const rel of altFiles) {
    const altPath = join(altRoot, rel);
    const canPath = join(canonicalRoot, rel);
    try {
      const a = readFileSync(altPath);
      const b = readFileSync(canPath);
      if (Buffer.compare(a, b) !== 0) return `bytes differ in ${rel}`;
    } catch {
      return `unreadable file ${rel}`;
    }
  }
  return null;
}

function collectRelativeFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) recurse(full);
      else if (st.isFile()) out.push(relative(root, full));
    }
  }
  recurse(root);
  return out.sort();
}

export type AltSkillPathOpts = {
  homeDir: string;
};

const ALT_SKILL_NAMES = ['roster-orchestrator'] as const;

export function auditAltSkillPaths(opts: AltSkillPathOpts): AltSkillPathAudit {
  const altRoot = join(opts.homeDir, '.agents', 'skills');
  const canonicalRoot = join(opts.homeDir, '.codex', 'skills');

  const items: AltSkillPathAudit['items'] = [];

  for (const skillName of ALT_SKILL_NAMES) {
    const altPath = join(altRoot, skillName);
    const canonicalPath = join(canonicalRoot, skillName);
    const altExists = existsSync(altPath);
    const canonicalExists = existsSync(canonicalPath);

    if (!altExists) {
      items.push({ path: altPath, presence: 'absent' });
      continue;
    }
    if (altExists && !canonicalExists) {
      items.push({ path: altPath, presence: 'only-alt-present', canonicalPath });
      continue;
    }
    const reason = compareSkillTrees(altPath, canonicalPath);
    if (reason === null) {
      items.push({ path: altPath, presence: 'matches-canonical' });
    } else {
      items.push({ path: altPath, presence: 'content-diverged', canonicalPath, reason });
    }
  }

  // Warn iff any item is in a non-clean state.
  const hasWarning = items.some(
    (i) => i.presence === 'only-alt-present' || i.presence === 'content-diverged',
  );
  return { status: hasWarning ? 'warn' : 'ok', items };
}

// =====================================================================
// Stale fires (ROS-42)
// =====================================================================

export type StaleFireItem =
  | { name: string; functionName: string; status: 'ok'; reason: 'recent-run' | 'recent-fire' | 'never-fired-yet' }
  | { name: string; functionName: string; status: 'warn'; reason: 'missed-window'; expectedBeforeUtc: string }
  | { name: string; functionName: string; status: 'fail'; reason: 'failed-last-fire'; exitCode: number | null; firedAtUtc: string };

export type StaleFireAudit = {
  status: 'ok' | 'warn' | 'fail';
  items: StaleFireItem[];
  graceMinutes: number;
};

export type StaleFireAuditOpts = {
  cwd: string;
  now?: Date;
  graceMinutes?: number;
};

const DEFAULT_GRACE_MINUTES = 120;

function loadAllSchedules(cwd: string): Array<{ entry: ScheduleEntry; functionName: string }> {
  const rosterDir = join(cwd, 'roster');
  let fns: string[];
  try {
    fns = readdirSync(rosterDir);
  } catch {
    return [];
  }
  const out: Array<{ entry: ScheduleEntry; functionName: string }> = [];
  for (const fn of fns.sort()) {
    const fnDir = join(rosterDir, fn);
    let st: Stats;
    try {
      st = statSync(fnDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const yamlPath = join(fnDir, 'schedules.yaml');
    let raw: string;
    try {
      raw = readFileSync(yamlPath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      continue;
    }
    const valid = scheduleFileSchema.safeParse(parsed);
    if (!valid.success) continue;
    for (const entry of valid.data.schedules) {
      out.push({ entry, functionName: fn });
    }
  }
  return out;
}

export function auditStaleFires(opts: StaleFireAuditOpts): StaleFireAudit {
  const cwd = opts.cwd;
  const now = opts.now ?? new Date();
  const graceMinutes = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;

  const stateCache = new Map<string, ReturnType<typeof readStateMd>>();
  function stateFor(functionName: string) {
    const cached = stateCache.get(functionName);
    if (cached !== undefined) return cached;
    const state = readStateMd(join(cwd, 'roster', functionName, 'state.md'));
    stateCache.set(functionName, state);
    return state;
  }

  const items: StaleFireItem[] = [];
  for (const { entry, functionName } of loadAllSchedules(cwd)) {
    const state = stateFor(functionName);
    const lastRun = findMostRecentRun(state.lines, functionName, entry.agent, entry.plan);

    let exitMtimeMs: number | undefined;
    let failed: { exitCode: number | null; firedAtUtc: string } | undefined;
    if (entry.tool === 'codex' && entry.install_mode === 'via-cron') {
      const exitRecord = readExitRecord(exitPathFor(cwd, entry.name));
      if (exitRecord !== null) {
        exitMtimeMs = exitRecord.mtimeMs;
        if (exitRecord.exitCode !== null && exitRecord.exitCode !== 0) {
          failed = {
            exitCode: exitRecord.exitCode,
            firedAtUtc: new Date(exitRecord.mtimeMs).toISOString(),
          };
        }
      }
    }

    if (failed !== undefined) {
      items.push({
        name: entry.name,
        functionName,
        status: 'fail',
        reason: 'failed-last-fire',
        exitCode: failed.exitCode,
        firedAtUtc: failed.firedAtUtc,
      });
      continue;
    }

    const stale = detectStale({
      cronExpr: entry.cron,
      lastRun,
      lastFireMtimeMs: exitMtimeMs,
      now,
      graceMinutes,
    });
    if (stale.stale) {
      items.push({
        name: entry.name,
        functionName,
        status: 'warn',
        reason: 'missed-window',
        expectedBeforeUtc: stale.expectedBeforeUtc,
      });
    } else {
      items.push({
        name: entry.name,
        functionName,
        status: 'ok',
        reason: stale.reason ?? 'recent-run',
      });
    }
  }

  const hasFail = items.some((i) => i.status === 'fail');
  const hasWarn = items.some((i) => i.status === 'warn');
  return {
    status: hasFail ? 'fail' : hasWarn ? 'warn' : 'ok',
    items,
    graceMinutes,
  };
}

// =====================================================================
// Aggregate
// =====================================================================

export type SchedulingDriftAuditResult = {
  ok: boolean;
  cronDrift: CronDriftAudit;
  altSkillPath: AltSkillPathAudit;
  staleFires: StaleFireAudit;
};

export type SchedulingDriftAuditOpts = {
  cwd: string;
  homeDir: string;
  crontabIO?: CrontabIO;
  env?: NodeJS.ProcessEnv;
  codexBinaryPathOverride?: string;
  now?: Date;
  graceMinutes?: number;
};

export function runSchedulingDriftAudit(opts: SchedulingDriftAuditOpts): SchedulingDriftAuditResult {
  const cronDrift = auditCronDrift({
    cwd: opts.cwd,
    crontabIO: opts.crontabIO,
    env: opts.env,
    codexBinaryPathOverride: opts.codexBinaryPathOverride,
  });
  const altSkillPath = auditAltSkillPaths({ homeDir: opts.homeDir });
  const staleFires = auditStaleFires({
    cwd: opts.cwd,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.graceMinutes !== undefined ? { graceMinutes: opts.graceMinutes } : {}),
  });

  // Alt-skill warnings do NOT flip ok (per acceptance: check 5 "warns").
  // Unreadable crontab also does not flip ok — drift section reports the
  // unreadable status as guidance; the user fixes their crontab perms.
  // Stale fires: warn does NOT flip ok (transient missed window may resolve
  // on next fire), but fail (non-zero exit code captured) DOES flip ok —
  // user needs to act.
  const cronOk = cronDrift.status === 'ok' || cronDrift.status === 'unreadable-crontab';
  const staleOk = staleFires.status !== 'fail';
  return {
    ok: cronOk && staleOk,
    cronDrift,
    altSkillPath,
    staleFires,
  };
}
