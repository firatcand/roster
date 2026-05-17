import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  installClaudeSchedule,
  deriveScheduleName,
  buildOrchestratorPrompt,
  renderFieldsDoc,
  type ClaudeInstallOpts,
} from '../src/lib/schedule-install.ts';
import { RosterError } from '../src/lib/errors.ts';
import { validateSchedulesInCwd } from '../src/lib/schedule-validate.ts';

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-schedule-install-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function baseOpts(cwd: string): ClaudeInstallOpts {
  return {
    cwd,
    functionName: 'gtm',
    agent: 'sdr',
    plan: 'cold-outreach',
    cron: '0 9 * * 1-5',
    name: undefined,
    dryRun: false,
  };
}

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

test('deriveScheduleName: default is ${agent}-${plan}', () => {
  assert.equal(deriveScheduleName('sdr', 'cold-outreach', undefined), 'sdr-cold-outreach');
});

test('deriveScheduleName: override wins', () => {
  assert.equal(deriveScheduleName('sdr', 'cold-outreach', 'morning'), 'morning');
});

test('deriveScheduleName: empty-string override is treated as no override', () => {
  assert.equal(deriveScheduleName('sdr', 'cold-outreach', ''), 'sdr-cold-outreach');
});

test('buildOrchestratorPrompt: stable phrase ROS-32 must honor', () => {
  assert.equal(
    buildOrchestratorPrompt('sdr', 'cold-outreach'),
    'Use the roster-orchestrator skill to run plan cold-outreach for agent sdr',
  );
});

test('renderFieldsDoc: includes the six labeled fields and the prompt block', () => {
  const md = renderFieldsDoc({
    name: 'sdr-cold-outreach',
    cron: '0 9 * * 1-5',
    workspacePath: '/Users/firat/my-roster',
    agent: 'sdr',
    plan: 'cold-outreach',
  });
  assert.match(md, /^# Claude Desktop Scheduled Task — sdr-cold-outreach$/m);
  assert.match(md, /Task name.*sdr-cold-outreach/);
  assert.match(md, /Cron schedule.*0 9 \* \* 1-5/);
  assert.match(md, /Workspace path.*\/Users\/firat\/my-roster/);
  assert.match(md, /Allowed tools.*Read, Write, Bash, Task, Edit, Glob, Grep/);
  assert.match(md, /MCP servers.*\(empty/);
  assert.match(md, /Use the roster-orchestrator skill to run plan cold-outreach for agent sdr/);
  assert.match(md, /anthropics\/claude-code#41364/);
});

test('install (non-dry-run): writes fields doc + schedules.yaml, returns action=created', () => {
  const fix = makeFixture();
  try {
    const result = installClaudeSchedule(baseOpts(fix.root));

    assert.equal(result.action, 'created');
    assert.equal(result.resolvedName, 'sdr-cold-outreach');
    assert.ok(existsSync(result.fieldsDocPath), 'fields doc should exist on disk');
    assert.ok(existsSync(result.schedulesYamlPath), 'schedules.yaml should exist on disk');

    const yamlContent = readFileSync(result.schedulesYamlPath, 'utf8');
    const doc = YAML.parse(yamlContent);
    assert.equal(doc.version, 1);
    assert.equal(doc.schedules.length, 1);
    assert.equal(doc.schedules[0].name, 'sdr-cold-outreach');
    assert.equal(doc.schedules[0].tool, 'claude');
    assert.equal(doc.schedules[0].install_mode, 'ui-handoff');
    assert.equal(doc.schedules[0].status, 'pending-ui-install');
  } finally {
    fix.cleanup();
  }
});

test('install --dry-run: writes nothing, returns content, action=noop-dry-run', () => {
  const fix = makeFixture();
  try {
    const before = listAllFiles(fix.root);
    const result = installClaudeSchedule({ ...baseOpts(fix.root), dryRun: true });
    const after = listAllFiles(fix.root);

    assert.deepEqual(after, before, 'dry-run must not write any files');
    assert.equal(result.action, 'noop-dry-run');
    assert.ok(result.fieldsDocContent.includes('sdr-cold-outreach'));
    assert.ok(result.handoffMessage.includes('Would register'));
  } finally {
    fix.cleanup();
  }
});

test('install: idempotent re-run with same params → action=updated, 1 entry', () => {
  const fix = makeFixture();
  try {
    installClaudeSchedule(baseOpts(fix.root));
    const second = installClaudeSchedule(baseOpts(fix.root));

    assert.equal(second.action, 'updated');
    const doc = YAML.parse(readFileSync(second.schedulesYamlPath, 'utf8'));
    assert.equal(doc.schedules.length, 1, 'should not duplicate the entry');
  } finally {
    fix.cleanup();
  }
});

test('install: re-run with changed cron updates in place', () => {
  const fix = makeFixture();
  try {
    installClaudeSchedule(baseOpts(fix.root));
    const second = installClaudeSchedule({ ...baseOpts(fix.root), cron: '30 14 * * 1-5' });

    assert.equal(second.action, 'updated');
    const doc = YAML.parse(readFileSync(second.schedulesYamlPath, 'utf8'));
    assert.equal(doc.schedules.length, 1);
    assert.equal(doc.schedules[0].cron, '30 14 * * 1-5', 'cron should be updated');
  } finally {
    fix.cleanup();
  }
});

test('install: custom --name override creates a second entry alongside default', () => {
  const fix = makeFixture();
  try {
    installClaudeSchedule(baseOpts(fix.root)); // sdr-cold-outreach
    const second = installClaudeSchedule({
      ...baseOpts(fix.root),
      name: 'sdr-cold-outreach-evening',
      cron: '0 17 * * 1-5',
    });

    assert.equal(second.action, 'created');
    assert.equal(second.resolvedName, 'sdr-cold-outreach-evening');
    const doc = YAML.parse(readFileSync(second.schedulesYamlPath, 'utf8'));
    assert.equal(doc.schedules.length, 2);
    const names = doc.schedules.map((s: { name: string }) => s.name).sort();
    assert.deepEqual(names, ['sdr-cold-outreach', 'sdr-cold-outreach-evening']);
  } finally {
    fix.cleanup();
  }
});

test('install: invalid cron throws RosterError naming the cron field', () => {
  const fix = makeFixture();
  try {
    assert.throws(
      () => installClaudeSchedule({ ...baseOpts(fix.root), cron: '0 99 * * *' }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.ok(err.body.includes('cron'), `expected cron error, got: ${err.body}`);
        return true;
      },
    );
  } finally {
    fix.cleanup();
  }
});

test('install: non-kebab agent throws RosterError', () => {
  const fix = makeFixture();
  try {
    assert.throws(
      () => installClaudeSchedule({ ...baseOpts(fix.root), agent: 'Sdr_v2' }),
      (err: unknown) => err instanceof RosterError,
    );
  } finally {
    fix.cleanup();
  }
});

test('install: non-kebab function name throws RosterError', () => {
  const fix = makeFixture();
  try {
    assert.throws(
      () => installClaudeSchedule({ ...baseOpts(fix.root), functionName: 'GTM' }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.ok(err.body.includes('kebab'));
        return true;
      },
    );
  } finally {
    fix.cleanup();
  }
});

test('install: malformed existing schedules.yaml refuses to overwrite', () => {
  const fix = makeFixture();
  try {
    const fnDir = join(fix.root, 'roster', 'gtm');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(fnDir, 'schedules.yaml'), 'version: 1\nschedules:\n  - name: foo\n    invalid: yaml: here\n');

    assert.throws(
      () => installClaudeSchedule(baseOpts(fix.root)),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.ok(err.header.includes('malformed') || err.body.includes('malformed'));
        return true;
      },
    );
  } finally {
    fix.cleanup();
  }
});

test('install: preserves a user comment in existing schedules.yaml on re-run', () => {
  const fix = makeFixture();
  try {
    const result = installClaudeSchedule(baseOpts(fix.root));

    // Inject a top-of-file comment by hand, then re-run.
    const original = readFileSync(result.schedulesYamlPath, 'utf8');
    const withComment = `# Hand-curated: please do not delete\n${original}`;
    writeFileSync(result.schedulesYamlPath, withComment, 'utf8');

    installClaudeSchedule(baseOpts(fix.root));
    const final = readFileSync(result.schedulesYamlPath, 'utf8');
    assert.ok(final.includes('Hand-curated'), 'comment must be preserved across upsert');
  } finally {
    fix.cleanup();
  }
});

if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
  test('install: EACCES on directory create surfaces as permissionError (not unexpectedError)', () => {
    const fix = makeFixture();
    try {
      // Lock the root so mkdir fails on .roster/ creation.
      chmodSync(fix.root, 0o500);
      try {
        installClaudeSchedule(baseOpts(fix.root));
        assert.fail('expected RosterError from permissionError');
      } catch (err) {
        assert.ok(err instanceof RosterError, `expected RosterError, got ${err}`);
        assert.ok(
          (err as RosterError).header.includes('permission denied'),
          `expected 'permission denied' header, got: ${(err as RosterError).header}`,
        );
      }
    } finally {
      // Restore so cleanup can run.
      try { chmodSync(fix.root, 0o755); } catch { /* best-effort */ }
      fix.cleanup();
    }
  });
}

test('install: file paths are anchored under cwd, not process.cwd()', () => {
  const fix = makeFixture();
  try {
    const result = installClaudeSchedule(baseOpts(fix.root));
    assert.ok(result.fieldsDocPath.startsWith(fix.root), `${result.fieldsDocPath} should start with ${fix.root}`);
    assert.ok(result.schedulesYamlPath.startsWith(fix.root), `${result.schedulesYamlPath} should start with ${fix.root}`);
    assert.ok(result.fieldsDocPath.endsWith('.claude.fields.md'), 'fields doc must end with .claude.fields.md');
  } finally {
    fix.cleanup();
  }
});

test('install: validated entry passes scheduleFileSchema round-trip', () => {
  const fix = makeFixture();
  try {
    const result = installClaudeSchedule(baseOpts(fix.root));
    // Use the validator from the same module the schedule validate command uses
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, true, `validate report: ${JSON.stringify(report)}`);
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]!.entryCount, 1);
    assert.ok(result.action === 'created');
  } finally {
    fix.cleanup();
  }
});
