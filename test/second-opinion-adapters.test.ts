import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter, scrubEnv, resolveHostBinary, findGeminiDotenv } from '../src/lib/second-opinion/adapters.ts';

function withTmpHome<T>(fn: (homeDir: string, cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'roster-so-adapters-'));
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

// --- argv construction (brief travels via stdin, NEVER argv) ---

test('adapters: claude argv is print-mode with no prompt in argv', () => {
  const a = getAdapter('claude');
  const argv = a.buildArgv();
  assert.ok(argv.includes('-p'));
  for (const arg of argv) assert.ok(!arg.includes('review'), `prompt leaked into argv: ${arg}`);
});

test('adapters: codex argv is exec with stdin marker', () => {
  const a = getAdapter('codex');
  const argv = a.buildArgv();
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('-'));
});

test('adapters: gemini argv forces non-interactive -p with a static, non-sensitive pointer', () => {
  const argv = getAdapter('gemini').buildArgv();
  assert.equal(argv[0], '-p');
  assert.equal(argv.length, 2);
  assert.match(argv[1]!, /stdin/);
});

// --- env scrub ---

test('scrubEnv: strips listed keys, preserves the rest', () => {
  const env = { ANTHROPIC_API_KEY: 'k', PATH: '/usr/bin', HOME: '/h' };
  const scrubbed = scrubEnv(env, ['ANTHROPIC_API_KEY']);
  assert.equal(scrubbed['ANTHROPIC_API_KEY'], undefined);
  assert.equal(scrubbed['PATH'], '/usr/bin');
  assert.equal(scrubbed['HOME'], '/h');
  // original untouched
  assert.equal(env['ANTHROPIC_API_KEY'], 'k');
});

test('adapters: claude scrub covers API keys + the whole CLAUDE_CODE_USE_* family', () => {
  const a = getAdapter('claude');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(a.scrubEnvKeys.includes(k), `missing ${k}`);
  }
  const scrubbed = scrubEnv(
    { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_FUTURE_PROVIDER: '1', PATH: '/usr/bin' },
    a.scrubEnvKeys,
    a.scrubEnvPrefixes ?? [],
  );
  assert.equal(scrubbed['CLAUDE_CODE_USE_BEDROCK'], undefined);
  assert.equal(scrubbed['CLAUDE_CODE_USE_FOUNDRY'], undefined);
  assert.equal(scrubbed['CLAUDE_CODE_USE_FUTURE_PROVIDER'], undefined);
  assert.equal(scrubbed['PATH'], '/usr/bin');
});

test('adapters: codex scrub list covers OPENAI/CODEX API keys', () => {
  const keys = getAdapter('codex').scrubEnvKeys;
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY']) assert.ok(keys.includes(k), `missing ${k}`);
});

test('adapters: gemini scrub list covers GEMINI/GOOGLE API keys', () => {
  const keys = getAdapter('gemini').scrubEnvKeys;
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) assert.ok(keys.includes(k), `missing ${k}`);
});

// --- preflights (wiring; deep matrices live in the per-host preflight tests) ---

test('adapters: claude preflight delegates to runClaudePreflight (clean → ok)', () => {
  withTmpHome((homeDir, cwd) => {
    writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    const r = getAdapter('claude').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('adapters: claude preflight refuses on API key', () => {
  withTmpHome((homeDir, cwd) => {
    writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    const r = getAdapter('claude').preflight({ homeDir, cwd, env: { ANTHROPIC_API_KEY: 'k' } });
    assert.equal(r.ok, false);
  });
});

test('adapters: codex preflight refuses without chatgpt auth.json', () => {
  withTmpHome((homeDir, cwd) => {
    const r = getAdapter('codex').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.failures.length > 0);
  });
});

test('adapters: codex preflight passes with chatgpt auth.json', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(join(homeDir, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
    const r = getAdapter('codex').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('adapters: gemini preflight refuses on API key even with oauth creds', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: { GEMINI_API_KEY: 'k' } });
    assert.equal(r.ok, false);
  });
});

test('adapters: gemini preflight refuses without oauth creds', () => {
  withTmpHome((homeDir, cwd) => {
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
  });
});

test('adapters: gemini preflight passes with oauth creds and clean env', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('adapters: every preflight failure carries actual/expected/remedy', () => {
  withTmpHome((homeDir, cwd) => {
    for (const host of ['claude', 'codex', 'gemini'] as const) {
      const r = getAdapter(host).preflight({ homeDir, cwd, env: { ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k' } });
      assert.equal(r.ok, false, host);
      if (r.ok) continue;
      for (const f of r.failures) {
        assert.ok(f.check.length > 0, host);
        assert.ok(f.remedy.length > 0, host);
      }
    }
  });
});

// --- binary resolution ---

test('resolveHostBinary: ROSTER_<HOST>_PATH override wins', () => {
  assert.equal(resolveHostBinary('claude', { ROSTER_CLAUDE_PATH: '/opt/claude' }), '/opt/claude');
  assert.equal(resolveHostBinary('codex', { ROSTER_CODEX_PATH: '/opt/codex' }), '/opt/codex');
  assert.equal(resolveHostBinary('gemini', { ROSTER_GEMINI_PATH: '/opt/gemini' }), '/opt/gemini');
});

test('resolveHostBinary: returns null when not on PATH', () => {
  const r = resolveHostBinary('gemini', { PATH: '/nonexistent-dir-xyz' });
  assert.equal(r, null);
});

test('adapters: gemini preflight refuses on GOOGLE_APPLICATION_CREDENTIALS (Vertex ADC path)', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: { GOOGLE_APPLICATION_CREDENTIALS: '/sa.json' } });
    assert.equal(r.ok, false);
  });
});

test('adapters: gemini scrub list covers ADC + cloud-project vars', () => {
  const keys = getAdapter('gemini').scrubEnvKeys;
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
});

// --- gemini dotenv bypass (Codex impl-pass round-2 finding 1) ---

test('adapters: gemini preflight refuses when cwd .env carries GEMINI_API_KEY', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(cwd, '.env'), 'GEMINI_API_KEY=abc123\n');
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.failures.some((f) => f.check === 'dotenv_billing_key'));
  });
});

test('adapters: gemini preflight refuses on export-form key in parent-dir .env', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    const nested = join(cwd, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(cwd, '.env'), 'export GOOGLE_APPLICATION_CREDENTIALS=/sa.json\n');
    const r = getAdapter('gemini').preflight({ homeDir, cwd: nested, env: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.failures.some((f) => f.check === 'dotenv_billing_key'));
  });
});

test('adapters: gemini preflight passes when the dotenv has no billing keys', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(cwd, '.env'), '# workspace agent env\nSLACK_TOKEN=xoxb\nGEMINI_API_KEY=\n');
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, true);
  });
});

test('adapters: findGeminiDotenv prefers .gemini/.env over .env and falls back to home', () => {
  withTmpHome((homeDir, cwd) => {
    writeFileSync(join(cwd, '.env'), 'X=1\n');
    mkdirSync(join(cwd, '.gemini'), { recursive: true });
    writeFileSync(join(cwd, '.gemini', '.env'), 'Y=1\n');
    assert.equal(findGeminiDotenv(cwd, homeDir), join(cwd, '.gemini', '.env'));

    const empty = join(cwd, 'a');
    mkdirSync(empty, { recursive: true });
    rmSync(join(cwd, '.gemini'), { recursive: true, force: true });
    rmSync(join(cwd, '.env'));
    writeFileSync(join(homeDir, '.env'), 'Z=1\n');
    assert.equal(findGeminiDotenv(empty, homeDir), join(homeDir, '.env'));
  });
});

test('adapters: gemini preflight fails closed on unreadable dotenv', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(cwd, '.env'), 'GEMINI_API_KEY=abc\n', { mode: 0o000 });
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
  });
});

// --- gemini persisted auth selection (Codex impl-pass round-5 finding 1) ---

test('adapters: gemini refuses when settings.json selects vertex-ai auth (flat v1)', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(homeDir, '.gemini', 'settings.json'), JSON.stringify({ selectedAuthType: 'vertex-ai' }));
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.failures.some((f) => f.check === 'selected_auth_type'));
  });
});

test('adapters: gemini refuses when nested v2 security.auth.selectedType is non-oauth', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(
      join(homeDir, '.gemini', 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
    );
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.failures.some((f) => f.check === 'selected_auth_type'));
  });
});

test('adapters: gemini refuses on workspace .gemini/settings.json selecting non-oauth auth', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    mkdirSync(join(cwd, '.gemini'), { recursive: true });
    writeFileSync(join(cwd, '.gemini', 'settings.json'), JSON.stringify({ selectedAuthType: 'vertex-ai' }));
    const nested = join(cwd, 'sub');
    mkdirSync(nested, { recursive: true });
    const r = getAdapter('gemini').preflight({ homeDir, cwd: nested, env: {} });
    assert.equal(r.ok, false);
  });
});

test('adapters: gemini passes with oauth-personal selection or no selection', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(homeDir, '.gemini', 'settings.json'), JSON.stringify({ selectedAuthType: 'oauth-personal' }));
    assert.equal(getAdapter('gemini').preflight({ homeDir, cwd, env: {} }).ok, true);
    writeFileSync(join(homeDir, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark' }));
    assert.equal(getAdapter('gemini').preflight({ homeDir, cwd, env: {} }).ok, true);
  });
});

test('adapters: gemini fails closed on malformed settings.json', () => {
  withTmpHome((homeDir, cwd) => {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(homeDir, '.gemini', 'settings.json'), '{ nope');
    const r = getAdapter('gemini').preflight({ homeDir, cwd, env: {} });
    assert.equal(r.ok, false);
  });
});
