import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  EXIT_NO_TOOLS,
  RosterError,
  isRosterError,
  missingScaffoldError,
  noToolsError,
  permissionError,
  renderError,
  unexpectedError,
  userCancelledInit,
  userCancelledInstall,
} from '../src/lib/errors.ts';

// Stripping ANSI escape sequences so substring matches don't have to escape colors.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function captureRender(err: RosterError, debug: boolean): { lines: string[]; raw: string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  renderError(err, { debug, stream });
  const raw = Buffer.concat(chunks).toString('utf8').replace(ANSI_RE, '');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { lines, raw };
}

test('exit-code constants are 0/1/2/3', () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_ERROR, 1);
  assert.equal(EXIT_CANCELLED, 2);
  assert.equal(EXIT_NO_TOOLS, 3);
});

test('renderError writes header, body, remedy in order (no stack without debug)', () => {
  const err = new RosterError({
    header: 'roster: something',
    body: '  caused by X',
    remedy: '  do Y',
    exitCode: EXIT_ERROR,
  });
  const { lines } = captureRender(err, false);
  assert.equal(lines.length, 3, 'three lines without debug');
  assert.match(lines[0]!, /roster: something/);
  assert.match(lines[1]!, /caused by X/);
  assert.match(lines[2]!, /do Y/);
});

test('renderError skips an empty body line — header then remedy, no blank gap', () => {
  const err = new RosterError({
    header: 'roster: bad flag',
    body: '',
    remedy: '  Run --help.',
    exitCode: EXIT_ERROR,
  });
  const { lines } = captureRender(err, false);
  assert.equal(lines.length, 2, 'two lines when body is empty');
  assert.match(lines[0]!, /roster: bad flag/);
  assert.match(lines[1]!, /Run --help\./);
});

test('renderError with debug=true appends stack after remedy', () => {
  const err = new RosterError({
    header: 'roster: boom',
    body: '  b',
    remedy: '  r',
    exitCode: EXIT_ERROR,
  });
  const { raw } = captureRender(err, true);
  // Stack lines have 'at ' frames in v8.
  assert.match(raw, /\bat\s+/, 'stack frame present with debug');
  // Order: header line precedes any stack frame.
  const headerIdx = raw.indexOf('roster: boom');
  const stackIdx = raw.search(/\bat\s+/);
  assert.ok(headerIdx >= 0 && stackIdx > headerIdx, 'header precedes stack');
});

test('isRosterError narrows to RosterError', () => {
  assert.equal(isRosterError(new Error('x')), false);
  assert.equal(isRosterError(new RosterError({ header: '', body: '', remedy: '', exitCode: 0 })), true);
  assert.equal(isRosterError(null), false);
  assert.equal(isRosterError('string'), false);
});

test('permissionError: exitCode EXIT_ERROR, header mentions permission, remedy mentions sudo', () => {
  const cause = Object.assign(new Error('boom'), { code: 'EACCES', syscall: 'mkdir' });
  const err = permissionError('/tmp/foo', cause);
  assert.equal(err.exitCode, EXIT_ERROR);
  assert.match(err.header, /permission denied/i);
  assert.match(err.body, /EACCES/);
  assert.match(err.body, /mkdir/);
  assert.match(err.body, /\/tmp\/foo/);
  assert.match(err.remedy, /sudo/);
  assert.match(err.remedy, /chown/);
});

test('noToolsError: exitCode EXIT_NO_TOOLS, body lists every passed tool with its link', () => {
  const err = noToolsError([
    { name: 'Claude Code', installLink: 'https://claude.ai/code' },
    { name: 'Codex CLI', installLink: 'https://github.com/openai/codex' },
    { name: 'Gemini CLI', installLink: 'https://github.com/google-gemini/gemini-cli' },
  ]);
  assert.equal(err.exitCode, EXIT_NO_TOOLS);
  assert.match(err.header, /no AI tools detected/i);
  assert.match(err.body, /Claude Code/);
  assert.match(err.body, /https:\/\/claude\.ai\/code/);
  assert.match(err.body, /Codex CLI/);
  assert.match(err.body, /github\.com\/openai\/codex/);
  assert.match(err.body, /Gemini CLI/);
  assert.match(err.body, /google-gemini/);
  assert.match(err.remedy, /roster install/);
});

test('noToolsError: empty tool list yields a coherent error (no crash)', () => {
  const err = noToolsError([]);
  assert.equal(err.exitCode, EXIT_NO_TOOLS);
  assert.match(err.header, /no AI tools detected/i);
});

test('userCancelledInit: exit 2, body "Nothing written."', () => {
  const err = userCancelledInit();
  assert.equal(err.exitCode, EXIT_CANCELLED);
  assert.match(err.body, /Nothing written\./);
});

test('userCancelledInstall: exit 2, body "Nothing written.", remedy points back to install', () => {
  const err = userCancelledInstall();
  assert.equal(err.exitCode, EXIT_CANCELLED);
  assert.match(err.body, /Nothing written\./);
  assert.match(err.remedy, /roster install/);
});

test('missingScaffoldError: exit 1, remedy suggests reinstall', () => {
  const err = missingScaffoldError('/some/path');
  assert.equal(err.exitCode, EXIT_ERROR);
  assert.match(err.body, /\/some\/path/);
  assert.match(err.remedy, /reinstall/i);
});

test('unexpectedError wraps a plain Error and splices original frames under its own header', () => {
  const original = new Error('boom');
  const err = unexpectedError(original);
  assert.equal(err.exitCode, EXIT_ERROR);
  assert.match(err.header, /unexpected error/i);
  assert.match(err.body, /boom/);
  // The wrapper's stack starts with RosterError's own header line, then the
  // original frames — never the original Error's "Error: boom" preamble.
  assert.ok(err.stack);
  const firstLine = err.stack!.split('\n', 1)[0]!;
  assert.match(firstLine, /^RosterError/, 'first line is the wrapper header');
  const originalFrames = original.stack!.replace(/^[^\n]*\n/, '');
  assert.ok(err.stack!.includes(originalFrames), 'original frames preserved');
});

test('unexpectedError wraps a non-Error throw value', () => {
  const err = unexpectedError('something went wrong');
  assert.equal(err.exitCode, EXIT_ERROR);
  assert.match(err.body, /something went wrong/);
  // No original stack to preserve; the wrapper supplies its own.
  assert.ok(err.stack);
});
