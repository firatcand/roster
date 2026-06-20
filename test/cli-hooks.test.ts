import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

// The installer copies ROSTER_ROOT/bin/tripwire-hook.js into the host hooks dir,
// so the bundled artifact must exist before these tests run. Build if missing.
const TRIPWIRE_ARTIFACT = resolve('bin/tripwire-hook.js');
if (!existsSync(TRIPWIRE_ARTIFACT)) {
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', stdio: 'inherit' });
  if (build.status !== 0) throw new Error('failed to build bin/tripwire-hook.js for cli-hooks tests');
}

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

test('hooks install --tool claude: also installs PostToolUse tripwire + copies the .mjs', () => {
  const h = makeHomes();
  try {
    const r = runCli(['hooks', 'install', '--tool', 'claude'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PostToolUse Tripwire/);

    assert.ok(existsSync(join(h.claude, 'hooks', 'roster-tripwire-hook.mjs')));

    const settings = JSON.parse(readFileSync(join(h.claude, 'settings.json'), 'utf8')) as {
      hooks: { PostToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    const group = settings.hooks.PostToolUse.find((g) =>
      g.hooks.some((hk) => hk.command.includes('roster-tripwire-hook.mjs')),
    );
    assert.ok(group !== undefined, 'expected tripwire PostToolUse group');
    assert.equal(group.matcher, '^(?:WebFetch|WebSearch|mcp__.*)$');
    assert.match(group.hooks[0]!.command, /^node '.*roster-tripwire-hook\.mjs'$/);
  } finally {
    h.cleanup();
  }
});

test('hooks install --tool claude: tripwire entry is idempotent (no dup on 2nd run)', () => {
  const h = makeHomes();
  try {
    runCli(['hooks', 'install', '--tool', 'claude'], { ROSTER_CLAUDE_HOME: h.claude, ROSTER_CODEX_HOME: h.codex });
    const r2 = runCli(['hooks', 'install', '--tool', 'claude'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r2.status, 0);

    const settings = JSON.parse(readFileSync(join(h.claude, 'settings.json'), 'utf8')) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const count = settings.hooks.PostToolUse.flatMap((g) => g.hooks).filter((hk) =>
      hk.command.includes('roster-tripwire-hook.mjs'),
    ).length;
    assert.equal(count, 1);
  } finally {
    h.cleanup();
  }
});

test('hooks install --tool claude: preserves a pre-existing user PostToolUse entry', () => {
  const h = makeHomes();
  try {
    mkdirSync(h.claude, { recursive: true });
    writeFileSync(
      join(h.claude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        },
      }),
    );

    const r = runCli(['hooks', 'install', '--tool', 'claude'], { ROSTER_CLAUDE_HOME: h.claude });
    assert.equal(r.status, 0);

    const settings = JSON.parse(readFileSync(join(h.claude, 'settings.json'), 'utf8')) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const all = settings.hooks.PostToolUse.flatMap((g) => g.hooks);
    assert.ok(all.some((hk) => hk.command === 'echo user-hook'), 'user PostToolUse entry preserved');
    assert.ok(
      all.some((hk) => hk.command.includes('roster-tripwire-hook.mjs')),
      'tripwire entry added',
    );
  } finally {
    h.cleanup();
  }
});

test('hooks install --tool claude: corrupted settings.json → skip not crash, file untouched', () => {
  const h = makeHomes();
  try {
    mkdirSync(h.claude, { recursive: true });
    const settingsPath = join(h.claude, 'settings.json');
    const corrupt = '{ not valid json ';
    writeFileSync(settingsPath, corrupt);

    const r = runCli(['hooks', 'install', '--tool', 'claude'], { ROSTER_CLAUDE_HOME: h.claude });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipped/);
    // Never clobbered.
    assert.equal(readFileSync(settingsPath, 'utf8'), corrupt);
  } finally {
    h.cleanup();
  }
});

test('hooks install --tool codex: gets banner but NOT the tripwire PostToolUse entry', () => {
  const h = makeHomes();
  try {
    const r = runCli(['hooks', 'install', '--tool', 'codex'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
    });
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(h.codex, 'hooks', 'roster-banner.sh')));
    assert.equal(existsSync(join(h.codex, 'hooks', 'roster-tripwire-hook.mjs')), false);

    const hooksJson = JSON.parse(readFileSync(join(h.codex, 'hooks.json'), 'utf8')) as {
      hooks: { PostToolUse?: unknown };
    };
    assert.equal(hooksJson.hooks.PostToolUse, undefined);
  } finally {
    h.cleanup();
  }
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

test('bundled bin/tripwire-hook.js is self-contained (no non-node imports)', () => {
  // The hook runs from ~/.claude/hooks/ where roster's node_modules is NOT
  // resolvable, so the bundle must import only node: builtins (or relative).
  const src = readFileSync(TRIPWIRE_ARTIFACT, 'utf8');
  const bad: string[] = [];
  const re = /(?:^|\s)(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] ?? m[2] ?? '';
    if (spec && !spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/')) {
      bad.push(spec);
    }
  }
  assert.deepEqual(bad, [], `bundle has non-node imports: ${bad.join(', ')}`);
});
