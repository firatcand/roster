import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };
type Homes = { root: string; claude: string; codex: string; gemini: string; cleanup: () => void };

function makeHomes(present: ReadonlyArray<'claude' | 'codex' | 'gemini'>): Homes {
  const root = mkdtempSync(join(tmpdir(), 'roster-doctor-cli-'));
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  const gemini = join(root, 'gemini');
  for (const key of present) mkdirSync(join(root, key), { recursive: true });
  // Seed a valid chatgpt-subscription auth.json for the codex preflight
  // (wired into doctor as part of ROS-38). Without this, doctor's safety
  // audit reports a billing-safety failure for every test that includes
  // 'codex' in `present`, masking the actual assertion under test.
  if (present.includes('codex')) {
    writeFileSync(
      join(codex, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }),
      'utf8',
    );
  }
  return { root, claude, codex, gemini, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCli(args: readonly string[], envOverrides: Record<string, string>): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function envFor(h: Homes): Record<string, string> {
  return {
    ROSTER_CLAUDE_HOME: h.claude,
    ROSTER_CODEX_HOME: h.codex,
    ROSTER_GEMINI_HOME: h.gemini,
  };
}

test('doctor after install --all exits 0 and shows no MISSING/STALE', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const install = runCli(['install', '--all', '--silent'], envFor(h));
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.doesNotMatch(doc.stdout, /MISSING/);
    assert.doesNotMatch(doc.stdout, /STALE/);
    assert.match(doc.stdout, /\bOK\b/, 'per-row OK label printed for clean items');
    assert.match(doc.stdout, /up to date/i);
  } finally {
    h.cleanup();
  }
});

test('doctor exits 1 and reports MISSING after a skill dir is deleted', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    rmSync(join(h.claude, 'skills', 'chief-of-staff'), { recursive: true, force: true });

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 1, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stdout, /MISSING/);
    assert.match(doc.stdout, /chief-of-staff/);
    assert.match(doc.stdout, /roster install/);
  } finally {
    h.cleanup();
  }
});

test('doctor exits 1 and reports STALE after a skill file is modified', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    writeFileSync(join(h.claude, 'skills', 'chief-of-staff', 'SKILL.md'), '# tampered\n');

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 1, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stdout, /STALE/);
    assert.match(doc.stdout, /chief-of-staff/);
  } finally {
    h.cleanup();
  }
});

test('doctor --json after clean install: valid JSON, ok=true, all items ok', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    const doc = runCli(['doctor', '--json'], envFor(h));
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}`);
    const payload = JSON.parse(doc.stdout) as {
      ok: boolean;
      tools: Array<{ items: Array<{ status: string }> }>;
    };
    assert.equal(payload.ok, true);
    assert.ok(payload.tools.length > 0);
    for (const t of payload.tools) {
      assert.ok(t.items.length > 0);
      for (const item of t.items) assert.equal(item.status, 'ok');
    }
  } finally {
    h.cleanup();
  }
});

test('doctor --json after deleting a skill: ok=false, item missing', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    rmSync(join(h.claude, 'skills', 'chief-of-staff'), { recursive: true, force: true });

    const doc = runCli(['doctor', '--json'], envFor(h));
    assert.equal(doc.status, 1);
    const payload = JSON.parse(doc.stdout) as {
      ok: boolean;
      tools: Array<{ items: Array<{ name: string; kind: string; status: string }> }>;
    };
    assert.equal(payload.ok, false);
    const deletedItem = payload.tools.flatMap((t) => t.items).find((i) => i.kind === 'skill' && i.name === 'chief-of-staff');
    assert.ok(deletedItem);
    assert.equal(deletedItem.status, 'missing');
  } finally {
    h.cleanup();
  }
});

test('doctor with no tools detected exits 3 and prints structured hint with install links', () => {
  const h = makeHomes([]);
  try {
    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 3, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stderr, /no AI tools/i);
    assert.match(doc.stderr, /Claude Code/);
    assert.match(doc.stderr, /https:\/\/claude\.ai\/code/);
    assert.match(doc.stderr, /Codex CLI/);
    assert.match(doc.stderr, /Gemini CLI/);
    // No stack trace without --debug.
    assert.doesNotMatch(doc.stderr, /\bat\s+.+:\d+:\d+\)/);
  } finally {
    h.cleanup();
  }
});

test('doctor --debug with no tools includes a stack trace on stderr', () => {
  const h = makeHomes([]);
  try {
    const doc = runCli(['doctor', '--debug'], envFor(h));
    assert.equal(doc.status, 3, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stderr, /\bat\s+/, 'stack frame present');
  } finally {
    h.cleanup();
  }
});

test('doctor --json with no tools detected: exits 3, valid JSON with empty tools', () => {
  const h = makeHomes([]);
  try {
    const doc = runCli(['doctor', '--json'], envFor(h));
    assert.equal(doc.status, 3, `stderr: ${doc.stderr}`);
    const payload = JSON.parse(doc.stdout) as { ok: boolean; tools: unknown[]; note?: string };
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.note, 'no tools detected');
  } finally {
    h.cleanup();
  }
});

test('doctor never prompts — symlinked skill + no inherited TTY exits cleanly', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));

    const skillTarget = join(h.claude, 'skills', 'chief-of-staff');
    const replica = join(h.root, 'chief-of-staff-replica');
    cpSync(skillTarget, replica, { recursive: true });
    rmSync(skillTarget, { recursive: true, force: true });
    symlinkSync(replica, skillTarget, 'dir');

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.doesNotMatch(doc.stdout, /MISSING/);
    assert.doesNotMatch(doc.stdout, /STALE/);
  } finally {
    h.cleanup();
  }
});

test('--help mentions --json', () => {
  const r = runCli(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--json/);
});

// ui-handoff install_mode keeps the cron-drift audit silent (only --via-cron
// codex entries are auditable against crontab). The pre-ROS-38 test fixture
// used via-cron and relied on no drift check; the new doctor flags drift when
// a registered via-cron entry has no matching crontab marker.
const validScheduleYaml = `version: 1
schedules:
  - name: cold-outreach-daily
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: ui-handoff
    status: pending-ui-install
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

const invalidScheduleYaml = `version: 1
schedules:
  - name: bad
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 8"
    tool: gemini
    install_mode: via-cron
    status: installed
`;

function writeSchedules(cwd: string, fn: string, content: string): void {
  mkdirSync(join(cwd, 'roster', fn), { recursive: true });
  writeFileSync(join(cwd, 'roster', fn, 'schedules.yaml'), content, 'utf8');
}

function runCliInCwd(args: readonly string[], env: Record<string, string>, cwd: string): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      cwd,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

test('doctor with valid schedules.yaml exits 0 and shows Scheduling OK', () => {
  const h = makeHomes(['claude']);
  try {
    const install = runCli(['install', '--all', '--silent'], envFor(h));
    assert.equal(install.status, 0);

    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-sched-ok-'));
    try {
      writeSchedules(ws, 'gtm', validScheduleYaml);
      const doc = runCliInCwd(['doctor'], envFor(h), ws);
      assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
      assert.match(doc.stdout, /Scheduling/);
      assert.match(doc.stdout, /schedules\.yaml.*OK/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('doctor with invalid schedules.yaml exits 1 and shows Scheduling FAIL', () => {
  const h = makeHomes(['claude']);
  try {
    const install = runCli(['install', '--all', '--silent'], envFor(h));
    assert.equal(install.status, 0);

    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-sched-fail-'));
    try {
      writeSchedules(ws, 'gtm', invalidScheduleYaml);
      const doc = runCliInCwd(['doctor'], envFor(h), ws);
      assert.equal(doc.status, 1, `stdout: ${doc.stdout}`);
      assert.match(doc.stdout, /Scheduling/);
      assert.match(doc.stdout, /FAIL/);
      assert.match(doc.stdout, /tool: must be one of/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('doctor --json includes scheduling payload', () => {
  const h = makeHomes(['claude']);
  try {
    const install = runCli(['install', '--all', '--silent'], envFor(h));
    assert.equal(install.status, 0);

    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-sched-json-'));
    try {
      writeSchedules(ws, 'gtm', validScheduleYaml);
      const doc = runCliInCwd(['doctor', '--json'], envFor(h), ws);
      assert.equal(doc.status, 0);
      const payload = JSON.parse(doc.stdout) as { ok: boolean; scheduling?: { ok: boolean; files: unknown[] } };
      assert.equal(payload.ok, true);
      assert.ok(payload.scheduling);
      assert.equal(payload.scheduling!.ok, true);
      assert.equal(payload.scheduling!.files.length, 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('doctor with no schedules.yaml files: no Scheduling section, exit 0', () => {
  const h = makeHomes(['claude']);
  try {
    const install = runCli(['install', '--all', '--silent'], envFor(h));
    assert.equal(install.status, 0);

    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-no-sched-'));
    try {
      const doc = runCliInCwd(['doctor'], envFor(h), ws);
      assert.equal(doc.status, 0);
      assert.doesNotMatch(doc.stdout, /Scheduling/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROS-33 — Codex Windows workaround surfaced under the Codex tool block.
// Driven by ROSTER_PLATFORM=win32 so the test runs on any host.
// ──────────────────────────────────────────────────────────────────────────────

test('doctor on win32: emits Codex workaround notice under the Codex tool block', () => {
  const h = makeHomes(['claude', 'codex']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));

    const env = { ...envFor(h), ROSTER_PLATFORM: 'win32' };
    const doc = runCli(['doctor'], env);
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stdout, /codex-windows-19399/);
    assert.match(doc.stdout, /runtime injection ACTIVE/);
    assert.match(doc.stdout, /github\.com\/openai\/codex\/issues\/19399/);
  } finally {
    h.cleanup();
  }
});

test('doctor on win32 --json: workarounds array contains codex-windows-19399', () => {
  const h = makeHomes(['claude', 'codex']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));

    const env = { ...envFor(h), ROSTER_PLATFORM: 'win32' };
    const doc = runCli(['doctor', '--json'], env);
    assert.equal(doc.status, 0);
    const payload = JSON.parse(doc.stdout) as {
      workarounds?: Array<{ id: string; toolKey: string; status: string; reference: string }>;
    };
    assert.ok(Array.isArray(payload.workarounds), 'workarounds present in JSON');
    const w = payload.workarounds!.find((x) => x.id === 'codex-windows-19399');
    assert.ok(w, 'codex-windows-19399 workaround in payload');
    assert.equal(w.toolKey, 'codex');
    assert.equal(w.status, 'active');
    assert.match(w.reference, /openai\/codex\/issues\/19399/);
  } finally {
    h.cleanup();
  }
});

test('doctor on non-win32: emits no workaround notice', () => {
  const h = makeHomes(['claude', 'codex']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));

    const env = { ...envFor(h), ROSTER_PLATFORM: 'darwin' };
    const doc = runCli(['doctor'], env);
    assert.equal(doc.status, 0);
    assert.doesNotMatch(doc.stdout, /codex-windows-19399/, 'no workaround on darwin');
  } finally {
    h.cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// ROS-38 — --fix tests
// ──────────────────────────────────────────────────────────────────────

test('doctor with .env mode 0644 → exit 1; doctor --fix → exit 0 + mode flips to 0600', () => {
  if (process.platform === 'win32') return;
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-fix-env-'));
    try {
      const envPath = join(ws, '.env');
      writeFileSync(envPath, 'API_KEY=secret\n');
      chmodSync(envPath, 0o644);

      const before = runCliInCwd(['doctor'], envFor(h), ws);
      assert.equal(before.status, 1, `expected fail before fix: ${before.stdout}`);
      assert.match(before.stdout, /\.env permissions/);

      const fix = runCliInCwd(['doctor', '--fix'], envFor(h), ws);
      assert.equal(fix.status, 0, `expected ok after fix: ${fix.stdout}`);
      const finalMode = statSync(envPath).mode & 0o777;
      assert.equal(finalMode.toString(8), '600', `.env should be 0600, got 0${finalMode.toString(8)}`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('doctor --fix NEVER unsets exported ANTHROPIC_API_KEY (billing-safety contract)', () => {
  const h = makeHomes(['claude', 'codex']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    const env = { ...envFor(h), ANTHROPIC_API_KEY: 'sk-ant-test-leaked-key-xxx' };
    const doc = runCli(['doctor', '--fix', '--json'], env);
    // Status MUST stay non-zero — the env var is a billing-safety leak.
    // If --fix ever silently unsets it (a future "helpful" extension), this
    // assertion fails loudly.
    assert.equal(doc.status, 1, 'doctor must keep exit=1 on billing-safety leak even with --fix');
    const payload = JSON.parse(doc.stdout) as {
      ok: boolean;
      safety: { codexPreflight: { status: string; failures?: Array<{ check: string }> } };
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.safety.codexPreflight.status, 'fail');
    const failures = payload.safety.codexPreflight.failures ?? [];
    assert.ok(failures.some((f) => f.check === 'env_anthropic_api_key'), 'preflight still reports the leak');
    // Cross-verify: the env var is still set on this process (we didn't accidentally clear it).
    // (Doctor runs in a child process, so the parent env is untouched regardless;
    // this test pins the assertion to the child-process safety contract.)
  } finally {
    h.cleanup();
  }
});

test('doctor --json payload includes safety, secrets, scheduling_drift sections', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-json-payload-'));
    try {
      const doc = runCliInCwd(['doctor', '--json'], envFor(h), ws);
      const payload = JSON.parse(doc.stdout) as {
        safety?: { bannedPatterns: { status: string } };
        secrets?: { envPermissions: { status: string } };
        scheduling_drift?: { cronDrift: { status: string } };
      };
      assert.ok(payload.safety, 'safety section present');
      assert.ok(payload.secrets, 'secrets section present');
      assert.ok(payload.scheduling_drift, 'scheduling_drift section present');
      assert.ok(typeof payload.safety!.bannedPatterns.status === 'string');
      assert.ok(typeof payload.secrets!.envPermissions.status === 'string');
      assert.ok(typeof payload.scheduling_drift!.cronDrift.status === 'string');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('doctor --json: payload.fix has stable shape (applied:false when --fix not used)', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    const ws = mkdtempSync(join(tmpdir(), 'roster-doctor-fix-shape-'));
    try {
      const noFix = runCliInCwd(['doctor', '--json'], envFor(h), ws);
      const a = JSON.parse(noFix.stdout) as { fix: { applied: boolean; fixed: string[]; failed: unknown[] } };
      // Codex 2nd-pass [MINOR/9]: fix MUST be an object, never null — otherwise
      // `.fix.fixed[]` jq-style scripts break across runs.
      assert.equal(a.fix.applied, false);
      assert.ok(Array.isArray(a.fix.fixed));
      assert.equal(a.fix.fixed.length, 0);
      assert.ok(Array.isArray(a.fix.failed));

      const withFix = runCliInCwd(['doctor', '--fix', '--json'], envFor(h), ws);
      const b = JSON.parse(withFix.stdout) as { fix: { applied: boolean } };
      assert.equal(b.fix.applied, true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('doctor --help mentions --fix', () => {
  const r = runCli(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--fix/);
});
