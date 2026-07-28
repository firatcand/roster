import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFile } from './schedule-yaml.ts';
import { ensureOwnedDir, writeFileCreateOnlySync } from './persistence/local/ledger.ts';
import { ConflictError } from './persistence/contracts.ts';
import { nextFireTime } from './cron-next.ts';
import { confinedFunctionDir, confinedProbeSync, confinedWorkspaceDir } from './workspace-path.ts';
import { loadSchedules, type LoadedSchedule } from './schedule-read.ts';
import {
  listExitRecords,
  logPathFor,
  readExitRecordForFire,
  type ExitRecord,
} from './cron-exit-log.ts';
import {
  detectStale,
  findMostRecentRun,
  listScheduleRuns,
  readStateMd,
  type StateLine,
} from './schedule-state.ts';
import type { RunStore } from './persistence/contracts.ts';

// ROS-42: synthesize error-class pending items from wrapper-level signals
// (`.exit` files, STALE detections). Idempotent: writes deterministic
// `pending/error-<id>.md` files where id = sha1(scheduleName + signalKey)
// so repeated runs of `roster pending sync` from SessionStart hooks + doctor
// don't duplicate entries.
//
// Out of scope: the orchestrator skill (which appends success/failed lines
// to state.md) and the in-LLM banner.sh hook (which surfaces the items this
// module writes). This module is the bridge between the two.

const DEFAULT_GRACE_MINUTES = 120;

export type PendingSyncResult = {
  // 'malformed-exit' (round-7 finding 9): the wrapper left exit evidence that
  // exists but cannot be trusted (empty/unparsable/FIFO/oversized) — treated as
  // failure evidence with its own reason, never as "wrapper reported fine".
  written: Array<{ path: string; reason: 'failed-exit' | 'malformed-exit' | 'stale'; scheduleName: string }>;
  // 'refused' (round-11 finding 2): the destination exists but is a shape this
  // sync will not write through — a symlink, a non-regular file, or a path
  // whose parent resolves outside the workspace. Skip-with-report, never a
  // silent already-exists (which would have suppressed the item outright).
  skipped: Array<{ path: string; reason: 'already-exists' | 'acknowledged' | 'refused' }>;
  // Schedules we considered but had no signal worth surfacing.
  inspected: number;
};

export type PendingSyncOpts = {
  cwd: string;
  // Allow tests to clock-pin without monkey-patching Date.
  now?: Date;
  graceMinutes?: number;
  dryRun?: boolean;
};

// Confined at BOTH levels (round-10 finding 1): `roster/` itself may be a
// symlink (readdirSync follows it), and although Dirent.isDirectory() is
// lstat-based — so a symlinked `roster/<fn>` is already not a directory here —
// the realpath check is what makes that guarantee explicit and uniform with the
// other walkers.
function listFunctionDirs(cwd: string, rosterDir: string): string[] {
  const root = confinedWorkspaceDir(rosterDir, cwd);
  if (root === null) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => confinedFunctionDir(cwd, name) !== null)
      .sort();
  } catch {
    return [];
  }
}

// Deterministic short id. We don't need cryptographic strength — just enough
// entropy to avoid collisions between different (schedule, signal) pairs and
// short enough to make `pending/error-<id>.md` filenames pleasant.
function shortId(scheduleName: string, signalKey: string): string {
  const h = createHash('sha1');
  h.update(scheduleName);
  h.update('\0');
  h.update(signalKey);
  return h.digest('hex').slice(0, 8);
}

function pendingDir(cwd: string, functionName: string): string {
  return join(cwd, 'roster', functionName, 'pending');
}

function pendingPath(cwd: string, functionName: string, id: string): string {
  return join(pendingDir(cwd, functionName), `error-${id}.md`);
}

// ── durable skip: acknowledgement sentinels (round-7 finding 8) ────────────────
//
// The exit evidence under logs/cron/ is immutable, so deleting a synthesized
// pending item alone is NOT a durable skip — the next sync re-creates it from
// the same evidence. The durable skip is an `acknowledged/error-<id>` sentinel
// in the function's pending dir: sync checks it BEFORE synthesizing, and
// `roster review --reject` (and the /inbox reject flow) drops it automatically
// for error-class items. The sentinel has no `.md` suffix and lives one level
// down, so neither the banner count nor the review walker ever lists it.

function acknowledgedDirFor(cwd: string, functionName: string): string {
  return join(pendingDir(cwd, functionName), 'acknowledged');
}

export function acknowledgedPathFor(cwd: string, functionName: string, id: string): string {
  return join(acknowledgedDirFor(cwd, functionName), `error-${id}`);
}

// Round-11 finding 2: this was a raw existsSync, which FOLLOWS symlinks and
// knows no boundary. `roster/gtm/pending/acknowledged -> /tmp/foreign-acks`
// with a matching sentinel therefore classified a failed fire as acknowledged
// and suppressed its decision item — a real failure disappearing from the
// inbox. Only a REGULAR file at the confined, un-followed path acknowledges;
// anything else (symlink, dir, diverted parent) reads as NOT acknowledged, so
// the item is still produced. That is the fail-loud direction: a spurious item
// is visible and one reject away, a suppressed one is invisible forever.
function isAcknowledged(cwd: string, functionName: string, id: string): boolean {
  return confinedProbeSync(acknowledgedPathFor(cwd, functionName, id), cwd) === 'present';
}

// Create-only, hardened (same writer as the fire sidecars: O_EXCL tmp + fsync +
// no-follow rename via the ledger core; the dir chain is workspace-confined).
// Idempotent: an already-present sentinel is a no-op.
export function acknowledgePendingId(cwd: string, functionName: string, id: string): void {
  const dir = acknowledgedDirFor(resolve(cwd), functionName);
  ensureOwnedDir(dir, resolve(cwd));
  try {
    writeFileCreateOnlySync(dir, `error-${id}`, `acknowledged ${new Date().toISOString()}\n`);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
}

function renderFailedExitItem(args: {
  schedule: LoadedSchedule;
  exit: ExitRecord;
  logPath: string;
  exitMtimeIso: string;
  pendingFilePath: string;
  acknowledgedFilePath: string;
}): string {
  const { schedule, exit, logPath, exitMtimeIso, pendingFilePath, acknowledgedFilePath } = args;
  const malformed = exit.exitCode === null;
  const code = malformed ? '<malformed>' : String(exit.exitCode);
  const headline = malformed
    ? [
        `The scheduled fire at ${exitMtimeIso} left exit evidence that exists but`,
        'cannot be read as an exit code (empty, unparsable, or a non-regular file).',
        `Malformed evidence is treated as a FAILURE of \`${schedule.entry.agent}\`/\`${schedule.entry.plan}\` —`,
        'an unreadable wrapper report must never pass as a clean run.',
      ]
    : [
        `The scheduled fire at ${exitMtimeIso} exited with code \`${code}\`. The`,
        `agent for \`${schedule.entry.agent}\`/\`${schedule.entry.plan}\` did not`,
        'complete normally.',
      ];
  return [
    '---',
    `type: scheduled-fire-failure`,
    `signal: ${malformed ? 'malformed-exit' : 'failed-exit'}`,
    `schedule: ${schedule.entry.name}`,
    `function: ${schedule.functionName}`,
    `agent: ${schedule.entry.agent}`,
    `plan: ${schedule.entry.plan}`,
    `cron: '${schedule.entry.cron}'`,
    `exit_code: ${code}`,
    `exit_path: ${exit.exitPath}`,
    `log_path: ${logPath}`,
    `detected_at: '${new Date().toISOString()}'`,
    `fire_at: '${exitMtimeIso}'`,
    'severity: error',
    '---',
    '',
    `# Failed fire — \`${schedule.entry.name}\``,
    '',
    ...headline,
    '',
    `**Log:** \`${logPath}\``,
    '',
    '## Choose one',
    '',
    `- **Retry** — \`roster schedule run ${schedule.entry.name}\``,
    `- **Skip** — \`roster review --reject <this item>\` (or \`mkdir -p '${dirname(acknowledgedFilePath)}' && touch '${acknowledgedFilePath}' && rm '${pendingFilePath}'\`). The acknowledgement sentinel makes the skip durable — a plain \`rm\` alone is re-created from the immutable exit evidence on the next sync.`,
    `- **Disable schedule** — \`roster schedule remove ${schedule.entry.name}\``,
    '',
    '_Auto-generated by `roster pending sync` (ROS-42). Re-running sync will not duplicate this item._',
    '',
  ].join('\n');
}

function renderStaleItem(args: {
  schedule: LoadedSchedule;
  expectedBeforeUtc: string;
  lastRun: StateLine | undefined;
}): string {
  const { schedule, expectedBeforeUtc, lastRun } = args;
  const lastRunLine = lastRun
    ? `${lastRun.timestamp} (status: ${lastRun.status})`
    : '(no record in state.md)';
  return [
    '---',
    `type: scheduled-fire-stale`,
    `schedule: ${schedule.entry.name}`,
    `function: ${schedule.functionName}`,
    `agent: ${schedule.entry.agent}`,
    `plan: ${schedule.entry.plan}`,
    `cron: '${schedule.entry.cron}'`,
    `expected_before: '${expectedBeforeUtc}'`,
    `last_run: '${lastRun?.timestamp ?? ''}'`,
    `detected_at: '${new Date().toISOString()}'`,
    'severity: warn',
    '---',
    '',
    `# Stale schedule — \`${schedule.entry.name}\``,
    '',
    `Expected a fresh fire by ${expectedBeforeUtc}, but the most recent`,
    `agent self-report is: ${lastRunLine}.`,
    '',
    'Possible causes:',
    '- The cron daemon (or Desktop Scheduled Task / Codex Automation) is not running',
    '- The schedule was disabled in the host app',
    '- The wrapper itself crashed before the agent could append to state.md',
    '',
    '## Choose one',
    '',
    `- **Verify cron is live** — \`roster doctor\` then \`crontab -l | grep ${schedule.entry.name}\``,
    `- **Fire manually** — \`roster schedule run ${schedule.entry.name}\``,
    `- **Disable schedule** — \`roster schedule remove ${schedule.entry.name}\``,
    '',
    '_Auto-generated by `roster pending sync` (ROS-42). Re-running sync will not duplicate this item._',
    '',
  ].join('\n');
}

export function syncPending(opts: PendingSyncOpts): PendingSyncResult {
  const cwd = resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const graceMinutes = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const dryRun = opts.dryRun ?? false;

  const written: PendingSyncResult['written'] = [];
  const skipped: PendingSyncResult['skipped'] = [];
  const schedules = loadSchedules(cwd, { sort: true });
  let inspected = 0;

  // Cache state.md per function to avoid re-reading on every schedule.
  const stateCache = new Map<string, ReturnType<typeof readStateMd>>();
  function stateFor(functionName: string) {
    const cached = stateCache.get(functionName);
    if (cached !== undefined) return cached;
    const path = join(cwd, 'roster', functionName, 'state.md');
    const result = readStateMd(path, cwd);
    stateCache.set(functionName, result);
    return result;
  }

  for (const schedule of schedules) {
    inspected++;
    // STALE detection works for both tools (Claude UI-handoff schedules can
    // still self-report via state.md), but the .exit channel is codex-only.
    const state = stateFor(schedule.functionName);
    const lastRun = findMostRecentRun(
      state.lines,
      schedule.functionName,
      schedule.entry.agent,
      schedule.entry.plan,
    );

    // Failed-exit signal (codex via-cron only; only modes that write .exit). Each
    // fire writes its own `<fireId>.exit`, so surface a pending item PER failed
    // fire — idempotent via id = shortId(name, fireId). Round-7 finding 9:
    // exitCode === null (present-but-malformed evidence — empty, unparsable,
    // FIFO/symlink/oversized) is FAILURE evidence with its own reason, never a
    // silent skip: a state that suppressed both this branch AND stale closure
    // left the run stuck forever.
    let exitMtimeMs: number | undefined;
    if (schedule.entry.tool === 'codex' && schedule.entry.install_mode === 'via-cron') {
      for (const exitRecord of listExitRecords(cwd, schedule.functionName, schedule.entry.name)) {
        exitMtimeMs = exitMtimeMs === undefined ? exitRecord.mtimeMs : Math.max(exitMtimeMs, exitRecord.mtimeMs);
        if (exitRecord.exitCode !== 0) {
          const reason = exitRecord.exitCode === null ? ('malformed-exit' as const) : ('failed-exit' as const);
          const exitMtimeIso = new Date(exitRecord.mtimeMs).toISOString();
          const id = shortId(schedule.entry.name, exitRecord.fireId);
          const dst = pendingPath(cwd, schedule.functionName, id);
          const dstProbe = confinedProbeSync(dst, cwd);
          if (isAcknowledged(cwd, schedule.functionName, id)) {
            skipped.push({ path: dst, reason: 'acknowledged' });
          } else if (dstProbe === 'refused') {
            skipped.push({ path: dst, reason: 'refused' });
          } else if (dstProbe === 'present') {
            skipped.push({ path: dst, reason: 'already-exists' });
          } else {
            const body = renderFailedExitItem({
              schedule,
              exit: exitRecord,
              logPath: logPathFor(cwd, schedule.functionName, schedule.entry.name),
              exitMtimeIso,
              pendingFilePath: dst,
              acknowledgedFilePath: acknowledgedPathFor(cwd, schedule.functionName, id),
            });
            if (!dryRun) atomicWriteFile(dst, body, cwd);
            written.push({ path: dst, reason, scheduleName: schedule.entry.name });
          }
        }
      }
    }

    // STALE signal — only when we have a lastRun to compare against (the
    // detectStale benign-default). For freshly-installed schedules with no
    // signals yet, schedules.yaml-mtime-based "registered but never ran"
    // would be the right check — out of scope for this PR.
    if (lastRun !== undefined) {
      const stale = detectStale({
        cronExpr: schedule.entry.cron,
        lastRun,
        lastFireMtimeMs: exitMtimeMs,
        now,
        graceMinutes,
      });
      if (stale.stale) {
        const id = shortId(schedule.entry.name, `stale:${stale.expectedBeforeUtc}`);
        const dst = pendingPath(cwd, schedule.functionName, id);
        const dstProbe = confinedProbeSync(dst, cwd);
        if (isAcknowledged(cwd, schedule.functionName, id)) {
          skipped.push({ path: dst, reason: 'acknowledged' });
        } else if (dstProbe === 'refused') {
          skipped.push({ path: dst, reason: 'refused' });
        } else if (dstProbe === 'present') {
          skipped.push({ path: dst, reason: 'already-exists' });
        } else {
          const body = renderStaleItem({
            schedule,
            expectedBeforeUtc: stale.expectedBeforeUtc,
            lastRun,
          });
          if (!dryRun) atomicWriteFile(dst, body, cwd);
          written.push({ path: dst, reason: 'stale', scheduleName: schedule.entry.name });
        }
      }
    }
  }

  return { written, skipped, inspected };
}

// ── ledger correlation of failed/stale fires (round-5 per-fire identity) ────────
//
// A scheduled process killed before its `finally` leaves its run 'running'
// forever. The fire minted a per-fire id in its cron wrapper (codex-cron.ts) and
// `roster run start --schedule` stamped a `<fireId>.run-id` sidecar; the wrapper
// wrote the exit to the co-located `<fireId>.exit`. Here — from a LATER session's
// `pending sync` — we pair a `<fireId>.exit` to its `<fireId>.run-id` by EXACT
// fire id and emit the closure the crashed process never wrote (a `run event
// --kind error` describing the signal + a `run end`).
//
// PER-FIRE correctness (finding 1): overlapping fires A@09:00, B@09:05, A exits
// 09:10 have DISTINCT fire ids, so A's exit correlates to A's run — NEVER to the
// still-running B. FUNCTION-SCOPED (finding 2): the channel dir is
// logs/cron/<function>/<schedule>/, so gtm/nightly and ops/nightly never collide.
// Idempotent: the error uses the fire id as its deterministic correlation id and
// `run-end` a fixed dedupe key, so repeated syncs dedup at the store.
// Best-effort: a store error on one fire never aborts the others.

export type FailedFireCorrelation = {
  scheduleName: string;
  runId: string;
  fireId: string;
  reason: 'failed-exit' | 'malformed-exit' | 'stale';
  correlationId: string;
};

export type CorrelateOpts = {
  cwd: string;
  runs: RunStore;
  now?: Date;
  graceMinutes?: number;
};

// Emit the correlated error + run-end for ONE fire's run, unless the run already
// has a run-end (a completed run is never reopened). Best-effort.
async function closeCorrelatedRun(
  runs: RunStore,
  runId: string,
  agent: string,
  cron: string,
  signal: { reason: 'failed-exit' | 'malformed-exit' | 'stale'; correlationId: string; data: unknown },
): Promise<boolean> {
  try {
    const existing = await runs.getRun(runId);
    const alreadyEnded = existing?.events.some((e) => e.kind === 'run-end') ?? false;
    if (alreadyEnded) return false;
    await runs.appendEvent({
      runId,
      kind: 'error',
      correlationId: signal.correlationId,
      data: signal.data,
      agent,
      trigger: cron,
    });
    await runs.appendEvent({ runId, kind: 'run-end', data: { source: 'pending-sync', closedBy: signal.reason } });
    return true;
  } catch {
    // Best-effort: a store failure on one fire must not abort the rest.
    return false;
  }
}

export async function correlateFailedFires(opts: CorrelateOpts): Promise<FailedFireCorrelation[]> {
  const cwd = resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const graceMinutes = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const out: FailedFireCorrelation[] = [];
  const schedules = loadSchedules(cwd, { sort: true });

  for (const schedule of schedules) {
    // Every recorded fire for this (function, schedule). A LEGACY plain sidecar
    // (the old single-file printf path) is not under the per-fire layout, so it is
    // simply never listed → non-correlatable by construction (finding 1c).
    const fires = listScheduleRuns(cwd, schedule.functionName, schedule.entry.name);
    if (fires.length === 0) continue;
    const isCodexViaCron = schedule.entry.tool === 'codex' && schedule.entry.install_mode === 'via-cron';

    // A fire's `<fireId>.exit` belongs to its `<fireId>.run-id` by construction —
    // no timestamp heuristic. Read each fire's exit by EXACT fire id.
    const exitByFire = new Map<string, ExitRecord | null>();
    for (const fire of fires) {
      exitByFire.set(
        fire.fireId,
        isCodexViaCron ? readExitRecordForFire(cwd, schedule.functionName, schedule.entry.name, fire.fireId) : null,
      );
    }

    // 1) Failed-exit: any fire whose OWN exit is non-zero closes its OWN run.
    // Round-7 finding 9: a PRESENT-but-malformed exit (exitCode null — empty,
    // unparsable, FIFO/oversized) closes the run through this SAME path with a
    // distinct malformed-exit reason. Before, exitCode null suppressed BOTH this
    // branch AND the stale branch (`exit !== null` skipped it below), so the run
    // stuck 'running' forever with no state able to close it.
    const failedRunIds = new Set<string>();
    for (const fire of fires) {
      const exit = exitByFire.get(fire.fireId) ?? null;
      if (exit !== null && exit.exitCode !== 0) {
        const malformed = exit.exitCode === null;
        const reason = malformed ? ('malformed-exit' as const) : ('failed-exit' as const);
        const signal = {
          reason,
          correlationId: `sched-error-${fire.fireId}`,
          data: {
            source: 'pending-sync',
            signal: reason,
            fireId: fire.fireId,
            exitCode: exit.exitCode,
            fireAt: new Date(exit.mtimeMs).toISOString(),
          },
        };
        if (await closeCorrelatedRun(opts.runs, fire.runId, schedule.entry.agent, schedule.entry.cron, signal)) {
          out.push({
            scheduleName: schedule.entry.name,
            runId: fire.runId,
            fireId: fire.fireId,
            reason,
            correlationId: signal.correlationId,
          });
        }
        failedRunIds.add(fire.runId);
      }
    }

    // 2) STALE: evaluated PER SIDECAR (round-6 finding 2 — the previous
    // schedule-level rule picked the LATEST sidecar as a proxy, so with
    // overlapping fires "A stale, B fresh" it closed the FRESH B and later
    // conflicted with B's real `run end`). A sidecar is closable ONLY when ITS
    // OWN window has passed — firedAt's next expected fire + grace is behind
    // `now` — AND it has no exit file for its exact fire id (the wrapper never
    // reported) AND its run has no run-end (closeCorrelatedRun's guard). Every
    // such sidecar is closed, never a neighbor. Idempotent: the correlation id
    // is the fire id, so repeated syncs dedup at the store.
    for (const fire of fires) {
      if (failedRunIds.has(fire.runId)) continue; // already closed via its own failed/malformed exit
      const exit = exitByFire.get(fire.fireId) ?? null;
      // An exit record here means the wrapper reported a ZERO exit (non-zero and
      // malformed both took branch 1) — a completed fire, not a vanished one.
      if (exit !== null) continue;
      const expectedNext = nextFireTime(schedule.entry.cron, new Date(fire.firedAt));
      if (!expectedNext.ok) continue; // schema validation surfaces the bad cron elsewhere
      const deadlineMs = expectedNext.next.getTime() + graceMinutes * 60_000;
      if (now.getTime() < deadlineMs) continue; // still inside its own window
      const signal = {
        reason: 'stale' as const,
        correlationId: `sched-stale-${fire.fireId}`,
        data: {
          source: 'pending-sync',
          signal: 'stale',
          fireId: fire.fireId,
          expectedBefore: new Date(deadlineMs).toISOString(),
        },
      };
      if (await closeCorrelatedRun(opts.runs, fire.runId, schedule.entry.agent, schedule.entry.cron, signal)) {
        out.push({
          scheduleName: schedule.entry.name,
          runId: fire.runId,
          fireId: fire.fireId,
          reason: 'stale',
          correlationId: signal.correlationId,
        });
      }
    }
  }
  return out;
}

// Helper for tests + the doctor section: how many of cwd's pending items are
// error-class (filename matches `error-<id>.md`). Used by render to badge the
// pending count.
export function countErrorPending(cwd: string): number {
  const root = join(cwd, 'roster');
  let count = 0;
  for (const fn of listFunctionDirs(cwd, root)) {
    const dir = confinedWorkspaceDir(pendingDir(cwd, fn), cwd);
    if (dir === null) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (/^error-[a-f0-9]+\.md$/.test(e)) count++;
    }
  }
  return count;
}
