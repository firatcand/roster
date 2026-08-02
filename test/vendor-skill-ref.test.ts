import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCanonicalSkillRef,
  parseSkillRef,
} from '../src/lib/vendor-skills/skill-ref.ts';
import {
  isImmutableFounderRevision,
  normalizeFounderRevision,
  normalizeFounderSource,
} from '../src/lib/vendor-skills/provenance.ts';

function failureText(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const record = error as { message?: unknown; header?: unknown; remedy?: unknown; details?: unknown };
    return JSON.stringify({
      message: record.message,
      header: record.header,
      remedy: record.remedy,
      details: record.details,
    });
  }
  assert.fail('expected failure');
}

test('canonical skill refs contain exactly two bounded kebab-case components', () => {
  assert.equal(parseSkillRef('exa:search'), 'exa:search');
  assert.equal(parseSkillRef(`${'a'.repeat(63)}:${'b'.repeat(63)}`).length, 127);
  assert.equal(isCanonicalSkillRef('company-tools:public-web-search'), true);

  for (const value of [
    '',
    'exa',
    ':search',
    'exa:',
    'exa:search:other',
    'Exa:search',
    'exa:Search',
    'exa:web/search',
    'exa:web\\search',
    'exa:web.search',
    'exa:..',
    'exa:%73earch',
    'exa:search?x=1',
    'exa:search#fragment',
    'exa:search@v1',
    'exa:${SKILL}',
    `a:${'b'.repeat(64)}`,
    `${'a'.repeat(64)}:b`,
  ]) {
    assert.equal(isCanonicalSkillRef(value), false, value);
  }
});

test('the roster package is reserved unless a shipped built-in explicitly opts in', () => {
  assert.equal(isCanonicalSkillRef('roster:brain'), false);
  assert.equal(isCanonicalSkillRef('roster:brain', { allowRosterPackage: true }), true);
  assert.equal(parseSkillRef('roster:brain', { allowRosterPackage: true }), 'roster:brain');
});

test('invalid skill-ref diagnostics never echo the raw value', () => {
  const canary = 'NOT_A_SKILL_REF_WITH_SECRET_SHAPE';
  const rendered = failureText(() => parseSkillRef(canary));
  assert.equal(rendered.includes(canary), false);
});

test('founder source and revision provenance is canonical, bounded, and honest', () => {
  assert.equal(
    normalizeFounderSource('github:FiratCand/Founder-Skills'),
    'github:firatcand/founder-skills',
  );
  assert.equal(normalizeFounderRevision('feature/release-1'), 'feature/release-1');
  const commit = 'A'.repeat(40);
  const digest = `sha256:${'B'.repeat(64)}`;
  assert.equal(normalizeFounderRevision(commit), commit.toLowerCase());
  assert.equal(normalizeFounderRevision(digest), digest.toLowerCase());
  assert.equal(isImmutableFounderRevision(commit), true);
  assert.equal(isImmutableFounderRevision(digest), true);
  assert.equal(isImmutableFounderRevision('main'), false);
  assert.equal(isImmutableFounderRevision('v1.2.3'), false);
});

test('unsafe or credential-shaped provenance is rejected without value or hash echo', () => {
  const token = `sk-${'Ab9_'.repeat(6)}`;
  for (const fn of [
    () => normalizeFounderSource(`github:owner/repo?token=${token}`),
    () => normalizeFounderRevision(`feature/${token}`),
    () => normalizeFounderRevision('../../main'),
    () => normalizeFounderRevision('--upload-pack'),
    () => normalizeFounderRevision('refs/heads/main.lock'),
    () => normalizeFounderRevision('${GIT_REF}'),
  ]) {
    const rendered = failureText(fn);
    assert.equal(rendered.includes(token), false);
    assert.equal(rendered.includes('sha256:'), false);
  }
});
