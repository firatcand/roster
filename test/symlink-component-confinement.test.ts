import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { syncPending } from '../src/lib/pending-sync.ts';
import { scanPending } from '../src/lib/pending.ts';
import { listFunctionDirs, loadSchedules } from '../src/lib/schedule-read.ts';
import { confinedFunctionDir, functionDirWithinRoster, resolveConfinedPath } from '../src/lib/workspace-path.ts';
import { LocalLedger, ledgerBoundaryFor, readLedgerMeta } from '../src/lib/persistence/local/ledger.ts';
import { localBackendInfo } from '../src/lib/persistence/capabilities.ts';

// ═════════════════════════════════════════════════════════════════════════════
// ROUND-12: the CLASS fix — component-wise no-follow confinement
//
// Rounds 10, 11 and 12 each produced a finding of the same class because the
// read-side boundary was REALPATH CONTAINMENT: resolve the whole symlink chain,
// accept it when the result lands under the workspace. By construction that
// ACCEPTS an in-workspace symlinked ancestor. These tests pin the three
// exploits the reviewer reproduced, all of them using links whose targets stay
// INSIDE the workspace (or inside another local ledger tree) — the exact case
// the old realpath rule blessed.
// ═════════════════════════════════════════════════════════════════════════════

const BIN = resolve('src/bin/roster.ts');
const posixOnly = process.platform === 'win32' ? 'POSIX only (symlinks)' : false;

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string): Run {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ROSTER_PLATFORM: 'darwin' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A recursive content fingerprint, so "the foreign tree is byte-unchanged" also
// catches a lock file created and released, or a seal sidecar written.
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) {
        out.push(`d ${relative(dir, p)}`);
        walk(p);
      } else if (entry.isFile()) {
        out.push(`f ${relative(dir, p)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      } else {
        out.push(`? ${relative(dir, p)}`);
      }
    }
  };
  walk(dir);
  return out;
}

const codexSchedulesYaml = `version: 1
schedules:
  - name: nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/x/.codex
`;

const claudeSchedulesYaml = `version: 1
schedules:
  - name: gtm-nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: claude
    install_mode: ui-handoff
    status: installed
`;

// A workspace whose single codex via-cron schedule has ONE failed fire, plus an
// in-workspace `archive/` the symlinks divert into (never a sibling repo — the
// point is that the target stays INSIDE the workspace).
function makeFailedFireWorkspace(): { ws: string; archive: string; pendingDir: string; cleanup: () => void } {
  const ws = tmp('roster-r12-');
  mkdirSync(join(ws, 'roster', 'gtm'), { recursive: true });
  writeFileSync(join(ws, 'roster', 'gtm', 'schedules.yaml'), codexSchedulesYaml, 'utf8');
  const exitDir = join(ws, 'logs', 'cron', 'gtm', 'nightly');
  mkdirSync(exitDir, { recursive: true });
  writeFileSync(join(exitDir, 'fire1.exit'), '1\n', 'utf8');
  const archive = join(ws, 'archive');
  mkdirSync(archive, { recursive: true });
  return {
    ws,
    archive,
    pendingDir: join(ws, 'roster', 'gtm', 'pending'),
    cleanup: () => rmSync(ws, { recursive: true, force: true }),
  };
}

// ── finding 1: pending probes followed IN-WORKSPACE symlinked ancestors ──────

test(
  'round-12 finding 1: an IN-WORKSPACE symlinked acknowledged/ does NOT suppress a real failed fire',
  { skip: posixOnly },
  () => {
    const fx = makeFailedFireWorkspace();
    try {
      // 1. Learn the id the failed fire synthesizes.
      const first = syncPending({ cwd: fx.ws });
      assert.equal(first.written.length, 1, 'baseline: the failed fire produces one decision item');
      const filename = first.written[0]!.path.split('/').pop()!;
      rmSync(first.written[0]!.path);

      // 2. Plant the matching sentinel INSIDE the workspace and divert
      //    acknowledged/ at it. Realpath containment blessed this link.
      const acks = join(fx.archive, 'acks');
      mkdirSync(acks, { recursive: true });
      writeFileSync(join(acks, filename.replace(/\.md$/, '')), 'acknowledged\n', 'utf8');
      symlinkSync(acks, join(fx.pendingDir, 'acknowledged'));

      // 3. The in-workspace sentinel must NOT acknowledge anything.
      const second = syncPending({ cwd: fx.ws });
      assert.deepEqual(
        second.skipped.filter((s) => s.reason === 'acknowledged'),
        [],
        'an in-workspace symlinked acknowledged/ must never suppress a failure',
      );
      assert.equal(second.written.length, 1, 'the real failure is still surfaced');
      assert.ok(existsSync(first.written[0]!.path));
    } finally {
      fx.cleanup();
    }
  },
);

test(
  'round-12 finding 1: an IN-WORKSPACE symlinked pending/ never receives a synthesized decision item',
  { skip: posixOnly },
  () => {
    const fx = makeFailedFireWorkspace();
    try {
      const divert = join(fx.archive, 'pending');
      mkdirSync(divert, { recursive: true });
      symlinkSync(divert, fx.pendingDir);

      const res = syncPending({ cwd: fx.ws });
      assert.deepEqual(res.written, [], 'nothing is written through the in-workspace link');
      assert.deepEqual(readdirSync(divert), [], 'the diverted directory receives no decision file');
      assert.deepEqual(res.skipped.map((s) => s.reason), ['refused']);

      // …and the reader half refuses it too, with a report rather than silence.
      const refused: string[] = [];
      assert.deepEqual(scanPending(fx.ws, 'gtm', refused), []);
      assert.equal(refused.length, 1);
      assert.match(refused[0]!, /symlinked path component/);
    } finally {
      fx.cleanup();
    }
  },
);

// ── finding 3: within-roster function-directory symlink ALIASES ──────────────

test('round-12 finding 3: roster/ops -> gtm is refused, never an alias of the same registry', { skip: posixOnly }, () => {
  const ws = tmp('roster-r12-alias-');
  try {
    mkdirSync(join(ws, 'roster', 'gtm'), { recursive: true });
    const gtmYaml = join(ws, 'roster', 'gtm', 'schedules.yaml');
    writeFileSync(gtmYaml, claudeSchedulesYaml, 'utf8');
    symlinkSync(join(ws, 'roster', 'gtm'), join(ws, 'roster', 'ops'));
    const before = readFileSync(gtmYaml);

    // Read boundary: `ops` is not a registry at all.
    assert.equal(confinedFunctionDir(ws, 'ops'), null, 'confinedFunctionDir must refuse a symlinked function dir');
    assert.equal(functionDirWithinRoster(ws, 'ops'), null, 'the WRITE boundary must refuse it too');
    assert.deepEqual(listFunctionDirs(ws), ['gtm'], 'no duplicate function identity is enumerated');
    assert.deepEqual(
      loadSchedules(ws, { sort: true }).map((s) => `${s.functionName}/${s.entry.name}`),
      ['gtm/gtm-nightly'],
      'the same schedule must never appear under two function identities',
    );

    // Write boundary: `schedule install ops/sdr` must not rewrite gtm's registry.
    const r = runCli(
      [
        'schedule', 'install', 'ops/sdr', 'cold-outreach',
        '--cron', '0 9 * * 1-5', '--tool', 'claude', '--name', 'ops-nightly', '--cwd', ws,
      ],
      ws,
    );
    assert.notEqual(r.status, 0, `install must refuse: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /resolves outside the roster registry/);
    assert.deepEqual(readFileSync(gtmYaml), before, "gtm's registry is byte-unchanged");
    const parsed = YAML.parse(readFileSync(gtmYaml, 'utf8')) as { schedules: Array<{ name: string }> };
    assert.deepEqual(parsed.schedules.map((s) => s.name), ['gtm-nightly'], 'no ops-qualified entry leaked into gtm');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── finding 2: the local ledger was not confined against ancestor symlinks ───

// Build a SEPARATE local ledger tree that carries `workspaceId` in its meta and
// whose tail segment is TORN — so any reader that recovers it would write a
// `.seal` sidecar and leave a trace.
function makeForeignLedgerTree(root: string, workspaceId: string): string {
  const opsRoot = join(root, '.roster', 'ops');
  const ledger = new LocalLedger({ opsRoot, workspaceId });
  ledger.append('runs', { id: 'foreign-1', kind: 'run-event', payload: { secret: 'foreign run' } });
  ledger.append('runs', { id: 'foreign-2', kind: 'run-event', payload: { secret: 'foreign run 2' } });
  appendFileSync(join(opsRoot, workspaceId, 'runs', 'segment-0000.jsonl'), '{"torn":', 'utf8');
  return opsRoot;
}

test('round-12 finding 2: a symlinked .roster/ops/<workspaceId> never reads OR mutates a foreign ledger tree', { skip: posixOnly }, () => {
  const base = tmp('roster-r12-ledger-');
  try {
    const ws = join(base, 'workspace');
    const foreign = join(base, 'foreign');
    mkdirSync(ws, { recursive: true });
    mkdirSync(foreign, { recursive: true });
    const workspaceId = randomUUID();

    const foreignOps = makeForeignLedgerTree(foreign, workspaceId);
    const foreignTree = join(foreignOps, workspaceId);
    const before = fingerprint(foreignTree);
    assert.ok(before.some((l) => l.includes('meta.json')), 'the foreign tree has a valid meta.json for this id');
    assert.ok(!before.some((l) => l.includes('.seal')), 'and an UNSEALED torn tail');

    // The plant: the workspace's own tree path IS the foreign tree.
    const opsRoot = join(ws, '.roster', 'ops');
    mkdirSync(opsRoot, { recursive: true });
    symlinkSync(foreignTree, join(opsRoot, workspaceId));

    const ledger = new LocalLedger({ opsRoot, workspaceId });
    assert.throws(
      () => ledger.scan('runs'),
      /symbolic link/,
      'scan must refuse — it would otherwise LOCK, recover and SEAL the foreign tree',
    );
    assert.throws(() => ledger.meta(), /symbolic link/, 'meta must refuse');
    assert.throws(
      () => readLedgerMeta(join(opsRoot, workspaceId), workspaceId, ledgerBoundaryFor(opsRoot)),
      /symbolic link/,
      'the read-only meta accessor must refuse',
    );
    assert.throws(() => localBackendInfo(opsRoot, workspaceId), /symbolic link/, 'capability discovery must refuse');

    assert.deepEqual(fingerprint(foreignTree), before, 'the foreign tree is byte-identical — no lock, no seal, no read');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('round-12 finding 2: run list/show through a symlinked ops tree surfaces no foreign run', { skip: posixOnly, timeout: 60000 }, () => {
  const base = tmp('roster-r12-runcli-');
  try {
    const ws = join(base, 'workspace');
    const foreign = join(base, 'foreign');
    mkdirSync(ws, { recursive: true });
    mkdirSync(foreign, { recursive: true });

    const setup = runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme', '--json'], ws);
    assert.equal(setup.status, 0, setup.stderr);
    const config = YAML.parse(readFileSync(join(ws, 'roster', 'persistence.yaml'), 'utf8')) as {
      workspace: { id: string };
    };
    const workspaceId = config.workspace.id;

    const foreignOps = makeForeignLedgerTree(foreign, workspaceId);
    const foreignTree = join(foreignOps, workspaceId);
    const before = fingerprint(foreignTree);

    rmSync(join(ws, '.roster', 'ops', workspaceId), { recursive: true, force: true });
    symlinkSync(foreignTree, join(ws, '.roster', 'ops', workspaceId));

    const list = runCli(['run', 'list', '--json', '--cwd', ws], ws);
    assert.notEqual(list.status, 0, `run list must refuse: ${list.stdout}`);
    assert.doesNotMatch(list.stdout, /foreign run/, 'no foreign payload may be reconstructed');
    assert.match(list.stdout + list.stderr, /symbolic link/);
    assert.deepEqual(fingerprint(foreignTree), before, 'the foreign tree is byte-identical after run list');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('round-12 finding 2: a FIFO at meta.json is refused, never blocks backend resolution', { skip: posixOnly, timeout: 60000 }, () => {
  const ws = tmp('roster-r12-fifo-');
  try {
    const setup = runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme', '--json'], ws);
    assert.equal(setup.status, 0, setup.stderr);
    const config = YAML.parse(readFileSync(join(ws, 'roster', 'persistence.yaml'), 'utf8')) as {
      workspace: { id: string };
    };
    const metaPath = join(ws, '.roster', 'ops', config.workspace.id, 'meta.json');
    unlinkSync(metaPath);
    const mk = spawnSync('mkfifo', [metaPath]);
    assert.equal(mk.status, 0, 'mkfifo available on POSIX');
    assert.ok(!statSync(metaPath).isFile());

    const list = runCli(['run', 'list', '--json', '--cwd', ws], ws);
    assert.notEqual(list.status, -1, 'the CLI must terminate, never block on the FIFO');
    assert.notEqual(list.status, 0, `run list must refuse: ${list.stdout}`);
    assert.match(list.stdout + list.stderr, /not a regular file|producer identity/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── the class invariant, stated directly ────────────────────────────────────

test('the primitive refuses a symlinked component REGARDLESS of where it points', { skip: posixOnly }, () => {
  const ws = tmp('roster-r12-prim-');
  try {
    mkdirSync(join(ws, 'real', 'inner'), { recursive: true });
    writeFileSync(join(ws, 'real', 'inner', 'file.md'), 'x', 'utf8');
    // The link target is INSIDE the boundary — the case realpath containment blessed.
    symlinkSync(join(ws, 'real'), join(ws, 'alias'));

    const viaLink = resolveConfinedPath(join(ws, 'alias', 'inner', 'file.md'), ws);
    assert.equal(viaLink.status, 'refused');
    if (viaLink.status === 'refused') assert.equal(viaLink.reason, 'symlink-component');

    // A symlinked FINAL component is refused the same way.
    symlinkSync(join(ws, 'real', 'inner', 'file.md'), join(ws, 'real', 'alias.md'));
    const finalLink = resolveConfinedPath(join(ws, 'real', 'alias.md'), ws);
    assert.equal(finalLink.status, 'refused');

    // …and the real path through real directories still resolves.
    const direct = resolveConfinedPath(join(ws, 'real', 'inner', 'file.md'), ws);
    assert.equal(direct.status, 'ok');
    const missing = resolveConfinedPath(join(ws, 'real', 'inner', 'nope.md'), ws);
    assert.equal(missing.status, 'absent');
    const escape = resolveConfinedPath(join(ws, '..', 'elsewhere'), ws);
    assert.equal(escape.status, 'refused');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
