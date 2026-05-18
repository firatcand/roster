import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeScheduleStatus } from '../src/commands/schedule.ts';

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-status-'));
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

const yamlCodex = `version: 1
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
`;

function captureStdout(fn: () => void): string {
  const buf: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => buf.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return buf.join('\n');
}

test('executeScheduleStatus (text): never fired → metadata + (never fired)', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    const out = captureStdout(() => {
      executeScheduleStatus({
        cwd: root,
        name: 'heartbeat',
        functionName: undefined,
        json: false,
        silent: false,
        dryRun: false,
      });
    });
    assert.match(out, /Schedule:\s+heartbeat/);
    assert.match(out, /Function:\s+ops/);
    assert.match(out, /never fired/);
  } finally {
    cleanup();
  }
});

test('executeScheduleStatus (text): with state.md → shows last_run + last_status + history', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    writeState(
      root,
      'ops',
      `2026-05-18T10:20:00Z | ops/noop/noop/_demo | failed
2026-05-18T10:25:00Z | ops/noop/noop/_demo | success
2026-05-18T10:30:00Z | ops/noop/noop/_demo | success
`,
    );
    const out = captureStdout(() => {
      executeScheduleStatus({
        cwd: root,
        name: 'heartbeat',
        functionName: undefined,
        json: false,
        silent: false,
        dryRun: false,
      });
    });
    assert.match(out, /Last run:\s+2026-05-18T10:30:00Z/);
    // chalk colors may wrap status; just ensure substring present.
    assert.match(out, /success/);
    assert.match(out, /History \(last 3\)/);
  } finally {
    cleanup();
  }
});

test('executeScheduleStatus (json): emits structured fields', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    writeState(root, 'ops', `2026-05-18T10:30:00Z | ops/noop/noop/_demo | success\n`);
    const out = captureStdout(() => {
      executeScheduleStatus({
        cwd: root,
        name: 'heartbeat',
        functionName: undefined,
        json: true,
        silent: false,
        dryRun: false,
      });
    });
    const json = JSON.parse(out);
    assert.equal(json.name, 'heartbeat');
    assert.equal(json.tool, 'codex');
    assert.equal(json.last_run, '2026-05-18T10:30:00Z');
    assert.equal(json.last_status, 'success');
    assert.equal(typeof json.next_due_at, 'string');
    assert.ok(Array.isArray(json.history));
    assert.equal(json.history.length, 1);
  } finally {
    cleanup();
  }
});

test('executeScheduleStatus: malformed state lines counted, do not crash', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    writeState(
      root,
      'ops',
      `2026-05-18T10:30:00Z | ops/noop/noop/_demo | success
garbage line
2026-05-18T10:35:00Z | invalid-scope | success
`,
    );
    const out = captureStdout(() => {
      executeScheduleStatus({
        cwd: root,
        name: 'heartbeat',
        functionName: undefined,
        json: true,
        silent: false,
        dryRun: false,
      });
    });
    const json = JSON.parse(out);
    assert.equal(json.malformed_state_lines, 2);
  } finally {
    cleanup();
  }
});

test('executeScheduleStatus: forward-compat — unknown status value passes through', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    writeState(root, 'ops', `2026-05-18T10:30:00Z | ops/noop/noop/_demo | timeout\n`);
    const out = captureStdout(() => {
      executeScheduleStatus({
        cwd: root,
        name: 'heartbeat',
        functionName: undefined,
        json: true,
        silent: false,
        dryRun: false,
      });
    });
    const json = JSON.parse(out);
    assert.equal(json.last_status, 'timeout');
  } finally {
    cleanup();
  }
});

// ── --dry-run (ROS-45): JSON byte-identity, text adds dim no-op line ──────

test('executeScheduleStatus --dry-run --json: byte-identical to non-dry-run', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    writeState(root, 'ops', `2026-05-18T10:30:00Z | ops/noop/noop/_demo | success\n`);
    const opts = {
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      json: true,
      silent: false,
    } as const;
    const baseline = captureStdout(() => {
      executeScheduleStatus({ ...opts, dryRun: false });
    });
    const dryRun = captureStdout(() => {
      executeScheduleStatus({ ...opts, dryRun: true });
    });
    assert.equal(dryRun, baseline);
  } finally {
    cleanup();
  }
});

test('executeScheduleStatus --dry-run (text): appends the read-only no-op line', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    writeState(root, 'ops', `2026-05-18T10:30:00Z | ops/noop/noop/_demo | success\n`);
    const out = captureStdout(() => {
      executeScheduleStatus({
        cwd: root,
        name: 'heartbeat',
        functionName: undefined,
        json: false,
        silent: false,
        dryRun: true,
      });
    });
    assert.match(out, /--dry-run: read-only command; nothing would be written\./);
  } finally {
    cleanup();
  }
});
