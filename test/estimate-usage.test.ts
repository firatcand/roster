import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateUsage,
  renderEstimateJson,
  makeFiresPerWeekFn,
  type EstimateReport,
} from '../src/lib/estimate-usage.ts';
import { buildListReport, renderListJson } from '../src/lib/schedule-list.ts';
import type { PlanCeilings } from '../src/lib/plan-ceilings.ts';
import { parseScheduleArgs } from '../src/lib/schedule-args.ts';

const T0 = new Date('2026-05-18T00:00:00Z'); // Monday

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'estimate-usage-'));
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

const SMALL_CEILINGS: PlanCeilings = [
  {
    id: 'claude-pro',
    tool: 'claude',
    label: 'Claude Pro',
    msgs_per_window: 45,
    window_hours: 5,
    msgs_per_week: 100,
    source_url: 'https://example.test/claude-pro',
    as_of: '2026-05-18',
  },
  {
    id: 'chatgpt-plus',
    tool: 'codex',
    label: 'ChatGPT Plus',
    msgs_per_window: 250,
    window_hours: 5,
    msgs_per_week: 2100,
    source_url: 'https://example.test/chatgpt-plus',
    as_of: '2026-05-18',
  },
];

function writeSchedules(workspace: string, functionName: string, schedulesYaml: string): void {
  write(workspace, `roster/${functionName}/schedules.yaml`, schedulesYaml);
}

// ── fires-per-week math ──────────────────────────────────────────────────

test('firesPerWeek: @hourly → 168', () => {
  const fn = makeFiresPerWeekFn();
  assert.equal(fn('@hourly', T0), 168);
});

test('firesPerWeek: @daily → 7', () => {
  const fn = makeFiresPerWeekFn();
  assert.equal(fn('@daily', T0), 7);
});

test('firesPerWeek: business-hours 0 9 * * 1-5 → 5', () => {
  const fn = makeFiresPerWeekFn();
  // T0 is Mon 00:00 → first fire Mon 09:00 → Mon–Fri = 5 fires in 7d window.
  assert.equal(fn('0 9 * * 1-5', T0), 5);
});

test('firesPerWeek: @yearly → 0 in arbitrary 7-day window', () => {
  const fn = makeFiresPerWeekFn();
  assert.equal(fn('@yearly', T0), 0);
});

test('firesPerWeek: cache returns same value for repeat cron', () => {
  const fn = makeFiresPerWeekFn();
  const a = fn('@hourly', T0);
  const b = fn('@hourly', T0);
  assert.equal(a, b);
  assert.equal(a, 168);
});

// ── estimate engine ───────────────────────────────────────────────────────

test('estimateUsage: empty workspace → empty rows', () => {
  const dir = tmp();
  try {
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    assert.equal(report.rows.length, 0);
    assert.equal(report.warnThreshold, 0.70);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: hourly claude schedule with 0 fanout → 168 msgs/week, no warning at 70%', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: hourly-sdr
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@hourly'
    tool: claude
    install_mode: ui-handoff
    status: installed
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    assert.equal(report.rows.length, 1);
    const row = report.rows[0]!;
    assert.equal(row.firesPerWeek, 168);
    assert.equal(row.msgsPerFire, 1);
    assert.equal(row.msgsPerWeek, 168);
    // Claude Pro weekly cap is 100 in SMALL_CEILINGS → 168/100 = 168% → warn.
    const claudeLoad = row.planLoads.find((p) => p.planId === 'claude-pro');
    assert.ok(claudeLoad);
    assert.equal(claudeLoad!.warn, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: schedule with fanout=2 → msgs/fire = 3', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: daily-sdr
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: installed
`,
    );
    write(
      dir,
      'gtm/sdr/agent.md',
      '# SDR\n\n## Subagents\n\n- `a.md` — one\n- `b.md` — two\n',
    );
    write(dir, 'gtm/sdr/a.md', '# A\n');
    write(dir, 'gtm/sdr/b.md', '# B\n');
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    const row = report.rows[0]!;
    assert.equal(row.fanout, 2);
    assert.equal(row.msgsPerFire, 3);
    assert.equal(row.firesPerWeek, 7);
    assert.equal(row.msgsPerWeek, 21);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: retry policy max_attempts=3 → msgsPerFireWithRetry = msgsPerFire * 3', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: with-retry
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: installed
    retry_policy:
      max_attempts: 3
      backoff_seconds: 60
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    const row = report.rows[0]!;
    assert.equal(row.retryMaxAttempts, 3);
    assert.equal(row.msgsPerFire, 1);
    assert.equal(row.msgsPerFireWithRetry, 3);
    assert.equal(row.msgsPerWeek, 21); // 1 * 3 retry * 7 daily fires
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: warnThreshold override lowers gate', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: light-load
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: installed
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    // 7 msgs/week ÷ 100 weekly cap = 7%. Threshold 5% → warn. Threshold 70% → no warn.
    const lo = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS, warnThreshold: 0.05 });
    const hi = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS, warnThreshold: 0.70 });
    const loLoad = lo.rows[0]!.planLoads.find((p) => p.planId === 'claude-pro');
    const hiLoad = hi.rows[0]!.planLoads.find((p) => p.planId === 'claude-pro');
    assert.equal(loLoad!.warn, true);
    assert.equal(hiLoad!.warn, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: planFilter narrows row planLoads AND report ceilings', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: filter-test
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: installed
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    const report = estimateUsage({
      cwd: dir,
      now: T0,
      ceilings: SMALL_CEILINGS,
      planFilter: 'claude-pro',
    });
    assert.equal(report.rows[0]!.planLoads.length, 1);
    assert.equal(report.rows[0]!.planLoads[0]!.planId, 'claude-pro');
    // Report-level ceilings array also narrowed so text + JSON renderers stay
    // consistent with the row planLoads.
    assert.equal(report.ceilings.length, 1);
    assert.equal(report.ceilings[0]!.id, 'claude-pro');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: planFilter rejecting unknown id throws', () => {
  const dir = tmp();
  try {
    assert.throws(
      () =>
        estimateUsage({
          cwd: dir,
          now: T0,
          ceilings: SMALL_CEILINGS,
          planFilter: 'nonexistent',
        }),
      /not found in plan-ceilings\.yaml/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateUsage: only compares against ceilings matching the schedule tool', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: claude-only
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: installed
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    const row = report.rows[0]!;
    // Only claude-pro should be compared (tool=claude); chatgpt-plus excluded.
    assert.equal(row.planLoads.length, 1);
    assert.equal(row.planLoads[0]!.planId, 'claude-pro');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── JSON envelope ─────────────────────────────────────────────────────────

test('renderEstimateJson: envelope shape includes cwd, schedules, ceilings, warnings', () => {
  const dir = tmp();
  try {
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    const json = JSON.parse(renderEstimateJson(report)) as Record<string, unknown>;
    assert.ok('cwd' in json);
    assert.ok('generated_at' in json);
    assert.ok('warn_threshold' in json);
    assert.ok(Array.isArray(json.schedules));
    assert.ok(Array.isArray(json.ceilings));
    assert.ok(Array.isArray(json.warnings));
    assert.equal(json.warn_threshold, 0.70);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderEstimateJson: per-row keys are a strict superset of renderListJson row keys', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'ops',
      `version: 1
schedules:
  - name: heartbeat
    agent: noop
    plan: noop
    project: _demo
    cron: "*/5 * * * *"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`,
    );
    write(dir, 'ops/noop/agent.md', '# noop\n');
    write(dir, 'roster/ops/state.md', '2026-05-18T10:30:00Z | ops/noop/noop/_demo | success\n');
    const now = new Date('2026-05-18T10:31:00Z');
    const list = JSON.parse(renderListJson(buildListReport(dir, now))) as {
      schedules: Array<Record<string, unknown>>;
    };
    const est = JSON.parse(
      renderEstimateJson(estimateUsage({ cwd: dir, now, ceilings: SMALL_CEILINGS })),
    ) as { schedules: Array<Record<string, unknown>> };

    assert.equal(list.schedules.length, 1);
    assert.equal(est.schedules.length, 1);

    const listKeys = Object.keys(list.schedules[0]!);
    const estKeys = new Set(Object.keys(est.schedules[0]!));
    for (const k of listKeys) {
      assert.ok(estKeys.has(k), `estimate row missing key '${k}' present in list row`);
    }

    // Values for the shared keys must match between the two envelopes.
    const e = est.schedules[0]!;
    const l = list.schedules[0]!;
    assert.equal(e.install_mode, l.install_mode);
    assert.equal(e.status, l.status);
    assert.equal(e.last_run, l.last_run);
    assert.equal(e.last_status, l.last_status);
    assert.equal(e.next_due_at, l.next_due_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderEstimateJson: nullable fields render as null (not omitted) with no run history', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: never-fired
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: pending-ui-install
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    const json = JSON.parse(renderEstimateJson(report)) as {
      schedules: Array<Record<string, unknown>>;
    };
    const row = json.schedules[0]!;
    assert.ok('last_run' in row, 'last_run key must be present');
    assert.ok('last_status' in row, 'last_status key must be present');
    assert.equal(row.last_run, null);
    assert.equal(row.last_status, null);
    assert.equal(row.install_mode, 'ui-handoff');
    assert.equal(row.status, 'pending-ui-install');
    assert.equal(typeof row.next_due_at, 'string'); // @daily always has a next fire
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderEstimateJson: per-schedule entry includes msgs_per_week + plan_loads', () => {
  const dir = tmp();
  try {
    writeSchedules(
      dir,
      'gtm',
      `version: 1
schedules:
  - name: shape-test
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: '@daily'
    tool: claude
    install_mode: ui-handoff
    status: installed
`,
    );
    write(dir, 'gtm/sdr/agent.md', '# SDR\n');
    const report = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    const json = JSON.parse(renderEstimateJson(report)) as { schedules: Array<Record<string, unknown>> };
    const entry = json.schedules[0]!;
    assert.equal(entry.name, 'shape-test');
    assert.equal(entry.msgs_per_week, 7);
    assert.ok(Array.isArray(entry.plan_loads));
    const pl = (entry.plan_loads as Array<Record<string, unknown>>)[0]!;
    assert.equal(pl.plan_id, 'claude-pro');
    assert.equal(typeof pl.weekly_load_fraction, 'number');
    assert.equal(typeof pl.warn, 'boolean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── argv parser ───────────────────────────────────────────────────────────

test('parseScheduleArgs: estimate-usage with no flags → defaults', () => {
  const r = parseScheduleArgs(['estimate-usage']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'estimate-usage') return;
  assert.equal(r.json, false);
  assert.equal(r.silent, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.plan, undefined);
  assert.equal(r.warnThreshold, 0.70);
});

test('parseScheduleArgs: estimate-usage --json', () => {
  const r = parseScheduleArgs(['estimate-usage', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'estimate-usage') return;
  assert.equal(r.json, true);
});

test('parseScheduleArgs: estimate-usage --plan claude-pro', () => {
  const r = parseScheduleArgs(['estimate-usage', '--plan', 'claude-pro']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'estimate-usage') return;
  assert.equal(r.plan, 'claude-pro');
});

test('parseScheduleArgs: estimate-usage --warn-threshold accepts integer percent', () => {
  const r = parseScheduleArgs(['estimate-usage', '--warn-threshold', '85']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'estimate-usage') return;
  assert.equal(r.warnThreshold, 0.85);
});

test('parseScheduleArgs: estimate-usage --warn-threshold accepts fraction', () => {
  const r = parseScheduleArgs(['estimate-usage', '--warn-threshold', '0.5']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'estimate-usage') return;
  assert.equal(r.warnThreshold, 0.5);
});

test('parseScheduleArgs: estimate-usage --warn-threshold rejects out-of-range', () => {
  const r = parseScheduleArgs(['estimate-usage', '--warn-threshold', '150']);
  assert.equal(r.kind, 'err');
});

test('parseScheduleArgs: estimate-usage rejects unknown flag', () => {
  const r = parseScheduleArgs(['estimate-usage', '--unknown']);
  assert.equal(r.kind, 'err');
});

test('parseScheduleArgs: estimate-usage rejects positional', () => {
  const r = parseScheduleArgs(['estimate-usage', 'extra']);
  assert.equal(r.kind, 'err');
});

test('parseScheduleArgs: estimate-usage is in subcommand list', () => {
  // Ensure not adding it to SCHEDULE_SUBCOMMANDS would have surfaced via parser.
  const r = parseScheduleArgs(['estimate-usage', '--json']);
  assert.equal(r.kind, 'ok');
});

// Sanity: ensure EstimateReport shape stays stable for downstream consumers.
test('EstimateReport: shape has rows, ceilings, warnings, generatedAt, warnThreshold', () => {
  const dir = tmp();
  try {
    const r: EstimateReport = estimateUsage({ cwd: dir, now: T0, ceilings: SMALL_CEILINGS });
    assert.equal(typeof r.cwd, 'string');
    assert.equal(typeof r.generatedAt, 'string');
    assert.equal(typeof r.warnThreshold, 'number');
    assert.ok(Array.isArray(r.rows));
    assert.ok(Array.isArray(r.ceilings));
    assert.ok(Array.isArray(r.warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
