import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  founderManifestSchema,
  normalizeManifest,
  isSafeSkillName,
  DEFAULT_SOURCE,
  DEFAULT_REF,
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

test('rejects an empty skills list', () => {
  assert.throws(() => founderManifestSchema.parse({ skills: [] }));
});

test('rejects a non-kebab skill name', () => {
  assert.throws(() => founderManifestSchema.parse({ skills: ['Bad_Name'] }));
  assert.throws(() => founderManifestSchema.parse({ skills: ['../evil'] }));
});

test('rejects duplicate skill names at normalize', () => {
  const m = founderManifestSchema.parse({ skills: ['pricing', 'pricing'] });
  assert.throws(() => normalizeManifest(m), /duplicate skill 'pricing'/);
});

test('isSafeSkillName guards path-traversal names', () => {
  assert.equal(isSafeSkillName('sales-skill'), true);
  assert.equal(isSafeSkillName('../../etc'), false);
  assert.equal(isSafeSkillName('a/b'), false);
  assert.equal(isSafeSkillName(''), false);
  assert.equal(isSafeSkillName(42), false);
});
