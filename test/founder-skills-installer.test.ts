import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAddArgv, parseSource } from '../src/lib/founder-skills/installer.ts';

test('parseSource accepts github: shorthand and bare owner/repo', () => {
  assert.deepEqual(parseSource('github:firatcand/founder-skills'), {
    owner: 'firatcand',
    repo: 'founder-skills',
  });
  assert.deepEqual(parseSource('firatcand/founder-skills'), {
    owner: 'firatcand',
    repo: 'founder-skills',
  });
});

test('parseSource rejects non-github / malformed sources', () => {
  assert.throws(() => parseSource('https://example.com/x'));
  assert.throws(() => parseSource('just-a-name'));
});

test('buildAddArgv pins via a per-skill tree URL with --copy and both agents', () => {
  const argv = buildAddArgv({
    source: { owner: 'firatcand', repo: 'founder-skills' },
    skill: 'pricing',
    ref: 'v1.0.0',
    tools: ['claude', 'codex'],
  });
  assert.deepEqual(argv, [
    'skills',
    'add',
    'https://github.com/firatcand/founder-skills/tree/v1.0.0/pricing',
    '--copy',
    '-y',
    '-a',
    'claude-code',
    '-a',
    'codex',
  ]);
});

test('buildAddArgv embeds the per-skill ref in the URL', () => {
  const argv = buildAddArgv({
    source: { owner: 'firatcand', repo: 'founder-skills' },
    skill: 'seo',
    ref: 'v0.9.0',
    tools: ['claude'],
  });
  assert.ok(argv.includes('https://github.com/firatcand/founder-skills/tree/v0.9.0/seo'));
  assert.deepEqual(argv.slice(-2), ['-a', 'claude-code']);
});
