import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { EXIT_OK, EXIT_ERROR, RosterError } from '../lib/errors.ts';
import {
  ConflictError,
  InvalidRecordError,
  PersistenceError,
  sha256Hex,
  type ArtifactRecord,
  type Cursor,
  type ReadOpts,
  type RunEventEnvelope,
} from '../lib/persistence/contracts.ts';
import {
  assertGenericEventKind,
  assertRunEventDraft,
  isRunEventKind,
  RUN_EVENT_KINDS,
  type RunEventKind,
} from '../lib/persistence/run-events.ts';
import { composeRun, type ComposedRun } from '../lib/persistence/run-compose.ts';
import {
  resolveObjectAdmin,
  resolveOpsBackend,
  type ResolvedOpsBackend,
  type ResolveOptions,
} from '../lib/persistence/resolve.ts';
import type { CreateOnlyObjectStore } from '../lib/persistence/objects.ts';
import { verifyBinding, type PgQueryable } from '../lib/persistence/postgres/binding.ts';
import { BRAIN_ENV_BINDING, OPS_ENV_BINDING, createRolePool } from '../lib/persistence/pool.ts';
import {
  PgRunLedgerSource,
  diagnoseRunLedger,
  fillVersionIds,
  type RunLedgerDiagnosis,
} from '../lib/persistence/run-repair.ts';
import { assertOperationSupported } from '../lib/persistence/capabilities.ts';
import { readCappedFileSync, readCappedStream } from '../lib/bounded-read.ts';
import { parseRunArgs, type RunOptions, type RunVerb } from '../lib/run-args.ts';
import { runIdPathFor, writeScheduleRunId } from '../lib/schedule-state.ts';

// `roster run` (#323 section C): the CLI over the run + artifact ledger. Every
// verb resolves the ops backend once, closes the Postgres pool in a finally, and
// maps a store PersistenceError to a clean exit-1 (a --json envelope for machine
// callers). Dedicated lifecycle verbs stamp source='cli'; the report verb stamps
// source='agent'; the generic `event` verb refuses lifecycle/tool-result/report/
// artifact-declared kinds (they come from dedicated verbs or the #322 hook).

// The PORTABLE raw report cap (round-10 finding 2). It used to advertise 1 MiB,
// which was never achievable end-to-end: the local JSONL backend applies its own
// 1 MiB limit to the ENTIRE SERIALIZED RECORD, so a raw report that passed the
// reader was rejected downstream by a differently-worded error — and a
// quote-heavy report failed well below the advertised number. The cap is now
// derived from what the strictest backend can actually store:
//
//   JSON string escaping expands at most 6× (a control byte becomes \u00XX;
//   a quote or backslash becomes 2 bytes), and the record ALSO carries the
//   sanitized index projection (≤ MAX_INDEX_TEXT raw, escaped by the same
//   factor) plus the sealed envelope + hash chain:
//
//     6 × 131072 (report)   =  786432
//   + 6 ×  16384 (sanitized projection) =  98304
//   + envelope/hash-chain/ids (< 8 KiB)
//   ------------------------------------------------
//                          <  1048576  = MAX_RECORD_BYTES  ✓
//
// 128 KiB is therefore a raw input the reader AND the local ledger both accept,
// for any byte sequence. Larger output has a dedicated path: `declare-artifact`.
export const MAX_REPORT_BYTES = 128 * 1024;
const DIGEST_RE = /^[0-9a-f]{64}$/;

// Test seams: inject the resolver, an object-admin resolver, an admin pool
// factory (repair), and a stdin reader — the real CLI uses the module defaults.
export type RunDeps = {
  resolveBackend?: (cwd: string, opts?: ResolveOptions) => Promise<ResolvedOpsBackend>;
  resolveOpts?: ResolveOptions;
  objectAdmin?: (cwd: string, opts?: ResolveOptions) => Promise<CreateOnlyObjectStore>;
  adminPool?: (
    config: Extract<ResolvedOpsBackend, { state: 'postgres-s3' }>['config'],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ query: PgQueryable['query']; end: () => Promise<void> }>;
  // Returns at most maxBytes + 1 bytes when a cap is passed (report/event);
  // unbounded when it is omitted (declare-artifact's bytes).
  readStdin?: (maxBytes?: number) => Promise<Buffer>;
  // Injectable clock for the fire-sidecar timestamp (tests).
  now?: () => number;
};

type ActiveBackend = Extract<ResolvedOpsBackend, { state: 'local' | 'postgres-s3' | 'degraded' }>;

// ---------- errors ----------

function notConfiguredError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} the operations backend is not configured`,
    body: '  The run ledger needs a configured backend (local or postgres-s3).',
    remedy: `  Run ${chalk.bold('roster ops setup --backend local')} (or ${chalk.bold('--backend postgres-s3 …')}) first.`,
    exitCode: EXIT_ERROR,
  });
}

function setupIncompleteError(journal: Extract<ResolvedOpsBackend, { state: 'setup-incomplete' }>['journal']): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ops setup is incomplete`,
    body: `  Workspace ${journal.workspaceName} (${journal.workspaceId}) has an in-flight setup at phase '${journal.phase}'.`,
    remedy: `  ${journal.remedy}`,
    exitCode: EXIT_ERROR,
  });
}

function usageError(detail: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ${detail}`,
    body: '',
    remedy: `  Run ${chalk.bold('roster run')} for usage.`,
    exitCode: EXIT_ERROR,
  });
}

export function runUsageError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} usage: roster run <verb> [flags]`,
    body: [
      '  Verbs:',
      '    start <run> [--schedule <name>]  record a run-start (source=cli); --schedule stamps the fire sidecar',
      '    end <run>                        record a run-end lifecycle event (source=cli)',
      `    event --run <id> --kind <k> --correlation-id <c>   record a generic event (${RUN_EVENT_KINDS.filter(
        (k) => k === 'error' || k === 'retry' || k === 'resumed' || k === 'approval-ref',
      ).join(' | ')})`,
      '    report --run <id> (--file <p> | --stdin)           store the agent report (source=agent; 128 KiB raw cap)',
      '    declare-artifact --run <id> --agent <a> …          declare a produced/used artifact',
      '    show <run>                       reconstruct + print a run',
      '    list [--task <id>] [--agent <a>] [--limit <n>]     list runs',
      '    doctor                           diagnose ledger drift (postgres-s3)',
      '    repair --fill-version-ids        fill missing object version ids (admin)',
      '  Global: --cwd <dir>  --json  --allow-partial',
    ].join('\n'),
    remedy: `  Run ${chalk.bold('roster --help')} for the full command list.`,
    exitCode: EXIT_ERROR,
  });
}

// ---------- backend plumbing ----------

async function withBackend<T>(
  cwd: string,
  deps: RunDeps,
  fn: (active: ActiveBackend) => Promise<T>,
): Promise<T> {
  const resolve = deps.resolveBackend ?? resolveOpsBackend;
  const resolved = await resolve(cwd, deps.resolveOpts);
  if (resolved.state === 'legacy') throw notConfiguredError();
  if (resolved.state === 'setup-incomplete') throw setupIncompleteError(resolved.journal);
  try {
    return await fn(resolved);
  } finally {
    if (resolved.state === 'postgres-s3') await resolved.close();
  }
}

function readOptsFor(opts: RunOptions): ReadOpts | undefined {
  return opts.allowPartial ? { allowPartial: true } : undefined;
}

function parseData(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw usageError(`--data is not valid JSON: ${raw.slice(0, 80)}`);
  }
}

function requireRun(opts: RunOptions, verb: RunVerb): string {
  if (opts.runId === undefined || opts.runId.length === 0) {
    throw usageError(`roster run ${verb} needs a run id (positional <run> or --run <id>)`);
  }
  return opts.runId;
}

function requireFlag(value: string | undefined, verb: RunVerb, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw usageError(`roster run ${verb} requires ${flag}`);
  }
  return value;
}

function outcomeWord(outcome: 'committed' | 'queued'): string {
  return outcome === 'queued' ? chalk.yellow('queued') : chalk.green('committed');
}

function failPersistence(err: PersistenceError, opts: RunOptions): number {
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: err.name, message: err.message }));
    return EXIT_ERROR;
  }
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} ${err.message}`,
    body: '',
    remedy:
      err instanceof ConflictError
        ? '  A record with this identity already exists with different content — this is not a duplicate replay.'
        : `  Run ${chalk.bold('roster run')} for usage.`,
    exitCode: EXIT_ERROR,
  });
}

// ---------- lifecycle verbs (start / end) ----------

async function verbLifecycle(kind: 'run-start' | 'run-end', opts: RunOptions, deps: RunDeps): Promise<number> {
  const runId = requireRun(opts, kind === 'run-start' ? 'start' : 'end');
  const cwd = opts.cwd ?? process.cwd();
  // Seal-check the COMPLETE event before anything is resolved, written, or
  // spooled (round-7 finding 4). This verb touches TWO stores — the ledger and
  // the per-fire sidecar — so every caller-supplied field (JSON --data, run id,
  // agent charset, dedupe/correlation rules, field caps) is validated up front
  // and neither store is touched for an event that cannot be sealed. The
  // mutation ORDER below stays round-6 finding 6's (append, then sidecar): a
  // sidecar must never name a run the ledger does not hold.
  const draft = {
    runId,
    kind,
    data: parseData(opts.data),
    agent: opts.agent ?? null,
    skill: opts.skill ?? null,
    trigger: opts.trigger ?? null,
    parentRunId: opts.parentRun ?? null,
    originTaskId: opts.originTask ?? null,
  };
  assertRunEventDraft(draft);
  return await withBackend(cwd, deps, async (active) => {
    // Validate-then-mutate (round-5 finding 3): a scheduled run-start validates
    // ALL sidecar inputs (--function present, fire id present, every path segment
    // safe) BEFORE any mutation, so a rejected start (missing --function, missing
    // fire id, `--schedule ../../../important`) writes neither a run-start event
    // nor a sidecar. The sidecar `logs/cron/<function>/<schedule>/<fireId>.run-id`
    // is keyed by the OUTER cron wrapper's fire id (ROSTER_FIRE_ID, or --fire-id
    // for tests), which also names the wrapper's `<fireId>.exit`, so pending-sync
    // pairs them by EXACT token.
    let sidecar: { functionName: string; schedule: string; fireId: string } | null = null;
    if (kind === 'run-start' && opts.schedule !== undefined && opts.schedule.length > 0) {
      const fnName = requireFlag(opts.functionName, 'start', '--function (required with --schedule)');
      const env = deps.resolveOpts?.env ?? process.env;
      const fireId = opts.fireId ?? env.ROSTER_FIRE_ID;
      if (fireId === undefined || fireId.length === 0) {
        throw usageError(
          'roster run start --schedule needs a fire id — pass --fire-id or set ROSTER_FIRE_ID (the cron wrapper exports it)',
        );
      }
      // Rejects `..`/`/`/control chars in any segment before the ledger append.
      runIdPathFor(cwd, fnName, opts.schedule, fireId);
      sidecar = { functionName: fnName, schedule: opts.schedule, fireId };
    }
    // Ledger append FIRST, sidecar SECOND (round-6 finding 6): a sidecar
    // committed before a failed appendEvent would correlate a NONEXISTENT run —
    // a later `<fireId>.exit` would then close a phantom (or a future run reusing
    // the id). With this order a crash between the two leaves a recorded run
    // with no sidecar: crash correlation for that fire is degraded, but stale
    // detection still surfaces it — the fail-closed direction.
    const res = await active.backend.runs.appendEvent(draft);
    if (sidecar !== null) {
      try {
        writeScheduleRunId(cwd, sidecar.functionName, sidecar.schedule, runId, sidecar.fireId, (deps.now ?? Date.now)());
      } catch (err) {
        if (err instanceof ConflictError) {
          // Round-7 finding 2: the fire id already binds a DIFFERENT run. This
          // is a deliberate identity conflict, NOT an availability failure — if
          // this start exited 0, run B would proceed while the sidecar stays
          // bound to A: A's `.exit` would later close A against B's work, and B
          // would stay uncorrelated forever. Instead: the run-start for B is
          // already appended (ledger-first ordering), so close B with a
          // compensating error + run-end — leaving no stuck 'running' run —
          // then fail HARD, naming the run the fire id is bound to (the
          // ConflictError message carries it).
          try {
            await active.backend.runs.appendEvent({
              runId,
              kind: 'error',
              correlationId: `fire-conflict-${sidecar.fireId}`,
              data: {
                source: 'run-start',
                signal: 'fire-conflict',
                fireId: sidecar.fireId,
                detail: err.message,
              },
              agent: opts.agent ?? null,
            });
            await active.backend.runs.appendEvent({
              runId,
              kind: 'run-end',
              data: { source: 'run-start', closedBy: 'fire-conflict' },
            });
          } catch {
            // Best-effort compensation: if the close itself fails, the hard
            // error below still surfaces and stale detection sweeps the run.
          }
          throw err;
        }
        // Genuine I/O/availability failure only: the run-start is durably
        // recorded; only the fire↔run correlation channel failed. Warn (stderr,
        // so --json stdout stays parseable) and exit 0.
        console.error(
          chalk.yellow(
            `roster: fire sidecar write failed (${(err as Error).message}) — crash correlation for this fire is degraded; stale detection still works`,
          ),
        );
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, verb: kind === 'run-start' ? 'start' : 'end', runId, ...res }));
    } else {
      console.log(`${chalk.green('✓')} ${kind} ${chalk.bold(runId)} — ${outcomeWord(res.outcome)} ${chalk.dim(res.id)}`);
    }
    return EXIT_OK;
  });
}

// ---------- generic event verb ----------

async function verbEvent(opts: RunOptions, deps: RunDeps): Promise<number> {
  const runId = requireRun(opts, 'event');
  const kindStr = requireFlag(opts.eventKind, 'event', '--kind');
  if (!isRunEventKind(kindStr)) {
    throw usageError(`'${kindStr}' is not a run-event kind (expected ${RUN_EVENT_KINDS.join(' | ')})`);
  }
  const kind: RunEventKind = kindStr;
  assertGenericEventKind(kind); // refuses lifecycle / tool-* / report / artifact-declared
  const cwd = opts.cwd ?? process.cwd();
  // --data (argv JSON) or --stdin (JSON on stdin) — mutually exclusive. --stdin is
  // the injection-safe path the orchestrator uses for an error event carrying an
  // untrusted subagent status: the JSON is piped (a quoted heredoc), never
  // string-interpolated into a shell-quoted argument (round-5 finding 6).
  if (opts.data !== undefined && opts.stdin) {
    throw usageError('roster run event: --data and --stdin are mutually exclusive');
  }
  let data: unknown;
  if (opts.stdin) {
    const bytes = await (deps.readStdin ?? readStdin)(MAX_REPORT_BYTES);
    if (bytes.byteLength > MAX_REPORT_BYTES) {
      throw usageError(
        `event --stdin payload exceeds the ${MAX_REPORT_BYTES}-byte cap (128 KiB — the portable raw limit every backend can store)`,
      );
    }
    const text = bytes.toString('utf8');
    try {
      data = JSON.parse(text);
    } catch {
      throw usageError(`--stdin is not valid JSON: ${text.slice(0, 80)}`);
    }
  } else {
    data = parseData(opts.data);
  }
  return await withBackend(cwd, deps, async (active) => {
    const res = await active.backend.runs.appendEvent({
      runId,
      kind,
      data,
      correlationId: opts.correlationId ?? null,
      agent: opts.agent ?? null,
      skill: opts.skill ?? null,
      trigger: opts.trigger ?? null,
      parentRunId: opts.parentRun ?? null,
      originTaskId: opts.originTask ?? null,
    });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, verb: 'event', runId, kind, ...res }));
    } else {
      console.log(`${chalk.green('✓')} event ${chalk.bold(kind)} on ${chalk.bold(runId)} — ${outcomeWord(res.outcome)} ${chalk.dim(res.id)}`);
    }
    return EXIT_OK;
  });
}

// ---------- report verb (agent prose → sanitized index input) ----------

// `maxBytes` bounds the buffering itself (round-9 finding 2): the reader stops
// one byte past the cap so an unbounded pipe can never be drained into memory
// just to be rejected afterwards. Omitted (undefined) = unbounded, which is
// what declare-artifact's bytes keep — artifact input has its own large-input
// policy and is digest-verified, not capped.
async function readStdin(maxBytes?: number): Promise<Buffer> {
  return await readCappedStream(process.stdin, maxBytes ?? null);
}

// `size` is null when the over-cap verdict came from the READ rather than an
// initial stat (an unbounded pipe, or a file that grew past the cap mid-read):
// no byte count we hold is the truth then, so none is quoted (round-10 finding
// 3 — quoting the stale pre-read size claimed a sub-cap file exceeded the cap).
function reportCapError(what: string, size: number | null): RosterError {
  const measured =
    size === null
      ? `exceeds the ${MAX_REPORT_BYTES}-byte cap`
      : `is ${size} bytes; the cap is ${MAX_REPORT_BYTES}`;
  return usageError(
    `${what} ${measured} — ${MAX_REPORT_BYTES} bytes (128 KiB) is the portable raw limit every backend can store (upload large output via 'declare-artifact')`,
  );
}

async function verbReport(opts: RunOptions, deps: RunDeps): Promise<number> {
  const runId = requireRun(opts, 'report');
  if (opts.file !== undefined && opts.stdin) {
    throw usageError('roster run report: --file and --stdin are mutually exclusive');
  }
  if (opts.file === undefined && !opts.stdin) {
    throw usageError('roster run report requires --file <path> or --stdin');
  }
  let bytes: Buffer;
  if (opts.stdin) {
    bytes = await (deps.readStdin ?? readStdin)(MAX_REPORT_BYTES);
    if (bytes.byteLength > MAX_REPORT_BYTES) throw reportCapError('report', null);
  } else {
    const read = readCappedFileSync(opts.file!, MAX_REPORT_BYTES);
    if (read.state === 'unreadable') {
      throw usageError(`cannot read report file '${opts.file}': ${read.error}`);
    }
    if (read.state === 'over-cap') throw reportCapError(`report file '${opts.file}'`, read.size);
    bytes = read.bytes;
  }
  const cwd = opts.cwd ?? process.cwd();
  return await withBackend(cwd, deps, async (active) => {
    const res = await active.backend.runs.appendEvent({
      runId,
      kind: 'report',
      data: bytes.toString('utf8'),
      agent: opts.agent ?? null,
    });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, verb: 'report', runId, bytes: bytes.byteLength, ...res }));
    } else {
      console.log(`${chalk.green('✓')} report on ${chalk.bold(runId)} (${bytes.byteLength} B) — ${outcomeWord(res.outcome)} ${chalk.dim(res.id)}`);
    }
    return EXIT_OK;
  });
}

// ---------- declare-artifact verb ----------

function parseExternalRef(ref: string): { provider: string; externalId: string } {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx === ref.length - 1) {
    throw usageError(`--external must be 'provider:external_id' (got '${ref}')`);
  }
  return { provider: ref.slice(0, idx), externalId: ref.slice(idx + 1) };
}

async function verbDeclareArtifact(opts: RunOptions, deps: RunDeps): Promise<number> {
  const runId = requireRun(opts, 'declare-artifact');
  const agent = requireFlag(opts.agent, 'declare-artifact', '--agent (the declaring agent)');
  const role = (opts.role ?? 'produced') as 'produced' | 'used';
  const isExternal = opts.external !== undefined;
  const isInternal = opts.digest !== undefined || opts.file !== undefined || opts.stdin;
  if (isExternal && isInternal) {
    throw usageError('declare-artifact: --external is mutually exclusive with --digest/--file/--stdin');
  }
  if (!isExternal && !isInternal) {
    throw usageError('declare-artifact needs either --external provider:id (external) or --digest + --file/--stdin (internal)');
  }
  const cwd = opts.cwd ?? process.cwd();

  if (isExternal) {
    const { provider, externalId } = parseExternalRef(opts.external!);
    return await withBackend(cwd, deps, async (active) => {
      const res = await active.backend.artifacts.putExternal({
        runId,
        declaringAgent: agent,
        role,
        provider,
        externalId,
        externalUrl: opts.url ?? null,
        artifactType: opts.artifactType ?? null,
        mediaType: opts.mediaType ?? null,
        text: opts.text ?? null,
      });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, verb: 'declare-artifact', kind: 'external', runId, role, provider, externalId, ...res }));
      } else {
        console.log(`${chalk.green('✓')} declared external ${chalk.bold(`${provider}:${externalId}`)} (${role}) on ${chalk.bold(runId)} — ${outcomeWord(res.outcome)} ${chalk.dim(res.id)}`);
      }
      return EXIT_OK;
    });
  }

  // internal: bytes + declaration.
  const digest = requireFlag(opts.digest, 'declare-artifact', '--digest');
  if (!DIGEST_RE.test(digest)) {
    throw usageError('--digest must be a full-length lowercase sha256 hex digest');
  }
  if (opts.file !== undefined && opts.stdin) {
    throw usageError('declare-artifact: --file and --stdin are mutually exclusive');
  }
  if (opts.file === undefined && !opts.stdin) {
    throw usageError('declare-artifact (internal) requires --file <path> or --stdin for the bytes');
  }
  // DELIBERATE exemption from the report cap (round-9 finding 2): artifact bytes
  // are the large-payload escape hatch the cap error points at, and they are
  // digest-verified here, so this read stays whole-input by policy — hence the
  // uncapped readStdin() and the plain readFileSync.
  let bytes: Buffer;
  if (opts.stdin) {
    bytes = await (deps.readStdin ?? readStdin)();
  } else {
    try {
      bytes = readFileSync(opts.file!);
    } catch (err) {
      throw usageError(`cannot read artifact file '${opts.file}': ${(err as Error).message}`);
    }
  }
  const actual = sha256Hex(bytes);
  if (actual !== digest) {
    throw new InvalidRecordError(`--digest ${digest} does not match the file's sha256 ${actual}`);
  }
  const filename = opts.filename ?? (opts.file !== undefined ? basename(opts.file) : 'artifact');
  return await withBackend(cwd, deps, async (active) => {
    const res = await active.backend.artifacts.putArtifact(
      { filename, contentType: opts.mediaType ?? 'application/octet-stream', runId },
      bytes,
      {
        runId,
        declaringAgent: agent,
        role,
        artifactType: opts.artifactType ?? null,
        mediaType: opts.mediaType ?? null,
        text: opts.text ?? null,
      },
    );
    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: true,
          verb: 'declare-artifact',
          kind: 'internal',
          runId,
          role,
          digest: res.digest,
          objectVersionId: res.objectVersionId,
          declarationId: res.declarationId,
          outcome: res.outcome,
          blobOutcome: res.blobOutcome,
          declarationOutcome: res.declarationOutcome,
          id: res.id,
        }),
      );
    } else {
      console.log(
        `${chalk.green('✓')} declared internal ${chalk.bold(digest.slice(0, 12))} (${role}) on ${chalk.bold(runId)} — blob ${outcomeWord(res.blobOutcome)}, declaration ${res.declarationOutcome ? outcomeWord(res.declarationOutcome) : chalk.dim('(none)')} ${chalk.dim(res.declarationId ?? '')}`,
      );
    }
    return EXIT_OK;
  });
}

// ---------- show verb ----------

function renderComposed(composed: ComposedRun): void {
  const lc = composed.lifecycle;
  console.log('');
  console.log(`${chalk.bold('run')} ${chalk.cyan(composed.runId)}  ${chalk.dim(`[${lc.status}]`)}`);
  if (lc.startedAt !== null) console.log(`  started : ${new Date(lc.startedAt).toISOString()}`);
  if (lc.endedAt !== null) console.log(`  ended   : ${new Date(lc.endedAt).toISOString()}`);
  if (composed.durationDerived !== null) console.log(`  duration: ${composed.durationDerived} ms`);
  if (composed.report !== null) {
    console.log(`  report  : ${chalk.dim('(unverified agent prose; sanitized index below)')}`);
    if (composed.report.sanitizedText !== null) {
      console.log('    ' + composed.report.sanitizedText.split('\n').slice(0, 8).join('\n    '));
    }
  }
  if (composed.toolCalls.length > 0) {
    console.log(`  tools   : ${composed.toolCalls.length} (${composed.toolCalls.filter((t) => t.externalSuccessPromoted).length} host-attested success)`);
  }
  if (composed.artifacts.length > 0) {
    console.log(`  artifacts:`);
    for (const a of composed.artifacts) {
      const d = a.declaration;
      const ref = d.kind === 'external' ? `${d.provider}:${d.externalId}` : (d.digest ?? '?').slice(0, 12);
      console.log(`    ${chalk.dim(a.state.padEnd(8))} ${d.role.padEnd(8)} ${ref} ${a.verified ? chalk.green('verified') : chalk.dim('unverified')}`);
    }
  }
  if (composed.errors.length > 0) console.log(`  errors  : ${composed.errors.length}`);
  if (composed.retries.length > 0) console.log(`  retries : ${composed.retries.length}`);
  console.log('');
}

async function verbShow(opts: RunOptions, deps: RunDeps): Promise<number> {
  const runId = requireRun(opts, 'show');
  const cwd = opts.cwd ?? process.cwd();
  const readOpts = readOptsFor(opts);
  return await withBackend(cwd, deps, async (active) => {
    const run = await active.backend.runs.getRun(runId, readOpts);
    const declarations = await active.backend.artifacts.getByRun(runId, readOpts);
    if ((run === null || run.events.length === 0) && declarations.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: 'not-found', runId }));
      } else {
        console.log(chalk.yellow(`run '${runId}' not found`));
      }
      return EXIT_ERROR;
    }
    const blobResolver = async (digest: string): Promise<ArtifactRecord | null> =>
      await active.backend.artifacts.head(digest, readOpts);
    const composed = await composeRun(runId, run?.events ?? [], declarations, blobResolver);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, run: composed }, null, 2));
    } else {
      renderComposed(composed);
    }
    return EXIT_OK;
  });
}

// ---------- list verb ----------

type RunListRow = {
  runId: string;
  agent: string | null;
  originTaskId: string | null;
  status: ComposedRun['lifecycle']['status'];
  events: number;
  startedAt: number;
  lastEventAt: number;
  queued: boolean;
};

function firstDefined(events: RunEventEnvelope[], pick: (e: RunEventEnvelope) => string | null): string | null {
  for (const e of events) {
    const v = pick(e);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

async function verbList(opts: RunOptions, deps: RunDeps): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const readOpts = readOptsFor(opts);
  const limit = opts.limit ?? 100;
  const hasFilter = opts.agent !== undefined || opts.task !== undefined;
  return await withBackend(cwd, deps, async (active) => {
    // Filter BEFORE the limit (finding: run list filters after the limit — a
    // match beyond the first page was dropped). With a filter active, scan the
    // store in LARGE internal pages (independent of the small output `limit`) so a
    // match many runs deep is still found, and keep paging (bounded) until `limit`
    // matches are collected or the store is exhausted (finding: with --limit 1 a
    // per-`limit` page + a 50-page cap silently dropped a match at run 51).
    const MAX_PAGES = 200;
    const SCAN_PAGE = hasFilter ? 500 : limit;
    const filtered: RunListRow[] = [];
    let cursor: Cursor | undefined = undefined;
    let partial = false;
    let truncated = false;
    let pages = 0;
    do {
      const page = await active.backend.runs.listRuns({ limit: SCAN_PAGE }, cursor, readOpts);
      partial = partial || page.partial;
      for (const summary of page.items) {
        const run = await active.backend.runs.getRun(summary.runId, readOpts);
        const events = run?.events ?? [];
        const composed = await composeRun(summary.runId, events, [], () => null);
        const row: RunListRow = {
          runId: summary.runId,
          agent: firstDefined(events, (e) => e.agent),
          originTaskId: firstDefined(events, (e) => e.originTaskId),
          status: composed.lifecycle.status,
          events: summary.events,
          startedAt: summary.startedAt,
          lastEventAt: summary.lastEventAt,
          queued: summary.queued,
        };
        if (
          (opts.agent === undefined || row.agent === opts.agent) &&
          (opts.task === undefined || row.originTaskId === opts.task)
        ) {
          filtered.push(row);
          if (filtered.length >= limit) break;
        }
      }
      cursor = page.cursor ?? undefined;
      pages += 1;
    } while (hasFilter && cursor !== undefined && filtered.length < limit && pages < MAX_PAGES);
    // The safety bound was reached with runs still unscanned and the requested
    // count unmet: signal a partial/truncated result rather than silently
    // returning fewer matches than exist (finding: MAX_PAGES stopped traversal
    // with no signal).
    if (hasFilter && cursor !== undefined && filtered.length < limit && pages >= MAX_PAGES) {
      truncated = true;
    }
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, runs: filtered, partial: partial || truncated, truncated }));
    } else {
      const flag = truncated
        ? chalk.yellow(`  (partial — scan bound hit after ${pages} pages; narrow with --task/--agent)`)
        : partial
          ? chalk.yellow('  (partial — overlay only)')
          : '';
      console.log('');
      console.log(chalk.bold('roster runs') + flag);
      if (filtered.length === 0) console.log(chalk.dim('  (none)'));
      for (const r of filtered) {
        const q = r.queued ? chalk.yellow(' queued') : '';
        console.log(
          `  ${chalk.cyan(r.status.padEnd(9))} ${chalk.bold(r.runId)}  ${chalk.dim(`${r.events} ev`)}  ${r.agent ?? chalk.dim('—')}${q}`,
        );
      }
      if (truncated) {
        console.error(
          chalk.yellow(
            `roster run list: scanned ${pages} pages (safety bound) without filling --limit ${limit} — more runs may match; narrow with --task/--agent.`,
          ),
        );
      }
      console.log('');
    }
    return EXIT_OK;
  });
}

// ---------- doctor + repair (postgres-s3 only) ----------

// Both admin verbs run v2-only declaration/version SQL and enumerate the bucket
// OUTSIDE the capability-gated store wrappers, so the gate has to be asserted
// here — BEFORE any admin resource is resolved and before any SQL is issued
// (round-8 finding 4). A supported v1 postgres-s3 backend therefore refuses with
// the same actionable VersionSkewError every other run-ledger op gives, instead
// of a raw missing-table/column database error.
function requirePostgres(
  active: ActiveBackend,
  verb: string,
  operation: 'runs.doctor' | 'runs.repair',
): Extract<ResolvedOpsBackend, { state: 'postgres-s3' }> {
  if (active.state !== 'postgres-s3') {
    throw usageError(
      `roster run ${verb} requires the postgres-s3 backend (this workspace is '${active.state}') — object listing + version repair are S3-only`,
    );
  }
  assertOperationSupported(active.info, operation);
  return active;
}

function renderDiagnosis(diag: RunLedgerDiagnosis): void {
  console.log('');
  console.log(chalk.bold('roster run doctor') + chalk.dim(`  (${diag.counts.runs} runs, ${diag.counts.declarations} declarations, ${diag.counts.blobs} blobs, ${diag.counts.objects} objects)`));
  if (diag.findings.length === 0) {
    console.log(`  ${chalk.green('✓')} no ledger drift detected`);
  } else {
    for (const f of diag.findings) {
      console.log(`  ${chalk.yellow('!')} ${chalk.bold(f.kind)} — ${f.detail}`);
    }
  }
  if (diag.deep.performed) {
    console.log(chalk.dim(`  deep digest check: ${diag.deep.checked} object(s)${diag.deep.limited ? ' (bounded — more remain)' : ''}`));
  }
  console.log('');
}

async function verbDoctor(opts: RunOptions, deps: RunDeps): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  return await withBackend(cwd, deps, async (active) => {
    const pg = requirePostgres(active, 'doctor', 'runs.doctor');
    const objects = await (deps.objectAdmin ?? resolveObjectAdmin)(cwd, deps.resolveOpts);
    const source = new PgRunLedgerSource({
      db: pg.pool,
      workspaceId: pg.config.workspace.id,
      objects,
      admin: pg.pool,
    });
    const diag = await diagnoseRunLedger(source, { deep: true });
    if (opts.json) {
      console.log(JSON.stringify({ ok: diag.findings.length === 0, ...diag }, null, 2));
    } else {
      renderDiagnosis(diag);
    }
    return diag.findings.length === 0 ? EXIT_OK : EXIT_ERROR;
  });
}

async function defaultAdminPool(
  config: Extract<ResolvedOpsBackend, { state: 'postgres-s3' }>['config'],
  env: NodeJS.ProcessEnv,
): Promise<{ query: PgQueryable['query']; end: () => Promise<void> }> {
  const binding = config.postgres.database === 'brain' ? BRAIN_ENV_BINDING : OPS_ENV_BINDING;
  const url = env[binding.admin];
  if (typeof url !== 'string' || url.length === 0) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} run repair needs admin credentials`,
      body: `  ${binding.admin} is not set. Filling object version ids is an admin-only mutation (the runtime role holds no UPDATE grant).`,
      remedy: `  Export ${binding.admin} (the same admin URL setup used) and re-run.`,
      exitCode: EXIT_ERROR,
    });
  }
  return createRolePool(binding, 'admin', url);
}

async function verbRepair(opts: RunOptions, deps: RunDeps): Promise<number> {
  if (!opts.fillVersionIds) {
    throw usageError('roster run repair currently supports only --fill-version-ids');
  }
  const cwd = opts.cwd ?? process.cwd();
  return await withBackend(cwd, deps, async (active) => {
    const pg = requirePostgres(active, 'repair', 'runs.repair');
    const objects = await (deps.objectAdmin ?? resolveObjectAdmin)(cwd, deps.resolveOpts);
    const env = deps.resolveOpts?.env ?? process.env;
    const admin = await (deps.adminPool ?? defaultAdminPool)(pg.config, env);
    try {
      const adminQ: PgQueryable = { query: (text, values) => admin.query(text, values) };
      // Verify the ADMIN connection's database belongs to the configured
      // workspace BEFORE any mutation (finding: repair ran the version-id fill
      // through an UNBOUND admin pool — a swapped admin URL would UPDATE a foreign
      // workspace's database). The runtime `db` pool is a BoundPool (verified per
      // connection); this closes the gap on the separate admin credential.
      await verifyBinding(adminQ, pg.config.workspace.id);
      const source = new PgRunLedgerSource({
        db: pg.pool,
        workspaceId: pg.config.workspace.id,
        objects,
        admin: adminQ,
      });
      const result = await fillVersionIds(source);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, verb: 'repair', ...result }));
      } else {
        console.log('');
        console.log(chalk.bold('roster run repair --fill-version-ids'));
        console.log(`  ${chalk.green('✓')} filled ${result.filled.length} object version id(s)`);
        if (result.skippedNoObject.length > 0) console.log(`  ${chalk.yellow('!')} ${result.skippedNoObject.length} skipped — object missing`);
        if (result.skippedNoVersion.length > 0) console.log(`  ${chalk.yellow('!')} ${result.skippedNoVersion.length} skipped — store returned no version id`);
        if (result.skippedDigestMismatch.length > 0) console.log(`  ${chalk.red('✗')} ${result.skippedDigestMismatch.length} skipped — bytes do NOT match the digest (NOT blessed)`);
        console.log('');
      }
      return EXIT_OK;
    } finally {
      await admin.end();
    }
  });
}

// ---------- dispatch ----------

export async function executeRun(verb: RunVerb, opts: RunOptions, deps: RunDeps = {}): Promise<number> {
  try {
    switch (verb) {
      case 'start':
        return await verbLifecycle('run-start', opts, deps);
      case 'end':
        return await verbLifecycle('run-end', opts, deps);
      case 'event':
        return await verbEvent(opts, deps);
      case 'report':
        return await verbReport(opts, deps);
      case 'declare-artifact':
        return await verbDeclareArtifact(opts, deps);
      case 'show':
        return await verbShow(opts, deps);
      case 'list':
        return await verbList(opts, deps);
      case 'doctor':
        return await verbDoctor(opts, deps);
      case 'repair':
        return await verbRepair(opts, deps);
    }
  } catch (err) {
    if (err instanceof PersistenceError) return failPersistence(err, opts);
    throw err;
  }
}

// argv front door (bin dispatch mirrors the `ops`/`task` wiring).
export async function runRun(argv: readonly string[], deps: RunDeps = {}): Promise<number> {
  const parsed = parseRunArgs(argv);
  if (parsed.kind === 'usage') throw runUsageError();
  if (parsed.kind === 'err') throw usageError(parsed.message);
  return await executeRun(parsed.verb, parsed.opts, deps);
}
