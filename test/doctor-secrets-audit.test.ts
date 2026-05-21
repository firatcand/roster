import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditEnvKeyReferences,
  auditEnvPermissions,
  auditPromptLeak,
  auditTemplateSecretLiterals,
  runSecretsAudit,
} from '../src/lib/doctor-secrets-audit.ts';
import { parseEnvKeys } from '../src/lib/dotenv-parse.ts';

function makeTmpCwd(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'roster-secrets-audit-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ──────────────────────────────────────────────────────────────────────
// parseEnvKeys
// ──────────────────────────────────────────────────────────────────────

test('parseEnvKeys: standard KEY=VALUE lines', () => {
  const keys = parseEnvKeys(['A=1', 'B=two', 'C_D=3'].join('\n'));
  assert.deepEqual(keys, ['A', 'B', 'C_D']);
});

test('parseEnvKeys: ignores comments and blanks', () => {
  const keys = parseEnvKeys(['# header', '', 'A=1', '#B=2', 'C=3'].join('\n'));
  assert.deepEqual(keys, ['A', 'C']);
});

test('parseEnvKeys: handles export prefix', () => {
  const keys = parseEnvKeys(['export A=1', 'export  B=two'].join('\n'));
  assert.deepEqual(keys, ['A', 'B']);
});

test('parseEnvKeys: dedupes repeated keys', () => {
  const keys = parseEnvKeys(['A=1', 'A=2'].join('\n'));
  assert.deepEqual(keys, ['A']);
});

test('parseEnvKeys: rejects malformed lines', () => {
  const keys = parseEnvKeys(['1=invalid', '=empty', 'A=1', '-B=2'].join('\n'));
  assert.deepEqual(keys, ['A']);
});

// ──────────────────────────────────────────────────────────────────────
// auditEnvPermissions
// ──────────────────────────────────────────────────────────────────────

test('auditEnvPermissions: absent .env → status absent', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const r = auditEnvPermissions(dir);
    assert.equal(r.status, 'absent');
  } finally {
    cleanup();
  }
});

test('auditEnvPermissions: 0600 .env → status ok', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'A=1\n');
    chmodSync(envPath, 0o600);
    const r = auditEnvPermissions(dir);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.mode, '0600');
  } finally {
    cleanup();
  }
});

test('auditEnvPermissions: 0644 .env → status fail + autoFixable', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'A=1\n');
    chmodSync(envPath, 0o644);
    const r = auditEnvPermissions(dir);
    assert.equal(r.status, 'fail');
    if (r.status !== 'fail') return;
    assert.equal(r.mode, '0644');
    assert.equal(r.expected, '0600');
    assert.equal(r.autoFixable, true);
  } finally {
    cleanup();
  }
});

test('auditEnvPermissions: world-readable 0666 → status fail', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'A=1\n');
    chmodSync(envPath, 0o666);
    const r = auditEnvPermissions(dir);
    assert.equal(r.status, 'fail');
  } finally {
    cleanup();
  }
});

test('auditEnvPermissions: ROSTER_PLATFORM=win32 → skip-platform', () => {
  const prev = process.env['ROSTER_PLATFORM'];
  process.env['ROSTER_PLATFORM'] = 'win32';
  try {
    const { dir, cleanup } = makeTmpCwd();
    try {
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'A=1\n');
      const r = auditEnvPermissions(dir);
      assert.equal(r.status, 'skip-platform');
    } finally {
      cleanup();
    }
  } finally {
    if (prev === undefined) delete process.env['ROSTER_PLATFORM'];
    else process.env['ROSTER_PLATFORM'] = prev;
  }
});

// ──────────────────────────────────────────────────────────────────────
// auditEnvKeyReferences
// ──────────────────────────────────────────────────────────────────────

function writeConfigYaml(cwd: string, fn: string, agent: string, project: string, name: string, content: string): void {
  const dir = join(cwd, fn, agent, 'projects', project, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
}

test('auditEnvKeyReferences: no .env, no configs → ok empty', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.envKeys, []);
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

test('auditEnvKeyReferences: config references key present in .env → ok', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    writeConfigYaml(dir, 'gtm', 'sdr', '_demo', 'default.yaml', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.envKeys, ['APOLLO_API_KEY']);
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

test('auditEnvKeyReferences: config references key missing from .env → fail', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'OTHER=1\n');
    writeConfigYaml(dir, 'gtm', 'sdr', '_demo', 'default.yaml', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0]!.key, 'APOLLO_API_KEY');
    assert.equal(r.missing[0]!.references.length, 1);
    assert.match(r.missing[0]!.references[0]!.file, /default\.yaml$/);
  } finally {
    cleanup();
  }
});

// Symmetry with resolveAgentEnv (env-merge.ts): K= in workspace .env means
// "explicit unset" and must NOT satisfy ${K} references. Otherwise doctor
// passes while runtime dispatch fails with a missing-key error.
test('auditEnvKeyReferences: empty-string workspace value does NOT satisfy reference', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=\n');
    writeConfigYaml(dir, 'gtm', 'sdr', '_demo', 'default.yaml', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing[0]!.key, 'APOLLO_API_KEY');
    assert.deepEqual(r.envKeys, [], 'empty-valued keys are excluded from envKeys');
  } finally {
    cleanup();
  }
});

test('auditEnvKeyReferences: $BAREWORD form also detected', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeConfigYaml(dir, 'gtm', 'sdr', '_demo', 'default.yaml', 'token: $SLACK_TOKEN\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing[0]!.key, 'SLACK_TOKEN');
  } finally {
    cleanup();
  }
});

test('auditEnvKeyReferences: well-known shell vars ($HOME, $PATH) are not flagged', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeConfigYaml(dir, 'gtm', 'sdr', '_demo', 'default.yaml', 'path: $HOME/logs\nother: $PATH\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

test('auditEnvKeyReferences: top-level roster/ and dotdirs are skipped', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    // Write a config under roster/ — should be ignored.
    mkdirSync(join(dir, 'roster', 'gtm', 'sdr', 'projects', '_demo', 'config'), { recursive: true });
    writeFileSync(join(dir, 'roster', 'gtm', 'sdr', 'projects', '_demo', 'config', 'x.yaml'), 'key: ${SHOULD_NOT_BE_FLAGGED}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// auditTemplateSecretLiterals
// ──────────────────────────────────────────────────────────────────────

function makeRosterRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-root-'));
  mkdirSync(join(root, 'templates'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('auditTemplateSecretLiterals: clean templates → ok', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFileSync(join(root, 'templates', 'a.md'), '# safe content\n');
    const r = auditTemplateSecretLiterals(root);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.hits, []);
  } finally {
    cleanup();
  }
});

test('auditTemplateSecretLiterals: detects sk- literal', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    // 32-char sk- string
    writeFileSync(join(root, 'templates', 'leak.md'), 'key=sk-abcdefghij0123456789abcdefgh\n');
    const r = auditTemplateSecretLiterals(root);
    assert.equal(r.status, 'fail');
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.patternId, 'openai-sk');
    // Redactor keeps a 6-char prefix; the rest is masked.
    assert.match(r.hits[0]!.snippet, /sk-abc\*+/);
    assert.doesNotMatch(r.hits[0]!.snippet, /defghij0123456789/);
  } finally {
    cleanup();
  }
});

test('auditTemplateSecretLiterals: detects AKIA + apify + GitHub patterns', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFileSync(join(root, 'templates', 'aws.env'), 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n');
    writeFileSync(join(root, 'templates', 'apify.txt'), 'TOKEN=apify_api_abcdefghij1234567890abcd\n');
    writeFileSync(join(root, 'templates', 'gh.txt'), 'GH_TOKEN=ghp_abcdefghij1234567890abcd\n');
    const r = auditTemplateSecretLiterals(root);
    assert.equal(r.status, 'fail');
    const ids = r.hits.map((h) => h.patternId).sort();
    assert.deepEqual(ids, ['apify', 'aws-access-key', 'github-token']);
  } finally {
    cleanup();
  }
});

test('auditTemplateSecretLiterals: short sk-foo strings are not flagged', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFileSync(join(root, 'templates', 'short.md'), 'placeholder: sk-foo\n');
    const r = auditTemplateSecretLiterals(root);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

test('auditTemplateSecretLiterals: recurses into subdirs', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    mkdirSync(join(root, 'templates', 'scaffold', 'nested'), { recursive: true });
    writeFileSync(
      join(root, 'templates', 'scaffold', 'nested', 'config.yaml'),
      'aws: AKIAIOSFODNN7EXAMPLE\n',
    );
    const r = auditTemplateSecretLiterals(root);
    assert.equal(r.status, 'fail');
    assert.match(r.hits[0]!.file, /scaffold\/nested\/config\.yaml$/);
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// auditPromptLeak
// ──────────────────────────────────────────────────────────────────────

test('auditPromptLeak: no .env → ok empty', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const r = auditPromptLeak(dir, [{ name: 'foo', tool: 'codex' }]);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.items, []);
  } finally {
    cleanup();
  }
});

test('auditPromptLeak: spec doc references env key → warn', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    mkdirSync(join(dir, '.roster', 'schedule-specs'), { recursive: true });
    writeFileSync(
      join(dir, '.roster', 'schedule-specs', 'sdr-cold.codex.fields.md'),
      'Run with token $APOLLO_API_KEY embedded.\n',
    );
    const r = auditPromptLeak(dir, [{ name: 'sdr-cold', tool: 'codex' }]);
    assert.equal(r.status, 'warn');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.schedule, 'sdr-cold');
    assert.equal(r.items[0]!.reference, '$APOLLO_API_KEY');
  } finally {
    cleanup();
  }
});

test('auditPromptLeak: spec doc references non-env $HOME → ok', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    mkdirSync(join(dir, '.roster', 'schedule-specs'), { recursive: true });
    writeFileSync(
      join(dir, '.roster', 'schedule-specs', 'sdr-cold.codex.fields.md'),
      'Workspace path: $HOME/my-roster.\n',
    );
    const r = auditPromptLeak(dir, [{ name: 'sdr-cold', tool: 'codex' }]);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// runSecretsAudit aggregate
// ──────────────────────────────────────────────────────────────────────

test('runSecretsAudit: empty cwd + clean templates → ok', () => {
  const { dir, cleanup } = makeTmpCwd();
  const { root, cleanup: cleanupRoot } = makeRosterRoot();
  try {
    const r = runSecretsAudit({ cwd: dir, rosterRoot: root, schedules: [] });
    assert.equal(r.ok, true);
  } finally {
    cleanup();
    cleanupRoot();
  }
});

test('runSecretsAudit: .env 0644 → ok=false (env permissions fail)', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  const { root, cleanup: cleanupRoot } = makeRosterRoot();
  try {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'A=1\n');
    chmodSync(envPath, 0o644);
    const r = runSecretsAudit({ cwd: dir, rosterRoot: root, schedules: [] });
    assert.equal(r.ok, false);
    assert.equal(r.envPermissions.status, 'fail');
  } finally {
    cleanup();
    cleanupRoot();
  }
});

test('runSecretsAudit: prompt-leak warning does NOT flip ok', () => {
  const { dir, cleanup } = makeTmpCwd();
  const { root, cleanup: cleanupRoot } = makeRosterRoot();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    chmodSync(join(dir, '.env'), 0o600);
    mkdirSync(join(dir, '.roster', 'schedule-specs'), { recursive: true });
    writeFileSync(
      join(dir, '.roster', 'schedule-specs', 'sdr.codex.fields.md'),
      'leak: $APOLLO_API_KEY\n',
    );
    const r = runSecretsAudit({
      cwd: dir,
      rosterRoot: root,
      schedules: [{ name: 'sdr', tool: 'codex' }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.promptLeak.status, 'warn');
    assert.equal(r.promptLeak.items.length, 1);
  } finally {
    cleanup();
    cleanupRoot();
  }
});
