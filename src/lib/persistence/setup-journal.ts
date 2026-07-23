import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { isUuidV4 } from './config-schema.ts';
import { atomicWriteFileSync, ensureOwnedDir } from './local/ledger.ts';

// The `roster ops setup` crash/race journal (#318 section J). Lives at the
// FIXED path .roster/ops/setup-journal.json — outside the per-UUID tree, so it
// is discoverable before persistence.yaml exists and survives --new-identity
// deliberations. The journal records INTENT; remote state is truth — re-entry
// revalidates every completed remote phase by re-running its idempotent
// operation, which also discovers a remote commit the journal never saw and
// rolls FORWARD (never compensates/unclaims, locked decision 5).

export const SETUP_PHASES = [
  'intent',
  'gitignore-ensured',
  'db-stamped-pending',
  'bucket-claimed',
  'db-finalized',
  'config-written',
  'done',
] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

export function phaseRank(phase: SetupPhase): number {
  return SETUP_PHASES.indexOf(phase);
}

export type SetupJournalObjects = {
  bucket: string;
  region: string | null;
  endpoint: string | null;
  force_path_style: boolean;
  markerSha256: string;
};

export type SetupJournal = {
  version: 1;
  workspaceId: string;
  workspaceName: string;
  backend: 'local' | 'postgres-s3';
  phase: SetupPhase;
  postgres: { database: 'brain' | 'dedicated' } | null;
  objects: SetupJournalObjects | null;
  createdAt: number;
  updatedAt: number;
};

export function opsRootPath(cwd: string): string {
  return join(cwd, '.roster', 'ops');
}

export function setupJournalPath(cwd: string): string {
  return join(opsRootPath(cwd), 'setup-journal.json');
}

function corruptJournalError(path: string, detail: string): RosterError {
  return new RosterError({
    header: 'roster: ops setup journal is corrupt',
    body: `  ${path}\n    ${detail}`,
    remedy:
      '  If a setup previously completed, restore the file from backup or delete it and re-run\n' +
      "  'roster ops setup' with the original flags. Deleting it orphans any pending database\n" +
      '  stamp (an admin must clear that manually — roster never auto-unclaims).',
    exitCode: EXIT_ERROR,
  });
}

export function readSetupJournal(cwd: string): SetupJournal | null {
  const path = setupJournalPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw corruptJournalError(path, `unreadable: ${(err as Error).message}`);
  }
  let parsed: SetupJournal;
  try {
    parsed = JSON.parse(raw) as SetupJournal;
  } catch {
    throw corruptJournalError(path, 'not valid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.version !== 1 ||
    typeof parsed.workspaceId !== 'string' ||
    !isUuidV4(parsed.workspaceId) ||
    typeof parsed.workspaceName !== 'string' ||
    (parsed.backend !== 'local' && parsed.backend !== 'postgres-s3') ||
    !SETUP_PHASES.includes(parsed.phase)
  ) {
    throw corruptJournalError(path, 'missing or invalid fields');
  }
  return parsed;
}

export function writeSetupJournal(cwd: string, journal: SetupJournal): void {
  ensureOwnedDir(opsRootPath(cwd), cwd);
  atomicWriteFileSync(setupJournalPath(cwd), JSON.stringify(journal, null, 2) + '\n');
}

export function removeSetupJournal(cwd: string): void {
  try {
    unlinkSync(setupJournalPath(cwd));
  } catch {
    // already gone
  }
}
