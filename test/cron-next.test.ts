import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFireTime, nextFireOrThrow } from '../src/lib/cron-next.ts';

const at = (iso: string): Date => new Date(iso);

// Strip millisecond precision — the state.md format is second-precision.
function nextIso(cron: string, from: string): string {
  const r = nextFireTime(cron, at(from));
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.next.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test('cron *: every minute → next minute boundary', () => {
  assert.equal(nextIso('* * * * *', '2026-05-18T10:30:15Z'), '2026-05-18T10:31:00Z');
});

test('cron 0 9 * * 1-5: weekday 09:00 — from Sunday', () => {
  // 2026-05-17 is a Sunday. Next Monday is 2026-05-18.
  assert.equal(nextIso('0 9 * * 1-5', '2026-05-17T12:00:00Z'), '2026-05-18T09:00:00Z');
});

test('cron 0 9 * * 1-5: weekday 09:00 — from Friday after fire', () => {
  // 2026-05-15 (Fri) 10:00 → next Mon 2026-05-18 09:00
  assert.equal(nextIso('0 9 * * 1-5', '2026-05-15T10:00:00Z'), '2026-05-18T09:00:00Z');
});

test('cron */5: every 5 minutes', () => {
  assert.equal(nextIso('*/5 * * * *', '2026-05-18T10:31:00Z'), '2026-05-18T10:35:00Z');
  assert.equal(nextIso('*/5 * * * *', '2026-05-18T10:34:30Z'), '2026-05-18T10:35:00Z');
  assert.equal(nextIso('*/5 * * * *', '2026-05-18T10:35:00Z'), '2026-05-18T10:40:00Z');
});

test('cron list of minutes: 1,15,30,45', () => {
  assert.equal(nextIso('1,15,30,45 * * * *', '2026-05-18T10:16:00Z'), '2026-05-18T10:30:00Z');
  assert.equal(nextIso('1,15,30,45 * * * *', '2026-05-18T10:45:00Z'), '2026-05-18T11:01:00Z');
});

test('cron range 0-30: only first half of each hour', () => {
  assert.equal(nextIso('0-30 * * * *', '2026-05-18T10:31:00Z'), '2026-05-18T11:00:00Z');
  assert.equal(nextIso('0-30 * * * *', '2026-05-18T10:29:00Z'), '2026-05-18T10:30:00Z');
});

test('cron range with step 1-10/2', () => {
  assert.equal(nextIso('1-10/2 * * * *', '2026-05-18T10:00:00Z'), '2026-05-18T10:01:00Z');
  assert.equal(nextIso('1-10/2 * * * *', '2026-05-18T10:02:00Z'), '2026-05-18T10:03:00Z');
  // From 9 → 10? 10 is not in 1,3,5,7,9 → next is 11:01.
  assert.equal(nextIso('1-10/2 * * * *', '2026-05-18T10:09:00Z'), '2026-05-18T11:01:00Z');
});

test('aliases: @hourly @daily @weekly @monthly @yearly @annually', () => {
  assert.equal(nextIso('@hourly', '2026-05-18T10:30:00Z'), '2026-05-18T11:00:00Z');
  assert.equal(nextIso('@daily', '2026-05-18T10:30:00Z'), '2026-05-19T00:00:00Z');
  // @weekly = 0 0 * * 0 = Sunday midnight. 2026-05-18 is Mon; next Sun = 2026-05-24.
  assert.equal(nextIso('@weekly', '2026-05-18T10:30:00Z'), '2026-05-24T00:00:00Z');
  assert.equal(nextIso('@monthly', '2026-05-18T10:30:00Z'), '2026-06-01T00:00:00Z');
  assert.equal(nextIso('@yearly', '2026-05-18T10:30:00Z'), '2027-01-01T00:00:00Z');
  assert.equal(nextIso('@annually', '2026-05-18T10:30:00Z'), '2027-01-01T00:00:00Z');
});

test('@yearly mid-year → next Jan 1 00:00 UTC', () => {
  assert.equal(nextIso('@yearly', '2026-07-15T12:00:00Z'), '2027-01-01T00:00:00Z');
});

test('day-of-week 7 normalizes to 0 (Sunday)', () => {
  // 2026-05-18 is Mon; next Sun midnight is 2026-05-24 with dow=7
  assert.equal(nextIso('0 0 * * 7', '2026-05-18T10:00:00Z'), '2026-05-24T00:00:00Z');
});

test('Vixie semantics: both dom and dow restricted → OR', () => {
  // "5th of month OR every Monday" — first Monday after 2026-04-30 is 2026-05-04.
  // 2026-05-04 (Mon, day-of-month 4) → Monday hit.
  assert.equal(nextIso('0 0 5 * 1', '2026-04-30T00:00:00Z'), '2026-05-04T00:00:00Z');
});

test('current time exactly matches → returns next match, never the same minute', () => {
  // Cron should fire AT the matching minute; nextFireTime from that minute
  // must advance to the *next* match, not return now.
  assert.equal(nextIso('*/5 * * * *', '2026-05-18T10:35:00Z'), '2026-05-18T10:40:00Z');
});

test('invalid cron expression → ok:false', () => {
  const r = nextFireTime('not a cron', new Date('2026-05-18T00:00:00Z'));
  assert.equal(r.ok, false);
});

test('unsatisfiable cron (Feb 30) → ok:false within 366d budget', () => {
  // Feb has no 30th. Brute-force 366 days finds no fire.
  const r = nextFireTime('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'));
  assert.equal(r.ok, false);
});

test('nextFireOrThrow: returns Date on success', () => {
  const d = nextFireOrThrow('*/5 * * * *', new Date('2026-05-18T10:31:00Z'));
  assert.equal(d.toISOString().replace(/\.\d{3}Z$/, 'Z'), '2026-05-18T10:35:00Z');
});

test('nextFireOrThrow: throws RosterError on invalid cron', () => {
  assert.throws(
    () => nextFireOrThrow('garbage', new Date('2026-05-18T00:00:00Z')),
    /cannot compute next fire time/,
  );
});
