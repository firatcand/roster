// ROS-45 follow-up (codex review nit #2): JSON byte-identity for every
// read-only command that accepts --dry-run, not just status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeScheduleList,
  executeScheduleValidate,
} from '../src/commands/schedule.ts';
import { executeDoctor } from '../src/commands/doctor.ts';

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-dryrun-parity-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSchedules(root: string, fn: string, body: string): void {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), body, 'utf8');
}

function captureStdout(fn: () => unknown): string {
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

const yamlCodex = `version: 1
schedules:
  - name: heartbeat
    agent: noop
    plan: noop
    cron: "*/5 * * * *"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

test('executeScheduleList --json: --dry-run output byte-identical to non-dry-run', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    const opts = { cwd: root, json: true, silent: false } as const;
    const baseline = captureStdout(() => executeScheduleList({ ...opts, dryRun: false }));
    const dryRun = captureStdout(() => executeScheduleList({ ...opts, dryRun: true }));
    assert.equal(dryRun, baseline);
  } finally {
    cleanup();
  }
});

test('executeScheduleValidate --json: --dry-run output byte-identical to non-dry-run', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodex);
    const opts = { cwd: root, json: true, silent: false } as const;
    const baseline = captureStdout(() => executeScheduleValidate({ ...opts, dryRun: false }));
    const dryRun = captureStdout(() => executeScheduleValidate({ ...opts, dryRun: true }));
    assert.equal(dryRun, baseline);
  } finally {
    cleanup();
  }
});

test('executeDoctor --json: --dry-run output byte-identical to non-dry-run', () => {
  // Use an isolated empty workspace; rely on the real home for tool detection
  // (deterministic since both invocations see the same env).
  const { root, cleanup } = makeWorkspace();
  try {
    const opts = { cwd: root, json: true, silent: false, fix: false } as const;
    const baseline = captureStdout(() => executeDoctor({ ...opts, dryRun: false }));
    const dryRun = captureStdout(() => executeDoctor({ ...opts, dryRun: true }));
    assert.equal(dryRun, baseline);
  } finally {
    cleanup();
  }
});
