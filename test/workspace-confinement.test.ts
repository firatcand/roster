import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanPending } from '../src/lib/pending.ts';
import { rejectItem, approveItem } from '../src/lib/pending-apply.ts';
import { acknowledgePendingId, syncPending } from '../src/lib/pending-sync.ts';
import { parseScheduleArgs } from '../src/lib/schedule-args.ts';
import { parseRunArgs } from '../src/lib/run-args.ts';
import { parseReviewArgs } from '../src/lib/review-args.ts';
import { listFunctionDirs, loadSchedules, readScheduleEntries } from '../src/lib/schedule-read.ts';
import { validateSchedulesInCwd, findScheduleFiles } from '../src/lib/schedule-validate.ts';
import { readExistingSchedulesDoc, atomicWriteFile } from '../src/lib/schedule-yaml.ts';
import { readStateMd, listScheduleRuns } from '../src/lib/schedule-state.ts';
import { listExitRecords } from '../src/lib/cron-exit-log.ts';

// ── round-10 finding 1: ancestor symlinks bypassed the no-follow boundary ─────
//
// O_NOFOLLOW protects a path's FINAL component only. Every walker over the
// workspace tree resolved its DIRECTORIES with plain statSync/existsSync, so a
// symlinked parent silently redirected the whole walk:
//
//   roster/gtm/pending -> /elsewhere/pending
//     `roster review` listed a foreign markdown item and `--reject` UNLINKED it.
//   roster/gtm -> /elsewhere
//     `schedule install` / `schedule remove` read AND REWROTE a foreign
//     schedules.yaml through the atomic-write rename.
//
// Every walk is now realpath-confined to the workspace BEFORE it reads or
// mutates anything. Refusals keep each caller's own contract: an actionable
// error where one exists, skip-with-report where the contract is skip-malformed.

const BIN = resolve('src/bin/roster.ts');
const posixOnly = process.platform === 'win32' ? 'POSIX only (symlinks)' : false;

type Run = { status: number; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd?: string): Run {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ROSTER_PLATFORM: 'darwin' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { status: out.status ?? -1, signal: out.signal, stdout: out.stdout, stderr: out.stderr };
}

// A workspace plus a sibling "other repo" the symlinks divert into. Siblings,
// never nested — a nested target would legitimately be inside the boundary.
function makePair(): { ws: string; other: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'roster-confine-'));
  const ws = join(base, 'workspace');
  const other = join(base, 'other');
  mkdirSync(ws, { recursive: true });
  mkdirSync(other, { recursive: true });
  return { ws, other, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const validYaml = `version: 1
schedules:
  - name: foreign-nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: claude
    install_mode: ui-handoff
    status: installed
`;

// ── (a) a symlinked pending/ dir ─────────────────────────────────────────────

test(
  'scanPending: a symlinked roster/<fn>/pending never lists a foreign item (and reports the refusal)',
  { skip: posixOnly },
  () => {
    const fx = makePair();
    try {
      const foreignPending = join(fx.other, 'pending');
      mkdirSync(foreignPending, { recursive: true });
      const foreignItem = join(foreignPending, 'secret.md');
      writeFileSync(foreignItem, '---\nid: foreign\n---\nnot ours\n', 'utf8');

      mkdirSync(join(fx.ws, 'roster', 'gtm'), { recursive: true });
      symlinkSync(foreignPending, join(fx.ws, 'roster', 'gtm', 'pending'));

      const refused: string[] = [];
      assert.deepEqual(scanPending(fx.ws, undefined, refused), []);
      assert.equal(refused.length, 1, 'the diverted directory is REPORTED, never silently skipped');
      assert.match(refused[0]!, /outside the workspace/);

      // Same verdict on the explicit --function path.
      assert.deepEqual(scanPending(fx.ws, 'gtm'), []);
      assert.ok(existsSync(foreignItem), 'the foreign item is untouched by the scan');
    } finally {
      fx.cleanup();
    }
  },
);

test(
  'roster review --json + --reject: a symlinked pending/ yields no items and UNLINKS nothing outside the workspace',
  { skip: posixOnly },
  () => {
    const fx = makePair();
    try {
      const foreignPending = join(fx.other, 'pending');
      mkdirSync(foreignPending, { recursive: true });
      const foreignItem = join(foreignPending, 'victim.md');
      writeFileSync(foreignItem, '---\nid: victim\n---\ndelete me\n', 'utf8');

      mkdirSync(join(fx.ws, 'roster', 'gtm'), { recursive: true });
      symlinkSync(foreignPending, join(fx.ws, 'roster', 'gtm', 'pending'));

      const list = runCli(['review', '--json', '--cwd', fx.ws], fx.ws);
      assert.equal(list.signal, null);
      assert.equal(list.status, 0, list.stderr);
      assert.deepEqual(JSON.parse(list.stdout), [], 'a diverted pending dir contributes no items');
      assert.match(list.stderr, /outside the workspace/, 'the refusal is reported on stderr');

      // Both selector forms — the derived id of the foreign item, and its path.
      for (const selector of ['roster/gtm/pending/victim.md', 'victim.md']) {
        const r = runCli(['review', '--reject', selector, '--json', '--cwd', fx.ws], fx.ws);
        assert.equal(r.signal, null);
        assert.notEqual(r.status, 0, `--reject ${selector} must not succeed`);
      }
      assert.ok(readFileSync(foreignItem, 'utf8').includes('delete me'), 'the foreign file still exists, unmodified');
    } finally {
      fx.cleanup();
    }
  },
);

test(
  'rejectItem/approveItem: an item whose path escapes the workspace is refused, never unlinked',
  { skip: posixOnly },
  () => {
    const fx = makePair();
    try {
      const foreignPending = join(fx.other, 'pending');
      mkdirSync(foreignPending, { recursive: true });
      const foreignItem = join(foreignPending, 'victim.md');
      writeFileSync(foreignItem, 'body\n', 'utf8');
      mkdirSync(join(fx.ws, 'roster', 'gtm'), { recursive: true });
      symlinkSync(foreignPending, join(fx.ws, 'roster', 'gtm', 'pending'));

      // A stale item record naming the diverted path — what a caller holding a
      // pre-swap listing would hand the apply layer.
      const item = {
        function: 'gtm',
        class: 'error' as const,
        path: join(fx.ws, 'roster', 'gtm', 'pending', 'victim.md'),
        filename: 'victim.md',
        frontMatter: { target_on_approve: 'roster/gtm/approved/victim.md' },
        body: 'body',
      };
      assert.throws(() => rejectItem(item, fx.ws), /outside the workspace/);
      assert.throws(() => approveItem(item, fx.ws), /outside the workspace/);
      assert.ok(existsSync(foreignItem), 'the foreign file survives both verbs');
    } finally {
      fx.cleanup();
    }
  },
);

// ── (b) a symlinked function dir ─────────────────────────────────────────────

test(
  'schedule install: a symlinked roster/<fn> is refused and the foreign schedules.yaml is byte-unchanged',
  { skip: posixOnly },
  () => {
    const fx = makePair();
    try {
      const foreignFn = join(fx.other, 'gtm');
      mkdirSync(foreignFn, { recursive: true });
      const foreignYaml = join(foreignFn, 'schedules.yaml');
      writeFileSync(foreignYaml, validYaml, 'utf8');
      const before = readFileSync(foreignYaml);

      mkdirSync(join(fx.ws, 'roster'), { recursive: true });
      symlinkSync(foreignFn, join(fx.ws, 'roster', 'gtm'));

      const r = runCli(
        ['schedule', 'install', 'gtm/sdr', 'cold-outreach', '--cron', '0 9 * * 1-5', '--tool', 'claude', '--cwd', fx.ws],
        fx.ws,
      );
      assert.equal(r.signal, null);
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /outside the workspace|symlink/i);
      assert.deepEqual(readFileSync(foreignYaml), before, 'the foreign registry is never rewritten');
    } finally {
      fx.cleanup();
    }
  },
);

test(
  'schedule remove: a symlinked roster/<fn> resolves no schedule and leaves the foreign registry byte-unchanged',
  { skip: posixOnly },
  () => {
    const fx = makePair();
    try {
      const foreignFn = join(fx.other, 'gtm');
      mkdirSync(foreignFn, { recursive: true });
      const foreignYaml = join(foreignFn, 'schedules.yaml');
      writeFileSync(foreignYaml, validYaml, 'utf8');
      const before = readFileSync(foreignYaml);

      mkdirSync(join(fx.ws, 'roster'), { recursive: true });
      symlinkSync(foreignFn, join(fx.ws, 'roster', 'gtm'));

      const r = runCli(['schedule', 'remove', 'foreign-nightly', '--yes', '--cwd', fx.ws], fx.ws);
      assert.equal(r.signal, null);
      assert.notEqual(r.status, 0, `remove must refuse: ${r.stdout}${r.stderr}`);
      assert.deepEqual(readFileSync(foreignYaml), before, 'the foreign registry is never rewritten');
    } finally {
      fx.cleanup();
    }
  },
);

test(
  'every schedule reader refuses a symlinked roster/<fn> rather than reading the foreign registry',
  { skip: posixOnly },
  () => {
    const fx = makePair();
    try {
      const foreignFn = join(fx.other, 'gtm');
      mkdirSync(foreignFn, { recursive: true });
      writeFileSync(join(foreignFn, 'schedules.yaml'), validYaml, 'utf8');
      writeFileSync(join(foreignFn, 'state.md'), '2026-01-01T00:00:00Z | gtm/sdr/cold-outreach/acme | success\n', 'utf8');
      mkdirSync(join(fx.ws, 'roster'), { recursive: true });
      symlinkSync(foreignFn, join(fx.ws, 'roster', 'gtm'));

      assert.deepEqual(listFunctionDirs(fx.ws), [], 'listFunctionDirs (schedule list + resolve)');
      assert.deepEqual(loadSchedules(fx.ws), [], 'loadSchedules (doctor, pending sync, drift)');
      assert.deepEqual(findScheduleFiles(fx.ws), [], 'schedule validate walk');
      assert.equal(validateSchedulesInCwd(fx.ws).files.length, 0);
      const warnings: string[] = [];
      assert.deepEqual(readScheduleEntries(fx.ws, 'gtm', warnings), []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /cannot read/);
      assert.throws(
        () => readExistingSchedulesDoc(join(fx.ws, 'roster', 'gtm', 'schedules.yaml'), fx.ws),
        /cannot read existing schedules\.yaml/,
      );
      const state = readStateMd(join(fx.ws, 'roster', 'gtm', 'state.md'), fx.ws);
      assert.deepEqual(state.lines, [], 'a diverted state.md yields NO self-report');
      assert.equal(state.malformedCount, 1, 'and the refusal is reported, not silently empty');
    } finally {
      fx.cleanup();
    }
  },
);

test('atomicWriteFile: a destination outside the boundary is refused before any mkdir/rename', { skip: posixOnly }, () => {
  const fx = makePair();
  try {
    const foreignFn = join(fx.other, 'gtm');
    mkdirSync(foreignFn, { recursive: true });
    const foreignYaml = join(foreignFn, 'schedules.yaml');
    writeFileSync(foreignYaml, validYaml, 'utf8');
    mkdirSync(join(fx.ws, 'roster'), { recursive: true });
    symlinkSync(foreignFn, join(fx.ws, 'roster', 'gtm'));

    assert.throws(
      () => atomicWriteFile(join(fx.ws, 'roster', 'gtm', 'schedules.yaml'), 'clobbered\n', fx.ws),
      /refusing to write outside the workspace/,
    );
    assert.equal(readFileSync(foreignYaml, 'utf8'), validYaml);
  } finally {
    fx.cleanup();
  }
});

// ── the cron evidence channel is the same class of walk ──────────────────────

test('cron evidence walkers refuse a symlinked logs/cron/<fn>', { skip: posixOnly }, () => {
  const fx = makePair();
  try {
    const foreignChannel = join(fx.other, 'gtm');
    mkdirSync(join(foreignChannel, 'sdr'), { recursive: true });
    writeFileSync(join(foreignChannel, 'sdr', 'fire1.exit'), '1\n', 'utf8');
    writeFileSync(
      join(foreignChannel, 'sdr', 'fire1.run-id'),
      JSON.stringify({ runId: 'run-foreign', firedAt: 1, fireId: 'fire1' }) + '\n',
      'utf8',
    );
    mkdirSync(join(fx.ws, 'logs', 'cron'), { recursive: true });
    symlinkSync(foreignChannel, join(fx.ws, 'logs', 'cron', 'gtm'));

    assert.deepEqual(listExitRecords(fx.ws, 'gtm', 'sdr'), [], 'no foreign exit evidence');
    assert.deepEqual(listScheduleRuns(fx.ws, 'gtm', 'sdr'), [], 'no foreign run correlation');
  } finally {
    fx.cleanup();
  }
});

// ── (c) the legitimate, non-symlinked layout keeps working ───────────────────

test('a real (non-symlinked) workspace layout is unaffected by the confinement', () => {
  const fx = makePair();
  try {
    const pending = join(fx.ws, 'roster', 'gtm', 'pending');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, 'ok.md'), '---\nid: ok\n---\nreal item\n', 'utf8');
    writeFileSync(join(fx.ws, 'roster', 'gtm', 'schedules.yaml'), validYaml, 'utf8');
    writeFileSync(
      join(fx.ws, 'roster', 'gtm', 'state.md'),
      '2026-01-01T00:00:00Z | gtm/sdr/cold-outreach/acme | success\n',
      'utf8',
    );

    const refused: string[] = [];
    const items = scanPending(fx.ws, undefined, refused);
    assert.deepEqual(items.map((i) => i.filename), ['ok.md']);
    assert.deepEqual(refused, []);
    assert.deepEqual(listFunctionDirs(fx.ws), ['gtm']);
    assert.equal(loadSchedules(fx.ws).length, 1);
    assert.equal(findScheduleFiles(fx.ws).length, 1);
    assert.equal(validateSchedulesInCwd(fx.ws).ok, true);
    assert.equal(readStateMd(join(fx.ws, 'roster', 'gtm', 'state.md'), fx.ws).lines.length, 1);
    const { existedBefore } = readExistingSchedulesDoc(join(fx.ws, 'roster', 'gtm', 'schedules.yaml'), fx.ws);
    assert.equal(existedBefore, true);
  } finally {
    fx.cleanup();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// round-11 finding 1: explicit --function escaped the ROSTER REGISTRY tree
//
// Round 10 confined every resolved path to the WORKSPACE. `../archive`
// satisfies that boundary while leaving the registry entirely, so with a valid
// <workspace>/archive/schedules.yaml:
//
//   roster schedule remove nightly --function ../archive --yes
//     resolved to — and REWROTE — that archive instead of a registry under
//     roster/; `status` and `run` consumed it the same way.
//
// An in-workspace SYMLINK (`roster/gtm -> ../archive`) reached the same place
// without any `..` at all. Two layers close both: one strict kebab validator
// wherever a function name is ACCEPTED, and a resolved-directory boundary of
// <workspace>/roster/ rather than <workspace>.
// ═════════════════════════════════════════════════════════════════════════════

const archiveYaml = `version: 1
schedules:
  - name: nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: claude
    install_mode: ui-handoff
    status: installed
`;

// A workspace with a real registry plus a SIBLING (in-workspace, outside
// roster/) `archive/schedules.yaml` — the tree `--function ../archive` reached.
function makeArchiveWorkspace(): { ws: string; archive: string; cleanup: () => void } {
  const fx = makePair();
  mkdirSync(join(fx.ws, 'roster', 'gtm'), { recursive: true });
  writeFileSync(join(fx.ws, 'roster', 'gtm', 'schedules.yaml'), validYaml, 'utf8');
  const archive = join(fx.ws, 'archive', 'schedules.yaml');
  mkdirSync(join(fx.ws, 'archive'), { recursive: true });
  writeFileSync(archive, archiveYaml, 'utf8');
  return { ws: fx.ws, archive, cleanup: fx.cleanup };
}

test('schedule remove --function ../archive is refused and leaves the sibling registry byte-identical', { timeout: 30000 }, () => {
  const fx = makeArchiveWorkspace();
  try {
    const before = readFileSync(fx.archive);
    const r = runCli(['schedule', 'remove', 'nightly', '--function', '../archive', '--yes', '--cwd', fx.ws]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /invalid function name '\.\.\/archive'/);
    assert.deepEqual(readFileSync(fx.archive), before, 'the out-of-tree registry is never rewritten');
  } finally {
    fx.cleanup();
  }
});

test('schedule status --function ../archive is refused', { timeout: 30000 }, () => {
  const fx = makeArchiveWorkspace();
  try {
    const r = runCli(['schedule', 'status', 'nightly', '--function', '../archive', '--cwd', fx.ws]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /invalid function name/);
  } finally {
    fx.cleanup();
  }
});

test('run start --function ../x is refused before any ledger write', { timeout: 30000 }, () => {
  const fx = makeArchiveWorkspace();
  try {
    const r = runCli([
      'run', 'start', 'run-escape',
      '--schedule', 'sdr', '--function', '../x', '--fire-id', 'fire1',
      '--cwd', fx.ws,
    ]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /invalid function name '\.\.\/x'/);
  } finally {
    fx.cleanup();
  }
});

test('schedule install through an IN-WORKSPACE symlinked roster/<fn> is refused', { timeout: 30000, skip: posixOnly }, () => {
  const fx = makeArchiveWorkspace();
  try {
    const before = readFileSync(fx.archive);
    symlinkSync(join(fx.ws, 'archive'), join(fx.ws, 'roster', 'ops'));
    const r = runCli([
      'schedule', 'install', 'ops/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude', '--name', 'nightly', '--cwd', fx.ws,
    ]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /resolves outside the roster registry/);
    assert.deepEqual(readFileSync(fx.archive), before, 'the diverted registry is never rewritten');
  } finally {
    fx.cleanup();
  }
});

test('schedule list / validate never surface an IN-WORKSPACE symlinked roster/<fn>', { timeout: 30000, skip: posixOnly }, () => {
  const fx = makeArchiveWorkspace();
  try {
    symlinkSync(join(fx.ws, 'archive'), join(fx.ws, 'roster', 'ops'));

    assert.deepEqual(listFunctionDirs(fx.ws), ['gtm'], 'the diverted function is not a registry');
    assert.deepEqual(listFunctionDirs(fx.ws, 'ops'), [], 'nor on the explicit --function path');
    assert.deepEqual(loadSchedules(fx.ws, { sort: true }).map((s) => s.entry.name), ['foreign-nightly']);
    assert.deepEqual(readScheduleEntries(fx.ws, 'ops', []), []);
    assert.equal(findScheduleFiles(fx.ws).length, 1);

    const r = runCli(['schedule', 'list', '--json', '--cwd', fx.ws]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /"nightly"/, 'the out-of-tree entry never appears in list output');
  } finally {
    fx.cleanup();
  }
});

test('scanPending refuses an IN-WORKSPACE symlinked roster/<fn> (and reports it on the explicit path)', { skip: posixOnly }, () => {
  const fx = makeArchiveWorkspace();
  try {
    const divertedPending = join(fx.ws, 'archive', 'pending');
    mkdirSync(divertedPending, { recursive: true });
    writeFileSync(join(divertedPending, 'off-tree.md'), '---\nid: x\n---\nnot a registry item\n', 'utf8');
    symlinkSync(join(fx.ws, 'archive'), join(fx.ws, 'roster', 'ops'));

    // The enumerate path never even offers it: Dirent.isDirectory() is
    // lstat-based, so a symlinked entry is not a directory to begin with.
    assert.deepEqual(scanPending(fx.ws), []);
    // The explicit `--function ops` path is where the boundary has to speak up.
    const refused: string[] = [];
    assert.deepEqual(scanPending(fx.ws, 'ops', refused), []);
    assert.equal(refused.length, 1);
    assert.match(refused[0]!, /does not resolve beneath roster\//);
  } finally {
    fx.cleanup();
  }
});

test('the function-name ARGUMENT boundary refuses traversal in every parser that accepts one', () => {
  // A leading '-' is rejected one layer earlier (it reads as a flag), so only
  // the rest are asserted to carry the shared invalid-function-name phrasing.
  const bad = ['../archive', '..', '.', 'a/b', 'a\\b', 'Gtm', 'gtm_ops', '', 'gtm-', '-gtm', 'a--b', 'x'.repeat(65)];
  for (const value of bad) {
    for (const sub of ['remove', 'status', 'run'] as const) {
      const parsed = parseScheduleArgs([sub, 'nightly', '--function', value]);
      assert.equal(parsed.kind, 'err', `schedule ${sub} --function '${value}'`);
      if (parsed.kind === 'err' && !value.startsWith('-')) {
        assert.match(parsed.message, /invalid function name/);
      }
    }
    const install = parseScheduleArgs([
      'install', `${value}/sdr`, 'cold-outreach', '--cron', '0 9 * * 1-5', '--tool', 'claude',
    ]);
    assert.equal(install.kind, 'err', `schedule install '${value}/sdr'`);

    const run = parseRunArgs(['start', 'r1', '--schedule', 'sdr', '--function', value]);
    assert.equal(run.kind, 'err', `run start --function '${value}'`);

    assert.equal(parseReviewArgs([value]).kind, 'err', `review '${value}'`);
  }

  // …and a legitimate kebab-case function is accepted by all of them.
  for (const good of ['gtm', 'product-ops', 'a1', 'x-y-z']) {
    assert.equal(parseScheduleArgs(['remove', 'nightly', '--function', good]).kind, 'ok');
    assert.equal(
      parseScheduleArgs(['install', `${good}/sdr`, 'cold-outreach', '--cron', '0 9 * * 1-5', '--tool', 'claude']).kind,
      'ok',
    );
    assert.equal(parseRunArgs(['start', 'r1', '--schedule', 'sdr', '--function', good]).kind, 'ok');
    assert.equal(parseReviewArgs([good]).kind, 'ok');
  }
});

test('a legitimate kebab-case function still installs, lists, and removes end-to-end', { timeout: 60000 }, () => {
  const fx = makePair();
  try {
    const install = runCli([
      'schedule', 'install', 'product-ops/sdr', 'cold-outreach',
      '--cron', '0 9 * * 1-5', '--tool', 'claude', '--name', 'nightly', '--cwd', fx.ws,
    ]);
    assert.equal(install.status, 0, install.stderr);
    const registry = join(fx.ws, 'roster', 'product-ops', 'schedules.yaml');
    assert.ok(existsSync(registry), 'the registry lands under roster/<fn>/');

    const list = runCli(['schedule', 'list', '--json', '--cwd', fx.ws]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /"nightly"/);

    const removed = runCli(['schedule', 'remove', 'nightly', '--function', 'product-ops', '--yes', '--cwd', fx.ws]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(readScheduleEntries(fx.ws, 'product-ops', []).length, 0);
  } finally {
    fx.cleanup();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// round-11 finding 2: pending-sync's existence probes bypassed confinement
//
// isAcknowledged and both pending-destination checks used raw existsSync, which
// FOLLOWS symlinks and knows no boundary:
//
//   roster/gtm/pending/acknowledged -> /elsewhere/foreign-acks
//     a matching foreign sentinel classified a FAILED fire as acknowledged and
//     suppressed its decision item — a real failure vanishing from the inbox.
//   roster/gtm/pending/error-<id>.md -> /elsewhere/whatever
//     probed as an existing item, so the failure was silently "already
//     reported" against a file the workspace does not own.
// ═════════════════════════════════════════════════════════════════════════════

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

// A workspace whose single codex via-cron schedule has ONE failed fire, so
// every sync has exactly one decision item to produce.
function makeFailedFireWorkspace(): { ws: string; other: string; pendingDir: string; cleanup: () => void } {
  const fx = makePair();
  mkdirSync(join(fx.ws, 'roster', 'gtm'), { recursive: true });
  writeFileSync(join(fx.ws, 'roster', 'gtm', 'schedules.yaml'), codexSchedulesYaml, 'utf8');
  const exitDir = join(fx.ws, 'logs', 'cron', 'gtm', 'nightly');
  mkdirSync(exitDir, { recursive: true });
  writeFileSync(join(exitDir, 'fire1.exit'), '1\n', 'utf8');
  return {
    ws: fx.ws,
    other: fx.other,
    pendingDir: join(fx.ws, 'roster', 'gtm', 'pending'),
    cleanup: fx.cleanup,
  };
}

test('pending sync: a SYMLINKED acknowledged/ with a matching foreign sentinel does NOT suppress the decision item', { skip: posixOnly }, () => {
  const fx = makeFailedFireWorkspace();
  try {
    // 1. Learn the item id the failed fire synthesizes.
    const first = syncPending({ cwd: fx.ws });
    assert.equal(first.written.length, 1, 'baseline: the failed fire produces one item');
    const filename = first.written[0]!.path.split('/').pop()!;
    assert.match(filename, /^error-[a-f0-9]+\.md$/);
    rmSync(first.written[0]!.path);

    // 2. Plant the matching sentinel in a foreign dir and divert acknowledged/.
    const foreignAcks = join(fx.other, 'foreign-acks');
    mkdirSync(foreignAcks, { recursive: true });
    writeFileSync(join(foreignAcks, filename.replace(/\.md$/, '')), 'acknowledged\n', 'utf8');
    symlinkSync(foreignAcks, join(fx.pendingDir, 'acknowledged'));

    // 3. The foreign sentinel must NOT acknowledge anything.
    const second = syncPending({ cwd: fx.ws });
    assert.equal(second.written.length, 1, 'the real failure is still surfaced');
    assert.deepEqual(second.skipped, [], 'and never counted as acknowledged');
    assert.ok(existsSync(first.written[0]!.path));
  } finally {
    fx.cleanup();
  }
});

test('pending sync: a real in-workspace acknowledged sentinel still suppresses its item (no regression)', () => {
  const fx = makeFailedFireWorkspace();
  try {
    const first = syncPending({ cwd: fx.ws });
    assert.equal(first.written.length, 1);
    const id = /^error-([a-f0-9]+)\.md$/.exec(first.written[0]!.path.split('/').pop()!)![1]!;
    rmSync(first.written[0]!.path);

    acknowledgePendingId(fx.ws, 'gtm', id);
    const second = syncPending({ cwd: fx.ws });
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.skipped.map((s) => s.reason), ['acknowledged']);
  } finally {
    fx.cleanup();
  }
});

test('pending sync: a SYMLINKED pending destination is REFUSED, never a wrong already-exists', { skip: posixOnly }, () => {
  const fx = makeFailedFireWorkspace();
  try {
    const first = syncPending({ cwd: fx.ws });
    assert.equal(first.written.length, 1);
    const dst = first.written[0]!.path;
    rmSync(dst);

    const foreign = join(fx.other, 'foreign-item.md');
    writeFileSync(foreign, 'not ours\n', 'utf8');
    const before = readFileSync(foreign);
    symlinkSync(foreign, dst);

    const second = syncPending({ cwd: fx.ws });
    assert.deepEqual(second.written, [], 'nothing is written through the link');
    assert.deepEqual(second.skipped.map((s) => s.reason), ['refused']);
    assert.deepEqual(readFileSync(foreign), before, 'the foreign file is byte-unchanged');
  } finally {
    fx.cleanup();
  }
});

test('approveItem: a DANGLING symlink at the approve target is refused, not clobbered', { skip: posixOnly }, () => {
  const fx = makePair();
  try {
    const pending = join(fx.ws, 'roster', 'gtm', 'pending');
    mkdirSync(pending, { recursive: true });
    const itemPath = join(pending, 'lesson.md');
    writeFileSync(itemPath, '---\ntarget_on_approve: gtm/sdr/playbook.md\n---\nbody\n', 'utf8');
    mkdirSync(join(fx.ws, 'gtm', 'sdr'), { recursive: true });
    symlinkSync(join(fx.other, 'gone.md'), join(fx.ws, 'gtm', 'sdr', 'playbook.md'));

    const items = scanPending(fx.ws);
    assert.equal(items.length, 1);
    const res = approveItem(items[0]!, fx.ws);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /not a safe destination/);
    assert.ok(existsSync(itemPath), 'the pending item is left in place');
  } finally {
    fx.cleanup();
  }
});
