import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], env: Record<string, string>): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function makeHomes(): { claude: string; codex: string; cleanup: () => void } {
  const claude = mkdtempSync(join(tmpdir(), 'roster-cli-hooks-claude-'));
  const codex = mkdtempSync(join(tmpdir(), 'roster-cli-hooks-codex-'));
  return {
    claude,
    codex,
    cleanup: () => {
      rmSync(claude, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    },
  };
}

test('hooks install --tool claude: installs Claude hook, leaves codex alone', () => {
  const h = makeHomes();
  try {
    const r = runCli(['hooks', 'install', '--tool', 'claude'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Claude Code/);
    assert.ok(existsSync(join(h.claude, 'settings.json')));
    assert.ok(existsSync(join(h.claude, 'hooks', 'roster-banner.sh')));
    assert.equal(existsSync(join(h.codex, 'hooks.json')), false);
  } finally {
    h.cleanup();
  }
});

test('hooks install --tool codex: installs Codex hook only', () => {
  const h = makeHomes();
  try {
    const r = runCli(['hooks', 'install', '--tool', 'codex'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(h.codex, 'hooks.json')));
    assert.ok(existsSync(join(h.codex, 'hooks', 'roster-banner.sh')));
    assert.equal(existsSync(join(h.claude, 'settings.json')), false);
  } finally {
    h.cleanup();
  }
});

test('hooks install --tool all (default): installs both hosts', () => {
  const h = makeHomes();
  try {
    const r = runCli(['hooks', 'install'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(h.claude, 'settings.json')));
    assert.ok(existsSync(join(h.codex, 'hooks.json')));
  } finally {
    h.cleanup();
  }
});

test('hooks install: re-run is idempotent (exit 0, no duplicate entries)', () => {
  const h = makeHomes();
  try {
    runCli(['hooks', 'install'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    const r2 = runCli(['hooks', 'install'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /already installed/);

    const claudeSettings = JSON.parse(readFileSync(join(h.claude, 'settings.json'), 'utf8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const rosterEntries = claudeSettings.hooks.SessionStart.flatMap((g) =>
      g.hooks.filter((hk) => hk.command.endsWith('roster-banner.sh')),
    );
    assert.equal(rosterEntries.length, 1);
  } finally {
    h.cleanup();
  }
});

test('hooks install: host absent → skipped with reason, exit 0', () => {
  const r = runCli(['hooks', 'install'], {
    ROSTER_CLAUDE_HOME: '/nonexistent/claude',
    ROSTER_CODEX_HOME: '/nonexistent/codex',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skipped/);
});

test('hooks install: unknown --tool value → exit 1', () => {
  const r = runCli(['hooks', 'install', '--tool', 'bogus'], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--tool must be one of/);
});

test('hooks install: --silent suppresses non-error output', () => {
  const h = makeHomes();
  try {
    const r = runCli(['hooks', 'install', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    h.cleanup();
  }
});

test('hooks: missing subcommand → exit 1', () => {
  const r = runCli(['hooks'], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing subcommand/);
});

test('hooks: unknown subcommand → exit 1', () => {
  const r = runCli(['hooks', 'wat'], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown hooks subcommand/);
});

test('hooks install: existing settings.json with unrelated keys preserved', () => {
  const h = makeHomes();
  try {
    mkdirSync(h.claude, { recursive: true });
    const existing = {
      permissions: { allow: ['Bash(echo*)'], deny: [] },
      statusLine: { type: 'command', command: 'sh /foo.sh' },
    };
    writeFileSync(join(h.claude, 'settings.json'), JSON.stringify(existing));

    runCli(['hooks', 'install', '--tool', 'claude'], { ROSTER_CLAUDE_HOME: h.claude });

    const after = JSON.parse(readFileSync(join(h.claude, 'settings.json'), 'utf8')) as {
      permissions: { allow: string[] };
      statusLine: { type: string };
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.deepEqual(after.permissions.allow, ['Bash(echo*)']);
    assert.equal(after.statusLine.type, 'command');
    assert.ok(after.hooks.SessionStart[0]!.hooks[0]!.command.endsWith('roster-banner.sh'));
  } finally {
    h.cleanup();
  }
});
