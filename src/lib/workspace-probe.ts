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

// Reads the innermost OS cause, never the human-readable diagnostic string
// (which embeds attacker-influenceable directory names). A workspace failure
// carries the original errno under details.cause however deeply it is wrapped;
// a raw errno carries it on .code.
function isPermissionDeniedFailure(error: unknown): boolean {
  const cause = isWorkspaceFailure(error)
    ? error.details['cause']
    : (error as NodeJS.ErrnoException).code;
  return cause === 'EACCES' || cause === 'EPERM';
}

function inspectPath(
  root: string,
  relativePath: string,
  expected: 'file' | 'directory',
  failureSignals: string[],
  diagnosticPath = relativePath,
  ioAmbiguousSignals?: string[],
): PathInspection {
  let kind;
  try {
    kind = inspectWorkspaceEntry(root, relativePath);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') return 'absent';
    const signal = isWorkspaceFailure(error)
      ? `${diagnosticPath}:${error.code.toLocaleLowerCase('en-US')}`
      : `${diagnosticPath}:unreadable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
    failureSignals.push(signal);
    if (ioAmbiguousSignals !== undefined && isPermissionDeniedFailure(error)) {
      ioAmbiguousSignals.push(signal);
    }
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
  ioAmbiguousSignals: string[],
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
    const signal = `${diagnosticPath}:unreadable:${code}`;
    inconclusiveSignals.push(signal);
    if (isPermissionDeniedFailure(error)) ioAmbiguousSignals.push(signal);
    return [];
  }
}

function inspectCandidateDirectory(
  parentRoot: string,
  entry: WorkspaceDirectoryInspectionEntry,
  relativePath: string,
  inconclusiveSignals: string[],
  ioAmbiguousSignals: string[],
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
    const signal = `${relativePath}:unreadable:${code}`;
    inconclusiveSignals.push(signal);
    if (isPermissionDeniedFailure(error)) ioAmbiguousSignals.push(signal);
  }
}

function detectV04Signals(
  root: string,
  inconclusiveSignals: string[],
  ioAmbiguousSignals: string[],
  candidates: WorkspaceDirectoryIdentityToken[],
  beforeInspect?: (relativePath: string) => void,
): string[] {
  const signals: string[] = [];
  const budget = { remaining: MAX_PROBE_TOTAL_ENTRIES };
  if (
    inspectPath(
      root,
      'projects',
      'directory',
      inconclusiveSignals,
      'projects',
      ioAmbiguousSignals,
    ) === 'present'
  ) {
    signals.push('projects/');
  }

  for (const top of boundedEntries(
    root,
    '.',
    '.',
    inconclusiveSignals,
    ioAmbiguousSignals,
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
      ioAmbiguousSignals,
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
            ioAmbiguousSignals,
          ) === 'present'
        ) {
          signals.push(`${topProjects}/`);
        }

        for (const child of boundedEntries(
          topRoot,
          '.',
          top.name,
          inconclusiveSignals,
          ioAmbiguousSignals,
          budget,
        )) {
          if (child.kind !== 'directory' || child.name.startsWith('.')) continue;
          const childPath = `${top.name}/${child.name}`;
          inspectCandidateDirectory(
            topRoot,
            child,
            childPath,
            inconclusiveSignals,
            ioAmbiguousSignals,
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
                  ioAmbiguousSignals,
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
  ioAmbiguousSignals: string[],
): boolean {
  const inspection = inspectPath(
    root,
    relativePath,
    'file',
    inconclusiveSignals,
    relativePath,
    ioAmbiguousSignals,
  );
  if (inspection !== 'present') return false;

  try {
    const actual = readWorkspaceFile(root, relativePath, { maxBytes: expected.byteLength });
    return actual.equals(expected);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'READ_LIMIT_EXCEEDED') return false;
    const code = isWorkspaceFailure(error)
      ? error.code.toLocaleLowerCase('en-US')
      : ((error as NodeJS.ErrnoException).code ?? 'unknown');
    const signal = `${relativePath}:unreadable:${code}`;
    inconclusiveSignals.push(signal);
    if (isPermissionDeniedFailure(error)) ioAmbiguousSignals.push(signal);
    return false;
  }
}

function legacySignatureSignals(
  root: string,
  inconclusiveSignals: string[],
  ioAmbiguousSignals: string[],
): string[] {
  const hits: string[] = [];
  for (const relativePath of LEGACY_SIGNATURE_FILES) {
    const template = readFileSync(join(ROSTER_ROOT, 'templates', 'scaffold', relativePath));
    if (
      regularFileEquals(root, relativePath, template, inconclusiveSignals, ioAmbiguousSignals)
    ) {
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
  const ioAmbiguousSignals: string[] = [];
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
        ioAmbiguousSignals,
        candidates,
        options.beforeDirectoryInspect,
      ));
      legacySignals.push(...legacySignatureSignals(
        anchoredRoot,
        inconclusiveSignals,
        ioAmbiguousSignals,
      ));
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
  const ioAmbiguous = new Set(ioAmbiguousSignals);
  // Only genuinely ambiguous permission failures (EACCES/EPERM) on a path
  // Roster never confirmed as workspace-relevant are exempt from blocking.
  // Wrong-type mismatches, directory-identity races, and traversal-budget
  // exhaustion recorded here are positive evidence of tampering or
  // incompleteness, not mere unreadability, so they are never treated as
  // io-ambiguous. This filter only feeds the branch below, though: with no
  // v2 sentinel (roster.yaml), any remaining (non-io-ambiguous) entry still
  // forces 'unsafe'. With a v2 sentinel present, the kind ternary resolves to
  // 'v2'/'mixed' before this filtered list is ever consulted -- structural
  // inconclusive signals are recorded (still visible via
  // probe.inconclusiveSignals) but non-blocking there. That precedence is
  // pre-existing (see the 'v2'/'mixed' branches below) and unchanged by this
  // fix; see test/init.test.ts's 'a regular v2 sentinel keeps incidental
  // legacy-scan uncertainty non-blocking'.
  //
  // Threat model (#386): an actor who can chmod a directory inside the tree
  // `roster init`/`install`/`doctor --fix` is about to run in already has
  // local write access to that tree, and could equally delete/rename/replace
  // the legacy markers directly -- hiding them behind a permission wall is
  // not a materially stronger attack than the many other ways such an actor
  // could already evade this heuristic. Verified against all 11 production
  // callers of probeWorkspace: only init, install's implicit user-scope
  // default, and doctor --fix can turn a downgrade into a write, and in all
  // three cases the write is either non-destructive/self-correcting (init:
  // fresh roster.yaml/ROSTER.md beside an undetected legacy dir), confined to
  // the tool install roots and independent of cwd (install: ~/.claude et al.
  // via assertWithinRoot -- those roots may themselves be descendants of cwd
  // when ROSTER_*_HOME points inside it, but nothing is resolved relative to
  // cwd on that path; see install.ts's user-scope branch), or a no-op /
  // identical to doctor --fix's pre-existing behavior on any other
  // non-workspace directory (see doctor.ts's fixer gates). That is strictly
  // better than the status quo, which fails EVERY command -- including
  // read-only ones like `discover`/`doctor --json` -- with a tampered-marker
  // error on any innocent unreadable sibling directory.
  const blockingInconclusive = inconclusive.filter((signal) => !ioAmbiguous.has(signal));
  const kind: WorkspaceKind =
    unsafe.length > 0
      ? 'unsafe'
      : v2.length > 0 && legacy.length > 0
        ? 'mixed'
        : v2.length > 0
          ? 'v2'
          : blockingInconclusive.length > 0
            ? 'unsafe'
            : legacy.length > 0
              ? 'legacy'
              : 'none';
  const blockingUnsafe = v2.length === 0 && kind === 'unsafe'
    ? sortedUnique([...unsafe, ...inconclusive])
    : unsafe;

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
