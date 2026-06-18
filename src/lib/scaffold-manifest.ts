import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCAFFOLD_MANIFEST_VERSION = 1;

// Per-file baseline: the sha256 of the rendered template content roster last
// produced for `path` (relative to the workspace root). A workspace file is
// "pristine" iff its on-disk hash equals this; "edited" otherwise.
export type ScaffoldFileEntry = {
  path: string;
  sha256: string;
};

export type ScaffoldManifest = {
  version: number;
  rosterVersion: string;
  generatedAtUtc: string;
  files: ScaffoldFileEntry[];
};

// Lives at <workspace>/.roster/scaffold-manifest.json. `.roster/` is committed
// (not gitignored), so the baseline travels with the repo and teammates'
// `roster upgrade` runs agree on what's pristine.
export function scaffoldManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.roster', 'scaffold-manifest.json');
}

export function readScaffoldManifest(workspaceRoot: string): ScaffoldManifest | null {
  const path = scaffoldManifestPath(workspaceRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ScaffoldManifest;
    if (parsed.version !== SCAFFOLD_MANIFEST_VERSION || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeScaffoldManifest(workspaceRoot: string, manifest: ScaffoldManifest): void {
  const path = scaffoldManifestPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  const body = JSON.stringify(manifest, null, 2) + '\n';
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export function entryMapFromManifest(
  manifest: ScaffoldManifest | null,
): Map<string, ScaffoldFileEntry> {
  const map = new Map<string, ScaffoldFileEntry>();
  for (const e of manifest?.files ?? []) map.set(e.path, e);
  return map;
}
