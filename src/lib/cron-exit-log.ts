import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Reader for sibling `.exit` files written by the cron wrapper installed by
// `roster schedule install --tool codex --via cron`. Layout:
//
//   <cwd>/logs/cron/<schedule-name>.log         (existing)
//   <cwd>/logs/cron/<schedule-name>.exit        (this module — process exit code)
//   <cwd>/logs/cron/<schedule-name>.events.jsonl (optional, when entry has capture_events)
//
// Acceptance ROS-42 #1: each scheduled fire writes timestamp + status to
// state.md AND exit code to a sibling .exit file. This module owns the .exit
// side of that bargain; src/lib/schedule-state.ts owns the state.md side.

export type ExitRecord = {
  scheduleName: string;
  exitPath: string;
  // `null` when the file exists but cannot be parsed as a non-negative integer
  // (race with the writer, manual edit, etc.). `unknown`-class items surface as
  // doctor warnings, never as auto-pending banners.
  exitCode: number | null;
  mtimeMs: number;
};

export type CronExitLogDir = {
  dir: string;
  records: ExitRecord[];
};

// Filename → schedule name. We do not embed timestamps in the filename — the
// .exit is overwritten on every fire (one source of truth per schedule). This
// matches the renderCronLine contract: a single `<name>.exit` path per entry.
function scheduleNameFromExitFilename(filename: string): string | null {
  if (!filename.endsWith('.exit')) return null;
  const stem = filename.slice(0, -'.exit'.length);
  if (stem.length === 0) return null;
  return stem;
}

function parseExitCode(content: string): number | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  return n;
}

export function readExitRecord(exitPath: string): ExitRecord | null {
  if (!existsSync(exitPath)) return null;
  let stat: ReturnType<typeof statSync>;
  let content: string;
  try {
    stat = statSync(exitPath);
    content = readFileSync(exitPath, 'utf8');
  } catch {
    return null;
  }
  const scheduleName = scheduleNameFromExitFilename(exitPath.split('/').pop() ?? '');
  if (scheduleName === null) return null;
  return {
    scheduleName,
    exitPath,
    exitCode: parseExitCode(content),
    mtimeMs: stat.mtimeMs,
  };
}

export function scanExitRecords(cwd: string): CronExitLogDir {
  const dir = join(cwd, 'logs', 'cron');
  if (!existsSync(dir)) return { dir, records: [] };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, records: [] };
  }
  const records: ExitRecord[] = [];
  for (const filename of entries.sort()) {
    if (!filename.endsWith('.exit')) continue;
    const full = join(dir, filename);
    const rec = readExitRecord(full);
    if (rec !== null) records.push(rec);
  }
  return { dir, records };
}

export function exitPathFor(cwd: string, scheduleName: string): string {
  return join(cwd, 'logs', 'cron', `${scheduleName}.exit`);
}

export function logPathFor(cwd: string, scheduleName: string): string {
  return join(cwd, 'logs', 'cron', `${scheduleName}.log`);
}

export function eventsPathFor(cwd: string, scheduleName: string): string {
  return join(cwd, 'logs', 'cron', `${scheduleName}.events.jsonl`);
}
