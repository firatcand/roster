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
};

export function renderCronLine(opts: CronLineOpts): string {
  const codexDir = dirname(opts.codexBinaryPath);
  const pathValue = `${codexDir}:/usr/bin:/bin`;
  const parts = [
    opts.cron,
    '/usr/bin/env',
    '-i',
    'HOME="$HOME"',
    `PATH=${shellQuote(pathValue)}`,
    'CODEX_HOME="$HOME/.codex"',
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
