import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shellQuote,
  renderCronLine,
  upsertCronEntry,
  findMarkerBlocks,
  getMarkerStrings,
  removeCronEntry,
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

test('renderCronLine: exitPath set → wraps in /bin/sh -c, captures $?', () => {
  const line = renderCronLine({
    cron: '0 9 * * 1-5',
    workspacePath: '/Users/firat/my-roster',
    codexBinaryPath: '/opt/homebrew/bin/codex',
    prompt: 'Use the roster-orchestrator skill',
    logPath: '/Users/firat/my-roster/logs/cron/sdr.log',
    exitPath: '/Users/firat/my-roster/logs/cron/sdr.exit',
  });
  // env prefix unchanged
  assert.match(line, /^0 9 \* \* 1-5 \/usr\/bin\/env -i HOME="\$HOME" /);
  // /bin/sh -c wraps the inner command
  assert.match(line, / \/bin\/sh -c '/);
  // inner: codex exec + redirect + rc capture + exit. The `%` in printf gets
  // escaped to `\%` by escapeCronPercent so cron doesn't treat it as the
  // stdin sentinel — cron strips the backslash before /bin/sh sees it, so
  // the actual shell still sees `printf %s`.
  assert.match(line, /printf \\%s "\$rc"/);
  assert.match(line, /exit "\$rc"/);
  // exit path is embedded
  assert.ok(line.includes("'/Users/firat/my-roster/logs/cron/sdr.exit'"));
});

test('renderCronLine: exitPath unset → legacy un-wrapped form (byte-exact backwards-compat)', () => {
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
    exitPath: '/w/exit',
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
    exitPath: '/Users/firat/my-roster/logs/cron/sdr.exit',
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
    exitPath: "/tmp/firat's-test/exit",
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
    exitPath: '/w/exit',
    eventsPath: '/w/events.jsonl',
  });
  const r = shellParses(line);
  assert.ok(r.ok, `sh -n rejected the events-form line:\n${r.stderr}`);
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
    exitPath: '/w/exit',
  });
  const matches = [...line.matchAll(/(?<!\\)%/g)];
  assert.equal(matches.length, 0, `unescaped % at index ${matches[0]?.index}`);
  // printf %s should also be escaped now (becomes printf \%s) — that's fine
  // because the cron daemon strips the backslash before /bin/sh sees it,
  // and `printf \%s "$rc"` is identical to `printf %s "$rc"` at the shell.
  assert.ok(line.includes('printf \\%s "$rc"'));
});
