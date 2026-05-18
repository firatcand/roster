import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRemove } from '../src/lib/schedule-remove.ts';
import { resolveScheduleByName } from '../src/lib/schedule-resolve.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { CrontabIO } from '../src/lib/codex-cron.ts';

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-remove-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSchedules(root: string, fn: string, body: string): string {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'schedules.yaml');
  writeFileSync(p, body, 'utf8');
  return p;
}

function fakeIO(initial: string): CrontabIO & { current: string; written: string[] } {
  const obj = {
    current: initial,
    written: [] as string[],
    read() {
      return { ok: true as const, content: this.current };
    },
    write(content: string) {
      this.written.push(content);
      this.current = content;
    },
  };
  return obj;
}

const yamlClaude = `version: 1
schedules:
  - name: nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: claude
    install_mode: ui-handoff
    status: pending-ui-install
`;

const yamlCodexCron = `version: 1
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

const yamlCodexUi = `version: 1
schedules:
  - name: weekly-report
    agent: gtm
    plan: report
    cron: "0 9 * * 1"
    tool: codex
    install_mode: ui-handoff
    status: pending-ui-install
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

test('executeRemove: ui-handoff (claude) → YAML entry stripped, no crontab touched', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const yamlPath = writeSchedules(root, 'gtm', yamlClaude);
    const io = fakeIO('# unrelated user line\n');
    const r = await executeRemove({
      cwd: root,
      name: 'nightly',
      functionName: undefined,
      dryRun: false,
      yes: true,
      crontabIO: io,
    });
    assert.equal(r.tool, 'claude');
    assert.equal(r.installMode, 'ui-handoff');
    assert.equal(r.cronStripped, false);
    assert.equal(r.cronMarkerMissing, false);
    assert.equal(io.written.length, 0);
    const after = readFileSync(yamlPath, 'utf8');
    assert.ok(!after.includes('nightly'));
  } finally {
    cleanup();
  }
});

test('executeRemove: codex via-cron → YAML + crontab block both stripped', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const yamlPath = writeSchedules(root, 'ops', yamlCodexCron);
    const cron = [
      '# user comment',
      '0 0 * * * user-job',
      '',
      '# roster:schedule:heartbeat:begin (do not edit; managed by `roster schedule install`)',
      '*/5 * * * * /bin/echo hi',
      '# roster:schedule:heartbeat:end',
      '',
    ].join('\n');
    const io = fakeIO(cron);
    const r = await executeRemove({
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      dryRun: false,
      yes: true,
      crontabIO: io,
    });
    assert.equal(r.cronStripped, true);
    assert.ok(!io.current.includes('roster:schedule:heartbeat'));
    assert.ok(io.current.includes('user-job'));
    const after = readFileSync(yamlPath, 'utf8');
    assert.ok(!after.includes('heartbeat'));
  } finally {
    cleanup();
  }
});

test('executeRemove: via-cron with missing crontab marker → YAML stripped + warning bit set', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodexCron);
    const io = fakeIO('# only user lines\n0 0 * * * user-job\n');
    const r = await executeRemove({
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      dryRun: false,
      yes: true,
      crontabIO: io,
    });
    assert.equal(r.cronStripped, false);
    assert.equal(r.cronMarkerMissing, true);
    assert.equal(io.written.length, 0);
  } finally {
    cleanup();
  }
});

test('executeRemove: codex ui-handoff → YAML stripped, no crontab read', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'gtm', yamlCodexUi);
    let cronRead = 0;
    const io: CrontabIO = {
      read() {
        cronRead++;
        return { ok: true, content: '' };
      },
      write() { /* noop */ },
    };
    const r = await executeRemove({
      cwd: root,
      name: 'weekly-report',
      functionName: undefined,
      dryRun: false,
      yes: true,
      crontabIO: io,
    });
    assert.equal(r.installMode, 'ui-handoff');
    assert.equal(cronRead, 0);
  } finally {
    cleanup();
  }
});

test('executeRemove: --dry-run never touches YAML or crontab', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const yamlPath = writeSchedules(root, 'ops', yamlCodexCron);
    const before = readFileSync(yamlPath, 'utf8');
    const io = fakeIO('# unrelated\n');
    const r = await executeRemove({
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      dryRun: true,
      yes: true,
      crontabIO: io,
    });
    assert.equal(r.dryRun, true);
    assert.equal(io.written.length, 0);
    assert.equal(readFileSync(yamlPath, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('executeRemove: cancel via confirm callback → throws cancelled, no writes', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const yamlPath = writeSchedules(root, 'gtm', yamlClaude);
    const before = readFileSync(yamlPath, 'utf8');
    await assert.rejects(
      executeRemove({
        cwd: root,
        name: 'nightly',
        functionName: undefined,
        dryRun: false,
        yes: false,
        crontabIO: fakeIO(''),
        confirm: async () => false,
      }),
      RosterError,
    );
    assert.equal(readFileSync(yamlPath, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('resolveScheduleByName: zero matches → scheduleNotFoundError lists known names', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'gtm', yamlClaude);
    assert.throws(
      () => resolveScheduleByName({ cwd: root, name: 'missing' }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /nightly/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('resolveScheduleByName: --function disambiguates cross-function name collision', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    // Same name in two functions.
    writeSchedules(root, 'a', yamlClaude);
    writeSchedules(root, 'b', yamlClaude);
    // No --function → ambiguous.
    assert.throws(
      () => resolveScheduleByName({ cwd: root, name: 'nightly' }),
      RosterError,
    );
    // With --function → resolves.
    const r = resolveScheduleByName({ cwd: root, name: 'nightly', functionName: 'b' });
    assert.equal(r.functionName, 'b');
  } finally {
    cleanup();
  }
});

test('executeRemove: empty schedules.yaml is removed-safe (no-op)', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'gtm', yamlClaude);
    await executeRemove({
      cwd: root,
      name: 'nightly',
      functionName: undefined,
      dryRun: false,
      yes: true,
      crontabIO: fakeIO(''),
    });
    // Now schedules.yaml exists but with no `nightly` entry — re-removing should error.
    await assert.rejects(
      executeRemove({
        cwd: root,
        name: 'nightly',
        functionName: undefined,
        dryRun: false,
        yes: true,
        crontabIO: fakeIO(''),
      }),
      RosterError,
    );
  } finally {
    cleanup();
  }
});

test('executeRemove: kept-for-audit hints populated correctly per tool/mode', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeSchedules(root, 'ops', yamlCodexCron);
    const r = await executeRemove({
      cwd: root,
      name: 'heartbeat',
      functionName: undefined,
      dryRun: true,
      yes: true,
      crontabIO: fakeIO(''),
    });
    assert.ok(r.logPathHint?.endsWith('logs/cron/heartbeat.log'));
    assert.equal(r.fieldsDocPathHint, null);
  } finally {
    cleanup();
  }
});
