// inbox skill — ROS-143
//
// The /inbox working-directory guard must identify a workspace by
// config/project.yaml alone. The old guard also demanded a runtime roster/
// directory, which a fresh init does not have — making /inbox falsely abort
// instead of reporting inbox-zero. The backend (roster review --json) already
// returns [] when roster/ is absent; this pins the SKILL.md guard so the doc
// matches that behavior and the contradiction can't silently return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const inboxSrc = join(repoRoot, 'skills', 'inbox', 'SKILL.md');

test('inbox: SKILL.md exists at skills/inbox/SKILL.md', () => {
  assert.ok(existsSync(inboxSrc), 'inbox SKILL.md present');
});

test('inbox: Working-directory guard identifies a workspace by config/project.yaml alone', () => {
  const content = readFileSync(inboxSrc, 'utf8');
  assert.ok(
    !/must contain config\/project\.yaml and roster\//.test(content),
    'old "must contain config/project.yaml and roster/" guard is gone',
  );
  assert.match(
    content,
    /must contain config\/project\.yaml\)/,
    'abort message now requires only config/project.yaml',
  );
});

test('inbox: documents that a missing roster/ is an empty queue, not an error', () => {
  const content = readFileSync(inboxSrc, 'utf8');
  assert.match(content, /missing `roster\/`/, 'mentions the missing-roster/ case');
  assert.match(content, /\*\*not\*\* an error/, 'frames a missing roster/ as not an error');
});

test('inbox: distinguishes .roster/ metadata from the runtime roster/ tree', () => {
  const content = readFileSync(inboxSrc, 'utf8');
  assert.match(content, /`\.roster\/`/, 'mentions .roster/ explicitly');
});
