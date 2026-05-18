import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleArgs } from '../src/lib/schedule-args.ts';

// ROS-45: --dry-run is uniform across every schedule subcommand.
// For install + remove it was already wired (P2.5-T04/T06). For validate,
// list, status, and run it lands here as a parser-level flag (no-op for the
// three read-only commands; skip-spawn for run — see executeRun tests).

test('schedule validate --dry-run → dryRun true', () => {
  const r = parseScheduleArgs(['validate', '--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'validate') return;
  assert.equal(r.dryRun, true);
});

test('schedule list --dry-run → dryRun true', () => {
  const r = parseScheduleArgs(['list', '--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'list') return;
  assert.equal(r.dryRun, true);
});

test('schedule status NAME --dry-run → dryRun true', () => {
  const r = parseScheduleArgs(['status', 'nightly', '--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'status') return;
  assert.equal(r.dryRun, true);
  assert.equal(r.name, 'nightly');
});

test('schedule run NAME --dry-run → dryRun true', () => {
  const r = parseScheduleArgs(['run', 'nightly', '--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'run') return;
  assert.equal(r.dryRun, true);
  assert.equal(r.name, 'nightly');
});

test('schedule remove NAME --dry-run → dryRun true (unchanged behavior)', () => {
  const r = parseScheduleArgs(['remove', 'nightly', '--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'remove') return;
  assert.equal(r.dryRun, true);
});

test('schedule install with --dry-run → dryRun true (unchanged)', () => {
  const r = parseScheduleArgs([
    'install',
    'gtm/sdr',
    'cold-outreach',
    '--cron',
    '0 9 * * 1-5',
    '--tool',
    'claude',
    '--dry-run',
  ]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'install') return;
  assert.equal(r.dryRun, true);
});

test('no --dry-run on any read-only subcommand → dryRun false', () => {
  for (const subc of ['validate', 'list'] as const) {
    const r = parseScheduleArgs([subc]);
    assert.equal(r.kind, 'ok', `${subc} should parse`);
    if (r.kind !== 'ok') continue;
    if (r.subcommand !== subc) continue;
    assert.equal(r.dryRun, false, `${subc} default dryRun`);
  }
  for (const subc of ['status', 'run'] as const) {
    const r = parseScheduleArgs([subc, 'x']);
    assert.equal(r.kind, 'ok', `${subc} should parse`);
    if (r.kind !== 'ok') continue;
    if (r.subcommand !== subc) continue;
    assert.equal(r.dryRun, false, `${subc} default dryRun`);
  }
});

test('schedule run --dry-run still rejects --json (run streams stdout)', () => {
  const r = parseScheduleArgs(['run', 'nightly', '--dry-run', '--json']);
  assert.equal(r.kind, 'err');
});
