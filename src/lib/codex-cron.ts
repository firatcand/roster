import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { RosterError, EXIT_ERROR } from './errors.ts';

export type CrontabReadResult =
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
  // ROS-42: when set, the rendered command is wrapped in /bin/sh -c so the
  // child's exit code lands in `exitPath` as a 1-3 byte ASCII integer.
  // doctor + `roster pending sync` read these files to detect failures
  // independent of state.md (which is only written if the agent runs to
  // completion). Optional to keep backwards-compat with the original
  // un-wrapped form; codex-install always passes this for new installs.
  exitPath?: string;
  // ROS-42: when set together with exitPath, the codex invocation gains the
  // `--json` flag and its stdout is redirected to eventsPath (the structured
  // event stream). Stderr still goes to logPath. Without exitPath, this is
  // ignored — there is no inner shell to do the split redirect.
  eventsPath?: string;
};

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
  if (opts.exitPath === undefined) {
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
    return parts.join(' ');
  }

  // Wrapped form with exit-code capture. The inner script runs the codex
  // invocation, captures $? immediately, writes it to exitPath as 1-3 ASCII
  // bytes, then re-exits with the same code so cron's MAILTO behavior is
  // preserved. printf is used (not echo) to avoid a trailing newline.
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

  // Build the inner script. Single-quoting the whole script via shellQuote
  // means $? / $rc / "$rc" survive to the inner /bin/sh -c, where they are
  // resolved at run time. The codex review pattern is to keep the inner
  // script as one POSIX-portable line: no arrays, no $PIPESTATUS, no bash-isms.
  const inner = [
    shellQuote(opts.codexBinaryPath),
    ...codexArgs,
    redirect,
    `; rc=$?; printf %s "$rc" > ${shellQuote(opts.exitPath)}; exit "$rc"`,
  ].join(' ');

  const parts = [...envPrefix, '/bin/sh', '-c', shellQuote(inner)];
  return parts.join(' ');
}

function markerBegin(name: string): string {
  return `# roster:schedule:${name}:begin (do not edit; managed by \`roster schedule install\`)`;
}
function markerEnd(name: string): string {
  return `# roster:schedule:${name}:end`;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findMarkerBlocks(content: string, name: string): number[] {
  const beginPrefix = `# roster:schedule:${name}:begin`;
  const escaped = escapeRegex(beginPrefix);
  const re = new RegExp(`^${escaped}(?:\\s|$)`, 'mg');
  const out: number[] = [];
  for (const m of content.matchAll(re)) {
    if (m.index !== undefined) out.push(m.index);
  }
  return out;
}

export function upsertCronEntry(
  io: CrontabIO,
  name: string,
  line: string,
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

  const beginMarker = markerBegin(name);
  const endMarker = markerEnd(name);
  const block = `${beginMarker}\n${line}\n${endMarker}`;

  const matches = findMarkerBlocks(content, name);
  if (matches.length > 1) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} duplicate marker blocks for schedule '${name}'`,
      body: `  Found ${matches.length} '# roster:schedule:${name}:begin' lines in crontab.\n  Replacing one would leave duplicate cron fires.`,
      remedy: `  Run 'crontab -e', remove duplicate blocks manually, then re-run this command.`,
      exitCode: EXIT_ERROR,
    });
  }

  if (matches.length === 0) {
    const sep = content.length > 0 && !content.endsWith('\n\n') ? (content.endsWith('\n') ? '\n' : '\n\n') : '';
    const next = content + sep + block + '\n';
    io.write(next);
    return { action: 'created' };
  }

  const beginIdx = matches[0]!;
  const endBeforeReplace = content.indexOf(endMarker, beginIdx);
  if (endBeforeReplace < 0) {
    // Codex review impl-pass: the previous fallback ("replace through next
    // blank line or EOF") could eat unrelated user lines if the begin marker
    // was hand-broken. Refuse instead — the user must repair the crontab.
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} malformed managed block for schedule '${name}'`,
      body: `  Found '# roster:schedule:${name}:begin' but no matching ':end' marker.\n  Refusing to guess the block boundary — user lines could be lost.`,
      remedy: `  Run 'crontab -e', restore the missing ':end' marker (or delete the orphan ':begin' line), then re-run this command.`,
      exitCode: EXIT_ERROR,
    });
  }
  const replaceEnd = endBeforeReplace + endMarker.length;
  const next = content.slice(0, beginIdx) + block + content.slice(replaceEnd);
  io.write(next);
  return { action: 'updated' };
}

export function getMarkerStrings(name: string): { begin: string; end: string } {
  return { begin: markerBegin(name), end: markerEnd(name) };
}

export function removeCronEntry(
  io: CrontabIO,
  name: string,
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

  const beginMarker = markerBegin(name);
  const endMarker = markerEnd(name);

  const matches = findMarkerBlocks(content, name);
  if (matches.length === 0) return { removed: false };

  if (matches.length > 1) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} duplicate marker blocks for schedule '${name}'`,
      body: `  Found ${matches.length} '${beginMarker}' lines in crontab.\n  Refusing to guess which block to remove.`,
      remedy: `  Run 'crontab -e', remove duplicate blocks manually, then re-run.`,
      exitCode: EXIT_ERROR,
    });
  }

  const beginIdx = matches[0]!;
  const endBefore = content.indexOf(endMarker, beginIdx);
  if (endBefore < 0) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} malformed managed block for schedule '${name}'`,
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
