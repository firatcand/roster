import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shellQuote,
  renderCronLine,
  upsertCronEntry,
  findMarkerBlocks,
  getMarkerStrings,
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
