import { hostname } from 'node:os';
import { lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { isWorkspaceFailure, workspaceFailure } from '../workspace-diagnostics.ts';
import {
  agentRecordPath,
  childRecordPath,
  resolveWorkspacePath,
  type WorkspaceScope,
} from '../workspace-layout.ts';
import {
  ensureRosterStateRoot,
  ensureWorkspaceDirectory,
  hashWorkspaceBytes,
  publishCreateOnly,
  readWorkspaceFile,
  readWorkspaceText,
  removeManagedWorkspaceFileIfHash,
  replaceWorkspaceFile,
  withWorkspaceLock,
} from '../workspace-io.ts';
import {
  parseAgentDefinition,
  parseMarkdownDefinition,
  removeYamlMembership,
  renderMarkdownDefinition,
} from '../workspace-record.ts';
import {
  readWorkspaceRegistry,
  scaffoldWorkspace,
  validateWorkspace,
} from '../workspace-registry.ts';
import { hasHostileBrainInstruction } from '../context-injection-gate.ts';
import { detectAuthoredSecretMaterial } from '../authored-secret-detector.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';
import {
  lessonSubjectOf,
  lessonTargetScope,
  type LessonDecisionVerb,
} from './dream-candidate-contracts.ts';
import { dreamLifecycleError, rethrowDreamLifecycleError, type DreamCandidateBinding } from './dream-candidates.ts';

export const DREAM_PHASE_LOCK_PATH = '.roster/state/locks/dream-phase';

// The bytes that land on disk: the deterministic scaffold stub the registry
// itself renders, then the authored body. Rendering depends only on
// server-verified identity plus the body, so the hash recorded in the decision
// ledger is exactly the hash of the published file and no row is ever amended
// after the fact.
export function renderLessonContent(
  lessonId: string,
  lessonPurpose: string,
  lessonBody: string,
  scope: WorkspaceScope,
): Readonly<{ stub: string; content: string; contentHash: string; stubHash: string }> {
  const stub = renderMarkdownDefinition('lesson', lessonId, lessonPurpose, scope);
  const content = `${stub}\n${lessonBody}${lessonBody.endsWith('\n') ? '' : '\n'}`;
  return Object.freeze({
    stub,
    content,
    contentHash: hashWorkspaceBytes(content),
    stubHash: hashWorkspaceBytes(stub),
  });
}

// Layer 3 of the injection boundary: the SAME closed gate the context seam
// applies to retrieved company text, re-run over the authored prose immediately
// before it becomes a Git file. Layer 1 is the pointer-only citation table and
// layer 2 is the durable SQL twin.
export function assertLessonContentAdmissible(
  candidateId: string,
  lessonPurpose: string,
  lessonBody: string,
): void {
  for (const [field, value] of [['lesson_purpose', lessonPurpose], ['lesson_body', lessonBody]] as const) {
    if (hasHostileBrainInstruction(value)) {
      throw dreamLifecycleError(
        'BRAIN_DREAM_INPUT_INVALID',
        `The candidate's ${field} carries an instruction-override shape and cannot become authored policy.`,
        { candidate_id: candidateId, field },
      );
    }
    const findings = detectAuthoredSecretMaterial(value);
    if (findings.length > 0) {
      throw dreamLifecycleError(
        'BRAIN_DREAM_INPUT_INVALID',
        `The candidate's ${field} carries credential-shaped material and cannot become a plaintext file.`,
        { candidate_id: candidateId, field, detector: findings[0]!.detector_id },
      );
    }
  }
}

export type LessonPaths = Readonly<{
  functionRoot: string;
  lessonPath: string;
  agentPath: string;
}>;

export function resolveLessonPaths(root: string, lessonAgentKey: string, lessonId: string): LessonPaths {
  const [functionId, agentId] = lessonAgentKey.split('/') as [string, string];
  const { registry } = readWorkspaceRegistry(root);
  const entry = registry.functions[functionId];
  if (entry === undefined) {
    throw workspaceFailure(
      'PARENT_NOT_FOUND',
      `Function '${functionId}' is not registered in this workspace.`,
      'Scaffold the function, agent, and plan the lesson targets before promoting it.',
      { function: functionId },
    );
  }
  return Object.freeze({
    functionRoot: entry.path,
    lessonPath: childRecordPath(entry.path, agentId, 'lesson', lessonId),
    agentPath: agentRecordPath(entry.path, agentId),
  });
}

export type LessonPreflightWarning = Readonly<{ code: string; detail: string }>;

// WARNING-ONLY, always. Classification is UNDECIDABLE before the fence -- the
// retired-content list only exists under the held subject lock -- so a refusal
// here would permanently block the very recoveries the fenced repair arms
// perform. Everything this reports is re-derived authoritatively inside the
// phase.
export function preflightLessonTarget(
  root: string,
  lessonAgentKey: string,
  lessonId: string,
  targetScope: WorkspaceScope,
): readonly LessonPreflightWarning[] {
  const warnings: LessonPreflightWarning[] = [];
  let paths: LessonPaths;
  try {
    paths = resolveLessonPaths(root, lessonAgentKey, lessonId);
  } catch {
    return Object.freeze(warnings);
  }
  let fileBytes: Buffer | null = null;
  try {
    fileBytes = readWorkspaceFile(root, paths.lessonPath);
  } catch {
    fileBytes = null;
  }
  if (fileBytes !== null) {
    warnings.push({
      code: 'LESSON_FILE_PRESENT',
      detail: `${paths.lessonPath} already exists (${hashWorkspaceBytes(fileBytes)});`
        + ' the fenced phase will adopt, replace, or refuse it.',
    });
  }
  try {
    const agent = parseAgentDefinition(readWorkspaceText(root, paths.agentPath), paths.agentPath);
    const registered = agent.lessons.includes(lessonId);
    warnings.push({
      code: registered ? 'LESSON_REGISTERED' : 'LESSON_UNREGISTERED',
      detail: registered
        ? `${paths.agentPath} already registers lesson '${lessonId}'.`
        : `${paths.agentPath} does not yet register lesson '${lessonId}'.`,
    });
    if (registered && fileBytes !== null) {
      const parsed = parseMarkdownDefinition(fileBytes.toString('utf8'), paths.lessonPath);
      const registeredPlan = parsed.scope.plan ?? null;
      if (registeredPlan !== (targetScope.plan ?? null)) {
        warnings.push({
          code: 'LESSON_SCOPE_DIFFERS',
          detail: `${paths.lessonPath} is registered at plan scope '${registeredPlan ?? '(none)'}'`
            + ` while this candidate targets '${targetScope.plan ?? '(none)'}'.`,
        });
      }
    }
  } catch {
    // An unreadable or unparseable agent file is not a preflight verdict: the
    // fenced phase resolves it with the authority the preflight lacks.
  }
  return Object.freeze(warnings);
}

type LockOwner = Readonly<{ pid: number; process_start_time: string; host: string }>;

export type DreamPhaseLock = Readonly<{ release: () => void }>;

function readDreamPhaseLockOwner(root: string): Partial<LockOwner> {
  try {
    const value = JSON.parse(
      readWorkspaceText(root, `${DREAM_PHASE_LOCK_PATH}/owner.json`, { maxBytes: 4096 }),
    ) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
      ...(typeof record.process_start_time === 'string'
        ? { process_start_time: record.process_start_time }
        : {}),
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
    };
  } catch {
    return {};
  }
}

// A dedicated local lock, held across the WHOLE filesystem phase by explicit
// acquire/release because a phase spans several workspace-lock invocations and
// async fence calls. The workspace is one directory on one machine, so two CLIs
// mutating it are on the same host and this local lock fully serializes dream
// phases: a successor's phase can never interleave with a predecessor's, even
// when the predecessor's database fence has already died.
//
// A SEPARATE lock name from the scaffold lock, deliberately: the phase's interior
// calls scaffoldWorkspace, which takes '.roster/state/locks/scaffold' itself.
// Nesting order is phase-lock outer, workspace-lock inner.
export function acquireDreamPhaseLock(root: string): DreamPhaseLock {
  ensureRosterStateRoot(root);
  ensureWorkspaceDirectory(root, '.roster/state/locks');
  const absolute = resolveWorkspacePath(root, DREAM_PHASE_LOCK_PATH);
  try {
    mkdirSync(absolute, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw workspaceFailure(
        'WRITE_CONFLICT',
        `Could not acquire the dream-phase lock '${DREAM_PHASE_LOCK_PATH}'.`,
        'Inspect the lock directory before retrying.',
        { path: DREAM_PHASE_LOCK_PATH, cause: (error as NodeJS.ErrnoException).code ?? 'unknown' },
      );
    }
    const owner = readDreamPhaseLockOwner(root);
    throw workspaceFailure(
      'WORKSPACE_BUSY',
      `Another dream operation is mutating this workspace ('${DREAM_PHASE_LOCK_PATH}' is held).`,
      `Wait for the other dream operation, then re-run — the re-run converges. Remove '${DREAM_PHASE_LOCK_PATH}' manually only after confirming that PID is no longer a live dream writer.`,
      {
        lockPath: DREAM_PHASE_LOCK_PATH,
        ...(owner.pid === undefined ? {} : { pid: owner.pid }),
        ...(owner.process_start_time === undefined
          ? {}
          : { processStartTime: owner.process_start_time }),
        ...(owner.host === undefined ? {} : { host: owner.host }),
      },
    );
  }
  // The identity token of the directory THIS call created. Every later removal
  // is gated on it, mirroring the workspace lock: a lock directory that was
  // replaced between acquisition and release is another writer's and is
  // preserved for inspection rather than removed.
  const acquired = lstatSync(absolute);
  if (acquired.isSymbolicLink() || !acquired.isDirectory()) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      `Dream-phase lock '${DREAM_PHASE_LOCK_PATH}' is not the directory this process created.`,
      'Inspect the exact lock path before retrying.',
      { path: DREAM_PHASE_LOCK_PATH },
    );
  }
  const lockIdentity = { dev: acquired.dev, ino: acquired.ino };
  const removeAcquiredLock = (): void => {
    const current = lstatSync(absolute);
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== lockIdentity.dev
      || current.ino !== lockIdentity.ino
    ) {
      throw workspaceFailure(
        'WORKSPACE_BUSY',
        `Dream-phase lock '${DREAM_PHASE_LOCK_PATH}' was replaced during the phase and was preserved.`,
        'Inspect the disclosed lock identity before removing any lock or retrying.',
        {
          path: DREAM_PHASE_LOCK_PATH,
          lockPath: DREAM_PHASE_LOCK_PATH,
          lockDev: lockIdentity.dev,
          lockIno: lockIdentity.ino,
        },
      );
    }
    rmdirSync(absolute);
  };
  const owner: LockOwner = Object.freeze({
    pid: process.pid,
    process_start_time: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    host: hostname(),
  });
  const ownerBytes = `${JSON.stringify(owner)}\n`;
  const ownerPath = `${DREAM_PHASE_LOCK_PATH}/owner.json`;
  try {
    if (publishCreateOnly(root, ownerPath, ownerBytes) !== 'created') {
      throw workspaceFailure(
        'WRITE_CONFLICT',
        `Dream-phase lock owner at '${ownerPath}' was not exclusively created.`,
        'Remove the untrusted lock only after confirming no dream writer is active.',
        { path: ownerPath },
      );
    }
  } catch (error) {
    try {
      removeAcquiredLock();
    } catch {
      // Preserve the acquired lock when cleanup cannot be proven safe.
    }
    throw error;
  }
  let released = false;
  return Object.freeze({
    release: (): void => {
      if (released) return;
      released = true;
      // Hash-gated: the owner file this process published is the identity token,
      // so a replaced owner is preserved for inspection rather than removed --
      // and the directory removal below then fails loudly rather than silently
      // deleting a lock whose contents are not this process's.
      removeManagedWorkspaceFileIfHash(root, ownerPath, hashWorkspaceBytes(ownerBytes));
      removeAcquiredLock();
    },
  });
}

export type SubjectFenceVerdict = Readonly<{
  lessonAgentKey: string;
  lessonId: string;
  governorCandidateId: string | null;
  governorDecision: LessonDecisionVerb | null;
  governorSubjectSequence: number | null;
  retiredContentHashes: readonly string[];
}>;

export type SubjectCandidate = Readonly<{
  candidateId: string;
  lessonScopeKey: string;
  lessonPurpose: string;
}>;

export type FenceContext = Readonly<{
  fence: SubjectFenceVerdict;
  subjectCandidates: readonly SubjectCandidate[];
}>;

export type FenceOutcome<T> =
  | Readonly<{ outcome: 'completed'; value: T }>
  | Readonly<{ outcome: 'superseded' }>
  | Readonly<{ outcome: 'unverified'; stage: 'pre-phase' | 'post-phase' | 'commit'; reason: string }>;

const HOLD_FENCE_SQL = `
SELECT lesson_agent_key, lesson_id, governor_candidate_id, governor_decision,
       governor_subject_sequence::text AS governor_subject_sequence, retired_content_hashes
  FROM brain_evidence.hold_dream_subject_lock($1)
`;

const VERIFY_GOVERNOR_SQL = `
SELECT lesson_agent_key, lesson_id, governor_candidate_id, governor_decision,
       governor_subject_sequence::text AS governor_subject_sequence
  FROM brain_evidence.verify_dream_subject_governor($1)
`;

const SUBJECT_CANDIDATES_SQL = `
SELECT candidate_id, lesson_scope_key, lesson_purpose
  FROM brain_evidence.dream_candidates
 WHERE lesson_agent_key = $1 AND lesson_id = $2
 ORDER BY recorded_at, candidate_id
`;

type FenceRow = {
  lesson_agent_key: string;
  lesson_id: string;
  governor_candidate_id: string | null;
  governor_decision: LessonDecisionVerb | null;
  governor_subject_sequence: string | null;
  retired_content_hashes: string[] | null;
};

// A LOST FENCE and a BROKEN QUERY are different failures with different
// remedies: the first is the UNVERIFIED contract ("re-run, it converges"), the
// second is a schema or permission defect that a re-run will reproduce forever.
// Mapping both to "the fence connection was lost" would bury the second inside
// the first's remediation, so only the connection classes below become
// UNVERIFIED and everything else keeps its own identity.
//
// Class 08 is PostgreSQL's connection-exception family; 57P01/02/03 are the
// admin-shutdown, crash-shutdown, and cannot-connect-now terminations a killed
// backend raises. The message check covers node-postgres's own client-side
// failures, which carry no SQLSTATE at all.
function isFenceConnectionFailure(error: unknown, captured: unknown): boolean {
  if (captured !== undefined) return true;
  const sqlState = (error as { code?: unknown }).code;
  if (typeof sqlState === 'string'
    && (sqlState.startsWith('08') || sqlState === '57P01' || sqlState === '57P02' || sqlState === '57P03')) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string'
    && /not queryable|connection terminated|terminating connection|socket|ECONNRESET|EPIPE/iu.test(message);
}

export type SubjectFenceHooks = Readonly<{
  afterFenceOpen?: () => Promise<void> | void;
  afterPhaseLock?: () => Promise<void> | void;
  beforeCommit?: () => Promise<void> | void;
}>;

export type SubjectFenceOptions<T> = Readonly<{
  pool: VerifiedBrainPool;
  root: string;
  candidateId: string;
  expectedDecision: LessonDecisionVerb;
  expectedSubjectSequence: number;
  phase: (context: FenceContext) => Promise<T>;
  hooks?: SubjectFenceHooks;
}>;

function fenceMatches(
  row: { governor_candidate_id: string | null; governor_decision: LessonDecisionVerb | null; governor_subject_sequence: string | null },
  candidateId: string,
  decision: LessonDecisionVerb,
  subjectSequence: number,
): boolean {
  return row.governor_candidate_id === candidateId
    && row.governor_decision === decision
    && row.governor_subject_sequence !== null
    && Number(row.governor_subject_sequence) === subjectSequence;
}

// The cross-store serialization boundary. One transaction on a DEDICATED client
// holds the subject advisory lock -- the same frame both decide-broker
// transactions acquire FIRST -- across the whole filesystem phase, so no new
// promote or retire can commit for this subject while the fence lives.
//
// Fence loss is treated in four parts: NEUTRALIZE the self-inflicted server
// timeout class with transaction-local GUCs; DETECT the unpreventable class
// (admin termination, network loss, middleware-owned pooler timeouts) with a
// checked-out-client error listener plus two verifications; VERIFY BEFORE
// MUTATING so a fence lost between fence-open and the phase lock touches no
// byte; and NEVER REPORT SUCCESS for a phase whose fence could not be verified.
export async function withSubjectFence<T>(options: SubjectFenceOptions<T>): Promise<FenceOutcome<T>> {
  const client = await options.pool.connect();
  let capturedError: unknown;
  const captureError = (error: unknown): void => {
    capturedError ??= error;
  };
  client.on('error', captureError);
  let phaseLock: DreamPhaseLock | undefined;
  let released = false;
  const releaseClient = (): void => {
    if (released) return;
    released = true;
    client.removeListener('error', captureError);
    client.release(capturedError instanceof Error ? capturedError : undefined);
  };
  const rollbackTolerated = async (): Promise<void> => {
    await (client.query('ROLLBACK') as Promise<unknown>).catch(() => {});
  };
  const verify = async (
    stage: 'pre-phase' | 'post-phase',
  ): Promise<FenceOutcome<T> | null> => {
    try {
      const rows = (await client.query<FenceRow>(VERIFY_GOVERNOR_SQL, [options.candidateId])).rows;
      const row = rows[0];
      if (capturedError !== undefined) {
        return { outcome: 'unverified', stage, reason: 'the fence connection reported a failure' };
      }
      if (row === undefined
        || !fenceMatches(row, options.candidateId, options.expectedDecision, options.expectedSubjectSequence)) {
        return { outcome: 'unverified', stage, reason: 'the subject governor changed under the fence' };
      }
      return null;
    } catch (error) {
      if (!isFenceConnectionFailure(error, capturedError)) throw error;
      captureError(error);
      return { outcome: 'unverified', stage, reason: 'the fence connection was lost' };
    }
  };

  try {
    await client.query('BEGIN');
    // Transaction-local, reverted at COMMIT/ROLLBACK, so the override never
    // leaks onto the pooled connection. Both GUCs are PGC_USERSET, so the
    // runtime role may set them with no grant. They are issued as the CLI's OWN
    // statements rather than from inside the fence function on purpose: every
    // SECURITY DEFINER function here pins search_path with a CREATE FUNCTION SET
    // clause, and PostgreSQL restores GUC changes made inside such a function at
    // function exit -- which would silently revert them before the phase began.
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    const version = (await client.query<{ server_version_num: string }>(
      `SELECT current_setting('server_version_num') AS server_version_num`,
    )).rows[0];
    // transaction_timeout is new in PostgreSQL 17 and SET LOCAL of an unknown
    // GUC raises 42704 and poisons the transaction, so the version gate is
    // strictly cleaner than issue-and-tolerate.
    if (version !== undefined && Number(version.server_version_num) >= 170_000) {
      await client.query('SET LOCAL transaction_timeout = 0');
    }

    let fenceRow: FenceRow;
    try {
      const rows = (await client.query<FenceRow>(HOLD_FENCE_SQL, [options.candidateId])).rows;
      const row = rows[0];
      if (row === undefined) {
        throw dreamLifecycleError(
          'BRAIN_DREAM_INTEGRITY',
          'The dream subject fence returned no verdict.',
          { candidate_id: options.candidateId },
        );
      }
      fenceRow = row;
    } catch (error) {
      await rollbackTolerated();
      rethrowDreamLifecycleError(error);
    }

    // Fence 2, authoritative: the broker's own verdict can stale the instant it
    // commits, but this one is read UNDER the held subject lock.
    if (!fenceMatches(
      fenceRow!,
      options.candidateId,
      options.expectedDecision,
      options.expectedSubjectSequence,
    )) {
      await rollbackTolerated();
      return { outcome: 'superseded' };
    }
    await options.hooks?.afterFenceOpen?.();

    const fence: SubjectFenceVerdict = Object.freeze({
      lessonAgentKey: fenceRow!.lesson_agent_key,
      lessonId: fenceRow!.lesson_id,
      governorCandidateId: fenceRow!.governor_candidate_id,
      governorDecision: fenceRow!.governor_decision,
      governorSubjectSequence: fenceRow!.governor_subject_sequence === null
        ? null
        : Number(fenceRow!.governor_subject_sequence),
      retiredContentHashes: Object.freeze([...(fenceRow!.retired_content_hashes ?? [])]),
    });

    // The prefetch is the LAST database read before the phase lock, and it runs
    // on the fence client -- so a fence that died between fence-open and here
    // fails HERE. That is still "before any mutation", so it belongs to the
    // pre-phase UNVERIFIED outcome rather than escaping as a raw driver error:
    // reporting it as a crash would tell an operator nothing about whether the
    // workspace was touched.
    let subjectCandidates: readonly SubjectCandidate[];
    try {
      subjectCandidates = (await client.query<{
        candidate_id: string;
        lesson_scope_key: string;
        lesson_purpose: string;
      }>(SUBJECT_CANDIDATES_SQL, [fence.lessonAgentKey, fence.lessonId])).rows.map((row) =>
        Object.freeze({
          candidateId: row.candidate_id,
          lessonScopeKey: row.lesson_scope_key,
          lessonPurpose: row.lesson_purpose,
        }));
    } catch (error) {
      // A defect here -- a missing relation, a revoked grant -- is not a lost
      // fence and must not inherit its "re-run converges" remedy.
      if (!isFenceConnectionFailure(error, capturedError)) throw error;
      captureError(error);
      await rollbackTolerated();
      return {
        outcome: 'unverified',
        stage: 'pre-phase',
        reason: 'the fence connection was lost',
      };
    }

    // Local acquisition is FAIL-FAST, never a blocking wait: a process holding a
    // local lock must never wait on a database lock, and a busy exit converges
    // on re-run.
    try {
      phaseLock = acquireDreamPhaseLock(options.root);
    } catch (error) {
      await rollbackTolerated();
      throw error;
    }
    await options.hooks?.afterPhaseLock?.();

    const prePhase = await verify('pre-phase');
    if (prePhase !== null) {
      await rollbackTolerated();
      return prePhase;
    }

    const value = await options.phase(Object.freeze({ fence, subjectCandidates }));

    const postPhase = await verify('post-phase');
    if (postPhase !== null) {
      await rollbackTolerated();
      return postPhase;
    }
    await options.hooks?.beforeCommit?.();
    try {
      await client.query('COMMIT');
    } catch (error) {
      captureError(error);
      return {
        outcome: 'unverified',
        stage: 'commit',
        reason: 'the fence transaction could not be committed',
      };
    }
    return { outcome: 'completed', value };
  } catch (error) {
    await rollbackTolerated();
    throw error;
  } finally {
    // NESTED, not sequential: a throwing lock release would otherwise skip the
    // client release and strand both the open transaction and the subject
    // advisory lock, hanging every later pool shutdown.
    try {
      phaseLock?.release();
    } finally {
      releaseClient();
    }
  }
}

export type MaterializationResult = Readonly<{
  status: 'converged' | 'created' | 'replaced';
  path: string;
  qualifiedId: string;
  contentHash: string;
  repairs: readonly string[];
}>;

export class LessonMaterializationConflict extends Error {
  readonly code = 'LESSON_MATERIALIZATION_CONFLICT';
  readonly details: Record<string, string>;

  constructor(message: string, details: Record<string, string>) {
    super(message);
    this.name = 'LessonMaterializationConflict';
    this.details = details;
  }
}

export class LessonRetirementConflict extends Error {
  readonly code = 'LESSON_RETIREMENT_CONFLICT';
  readonly details: Record<string, string>;

  constructor(message: string, details: Record<string, string>) {
    super(message);
    this.name = 'LessonRetirementConflict';
    this.details = details;
  }
}

function scopeOfLessonScopeKey(lessonScopeKey: string): WorkspaceScope {
  return lessonTargetScope(lessonScopeKey);
}

function sameScope(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type MaterializeHooks = Readonly<{
  afterScaffold?: () => Promise<void> | void;
  afterRepair?: () => Promise<void> | void;
  // The F-6a failpoint: a SYNCHRONOUS seam between the repair arm's membership
  // removal and its file removal. It is synchronous because it sits inside a
  // workspace-lock callback, and a test simulates the crash by throwing.
  afterRepairMembershipRemoval?: () => void;
}>;

export type RepairContext = Readonly<{
  root: string;
  paths: LessonPaths;
  lessonId: string;
  targetScope: WorkspaceScope;
  expectedQualifiedId: string;
  governorCandidateId: string;
  subjectCandidates: readonly SubjectCandidate[];
  retiredContentHashes: readonly string[];
  hooks?: MaterializeHooks;
}>;

// The membership-PRESENT arm: authenticate-then-mutate. All four clauses must
// hold BEFORE any mutation, and any failure preserves BOTH the file and the
// registration and reports a named conflict. The provenance rule here is the
// STRICT one -- the bytes must be the REGISTERED entry's own rendered stub or a
// committed retired governor's recorded content -- because this arm can destroy a
// registration, and matching an arbitrary sibling's stub would prove nothing
// about who registered this entry.
// Exported for the failpoint matrix: the per-clause authentication tests drive
// the REAL arm rather than a re-implementation, because the whole point of the
// clauses is that they refuse states a re-implementation would not reproduce.
export function repairWrongScopeRegistration(
  context: RepairContext,
  details: Record<string, unknown>,
): void {
  const { root, paths } = context;
  const kind = details.kind;
  const qualifiedId = details.qualifiedId;
  const existingScope = details.existingScope;
  const requestedScope = details.requestedScope;
  const conflict = (clause: string): never => {
    throw new LessonMaterializationConflict(
      `The lesson at ${paths.lessonPath} could not be authenticated as recoverable residue (${clause}).`,
      {
        clause,
        path: paths.lessonPath,
        candidate_id: context.governorCandidateId,
        remedy: 'A human reconciles: retire the lesson, or move or adopt the conflicting file, then re-run promote.',
      },
    );
  };
  // Clause (a): authenticate the ERROR ITSELF. DUPLICATE_IDENTITY has seven raise
  // sites across the registry, the record layer, and the plan layer; only the
  // scaffold scope-mismatch branch carries this exact four-key details shape, so
  // the code alone is insufficient and the shape is what identifies the branch.
  if (Object.keys(details).sort().join(',') !== 'existingScope,kind,qualifiedId,requestedScope') {
    conflict('a:details-shape');
  }
  if (kind !== 'lesson') conflict('a:kind');
  if (qualifiedId !== context.expectedQualifiedId) conflict('a:qualified-id');
  if (!sameScope(requestedScope, context.targetScope)) conflict('a:requested-scope');
  if (existingScope === undefined || existingScope === null) conflict('a:existing-scope');
  if (sameScope(existingScope, requestedScope)) conflict('a:scopes-equal');

  withWorkspaceLock(root, () => {
    const agentBytes = readWorkspaceFile(root, paths.agentPath);
    const agent = parseAgentDefinition(agentBytes.toString('utf8'), paths.agentPath);
    if (!agent.lessons.includes(context.lessonId)) conflict('b:membership-absent');
    let fileBytes: Buffer;
    try {
      fileBytes = readWorkspaceFile(root, paths.lessonPath);
    } catch {
      return conflict('b:file-absent');
    }
    const parsed = parseMarkdownDefinition(fileBytes.toString('utf8'), paths.lessonPath);
    if (parsed.id !== context.lessonId || parsed.kind !== 'lesson') conflict('b:identity');
    // The registry walk fixes function and agent; only the PLAN component is
    // re-derived from the file's own frontmatter, mirroring how the registry
    // itself resolves a registered lesson's actual scope.
    const functionId = context.targetScope.function ?? '';
    const agentId = context.targetScope.agent ?? '';
    const rederived: WorkspaceScope = parsed.scope.plan === undefined
      ? { function: functionId, agent: agentId }
      : { function: functionId, agent: agentId, plan: parsed.scope.plan };
    if (!sameScope(rederived, existingScope)) conflict('b:scope-changed');
    if (sameScope(rederived, context.targetScope)) conflict('b:scope-changed');

    const fileHash = hashWorkspaceBytes(fileBytes);
    const registeredStub = context.subjectCandidates
      .filter((candidate) => sameScope(scopeOfLessonScopeKey(candidate.lessonScopeKey), rederived))
      .map((candidate) => renderMarkdownDefinition(
        'lesson',
        context.lessonId,
        candidate.lessonPurpose,
        rederived,
      ))
      .find((rendered) => hashWorkspaceBytes(rendered) === fileHash);
    const retiredMatch = context.retiredContentHashes.find((hash) => hash === fileHash);
    if (registeredStub === undefined && retiredMatch === undefined) conflict('c:provenance');

    const provenanceCandidate = context.subjectCandidates.find((candidate) =>
      sameScope(scopeOfLessonScopeKey(candidate.lessonScopeKey), rederived));
    if (provenanceCandidate !== undefined
      && provenanceCandidate.candidateId === context.governorCandidateId) {
      conflict('d:registrant-is-governor');
    }

    replaceWorkspaceFile(
      root,
      paths.agentPath,
      removeYamlMembership(agentBytes.toString('utf8'), paths.agentPath, 'lessons', context.lessonId),
      { expectedHash: hashWorkspaceBytes(agentBytes) },
    );
    // A crash HERE leaves an UNREGISTERED stale stub. That is convergent, not
    // stranded: the replay's scaffold no longer sees membership, reaches
    // publishCreateOnly, and raises the publish WRITE_CONFLICT the widened
    // membership-absent arm authenticates and removes.
    context.hooks?.afterRepairMembershipRemoval?.();
    removeManagedWorkspaceFileIfHash(root, paths.lessonPath, fileHash);
  });
}

// The membership-ABSENT arm, widened: with no registration present there is
// nothing a removal can destroy, so bytes that are provably recorded-derivable
// residue -- a committed retired governor's recorded content, or the deterministic
// rendered stub of ANY known subject candidate at that candidate's own declared
// scope -- are removed and the path is recreated create-only by the proven
// governor. Provenance strictness scales with what the mutation can destroy;
// foreign bytes remain the human boundary.
export function repairUnregisteredResidue(
  context: RepairContext,
  details: Record<string, unknown>,
): void {
  const { root, paths } = context;
  const conflict = (clause: string, extra: Record<string, string> = {}): never => {
    throw new LessonMaterializationConflict(
      `The lesson at ${paths.lessonPath} could not be authenticated as recoverable residue (${clause}).`,
      {
        clause,
        path: paths.lessonPath,
        candidate_id: context.governorCandidateId,
        ...extra,
        remedy: 'A human reconciles: retire the lesson, or move or adopt the conflicting file, then re-run promote.',
      },
    );
  };
  // WRITE_CONFLICT is a BROAD code inside scaffold: it is also raised when a
  // publication's state is uncertain, when the parent registry replacement
  // fails, and when a lock's owner file changed -- and the registry deliberately
  // PRESERVES the published child whenever the parent's commit state cannot be
  // proven, which means membership may already be committed. Entering this arm
  // on the code alone would let it delete recorded-derivable bytes out from
  // under a live registration. Only the exact publish conflict -- which carries
  // this three-key shape at THIS path and is raised strictly BEFORE any parent
  // mutation -- dispatches here; every other WRITE_CONFLICT is the named
  // conflict with both file and membership preserved.
  const keys = Object.keys(details).sort().join(',');
  if (keys !== 'actualHash,expectedHash,path') conflict('x:details-shape');
  if (details.path !== paths.lessonPath) conflict('x:path');
  withWorkspaceLock(root, () => {
    // Re-proved UNDER the lock, immediately before any mutation: the arm's whole
    // licence to delete is that no registration exists to destroy.
    let agent;
    try {
      agent = parseAgentDefinition(readWorkspaceText(root, paths.agentPath), paths.agentPath);
    } catch {
      return conflict('x:agent-unreadable');
    }
    if (agent.lessons.includes(context.lessonId)) conflict('x:membership-present');
    let fileBytes: Buffer;
    try {
      fileBytes = readWorkspaceFile(root, paths.lessonPath);
    } catch {
      return;
    }
    const fileHash = hashWorkspaceBytes(fileBytes);
    const retiredMatch = context.retiredContentHashes.find((hash) => hash === fileHash);
    if (retiredMatch !== undefined) {
      removeManagedWorkspaceFileIfHash(root, paths.lessonPath, retiredMatch);
      return;
    }
    for (const candidate of context.subjectCandidates) {
      const rendered = renderMarkdownDefinition(
        'lesson',
        context.lessonId,
        candidate.lessonPurpose,
        scopeOfLessonScopeKey(candidate.lessonScopeKey),
      );
      if (hashWorkspaceBytes(rendered) === fileHash) {
        removeManagedWorkspaceFileIfHash(root, paths.lessonPath, fileHash);
        return;
      }
    }
    return conflict('x:provenance', { actual_hash: fileHash });
  });
}

export type MaterializeLessonOptions = Readonly<{
  root: string;
  candidate: DreamCandidateBinding;
  context: FenceContext;
  hooks?: MaterializeHooks;
}>;

// The filesystem phase. Synchronous within each sub-step, with NO database call
// between entering a workspace-lock callback and its return: every database fact
// this phase needs was fetched on the fence client before the first local lock,
// which is legal precisely because the held subject lock keeps those facts stable.
export async function materializeLesson(
  options: MaterializeLessonOptions,
): Promise<MaterializationResult> {
  const { root, candidate } = options;
  const targetScope = lessonTargetScope(candidate.lessonScopeKey);
  const subject = lessonSubjectOf(candidate.lessonScopeKey);
  const paths = resolveLessonPaths(root, candidate.lessonAgentKey, candidate.lessonId);
  const rendered = renderLessonContent(
    candidate.lessonId,
    candidate.lessonPurpose,
    candidate.lessonBody,
    targetScope,
  );
  const repairContext: RepairContext = Object.freeze({
    root,
    paths,
    lessonId: candidate.lessonId,
    targetScope,
    expectedQualifiedId: subject.qualifiedIdOf(candidate.lessonId),
    governorCandidateId: candidate.candidateId,
    subjectCandidates: options.context.subjectCandidates,
    retiredContentHashes: options.context.fence.retiredContentHashes,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  const repairs: string[] = [];

  const scaffold = (): void => {
    scaffoldWorkspace(root, {
      kind: 'lesson',
      id: candidate.lessonId,
      scope: candidate.lessonScopeKey,
      purpose: candidate.lessonPurpose,
    });
  };

  try {
    scaffold();
  } catch (error) {
    if (!isWorkspaceFailure(error)) throw error;
    if (error.code === 'DUPLICATE_IDENTITY') {
      repairWrongScopeRegistration(repairContext, error.details as Record<string, unknown>);
      repairs.push('wrong-scope-registration');
      await options.hooks?.afterRepair?.();
      scaffold();
    } else if (error.code === 'WRITE_CONFLICT') {
      repairUnregisteredResidue(repairContext, error.details as Record<string, unknown>);
      repairs.push('unregistered-residue');
      await options.hooks?.afterRepair?.();
      scaffold();
    } else {
      throw error;
    }
  }
  await options.hooks?.afterScaffold?.();

  const status = withWorkspaceLock(root, (): MaterializationResult['status'] => {
    const current = readWorkspaceFile(root, paths.lessonPath);
    const currentHash = hashWorkspaceBytes(current);
    if (currentHash === rendered.contentHash) return 'converged';
    if (currentHash === rendered.stubHash) {
      replaceWorkspaceFile(root, paths.lessonPath, rendered.content, { expectedHash: currentHash });
      return 'created';
    }
    // A predecessor governor whose own filesystem phase was skipped can still
    // own these bytes; the retired list is walked newest-first and the first
    // exact match wins. The converged arm above fires first, so this can never
    // reach the current governor's own re-promoted content.
    const retired = options.context.fence.retiredContentHashes.find((hash) => hash === currentHash);
    if (retired !== undefined) {
      replaceWorkspaceFile(root, paths.lessonPath, rendered.content, { expectedHash: retired });
      return 'replaced';
    }
    throw new LessonMaterializationConflict(
      `The file at ${paths.lessonPath} does not hold this lesson's stub or any recorded content.`,
      {
        path: paths.lessonPath,
        candidate_id: candidate.candidateId,
        expected_hash: rendered.contentHash,
        actual_hash: currentHash,
        remedy: 'A human reconciles: retire the lesson, or move or adopt the conflicting file, then re-run promote.',
      },
    );
  });

  // Scoped to what THIS phase owes. The validator's workspace-wide checks --
  // generated host activation, the vendor-skill map, unrelated plans -- can be
  // failing for reasons a lesson promotion neither caused nor can fix, and this
  // runs AFTER the mutation: a global verdict would report a file that is
  // already converged as an unresolvable conflict on every re-run. Errors that
  // name the lesson or its owning agent record are exactly the ones
  // materialization is answerable for.
  const owned = validateWorkspace(root, { target: subject.qualifiedIdOf(candidate.lessonId) })
    .diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .filter((diagnostic) => diagnostic.path === paths.lessonPath
      || diagnostic.path === paths.agentPath);
  if (owned.length > 0) {
    throw new LessonMaterializationConflict(
      `The materialized lesson at ${paths.lessonPath} does not validate.`,
      {
        path: paths.lessonPath,
        candidate_id: candidate.candidateId,
        diagnostic: owned[0]!.code,
        detail: owned[0]!.message,
        remedy: 'Run roster validate, resolve the reported diagnostics, then re-run promote.',
      },
    );
  }
  const finalHash = hashWorkspaceBytes(readWorkspaceFile(root, paths.lessonPath));
  if (finalHash !== rendered.contentHash) {
    throw new LessonMaterializationConflict(
      `The published lesson at ${paths.lessonPath} does not match its recorded content hash.`,
      {
        path: paths.lessonPath,
        candidate_id: candidate.candidateId,
        expected_hash: rendered.contentHash,
        actual_hash: finalHash,
        remedy: 'Retire the lesson and re-promote it; roster brain doctor stays red until the file matches.',
      },
    );
  }
  return Object.freeze({
    status,
    path: paths.lessonPath,
    qualifiedId: subject.qualifiedIdOf(candidate.lessonId),
    contentHash: rendered.contentHash,
    repairs: Object.freeze(repairs),
  });
}

export type RetirementResult = Readonly<{
  status: 'retired' | 'already-absent';
  path: string;
  removedMembership: boolean;
  removedFile: boolean;
}>;

// MEMBERSHIP FIRST. The dangerous intermediate is a SELECTABLE retired lesson:
// deregistering stops context selection immediately and downgrades the orphan
// file to a soft unregistered-record diagnostic, while the reverse order leaves a
// registered-but-missing lesson that makes every agent load fail hard. Both steps
// are hash-gated and idempotent, so every intermediate converges on re-run.
export async function retireLesson(options: Readonly<{
  root: string;
  candidate: DreamCandidateBinding;
  lessonContentHash: string;
  hooks?: Readonly<{ afterMembership?: () => Promise<void> | void }>;
}>): Promise<RetirementResult> {
  const { root, candidate } = options;
  const paths = resolveLessonPaths(root, candidate.lessonAgentKey, candidate.lessonId);
  const outcome = withWorkspaceLock(root, (): { removedMembership: boolean; removedFile: boolean } => {
    const agentBytes = readWorkspaceFile(root, paths.agentPath);
    const agentText = agentBytes.toString('utf8');
    const updated = removeYamlMembership(agentText, paths.agentPath, 'lessons', candidate.lessonId);
    const removedMembership = updated !== agentText;
    if (removedMembership) {
      replaceWorkspaceFile(root, paths.agentPath, updated, {
        expectedHash: hashWorkspaceBytes(agentBytes),
      });
    }
    let removedFile = false;
    try {
      removedFile = removeManagedWorkspaceFileIfHash(root, paths.lessonPath, options.lessonContentHash);
    } catch (error) {
      if (isWorkspaceFailure(error) && error.code === 'WRITE_CONFLICT') {
        throw new LessonRetirementConflict(
          `The lesson file at ${paths.lessonPath} no longer holds the promoted content and was left in place.`,
          {
            path: paths.lessonPath,
            candidate_id: candidate.candidateId,
            expected_hash: options.lessonContentHash,
            remedy: 'A human reconciles the drifted file; the membership is already removed, so the lesson is no longer selected.',
          },
        );
      }
      throw error;
    }
    return { removedMembership, removedFile };
  });
  await options.hooks?.afterMembership?.();
  // Same scoping as promote: the retired lesson no longer exists as a record, so
  // the target is its owning AGENT, and only errors naming the lesson path or
  // that agent record are this verb's to answer for.
  const owned = validateWorkspace(root, { target: candidate.lessonAgentKey })
    .diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .filter((diagnostic) => diagnostic.path === paths.lessonPath
      || diagnostic.path === paths.agentPath);
  if (owned.length > 0) {
    throw new LessonRetirementConflict(
      `The retired lesson at ${paths.lessonPath} left the workspace invalid.`,
      {
        path: paths.lessonPath,
        candidate_id: candidate.candidateId,
        diagnostic: owned[0]!.code,
        detail: owned[0]!.message,
        remedy: 'Run roster validate and resolve the reported diagnostics.',
      },
    );
  }
  return Object.freeze({
    status: outcome.removedMembership || outcome.removedFile ? 'retired' : 'already-absent',
    path: paths.lessonPath,
    removedMembership: outcome.removedMembership,
    removedFile: outcome.removedFile,
  });
}

export function isLessonLifecycleConflict(
  error: unknown,
): error is LessonMaterializationConflict | LessonRetirementConflict {
  return error instanceof LessonMaterializationConflict
    || error instanceof LessonRetirementConflict;
}
