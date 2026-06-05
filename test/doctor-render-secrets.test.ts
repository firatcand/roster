// Characterization tests for renderSecretsSection (ROS-119, Phase 2 batch 1).
// These pin the EXACT rendered output of the doctor "Secrets" section before
// it is refactored. They encode current behavior — including the subtle
// slice(0,10)-then-skip-ok ordering and the "… (N more)" truncation lines.
// Negative control per case is noted inline: the named mutation would flip it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSecretsSection } from '../src/commands/doctor.ts';
import type { SecretsAuditResult } from '../src/lib/doctor-secrets-audit.ts';

// chalk may or may not emit ANSI depending on TTY detection; strip so the pin
// is on textual content (symbols, words, counts, ordering, truncation).
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const strip = (lines: string[]): string[] => lines.map((l) => l.replace(ANSI, ''));

const clean: SecretsAuditResult = {
  ok: true,
  envPermissions: { status: 'absent' },
  agentEnvPermissions: { status: 'ok', items: [] },
  envKeyReferences: { status: 'ok', envKeys: [], missing: [] },
  templateSecretLiterals: { status: 'ok', hits: [] },
  promptLeak: { status: 'ok', items: [] },
  agentEnvRefs: { status: 'ok', errors: [], warns: [] },
  agentEnvRedundancy: { status: 'ok', items: [] },
};

const render = (over: Partial<SecretsAuditResult>): string[] =>
  strip(renderSecretsSection({ ...clean, ...over }));

test('all-clean audit renders nothing (early return)', () => {
  // negative control: flip any sub-status to fail/warn → non-empty.
  assert.deepEqual(renderSecretsSection(clean), []);
});

test('env permissions fail → line + chmod hint', () => {
  // negative control: status 'ok' → "OK" line, no hint.
  assert.deepEqual(
    render({
      envPermissions: { status: 'fail', path: '/.env', mode: '0644', expected: '0600', autoFixable: true },
    }),
    [
      '',
      'Secrets',
      '  ✗ .env permissions  FAIL (got 0644, expected 0600)',
      '      → Run `roster doctor --fix` to chmod 0600.',
    ],
  );
});

test('agent-env-refs: 12 errors + 7 warns → counts, two truncations, fix hint', () => {
  // negative control: drop one error so errors.length === 10 → no "… more errors" line.
  const errors = Array.from({ length: 12 }, (_, i) => ({
    agent: `a${i}`,
    binding: 'slack',
    key: `KEY_${i}`,
    required: true,
  }));
  const warns = Array.from({ length: 7 }, (_, i) => ({
    agent: `w${i}`,
    binding: 'github',
    key: `WKEY_${i}`,
    required: false,
  }));
  const out = render({ agentEnvRefs: { status: 'fail', errors, warns } });
  assert.deepEqual(out, [
    '',
    'Secrets',
    '  ✗ agent-env-refs    FAIL (12 errors, 7 warns)',
    ...errors.slice(0, 10).map((m) => `      - ${m.agent}: ${m.key} (tools.${m.binding}, required)`),
    '      … (2 more errors)',
    ...warns.slice(0, 5).map((m) => `      - ${m.agent}: ${m.key} (tools.${m.binding}, optional)`),
    '      … (2 more warns)',
    '      → Run `roster doctor --fix` to append missing keys to /.env.',
  ]);
});

test('agent .env perms fail: slice(0,10)-then-skip-ok ordering preserved', () => {
  // The loop slices the first 10 items, THEN skips ok ones — so ok items inside
  // the window consume a slot and simply do not render. negative control:
  // moving an ok item out of the first 10 would change which fails appear.
  const items = [
    { status: 'ok' as const, agentPath: 'gtm/a0', envPath: 'x', mode: '0600' },
    { status: 'fail' as const, agentPath: 'gtm/a1', envPath: 'x', mode: '0666', expected: '0600' as const, autoFixable: true as const },
    { status: 'ok' as const, agentPath: 'gtm/a2', envPath: 'x', mode: '0600' },
    { status: 'warn' as const, agentPath: 'gtm/a3', envPath: 'x', mode: '0644', expected: '0600' as const, autoFixable: true as const },
  ];
  const out = render({ agentEnvPermissions: { status: 'fail', items } });
  assert.deepEqual(out, [
    '',
    'Secrets',
    '  ✗ agent .env perms  FAIL (1 world-writable, 1 other not 0600)',
    '      - gtm/a1/.env (got 0666, expected 0600)',
    '      - gtm/a3/.env (got 0644, expected 0600)',
    '      → Run `roster doctor --fix` to chmod 0600.',
  ]);
});

test('agent .env redundancy warn: 12 items → first 10 + "… (2 more)" + hint', () => {
  // negative control: 10 items → no "… (2 more)" line.
  const items = Array.from({ length: 12 }, (_, i) => ({
    agentEnvPath: `gtm/a${i}/.env`,
    line: i + 1,
    key: `DUP_${i}`,
  }));
  const out = render({ agentEnvRedundancy: { status: 'warn', items } });
  assert.deepEqual(out, [
    '',
    'Secrets',
    '  ! agent .env redundancy  WARN (12 entries)',
    ...items.slice(0, 10).map((it) => `      - ${it.agentEnvPath}:${it.line}  ${it.key} matches workspace .env`),
    '      … (2 more)',
    '      → Run `roster doctor --fix` to prompt removal of redundant lines.',
  ]);
});

test('templates fail + prompt-leak warn compose in source order under one header', () => {
  // negative control: swapping the section order in the source would reorder these.
  const out = render({
    templateSecretLiterals: {
      status: 'fail',
      hits: [{ file: 'templates/x.md', line: 3, patternId: 'openai-sk', snippet: 'sk-abc' }],
    },
    promptLeak: {
      status: 'warn',
      items: [{ schedule: 'sdr-cold', reference: '$SLACK_TOKEN', source: 'spec-doc', file: 'spec.md', line: 9 }],
    },
  });
  assert.deepEqual(out, [
    '',
    'Secrets',
    '  ✗ template literals  FAIL (1 hit)',
    '      - templates/x.md:3 [openai-sk] sk-abc',
    '  ! prompt-leak       WARN (1 reference)',
    '      - sdr-cold: $SLACK_TOKEN in spec.md:9',
  ]);
});

test('env-key refs fail: singular/path detail', () => {
  // negative control: status 'ok' → no env-key-refs line at all.
  const out = render({
    envKeyReferences: {
      status: 'fail',
      envKeys: ['API_KEY'],
      missing: [{ key: 'API_KEY', references: [{ file: 'config/project.yaml', line: 4 }] }],
    },
  });
  assert.deepEqual(out, [
    '',
    'Secrets',
    '  ✗ env-key refs       FAIL (1 unreferenced)',
    '      - API_KEY (referenced in config/project.yaml:4)',
  ]);
});
