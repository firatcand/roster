import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateManifestLockContentionError, migrateManifestLockedError } from '../errors.ts';

export const STALE_LOCK_MS = 15 * 60 * 1000;
const MAX_ACQUIRE_ATTEMPTS = 5;

export type ManifestLockHandle = {
  lockPath: string;
};

export type AcquireTestHooks = {
  beforeAttempt?: (attempt: number) => void;
  beforeStaleBreak?: () => void;
};

export function manifestLockPathFor(manifestPath: string): string {
  return `${manifestPath}.lock`;
}

function statMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function readHolderPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

export function acquireManifestLock(manifestPath: string, testHooks: AcquireTestHooks = {}): ManifestLockHandle {
  const lockPath = manifestLockPathFor(manifestPath);
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    testHooks.beforeAttempt?.(attempt);
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', {
        flag: 'wx',
      });
      return { lockPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const mtimeMs = statMtimeMs(lockPath);
    if (mtimeMs === null) continue;

    const ageMs = Math.max(0, Date.now() - mtimeMs);
    if (ageMs < STALE_LOCK_MS) {
      throw migrateManifestLockedError(lockPath, readHolderPid(lockPath), ageMs);
    }

    // Stale-break is rename-serialized: rename is atomic, so exactly one racer
    // takes ownership of the stale lock; the loser's rename throws ENOENT and
    // re-enters acquire (refusing against the winner's fresh lock). No code
    // path ever unlinks a lock it didn't rename.
    testHooks.beforeStaleBreak?.();
    const stalePath = `${lockPath}.stale-${process.pid}`;
    try {
      renameSync(lockPath, stalePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    try {
      unlinkSync(stalePath);
    } catch {
      // best-effort — the rename made it ours
    }
  }

  throw migrateManifestLockContentionError(lockPath, MAX_ACQUIRE_ATTEMPTS);
}

export function releaseManifestLock(handle: ManifestLockHandle): void {
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // best-effort — ENOENT means already released or broken as stale
  }
}
