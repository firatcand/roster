import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { describeEvidenceFailure, readEvidenceFileSync } from '../evidence-read.ts';
import { isUuidV4 } from './config-schema.ts';
import {
  atomicWriteFileSync,
  confinedLedgerDir,
  ensureOwnedDir,
  ledgerBoundaryFor,
} from './local/ledger.ts';

// The journal is small JSON; a legitimate one is a few hundred bytes.
const MAX_JOURNAL_BYTES = 64 * 1024;

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
  const opsRoot = opsRootPath(cwd);
  // Round-12 finding 2 (same class): the journal decides which backend and
  // which workspace identity setup resumes into, so a symlinked `.roster` or
  // `.roster/ops` must never divert this read to a foreign tree — and a planted
  // FIFO must not block it. Component-wise confinement + the hardened bounded
  // reader, exactly like the ledger meta.
  if (confinedLedgerDir(opsRoot, ledgerBoundaryFor(opsRoot)) === 'absent') return null;
  const path = setupJournalPath(cwd);
  const read = readEvidenceFileSync(path, MAX_JOURNAL_BYTES);
  if (read.state === 'missing') return null;
  if (read.state === 'malformed') {
    throw corruptJournalError(path, `unreadable: ${describeEvidenceFailure(read.reason, MAX_JOURNAL_BYTES)}`);
  }
  let parsed: SetupJournal;
  try {
    parsed = JSON.parse(read.content) as SetupJournal;
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
