import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { installCodexSchedule, type CodexInstallOpts } from '../src/lib/codex-install.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { CrontabIO } from '../src/lib/codex-cron.ts';

function makeWorkspaceAndHome(): {
  cwd: string;
  home: string;
  codex: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'roster-codex-install-'));
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
  return { cwd, home, codex, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function inMemoryCrontabIO(): CrontabIO & { writes: string[]; current: string } {
  const obj = {
    current: '',
    writes: [] as string[],
    read() {
      return { ok: true as const, content: this.current };
    },
    write(content: string) {
      this.writes.push(content);
      this.current = content;
    },
  };
  return obj;
}

function baseOpts(cwd: string, home: string): CodexInstallOpts {
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

// ── Hand-off mode ─────────────────────────────────────────────────────────

test('codex install (ui-handoff): writes fields doc + schedules.yaml with attestation', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const result = installCodexSchedule(baseOpts(fx.cwd, fx.home));
    assert.equal(result.action, 'created');
    assert.equal(result.installMode, 'ui-handoff');
    assert.ok(existsSync(result.fieldsDocPath!));
    assert.ok(existsSync(result.schedulesYamlPath));

    const yaml = YAML.parse(readFileSync(result.schedulesYamlPath, 'utf8'));
    assert.equal(yaml.schedules[0].tool, 'codex');
    assert.equal(yaml.schedules[0].install_mode, 'ui-handoff');
    assert.equal(yaml.schedules[0].status, 'pending-ui-install');
    assert.equal(yaml.schedules[0].subscription_attestation.auth_mode, 'chatgpt');
    assert.equal(yaml.schedules[0].subscription_attestation.env_policy, 'cleared');
    assert.equal(yaml.schedules[0].subscription_attestation.codex_home, fx.codex);

    const fieldsDoc = readFileSync(result.fieldsDocPath!, 'utf8');
    assert.match(fieldsDoc, /Codex App Automation/);
    assert.match(fieldsDoc, /Use the roster-orchestrator skill to run plan cold-outreach for agent sdr/);
  } finally {
    fx.cleanup();
  }
});

test('codex install (ui-handoff) --dry-run: writes nothing, no logs/cron dir', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const result = installCodexSchedule({ ...baseOpts(fx.cwd, fx.home), dryRun: true });
    assert.equal(result.action, 'noop-dry-run');
    assert.ok(!existsSync(result.fieldsDocPath!), 'fields doc must not be written in dry-run');
    assert.ok(!existsSync(result.schedulesYamlPath), 'schedules.yaml must not be written in dry-run');
    assert.ok(!existsSync(join(fx.cwd, 'logs', 'cron')), 'logs/cron/ must not be created in dry-run');
    assert.ok(result.fieldsDocContent !== null && result.fieldsDocContent.includes('Codex App Automation'));
  } finally {
    fx.cleanup();
  }
});

test('codex install (ui-handoff): idempotent re-run → action=updated', () => {
  const fx = makeWorkspaceAndHome();
  try {
    installCodexSchedule(baseOpts(fx.cwd, fx.home));
    const second = installCodexSchedule(baseOpts(fx.cwd, fx.home));
    assert.equal(second.action, 'updated');
    const yaml = YAML.parse(readFileSync(second.schedulesYamlPath, 'utf8'));
    assert.equal(yaml.schedules.length, 1);
  } finally {
    fx.cleanup();
  }
});

// ── via-cron mode ─────────────────────────────────────────────────────────

test('codex install (via-cron): writes schedules.yaml + invokes crontab IO + creates logs/cron/', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const io = inMemoryCrontabIO();
    const result = installCodexSchedule({
      ...baseOpts(fx.cwd, fx.home),
      installMode: 'via-cron',
      crontabIO: io,
      codexBinaryPathOverride: '/opt/homebrew/bin/codex',
    });

    assert.equal(result.action, 'created');
    assert.equal(result.installMode, 'via-cron');
    assert.equal(result.fieldsDocPath, null);
    assert.ok(existsSync(join(fx.cwd, 'logs', 'cron')), 'logs/cron/ should be pre-created');
    assert.equal(io.writes.length, 1);
    assert.match(io.current, /# roster:schedule:sdr-cold-outreach:begin/);
    assert.match(io.current, /codex' exec -C/);

    const yaml = YAML.parse(readFileSync(result.schedulesYamlPath, 'utf8'));
    assert.equal(yaml.schedules[0].install_mode, 'via-cron');
    assert.equal(yaml.schedules[0].status, 'installed');
  } finally {
    fx.cleanup();
  }
});

test('codex install (via-cron) --dry-run: no crontab write, no mkdir for logs/cron, no yaml write', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const io = inMemoryCrontabIO();
    const result = installCodexSchedule({
      ...baseOpts(fx.cwd, fx.home),
      installMode: 'via-cron',
      dryRun: true,
      crontabIO: io,
      codexBinaryPathOverride: '/opt/homebrew/bin/codex',
    });

    assert.equal(result.action, 'noop-dry-run');
    assert.equal(io.writes.length, 0);
    assert.ok(!existsSync(join(fx.cwd, 'logs', 'cron')), 'logs/cron/ must not exist in dry-run');
    assert.ok(!existsSync(result.schedulesYamlPath), 'schedules.yaml must not be written in dry-run');
    assert.ok(result.cronLine !== null && result.cronLine.includes('codex'));
  } finally {
    fx.cleanup();
  }
});

test('codex install (via-cron): idempotent re-run → one crontab block, action=updated', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const io = inMemoryCrontabIO();
    installCodexSchedule({
      ...baseOpts(fx.cwd, fx.home),
      installMode: 'via-cron',
      crontabIO: io,
      codexBinaryPathOverride: '/opt/homebrew/bin/codex',
    });
    const second = installCodexSchedule({
      ...baseOpts(fx.cwd, fx.home),
      installMode: 'via-cron',
      crontabIO: io,
      codexBinaryPathOverride: '/opt/homebrew/bin/codex',
    });
    assert.equal(second.action, 'updated');
    const beginCount = (io.current.match(/# roster:schedule:sdr-cold-outreach:begin/g) ?? []).length;
    assert.equal(beginCount, 1);
  } finally {
    fx.cleanup();
  }
});

// ── Preflight + validation ────────────────────────────────────────────────

test('codex install: preflight failure (env CODEX_API_KEY set) → throws RosterError', () => {
  const fx = makeWorkspaceAndHome();
  try {
    assert.throws(
      () => installCodexSchedule({
        ...baseOpts(fx.cwd, fx.home),
        env: { PATH: '/usr/bin', CODEX_API_KEY: 'sk-leak' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /preflight failed/);
        assert.match(err.body, /env_codex_api_key/);
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});

test('codex install: tool mismatch on same name → throws (claude entry exists, install codex)', () => {
  const fx = makeWorkspaceAndHome();
  try {
    // Pre-seed a claude entry with the same name we're about to use.
    const yamlPath = join(fx.cwd, 'roster', 'gtm', 'schedules.yaml');
    mkdirSync(join(fx.cwd, 'roster', 'gtm'), { recursive: true });
    writeFileSync(
      yamlPath,
      `version: 1
schedules:
  - name: sdr-cold-outreach
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: claude
    install_mode: ui-handoff
    status: pending-ui-install
`,
      'utf8',
    );
    assert.throws(
      () => installCodexSchedule(baseOpts(fx.cwd, fx.home)),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /tool=claude/);
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});

test('codex install (via-cron): codex binary not found AND no override → throws', () => {
  const fx = makeWorkspaceAndHome();
  try {
    assert.throws(
      () => installCodexSchedule({
        ...baseOpts(fx.cwd, fx.home),
        installMode: 'via-cron',
        // no codexBinaryPathOverride, env has empty PATH (no codex on it)
        env: { PATH: '/tmp/does-not-exist' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /codex binary not found/);
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});

test('codex install (via-cron): ROSTER_CODEX_PATH env honored as binary override', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const io = inMemoryCrontabIO();
    const result = installCodexSchedule({
      ...baseOpts(fx.cwd, fx.home),
      installMode: 'via-cron',
      env: { PATH: '/usr/bin', ROSTER_CODEX_PATH: '/custom/path/codex' },
      crontabIO: io,
    });
    assert.match(result.cronLine!, /'\/custom\/path\/codex'/);
  } finally {
    fx.cleanup();
  }
});

test('codex install: custom --name produces fields doc under that name', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const result = installCodexSchedule({
      ...baseOpts(fx.cwd, fx.home),
      name: 'morning-run',
    });
    assert.equal(result.resolvedName, 'morning-run');
    assert.ok(result.fieldsDocPath!.endsWith('morning-run.codex.fields.md'));
  } finally {
    fx.cleanup();
  }
});

test('codex install: invalid cron throws RosterError naming cron', () => {
  const fx = makeWorkspaceAndHome();
  try {
    assert.throws(
      () => installCodexSchedule({ ...baseOpts(fx.cwd, fx.home), cron: '99 99 * * *' }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /cron/);
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});

// Codex impl-review c=9: side-effects must run before YAML write so a
// crontab failure doesn't leave schedules.yaml claiming `status: installed`.
test('codex install (via-cron): crontab IO failure leaves schedules.yaml unwritten', () => {
  const fx = makeWorkspaceAndHome();
  try {
    const failingIO: CrontabIO = {
      read() { return { ok: true, content: '' }; },
      write() { throw new Error('crontab write failed (simulated)'); },
    };
    const yamlPath = join(fx.cwd, 'roster', 'gtm', 'schedules.yaml');
    assert.throws(
      () => installCodexSchedule({
        ...baseOpts(fx.cwd, fx.home),
        installMode: 'via-cron',
        crontabIO: failingIO,
        codexBinaryPathOverride: '/opt/homebrew/bin/codex',
      }),
      (err: unknown) => err instanceof Error,
    );
    assert.ok(!existsSync(yamlPath), 'schedules.yaml must not be written when crontab fails');
  } finally {
    fx.cleanup();
  }
});

test('codex install: non-kebab function name throws', () => {
  const fx = makeWorkspaceAndHome();
  try {
    assert.throws(
      () => installCodexSchedule({ ...baseOpts(fx.cwd, fx.home), functionName: 'GTM' }),
      (err: unknown) => err instanceof RosterError,
    );
  } finally {
    fx.cleanup();
  }
});
