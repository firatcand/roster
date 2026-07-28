import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  linkSync,
  renameSync,
  unlinkSync,
  writeSync,
  ftruncateSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  PersistenceError,
  WorkspaceMismatchError,
  canonicalJson,
  sha256Hex,
} from '../contracts.ts';
import { assertSafeSegment } from '../safe-path.ts';
import { isUuidV4, PERSISTENCE_YAML_VERSION } from '../config-schema.ts';
import {
  pathComponentsBelow,
  resolveConfinedPath,
  type ConfinedPath,
} from '../../workspace-path.ts';
import { describeEvidenceFailure, readEvidenceFileSync } from '../../evidence-read.ts';

// Append-only JSONL ledger for the local backend (#318 section D). Layout:
//   <opsRoot>/<workspaceId>/meta.json
//   <opsRoot>/<workspaceId>/<namespace>/segment-NNNN.jsonl (+ .seal sidecars)
// Durability: per-namespace O_EXCL lockfile, checked write-all + fsync(fd),
// dir-fsync on segment/dir creation, store-assigned monotonic seq under the
// lock, hash chain (prev = sha256 of prior record line), seal-protocol
// recovery for torn tails. Append-only is an API guarantee + hash-chain
// tamper-EVIDENCE, not OS tamper-proofing. Every path component below the
// workspace boundary is lstat-verified (no symlinks, no non-directories) so a
// hostile checkout cannot redirect persistence writes outside the workspace.

export const MAX_RECORD_BYTES = 1024 * 1024;

// The component versions the local JSONL backend advertises (#323): its code
// implements the run ledger + artifact declarations, so it mints roster_ops +
// objects at v2. Kept in sync with capabilities.ts CURRENT_COMPONENT_VERSIONS.
export const LOCAL_COMPONENT_VERSIONS: Readonly<Record<string, number>> = { hitl: 1, roster_ops: 2, objects: 2 };

function needsComponentUpgrade(versions: Record<string, number> | undefined): boolean {
  if (versions === undefined) return true;
  for (const [name, min] of Object.entries(LOCAL_COMPONENT_VERSIONS)) {
    if ((versions[name] ?? 1) < min) return true;
  }
  return false;
}

// Merge UP: never downgrade a component the tree already advertises higher than
// the current baseline (forward-compat), only raise below-baseline components.
function mergeComponentVersions(versions: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = { ...(versions ?? {}) };
  for (const [name, min] of Object.entries(LOCAL_COMPONENT_VERSIONS)) {
    out[name] = Math.max(out[name] ?? 1, min);
  }
  return out;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOOSE_MODE_MASK = 0o077;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;
const SCAN_CHUNK_BYTES = 64 * 1024;
const SEGMENT_RE = /^segment-(\d{4,})\.jsonl$/;
// Byte caps for the small JSON sidecars read through the hardened bounded
// reader. Generous enough for any legitimate file, small enough that a planted
// runaway one is refused instead of loaded.
const MAX_META_BYTES = 64 * 1024;
const MAX_SEAL_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;

// No-follow append+create open (finding: append-path symlink TOCTOU). O_NOFOLLOW
// makes open() ELOOP if the final path component is a symlink — closing the
// window between the pre-open lstat check and the open where a concurrent swap
// could redirect the write outside the workspace. Absent on some platforms
// (Windows): the immediately-preceding lstat + the post-open fstat(isFile)
// narrow the window there.
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;
const APPEND_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW;
// Read opens over agent-writable ledger files: never follow a symlinked final
// component, never block on a planted FIFO.
const RO_NOFOLLOW_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

export type LedgerRecord = {
  id: string;
  ws: string;
  seq: number;
  ts: number;
  kind: string;
  payload: unknown;
  checksum: string;
  prev: string | null;
  producerId: string;
  producerSeq: number;
  // #323 store-assigned observations: metadata recorded ALONGSIDE the record but
  // EXCLUDED from the checksum (which covers `payload` only), so a retry that
  // changes only observations (a new pid/timestamp/version) is an idempotent
  // replay, not a ConflictError. Absent on records that carry none.
  observations?: unknown;
};

export type LedgerMeta = {
  configVersion: number;
  workspaceId: string;
  producerId: string;
  componentVersions: Record<string, number>;
};

export type AppendInput = { id: string; kind: string; payload: unknown; observations?: unknown };
export type AppendResult = { record: LedgerRecord; replayed: boolean };

// Crash-matrix injection points for the durability tests; never set outside
// tests. midWrite splits the line write in two so a SIGKILL between the halves
// produces a genuinely torn record.
export type LedgerTestHooks = {
  // Fires AFTER the pre-open path validation and BEFORE the segment is opened —
  // the TOCTOU window a concurrent symlink swap would exploit.
  beforeOpen?: () => void;
  beforeWrite?: () => void;
  midWrite?: () => void;
  beforeFsync?: () => void;
  afterFsync?: () => void;
};

export type LocalLedgerOptions = {
  opsRoot: string;
  workspaceId: string;
  now?: () => number;
  maxRecordBytes?: number;
  lockTimeoutMs?: number;
};

type SealSidecar = {
  segment: string;
  lastValidOffset: number;
  records: number;
  lastHash: string | null;
  checksum: string;
};

type SegmentScan = {
  records: LedgerRecord[];
  lineHashes: string[];
  endOffset: number;
  tornStart: number | null;
};

type NamespaceState = {
  records: LedgerRecord[];
  byId: Map<string, LedgerRecord>;
  lastSeq: number;
  lastHash: string | null;
  tailIndex: number;
  tailSealed: boolean;
};

// Test seams: the raw directory-fsync, rename, and hard-link operations,
// replaceable to fault-inject EIO/ENOSPC-class failures (and the create-only
// race) without touching the real filesystem.
export const ledgerFsSeams = {
  fsyncDirRaw(path: string): void {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  renameRaw(from: string, to: string): void {
    renameSync(from, to);
  },
  linkRaw(from: string, to: string): void {
    linkSync(from, to);
  },
  createExclusiveRaw(path: string, mode: number): number {
    return openSync(path, 'wx', mode);
  },
};

// Directory-entry durability is part of the commit protocol: a failure here
// (other than the filesystem legitimately not supporting directory fsync)
// must fail the write — never be swallowed into a false 'committed'.
export function fsyncDir(path: string): void {
  try {
    ledgerFsSeams.fsyncDirRaw(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOTSUP') return;
    throw new BackendUnavailableError(`directory fsync failed for ${path}: ${(err as Error).message}`);
  }
}

function writeFully(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

function symlinkRefusal(path: string): InvalidRecordError {
  return new InvalidRecordError(
    `refusing to follow '${path}': it is a symbolic link (ELOOP) — persistence paths must be real files/directories inside the workspace`,
  );
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BackendUnavailableError(`cannot lstat ${path}: ${(err as Error).message}`);
  }
}

function ownedByUs(st: Stats): boolean {
  return typeof process.getuid === 'function' ? st.uid === process.getuid() : true;
}

// lstat guard for a file we are about to read or write in place: symlinks and
// non-regular files are refused, an overly-permissive mode is repaired (owned)
// or refused (foreign). Returns null when the path does not exist.
export function assertRegularFileIfExists(path: string): Stats | null {
  const st = lstatOrNull(path);
  if (st === null) return null;
  if (st.isSymbolicLink()) throw symlinkRefusal(path);
  if (!st.isFile()) {
    throw new InvalidRecordError(`'${path}' is not a regular file — refusing to use it`);
  }
  if (process.platform !== 'win32' && (st.mode & LOOSE_MODE_MASK) !== 0) {
    if (!ownedByUs(st)) {
      throw new InvalidRecordError(
        `'${path}' has permissive mode 0${(st.mode & 0o777).toString(8)} and is not owned by this user — chown it or remove it, then retry`,
      );
    }
    chmodSync(path, FILE_MODE);
  }
  return st;
}

// Read a whole regular file through its DESCRIPTOR (round-8 finding 3): the open
// is O_NOFOLLOW (a symlinked final component is refused, never traversed) and
// O_NONBLOCK (a planted FIFO opens instantly instead of blocking forever), and
// fstat re-verifies the OPENED inode is a regular file — so a FIFO, directory, or
// device swapped in between an lstat check and the read can neither hang the
// caller nor divert it to foreign bytes. Returns null when the path is absent;
// content integrity (digest) stays the caller's check.
export function readRegularFileSync(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, RO_NOFOLLOW_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') throw symlinkRefusal(path);
    throw new InvalidRecordError(`'${path}' cannot be read (${code ?? (err as Error).message})`);
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new InvalidRecordError(`'${path}' is not a regular file — refusing to read it`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function componentsBelow(boundary: string, path: string): string[] {
  const parts = pathComponentsBelow(boundary, path);
  if (parts === null) {
    throw new InvalidRecordError(`'${path}' is not under '${boundary}' — refusing to touch it`);
  }
  return parts;
}

// ── the READ-side boundary (round-12 finding 2) ──────────────────────────────
//
// ensureOwnedDir below is the WRITE-side rule: walk every component under the
// boundary, refuse any symlink. The read paths had no equivalent — `scan` only
// lstat'd the FINAL namespace directory and `readLedgerMeta` used a raw
// readFileSync — so `.roster/ops/<workspaceId> -> <another ledger tree>` let
// `run list`/`run show` reconstruct a FOREIGN ledger, and let `scan` acquire
// that tree's lock and recover/seal its segments: a nominal READ mutating
// someone else's data.
//
// This is the read-only sibling: the SAME component-wise no-follow walk (the
// shared primitive workspace-path.ts#resolveConfinedPath) translated into the
// ledger's error taxonomy, creating no directory and repairing no mode.
export type ConfinedDirState = 'absent' | 'present';

function refuseConfinement(res: Extract<ConfinedPath, { status: 'refused' }>, path: string): never {
  if (res.reason === 'symlink-component') throw symlinkRefusal(res.at);
  if (res.reason === 'outside-boundary') {
    throw new InvalidRecordError(
      `'${path}' resolves outside the workspace boundary (at '${res.at}') — refusing to touch it`,
    );
  }
  throw new BackendUnavailableError(`cannot lstat ${res.at}: the path component is unreadable`);
}

export function confinedLedgerDir(path: string, boundary: string): ConfinedDirState {
  const res = resolveConfinedPath(path, boundary);
  if (res.status === 'refused') refuseConfinement(res, path);
  if (res.status === 'absent') return 'absent';
  if (!res.stat.isDirectory()) {
    throw new InvalidRecordError(`'${path}' exists but is not a directory — refusing to read it`);
  }
  return 'present';
}

// The containment boundary for a `<cwd>/.roster/ops` tree: the workspace root.
export function ledgerBoundaryFor(opsRoot: string): string {
  return dirname(dirname(opsRoot));
}

// Creates (0700) or validates every path component strictly below `boundary`:
// symlinks and non-directories are refused, permissive modes are repaired for
// owned dirs and refused for foreign ones, and the realpath of the result must
// stay under the boundary's realpath.
export function ensureOwnedDir(path: string, boundary: string): void {
  for (const p of componentsBelow(boundary, path)) {
    let st = lstatOrNull(p);
    if (st === null) {
      let created = false;
      try {
        mkdirSync(p, { mode: DIR_MODE });
        created = true;
      } catch (err) {
        // Lost a concurrent create race: fall through and validate the
        // component another process just made.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      if (created) {
        chmodSync(p, DIR_MODE);
        fsyncDir(dirname(p));
        continue;
      }
      st = lstatOrNull(p);
      if (st === null) {
        throw new BackendUnavailableError(`cannot create ${p}: it vanished during a concurrent create race`);
      }
    }
    if (st.isSymbolicLink()) throw symlinkRefusal(p);
    if (!st.isDirectory()) {
      throw new InvalidRecordError(`'${p}' exists but is not a directory — refusing to use it`);
    }
    if (process.platform !== 'win32' && (st.mode & LOOSE_MODE_MASK) !== 0) {
      if (!ownedByUs(st)) {
        throw new InvalidRecordError(
          `'${p}' has permissive mode 0${(st.mode & 0o777).toString(8)} and is not owned by this user — chown it or remove it, then retry`,
        );
      }
      chmodSync(p, DIR_MODE);
    }
  }
  const realBoundary = realpathSync(boundary);
  const realPath = realpathSync(path);
  if (realPath !== realBoundary && !realPath.startsWith(realBoundary + sep)) {
    throw new InvalidRecordError(
      `'${path}' resolves to '${realPath}', outside the workspace boundary '${realBoundary}' — refusing to write there`,
    );
  }
}

export function atomicWriteFileSync(path: string, contents: string): void {
  const dir = dirname(path);
  const existing = lstatOrNull(path);
  if (existing !== null) {
    if (existing.isSymbolicLink()) throw symlinkRefusal(path);
    if (!existing.isFile()) {
      throw new InvalidRecordError(`'${path}' exists but is not a regular file — refusing to replace it`);
    }
  }
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  // Round-6 finding 10: a write/fsync/close/rename failure must not strand the
  // .tmp-* staging file (the blob writer below already cleans up; this one did
  // not). The original error is rethrown unchanged.
  try {
    const fd = openSync(tmp, 'wx', FILE_MODE);
    try {
      writeFully(fd, Buffer.from(contents, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    ledgerFsSeams.renameRaw(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never landed
    }
    throw err;
  }
  fsyncDir(dir);
}

// The shared hardened create-only writer core (round-6 findings 5+9+10): the
// single write path for content-addressed blobs, the outbox spool, and the
// per-fire schedule sidecars. Protections: same-dir tmp opened 'wx'
// (O_CREAT|O_EXCL — never follows a symlink final component), full write +
// fsync(fd), an lstat re-verification of the target IMMEDIATELY before the
// rename (rename replaces, so the recheck narrows the window in which a
// concurrent create could be clobbered — Node exposes no dirfd-relative rename,
// so a residual sub-millisecond window remains), tmp unlinked on ANY failure,
// dir-fsync after the rename. An existing target — before the write or appearing
// during it — is a ConflictError; callers wanting idempotent-replay semantics
// catch it and compare content.
//
// Filesystems that cannot hard-link (some network/FUSE mounts). There the publish
// FAILS CLOSED (round-8 finding 2): it re-publishes with an O_CREAT|O_EXCL create
// AT THE FINAL NAME — still a genuinely exclusive create-once, the kernel refuses
// the second creator with EEXIST — and if even that is impossible it refuses with
// an actionable error. rename(2) is NEVER an acceptable publish: it REPLACES, so
// two writers racing one name could both "create" it and the later one would
// silently rebind it (a fire id re-pointed at another run, so the exit signal
// closes the WRONG run). link(2) stays PRIMARY because it is exclusive *and*
// all-or-nothing: the final name never appears holding a partially written blob.
const LINK_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EXDEV']);

function publishExclusiveInPlace(target: string, name: string, bytes: Buffer, linkCode: string): void {
  let fd: number;
  try {
    fd = ledgerFsSeams.createExclusiveRaw(target, FILE_MODE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new ConflictError(name, `'${target}' appeared during the write — refusing to replace it (create-only)`);
    }
    throw new BackendUnavailableError(
      `cannot publish ${target} create-once: this filesystem does not support link(2) (${linkCode}) and an exclusive create at the final name failed (${code ?? (err as Error).message}) — refusing to fall back to a replacing rename, which would let two concurrent writers both claim the name`,
    );
  }
  try {
    writeFully(fd, bytes);
    fsyncSync(fd);
  } catch (err) {
    try {
      unlinkSync(target);
    } catch {
      // best effort: never leave a half-written publication behind
    }
    throw err;
  } finally {
    closeSync(fd);
  }
}

function createOnlyWriteCore(dir: string, name: string, bytes: Buffer): void {
  const target = join(dir, name);
  if (lstatOrNull(target) !== null) {
    throw new ConflictError(name, `'${target}' already exists — the blob writer is create-only`);
  }
  const tmp = join(dir, `.tmp-${name.slice(0, 16)}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    const fd = openSync(tmp, 'wx', FILE_MODE);
    try {
      writeFully(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Publish by HARD LINK, not rename (round-7 finding 3). link(2) is an atomic
    // create-if-absent — it fails EEXIST when the target exists and never follows
    // or replaces it — so a concurrent writer that landed after the lstat above
    // LOSES here instead of being silently clobbered. (rename(2) replaces, so the
    // old lstat-recheck+rename form left a real window in which two processes
    // both "created" the file and the later one won: a fire id could be rebound
    // to a second run.) Durability is unchanged: same-dir tmp → write → fsync →
    // publish → dir fsync; the tmp link is dropped once the target name exists.
    try {
      ledgerFsSeams.linkRaw(tmp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new ConflictError(name, `'${target}' appeared during the write — refusing to replace it (create-only)`);
      }
      if (!LINK_UNSUPPORTED.has(code ?? '')) throw err;
      publishExclusiveInPlace(target, name, bytes, code ?? 'unknown');
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never landed
    }
    if (err instanceof PersistenceError) throw err;
    throw new BackendUnavailableError(`cannot write ${target}: ${(err as Error).message}`);
  }
  try {
    unlinkSync(tmp);
  } catch {
    // already gone
  }
  fsyncDir(dir);
}

// Content-addressed byte staging shared by the local artifact store and the
// outbox spool: write-temp → fsync → rename → dir-fsync, create-only. A write
// failure (disk full, permissions) surfaces as BackendUnavailableError — the
// bytes either land fully durable under their final name or not at all.
export function writeBlobSync(dir: string, name: string, bytes: Uint8Array): void {
  createOnlyWriteCore(dir, name, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
}

// String flavor of the create-only core for small JSON sidecars (the per-fire
// schedule run-id channel). Same hardening, same ConflictError-on-exists
// contract (round-6 findings 5+9: the sidecar must never REBIND an existing
// fire id via a replacing write, and must not go through a weaker parallel
// pathname helper).
export function writeFileCreateOnlySync(dir: string, name: string, contents: string): void {
  createOnlyWriteCore(dir, name, Buffer.from(contents, 'utf8'));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockHandle = { path: string; fd: number };

export type ReclaimHooks = { beforeRename?: () => void };

// Race-safe stale-lock reclaim: open the lock, verify the open fd and the
// pathname still name the same inode, verify the recorded holder is dead,
// re-verify inode identity immediately before renaming the stale lock aside
// to a unique name, then let the caller retry a fresh O_EXCL acquire. The
// renamed-aside file is abandoned (unique name, ignored by readers) — it is
// NEVER moved back, so a concurrently-acquired live lock can never be
// clobbered by a reclaim restoring stale state over it.
export function tryReclaimStaleLock(lockPath: string, hooks?: ReclaimHooks): boolean {
  // A lock file is agent-writable state like every other sidecar: refuse a
  // planted symlink outright (never reclaim THROUGH it), open no-follow +
  // non-blocking so a FIFO cannot hang the acquire loop, and re-verify through
  // the descriptor that the opened inode is a regular file of sane size before
  // reading the holder record.
  const planted = lstatOrNull(lockPath);
  if (planted === null) return true; // gone already — retry the O_EXCL acquire
  if (planted.isSymbolicLink()) throw symlinkRefusal(lockPath);
  let fd: number;
  try {
    fd = openSync(lockPath, RO_NOFOLLOW_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw symlinkRefusal(lockPath);
    if (code === 'ENOENT') return true;
    return false;
  }
  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size > MAX_LOCK_BYTES) return false;
    let pathStat = lstatOrNull(lockPath);
    if (pathStat === null) return true;
    if (pathStat.ino !== fdStat.ino || pathStat.dev !== fdStat.dev) return false;
    let raw: string;
    try {
      raw = readFileSync(fd, 'utf8');
    } catch {
      return false;
    }
    let holderPid: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === 'number') holderPid = parsed.pid;
    } catch {
      holderPid = null;
    }
    if (holderPid !== null && pidAlive(holderPid)) return false;
    if (holderPid === null) {
      // Unparseable lock content: only reclaim once it is old enough to rule
      // out a lock file mid-write.
      if (Date.now() - fdStat.mtimeMs < 5_000) return false;
    }
    hooks?.beforeRename?.();
    pathStat = lstatOrNull(lockPath);
    if (pathStat === null) return true;
    if (pathStat.ino !== fdStat.ino || pathStat.dev !== fdStat.dev) return false;
    const aside = `${lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      renameSync(lockPath, aside);
    } catch {
      return true; // someone else won the reclaim race
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

export function acquirePathLock(dir: string, name: string, timeoutMs: number): LockHandle {
  const lockPath = join(dir, name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx', FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new BackendUnavailableError(`cannot acquire ledger lock ${lockPath}: ${(err as Error).message}`);
      }
      if (tryReclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new BackendUnavailableError(`ledger lock held by another process: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      writeFully(fd, Buffer.from(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })));
      fsyncSync(fd);
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // never landed
      }
      throw new BackendUnavailableError(`cannot write ledger lock ${lockPath}: ${(err as Error).message}`);
    }
    return { path: lockPath, fd };
  }
}

export function releasePathLock(lock: LockHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    // already closed
  }
  try {
    unlinkSync(lock.path);
  } catch {
    // reclaimed by another process after we died? nothing to do
  }
}

// Read-only meta accessor (no minting side effect) — capability discovery and
// doctor paths read the tree's identity without creating one. Returns null when
// the tree has no meta.json yet; refuses loudly on corruption or a foreign
// workspace id.
//
// Round-12 finding 2: this was a raw readFileSync over an unconfined tree, so a
// symlinked `.roster/ops/<workspaceId>` handed backend resolution a FOREIGN
// meta.json (and a planted FIFO blocked it forever). The directory chain is now
// component-wise confined and the file itself read through the shared hardened
// bounded reader (O_NOFOLLOW + O_NONBLOCK + fstat regular-file + byte cap).
export function readLedgerMeta(treeDir: string, workspaceId: string, boundary: string): LedgerMeta | null {
  if (confinedLedgerDir(treeDir, boundary) === 'absent') return null;
  const metaPath = join(treeDir, 'meta.json');
  const read = readEvidenceFileSync(metaPath, MAX_META_BYTES);
  if (read.state === 'missing') return null;
  if (read.state === 'malformed') {
    if (read.reason === 'unreadable') {
      throw new BackendUnavailableError(`cannot read ${metaPath}: ${describeEvidenceFailure(read.reason)}`);
    }
    throw new InvalidRecordError(
      `${metaPath} is ${describeEvidenceFailure(read.reason, MAX_META_BYTES)} — refusing to guess a producer identity`,
    );
  }
  const raw = read.content;
  let parsed: LedgerMeta;
  try {
    parsed = JSON.parse(raw) as LedgerMeta;
  } catch {
    throw new InvalidRecordError(`${metaPath} is corrupt (not valid JSON) — refusing to guess a producer identity`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.workspaceId !== 'string' ||
    typeof parsed.producerId !== 'string' ||
    typeof parsed.configVersion !== 'number'
  ) {
    throw new InvalidRecordError(`${metaPath} is corrupt (missing fields) — refusing to guess a producer identity`);
  }
  if (parsed.workspaceId !== workspaceId) {
    throw new WorkspaceMismatchError(`${metaPath} belongs to workspace ${parsed.workspaceId}, not ${workspaceId}`);
  }
  return parsed;
}

function segmentName(index: number): string {
  return `segment-${String(index).padStart(4, '0')}.jsonl`;
}

function sealChecksum(seal: Omit<SealSidecar, 'checksum'>): string {
  return sha256Hex(
    JSON.stringify({
      segment: seal.segment,
      lastValidOffset: seal.lastValidOffset,
      records: seal.records,
      lastHash: seal.lastHash,
    }),
  );
}

// The sidecar is derived metadata a hostile checkout can plant, so it is read
// through the SAME hardened bounded reader as every other agent-writable
// sidecar (round-12 finding 2 audit): O_NOFOLLOW so a symlink swapped in
// between the lstat above and this read is refused, O_NONBLOCK so a FIFO cannot
// hang recovery, and a byte cap so a runaway file is never loaded. Any refusal
// is `null` — the caller's existing "discard the sidecar and recompute from the
// segment bytes" path, which never drops records.
function readSeal(sealPath: string, segmentFile: string): SealSidecar | null {
  const read = readEvidenceFileSync(sealPath, MAX_SEAL_BYTES);
  if (read.state !== 'ok') return null;
  let parsed: SealSidecar;
  try {
    parsed = JSON.parse(read.content) as SealSidecar;
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.segment !== segmentFile ||
    typeof parsed.lastValidOffset !== 'number' ||
    !Number.isInteger(parsed.lastValidOffset) ||
    parsed.lastValidOffset < 0 ||
    typeof parsed.records !== 'number' ||
    (parsed.lastHash !== null && typeof parsed.lastHash !== 'string') ||
    parsed.checksum !== sealChecksum(parsed)
  ) {
    return null;
  }
  return parsed;
}

export class LocalLedger {
  readonly opsRoot: string;
  readonly workspaceId: string;
  readonly treeDir: string;
  // Symlink/realpath containment boundary: every persistence path component
  // below it is verified. For the standard cwd/.roster/ops layout this is the
  // workspace cwd, so a symlinked .roster or .roster/ops is refused.
  readonly boundary: string;
  private readonly now: () => number;
  private readonly maxRecordBytes: number;
  private readonly lockTimeoutMs: number;
  private cachedMeta: LedgerMeta | null;

  constructor(opts: LocalLedgerOptions) {
    if (!isUuidV4(opts.workspaceId)) {
      throw new InvalidRecordError(`workspace id must be a UUID v4 (got '${opts.workspaceId}')`);
    }
    assertSafeSegment('workspace id', opts.workspaceId);
    this.opsRoot = opts.opsRoot;
    this.workspaceId = opts.workspaceId;
    this.treeDir = join(opts.opsRoot, opts.workspaceId);
    this.boundary = ledgerBoundaryFor(opts.opsRoot);
    this.now = opts.now ?? Date.now;
    this.maxRecordBytes = opts.maxRecordBytes ?? MAX_RECORD_BYTES;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.cachedMeta = null;
  }

  namespaceDir(namespace: string): string {
    assertSafeSegment('namespace', namespace);
    return join(this.treeDir, namespace);
  }

  ensureDir(path: string): void {
    ensureOwnedDir(path, this.boundary);
  }

  withLock<T>(dir: string, name: string, fn: () => T): T {
    const lock = acquirePathLock(dir, name, this.lockTimeoutMs);
    try {
      return fn();
    } finally {
      releasePathLock(lock);
    }
  }

  meta(): LedgerMeta {
    if (this.cachedMeta) return this.cachedMeta;
    const metaPath = join(this.treeDir, 'meta.json');
    this.ensureDir(this.treeDir);
    let meta = readLedgerMeta(this.treeDir, this.workspaceId, this.boundary);
    if (meta === null) {
      const lock = acquirePathLock(this.treeDir, '.init.lock', this.lockTimeoutMs);
      try {
        meta = readLedgerMeta(this.treeDir, this.workspaceId, this.boundary);
        if (meta === null) {
          meta = {
            configVersion: PERSISTENCE_YAML_VERSION,
            workspaceId: this.workspaceId,
            producerId: randomUUID(),
            // The local JSONL backend implements the #323 run ledger + artifact
            // declarations unconditionally, so it mints roster_ops/objects at v2
            // — its meta must ADVERTISE that so the per-operation capability gates
            // (run-ledger) pass on a local workspace (finding: local mints v1).
            componentVersions: LOCAL_COMPONENT_VERSIONS,
          };
          atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
        }
      } finally {
        releasePathLock(lock);
      }
    } else if (needsComponentUpgrade(meta.componentVersions)) {
      // A tree minted by #318 records roster_ops v1; the #323 code serves v2
      // features over it unchanged, so upgrade the meta advertisement in place
      // (a local, code-driven "migration") so the capability gates authorize the
      // run-ledger operations (finding: implement the local meta upgrade).
      const lock = acquirePathLock(this.treeDir, '.init.lock', this.lockTimeoutMs);
      try {
        const fresh = readLedgerMeta(this.treeDir, this.workspaceId, this.boundary) ?? meta;
        if (needsComponentUpgrade(fresh.componentVersions)) {
          meta = { ...fresh, componentVersions: mergeComponentVersions(fresh.componentVersions) };
          atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
        } else {
          meta = fresh;
        }
      } finally {
        releasePathLock(lock);
      }
    }
    this.cachedMeta = meta;
    return meta;
  }

  append(namespace: string, input: AppendInput, testHooks?: LedgerTestHooks): AppendResult {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new InvalidRecordError('record id is required');
    }
    if (typeof input.kind !== 'string' || input.kind.length === 0) {
      throw new InvalidRecordError('record kind is required');
    }
    if (input.payload === undefined) {
      throw new InvalidRecordError('record payload is required (undefined is not JSON-serializable)');
    }
    // The payload is serialized EXACTLY ONCE (canonical form: recursively
    // sorted keys, toJSON applied once) — the checksum, the stored line, and
    // the embedded value all derive from this single serialization, so a
    // stateful toJSON can never produce a record whose own recovery rejects
    // it, and local + postgres hashing agree on key order.
    let payloadJson: string;
    try {
      payloadJson = canonicalJson(input.payload);
    } catch (err) {
      throw new InvalidRecordError(`record payload is not JSON-serializable: ${(err as Error).message}`);
    }
    if (payloadJson === undefined) {
      throw new InvalidRecordError('record payload is not JSON-serializable');
    }
    const payload = JSON.parse(payloadJson) as unknown;
    const meta = this.meta();
    const nsDir = this.namespaceDir(namespace);
    this.ensureDir(nsDir);
    const lock = acquirePathLock(nsDir, '.lock', this.lockTimeoutMs);
    try {
      const state = this.recoverNamespace(nsDir);
      const checksum = sha256Hex(payloadJson);
      const existing = state.byId.get(input.id);
      if (existing) {
        if (existing.checksum === checksum && existing.kind === input.kind) {
          // Replay idempotency: the record bytes are already present, but a
          // prior append may have crashed AFTER fsync(fd) yet BEFORE fsyncDir
          // confirmed the directory entry (dir-fsync threw). Re-fsync the
          // namespace dir before acking so a replay never returns committed over
          // an unconfirmed directory-durability seam.
          fsyncDir(nsDir);
          return { record: existing, replayed: true };
        }
        throw new ConflictError(input.id, 'same id re-appended with a different payload');
      }
      const seq = state.lastSeq + 1;
      const record: LedgerRecord = {
        id: input.id,
        ws: this.workspaceId,
        seq,
        ts: this.now(),
        kind: input.kind,
        payload,
        checksum,
        prev: state.lastHash,
        producerId: meta.producerId,
        // Single-producer tree: the store-assigned seq IS the producer seq
        // (both are allocated under the same lock).
        producerSeq: seq,
        // Observations ride ALONGSIDE the payload but are excluded from the
        // checksum above, so a same-id replay with different observations dedups
        // (first-write-wins) rather than conflicting.
        ...(input.observations !== undefined ? { observations: input.observations } : {}),
      };
      const line = JSON.stringify(record) + '\n';
      const buf = Buffer.from(line, 'utf8');
      if (buf.length > this.maxRecordBytes) {
        throw new InvalidRecordError(
          `record ${input.id} is ${buf.length} bytes; the ledger record limit is ${this.maxRecordBytes} bytes — store large payloads as artifacts`,
        );
      }
      const targetIndex =
        state.tailIndex < 0 ? 0 : state.tailSealed ? state.tailIndex + 1 : state.tailIndex;
      const segPath = join(nsDir, segmentName(targetIndex));
      const creating = assertRegularFileIfExists(segPath) === null;
      testHooks?.beforeOpen?.();
      let fd: number;
      try {
        fd = openSync(segPath, APPEND_OPEN_FLAGS, FILE_MODE);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw symlinkRefusal(segPath);
        throw new BackendUnavailableError(`cannot open ledger segment ${segPath}: ${(err as Error).message}`);
      }
      // Descriptor-based verification: the opened inode must be a regular file
      // (O_NOFOLLOW already refused a symlink; this also rejects a FIFO/device
      // swapped in). Done before the write block so a bad inode never hits the
      // truncate-rollback path.
      const openedStat = fstatSync(fd);
      if (!openedStat.isFile()) {
        closeSync(fd);
        throw new InvalidRecordError(`ledger segment ${segPath} is not a regular file — refusing to append`);
      }
      let preSize = 0;
      try {
        // fchmod on the fd (not the path) avoids re-resolving segPath.
        if (creating) fchmodSync(fd, FILE_MODE);
        preSize = openedStat.size;
        testHooks?.beforeWrite?.();
        if (testHooks?.midWrite) {
          const split = Math.max(1, Math.floor(buf.length / 2));
          writeFully(fd, buf.subarray(0, split));
          testHooks.midWrite();
          writeFully(fd, buf.subarray(split));
        } else {
          writeFully(fd, buf);
        }
        testHooks?.beforeFsync?.();
        fsyncSync(fd);
        testHooks?.afterFsync?.();
      } catch (err) {
        // Never leave a partial line acked as durable: best-effort roll back to
        // the pre-append size (a crash here is healed by the seal protocol).
        try {
          ftruncateSync(fd, preSize);
          fsyncSync(fd);
        } catch {
          // seal protocol handles what we could not undo
        }
        if (err instanceof PersistenceError) throw err;
        throw new BackendUnavailableError(`ledger append failed: ${(err as Error).message}`);
      } finally {
        closeSync(fd);
      }
      if (creating) fsyncDir(nsDir);
      return { record, replayed: false };
    } finally {
      releasePathLock(lock);
    }
  }

  scan(namespace: string): { records: LedgerRecord[]; lastSeq: number } {
    const nsDir = this.namespaceDir(namespace);
    // Round-12 finding 2: this checked only the FINAL namespace component, so a
    // symlinked `.roster/ops/<workspaceId>` still made the read path scan — and
    // LOCK, recover and seal — a FOREIGN ledger tree. Confine EVERY component
    // below the workspace boundary before touching anything. Same taxonomy as
    // the write side (ensureOwnedDir): missing is "no records yet", a link or a
    // non-directory is an integrity refusal.
    if (confinedLedgerDir(nsDir, this.boundary) === 'absent') return { records: [], lastSeq: 0 };
    const lock = acquirePathLock(nsDir, '.lock', this.lockTimeoutMs);
    try {
      const state = this.recoverNamespace(nsDir);
      return { records: state.records, lastSeq: state.lastSeq };
    } finally {
      releasePathLock(lock);
    }
  }

  verifyChain(namespace: string): { records: number } {
    return { records: this.scan(namespace).records.length };
  }

  // Full-scan recovery: validates every segment (checksums, seq continuity,
  // hash chain), verifies seal sidecars against the segment bytes (a sidecar
  // is NEVER trusted unverified — a forged seal hiding valid records is
  // discarded and the state recomputed), seals a torn tail, and hard-errors
  // on corruption before the seal point. Must be called with the namespace
  // lock held — sealing without the lock would mistake an in-flight append
  // for a torn tail.
  private recoverNamespace(nsDir: string): NamespaceState {
    let entries: string[];
    try {
      entries = readdirSync(nsDir);
    } catch (err) {
      throw new BackendUnavailableError(`cannot read ${nsDir}: ${(err as Error).message}`);
    }
    const indexes: number[] = [];
    for (const entry of entries) {
      const m = SEGMENT_RE.exec(entry);
      if (m) indexes.push(Number(m[1]));
    }
    indexes.sort((a, b) => a - b);
    for (let i = 0; i < indexes.length; i++) {
      if (indexes[i] !== i) {
        throw new InvalidRecordError(
          `ledger segment numbering has a gap in ${nsDir}: expected ${segmentName(i)}, found ${segmentName(indexes[i]!)}`,
        );
      }
    }
    const state: NamespaceState = {
      records: [],
      byId: new Map(),
      lastSeq: 0,
      lastHash: null,
      tailIndex: indexes.length === 0 ? -1 : indexes.length - 1,
      tailSealed: false,
    };
    for (let i = 0; i < indexes.length; i++) {
      const isTail = i === indexes.length - 1;
      const segFile = segmentName(i);
      const segPath = join(nsDir, segFile);
      const segStat = lstatSync(segPath);
      if (segStat.isSymbolicLink()) throw symlinkRefusal(segPath);
      if (!segStat.isFile()) {
        throw new InvalidRecordError(`ledger segment ${segPath} is not a regular file`);
      }
      const size = segStat.size;
      const sealPath = `${segPath}.seal`;
      const sealStat = lstatOrNull(sealPath);
      const sidecarWasPresent = sealStat !== null;
      let seal: SealSidecar | null = null;
      if (sealStat !== null) {
        if (sealStat.isFile()) seal = readSeal(sealPath, segFile);
        // Invalid (or non-regular-file) sidecar: derived state is never
        // trusted over the segments — discard it.
        if (seal === null) unlinkSync(sealPath);
      }
      if (seal !== null && seal.lastValidOffset > size) {
        // The sidecar is intact (its checksum verified); the SEGMENT lost
        // sealed bytes — corruption before the seal point, never a re-seal.
        throw new InvalidRecordError(
          `ledger segment ${segPath} is shorter (${size} bytes) than its seal sidecar records (${seal.lastValidOffset} bytes) — corruption before the seal point`,
        );
      }
      // Descriptor-verified read open, matching the append path: O_NOFOLLOW so a
      // symlink swapped in after the lstat above is refused rather than
      // traversed, O_NONBLOCK so a FIFO cannot hang recovery, and an fstat that
      // re-proves the OPENED inode is the regular file we measured.
      let fd: number;
      try {
        fd = openSync(segPath, RO_NOFOLLOW_FLAGS);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw symlinkRefusal(segPath);
        throw new BackendUnavailableError(`cannot read ledger segment ${segPath}: ${(err as Error).message}`);
      }
      if (!fstatSync(fd).isFile()) {
        closeSync(fd);
        throw new InvalidRecordError(`ledger segment ${segPath} is not a regular file`);
      }
      let scanned: SegmentScan;
      try {
        if (seal !== null) {
          const sealedScan = this.scanRange(segPath, fd, 0, seal.lastValidOffset, state.lastSeq, state.lastHash);
          if (sealedScan.tornStart !== null) {
            throw new InvalidRecordError(
              `ledger segment ${segPath} is corrupt at byte ${sealedScan.tornStart} (before the seal point) — refusing to silently skip records`,
            );
          }
          const sealedLastHash =
            sealedScan.lineHashes.length > 0
              ? sealedScan.lineHashes[sealedScan.lineHashes.length - 1]!
              : state.lastHash;
          const sealedLastSeq =
            sealedScan.records.length > 0
              ? sealedScan.records[sealedScan.records.length - 1]!.seq
              : state.lastSeq;
          const remainder = this.classifyRemainder(
            segPath,
            fd,
            seal.lastValidOffset,
            size,
            sealedLastSeq,
            sealedLastHash,
          );
          if (remainder === 'corrupt') {
            // COMPLETE but invalid content exists beyond the seal offset. A
            // sidecar is derived metadata — it can never turn a segment with
            // complete corruption into a valid short one (that would silently
            // drop records). Only a genuinely TORN (incomplete, unterminated)
            // final write is a legitimate post-seal remainder.
            throw new InvalidRecordError(
              `ledger segment ${segPath} has complete but invalid content beyond its seal offset (${seal.lastValidOffset}) — a seal sidecar cannot hide segment corruption`,
            );
          }
          const honest =
            sealedScan.records.length === seal.records &&
            sealedLastHash === seal.lastHash &&
            remainder === 'clean';
          if (honest) {
            scanned = sealedScan;
          } else {
            // A self-consistent but FALSE seal (its offset/count/hash do not
            // match the segment, or complete VALID records exist beyond its
            // offset): discard it and recompute — records reappear.
            unlinkSync(sealPath);
            seal = null;
            scanned = this.scanRange(segPath, fd, 0, size, state.lastSeq, state.lastHash);
          }
        } else {
          scanned = this.scanRange(segPath, fd, 0, size, state.lastSeq, state.lastHash);
        }
      } finally {
        closeSync(fd);
      }
      if (scanned.tornStart !== null) {
        // Sealing is only legitimate for an unsealed tail (a crash tore the
        // final append) or when recomputing a discarded invalid sidecar. A
        // tear anywhere else — inside a sealed region or in a non-tail
        // segment — is corruption before the seal point.
        const mayRecover = isTail || sidecarWasPresent;
        if (!mayRecover) {
          throw new InvalidRecordError(
            `ledger segment ${segPath} is corrupt at byte ${scanned.tornStart} (before the seal point) — refusing to silently skip records`,
          );
        }
        // Torn tail (or a discarded invalid sidecar recomputed from the segment
        // scan): seal at the last valid offset. Original bytes stay untouched.
        const sidecar: Omit<SealSidecar, 'checksum'> = {
          segment: segFile,
          lastValidOffset: scanned.tornStart,
          records: scanned.records.length,
          lastHash:
            scanned.lineHashes.length > 0
              ? scanned.lineHashes[scanned.lineHashes.length - 1]!
              : state.lastHash,
        };
        atomicWriteFileSync(sealPath, JSON.stringify({ ...sidecar, checksum: sealChecksum(sidecar) }) + '\n');
        seal = { ...sidecar, checksum: sealChecksum(sidecar) };
      }
      for (const record of scanned.records) {
        state.records.push(record);
        state.byId.set(record.id, record);
      }
      if (scanned.records.length > 0) {
        state.lastSeq = scanned.records[scanned.records.length - 1]!.seq;
        state.lastHash = scanned.lineHashes[scanned.lineHashes.length - 1]!;
      }
      if (isTail) state.tailSealed = seal !== null;
    }
    return state;
  }

  // Classify the bytes beyond a seal offset:
  //  - 'clean'         : empty, or an incomplete/torn final write (the ONLY
  //                      legitimate post-seal content) — the seal may be trusted.
  //  - 'hides-records' : complete, chain-VALID records exist past the offset —
  //                      a false/stale seal; discard it and recompute (records
  //                      reappear).
  //  - 'corrupt'       : a complete but INVALID line (bad JSON, broken chain,
  //                      oversized) exists past the offset — the segment is
  //                      corrupt; a sidecar must not paper over it.
  // A torn tail surfaces via scanRange's tornStart (no exception) with zero
  // complete records; a complete invalid line throws InvalidRecordError.
  private classifyRemainder(
    segPath: string,
    fd: number,
    start: number,
    size: number,
    prevSeq: number,
    prevHash: string | null,
  ): 'clean' | 'hides-records' | 'corrupt' {
    if (start >= size) return 'clean';
    try {
      return this.scanRange(segPath, fd, start, size, prevSeq, prevHash).records.length > 0
        ? 'hides-records'
        : 'clean';
    } catch (err) {
      if (err instanceof InvalidRecordError) return 'corrupt';
      throw err;
    }
  }

  // Streaming line scanner over [start, limit): bounded memory (chunked reads,
  // per-line cap = the append record cap), byte-offset tracking for the seal
  // protocol. An unterminated final line reports tornStart; an oversized line
  // is a hard error naming the segment.
  private scanRange(
    segPath: string,
    fd: number,
    start: number,
    limit: number,
    prevSeq: number,
    prevHash: string | null,
  ): SegmentScan {
    const records: LedgerRecord[] = [];
    const lineHashes: string[] = [];
    let expectedSeq = prevSeq + 1;
    let expectedPrev = prevHash;
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let lineStart = start;
    let pos = start;
    const oversized = (at: number): never => {
      throw new InvalidRecordError(
        `ledger segment ${segPath} record at byte ${at} exceeds the ${this.maxRecordBytes}-byte record limit — refusing to load it`,
      );
    };
    while (pos < limit) {
      const want = Math.min(chunk.length, limit - pos);
      const n = readSync(fd, chunk, 0, want, pos);
      if (n <= 0) {
        throw new BackendUnavailableError(`ledger segment ${segPath} ended unexpectedly at byte ${pos}`);
      }
      let sliceStart = 0;
      for (let i = 0; i < n; i++) {
        if (chunk[i] !== 0x0a) continue;
        const tailPart = chunk.subarray(sliceStart, i);
        const lineBuf = pending.length === 0 ? Buffer.from(tailPart) : Buffer.concat([...pending, tailPart]);
        pending = [];
        pendingBytes = 0;
        if (lineBuf.length >= this.maxRecordBytes) oversized(lineStart);
        this.consumeLine(segPath, lineBuf.toString('utf8'), lineStart, records, lineHashes, expectedSeq, expectedPrev);
        expectedSeq = records[records.length - 1]!.seq + 1;
        expectedPrev = lineHashes[lineHashes.length - 1]!;
        lineStart = pos + i + 1;
        sliceStart = i + 1;
      }
      if (sliceStart < n) {
        pending.push(Buffer.from(chunk.subarray(sliceStart, n)));
        pendingBytes += n - sliceStart;
        if (pendingBytes > this.maxRecordBytes) oversized(lineStart);
      }
      pos += n;
    }
    if (pendingBytes > 0) {
      // Unterminated bytes: a torn (physically incomplete) final write. The
      // caller decides whether this is sealable (tail) or corruption.
      return { records, lineHashes, endOffset: lineStart, tornStart: lineStart };
    }
    return { records, lineHashes, endOffset: lineStart, tornStart: null };
  }

  private consumeLine(
    segPath: string,
    lineStr: string,
    offset: number,
    records: LedgerRecord[],
    lineHashes: string[],
    expectedSeq: number,
    expectedPrev: string | null,
  ): void {
    let parsed: LedgerRecord;
    try {
      parsed = JSON.parse(lineStr) as LedgerRecord;
    } catch {
      // A complete line (it has its newline) that does not parse cannot come
      // from a torn single-buffer write — record lines contain no interior
      // newlines, so a partial write is always an UNTERMINATED prefix. This
      // is corruption, never a tear.
      throw new InvalidRecordError(`ledger segment ${segPath} record at byte ${offset} is not valid JSON`);
    }
    const reason = this.validateRecord(parsed, expectedSeq, expectedPrev);
    if (reason !== null) {
      throw new InvalidRecordError(
        `ledger segment ${segPath} record seq ${String((parsed as { seq?: unknown }).seq ?? '?')} at byte ${offset} is invalid: ${reason}`,
      );
    }
    records.push(parsed);
    lineHashes.push(sha256Hex(lineStr));
  }

  private validateRecord(rec: LedgerRecord, expectedSeq: number, expectedPrev: string | null): string | null {
    if (rec === null || typeof rec !== 'object') return 'not an object';
    if (typeof rec.id !== 'string' || rec.id.length === 0) return 'missing id';
    if (typeof rec.ws !== 'string') return 'missing ws';
    if (rec.ws !== this.workspaceId) {
      throw new WorkspaceMismatchError(
        `ledger record ${rec.id} belongs to workspace ${rec.ws}, not ${this.workspaceId}`,
      );
    }
    if (rec.seq !== expectedSeq) return `seq ${String(rec.seq)} does not continue the chain (expected ${expectedSeq})`;
    if (typeof rec.ts !== 'number') return 'missing ts';
    if (typeof rec.kind !== 'string' || rec.kind.length === 0) return 'missing kind';
    if (!('payload' in rec)) return 'missing payload';
    if (typeof rec.checksum !== 'string') return 'missing checksum';
    if (rec.checksum !== sha256Hex(canonicalJson(rec.payload))) return 'payload checksum mismatch';
    if (rec.prev !== expectedPrev) return 'hash chain broken (prev does not match prior record line)';
    if (typeof rec.producerId !== 'string' || rec.producerId.length === 0) return 'missing producerId';
    if (typeof rec.producerSeq !== 'number') return 'missing producerSeq';
    return null;
  }
}
