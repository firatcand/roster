import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_PROJECT_INSTRUCTIONS_PATH,
  CLAUDE_PROJECT_RULE_PATH,
  CODEX_PROJECT_INSTRUCTIONS_PATH,
  CODEX_ROSTER_SKILL_PATH,
  installV2ProjectActivation,
} from '../src/lib/generated-artifacts.ts';
import { parseDreamArgs } from '../src/lib/dream-args.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HOST_ENTRY_POINTS = {
  claude: [CLAUDE_PROJECT_INSTRUCTIONS_PATH, CLAUDE_PROJECT_RULE_PATH],
  codex: [CODEX_PROJECT_INSTRUCTIONS_PATH, CODEX_ROSTER_SKILL_PATH],
} as const;

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-dreamer-activation-'));
  writeFileSync(
    join(root, 'roster.yaml'),
    'schema_version: 2\nworkspace_id: test\ntool_uses: []\nfunctions: {}\nhosts: {}\n',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The host never reads ROSTER.md directly: it reads whatever its own tool loads,
// which then points at the shared bootstrap. Walking that pointer is the only
// way to prove the lifecycle actually REACHES the host.
function activationBytesFor(host: 'claude' | 'codex'): string {
  const ws = makeWorkspace();
  try {
    installV2ProjectActivation({ root: ws.root, host });
    const wrappers = HOST_ENTRY_POINTS[host]
      .filter((path) => existsSync(join(ws.root, path)))
      .map((path) => readFileSync(join(ws.root, path), 'utf8'));
    assert.ok(wrappers.length > 0, `${host}: no activation entry point was written`);
    for (const wrapper of wrappers) assert.match(wrapper, /ROSTER\.md/);
    return `${wrappers.join('\n')}\n${readFileSync(join(ws.root, 'ROSTER.md'), 'utf8')}`;
  } finally {
    ws.cleanup();
  }
}

test('both hosts are told to record, check, recheck, and read the exact occasion in order', () => {
  for (const host of ['claude', 'codex'] as const) {
    const bytes = activationBytesFor(host);
    const ordered = [
      '`roster brain record run`',
      '`roster dream status --json` immediately after recording',
      'again at the start of the next interaction that touches this workspace',
      'While the status is `due`',
      '`roster dream candidates list --readiness-key <readiness_key> --json`',
      'present that one and do not redraft',
      'stop for the human',
    ];
    let offset = -1;
    for (const fragment of ordered) {
      const next = bytes.indexOf(fragment, offset + 1);
      assert.ok(next > offset, `${host}: missing or out of order: ${fragment}`);
      offset = next;
    }
    // The recheck is durable RECOVERY, not a retry loop, and the empty-result
    // branch is the only one that authorizes drafting.
    assert.match(bytes, /a check that never happened is recovered by the next one/u);
    assert.match(bytes, /An empty result is the only case that warrants drafting/u);
    assert.match(bytes, /never approval authority/u);
  }
});

test('the generated activation teaches no timer, no queue, and no singular log tree', () => {
  for (const host of ['claude', 'codex'] as const) {
    const bytes = activationBytesFor(host);
    for (const forbidden of [/\bcron\b/iu, /\bnightly\b/iu, /\bslack\b/iu, /(?<!s)\blog\//u]) {
      assert.equal(forbidden.test(bytes), false, `${host}: ${String(forbidden)}`);
    }
    // `schedule` survives only inside the prohibition that names the retired
    // verbs. A negation SOMEWHERE on the line is too weak -- a positive
    // scheduling instruction appended to a negated sentence would pass -- so
    // every CLAUSE that mentions it must carry its own negation.
    const clauses = bytes.split('\n').flatMap((line) => line.split(/(?<=[.;:])\s+/u));
    const scheduling = clauses.filter((clause) => /schedul/iu.test(clause));
    assert.ok(scheduling.length > 0, `${host}: the prohibition clause disappeared`);
    for (const clause of scheduling) {
      assert.match(clause, /\b(?:Do not|do not|never|Never|no)\b/u, `${host}: unprohibited scheduling clause: ${clause}`);
    }
    // And the guard is proven able to fail: a positive clause appended to the
    // negated one must be rejected.
    const smuggled = `${scheduling[0]!} Register it with a scheduler.`
      .split(/(?<=[.;:])\s+/u)
      .filter((clause) => /schedul/iu.test(clause));
    assert.equal(
      smuggled.every((clause) => /\b(?:Do not|do not|never|Never|no)\b/u.test(clause)),
      false,
      'the per-clause guard must reject a positive scheduling clause beside a negated one',
    );
  }
});

test('every roster command the generated activation teaches parses through its own parser', () => {
  const bytes = activationBytesFor('claude');
  const taught = [...bytes.matchAll(/`roster ([a-z][^`]*)`/gu)]
    .map((match) => match[1]!.trim())
    // `roster brain save` and friends appear only as verbs the host must NOT
    // call; a prohibition is not a taught command.
    .filter((command) => !/^(?:run|schedule|pending|ops|brain save|brain event)$/u.test(command));
  const relevant = taught.filter((command) => /^(?:dream|brain) /u.test(command));
  assert.ok(relevant.length >= 4, `expected taught learning commands, saw ${JSON.stringify(relevant)}`);

  let sawReadinessKey = false;
  for (const command of relevant) {
    const tokens = command.split(/\s+/u).map((token) =>
      token.startsWith('<') && token.endsWith('>')
        ? (/readiness_key|sha256/u.test(token) ? `sha256:${'a'.repeat(64)}` : 'placeholder')
        : token);
    if (tokens.includes('--readiness-key')) sawReadinessKey = true;
    const [head, ...rest] = tokens;
    // The lifecycle names `roster brain record run` as a VERB the host invokes,
    // not as a complete argv; supplying the payload the verb requires is what
    // lets the real parser judge the verb SPELLING rather than the citation
    // style. A wrong verb still fails here -- `record nonsense --payload {}`
    // does not parse.
    const argv = head === 'brain' && !rest.some((token) => token.startsWith('--'))
      ? [...rest, '--payload', '{}']
      : rest;
    const parsed = head === 'dream' ? parseDreamArgs(argv) : parseBrainArgs(argv);
    assert.equal(parsed.kind, 'ok', `${command} -> ${JSON.stringify(parsed)}`);
  }
  assert.ok(sawReadinessKey, 'the generated lifecycle must teach the exact-key candidate read');
});

test('the shipped scaffold no longer carries the nightly Dreamer surfaces', () => {
  assert.equal(existsSync(join(PROJECT_ROOT, 'templates/scaffold/dreamer/plans')), false);
  assert.equal(existsSync(join(PROJECT_ROOT, 'templates/scaffold/dreamer/state.md')), false);

  // The one surviving v1 spelling is the byte-frozen legacy-detection signature
  // (workspace-probe.ts, smoke.sh). Naming it here means a SECOND file drifting
  // back in fails this test instead of passing unnoticed; #361/#363 own removing
  // it once the probe no longer needs its bytes.
  const readme = readFileSync(join(PROJECT_ROOT, 'templates/scaffold/dreamer/README.md'), 'utf8');
  for (const forbidden of [/\bnightly\b/iu, /\bslack\b/iu, /roster schedule/u, /state\.md/u]) {
    assert.equal(forbidden.test(readme), false, String(forbidden));
  }
  assert.match(readme, /roster dream status/u);
  assert.match(readme, /roster dream candidates list --readiness-key/u);

  const conventions = readFileSync(join(PROJECT_ROOT, 'templates/scaffold/conventions.md'), 'utf8');
  assert.equal(/Dreamer drafts .* `<agent>\/pending\/`/u.test(conventions), false);
  assert.match(conventions, /roster dream candidates promote/u);

  const rename = readFileSync(join(PROJECT_ROOT, 'templates/scaffold/scripts/rename-agent.sh'), 'utf8');
  assert.equal(/\/log\/(?:runs|feedback)\//u.test(rename), false);
  assert.match(rename, /\/logs\//u);
});
