import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStale, type StateLine } from '../src/lib/schedule-state.ts';

// Helper: build a StateLine matching the orchestrator's append format.
function line(ts: string, scope: string, status: string): StateLine {
  return { timestamp: ts, scope, status, raw: `${ts} | ${scope} | ${status}`, lineNumber: 1 };
}

// `9 AM weekdays` cron — most realistic test case from ADR-0001 sample.
const NINE_AM_WEEKDAYS = '0 9 * * 1-5';

// ── never-fired-yet ──────────────────────────────────────────────────────

test('detectStale: never fired, before first window → not stale (never-fired-yet)', () => {
  // First weekday at 09:00 UTC after this `now` would be 2026-05-18T09:00 (Monday).
  // At 2026-05-18T07:00 with no lastRun, the 09:00 window has not happened yet.
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: undefined,
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T07:00:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
  if (!r.stale) assert.equal(r.reason, 'never-fired-yet');
});

// ── recent run within grace ──────────────────────────────────────────────

test('detectStale: agent reported within grace → not stale (recent-run)', () => {
  // Fire window: Mon 09:00. Last run at 09:05. Now at 11:30 (within 2h grace).
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: line('2026-05-18T09:05:00Z', 'gtm/sdr/cold/_demo', 'success'),
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T11:30:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
  if (!r.stale) assert.equal(r.reason, 'recent-run');
});

// ── no signals at all → benign (never-fired-yet) ─────────────────────────

test('detectStale: no lastRun + no .exit → never-fired-yet (caller decides via install mtime)', () => {
  // Can't distinguish "freshly installed" from "broken since forever" without
  // an install-time anchor. detectStale stays quiet; doctor checks
  // schedules.yaml mtime separately if it wants the freshness signal.
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: undefined,
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T11:01:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
  if (!r.stale) assert.equal(r.reason, 'never-fired-yet');
});

test('detectStale: no lastRun + recent .exit → recent-fire (wrapper ran; failure path surfaces)', () => {
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: undefined,
    lastFireMtimeMs: new Date('2026-05-18T09:00:00Z').getTime(),
    now: new Date('2026-05-18T11:30:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
  if (!r.stale) assert.equal(r.reason, 'recent-fire');
});

// ── stale: previous run is from before the expected fire ─────────────────

test('detectStale: stale last run from previous day → stale (missed-window)', () => {
  // Last successful run was Friday 09:05. Now is Monday 11:30 (grace expired
  // on the Monday window).
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: line('2026-05-15T09:05:00Z', 'gtm/sdr/cold/_demo', 'success'),
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T11:30:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, true);
  if (r.stale) assert.equal(r.reason, 'missed-window');
});

// ── recent-fire: wrapper recorded fire but agent silent ──────────────────

test('detectStale: .exit mtime recent but no agent line → not stale (recent-fire)', () => {
  // The cron daemon ran the wrapper at 09:00 (.exit mtime), but agent never
  // appended state.md (e.g., codex crashed mid-orchestration). At 11:30 we
  // know the wrapper ran — the failure-detection path (non-zero exit) will
  // surface this; STALE is about cron dropping fires, which it didn't here.
  const fireAt = new Date('2026-05-18T09:00:00Z').getTime();
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: line('2026-05-15T09:05:00Z', 'gtm/sdr/cold/_demo', 'success'), // stale agent state
    lastFireMtimeMs: fireAt,
    now: new Date('2026-05-18T11:30:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
  if (!r.stale) assert.equal(r.reason, 'recent-fire');
});

// ── boundary: exactly at cutoff ──────────────────────────────────────────

test('detectStale: precisely at cutoff (now == fire + grace) → stale (boundary closes the window)', () => {
  // Last run Fri 09:05. Cron next-fire Mon 09:00 + 120m grace = Mon 11:00.
  // At exactly Mon 11:00 the window has just closed → stale.
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: line('2026-05-15T09:05:00Z', 'gtm/sdr/cold/_demo', 'success'),
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T11:00:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, true);
});

test('detectStale: 1ms before cutoff with lastRun → not stale (grace still open)', () => {
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: line('2026-05-15T09:05:00Z', 'gtm/sdr/cold/_demo', 'success'),
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T10:59:59.999Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
});

// ── boundary: epsilon before cutoff ─────────────────────────────────────

test('detectStale: 1 minute before cutoff with no lastRun → never-fired-yet', () => {
  // No lastRun → benign default. Caller (doctor) decides via install mtime.
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: undefined,
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T10:59:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
});

// ── invalid cron expression ──────────────────────────────────────────────

test('detectStale: malformed cron → not stale (defers to schema-validation section)', () => {
  const r = detectStale({
    cronExpr: 'not a cron',
    lastRun: undefined,
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T11:30:00Z'),
    graceMinutes: 120,
  });
  assert.equal(r.stale, false);
});

// ── custom grace minutes ────────────────────────────────────────────────

test('detectStale: graceMinutes=0 with old lastRun → window closes immediately at fire time', () => {
  // Last run Fri 09:05. Cron next-fire Mon 09:00. graceMinutes=0 means cutoff
  // is Mon 09:00 exactly. now=Mon 09:01 → stale.
  const r = detectStale({
    cronExpr: NINE_AM_WEEKDAYS,
    lastRun: line('2026-05-15T09:05:00Z', 'gtm/sdr/cold/_demo', 'success'),
    lastFireMtimeMs: undefined,
    now: new Date('2026-05-18T09:01:00Z'),
    graceMinutes: 0,
  });
  assert.equal(r.stale, true);
});
