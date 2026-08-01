import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, posix, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { normalizeWorkspaceRelativePath } from './workspace-layout.ts';
import { isWorkspaceFailure, workspaceFailure } from './workspace-diagnostics.ts';

export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;
export const MAX_SLOT_ENTRIES = 1_000;
export const ROSTER_STATE_GITIGNORE = 'state/\n';

export type WorkspaceReadOptions = {
  maxBytes?: number;
  fs?: WorkspaceReadFs;
  beforeOpen?: () => void;
};

export type WorkspaceReadFs = {
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  readSync: (
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  closeSync: typeof closeSync;
  lstatSync: (path: string) => Stats;
};

export const realWorkspaceReadFs: WorkspaceReadFs = {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  lstatSync,
};

export type WorkspaceDurabilityFs = {
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
};

export const realWorkspaceDurabilityFs: WorkspaceDurabilityFs = {
  openSync,
  fstatSync,
  fsyncSync,
  closeSync,
};

export type WorkspaceMutationFs = {
  openSync: (path: string, flags: number, mode?: number) => number;
  writeSync: (
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  fchmodSync: typeof fchmodSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  linkSync: typeof linkSync;
  mkdirSync: typeof mkdirSync;
  renameSync: typeof renameSync;
  rmdirSync: typeof rmdirSync;
  unlinkSync: typeof unlinkSync;
  lstatSync: (path: string) => Stats;
};

export const realWorkspaceMutationFs: WorkspaceMutationFs = {
  openSync,
  writeSync,
  fchmodSync,
  fsyncSync,
  closeSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  lstatSync,
};

export type WorkspaceReadSession = {
  readFile: (relativePath: string, options?: WorkspaceReadOptions) => Buffer;
  readText: (relativePath: string, options?: WorkspaceReadOptions) => string;
  verify: () => void;
};

export type WorkspaceDirectoryResult = {
  created: string[];
  creationTokens: WorkspaceDirectoryIdentityToken[];
};

export type WorkspaceDirectoryIdentityToken = {
  path: string;
  dev: number;
  ino: number;
};

export type WorkspaceDirectoryOptions = {
  durabilityFs?: WorkspaceDurabilityFs;
  mutationFs?: WorkspaceMutationFs;
  beforeRootRealpath?: () => void;
  beforeCreate?: (relativePath: string) => void;
  afterMutation?: (relativePath: string) => void;
};

export type PublicationResult = 'created' | 'adopted';

export type WorkspaceFileIdentityToken = {
  dev: number;
  ino: number;
  hash: string;
};

export type WorkspaceSlotEntry = {
  name: string;
  kind: 'file' | 'directory';
};

export type WorkspaceEntryKind = 'absent' | 'file' | 'directory' | 'symlink' | 'other';

let temporarySequence = 0;

function errno(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

function isMissing(error: unknown): boolean {
  const code = errno(error).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (isWorkspaceFailure(error)) return { code: error.code, message: error.header.replace(/^roster:\s*/, '') };
  return {
    code: errno(error).code ?? 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

function relativeComponents(relativePath: string): string[] {
  return normalizeWorkspaceRelativePath(relativePath).split('/');
}

function assertRootDirectory(root: string, beforeRealpath?: () => void): string {
  const absoluteRoot = root === '.' ? '.' : resolve(root);
  let stat;
  try {
    stat = lstatSync(absoluteRoot);
  } catch (error) {
    if (isMissing(error)) {
      throw workspaceFailure('WORKSPACE_NOT_FOUND', `Workspace '${absoluteRoot}' does not exist.`, 'Create or enter a directory before running Roster.', { root: absoluteRoot });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw workspaceFailure('SYMLINK_COMPONENT', `Workspace root '${absoluteRoot}' is a symlink.`, 'Use the real workspace directory, not a symlink.', { path: absoluteRoot });
  }
  if (!stat.isDirectory()) {
    throw workspaceFailure('NOT_REGULAR_FILE', `Workspace root '${absoluteRoot}' is not a directory.`, 'Use a real workspace directory.', { path: absoluteRoot });
  }
  beforeRealpath?.();
  let canonical: string;
  try {
    canonical = realpathSync.native(absoluteRoot);
  } catch (error) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Workspace root '${absoluteRoot}' changed during boundary canonicalization.`,
      'Stop the concurrent filesystem mutation and retry from the real workspace directory.',
      { path: absoluteRoot, cause: errno(error).code ?? 'unknown' },
    );
  }
  let final;
  let canonicalStat;
  try {
    final = lstatSync(absoluteRoot);
    canonicalStat = lstatSync(canonical);
  } catch (error) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Workspace root '${absoluteRoot}' changed during boundary verification.`,
      'Stop the concurrent filesystem mutation and retry from the real workspace directory.',
      { path: absoluteRoot, cause: errno(error).code ?? 'unknown' },
    );
  }
  if (
    final.isSymbolicLink()
    || !final.isDirectory()
    || !canonicalStat.isDirectory()
    || canonicalStat.isSymbolicLink()
    || final.dev !== stat.dev
    || final.ino !== stat.ino
    || canonicalStat.dev !== stat.dev
    || canonicalStat.ino !== stat.ino
  ) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Workspace root '${absoluteRoot}' was replaced during boundary verification.`,
      'Use the stable real workspace directory and retry.',
      { path: absoluteRoot },
    );
  }
  return canonical;
}

function assertExistingDirectoryChain(root: string, relativeDirectory: string): string {
  const absoluteRoot = assertRootDirectory(root);
  if (relativeDirectory === '.' || relativeDirectory === '') return absoluteRoot;
  let current = absoluteRoot;
  for (const component of relativeComponents(relativeDirectory)) {
    current = resolve(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) {
        throw workspaceFailure('PARENT_NOT_FOUND', `Directory '${relativeDirectory}' does not exist.`, 'Scaffold or restore the registered parent first.', { path: relativeDirectory });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw workspaceFailure('SYMLINK_COMPONENT', `Path component '${current}' is a symlink.`, 'Replace the symlink with a real workspace directory.', { path: current });
    }
    if (!stat.isDirectory()) {
      throw workspaceFailure('NOT_REGULAR_FILE', `Path component '${current}' is not a directory.`, 'Remove the conflicting entry or choose another registered path.', { path: current });
    }
  }
  return current;
}

function assertSafeParent(root: string, relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const parent = posix.dirname(normalized);
  return assertExistingDirectoryChain(root, parent);
}

type DirectoryIdentity = {
  absolute: string;
  relative: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
};

function directoryIdentity(
  absolute: string,
  relativePath: string,
  requireCanonicalPath = true,
): DirectoryIdentity {
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (isMissing(error)) {
      throw workspaceFailure('PARENT_NOT_FOUND', `Directory '${relativePath}' does not exist.`, 'Scaffold or restore the registered parent first.', { path: relativePath });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw workspaceFailure('SYMLINK_COMPONENT', `Path component '${relativePath}' is a symlink.`, 'Replace the symlink with a real workspace directory.', { path: relativePath });
  }
  if (!stat.isDirectory()) {
    throw workspaceFailure('NOT_REGULAR_FILE', `Path component '${relativePath}' is not a directory.`, 'Remove the conflicting entry or choose another registered path.', { path: relativePath });
  }
  if (requireCanonicalPath) {
    const canonical = realpathSync.native(absolute);
    if (canonical !== absolute) {
      throw workspaceFailure('SYMLINK_COMPONENT', `Path component '${relativePath}' resolves through a symlink.`, 'Replace the symlinked component with a real workspace directory.', { path: relativePath, resolvedPath: canonical });
    }
  }
  return {
    absolute,
    relative: relativePath,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function directoryIdentityFromStat(
  absolute: string,
  relativePath: string,
  stat: Stats,
): DirectoryIdentity {
  return {
    absolute,
    relative: relativePath,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function workspaceDirectoryIdentityFailure(
  token: WorkspaceDirectoryIdentityToken,
  cause?: unknown,
): ReturnType<typeof workspaceFailure> {
  return workspaceFailure(
    'WRITE_CONFLICT',
    `Directory '${token.path}' no longer matches the captured workspace identity.`,
    'Stop the concurrent filesystem mutation and retry from a fresh workspace probe.',
    {
      path: token.path,
      directoryIdentityChanged: true,
      expectedDev: token.dev,
      expectedIno: token.ino,
      ...(cause === undefined ? {} : { cause: errno(cause).code ?? 'unknown' }),
    },
  );
}

function directoryIdentityForToken(
  root: string,
  token: WorkspaceDirectoryIdentityToken,
): DirectoryIdentity {
  const normalized = token.path === '.' ? '.' : normalizeWorkspaceRelativePath(token.path);
  let actual: DirectoryIdentity;
  try {
    const absolute = normalized === '.'
      ? assertRootDirectory(root)
      : assertExistingDirectoryChain(root, normalized);
    actual = directoryIdentity(absolute, normalized);
  } catch (error) {
    if (
      (isWorkspaceFailure(error)
        && (
          error.code === 'WORKSPACE_NOT_FOUND'
          || error.code === 'PARENT_NOT_FOUND'
          || error.code === 'SYMLINK_COMPONENT'
          || error.code === 'NOT_REGULAR_FILE'
          || error.code === 'WRITE_CONFLICT'
        ))
      || isMissing(error)
      || errno(error).code === 'ELOOP'
    ) {
      throw workspaceDirectoryIdentityFailure(token, error);
    }
    throw error;
  }
  if (actual.dev !== token.dev || actual.ino !== token.ino) {
    throw workspaceDirectoryIdentityFailure(token);
  }
  return actual;
}

export function isWorkspaceDirectoryIdentityFailure(error: unknown): boolean {
  return isWorkspaceFailure(error)
    && error.code === 'WRITE_CONFLICT'
    && error.details['directoryIdentityChanged'] === true;
}

export function assertWorkspaceDirectoryIdentity(
  root: string,
  token: WorkspaceDirectoryIdentityToken,
): void {
  directoryIdentityForToken(root, token);
}

export function withWorkspaceDirectoryIdentity<T>(
  root: string,
  token: WorkspaceDirectoryIdentityToken,
  operation: (anchoredRoot: '.') => T,
  options: { verifyAfter?: boolean } = {},
): T {
  const identity = directoryIdentityForToken(root, token);
  let entered = false;
  let result!: T;
  let operationError: unknown;
  try {
    result = withAnchoredDirectory(identity, () => {
      entered = true;
      return operation('.');
    });
  } catch (error) {
    operationError = error;
  }

  if (options.verifyAfter ?? true) {
    try {
      directoryIdentityForToken(root, token);
    } catch (error) {
      throw error;
    }
  }
  if (operationError !== undefined) {
    if (!entered && isWorkspaceFailure(operationError) && operationError.code === 'WRITE_CONFLICT') {
      const cause = operationError.details['cause'];
      if (cause === undefined || cause === 'ENOENT' || cause === 'ENOTDIR' || cause === 'ELOOP') {
        throw workspaceDirectoryIdentityFailure(token, operationError);
      }
    }
    throw operationError;
  }
  return result;
}

function assertDirectoryBinding(expected: DirectoryIdentity): DirectoryIdentity {
  const actual = directoryIdentity(expected.absolute, expected.relative);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Directory '${expected.relative}' was replaced during the filesystem operation.`,
      'Stop the concurrent filesystem mutation and retry.',
      { path: expected.relative },
    );
  }
  return actual;
}

function assertDirectoryIdentity(expected: DirectoryIdentity): void {
  const actual = assertDirectoryBinding(expected);
  if (actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Directory '${expected.relative}' changed during the bounded workspace read.`,
      'Stop the concurrent filesystem mutation and retry.',
      { path: expected.relative },
    );
  }
}

function assertCurrentDirectoryIdentity(expected: DirectoryIdentity): void {
  const actual = statSync('.');
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Directory '${expected.relative}' was replaced before the anchored filesystem operation.`,
      'Stop the concurrent filesystem mutation and retry.',
      { path: expected.relative },
    );
  }
}

function withAnchoredDirectory<T>(expected: DirectoryIdentity, operation: () => T): T {
  const current = statSync('.');
  if (current.dev === expected.dev && current.ino === expected.ino) {
    try {
      return operation();
    } finally {
      assertCurrentDirectoryIdentity(expected);
    }
  }
  const previous = process.cwd();
  const previousIdentity = statSync('.');
  try {
    process.chdir(expected.absolute);
  } catch (error) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Directory '${expected.relative}' could not be anchored for a filesystem operation.`,
      'Stop the concurrent filesystem mutation and retry.',
      { path: expected.relative, cause: errno(error).code ?? 'unknown' },
    );
  }
  try {
    assertCurrentDirectoryIdentity(expected);
    return operation();
  } finally {
    try {
      process.chdir(previous);
      const restored = statSync('.');
      if (restored.dev !== previousIdentity.dev || restored.ino !== previousIdentity.ino) {
        throw new Error('previous working directory identity changed');
      }
    } catch (error) {
      throw workspaceFailure(
        'WRITE_CONFLICT',
        'Process working directory changed during an anchored filesystem operation.',
        'Stop the concurrent filesystem mutation and restart the Roster command.',
        { path: previous, cause: errno(error).code ?? 'unknown' },
      );
    }
  }
}

function durabilityFailure(path: string, operation: string, error: unknown): never {
  const cause = errno(error).code ?? 'unknown';
  throw workspaceFailure(
    'ATOMIC_PUBLICATION_UNSUPPORTED',
    `Filesystem could not durably ${operation} directory '${path}'.`,
    'Move the workspace to a local filesystem that supports directory fsync, then retry.',
    { path, operation, cause },
  );
}

function mutationFailure(path: string, operation: string, error: unknown): never {
  const cause = errno(error).code ?? 'unknown';
  throw workspaceFailure(
    'FILESYSTEM_WRITE_FAILED',
    `Filesystem could not ${operation} '${path}'.`,
    'Check directory permissions and free space, then retry without removing existing bytes.',
    { path, operation, cause },
  );
}

function mutationStat(
  fs: WorkspaceMutationFs,
  path: string,
  diagnosticPath: string,
  operation: string,
): Stats {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    mutationFailure(diagnosticPath, operation, error);
  }
}

export function syncWorkspaceDirectory(
  path: string,
  fs: WorkspaceDurabilityFs = realWorkspaceDurabilityFs,
): void {
  let fd: number;
  try {
    fd = fs.openSync(path, fsConstants.O_RDONLY);
  } catch (error) {
    durabilityFailure(path, 'open', error);
  }
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    durabilityFailure(path, 'sync', error);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      durabilityFailure(path, 'close', error);
    }
  }
}

function syncAnchoredWorkspaceFile(
  parent: DirectoryIdentity,
  target: string,
  normalized: string,
  expected: Pick<Stats, 'dev' | 'ino'>,
  fs: WorkspaceDurabilityFs,
): void {
  let fd: number;
  try {
    fd = fs.openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    durabilityFailure(normalized, 'open file for sync in', error);
  }
  let failure: unknown;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' was replaced before durability sync.`, 'Preserve the replacement and retry from a fresh read.', { path: normalized });
    }
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd);
    const leaf = lstatSync(target);
    if (
      !after.isFile()
      || leaf.isSymbolicLink()
      || !leaf.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || leaf.dev !== before.dev
      || leaf.ino !== before.ino
    ) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' was replaced during durability sync.`, 'Preserve the replacement and retry from a fresh read.', { path: normalized });
    }
    assertCurrentDirectoryIdentity(parent);
  } catch (error) {
    failure = error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (isWorkspaceFailure(failure)) throw failure;
    durabilityFailure(normalized, 'sync file in', failure);
  }
}

function temporaryPath(parent: string, targetName: string): string {
  temporarySequence++;
  const name = `.${targetName}.roster-${process.pid}-${temporarySequence}-${randomBytes(6).toString('hex')}`;
  return parent === '.' ? name : resolve(parent, name);
}

function findAnchoredEntryName(
  dev: number,
  ino: number,
  kind: 'file' | 'directory',
): string | undefined {
  const handle = opendirSync('.');
  try {
    let inspected = 0;
    for (;;) {
      const entry = handle.readSync();
      if (entry === null || inspected === MAX_SLOT_ENTRIES) return undefined;
      inspected++;
      let stat;
      try {
        stat = lstatSync(entry.name);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (
        !stat.isSymbolicLink()
        && (kind === 'file' ? stat.isFile() : stat.isDirectory())
        && stat.dev === dev
        && stat.ino === ino
      ) return entry.name;
    }
  } finally {
    handle.closeSync();
  }
}

function writeTemporary(
  parent: string,
  targetName: string,
  bytes: Buffer,
  fs: WorkspaceMutationFs = realWorkspaceMutationFs,
): string {
  const temporary = temporaryPath(parent, targetName);
  const flags = fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(temporary, flags, 0o600);
  } catch (error) {
    mutationFailure(temporary, 'create temporary file for', error);
  }
  let failure: unknown;
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (written <= 0) throw new Error('zero-byte temporary write');
      offset += written;
    }
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort: the unique temp never becomes canonical.
    }
    mutationFailure(temporary, 'write temporary file for', failure);
  }
  return temporary;
}

function publicationUnsupported(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPERM'
    || error.code === 'EXDEV'
    || error.code === 'ENOTSUP'
    || error.code === 'EOPNOTSUPP'
    || error.code === 'ENOSYS';
}

export function hashWorkspaceBytes(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function ensureWorkspaceDirectory(
  root: string,
  relativeDirectory: string,
  options: WorkspaceDirectoryOptions = {},
): WorkspaceDirectoryResult {
  const normalized = normalizeWorkspaceRelativePath(relativeDirectory);
  const absoluteRoot = assertRootDirectory(root, options.beforeRootRealpath);
  const mutationFs = options.mutationFs ?? realWorkspaceMutationFs;
  const durabilityFs = options.durabilityFs ?? realWorkspaceDurabilityFs;
  const created: string[] = [];
  const creationTokens: WorkspaceDirectoryIdentityToken[] = [];
  let parent = directoryIdentity(absoluteRoot, '.');
  let relativeCurrent = '';
  try {
    for (const component of normalized.split('/')) {
    relativeCurrent = relativeCurrent === '' ? component : posix.join(relativeCurrent, component);
    const absolute = resolve(parent.absolute, component);
    const result = withAnchoredDirectory(parent, () => {
      let stat: Stats | undefined;
      try {
        stat = mutationFs.lstatSync(component);
      } catch (error) {
        if (!isMissing(error)) mutationFailure(relativeCurrent, 'inspect directory component', error);
      }
      if (stat !== undefined) {
        if (stat.isSymbolicLink()) {
          throw workspaceFailure('SYMLINK_COMPONENT', `Path component '${relativeCurrent}' is a symlink.`, 'Replace it with a real workspace directory.', { path: relativeCurrent });
        }
        if (!stat.isDirectory()) {
          throw workspaceFailure('NOT_REGULAR_FILE', `Path component '${relativeCurrent}' is not a directory.`, 'Remove the conflicting entry before retrying.', { path: relativeCurrent });
        }
        assertDirectoryBinding(parent);
        return { stat, created: false };
      }

      options.beforeCreate?.(relativeCurrent);
      assertCurrentDirectoryIdentity(parent);
      assertDirectoryBinding(parent);
      let made = false;
      try {
        mutationFs.mkdirSync(component, { mode: 0o755 });
        made = true;
      } catch (error) {
        if (errno(error).code !== 'EEXIST') mutationFailure(relativeCurrent, 'create directory', error);
      }
      try {
        stat = mutationFs.lstatSync(component);
      } catch (error) {
        mutationFailure(relativeCurrent, 'inspect created directory', error);
      }
      if (stat.isSymbolicLink()) {
        throw workspaceFailure('SYMLINK_COMPONENT', `Path component '${relativeCurrent}' became a symlink.`, 'Remove it and retry.', { path: relativeCurrent });
      }
      if (!stat.isDirectory()) {
        throw workspaceFailure('NOT_REGULAR_FILE', `Path component '${relativeCurrent}' is not a directory.`, 'Remove the conflicting entry before retrying.', { path: relativeCurrent });
      }
      if (!made) {
        assertDirectoryBinding(parent);
        return { stat, created: false };
      }

      const createdIdentity = stat;
      const rollbackCreated = (originalError: unknown): never => {
        try {
          const current = mutationFs.lstatSync(component);
          if (
            current.isSymbolicLink()
            || !current.isDirectory()
            || current.dev !== createdIdentity.dev
            || current.ino !== createdIdentity.ino
          ) {
            throw new Error('created directory identity changed before rollback');
          }
          mutationFs.rmdirSync(component);
          syncWorkspaceDirectory('.', durabilityFs);
        } catch (rollbackError) {
          let retainedName: string | undefined;
          try {
            retainedName = findAnchoredEntryName(createdIdentity.dev, createdIdentity.ino, 'directory');
          } catch {
            // The stable identity below remains sufficient for manual inode-level recovery.
          }
          const quarantinePath = retainedName === undefined
            ? undefined
            : (parent.relative === '.' ? retainedName : posix.join(parent.relative, retainedName));
          throw workspaceFailure(
            'WRITE_CONFLICT',
            `Directory creation state for '${relativeCurrent}' is uncertain after rollback failure.`,
            `Inspect '${relativeCurrent}' and remove only the empty directory created by this command before retrying.`,
            {
              path: relativeCurrent,
              canonicalPath: relativeCurrent,
              ...(quarantinePath === undefined ? {} : { quarantinePath }),
              createdDev: createdIdentity.dev,
              createdIno: createdIdentity.ino,
              cause: errno(rollbackError).code ?? 'unknown',
              state: 'unknown',
            },
          );
        }
        throw originalError;
      };

      try {
        syncWorkspaceDirectory('.', durabilityFs);
        options.afterMutation?.(relativeCurrent);
        assertDirectoryBinding(parent);
        const final = mutationStat(mutationFs, component, relativeCurrent, 'verify created directory');
        if (
          final.isSymbolicLink()
          || !final.isDirectory()
          || final.dev !== createdIdentity.dev
          || final.ino !== createdIdentity.ino
        ) {
          throw workspaceFailure(
            'WRITE_CONFLICT',
            `Directory '${relativeCurrent}' was replaced after creation.`,
            'The replacement was preserved; reconcile it with the disclosed created-directory identity.',
            { path: relativeCurrent },
          );
        }
      } catch (error) {
        return rollbackCreated(error);
      }
      return { stat, created: true };
    });
    if (result.created) {
      created.push(relativeCurrent);
      creationTokens.push({ path: relativeCurrent, dev: result.stat.dev, ino: result.stat.ino });
    }
      parent = directoryIdentityFromStat(absolute, relativeCurrent, result.stat);
    }
  } catch (error) {
    removeEmptyWorkspaceDirectories(root, creationTokens);
    throw error;
  }
  return { created, creationTokens };
}

function readRegularWorkspaceFile(
  absolute: string,
  normalized: string,
  maxBytes: number,
  verifyParent: () => void,
  fs: WorkspaceReadFs,
): Buffer {
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW ?? 0)
    | (fsConstants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(absolute, flags);
  } catch (error) {
    const code = errno(error).code;
    if (code === 'ELOOP') {
      throw workspaceFailure('SYMLINK_COMPONENT', `File '${normalized}' is a symlink.`, 'Replace it with a regular workspace file.', { path: normalized });
    }
    if (isMissing(error)) {
      throw workspaceFailure('PARENT_NOT_FOUND', `File '${normalized}' does not exist.`, 'Scaffold or restore the registered record.', { path: normalized });
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENXIO' || code === 'ENODEV' || code === 'EOPNOTSUPP') {
      throw workspaceFailure('NOT_REGULAR_FILE', `File '${normalized}' is not a readable regular file.`, 'Restore regular-file permissions or replace the unsupported filesystem entry.', { path: normalized, cause: code ?? 'unknown' });
    }
    throw error;
  }
  try {
    const initial = fs.fstatSync(fd);
    if (!initial.isFile()) {
      throw workspaceFailure('NOT_REGULAR_FILE', `File '${normalized}' is not a regular file.`, 'Replace it with a bounded regular file.', { path: normalized });
    }
    if (initial.size > maxBytes) {
      throw workspaceFailure('READ_LIMIT_EXCEEDED', `File '${normalized}' exceeds the ${maxBytes}-byte read limit.`, 'Reduce the file size before retrying.', { path: normalized, maxBytes, size: initial.size });
    }
    const bytes = Buffer.alloc(initial.size);
    let total = 0;
    let requested = Math.min(maxBytes, initial.size);
    while (total < initial.size && requested > 0) {
      const count = fs.readSync(fd, bytes, total, requested, total);
      if (count === 0) break;
      total += count;
      requested = Math.min(initial.size - total, 64 * 1024);
    }
    if (total > maxBytes) {
      throw workspaceFailure('READ_LIMIT_EXCEEDED', `File '${normalized}' grew beyond the ${maxBytes}-byte read limit.`, 'Stop the concurrent writer and reduce the file size before retrying.', { path: normalized, maxBytes });
    }
    const final = fs.fstatSync(fd);
    if (!final.isFile()) {
      throw workspaceFailure('NOT_REGULAR_FILE', `File '${normalized}' changed type during read.`, 'Restore it as a regular file before retrying.', { path: normalized });
    }
    if (
      final.dev !== initial.dev
      || final.ino !== initial.ino
      || final.size !== initial.size
      || final.size !== total
      || final.mtimeMs !== initial.mtimeMs
      || final.ctimeMs !== initial.ctimeMs
    ) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed during the bounded read.`, 'Stop the concurrent writer and retry.', { path: normalized });
    }
    let leaf;
    try {
      leaf = fs.lstatSync(absolute);
    } catch (error) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed during the bounded read.`, 'Stop the concurrent writer and retry.', { path: normalized, cause: errno(error).code ?? 'unknown' });
    }
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.dev !== initial.dev || leaf.ino !== initial.ino) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' was replaced during the bounded read.`, 'Stop the concurrent writer and retry.', { path: normalized });
    }
    verifyParent();
    return total === bytes.byteLength ? bytes : bytes.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

function readAnchoredWorkspaceFile(
  parent: DirectoryIdentity,
  leaf: string,
  normalized: string,
  maxBytes: number,
  fs: WorkspaceReadFs = realWorkspaceReadFs,
): Buffer {
  return readRegularWorkspaceFile(
    leaf,
    normalized,
    maxBytes,
    () => assertCurrentDirectoryIdentity(parent),
    fs,
  );
}

export function readWorkspaceFile(
  root: string,
  relativePath: string,
  options: WorkspaceReadOptions = {},
): Buffer {
  const maxBytes = options.maxBytes ?? MAX_WORKSPACE_FILE_BYTES;
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const parentRelative = posix.dirname(normalized);
  const parent = directoryIdentity(assertSafeParent(root, normalized), parentRelative);
  const bytes = withAnchoredDirectory(parent, () => {
    options.beforeOpen?.();
    assertCurrentDirectoryIdentity(parent);
    return readAnchoredWorkspaceFile(
      parent,
      basename(normalized),
      normalized,
      maxBytes,
      options.fs ?? realWorkspaceReadFs,
    );
  });
  assertDirectoryIdentity(parent);
  return bytes;
}

export function createWorkspaceReadSession(
  root: string,
  sessionOptions: { deferParentChecks?: boolean } = {},
): WorkspaceReadSession {
  const absoluteRoot = assertRootDirectory(root);
  const directories = new Map<string, DirectoryIdentity>();
  const namespaceParents = new Set<string>();
  directories.set('.', directoryIdentity(absoluteRoot, '.'));

  const ensureDirectory = (relativeDirectory: string): DirectoryIdentity => {
    const normalized = relativeDirectory;
    const existing = directories.get(normalized);
    if (existing !== undefined) return existing;
    const parent = posix.dirname(normalized);
    const parentIdentity = ensureDirectory(parent);
    if (sessionOptions.deferParentChecks) namespaceParents.add(parent);
    else assertDirectoryIdentity(parentIdentity);
    const identity = directoryIdentity(
      resolve(absoluteRoot, ...normalized.split('/')),
      normalized,
      !sessionOptions.deferParentChecks,
    );
    directories.set(normalized, identity);
    return identity;
  };

  const assertCachedDirectoryChain = (relativeDirectory: string): void => {
    assertDirectoryIdentity(directories.get(relativeDirectory)!);
  };

  const sessionRead = (relativePath: string, readOptions: WorkspaceReadOptions = {}): Buffer => {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const parent = ensureDirectory(posix.dirname(normalized));
    if (!sessionOptions.deferParentChecks) {
      assertCachedDirectoryChain(parent.relative);
      const bytes = withAnchoredDirectory(parent, () => {
        readOptions.beforeOpen?.();
        assertCurrentDirectoryIdentity(parent);
        return readAnchoredWorkspaceFile(
          parent,
          basename(normalized),
          normalized,
          readOptions.maxBytes ?? MAX_WORKSPACE_FILE_BYTES,
          readOptions.fs ?? realWorkspaceReadFs,
        );
      });
      assertCachedDirectoryChain(parent.relative);
      return bytes;
    }
    readOptions.beforeOpen?.();
    const absolute = resolve(absoluteRoot, ...normalized.split('/'));
    return readRegularWorkspaceFile(
      absolute,
      normalized,
      readOptions.maxBytes ?? MAX_WORKSPACE_FILE_BYTES,
      () => assertCachedDirectoryChain(parent.relative),
      readOptions.fs ?? realWorkspaceReadFs,
    );
  };

  return {
    readFile: sessionRead,
    readText: (relativePath, options = {}) => sessionRead(relativePath, options).toString('utf8'),
    verify: () => {
      for (const relativeDirectory of namespaceParents) {
        assertDirectoryIdentity(directories.get(relativeDirectory)!);
      }
    },
  };
}

export function tryReadWorkspaceFile(
  root: string,
  relativePath: string,
  options: WorkspaceReadOptions = {},
): Buffer | null {
  try {
    return readWorkspaceFile(root, relativePath, options);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') return null;
    throw error;
  }
}

export function readWorkspaceText(
  root: string,
  relativePath: string,
  options: WorkspaceReadOptions = {},
): string {
  return readWorkspaceFile(root, relativePath, options).toString('utf8');
}

export function inspectWorkspaceEntry(
  root: string,
  relativePath: string,
  options: { beforeInspect?: () => void } = {},
): WorkspaceEntryKind {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const parent = directoryIdentity(assertSafeParent(root, normalized), posix.dirname(normalized));
  const kind = withAnchoredDirectory(parent, () => {
    options.beforeInspect?.();
    assertCurrentDirectoryIdentity(parent);
    assertDirectoryBinding(parent);
    let stat;
    try {
      stat = lstatSync(basename(normalized));
    } catch (error) {
      if (isMissing(error)) return 'absent' as const;
      throw error;
    }
    if (stat.isSymbolicLink()) return 'symlink' as const;
    if (stat.isFile()) return 'file' as const;
    if (stat.isDirectory()) return 'directory' as const;
    return 'other' as const;
  });
  assertDirectoryIdentity(parent);
  return kind;
}

export function publishCreateOnly(
  root: string,
  relativePath: string,
  content: Buffer | string,
  options: {
    durabilityFs?: WorkspaceDurabilityFs;
    mutationFs?: WorkspaceMutationFs;
    beforePublish?: () => void;
    afterMutation?: () => void;
    captureCreation?: (token: WorkspaceFileIdentityToken) => void;
  } = {},
): PublicationResult {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const parent = directoryIdentity(assertSafeParent(root, normalized), posix.dirname(normalized));
  const target = basename(normalized);
  const mutationFs = options.mutationFs ?? realWorkspaceMutationFs;
  const result = withAnchoredDirectory(parent, () => {
    const temporary = writeTemporary('.', target, bytes, mutationFs);
    const temporaryRelative = posix.join(posix.dirname(normalized), basename(temporary));
    let completed: PublicationResult | undefined;
    let targetCreated = false;
    let preserveTemporary = false;
    const rollbackCreatedTarget = (originalError: unknown): never => {
      try {
        const targetIdentity = mutationStat(mutationFs, target, normalized, 'inspect published target for rollback');
        const temporaryIdentity = mutationStat(mutationFs, temporary, temporaryRelative, 'inspect publication recovery file');
        const committed = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
        if (
          !committed.equals(bytes)
          || targetIdentity.dev !== temporaryIdentity.dev
          || targetIdentity.ino !== temporaryIdentity.ino
        ) throw new Error('published target no longer matches retained temporary inode');
        mutationFs.unlinkSync(target);
        targetCreated = false;
        syncWorkspaceDirectory('.', options.durabilityFs ?? realWorkspaceDurabilityFs);
      } catch (rollbackError) {
        preserveTemporary = true;
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `Publication state for '${normalized}' is uncertain; exact recovery bytes were preserved.`,
          `Inspect '${normalized}' and '${temporaryRelative}' before retrying.`,
          {
            path: normalized,
            canonicalPath: normalized,
            quarantinePath: temporaryRelative,
            expectedHash: hashWorkspaceBytes(bytes),
            cause: errno(rollbackError).code ?? 'unknown',
            state: 'unknown',
          },
        );
      }
      throw originalError;
    };
    try {
      options.beforePublish?.();
      assertCurrentDirectoryIdentity(parent);
      assertDirectoryBinding(parent);
      try {
        mutationFs.linkSync(temporary, target);
        targetCreated = true;
      } catch (error) {
        if (errno(error).code === 'EEXIST') {
          const existing = readAnchoredWorkspaceFile(parent, target, normalized, MAX_WORKSPACE_FILE_BYTES);
          if (existing.equals(bytes)) {
            const adoptedIdentity = mutationStat(mutationFs, target, normalized, 'inspect adopted file');
            const durabilityFs = options.durabilityFs ?? realWorkspaceDurabilityFs;
            syncAnchoredWorkspaceFile(parent, target, normalized, adoptedIdentity, durabilityFs);
            syncWorkspaceDirectory('.', durabilityFs);
            const adopted = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
            const finalIdentity = mutationStat(mutationFs, target, normalized, 'verify adopted file');
            if (
              !adopted.equals(bytes)
              || finalIdentity.dev !== adoptedIdentity.dev
              || finalIdentity.ino !== adoptedIdentity.ino
            ) {
              throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed during adoption.`, 'Inspect the concurrent writer before retrying.', { path: normalized });
            }
            assertDirectoryBinding(parent);
            completed = 'adopted';
            return completed;
          }
          throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' already exists with different bytes.`, 'Preserve the existing file, choose another identity, or reconcile it explicitly.', { path: normalized, expectedHash: hashWorkspaceBytes(bytes), actualHash: hashWorkspaceBytes(existing) });
        }
        if (publicationUnsupported(errno(error))) {
          throw workspaceFailure('ATOMIC_PUBLICATION_UNSUPPORTED', `Filesystem cannot atomically create '${normalized}'.`, 'Move the workspace to a filesystem that supports same-directory hard links.', { path: normalized, cause: errno(error).code ?? 'unknown' });
        }
        mutationFailure(normalized, 'publish', error);
      }
      try {
        const durabilityFs = options.durabilityFs ?? realWorkspaceDurabilityFs;
        const linkedIdentity = mutationStat(mutationFs, target, normalized, 'inspect published file');
        syncAnchoredWorkspaceFile(parent, target, normalized, linkedIdentity, durabilityFs);
        syncWorkspaceDirectory('.', durabilityFs);
        const published = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
        if (!published.equals(bytes)) {
          throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed during publication.`, 'Inspect the concurrent writer before retrying.', { path: normalized });
        }
        options.afterMutation?.();
        assertDirectoryBinding(parent);
        const finalIdentity = mutationStat(mutationFs, target, normalized, 'verify published file');
        const temporaryIdentity = mutationStat(mutationFs, temporary, temporaryRelative, 'verify publication recovery file');
        const finalBytes = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
        if (
          finalIdentity.isSymbolicLink()
          || !finalIdentity.isFile()
          || finalIdentity.dev !== temporaryIdentity.dev
          || finalIdentity.ino !== temporaryIdentity.ino
          || !finalBytes.equals(bytes)
        ) {
          throw workspaceFailure(
            'WRITE_CONFLICT',
            `File '${normalized}' was replaced after publication.`,
            'The replacement was preserved; reconcile it with the disclosed recovery bytes.',
            { path: normalized },
          );
        }
        options.captureCreation?.({
          dev: finalIdentity.dev,
          ino: finalIdentity.ino,
          hash: hashWorkspaceBytes(bytes),
        });
      } catch (error) {
        return rollbackCreatedTarget(error);
      }
      completed = 'created';
      return completed;
    } finally {
      if (!preserveTemporary) {
        let temporaryGone = false;
        try {
          mutationFs.unlinkSync(temporary);
          temporaryGone = true;
          targetCreated = false;
        } catch (error) {
          if (isMissing(error)) {
            temporaryGone = true;
          } else {
            if (targetCreated && completed === 'created') {
              return rollbackCreatedTarget(workspaceFailure(
                'FILESYSTEM_WRITE_FAILED',
                `Filesystem could not remove publication temporary file '${temporaryRelative}'.`,
                'Check directory permissions and retry after confirming the canonical target is absent.',
                { path: normalized, temporaryPath: temporaryRelative, cause: errno(error).code ?? 'unknown' },
              ));
            }
            mutationFailure(temporaryRelative, 'remove publication temporary file', error);
          }
        }
        if (temporaryGone) {
          try {
            syncWorkspaceDirectory('.', options.durabilityFs ?? realWorkspaceDurabilityFs);
          } catch (error) {
            throw workspaceFailure(
              'WRITE_CONFLICT',
              `Publication cleanup durability for '${normalized}' is uncertain.`,
              `Inspect '${normalized}' and '${temporaryRelative}' before retrying; preserve canonical bytes.`,
              {
                path: normalized,
                canonicalPath: normalized,
                temporaryPath: temporaryRelative,
                expectedHash: hashWorkspaceBytes(bytes),
                state: completed === undefined
                  ? 'publication-failed-temp-cleanup-unknown'
                  : `${completed}-temp-cleanup-unknown`,
                cause: isWorkspaceFailure(error) ? error.code : (errno(error).code ?? 'unknown'),
              },
            );
          }
        }
      }
    }
  });
  return result;
}

export function replaceWorkspaceFile(
  root: string,
  relativePath: string,
  content: Buffer | string,
  options: {
    expectedHash: string;
    durabilityFs?: WorkspaceDurabilityFs;
    mutationFs?: WorkspaceMutationFs;
    beforePublish?: () => void;
    afterMutation?: () => void;
  },
): void {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const parent = directoryIdentity(assertSafeParent(root, normalized), posix.dirname(normalized));
  const target = basename(normalized);
  const mutationFs = options.mutationFs ?? realWorkspaceMutationFs;
  withAnchoredDirectory(parent, () => {
    const before = readAnchoredWorkspaceFile(parent, target, normalized, MAX_WORKSPACE_FILE_BYTES);
    if (hashWorkspaceBytes(before) !== options.expectedHash) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed before update.`, 'Re-read the parent registry and retry the requested mutation.', { path: normalized, expectedHash: options.expectedHash, actualHash: hashWorkspaceBytes(before) });
    }
    const temporary = writeTemporary('.', target, bytes, mutationFs);
    const temporaryIdentity = mutationStat(mutationFs, temporary, normalized, 'inspect replacement temporary file');
    const rollback = temporaryPath('.', `${target}.rollback`);
    const rollbackRelative = posix.join(posix.dirname(normalized), basename(rollback));
    let rollbackAvailable = false;
    let replacementCommitted = false;
    let preserveRollback = false;
    const rollbackReplacement = (originalError: unknown): never => {
      const recovery = temporaryPath('.', `${target}.recovery`);
      const recoveryRelative = posix.join(posix.dirname(normalized), basename(recovery));
      let recoveryAvailable = false;
      try {
        if (!rollbackAvailable) throw new Error('rollback bytes are unavailable');
        const current = mutationStat(mutationFs, target, normalized, 'inspect replacement target for rollback');
        const currentBytes = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
        if (
          current.isSymbolicLink()
          || !current.isFile()
          || current.dev !== temporaryIdentity.dev
          || current.ino !== temporaryIdentity.ino
          || !currentBytes.equals(bytes)
        ) throw new Error('published target was replaced before rollback');
        mutationFs.linkSync(rollback, recovery);
        recoveryAvailable = true;
        mutationFs.renameSync(rollback, target);
        rollbackAvailable = false;
        replacementCommitted = false;
        syncWorkspaceDirectory('.', options.durabilityFs ?? realWorkspaceDurabilityFs);
        const restored = readAnchoredWorkspaceFile(parent, target, normalized, MAX_WORKSPACE_FILE_BYTES);
        if (!restored.equals(before)) throw new Error('restored bytes do not match original');
      } catch (rollbackError) {
        preserveRollback = rollbackAvailable;
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `Replacement state for '${normalized}' is uncertain; exact prior bytes were preserved.`,
          `Inspect '${normalized}' and the disclosed recovery file before retrying.`,
          {
            path: normalized,
            canonicalPath: normalized,
            quarantinePath: recoveryAvailable ? recoveryRelative : rollbackRelative,
            priorHash: hashWorkspaceBytes(before),
            expectedHash: hashWorkspaceBytes(bytes),
            cause: errno(rollbackError).code ?? 'unknown',
            state: 'unknown',
          },
        );
      }
      try {
        mutationFs.unlinkSync(recovery);
        syncWorkspaceDirectory('.', options.durabilityFs ?? realWorkspaceDurabilityFs);
      } catch {
        // The canonical prior bytes were already durably restored; a hidden recovery copy is harmless.
      }
      throw originalError;
    };
    try {
      const rechecked = readAnchoredWorkspaceFile(parent, target, normalized, MAX_WORKSPACE_FILE_BYTES);
      if (hashWorkspaceBytes(rechecked) !== options.expectedHash) {
        throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed during update.`, 'Re-read the parent registry and retry the requested mutation.', { path: normalized, expectedHash: options.expectedHash, actualHash: hashWorkspaceBytes(rechecked) });
      }
      const expectedIdentity = mutationStat(mutationFs, target, normalized, 'inspect replacement source');
      if (expectedIdentity.isSymbolicLink() || !expectedIdentity.isFile()) {
        throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' changed type during update.`, 'Restore the regular parent registry and retry.', { path: normalized });
      }
      options.beforePublish?.();
      assertCurrentDirectoryIdentity(parent);
      assertDirectoryBinding(parent);
      const publishIdentity = mutationStat(mutationFs, target, normalized, 'recheck replacement source');
      if (
        publishIdentity.isSymbolicLink()
        || !publishIdentity.isFile()
        || publishIdentity.dev !== expectedIdentity.dev
        || publishIdentity.ino !== expectedIdentity.ino
        || publishIdentity.size !== expectedIdentity.size
        || publishIdentity.mtimeMs !== expectedIdentity.mtimeMs
        || publishIdentity.ctimeMs !== expectedIdentity.ctimeMs
      ) {
        throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' was replaced before publication.`, 'Preserve the concurrent bytes, re-read the parent registry, and retry.', { path: normalized });
      }
      try {
        mutationFs.linkSync(target, rollback);
        rollbackAvailable = true;
      } catch (error) {
        if (publicationUnsupported(errno(error))) {
          throw workspaceFailure('ATOMIC_PUBLICATION_UNSUPPORTED', `Filesystem cannot retain rollback bytes for '${normalized}'.`, 'Move the workspace to a filesystem that supports same-directory hard links.', { path: normalized, cause: errno(error).code ?? 'unknown' });
        }
        mutationFailure(normalized, 'retain rollback bytes for', error);
      }
      const rollbackBytes = readAnchoredWorkspaceFile(parent, rollback, normalized, MAX_WORKSPACE_FILE_BYTES);
      const rollbackIdentity = mutationStat(mutationFs, rollback, rollbackRelative, 'inspect replacement rollback file');
      if (
        !rollbackBytes.equals(before)
        || rollbackIdentity.dev !== expectedIdentity.dev
        || rollbackIdentity.ino !== expectedIdentity.ino
      ) {
        throw workspaceFailure('WRITE_CONFLICT', `Rollback bytes for '${normalized}' changed before publication.`, 'Stop the concurrent writer and retry from a fresh registry read.', { path: normalized });
      }
      try {
        mutationFs.renameSync(temporary, target);
        replacementCommitted = true;
      } catch (error) {
        mutationFailure(normalized, 'atomically replace', error);
      }
      try {
        const durabilityFs = options.durabilityFs ?? realWorkspaceDurabilityFs;
        syncAnchoredWorkspaceFile(parent, target, normalized, temporaryIdentity, durabilityFs);
        syncWorkspaceDirectory('.', durabilityFs);
        const published = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
        if (!published.equals(bytes)) {
          throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' did not persist expected bytes.`, 'Inspect filesystem durability and retry from a clean registry read.', { path: normalized });
        }
        options.afterMutation?.();
        assertDirectoryBinding(parent);
        const finalIdentity = mutationStat(mutationFs, target, normalized, 'verify replaced file');
        const finalBytes = readAnchoredWorkspaceFile(parent, target, normalized, Math.max(bytes.byteLength, 1));
        if (
          finalIdentity.isSymbolicLink()
          || !finalIdentity.isFile()
          || finalIdentity.dev !== temporaryIdentity.dev
          || finalIdentity.ino !== temporaryIdentity.ino
          || !finalBytes.equals(bytes)
        ) {
          throw workspaceFailure(
            'WRITE_CONFLICT',
            `File '${normalized}' was replaced after update.`,
            'The replacement was preserved; reconcile it with the disclosed prior-byte recovery file.',
            { path: normalized },
          );
        }
      } catch (error) {
        return rollbackReplacement(error);
      }
      try {
        mutationFs.unlinkSync(rollback);
        rollbackAvailable = false;
        syncWorkspaceDirectory('.', options.durabilityFs ?? realWorkspaceDurabilityFs);
      } catch {
        // Canonical replacement was already durably verified; rollback cleanup is non-semantic.
      }
    } finally {
      try {
        mutationFs.unlinkSync(temporary);
      } catch {
        // A unique non-canonical temporary file is safe to leave for explicit cleanup.
      }
      if (rollbackAvailable && !replacementCommitted && !preserveRollback) {
        try {
          mutationFs.unlinkSync(rollback);
        } catch {
          // The authored target is unchanged; a hidden hard-link is non-semantic.
        }
      }
    }
  });
}

type WorkspaceRemovalOptions = {
  durabilityFs?: WorkspaceDurabilityFs;
  mutationFs?: WorkspaceMutationFs;
  expectedIdentity?: WorkspaceFileIdentityToken;
  beforeQuarantine?: () => void;
  afterMutation?: () => void;
};

function removeWorkspaceFile(
  root: string,
  relativePath: string,
  expectedHash: string,
  options: WorkspaceRemovalOptions = {},
): boolean {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const parent = directoryIdentity(assertSafeParent(root, normalized), posix.dirname(normalized));
  const target = basename(normalized);
  const mutationFs = options.mutationFs ?? realWorkspaceMutationFs;
  const durabilityFs = options.durabilityFs ?? realWorkspaceDurabilityFs;
  const removed = withAnchoredDirectory(parent, () => {
    let identity;
    try {
      identity = mutationFs.lstatSync(target);
    } catch (error) {
      if (isMissing(error)) return false;
      mutationFailure(normalized, 'inspect file for removal', error);
    }
    if (identity.isSymbolicLink() || !identity.isFile()) return false;
    const existing = readAnchoredWorkspaceFile(parent, target, normalized, MAX_WORKSPACE_FILE_BYTES);
    if (hashWorkspaceBytes(existing) !== expectedHash) return false;
    if (
      options.expectedIdentity !== undefined
      && (
        identity.dev !== options.expectedIdentity.dev
        || identity.ino !== options.expectedIdentity.ino
        || expectedHash !== options.expectedIdentity.hash
      )
    ) return false;
    options.beforeQuarantine?.();
    assertCurrentDirectoryIdentity(parent);
    assertDirectoryBinding(parent);
    const finalIdentity = mutationStat(mutationFs, target, normalized, 'recheck file for removal');
    if (
      finalIdentity.isSymbolicLink()
      || !finalIdentity.isFile()
      || finalIdentity.dev !== identity.dev
      || finalIdentity.ino !== identity.ino
      || finalIdentity.size !== identity.size
      || finalIdentity.mtimeMs !== identity.mtimeMs
      || finalIdentity.ctimeMs !== identity.ctimeMs
    ) {
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' was replaced before rollback.`, 'The concurrent replacement was preserved; retry after its writer finishes.', { path: normalized });
    }
    const quarantine = temporaryPath('.', target);
    const quarantineRelative = posix.join(posix.dirname(normalized), basename(quarantine));
    try {
      mutationFs.renameSync(target, quarantine);
    } catch (error) {
      mutationFailure(normalized, 'quarantine file for removal', error);
    }
    const restoreQuarantine = (originalError?: unknown): never => {
      try {
        mutationFs.linkSync(quarantine, target);
        syncWorkspaceDirectory('.', durabilityFs);
        const restored = readAnchoredWorkspaceFile(parent, target, normalized, MAX_WORKSPACE_FILE_BYTES);
        if (hashWorkspaceBytes(restored) !== expectedHash) throw new Error('restored bytes do not match expected hash');
        try {
          mutationFs.unlinkSync(quarantine);
          syncWorkspaceDirectory('.', durabilityFs);
        } catch {
          // The canonical target was already durably restored while quarantine remained linked.
        }
      } catch (error) {
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `Removal state for '${normalized}' is uncertain; exact bytes were preserved.`,
          `Inspect '${normalized}' and '${quarantineRelative}' before retrying.`,
          {
            path: normalized,
            canonicalPath: normalized,
            quarantinePath: quarantineRelative,
            priorHash: expectedHash,
            cause: errno(error).code ?? 'unknown',
            state: 'unknown',
          },
        );
      }
      if (originalError !== undefined) throw originalError;
      throw workspaceFailure('WRITE_CONFLICT', `File '${normalized}' was replaced during rollback.`, 'The replacement was restored; retry after the concurrent writer finishes.', { path: normalized });
    };
    try {
      syncWorkspaceDirectory('.', durabilityFs);
    } catch (error) {
      return restoreQuarantine(error);
    }
    let quarantined: Buffer;
    let quarantinedIdentity;
    try {
      quarantined = readAnchoredWorkspaceFile(parent, quarantine, quarantineRelative, MAX_WORKSPACE_FILE_BYTES);
      quarantinedIdentity = mutationStat(mutationFs, quarantine, quarantineRelative, 'inspect removal quarantine');
    } catch {
      return restoreQuarantine();
    }
    if (
      hashWorkspaceBytes(quarantined) !== expectedHash
      || quarantinedIdentity.dev !== identity.dev
      || quarantinedIdentity.ino !== identity.ino
    ) return restoreQuarantine();
    try {
      options.afterMutation?.();
      assertDirectoryBinding(parent);
      try {
        mutationFs.lstatSync(target);
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `File '${normalized}' was recreated during removal.`,
          `The concurrent target and '${quarantineRelative}' were preserved for reconciliation.`,
          { path: normalized, canonicalPath: normalized, quarantinePath: quarantineRelative },
        );
      } catch (error) {
        if (!isMissing(error)) {
          if (isWorkspaceFailure(error)) throw error;
          mutationFailure(normalized, 'verify removed canonical path', error);
        }
      }
    } catch (bindingError) {
      return restoreQuarantine(bindingError);
    }
    try {
      mutationFs.unlinkSync(quarantine);
    } catch (error) {
      if (!isMissing(error)) {
        throw workspaceFailure(
          'FILESYSTEM_WRITE_FAILED',
          `File '${normalized}' was deleted, but its exact quarantine could not be cleaned up.`,
          `Inspect and remove '${quarantineRelative}' after confirming '${normalized}' should remain absent.`,
          {
            path: normalized,
            canonicalPath: normalized,
            quarantinePath: quarantineRelative,
            priorHash: expectedHash,
            cause: errno(error).code ?? 'unknown',
            state: 'deleted-with-quarantine',
          },
        );
      }
    }
    try {
      syncWorkspaceDirectory('.', durabilityFs);
    } catch {
      // Canonical deletion was already durable; quarantine cleanup durability is non-semantic.
    }
    return true;
  });
  return removed;
}

export function removeManagedWorkspaceFileIfHash(
  root: string,
  relativePath: string,
  expectedHash: string,
  options: Omit<WorkspaceRemovalOptions, 'expectedIdentity'> = {},
): boolean {
  return removeWorkspaceFile(root, relativePath, expectedHash, options);
}

export function removePublishedWorkspaceFile(
  root: string,
  relativePath: string,
  identity: WorkspaceFileIdentityToken,
  options: Omit<WorkspaceRemovalOptions, 'expectedIdentity'> = {},
): boolean {
  return removeWorkspaceFile(root, relativePath, identity.hash, {
    ...options,
    expectedIdentity: identity,
  });
}

export function removeEmptyWorkspaceDirectories(
  root: string,
  directories: readonly WorkspaceDirectoryIdentityToken[],
  options: { beforeRemove?: (relativePath: string) => void } = {},
): void {
  const sorted = [...directories].sort((a, b) => b.path.split('/').length - a.path.split('/').length);
  for (const token of sorted) {
    const relativeDirectory = normalizeWorkspaceRelativePath(token.path);
    const parentRelative = posix.dirname(relativeDirectory);
    try {
      const parent = directoryIdentity(
        assertExistingDirectoryChain(root, parentRelative),
        parentRelative,
      );
      withAnchoredDirectory(parent, () => {
        options.beforeRemove?.(relativeDirectory);
        assertCurrentDirectoryIdentity(parent);
        assertDirectoryBinding(parent);
        const leaf = basename(relativeDirectory);
        let stat;
        try {
          stat = lstatSync(leaf);
        } catch (error) {
          if (isMissing(error)) {
            const retained = findAnchoredEntryName(token.dev, token.ino, 'directory');
            if (retained !== undefined) {
              const quarantinePath = parent.relative === '.'
                ? retained
                : posix.join(parent.relative, retained);
              throw workspaceFailure(
                'WRITE_CONFLICT',
                `Created directory '${relativeDirectory}' moved before cleanup.`,
                `Inspect '${quarantinePath}' and remove it only after confirming its inode matches the disclosed token.`,
                {
                  path: relativeDirectory,
                  canonicalPath: relativeDirectory,
                  quarantinePath,
                  createdDev: token.dev,
                  createdIno: token.ino,
                },
              );
            }
            return;
          }
          throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== token.dev || stat.ino !== token.ino) {
          const retained = findAnchoredEntryName(token.dev, token.ino, 'directory');
          const quarantinePath = retained === undefined
            ? undefined
            : (parent.relative === '.' ? retained : posix.join(parent.relative, retained));
          throw workspaceFailure(
            'WRITE_CONFLICT',
            `Created directory '${relativeDirectory}' was replaced before cleanup.`,
            'The replacement was preserved; inspect the disclosed created-directory identity before retrying.',
            {
              path: relativeDirectory,
              canonicalPath: relativeDirectory,
              ...(quarantinePath === undefined ? {} : { quarantinePath }),
              createdDev: token.dev,
              createdIno: token.ino,
            },
          );
        }
        rmdirSync(leaf);
        syncWorkspaceDirectory('.');
      });
    } catch (error) {
      if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') continue;
      const code = errno(error).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `Created directory '${relativeDirectory}' is no longer empty during cleanup.`,
          'The directory was preserved; inspect its contents and creation token before retrying.',
          { path: relativeDirectory, createdDev: token.dev, createdIno: token.ino },
        );
      }
      if (
        code !== 'ENOENT'
        && code !== 'ENOTDIR'
      ) throw error;
    }
  }
}

export function ensureRosterStateRoot(root: string): WorkspaceDirectoryResult {
  const roster = ensureWorkspaceDirectory(root, '.roster');
  publishCreateOnly(root, '.roster/.gitignore', ROSTER_STATE_GITIGNORE);
  const state = ensureWorkspaceDirectory(root, '.roster/state');
  return {
    created: [...roster.created, ...state.created],
    creationTokens: [...roster.creationTokens, ...state.creationTokens],
  };
}

type LockOwner = {
  pid: number;
  process_start_time: string;
  host: string;
};

function readLockOwner(root: string): Partial<LockOwner> {
  try {
    const text = readWorkspaceText(root, '.roster/state/locks/scaffold/owner.json', { maxBytes: 4096 });
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
      ...(typeof record.process_start_time === 'string' ? { process_start_time: record.process_start_time } : {}),
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
    };
  } catch {
    return {};
  }
}

export function withWorkspaceLock<T>(root: string, operation: () => T): T {
  ensureRosterStateRoot(root);
  ensureWorkspaceDirectory(root, '.roster/state/locks');
  const lockRelative = '.roster/state/locks/scaffold';
  const locksRelative = posix.dirname(lockRelative);
  const locksParent = directoryIdentity(
    assertExistingDirectoryChain(root, locksRelative),
    locksRelative,
  );
  const owner: LockOwner = {
    pid: process.pid,
    process_start_time: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    host: hostname(),
  };
  const ownerBytes = `${JSON.stringify(owner)}\n`;
  return withAnchoredDirectory(locksParent, () => {
    const lockName = basename(lockRelative);
    assertCurrentDirectoryIdentity(locksParent);
    assertDirectoryBinding(locksParent);
    try {
      mkdirSync(lockName, { mode: 0o700 });
    } catch (error) {
      if (errno(error).code !== 'EEXIST') mutationFailure(lockRelative, 'acquire workspace lock', error);
      const existingOwner = readLockOwner(root);
      throw workspaceFailure(
        'WORKSPACE_BUSY',
        `Workspace mutation lock '${lockRelative}' is already held.`,
        `Wait for the local writer. Remove '${lockRelative}' manually only after confirming that PID is no longer a live writer.`,
        {
          lockPath: lockRelative,
          ...(existingOwner.pid === undefined ? {} : { pid: existingOwner.pid }),
          ...(existingOwner.process_start_time === undefined ? {} : { processStartTime: existingOwner.process_start_time }),
          ...(existingOwner.host === undefined ? {} : { host: existingOwner.host }),
        },
      );
    }
    const lockStat = lstatSync(lockName);
    const lockIdentity = directoryIdentityFromStat(
      resolve(locksParent.absolute, lockName),
      lockRelative,
      lockStat,
    );
    const removeAcquiredLock = (): void => {
      let match: string | undefined;
      const handle = opendirSync('.');
      try {
        let inspected = 0;
        for (;;) {
          const entry = handle.readSync();
          if (entry === null || inspected === MAX_SLOT_ENTRIES) break;
          inspected++;
          let stat;
          try {
            stat = lstatSync(entry.name);
          } catch (error) {
            if (isMissing(error)) continue;
            throw error;
          }
          if (
            !stat.isSymbolicLink()
            && stat.isDirectory()
            && stat.dev === lockIdentity.dev
            && stat.ino === lockIdentity.ino
          ) {
            match = entry.name;
            break;
          }
        }
      } finally {
        handle.closeSync();
      }
      if (match === undefined) return;
      const final = lstatSync(match);
      if (
        final.isSymbolicLink()
        || !final.isDirectory()
        || final.dev !== lockIdentity.dev
        || final.ino !== lockIdentity.ino
      ) return;
      rmdirSync(match);
      syncWorkspaceDirectory('.');
    };

    try {
      syncWorkspaceDirectory('.');
      assertDirectoryBinding(locksParent);
    } catch (error) {
      try {
        removeAcquiredLock();
      } catch (rollbackError) {
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `Workspace lock state at '${lockRelative}' is uncertain after acquisition failure.`,
          `Inspect the exact lock directory before retrying.`,
          { path: lockRelative, cause: errno(rollbackError).code ?? 'unknown' },
        );
      }
      throw error;
    }

    let ownerIdentity: WorkspaceFileIdentityToken | undefined;
    try {
      const publication = publishCreateOnly(root, `${lockRelative}/owner.json`, ownerBytes, {
        captureCreation(token) {
          ownerIdentity = token;
        },
      });
      if (publication !== 'created' || ownerIdentity === undefined) {
        throw workspaceFailure('WRITE_CONFLICT', `Lock owner at '${lockRelative}/owner.json' was not exclusively created.`, 'Remove the untrusted lock only after confirming no writer is active.', { path: `${lockRelative}/owner.json` });
      }
    } catch (error) {
      try {
        removeAcquiredLock();
      } catch {
        // Preserve the exact acquired lock when cleanup cannot be proven safe.
      }
      throw error;
    }

    process.chdir(lockName);
    assertCurrentDirectoryIdentity(lockIdentity);
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = operation();
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      assertCurrentDirectoryIdentity(lockIdentity);
      const currentOwner = lstatSync('owner.json');
      if (
        currentOwner.isSymbolicLink()
        || !currentOwner.isFile()
        || currentOwner.dev !== ownerIdentity.dev
        || currentOwner.ino !== ownerIdentity.ino
      ) {
        throw workspaceFailure(
          'WRITE_CONFLICT',
          `Lock owner at '${lockRelative}/owner.json' was replaced during the operation.`,
          'The replacement was preserved; inspect the lock before retrying.',
          { path: `${lockRelative}/owner.json` },
        );
      }
      const currentBytes = readRegularWorkspaceFile(
        'owner.json',
        `${lockRelative}/owner.json`,
        4096,
        () => assertCurrentDirectoryIdentity(lockIdentity),
        realWorkspaceReadFs,
      );
      if (!currentBytes.equals(Buffer.from(ownerBytes))) {
        throw workspaceFailure('WRITE_CONFLICT', `Lock owner at '${lockRelative}/owner.json' changed during the operation.`, 'The changed owner was preserved for inspection.', { path: `${lockRelative}/owner.json` });
      }
      unlinkSync('owner.json');
      syncWorkspaceDirectory('.');
    } catch (error) {
      cleanupError = error;
    }

    try {
      process.chdir('..');
      assertCurrentDirectoryIdentity(locksParent);
      if (cleanupError === undefined) removeAcquiredLock();
    } catch (error) {
      cleanupError ??= error;
    }

    let bindingError: unknown;
    try {
      assertDirectoryBinding(locksParent);
    } catch (error) {
      bindingError = error;
    }
    if (cleanupError !== undefined || bindingError !== undefined) {
      let recoveryLockPath: string | undefined;
      try {
        assertCurrentDirectoryIdentity(locksParent);
        const retained = findAnchoredEntryName(lockIdentity.dev, lockIdentity.ino, 'directory');
        if (retained !== undefined) recoveryLockPath = posix.join(locksRelative, retained);
      } catch {
        // The exact inode token remains in the diagnostic when no path can be recovered safely.
      }
      const cleanup = errorDetails(cleanupError ?? bindingError);
      const original = operationError === undefined ? undefined : errorDetails(operationError);
      throw workspaceFailure(
        'WORKSPACE_BUSY',
        `Workspace operation finished without a clean release of lock '${lockRelative}'.`,
        `Inspect the disclosed lock identity and recovery path before removing any lock or retrying.`,
        {
          path: lockRelative,
          lockPath: lockRelative,
          ...(recoveryLockPath === undefined ? {} : { recoveryLockPath }),
          lockDev: lockIdentity.dev,
          lockIno: lockIdentity.ino,
          cleanupCode: cleanup.code,
          cleanupMessage: cleanup.message,
          ...(original === undefined ? {} : {
            operationCode: original.code,
            operationMessage: original.message,
          }),
        },
      );
    }
    if (operationError !== undefined) throw operationError;
    return result as T;
  });
}

export type WorkspaceDirectoryInspectionEntry = {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  dev: number;
  ino: number;
};

export type WorkspaceDirectoryInspection = {
  entries: WorkspaceDirectoryInspectionEntry[];
  truncated: boolean;
};

export function inspectWorkspaceDirectory(
  root: string,
  relativeDirectory: string,
  options: { maxEntries?: number; beforeOpen?: () => void } = {},
): WorkspaceDirectoryInspection {
  const maxEntries = options.maxEntries ?? MAX_SLOT_ENTRIES;
  const normalized = relativeDirectory === '.' ? '.' : normalizeWorkspaceRelativePath(relativeDirectory);
  let directory: string;
  try {
    directory = normalized === '.'
      ? assertRootDirectory(root)
      : assertExistingDirectoryChain(root, normalized);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') {
      return { entries: [], truncated: false };
    }
    throw error;
  }
  const identity = directoryIdentity(directory, normalized);
  const result = withAnchoredDirectory(identity, () => {
    options.beforeOpen?.();
    assertCurrentDirectoryIdentity(identity);
    assertDirectoryBinding(identity);
    const names: string[] = [];
    let truncated = false;
    const handle = opendirSync('.');
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (names.length === maxEntries) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    const entries: WorkspaceDirectoryInspectionEntry[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, 'en'))) {
      let stat;
      try {
        stat = lstatSync(name);
      } catch (error) {
        throw workspaceFailure('WRITE_CONFLICT', `Slot entry '${posix.join(normalized, name)}' changed during enumeration.`, 'Stop the concurrent writer and retry.', { path: posix.join(normalized, name), cause: errno(error).code ?? 'unknown' });
      }
      if (stat.isSymbolicLink()) {
        entries.push({ name, kind: 'symlink', dev: stat.dev, ino: stat.ino });
      } else if (stat.isDirectory()) {
        entries.push({ name, kind: 'directory', dev: stat.dev, ino: stat.ino });
      } else if (stat.isFile()) {
        entries.push({ name, kind: 'file', dev: stat.dev, ino: stat.ino });
      } else {
        entries.push({ name, kind: 'other', dev: stat.dev, ino: stat.ino });
      }
    }
    assertCurrentDirectoryIdentity(identity);
    return { entries, truncated };
  });
  assertDirectoryIdentity(identity);
  return result;
}

export function enumerateWorkspaceSlot(
  root: string,
  relativeDirectory: string,
  options: { maxEntries?: number; beforeOpen?: () => void } = {},
): WorkspaceSlotEntry[] {
  const maxEntries = options.maxEntries ?? MAX_SLOT_ENTRIES;
  const normalized = normalizeWorkspaceRelativePath(relativeDirectory);
  const inspection = inspectWorkspaceDirectory(root, normalized, options);
  if (inspection.truncated) {
    throw workspaceFailure('READ_LIMIT_EXCEEDED', `Directory '${normalized}' exceeds the ${maxEntries}-entry inspection limit.`, 'Reduce unexpected slot entries before validating again.', { path: normalized, maxEntries, entries: maxEntries + 1 });
  }
  return inspection.entries.map((entry) => {
    const path = posix.join(normalized, entry.name);
    if (entry.kind === 'symlink') {
      throw workspaceFailure('SYMLINK_COMPONENT', `Slot entry '${path}' is a symlink.`, 'Replace it with an explicitly registered regular file or directory.', { path });
    }
    if (entry.kind === 'other') {
      throw workspaceFailure('NOT_REGULAR_FILE', `Slot entry '${path}' has an unsupported type.`, 'Remove the FIFO, socket, or device before retrying.', { path });
    }
    return { name: entry.name, kind: entry.kind };
  });
}
