import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hook-install.ts';

let claudeHome = '';
let codexHome = '';

beforeEach(() => {
  claudeHome = mkdtempSync(join(tmpdir(), 'roster-hook-claude-'));
  codexHome = mkdtempSync(join(tmpdir(), 'roster-hook-codex-'));
  process.env['ROSTER_CLAUDE_HOME'] = claudeHome;
  process.env['ROSTER_CODEX_HOME'] = codexHome;
});

afterEach(() => {
  rmSync(claudeHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
  delete process.env['ROSTER_CLAUDE_HOME'];
  delete process.env['ROSTER_CODEX_HOME'];
});

test('installHook(claude): fresh dir → writes settings.json with SessionStart hook + copies banner.sh', () => {
  const result = installHook('claude');
  assert.equal(result.status, 'installed');
  assert.equal(result.host, 'claude');
  assert.equal(result.configFile, join(claudeHome, 'settings.json'));

  const settings = JSON.parse(readFileSync(result.configFile, 'utf8')) as {
    hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  assert.ok(settings.hooks.SessionStart.length >= 1);
  const group = settings.hooks.SessionStart[0]!;
  assert.equal(group.matcher, '*');
  assert.equal(group.hooks[0]!.type, 'command');
  assert.ok(group.hooks[0]!.command.endsWith('roster-banner.sh'));

  // banner.sh copied to ~/.claude/hooks/ with executable bit
  const bannerPath = join(claudeHome, 'hooks', 'roster-banner.sh');
  assert.ok(existsSync(bannerPath));
  const mode = statSync(bannerPath).mode & 0o777;
  assert.ok((mode & 0o100) !== 0, `expected executable bit, got mode=${mode.toString(8)}`);
});

test('installHook(claude): re-run is idempotent (no second entry added)', () => {
  const first = installHook('claude');
  const second = installHook('claude');
  assert.equal(first.status, 'installed');
  assert.equal(second.status, 'already-present');

  const settings = JSON.parse(readFileSync(first.configFile, 'utf8')) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
  };
  const allHookCommands = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  const rosterHookCount = allHookCommands.filter((c) => c.endsWith('roster-banner.sh')).length;
  assert.equal(rosterHookCount, 1, 'expected exactly one roster hook entry after two installs');
});

test('installHook(claude): existing unrelated SessionStart hook preserved', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo "other plugin hook"' }],
          },
        ],
      },
      permissions: { allow: ['mcp__pencil'] },
    }),
  );

  installHook('claude');

  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    permissions: { allow: string[] };
  };
  // Other plugin hook preserved
  const otherHook = settings.hooks.SessionStart.find((g) =>
    g.hooks.some((h) => h.command === 'echo "other plugin hook"'),
  );
  assert.ok(otherHook !== undefined, 'expected other plugin hook to be preserved');
  // Permissions block untouched
  assert.deepEqual(settings.permissions.allow, ['mcp__pencil']);
  // Roster hook added
  const rosterHook = settings.hooks.SessionStart.find((g) =>
    g.hooks.some((h) => h.command.endsWith('roster-banner.sh')),
  );
  assert.ok(rosterHook !== undefined, 'expected roster hook to be added');
});

test('installHook(claude): existing roster hook with stale path → still detected, no duplicate', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'bash /stale/path/to/roster-banner.sh' }],
          },
        ],
      },
    }),
  );

  const result = installHook('claude');
  assert.equal(result.status, 'already-present');
  // We don't auto-replace stale paths in v1 — that's a v2 feature.
});

test('installHook(codex): fresh dir → writes hooks.json (NOT config.toml)', () => {
  const result = installHook('codex');
  assert.equal(result.status, 'installed');
  assert.equal(result.host, 'codex');
  assert.equal(result.configFile, join(codexHome, 'hooks.json'));

  const hooksJson = JSON.parse(readFileSync(result.configFile, 'utf8')) as {
    hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  assert.equal(hooksJson.hooks.SessionStart.length, 1);
  assert.ok(hooksJson.hooks.SessionStart[0]!.hooks[0]!.command.endsWith('roster-banner.sh'));

  // banner.sh copied to ~/.codex/hooks/
  assert.ok(existsSync(join(codexHome, 'hooks', 'roster-banner.sh')));
});

test('installHook(codex): re-run is idempotent', () => {
  installHook('codex');
  const second = installHook('codex');
  assert.equal(second.status, 'already-present');

  const hooksJson = JSON.parse(readFileSync(second.configFile, 'utf8')) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
  };
  const count = hooksJson.hooks.SessionStart.flatMap((g) =>
    g.hooks.filter((h) => h.command.endsWith('roster-banner.sh')),
  ).length;
  assert.equal(count, 1);
});

test('installHook: host home does not exist → skipped (not an error)', () => {
  process.env['ROSTER_CLAUDE_HOME'] = '/nonexistent/claude-home';
  const result = installHook('claude');
  assert.equal(result.status, 'skipped-host-absent');
  assert.ok(result.reason !== undefined);
  // No config file written
  assert.equal(existsSync(result.configFile), false);
});

test('installHook(codex): existing unrelated SessionStart hook preserved', () => {
  mkdirSync(codexHome, { recursive: true });
  const hooksPath = join(codexHome, 'hooks.json');
  writeFileSync(
    hooksPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'echo "codex plugin"' }],
          },
        ],
      },
    }),
  );

  installHook('codex');

  const hooksJson = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
  };
  const allCommands = hooksJson.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(allCommands.includes('echo "codex plugin"'), 'preserved');
  assert.ok(allCommands.some((c) => c.endsWith('roster-banner.sh')), 'roster hook added');
});

test('installHook(claude): malformed settings.json → throws (not silent corruption)', () => {
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, 'settings.json'), '{ this is not valid JSON');
  assert.throws(() => installHook('claude'));
});
