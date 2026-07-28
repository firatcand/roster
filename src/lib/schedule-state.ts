import { readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { nextFireTime } from './cron-next.ts';
import { ensureOwnedDir, writeFileCreateOnlySync } from './persistence/local/ledger.ts';
import { ConflictError } from './persistence/contracts.ts';
import { confinedWorkspaceDir } from './workspace-path.ts';
import {
  describeEvidenceFailure,
  readWorkspaceEvidenceFileSync,
  realEvidenceFs,
  type EvidenceFs,
} from './evidence-read.ts';

// Contract: skills/roster-orchestrator/SKILL.md:58-64. The orchestrator skill
// appends one line per fire to roster/<function>/state.md in this exact shape:
//   <utc-iso-8601> | <function>/<agent>/<plan>/<project> | <status>
// where status is one of `success` or `failed`. This module is a reader only —
// ROS-32 owns the writes; ROS-42 will extend with missed-fire detection on top
// of the same log.

export type StateLine = {
  timestamp: string;
  scope: string;
  status: string;
  raw: string;
  lineNumber: number;
};

export type ParseResult = {
  lines: StateLine[];
  malformedCount: number;
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseStateMd(content: string): ParseResult {
  const out: StateLine[] = [];
  let malformedCount = 0;
  const rawLines = content.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;

    const parts = trimmed.split(' | ');
    if (parts.length !== 3) {
      malformedCount++;
      continue;
    }
    const [timestamp, scope, status] = parts as [string, string, string];

    if (!ISO_RE.test(timestamp)) {
      malformedCount++;
      continue;
    }
    if (status.length === 0) {
      malformedCount++;
      continue;
    }
    // scope shape: <function>/<agent>/<plan>/<project> — exactly 4 non-empty
    // segments per skills/roster-orchestrator/SKILL.md:60.
    const scopeParts = scope.split('/');
    if (scopeParts.length !== 4 || scopeParts.some((p) => p.length === 0)) {
      malformedCount++;
      continue;
    }

    out.push({
      timestamp,
      scope,
      status,
      raw,
      lineNumber: i + 1,
    });
  }
  return { lines: out, malformedCount };
}

// state.md is the agent's own self-report — agent-writable, so it gets the same
// hardened read as the correlation sidecars (round-8 finding 1 sweep): a planted
// FIFO would otherwise block every reader of it (doctor, pending-sync, schedule
// list) forever, and a symlink would divert them. A hostile or oversized shape
// yields NO parseable self-report and is reported as malformed, never read.
export const MAX_STATE_MD_BYTES = 4 * 1024 * 1024;

export function readStateMd(
  path: string,
  boundary: string,
  fs: EvidenceFs = realEvidenceFs,
): ParseResult {
  const read = readWorkspaceEvidenceFileSync(path, boundary, MAX_STATE_MD_BYTES, fs);
  if (read.state === 'missing') return { lines: [], malformedCount: 0 };
  if (read.state === 'malformed') return { lines: [], malformedCount: 1 };
  return parseStateMd(read.content);
}

// ── per-fire run-id correlation channel (round-5 findings 1+2+3) ────────────────
//
// PER-FIRE IDENTITY. A scheduled fire mints a random fire id in its OUTER cron
// wrapper (see codex-cron.ts) and exports it as ROSTER_FIRE_ID to the codex
// process. The orchestrator's `roster run start --schedule` reads it and stamps a
// sidecar keyed by that EXACT fire id, so a delayed failure signal correlates to
// the SAME fire's run — never an overlapping fire's (finding 1). The wrapper
// writes its exit code to a sibling `<fireId>.exit` in the SAME per-fire dir, so a
// `<fireId>.exit` and its `<fireId>.run-id` pair by an exact token, with no
// fragile timestamp heuristic.
//
// FUNCTION-SCOPED. The channel dir is `logs/cron/<function>/<name>/`, so two
// functions owning a same-named schedule (`gtm/nightly` vs `ops/nightly`) never
// collide (finding 2).
//
// SAFE WRITE. Every path segment (function, schedule, fire id) is validated —
// `.`, `..`, `/`, `\`, absolutes, and control chars are rejected (finding 3:
// traversal via `--schedule ../../../important`). The dir is created + workspace-
// confined via ensureOwnedDir (no-follow, refuses symlinked components) and the
// sidecar is written through the ledger's shared CREATE-ONLY writer (round-6
// findings 5+9): same-dir tmp opened O_EXCL, fsync, lstat re-verify immediately
// before rename, tmp cleanup on failure — never a truncate-in-place, never a
// symlink follow, never a replacing write that could REBIND an existing fire id.

// The hardened evidence reader now lives in the leaf module `evidence-read.ts`
// so the local ops ledger can share it without an import cycle (schedule-state
// imports the ledger's ensureOwnedDir/create-only writer). This module stays
// the facade its callers already use.
export {
  MAX_EVIDENCE_BYTES,
  describeEvidenceFailure,
  readEvidenceFileSync,
  readWorkspaceEvidenceFileSync,
  realEvidenceFs,
  type EvidenceFs,
  type EvidenceRead,
} from './evidence-read.ts';


// The sidecar records {runId, firedAt, fireId}. firedAt is a real number here
// (per-fire sidecars are always written with a timestamp) — a legacy plain sidecar
// from the old single-file scheme is simply not found under the new layout, so it
// is non-correlatable by construction (finding: legacy plain sidecar skipped).
export type ScheduleRunRecord = { runId: string; firedAt: number; fireId: string };

const SEGMENT_CHARSET = /^[A-Za-z0-9._:-]+$/;

// Reject a path segment that could escape the correlation dir or inject control
// bytes. Used for the function, schedule name, and fire id.
export function assertSafeSegment(kind: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`invalid ${kind} '${String(value)}': must be 1..128 chars`);
  }
  if (value === '.' || value === '..') throw new Error(`invalid ${kind} '${value}': path traversal`);
  if (value.includes('/') || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new Error(`invalid ${kind} '${value}': contains a path separator, NUL, or is absolute`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`invalid ${kind} '${value}': contains a control character`);
  if (!SEGMENT_CHARSET.test(value)) throw new Error(`invalid ${kind} '${value}': allowed charset is [A-Za-z0-9._:-]`);
  return value;
}

export function scheduleRunDir(cwd: string, functionName: string, scheduleName: string): string {
  return join(
    cwd,
    'logs',
    'cron',
    assertSafeSegment('function', functionName),
    assertSafeSegment('schedule', scheduleName),
  );
}

export function runIdPathFor(cwd: string, functionName: string, scheduleName: string, fireId: string): string {
  return join(scheduleRunDir(cwd, functionName, scheduleName), `${assertSafeSegment('fire-id', fireId)}.run-id`);
}

// Stamp the per-fire sidecar. Validates every segment, creates + workspace-confines
// the dir (no-follow), and writes CREATE-ONLY (round-6 finding 5): a fire id
// binds exactly one run for all time. If the sidecar already exists, an
// identical binding (same runId + fireId) is an idempotent no-op — firedAt keeps
// its first-write value, so a replay can never rewrite the staleness anchor —
// while a DIFFERENT binding is a ConflictError (no overwrite, no silent rebind
// of the sidecar to another run).
export function writeScheduleRunId(
  cwd: string,
  functionName: string,
  scheduleName: string,
  runId: string,
  fireId: string,
  firedAt: number,
): void {
  const dir = scheduleRunDir(cwd, functionName, scheduleName);
  const filename = `${assertSafeSegment('fire-id', fireId)}.run-id`;
  ensureOwnedDir(dir, cwd);
  const record: ScheduleRunRecord = { runId: runId.trim(), firedAt, fireId };
  try {
    writeFileCreateOnlySync(dir, filename, JSON.stringify(record) + '\n');
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    // Arbitrate the loser through the HARDENED evidence reader (round-8 finding
    // 1). The channel dir is agent-writable, so an unbounded symlink-following
    // readFileSync here was the one remaining hostile-shape hole: a FIFO planted
    // at `<fireId>.run-id` blocked this read FOREVER — and it runs AFTER the
    // run-start event is appended, so `roster run start --schedule` hung with the
    // run left active and the cron fire wedged — while a symlink diverted the
    // arbitration to a foreign file and a huge file exhausted memory. A
    // non-regular / oversized / unreadable sidecar is now never read: it refuses
    // with an actionable error naming the shape.
    const path = join(dir, filename);
    const read = readWorkspaceEvidenceFileSync(path, cwd);
    if (read.state === 'malformed') {
      // An IDENTITY refusal, not an availability blip (so `roster run start
      // --schedule` fails hard and closes the run instead of proceeding
      // uncorrelated): the fire's channel is occupied by something that can never
      // hold a binding, and unlike a transient I/O error it does not self-heal.
      throw new ConflictError(
        fireId,
        `fire sidecar '${path}' is ${describeEvidenceFailure(read.reason)} — refusing to bind run '${record.runId}' to fire '${fireId}'; inspect and remove that path, then retry`,
      );
    }
    let existing: Partial<ScheduleRunRecord> | null = null;
    if (read.state === 'ok') {
      try {
        existing = JSON.parse(read.content) as Partial<ScheduleRunRecord>;
      } catch {
        existing = null;
      }
    }
    const existingRunId = typeof existing?.runId === 'string' ? existing.runId.trim() : null;
    if (existingRunId === record.runId && existing?.fireId === fireId) return;
    throw new ConflictError(
      fireId,
      `fire '${fireId}' already binds run '${existingRunId ?? '<unreadable>'}' — refusing to rebind it to run '${record.runId}' (a fire id names exactly one run)`,
    );
  }
}

function fireIdFromRunIdFilename(filename: string): string | null {
  if (!filename.endsWith('.run-id')) return null;
  const stem = filename.slice(0, -'.run-id'.length);
  return stem.length === 0 ? null : stem;
}

// List every per-fire sidecar for one (function, schedule) — the fires whose runs
// pending-sync may need to close. Malformed / non-JSON sidecars are skipped: a
// sidecar that cannot be parsed names NO run, so there is nothing to close —
// but the read itself is hardened (round-7 finding 7), so a planted FIFO /
// symlink / oversized file is classified malformed and skipped instead of
// blocking the whole scan.
export function listScheduleRuns(cwd: string, functionName: string, scheduleName: string): ScheduleRunRecord[] {
  let dir: string;
  try {
    dir = scheduleRunDir(cwd, functionName, scheduleName);
  } catch {
    return []; // an unsafe function/schedule name yields no channel
  }
  // Ancestor confinement before the walk (round-10 finding 1): a symlinked
  // `logs/cron/<fn>/` would otherwise enumerate — and correlate runs from — a
  // foreign directory. A refused channel simply names no fires.
  if (confinedWorkspaceDir(dir, cwd) === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: ScheduleRunRecord[] = [];
  for (const filename of entries) {
    const fireId = fireIdFromRunIdFilename(filename);
    if (fireId === null) continue;
    const read = readWorkspaceEvidenceFileSync(join(dir, filename), cwd);
    if (read.state !== 'ok') continue; // missing or malformed shape — non-correlatable
    const raw = read.content.trim();
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a legacy plain-text sidecar is non-correlatable — skip
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const rec = parsed as Partial<ScheduleRunRecord>;
    if (typeof rec.runId !== 'string' || rec.runId.trim().length === 0) continue;
    if (typeof rec.firedAt !== 'number') continue;
    out.push({ runId: rec.runId.trim(), firedAt: rec.firedAt, fireId });
  }
  return out;
}

// Match lines whose scope starts with `<function>/<agent>/<plan>/`. The
// trailing slash anchors the prefix so 'gtm/sdr/cold' does not accidentally
// match a longer plan name like 'cold-outreach' under a future schema change.
function scopePrefix(functionName: string, agent: string, plan: string): string {
  return `${functionName}/${agent}/${plan}/`;
}

export function findRecentRuns(
  lines: readonly StateLine[],
  functionName: string,
  agent: string,
  plan: string,
  limit: number,
): StateLine[] {
  const prefix = scopePrefix(functionName, agent, plan);
  const out: StateLine[] = [];
  // Reverse-scan: orchestrator appends; most recent lives at the bottom.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!;
    if (line.scope.startsWith(prefix)) out.push(line);
  }
  return out;
}

export function findMostRecentRun(
  lines: readonly StateLine[],
  functionName: string,
  agent: string,
  plan: string,
): StateLine | undefined {
  const matches = findRecentRuns(lines, functionName, agent, plan, 1);
  return matches[0];
}

// ── ROS-42: stale-fire detection ─────────────────────────────────────────

export type StaleDetectInput = {
  cronExpr: string;
  // Most recent line for this schedule from state.md. `undefined` when the
  // agent has never reported a run.
  lastRun: StateLine | undefined;
  // Last fire's process-level mtime, when available. Used as a fallback signal:
  // if `.exit` is recent (within grace), the cron daemon DID fire — but the
  // agent never wrote state.md. That's a "ran-but-silent" failure, not STALE.
  lastFireMtimeMs: number | undefined;
  now: Date;
  graceMinutes: number;
};

export type StaleDetectResult =
  | { stale: false; reason?: 'recent-run' | 'recent-fire' | 'never-fired-yet' }
  | { stale: true; reason: 'no-recent-run' | 'missed-window'; expectedBeforeUtc: string };

// Reports STALE when the most recent agent self-report is older than the
// cron's expected next-fire + grace. Cases:
//
//   - lastRun present + (lastRun + cron-next + grace) > now → not stale
//     (the agent reported within the most recent expected window)
//   - lastRun present + cutoff passed + .exit recent (≥ expected fire) → not
//     stale, reason=recent-fire (wrapper ran; agent silent → failure path
//     surfaces it via pending-sync, not STALE)
//   - lastRun present + cutoff passed + no recent .exit → STALE missed-window
//   - lastRun absent + .exit recent → not stale, reason=recent-fire
//   - lastRun absent + .exit absent → not stale, reason=never-fired-yet
//     (cannot distinguish "freshly installed" from "broken since forever"
//     without an install-time anchor; caller decides via schedules.yaml mtime
//     in a separate doctor check if it cares)
//
// ROS-42 acceptance #2: "STALE if last_run is older than expected_next_fire
// + 2h" — implemented for the `lastRun present` branch above.
export function detectStale(input: StaleDetectInput): StaleDetectResult {
  const { cronExpr, lastRun, lastFireMtimeMs, now, graceMinutes } = input;

  if (lastRun === undefined) {
    if (lastFireMtimeMs !== undefined) return { stale: false, reason: 'recent-fire' };
    return { stale: false, reason: 'never-fired-yet' };
  }

  const lastRunDate = new Date(lastRun.timestamp);
  const expectedNext = nextFireTime(cronExpr, lastRunDate);
  if (!expectedNext.ok) {
    // Cron parser rejected the expression — the doctor's schema-validation
    // section surfaces the real problem. Stay quiet here.
    return { stale: false, reason: 'recent-run' };
  }

  const cutoffMs = expectedNext.next.getTime() + graceMinutes * 60_000;

  // Within the grace window for the most recent expected fire.
  if (now.getTime() < cutoffMs) {
    return { stale: false, reason: 'recent-run' };
  }

  // Grace window has closed without a fresh state.md line. Two sub-cases:
  //   (a) wrapper recorded a fire at-or-after the expected fire time — process
  //       ran but agent stayed silent. Not STALE; failure-detection surfaces.
  if (lastFireMtimeMs !== undefined && lastFireMtimeMs >= expectedNext.next.getTime()) {
    return { stale: false, reason: 'recent-fire' };
  }
  //   (b) no signal at all → STALE missed-window.
  return {
    stale: true,
    reason: 'missed-window',
    expectedBeforeUtc: new Date(cutoffMs).toISOString(),
  };
}
