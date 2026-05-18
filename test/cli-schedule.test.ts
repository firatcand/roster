import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[]): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      // Pin ROSTER_PLATFORM=darwin so install-path tests don't trip the
      // Linux + --tool claude refusal on Ubuntu CI runners. Tests that
      // explicitly need a different platform spawn the child directly
      // (see the 'Linux + --tool claude' refusal test below).
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ROSTER_PLATFORM: 'darwin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function makeCwd(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-schedule-cli-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSchedules(root: string, fn: string, content: string): void {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), content, 'utf8');
}

const validYaml = `version: 1
schedules:
  - name: cold-outreach-daily
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

const invalidYaml = `version: 1
schedules:
  - name: bad
    agent: sdr
    plan: cold-outreach
    project: _demo
    cron: "0 9 * * 8"
    tool: gemini
    install_mode: via-cron
    status: installed
`;

test('schedule validate: empty cwd → exit 0, "no files" message', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /No roster.*schedules\.yaml files found/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: valid file → exit 0, PASS line', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /PASS/);
    assert.match(r.stdout, /All schedules valid/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: invalid file → exit 1 with field-level error for tool enum', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL/);
    assert.match(r.stdout, /tool: must be one of 'claude' \| 'codex'/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: invalid file → exit 1 with cron error', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /cron.*day-of-week/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate --json: valid → exit 0 with parseable ok=true', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--json']);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; files: { status: string }[] };
    assert.equal(payload.ok, true);
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0]!.status, 'pass');
  } finally {
    fix.cleanup();
  }
});

test('schedule validate --json: invalid → exit 1 with ok=false and errors[]', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--json']);
    assert.equal(r.status, 1);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      files: { status: string; errors: { path: string; message: string }[] }[];
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.files[0]!.status, 'fail');
    assert.ok(payload.files[0]!.errors.length >= 2);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate --silent: invalid → exit 1, no stdout', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--silent']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
  } finally {
    fix.cleanup();
  }
});

test('schedule (no subcommand): exits 1 with helpful message', () => {
  const r = runCli(['schedule']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing subcommand.*schedule/);
  assert.match(r.stderr, /available: validate/);
});

test('schedule garbage: exits 1 with unknown-subcommand error', () => {
  const r = runCli(['schedule', 'frobnicate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown.*subcommand.*frobnicate/);
});

test('schedule validate --bogus-flag: exits 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: --cwd missing path argument errors', () => {
  const r = runCli(['schedule', 'validate', '--cwd']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--cwd requires a path/);
});

test('schedule validate: --cwd=path form is accepted', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const r = runCli(['schedule', 'validate', `--cwd=${fix.root}`]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fix.cleanup();
  }
});

test('help text includes schedule validate', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /roster schedule validate/);
});

test('help text includes schedule install', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /roster schedule install/);
});

test('schedule (no subcommand): error message lists install too', () => {
  const r = runCli(['schedule']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /install/);
});

// ---------------------------------------------------------------------------
// schedule install (ROS-34) — full CLI integration coverage
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import YAML from 'yaml';

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

test('schedule install: happy path → exit 0, files written, hand-off printed', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'claude',
      '--cwd', fix.root,
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Registered schedule sdr-cold-outreach/);
    assert.match(r.stdout, /Next: paste into Claude Desktop/);
    assert.match(r.stdout, /41364/);

    const fieldsDocPath = join(fix.root, '.roster', 'schedule-specs', 'sdr-cold-outreach.claude.fields.md');
    assert.ok(existsSync(fieldsDocPath), 'fields doc should exist');
    const fieldsDoc = readFileSync(fieldsDocPath, 'utf8');
    assert.match(fieldsDoc, /Task name.*sdr-cold-outreach/);
    assert.match(fieldsDoc, /Workspace path.*roster-schedule-cli-/);

    const yamlPath = join(fix.root, 'roster', 'gtm', 'schedules.yaml');
    assert.ok(existsSync(yamlPath));
    const doc = YAML.parse(readFileSync(yamlPath, 'utf8'));
    assert.equal(doc.version, 1);
    assert.equal(doc.schedules[0].status, 'pending-ui-install');
    assert.equal(doc.schedules[0].tool, 'claude');
    assert.equal(doc.schedules[0].install_mode, 'ui-handoff');
  } finally {
    fix.cleanup();
  }
});

test('schedule install --dry-run: writes nothing, prints fields doc', () => {
  const fix = makeCwd();
  try {
    const before = listAllFiles(fix.root);
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'claude',
      '--cwd', fix.root,
      '--dry-run',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Would register/);
    assert.match(r.stdout, /Fields document \(would be written\)/);

    const after = listAllFiles(fix.root);
    assert.deepEqual(after, before, 'dry-run must not write any files');
  } finally {
    fix.cleanup();
  }
});

test('schedule install: Linux + --tool claude → exit 1 with linux refusal', () => {
  const fix = makeCwd();
  try {
    const out = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', BIN,
       'schedule', 'install', 'gtm/sdr', 'cold-outreach',
       '--cron', '0 9 * * 1-5', '--tool', 'claude', '--cwd', fix.root,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ROSTER_PLATFORM: 'linux' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      },
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /not available on Linux/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: --cloud-routine → exit 1 with not-yet-implemented', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'claude',
      '--cwd', fix.root,
      '--cloud-routine',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--cloud-routine is not yet implemented/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: --via cron with --tool claude → exit 1 with unsupported error', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'claude',
      '--via', 'cron',
      '--cwd', fix.root,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--via cron is not supported with --tool claude/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: --via foo (unknown mode) → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'codex',
      '--via', 'foo',
      '--cwd', fix.root,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown --via mode/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: missing --cron → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--tool', 'claude',
      '--cwd', fix.root,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required flag --cron/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: missing --tool → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--cwd', fix.root,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required flag --tool/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: malformed positional (no slash) → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli([
      'schedule', 'install',
      'gtm-sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude',
      '--cwd', fix.root,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /<function>\/<agent>/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install: idempotent re-run → 1 entry, action=updated', () => {
  const fix = makeCwd();
  try {
    const r1 = runCli([
      'schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude', '--cwd', fix.root,
    ]);
    assert.equal(r1.status, 0);

    const r2 = runCli([
      'schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '30 14 * * 1-5', '--tool', 'claude', '--cwd', fix.root,
    ]);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /Updated schedule sdr-cold-outreach/);

    const yamlPath = join(fix.root, 'roster', 'gtm', 'schedules.yaml');
    const doc = YAML.parse(readFileSync(yamlPath, 'utf8'));
    assert.equal(doc.schedules.length, 1);
    assert.equal(doc.schedules[0].cron, '30 14 * * 1-5');
  } finally {
    fix.cleanup();
  }
});

test('schedule install: --name override creates a distinct entry', () => {
  const fix = makeCwd();
  try {
    runCli(['schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude', '--cwd', fix.root]);
    const r = runCli(['schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '0 17 * * 1-5', '--tool', 'claude',
      '--name', 'sdr-cold-outreach-evening', '--cwd', fix.root]);
    assert.equal(r.status, 0);

    const yamlPath = join(fix.root, 'roster', 'gtm', 'schedules.yaml');
    const doc = YAML.parse(readFileSync(yamlPath, 'utf8'));
    assert.equal(doc.schedules.length, 2);
  } finally {
    fix.cleanup();
  }
});

test('schedule install → schedule validate round-trip passes', () => {
  const fix = makeCwd();
  try {
    const r1 = runCli(['schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude', '--cwd', fix.root]);
    assert.equal(r1.status, 0);

    const r2 = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r2.status, 0, `validate stderr: ${r2.stderr}\nvalidate stdout: ${r2.stdout}`);
    assert.match(r2.stdout, /PASS/);
  } finally {
    fix.cleanup();
  }
});

test('schedule install --json: exit 0, parseable payload', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude', '--cwd', fix.root, '--json']);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; name: string; action: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.name, 'sdr-cold-outreach');
    assert.equal(payload.action, 'created');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// schedule install (ROS-35) — Codex paths
// ---------------------------------------------------------------------------

import { homedir } from 'node:os';

function makeFakeHome(): { home: string; codex: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'roster-codex-home-'));
  const codex = join(home, '.codex');
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }), 'utf8');
  return { home, codex, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runCliCodex(args: readonly string[], homeDir: string, platform: 'darwin' | 'linux' | 'win32' = 'darwin'): Run {
  // Strip API-key env vars so preflight passes deterministically. HOME override
  // makes the CLI's homedir() resolve to our fake codex root. ROSTER_CODEX_PATH
  // pin is required so via-cron tests don't depend on `codex` being installed
  // on the CI runner (Ubuntu has no codex binary on PATH).
  const baseEnv = { ...process.env };
  delete baseEnv['CODEX_API_KEY'];
  delete baseEnv['OPENAI_API_KEY'];
  delete baseEnv['ANTHROPIC_API_KEY'];
  delete baseEnv['CODEX_HOME'];
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: homeDir,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ROSTER_PLATFORM: platform,
    ROSTER_CODEX_PATH: '/opt/homebrew/bin/codex',
  };
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

test('schedule install --tool codex (hand-off): exit 0, fields doc written, hand-off printed', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const r = runCliCodex([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'codex',
      '--cwd', fix.root,
    ], fh.home);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /Registered codex schedule sdr-cold-outreach/);
    assert.match(r.stdout, /paste into the Codex app/);

    const fieldsDocPath = join(fix.root, '.roster', 'schedule-specs', 'sdr-cold-outreach.codex.fields.md');
    assert.ok(existsSync(fieldsDocPath));

    const yamlPath = join(fix.root, 'roster', 'gtm', 'schedules.yaml');
    const doc = YAML.parse(readFileSync(yamlPath, 'utf8'));
    assert.equal(doc.schedules[0].tool, 'codex');
    assert.equal(doc.schedules[0].install_mode, 'ui-handoff');
    assert.equal(doc.schedules[0].status, 'pending-ui-install');
    assert.equal(doc.schedules[0].subscription_attestation.auth_mode, 'chatgpt');
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

test('schedule install --tool codex (hand-off) --dry-run: exit 0, no writes', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const before = listAllFiles(fix.root);
    const r = runCliCodex([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'codex',
      '--cwd', fix.root,
      '--dry-run',
    ], fh.home);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Would register/);
    const after = listAllFiles(fix.root);
    assert.deepEqual(after, before);
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

test('schedule install --tool codex --via cron --dry-run: exit 0, cron line printed, no crontab call, no logs dir', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const r = runCliCodex([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'codex',
      '--via', 'cron',
      '--cwd', fix.root,
      '--dry-run',
    ], fh.home);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Would register/);
    assert.match(r.stdout, /Crontab line \(would be installed\)/);
    assert.ok(!existsSync(join(fix.root, 'logs', 'cron')));
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

test('schedule install --tool codex: preflight fails when API key in shell → exit 1, lists failures', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fh.home,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ROSTER_PLATFORM: 'darwin',
      OPENAI_API_KEY: 'sk-leak',
    };
    const out = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', BIN,
        'schedule', 'install', 'gtm/sdr', 'cold-outreach',
        '--cron', '0 9 * * 1-5', '--tool', 'codex', '--cwd', fix.root,
      ],
      { encoding: 'utf8', env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /preflight failed/);
    assert.match(out.stderr, /env_openai_api_key/);
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

test('schedule install --tool codex on Linux without --via cron → exit 1 (Codex desktop not on Linux)', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const r = runCliCodex([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'codex',
      '--cwd', fix.root,
    ], fh.home, 'linux');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Codex desktop app is not available on Linux/);
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

test('schedule install --tool codex --via cron on Windows → exit 1', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const r = runCliCodex([
      'schedule', 'install',
      'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5',
      '--tool', 'codex',
      '--via', 'cron',
      '--cwd', fix.root,
    ], fh.home, 'win32');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--via cron is not supported on Windows/);
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

test('schedule install --tool codex --json: exit 0, parseable payload includes attestation', () => {
  const fix = makeCwd();
  const fh = makeFakeHome();
  try {
    const r = runCliCodex([
      'schedule', 'install', 'gtm/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'codex',
      '--cwd', fix.root, '--json',
    ], fh.home);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      name: string;
      tool: string;
      installMode: string;
      attestation: { auth_mode: string };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.tool, 'codex');
    assert.equal(payload.installMode, 'ui-handoff');
    assert.equal(payload.attestation.auth_mode, 'chatgpt');
  } finally {
    fix.cleanup();
    fh.cleanup();
  }
});

// Suppress unused-import warnings: homedir is reserved for future tests.
void homedir;
