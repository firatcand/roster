import { basename, resolve } from 'node:path';
import chalk from 'chalk';
import {
  legacyWorkspaceError,
  mixedWorkspaceError,
  RosterError,
  unsafeWorkspaceMarkerError,
  EXIT_ERROR,
} from '../lib/errors.ts';
import { renderRosterBootstrap } from '../lib/generated-artifacts.ts';
import { assertWorkspaceId } from '../lib/workspace-layout.ts';
import {
  assertWorkspaceDirectoryIdentity,
  hashWorkspaceBytes,
  isWorkspaceDirectoryIdentityFailure,
  publishCreateOnly,
  removePublishedWorkspaceFile,
  tryReadWorkspaceFile,
  withWorkspaceDirectoryIdentity,
  type WorkspaceFileIdentityToken,
} from '../lib/workspace-io.ts';
import { isWorkspaceFailure, workspaceFailure } from '../lib/workspace-diagnostics.ts';
import {
  probeWorkspace,
  type WorkspaceProbe,
} from '../lib/workspace-probe.ts';

export type InitLogger = {
  log: (message: string) => void;
};

export type InitOptions = {
  cwd: string;
  workspaceId?: string;
  name?: string;
  silent?: boolean;
  logger?: InitLogger;
};

export type InitResult = {
  status: 'ok';
  workspaceRoot: string;
  workspaceId: string;
  filesWritten: string[];
  filesSkipped: string[];
};

export type InitIo = {
  publish: typeof publishCreateOnly;
  removePublished: typeof removePublishedWorkspaceFile;
  probe?: typeof probeWorkspace;
};

const realInitIo: InitIo = {
  publish: publishCreateOnly,
  removePublished: removePublishedWorkspaceFile,
};

const consoleLogger: InitLogger = {
  log: (message) => console.log(message),
};

function resolveWorkspaceId(opts: InitOptions, root: string): string {
  const positional = opts.workspaceId === undefined
    ? undefined
    : assertWorkspaceId(opts.workspaceId);
  const named = opts.name === undefined ? undefined : assertWorkspaceId(opts.name);
  if (positional !== undefined && named !== undefined && positional !== named) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} workspace identity arguments disagree`,
      body: `  Positional workspace id '${positional}' does not match --name '${named}'.`,
      remedy: '  Pass one workspace id, or use the same value in both forms.',
      exitCode: EXIT_ERROR,
      code: 'IDENTITY_INVALID',
      details: { positional, name: named },
    });
  }
  return positional ?? named ?? assertWorkspaceId(basename(root));
}

function renderRegistry(workspaceId: string): string {
  return [
    'schema_version: 2',
    `workspace_id: ${workspaceId}`,
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n');
}

function assertInitTarget(probe: WorkspaceProbe): void {
  if (probe.kind === 'unsafe') {
    throw unsafeWorkspaceMarkerError(probe.unsafeSignals);
  }
  if (probe.kind === 'mixed') {
    throw mixedWorkspaceError(probe.v2Signals, probe.legacySignals);
  }
  if (probe.kind === 'legacy') {
    throw legacyWorkspaceError(probe.legacySignals);
  }
}

function identitySignal(path: string): string {
  return `${path}:probe-directory-identity-changed`;
}

function assertProbeSession(probe: WorkspaceProbe): void {
  if (probe.session === undefined) {
    throw workspaceFailure(
      'WORKSPACE_NOT_FOUND',
      `Workspace '${probe.root}' does not exist.`,
      'Create or enter a directory before running Roster.',
      { root: probe.root },
    );
  }
  const tokens = probe.v2Signals.length > 0
    ? [probe.session.root]
    : [probe.session.root, ...probe.session.candidates];
  for (const token of tokens) {
    try {
      assertWorkspaceDirectoryIdentity(probe.root, token);
    } catch (error) {
      if (isWorkspaceDirectoryIdentityFailure(error)) {
        throw unsafeWorkspaceMarkerError([identitySignal(token.path)]);
      }
      throw error;
    }
  }
}

function withProbedRoot<T>(probe: WorkspaceProbe, operation: (anchoredRoot: '.') => T): T {
  if (probe.session === undefined) {
    assertProbeSession(probe);
    throw new Error('unreachable');
  }
  try {
    return withWorkspaceDirectoryIdentity(
      probe.root,
      probe.session.root,
      operation,
      { verifyAfter: false },
    );
  } catch (error) {
    if (isWorkspaceDirectoryIdentityFailure(error)) {
      throw unsafeWorkspaceMarkerError([identitySignal('.')]);
    }
    throw error;
  }
}

function assertExistingRegistryMatches(root: string, registry: string): boolean {
  const existing = tryReadWorkspaceFile(root, 'roster.yaml');
  if (existing === null) return false;
  const expected = Buffer.from(registry, 'utf8');
  if (existing.equals(expected)) return true;
  throw workspaceFailure(
    'WRITE_CONFLICT',
    "File 'roster.yaml' already exists with different bytes.",
    'Preserve the existing file, choose another identity, or reconcile it explicitly.',
    {
      path: 'roster.yaml',
      expectedHash: hashWorkspaceBytes(expected),
      actualHash: hashWorkspaceBytes(existing),
    },
  );
}

function initRollbackIncomplete(
  path: 'ROSTER.md' | 'roster.yaml',
  identity: WorkspaceFileIdentityToken,
  cause: unknown,
  related?: { path: 'ROSTER.md' | 'roster.yaml'; identity: WorkspaceFileIdentityToken },
): RosterError {
  return workspaceFailure(
    'WRITE_CONFLICT',
    `Initialization rollback could not remove the exact published '${path}' bytes.`,
    `Inspect '${path}' and the disclosed identity token before retrying; a concurrent replacement was preserved.`,
    {
      path,
      state: 'unknown',
      expectedDev: identity.dev,
      expectedIno: identity.ino,
      expectedHash: identity.hash,
      preservedPaths: related === undefined ? [path] : [path, related.path],
      ...(related === undefined ? {} : {
        relatedPath: related.path,
        relatedExpectedDev: related.identity.dev,
        relatedExpectedIno: related.identity.ino,
        relatedExpectedHash: related.identity.hash,
      }),
      cause: isWorkspaceFailure(cause)
        ? cause.code
        : ((cause as NodeJS.ErrnoException).code ?? String(cause)),
    },
  );
}

export async function executeInit(opts: InitOptions, io: InitIo = realInitIo): Promise<InitResult> {
  const root = resolve(opts.cwd);
  const workspaceId = resolveWorkspaceId(opts, root);
  const logger = opts.logger ?? consoleLogger;
  const rosterBootstrap = renderRosterBootstrap();
  const registry = renderRegistry(workspaceId);

  const probe = (io.probe ?? probeWorkspace)(root);
  assertInitTarget(probe);

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];
  withProbedRoot(probe, (anchoredRoot) => {
    let bootstrapIdentity: WorkspaceFileIdentityToken | undefined;
    let bootstrapPublication: ReturnType<typeof publishCreateOnly> | undefined;
    let registryIdentity: WorkspaceFileIdentityToken | undefined;
    let registryPublication: ReturnType<typeof publishCreateOnly> | undefined;
    let registryPreexisted = false;
    try {
      assertProbeSession(probe);
      registryPreexisted = assertExistingRegistryMatches(anchoredRoot, registry);
      assertProbeSession(probe);

      bootstrapPublication = io.publish(anchoredRoot, 'ROSTER.md', rosterBootstrap, {
        captureCreation(token) {
          bootstrapIdentity = token;
        },
      });
      assertProbeSession(probe);
      (bootstrapPublication === 'created' ? filesWritten : filesSkipped).push('ROSTER.md');

      registryPublication = io.publish(anchoredRoot, 'roster.yaml', registry, {
        captureCreation(token) {
          registryIdentity = token;
        },
      });
      assertProbeSession(probe);
      (registryPublication === 'created' ? filesWritten : filesSkipped).push('roster.yaml');
    } catch (error) {
      let boundaryError: unknown;
      try {
        assertProbeSession(probe);
      } catch (verificationError) {
        boundaryError = verificationError;
      }
      let bootstrapCanBeRemoved = registryPreexisted || registryPublication === 'adopted';
      if (registryIdentity !== undefined) {
        let removed = false;
        try {
          removed = io.removePublished(anchoredRoot, 'roster.yaml', registryIdentity);
        } catch (removalError) {
          throw initRollbackIncomplete(
            'roster.yaml',
            registryIdentity,
            removalError,
            bootstrapIdentity === undefined
              ? undefined
              : { path: 'ROSTER.md', identity: bootstrapIdentity },
          );
        }
        if (!removed) {
          throw initRollbackIncomplete(
            'roster.yaml',
            registryIdentity,
            'identity-mismatch',
            bootstrapIdentity === undefined
              ? undefined
              : { path: 'ROSTER.md', identity: bootstrapIdentity },
          );
        }
        bootstrapCanBeRemoved = true;
      } else if (registryPublication === 'created') {
        throw workspaceFailure(
          'WRITE_CONFLICT',
          "Initialization committed 'roster.yaml' without an identity token for rollback.",
          "Preserve 'roster.yaml' and 'ROSTER.md', inspect their bytes, and retry only after reconciliation.",
          { path: 'roster.yaml', preservedPaths: ['roster.yaml', 'ROSTER.md'], state: 'unknown' },
        );
      } else if (registryPublication === undefined && !registryPreexisted) {
        try {
          bootstrapCanBeRemoved = tryReadWorkspaceFile(anchoredRoot, 'roster.yaml') === null;
        } catch {
          // Unknown commit state: preserve the bootstrap dependency for exact-byte recovery.
        }
      }
      if (
        bootstrapIdentity !== undefined
        && bootstrapCanBeRemoved
      ) {
        try {
          assertProbeSession(probe);
        } catch (verificationError) {
          boundaryError ??= verificationError;
        }
        let removed = false;
        try {
          removed = io.removePublished(
            anchoredRoot,
            'ROSTER.md',
            bootstrapIdentity,
          );
        } catch (removalError) {
          throw initRollbackIncomplete('ROSTER.md', bootstrapIdentity, removalError);
        }
        if (!removed) {
          throw initRollbackIncomplete('ROSTER.md', bootstrapIdentity, 'identity-mismatch');
        }
      } else if (bootstrapPublication === 'created' && bootstrapIdentity === undefined) {
        throw workspaceFailure(
          'WRITE_CONFLICT',
          "Initialization committed 'ROSTER.md' without an identity token for rollback.",
          "Preserve 'ROSTER.md', inspect its bytes, and retry only after reconciliation.",
          { path: 'ROSTER.md', preservedPaths: ['ROSTER.md'], state: 'unknown' },
        );
      }
      throw boundaryError ?? error;
    }
  });

  if (!(opts.silent ?? false)) {
    logger.log(
      `${chalk.green('✓')} Initialized sparse Roster workspace ${chalk.bold(`'${workspaceId}'`)} in ${root}`,
    );
    logger.log(chalk.dim('Files: roster.yaml, ROSTER.md'));
    logger.log(
      `${chalk.dim('Next: ')}open Claude Code or Codex here; the host can run ${chalk.bold('roster scaffold')} and ${chalk.bold('roster discover --json')}.`,
    );
  }

  return {
    status: 'ok',
    workspaceRoot: root,
    workspaceId,
    filesWritten,
    filesSkipped,
  };
}
