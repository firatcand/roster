import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  founderManifestSchema,
  normalizeManifest,
  isSafeSkillName,
  DEFAULT_SOURCE,
  DEFAULT_REF,
  readFounderSkillsManifest,
} from '../src/lib/founder-skills/manifest-schema.ts';

test('applies default source + ref', () => {
  const m = founderManifestSchema.parse({ skills: ['pricing'] });
  assert.equal(m.source, DEFAULT_SOURCE);
  assert.equal(m.ref, DEFAULT_REF);
  const n = normalizeManifest(m);
  assert.deepEqual(n.skills, [{ name: 'pricing', ref: DEFAULT_REF }]);
});

test('per-skill ref overrides the top-level ref', () => {
  const m = founderManifestSchema.parse({
    ref: 'v1.0.0',
    skills: ['pricing', { name: 'seo', ref: 'v0.9.0' }],
  });
  const n = normalizeManifest(m);
  assert.deepEqual(n.skills, [
    { name: 'pricing', ref: 'v1.0.0' },
    { name: 'seo', ref: 'v0.9.0' },
  ]);
});

test('optional canonical skill_ref survives normalization without changing unjoined entries', () => {
  const m = founderManifestSchema.parse({
    ref: 'v1.0.0',
    skills: [
      'pricing',
      { name: 'seo', skill_ref: 'founder-skills:seo' },
    ],
  });
  assert.deepEqual(normalizeManifest(m).skills, [
    { name: 'pricing', ref: 'v1.0.0' },
    { name: 'seo', ref: 'v1.0.0', skillRef: 'founder-skills:seo' },
  ]);
});

test('rejects an empty skills list', () => {
  assert.throws(() => founderManifestSchema.parse({ skills: [] }));
});

test('rejects a non-kebab skill name', () => {
  assert.throws(() => founderManifestSchema.parse({ skills: ['Bad_Name'] }));
  assert.throws(() => founderManifestSchema.parse({ skills: ['../evil'] }));
});

test('rejects duplicate skill names at normalize', () => {
  const m = founderManifestSchema.parse({ skills: ['pricing', 'pricing'] });
  assert.throws(
    () => normalizeManifest(m),
    (error: unknown) => (error as { code?: unknown }).code === 'SKILL_REF_INVALID',
  );
});

test('isSafeSkillName guards path-traversal names', () => {
  assert.equal(isSafeSkillName('sales-skill'), true);
  assert.equal(isSafeSkillName('../../etc'), false);
  assert.equal(isSafeSkillName('a/b'), false);
  assert.equal(isSafeSkillName(''), false);
  assert.equal(isSafeSkillName(42), false);
});

test('manifest schema is closed and rejects malformed provenance', () => {
  assert.throws(() => founderManifestSchema.parse({
    source: 'https://github.com/owner/repo',
    skills: ['pricing'],
  }));
  assert.throws(() => founderManifestSchema.parse({
    skills: [{ name: 'pricing', skill_ref: 'pricing' }],
  }));
  assert.throws(() => founderManifestSchema.parse({
    skills: [{ name: 'pricing', credentials: 'forbidden' }],
  }));
  assert.throws(() => founderManifestSchema.parse({
    skills: ['pricing'],
    extra: true,
  }));
});

test('safe manifest reader distinguishes missing from malformed and never echoes secrets', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-founder-manifest-'));
  const token = `sk-${'Ab9_'.repeat(6)}`;
  try {
    assert.equal(readFounderSkillsManifest(cwd), null);
    writeFileSync(
      join(cwd, 'founder-skills.yaml'),
      'source: github:owner/repository\nref: main\nskills:\n  - name: pricing\n    skill_ref: founder-skills:pricing\n',
    );
    assert.deepEqual(readFounderSkillsManifest(cwd), {
      source: 'github:owner/repository',
      skills: [{ name: 'pricing', ref: 'main', skillRef: 'founder-skills:pricing' }],
    });

    writeFileSync(
      join(cwd, 'founder-skills.yaml'),
      'source: owner/repository\nref: main\nskills:\n  - pricing\n',
    );
    assert.deepEqual(readFounderSkillsManifest(cwd), {
      source: 'github:owner/repository',
      skills: [{ name: 'pricing', ref: 'main' }],
    });

    writeFileSync(
      join(cwd, 'founder-skills.yaml'),
      'source: !unreviewed github:owner/repository\nref: main\nskills:\n  - pricing\n',
    );
    assert.throws(
      () => readFounderSkillsManifest(cwd),
      (error: unknown) => (error as { code?: unknown }).code === 'SKILL_REF_INVALID',
    );

    writeFileSync(
      join(cwd, 'founder-skills.yaml'),
      `# ${token}\nsource: github:owner/repository\nskills:\n  - pricing\n`,
    );
    assert.throws(
      () => readFounderSkillsManifest(cwd),
      (error: unknown) => {
        const record = error as { code?: unknown; message?: unknown; details?: unknown };
        const rendered = JSON.stringify(record);
        return record.code === 'SECRET_MATERIAL_FORBIDDEN'
          && !rendered.includes(token)
          && !rendered.includes('sha256:');
      },
    );

    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills: [\n');
    assert.throws(
      () => readFounderSkillsManifest(cwd),
      (error: unknown) => (error as { code?: unknown }).code === 'SKILL_REF_INVALID',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
