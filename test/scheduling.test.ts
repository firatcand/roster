// ROS-40 — Phase 2.5 scheduling acceptance gate.
//
// Vertical-slice tests covering the 5 named behaviors in the Linear ticket:
//   1. Schedule install spec generation
//   2. Symlink/dual-write logic (schedule-resolve.ts — was untested)
//   3. Drift detection in doctor (validateSchedulesInCwd — actual production behavior)
//   4. Codex auth preflight (env-var blocklist)
//   5. env-var blocklist enforcement (cron line wrapper)
//
// Uses production helpers, not mocks beyond the existing CrontabIO injection
// point. Complements the per-module test files; does not duplicate them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

import { installClaudeSchedule, type ClaudeInstallOpts } from '../src/lib/schedule-install.ts';
import { installCodexSchedule, type CodexInstallOpts } from '../src/lib/codex-install.ts';
import { resolveScheduleByName } from '../src/lib/schedule-resolve.ts';
import { runCodexPreflight } from '../src/lib/codex-preflight.ts';
import { renderCronLine } from '../src/lib/codex-cron.ts';
import { validateSchedulesInCwd } from '../src/lib/schedule-validate.ts';
import { readExistingSchedulesDoc, upsertEntryInDoc, atomicWriteFile } from '../src/lib/schedule-yaml.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { CrontabIO } from '../src/lib/codex-cron.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeWorkspace(): { root: string; cwd: string; home: string; codex: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-scheduling-'));
  const cwd = join(root, 'workspace');
  const home = join(root, 'home');
  const codex = join(home, '.codex');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    join(codex, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }),
    'utf8',
  );
  return { root, cwd, home, codex, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function inMemoryCrontabIO(): CrontabIO & { current: string } {
  return {
    current: '',
    read() {
      return { ok: true as const, content: this.current };
    },
    write(content: string) {
      this.current = content;
    },
  };
}

function claudeBaseOpts(cwd: string): ClaudeInstallOpts {
  return {
    cwd,
    functionName: 'gtm',
    agent: 'sdr',
    plan: 'cold-outreach',
    cron: '0 9 * * 1-5',
    name: undefined,
    dryRun: false,
  };
}

function codexBaseOpts(cwd: string, home: string): CodexInstallOpts {
  return {
    cwd,
    functionName: 'gtm',
    agent: 'sdr',
    plan: 'cold-outreach',
    cron: '0 9 * * 1-5',
    name: undefined,
    installMode: 'ui-handoff',
    dryRun: false,
    homeDir: home,
    env: { PATH: '/usr/bin' },
  };
}

// ── 1. Install spec generation ─────────────────────────────────────────────

test('scheduling.gate: Claude install writes fields.md at .roster/schedule-specs/<name>.claude.fields.md', () => {
  const fx = makeWorkspace();
  try {
    const result = installClaudeSchedule(claudeBaseOpts(fx.cwd));
    assert.equal(result.action, 'created');
    assert.equal(
      result.fieldsDocPath,
      join(fx.cwd, '.roster', 'schedule-specs', 'sdr-cold-outreach.claude.fields.md'),
    );
    assert.ok(existsSync(result.fieldsDocPath));
    const doc = readFileSync(result.fieldsDocPath, 'utf8');
    assert.match(doc, /Claude Desktop Scheduled Task — sdr-cold-outreach/);
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: Codex ui-handoff install writes fields.md at .roster/schedule-specs/<name>.codex.fields.md', () => {
  const fx = makeWorkspace();
  try {
    const result = installCodexSchedule(codexBaseOpts(fx.cwd, fx.home));
    assert.equal(result.action, 'created');
    assert.equal(
      result.fieldsDocPath,
      join(fx.cwd, '.roster', 'schedule-specs', 'sdr-cold-outreach.codex.fields.md'),
    );
    assert.ok(existsSync(result.fieldsDocPath!));
    assert.match(readFileSync(result.fieldsDocPath!, 'utf8'), /Codex App Automation/);
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: Codex via-cron install produces a cron line that env -i wraps the codex invocation', () => {
  const fx = makeWorkspace();
  try {
    const io = inMemoryCrontabIO();
    const result = installCodexSchedule({
      ...codexBaseOpts(fx.cwd, fx.home),
      installMode: 'via-cron',
      crontabIO: io,
      codexBinaryPathOverride: '/opt/codex/bin/codex',
    });
    assert.equal(result.action, 'created');
    assert.equal(result.installMode, 'via-cron');
    assert.ok(result.cronLine !== null);
    assert.match(result.cronLine!, /\/usr\/bin\/env -i/);
    // Crontab was written via injected IO (no real crontab call).
    assert.ok(io.current.includes(result.cronLine!));
  } finally {
    fx.cleanup();
  }
});

// ── 2. Symlink/dual-write logic (schedule-resolve.ts) ─────────────────────
//
// resolveScheduleByName scans roster/<function>/schedules.yaml across all
// function dirs. This was the zero-tests gap before ROS-40.

function seedSchedulesYaml(cwd: string, functionName: string, entries: unknown[]): void {
  const dir = join(cwd, 'roster', functionName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'schedules.yaml'),
    YAML.stringify({ version: 1, schedules: entries }),
    'utf8',
  );
}

const sdrEntryBase = {
  name: 'sdr-cold-outreach',
  agent: 'sdr',
  plan: 'cold-outreach',
  cron: '0 9 * * 1-5',
  tool: 'claude' as const,
  install_mode: 'ui-handoff' as const,
  status: 'pending-ui-install' as const,
};

test('scheduling.gate: resolveScheduleByName returns entry from its function dir', () => {
  const fx = makeWorkspace();
  try {
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    const resolved = resolveScheduleByName({ cwd: fx.cwd, name: 'sdr-cold-outreach' });
    assert.equal(resolved.functionName, 'gtm');
    assert.equal(resolved.entry.name, 'sdr-cold-outreach');
    assert.equal(resolved.schedulesYamlPath, join(fx.cwd, 'roster', 'gtm', 'schedules.yaml'));
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: resolveScheduleByName throws ambiguous when same name exists in two function dirs', () => {
  const fx = makeWorkspace();
  try {
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    seedSchedulesYaml(fx.cwd, 'product-ops', [sdrEntryBase]);
    assert.throws(
      () => resolveScheduleByName({ cwd: fx.cwd, name: 'sdr-cold-outreach' }),
      (err: unknown) => err instanceof RosterError && /ambiguous|multiple|found in/i.test(err.message),
    );
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: resolveScheduleByName with --function suggests the right function when name is in a different dir', () => {
  const fx = makeWorkspace();
  try {
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    mkdirSync(join(fx.cwd, 'roster', 'product-ops'), { recursive: true });
    assert.throws(
      () => resolveScheduleByName({ cwd: fx.cwd, name: 'sdr-cold-outreach', functionName: 'product-ops' }),
      (err: unknown) => err instanceof RosterError && /gtm/i.test(err.message),
    );
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: resolveScheduleByName throws not-found with empty workspace', () => {
  const fx = makeWorkspace();
  try {
    assert.throws(
      () => resolveScheduleByName({ cwd: fx.cwd, name: 'missing' }),
      (err: unknown) => err instanceof RosterError && /not found|no schedule/i.test(err.message),
    );
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: resolveScheduleByName ignores malformed schedules.yaml in one fn dir, finds entry in another', () => {
  const fx = makeWorkspace();
  try {
    const badDir = join(fx.cwd, 'roster', 'broken');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'schedules.yaml'), '{ this is not: valid: yaml:::\n', 'utf8');
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    const resolved = resolveScheduleByName({ cwd: fx.cwd, name: 'sdr-cold-outreach' });
    assert.equal(resolved.functionName, 'gtm');
  } finally {
    fx.cleanup();
  }
});

// ── 3. Drift detection in doctor (validateSchedulesInCwd) ─────────────────
//
// Note: doctor does not cross-reference live crontab vs schedules.yaml. The
// actual "drift" surface doctor checks is YAML well-formedness + schema. The
// scheduling section in doctor's output (renderSchedulingSection in
// src/commands/doctor.ts:60) is driven entirely by validateSchedulesInCwd.

test('scheduling.gate: validateSchedulesInCwd passes on a valid schedules.yaml', () => {
  const fx = makeWorkspace();
  try {
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    const report = validateSchedulesInCwd(fx.cwd);
    assert.equal(report.ok, true);
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]!.status, 'pass');
    assert.equal(report.files[0]!.entryCount, 1);
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: validateSchedulesInCwd flags malformed yaml', () => {
  const fx = makeWorkspace();
  try {
    const dir = join(fx.cwd, 'roster', 'gtm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'schedules.yaml'), '{ not: valid: yaml::\n', 'utf8');
    const report = validateSchedulesInCwd(fx.cwd);
    assert.equal(report.ok, false);
    assert.equal(report.files[0]!.status, 'fail');
    assert.ok(report.files[0]!.errors.length > 0);
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: validateSchedulesInCwd flags bad cron expression in otherwise-valid yaml', () => {
  const fx = makeWorkspace();
  try {
    seedSchedulesYaml(fx.cwd, 'gtm', [{ ...sdrEntryBase, cron: 'not a cron' }]);
    const report = validateSchedulesInCwd(fx.cwd);
    assert.equal(report.ok, false);
    assert.equal(report.files[0]!.status, 'fail');
    assert.ok(report.files[0]!.errors.some((e) => e.path.includes('cron')));
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: validateSchedulesInCwd is ok with zero schedule files', () => {
  const fx = makeWorkspace();
  try {
    const report = validateSchedulesInCwd(fx.cwd);
    assert.equal(report.ok, true);
    assert.equal(report.files.length, 0);
  } finally {
    fx.cleanup();
  }
});

// ── 4. Codex auth preflight — API-key env-var blocklist ───────────────────
//
// The acceptance bullet says: "pre-flight refuses install when API-key env
// vars are exported." Re-asserted at the gate level (per env var), separate
// from codex-preflight.test.ts's exhaustive coverage of all 8 checks.

test('scheduling.gate: preflight refuses install when OPENAI_API_KEY is exported', () => {
  const fx = makeWorkspace();
  try {
    const result = runCodexPreflight({
      homeDir: fx.home,
      env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test-not-real' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.failures.some((f) => f.check === 'env_openai_api_key'));
    }
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: preflight refuses install when CODEX_API_KEY is exported', () => {
  const fx = makeWorkspace();
  try {
    const result = runCodexPreflight({
      homeDir: fx.home,
      env: { PATH: '/usr/bin', CODEX_API_KEY: 'sk-test-not-real' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.failures.some((f) => f.check === 'env_codex_api_key'));
    }
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: preflight refuses install when ANTHROPIC_API_KEY is exported', () => {
  const fx = makeWorkspace();
  try {
    const result = runCodexPreflight({
      homeDir: fx.home,
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-test-not-real' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.failures.some((f) => f.check === 'env_anthropic_api_key'));
    }
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: preflight passes with clean ChatGPT subscription environment', () => {
  const fx = makeWorkspace();
  try {
    const result = runCodexPreflight({
      homeDir: fx.home,
      env: { PATH: '/usr/bin' },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.attestation.auth_mode, 'chatgpt');
      assert.equal(result.attestation.env_policy, 'cleared');
    }
  } finally {
    fx.cleanup();
  }
});

// ── 5. env-var blocklist in cron line + subscription policy ───────────────

test('scheduling.gate: renderCronLine wraps invocation with `/usr/bin/env -i`', () => {
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: '/workspace',
    codexBinaryPath: '/opt/codex/bin/codex',
    prompt: 'Use the roster-orchestrator skill to run plan p for agent a',
    logPath: '/workspace/logs/cron/a-p.log',
  });
  assert.match(line, /\/usr\/bin\/env -i/);
});

test('scheduling.gate: renderCronLine forwards EXACTLY {HOME, PATH, CODEX_HOME} via env -i — no others', () => {
  // Positive whitelist (not absence-of-known-bad). Codex review (ROS-40):
  // a future `FOO=...` or accidental `ROSTER_CODEX_PATH=...` would silently
  // re-introduce a per-token billing leak — the test must fail if the set
  // of forwarded vars is anything other than exactly these three.
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: '/workspace',
    codexBinaryPath: '/opt/codex/bin/codex',
    prompt: 'Use the roster-orchestrator skill to run plan p for agent a',
    logPath: '/workspace/logs/cron/a-p.log',
  });
  // Slice the env -i forward list: from after "/usr/bin/env -i " up to the
  // codex binary path (the next token that is the shell-quoted absolute path).
  const after = line.slice(line.indexOf('/usr/bin/env -i ') + '/usr/bin/env -i '.length);
  const upTo = after.indexOf("'/opt/codex/bin/codex'");
  assert.ok(upTo > 0, 'env -i forward list must precede the quoted codex binary path');
  const forwardSegment = after.slice(0, upTo).trim();
  // The segment is space-separated KEY=value tokens (HOME/CODEX_HOME use
  // "$VAR" expansion, PATH uses single-quoted literal). Match KEY at the
  // start of each token to enumerate the forwarded variable names.
  const forwardedKeys = forwardSegment
    .split(/\s+(?=[A-Z_]+=)/)
    .map((tok) => tok.match(/^([A-Z_]+)=/)?.[1])
    .filter((k): k is string => k !== undefined)
    .sort();
  assert.deepEqual(forwardedKeys, ['CODEX_HOME', 'HOME', 'PATH']);
});

test('scheduling.gate: renderCronLine includes `shell_environment_policy.inherit=core`', () => {
  const line = renderCronLine({
    cron: '0 9 * * *',
    workspacePath: '/workspace',
    codexBinaryPath: '/opt/codex/bin/codex',
    prompt: 'Use the roster-orchestrator skill to run plan p for agent a',
    logPath: '/workspace/logs/cron/a-p.log',
  });
  assert.match(line, /-c shell_environment_policy\.inherit=core/);
});

// ── 6. Tool-mismatch guard on upsert ──────────────────────────────────────

test('scheduling.gate: upsertEntryInDoc refuses to overwrite a claude entry with a codex entry of the same name', () => {
  const fx = makeWorkspace();
  try {
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    const { doc } = readExistingSchedulesDoc(join(fx.cwd, 'roster', 'gtm', 'schedules.yaml'));
    assert.throws(
      () =>
        upsertEntryInDoc(doc, {
          ...sdrEntryBase,
          tool: 'codex',
          install_mode: 'via-cron',
          status: 'installed',
          subscription_attestation: { auth_mode: 'chatgpt', env_policy: 'cleared', codex_home: '/h/.codex' },
        }),
      (err: unknown) => err instanceof RosterError && /different tool/i.test(err.message),
    );
  } finally {
    fx.cleanup();
  }
});

test('scheduling.gate: upsertEntryInDoc allows same-name same-tool overwrite, written back to disk', () => {
  // Round-trip through disk — assert the file on disk has the updated value,
  // not the in-memory doc. The in-memory mutation could write to a wrong
  // slot and a same-object reparse would still report success.
  const fx = makeWorkspace();
  try {
    const yamlPath = join(fx.cwd, 'roster', 'gtm', 'schedules.yaml');
    seedSchedulesYaml(fx.cwd, 'gtm', [sdrEntryBase]);
    const { doc } = readExistingSchedulesDoc(yamlPath);
    const result = upsertEntryInDoc(doc, { ...sdrEntryBase, cron: '0 17 * * 1-5' });
    assert.equal(result.action, 'updated');
    atomicWriteFile(yamlPath, doc.toString());
    const fromDisk = YAML.parse(readFileSync(yamlPath, 'utf8'));
    assert.equal(fromDisk.schedules.length, 1);
    assert.equal(fromDisk.schedules[0].name, 'sdr-cold-outreach');
    assert.equal(fromDisk.schedules[0].cron, '0 17 * * 1-5');
  } finally {
    fx.cleanup();
  }
});
