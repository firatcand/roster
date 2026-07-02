import { closeSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  migrateManifestLockStaleError,
  migrateManifestLockSuspiciousError,
  migrateManifestLockedError,
} from '../errors.ts';

// Messaging threshold only — locks are NEVER auto-broken. Past this age the
// refusal says "that run likely crashed" and points at verified manual deletion.
export const STALE_LOCK_MS = 15 * 60 * 1000;

const MAX_LOCK_READ_BYTES = 4096;

export type ManifestLockHandle = {
  lockPath: string;
  token: string;
};

export function manifestLockPathFor(manifestPath: string): string {
  return `${manifestPath}.lock`;
}

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function entryKind(st: Stats): string {
  if (st.isSymbolicLink()) return 'symbolic link';
  if (st.isDirectory()) return 'directory';
  return 'non-regular file';
}

function readLockJson(lockPath: string): { pid?: unknown; token?: unknown } | null {
  try {
    const fd = openSync(lockPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_LOCK_READ_BYTES);
      const n = readSync(fd, buf, 0, MAX_LOCK_READ_BYTES, 0);
      return JSON.parse(buf.subarray(0, n).toString('utf8')) as { pid?: unknown; token?: unknown };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readHolderPid(lockPath: string): number | null {
  const pid = readLockJson(lockPath)?.pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function acquireManifestLock(manifestPath: string): ManifestLockHandle {
  const lockPath = manifestLockPathFor(manifestPath);
  mkdirSync(dirname(lockPath), { recursive: true });

  // The retry exists ONLY for a lock vanishing between the failed wx-create and
  // the lstat (the holder released in that window) — never to break a held lock.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID();
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }) + '\n',
        { flag: 'wx' },
      );
      return { lockPath, token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const st = tryLstat(lockPath);
    if (st === null) continue;
    if (!st.isFile()) throw migrateManifestLockSuspiciousError(lockPath, entryKind(st));

    const ageMs = Math.max(0, Date.now() - st.mtimeMs);
    const holderPid = readHolderPid(lockPath);
    throw ageMs >= STALE_LOCK_MS
      ? migrateManifestLockStaleError(lockPath, holderPid, ageMs)
      : migrateManifestLockedError(lockPath, holderPid, ageMs);
  }

  throw migrateManifestLockedError(lockPath, null, 0);
}

export function releaseManifestLock(handle: ManifestLockHandle): void {
  // Unlink ONLY a lock whose content carries our token, so a finishing run can
  // never delete a successor's lock. Read-then-unlink is not atomic; the
  // residual window only matters after manual intervention mid-run (our lock
  // deleted and a successor's created between our matching read and the
  // unlink), which already violates the verify-then-delete remedy.
  try {
    const st = tryLstat(handle.lockPath);
    if (st === null || !st.isFile()) return;
    if (readLockJson(handle.lockPath)?.token !== handle.token) return;
    unlinkSync(handle.lockPath);
  } catch {
    // best-effort — a lock we cannot verify as ours stays in place
  }
}
