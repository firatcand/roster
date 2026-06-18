import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ROSTER_ROOT, getPackageVersion } from './paths.ts';
import { detectWorkspace } from './install-scope.ts';
import { workspaceRequiredError, missingScaffoldError } from './errors.ts';
import { destNameFor, renderScaffoldFile } from './scaffold-render.ts';
import {
  SCAFFOLD_MANIFEST_VERSION,
  readScaffoldManifest,
  writeScaffoldManifest,
  entryMapFromManifest,
  type ScaffoldManifest,
  type ScaffoldFileEntry,
} from './scaffold-manifest.ts';

const PLACEHOLDER_VARS = { PROJECT_NAME: '{{PROJECT_NAME}}', DISPLAY_NAME: '{{DISPLAY_NAME}}' };

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// A scaffold source file paired with the workspace-relative path it renders to
// (the `.template` suffix stripped).
type ScaffoldEntry = { srcPath: string; destRel: string };

function collectScaffoldFiles(scaffoldSrc: string): ScaffoldEntry[] {
  const out: ScaffoldEntry[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const srcPath = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(srcPath, relDir ? join(relDir, ent.name) : ent.name);
      } else if (ent.isFile()) {
        const destName = destNameFor(ent.name);
        out.push({ srcPath, destRel: relDir ? join(relDir, destName) : destName });
      }
    }
  };
  walk(scaffoldSrc, '');
  return out;
}

function scaffoldSrcRoot(): string {
  const src = join(ROSTER_ROOT, 'templates', 'scaffold');
  if (!existsSync(src)) throw missingScaffoldError(src);
  return src;
}

// Read PROJECT_NAME / DISPLAY_NAME from the workspace's config/project.yaml so
// *.template files re-render identically to how init wrote them. Falls back to
// placeholders when the file is missing/unreadable (those files then look
// "changed" and degrade to a conflict — safe).
export function varsFromWorkspace(cwd: string): Record<string, string> {
  try {
    const y = parseYaml(readFileSync(join(cwd, 'config', 'project.yaml'), 'utf8')) as
      | { name?: unknown; display_name?: unknown }
      | null;
    const name = typeof y?.name === 'string' ? y.name : PLACEHOLDER_VARS.PROJECT_NAME;
    const display = typeof y?.display_name === 'string' ? y.display_name : PLACEHOLDER_VARS.DISPLAY_NAME;
    return { PROJECT_NAME: name, DISPLAY_NAME: display };
  } catch {
    return { ...PLACEHOLDER_VARS };
  }
}

// Build the baseline manifest from the current templates. Used by init (fresh
// scaffold) and as the post-upgrade manifest. Each entry hashes the rendered
// output — the exact bytes roster produces for that file.
export function buildScaffoldManifestFromTemplates(
  scaffoldSrc: string,
  vars: Record<string, string>,
): ScaffoldManifest {
  const files: ScaffoldFileEntry[] = collectScaffoldFiles(scaffoldSrc).map(({ srcPath, destRel }) => ({
    path: destRel,
    sha256: sha256(renderScaffoldFile(srcPath, basename(srcPath), vars)),
  }));
  return {
    version: SCAFFOLD_MANIFEST_VERSION,
    rosterVersion: getPackageVersion(),
    generatedAtUtc: new Date().toISOString(),
    files,
  };
}

export type UpgradeAction = 'create' | 'noop' | 'update' | 'conflict';

// disk state for a destination path.
type DiskState = { kind: 'absent' } | { kind: 'symlink' } | { kind: 'file'; sha: string };

function probeDest(destPath: string): DiskState {
  let st;
  try {
    st = lstatSync(destPath);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isSymbolicLink()) return { kind: 'symlink' };
  if (!st.isFile()) return { kind: 'symlink' }; // dir/other at a file path — treat as untouchable
  return { kind: 'file', sha: sha256(readFileSync(destPath, 'utf8')) };
}

export function decideUpgradeAction(args: {
  disk: DiskState;
  newSha: string;
  manifestEntry: ScaffoldFileEntry | undefined;
}): UpgradeAction {
  const { disk, newSha, manifestEntry } = args;
  if (disk.kind === 'absent') return 'create';
  if (disk.kind === 'symlink') return 'conflict'; // never write through a symlink; surfaced separately
  if (disk.sha === newSha) return 'noop'; // already current
  // disk differs from the new template.
  if (manifestEntry === undefined) return 'conflict'; // degraded: can't prove provenance → offer .new
  const templateChanged = newSha !== manifestEntry.sha256;
  if (!templateChanged) return 'noop'; // user edited, but there's no new template to deliver
  const userEdited = disk.sha !== manifestEntry.sha256;
  return userEdited ? 'conflict' : 'update'; // edited → .new; pristine → auto-update
}

export type UpgradeResult = {
  created: string[];
  updated: string[];
  conflicts: string[]; // wrote <path>.new (or would, under dry-run)
  unchanged: string[];
  symlinkSkipped: string[];
  droppedKept: string[]; // in old manifest, no longer a template file — left in place
  founderExampleChanged: boolean;
  hadManifest: boolean;
  dryRun: boolean;
};

const FOUNDER_EXAMPLE = 'founder-skills.yaml.example';

export function executeUpgrade(opts: { cwd: string; dryRun: boolean }): UpgradeResult {
  const { cwd, dryRun } = opts;
  if (!detectWorkspace(cwd)) throw workspaceRequiredError(cwd);

  const scaffoldSrc = scaffoldSrcRoot();
  const vars = varsFromWorkspace(cwd);
  const oldManifest = readScaffoldManifest(cwd);
  const entries = entryMapFromManifest(oldManifest);

  const result: UpgradeResult = {
    created: [],
    updated: [],
    conflicts: [],
    unchanged: [],
    symlinkSkipped: [],
    droppedKept: [],
    founderExampleChanged: false,
    hadManifest: oldManifest !== null,
    dryRun,
  };

  const realCwd = safeRealpath(cwd) ?? cwd;
  const currentTemplatePaths = new Set<string>();
  // Built entry-by-entry: a file's baseline only advances to the new template
  // hash when its on-disk copy actually reflects that template (create/update/
  // noop). A conflict keeps its OLD baseline so the next run still detects the
  // unresolved edit and re-offers the `.new` (else the conflict silently
  // vanishes and the CLI falsely reports "already matches").
  const newEntries: ScaffoldFileEntry[] = [];
  const advance = (destRel: string, newSha: string): void => {
    newEntries.push({ path: destRel, sha256: newSha });
  };
  const preserve = (destRel: string): void => {
    const old = entries.get(destRel);
    if (old) newEntries.push(old);
  };

  for (const { srcPath, destRel } of collectScaffoldFiles(scaffoldSrc)) {
    currentTemplatePaths.add(destRel);
    const newContent = renderScaffoldFile(srcPath, basename(srcPath), vars);
    const newSha = sha256(newContent);
    const destPath = join(cwd, destRel);

    // Refuse to write through a symlinked parent dir that escapes the workspace
    // (a symlinked leaf is caught by probeDest below).
    if (!isDestWriteSafe(realCwd, cwd, destRel)) {
      result.symlinkSkipped.push(destRel);
      preserve(destRel);
      continue;
    }

    const disk = probeDest(destPath);
    if (disk.kind === 'symlink') {
      result.symlinkSkipped.push(destRel);
      preserve(destRel);
      continue;
    }

    const action = decideUpgradeAction({ disk, newSha, manifestEntry: entries.get(destRel) });
    if (action === 'noop') {
      result.unchanged.push(destRel);
      advance(destRel, newSha);
    } else if (action === 'create') {
      if (!dryRun) writeFile(destPath, newContent);
      result.created.push(destRel);
      advance(destRel, newSha);
    } else if (action === 'update') {
      if (!dryRun) writeFile(destPath, newContent);
      result.updated.push(destRel);
      advance(destRel, newSha);
    } else {
      // conflict — never touch the user's file; offer the new version alongside,
      // and keep the old baseline so it stays flagged until reconciled.
      if (!dryRun) writeFile(`${destPath}.new`, newContent);
      result.conflicts.push(destRel);
      preserve(destRel);
    }
    if (destRel === FOUNDER_EXAMPLE && action !== 'noop') result.founderExampleChanged = true;
  }

  // Files roster previously produced that are no longer templates: keep the
  // user's copy (never delete), just report. They drop out of the manifest.
  for (const e of oldManifest?.files ?? []) {
    if (!currentTemplatePaths.has(e.path)) result.droppedKept.push(e.path);
  }

  if (!dryRun) {
    writeScaffoldManifest(cwd, {
      version: SCAFFOLD_MANIFEST_VERSION,
      rosterVersion: getPackageVersion(),
      generatedAtUtc: new Date().toISOString(),
      files: newEntries.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  return result;
}

function writeFile(destPath: string, content: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content, 'utf8');
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// True unless an already-existing parent component of destRel is a symlink that
// resolves outside the workspace. destRel is workspace-relative and trusted
// (it comes from walking the shipped templates), so the only escape vector is a
// symlinked dir the user planted; refuse to write/`.new` through it.
function isDestWriteSafe(realCwd: string, cwd: string, destRel: string): boolean {
  const parts = destRel.split(sep);
  let cur = cwd;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return true; // doesn't exist yet → mkdir creates it inside cwd → safe
    }
    if (st.isSymbolicLink()) {
      const real = safeRealpath(cur);
      if (real === null) return false;
      if (real !== realCwd && !real.startsWith(realCwd + sep)) return false;
    }
  }
  return true;
}
