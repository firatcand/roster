import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type EntryInfo = {
  exists: boolean;
  isSymlink: boolean;
  isDirectory: boolean;
  unreadable: boolean;
  error?: string;
};

export function entryAtPath(path: string): EntryInfo {
  try {
    const st = lstatSync(path);
    return {
      exists: true,
      isSymlink: st.isSymbolicLink(),
      isDirectory: st.isDirectory(),
      unreadable: false,
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, isSymlink: false, isDirectory: false, unreadable: false };
    }
    return {
      exists: true,
      isSymlink: false,
      isDirectory: false,
      unreadable: true,
      error: (err as NodeJS.ErrnoException).message,
    };
  }
}

const FALLBACK_CODES = new Set(['EPERM', 'ENOSYS', 'EXDEV']);

export function probeSymlinkSupport(cwd: string): boolean {
  const tempPath = join(cwd, `.roster-probe-${Date.now()}`);
  try {
    symlinkSync('CONTEXT.md', tempPath);
    unlinkSync(tempPath);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && FALLBACK_CODES.has(code)) return false;
    throw err;
  }
}

export function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
