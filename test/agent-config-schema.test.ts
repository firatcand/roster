import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentConfigSchema, loadAgentConfig } from '../src/lib/agent-config-schema.ts';

const canonical = {
  agent: 'gtm/sdr',
  plans_dir: './plans/',
  guideline_refs: {
    voice: '/guidelines/voice.md',
    icps: '/guidelines/icps/',
    brand_book: '/guidelines/brand-book.md',
  },
  tools: {
    apollo: { env_var: 'APOLLO_API_KEY', required: true },
    slack: { env_var: 'SLACK_BOT_TOKEN', required: false },
  },
};

type WorkspaceLayout = {
  configContent?: string;
  configAt?: string;
  files?: string[];
  dirs?: string[];
};

function makeWorkspace(layout: WorkspaceLayout = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-agent-config-'));

  const agentDir = layout.configAt ?? 'gtm/sdr';
  mkdirSync(join(root, agentDir), { recursive: true });
  if (layout.configContent !== undefined) {
    writeFileSync(join(root, agentDir, 'config.yaml'), layout.configContent);
  }

  for (const f of layout.files ?? []) {
    const full = join(root, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
  }
  for (const d of layout.dirs ?? []) {
    mkdirSync(join(root, d), { recursive: true });
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function happyPathYaml(): string {
  return [
    'agent: gtm/sdr',
    'plans_dir: ./plans/',
    'guideline_refs:',
    '  voice: /guidelines/voice.md',
    '  icps: /guidelines/icps/',
    '  brand_book: /guidelines/brand-book.md',
    'tools:',
    '  apollo:',
    '    env_var: APOLLO_API_KEY',
    '    required: true',
    '  slack:',
    '    env_var: SLACK_BOT_TOKEN',
    '    required: false',
    '',
  ].join('\n');
}

function happyPathFiles(): WorkspaceLayout {
  return {
    files: ['guidelines/voice.md', 'guidelines/brand-book.md'],
    dirs: ['guidelines/icps'],
  };
}

// ---------- Pure schema tests (no fs) ----------

test('schema — accepts the canonical SPEC sample', () => {
  const parsed = agentConfigSchema.safeParse(canonical);
  assert.equal(parsed.success, true);
});

test('schema — accepts config without guideline_refs and tools', () => {
  const parsed = agentConfigSchema.safeParse({ agent: 'gtm/sdr', plans_dir: './plans/' });
  assert.equal(parsed.success, true);
});

test('schema — accepts empty tools mapping', () => {
  const parsed = agentConfigSchema.safeParse({ agent: 'gtm/sdr', plans_dir: './plans/', tools: {} });
  assert.equal(parsed.success, true);
});

test("schema — rejects agent missing the '/' separator", () => {
  const parsed = agentConfigSchema.safeParse({ ...canonical, agent: 'gtm' });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((i) => i.path[0] === 'agent'));
  }
});

test('schema — rejects uppercase in agent', () => {
  const parsed = agentConfigSchema.safeParse({ ...canonical, agent: 'Gtm/Sdr' });
  assert.equal(parsed.success, false);
});

test('schema — rejects lowercase env_var', () => {
  const parsed = agentConfigSchema.safeParse({
    ...canonical,
    tools: { apollo: { env_var: 'apollo_api_key', required: true } },
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((i) => i.message.includes('SCREAMING_SNAKE_CASE')));
  }
});

test('schema — rejects literal absolute fs path /Users/...', () => {
  const parsed = agentConfigSchema.safeParse({
    ...canonical,
    guideline_refs: { voice: '/Users/me/secrets.yaml' },
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(
      parsed.error.issues.some((i) => i.message.includes('workspace-root-relative')),
      'expected documented workspace-root-relative error',
    );
  }
});

test('schema — rejects ref missing leading slash', () => {
  const parsed = agentConfigSchema.safeParse({
    ...canonical,
    guideline_refs: { voice: 'guidelines/voice.md' },
  });
  assert.equal(parsed.success, false);
});

test('schema — rejects each forbidden fs prefix', () => {
  for (const pfx of ['/Users/', '/home/', '/etc/', '/var/', '/tmp/', '/opt/']) {
    const parsed = agentConfigSchema.safeParse({
      ...canonical,
      guideline_refs: { x: `${pfx}foo/bar.md` },
    });
    assert.equal(parsed.success, false, `expected rejection for prefix ${pfx}`);
  }
});

test('schema — rejects extra top-level keys (strict)', () => {
  const parsed = agentConfigSchema.safeParse({ ...canonical, unknown_field: 1 });
  assert.equal(parsed.success, false);
});

// ---------- Loader tests (fs-backed) ----------

test('loader — happy path returns ok with refsChecked', () => {
  const { root, cleanup } = makeWorkspace({ configContent: happyPathYaml(), ...happyPathFiles() });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.refsChecked, 3);
      assert.equal(result.config.agent, 'gtm/sdr');
    }
  } finally {
    cleanup();
  }
});

test('loader — missing file', () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.kind, 'missing-file');
    }
  } finally {
    cleanup();
  }
});

test('loader — yaml parse error', () => {
  const { root, cleanup } = makeWorkspace({ configContent: 'agent: gtm/sdr\n  bad: :\n' });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.kind, 'yaml-parse');
    }
  } finally {
    cleanup();
  }
});

test('loader — schema reject surfaces zod issues', () => {
  const { root, cleanup } = makeWorkspace({
    configContent: 'agent: not-a-valid-shape\nplans_dir: ./plans/\n',
  });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.every((e) => e.kind === 'schema'));
      assert.ok(result.errors.some((e) => e.path === 'agent'));
    }
  } finally {
    cleanup();
  }
});

test('loader — agent field mismatch when value disagrees with agentPath', () => {
  const cfg =
    'agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n  voice: /guidelines/voice.md\n';
  const { root, cleanup } = makeWorkspace({
    configContent: cfg,
    configAt: 'ops/sdr',
    files: ['guidelines/voice.md'],
  });
  try {
    const result = loadAgentConfig(root, 'ops/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.kind === 'agent-field-mismatch'));
    }
  } finally {
    cleanup();
  }
});

test('loader — ref-not-found when target file is missing', () => {
  const cfg =
    'agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n  voice: /guidelines/voice.md\n';
  const { root, cleanup } = makeWorkspace({ configContent: cfg });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.kind === 'ref-not-found' && e.ref === '/guidelines/voice.md'));
    }
  } finally {
    cleanup();
  }
});

test('loader — ref-shape-mismatch when trailing slash but target is a file', () => {
  const cfg =
    "agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n  voice: /guidelines/voice.md/\n";
  const { root, cleanup } = makeWorkspace({ configContent: cfg, files: ['guidelines/voice.md'] });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.kind === 'ref-shape-mismatch'));
    }
  } finally {
    cleanup();
  }
});

test('loader — ref-shape-mismatch when no trailing slash but target is a directory', () => {
  const cfg =
    'agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n  icps: /guidelines/icps\n';
  const { root, cleanup } = makeWorkspace({ configContent: cfg, dirs: ['guidelines/icps'] });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      const e = result.errors.find((x) => x.kind === 'ref-shape-mismatch');
      assert.ok(e);
      assert.ok(e!.message.includes("add '/'"));
    }
  } finally {
    cleanup();
  }
});

test('loader — rejects ref that escapes workspace via ..', () => {
  const cfg =
    'agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n  evil: /guidelines/../../etc/passwd\n';
  const { root, cleanup } = makeWorkspace({ configContent: cfg });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      const e = result.errors.find((x) => x.kind === 'ref-shape-mismatch');
      assert.ok(e);
      assert.ok(e!.message.includes('escapes outside workspace root'));
    }
  } finally {
    cleanup();
  }
});

test('loader — aggregates multiple errors (agent mismatch + missing ref)', () => {
  const cfg =
    'agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n  voice: /guidelines/voice.md\n  brand: /guidelines/brand-book.md\n';
  const { root, cleanup } = makeWorkspace({ configContent: cfg, configAt: 'ops/sdr' });
  try {
    const result = loadAgentConfig(root, 'ops/sdr');
    assert.equal(result.ok, false);
    if (!result.ok) {
      const kinds = new Set(result.errors.map((e) => e.kind));
      assert.ok(kinds.has('agent-field-mismatch'));
      assert.ok(kinds.has('ref-not-found'));
      assert.equal(result.errors.filter((e) => e.kind === 'ref-not-found').length, 2);
    }
  } finally {
    cleanup();
  }
});

test('loader — refsChecked counts every ref including dirs', () => {
  const { root, cleanup } = makeWorkspace({ configContent: happyPathYaml(), ...happyPathFiles() });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.refsChecked, 3);
    }
  } finally {
    cleanup();
  }
});

test('loader — empty guideline_refs returns refsChecked: 0', () => {
  const cfg = 'agent: gtm/sdr\nplans_dir: ./plans/\n';
  const { root, cleanup } = makeWorkspace({ configContent: cfg });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.refsChecked, 0);
    }
  } finally {
    cleanup();
  }
});

test('loader — YAML `guideline_refs:` (null) is treated as zero refs', () => {
  const cfg = 'agent: gtm/sdr\nplans_dir: ./plans/\nguideline_refs:\n';
  const { root, cleanup } = makeWorkspace({ configContent: cfg });
  try {
    const result = loadAgentConfig(root, 'gtm/sdr');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.refsChecked, 0);
    }
  } finally {
    cleanup();
  }
});
