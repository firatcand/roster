import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };
type Homes = { root: string; claude: string; codex: string; gemini: string; cleanup: () => void };

function makeHomes(present: ReadonlyArray<'claude' | 'codex' | 'gemini'>): Homes {
  const root = mkdtempSync(join(tmpdir(), 'roster-doctor-cli-'));
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  const gemini = join(root, 'gemini');
  for (const key of present) mkdirSync(join(root, key), { recursive: true });
  return { root, claude, codex, gemini, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCli(args: readonly string[], envOverrides: Record<string, string>): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function envFor(h: Homes): Record<string, string> {
  return {
    ROSTER_CLAUDE_HOME: h.claude,
    ROSTER_CODEX_HOME: h.codex,
    ROSTER_GEMINI_HOME: h.gemini,
  };
}

test('doctor after install --all exits 0 and shows no MISSING/STALE', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const install = runCli(['install', '--all', '--silent'], envFor(h));
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.doesNotMatch(doc.stdout, /MISSING/);
    assert.doesNotMatch(doc.stdout, /STALE/);
    assert.match(doc.stdout, /\bOK\b/, 'per-row OK label printed for clean items');
    assert.match(doc.stdout, /up to date/i);
  } finally {
    h.cleanup();
  }
});

test('doctor exits 1 and reports MISSING after a skill dir is deleted', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    rmSync(join(h.claude, 'skills', 'sdr'), { recursive: true, force: true });

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 1, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stdout, /MISSING/);
    assert.match(doc.stdout, /sdr/);
    assert.match(doc.stdout, /roster install/);
  } finally {
    h.cleanup();
  }
});

test('doctor exits 1 and reports STALE after a skill file is modified', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    writeFileSync(join(h.claude, 'skills', 'sdr', 'SKILL.md'), '# tampered\n');

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 1, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stdout, /STALE/);
    assert.match(doc.stdout, /sdr/);
  } finally {
    h.cleanup();
  }
});

test('doctor --json after clean install: valid JSON, ok=true, all items ok', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    const doc = runCli(['doctor', '--json'], envFor(h));
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}`);
    const payload = JSON.parse(doc.stdout) as {
      ok: boolean;
      tools: Array<{ items: Array<{ status: string }> }>;
    };
    assert.equal(payload.ok, true);
    assert.ok(payload.tools.length > 0);
    for (const t of payload.tools) {
      assert.ok(t.items.length > 0);
      for (const item of t.items) assert.equal(item.status, 'ok');
    }
  } finally {
    h.cleanup();
  }
});

test('doctor --json after deleting a skill: ok=false, item missing', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));
    rmSync(join(h.claude, 'skills', 'sdr'), { recursive: true, force: true });

    const doc = runCli(['doctor', '--json'], envFor(h));
    assert.equal(doc.status, 1);
    const payload = JSON.parse(doc.stdout) as {
      ok: boolean;
      tools: Array<{ items: Array<{ name: string; kind: string; status: string }> }>;
    };
    assert.equal(payload.ok, false);
    const sdrItem = payload.tools.flatMap((t) => t.items).find((i) => i.kind === 'skill' && i.name === 'sdr');
    assert.ok(sdrItem);
    assert.equal(sdrItem.status, 'missing');
  } finally {
    h.cleanup();
  }
});

test('doctor with no tools detected exits 3 and prints hint to stderr', () => {
  const h = makeHomes([]);
  try {
    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 3, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.match(doc.stderr, /no AI tools/i);
  } finally {
    h.cleanup();
  }
});

test('doctor --json with no tools detected: exits 3, valid JSON with empty tools', () => {
  const h = makeHomes([]);
  try {
    const doc = runCli(['doctor', '--json'], envFor(h));
    assert.equal(doc.status, 3, `stderr: ${doc.stderr}`);
    const payload = JSON.parse(doc.stdout) as { ok: boolean; tools: unknown[]; note?: string };
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.note, 'no tools detected');
  } finally {
    h.cleanup();
  }
});

test('doctor never prompts — symlinked skill + no inherited TTY exits cleanly', () => {
  const h = makeHomes(['claude']);
  try {
    runCli(['install', '--all', '--silent'], envFor(h));

    const sdrTarget = join(h.claude, 'skills', 'sdr');
    const replica = join(h.root, 'sdr-replica');
    cpSync(sdrTarget, replica, { recursive: true });
    rmSync(sdrTarget, { recursive: true, force: true });
    symlinkSync(replica, sdrTarget, 'dir');

    const doc = runCli(['doctor'], envFor(h));
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    assert.doesNotMatch(doc.stdout, /MISSING/);
    assert.doesNotMatch(doc.stdout, /STALE/);
  } finally {
    h.cleanup();
  }
});

test('--help mentions --json', () => {
  const r = runCli(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--json/);
});
