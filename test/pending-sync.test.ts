import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPending, countErrorPending } from '../src/lib/pending-sync.ts';
import { exitPathFor } from '../src/lib/cron-exit-log.ts';

function withTmpCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-pendingsync-'));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Helper: write a valid via-cron codex schedule. attestation is required by
// the schema for tool=codex.
function writeSchedules(cwd: string, fn: string, entries: Array<{
  name: string;
  agent: string;
  plan: string;
  cron?: string;
  install_mode?: 'via-cron' | 'ui-handoff';
}>) {
  const fnDir = join(cwd, 'roster', fn);
  mkdirSync(fnDir, { recursive: true });
  const schedules = entries.map((e) => ({
    name: e.name,
    agent: e.agent,
    plan: e.plan,
    cron: e.cron ?? '0 9 * * 1-5',
    tool: 'codex',
    install_mode: e.install_mode ?? 'via-cron',
    status: e.install_mode === 'ui-handoff' ? 'pending-ui-install' : 'installed',
    subscription_attestation: { auth_mode: 'chatgpt', env_policy: 'cleared', codex_home: '/Users/x/.codex' },
  }));
  // YAML-ish; safe shape.
  const lines = ['version: 1', 'schedules:'];
  for (const s of schedules) {
    lines.push(`  - name: ${s.name}`);
    lines.push(`    agent: ${s.agent}`);
    lines.push(`    plan: ${s.plan}`);
    lines.push(`    cron: '${s.cron}'`);
    lines.push(`    tool: ${s.tool}`);
    lines.push(`    install_mode: ${s.install_mode}`);
    lines.push(`    status: ${s.status}`);
    lines.push(`    subscription_attestation:`);
    lines.push(`      auth_mode: chatgpt`);
    lines.push(`      env_policy: cleared`);
    lines.push(`      codex_home: ${s.subscription_attestation.codex_home}`);
  }
  writeFileSync(join(fnDir, 'schedules.yaml'), lines.join('\n') + '\n', 'utf8');
}

function writeExit(cwd: string, name: string, exitCode: string, mtimeUtc: Date | undefined = undefined) {
  mkdirSync(join(cwd, 'logs', 'cron'), { recursive: true });
  const p = exitPathFor(cwd, name);
  writeFileSync(p, exitCode, 'utf8');
  if (mtimeUtc !== undefined) {
    const sec = mtimeUtc.getTime() / 1000;
    utimesSync(p, sec, sec);
  }
}

function writeState(cwd: string, fn: string, line: string) {
  const fnDir = join(cwd, 'roster', fn);
  mkdirSync(fnDir, { recursive: true });
  const path = join(fnDir, 'state.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, existing + line + '\n', 'utf8');
}

// ── basic behaviors ───────────────────────────────────────────────────────

test('syncPending: empty workspace → inspected=0, nothing written', () => {
  withTmpCwd((cwd) => {
    const r = syncPending({ cwd });
    assert.equal(r.inspected, 0);
    assert.equal(r.written.length, 0);
    assert.equal(r.skipped.length, 0);
  });
});

test('syncPending: schedule with no signals → inspected, nothing written', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const r = syncPending({ cwd });
    assert.equal(r.inspected, 1);
    assert.equal(r.written.length, 0);
  });
});

// ── failed-exit signal ────────────────────────────────────────────────────

test('syncPending: non-zero exit → writes pending/error-<id>.md (failed-exit)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'sdr', '137');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.reason, 'failed-exit');
    assert.equal(r.written[0]!.scheduleName, 'sdr');
    assert.ok(existsSync(r.written[0]!.path));
    const body = readFileSync(r.written[0]!.path, 'utf8');
    assert.match(body, /exit_code: 137/);
    assert.match(body, /type: scheduled-fire-failure/);
    assert.match(body, /Retry/);
  });
});

test('syncPending: zero exit → not surfaced (no failure)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'sdr', '0');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 0);
  });
});

test('syncPending: malformed .exit (non-numeric) → not surfaced', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'sdr', 'oops');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 0);
  });
});

test('syncPending: idempotent on re-run — same exit mtime → skip-if-exists', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const fireAt = new Date('2026-05-18T09:00:00Z');
    writeExit(cwd, 'sdr', '1', fireAt);

    const first = syncPending({ cwd });
    assert.equal(first.written.length, 1);

    // No mtime change → re-sync should skip, not re-write.
    const second = syncPending({ cwd });
    assert.equal(second.written.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0]!.reason, 'already-exists');
  });
});

test('syncPending: different exit mtimes → distinct ids → both surface', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'sdr', '1', new Date('2026-05-18T09:00:00Z'));
    const first = syncPending({ cwd });
    assert.equal(first.written.length, 1);

    // Simulate a second failure on the next day — overwrite .exit + bump mtime.
    writeExit(cwd, 'sdr', '1', new Date('2026-05-19T09:00:00Z'));
    const second = syncPending({ cwd });
    assert.equal(second.written.length, 1, 'second fire should surface as new error item');
    assert.notEqual(first.written[0]!.path, second.written[0]!.path, 'distinct ids on different mtime');
  });
});

// ── dry-run ──────────────────────────────────────────────────────────────

test('syncPending: --dry-run reports what would be written but does not write', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'sdr', '1');
    const r = syncPending({ cwd, dryRun: true });
    assert.equal(r.written.length, 1);
    assert.ok(!existsSync(r.written[0]!.path), 'no actual file in dry-run');
  });
});

// ── stale signal ─────────────────────────────────────────────────────────

test('syncPending: stale last_run (cutoff passed, no .exit) → writes stale pending', () => {
  withTmpCwd((cwd) => {
    // Daily 9am cron. Last run on Friday. now=Monday 12pm. cutoff=11am Mon.
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    writeState(cwd, 'gtm', '2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success');
    const r = syncPending({ cwd, now: new Date('2026-05-18T12:00:00Z') });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.reason, 'stale');
    const body = readFileSync(r.written[0]!.path, 'utf8');
    assert.match(body, /type: scheduled-fire-stale/);
    assert.match(body, /expected_before:/);
  });
});

test('syncPending: stale + .exit recent → not stale (recent-fire absorbs)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    writeState(cwd, 'gtm', '2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success');
    // Wrapper ran Mon 09:00; .exit shows zero (so no failed-exit). State.md
    // is still old (agent didn't append) — recent-fire absorbs without
    // surfacing STALE, on the theory that the next fire's success will
    // restore freshness.
    writeExit(cwd, 'sdr', '0', new Date('2026-05-18T09:00:00Z'));
    const r = syncPending({ cwd, now: new Date('2026-05-18T12:00:00Z') });
    assert.equal(r.written.length, 0);
  });
});

// ── countErrorPending ────────────────────────────────────────────────────

test('countErrorPending: counts error-<id>.md across all function dirs', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeSchedules(cwd, 'design', [{ name: 'crit', agent: 'critic', plan: 'review' }]);
    writeExit(cwd, 'sdr', '1');
    writeExit(cwd, 'crit', '2');
    syncPending({ cwd });
    assert.equal(countErrorPending(cwd), 2);
  });
});

test('countErrorPending: ignores non-error pending items (e.g., manual handoffs)', () => {
  withTmpCwd((cwd) => {
    const pdir = join(cwd, 'roster', 'gtm', 'pending');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'manual-followup.md'), '# tbd', 'utf8');
    writeFileSync(join(pdir, 'error-aabbccdd.md'), '# err', 'utf8');
    assert.equal(countErrorPending(cwd), 1);
  });
});

// ── stability ────────────────────────────────────────────────────────────

test('syncPending: ui-handoff codex schedule → no .exit channel (skip failed-exit)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', install_mode: 'ui-handoff' }]);
    // Even if a .exit exists at the conventional path, we don't read it for
    // ui-handoff (there's no wrapper-installed cron line for it).
    writeExit(cwd, 'sdr', '1');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 0);
    assert.equal(r.inspected, 1);
  });
});

test('syncPending: malformed schedules.yaml is skipped silently', () => {
  withTmpCwd((cwd) => {
    const fnDir = join(cwd, 'roster', 'gtm');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(fnDir, 'schedules.yaml'), 'this is not yaml: : :\n', 'utf8');
    const r = syncPending({ cwd });
    assert.equal(r.inspected, 0);
    assert.equal(r.written.length, 0);
  });
});

// ── multi-schedule fairness ──────────────────────────────────────────────

test('syncPending: failure in one schedule does not skip another', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [
      { name: 'sdr', agent: 'sdr', plan: 'cold' },
      { name: 'bdr', agent: 'bdr', plan: 'warm' },
    ]);
    writeExit(cwd, 'sdr', '137');
    writeExit(cwd, 'bdr', '0');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.scheduleName, 'sdr');
  });
});

// ── filename shape ───────────────────────────────────────────────────────

test('syncPending: written file matches pending/error-<8 hex>.md', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'sdr', '1');
    syncPending({ cwd });
    const files = readdirSync(join(cwd, 'roster', 'gtm', 'pending'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^error-[a-f0-9]{8}\.md$/);
  });
});
