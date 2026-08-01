import {
  lstatSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ROSTER_ROOT } from './paths.ts';
import {
  inspectWorkspaceDirectory,
  inspectWorkspaceEntry,
  isWorkspaceDirectoryIdentityFailure,
  readWorkspaceFile,
  withWorkspaceDirectoryIdentity,
  type WorkspaceDirectoryInspectionEntry,
  type WorkspaceDirectoryIdentityToken,
} from './workspace-io.ts';
import { isWorkspaceFailure } from './workspace-diagnostics.ts';

export type WorkspaceKind = 'v2' | 'legacy' | 'mixed' | 'unsafe' | 'none';

export type WorkspaceProbe = {
  kind: WorkspaceKind;
  root: string;
  v2Signals: readonly string[];
  legacySignals: readonly string[];
  unsafeSignals: readonly string[];
  inconclusiveSignals: readonly string[];
  session?: WorkspaceProbeSession;
};

export type WorkspaceProbeSession = {
  root: WorkspaceDirectoryIdentityToken;
  candidates: readonly WorkspaceDirectoryIdentityToken[];
};

type PathInspection = 'absent' | 'present' | 'unsafe';

export type WorkspaceProbeOptions = {
  beforeDirectoryInspect?: (relativePath: string) => void;
};

const V04_SCAN_SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'lib',
  'bin',
  'src',
  'test',
  'tests',
  'docs',
  'examples',
  'packages',
  'apps',
  'public',
  'vendor',
  'scripts',
  'templates',
  'assets',
  'functions',
]);
const MAX_PROBE_ENTRIES = 1024;
const MAX_PROBE_TOTAL_ENTRIES = 10_000;
const LEGACY_SIGNATURE_FILES = [
  'chief-of-staff/agent.md',
  'dreamer/agent.md',
  'scripts/new-agent.sh',
] as const;

function statKind(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'special-file';
}

function rootEntry(path: string): { kind: string; stat?: Stats } {
  try {
    const stat = lstatSync(path);
    return { kind: statKind(stat), stat };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === 'ENOENT' ? 'absent' : `unreadable:${code ?? 'unknown'}` };
  }
}

function inspectPath(
  root: string,
  relativePath: string,
  expected: 'file' | 'directory',
  failureSignals: string[],
  diagnosticPath = relativePath,
): PathInspection {
  let kind;
  try {
    kind = inspectWorkspaceEntry(root, relativePath);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') return 'absent';
    if (isWorkspaceFailure(error)) {
      failureSignals.push(`${diagnosticPath}:${error.code.toLocaleLowerCase('en-US')}`);
      return 'unsafe';
    }
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    failureSignals.push(`${diagnosticPath}:unreadable:${code}`);
    return 'unsafe';
  }
  if (kind === 'absent') return 'absent';
  if (kind !== expected) {
    failureSignals.push(`${diagnosticPath}:${kind}`);
    return 'unsafe';
  }
  return 'present';
}

function boundedEntries(
  root: string,
  relativePath: string,
  diagnosticPath: string,
  inconclusiveSignals: string[],
  budget: { remaining: number },
  beforeInspect?: (relativePath: string) => void,
): WorkspaceDirectoryInspectionEntry[] {
  if (budget.remaining === 0) {
    inconclusiveSignals.push(`${diagnosticPath}:probe-total-entry-limit-exceeded`);
    return [];
  }
  const maxEntries = Math.min(MAX_PROBE_ENTRIES, budget.remaining);
  try {
    beforeInspect?.(diagnosticPath);
    const inspection = inspectWorkspaceDirectory(root, relativePath, { maxEntries });
    budget.remaining -= inspection.entries.length;
    if (inspection.truncated) {
      inconclusiveSignals.push(
        maxEntries < MAX_PROBE_ENTRIES || budget.remaining === 0
          ? `${diagnosticPath}:probe-total-entry-limit-exceeded`
          : `${diagnosticPath}:probe-directory-entry-limit-exceeded`,
      );
    }
    return inspection.entries;
  } catch (error) {
    const code = isWorkspaceFailure(error)
      ? error.code.toLocaleLowerCase('en-US')
      : ((error as NodeJS.ErrnoException).code ?? 'unknown');
    inconclusiveSignals.push(`${diagnosticPath}:unreadable:${code}`);
    return [];
  }
}

function inspectCandidateDirectory(
  parentRoot: string,
  entry: WorkspaceDirectoryInspectionEntry,
  relativePath: string,
  inconclusiveSignals: string[],
  candidates: WorkspaceDirectoryIdentityToken[],
  operation: (anchoredRoot: '.') => void,
  beforeInspect?: (relativePath: string) => void,
): void {
  const localToken = { path: entry.name, dev: entry.dev, ino: entry.ino };
  try {
    beforeInspect?.(relativePath);
    withWorkspaceDirectoryIdentity(parentRoot, localToken, operation);
    candidates.push({ path: relativePath, dev: entry.dev, ino: entry.ino });
  } catch (error) {
    if (isWorkspaceDirectoryIdentityFailure(error)) {
      inconclusiveSignals.push(`${relativePath}:probe-directory-identity-changed`);
      return;
    }
    const code = isWorkspaceFailure(error)
      ? error.code.toLocaleLowerCase('en-US')
      : ((error as NodeJS.ErrnoException).code ?? 'unknown');
    inconclusiveSignals.push(`${relativePath}:unreadable:${code}`);
  }
}

function detectV04Signals(
  root: string,
  inconclusiveSignals: string[],
  candidates: WorkspaceDirectoryIdentityToken[],
  beforeInspect?: (relativePath: string) => void,
): string[] {
  const signals: string[] = [];
  const budget = { remaining: MAX_PROBE_TOTAL_ENTRIES };
  if (inspectPath(root, 'projects', 'directory', inconclusiveSignals) === 'present') {
    signals.push('projects/');
  }

  for (const top of boundedEntries(
    root,
    '.',
    '.',
    inconclusiveSignals,
    budget,
    beforeInspect,
  )) {
    if (top.kind !== 'directory' || top.name.startsWith('.') || V04_SCAN_SKIP.has(top.name)) {
      continue;
    }

    inspectCandidateDirectory(
      root,
      top,
      top.name,
      inconclusiveSignals,
      candidates,
      (topRoot) => {
        const topProjects = `${top.name}/projects`;
        if (
          inspectPath(
            topRoot,
            'projects',
            'directory',
            inconclusiveSignals,
            topProjects,
          ) === 'present'
        ) {
          signals.push(`${topProjects}/`);
        }

        for (const child of boundedEntries(
          topRoot,
          '.',
          top.name,
          inconclusiveSignals,
          budget,
        )) {
          if (child.kind !== 'directory' || child.name.startsWith('.')) continue;
          const childPath = `${top.name}/${child.name}`;
          inspectCandidateDirectory(
            topRoot,
            child,
            childPath,
            inconclusiveSignals,
            candidates,
            (childRoot) => {
              const childProjects = `${childPath}/projects`;
              if (
                inspectPath(
                  childRoot,
                  'projects',
                  'directory',
                  inconclusiveSignals,
                  childProjects,
                ) === 'present'
              ) {
                signals.push(`${childProjects}/`);
              }
            },
            beforeInspect,
          );
        }
      },
      beforeInspect,
    );
  }

  return signals;
}

function regularFileEquals(
  root: string,
  relativePath: string,
  expected: Buffer,
  inconclusiveSignals: string[],
): boolean {
  const inspection = inspectPath(root, relativePath, 'file', inconclusiveSignals);
  if (inspection !== 'present') return false;

  try {
    const actual = readWorkspaceFile(root, relativePath, { maxBytes: expected.byteLength });
    return actual.equals(expected);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'READ_LIMIT_EXCEEDED') return false;
    const code = isWorkspaceFailure(error)
      ? error.code.toLocaleLowerCase('en-US')
      : ((error as NodeJS.ErrnoException).code ?? 'unknown');
    inconclusiveSignals.push(`${relativePath}:unreadable:${code}`);
    return false;
  }
}

function legacySignatureSignals(root: string, inconclusiveSignals: string[]): string[] {
  const hits: string[] = [];
  for (const relativePath of LEGACY_SIGNATURE_FILES) {
    const template = readFileSync(join(ROSTER_ROOT, 'templates', 'scaffold', relativePath));
    if (regularFileEquals(root, relativePath, template, inconclusiveSignals)) {
      hits.push(relativePath);
    }
  }
  return hits.length >= 2 ? hits.map((path) => `managed-v1:${path}`) : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function probeWorkspace(cwd: string, options: WorkspaceProbeOptions = {}): WorkspaceProbe {
  const root = resolve(cwd);
  const v2Signals: string[] = [];
  const legacySignals: string[] = [];
  const unsafeSignals: string[] = [];
  const inconclusiveSignals: string[] = [];
  const candidates: WorkspaceDirectoryIdentityToken[] = [];

  const rootInspection = rootEntry(root);
  if (rootInspection.kind === 'absent') {
    return {
      kind: 'none',
      root,
      v2Signals: [],
      legacySignals: [],
      unsafeSignals: [],
      inconclusiveSignals: [],
    };
  }
  if (rootInspection.kind !== 'directory' || rootInspection.stat === undefined) {
    return {
      kind: 'unsafe',
      root,
      v2Signals: [],
      legacySignals: [],
      unsafeSignals: [`.:${rootInspection.kind}`],
      inconclusiveSignals: [],
    };
  }
  const rootToken: WorkspaceDirectoryIdentityToken = {
    path: '.',
    dev: rootInspection.stat.dev,
    ino: rootInspection.stat.ino,
  };

  try {
    withWorkspaceDirectoryIdentity(root, rootToken, (anchoredRoot) => {
      if (inspectPath(anchoredRoot, 'roster.yaml', 'file', unsafeSignals) === 'present') {
        v2Signals.push('roster.yaml');
      }
      inspectPath(anchoredRoot, 'ROSTER.md', 'file', unsafeSignals);

      if (
        inspectPath(anchoredRoot, 'config/project.yaml', 'file', unsafeSignals) === 'present'
      ) {
        legacySignals.push('config/project.yaml');
      }
      if (
        inspectPath(
          anchoredRoot,
          '.roster/scaffold-manifest.json',
          'file',
          unsafeSignals,
        ) === 'present'
      ) {
        legacySignals.push('.roster/scaffold-manifest.json');
      }

      legacySignals.push(...detectV04Signals(
        anchoredRoot,
        inconclusiveSignals,
        candidates,
        options.beforeDirectoryInspect,
      ));
      legacySignals.push(...legacySignatureSignals(anchoredRoot, inconclusiveSignals));
    });
  } catch (error) {
    if (isWorkspaceDirectoryIdentityFailure(error)) {
      unsafeSignals.push('.:probe-directory-identity-changed');
    } else {
      const code = isWorkspaceFailure(error)
        ? error.code.toLocaleLowerCase('en-US')
        : ((error as NodeJS.ErrnoException).code ?? 'unknown');
      unsafeSignals.push(`.:unreadable:${code}`);
    }
  }

  const v2 = sortedUnique(v2Signals);
  const legacy = sortedUnique(legacySignals);
  const unsafe = sortedUnique(unsafeSignals);
  const inconclusive = sortedUnique(inconclusiveSignals);
  const blockingUnsafe = v2.length === 0
    ? sortedUnique([...unsafe, ...inconclusive])
    : unsafe;
  const kind: WorkspaceKind =
    unsafe.length > 0
      ? 'unsafe'
      : v2.length > 0 && legacy.length > 0
        ? 'mixed'
        : v2.length > 0
          ? 'v2'
          : inconclusive.length > 0
            ? 'unsafe'
          : legacy.length > 0
            ? 'legacy'
            : 'none';

  return {
    kind,
    root,
    v2Signals: v2,
    legacySignals: legacy,
    unsafeSignals: blockingUnsafe,
    inconclusiveSignals: inconclusive,
    session: {
      root: rootToken,
      candidates: candidates.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    },
  };
}
