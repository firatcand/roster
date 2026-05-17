import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSchedulesInCwd, findScheduleFiles } from '../src/lib/schedule-validate.ts';

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-schedule-validate-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeSchedules(root: string, fn: string, content: string): string {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'schedules.yaml');
  writeFileSync(path, content, 'utf8');
  return path;
}

const validYaml = `version: 1
schedules:
  - name: cold-outreach-daily
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
`;

const invalidEnumYaml = `version: 1
schedules:
  - name: bad-tool
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: gemini
    install_mode: via-cron
    status: installed
`;

const invalidCronYaml = `version: 1
schedules:
  - name: bad-cron
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 8"
    tool: codex
    install_mode: via-cron
    status: installed
`;

const duplicateNameYaml = `version: 1
schedules:
  - name: alpha
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
  - name: alpha
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
`;

test('findScheduleFiles: empty cwd → []', () => {
  const fix = makeFixture();
  try {
    assert.deepEqual(findScheduleFiles(fix.root), []);
  } finally {
    fix.cleanup();
  }
});

test('findScheduleFiles: roster/ exists but no schedules.yaml → []', () => {
  const fix = makeFixture();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    assert.deepEqual(findScheduleFiles(fix.root), []);
  } finally {
    fix.cleanup();
  }
});

test('findScheduleFiles: finds schedules.yaml across multiple functions', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    writeSchedules(fix.root, 'product', validYaml);
    writeSchedules(fix.root, 'design', validYaml);
    const files = findScheduleFiles(fix.root);
    assert.equal(files.length, 3);
    assert.ok(files.every((f) => f.endsWith('schedules.yaml')));
  } finally {
    fix.cleanup();
  }
});

test('findScheduleFiles: skips non-directory entries under roster/', () => {
  const fix = makeFixture();
  try {
    mkdirSync(join(fix.root, 'roster'), { recursive: true });
    writeFileSync(join(fix.root, 'roster', 'rogue.txt'), 'not a function dir');
    assert.deepEqual(findScheduleFiles(fix.root), []);
  } finally {
    fix.cleanup();
  }
});

test('validate: empty cwd → ok=true, files=[]', () => {
  const fix = makeFixture();
  try {
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, true);
    assert.equal(report.files.length, 0);
  } finally {
    fix.cleanup();
  }
});

test('validate: valid file → ok=true, status=pass, entryCount=1', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, true);
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]!.status, 'pass');
    assert.equal(report.files[0]!.entryCount, 1);
    assert.equal(report.files[0]!.errors.length, 0);
    assert.equal(report.files[0]!.relativePath, 'roster/gtm/schedules.yaml');
  } finally {
    fix.cleanup();
  }
});

test('validate: invalid enum → ok=false with field-level error', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', invalidEnumYaml);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.equal(report.files[0]!.status, 'fail');
    assert.ok(
      report.files[0]!.errors.some((e) => e.message.includes("must be one of 'claude' | 'codex'")),
      `expected tool-enum error, got ${JSON.stringify(report.files[0]!.errors)}`,
    );
  } finally {
    fix.cleanup();
  }
});

test('validate: invalid cron → ok=false with cron-specific message', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', invalidCronYaml);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.ok(
      report.files[0]!.errors.some((e) => e.message.toLowerCase().includes('cron')),
      `expected cron error, got ${JSON.stringify(report.files[0]!.errors)}`,
    );
  } finally {
    fix.cleanup();
  }
});

test('validate: malformed YAML → file-level parse error', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', 'version: 1\nschedules:\n  - name: foo\n    invalid: yaml: here\n');
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    // Either a parse error or schema error — either way it should fail
    assert.equal(report.files[0]!.status, 'fail');
    assert.ok(report.files[0]!.errors.length > 0);
  } finally {
    fix.cleanup();
  }
});

test('validate: empty file → file-level error', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', '');
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.equal(report.files[0]!.status, 'fail');
    assert.ok(report.files[0]!.errors.some((e) => e.message.includes('empty')));
  } finally {
    fix.cleanup();
  }
});

test('validate: duplicate names within file → ok=false', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', duplicateNameYaml);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.ok(
      report.files[0]!.errors.some((e) => e.message.includes('duplicate')),
      `expected duplicate-name error, got ${JSON.stringify(report.files[0]!.errors)}`,
    );
  } finally {
    fix.cleanup();
  }
});

test('validate: missing version field → file-level fail', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', `schedules:
  - name: foo
    agent: sdr
    plan: x
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
`);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.ok(report.files[0]!.errors.some((e) => e.path === 'version'));
  } finally {
    fix.cleanup();
  }
});

test('validate: two files — one valid, one invalid → ok=false, per-file statuses correct', () => {
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    writeSchedules(fix.root, 'product', invalidEnumYaml);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.equal(report.files.length, 2);
    const gtm = report.files.find((f) => f.relativePath.includes('gtm'));
    const product = report.files.find((f) => f.relativePath.includes('product'));
    assert.equal(gtm!.status, 'pass');
    assert.equal(product!.status, 'fail');
  } finally {
    fix.cleanup();
  }
});

test('validate: schedules.yaml is a directory → "expected file, found directory"', () => {
  const fix = makeFixture();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm', 'schedules.yaml'), { recursive: true });
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]!.status, 'fail');
    assert.ok(
      report.files[0]!.errors.some((e) => e.message.includes('expected file, found directory')),
      `expected directory error, got ${JSON.stringify(report.files[0]!.errors)}`,
    );
  } finally {
    fix.cleanup();
  }
});

test('contract: validator accepts the literal example from ROS-41 plan', () => {
  // This is the file-shape example from plans/tasks/ROS-41.plan.md.
  // If the plan ever diverges from what the validator accepts, this test fails.
  const planExample = `version: 1
schedules:
  - name: cold-outreach-daily
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
    timezone: "America/New_York"
    max_duration_minutes: 30
    hitl_routing: "roster/gtm/pending/"
    retry_policy: { max_attempts: 2, backoff_seconds: 300 }
`;
  const fix = makeFixture();
  try {
    writeSchedules(fix.root, 'gtm', planExample);
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, true, `plan example must validate cleanly: ${JSON.stringify(report)}`);
  } finally {
    fix.cleanup();
  }
});

if (process.platform !== 'win32') {
  test('validate: unreadable file → file-level error', () => {
    const fix = makeFixture();
    try {
      const path = writeSchedules(fix.root, 'gtm', validYaml);
      chmodSync(path, 0o000);
      const report = validateSchedulesInCwd(fix.root);
      // chmod 0 may or may not block reads depending on uid (root bypasses).
      // Either outcome is acceptable; if reachable as unreadable, error is reported.
      if (!report.ok) {
        assert.ok(report.files[0]!.errors.some((e) => e.message.includes('cannot read')));
      }
      chmodSync(path, 0o644);
    } finally {
      fix.cleanup();
    }
  });

  test('validate: symlinked schedules.yaml is followed', () => {
    const fix = makeFixture();
    try {
      const real = join(fix.root, 'real-schedules.yaml');
      writeFileSync(real, validYaml);
      mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
      symlinkSync(real, join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
      const report = validateSchedulesInCwd(fix.root);
      assert.equal(report.ok, true);
      assert.equal(report.files[0]!.status, 'pass');
    } finally {
      fix.cleanup();
    }
  });
}
