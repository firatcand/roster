import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  auditAgentEnvPermissions,
  auditEnvKeyReferences,
  auditEnvPermissions,
  listV1AgentPaths,
  type AgentEnvRefMiss,
  type AgentEnvRefsResult,
} from '../src/lib/doctor-secrets-audit.ts';
import {
  auditAgentEnvRedundancy,
  findLastLineForKey,
  removeLineForKey,
} from '../src/lib/doctor-agent-env-audit.ts';
import { confirmAndDeleteRedundantLines } from '../src/lib/agent-env-fix-prompt.ts';
import { applyAgentEnvFix, runFixes } from '../src/commands/doctor.ts';
import { auditWorkspace } from '../src/lib/project-context.ts';

// Home of the SPEC v1 acceptance tests for the three new doctor checks:
//   - check 13: agent .env file permissions
//   - check 14: redundant agent keys
//   - check 15: referenced-but-unset across agents
// Each check has positive + negative + --fix cases. The check-13 and check-15
// audit-level cases were moved verbatim from test/doctor-secrets-audit.test.ts
// when this file was created (see ROS-88 plan).

function makeTmpCwd(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'roster-doctor-v1-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeAgentEnv(cwd: string, fn: string, agent: string, mode: number): string {
  const agentDir = join(cwd, fn, agent);
  mkdirSync(agentDir, { recursive: true });
  const envPath = join(agentDir, '.env');
  writeFileSync(envPath, 'A=1\n');
  chmodSync(envPath, mode);
  return envPath;
}

function writeConfigYaml(cwd: string, fn: string, agent: string, content: string): void {
  const dir = join(cwd, fn, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), content, 'utf8');
}

// v1 flat layout: <top>/config.yaml (top-level agents like dreamer, chief-of-staff)
function writeTopConfigYaml(cwd: string, top: string, content: string): void {
  const dir = join(cwd, top);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), content, 'utf8');
}

// ──────────────────────────────────────────────────────────────────────
// Check 13 — agent .env file permissions
// ──────────────────────────────────────────────────────────────────────

test('check 13 / auditAgentEnvPermissions: no agent .env files → status ok, empty items', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: 0600 agent .env → ok item', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeAgentEnv(dir, 'gtm', 'sdr', 0o600);
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.status, 'ok');
    assert.equal(r.items[0]!.mode, '0600');
    assert.equal(r.items[0]!.agentPath, join('gtm', 'sdr'));
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: 0644 agent .env → warn item, autoFixable', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeAgentEnv(dir, 'gtm', 'sdr', 0o644);
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'warn');
    if (r.status !== 'warn') return;
    assert.equal(r.items.length, 1);
    const item = r.items[0]!;
    assert.equal(item.status, 'warn');
    if (item.status !== 'warn') return;
    assert.equal(item.mode, '0644');
    assert.equal(item.expected, '0600');
    assert.equal(item.autoFixable, true);
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: 0666 agent .env → fail item (world-writable)', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeAgentEnv(dir, 'gtm', 'sdr', 0o666);
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'fail');
    if (r.status !== 'fail') return;
    assert.equal(r.items.length, 1);
    const item = r.items[0]!;
    assert.equal(item.status, 'fail');
    if (item.status !== 'fail') return;
    assert.equal(item.mode, '0666');
    assert.equal(item.autoFixable, true);
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: mixed agents → aggregate fail, per-item statuses preserved', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeAgentEnv(dir, 'gtm', 'sdr', 0o600);
    writeAgentEnv(dir, 'gtm', 'enricher', 0o644);
    writeAgentEnv(dir, 'ops', 'janitor', 0o666);
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'fail');
    if (r.status !== 'fail') return;
    const byAgent = new Map(r.items.map((i) => [i.agentPath, i.status]));
    assert.equal(byAgent.get(join('gtm', 'sdr')), 'ok');
    assert.equal(byAgent.get(join('gtm', 'enricher')), 'warn');
    assert.equal(byAgent.get(join('ops', 'janitor')), 'fail');
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: catches top-level infra agents (dreamer, chief-of-staff)', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    // dreamer/ and chief-of-staff/ are top-level agents (peers of <function>/
    // dirs), not nested under any function. The walker must check their
    // .env at depth 1.
    const dreamerEnv = join(dir, 'dreamer', '.env');
    const cosEnv = join(dir, 'chief-of-staff', '.env');
    mkdirSync(join(dir, 'dreamer'), { recursive: true });
    mkdirSync(join(dir, 'chief-of-staff'), { recursive: true });
    writeFileSync(dreamerEnv, 'A=1\n');
    writeFileSync(cosEnv, 'B=2\n');
    chmodSync(dreamerEnv, 0o666);
    chmodSync(cosEnv, 0o644);

    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'fail');
    if (r.status !== 'fail') return;
    const byAgent = new Map(r.items.map((i) => [i.agentPath, i.status]));
    assert.equal(byAgent.get('dreamer'), 'fail');
    assert.equal(byAgent.get('chief-of-staff'), 'warn');
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: skips SKIP_TOP dirs (node_modules, src, plans, spec, docs)', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    // These directories should be skipped — placing a 0666 .env under each
    // would otherwise produce false positives if the walker mis-categorized
    // them as <function>/<agent> dirs.
    writeAgentEnv(dir, 'node_modules', 'pkg', 0o666);
    writeAgentEnv(dir, 'src', 'lib', 0o666);
    writeAgentEnv(dir, 'plans', 'tasks', 0o666);
    writeAgentEnv(dir, 'spec', '_archive', 0o666);
    writeAgentEnv(dir, 'docs', 'learnings', 0o666);
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: skips dotdirs at function and agent levels', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeAgentEnv(dir, '.hidden-fn', 'agent', 0o666);
    writeAgentEnv(dir, 'gtm', '.hidden-agent', 0o666);
    const r = auditAgentEnvPermissions(dir);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('check 13 / auditAgentEnvPermissions: ROSTER_PLATFORM=win32 → skip-platform', () => {
  const prev = process.env['ROSTER_PLATFORM'];
  process.env['ROSTER_PLATFORM'] = 'win32';
  try {
    const { dir, cleanup } = makeTmpCwd();
    try {
      const r = auditAgentEnvPermissions(dir);
      assert.equal(r.status, 'skip-platform');
    } finally {
      cleanup();
    }
  } finally {
    if (prev === undefined) delete process.env['ROSTER_PLATFORM'];
    else process.env['ROSTER_PLATFORM'] = prev;
  }
});

// --fix apply (depth: exercise the helper, not just the autoFixable flag).
// The end-to-end CLI variant lives in test/cli-doctor.test.ts (ROS-85). This
// is the direct-call regression — if runFixes' chmod loop regresses, this
// fails at unit level instead of waiting for the slower spawn-based E2E.
test('check 13 / runFixes: 0644 agent .env → mode flipped to 0600 (unit)', () => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = makeTmpCwd();
  try {
    const envPath = writeAgentEnv(dir, 'gtm', 'sdr', 0o644);
    // workspace .env: clean so runFixes only touches the agent .env.
    writeFileSync(join(dir, '.env'), 'A=1\n');
    chmodSync(join(dir, '.env'), 0o600);

    const workspace = auditWorkspace(dir);
    const envPerms = auditEnvPermissions(dir);
    const agentEnvPerms = auditAgentEnvPermissions(dir);
    assert.equal(agentEnvPerms.status, 'warn', 'precondition: agent .env should warn at 0644');

    const outcome = runFixes(dir, workspace, envPerms, agentEnvPerms, false);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.failed.length, 0, `unexpected failures: ${JSON.stringify(outcome.failed)}`);

    const finalMode = statSync(envPath).mode & 0o777;
    assert.equal(finalMode.toString(8), '600', `agent .env should be 0600, got 0${finalMode.toString(8)}`);
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// Check 14 — redundant agent keys
// ──────────────────────────────────────────────────────────────────────

function writeAgentEnvContent(cwd: string, fn: string, agent: string, content: string): string {
  const agentDir = join(cwd, fn, agent);
  mkdirSync(agentDir, { recursive: true });
  const envPath = join(agentDir, '.env');
  writeFileSync(envPath, content);
  return envPath;
}

test('check 14 / auditAgentEnvRedundancy: agent KEY matches workspace KEY → item with status warn', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'APOLLO_API_KEY=secret\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'warn');
    assert.equal(r.items.length, 1);
    const item = r.items[0]!;
    assert.equal(item.key, 'APOLLO_API_KEY');
    assert.equal(item.agentEnvPath, join('gtm', 'sdr', '.env'));
    assert.equal(item.line, 1);
  } finally {
    cleanup();
  }
});

test('check 14 / auditAgentEnvRedundancy: agent KEY differs from workspace value → no item', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=workspace-value\n');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'APOLLO_API_KEY=agent-override\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'ok');
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('check 14 / auditAgentEnvRedundancy: workspace .env missing → status ok regardless of agent files', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'APOLLO_API_KEY=anything\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'ok');
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('check 14 / auditAgentEnvRedundancy: agent KEY present, workspace KEY absent → no item (override, not redundancy)', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'OTHER=x\n');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'APOLLO_API_KEY=agent-only\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'ok');
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('check 14 / auditAgentEnvRedundancy: covers top-level infra agents (dreamer/.env at depth 1)', () => {
  // Walker topology — per learning walker-topology-must-match-scaffold-not-schema.md (ROS-85).
  // dreamer/ and chief-of-staff/ are depth-1 agents (peers of <function>/ dirs).
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'OPENAI_KEY=shared\n');
    mkdirSync(join(dir, 'dreamer'), { recursive: true });
    writeFileSync(join(dir, 'dreamer', '.env'), 'OPENAI_KEY=shared\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'warn');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.agentEnvPath, join('dreamer', '.env'));
    assert.equal(r.items[0]!.key, 'OPENAI_KEY');
  } finally {
    cleanup();
  }
});

test('check 14 / auditAgentEnvRedundancy: last-occurrence semantics (KEY declared twice → line points to LAST)', () => {
  // Per learning parser-last-wins-vs-line-finder-first-match.md (ROS-86):
  // parseEnvFile is last-wins, so the item's `line` field must point to the
  // last declaration, which is the line removeLineForKey will delete.
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=second\n');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'APOLLO_API_KEY=first\nAPOLLO_API_KEY=second\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'warn');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.line, 2, 'line should point to last occurrence, not first');
  } finally {
    cleanup();
  }
});

test('check 14 / auditAgentEnvRedundancy: empty-string match (workspace KEY= and agent KEY=) → flagged', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'TOGGLE=\n');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'TOGGLE=\n');
    const r = auditAgentEnvRedundancy(dir);
    assert.equal(r.status, 'warn');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.key, 'TOGGLE');
  } finally {
    cleanup();
  }
});

// removeLineForKey — apply helper for --fix
test('check 14 / removeLineForKey: happy path removes specified line, preserves others, preserves trailing newline', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const path = join(dir, 'agent.env');
    writeFileSync(path, 'A=1\nB=2\nC=3\n');
    const outcome = removeLineForKey(path, 2, 'B', '2', false);
    assert.equal(outcome.kind, 'removed');
    assert.equal(readFileSync(path, 'utf8'), 'A=1\nC=3\n');
  } finally {
    cleanup();
  }
});

test('check 14 / removeLineForKey: dual-guard rejects when key at line no longer matches expectedKey', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const path = join(dir, 'agent.env');
    writeFileSync(path, 'A=1\nB=2\nC=3\n');
    const outcome = removeLineForKey(path, 2, 'WRONG_KEY', '2', false);
    assert.equal(outcome.kind, 'changed');
    // File untouched.
    assert.equal(readFileSync(path, 'utf8'), 'A=1\nB=2\nC=3\n');
  } finally {
    cleanup();
  }
});

test('check 14 / removeLineForKey: dual-guard rejects when value at line no longer matches expectedValue', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const path = join(dir, 'agent.env');
    writeFileSync(path, 'A=1\nB=changed\nC=3\n');
    const outcome = removeLineForKey(path, 2, 'B', 'original', false);
    assert.equal(outcome.kind, 'changed');
    assert.equal(readFileSync(path, 'utf8'), 'A=1\nB=changed\nC=3\n');
  } finally {
    cleanup();
  }
});

test('check 14 / removeLineForKey: out-of-range line returns changed with reason', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const path = join(dir, 'agent.env');
    writeFileSync(path, 'A=1\n');
    const outcome = removeLineForKey(path, 99, 'A', '1', false);
    assert.equal(outcome.kind, 'changed');
    if (outcome.kind !== 'changed') return;
    assert.match(outcome.reason, /out of range/i);
  } finally {
    cleanup();
  }
});

test('check 14 / removeLineForKey: dryRun=true returns would-remove without modifying the file', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const path = join(dir, 'agent.env');
    const before = 'A=1\nB=2\nC=3\n';
    writeFileSync(path, before);
    const outcome = removeLineForKey(path, 2, 'B', '2', true);
    assert.equal(outcome.kind, 'would-remove');
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('check 14 / removeLineForKey: preserves CRLF line endings when original file uses CRLF', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const path = join(dir, 'agent.env');
    writeFileSync(path, 'A=1\r\nB=2\r\nC=3\r\n');
    const outcome = removeLineForKey(path, 2, 'B', '2', false);
    assert.equal(outcome.kind, 'removed');
    assert.equal(readFileSync(path, 'utf8'), 'A=1\r\nC=3\r\n');
  } finally {
    cleanup();
  }
});

test('check 14 / findLastLineForKey: returns null for absent key', () => {
  assert.equal(findLastLineForKey('A=1\nB=2\n', 'C'), null);
});

test('check 14 / findLastLineForKey: returns last 1-based line for duplicated key', () => {
  assert.equal(findLastLineForKey('K=a\nK=b\nK=c\n', 'K'), 3);
});

// confirmAndDeleteRedundantLines — prompt orchestrator (DI via FixPromptDeps)
function makePromptDeps(answer: string | null): {
  deps: { isTTY: boolean; stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };
  stdoutChunks: string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  if (answer === null) {
    stdin.end();
  } else {
    stdin.write(answer);
    stdin.end();
  }
  return { deps: { isTTY: true, stdin, stdout }, stdoutChunks: chunks };
}

test('check 14 / confirmAndDeleteRedundantLines: TTY + "y" → deleted populated, file modified', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'K=v\n');
    const agentEnvPath = join('gtm', 'sdr', '.env');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'K=v\n');
    const items = [{ agentEnvPath, line: 1, key: 'K' }];
    const { deps } = makePromptDeps('y\n');
    const outcome = await confirmAndDeleteRedundantLines(items, dir, deps, false);
    assert.equal(outcome.deleted.length, 1);
    assert.equal(outcome.skipped.length, 0);
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.nonTtySkipped, false);
    assert.equal(readFileSync(join(dir, agentEnvPath), 'utf8'), '');
  } finally {
    cleanup();
  }
});

test('check 14 / confirmAndDeleteRedundantLines: TTY + "n" → skipped populated, file untouched', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'K=v\n');
    const agentEnvPath = join('gtm', 'sdr', '.env');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'K=v\n');
    const items = [{ agentEnvPath, line: 1, key: 'K' }];
    const { deps } = makePromptDeps('n\n');
    const outcome = await confirmAndDeleteRedundantLines(items, dir, deps, false);
    assert.equal(outcome.deleted.length, 0);
    assert.equal(outcome.skipped.length, 1);
    assert.equal(readFileSync(join(dir, agentEnvPath), 'utf8'), 'K=v\n');
  } finally {
    cleanup();
  }
});

test('check 14 / confirmAndDeleteRedundantLines: non-TTY (isTTY=false) → nonTtySkipped=true, no file changes', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'K=v\n');
    const agentEnvPath = join('gtm', 'sdr', '.env');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'K=v\n');
    const items = [{ agentEnvPath, line: 1, key: 'K' }];
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const deps = { isTTY: false, stdin, stdout };
    const outcome = await confirmAndDeleteRedundantLines(items, dir, deps, false);
    assert.equal(outcome.nonTtySkipped, true);
    assert.equal(outcome.deleted.length, 0);
    assert.equal(readFileSync(join(dir, agentEnvPath), 'utf8'), 'K=v\n');
  } finally {
    cleanup();
  }
});

test('check 14 / confirmAndDeleteRedundantLines: dryRun=true on confirm → would-remove, no file write', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'K=v\n');
    const agentEnvPath = join('gtm', 'sdr', '.env');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'K=v\n');
    const items = [{ agentEnvPath, line: 1, key: 'K' }];
    const { deps } = makePromptDeps('y\n');
    const outcome = await confirmAndDeleteRedundantLines(items, dir, deps, true);
    // dryRun: file untouched; the would-remove path still records the item
    // somewhere observable, but we focus on the on-disk invariant here.
    assert.equal(readFileSync(join(dir, agentEnvPath), 'utf8'), 'K=v\n');
    assert.equal(outcome.failed.length, 0);
  } finally {
    cleanup();
  }
});

test('check 14 / confirmAndDeleteRedundantLines: empty items array → no-op outcome', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const { deps } = makePromptDeps('y\n');
    const outcome = await confirmAndDeleteRedundantLines([], dir, deps, false);
    assert.equal(outcome.deleted.length, 0);
    assert.equal(outcome.skipped.length, 0);
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.nonTtySkipped, false);
  } finally {
    cleanup();
  }
});

test('check 14 / confirmAndDeleteRedundantLines: workspace .env removed between audit and prompt → no deletion', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'K=v\n');
    const agentEnvPath = join('gtm', 'sdr', '.env');
    writeAgentEnvContent(dir, 'gtm', 'sdr', 'K=v\n');
    const items = [{ agentEnvPath, line: 1, key: 'K' }];
    // Audit ran, items computed — now workspace .env disappears.
    rmSync(join(dir, '.env'));
    const { deps } = makePromptDeps('y\n');
    const outcome = await confirmAndDeleteRedundantLines(items, dir, deps, false);
    // With workspace map empty, the per-item value-match guard fires inside
    // removeLineForKey (workspaceMap.get(K) is undefined ≠ 'v') and the line
    // is preserved. Deleted should be empty; agent .env unchanged.
    assert.equal(outcome.deleted.length, 0);
    assert.equal(readFileSync(join(dir, agentEnvPath), 'utf8'), 'K=v\n');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// Check 15 — referenced-but-unset across agents
// ──────────────────────────────────────────────────────────────────────

test('check 15 / auditEnvKeyReferences: no .env, no configs → ok empty', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.envKeys, []);
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: config references key present in .env → ok', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    writeConfigYaml(dir, 'gtm', 'sdr', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.envKeys, ['APOLLO_API_KEY']);
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: config references key missing from .env → fail', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'OTHER=1\n');
    writeConfigYaml(dir, 'gtm', 'sdr', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0]!.key, 'APOLLO_API_KEY');
    assert.equal(r.missing[0]!.references.length, 1);
    assert.match(r.missing[0]!.references[0]!.file, /config\.yaml$/);
  } finally {
    cleanup();
  }
});

// Symmetry with resolveAgentEnv (env-merge.ts): K= in workspace .env means
// "explicit unset" and must NOT satisfy ${K} references. Otherwise doctor
// passes while runtime dispatch fails with a missing-key error.
test('check 15 / auditEnvKeyReferences: empty-string workspace value does NOT satisfy reference', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=\n');
    writeConfigYaml(dir, 'gtm', 'sdr', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing[0]!.key, 'APOLLO_API_KEY');
    assert.deepEqual(r.envKeys, [], 'empty-valued keys are excluded from envKeys');
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: $BAREWORD form also detected', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeConfigYaml(dir, 'gtm', 'sdr', 'token: $SLACK_TOKEN\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing[0]!.key, 'SLACK_TOKEN');
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: well-known shell vars ($HOME, $PATH) are not flagged', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeConfigYaml(dir, 'gtm', 'sdr', 'path: $HOME/logs\nother: $PATH\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: top-level roster/ and dotdirs are skipped', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    mkdirSync(join(dir, 'roster', 'gtm', 'sdr'), { recursive: true });
    writeFileSync(join(dir, 'roster', 'gtm', 'sdr', 'config.yaml'), 'key: ${SHOULD_NOT_BE_FLAGGED_ROSTER}\n');
    // Write a config under a dotdir — should also be ignored.
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    writeFileSync(join(dir, '.hidden', 'config.yaml'), 'key: ${SHOULD_NOT_BE_FLAGGED_DOTDIR}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

// ROS-101: top-level infra agents (dreamer, chief-of-staff) live at depth 1
// in the v1 scaffold. The walker must yield <top>/config.yaml.
test('check 15 / auditEnvKeyReferences: depth-1 dreamer/config.yaml ${KEY} ref present → ok', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=secret\n');
    writeTopConfigYaml(dir, 'dreamer', 'apollo_token: ${APOLLO_API_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: depth-1 chief-of-staff/config.yaml ${KEY} ref missing → fail', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'OTHER=1\n');
    writeTopConfigYaml(dir, 'chief-of-staff', 'token: ${MISSING_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'fail');
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0]!.key, 'MISSING_KEY');
    assert.match(r.missing[0]!.references[0]!.file, /^chief-of-staff\/config\.yaml$/);
  } finally {
    cleanup();
  }
});

test('check 15 / auditEnvKeyReferences: SKIP_TOP excludes v1 workspace dirs (config, guidelines, logs, scripts)', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    for (const top of ['config', 'guidelines', 'logs', 'scripts']) {
      writeTopConfigYaml(dir, top, 'key: ${SHOULD_NOT_BE_FLAGGED}\n');
    }
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok', 'v1 workspace dirs must not be walked as agent dirs');
  } finally {
    cleanup();
  }
});

// Top-level agents are leaves: a depth-1 config.yaml means <top> IS the agent.
// The walker must NOT descend into <top>'s runtime subdirs (plans/, logs/, …)
// where an unrelated config.yaml could be misread as a depth-2 agent.
test('check 15 / auditEnvKeyReferences: depth-1 leaf agent does NOT descend into runtime subdirs', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'TOP_KEY=ok\n');
    writeTopConfigYaml(dir, 'dreamer', 'top: ${TOP_KEY}\n');
    // Booby trap: would flag MISSING_KEY if the walker descended.
    mkdirSync(join(dir, 'dreamer', 'plans'), { recursive: true });
    writeFileSync(join(dir, 'dreamer', 'plans', 'config.yaml'), 'sub: ${MISSING_KEY}\n');
    const r = auditEnvKeyReferences(dir);
    assert.equal(r.status, 'ok', 'leaf agent must short-circuit the depth-2 walk');
    assert.deepEqual(r.missing, []);
  } finally {
    cleanup();
  }
});

// listV1AgentPaths walker — direct unit tests for the walker output the
// audit pipeline depends on.
test('check 15 / listV1AgentPaths: yields depth-1 top-level agent when <top>/config.yaml present', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeTopConfigYaml(dir, 'dreamer', 'agent: dreamer/dreamer\nplans_dir: ./plans\n');
    const paths = listV1AgentPaths(dir);
    assert.ok(paths.includes('dreamer'), `expected 'dreamer' in walker output; got ${JSON.stringify(paths)}`);
  } finally {
    cleanup();
  }
});

test('check 15 / listV1AgentPaths: yields depth-1 AND depth-2 agents together, sorted', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeTopConfigYaml(dir, 'dreamer', 'agent: dreamer/dreamer\nplans_dir: ./plans\n');
    writeConfigYaml(dir, 'gtm', 'sdr', 'agent: gtm/sdr\nplans_dir: ./plans\n');
    writeTopConfigYaml(dir, 'chief-of-staff', 'agent: cos/cos\nplans_dir: ./plans\n');
    const paths = listV1AgentPaths(dir);
    assert.deepEqual(paths, ['chief-of-staff', 'dreamer', 'gtm/sdr']);
  } finally {
    cleanup();
  }
});

test('check 15 / listV1AgentPaths: depth-1 leaf does NOT yield phantom depth-2 entries', () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeTopConfigYaml(dir, 'dreamer', 'agent: dreamer/dreamer\nplans_dir: ./plans\n');
    // Booby trap: would yield 'dreamer/subagents' if walker descended.
    mkdirSync(join(dir, 'dreamer', 'subagents'), { recursive: true });
    writeFileSync(
      join(dir, 'dreamer', 'subagents', 'config.yaml'),
      'agent: dreamer/subagents\nplans_dir: ./plans\n',
    );
    const paths = listV1AgentPaths(dir);
    assert.deepEqual(paths, ['dreamer'], 'leaf agent must not yield phantom children');
  } finally {
    cleanup();
  }
});

// applyAgentEnvFix — apply helper for --fix (DI via opts.prompt).
// Synthetic AgentEnvRefsResult inputs decouple these tests from the audit
// surface, which is exercised separately by auditEnvKeyReferences above and
// by integration tests in test/cli-doctor.test.ts.
function makeRefs(...errors: AgentEnvRefMiss[]): AgentEnvRefsResult {
  return { status: errors.length > 0 ? 'fail' : 'ok', errors, warns: [] };
}

test('check 15 / applyAgentEnvFix: prompt returns selected keys → keys appended to /.env with empty value', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'EXISTING=1\n');
    const refs = makeRefs(
      { agent: 'gtm/sdr', binding: 'apollo', key: 'APOLLO_API_KEY', required: true },
      { agent: 'gtm/sdr', binding: 'slack', key: 'SLACK_TOKEN', required: true },
    );
    const outcome = await applyAgentEnvFix(dir, refs, {
      dryRun: false,
      prompt: async () => ['APOLLO_API_KEY', 'SLACK_TOKEN'],
    });
    assert.equal(outcome.failed.length, 0);
    const content = readFileSync(join(dir, '.env'), 'utf8');
    assert.match(content, /^EXISTING=1$/m);
    assert.match(content, /^APOLLO_API_KEY=$/m);
    assert.match(content, /^SLACK_TOKEN=$/m);
  } finally {
    cleanup();
  }
});

test('check 15 / applyAgentEnvFix: prompt returns [] → no append, fixed[] empty', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'EXISTING=1\n');
    const refs = makeRefs(
      { agent: 'gtm/sdr', binding: 'apollo', key: 'APOLLO_API_KEY', required: true },
    );
    const outcome = await applyAgentEnvFix(dir, refs, {
      dryRun: false,
      prompt: async () => [],
    });
    assert.equal(outcome.fixed.length, 0);
    assert.equal(outcome.failed.length, 0);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'EXISTING=1\n');
  } finally {
    cleanup();
  }
});

test('check 15 / applyAgentEnvFix: dry-run → "would append" entries, /.env unchanged', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'EXISTING=1\n');
    const refs = makeRefs(
      { agent: 'gtm/sdr', binding: 'apollo', key: 'APOLLO_API_KEY', required: true },
    );
    const outcome = await applyAgentEnvFix(dir, refs, {
      dryRun: true,
      prompt: async () => ['APOLLO_API_KEY'], // unused in dryRun path
    });
    assert.equal(outcome.failed.length, 0);
    assert.ok(outcome.fixed.some((l) => l.includes('would append') && l.includes('APOLLO_API_KEY')));
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'EXISTING=1\n');
  } finally {
    cleanup();
  }
});

test('check 15 / applyAgentEnvFix: selected key already in /.env → reported as already present (skipped)', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    writeFileSync(join(dir, '.env'), 'APOLLO_API_KEY=already-here\n');
    const refs = makeRefs(
      { agent: 'gtm/sdr', binding: 'apollo', key: 'APOLLO_API_KEY', required: true },
    );
    const outcome = await applyAgentEnvFix(dir, refs, {
      dryRun: false,
      prompt: async () => ['APOLLO_API_KEY'],
    });
    assert.equal(outcome.failed.length, 0);
    assert.ok(outcome.fixed.some((l) => l.includes('APOLLO_API_KEY') && /already present|skipped/i.test(l)));
    // Original line untouched.
    assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^APOLLO_API_KEY=already-here$/m);
  } finally {
    cleanup();
  }
});

test('check 15 / applyAgentEnvFix: /.env absent → file is created with the appended keys', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    assert.equal(existsSync(join(dir, '.env')), false, 'precondition: /.env should not exist');
    const refs = makeRefs(
      { agent: 'gtm/sdr', binding: 'apollo', key: 'APOLLO_API_KEY', required: true },
    );
    const outcome = await applyAgentEnvFix(dir, refs, {
      dryRun: false,
      prompt: async () => ['APOLLO_API_KEY'],
    });
    assert.equal(outcome.failed.length, 0);
    assert.equal(existsSync(join(dir, '.env')), true);
    assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^APOLLO_API_KEY=$/m);
  } finally {
    cleanup();
  }
});

test('check 15 / applyAgentEnvFix: empty refs (no errors, no warns) → no-op', async () => {
  const { dir, cleanup } = makeTmpCwd();
  try {
    const refs: AgentEnvRefsResult = { status: 'ok', errors: [], warns: [] };
    const outcome = await applyAgentEnvFix(dir, refs, {
      dryRun: false,
      prompt: async () => [],
    });
    assert.equal(outcome.fixed.length, 0);
    assert.equal(outcome.failed.length, 0);
  } finally {
    cleanup();
  }
});
