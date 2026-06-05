import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MANIFEST_VERSION = 1;

export type ManifestFileEntry = {
  src: string;
  dest: string;
  srcSha256: string;
  copiedAtUtc: string;
};

export type Manifest = {
  version: number;
  sourceDir: string;
  sourceHash: string;
  migratedAt: string;
  files: ReadonlyArray<ManifestFileEntry>;
};

export function manifestPathFor(destWorkspace: string, sourceHash: string): string {
  return join(destWorkspace, '.roster', 'migration-manifests', `agent-team-${sourceHash}.json`);
}

export function sourceHashFor(sourceDir: string): string {
  // Stable hash from the absolute path; not security-critical, just collision-resistant
  // enough to differentiate concurrent migrations from different sources.
  return createHash('sha256').update(sourceDir).digest('hex').slice(0, 12);
}

export function fileSha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

export function safeFileSha256(filePath: string): string | null {
  try {
    return fileSha256(filePath);
  } catch {
    return null;
  }
}

export function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version !== MANIFEST_VERSION) return null;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeManifest(path: string, manifest: Manifest): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  const body = JSON.stringify(manifest, null, 2) + '\n';
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
}

export type FileDecision =
  | { kind: 'noop'; reason: 'already-migrated-and-unchanged' }
  | { kind: 'skip'; reason: 'user-hand-edited-destination'; destPath: string }
  | { kind: 'skip'; reason: 'source-changed-since-last-migration'; suggestForceResync: true }
  | { kind: 'write'; reason: 'new-or-resync' };

export function decideFileAction(args: {
  srcPath: string;
  destPath: string;
  srcSha: string;
  manifestEntry: ManifestFileEntry | undefined;
  forceResync: boolean;
}): FileDecision {
  const { srcPath: _srcPath, destPath, srcSha, manifestEntry, forceResync } = args;
  const destExists = existsSync(destPath);

  if (!destExists) return { kind: 'write', reason: 'new-or-resync' };

  // Destination exists. Check manifest.
  if (manifestEntry === undefined) {
    // We have a destination file but no record of having migrated it.
    // Treat as user hand-edit; do not clobber.
    return { kind: 'skip', reason: 'user-hand-edited-destination', destPath };
  }

  const destSha = safeFileSha256(destPath);
  const destUnchangedSinceMigration = destSha !== null && destSha === manifestEntry.srcSha256;
  const sourceUnchanged = srcSha === manifestEntry.srcSha256;

  if (sourceUnchanged && destUnchangedSinceMigration) {
    return { kind: 'noop', reason: 'already-migrated-and-unchanged' };
  }
  if (sourceUnchanged && !destUnchangedSinceMigration) {
    return { kind: 'skip', reason: 'user-hand-edited-destination', destPath };
  }
  // Source changed.
  if (forceResync) return { kind: 'write', reason: 'new-or-resync' };
  return { kind: 'skip', reason: 'source-changed-since-last-migration', suggestForceResync: true };
}

