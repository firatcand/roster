import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function skill(name: string): string {
  return readFileSync(resolve('skills', name, 'SKILL.md'), 'utf8');
}

test('legacy user skills classify mixed workspaces before either execution path', () => {
  for (const name of ['inbox', 'tasks', 'roster-orchestrator', 'chief-of-staff']) {
    const content = skill(name);
    const mixed = content.indexOf('both `roster.yaml` and `config/project.yaml` exist');
    const v2 = content.indexOf('If `roster.yaml` exists');
    assert.ok(mixed >= 0, `${name}: mixed branch exists`);
    assert.ok(v2 > mixed, `${name}: mixed branch is checked before v2`);
    assert.match(content.slice(mixed, v2), /#363/, `${name}: mixed branch points to migration`);
  }
});

test('tasks stops on v2 without invoking the legacy Notion state machine', () => {
  const content = skill('tasks');
  assert.match(content, /If `roster\.yaml` exists, stop/);
  assert.match(content, /do not invoke roster task or read legacy tracker state/i);
  assert.match(content, /workflow-specific tool guidance/i);
});

test('chief-of-staff maps v2 structure to deterministic scaffold and validate commands', () => {
  const content = skill('chief-of-staff');
  assert.match(content, /roster scaffold function <id>/);
  assert.match(content, /roster scaffold agent <id> --scope function:<function>/);
  assert.match(content, /roster scaffold plan <id> --scope agent:<function\/agent>/);
  assert.match(content, /roster scaffold tool-use <id>/);
  assert.match(content, /roster validate \[target\] --json/);
  assert.match(content, /never invoke `scripts\/new-agent\.sh`/);
  assert.match(content, /Do not fall through into the v1 plans/);
});
