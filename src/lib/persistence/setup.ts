import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync, writeSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import YAML from 'yaml';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { flattenZodErrors } from '../schedule-schema.ts';
import {
  loadPersistenceConfig,
  persistenceConfigPath,
  persistenceConfigSchema,
  type PersistenceConfig,
} from './config-schema.ts';
import { sha256Hex } from './contracts.ts';
import { describeEvidenceFailure, readEvidenceFileSync } from '../evidence-read.ts';
import { LocalLedger, atomicWriteFileSync, pidAlive, readLedgerMeta, tryReclaimStaleLock } from './local/ledger.ts';
import { ensureLocalHitlV2 } from './hitl-local-migrate.ts';
import { BRAIN_ENV_BINDING, OPS_ENV_BINDING, withPoolClient, type RoleEnvBinding } from './pool.ts';
import { pendingOpsMigrations, runOpsMigrations } from './postgres/migrate.ts';
import {
  assertBootstrapEligible,
  finalizeBinding,
  recordMarkerEtag,
  stampPending,
  verifyBinding,
  type CanonicalObjectTuple,
} from './postgres/binding.ts';
import {
  checkOpsRoleInvariants,
  ensureOpsRuntimeRole,
  type OpsRoleReport,
} from './postgres/roles.ts';
import {
  claimWorkspaceMarker,
  detectObjectLockCapability,
  verifyBucketVersioning,
  workspaceMarkerSha256,
} from './objects.ts';
import { createS3FileStore, type FileStore, type S3StoreConfig } from './s3-core.ts';
import type { BackendInfo } from './capabilities.ts';
import {
  phaseRank,
  readSetupJournal,
  removeSetupJournal,
  writeSetupJournal,
  type SetupJournal,
  type SetupJournalObjects,
  type SetupPhase,
} from './setup-journal.ts';
import { adminObjectEnv, classifyAdminObjectCreds, opsRootFor, resolveOpsBackend } from './resolve.ts';

// `roster ops setup` engine (#318 section J). Roll-forward-only: every phase's
// operation is idempotent and arbitrated at the remote (DB stamp transaction,
// marker If-None-Match), so re-entry after any crash simply re-runs the
// pipeline — each op discovers a prior commit (journaled or not) and advances.
// Nothing is ever compensated or unclaimed (locked decision 5).

export const OPS_GITIGNORE_LINE = '/.roster/ops/';

// Byte caps for the two small workspace/OS-temp files this module reads through
// the hardened bounded reader. Generous for any legitimate file, small enough
// that a planted runaway one is refused instead of loaded.
const MAX_GITIGNORE_BYTES = 256 * 1024;
const MAX_SETUP_LOCK_BYTES = 4 * 1024;

// ---------- gitignore (first side effect; independent of init's marker block) ----------

export function ensureOpsGitignore(cwd: string): 'appended' | 'present' {
  const path = join(cwd, '.gitignore');
  // Same hardened bounded reader as the rest of the persistence surface
  // (round-13 finding 2 sweep): .gitignore is workspace state, so a planted FIFO
  // must not block `ops setup` and a symlink must not be read through. The
  // append below already refuses to REPLACE a non-regular file.
  const read = readEvidenceFileSync(path, MAX_GITIGNORE_BYTES);
  if (read.state === 'malformed') {
    throw new RosterError({
      header: 'roster: cannot read .gitignore',
      body: `  ${path} is ${describeEvidenceFailure(read.reason, MAX_GITIGNORE_BYTES)}.`,
      remedy: '  Replace it with a regular file inside the workspace and re-run.',
      exitCode: EXIT_ERROR,
    });
  }
  const current = read.state === 'ok' ? read.content : '';
  if (current.split('\n').some((line) => line.trim() === OPS_GITIGNORE_LINE)) return 'present';
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  atomicWriteFileSync(path, `${current}${sep}${OPS_GITIGNORE_LINE}\n`);
  return 'appended';
}

// ---------- exclusive setup lock (OS temp, keyed by canonical workspace path) ----------

export function setupLockPath(cwd: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
  } catch {
    canonical = resolvePath(cwd);
  }
  return join(tmpdir(), `roster-ops-setup-${sha256Hex(canonical).slice(0, 32)}.lock`);
}

export type SetupLock = { path: string; release: () => void };

function lockHeldError(lockPath: string, holder: string): RosterError {
  return new RosterError({
    header: 'roster: another ops setup is already running for this workspace',
    body: `  lock: ${lockPath}${holder ? `\n  holder: ${holder}` : ''}`,
    remedy: '  Wait for it to finish (or, if it is truly gone, remove the lock file) and re-run.',
    exitCode: EXIT_ERROR,
  });
}

// One winner; the loser errors IMMEDIATELY (no queueing behind an interactive
// peer). Stale locks (dead pid) are reclaimed via the ledger's rename-aside
// protocol so two concurrent reclaims cannot delete a fresh winner's lock.
export function acquireSetupLock(cwd: string): SetupLock {
  const lockPath = setupLockPath(cwd);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new RosterError({
          header: 'roster: cannot create the setup lock',
          body: `  ${lockPath}: ${(err as Error).message}`,
          remedy: '  Fix filesystem permissions on the OS temp dir and re-run.',
          exitCode: EXIT_ERROR,
        });
      }
      // The lock lives in the world-writable OS temp dir, so its holder record
      // is read no-follow / non-blocking / capped — a planted FIFO there would
      // otherwise hang every `ops setup` for this workspace. An unreadable or
      // hostile shape simply means "holder unknown", the existing path that
      // defers to tryReclaimStaleLock below.
      let holderPid: number | null = null;
      const held = readEvidenceFileSync(lockPath, MAX_SETUP_LOCK_BYTES);
      if (held.state === 'ok') {
        try {
          const parsed = JSON.parse(held.content) as { pid?: unknown };
          if (typeof parsed.pid === 'number') holderPid = parsed.pid;
        } catch {
          holderPid = null;
        }
      }
      if (holderPid !== null && pidAlive(holderPid)) {
        throw lockHeldError(lockPath, `pid ${holderPid}`);
      }
      if (!tryReclaimStaleLock(lockPath)) {
        throw lockHeldError(lockPath, holderPid === null ? '' : `pid ${holderPid}`);
      }
      continue;
    }
    try {
      const body = Buffer.from(JSON.stringify({ pid: process.pid, cwd, acquiredAt: Date.now() }));
      let off = 0;
      while (off < body.length) off += writeSync(fd, body, off, body.length - off);
      fsyncSync(fd);
    } catch (err) {
      // Best-effort cleanup: never leave a live-looking partial lock behind a
      // failed write/fsync (disk-full class), then rethrow.
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // never landed
      }
      throw new RosterError({
        header: 'roster: cannot write the setup lock',
        body: `  ${lockPath}: ${(err as Error).message}`,
        remedy: '  Fix the OS temp dir (disk space / permissions) and re-run.',
        exitCode: EXIT_ERROR,
      });
    }
    const acquired = fd;
    return {
      path: lockPath,
      release: () => {
        try {
          closeSync(acquired);
        } catch {
          // already closed
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // reclaimed elsewhere
        }
      },
    };
  }
  throw lockHeldError(lockPath, '');
}

// ---------- options / result ----------

export type SetupHookMoment = 'begin' | 'committed';
// Fault-injection seam: throwing from the hook aborts setup at exactly that
// boundary ('committed' = the phase's side effect landed, journal not yet
// advanced — the after-remote-commit-before-journal window).
export type SetupPhaseHook = (phase: SetupPhase, moment: SetupHookMoment) => void;

export type SetupOptions = {
  cwd: string;
  backend?: 'local' | 'postgres-s3';
  database?: 'brain' | 'dedicated';
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  name?: string;
  newIdentity?: boolean;
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  mintId?: () => string;
  // Test seams. adminFiles: the admin-credential object store used for the
  // bucket claim; files: the runtime store used by validate-mode resolution;
  // validateBucket: replaces the AWS-SDK versioning/Object Lock probe.
  adminFiles?: FileStore;
  files?: FileStore;
  validateBucket?: (cfg: S3StoreConfig, env: NodeJS.ProcessEnv) => Promise<{ objectLock: boolean }>;
  onPhase?: SetupPhaseHook;
};

export type OrphanReport = {
  workspaceId: string;
  workspaceName: string;
  tree: string;
  database: boolean;
  bucket: boolean;
};

export type SetupResult = {
  status: 'created' | 'resumed' | 'validated' | 'forked';
  state: 'configured-local' | 'postgres-s3';
  workspace: { id: string; name: string };
  backend: 'local' | 'postgres-s3';
  configPath: string;
  gitignore: 'appended' | 'present';
  backendInfo: BackendInfo | null;
  roleInvariants: OpsRoleReport | null;
  orphaned: OrphanReport | null;
  // Migrations applied by this run (the v1→v2 upgrade path when re-running setup
  // over an existing postgres-s3 workspace). Empty when nothing was pending.
  migrations: string[];
};

// ---------- parameter resolution ----------

type EffectiveParams = {
  id: string;
  name: string;
  backend: 'local' | 'postgres-s3';
  database: 'brain' | 'dedicated' | null;
  objects: SetupJournalObjects | null;
  config: PersistenceConfig;
};

function setupError(header: string, body: string, remedy: string): RosterError {
  return new RosterError({ header: `roster: ${header}`, body, remedy, exitCode: EXIT_ERROR });
}

function missingFlagsError(flags: string[]): RosterError {
  return setupError(
    'ops setup is missing required flags',
    '  Missing:\n' + flags.map((f) => `    ${f}`).join('\n'),
    "  roster ops setup is non-interactive; pass every required flag. See 'roster --help'.",
  );
}

function missingEnvError(vars: string[]): RosterError {
  return setupError(
    'ops setup env vars missing',
    '  Required but not set:\n' + vars.map((v) => `    ${v}`).join('\n'),
    '  Credentials are env-only (persistence.yaml never holds secrets). Export them and re-run.',
  );
}

function envBindingForDatabase(database: 'brain' | 'dedicated'): RoleEnvBinding {
  return database === 'brain' ? BRAIN_ENV_BINDING : OPS_ENV_BINDING;
}

function buildConfig(params: {
  id: string;
  name: string;
  backend: 'local' | 'postgres-s3';
  database: 'brain' | 'dedicated' | null;
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}): PersistenceConfig {
  const raw: Record<string, unknown> = {
    version: 1,
    workspace: { id: params.id, name: params.name },
    backend: params.backend,
  };
  if (params.backend === 'postgres-s3') {
    raw.postgres = { database: params.database };
    raw.objects = {
      bucket: params.bucket,
      region: params.region ?? null,
      endpoint: params.endpoint ?? null,
      force_path_style: params.forcePathStyle ?? false,
    };
  }
  const parsed = persistenceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw setupError(
      'invalid ops setup parameters',
      flattenZodErrors(parsed.error)
        .map((i) => `    ${i.path}: ${i.message}`)
        .join('\n'),
      '  Fix the flag value(s) above and re-run.',
    );
  }
  return parsed.data;
}

function journalObjectsOf(config: PersistenceConfig): SetupJournalObjects | null {
  if (config.backend !== 'postgres-s3') return null;
  return {
    bucket: config.objects.bucket,
    region: config.objects.region,
    endpoint: config.objects.endpoint,
    force_path_style: config.objects.force_path_style,
    markerSha256: workspaceMarkerSha256({ workspaceId: config.workspace.id, name: config.workspace.name }),
  };
}

function freshParams(opts: SetupOptions, defaultName: string): EffectiveParams {
  const missing: string[] = [];
  if (opts.backend === undefined) missing.push('--backend local|postgres-s3');
  if (opts.backend === 'postgres-s3') {
    if (opts.database === undefined) missing.push('--database brain|dedicated');
    if (opts.bucket === undefined) missing.push('--bucket <name>');
  }
  if (missing.length > 0) throw missingFlagsError(missing);
  if (opts.backend === 'local') {
    const stray = [
      opts.database !== undefined ? '--database' : null,
      opts.bucket !== undefined ? '--bucket' : null,
      opts.region !== undefined ? '--region' : null,
      opts.endpoint !== undefined ? '--endpoint' : null,
      opts.forcePathStyle === true ? '--force-path-style' : null,
    ].filter((f): f is string => f !== null);
    if (stray.length > 0) {
      throw setupError(
        `${stray.join(', ')} only appl${stray.length === 1 ? 'ies' : 'y'} to --backend postgres-s3`,
        '',
        '  Drop the flag(s) or switch to --backend postgres-s3.',
      );
    }
  }
  const id = (opts.mintId ?? randomUUID)();
  const name = opts.name ?? defaultName;
  const config = buildConfig({
    id,
    name,
    backend: opts.backend!,
    database: opts.database ?? null,
    ...(opts.bucket !== undefined ? { bucket: opts.bucket } : {}),
    ...(opts.region !== undefined ? { region: opts.region } : {}),
    ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
    ...(opts.forcePathStyle !== undefined ? { forcePathStyle: opts.forcePathStyle } : {}),
  });
  return {
    id,
    name,
    backend: config.backend,
    database: config.backend === 'postgres-s3' ? config.postgres.database : null,
    objects: journalObjectsOf(config),
    config,
  };
}

function conflictWith(what: 'journal' | 'config', field: string, current: string, given: string): RosterError {
  const source = what === 'journal' ? 'the in-progress setup journal' : 'roster/persistence.yaml';
  return setupError(
    `--${field} conflicts with ${source}`,
    `    recorded: ${current}\n    given:    ${given}`,
    what === 'journal'
      ? '  Re-run with the original value (or no flags) to resume, or use --new-identity --yes to abandon and fork.'
      : '  This workspace is already configured. Re-run with matching flags (or none) to validate,\n  or use --new-identity to fork a fresh identity.',
  );
}

function assertFlagsMatch(
  what: 'journal' | 'config',
  current: {
    backend: 'local' | 'postgres-s3';
    name: string;
    database: 'brain' | 'dedicated' | null;
    objects: { bucket: string; region: string | null; endpoint: string | null; force_path_style: boolean } | null;
  },
  opts: SetupOptions,
): void {
  if (opts.backend !== undefined && opts.backend !== current.backend) {
    throw conflictWith(what, 'backend', current.backend, opts.backend);
  }
  if (opts.name !== undefined && opts.name !== current.name) {
    throw conflictWith(what, 'name', current.name, opts.name);
  }
  if (opts.database !== undefined && opts.database !== (current.database ?? '')) {
    throw conflictWith(what, 'database', current.database ?? '(none)', opts.database);
  }
  const o = current.objects;
  if (opts.bucket !== undefined && opts.bucket !== (o?.bucket ?? '')) {
    throw conflictWith(what, 'bucket', o?.bucket ?? '(none)', opts.bucket);
  }
  if (opts.region !== undefined && opts.region !== (o?.region ?? '')) {
    throw conflictWith(what, 'region', o?.region ?? '(none)', opts.region);
  }
  if (opts.endpoint !== undefined && opts.endpoint !== (o?.endpoint ?? '')) {
    throw conflictWith(what, 'endpoint', o?.endpoint ?? '(none)', opts.endpoint);
  }
  if (opts.forcePathStyle === true && o?.force_path_style !== true) {
    throw conflictWith(what, 'force-path-style', String(o?.force_path_style ?? '(none)'), 'true');
  }
}

function resumeParams(journal: SetupJournal, opts: SetupOptions): EffectiveParams {
  assertFlagsMatch(
    'journal',
    {
      backend: journal.backend,
      name: journal.workspaceName,
      database: journal.postgres?.database ?? null,
      objects: journal.objects,
    },
    opts,
  );
  const config = buildConfig({
    id: journal.workspaceId,
    name: journal.workspaceName,
    backend: journal.backend,
    database: journal.postgres?.database ?? null,
    ...(journal.objects !== null
      ? {
          bucket: journal.objects.bucket,
          region: journal.objects.region ?? undefined,
          endpoint: journal.objects.endpoint ?? undefined,
          forcePathStyle: journal.objects.force_path_style,
        }
      : {}),
  });
  return {
    id: journal.workspaceId,
    name: journal.workspaceName,
    backend: journal.backend,
    database: journal.postgres?.database ?? null,
    objects: journalObjectsOf(config),
    config,
  };
}

function requireSetupEnv(params: EffectiveParams, opts: SetupOptions, env: NodeJS.ProcessEnv): {
  adminUrl: string;
  runtimeUrl: string;
} | null {
  if (params.backend !== 'postgres-s3') return null;
  const binding = envBindingForDatabase(params.database!);
  const missing: string[] = [];
  const adminUrl = env[binding.admin];
  const runtimeUrl = env[binding.runtime];
  if (typeof adminUrl !== 'string' || adminUrl.length === 0) missing.push(binding.admin);
  if (typeof runtimeUrl !== 'string' || runtimeUrl.length === 0) missing.push(binding.runtime);
  if (opts.adminFiles === undefined) {
    // The bucket claim + versioning probe are ADMIN operations — they need the
    // admin object credentials (ROSTER_OPS_ADMIN_AWS_*), falling back to AWS_*
    // only when the admin pair is COMPLETELY unset (finding: setup passed the
    // restricted runtime AWS_* and failed with AccessDenied against valid admin
    // creds). Route through the SHARED partial-pair rule (classifyAdminObjectCreds)
    // so a partially-set admin pair (key-only, secret-only, lone token) is an
    // actionable error here too — not a silent AWS_* fall-through (finding: setup
    // bypassed the strict rule adminObjectEnv already enforced on the resolve path).
    if (classifyAdminObjectCreds(env) === 'aws-fallback' && !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) {
      missing.push('ROSTER_OPS_ADMIN_AWS_ACCESS_KEY_ID + ROSTER_OPS_ADMIN_AWS_SECRET_ACCESS_KEY (admin object creds — or the AWS_* pair as a single-identity fallback)');
    }
  }
  if (missing.length > 0) throw missingEnvError(missing);
  return { adminUrl: adminUrl!, runtimeUrl: runtimeUrl! };
}

function runtimeRoleFromUrl(runtimeUrl: string): string | undefined {
  try {
    const user = new URL(runtimeUrl).username;
    return user === '' ? undefined : decodeURIComponent(user);
  } catch {
    return undefined;
  }
}

// Finalization proof: setup must never stamp a workspace 'done' against a
// runtime URL that cannot actually connect and use the schemas — OR that points
// at a DIFFERENT database than the admin URL just stamped. Connects with the
// ACTUAL runtime URL, confirms BOTH meta rows carry the workspace being
// configured (a runtime URL aimed at another already-bound database — same
// cluster-global role — reads a foreign workspace_id and is refused here), then
// probes SELECT + INSERT/rollback into an append table. Any failure refuses
// finalization actionably; the journal stays resumable, nothing is finalized.
async function proveRuntimeUrl(runtimeUrl: string, envVar: string, workspaceId: string): Promise<void> {
  const client = new pg.Client({ connectionString: runtimeUrl });
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw setupError(
      'the runtime database URL cannot connect',
      `    ${envVar}: ${(err as Error).message}`,
      '  Setup refuses to finalize against credentials the runtime cannot use (writes would\n' +
        `  queue forever). Fix the user/password/login in ${envVar}, then re-run —\n` +
        '  every completed phase resumes; nothing is unclaimed.',
    );
  }
  try {
    await client.query('BEGIN');
    const hitl = await client.query('SELECT workspace_id::text AS ws, state FROM hitl.meta WHERE singleton');
    const ops = await client.query('SELECT workspace_id::text AS ws, state FROM roster_ops.meta WHERE singleton');
    const hitlRow = hitl.rows[0] as { ws: string | null; state: string | null } | undefined;
    const opsRow = ops.rows[0] as { ws: string | null; state: string | null } | undefined;
    if (
      hitlRow === undefined ||
      opsRow === undefined ||
      hitlRow.ws !== workspaceId ||
      opsRow.ws !== workspaceId
    ) {
      await client.query('ROLLBACK').catch(() => {});
      throw setupError(
        'the runtime database URL points at a different workspace',
        `    ${envVar}: the connected database is bound to workspace ` +
          `${hitlRow?.ws ?? '(unbound)'} (hitl) / ${opsRow?.ws ?? '(unbound)'} (roster_ops), not ${workspaceId}`,
        '  The runtime URL must point at the SAME database the admin URL stamped (strict 1:1\n' +
          `  binding). Fix ${envVar} to target this workspace's database, then re-run —\n` +
          '  nothing was finalized.',
      );
    }
    await client.query(
      `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, created_at)
       VALUES ('setup-probe', $1::uuid, 'setup-probe', 'setup-probe', 'probe', '{}'::jsonb, 0)`,
      [workspaceId],
    );
    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof RosterError) throw err; // our own actionable refusal — never re-wrap
    throw setupError(
      'the runtime role cannot use the ops schemas',
      `    ${envVar}: ${(err as Error).message}`,
      '  The runtime URL connects, but its probe (SELECT on meta + INSERT/rollback into an\n' +
        '  append table) failed. Fix the grants, then re-run — nothing was finalized.',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

function roleGateError(role: string, report: OpsRoleReport): RosterError {
  const lines = report.violations.flatMap((v) => [`    [${v.kind}] ${v.detail}`, `      fix: ${v.remedy}`]);
  return setupError(
    `refusing to finalize — runtime role '${role}' fails the least-privilege gate`,
    lines.join('\n'),
    '  Apply the fixes above (setup never strips an operator-supplied role itself), then re-run\n' +
      "  'roster ops setup' — every completed phase resumes; nothing is unclaimed.",
    );
}

function s3ConfigOf(params: EffectiveParams): S3StoreConfig {
  const o = params.objects!;
  return { bucket: o.bucket, region: o.region, endpoint: o.endpoint, forcePathStyle: o.force_path_style };
}

// The object credentials setup uses for its ADMIN operations (marker claim +
// GetBucketVersioning): the distinct admin pair when present (dropping any
// runtime STS bleed), else the AWS_* pair (single-identity fallback), else the
// raw env untouched. Routes through the SHARED partial-pair rule
// (classifyAdminObjectCreds) so a PARTIALLY-set admin pair throws here too
// (finding: setup fell back to AWS_* when only one admin var was set —
// requireSetupEnv already rejects it before this runs, but the two callers must
// share the one helper). For the aws-fallback branch this stays non-throwing on
// a missing AWS_* pair (requireSetupEnv confirmed creds exist, and this is
// eagerly evaluated as an argument even when a test injects validateBucket).
function setupObjectEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return classifyAdminObjectCreds(env) === 'admin-pair' ? adminObjectEnv(env) : env;
}

async function defaultValidateBucket(cfg: S3StoreConfig, env: NodeJS.ProcessEnv): Promise<{ objectLock: boolean }> {
  await verifyBucketVersioning(cfg, env);
  return { objectLock: await detectObjectLockCapability(cfg, env) };
}

function writeConfigFile(cwd: string, config: PersistenceConfig): string {
  const path = persistenceConfigPath(cwd);
  const configDir = join(cwd, 'roster');
  let dirStat = null;
  try {
    dirStat = lstatSync(configDir);
  } catch {
    dirStat = null;
  }
  if (dirStat !== null && dirStat.isSymbolicLink()) {
    throw setupError(
      'refusing to write persistence.yaml through a symlink',
      `    ${configDir} is a symbolic link`,
      '  Replace it with a real directory inside the workspace, then re-run.',
    );
  }
  mkdirSync(configDir, { recursive: true });
  const doc: Record<string, unknown> = {
    version: config.version,
    workspace: { id: config.workspace.id, name: config.workspace.name },
    backend: config.backend,
  };
  if (config.backend === 'postgres-s3') {
    doc.postgres = { database: config.postgres.database };
    doc.objects = {
      bucket: config.objects.bucket,
      region: config.objects.region,
      endpoint: config.objects.endpoint,
      force_path_style: config.objects.force_path_style,
    };
  }
  atomicWriteFileSync(path, YAML.stringify(doc));
  return path;
}

// ---------- validate mode (existing config, no --new-identity) ----------

// Re-running `roster ops setup` over an existing configured postgres-s3
// workspace runs any PENDING migrations (the v1→v2 run-ledger upgrade) with the
// ADMIN url, then reapplies the runtime grants (idempotent — REVOKE ALL + GRANT
// picks up new tables/views/sequences) and re-gates the role. Without this an
// existing #318 v1 workspace stayed capability-gated and unusable after the CLI
// upgrade (finding: the existing-config branch only validated). Returns the
// migrations it applied for --json.
async function upgradeExistingPostgres(
  config: Extract<PersistenceConfig, { backend: 'postgres-s3' }>,
  env: NodeJS.ProcessEnv,
): Promise<{ migrations: string[]; roleInvariants: OpsRoleReport }> {
  const binding = envBindingForDatabase(config.postgres.database);
  const adminUrl = env[binding.admin];
  const runtimeUrl = env[binding.runtime];
  const missing: string[] = [];
  if (typeof adminUrl !== 'string' || adminUrl.length === 0) missing.push(binding.admin);
  if (typeof runtimeUrl !== 'string' || runtimeUrl.length === 0) missing.push(binding.runtime);
  if (missing.length > 0) throw missingEnvError(missing);

  const adminPool = new pg.Pool({ connectionString: adminUrl!, max: 2 });
  try {
    // Verify the DB behind the admin URL actually belongs to the CONFIGURED
    // workspace BEFORE any mutation (finding: a swapped admin URL ran migrations
    // + grants against a foreign workspace's database before runtime resolution
    // could reject it). The #318 binding stamp (workspace_id, finalized) exists on
    // a v1 DB, so this refuses BEFORE the v1→v2 migration touches a foreign DB.
    await verifyBinding(adminPool, config.workspace.id);
    const pending = await pendingOpsMigrations(adminPool);
    await runOpsMigrations(adminPool);
    const roleOpt = runtimeRoleFromUrl(runtimeUrl!);
    const gate = await withPoolClient(adminPool, async (client) => {
      const ensured = await ensureOpsRuntimeRole(
        client,
        config.postgres.database,
        roleOpt !== undefined ? { role: roleOpt } : {},
      );
      return { role: ensured.role, report: await checkOpsRoleInvariants(client, ensured.role) };
    });
    if (!gate.report.ok) throw roleGateError(gate.role, gate.report);
    return { migrations: [...pending.hitl, ...pending.roster_ops], roleInvariants: gate.report };
  } finally {
    await adminPool.end().catch(() => {});
  }
}

async function validateExisting(opts: SetupOptions, env: NodeJS.ProcessEnv): Promise<SetupResult> {
  const now = opts.now ?? Date.now;
  const loaded = loadPersistenceConfig(opts.cwd);
  if (loaded.state === 'legacy-implicit') {
    throw setupError('internal: validate mode without a config', '', '  Report this as a roster bug.');
  }
  const config = loaded.config;
  assertFlagsMatch(
    'config',
    {
      backend: config.backend,
      name: config.workspace.name,
      database: config.backend === 'postgres-s3' ? config.postgres.database : null,
      objects: config.backend === 'postgres-s3' ? config.objects : null,
    },
    opts,
  );
  const gitignore = ensureOpsGitignore(opts.cwd);
  // v1→v2 upgrade FIRST (admin url): run pending migrations + reapply grants so
  // the subsequent runtime resolution sees the upgraded (v2) schema and the
  // run-ledger operations are usable. postgres-s3 only; local trees upgrade
  // themselves on the next ledger write (the code IS v2).
  let migrations: string[] = [];
  if (config.backend === 'postgres-s3') {
    const up = await upgradeExistingPostgres(config, env);
    migrations = up.migrations;
  } else {
    // A local tree upgrades itself in code, but only lazily on the next write.
    // A setup re-run is the moment to make it explicit: refresh the meta.json
    // component versions (ledger.meta() clamps them up to the code's floor) and
    // run the #319 hitl v1→v2 conversion under its barrier, so the workspace is
    // usable — and capability-gated correctly — the moment setup returns.
    const ledger = new LocalLedger({ opsRoot: opsRootFor(opts.cwd), workspaceId: config.workspace.id });
    // READ-ONLY first: ledger.meta() performs the clamp itself, so reading
    // through it would always observe the post-upgrade values.
    const before =
      readLedgerMeta(ledger.treeDir, ledger.workspaceId, ledger.boundary)?.componentVersions ?? {};
    const converted = ensureLocalHitlV2(ledger, now());
    if (converted.converted) migrations.push('hitl: local v1→v2 conversion');
    const after = ledger.meta().componentVersions;
    for (const [name, version] of Object.entries(after)) {
      if ((before[name] ?? 1) !== version) migrations.push(`${name}: local component version → ${version}`);
    }
  }
  const resolved = await resolveOpsBackend(opts.cwd, {
    env,
    ...(opts.files !== undefined ? { files: opts.files } : opts.adminFiles !== undefined ? { files: opts.adminFiles } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (resolved.state === 'degraded') {
    throw setupError(
      'the configured backend is unreachable',
      `    ${resolved.reason}`,
      '  Validation requires the live store. Restore connectivity and re-run.',
    );
  }
  if (resolved.state === 'legacy' || resolved.state === 'setup-incomplete') {
    throw setupError('internal: unexpected resolution state in validate mode', `    ${resolved.state}`, '  Report this as a roster bug.');
  }
  let roleInvariants: OpsRoleReport | null = null;
  if (resolved.state === 'postgres-s3') {
    try {
      const binding = envBindingForDatabase(config.backend === 'postgres-s3' ? config.postgres.database : 'dedicated');
      const runtimeUrl = env[binding.runtime]!;
      const role =
        runtimeRoleFromUrl(runtimeUrl) ?? (config.backend === 'postgres-s3' && config.postgres.database === 'brain' ? 'roster_brain_rw' : '');
      if (role !== '') {
        const client = await resolved.pool.connect();
        try {
          roleInvariants = await checkOpsRoleInvariants(client, role);
        } finally {
          client.release();
        }
      }
    } finally {
      await resolved.close();
    }
  }
  return {
    status: 'validated',
    state: resolved.state === 'local' ? 'configured-local' : 'postgres-s3',
    workspace: { id: config.workspace.id, name: config.workspace.name },
    backend: config.backend,
    configPath: persistenceConfigPath(opts.cwd),
    gitignore,
    backendInfo: resolved.info,
    roleInvariants,
    orphaned: null,
    migrations,
  };
}

// ---------- the pipeline ----------

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const cwd = opts.cwd;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const lock = acquireSetupLock(cwd);
  try {
    const journalRaw = readSetupJournal(cwd);
    const journal = journalRaw !== null && journalRaw.phase !== 'done' ? journalRaw : null;
    if (journalRaw !== null && journalRaw.phase === 'done') removeSetupJournal(cwd);
    const existing = loadPersistenceConfig(cwd);
    const newIdentity = opts.newIdentity === true;

    if (!newIdentity && journal === null && existing.state !== 'legacy-implicit') {
      return await validateExisting(opts, env);
    }

    let status: SetupResult['status'];
    let params: EffectiveParams;
    let orphaned: OrphanReport | null = null;

    if (newIdentity) {
      const prior =
        existing.state !== 'legacy-implicit'
          ? { id: existing.config.workspace.id, name: existing.config.workspace.name, remote: existing.state === 'postgres-s3' }
          : journal !== null
            ? {
                id: journal.workspaceId,
                name: journal.workspaceName,
                remote: journal.backend === 'postgres-s3' && phaseRank(journal.phase) >= phaseRank('db-stamped-pending'),
              }
            : null;
      if (prior !== null) {
        orphaned = {
          workspaceId: prior.id,
          workspaceName: prior.name,
          tree: join(opsRootFor(cwd), prior.id),
          database: prior.remote,
          bucket: prior.remote,
        };
        if (prior.remote && opts.yes !== true) {
          throw setupError(
            '--new-identity would orphan a claimed backend',
            [
              `    current identity: ${prior.name} (${prior.id})`,
              `    stamped database: yes (stays bound to the old identity — roster never unclaims)`,
              `    claimed bucket:   yes (marker stays in place)`,
              `    local tree:       ${orphaned.tree} (preserved, never replayed into the fork)`,
            ].join('\n'),
            '  Re-run with --yes to fork anyway. Nothing is deleted; the old resources stay claimed.',
          );
        }
      }
      params = freshParams(
        { ...opts, name: opts.name ?? prior?.name ?? basename(cwd) },
        prior?.name ?? basename(cwd),
      );
      status = prior !== null ? 'forked' : 'created';
      if (journal !== null) removeSetupJournal(cwd);
    } else if (journal !== null) {
      params = resumeParams(journal, opts);
      status = 'resumed';
    } else {
      params = freshParams(opts, basename(cwd));
      status = 'created';
    }

    const urls = requireSetupEnv(params, opts, env);
    const boundary: SetupPhaseHook = (phase, moment) => {
      opts.onPhase?.(phase, moment);
    };

    let j: SetupJournal =
      status === 'resumed'
        ? { ...journal!, updatedAt: now() }
        : {
            version: 1,
            workspaceId: params.id,
            workspaceName: params.name,
            backend: params.backend,
            phase: 'intent',
            postgres: params.database === null ? null : { database: params.database },
            objects: params.objects,
            createdAt: now(),
            updatedAt: now(),
          };
    const advance = (phase: SetupPhase): void => {
      if (phaseRank(phase) > phaseRank(j.phase)) j = { ...j, phase };
      j = { ...j, updatedAt: now() };
      writeSetupJournal(cwd, j);
    };

    // intent — the gitignore side effect runs FIRST so no .roster/ops/ file
    // (the journal included) ever exists unignored; the journal then lands.
    boundary('intent', 'begin');
    const gitignore = ensureOpsGitignore(cwd);
    writeSetupJournal(cwd, j);
    boundary('intent', 'committed');

    boundary('gitignore-ensured', 'begin');
    ensureOpsGitignore(cwd);
    boundary('gitignore-ensured', 'committed');
    advance('gitignore-ensured');

    let roleInvariants: OpsRoleReport | null = null;
    if (params.backend === 'postgres-s3') {
      const tuple: CanonicalObjectTuple = {
        bucket: params.objects!.bucket,
        region: params.objects!.region,
        endpoint: params.objects!.endpoint,
        forcePathStyle: params.objects!.force_path_style,
        markerSha256: params.objects!.markerSha256,
      };
      const adminPool = new pg.Pool({ connectionString: urls!.adminUrl, max: 2 });
      try {
        boundary('db-stamped-pending', 'begin');
        // Preflight the existing stamp BEFORE any migration (finding: the fresh
        // path ran runOpsMigrations before stampPending, so a swapped admin URL
        // pointing at another workspace's finalized v1 DB was upgraded to v2 —
        // its metadata mutated — before the stamp could reject it). A DB already
        // finalized/pending for a different workspace is refused here, unmutated;
        // an empty/unstamped DB (or one already stamped for this workspace)
        // proceeds. The existing-config + repair paths already guard via
        // verifyBinding; this closes the sibling fresh/new-identity path.
        await assertBootstrapEligible(adminPool, params.id);
        await runOpsMigrations(adminPool);
        await stampPending(adminPool, {
          workspaceId: params.id,
          workspaceName: params.name,
          objects: tuple,
        });
        boundary('db-stamped-pending', 'committed');
        advance('db-stamped-pending');

        boundary('bucket-claimed', 'begin');
        // The marker claim is an admin write — use the admin object credentials
        // (finding: setup claimed the marker with the restricted runtime creds).
        const adminFiles = opts.adminFiles ?? (await createS3FileStore(s3ConfigOf(params), setupObjectEnv(env)));
        const claim = await claimWorkspaceMarker(adminFiles, { workspaceId: params.id, name: params.name });
        // Cross-check the claimed marker's actual sha256 against the digest
        // stamped into the DB tuple (db-stamped-pending). They must agree — an
        // existing same-UUID marker whose bytes differ (e.g. a different display
        // name) would otherwise finalize an unusable binding that resolution
        // later rejects. Refuse BEFORE recordMarkerEtag/finalize; the journal
        // stays at db-stamped-pending (resumable), the DB is never finalized.
        if (claim.markerSha256 !== tuple.markerSha256) {
          throw setupError(
            'the existing bucket marker disagrees with this workspace',
            `    bucket marker sha256: ${claim.markerSha256}\n    stamped tuple sha256: ${tuple.markerSha256}`,
            '  The bucket already holds a workspace marker whose bytes differ from the marker this setup\n' +
              '  would stamp (same UUID, different name/bytes). Nothing was finalized; the journal is resumable.\n' +
              '  Re-run with the original --name (or clear the bucket marker on an admin path), then re-run.',
          );
        }
        await recordMarkerEtag(adminPool, { workspaceId: params.id, markerEtag: claim.markerEtag });
        boundary('bucket-claimed', 'committed');
        advance('bucket-claimed');

        boundary('db-finalized', 'begin');
        const roleOpt = runtimeRoleFromUrl(urls!.runtimeUrl);
        const gate = await withPoolClient(adminPool, async (client) => {
          const ensured = await ensureOpsRuntimeRole(
            client,
            params.database!,
            roleOpt !== undefined ? { role: roleOpt } : {},
          );
          return { role: ensured.role, report: await checkOpsRoleInvariants(client, ensured.role) };
        });
        if (!gate.report.ok) throw roleGateError(gate.role, gate.report);
        roleInvariants = gate.report;
        await proveRuntimeUrl(urls!.runtimeUrl, envBindingForDatabase(params.database!).runtime, params.id);
        // GetBucketVersioning + Object Lock detection are admin reads — use the
        // admin object credentials (finding: bucket validation used the runtime
        // creds, which the least-privilege IAM policy denies these operations).
        const bucketCheck = await (opts.validateBucket ?? defaultValidateBucket)(s3ConfigOf(params), setupObjectEnv(env));
        if (bucketCheck.objectLock) {
          await adminPool.query(
            `UPDATE roster_ops.meta
                SET objects_capabilities = objects_capabilities || '["object-lock"]'::jsonb
              WHERE singleton AND NOT objects_capabilities ? 'object-lock'`,
          );
        }
        await finalizeBinding(adminPool, { workspaceId: params.id });
        boundary('db-finalized', 'committed');
        advance('db-finalized');
      } finally {
        await adminPool.end().catch(() => {});
      }
    }

    boundary('config-written', 'begin');
    const configPath = writeConfigFile(cwd, params.config);
    // Fresh empty per-UUID tree: minted here so the identity is immediately
    // usable (and so a fork starts from a tree that provably exists).
    new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId: params.id, ...(opts.now ? { now: opts.now } : {}) }).meta();
    boundary('config-written', 'committed');
    advance('config-written');

    boundary('done', 'begin');
    advance('done');
    removeSetupJournal(cwd);
    boundary('done', 'committed');

    const resolved = await resolveOpsBackend(cwd, {
      env,
      ...(opts.files !== undefined ? { files: opts.files } : opts.adminFiles !== undefined ? { files: opts.adminFiles } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    let backendInfo: BackendInfo | null = null;
    if (resolved.state === 'local' || resolved.state === 'postgres-s3') {
      backendInfo = resolved.info;
      if (resolved.state === 'postgres-s3') await resolved.close();
    }
    return {
      status,
      state: params.backend === 'local' ? 'configured-local' : 'postgres-s3',
      workspace: { id: params.id, name: params.name },
      backend: params.backend,
      configPath,
      gitignore,
      backendInfo,
      roleInvariants,
      orphaned,
      // The fresh pipeline applies migrations inline (db-stamped-pending); the
      // upgrade-report field is for the validate-mode v1→v2 path.
      migrations: [],
    };
  } finally {
    lock.release();
  }
}
