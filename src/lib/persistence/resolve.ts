import { countPending, scanPending, type PendingItem } from '../pending.ts';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  NotConfiguredError,
  VersionSkewError,
  WorkspaceMismatchError,
  type ArtifactDeclaration,
  type ArtifactMeta,
  type ArtifactPutResult,
  type ArtifactRecord,
  type ArtifactStore,
  type CountResult,
  type Cursor,
  type DeclarationPutResult,
  type ExternalArtifactInput,
  type HitlDecisionEnvelope,
  type HitlDecisionInput,
  type HitlDecisionOutcome,
  type HitlExpiryCandidate,
  type HitlGenerationSummary,
  type HitlReplaceInput,
  type HitlRequestEnvelope,
  type HitlRequestFilter,
  type HitlRequestInput,
  type HitlVersionRecord,
  type HitlWriteOutcome,
  type HitlStore,
  type InternalDeclarationInput,
  type OpsBackend,
  type Page,
  type ReadOpts,
  type RunEventEnvelope,
  type RunEventInput,
  type RunFilter,
  type RunStore,
  type RunSummary,
  type WriteOutcome,
} from './contracts.ts';
import { externalDeclarationParts, internalDeclarationParts } from './artifact-declarations.ts';
import { classifyDeliveryError } from './error-classify.ts';
import {
  hitlExpiryOf,
  loadPersistenceConfig,
  type LocalPersistenceConfig,
  type PostgresS3PersistenceConfig,
} from './config-schema.ts';
import {
  assertOperationSupported,
  collectComponentSkew,
  localBackendInfo,
  type BackendInfo,
  type OpsOperation,
} from './capabilities.ts';
import { createLocalBackend, type LocalOpsBackend } from './local/stores.ts';
import { LocalLedger } from './local/ledger.ts';
import { LocalOutbox, type DrainReport } from './outbox.ts';
import { BoundPool, verifyBinding, type BindingRecord, type CanonicalObjectTuple } from './postgres/binding.ts';
import { BRAIN_ENV_BINDING, OPS_ENV_BINDING, type RoleEnvBinding } from './pool.ts';
import {
  createPgBackend,
  pgBackendInfo,
  artifactParts,
  runEventParts,
  type PgOpsBackend,
} from './postgres/stores.ts';
import {
  overlayArtifactGet,
  overlayArtifactHead,
  overlayDeclarationGet,
  overlayDeclarationsByRun,
  overlayRunGet,
  overlayRunsCount,
  overlayRunsList,
  requireReadDigest,
  requireReadId,
} from './overlay-reads.ts';
import {
  CreateOnlyFileStore,
  S3ObjectTarget,
  verifyWorkspaceMarker,
  workspaceMarkerSha256,
  type CreateOnlyObjectStore,
} from './objects.ts';
import { createS3FileStore, type FileStore } from './s3-core.ts';
import { opsRootPath, readSetupJournal, setupJournalPath, type SetupJournal } from './setup-journal.ts';

// resolveOpsBackend(cwd) — the section-I integration seam #320/#321 consume.
// One factory, five states. A TRANSPORT failure during postgres-s3 resolution
// degrades (spoolable writes queue to the outbox; reads fail BackendUnavailable
// unless allowPartial serves the overlay); a KNOWN mismatch —
// WorkspaceMismatch, marker digest mismatch, config-vs-DB tuple mismatch,
// NotConfigured, and pg AUTH failures (bad credentials are config errors, not
// outages) — fails hard WITHOUT queuing: spooling toward a wrong-workspace
// target is never allowed. Component version skew is recorded (doctor-visible)
// and enforced per-operation — a future hitl version never blocks
// runs.appendEvent. The remote targets carry a preflight that revalidates
// binding + marker once per drain batch, before any remote I/O.

export function opsRootFor(cwd: string): string {
  return opsRootPath(cwd);
}

// ---------- legacy adapter (read-only over today's pending files) ----------

// The narrow seam the four current consumers (review.ts, pending-sync.ts,
// banner.sh, /inbox) will be converted onto in #320/#321. Strictly read-only:
// listing + counting only — approve/reject/rename stay with pending-apply.ts
// until the cutover ticket swaps implementations behind this interface.
export interface LegacyPendingReader {
  items(fn?: string): PendingItem[];
  count(): number;
}

export class LegacyFilesAdapter implements LegacyPendingReader {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  items(fn?: string): PendingItem[] {
    return scanPending(this.cwd, fn);
  }

  count(): number {
    return countPending(this.cwd);
  }
}

// ---------- capability gating (section H: assert before any operation) ----------

function gate<A extends unknown[], R>(
  info: BackendInfo,
  operation: OpsOperation,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    assertOperationSupported(info, operation);
    return await fn(...args);
  };
}

export function withCapabilityGate(backend: OpsBackend, info: BackendInfo): OpsBackend {
  const { hitl, runs, artifacts } = backend;
  return {
    backend: backend.backend,
    workspaceId: backend.workspaceId,
    hitl: {
      createRequest: gate(info, 'hitl.createRequest', hitl.createRequest.bind(hitl)),
      replaces: gate(info, 'hitl.replaces', hitl.replaces.bind(hitl)),
      appendDecision: gate(info, 'hitl.appendDecision', hitl.appendDecision.bind(hitl)),
      getRequest: gate(info, 'hitl.getRequest', hitl.getRequest.bind(hitl)),
      listRequests: gate(info, 'hitl.listRequests', hitl.listRequests.bind(hitl)),
      count: gate(info, 'hitl.count', hitl.count.bind(hitl)),
      listVersions: gate(info, 'hitl.listVersions', hitl.listVersions.bind(hitl)),
      listGenerations: gate(info, 'hitl.listGenerations', hitl.listGenerations.bind(hitl)),
      listDecisions: gate(info, 'hitl.listDecisions', hitl.listDecisions.bind(hitl)),
      listExpiryCandidates: gate(info, 'hitl.sweepExpired', hitl.listExpiryCandidates.bind(hitl)),
      insertSystemExpiry: gate(info, 'hitl.sweepExpired', hitl.insertSystemExpiry.bind(hitl)),
    },
    runs: {
      appendEvent: gate(info, 'runs.appendEvent', runs.appendEvent.bind(runs)),
      getRun: gate(info, 'runs.getRun', runs.getRun.bind(runs)),
      listRuns: gate(info, 'runs.listRuns', runs.listRuns.bind(runs)),
      count: gate(info, 'runs.count', runs.count.bind(runs)),
    },
    artifacts: {
      putArtifact: gate(info, 'artifacts.putArtifact', artifacts.putArtifact.bind(artifacts)),
      getArtifact: gate(info, 'artifacts.getArtifact', artifacts.getArtifact.bind(artifacts)),
      head: gate(info, 'artifacts.head', artifacts.head.bind(artifacts)),
      putExternal: gate(info, 'artifacts.putExternal', artifacts.putExternal.bind(artifacts)),
      getByRun: gate(info, 'artifacts.getByRun', artifacts.getByRun.bind(artifacts)),
      getDeclaration: gate(info, 'artifacts.getDeclaration', artifacts.getDeclaration.bind(artifacts)),
    },
  };
}

// ---------- degraded stores (transport down; spoolable writes queue) ----------

function readsUnavailable(reason: string): never {
  throw new BackendUnavailableError(
    `the postgres-s3 backend is unreachable (${reason}) — reads and counts require the live store (pass allowPartial for an overlay-only answer); queued writes drain when connectivity returns`,
  );
}

// Reads are overlay-only by construction (the live store is unreachable): every
// read delegates to the SAME shared overlay pager the healthy backend's
// allowPartial fallback uses (overlay-reads.ts), so local↔PG partial semantics
// stay identical (#318 R4 finding 4). Writes spool to the outbox; HITL
// decisions fail closed (owner decision 8).

// #319 owner decision 6: HITL is FAIL-CLOSED end to end. Both writes require the
// live store (nothing is ever spooled — the enqueue guard refuses the whole
// namespace), and reads throw rather than answer from a partial view: there is
// no queued HITL overlay to serve, and an approval system that reports "nothing
// awaiting" from an incomplete picture is worse than one that admits it cannot
// answer. `allowPartial` is deliberately not honored here.
class DegradedHitlStore implements HitlStore {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  private closed(): never {
    throw new BackendUnavailableError(
      `HITL requires the live store and is never served from a partial view — the backend is unreachable (${this.reason}); restore connectivity and retry`,
    );
  }

  async createRequest(_input: HitlRequestInput): Promise<HitlWriteOutcome> {
    this.closed();
  }

  async replaces(_input: HitlReplaceInput): Promise<HitlWriteOutcome> {
    this.closed();
  }

  async appendDecision(_input: HitlDecisionInput): Promise<HitlDecisionOutcome> {
    this.closed();
  }

  async getRequest(id: string): Promise<HitlRequestEnvelope | null> {
    requireReadId('id', id);
    this.closed();
  }

  async listRequests(_filter: HitlRequestFilter, _cursor?: Cursor): Promise<Page<HitlRequestEnvelope>> {
    this.closed();
  }

  async count(_filter?: HitlRequestFilter): Promise<CountResult> {
    this.closed();
  }

  async listVersions(id: string): Promise<HitlVersionRecord[]> {
    requireReadId('id', id);
    this.closed();
  }

  async listGenerations(id: string): Promise<HitlGenerationSummary[]> {
    requireReadId('id', id);
    this.closed();
  }

  async listDecisions(id: string): Promise<HitlDecisionEnvelope[]> {
    requireReadId('id', id);
    this.closed();
  }

  async listExpiryCandidates(_now: number, _limit: number): Promise<HitlExpiryCandidate[]> {
    this.closed();
  }

  async insertSystemExpiry(_candidate: HitlExpiryCandidate, _now: number): Promise<'expired' | 'conflict'> {
    this.closed();
  }
}

class DegradedRunStore implements RunStore {
  private readonly workspaceId: string;
  private readonly outbox: LocalOutbox;
  private readonly reason: string;
  private readonly now: () => number;
  private readonly pid: () => string;

  constructor(workspaceId: string, outbox: LocalOutbox, reason: string, now: () => number, pid: () => string) {
    this.workspaceId = workspaceId;
    this.outbox = outbox;
    this.reason = reason;
    this.now = now;
    this.pid = pid;
  }

  async appendEvent(input: RunEventInput): Promise<WriteOutcome> {
    const { id, payload, observations } = runEventParts(this.workspaceId, input, {
      now: this.now(),
      pid: this.pid(),
    });
    const res = this.outbox.enqueue({ namespace: 'runs', id, kind: 'run-event', payload, observations });
    return { outcome: 'queued', id: res.id };
  }

  async getRun(runId: string, opts?: ReadOpts): Promise<{ runId: string; events: RunEventEnvelope[] } | null> {
    requireReadId('runId', runId);
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return overlayRunGet(this.outbox, this.workspaceId, runId);
  }

  async listRuns(filter: RunFilter, cursor?: Cursor, opts?: ReadOpts): Promise<Page<RunSummary>> {
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return overlayRunsList(this.outbox, this.workspaceId, filter, cursor);
  }

  async count(filter?: RunFilter, opts?: ReadOpts): Promise<CountResult> {
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return { committed: 0, queued: overlayRunsCount(this.outbox, filter), partial: true };
  }
}

class DegradedArtifactStore implements ArtifactStore {
  private readonly workspaceId: string;
  private readonly outbox: LocalOutbox;
  private readonly reason: string;

  constructor(workspaceId: string, outbox: LocalOutbox, reason: string) {
    this.workspaceId = workspaceId;
    this.outbox = outbox;
    this.reason = reason;
  }

  async putArtifact(meta: ArtifactMeta, bytes: Uint8Array, decl?: InternalDeclarationInput): Promise<ArtifactPutResult> {
    const { id, payload, digest, observations } = artifactParts(this.workspaceId, meta, bytes);
    // Derive + snapshot the COMPLETE declaration (role/agent/types AND the
    // provenance canonical serialization) BEFORE spooling any bytes, so a bad
    // field OR unserializable (circular) provenance throws with NO side effect
    // (finding: validation ran AFTER the spool — a bad declaration left a durable
    // queued upload orphaned). object_version_id is unknown while degraded, so
    // version_state stays 'unverified'.
    const declParts =
      decl !== undefined ? internalDeclarationParts(this.workspaceId, digest, decl, 'unverified') : undefined;
    // …and that 'unverified' is a PLACEHOLDER, not a verdict: mark the
    // declaration version-pending so the materializing store derives the real
    // state from the committed blob row when this spool drains (round-7 finding
    // 5 — parity with the healthy backend's queued write-through path).
    if (declParts !== undefined) declParts.observations.versionPending = true;
    const res = this.outbox.enqueueArtifact(
      { namespace: 'artifacts', id, kind: 'artifact', payload, observations },
      bytes,
    );
    let declarationId: string | null = null;
    if (declParts !== undefined) {
      // Blob enqueued first (earlier producerSeq → drains first); the declaration
      // references it and converges on drain.
      this.outbox.enqueue({
        namespace: 'artifacts',
        id: declParts.id,
        kind: 'artifact-declaration',
        payload: declParts.payload,
        observations: declParts.observations,
      });
      declarationId = declParts.id;
    }
    return {
      outcome: 'queued',
      id: res.id,
      digest,
      objectVersionId: null,
      declarationId,
      blobOutcome: 'queued',
      declarationOutcome: decl !== undefined ? 'queued' : null,
    };
  }

  async putExternal(meta: ExternalArtifactInput): Promise<DeclarationPutResult> {
    const parts = externalDeclarationParts(this.workspaceId, meta);
    const res = this.outbox.enqueue({
      namespace: 'artifacts',
      id: parts.id,
      kind: 'artifact-declaration',
      payload: parts.payload,
      observations: parts.observations,
    });
    return { outcome: 'queued', id: res.id };
  }

  async getByRun(runId: string, opts?: ReadOpts): Promise<ArtifactDeclaration[]> {
    requireReadId('runId', runId);
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return overlayDeclarationsByRun(this.outbox, this.workspaceId, runId);
  }

  async getDeclaration(id: string, opts?: ReadOpts): Promise<ArtifactDeclaration | null> {
    requireReadId('id', id);
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return overlayDeclarationGet(this.outbox, this.workspaceId, id);
  }

  async getArtifact(digest: string, opts?: ReadOpts): Promise<{ record: ArtifactRecord; bytes: Buffer } | null> {
    requireReadDigest(digest);
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return overlayArtifactGet(this.outbox, this.workspaceId, digest);
  }

  async head(digest: string, opts?: ReadOpts): Promise<ArtifactRecord | null> {
    requireReadDigest(digest);
    if (opts?.allowPartial !== true) readsUnavailable(this.reason);
    return overlayArtifactHead(this.outbox, this.workspaceId, digest);
  }
}

// ---------- the resolved union ----------

export type SetupJournalInfo = {
  path: string;
  workspaceId: string;
  workspaceName: string;
  backend: 'local' | 'postgres-s3';
  phase: SetupJournal['phase'];
  remedy: string;
};

export type ResolvedOpsBackend =
  | { state: 'legacy'; adapter: LegacyFilesAdapter }
  | { state: 'setup-incomplete'; journal: SetupJournalInfo }
  | {
      state: 'local';
      config: LocalPersistenceConfig;
      backend: OpsBackend;
      ledger: LocalLedger;
      info: BackendInfo;
      // Doctor-visible component version skew — enforced per-operation, never
      // a wholesale resolution refusal (components negotiate independently).
      skew: string[];
    }
  | {
      state: 'postgres-s3';
      config: PostgresS3PersistenceConfig;
      backend: OpsBackend;
      remote: PgOpsBackend['remote'];
      pool: BoundPool;
      objects: CreateOnlyObjectStore;
      outbox: LocalOutbox;
      binding: BindingRecord;
      info: BackendInfo;
      skew: string[];
      close: () => Promise<void>;
    }
  | {
      state: 'degraded';
      config: PostgresS3PersistenceConfig;
      backend: OpsBackend;
      outbox: LocalOutbox;
      reason: string;
      skew: string[];
    };

export type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  // Runtime object-store injection (MemoryFileStore in tests, doctor probes).
  files?: FileStore;
  now?: () => number;
  // Injectable pid seam for the run-event observation columns (tests).
  pid?: () => string;
};

// The LIST-capable admin/read object resolver (#323 object-store extension).
// Repair/doctor enumerate the artifacts/ prefix via CreateOnlyObjectStore.listPrefix
// AND read exact object versions (GetObjectVersion) — capabilities the RESTRICTED
// runtime IAM intentionally lacks (no bucket-wide list, no versioned reads). So it
// resolves with a DISTINCT admin credential pair (finding: runtime and admin used
// the same creds, and the least-privilege policies omitted the version primitives):
//   ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID / ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY
//   (+ optional ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN)
// falling back to the standard AWS_* pair only when the admin pair is unset (a
// single-identity dev convenience — production separates the identities; see the
// IAM matrix in docs/API.md + docs/adr/0004). The runtime object store is
// unchanged. It reuses the SAME object config setup used (bucket/region/endpoint/
// force_path_style from persistence.yaml); tests inject a MemoryFileStore via opts.files.
export type ObjectAdminResolver = (cwd: string, opts?: ResolveOptions) => Promise<CreateOnlyObjectStore>;

// Classify the admin object credentials against the SHARED partial-pair rule —
// the SINGLE source of truth for "how are admin object creds resolved". Both
// adminObjectEnv (the resolve/repair/doctor path) AND `roster ops setup`'s
// object-env resolution (requireSetupEnv + setupObjectEnv) route through this so
// the rule can never drift between them (finding: setup still fell back to AWS_*
// when only ONE ROSTER_OPS_ADMIN_AWS_* value was set, bypassing the strict rule
// adminObjectEnv already enforced).
//
//   - 'admin-pair'   → both admin key AND secret present (a complete triple; the
//                      session token rides only when the admin channel supplies it).
//   - 'aws-fallback' → EVERY ROSTER_OPS_ADMIN_AWS_* field is absent → defer to AWS_*.
//   - THROWS         → a PARTIALLY-set admin pair (key-only, secret-only, or a lone
//                      session token). A typo in one admin var must NEVER silently
//                      select the AWS_* identity (possibly more-privileged).
export type AdminObjectCredKind = 'admin-pair' | 'aws-fallback';

export function classifyAdminObjectCreds(env: NodeJS.ProcessEnv): AdminObjectCredKind {
  const adminKey = env.ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID;
  const adminSecret = env.ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY;
  const adminToken = env.ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN;
  if (adminKey && adminSecret) return 'admin-pair';
  if (adminKey || adminSecret || adminToken) {
    const present = (
      [
        adminKey ? 'ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID' : null,
        adminSecret ? 'ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY' : null,
        adminToken ? 'ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN' : null,
      ] as (string | null)[]
    ).filter((v): v is string => v !== null);
    const missing = (
      [
        adminKey ? null : 'ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID',
        adminSecret ? null : 'ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY',
      ] as (string | null)[]
    ).filter((v): v is string => v !== null);
    throw new RosterError({
      header: 'roster: incomplete admin object credentials',
      body:
        `  A partial admin credential set is configured (${present.join(', ')}) but ` +
        `${missing.join(' + ')} ${missing.length > 1 ? 'are' : 'is'} missing.\n` +
        '  Refusing to fall back to the AWS_* identity — a typo in one admin var must not\n' +
        '  silently select a different (possibly more-privileged) identity.',
      remedy:
        '  Set BOTH ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID and ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY\n' +
        '  (plus optional ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN), or unset every ROSTER_OPS_ADMIN_AWS_* to use AWS_*.',
      exitCode: EXIT_ERROR,
    });
  }
  return 'aws-fallback';
}

// Resolve the admin AWS credential env, preferring the distinct admin pair and
// falling back to the standard pair. Returns an env object whose AWS_* keys carry
// the admin identity (createS3FileStore reads AWS_ACCESS_KEY_ID/SECRET).
//
// The admin credential triple is built PURELY from one source — either all from
// ROSTER_OPS_ADMIN_AWS_* (key, secret, AND session token) OR all from AWS_*
// (finding: admin creds inherited an unrelated runtime STS token). When the
// admin key/secret pair is used, the runtime's AWS_SESSION_TOKEN is DROPPED
// unless a matching ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN is set — a long-lived
// admin key paired with a runtime temp-session token is an invalid mixed triple
// (S3 rejects it), so the runtime token must never bleed into the admin identity.
export function adminObjectEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (classifyAdminObjectCreds(env) === 'admin-pair') {
    const out: NodeJS.ProcessEnv = {
      ...env,
      AWS_ACCESS_KEY_ID: env.ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY,
    };
    // All-three-or-none from the admin source: the admin session token rides
    // ONLY when the admin channel supplies it; a runtime AWS_SESSION_TOKEN is
    // never inherited alongside a long-lived admin key/secret.
    if (env.ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN) {
      out.AWS_SESSION_TOKEN = env.ROSTER_OPS_ADMIN_AWS_SESSION_TOKEN;
    } else {
      delete out.AWS_SESSION_TOKEN;
    }
    return out;
  }
  // aws-fallback: EVERY admin field is absent — require the standard AWS_* pair.
  const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((v) => !env[v]);
  if (missing.length > 0) {
    throw missingEnvError([
      'ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID + ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY (admin repair/doctor creds — list + version reads)',
      ...missing.map((v) => `${v} (fallback)`),
    ]);
  }
  // Fallback: the standard AWS_* triple, kept intact (key + secret + its own
  // session token) — a single-identity dev convenience where runtime == admin.
  return env;
}

export const resolveObjectAdmin: ObjectAdminResolver = async (cwd, opts = {}) => {
  const loaded = loadPersistenceConfig(cwd);
  if (loaded.state !== 'postgres-s3') {
    throw new NotConfiguredError(
      'the list-capable admin/read object store is only available for the postgres-s3 backend (run repair/doctor there)',
    );
  }
  const config = loaded.config;
  const env = opts.env ?? process.env;
  if (opts.files) return new CreateOnlyFileStore(opts.files);
  const files = await createS3FileStore(
    {
      bucket: config.objects.bucket,
      region: config.objects.region,
      endpoint: config.objects.endpoint,
      forcePathStyle: config.objects.force_path_style,
    },
    adminObjectEnv(env),
  );
  return new CreateOnlyFileStore(files);
};

function envBindingFor(config: PostgresS3PersistenceConfig): RoleEnvBinding {
  return config.postgres.database === 'brain' ? BRAIN_ENV_BINDING : OPS_ENV_BINDING;
}

function missingEnvError(vars: string[]): RosterError {
  return new RosterError({
    header: 'roster: postgres-s3 backend env vars missing',
    body: '  Required but not set:\n' + vars.map((v) => `    ${v}`).join('\n'),
    remedy: '  Credentials are env-only (persistence.yaml never holds secrets). Export them and re-run.',
    exitCode: EXIT_ERROR,
  });
}

// The enumerated known-mismatch set (section I): these fail hard without
// queuing. Everything else thrown during remote probing is transport.
function isKnownMismatch(err: unknown): boolean {
  return (
    err instanceof WorkspaceMismatchError ||
    err instanceof VersionSkewError ||
    err instanceof ConflictError ||
    err instanceof InvalidRecordError ||
    err instanceof NotConfiguredError ||
    err instanceof RosterError
  );
}

// Authentication/authorization failures are CONFIG errors (bad credentials,
// missing role, no login), never transport degradation — degrading would queue
// writes forever behind a URL that can never work.
function isPgAuthError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === '28P01' || code === '28000';
}

function pgAuthConfigError(envVar: string, err: unknown): RosterError {
  return new RosterError({
    header: 'roster: postgres authentication failed for the ops backend',
    body: `  ${envVar}: ${(err as Error).message}`,
    remedy:
      '  This is a credential problem, not an outage — nothing was queued.\n' +
      `  Fix the user/password/role in ${envVar} and re-run.`,
    exitCode: EXIT_ERROR,
  });
}

// A non-auth halt from the database (missing privilege 42501, invalid catalog
// 3D000, …) is a config error, never a transport outage — fail hard, no queue.
function dbConfigError(envVar: string, err: unknown): RosterError {
  return new RosterError({
    header: 'roster: the ops database rejected the connection (configuration error)',
    body: `  ${envVar}: ${(err as Error).message}`,
    remedy:
      '  This is a config/permission problem (missing privilege, wrong database), not an outage —\n' +
      `  nothing was queued. Fix ${envVar} (or the runtime grants) and re-run.`,
    exitCode: EXIT_ERROR,
  });
}

// An UNKNOWN error (PG 42703 / schema drift, a stray TypeError) during
// resolution is a programming/schema defect, not a transport outage — fail
// closed rather than degrade writes toward a target a bug will never accept.
function dbUnexpectedError(envVar: string, err: unknown): RosterError {
  return new RosterError({
    header: 'roster: unexpected error from the ops database (failing closed)',
    body: `  ${envVar}: ${(err as Error).message}`,
    remedy:
      '  This is not a recognized transport outage — it looks like a schema/programming defect,\n' +
      `  so nothing was queued (queuing toward a target a bug will never accept would lose data).\n` +
      `  Run 'roster ops doctor', check the ops schema version, and fix ${envVar} or the schema, then re-run.`,
    exitCode: EXIT_ERROR,
  });
}

function objectStoreUnexpectedError(err: unknown): RosterError {
  return new RosterError({
    header: 'roster: unexpected error from the ops object store (failing closed)',
    body: `  ${(err as Error).message}`,
    remedy:
      '  This is not a recognized transport outage — nothing was queued. Investigate the object\n' +
      '  store (endpoint, SDK/version, response shape) and re-run.',
    exitCode: EXIT_ERROR,
  });
}

// AccessDenied / NoSuchBucket / 403 / 404 from the object store are IAM/config
// failures — fail hard so writes never queue toward a target that can never
// accept them. Only connect/network failures degrade (see resolvePostgresS3).
function objectStoreConfigError(err: unknown): RosterError {
  return new RosterError({
    header: 'roster: the ops object store denied access (configuration error)',
    body: `  ${(err as Error).message}`,
    remedy:
      '  This is an object-store permissions/config problem (AccessDenied, NoSuchBucket, …),\n' +
      '  not a transport outage — nothing was queued. Fix the bucket policy/credentials and re-run.',
    exitCode: EXIT_ERROR,
  });
}

function configTupleOf(config: PostgresS3PersistenceConfig): CanonicalObjectTuple {
  return {
    bucket: config.objects.bucket,
    region: config.objects.region,
    endpoint: config.objects.endpoint,
    forcePathStyle: config.objects.force_path_style,
    markerSha256: workspaceMarkerSha256({ workspaceId: config.workspace.id, name: config.workspace.name }),
  };
}

function tuplesEqual(a: CanonicalObjectTuple, b: CanonicalObjectTuple): boolean {
  return (
    a.bucket === b.bucket &&
    a.region === b.region &&
    a.endpoint === b.endpoint &&
    a.forcePathStyle === b.forcePathStyle &&
    a.markerSha256 === b.markerSha256
  );
}

function tupleMismatchDetail(config: CanonicalObjectTuple, db: CanonicalObjectTuple | null): string {
  const show = (t: CanonicalObjectTuple | null): string =>
    t === null
      ? '(none)'
      : `bucket=${t.bucket} region=${t.region ?? '-'} endpoint=${t.endpoint ?? '-'} force_path_style=${t.forcePathStyle} marker_sha256=${t.markerSha256}`;
  return `persistence.yaml object tuple [${show(config)}] does not match the tuple stamped in the database [${show(db)}]`;
}

function buildLocalTree(cwd: string, workspaceId: string, now?: () => number): { ledger: LocalLedger; outbox: LocalOutbox } {
  const ledger = new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId, ...(now ? { now } : {}) });
  const outbox = new LocalOutbox({ ledger, ...(now ? { now } : {}) });
  return { ledger, outbox };
}

async function makeRuntimeFiles(
  config: PostgresS3PersistenceConfig,
  env: NodeJS.ProcessEnv,
  injected: FileStore | undefined,
): Promise<FileStore> {
  if (injected) return injected;
  const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((v) => !env[v]);
  if (missing.length > 0) throw missingEnvError(missing);
  return await createS3FileStore(
    {
      bucket: config.objects.bucket,
      region: config.objects.region,
      endpoint: config.objects.endpoint,
      forcePathStyle: config.objects.force_path_style,
    },
    env,
  );
}

async function resolvePostgresS3(
  cwd: string,
  config: PostgresS3PersistenceConfig,
  opts: ResolveOptions,
): Promise<ResolvedOpsBackend> {
  const env = opts.env ?? process.env;
  const ws = config.workspace;
  const binding = envBindingFor(config);
  const runtimeUrl = env[binding.runtime];
  if (typeof runtimeUrl !== 'string' || runtimeUrl.length === 0) {
    throw missingEnvError([binding.runtime]);
  }
  // The local mirror is surveyed FIRST (offline): component skew in meta.json
  // is recorded here and enforced by the per-operation gates — a future hitl
  // version leaves runs operations fully usable.
  const localInfo = localBackendInfo(opsRootFor(cwd), ws.id);
  const localSkew = collectComponentSkew(localInfo);
  const { outbox } = buildLocalTree(cwd, ws.id, opts.now);
  const files = await makeRuntimeFiles(config, env, opts.files);
  const objects = new CreateOnlyFileStore(files);
  const configTuple = configTupleOf(config);

  const nowFn = opts.now ?? Date.now;
  const pidFn = opts.pid ?? (() => String(process.pid));
  const degraded = (reason: string): ResolvedOpsBackend => {
    const backend: OpsBackend = {
      backend: 'postgres-s3',
      workspaceId: ws.id,
      hitl: new DegradedHitlStore(reason),
      runs: new DegradedRunStore(ws.id, outbox, reason, nowFn, pidFn),
      artifacts: new DegradedArtifactStore(ws.id, outbox, reason),
    };
    return {
      state: 'degraded',
      config,
      backend: withCapabilityGate(backend, localInfo),
      outbox,
      reason,
      skew: localSkew,
    };
  };

  const pool = new BoundPool({ connectionString: runtimeUrl, workspaceId: ws.id });
  const failHard = async (err: unknown): Promise<never> => {
    await pool.end().catch(() => {});
    throw err;
  };

  let dbBinding: BindingRecord;
  try {
    const client = await pool.connect();
    try {
      dbBinding = await verifyBinding(client, ws.id);
    } finally {
      client.release();
    }
  } catch (err) {
    if (isKnownMismatch(err)) return await failHard(err);
    if (isPgAuthError(err)) return await failHard(pgAuthConfigError(binding.runtime, err));
    // ONLY a genuine transport failure degrades to a durable queue. A KNOWN
    // config halt (missing privilege, invalid catalog) AND an UNKNOWN defect
    // (schema drift, programming bug) both fail hard — queuing toward a target
    // that can never accept the write would silently lose data.
    const cls = classifyDeliveryError(err);
    if (cls === 'halt') return await failHard(dbConfigError(binding.runtime, err));
    if (cls === 'unknown') return await failHard(dbUnexpectedError(binding.runtime, err));
    await pool.end().catch(() => {});
    return degraded(`database: ${(err as Error).message}`);
  }

  if (dbBinding.tuple === null || !tuplesEqual(dbBinding.tuple, configTuple)) {
    return await failHard(new WorkspaceMismatchError(tupleMismatchDetail(configTuple, dbBinding.tuple)));
  }

  try {
    await verifyWorkspaceMarker(objects, { workspaceId: ws.id, markerSha256: dbBinding.tuple.markerSha256 });
  } catch (err) {
    if (isKnownMismatch(err)) return await failHard(err);
    // AccessDenied / NoSuchBucket / 403 / 404 are IAM/config failures — fail
    // hard, never queue toward a bucket the runtime can never read/write. An
    // UNKNOWN object-store error fails closed too (never a silent degrade).
    const cls = classifyDeliveryError(err);
    if (cls === 'halt') return await failHard(objectStoreConfigError(err));
    if (cls === 'unknown') return await failHard(objectStoreUnexpectedError(err));
    // Object store transport down, database up: still degraded — artifact
    // publication is object-first, so no remote write can proceed safely.
    await pool.end().catch(() => {});
    return degraded(`object store: ${(err as Error).message}`);
  }

  let info: BackendInfo;
  try {
    info = await pgBackendInfo(pool);
  } catch (err) {
    if (isKnownMismatch(err)) return await failHard(err);
    const cls = classifyDeliveryError(err);
    if (cls === 'halt') return await failHard(dbConfigError(binding.runtime, err));
    if (cls === 'unknown') return await failHard(dbUnexpectedError(binding.runtime, err));
    await pool.end().catch(() => {});
    return degraded(`database: ${(err as Error).message}`);
  }
  const skew = collectComponentSkew(info);

  // Per-batch revalidation for every subsequent remote I/O path: binding AND
  // marker must both be POSITIVELY verified before ANY delivery. If either
  // cannot be affirmatively verified — for ANY reason — this THROWS; it never
  // swallows. The drain decides what the throw means (outbox.ts): a classified
  // transport outage skips the whole batch (nothing delivered, everything stays
  // queued), while a semantic mismatch, config/auth halt, or unknown defect is
  // surfaced fail-closed. #318 R4 finding 3: swallowing a transport marker
  // failure here previously let a PG-only (hitl/run) delivery commit with the
  // marker unverified — that path is now closed for ALL record kinds.
  const preflight = async (): Promise<void> => {
    const client = await pool.connect().catch((err: unknown) => {
      if (isPgAuthError(err)) throw pgAuthConfigError(binding.runtime, err);
      throw err;
    });
    try {
      const fresh = await verifyBinding(client, ws.id);
      if (fresh.tuple === null || !tuplesEqual(fresh.tuple, configTuple)) {
        throw new WorkspaceMismatchError(tupleMismatchDetail(configTuple, fresh.tuple));
      }
    } catch (err) {
      if (isPgAuthError(err)) throw pgAuthConfigError(binding.runtime, err);
      throw err;
    } finally {
      client.release();
    }
    await verifyWorkspaceMarker(objects, { workspaceId: ws.id, markerSha256: configTuple.markerSha256 });
  };

  const pgBackend = createPgBackend({
    pool,
    objects,
    outbox,
    preflight,
    // Pass the negotiated roster_ops version so a v1 backend's artifact reads
    // stay version-less (finding 5: v1 read must not execute v2-only SQL).
    opsVersion: info.components.roster_ops.version,
    hitlExpiry: hitlExpiryOf(config),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.pid ? { pid: opts.pid } : {}),
  });
  return {
    state: 'postgres-s3',
    config,
    backend: withCapabilityGate(pgBackend, info),
    remote: pgBackend.remote,
    pool,
    objects,
    outbox,
    binding: dbBinding,
    info,
    skew,
    close: async () => {
      await pool.end();
    },
  };
}

export async function resolveOpsBackend(cwd: string, opts: ResolveOptions = {}): Promise<ResolvedOpsBackend> {
  // The setup journal is checked BEFORE persistence.yaml: an in-flight setup
  // (crashed or racing) means the workspace has no resolvable backend yet.
  const journal = readSetupJournal(cwd);
  if (journal !== null && journal.phase !== 'done') {
    return {
      state: 'setup-incomplete',
      journal: {
        path: setupJournalPath(cwd),
        workspaceId: journal.workspaceId,
        workspaceName: journal.workspaceName,
        backend: journal.backend,
        phase: journal.phase,
        remedy: "setup incomplete — re-run 'roster ops setup' to roll it forward",
      },
    };
  }
  const loaded = loadPersistenceConfig(cwd);
  if (loaded.state === 'legacy-implicit') {
    return { state: 'legacy', adapter: new LegacyFilesAdapter(cwd) };
  }
  if (loaded.state === 'configured-local') {
    const config = loaded.config;
    const info = localBackendInfo(opsRootFor(cwd), config.workspace.id);
    const backend: LocalOpsBackend = createLocalBackend({
      opsRoot: opsRootFor(cwd),
      workspaceId: config.workspace.id,
      hitlExpiry: hitlExpiryOf(config),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.pid ? { pid: opts.pid } : {}),
    });
    return {
      state: 'local',
      config,
      backend: withCapabilityGate(backend, info),
      ledger: backend.ledger,
      info,
      skew: collectComponentSkew(info),
    };
  }
  return await resolvePostgresS3(cwd, loaded.config, opts);
}

// Drain helper for the future doctor/sync (#325): revalidates binding AND
// marker before any remote I/O — a re-pointed URL or swapped bucket parks the
// drain with a hard error instead of delivering into a foreign workspace.
export async function drainOutbox(
  resolved: Extract<ResolvedOpsBackend, { state: 'postgres-s3' }>,
): Promise<DrainReport> {
  assertOperationSupported(resolved.info, 'outbox.drain');
  const workspaceId = resolved.config.workspace.id;
  const client = await resolved.pool.connect();
  let binding: BindingRecord;
  try {
    binding = await verifyBinding(client, workspaceId);
  } finally {
    client.release();
  }
  if (binding.tuple === null) {
    throw new WorkspaceMismatchError('database binding carries no object tuple — refusing to drain');
  }
  await verifyWorkspaceMarker(resolved.objects, { workspaceId, markerSha256: binding.tuple.markerSha256 });
  return await resolved.outbox.drain(resolved.remote, { objects: new S3ObjectTarget(resolved.objects) });
}
