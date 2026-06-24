import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMigrateArgs } from '../src/lib/migrate-args.ts';

test('parseMigrateArgs: no subcommand → err', () => {
  const r = parseMigrateArgs([]);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /missing subcommand/);
});

test('parseMigrateArgs: unknown subcommand → err', () => {
  const r = parseMigrateArgs(['from-anywhere']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /unknown 'migrate' subcommand/);
});

test('parseMigrateArgs: codex-skills accepts cwd, dry-run, json, silent', () => {
  const r = parseMigrateArgs(['codex-skills', '--cwd', '/workspace', '--dry-run', '--json', '--silent']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.subcommand, 'codex-skills');
  assert.equal(r.cwd, '/workspace');
  assert.equal(r.dryRun, true);
  assert.equal(r.json, true);
  assert.equal(r.silent, true);
});

test('parseMigrateArgs: missing source-dir → err', () => {
  const r = parseMigrateArgs(['from-agent-team']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /missing positional/);
});

test('parseMigrateArgs: too many positionals → err', () => {
  const r = parseMigrateArgs(['from-agent-team', '/a', '/b']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /expected 1 positional/);
});

test('parseMigrateArgs: source only → ok with defaults', () => {
  const r = parseMigrateArgs(['from-agent-team', '/src']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.subcommand, 'from-agent-team');
  if (r.subcommand !== 'from-agent-team') return;
  assert.equal(r.sourceDir, '/src');
  assert.equal(r.dest, undefined);
  assert.equal(r.dryRun, false);
  assert.equal(r.forceResync, false);
  assert.equal(r.json, false);
  assert.equal(r.silent, false);
});

test('parseMigrateArgs: all flags', () => {
  const r = parseMigrateArgs([
    'from-agent-team',
    '/src',
    '--dest',
    '/dst',
    '--dry-run',
    '--force-resync',
    '--json',
    '--silent',
  ]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.subcommand, 'from-agent-team');
  if (r.subcommand !== 'from-agent-team') return;
  assert.equal(r.sourceDir, '/src');
  assert.equal(r.dest, '/dst');
  assert.equal(r.dryRun, true);
  assert.equal(r.forceResync, true);
  assert.equal(r.json, true);
  assert.equal(r.silent, true);
});

test('parseMigrateArgs: --dest=VALUE inline form', () => {
  const r = parseMigrateArgs(['from-agent-team', '/src', '--dest=/dst']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.subcommand, 'from-agent-team');
  if (r.subcommand !== 'from-agent-team') return;
  assert.equal(r.dest, '/dst');
});

test('parseMigrateArgs: --dest specified twice → err', () => {
  const r = parseMigrateArgs(['from-agent-team', '/src', '--dest', '/a', '--dest', '/b']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /specified more than once/);
});

test('parseMigrateArgs: unknown flag → err', () => {
  const r = parseMigrateArgs(['from-agent-team', '/src', '--bogus']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /unknown flag/);
});

test('parseMigrateArgs: positional after flag works', () => {
  const r = parseMigrateArgs(['from-agent-team', '--dry-run', '/src']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.subcommand, 'from-agent-team');
  if (r.subcommand !== 'from-agent-team') return;
  assert.equal(r.sourceDir, '/src');
  assert.equal(r.dryRun, true);
});
