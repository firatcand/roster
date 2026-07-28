import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shellQuote,
  renderCronLine,
  upsertCronEntry,
  findMarkerBlocks,
  getMarkerStrings,
  legacyMarkerIsAmbiguous,
  legacyMarkerOwnedBy,
  removeCronEntry,
  cronMarkerId,
  type CrontabIO,
} from '../src/lib/codex-cron.ts';
import { RosterError } from '../src/lib/errors.ts';

// ── Fake IO ───────────────────────────────────────────────────────────────

function fakeIO(initial: string): CrontabIO & { written: string[]; current: string } {
  const obj = {
    current: initial,
    written: [] as string[],
    read() {
      return { ok: true as const, content: this.current };
    },
    write(content: string) {
      this.written.push(content);
      this.current = content;
    },
  };
  return obj;
}

// Simulates a user with no existing crontab on the first read; after our
// first write the IO behaves like a normal crontab (reads back what was set).
function noCrontabIO(): CrontabIO & { written: string[]; current: string } {
  const obj = {
    current: '',
    written: [] as string[],
    read() {
      if (this.current === '') return { ok: false as const, reason: 'no-crontab' as const, content: '' as const };
      return { ok: true as const, content: this.current };
    },
    write(content: string) {
      this.written.push(content);
      this.current = content;
    },
  };
  return obj;
}

// ── shellQuote ────────────────────────────────────────────────────────────

test('shellQuote: simple value → wrapped in single quotes', () => {
  assert.equal(shellQuote('hello'), "'hello'");
});

test('shellQuote: value with space → quoted', () => {
  assert.equal(shellQuote('/Users/firat/my roster'), "'/Users/firat/my roster'");
});

test('shellQuote: value with apostrophe → uses \\\'\\\'\\\' dance', () => {
  // Input:  firat's-test
  // Output: 'firat'\''s-test'
  assert.equal(shellQuote("firat's-test"), "'firat'\\''s-test'");
});

test('shellQuote: value with double quotes → quoted (single quotes preserve them)', () => {
  assert.equal(shellQuote('say "hi"'), `'say "hi"'`);
});

test('shellQuote: value with backtick → quoted (single quotes prevent expansion)', () => {
  assert.equal(shellQuote('`whoami`'), "'`whoami`'");
});

test('shellQuote: value with dollar sign → quoted', () => {
  assert.equal(shellQuote('$HOME'), "'$HOME'");
});

test('shellQuote: value with embedded newline → throws RosterError (impl-review)', () => {
  assert.throws(
    () => shellQuote('a\nb'),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /newline or NUL/);
      return true;
    },
  );
});

test('shellQuote: value with NUL byte → throws (impl-review)', () => {
  assert.throws(
    () => shellQuote('a\0b'),
    (err: unknown) => err instanceof RosterError,
  );
});

// ── renderCronLine ────────────────────────────────────────────────────────

test('renderCronLine: standard shape matches ADR-0001 Spike 1 verified form', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/Users/firat/my-roster',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Use the roster-orchestrator skill to run plan cold-outreach for agent sdr',
    logPath: '/Users/firat/my-roster/logs/cron/sdr-cold-outreach.log',
  });

  // Tokens we MUST see, in order.
  assert.match(line, /^0 9 \* \* 1-5 /);
  assert.match(line, / \/usr\/bin\/env -i /);
  assert.match(line, / HOME="\$HOME" /);
  assert.match(line, / PATH='\/opt\/homebrew\/bin:\/usr\/bin:\/bin' /);
  assert.match(line, / CODEX_HOME="\$HOME\/\.codex" /);
  assert.match(line, / '\/opt\/homebrew\/bin\/codex' /);
  // Subcommand name (not the JS regex method): bare `exec` token follows the binary path.
  assert.ok(line.includes("'/opt/homebrew/bin/codex' exec -C"), `expected codex subcommand after binary, got: ${line}`);
  assert.match(line, / -c shell_environment_policy\.inherit=core /);
  assert.match(line, / >> '\/Users\/firat\/my-roster\/logs\/cron\/sdr-cold-outreach\.log' 2>&1$/);
});

test('renderCronLine: workspace with a space is shell-quoted (no shell breakage)', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/Users/firat/my roster',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Use the roster-orchestrator skill',
    logPath: '/Users/firat/my roster/logs/cron/foo.log',
  });
  assert.match(line, /'\/Users\/firat\/my roster'/);
});

test('renderCronLine: workspace with apostrophe is escaped correctly', () => {
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: "/tmp/firat's-test",
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Hello',
    logPath: '/tmp/log.txt',
  });
  assert.match(line, /'\/tmp\/firat'\\''s-test'/);
});

// ── renderCronLine: ROS-42 wrapped form with exit-code capture ────────────

test('renderCronLine: exitDir set → wraps in /bin/sh -c, mints a per-fire id, captures $?', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/Users/firat/my-roster',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Use the roster-orchestrator skill',
    logPath: '/Users/firat/my-roster/logs/cron/sdr.log',
    exitDir: '/Users/firat/my-roster/logs/cron/gtm/sdr',
  });
  // env prefix unchanged
  assert.match(line, /^0 9 \* \* 1-5 \/usr\/bin\/env -i HOME="\$HOME" /);
  // /bin/sh -c wraps the inner command
  assert.match(line, / \/bin\/sh -c '/);
  // the per-fire dir is created before the exit write
  assert.ok(line.includes('mkdir -p'));
  // a per-fire id is minted from /dev/urandom (hex, spaces/newlines stripped)
  assert.match(line, /fid=\$\(od -An -N8 -tx1 \/dev\/urandom/);
  // …with a $$-<epoch> fallback (the % of date +%s is cron-escaped to \%s)
  assert.ok(line.includes('fid=$$-$(date +\\%s)'));
  // …and exported to the codex process so `roster run start` records the match
  assert.ok(line.includes('export ROSTER_FIRE_ID=$fid'));
  // inner: codex exec + redirect + rc capture + exit. The `%` in printf gets
  // escaped to `\%` by escapeCronPercent so cron doesn't treat it as the
  // stdin sentinel — cron strips the backslash before /bin/sh sees it.
  assert.match(line, /printf \\%s "\$rc"/);
  assert.match(line, /exit "\$rc"/);
  // the exit is written to a PER-FIRE file `<exitDir>/<fireId>.exit`
  assert.ok(line.includes("'/Users/firat/my-roster/logs/cron/gtm/sdr'"));
  assert.ok(line.includes('"/$fid.exit"'));
});

test('renderCronLine: exitDir unset → legacy un-wrapped form (byte-exact backwards-compat)', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/work',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'p',
    logPath: '/work/log',
  });
  // No /bin/sh -c wrap.
  assert.ok(!line.includes('/bin/sh -c'));
  assert.ok(!line.includes('printf'));
  // Trailing token is the legacy redirect.
  assert.match(line, />> '\/work\/log' 2>&1$/);
});

test('renderCronLine: eventsPath set → adds --json, splits stdout/stderr redirects', () => {
  const line = renderCronLine({
    cron: '*/15 * * * *',
    workspacePath: '/w',
    codexBinaryPath: '/usr/local/bin/codex',
    prompt: 'p',
    logPath: '/w/log',
    exitDir: '/w/exit',
    eventsPath: '/w/events.jsonl',
  });
  // --json present in inner script (note: single quotes are escaped as '\'' by
  // the outer wrap, so `' exec --json '` appears as `'\'' exec --json '\''`).
  assert.ok(line.includes(" exec --json "));
  // stdout → events.jsonl, stderr → log (paths embedded with the '\'' dance)
  assert.ok(line.includes(">> '\\''/w/events.jsonl'\\'' 2>> '\\''/w/log'\\''"));
  // still wrapped (exitPath set)
  assert.match(line, / \/bin\/sh -c '/);
});

test('renderCronLine: eventsPath without exitPath is ignored (no wrapper, no --json)', () => {
  const line = renderCronLine({
    cron: '0 * * * *',
    workspacePath: '/w',
    codexBinaryPath: '/codex',
    prompt: 'p',
    logPath: '/w/log',
    eventsPath: '/w/events.jsonl',
  });
  assert.ok(!line.includes('--json'));
  assert.ok(!line.includes('events.jsonl'));
});

// ── renderCronLine: shell-syntax sanity via /bin/sh -n ────────────────────
//
// /bin/sh -n parses the script without executing — catches quoting and
// redirection mistakes (a missing `'`, an unbalanced `"`, a stray `&`) that
// would otherwise only surface at fire-time.

import { spawnSync as _spawnSync } from 'node:child_process';

function shellParses(line: string): { ok: boolean; stderr: string } {
  // Strip the cron schedule (first 5 fields) so we feed the actual command to sh -n.
  const fields = line.split(/\s+/);
  const cmd = fields.slice(5).join(' ');
  const r = _spawnSync('/bin/sh', ['-n', '-c', cmd], { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: r.stderr ?? '' };
}

test('renderCronLine: wrapped form parses as valid POSIX shell', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/Users/firat/my-roster',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Use the roster-orchestrator skill to run plan cold for agent sdr',
    logPath: '/Users/firat/my-roster/logs/cron/sdr.log',
    exitDir: '/Users/firat/my-roster/logs/cron/gtm/sdr',
  });
  const r = shellParses(line);
  assert.ok(r.ok, `sh -n rejected the rendered line:\n${r.stderr}\nline:\n${line}`);
});

test('renderCronLine: wrapped form with apostrophe path parses', () => {
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: "/tmp/firat's-test",
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: "Run plan that's important",
    logPath: "/tmp/firat's-test/log",
    exitDir: "/tmp/firat's-test/exit",
  });
  const r = shellParses(line);
  assert.ok(r.ok, `sh -n rejected the apostrophe-path line:\n${r.stderr}`);
});

test('renderCronLine: events form parses', () => {
  const line = renderCronLine({
    cron: '*/15 * * * *',
    workspacePath: '/w',
    codexBinaryPath: '/usr/local/bin/codex',
    prompt: 'p',
    logPath: '/w/log',
    exitDir: '/w/exit',
    eventsPath: '/w/events.jsonl',
  });
  const r = shellParses(line);
  assert.ok(r.ok, `sh -n rejected the events-form line:\n${r.stderr}`);
});

// ── renderCronLine: byte-exact GOLDEN (should-fix 6) ──────────────────────
//
// A COMPLETE hardcoded golden string of the full wrapped line — NOT derived from
// renderCronLine, so the renderer and auditCronDrift's re-render cannot drift
// together silently (the fire id is resolved at runtime as `$fid`, so the
// rendered string is fully deterministic). String.raw preserves the literal
// backslashes (`\%`, the `'\''` single-quote dances) byte-for-byte.

const GOLDEN_WRAPPED_LINE = String.raw`0 9 * * 1-5 /usr/bin/env -i HOME="$HOME" PATH='/opt/homebrew/bin:/usr/bin:/bin' CODEX_HOME="$HOME/.codex" /bin/sh -c 'mkdir -p '\''/w/logs/cron/gtm/sdr'\''; fid=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -dc 0-9a-f); [ -n "$fid" ] || fid=$$-$(date +\%s); export ROSTER_FIRE_ID=$fid; '\''/opt/homebrew/bin/codex'\'' exec -C '\''/w'\'' -c shell_environment_policy.inherit=core '\''p'\'' >> '\''/w/logs/cron/gtm/sdr.log'\'' 2>&1 ; rc=$?; rm -f '\''/w/logs/cron/gtm/sdr'\''"/$fid.exit" 2>/dev/null; ( set -C; printf \%s "$rc" > '\''/w/logs/cron/gtm/sdr'\''"/$fid.exit" ) 2>/dev/null; exit "$rc"'`;

test('renderCronLine (should-fix 6): the full wrapped line byte-exactly matches the golden string', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/w',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'p',
    logPath: '/w/logs/cron/gtm/sdr.log',
    exitDir: '/w/logs/cron/gtm/sdr',
  });
  assert.equal(line, GOLDEN_WRAPPED_LINE);
});

// ── renderCronLine: symlink-proof exit write (round-6 finding 1) ───────────
//
// The sandboxed agent knows the fire id (ROSTER_FIRE_ID / the .run-id sidecar)
// and could plant a symlink at `<exitDir>/<fid>.exit` — the old plain `>`
// redirect FOLLOWED it and truncated any same-user file. The wrapper now
// `rm -f`s the path and creates under `set -C` (noclobber → O_CREAT|O_EXCL,
// which never follows a symlink); if the create fails, it exits SILENTLY with
// codex's rc — a missing exit file is the fail-closed outcome (stale path).

test('renderCronLine (round-6 finding 1): the rendered tail uses rm -f + set -C noclobber, never a bare > redirect', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/w',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'p',
    logPath: '/w/logs/cron/gtm/sdr.log',
    exitDir: '/w/logs/cron/gtm/sdr',
  });
  // Planted-entry removal precedes the write.
  assert.ok(line.includes(`; rc=$?; rm -f '\\''/w/logs/cron/gtm/sdr'\\''"/$fid.exit" 2>/dev/null; `), line);
  // The write happens ONLY inside a noclobber subshell (O_CREAT|O_EXCL).
  assert.ok(line.includes(`( set -C; printf \\%s "$rc" > '\\''/w/logs/cron/gtm/sdr'\\''"/$fid.exit" ) 2>/dev/null; exit "$rc"'`), line);
  // No sentinel/fallback write path remains for an attacker to steer.
  assert.ok(!line.includes('111'));
  assert.ok(!line.includes('exit-evidence'));
});

// Reverse the outer shellQuote (inner.replace(' → '\'')) and the cron %-escape
// to recover the EXACT inner script bytes /bin/sh executes at fire time, so the
// behavioral tests below exercise the real rendered tail, not a re-typed copy.
function innerScriptOf(line: string): string {
  const m = line.match(/ \/bin\/sh -c '(.*)'$/s);
  assert.ok(m, `no /bin/sh -c wrapper in: ${line}`);
  return m![1]!.split(`'\\''`).join(`'`).replace(/\\%/g, '%');
}

function exitWriteTailOf(line: string): string {
  const inner = innerScriptOf(line);
  const idx = inner.indexOf('; rc=$?;');
  assert.ok(idx >= 0, `no rc-capture tail in inner script: ${inner}`);
  return inner.slice(idx + '; rc=$?;'.length);
}

test('renderCronLine (round-6 finding 1): a planted symlink at the exit path is NOT followed — the victim file survives, the exit lands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-cron-symlink-'));
  try {
    const exitDir = join(dir, 'exit');
    mkdirSync(exitDir, { recursive: true });
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'precious bytes');
    symlinkSync(victim, join(exitDir, 'attackfid.exit')); // the attacker's plant
    const line = renderCronLine({
      cron: '0 9 * * *',
      workspacePath: dir,
      codexBinaryPath: '/usr/bin/true',
      prompt: 'p',
      logPath: join(dir, 'run.log'),
      exitDir,
    });
    // Execute the REAL rendered tail with the fire id + rc pinned.
    const r = _spawnSync('/bin/sh', ['-c', `fid=attackfid; rc=0;${exitWriteTailOf(line)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(victim, 'utf8'), 'precious bytes', 'the symlink target must NEVER be truncated');
    const st = lstatSync(join(exitDir, 'attackfid.exit'));
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'the exit path is now a real file, not the planted symlink');
    assert.equal(readFileSync(join(exitDir, 'attackfid.exit'), 'utf8'), '0', 'the exit code still lands');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCronLine (round-6 finding 1): an unremovable plant (directory) → silent exit with codex rc, NO exit file (fail-closed, stale path catches it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-cron-plant-dir-'));
  try {
    const exitDir = join(dir, 'exit');
    mkdirSync(join(exitDir, 'attackfid.exit'), { recursive: true }); // rm -f fails, set -C create fails
    const line = renderCronLine({
      cron: '0 9 * * *',
      workspacePath: dir,
      codexBinaryPath: '/usr/bin/true',
      prompt: 'p',
      logPath: join(dir, 'run.log'),
      exitDir,
    });
    const r = _spawnSync('/bin/sh', ['-c', `fid=attackfid; rc=0;${exitWriteTailOf(line)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'codex rc is preserved — the write failure never masquerades as a codex failure');
    assert.equal(r.stderr, '', 'silent: no stderr noise an attacker can trigger');
    assert.ok(lstatSync(join(exitDir, 'attackfid.exit')).isDirectory(), 'nothing was written through the plant');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCronLine (round-6 finding 1): full wrapped command with a WRITABLE exit dir + SUCCEEDING codex → exit 0, evidence written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-cron-evidence-ok-'));
  try {
    const exitDir = join(dir, 'exit');
    const line = renderCronLine({
      cron: '0 9 * * *',
      workspacePath: dir,
      codexBinaryPath: '/usr/bin/true',
      prompt: 'p',
      logPath: join(dir, 'run.log'),
      exitDir,
    });
    // Execute the command portion (everything after the 5 cron fields), verbatim.
    // The cron daemon would strip the `\` from `\%`; /bin/sh reads `\%` as `%`
    // (identical), so running the rendered line directly is faithful.
    const cmd = line.match(/^(?:\S+\s+){5}(.*)$/s)![1]!;
    const r = _spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(r.status, 0, `evidence written successfully → codex's own exit (0); stderr:\n${r.stderr}`);
    const exits = readdirSync(exitDir).filter((f) => f.endsWith('.exit'));
    assert.equal(exits.length, 1, 'exactly one per-fire exit file');
    assert.equal(readFileSync(join(exitDir, exits[0]!), 'utf8'), '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCronLine (round-6 finding 1): an unwritable exit dir + a SUCCEEDING codex → SILENT exit 0, no exit file (fail-closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-cron-evidence-'));
  try {
    // codex stub = /bin/true (exits 0, ignores args). exitDir points at a regular
    // FILE, so the create fails with ENOTDIR even though codex succeeded — a
    // uid-independent way to simulate an unwritable exit dir. The wrapper exits
    // with codex's own rc and writes nothing: the MISSING exit file is the
    // detectable (stale-path) signal, replacing the old 111 sentinel that gave
    // a symlink-planting agent a way to forge failures.
    const exitDir = join(dir, 'exit-is-a-file');
    writeFileSync(exitDir, 'not a dir');
    const line = renderCronLine({
      cron: '0 9 * * *',
      workspacePath: dir,
      codexBinaryPath: '/usr/bin/true',
      prompt: 'p',
      logPath: join(dir, 'run.log'),
      exitDir,
    });
    const cmd = line.match(/^(?:\S+\s+){5}(.*)$/s)![1]!;
    const r = _spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(r.status, 0, `codex rc preserved; got ${r.status}\nstderr:\n${r.stderr}`);
    assert.equal(readFileSync(exitDir, 'utf8'), 'not a dir', 'nothing written through the bad path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cronMarkerId + legacy-marker migration (finding 2 backward-compat) ─────

test('cronMarkerId: composes <function>/<schedule>', () => {
  assert.equal(cronMarkerId('gtm', 'nightly'), 'gtm/nightly');
});

// A legacy bare-name block whose line PROVES ownership by embedding the
// function-scoped channel paths (what an interim scoped-path install wrote
// under a bare marker).
function legacyBlockOwnedBy(fn: string, name: string): string {
  return (
    `# roster:schedule:${name}:begin (do not edit; managed by \`roster schedule install\`)\n` +
    `0 0 * * * old-line >> '/w/logs/cron/${fn}/${name}.log' 2>&1\n` +
    `# roster:schedule:${name}:end\n`
  );
}

test('upsertCronEntry: migrates a legacy bare-name block whose content proves OUR function (backward compat)', () => {
  const io = fakeIO(legacyBlockOwnedBy('gtm', 'nightly'));
  const r = upsertCronEntry(io, 'gtm/nightly', 'new-line', { id: 'nightly', registeredFunctions: ['gtm'] });
  assert.equal(r.action, 'updated');
  // The block is now under the scoped id; the legacy bare marker is gone.
  assert.match(io.current, /# roster:schedule:gtm\/nightly:begin/);
  assert.equal(findMarkerBlocks(io.current, 'nightly').length, 0, 'legacy bare marker migrated away');
  assert.ok(io.current.includes('new-line'));
  assert.ok(!io.current.includes('old-line'));
});

test('removeCronEntry: strips a provably-owned legacy bare-name block when given the scoped id + legacy fallback', () => {
  const io = fakeIO(legacyBlockOwnedBy('gtm', 'nightly'));
  const r = removeCronEntry(io, 'gtm/nightly', { id: 'nightly', registeredFunctions: ['gtm'] });
  assert.equal(r.removed, true);
  assert.equal(io.current, '');
});

// ── round-6 finding 8: a bare legacy marker is adopted ONLY with proof ─────
//
// The bare marker id carries no function. Before this fix, installing or
// removing ops/nightly adopted ANY bare 'nightly' block — including
// gtm/nightly's LIVE one — rewriting or deleting another function's schedule.

test('upsertCronEntry (round-6 finding 8): a bare legacy block belonging to ANOTHER function is refused, never rewritten', () => {
  const io = fakeIO(legacyBlockOwnedBy('gtm', 'nightly'));
  assert.throws(
    () => upsertCronEntry(io, 'ops/nightly', 'ops-line', { id: 'nightly', registeredFunctions: ['ops'] }),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /cannot adopt legacy cron block 'nightly'/);
      assert.match(err.body, /roster:schedule:nightly:begin/, 'the conflicting block is named');
      assert.match(err.remedy, /crontab/);
      return true;
    },
  );
  assert.equal(io.written.length, 0, "gtm/nightly's live block is untouched");
  assert.ok(io.current.includes('old-line'));
});

test('upsertCronEntry (round-6 finding 8): an UNPROVABLE bare legacy block (pre-scoped-paths content) is refused', () => {
  // A genuine pre-#323 line carries only `logs/cron/<name>.log` — no function
  // segment, so ownership cannot be proven for ANY function.
  const unprovable =
    '# roster:schedule:nightly:begin (do not edit; managed by `roster schedule install`)\n' +
    "0 0 * * * codex exec >> '/w/logs/cron/nightly.log' 2>&1\n" +
    '# roster:schedule:nightly:end\n';
  const io = fakeIO(unprovable);
  assert.throws(() => upsertCronEntry(io, 'gtm/nightly', 'new-line', { id: 'nightly', registeredFunctions: ['gtm'] }), RosterError);
  assert.equal(io.written.length, 0);
});

test('removeCronEntry (round-6 finding 8): a bare legacy block belonging to ANOTHER function is refused, never deleted', () => {
  const io = fakeIO(legacyBlockOwnedBy('gtm', 'nightly'));
  assert.throws(
    () => removeCronEntry(io, 'ops/nightly', { id: 'nightly', registeredFunctions: ['ops'] }),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /cannot adopt legacy cron block/);
      return true;
    },
  );
  assert.equal(io.written.length, 0, "gtm/nightly's live cron survives an ops/nightly remove");
  assert.ok(io.current.includes('old-line'));
});

test('legacyMarkerOwnedBy: schedule-name boundary is pinned (gtm/night does not claim gtm/nightly paths)', () => {
  const content = legacyBlockOwnedBy('gtm', 'nightly');
  assert.equal(legacyMarkerOwnedBy(content, 'nightly', 'gtm', 'nightly'), true);
  assert.equal(legacyMarkerOwnedBy(content, 'nightly', 'ops', 'nightly'), false);
  // A hypothetical shorter name must not prefix-match the longer path.
  const short =
    '# roster:schedule:night:begin (managed)\n' +
    "0 0 * * * x >> '/w/logs/cron/gtm/nightly.log' 2>&1\n" +
    '# roster:schedule:night:end\n';
  assert.equal(legacyMarkerOwnedBy(short, 'night', 'gtm', 'night'), false);
});

// ── round-7 finding 5: ownership parses the block's OWN path ARGUMENT, never a
// substring of the whole line ────────────────────────────────────────────────

// A foreign (ops/night) block whose WORKSPACE path happens to embed
// `logs/cron/gtm/night`. The old unanchored substring scan matched it for
// (gtm, night) — install/remove could then rewrite or delete the foreign block.
function foreignBlockWithEmbeddedPath(): string {
  return (
    '# roster:schedule:night:begin (do not edit; managed by `roster schedule install`)\n' +
    renderCronLine({
      cron: '0 0 * * *',
      workspacePath: '/tmp/logs/cron/gtm/night',
      codexBinaryPath: '/usr/local/bin/codex',
      prompt: 'Use the roster-orchestrator skill to run plan sweep for agent ops/janitor (schedule night)',
      logPath: '/tmp/logs/cron/gtm/night/logs/cron/ops/night.log',
      exitDir: '/tmp/logs/cron/gtm/night/logs/cron/ops/night',
    }) +
    '\n# roster:schedule:night:end\n'
  );
}

test('legacyMarkerOwnedBy (round-7 finding 5): a foreign block whose WORKSPACE path embeds logs/cron/<fn>/<sched> is NOT adopted', () => {
  const content = foreignBlockWithEmbeddedPath();
  // gtm/night must NOT claim the ops/night block just because the foreign
  // workspace path contains 'logs/cron/gtm/night'.
  assert.equal(legacyMarkerOwnedBy(content, 'night', 'gtm', 'night'), false);
  // The block's true owner still proves ownership via its exit-dir argument.
  assert.equal(legacyMarkerOwnedBy(content, 'night', 'ops', 'night'), true);
});

test('upsertCronEntry/removeCronEntry (round-7 finding 5): the embedded-path foreign block is refused, never rewritten or deleted', () => {
  const upIo = fakeIO(foreignBlockWithEmbeddedPath());
  assert.throws(() => upsertCronEntry(upIo, 'gtm/night', 'gtm-line', { id: 'night', registeredFunctions: ['gtm'] }), RosterError);
  assert.equal(upIo.written.length, 0, "ops/night's live block is untouched by a gtm/night install");

  const rmIo = fakeIO(foreignBlockWithEmbeddedPath());
  assert.throws(() => removeCronEntry(rmIo, 'gtm/night', { id: 'night', registeredFunctions: ['gtm'] }), RosterError);
  assert.equal(rmIo.written.length, 0, "ops/night's live block survives a gtm/night remove");
});

test('legacyMarkerOwnedBy (round-7 finding 5): a legitimate legacy WRAPPED block (bare marker, real rendered line) is still owned', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/home/u/ws',
    codexBinaryPath: '/usr/local/bin/codex',
    prompt: 'Use the roster-orchestrator skill to run plan cold for agent gtm/sdr (schedule nightly)',
    logPath: '/home/u/ws/logs/cron/gtm/nightly.log',
    exitDir: '/home/u/ws/logs/cron/gtm/nightly',
  });
  const content =
    '# roster:schedule:nightly:begin (do not edit; managed by `roster schedule install`)\n' +
    line +
    '\n# roster:schedule:nightly:end\n';
  assert.equal(legacyMarkerOwnedBy(content, 'nightly', 'gtm', 'nightly'), true, 'the exit-dir argument proves ownership');
  assert.equal(legacyMarkerOwnedBy(content, 'nightly', 'ops', 'nightly'), false, 'another function cannot claim it');
  const io = fakeIO(content);
  const r = upsertCronEntry(io, 'gtm/nightly', 'migrated-line', { id: 'nightly', registeredFunctions: ['gtm'] });
  assert.equal(r.action, 'updated', 'the provably-owned legacy block still migrates');
});

// ── round-7 finding 2: the legacy bare-name fallback needs a GLOBALLY UNIQUE
// schedule name, not just a content proof ────────────────────────────────────

test('upsertCronEntry (round-7 finding 2): a bare marker whose name TWO functions register is refused as ambiguous, even when the content "proves" us', () => {
  const io = fakeIO(legacyBlockOwnedBy('gtm', 'nightly'));
  assert.throws(
    () => upsertCronEntry(io, 'gtm/nightly', 'new-line', { id: 'nightly', registeredFunctions: ['gtm', 'ops'] }),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /ambiguous legacy cron block 'nightly'/);
      assert.match(err.body, /gtm, ops/, 'the competing functions are named');
      assert.match(err.remedy, /roster schedule install/);
      return true;
    },
  );
  assert.equal(io.written.length, 0, 'the crontab is never rewritten under ambiguity');
  assert.ok(io.current.includes('old-line'));
});

test('removeCronEntry (round-7 finding 2): the ambiguous bare block SURVIVES a remove', () => {
  const io = fakeIO(legacyBlockOwnedBy('gtm', 'nightly'));
  assert.throws(
    () => removeCronEntry(io, 'gtm/nightly', { id: 'nightly', registeredFunctions: ['gtm', 'ops'] }),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /ambiguous legacy cron block/);
      return true;
    },
  );
  assert.equal(io.written.length, 0);
  assert.ok(io.current.includes('old-line'), "the block that may be ops' live schedule is untouched");
});

test('legacyMarkerIsAmbiguous: >1 DISTINCT claimant is ambiguous; one (even repeated) is not', () => {
  assert.equal(legacyMarkerIsAmbiguous({ id: 'nightly', registeredFunctions: ['gtm'] }), false);
  assert.equal(legacyMarkerIsAmbiguous({ id: 'nightly', registeredFunctions: ['gtm', 'gtm'] }), false);
  assert.equal(legacyMarkerIsAmbiguous({ id: 'nightly', registeredFunctions: [] }), false);
  assert.equal(legacyMarkerIsAmbiguous({ id: 'nightly', registeredFunctions: ['gtm', 'ops'] }), true);
});

test('upsertCronEntry (round-7 finding 2): ambiguity does NOT gate the function-SCOPED path (the normal post-migration case)', () => {
  const scoped =
    '# roster:schedule:gtm/nightly:begin (do not edit; managed by `roster schedule install`)\n' +
    'old-scoped-line\n' +
    '# roster:schedule:gtm/nightly:end\n';
  const io = fakeIO(scoped);
  const r = upsertCronEntry(io, 'gtm/nightly', 'new-line', { id: 'nightly', registeredFunctions: ['gtm', 'ops'] });
  assert.equal(r.action, 'updated', 'a scoped block never consults the legacy fallback');
  assert.ok(io.current.includes('new-line'));
});

// ── findMarkerBlocks ──────────────────────────────────────────────────────

test('findMarkerBlocks: empty content → empty', () => {
  assert.deepEqual(findMarkerBlocks('', 'foo'), []);
});

test('findMarkerBlocks: single block → one index', () => {
  const content = '# roster:schedule:foo:begin (do not edit)\n0 * * * * echo\n# roster:schedule:foo:end\n';
  const matches = findMarkerBlocks(content, 'foo');
  assert.equal(matches.length, 1);
});

test('findMarkerBlocks: false-match guard — name=foo does not match foobar', () => {
  const content = '# roster:schedule:foobar:begin (do not edit)\nline\n# roster:schedule:foobar:end\n';
  const matches = findMarkerBlocks(content, 'foo');
  assert.equal(matches.length, 0);
});

test('findMarkerBlocks: false-match guard — name=foo does not match foo-bar', () => {
  const content = '# roster:schedule:foo-bar:begin (managed)\n';
  const matches = findMarkerBlocks(content, 'foo');
  assert.equal(matches.length, 0);
});

test('findMarkerBlocks: duplicates → two indices', () => {
  const content = [
    '# roster:schedule:foo:begin (a)',
    'line1',
    '# roster:schedule:foo:end',
    '',
    '# roster:schedule:foo:begin (b)',
    'line2',
    '# roster:schedule:foo:end',
    '',
  ].join('\n');
  const matches = findMarkerBlocks(content, 'foo');
  assert.equal(matches.length, 2);
});

// ── upsertCronEntry ───────────────────────────────────────────────────────

test('upsertCronEntry: empty crontab → action=created, marker block written', () => {
  const io = noCrontabIO();
  const result = upsertCronEntry(io, 'sdr-cold-outreach', '0 9 * * 1-5 echo hi');
  assert.equal(result.action, 'created');
  assert.equal(io.written.length, 1);
  assert.match(io.current, /# roster:schedule:sdr-cold-outreach:begin/);
  assert.match(io.current, /0 9 \* \* 1-5 echo hi/);
  assert.match(io.current, /# roster:schedule:sdr-cold-outreach:end/);
});

test('upsertCronEntry: existing crontab without our block → action=created, unrelated lines preserved', () => {
  const initial = '# user comment\n0 0 * * * /bin/user-job\n';
  const io = fakeIO(initial);
  const result = upsertCronEntry(io, 'mine', '5 * * * * /bin/mine');
  assert.equal(result.action, 'created');
  assert.match(io.current, /# user comment/);
  assert.match(io.current, /\/bin\/user-job/);
  assert.match(io.current, /# roster:schedule:mine:begin/);
});

test('upsertCronEntry: existing block → action=updated, replaced in place', () => {
  const initial = [
    '# user line',
    '0 0 * * * user-job',
    '',
    '# roster:schedule:mine:begin (managed)',
    'old-line',
    '# roster:schedule:mine:end',
    '',
    '# trailing user line',
    '',
  ].join('\n');
  const io = fakeIO(initial);
  const result = upsertCronEntry(io, 'mine', 'new-line');
  assert.equal(result.action, 'updated');
  assert.ok(io.current.includes('new-line'));
  assert.ok(!io.current.includes('old-line'));
  assert.match(io.current, /# user line/);
  assert.match(io.current, /# trailing user line/);
});

test('upsertCronEntry: begin marker present but end marker missing → throws (impl-review)', () => {
  // Codex impl-review caught: previous fallback ate user lines through EOF.
  const orphan = [
    '# roster:schedule:mine:begin (managed)',
    '0 0 * * * orphan-line',
    '# UNRELATED USER LINE 1',
    '# UNRELATED USER LINE 2',
  ].join('\n');
  const io = fakeIO(orphan);
  assert.throws(
    () => upsertCronEntry(io, 'mine', 'new-line'),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /malformed managed block/);
      return true;
    },
  );
  assert.equal(io.written.length, 0, 'no write should happen on malformed block');
});

test('upsertCronEntry: duplicate marker blocks → throws RosterError, no write', () => {
  const dup = [
    '# roster:schedule:dup:begin (a)',
    'line1',
    '# roster:schedule:dup:end',
    '',
    '# roster:schedule:dup:begin (b)',
    'line2',
    '# roster:schedule:dup:end',
    '',
  ].join('\n');
  const io = fakeIO(dup);
  assert.throws(
    () => upsertCronEntry(io, 'dup', 'new-line'),
    (err: unknown) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.header, /duplicate marker blocks/);
      return true;
    },
  );
  assert.equal(io.written.length, 0);
});

test('upsertCronEntry: idempotent re-install → same content, marker block intact', () => {
  const io = noCrontabIO();
  upsertCronEntry(io, 'foo', '0 9 * * 1-5 first');
  const after1 = io.current;
  const r2 = upsertCronEntry(io, 'foo', '0 9 * * 1-5 first');
  assert.equal(r2.action, 'updated');
  assert.equal(io.current, after1);
});

test('upsertCronEntry: re-install with changed line → block content swapped, no duplicates', () => {
  const io = noCrontabIO();
  upsertCronEntry(io, 'foo', '0 9 * * 1-5 v1');
  upsertCronEntry(io, 'foo', '0 9 * * 1-5 v2');
  assert.ok(io.current.includes('v2'));
  assert.ok(!io.current.includes('v1'));
  // Only one begin marker.
  const matches = findMarkerBlocks(io.current, 'foo');
  assert.equal(matches.length, 1);
});

// ── markerStrings ─────────────────────────────────────────────────────────

test('getMarkerStrings: begin/end are stable', () => {
  const { begin, end } = getMarkerStrings('foo');
  assert.ok(begin.startsWith('# roster:schedule:foo:begin'));
  assert.equal(end, '# roster:schedule:foo:end');
});

// ── removeCronEntry ───────────────────────────────────────────────────────

test('removeCronEntry: no crontab at all → returns removed=false', () => {
  const io = noCrontabIO();
  const r = removeCronEntry(io, 'heartbeat');
  assert.equal(r.removed, false);
  assert.equal(io.written.length, 0);
});

test('removeCronEntry: marker block absent → returns removed=false without writing', () => {
  const io = fakeIO('# user comment\n0 9 * * * /bin/true\n');
  const r = removeCronEntry(io, 'heartbeat');
  assert.equal(r.removed, false);
  assert.equal(io.written.length, 0);
});

test('removeCronEntry: lone managed block → leaves empty crontab', () => {
  const initial =
    '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)\n' +
    '* * * * * /bin/echo hi\n' +
    '# roster:schedule:heartbeat:end\n';
  const io = fakeIO(initial);
  const r = removeCronEntry(io, 'heartbeat');
  assert.equal(r.removed, true);
  assert.equal(io.written.length, 1);
  assert.equal(io.current, '');
});

test('removeCronEntry: managed block among other user lines → preserves user lines', () => {
  const initial =
    '# user comment\n' +
    '0 9 * * * /bin/true\n' +
    '\n' +
    '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)\n' +
    '* * * * * /bin/echo hi\n' +
    '# roster:schedule:heartbeat:end\n' +
    '\n' +
    '# another user line\n' +
    '0 10 * * * /bin/false\n';
  const io = fakeIO(initial);
  removeCronEntry(io, 'heartbeat');
  const after = io.current;
  assert.ok(after.includes('# user comment'));
  assert.ok(after.includes('# another user line'));
  assert.ok(after.includes('0 9 * * * /bin/true'));
  assert.ok(after.includes('0 10 * * * /bin/false'));
  assert.ok(!after.includes('roster:schedule:heartbeat'));
});

test('removeCronEntry: duplicate marker blocks → throws RosterError', () => {
  const initial =
    '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)\n' +
    '* * * * * /bin/echo first\n' +
    '# roster:schedule:heartbeat:end\n' +
    '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)\n' +
    '* * * * * /bin/echo second\n' +
    '# roster:schedule:heartbeat:end\n';
  const io = fakeIO(initial);
  assert.throws(() => removeCronEntry(io, 'heartbeat'), RosterError);
  assert.equal(io.written.length, 0);
});

test('removeCronEntry: missing :end marker → throws RosterError (refuse to guess)', () => {
  const initial =
    '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)\n' +
    '* * * * * /bin/echo hi\n';
  const io = fakeIO(initial);
  assert.throws(() => removeCronEntry(io, 'heartbeat'), RosterError);
  assert.equal(io.written.length, 0);
});

test('removeCronEntry: only removes the requested schedule, not other managed blocks', () => {
  const initial =
    '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)\n' +
    '* * * * * /bin/echo hi\n' +
    '# roster:schedule:heartbeat:end\n' +
    '\n' +
    '# roster:schedule:other:begin (do not edit; managed by `roster schedule install`)\n' +
    '0 9 * * * /bin/echo other\n' +
    '# roster:schedule:other:end\n';
  const io = fakeIO(initial);
  removeCronEntry(io, 'heartbeat');
  assert.ok(!io.current.includes('roster:schedule:heartbeat'));
  assert.ok(io.current.includes('roster:schedule:other:begin'));
  assert.ok(io.current.includes('/bin/echo other'));
});

test('removeCronEntry: byte-exact inverse of upsert when initial content had no trailing newline (codex finding #5)', () => {
  // Initial state: user had a crontab like `MAILTO=me` with no trailing \n.
  // upsertCronEntry will insert `\n\n{block}\n`. removeCronEntry should
  // restore the exact original bytes, not leave a stray `\n` behind.
  const initial = 'MAILTO=me';
  const io = fakeIO(initial);
  upsertCronEntry(io, 'heartbeat', '* * * * * /bin/echo');
  // Sanity: upsert inserted both separator newlines.
  assert.equal(io.current.startsWith('MAILTO=me\n\n# roster:schedule:heartbeat:begin'), true);
  removeCronEntry(io, 'heartbeat');
  assert.equal(io.current, 'MAILTO=me', `expected byte-exact restore, got: ${JSON.stringify(io.current)}`);
});

test('removeCronEntry: ambiguity at trailing-block — biases toward byte-exact for no-trailing-newline case', () => {
  // KNOWN LIMITATION: upsert produces identical bytes for two distinct inputs
  //   (a) original `X\n\n` (ends with blank line) + sep='' → `X\n\n<block>\n`
  //   (b) original `X` (no trailing newline) + sep='\n\n' → `X\n\n<block>\n`
  // remove cannot distinguish (a) from (b) without out-of-band metadata.
  // Decision: bias toward (b) — restore byte-exact for the codex-finding case
  // (initial `MAILTO=me` round-trips), at the cost of trimming the user's
  // intentional blank line in (a). The information loss is symmetric.
  const initial = '# user 1\n\n# user 2\n\n# roster:schedule:foo:begin (managed)\n* * * * * /bin/echo\n# roster:schedule:foo:end\n';
  const io = fakeIO(initial);
  removeCronEntry(io, 'foo');
  assert.equal(io.current, '# user 1\n\n# user 2');
});

// ── renderCronLine: % escape for crontab (ROS-42 codex review) ────────────

test('renderCronLine: literal % in workspace path is escaped as \\% (vixie cron sends % to stdin)', () => {
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: '/tmp/firat%test',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Hello',
    logPath: '/tmp/log.txt',
  });
  // The % byte must NOT appear unescaped anywhere in the rendered line.
  // Every literal % must be preceded by a backslash.
  const matches = [...line.matchAll(/(?<!\\)%/g)];
  assert.equal(matches.length, 0, `unescaped % at index ${matches[0]?.index}: ${line}`);
  // And the path must round-trip back to the original (escape is reversible).
  assert.ok(line.includes('/tmp/firat\\%test'));
});

test('renderCronLine: % in prompt is escaped (wrapped form)', () => {
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: '/w',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Use 100% effort',
    logPath: '/w/log',
    exitDir: '/w/exit',
  });
  const matches = [...line.matchAll(/(?<!\\)%/g)];
  assert.equal(matches.length, 0, `unescaped % at index ${matches[0]?.index}`);
  // printf %s should also be escaped now (becomes printf \%s) — that's fine
  // because the cron daemon strips the backslash before /bin/sh sees it,
  // and `printf \%s "$rc"` is identical to `printf %s "$rc"` at the shell.
  assert.ok(line.includes('printf \\%s "$rc"'));
});
