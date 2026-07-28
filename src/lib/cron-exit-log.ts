import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeSegment, readWorkspaceEvidenceFileSync, scheduleRunDir } from './schedule-state.ts';
import { confinedWorkspaceDir } from './workspace-path.ts';

// Reader for the sibling `.exit` files written by the cron wrapper installed by
// `roster schedule install --tool codex --via cron`. Round-5 per-fire layout:
//
//   <cwd>/logs/cron/<name>.log                       (existing, per-schedule)
//   <cwd>/logs/cron/<name>.events.jsonl              (optional, per-schedule)
//   <cwd>/logs/cron/<function>/<name>/<fireId>.exit   (this module — per-fire exit code)
//   <cwd>/logs/cron/<function>/<name>/<fireId>.run-id (schedule-state.ts — per-fire run id)
//
// PER-FIRE + FUNCTION-SCOPED. Each fire mints a fire id in its cron wrapper and
// writes its exit code to `<fireId>.exit` in a function-scoped dir, so overlapping
// fires never clobber a shared file (round-5 finding 1) and two functions owning a
// same-named schedule never collide (finding 2). The `.exit` and `.run-id` for one
// fire are co-located and pair by exact fire id — no timestamp heuristic.

export type ExitRecord = {
  functionName: string;
  scheduleName: string;
  fireId: string;
  exitPath: string;
  // `null` when the file EXISTS but is malformed evidence: unparsable as a
  // non-negative integer, or a hardened-read violation (FIFO/symlink/oversized/
  // unreadable — round-7 finding 7). Round-7 finding 9: malformed evidence is
  // FAILURE evidence — pending-sync surfaces it and closes the correlated run
  // exactly like a non-zero exit (with a distinct malformed-exit reason); it
  // never suppresses both the failed-exit and stale paths.
  exitCode: number | null;
  mtimeMs: number;
};

function parseExitCode(content: string): number | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  return n;
}

function fireIdFromExitFilename(filename: string): string | null {
  if (!filename.endsWith('.exit')) return null;
  const stem = filename.slice(0, -'.exit'.length);
  return stem.length === 0 ? null : stem;
}

// The per-fire exit dir (shared with the run-id sidecar). Validates segments via
// scheduleRunDir (rejects `..`, `/`, control chars).
export function exitDirFor(cwd: string, functionName: string, scheduleName: string): string {
  return scheduleRunDir(cwd, functionName, scheduleName);
}

export function exitPathForFire(cwd: string, functionName: string, scheduleName: string, fireId: string): string {
  return join(exitDirFor(cwd, functionName, scheduleName), `${fireId}.exit`);
}

export function readExitRecord(
  cwd: string,
  functionName: string,
  scheduleName: string,
  exitPath: string,
): ExitRecord | null {
  const fireId = fireIdFromExitFilename(exitPath.split('/').pop() ?? '');
  if (fireId === null) return null;
  // Hardened read (round-7 finding 7): O_NOFOLLOW + regular-file check + size
  // cap BEFORE the read — a planted FIFO, a symlink, or a huge file classifies
  // as malformed evidence (exitCode null) instead of hanging or exhausting the
  // caller. Only a genuinely ABSENT file reads as "no evidence" (null record).
  // Round-10 finding 1 adds the ancestor half: a symlinked `logs/cron/<fn>/` is
  // malformed evidence too, never a read of a foreign exit code.
  const read = readWorkspaceEvidenceFileSync(exitPath, cwd);
  if (read.state === 'missing') return null;
  if (read.state === 'malformed') {
    return { functionName, scheduleName, fireId, exitPath, exitCode: null, mtimeMs: read.mtimeMs };
  }
  return {
    functionName,
    scheduleName,
    fireId,
    exitPath,
    exitCode: parseExitCode(read.content),
    mtimeMs: read.mtimeMs,
  };
}

export function readExitRecordForFire(
  cwd: string,
  functionName: string,
  scheduleName: string,
  fireId: string,
): ExitRecord | null {
  let path: string;
  try {
    path = exitPathForFire(cwd, functionName, scheduleName, fireId);
  } catch {
    return null;
  }
  return readExitRecord(cwd, functionName, scheduleName, path);
}

// Every per-fire exit record for one (function, schedule), sorted by fire id.
export function listExitRecords(cwd: string, functionName: string, scheduleName: string): ExitRecord[] {
  let dir: string;
  try {
    dir = exitDirFor(cwd, functionName, scheduleName);
  } catch {
    return [];
  }
  if (confinedWorkspaceDir(dir, cwd) === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const records: ExitRecord[] = [];
  for (const filename of entries.sort()) {
    if (!filename.endsWith('.exit')) continue;
    const rec = readExitRecord(cwd, functionName, scheduleName, join(dir, filename));
    if (rec !== null) records.push(rec);
  }
  return records;
}

// FUNCTION-SCOPED like the exit dir (finding 2): the log + events files live at
// `logs/cron/<function>/<name>.log` / `.events.jsonl`, siblings of the per-fire
// exit dir `logs/cron/<function>/<name>/`. Two functions owning a same-named
// schedule (gtm/nightly vs ops/nightly) therefore never share a log/event stream
// and never collide. Segments are validated (rejects `..`/`/`/control chars).
export function logPathFor(cwd: string, functionName: string, scheduleName: string): string {
  return join(
    cwd,
    'logs',
    'cron',
    assertSafeSegment('function', functionName),
    `${assertSafeSegment('schedule', scheduleName)}.log`,
  );
}

export function eventsPathFor(cwd: string, functionName: string, scheduleName: string): string {
  return join(
    cwd,
    'logs',
    'cron',
    assertSafeSegment('function', functionName),
    `${assertSafeSegment('schedule', scheduleName)}.events.jsonl`,
  );
}
