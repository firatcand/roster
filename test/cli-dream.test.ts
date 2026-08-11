import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseDreamArgs } from '../src/lib/dream-args.ts';
import { decisionActionsFor } from '../src/lib/brain/dream-candidates.ts';
import {
  SUPERSEDED_MESSAGE,
  executeDreamStatus,
  renderCandidateLines,
  renderUnverifiedLines,
} from '../src/commands/dream.ts';
import { RosterError } from '../src/lib/errors.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const WORKSPACE_ID = 'dream-cli-test';

function ok(args: string[]) {
  const parsed = parseDreamArgs(args);
  assert.equal(parsed.kind, 'ok', JSON.stringify(parsed));
  return parsed as Extract<ReturnType<typeof parseDreamArgs>, { kind: 'ok' }>;
}

function bad(args: string[]): string {
  const parsed = parseDreamArgs(args);
  assert.equal(parsed.kind, 'err', JSON.stringify(parsed));
  return (parsed as { kind: 'err'; message: string }).message;
}

function writeWorkspace(root: string, withBrain: boolean): void {
  writeFileSync(
    join(root, 'roster.yaml'),
    [
      'schema_version: 2',
      `workspace_id: ${WORKSPACE_ID}`,
      ...(withBrain
        ? [
            'brain:',
            `  secrets_path: /${WORKSPACE_ID}`,
            '  storage:',
            `    bucket: ${WORKSPACE_ID}`,
            '    region: eu-central-1',
          ]
        : []),
      'functions: {}',
      'hosts:',
      '  codex: enabled',
      'tool_uses: []',
      '',
    ].join('\n'),
    'utf8',
  );
}

test('dream status parses its scope aliases and refuses every other verb', () => {
  assert.deepEqual({ ...ok(['status']) }, {
    kind: 'ok', subcommand: 'status', json: false,
    scope: undefined, functionId: undefined, agent: undefined,
  });
  assert.deepEqual({ ...ok(['status', '--json', '--scope', 'agent:gtm/manager']) }, {
    kind: 'ok', subcommand: 'status', json: true,
    scope: 'agent:gtm/manager', functionId: undefined, agent: undefined,
  });
  assert.deepEqual({ ...ok(['status', '--function', 'gtm']) }, {
    kind: 'ok', subcommand: 'status', json: false,
    scope: undefined, functionId: 'gtm', agent: undefined,
  });
  assert.deepEqual({ ...ok(['status', '--agent', 'gtm/manager']) }, {
    kind: 'ok', subcommand: 'status', json: false,
    scope: undefined, functionId: undefined, agent: 'gtm/manager',
  });

  // The usage error names exactly the surface that exists, so a host never
  // believes in a verb Roster does not have.
  for (const verb of ['reflect', 'promote', 'status-all']) {
    const message = bad([verb]);
    assert.match(message, /unknown 'dream' subcommand/u, verb);
    assert.match(message, /available: status \| candidates/u, verb);
  }
  assert.match(bad([]), /missing subcommand for 'dream' \(available: status \| candidates\)/u);
  assert.match(bad(['status', '--scope']), /--scope requires a value/u);
  assert.match(bad(['status', '--function', '--json']), /--function requires a value/u);
  assert.match(bad(['status', '--force']), /unknown flag for 'dream status'/u);
  assert.match(bad(['status', 'workspace']), /unexpected positional argument/u);
});

test('the candidate grammar accepts exactly the shipped surface', () => {
  assert.deepEqual({ ...ok(['candidates', 'list']) }, {
    kind: 'ok', subcommand: 'candidates', verb: 'list', json: false,
    state: undefined, target: undefined, candidateId: undefined, limit: undefined,
  });
  assert.deepEqual({ ...ok(['candidates', 'list', '--json', '--state', 'open', '--target', 'gtm/sdr', '--limit', '5']) }, {
    kind: 'ok', subcommand: 'candidates', verb: 'list', json: true,
    state: 'open', target: 'gtm/sdr', candidateId: undefined, limit: 5,
  });
  assert.deepEqual({ ...ok(['candidates', 'list', '--candidate', 'sha256:abc']) }, {
    kind: 'ok', subcommand: 'candidates', verb: 'list', json: false,
    state: undefined, target: undefined, candidateId: 'sha256:abc', limit: undefined,
  });
  assert.deepEqual({ ...ok(['candidates', 'create', '--stdin']) }, {
    kind: 'ok', subcommand: 'candidates', verb: 'create', json: false,
    file: undefined, stdin: true,
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  for (const verb of ['promote', 'reject', 'retire'] as const) {
    assert.deepEqual({ ...ok(['candidates', verb, 'cand-1', '--decision', 'hd-1', '--action-digest', digest]) }, {
      kind: 'ok', subcommand: 'candidates', verb, json: false,
      candidateId: 'cand-1', decisionId: 'hd-1', actionDigest: digest,
    });
  }

  assert.match(bad(['candidates']), /missing verb for 'dream candidates'/u);
  assert.match(bad(['candidates', 'approve']), /unknown 'dream candidates' verb 'approve'/u);
  assert.match(bad(['candidates', 'list', '--state', 'nope']), /unknown --state 'nope'/u);
  assert.match(bad(['candidates', 'list', '--limit', '0']), /--limit must be a whole number/u);
  assert.match(bad(['candidates', 'create']), /pass exactly one of --file <path> or --stdin/u);
  assert.match(bad(['candidates', 'create', '--file', 'a', '--stdin']), /pass exactly one of/u);
  assert.match(bad(['candidates', 'promote']), /a candidate id is required/u);
  assert.match(bad(['candidates', 'promote', 'c1']), /--decision <human-decision-id> is required/u);
  assert.match(bad(['candidates', 'promote', 'c1', '--decision', 'hd']), /--action-digest <sha256:\.\.\.> is required/u);
  assert.match(bad(['candidates', 'promote', 'c1', 'c2', '--decision', 'hd', '--action-digest', digest]), /unexpected positional/u);
});

test('the superseded, unverified, and warning reports say exactly what to do next', () => {
  // A superseded replay is a deliberate NO-OP at exit 0: retrying is not the
  // remedy, reading the current state is.
  assert.match(SUPERSEDED_MESSAGE, /superseded by later lifecycle activity/u);
  assert.match(SUPERSEDED_MESSAGE, /no filesystem change/u);

  const pre = renderUnverifiedLines('pre-phase', 'the fence connection was lost').join('\n');
  assert.match(pre, /UNVERIFIED \(no mutation performed\)/u);
  assert.match(pre, /re-run the verb \(it converges\) and run roster brain doctor/u);
  const post = renderUnverifiedLines('post-phase', 'the subject governor changed under the fence').join('\n');
  assert.match(post, /UNVERIFIED/u);
  assert.equal(/no mutation performed/u.test(post), false);
  assert.match(post, /re-run the verb \(it converges\)/u);

  // The list renderer prints the warning verbatim and never fails on one.
  const rendered = renderCandidateLines([{
    candidate_id: `sha256:${'a'.repeat(64)}`,
    state: 'open',
    scope_key: 'workspace',
    lesson_scope_key: 'agent:gtm/sdr',
    lesson_agent_key: 'gtm/sdr',
    lesson_id: 'shorter-openers',
    lesson_qualified_id: 'gtm/sdr/playbook/shorter-openers',
    drafted_by_agent_id: 'dreamer',
    lesson_purpose: 'Lead with the prospect.',
    privacy_class: 'internal',
    policy_version: 'roster.dream.default.v1',
    readiness_key: `sha256:${'b'.repeat(64)}`,
    watermark_ordinal: 0,
    frontier_ordinal: 9,
    recorded_at: '2026-08-11T09:00:00.000Z',
    supersedes_candidate_id: null,
    decision_action: decisionActionsFor(`sha256:${'a'.repeat(64)}`, 'agent:gtm/sdr'),
    warnings: [{ code: 'SAME_LESSON_FILE', detail: 'both cannot be promoted — retire the promoted one first.' }],
  }]).join('\n');
  assert.match(rendered, /SAME_LESSON_FILE/u);
  assert.match(rendered, /both cannot be promoted/u);
  assert.match(rendered, /gtm\/sdr\/playbook\/shorter-openers/u);

  // The list PRINTS the exact human-decision action for every verb. A host
  // cannot derive the target: it is a grouped spelling of the candidate digest,
  // because a bare sha256 is credential-shaped and is refused in free text.
  for (const verb of ['promote', 'reject', 'retire']) {
    assert.match(rendered, new RegExp(`decision action \\(${verb}\\): target=dream-candidate:aaaa-`, 'u'));
    assert.match(rendered, new RegExp(`effect=dream-candidate-${verb} scope=agent:gtm/sdr`, 'u'));
  }
  assert.equal(/target=sha256:/u.test(rendered), false, 'the raw digest is never the decision target');
  assert.deepEqual(renderCandidateLines([]).some((line) => line.includes('no candidates recorded')), true);
});

test('a workspace with no brain block answers not_due at exit 0 without a pool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-local-'));
  const originalUrl = process.env.ROSTER_BRAIN_URL;
  const originalAdminUrl = process.env.ROSTER_BRAIN_ADMIN_URL;
  const logged: string[] = [];
  const log = console.log;
  console.log = (value?: unknown) => { logged.push(String(value)); };
  try {
    writeWorkspace(root, false);
    // Both ambient credentials are removed: had a pool been constructed, the
    // runtime credential resolver would have thrown BRAIN_RUNTIME_CREDENTIAL_INVALID
    // instead of returning a verdict, so exit 0 IS the no-pool proof.
    delete process.env.ROSTER_BRAIN_URL;
    delete process.env.ROSTER_BRAIN_ADMIN_URL;
    const code = await executeDreamStatus({ cwd: root, json: true });
    assert.equal(code, 0);
    const result = JSON.parse(logged.join('\n')) as Record<string, never>;
    assert.equal(result['ok'], true);
    assert.equal(result['status'], 'not_due');
    assert.equal(result['workspace_id'], WORKSPACE_ID);
    assert.deepEqual(
      (result['reasons'] as unknown as { code: string }[]).map((reason) => reason.code),
      ['BRAIN_NOT_CONFIGURED'],
    );
    assert.equal((result['frontier'] as unknown as { ordinal: number }).ordinal, 0);
    assert.equal((result['watermark'] as unknown as { state: string }).state, 'genesis');
    assert.equal((result['policy'] as unknown as { source: string }).source, 'built-in');
  } finally {
    console.log = log;
    if (originalUrl === undefined) delete process.env.ROSTER_BRAIN_URL;
    else process.env.ROSTER_BRAIN_URL = originalUrl;
    if (originalAdminUrl === undefined) delete process.env.ROSTER_BRAIN_ADMIN_URL;
    else process.env.ROSTER_BRAIN_ADMIN_URL = originalAdminUrl;
    rmSync(root, { recursive: true, force: true });
  }
});

test('conflicting scope aliases are refused before any Brain contact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-scope-'));
  try {
    writeWorkspace(root, false);
    await assert.rejects(
      executeDreamStatus({ cwd: root, json: true, scope: 'function:gtm', agent: 'gtm/manager' }),
      (error: unknown) => error instanceof RosterError && error.code === 'IDENTITY_INVALID',
    );
    await assert.rejects(
      executeDreamStatus({ cwd: root, json: true, scope: 'agent:gtm' }),
      (error: unknown) => error instanceof RosterError && error.code === 'IDENTITY_INVALID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the built CLI routes dream status and reports it in --help', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-bin-'));
  try {
    writeWorkspace(root, false);
    const env = { ...process.env };
    delete env['ROSTER_BRAIN_URL'];
    delete env['ROSTER_BRAIN_ADMIN_URL'];
    const status = spawnSync(process.execPath, [BIN, 'dream', 'status', '--json'], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    assert.equal(status.status, 0, status.stderr);
    const parsed = JSON.parse(status.stdout) as { ok: boolean; status: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'not_due');

    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', cwd: root, env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /roster dream status/u);

    assert.match(help.stdout, /roster dream candidates/u);

    const unknown = spawnSync(process.execPath, [BIN, 'dream', 'reflect', '--json'], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    assert.notEqual(unknown.status, 0);
    assert.match(JSON.parse(unknown.stdout).message as string, /available: status \| candidates/u);

    // The list verb mirrors `status`'s local-only tolerance: a Brain-less
    // workspace answers with an empty list at exit 0 rather than erroring on an
    // ordinary host interaction.
    const list = spawnSync(process.execPath, [BIN, 'dream', 'candidates', 'list', '--json'], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), { ok: true, candidates: [], brain: 'not-configured' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
