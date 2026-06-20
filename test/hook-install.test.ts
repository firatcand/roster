import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook, type HookInstallResult, type HookKind } from '../src/lib/hook-install.ts';

let claudeHome = '';
let codexHome = '';

function pick(results: HookInstallResult[], kind: HookKind): HookInstallResult {
  const r = results.find((x) => x.kind === kind);
  assert.ok(r !== undefined, `expected a ${kind} result`);
  return r;
}

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
  const result = pick(installHook('claude'), 'session-start');
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
  const first = pick(installHook('claude'), 'session-start');
  const second = pick(installHook('claude'), 'session-start');
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

  const result = pick(installHook('claude'), 'session-start');
  assert.equal(result.status, 'already-present');
  // We don't auto-replace stale paths in v1 — that's a v2 feature.
});

test('installHook(codex): fresh dir → writes hooks.json (NOT config.toml)', () => {
  const result = pick(installHook('codex'), 'session-start');
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
  const second = pick(installHook('codex'), 'session-start');
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
  const result = pick(installHook('claude'), 'session-start');
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

test('installHook(claude): malformed settings.json → skipped, file left untouched (no throw, no corruption)', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  const original = '{ this is not valid JSON';
  writeFileSync(settingsPath, original);

  const results = installHook('claude');
  for (const r of results) {
    assert.equal(r.status, 'skipped-malformed-config', `${r.kind} should be skipped`);
  }
  // The corrupted file is never overwritten.
  assert.equal(readFileSync(settingsPath, 'utf8'), original);
});

test('installHook(claude): also installs the PostToolUse tripwire hook (shell form, anchored matcher)', () => {
  const results = installHook('claude');
  const tw = pick(results, 'tripwire');
  assert.equal(tw.status, 'installed');

  const settings = JSON.parse(readFileSync(tw.configFile, 'utf8')) as {
    hooks: { PostToolUse: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> };
  };
  const group = settings.hooks.PostToolUse.find((g) =>
    g.hooks.some((h) => h.command.includes('roster-tripwire-hook.mjs')),
  );
  assert.ok(group !== undefined, 'expected a tripwire PostToolUse group');
  assert.equal(group.matcher, '^(?:WebFetch|WebSearch|mcp__.*)$');
  // Shell-form: `node '<absPath>'` — single-quoted path (not an args array).
  assert.match(group.hooks[0]!.command, /^node '.*roster-tripwire-hook\.mjs'$/);

  // .mjs copied into ~/.claude/hooks/
  assert.ok(existsSync(join(claudeHome, 'hooks', 'roster-tripwire-hook.mjs')));
});

test('installHook(claude): tripwire install is idempotent (no duplicate PostToolUse entry)', () => {
  installHook('claude');
  const second = pick(installHook('claude'), 'tripwire');
  assert.equal(second.status, 'already-present');

  const settings = JSON.parse(readFileSync(second.configFile, 'utf8')) as {
    hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const count = settings.hooks.PostToolUse.flatMap((g) => g.hooks).filter((h) =>
    h.command.includes('roster-tripwire-hook.mjs'),
  ).length;
  assert.equal(count, 1);
});

test('installHook(claude): repairs a STALE tripwire path (different home) instead of leaving it broken', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  // Settings copied from another machine: a roster-tripwire entry at a path that
  // does not exist here. Must be REPLACED with the current path, not skipped.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: '^(?:WebFetch|WebSearch|mcp__.*)$', hooks: [{ type: 'command', command: "node '/old/home/.claude/hooks/roster-tripwire-hook.mjs'" }] },
        ],
      },
    }),
    'utf8',
  );
  const tw = pick(installHook('claude'), 'tripwire');
  assert.equal(tw.status, 'installed'); // repaired, not already-present
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const cmds = settings.hooks.PostToolUse.flatMap((g) => g.hooks).map((h) => h.command);
  const roster = cmds.filter((c) => c.includes('roster-tripwire-hook.mjs'));
  assert.equal(roster.length, 1, 'stale entry replaced, no duplicate');
  assert.ok(!roster[0]!.includes('/old/home/'), 'stale path removed');
  assert.ok(roster[0]!.includes(claudeHome), 'now points at the current home');
});

test('installHook(claude): drops a legacy EXEC-form tripwire entry (path in args) on reinstall', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  // A dev's prior exec-form entry: filename lives in args, command is bare node.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: '^(?:WebFetch|WebSearch|mcp__.*)$', hooks: [{ type: 'command', command: 'node', args: ['/old/.claude/hooks/roster-tripwire-hook.mjs'] }] },
        ],
      },
    }),
    'utf8',
  );
  installHook('claude');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: { PostToolUse: Array<{ hooks: Array<{ command: string; args?: string[] }> }> };
  };
  const hooks = settings.hooks.PostToolUse.flatMap((g) => g.hooks);
  const roster = hooks.filter((h) => [h.command, ...(h.args ?? [])].some((s) => s.includes('roster-tripwire-hook.mjs')));
  assert.equal(roster.length, 1, 'legacy exec-form entry dropped, exactly one shell-form entry remains');
  assert.match(roster[0]!.command, /^node '.*roster-tripwire-hook\.mjs'$/);
  assert.equal(roster[0]!.args, undefined, 'no leftover args field');
});

test('installHook(claude): valid SessionStart + malformed PostToolUse → NOTHING written, both skipped', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  // SessionStart is fine (banner would install), but PostToolUse is malformed.
  // A malformed event in EITHER hook must leave the whole file untouched.
  const raw = JSON.stringify({ hooks: { SessionStart: [], PostToolUse: 'garbage-not-an-array' } });
  writeFileSync(settingsPath, raw, 'utf8');
  const results = installHook('claude');
  for (const r of results) {
    assert.equal(r.status, 'skipped-malformed-config', `${r.kind} must skip (shared file is malformed)`);
  }
  assert.equal(readFileSync(settingsPath, 'utf8'), raw, 'file left byte-for-byte untouched (no banner write)');
});

test('installHook(claude): malformed non-object hooks value → skipped, file untouched (B3)', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  const raw = JSON.stringify({ hooks: 'not-an-object' });
  writeFileSync(settingsPath, raw, 'utf8');
  for (const r of installHook('claude')) {
    assert.equal(r.status, 'skipped-malformed-config', `${r.kind} should skip on malformed hooks`);
  }
  assert.equal(readFileSync(settingsPath, 'utf8'), raw, 'file left byte-for-byte untouched');
});

test('installHook(claude): preserves a pre-existing user PostToolUse entry', () => {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "user posttooluse"' }] },
        ],
      },
    }),
  );

  installHook('claude');

  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const all = settings.hooks.PostToolUse.flatMap((g) => g.hooks);
  assert.ok(all.some((h) => h.command === 'echo "user posttooluse"'), 'user entry preserved');
  assert.ok(
    all.some((h) => h.command.includes('roster-tripwire-hook.mjs')),
    'tripwire entry added',
  );
});

test('installHook(codex): does NOT install the tripwire PostToolUse hook', () => {
  const results = installHook('codex');
  assert.equal(results.find((r) => r.kind === 'tripwire'), undefined);

  const hooksJson = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')) as {
    hooks: { PostToolUse?: unknown };
  };
  assert.equal(hooksJson.hooks.PostToolUse, undefined);
  assert.equal(existsSync(join(codexHome, 'hooks', 'roster-tripwire-hook.mjs')), false);
});
