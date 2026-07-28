import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { ancestorsConfined } from './workspace-path.ts';

// ── hardened evidence reads (round-7 finding 7) ────────────────────────────────
//
// The correlation channel dir (`logs/cron/<fn>/<sched>/`) is writable by the
// sandboxed agent, so its readers must never trust the file SHAPE: a FIFO
// planted at an evidence path would block a plain synchronous read forever
// (hanging pending sync, the SessionStart banner, and doctor), a symlink could
// route the read to /dev/zero or a foreign file, and a huge file would exhaust
// memory. This reader opens O_NOFOLLOW|O_NONBLOCK, requires a REGULAR file via
// fstat, enforces a byte cap BEFORE reading, and then reads to EOF under a
// maxBytes+1 bound (so a file that grows past the cap between fstat and read is
// still caught — round-9 finding 3). Every violation is MALFORMED EVIDENCE —
// reported, never a hang; finding 9 turns malformed exit evidence into failure
// evidence, so no shape of file can silently suppress closure.

export const MAX_EVIDENCE_BYTES = 4096;

export type EvidenceRead =
  | { state: 'ok'; content: string; mtimeMs: number }
  | { state: 'missing' }
  | {
      state: 'malformed';
      reason: 'not-a-regular-file' | 'oversized' | 'unreadable' | 'outside-workspace';
      mtimeMs: number;
    };

// Injectable fs seam — the tests drive the fstat/read interleaving that a
// concurrent append produces (round-9 finding 3); production passes the real fs.
export type EvidenceFs = {
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  readSync: typeof readSync;
  closeSync: typeof closeSync;
  lstatSync: typeof lstatSync;
};

export const realEvidenceFs: EvidenceFs = { openSync, fstatSync, readSync, closeSync, lstatSync };

// Chunk for the continuation reads after the size-aware first read. Small
// enough that a grown file never allocates the whole cap up front.
const EVIDENCE_CHUNK_BYTES = 64 * 1024;

function lstatMtimeMs(path: string, fs: EvidenceFs): number {
  try {
    return fs.lstatSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function readEvidenceFileSync(
  path: string,
  maxBytes: number = MAX_EVIDENCE_BYTES,
  fs: EvidenceFs = realEvidenceFs,
): EvidenceRead {
  // O_NOFOLLOW / O_NONBLOCK are POSIX-only; 0 keeps the open valid elsewhere.
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(path, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
    // ELOOP: the final component is a symlink and O_NOFOLLOW refused it.
    const reason = code === 'ELOOP' ? ('not-a-regular-file' as const) : ('unreadable' as const);
    return { state: 'malformed', reason, mtimeMs: lstatMtimeMs(path, fs) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { state: 'malformed', reason: 'not-a-regular-file', mtimeMs: st.mtimeMs };
    if (st.size > maxBytes) return { state: 'malformed', reason: 'oversized', mtimeMs: st.mtimeMs };
    // Read to EOF under a DELIBERATE maxBytes+1 bound instead of one
    // fstat-sized read (round-9 finding 3). state.md is append-only and its
    // readers run concurrently with the orchestrator's appends: a single
    // `size + 1` read consumed exactly the FIRST BYTE of a line appended
    // between the fstat and the read, so a COMPLETE, valid latest-run line
    // arrived truncated, parsed as malformed, and could hand detectStale a
    // stale-looking log — a false STALE warning for a schedule that had just
    // reported success. Looping to EOF sees whole appended lines; the +1 byte
    // past the cap is what still classifies a runaway file as oversized.
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    // First read is size-aware so a 4 KiB sidecar never allocates state.md's
    // megabyte cap; continuation reads only happen when the file grew.
    let want = Math.min(limit, st.size + 1);
    while (total < limit && want > 0) {
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, total);
      if (n === 0) break;
      chunks.push(n === want ? buf : buf.subarray(0, n));
      total += n;
      want = Math.min(limit - total, EVIDENCE_CHUNK_BYTES);
    }
    if (total > maxBytes) return { state: 'malformed', reason: 'oversized', mtimeMs: st.mtimeMs };
    return { state: 'ok', content: Buffer.concat(chunks, total).toString('utf8'), mtimeMs: st.mtimeMs };
  } catch {
    return { state: 'malformed', reason: 'unreadable', mtimeMs: lstatMtimeMs(path, fs) };
  } finally {
    fs.closeSync(fd);
  }
}

// Boundary-checked evidence read (round-10 finding 1). O_NOFOLLOW above refuses
// only a symlinked FINAL component, so a symlinked ANCESTOR (`roster/gtm ->
// /elsewhere`, or the round-12 in-workspace `roster/ops -> gtm`) still diverted
// every reader of `roster/<fn>/…`. The DIRECTORY chain is confined here with
// the component-wise no-follow walk (ancestorsConfined) while the final
// component stays O_NOFOLLOW's business — so a symlinked evidence FILE keeps
// its precise 'not-a-regular-file' reason and a diverted DIRECTORY is
// 'outside-workspace'. Either way the refusal is one more MALFORMED shape, so
// each caller keeps its own error path (the registry upsert throws its
// RosterError, validate reports a per-file row, the banner skips the item)
// instead of silently following the link.
export function readWorkspaceEvidenceFileSync(
  path: string,
  boundary: string,
  maxBytes: number = MAX_EVIDENCE_BYTES,
  fs: EvidenceFs = realEvidenceFs,
): EvidenceRead {
  if (!ancestorsConfined(path, boundary)) {
    return { state: 'malformed', reason: 'outside-workspace', mtimeMs: 0 };
  }
  return readEvidenceFileSync(path, maxBytes, fs);
}

// Shared phrasing for a malformed evidence read. Callers keep their OWN error
// type, exit path, and remedy (the sidecar arbitration refuses a bind, the
// registry upsert raises a RosterError, validate reports a per-file row) — only
// the description of the hostile shape is common.
export function describeEvidenceFailure(
  reason: Extract<EvidenceRead, { state: 'malformed' }>['reason'],
  maxBytes: number = MAX_EVIDENCE_BYTES,
): string {
  if (reason === 'not-a-regular-file') {
    return 'not a regular file (a FIFO, directory, device, or symlink is planted there)';
  }
  if (reason === 'oversized') return `larger than the ${maxBytes}-byte cap`;
  if (reason === 'outside-workspace') {
    return 'outside the workspace (a symlinked parent directory resolves elsewhere)';
  }
  return 'unreadable';
}
