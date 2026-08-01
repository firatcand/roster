import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../src/commands/init.ts';
import { executeUpgradeCommand } from '../src/commands/upgrade.ts';
import { decideUpgradeAction, isPathExcluded } from '../src/lib/upgrade.ts';
import { RosterError } from '../src/lib/errors.ts';

test('decideUpgradeAction retains the isolated legacy conflict-classification seam', () => {
  const base = { path: 'x', sha256: 'BASE' };
  assert.equal(decideUpgradeAction({ disk: { kind: 'absent' }, newSha: 'N', manifestEntry: base }), 'create');
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'N' }, newSha: 'N', manifestEntry: base }), 'noop');
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'D' }, newSha: 'N', manifestEntry: undefined }), 'conflict');
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'D' }, newSha: 'BASE', manifestEntry: base }), 'noop');
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'BASE' }, newSha: 'N', manifestEntry: base }), 'update');
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'D' }, newSha: 'N', manifestEntry: base }), 'conflict');
});

test('isPathExcluded retains exact, subtree, and glob behavior for migration tooling', () => {
  assert.equal(isPathExcluded('guidelines/voice.md', ['guidelines']), true);
  assert.equal(isPathExcluded('guidelines', ['guidelines']), true);
  assert.equal(isPathExcluded('guidelines/icps/x.md', ['guidelines']), true);
  assert.equal(isPathExcluded('gtm/EXPERT.md', ['guidelines']), false);
  assert.equal(isPathExcluded('voice.md', ['*.md']), true);
  assert.equal(isPathExcluded('gtm/EXPERT.md', ['*.md']), false);
  assert.equal(isPathExcluded('gtm/EXPERT.md', ['**/EXPERT.md']), true);
});

test('upgrade refuses a sparse v2 workspace and preserves every byte', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-upgrade-v2-'));
  try {
    await executeInit({ cwd, name: 'upgrade-v2', silent: true });
    const registryBefore = readFileSync(join(cwd, 'roster.yaml'));
    const bootstrapBefore = readFileSync(join(cwd, 'ROSTER.md'));
    assert.throws(
      () => executeUpgradeCommand({ cwd, dryRun: false, json: false, excludes: [] }),
      (error: unknown) => error instanceof RosterError && error.code === 'COMMAND_REPLACED' && /roster update/.test(error.remedy),
    );
    assert.deepEqual(readFileSync(join(cwd, 'roster.yaml')), registryBefore);
    assert.deepEqual(readFileSync(join(cwd, 'ROSTER.md')), bootstrapBefore);
    assert.deepEqual(readdirSync(cwd).sort(), ['ROSTER.md', 'roster.yaml']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('upgrade refuses legacy workspaces without overlaying v2 state', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-upgrade-legacy-'));
  try {
    mkdirSync(join(cwd, 'config'));
    const legacy = Buffer.from('name: legacy\n');
    writeFileSync(join(cwd, 'config', 'project.yaml'), legacy);
    assert.throws(
      () => executeUpgradeCommand({ cwd, dryRun: true, json: true, excludes: [] }),
      (error: unknown) => error instanceof RosterError && error.code === 'LEGACY_WORKSPACE',
    );
    assert.deepEqual(readFileSync(join(cwd, 'config', 'project.yaml')), legacy);
    assert.deepEqual(readdirSync(cwd).sort(), ['config']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('upgrade refuses outside a workspace', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-noupgrade-'));
  try {
    assert.throws(
      () => executeUpgradeCommand({ cwd, dryRun: false, json: false, excludes: [] }),
      (error: unknown) => error instanceof RosterError && error.code === 'WORKSPACE_NOT_FOUND',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
