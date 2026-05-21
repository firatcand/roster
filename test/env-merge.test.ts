import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveAgentEnv } from '../src/lib/env-merge.ts';

type Fixture = { root: string; cleanup: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-env-merge-'));
  mkdirSync(join(root, 'gtm', 'sdr'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeEnv(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

// ──────────────────────────────────────────────────────────────────────
// SPEC §Risks acceptance trio (unset / empty / defined)
// ──────────────────────────────────────────────────────────────────────

test('resolveAgentEnv: missing agent .env inherits workspace', () => {
  const { root, cleanup } = fixture();
  try {
    writeEnv(join(root, '.env'), ['OPENAI_API_KEY=sk-workspace', 'OTHER=keep']);
    // No agent .env.
    const env = resolveAgentEnv(root, 'gtm/sdr');
    assert.equal(env.OPENAI_API_KEY, 'sk-workspace');
    assert.equal(env.OTHER, 'keep');
  } finally {
    cleanup();
  }
});

test('resolveAgentEnv: empty-string agent key explicit-unsets workspace value', () => {
  const { root, cleanup } = fixture();
  try {
    writeEnv(join(root, '.env'), ['OPENAI_API_KEY=sk-workspace', 'OTHER=keep']);
    writeEnv(join(root, 'gtm', 'sdr', '.env'), ['OPENAI_API_KEY=']);
    const env = resolveAgentEnv(root, 'gtm/sdr');
    assert.ok(!('OPENAI_API_KEY' in env), 'agent K= should mask workspace value');
    assert.equal(env.OTHER, 'keep');
  } finally {
    cleanup();
  }
});

test('resolveAgentEnv: defined agent key overrides workspace value', () => {
  const { root, cleanup } = fixture();
  try {
    writeEnv(join(root, '.env'), ['OPENAI_API_KEY=sk-workspace']);
    writeEnv(join(root, 'gtm', 'sdr', '.env'), ['OPENAI_API_KEY=sk-agent']);
    const env = resolveAgentEnv(root, 'gtm/sdr');
    assert.equal(env.OPENAI_API_KEY, 'sk-agent');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// Supporting cases
// ──────────────────────────────────────────────────────────────────────

test('resolveAgentEnv: empty-string in workspace (no agent file) treated as unset', () => {
  const { root, cleanup } = fixture();
  try {
    writeEnv(join(root, '.env'), ['OPENAI_API_KEY=', 'OTHER=keep']);
    const env = resolveAgentEnv(root, 'gtm/sdr');
    assert.ok(!('OPENAI_API_KEY' in env));
    assert.equal(env.OTHER, 'keep');
  } finally {
    cleanup();
  }
});

test('resolveAgentEnv: both files missing returns empty record', () => {
  const { root, cleanup } = fixture();
  try {
    const env = resolveAgentEnv(root, 'gtm/sdr');
    assert.deepEqual(env, {});
  } finally {
    cleanup();
  }
});

test('resolveAgentEnv: agent-only key (not in workspace) present in result', () => {
  const { root, cleanup } = fixture();
  try {
    writeEnv(join(root, '.env'), ['OTHER=keep']);
    writeEnv(join(root, 'gtm', 'sdr', '.env'), ['APOLLO_API_KEY=apify-xyz']);
    const env = resolveAgentEnv(root, 'gtm/sdr');
    assert.equal(env.APOLLO_API_KEY, 'apify-xyz');
    assert.equal(env.OTHER, 'keep');
  } finally {
    cleanup();
  }
});

test('resolveAgentEnv: permission-denied on agent .env treated as absent', { skip: platform() === 'win32' }, () => {
  const { root, cleanup } = fixture();
  try {
    writeEnv(join(root, '.env'), ['OPENAI_API_KEY=sk-workspace']);
    const agentEnvPath = join(root, 'gtm', 'sdr', '.env');
    writeEnv(agentEnvPath, ['SHOULD_NOT_LOAD=x']);
    chmodSync(agentEnvPath, 0o000);
    try {
      const env = resolveAgentEnv(root, 'gtm/sdr');
      assert.equal(env.OPENAI_API_KEY, 'sk-workspace');
      assert.ok(!('SHOULD_NOT_LOAD' in env));
    } finally {
      chmodSync(agentEnvPath, 0o600);
    }
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// Perf: SPEC L276 — p95 < 5 ms per call
// ──────────────────────────────────────────────────────────────────────

test('resolveAgentEnv: p95 < 5ms per call (100 iterations)', () => {
  const { root, cleanup } = fixture();
  try {
    const workspaceKeys = Array.from({ length: 20 }, (_, i) => `WORKSPACE_KEY_${i}=value-${i}`);
    const agentKeys = Array.from({ length: 5 }, (_, i) => `AGENT_KEY_${i}=override-${i}`);
    writeEnv(join(root, '.env'), workspaceKeys);
    writeEnv(join(root, 'gtm', 'sdr', '.env'), agentKeys);

    // Warm-up read to amortise cold-disk effects out of the p95 sample.
    resolveAgentEnv(root, 'gtm/sdr');

    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      resolveAgentEnv(root, 'gtm/sdr');
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[94]!;
    assert.ok(p95 < 5, `p95 was ${p95.toFixed(3)}ms — expected < 5ms`);
  } finally {
    cleanup();
  }
});
