import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { RosterError, EXIT_ERROR } from './errors.ts';

type CrontabReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'no-crontab'; content: '' }
  | { ok: false; reason: 'error'; message: string };

export type CrontabIO = {
  read(): CrontabReadResult;
  write(content: string): void;
};

export function defaultCrontabIO(): CrontabIO {
  return {
    read() {
      const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      if (r.status === 0) return { ok: true, content: r.stdout ?? '' };
      const stderr = (r.stderr ?? '').toLowerCase();
      if (stderr.includes('no crontab')) return { ok: false, reason: 'no-crontab', content: '' };
      return {
        ok: false,
        reason: 'error',
        message: `crontab -l exited ${r.status ?? '?'}: ${r.stderr?.trim() ?? 'unknown error'}`,
      };
    },
    write(content: string) {
      const r = spawnSync('crontab', ['-'], { encoding: 'utf8', input: content });
      if (r.status !== 0) {
        throw new RosterError({
          header: `${chalk.red.bold('roster:')} crontab write failed`,
          body: `  crontab - exited ${r.status ?? '?'}: ${r.stderr?.trim() ?? 'unknown error'}`,
          remedy: `  Check 'crontab -l' manually; you may need to grant Terminal Full Disk Access on macOS.`,
          exitCode: EXIT_ERROR,
        });
      }
    },
  };
}

// POSIX single-quote escape. Wraps the value in single quotes and uses the
// '\'' dance to embed any single quotes from the value itself. Safe for any
// byte sequence including spaces, double quotes, backticks, dollar signs.
// Refuses newlines and NUL bytes (codex review impl-pass): a literal '\n' in
// a single-quoted value survives quoting and breaks crontab into multiple
// lines; NUL would silently truncate.
export function shellQuote(value: string): string {
  if (value.includes('\n') || value.includes('\0')) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} cannot shell-quote value with newline or NUL`,
      body: `  Value contains a forbidden control character. Crontab lines must be single-line.`,
      remedy: `  Move the workspace to a path that does not contain newlines or NUL bytes.`,
      exitCode: EXIT_ERROR,
    });
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type CronLineOpts = {
  cron: string;
  workspacePath: string;
  codexBinaryPath: string;
  prompt: string;
  logPath: string;
  // ROS-42 + round-5 per-fire identity: when set, the rendered command is wrapped
  // in /bin/sh -c so the wrapper (the OUTER process, which observes the agent's
  // real exit even on crash) mints a per-fire id, exports it to codex as
  // ROSTER_FIRE_ID, and writes the child's exit code to a PER-FIRE file
  // `<exitDir>/<fireId>.exit` (1-3 byte ASCII int). The orchestrator's
  // `roster run start --schedule` reads ROSTER_FIRE_ID and stamps a matching
  // `<fireId>.run-id` sidecar in the SAME dir, so a delayed failure correlates to
  // the EXACT fire's run — overlapping fires never clobber (finding 1). doctor +
  // `roster pending sync` read these files independent of state.md. Optional to
  // keep backwards-compat with the original un-wrapped form; codex-install always
  // passes this for new installs.
  exitDir?: string;
  // ROS-42: when set together with exitDir, the codex invocation gains the
  // `--json` flag and its stdout is redirected to eventsPath (the structured
  // event stream). Stderr still goes to logPath. Without exitDir, this is
  // ignored — there is no inner shell to do the split redirect.
  eventsPath?: string;
};

// Vixie cron treats unescaped `%` in the command portion as a newline (and
// sends everything after the first `%` to stdin), regardless of shell
// quoting. Escape every literal `%` in the rendered line with `\%`. The
// schedule expression doesn't contain `%` (validateCronExpression would
// reject it), so a global replace is safe across the joined string.
// See `man 5 crontab`. Caught by codex review impl-pass for ROS-42.
function escapeCronPercent(line: string): string {
  return line.replace(/%/g, '\\%');
}

export function renderCronLine(opts: CronLineOpts): string {
  const codexDir = dirname(opts.codexBinaryPath);
  const pathValue = `${codexDir}:/usr/bin:/bin`;
  const envPrefix = [
    opts.cron,
    '/usr/bin/env',
    '-i',
    'HOME="$HOME"',
    `PATH=${shellQuote(pathValue)}`,
    'CODEX_HOME="$HOME/.codex"',
  ];

  // Legacy un-wrapped form (no exit capture). Kept so call sites that still
  // pass the v0.2.4 shape produce identical bytes — the byte-exact path makes
  // auditCronDrift's mismatch test simpler to reason about during rollout.
  if (opts.exitDir === undefined) {
    const parts = [
      ...envPrefix,
      shellQuote(opts.codexBinaryPath),
      'exec',
      '-C',
      shellQuote(opts.workspacePath),
      '-c',
      'shell_environment_policy.inherit=core',
      shellQuote(opts.prompt),
      '>>',
      shellQuote(opts.logPath),
      '2>&1',
    ];
    return escapeCronPercent(parts.join(' '));
  }

  // Wrapped form with PER-FIRE identity + exit-code capture. The inner script:
  //   1. ensures the per-fire dir exists,
  //   2. mints a per-fire id (8 random bytes as hex; `tr -dc 0-9a-f` strips
  //      od's spaces/newlines) with a `$$-<epoch>` fallback if /dev/urandom is
  //      unreadable,
  //   3. exports it as ROSTER_FIRE_ID so the codex process (and the orchestrator's
  //      `roster run start` inside it) records the matching `<fireId>.run-id`,
  //   4. runs codex, captures $? immediately,
  //   5. writes the exit code to `<exitDir>/<fireId>.exit` (1-3 ASCII bytes, no
  //      trailing newline via printf) CREATE-ONLY (round-6 finding 1): the
  //      sandboxed agent knows the fire id (ROSTER_FIRE_ID / the .run-id sidecar)
  //      and could plant a symlink at the exit path — a plain `>` redirect FOLLOWS
  //      it and truncates any same-user file. So the wrapper first `rm -f`s the
  //      path (removes a planted symlink itself, never its target), then writes
  //      under `set -C` (noclobber → O_CREAT|O_EXCL, which does not follow
  //      symlinks and refuses anything re-planted between the rm and the create).
  //      If the create fails (dir unwritable, hostile re-plant), the wrapper exits
  //      SILENTLY with codex's own rc — a MISSING exit file is the fail-closed
  //      outcome the stale-fire path surfaces; no fallback write path exists that
  //      an attacker could steer.
  // One POSIX-portable line: no arrays, no $PIPESTATUS, no bash-isms.
  //
  // Event capture (when eventsPath is set): codex --json prints structured
  // events to stdout; we redirect stdout to events.jsonl and stderr to log.
  // Without --json codex's human-readable output goes to log via `>> log 2>&1`.
  const codexArgs: string[] = ['exec'];
  if (opts.eventsPath !== undefined) codexArgs.push('--json');
  codexArgs.push(
    '-C',
    shellQuote(opts.workspacePath),
    '-c',
    'shell_environment_policy.inherit=core',
    shellQuote(opts.prompt),
  );
  const redirect =
    opts.eventsPath !== undefined
      ? `>> ${shellQuote(opts.eventsPath)} 2>> ${shellQuote(opts.logPath)}`
      : `>> ${shellQuote(opts.logPath)} 2>&1`;

  const exitDirQ = shellQuote(opts.exitDir);
  const inner = [
    `mkdir -p ${exitDirQ};`,
    'fid=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -dc 0-9a-f);',
    '[ -n "$fid" ] || fid=$$-$(date +%s);',
    'export ROSTER_FIRE_ID=$fid;',
    shellQuote(opts.codexBinaryPath),
    ...codexArgs,
    redirect,
    `; rc=$?; rm -f ${exitDirQ}"/$fid.exit" 2>/dev/null; ( set -C; printf %s "$rc" > ${exitDirQ}"/$fid.exit" ) 2>/dev/null; exit "$rc"`,
  ].join(' ');

  const parts = [...envPrefix, '/bin/sh', '-c', shellQuote(inner)];
  return escapeCronPercent(parts.join(' '));
}

// A managed cron block is identified by the (function, schedule) PAIR, not the
// schedule name alone (finding: installing gtm/nightly then ops/nightly updated
// the FIRST marker block — only ops active; removing either removed the other's
// cron). The marker id embeds both as `<function>/<schedule>`. `/` is legal in a
// crontab comment and can never appear in a kebab-case function/schedule name, so
// a scoped id can never be confused with a bare name that literally held a slash.
// The old pre-#323 single-function installs carried the bare `<schedule>` marker;
// upsert/remove/drift tolerate that legacy id as a fallback and migrate it.
export function cronMarkerId(functionName: string, scheduleName: string): string {
  return `${functionName}/${scheduleName}`;
}

function markerBegin(id: string): string {
  return `# roster:schedule:${id}:begin (do not edit; managed by \`roster schedule install\`)`;
}
function markerEnd(id: string): string {
  return `# roster:schedule:${id}:end`;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findMarkerBlocks(content: string, id: string): number[] {
  const beginPrefix = `# roster:schedule:${id}:begin`;
  const escaped = escapeRegex(beginPrefix);
  const re = new RegExp(`^${escaped}(?:\\s|$)`, 'mg');
  const out: number[] = [];
  for (const m of content.matchAll(re)) {
    if (m.index !== undefined) out.push(m.index);
  }
  return out;
}

// The body (lines between :begin and :end) of the FIRST block for a marker id,
// or null when no well-formed block exists.
export function extractManagedBlockBody(content: string, id: string): string | null {
  const blocks = findMarkerBlocks(content, id);
  if (blocks.length === 0) return null;
  const begin = markerBegin(id);
  const beginIdx = content.indexOf(begin, blocks[0]!);
  const endIdx = content.indexOf(markerEnd(id), blocks[0]!);
  if (beginIdx < 0 || endIdx < 0) return null;
  return content.slice(beginIdx + begin.length, endIdx);
}

// Does the legacy bare-name block's OWN rendered content provably belong to
// (functionName, scheduleName)? A bare marker id carries no function, so before
// touching such a block its cron line must prove ownership. Round-7 finding 5:
// ownership is proven by parsing the block's channel-path ARGUMENT at its exact
// position in the rendered wrapper grammar — never a substring scan of the whole
// line. (The old unanchored scan matched a foreign block whose WORKSPACE path
// merely embedded `logs/cron/<fn>/<sched>` — e.g. `-C '/tmp/logs/cron/gtm/night'`
// inside an ops/night block claimed gtm/night — letting install/remove rewrite
// or delete a different function's live schedule.) Two anchors cover every line
// this CLI renders:
//   1. wrapped form — the per-fire exit dir is the argument of `mkdir -p`,
//      nested inside the outer `/bin/sh -c '…'` quoting, so it appears as
//      `mkdir -p '\''<exitDir>'\'';`. The exit dir must END WITH exactly
//      `/logs/cron/<fn>/<sched>`.
//   2. legacy un-wrapped form — the log path is the top-level `>> '<log>' 2>&1`
//      redirect target; it must END WITH exactly `/logs/cron/<fn>/<sched>.log`.
// endsWith anchors the whole (fn, sched) tail, so `gtm/night` never claims
// `gtm/nightly`'s paths and an embedded workspace prefix never matches. A block
// matching neither anchor (hand-edited, pre-scoped-path install) is unprovable →
// never adopted (locateManagedBlock refuses).
const WRAPPED_EXIT_DIR_RE = /mkdir -p '\\''([^'\n]*)'\\'';/;
const UNWRAPPED_LOG_RE = />> '([^'\n]*)' 2>&1(?:\s|$)/;

export function legacyMarkerOwnedBy(
  content: string,
  legacyId: string,
  functionName: string,
  scheduleName: string,
): boolean {
  const body = extractManagedBlockBody(content, legacyId);
  if (body === null) return false;
  const wrapped = body.match(WRAPPED_EXIT_DIR_RE);
  if (wrapped !== null) {
    return wrapped[1]!.endsWith(`/logs/cron/${functionName}/${scheduleName}`);
  }
  const unwrapped = body.match(UNWRAPPED_LOG_RE);
  if (unwrapped !== null) {
    return unwrapped[1]!.endsWith(`/logs/cron/${functionName}/${scheduleName}.log`);
  }
  return false;
}

// The legacy bare-name fallback, as supplied by a caller that CAN see the
// workspace registry (round-7 finding 2). `id` is the pre-#323 bare marker id
// (the schedule name); `registeredFunctions` is every function in the workspace
// registering a schedule with that name, INCLUDING the caller's own. A bare
// marker names no function, so it may be adopted only when exactly one function
// claims the name — the content proof below (legacyMarkerOwnedBy) reads
// user-editable crontab text and cannot arbitrate between two legitimate
// claimants. Both conditions must hold; either one failing refuses the fallback.
export type LegacyMarkerFallback = {
  id: string;
  registeredFunctions: readonly string[];
};

function legacyAmbiguityError(legacyId: string, competing: readonly string[]): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ambiguous legacy cron block '${legacyId}'`,
    body: `  A bare marker block '# roster:schedule:${legacyId}:begin' exists, but ${competing.length} functions register a schedule named '${legacyId}': ${competing.join(', ')}.\n  The bare marker names no function, so it cannot be attributed — claiming it could rewrite or delete another function's live schedule.`,
    remedy: `  Inspect with 'crontab -l', then re-install each same-named schedule ('roster schedule install … --function <fn>') so every block carries a scoped '<function>/${legacyId}' marker — or delete the stale bare block via 'crontab -e'. Then re-run this command.`,
    exitCode: EXIT_ERROR,
  });
}

function legacyOwnershipError(legacyId: string, functionName: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} cannot adopt legacy cron block '${legacyId}'`,
    body: `  Found a bare marker block '# roster:schedule:${legacyId}:begin' whose content does not provably belong to function '${functionName}'.\n  It may be ANOTHER function's live schedule of the same name (or a pre-scoped install) — touching it could rewrite or delete that schedule's cron line.`,
    remedy: `  Inspect with 'crontab -l'. If the block belongs to another function, re-install that schedule to migrate it to a scoped marker; if it is stale, delete it via 'crontab -e'. Then re-run this command.`,
    exitCode: EXIT_ERROR,
  });
}

// Is the bare schedule name claimed by more than one function in the workspace?
// Exported so drift can REPORT the ambiguity (it never mutates, so it must not
// throw) with the same rule install/remove enforce.
export function legacyMarkerIsAmbiguous(legacy: LegacyMarkerFallback): boolean {
  return new Set(legacy.registeredFunctions).size > 1;
}

// Locate the managed block for a marker id, preferring the (function-scoped)
// primary id and falling back to a legacy bare-schedule-name id for a pre-#323
// single-function install (backward-compat migration — upsert then rewrites the
// block under the scoped id; remove strips it). The fallback is accepted ONLY
// when BOTH guards hold: the schedule name is registered by exactly one function
// in the workspace (round-7 finding 2 — a name two functions claim can never be
// attributed to one of them from a bare marker), and the legacy block's own
// content proves it belongs to this function (round-6 finding 8). An ambiguous,
// unprovable, or foreign same-name block is refused, never silently adopted.
// Returns the id whose markers actually delimit the found block, so callers use
// the right :end marker.
function locateManagedBlock(
  content: string,
  id: string,
  legacy: LegacyMarkerFallback | undefined,
): { id: string; begin: string; end: string; indices: number[] } {
  const primary = findMarkerBlocks(content, id);
  if (primary.length > 0 || legacy === undefined || legacy.id === id) {
    return { id, begin: markerBegin(id), end: markerEnd(id), indices: primary };
  }
  const legacyId = legacy.id;
  const legacyBlocks = findMarkerBlocks(content, legacyId);
  if (legacyBlocks.length > 0) {
    if (legacyMarkerIsAmbiguous(legacy)) {
      throw legacyAmbiguityError(legacyId, [...new Set(legacy.registeredFunctions)].sort());
    }
    const slash = id.indexOf('/');
    const functionName = slash > 0 ? id.slice(0, slash) : '';
    if (legacyBlocks.length === 1 && !legacyMarkerOwnedBy(content, legacyId, functionName, legacyId)) {
      throw legacyOwnershipError(legacyId, functionName);
    }
    return { id: legacyId, begin: markerBegin(legacyId), end: markerEnd(legacyId), indices: legacyBlocks };
  }
  return { id, begin: markerBegin(id), end: markerEnd(id), indices: primary };
}

export function upsertCronEntry(
  io: CrontabIO,
  id: string,
  line: string,
  legacy?: LegacyMarkerFallback,
): { action: 'created' | 'updated' } {
  const r = io.read();
  let content: string;
  if (r.ok) {
    content = r.content;
  } else if (r.reason === 'no-crontab') {
    content = '';
  } else {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} cannot read existing crontab`,
      body: `  ${r.message}`,
      remedy: `  Run 'crontab -l' manually to diagnose, then retry.`,
      exitCode: EXIT_ERROR,
    });
  }

  // Always WRITE the block under the scoped id; the block we REPLACE may be a
  // legacy bare-name block (migration).
  const block = `${markerBegin(id)}\n${line}\n${markerEnd(id)}`;

  const found = locateManagedBlock(content, id, legacy);
  if (found.indices.length > 1) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} duplicate marker blocks for schedule '${found.id}'`,
      body: `  Found ${found.indices.length} '# roster:schedule:${found.id}:begin' lines in crontab.\n  Replacing one would leave duplicate cron fires.`,
      remedy: `  Run 'crontab -e', remove duplicate blocks manually, then re-run this command.`,
      exitCode: EXIT_ERROR,
    });
  }

  if (found.indices.length === 0) {
    const sep = content.length > 0 && !content.endsWith('\n\n') ? (content.endsWith('\n') ? '\n' : '\n\n') : '';
    const next = content + sep + block + '\n';
    io.write(next);
    return { action: 'created' };
  }

  const beginIdx = found.indices[0]!;
  const endBeforeReplace = content.indexOf(found.end, beginIdx);
  if (endBeforeReplace < 0) {
    // Codex review impl-pass: the previous fallback ("replace through next
    // blank line or EOF") could eat unrelated user lines if the begin marker
    // was hand-broken. Refuse instead — the user must repair the crontab.
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} malformed managed block for schedule '${found.id}'`,
      body: `  Found '# roster:schedule:${found.id}:begin' but no matching ':end' marker.\n  Refusing to guess the block boundary — user lines could be lost.`,
      remedy: `  Run 'crontab -e', restore the missing ':end' marker (or delete the orphan ':begin' line), then re-run this command.`,
      exitCode: EXIT_ERROR,
    });
  }
  const replaceEnd = endBeforeReplace + found.end.length;
  const next = content.slice(0, beginIdx) + block + content.slice(replaceEnd);
  io.write(next);
  return { action: 'updated' };
}

export function getMarkerStrings(id: string): { begin: string; end: string } {
  return { begin: markerBegin(id), end: markerEnd(id) };
}

export function removeCronEntry(
  io: CrontabIO,
  id: string,
  legacy?: LegacyMarkerFallback,
): { removed: boolean } {
  const r = io.read();
  let content: string;
  if (r.ok) {
    content = r.content;
  } else if (r.reason === 'no-crontab') {
    return { removed: false };
  } else {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} cannot read existing crontab`,
      body: `  ${r.message}`,
      remedy: `  Run 'crontab -l' manually to diagnose, then retry.`,
      exitCode: EXIT_ERROR,
    });
  }

  const found = locateManagedBlock(content, id, legacy);
  const beginMarker = found.begin;
  const endMarker = found.end;

  const matches = found.indices;
  if (matches.length === 0) return { removed: false };

  if (matches.length > 1) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} duplicate marker blocks for schedule '${found.id}'`,
      body: `  Found ${matches.length} '${beginMarker}' lines in crontab.\n  Refusing to guess which block to remove.`,
      remedy: `  Run 'crontab -e', remove duplicate blocks manually, then re-run.`,
      exitCode: EXIT_ERROR,
    });
  }

  const beginIdx = matches[0]!;
  const endBefore = content.indexOf(endMarker, beginIdx);
  if (endBefore < 0) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} malformed managed block for schedule '${found.id}'`,
      body: `  Found '${beginMarker}' but no matching '${endMarker}'.\n  Refusing to guess the block boundary — user lines could be lost.`,
      remedy: `  Run 'crontab -e', restore the missing ':end' marker (or delete the orphan ':begin' line), then re-run.`,
      exitCode: EXIT_ERROR,
    });
  }

  // Strip the managed block, inverting upsertCronEntry's separator logic.
  //
  // upsert (see findMarkerBlocks / upsertCronEntry above) inserts:
  //   - `{block}\n`        if crontab is empty
  //   - `\n{block}\n`      if crontab already ends with `\n`
  //   - `\n\n{block}\n`    if crontab is non-empty but lacks trailing `\n`
  //
  // Symmetric remove: also strip the separator characters that upsert added.
  // Codex review impl-pass finding #5 (ROS-36): the previous version always
  // stripped a single leading `\n` when it found `\n\n` before the block,
  // which over-trimmed for the third case (initial content had no trailing
  // newline) — leaving `MAILTO=me\n` instead of restoring `MAILTO=me`.
  let stripStart = beginIdx;
  let stripEnd = endBefore + endMarker.length;
  if (content[stripEnd] === '\n') stripEnd += 1;

  if (stripStart >= 2 && content.slice(stripStart - 2, stripStart) === '\n\n') {
    // Block was preceded by '\n\n'. If the char at -3 (or pre-file-start) is
    // also '\n', the user actually had a blank line there → strip ONE newline,
    // preserving the user's blank line. Otherwise upsert inserted both
    // newlines as a separator → strip BOTH to restore the original byte stream.
    if (stripStart >= 3 && content[stripStart - 3] === '\n') {
      stripStart -= 1;
    } else {
      stripStart -= 2;
    }
  } else if (stripStart >= 1 && content[stripStart - 1] === '\n' && stripEnd === content.length) {
    // Block was the only content after a single newline at start — trim that newline.
    stripStart -= 1;
  }

  const next = content.slice(0, stripStart) + content.slice(stripEnd);
  io.write(next);
  return { removed: true };
}

// Resolve the codex binary path on the user's $PATH. Used by `schedule install`
// (build a crontab line with an absolute path) and `schedule run` (spawn the
// same binary the cron line would). Extracted from codex-install.ts so both
// callers share one resolution policy.
export function resolveCodexBinaryPath(
  env: NodeJS.ProcessEnv,
  override: string | undefined,
): string {
  if (override !== undefined && override !== '') return override;
  const fromEnv = env['ROSTER_CODEX_PATH'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const r = spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8', env });
  if (r.status === 0) {
    const out = (r.stdout ?? '').trim();
    if (out.length > 0) return out;
  }
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} codex binary not found on PATH`,
    body: '  Install codex CLI (https://developers.openai.com/codex) and ensure it is on your PATH.',
    remedy: '  Or pass ROSTER_CODEX_PATH=/abs/path/to/codex when invoking roster.',
    exitCode: EXIT_ERROR,
  });
}
