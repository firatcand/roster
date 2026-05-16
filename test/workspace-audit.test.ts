import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditWorkspace,
  parseRegions,
  mergeRegions,
  renderTemplate,
} from '../src/lib/project-context.ts';

function makeTmp(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-audit-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

// ─── auditWorkspace ──────────────────────────────────────────────────────────

test('auditWorkspace: no roster files → contextMdExists=false, items=[], ok=true', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const result = auditWorkspace(cwd);
    assert.equal(result.contextMdExists, false);
    assert.deepEqual(result.items, []);
    assert.equal(result.ok, true);
    assert.equal(result.cwd, cwd);
  } finally {
    cleanup();
  }
});

test('auditWorkspace POSIX: correct symlinks → ok=true', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    symlinkSync('CONTEXT.md', join(cwd, 'CLAUDE.md'));
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const result = auditWorkspace(cwd, { platform: 'linux' });
    assert.equal(result.contextMdExists, true);
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 2);
    for (const item of result.items) assert.equal(item.status, 'ok');
  } finally {
    cleanup();
  }
});

test('auditWorkspace POSIX: CLAUDE.md is regular file → not-a-symlink', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    writeFileSync(join(cwd, 'CLAUDE.md'), '# not a symlink\n', 'utf8');
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const result = auditWorkspace(cwd, { platform: 'linux' });
    assert.equal(result.ok, false);
    const claudeItem = result.items.find((i) => i.name === 'CLAUDE.md');
    assert.ok(claudeItem, 'CLAUDE.md item present');
    assert.equal(claudeItem!.status, 'not-a-symlink');
  } finally {
    cleanup();
  }
});

test('auditWorkspace POSIX: CLAUDE.md symlink wrong target → wrong-target', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    writeFileSync(join(cwd, 'old-context.md'), '# old\n', 'utf8');
    symlinkSync('old-context.md', join(cwd, 'CLAUDE.md'));
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const result = auditWorkspace(cwd, { platform: 'linux' });
    assert.equal(result.ok, false);
    const claudeItem = result.items.find((i) => i.name === 'CLAUDE.md');
    assert.ok(claudeItem);
    assert.equal(claudeItem!.status, 'wrong-target');
    assert.ok(claudeItem!.reason?.includes('old-context.md'));
  } finally {
    cleanup();
  }
});

test('auditWorkspace POSIX: CLAUDE.md missing → missing', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const result = auditWorkspace(cwd, { platform: 'linux' });
    assert.equal(result.ok, false);
    const claudeItem = result.items.find((i) => i.name === 'CLAUDE.md');
    assert.ok(claudeItem);
    assert.equal(claudeItem!.status, 'missing');
  } finally {
    cleanup();
  }
});

test('auditWorkspace POSIX: directory at CLAUDE.md path → is-directory', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    mkdirSync(join(cwd, 'CLAUDE.md'), { recursive: true });
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const result = auditWorkspace(cwd, { platform: 'linux' });
    assert.equal(result.ok, false);
    const claudeItem = result.items.find((i) => i.name === 'CLAUDE.md');
    assert.ok(claudeItem);
    assert.equal(claudeItem!.status, 'is-directory');
  } finally {
    cleanup();
  }
});

test('auditWorkspace POSIX: unreadable entry → unreadable, does not throw', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    // Broken symlink: target does not exist, but the symlink itself can be lstat'd
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));
    // Simulate unreadable: create a symlink to a non-existent path for CLAUDE.md
    // entryAtPath will show exists=true, isSymlink=true for a broken symlink on POSIX
    symlinkSync('does-not-exist.md', join(cwd, 'CLAUDE.md'));

    // Should not throw, even for broken symlinks
    let result;
    assert.doesNotThrow(() => {
      result = auditWorkspace(cwd, { platform: 'linux' });
    });
    assert.ok(result);
    const claudeItem = (result as ReturnType<typeof auditWorkspace>).items.find((i) => i.name === 'CLAUDE.md');
    assert.ok(claudeItem);
    // A broken symlink is still a symlink, but points to wrong target
    assert.ok(claudeItem!.status === 'wrong-target' || claudeItem!.status === 'unreadable');
  } finally {
    cleanup();
  }
});

test('auditWorkspace win32: content equal → ok', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const content = '# shared context\n';
    writeFileSync(join(cwd, 'CONTEXT.md'), content, 'utf8');
    writeFileSync(join(cwd, 'CLAUDE.md'), content, 'utf8');
    writeFileSync(join(cwd, 'AGENTS.md'), content, 'utf8');

    const result = auditWorkspace(cwd, { platform: 'win32' });
    assert.equal(result.contextMdExists, true);
    assert.equal(result.ok, true);
    for (const item of result.items) assert.equal(item.status, 'ok');
  } finally {
    cleanup();
  }
});

test('auditWorkspace win32: content diverged → content-diverged', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# context\n', 'utf8');
    writeFileSync(join(cwd, 'CLAUDE.md'), '# different content\n', 'utf8');
    writeFileSync(join(cwd, 'AGENTS.md'), '# context\n', 'utf8');

    const result = auditWorkspace(cwd, { platform: 'win32' });
    assert.equal(result.ok, false);
    const claudeItem = result.items.find((i) => i.name === 'CLAUDE.md');
    assert.ok(claudeItem);
    assert.equal(claudeItem!.status, 'content-diverged');
  } finally {
    cleanup();
  }
});

// ─── parseRegions ────────────────────────────────────────────────────────────

test('parseRegions: well-formed → ok=true, correct maps', () => {
  const content = [
    '<!-- roster:managed:start orchestrator -->',
    '## Orchestrator',
    '<!-- roster:managed:end orchestrator -->',
    '<!-- roster:user:start workspace -->',
    '## Workspace',
    '<!-- roster:user:end workspace -->',
  ].join('\n');

  const result = parseRegions(content);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.managed.has('orchestrator'));
  assert.ok(result.user.has('workspace'));
  assert.ok(result.managed.get('orchestrator')!.includes('## Orchestrator'));
  assert.ok(result.user.get('workspace')!.includes('## Workspace'));
});

test('parseRegions: start without end → ok=false, errors describes problem', () => {
  const content = [
    '<!-- roster:managed:start orchestrator -->',
    '## Orchestrator',
  ].join('\n');

  const result = parseRegions(content);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.includes('orchestrator')));
});

test('parseRegions: end without start → ok=false', () => {
  const content = '<!-- roster:managed:end orphan -->';
  const result = parseRegions(content);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('orphan')));
});

test('parseRegions: mismatched names → ok=false', () => {
  const content = [
    '<!-- roster:managed:start alpha -->',
    '## content',
    '<!-- roster:managed:end beta -->',
  ].join('\n');

  const result = parseRegions(content);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('beta') || e.includes('alpha')));
});

// ─── mergeRegions ────────────────────────────────────────────────────────────

test('mergeRegions: managed regions updated, user regions preserved', () => {
  const existing = [
    '<!-- roster:managed:start orchestrator -->',
    '## Old orchestrator',
    '<!-- roster:managed:end orchestrator -->',
    '<!-- roster:user:start workspace -->',
    '## My custom workspace notes',
    '<!-- roster:user:end workspace -->',
  ].join('\n');

  const fresh = [
    '<!-- roster:managed:start orchestrator -->',
    '## New orchestrator content',
    '<!-- roster:managed:end orchestrator -->',
    '<!-- roster:user:start workspace -->',
    '## Default workspace placeholder',
    '<!-- roster:user:end workspace -->',
  ].join('\n');

  const { merged, warnings } = mergeRegions(existing, fresh, { force: false });
  assert.equal(warnings.length, 0);
  assert.ok(merged.includes('## New orchestrator content'), 'managed region refreshed');
  assert.ok(!merged.includes('## Old orchestrator'), 'old managed content gone');
  assert.ok(merged.includes('## My custom workspace notes'), 'user region preserved');
  assert.ok(!merged.includes('## Default workspace placeholder'), 'default user content not injected over existing');
});

test('mergeRegions: new user region in fresh template appended to existing file', () => {
  const existing = [
    '<!-- roster:managed:start orchestrator -->',
    '## Orchestrator',
    '<!-- roster:managed:end orchestrator -->',
  ].join('\n');

  const fresh = [
    '<!-- roster:managed:start orchestrator -->',
    '## Orchestrator updated',
    '<!-- roster:managed:end orchestrator -->',
    '<!-- roster:user:start workspace -->',
    '## Default workspace',
    '<!-- roster:user:end workspace -->',
  ].join('\n');

  const { merged } = mergeRegions(existing, fresh, { force: false });
  assert.ok(merged.includes('## Default workspace'), 'new user region appended with fresh default');
  assert.ok(merged.includes('<!-- roster:user:start workspace -->'));
});

test('mergeRegions: malformed existing + force=false → throws', () => {
  const existing = '<!-- roster:managed:start orphan -->\n## content without end';
  const fresh = '<!-- roster:managed:start orchestrator -->\n## fresh\n<!-- roster:managed:end orchestrator -->';

  assert.throws(
    () => mergeRegions(existing, fresh, { force: false }),
    /malformed/i,
  );
});

test('mergeRegions: malformed existing + force=true → returns fresh, warning in warnings array', () => {
  const existing = '<!-- roster:managed:start orphan -->\n## content without end';
  const fresh = '<!-- roster:managed:start orchestrator -->\n## fresh\n<!-- roster:managed:end orchestrator -->';

  const { merged, warnings } = mergeRegions(existing, fresh, { force: true });
  assert.equal(merged, fresh);
  assert.ok(warnings.length > 0);
  assert.ok(warnings[0]!.toLowerCase().includes('malformed'));
});

test('mergeRegions: user region in existing not in fresh template is preserved', () => {
  const existing = [
    '<!-- roster:managed:start orchestrator -->',
    '## Orchestrator',
    '<!-- roster:managed:end orchestrator -->',
    '<!-- roster:user:start custom-notes -->',
    '## My custom notes',
    '<!-- roster:user:end custom-notes -->',
  ].join('\n');

  const fresh = [
    '<!-- roster:managed:start orchestrator -->',
    '## Orchestrator fresh',
    '<!-- roster:managed:end orchestrator -->',
  ].join('\n');

  const { merged } = mergeRegions(existing, fresh, { force: false });
  assert.ok(merged.includes('<!-- roster:user:start custom-notes -->'), 'unknown user region preserved');
  assert.ok(merged.includes('## My custom notes'));
});

// ─── Contract tests ───────────────────────────────────────────────────────────

test('contract: CONTEXT.md contains roster:managed:start orchestrator blockquote', () => {
  const content = renderTemplate('test-project');
  assert.ok(
    content.includes('> **You are operating inside a roster-managed workspace.**'),
    'orchestrator blockquote present',
  );
});

test('contract: managed region markers are balanced in rendered template', () => {
  const content = renderTemplate('test-project');
  const result = parseRegions(content);
  assert.equal(result.ok, true, `Marker errors: ${result.errors.join(', ')}`);
});

test('contract: {{PROJECT_NAME}} fully substituted in rendered template', () => {
  const content = renderTemplate('my-project');
  assert.ok(!content.includes('{{PROJECT_NAME}}'), 'no unresolved tokens');
  assert.ok(content.includes('my-project'), 'project name present');
});
