import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStateMd,
  readStateMd,
  findRecentRuns,
  findMostRecentRun,
} from '../src/lib/schedule-state.ts';

// Orchestrator appends, so chronological order in the file means oldest line
// first, newest line last. parseStateMd preserves file order; findRecentRuns
// reverse-scans to yield reverse-chronological matches.
const SAMPLE = `2026-05-18T09:00:00Z | gtm/sdr/cold-outreach/acme | success
2026-05-18T10:20:00Z | ops/heartbeat-noop/noop/_demo | failed
2026-05-18T10:25:00Z | ops/heartbeat-noop/noop/_demo | success
2026-05-18T10:30:00Z | ops/heartbeat-noop/noop/_demo | success
`;

test('parseStateMd: parses well-formed lines', () => {
  const r = parseStateMd(SAMPLE);
  assert.equal(r.lines.length, 4);
  assert.equal(r.malformedCount, 0);
  assert.equal(r.lines[0]!.timestamp, '2026-05-18T09:00:00Z');
  assert.equal(r.lines[0]!.scope, 'gtm/sdr/cold-outreach/acme');
  assert.equal(r.lines[0]!.status, 'success');
  assert.equal(r.lines[1]!.status, 'failed');
  assert.equal(r.lines[3]!.timestamp, '2026-05-18T10:30:00Z');
});

test('parseStateMd: blank lines and comments are skipped (not malformed)', () => {
  const content = `# header comment
2026-05-18T10:00:00Z | ops/h/n/p | success

# another comment
2026-05-18T11:00:00Z | ops/h/n/p | failed
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 2);
  assert.equal(r.malformedCount, 0);
});

test('parseStateMd: malformed lines are counted, not crashed on', () => {
  const content = `2026-05-18T10:00:00Z | ops/h/n/p | success
garbage line with no pipes
2026-05-18T11:00:00Z | only two | parts
not-a-timestamp | ops/h/n/p | success
2026-05-18T12:00:00Z |  | success
2026-05-18T13:00:00Z | ops/h/n/p | failed
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 2);
  assert.equal(r.malformedCount, 4);
  assert.equal(r.lines[0]!.timestamp, '2026-05-18T10:00:00Z');
  assert.equal(r.lines[1]!.timestamp, '2026-05-18T13:00:00Z');
});

test('parseStateMd: empty content yields empty result', () => {
  const r = parseStateMd('');
  assert.deepEqual(r, { lines: [], malformedCount: 0 });
});

test('parseStateMd: forward-compat — unknown status passes through opaque', () => {
  const content = `2026-05-18T10:00:00Z | ops/h/n/p | timeout
2026-05-18T11:00:00Z | ops/h/n/p | partial-success
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 2);
  assert.equal(r.malformedCount, 0);
  assert.equal(r.lines[0]!.status, 'timeout');
  assert.equal(r.lines[1]!.status, 'partial-success');
});

test('parseStateMd: ISO-8601 requires Z suffix and second precision', () => {
  const content = `2026-05-18T10:00:00 | ops/h/n/p | success
2026-05-18T10:00:00+00:00 | ops/h/n/p | success
2026-05-18T10:00:00.123Z | ops/h/n/p | success
2026-05-18 10:00:00Z | ops/h/n/p | success
2026-05-18T10:00:00Z | ops/h/n/p | success
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 1);
  assert.equal(r.malformedCount, 4);
});

test('findRecentRuns: filters by function/agent/plan prefix, returns reverse-chronological', () => {
  const parsed = parseStateMd(SAMPLE);
  const ops = findRecentRuns(parsed.lines, 'ops', 'heartbeat-noop', 'noop', 10);
  assert.equal(ops.length, 3);
  assert.equal(ops[0]!.timestamp, '2026-05-18T10:30:00Z');
  assert.equal(ops[1]!.timestamp, '2026-05-18T10:25:00Z');
  assert.equal(ops[2]!.timestamp, '2026-05-18T10:20:00Z');

  const gtm = findRecentRuns(parsed.lines, 'gtm', 'sdr', 'cold-outreach', 10);
  assert.equal(gtm.length, 1);
  assert.equal(gtm[0]!.scope, 'gtm/sdr/cold-outreach/acme');
});

test('findRecentRuns: prefix anchors at trailing slash — partial plan names do not match', () => {
  const content = `2026-05-18T10:00:00Z | gtm/sdr/cold-outreach/acme | success
2026-05-18T11:00:00Z | gtm/sdr/cold/acme | success
`;
  const parsed = parseStateMd(content);
  const cold = findRecentRuns(parsed.lines, 'gtm', 'sdr', 'cold', 10);
  assert.equal(cold.length, 1);
  assert.equal(cold[0]!.scope, 'gtm/sdr/cold/acme');
});

test('findRecentRuns: honors limit', () => {
  const parsed = parseStateMd(SAMPLE);
  const r = findRecentRuns(parsed.lines, 'ops', 'heartbeat-noop', 'noop', 2);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.timestamp, '2026-05-18T10:30:00Z');
  assert.equal(r[1]!.timestamp, '2026-05-18T10:25:00Z');
});

test('findMostRecentRun: returns undefined when no match', () => {
  const parsed = parseStateMd(SAMPLE);
  const r = findMostRecentRun(parsed.lines, 'nonexistent', 'a', 'p');
  assert.equal(r, undefined);
});

test('findMostRecentRun: returns most recent match', () => {
  const parsed = parseStateMd(SAMPLE);
  const r = findMostRecentRun(parsed.lines, 'ops', 'heartbeat-noop', 'noop');
  assert.ok(r);
  assert.equal(r!.timestamp, '2026-05-18T10:30:00Z');
  assert.equal(r!.status, 'success');
});

test('readStateMd: missing file returns empty result', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'state-md-'));
  try {
    const r = readStateMd(join(tmp, 'nonexistent.md'));
    assert.deepEqual(r, { lines: [], malformedCount: 0 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readStateMd: reads and parses existing file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'state-md-'));
  try {
    const p = join(tmp, 'state.md');
    writeFileSync(p, SAMPLE, 'utf8');
    const r = readStateMd(p);
    assert.equal(r.lines.length, 4);
    assert.equal(r.malformedCount, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
