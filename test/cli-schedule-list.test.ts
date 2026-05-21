import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildListReport, renderListText, renderListJson } from '../src/lib/schedule-list.ts';

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-list-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSchedules(root: string, fn: string, body: string): void {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), body, 'utf8');
}

function writeState(root: string, fn: string, body: string): void {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.md'), body, 'utf8');
}

const validCodex = (name: string, agent: string, plan: string, cron: string) => `version: 1
schedules:
  - name: ${name}
    agent: ${agent}
    plan: ${plan}
    cron: "${cron}"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

const validClaude = (name: string, agent: string, plan: string, cron: string) => `version: 1
schedules:
  - name: ${name}
    agent: ${agent}
    plan: ${plan}
    cron: "${cron}"
    tool: claude
    install_mode: ui-handoff
    status: pending-ui-install
`;

test('buildListReport: empty workspace returns empty rows', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const r = buildListReport(root);
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.warnings, []);
  } finally {
    cleanup();
  }
});

test('buildListReport: aggregates across multiple functions', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', validCodex('heartbeat', 'noop', 'noop', '*/5 * * * *'));
    writeSchedules(root, 'gtm', validClaude('nightly', 'sdr', 'cold-outreach', '0 9 * * 1-5'));
    const r = buildListReport(root, new Date('2026-05-18T10:30:00Z'));
    assert.equal(r.rows.length, 2);
    // Sorted by function name (ops < gtm? actually g < o; gtm first)
    assert.equal(r.rows[0]!.functionName, 'gtm');
    assert.equal(r.rows[1]!.functionName, 'ops');
  } finally {
    cleanup();
  }
});

test('buildListReport: joins state.md to find lastRun per row', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', validCodex('heartbeat', 'noop', 'noop', '*/5 * * * *'));
    writeState(root, 'ops', `2026-05-18T10:25:00Z | ops/noop/noop/_demo | success
2026-05-18T10:30:00Z | ops/noop/noop/_demo | success
`);
    const r = buildListReport(root, new Date('2026-05-18T10:31:00Z'));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.lastRun?.timestamp, '2026-05-18T10:30:00Z');
    assert.equal(r.rows[0]!.lastRun?.status, 'success');
  } finally {
    cleanup();
  }
});

test('buildListReport: computes nextDueAt from cron', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', validCodex('heartbeat', 'noop', 'noop', '*/5 * * * *'));
    const r = buildListReport(root, new Date('2026-05-18T10:31:00Z'));
    assert.equal(r.rows.length, 1);
    assert.ok(r.rows[0]!.nextDueAt);
    assert.equal(r.rows[0]!.nextDueAt!.toISOString().replace(/\.\d{3}Z$/, 'Z'), '2026-05-18T10:35:00Z');
  } finally {
    cleanup();
  }
});

test('buildListReport: tolerates one malformed schedules.yaml — surfaces warning, continues others', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', validCodex('heartbeat', 'noop', 'noop', '*/5 * * * *'));
    writeSchedules(root, 'broken', 'this is: not: valid: yaml:\n  - {{}}\n  ::');
    const r = buildListReport(root);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.functionName, 'ops');
    assert.ok(r.warnings.some((w) => w.includes('roster/broken/schedules.yaml')));
  } finally {
    cleanup();
  }
});

test('buildListReport: malformed state.md lines counted in warnings', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', validCodex('heartbeat', 'noop', 'noop', '*/5 * * * *'));
    writeState(root, 'ops', `2026-05-18T10:30:00Z | ops/noop/noop/_demo | success
garbage line
`);
    const r = buildListReport(root);
    assert.equal(r.rows.length, 1);
    assert.ok(r.warnings.some((w) => w.includes('state.md') && w.includes('malformed')));
  } finally {
    cleanup();
  }
});

test('renderListText: empty rows → no-schedules message', () => {
  const text = renderListText({ cwd: '/tmp/x', rows: [], warnings: [] }).join('\n');
  assert.match(text, /no schedules registered/);
});

test('renderListJson: shape includes name, tool, last_run, last_status, next_due_at', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', validCodex('heartbeat', 'noop', 'noop', '*/5 * * * *'));
    writeState(root, 'ops', `2026-05-18T10:30:00Z | ops/noop/noop/_demo | success\n`);
    const r = buildListReport(root, new Date('2026-05-18T10:31:00Z'));
    const json = JSON.parse(renderListJson(r));
    assert.equal(json.schedules.length, 1);
    assert.equal(json.schedules[0].name, 'heartbeat');
    assert.equal(json.schedules[0].tool, 'codex');
    assert.equal(json.schedules[0].last_run, '2026-05-18T10:30:00Z');
    assert.equal(json.schedules[0].last_status, 'success');
    assert.equal(json.schedules[0].next_due_at, '2026-05-18T10:35:00Z');
  } finally {
    cleanup();
  }
});
