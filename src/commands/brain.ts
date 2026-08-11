import chalk from 'chalk';
import type pg from 'pg';
import { relative } from 'node:path';
import {
  initializeCleanBrain,
  openBrainDiagnosticPool,
  openVerifiedAdminPool,
  openVerifiedRuntimePool,
  resolveBrainDoctorRoleName,
} from '../lib/brain/connect.ts';
import { assertBrainActivationComplete } from '../lib/brain-activation-config.ts';
import type { VerifiedBrainPool } from '../lib/brain/workspace-authority.ts';
import { fingerprintBrainNamespace } from '../lib/workspace-record.ts';
import { readWorkspaceFile } from '../lib/workspace-io.ts';
import type {
  CompletedRunInput,
  FeedbackInput,
  HumanDecisionInput,
  RunArtifactInput,
} from '../lib/brain/evidence-contracts.ts';
import {
  recordCompletedRun,
  recordFeedback,
  recordHumanDecision,
  recordRunArtifact,
} from '../lib/brain/evidence-store.ts';
import { RUNTIME_ROLE } from '../lib/brain/roles.ts';
import { runDoctor } from '../lib/brain/doctor.ts';
import { requireBrainActivation, type BrainActivationStore } from '../lib/brain/activation.ts';
import { ingestAndExtractBrainSource } from '../lib/brain/extraction.ts';
import {
  brainObjectStoreConfigFromRegistry,
  createBrainObjectStore,
  type BrainObjectStoreConfig,
} from '../lib/brain/object-store.ts';
import { MAX_SOURCE_BYTES, type SourceIngestInput } from '../lib/brain/source-contracts.ts';
import { saveEntity } from '../lib/brain/save.ts';
import type { EvidenceRecordVerb, FactPair } from '../lib/brain-args.ts';
import { appendEvent } from '../lib/brain/event.ts';
import { createLink } from '../lib/brain/link.ts';
import { mergeEntities } from '../lib/brain/merge.ts';
import { getEntity } from '../lib/brain/get.ts';
import {
  brainFilesTarget,
  createBrainFilesStore,
  putFile,
  getFile,
  listFiles,
  rmFile,
  type FilesTarget,
} from '../lib/brain/fs.ts';
import type { FileStore } from '../lib/brain/s3.ts';
import { EXIT_OK, EXIT_ERROR, RosterError, isRosterError } from '../lib/errors.ts';
import {
  auditLessonDrift,
  notApplicableLessonDrift,
  type LessonDriftReport,
} from '../lib/brain/lesson-drift.ts';

export type BrainInitOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
  embeddings: boolean;
  adminUrl?: string;
  role?: string;
};

export type BrainDoctorOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
  role?: string;
};

export async function executeBrainInit(opts: BrainInitOptions): Promise<number> {
  const initialized = await guardBrainProvider(() => initializeCleanBrain({
    cwd: opts.cwd,
    ...(opts.adminUrl === undefined ? {} : { adminUrl: opts.adminUrl }),
    role: opts.role ?? RUNTIME_ROLE,
  }));
  const migration = initialized.bootstrap.migrations;
  const role = initialized.bootstrap.role;
  const adminRole = initialized.adminRole;
  const roleName = role.roleName;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          applied: migration.applied,
          skipped: migration.skipped,
          roleCreated: role.created,
          roleName,
          embeddings: opts.embeddings,
          creatorGrantRemains: role.creatorGrantRemains,
        },
        null,
        2,
      ),
    );
  } else if (!opts.silent) {
    console.log('');
    console.log(chalk.bold('roster brain init'));
    console.log(`  ${chalk.green('✓')} migrations applied: ${migration.applied.length}, up-to-date: ${migration.skipped.length}`);
    console.log(`  ${chalk.green('✓')} runtime role ${roleName} ${role.created ? 'created' : 'already present'}`);
    if (role.creatorGrantRemains) {
      console.log(`  ${chalk.yellow('⚠')} could not revoke the creator's membership in ${roleName} (stock PG16`);
      console.log(`    records it as bootstrap-granted). 'brain doctor' will stay red on no-inbound-members`);
      console.log(`    until a superuser runs: ${chalk.bold(`REVOKE ${roleName} FROM ${adminRole};`)}`);
    }
    console.log(`  ${chalk.green('✓')} ambient runtime credential verified`);
    console.log('');
    console.log(chalk.dim('  Company knowledge enters the Brain through roster brain ingest,'));
    console.log(chalk.dim('  which mints an immutable source version for it.'));
    console.log('');
  }
  return EXIT_OK;
}

export async function executeBrainDoctor(opts: BrainDoctorOptions): Promise<number> {
  const pool = openBrainDiagnosticPool(opts.cwd);
  try {
    const roleName = resolveBrainDoctorRoleName(opts.cwd, opts.role ?? RUNTIME_ROLE);
    const report = await guardBrainProvider(() => runDoctor(pool, roleName));
    // #358: the lesson ledger and the Git playbook are two stores, so the
    // doctor owes a cross-store account of every materialized lesson. The audit
    // is report-only and takes neither the fence nor a local lock; it is also
    // the named second half of the UNVERIFIED remediation, telling the operator
    // exactly which convergence a re-run will perform.
    const drift = await guardBrainProvider(() => auditLessonDriftForDoctor(opts.cwd, report.pending));
    const ok = report.ok && drift.ok;
    if (opts.json) {
      console.log(JSON.stringify({ ...report, ok, lesson_drift: drift }, null, 2));
    } else if (!opts.silent) {
      console.log('');
      console.log(chalk.bold('roster brain doctor'));
      for (const c of report.checks) {
        const mark = c.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${mark} ${c.name} — ${c.detail}`);
      }
      if (drift.applicable) {
        const mark = drift.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${mark} lesson-drift — ${drift.ok
          ? `${drift.subjects} materialized lesson(s) match their governing decision`
          : `${drift.findings.length} lesson(s) drifted from the governing decision`}`);
        for (const finding of drift.findings) {
          console.log(`      ${chalk.red('·')} ${finding.code} ${finding.lesson_qualified_id} — ${finding.detail}`);
          console.log(`        ${chalk.dim(finding.remedy)}`);
        }
      }
      console.log(`  ${chalk.dim('·')} identity: ${report.identity_state}`);
      console.log(`  ${chalk.dim('·')} tables: ${report.tables.length === 0 ? '(none)' : report.tables.join(', ')}`);
      console.log(`  ${chalk.dim('·')} pending migrations: ${report.pending.length === 0 ? '(none)' : report.pending.join(', ')}`);
      console.log('');
      console.log(ok ? chalk.green('  brain healthy') : chalk.red('  brain UNHEALTHY'));
      console.log('');
    }
    return ok ? EXIT_OK : EXIT_ERROR;
  } finally {
    await pool.end();
  }
}

// Skipped cleanly when the lifecycle schema is not applied yet or the workspace
// has no runtime credential: a diagnostic must never fail on state it is
// diagnosing the absence of.
async function auditLessonDriftForDoctor(
  cwd: string,
  pending: readonly string[],
): Promise<LessonDriftReport> {
  if (pending.length > 0) return notApplicableLessonDrift();
  let runtime;
  try {
    runtime = openVerifiedRuntimePool(cwd);
  } catch {
    return notApplicableLessonDrift();
  }
  try {
    return await auditLessonDrift(runtime, cwd);
  } catch (error) {
    if ((error as { code?: unknown }).code === '42P01') return notApplicableLessonDrift();
    throw error;
  } finally {
    await runtime.end();
  }
}

// §10 forbids printing a connection string OR ANY FRAGMENT of one. A raw pg or
// AWS SDK failure carries exactly that (`connect ECONNREFUSED <host>:<port>`, a
// request URL, a bucket), and errors.ts's global `unexpectedError` prints the
// message verbatim. Rather than rewrite the global handler, every Brain verb
// funnels its provider failures through this redactor: a driver failure becomes
// one stable code with no address text, and anything that is NOT a driver
// failure (a genuine Roster bug) is rethrown untouched so it still surfaces.
export async function guardBrainProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw redactBrainProviderFailure(error);
  }
}

// Only NETWORK-shaped syscalls count: a local `open`/`stat` ENOENT is a Roster
// bug or a bad workspace path, and misreporting it as a Brain connection failure
// would hide it behind a stable code.
const NETWORK_SYSCALLS: ReadonlySet<string> = new Set([
  'connect',
  'read',
  'write',
  'getaddrinfo',
  'querya',
  'queryaaaa',
]);

// A TLS handshake failure carries NO syscall and names the private host in its
// own message (`Hostname/IP does not match certificate's altnames: Host:
// db.internal…`), so it must be classified explicitly or it prints verbatim.
// Node's own failures use ERR_TLS_*; OpenSSL's verification verdicts surface on
// `err.code` under their raw names.
const TLS_FAILURE_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function isTlsFailureCode(code: unknown): boolean {
  return typeof code === 'string' && (/^ERR_TLS_/u.test(code) || TLS_FAILURE_CODES.has(code));
}

export function redactBrainProviderFailure(error: unknown): unknown {
  if (isRosterError(error)) return error;
  const candidate = error as {
    code?: unknown;
    syscall?: unknown;
    severity?: unknown;
    routine?: unknown;
    $metadata?: unknown;
  };
  const sqlState = typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/u.test(candidate.code);
  // TLS is checked first: a handshake failure may also carry a network syscall,
  // and 'tls-failed' is the more precise verdict.
  const tlsFailure = isTlsFailureCode(candidate.code);
  const connectFailure = !tlsFailure
    && typeof candidate.syscall === 'string'
    && NETWORK_SYSCALLS.has(candidate.syscall.toLowerCase());
  const providerFailure = tlsFailure
    || connectFailure
    // pg surfaces every server-side failure with BOTH a severity and a SQLSTATE.
    || (typeof candidate.severity === 'string' && sqlState)
    || (typeof candidate.routine === 'string' && sqlState)
    // Every AWS SDK service exception carries $metadata.
    || candidate.$metadata !== undefined;
  if (!providerFailure) return error;
  // Nothing from the original error is passed through — not its message, not its
  // host, not its certificate subject.
  return new RosterError({
    header: 'Brain provider access failed',
    body: 'The configured Brain database or object storage refused or dropped the operation.',
    remedy: 'Verify the ambient Brain credentials and the tracked brain.storage namespace, then retry.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_CONNECTION_FAILED',
    details: { reason: tlsFailure ? 'tls-failed' : connectFailure ? 'connect-failed' : 'query-failed' },
  });
}

type RuntimeVerbOptions = { cwd: string; json: boolean };

// The pool is opened FIRST and closed LAST: opening it runs the §6 activation
// preflight and the runtime-credential contract check synchronously, before the
// body may read a caller-supplied file or construct an object-storage client.
async function withVerifiedRuntimePool<T>(
  cwd: string,
  fn: (pool: VerifiedBrainPool) => Promise<T>,
): Promise<T> {
  const pool = openVerifiedRuntimePool(cwd);
  try {
    return await guardBrainProvider(() => fn(pool));
  } finally {
    await pool.end();
  }
}

async function withVerifiedRuntimeClient<T>(
  cwd: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return await withVerifiedRuntimePool(cwd, async (pool) => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  });
}

export type BrainIngestOptions = {
  cwd: string;
  json: boolean;
  manifest?: string;
  manifestFile?: string;
  bytesFile?: string;
  // Test seam: the hermetic ingest matrix needs a BrainObjectTransport double,
  // and the real store is only reachable with live object-storage credentials.
  makeObjectStore?: (config: BrainObjectStoreConfig) => BrainActivationStore;
};

const MAX_INGEST_MANIFEST_BYTES = 262_144;

function ingestInputInvalid(reason: string): RosterError {
  return new RosterError({
    header: 'Invalid Brain ingest manifest',
    body: `The ingest manifest is invalid: ${reason}.`,
    remedy: 'Supply one bounded JSON object that follows the documented Brain source ingest contract.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_INGEST_INPUT_INVALID',
    details: { reason },
  });
}

function workspaceFilePath(manifest: Record<string, unknown>): string | undefined {
  const source = manifest['source'];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const origin = source as { kind?: unknown; workspacePath?: unknown };
  if (origin.kind !== 'workspace-file' || typeof origin.workspacePath !== 'string') return undefined;
  return origin.workspacePath;
}

// The manifest and the bytes are never echoed back: an ingested source can carry
// internal or secret-class business text, and a CLI transcript is not a durable
// store. Only content-addressed identities reach stdout.
export async function executeBrainIngest(opts: BrainIngestOptions): Promise<number> {
  const activation = assertBrainActivationComplete(opts.cwd, {
    postgres: 'admin',
    objectStorage: 'live',
  });
  const raw = opts.manifestFile === undefined
    ? opts.manifest!
    : readWorkspaceFile(opts.cwd, opts.manifestFile, { maxBytes: MAX_INGEST_MANIFEST_BYTES }).toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INGEST_MANIFEST_BYTES) {
    throw ingestInputInvalid(`it exceeds ${MAX_INGEST_MANIFEST_BYTES} UTF-8 bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ingestInputInvalid('it is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ingestInputInvalid('it must be a JSON object');
  }
  const manifest = parsed as Record<string, unknown>;
  if (Object.hasOwn(manifest, 'bytes')) {
    throw ingestInputInvalid("it must not carry 'bytes'; supply them with --bytes-file");
  }
  const bytesPath = opts.bytesFile ?? workspaceFilePath(manifest);
  if (bytesPath === undefined) {
    throw ingestInputInvalid(`'brain ingest': --bytes-file is required unless source.kind is 'workspace-file'`);
  }
  const bytes = readWorkspaceFile(opts.cwd, bytesPath, { maxBytes: MAX_SOURCE_BYTES });

  const storeConfig = brainObjectStoreConfigFromRegistry(activation.brain);
  const pool = openVerifiedAdminPool(opts.cwd);
  const objectStore = opts.makeObjectStore === undefined
    ? createBrainObjectStore(storeConfig)
    : opts.makeObjectStore(storeConfig);
  try {
    const active = requireBrainActivation({ pool, objectStore });
    const result = await guardBrainProvider(() => ingestAndExtractBrainSource(
      active,
      { ...manifest, bytes } as unknown as SourceIngestInput,
    ));
    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        verb: 'ingest',
        ingest: {
          intent_id: result.ingest.intentId,
          source_id: result.ingest.sourceId,
          source_version_id: result.ingest.sourceVersionId,
          object_id: result.ingest.objectId,
          published_as_current: result.ingest.publishedAsCurrent,
        },
        extraction: {
          extraction_id: result.extraction.extractionId,
          extractor_name: result.extraction.extractorName,
          extractor_version: result.extraction.extractorVersion,
          status: result.extraction.status,
          unsupported_reason: result.extraction.unsupportedReason,
          chunk_count: result.extraction.chunkCount,
          text_sha256: result.extraction.textSha256,
          outcome: result.extraction.outcome,
        },
      }, null, 2));
    } else {
      console.log(
        `${chalk.green('✓')} ingested source version ${result.ingest.sourceVersionId}`
        + `${result.ingest.publishedAsCurrent ? ' (current)' : ''}`,
      );
      console.log(
        `  ${chalk.dim('·')} extraction ${result.extraction.status}: `
        + `${result.extraction.chunkCount} chunk(s) (${result.extraction.outcome})`,
      );
    }
    return EXIT_OK;
  } finally {
    objectStore.close();
    await pool.end();
  }
}

export type BrainSaveOptions = RuntimeVerbOptions & {
  kind: string;
  slug: string;
  title?: string;
  fields: FactPair[];
  source?: string;
  confidence?: number;
  actor?: string;
};

export async function executeBrainSave(opts: BrainSaveOptions): Promise<number> {
  const result = await withVerifiedRuntimeClient(opts.cwd, (client) =>
    saveEntity(client, {
      kind: opts.kind,
      slug: opts.slug,
      title: opts.title,
      fields: opts.fields,
      source: opts.source,
      confidence: opts.confidence,
      actor: opts.actor,
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(
      `${chalk.green('✓')} ${opts.kind}/${opts.slug} ${result.created ? 'created' : 'exists'}; +${result.factIds.length} fact(s)`,
    );
    if (result.created && result.create_safety === 'probable' && result.candidates.length > 0) {
      const top = result.candidates
        .slice(0, 3)
        .map((c) => `${c.kind}/${c.slug} (${c.similarity.toFixed(2)})`)
        .join(', ');
      console.log(
        `  ${chalk.yellow('⚠')} possible duplicate of: ${top} — run ${chalk.bold(`roster brain merge ${opts.slug} <into-slug>`)} if so`,
      );
    }
  }
  return EXIT_OK;
}

export type BrainMergeOptions = RuntimeVerbOptions & {
  fromSlug: string;
  intoSlug: string;
  kind?: string;
  actor?: string;
};

export async function executeBrainMerge(opts: BrainMergeOptions): Promise<number> {
  const result = await withVerifiedRuntimeClient(opts.cwd, (client) =>
    mergeEntities(client, {
      fromSlug: opts.fromSlug,
      intoSlug: opts.intoSlug,
      kind: opts.kind,
      actor: opts.actor,
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(
      `${chalk.green('✓')} merged ${opts.fromSlug} → ${opts.intoSlug}; canonical #${result.canonicalId}; +${result.aliasesAdded} alias(es)`,
    );
  }
  return EXIT_OK;
}

export type BrainEventOptions = RuntimeVerbOptions & {
  kind: string;
  slug?: string;
  payload: unknown;
  actor?: string;
};

export async function executeBrainEvent(opts: BrainEventOptions): Promise<number> {
  const result = await withVerifiedRuntimeClient(opts.cwd, (client) =>
    appendEvent(client, { kind: opts.kind, slug: opts.slug, payload: opts.payload, actor: opts.actor }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`${chalk.green('✓')} event '${opts.kind}' #${result.eventId}`);
  }
  return EXIT_OK;
}

export type BrainLinkOptions = RuntimeVerbOptions & {
  srcSlug: string;
  rel: string;
  dstSlug: string;
  kindSrc?: string;
  kindDst?: string;
  props?: unknown;
  actor?: string;
};

// #383/D1: edges carry no immutable source-version citation, and #397 owns that
// migration. The label is explicit so `link` is visibly deferred rather than
// silently deferred; citation ENFORCEMENT for save/event/merge is PR B's.
export async function executeBrainLink(opts: BrainLinkOptions): Promise<number> {
  const result = await withVerifiedRuntimeClient(opts.cwd, (client) =>
    createLink(client, {
      srcSlug: opts.srcSlug,
      rel: opts.rel,
      dstSlug: opts.dstSlug,
      kindSrc: opts.kindSrc,
      kindDst: opts.kindDst,
      props: opts.props,
      actor: opts.actor,
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result, cited: false, citation_owner: '397' }, null, 2));
  } else {
    console.log(`${chalk.green('✓')} ${opts.srcSlug} -[${opts.rel}]-> ${opts.dstSlug} #${result.edgeId}`);
    console.log(`  ${chalk.yellow('⚠')} recorded without a citation — edge citation ships in #397`);
  }
  return EXIT_OK;
}

export type BrainGetOptions = RuntimeVerbOptions & { kind: string; slug: string };

export async function executeBrainGet(opts: BrainGetOptions): Promise<number> {
  const truth = await withVerifiedRuntimeClient(opts.cwd, (client) => getEntity(client, opts.kind, opts.slug));
  if (truth.entity === null) {
    if (opts.json) console.log(JSON.stringify({ ok: false, found: false }, null, 2));
    else console.log(chalk.yellow(`no entity ${opts.kind}/${opts.slug}`));
    return EXIT_ERROR;
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...truth }, null, 2));
  } else {
    console.log(chalk.bold(`${truth.entity.kind}/${truth.entity.slug}${truth.entity.title ? ` — ${truth.entity.title}` : ''}`));
    for (const f of truth.facts) {
      const attrib = f.actor || f.source ? chalk.dim(` (${[f.source, f.actor].filter(Boolean).join('/')})`) : '';
      console.log(`  ${f.key} = ${JSON.stringify(f.value)}${attrib}`);
    }
    for (const ev of truth.events) console.log(`  ${chalk.dim('event')} ${ev.kind}`);
    for (const ed of truth.edges) {
      const arrow = ed.direction === 'out' ? '->' : '<-';
      console.log(`  ${chalk.dim('edge')} ${arrow} ${ed.rel} ${ed.other_kind}/${ed.other_slug}`);
    }
  }
  return EXIT_OK;
}

export type BrainFsOptions = RuntimeVerbOptions & {
  // Test seam: the privacy and boundary regressions need a store double, and
  // the real store is only reachable with live object-storage credentials.
  makeStore?: (config: BrainObjectStoreConfig) => Promise<FileStore>;
} & (
  | { op: 'put'; kind: string; slug: string; file: string; filename?: string; actor?: string }
  | { op: 'get'; kind: string; slug: string; filename: string; out?: string }
  | { op: 'ls'; kind?: string; slug?: string }
  | { op: 'rm'; kind: string; slug: string; filename: string; actor?: string }
);

// The object-storage bucket, endpoint, key, and s3:// URI are private workspace
// identifiers (§10): the namespace fingerprint is the addressable identity a
// caller may see.
export async function executeBrainFs(opts: BrainFsOptions): Promise<number> {
  if (opts.op === 'ls') {
    const entries = await withVerifiedRuntimeClient(opts.cwd, (client) =>
      listFiles(client, { kind: opts.kind, slug: opts.slug }));
    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        op: 'ls',
        files: entries.map((entry) => ({
          kind: entry.kind,
          slug: entry.slug,
          filename: entry.filename,
          size_bytes: entry.sizeBytes,
          indexed: entry.indexed,
        })),
      }, null, 2));
    } else if (entries.length === 0) {
      console.log(chalk.dim('no files'));
    } else {
      for (const e of entries) {
        const size = e.sizeBytes === null ? '' : ` ${chalk.dim(`${e.sizeBytes}B`)}`;
        const idx = e.indexed ? '' : chalk.dim(' (not indexed)');
        console.log(`${e.kind}/${e.slug}/${e.filename}${size}${idx}`);
      }
    }
    return EXIT_OK;
  }

  const activation = assertBrainActivationComplete(opts.cwd, {
    postgres: 'runtime',
    objectStorage: 'live',
  });
  const storeConfig = brainObjectStoreConfigFromRegistry(activation.brain);
  const target = brainFilesTarget(storeConfig);
  const namespaceFingerprint = fingerprintBrainNamespace(activation.brain).fingerprint;

  // Pool first: the runtime credential contract is proven before an
  // object-storage client exists (§6.5 step 6 precedes step 7).
  return await withVerifiedRuntimePool(opts.cwd, async (pool) => {
    const store = opts.makeStore === undefined
      ? await createBrainFilesStore(storeConfig)
      : await opts.makeStore(storeConfig);
    const client = await pool.connect();
    try {
      return await runFsOperation(client, store, opts, target, namespaceFingerprint);
    } finally {
      client.release();
    }
  });
}

async function runFsOperation(
  client: pg.PoolClient,
  store: FileStore,
  opts: Exclude<BrainFsOptions, { op: 'ls' }>,
  target: FilesTarget,
  namespaceFingerprint: string,
): Promise<number> {
  {
    if (opts.op === 'put') {
      const res = await putFile(client, store, target, opts);
      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          op: 'put',
          kind: opts.kind,
          slug: opts.slug,
          filename: opts.filename ?? res.s3Key.slice(res.s3Key.lastIndexOf('/') + 1),
          content_hash: `sha256:${res.contentHash}`,
          size_bytes: res.sizeBytes,
          entity_exists: res.entityExists,
          superseded: res.supersededUri !== null,
          namespace_fingerprint: namespaceFingerprint,
        }, null, 2));
      } else {
        console.log(`${chalk.green('✓')} put ${opts.kind}/${opts.slug}`);
        if (!res.entityExists) {
          console.log(`  ${chalk.yellow('⚠')} entity ${opts.kind}/${opts.slug} not found in brain (file stored anyway)`);
        }
        if (res.supersededUri !== null) console.log(`  ${chalk.dim('·')} superseded the previous namespace object`);
      }
      return EXIT_OK;
    }

    if (opts.op === 'get') {
      const res = await getFile(client, store, { ...opts, expectedBucket: target.bucket });
      const outPath = relative(opts.cwd, res.outPath);
      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          op: 'get',
          kind: opts.kind,
          slug: opts.slug,
          filename: opts.filename,
          out_path: outPath,
          size_bytes: res.bytes,
          hash_matches: res.hashMatches,
        }, null, 2));
      } else {
        console.log(`${chalk.green('✓')} wrote ${outPath} (${res.bytes}B)`);
        if (!res.hashMatches) {
          console.log(`  ${chalk.yellow('⚠')} content hash mismatch — the stored object differs from what the ledger recorded`);
        }
      }
      return EXIT_OK;
    }

    const res = await rmFile(client, store, opts);
    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        op: 'rm',
        kind: opts.kind,
        slug: opts.slug,
        filename: opts.filename,
        tombstoned: true,
        object_deleted: res.s3Deleted,
      }, null, 2));
    } else {
      const del = res.s3Deleted ? 'object deleted' : chalk.yellow('object delete failed — run brain doctor');
      console.log(`${chalk.green('✓')} tombstoned ${opts.kind}/${opts.slug}/${opts.filename}; ${del}`);
    }
    return EXIT_OK;
  }
}

export type BrainRecordOptions = {
  cwd: string;
  json: boolean;
  recordKind: EvidenceRecordVerb;
  payload?: string;
  file?: string;
};

const MAX_RECORD_PAYLOAD_BYTES = 262_144;

function recordPayloadInvalid(reason: string): RosterError {
  return new RosterError({
    header: 'Invalid Brain evidence payload',
    body: `The evidence payload is invalid: ${reason}.`,
    remedy: 'Supply one bounded JSON object that follows the documented Brain evidence contract.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_EVIDENCE_INPUT_INVALID',
    details: { reason },
  });
}

// The payload is never echoed back: durable evidence can carry internal or
// secret-class business text, and a CLI transcript is not a durable store.
export async function executeBrainRecord(opts: BrainRecordOptions): Promise<number> {
  // The pool is opened first so an unconfigured, half-declared, or
  // credential-less workspace refuses BEFORE any caller-supplied file is read.
  return await withVerifiedRuntimePool(opts.cwd, async (pool) => {
    const raw = opts.file === undefined
      ? opts.payload!
      : readWorkspaceFile(opts.cwd, opts.file, { maxBytes: MAX_RECORD_PAYLOAD_BYTES }).toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_PAYLOAD_BYTES) {
      throw recordPayloadInvalid(`it exceeds ${MAX_RECORD_PAYLOAD_BYTES} UTF-8 bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw recordPayloadInvalid('it is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw recordPayloadInvalid('it must be a JSON object');
    }

    const result = opts.recordKind === 'run'
      ? await recordCompletedRun(pool, parsed as CompletedRunInput)
      : opts.recordKind === 'artifact'
        ? await recordRunArtifact(pool, parsed as RunArtifactInput)
        : opts.recordKind === 'feedback'
          ? await recordFeedback(pool, parsed as FeedbackInput)
          : await recordHumanDecision(pool, parsed as HumanDecisionInput);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, kind: opts.recordKind, ...result }, null, 2));
    } else {
      console.log(
        `${chalk.green('✓')} ${opts.recordKind} evidence ${result.status}: ${result.id} (${result.recordFingerprint})`,
      );
    }
    return EXIT_OK;
  });
}
