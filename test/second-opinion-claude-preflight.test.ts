import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudePreflight } from '../src/lib/second-opinion/claude-preflight.ts';

function withTmpHome<T>(fn: (homeDir: string, cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'roster-claude-preflight-'));
  const homeDir = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  try {
    return fn(homeDir, cwd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Write a subscription credential signal: ~/.claude.json with oauthAccount.
function writeOauthState(homeDir: string): void {
  writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
}

function failureChecks(r: ReturnType<typeof runClaudePreflight>): string[] {
  return r.ok ? [] : r.failures.map((f) => f.check);
}

test('claude-preflight: clean subscription env → ok', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('claude-preflight: credentials file (linux layout) also counts as subscription', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', '.credentials.json'), '{}');
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('claude-preflight: ANTHROPIC_API_KEY set → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const r = runClaudePreflight({ homeDir, cwd, env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('env_anthropic_api_key'));
  });
});

test('claude-preflight: ANTHROPIC_AUTH_TOKEN set → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const r = runClaudePreflight({ homeDir, cwd, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('env_anthropic_auth_token'));
  });
});

test('claude-preflight: Bedrock flag → refuse; Vertex flag → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const bedrock = runClaudePreflight({ homeDir, cwd, env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    assert.equal(bedrock.ok, false);
    assert.ok(failureChecks(bedrock).includes('env_bedrock_vertex'));

    const vertex = runClaudePreflight({ homeDir, cwd, env: { CLAUDE_CODE_USE_VERTEX: 'true' } });
    assert.equal(vertex.ok, false);
    assert.ok(failureChecks(vertex).includes('env_bedrock_vertex'));
  });
});

test('claude-preflight: bedrock/vertex flag set to 0/false/empty is treated as unset', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const r = runClaudePreflight({
      homeDir,
      cwd,
      env: { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' },
    });
    assert.equal(r.ok, true);
  });
});

test('claude-preflight: apiKeyHelper in user settings → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/get-key.sh' }));
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('api_key_helper'));
  });
});

test('claude-preflight: apiKeyHelper in project settings of the spawn cwd → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'helper' }));
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('api_key_helper'));
  });
});

test('claude-preflight: apiKeyHelper in project settings.local.json → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'helper' }));
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('api_key_helper'));
  });
});

test('claude-preflight: malformed settings.json fails closed', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'settings.json'), '{ not json');
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('api_key_helper'));
  });
});

test('claude-preflight: settings.json without apiKeyHelper passes', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('claude-preflight: no subscription credential at all → refuse', () => {
  withTmpHome((homeDir, cwd) => {
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('subscription_credential'));
  });
});

test('claude-preflight: ~/.claude.json WITHOUT oauthAccount does not count as credential', () => {
  withTmpHome((homeDir, cwd) => {
    writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ someOtherState: true }));
    const r = runClaudePreflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('subscription_credential'));
  });
});

test('claude-preflight: keychain override signals credential without a file (macOS seam)', () => {
  withTmpHome((homeDir, cwd) => {
    const r = runClaudePreflight({ homeDir, cwd, env: {}, assumeKeychainCredential: true });
    assert.equal(r.ok, true);
  });
});

test('claude-preflight: multiple failures accumulate', () => {
  withTmpHome((homeDir, cwd) => {
    const r = runClaudePreflight({
      homeDir,
      cwd,
      env: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: 'true' },
    });
    assert.equal(r.ok, false);
    const checks = failureChecks(r);
    assert.ok(checks.includes('env_anthropic_api_key'));
    assert.ok(checks.includes('env_bedrock_vertex'));
    assert.ok(checks.includes('subscription_credential'));
  });
});

test('claude-preflight: every failure carries actual/expected/remedy', () => {
  withTmpHome((homeDir, cwd) => {
    const r = runClaudePreflight({ homeDir, cwd, env: { ANTHROPIC_API_KEY: 'k' } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    for (const f of r.failures) {
      assert.ok(f.actual.length > 0);
      assert.ok(f.expected.length > 0);
      assert.ok(f.remedy.length > 0);
    }
  });
});

// --- Codex impl-pass round-3: settings scope coverage ---

test('claude-preflight: apiKeyHelper in an ANCESTOR project root refuses (spawn from subdir)', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'helper' }));
    const nested = join(cwd, 'packages', 'web');
    mkdirSync(nested, { recursive: true });
    const r = runClaudePreflight({ homeDir, cwd: nested, env: {} });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('api_key_helper'));
  });
});

test('claude-preflight: apiKeyHelper in managed settings refuses', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const managed = join(homeDir, 'managed-settings.json');
    writeFileSync(managed, JSON.stringify({ apiKeyHelper: '/corp/helper.sh' }));
    const r = runClaudePreflight({ homeDir, cwd, env: {}, managedSettingsPaths: [managed] });
    assert.equal(r.ok, false);
    assert.ok(failureChecks(r).includes('api_key_helper'));
  });
});

test('claude-preflight: malformed managed settings fails closed', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const managed = join(homeDir, 'managed-settings.json');
    writeFileSync(managed, '{ nope');
    const r = runClaudePreflight({ homeDir, cwd, env: {}, managedSettingsPaths: [managed] });
    assert.equal(r.ok, false);
  });
});

test('claude-preflight: clean managed settings passes', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    const managed = join(homeDir, 'managed-settings.json');
    writeFileSync(managed, JSON.stringify({ permissions: {} }));
    const r = runClaudePreflight({ homeDir, cwd, env: {}, managedSettingsPaths: [managed] });
    assert.equal(r.ok, true);
  });
});

test('claude-preflight: ANY truthy CLAUDE_CODE_USE_* provider switch refuses (Foundry & future)', () => {
  withTmpHome((homeDir, cwd) => {
    writeOauthState(homeDir);
    for (const flag of ['CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_SOME_FUTURE_PROVIDER']) {
      const r = runClaudePreflight({ homeDir, cwd, env: { [flag]: '1' } });
      assert.equal(r.ok, false, flag);
      assert.ok(failureChecks(r).includes('env_bedrock_vertex'), flag);
    }
  });
});
