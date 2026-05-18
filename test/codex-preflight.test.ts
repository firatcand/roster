import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexPreflight, type PreflightFailure } from '../src/lib/codex-preflight.ts';

function makeFakeCodexHome(): { home: string; codex: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'roster-codex-preflight-'));
  const codex = join(home, '.codex');
  mkdirSync(codex, { recursive: true });
  return { home, codex, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function writeAuth(codex: string, content: Record<string, unknown>): void {
  writeFileSync(join(codex, 'auth.json'), JSON.stringify(content), 'utf8');
}

function writeConfig(codex: string, content: string): void {
  writeFileSync(join(codex, 'config.toml'), content, 'utf8');
}

function failuresByCheck(failures: PreflightFailure[]): Record<string, PreflightFailure> {
  const out: Record<string, PreflightFailure> = {};
  for (const f of failures) out[f.check] = f;
  return out;
}

test('preflight: happy path (auth_mode=chatgpt, clean env, no config) → ok with attestation', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    const result = runCodexPreflight({ homeDir: fx.home, env: { PATH: '/usr/bin' } });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.attestation.auth_mode, 'chatgpt');
      assert.equal(result.attestation.env_policy, 'cleared');
      assert.equal(result.attestation.codex_home, fx.codex);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: missing auth.json → check auth_mode fails', () => {
  const fx = makeFakeCodexHome();
  try {
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['auth_mode'], 'expected auth_mode failure');
      assert.match(f['auth_mode']!.remedy, /codex login/);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: auth_mode is apikey (not chatgpt) → fails', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'apikey', OPENAI_API_KEY: null });
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['auth_mode']);
      assert.equal(f['auth_mode']!.actual, 'apikey');
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: OPENAI_API_KEY set in auth.json → fails', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-leak' });
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['openai_api_key_in_auth']);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: env CODEX_API_KEY set → fails check env_codex_api_key', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    const result = runCodexPreflight({ homeDir: fx.home, env: { CODEX_API_KEY: 'x' } });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['env_codex_api_key']);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: env OPENAI_API_KEY + ANTHROPIC_API_KEY both set → both reported', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    const result = runCodexPreflight({
      homeDir: fx.home,
      env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['env_openai_api_key']);
      assert.ok(f['env_anthropic_api_key']);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: config.toml with [model_providers.foo] → fails', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    writeConfig(fx.codex, '[model_providers.foo]\nbase_url = "https://x.com"\n');
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['config_model_providers']);
      assert.match(f['config_model_providers']!.actual, /model_providers\.foo/);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: config.toml with top-level model_provider = "custom" → fails check config_active_model_provider', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    writeConfig(fx.codex, 'model_provider = "custom"\n');
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['config_active_model_provider']);
      assert.match(f['config_active_model_provider']!.actual, /model_provider = "custom"/);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: config.toml with model_provider = "openai" → passes', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    writeConfig(fx.codex, 'model_provider = "openai"\n');
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('preflight: model_provider in another section is ignored', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    writeConfig(fx.codex, '[some_section]\nmodel_provider = "custom"\n');
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('preflight: CODEX_HOME set to wrong path → fails check codex_home', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    const result = runCodexPreflight({ homeDir: fx.home, env: { CODEX_HOME: '/somewhere/else' } });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const f = failuresByCheck(result.failures);
      assert.ok(f['codex_home']);
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: CODEX_HOME set to canonical $HOME/.codex → passes', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    const result = runCodexPreflight({ homeDir: fx.home, env: { CODEX_HOME: fx.codex } });
    assert.equal(result.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('preflight: collects ALL failures (no short-circuit)', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' });
    writeConfig(fx.codex, 'model_provider = "custom"\n[model_providers.foo]\nbase_url = "x"\n');
    const result = runCodexPreflight({
      homeDir: fx.home,
      env: {
        CODEX_API_KEY: '1',
        OPENAI_API_KEY: '2',
        ANTHROPIC_API_KEY: '3',
        CODEX_HOME: '/wrong/path',
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const checks = result.failures.map((f) => f.check).sort();
      assert.deepEqual(
        checks,
        [
          'auth_mode',
          'codex_home',
          'config_active_model_provider',
          'config_model_providers',
          'env_anthropic_api_key',
          'env_codex_api_key',
          'env_openai_api_key',
          'openai_api_key_in_auth',
        ].sort(),
      );
    }
  } finally {
    fx.cleanup();
  }
});

test('preflight: comments in config.toml are ignored', () => {
  const fx = makeFakeCodexHome();
  try {
    writeAuth(fx.codex, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    writeConfig(fx.codex, '# model_provider = "custom"\n# [model_providers.bogus]\n');
    const result = runCodexPreflight({ homeDir: fx.home, env: {} });
    assert.equal(result.ok, true);
  } finally {
    fx.cleanup();
  }
});
