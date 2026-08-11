import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { scaffoldWorkspace } from '../src/lib/workspace-registry.ts';
import { deriveWorkspaceRuntimeRoleName } from '../src/lib/brain/roles.ts';
import { ADMIN_URL, HAS_DB, createFreshDb } from './brain-helpers.ts';

// The workflow the SKILL documents, driven through the BUILT binary only: argv
// parsing, JSON output, payload files on disk, and subcommand dispatch are all
// exercised, because every one of them is a place the documented workflow can
// fail without a single library call noticing.
const BIN = resolve(process.cwd(), 'bin/roster.js');
// Unique per run: the runtime role name is DERIVED from the workspace id and
// PostgreSQL roles are cluster-global, so a crashed earlier run must not leave a
// role whose password no longer matches this run's ambient credential.
const WORKSPACE_ID = `cli-dream-${randomBytes(6).toString('hex')}`;
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };

type CliResult = { status: number; stdout: string; stderr: string };

function runtimeUrl(adminUrl: string, roleName: string, password: string): string {
  const parsed = new URL(adminUrl);
  return `${parsed.protocol}//${roleName}:${password}@${parsed.host}${parsed.pathname}`;
}

async function dropDerivedRole(roleName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName)) throw new Error('unsafe derived role fixture');
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
    if ((exists.rowCount ?? 0) === 0) return;
    await client.query(`REVOKE "${roleName}" FROM CURRENT_USER`);
    await client.query(`DROP ROLE "${roleName}"`);
  } finally {
    await client.end();
  }
}

test('the documented workflow runs end to end through the built CLI', options, async (t) => {
  const fresh = await createFreshDb();
  const root = mkdtempSync(join(tmpdir(), 'roster-cli-dream-'));
  // The DEFAULT role base: only `brain init` accepts --role, while every other
  // verb resolves the runtime role from the workspace id alone, so the ambient
  // credential has to name the default-derived role.
  const roleName = deriveWorkspaceRuntimeRoleName(WORKSPACE_ID);
  const password = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ROSTER_BRAIN_ADMIN_URL: fresh.url,
    ROSTER_BRAIN_URL: runtimeUrl(fresh.url, roleName, password),
  };
  const cli = (...args: string[]): CliResult => {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
      timeout: 120_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  };
  // Every dream and brain verb prints PRETTY JSON (`JSON.stringify(v, null, 2)`),
  // which is the shipped convention for these surfaces, so the pin is "stdout
  // parses as exactly one JSON document" rather than "one line".
  const json = (result: CliResult, label: string): Record<string, unknown> => {
    assert.equal(result.status, 0, `${label} exited ${result.status}: ${result.stdout}${result.stderr}`);
    let parsed: unknown;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); },
      `${label} stdout was not JSON: ${result.stdout}`);
    return parsed as Record<string, unknown>;
  };
  const writePayload = (name: string, value: unknown): string => {
    writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return name;
  };

  try {
    writeFileSync(join(root, 'roster.yaml'), [
      'schema_version: 2',
      `workspace_id: ${WORKSPACE_ID}`,
      'brain:',
      `  secrets_path: /${WORKSPACE_ID}`,
      '  storage:',
      `    bucket: ${WORKSPACE_ID}-vault`,
      '    region: eu-central-1',
      'functions: {}',
      'hosts:',
      '  codex: enabled',
      'tool_uses: []',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
    scaffoldWorkspace(root, { kind: 'function', id: 'growth', purpose: 'Growth' });
    scaffoldWorkspace(root, { kind: 'agent', id: 'sdr', scope: 'function:growth', purpose: 'SDR' });

    const init = cli('brain', 'init', '--json');
    assert.equal(init.status, 0, `brain init failed: ${init.stdout}${init.stderr}`);

    // Seed evidence through the RECORD verb, so even the fixture data arrives
    // over the same CLI surface a host would use.
    for (let index = 0; index < 6; index++) {
      const file = writePayload(`run-${index}.json`, {
        runId: `cli-run-${index}`,
        functionId: 'growth',
        agentId: 'sdr',
        planId: null,
        host: 'claude',
        hostVersion: '2.0.0',
        requestSummary: `seeded cli run ${index}`,
        requestHash: `sha256:${'a'.repeat(64)}`,
        startedAt: '2026-08-11T08:00:00.000Z',
        completedAt: '2026-08-11T08:04:00.000Z',
        outcome: 'succeeded',
        privacy: 'internal',
        trust: 'host-asserted',
        sources: [],
        tools: [],
        actor: {
          actorId: 'claude-session',
          assurance: 'host-attested',
          host: 'claude',
          sessionId: 'cli-dream',
        },
        provenance: { fixture: 'cli-dream' },
      });
      const recorded = cli('brain', 'record', 'run', '--file', file, '--json');
      assert.equal(recorded.status, 0, `record run failed: ${recorded.stdout}${recorded.stderr}`);
    }

    let candidateId = '';
    let action: Record<string, unknown> = {};

    await t.test('step 1-4: status, then a drafted candidate', () => {
      const status = json(cli('dream', 'status', '--json'), 'dream status');
      assert.equal(status['status'], 'due');
      const frontier = status['frontier'] as { ordinal: number };
      const policy = status['policy'] as { version: string; fingerprint: string };
      const watermark = status['watermark'] as { ordinal: number };
      const evidence = status['evidence'] as { completed_runs: number; feedback_records: number };

      const draft = writePayload('draft.json', {
        readiness_key: status['readiness_key'],
        scopeKey: (status['scope'] as { key: string }).key,
        lessonScopeKey: 'agent:growth/sdr',
        lessonId: 'shorter-openers',
        draftedByAgentId: 'dreamer',
        lessonPurpose: 'Open with one sentence about the prospect.',
        lessonBody: 'Lead with the prospect.\n\nKeep the first message under 60 words.',
        expectedEffect: 'Reply rate rises on cold outbound.',
        conflictingSurvey: 'none-found',
        counterexampleSurvey: 'none-found',
        policyVersion: policy.version,
        policyFingerprint: policy.fingerprint,
        watermarkOrdinal: watermark.ordinal,
        frontierOrdinal: frontier.ordinal,
        consumedCompletedRuns: evidence.completed_runs,
        consumedFeedbackRecords: evidence.feedback_records,
        supersedesCandidateId: null,
        privacyClass: 'internal',
        citations: [{
          role: 'supporting',
          evidenceKind: 'completed-run',
          // The LAST run recorded, so its observation ordinal IS the frontier
          // the snapshot binds.
          runId: 'cli-run-5',
          feedbackId: null,
          observationOrdinal: frontier.ordinal,
        }],
        actor: {
          actorId: 'dreamer',
          assurance: 'host-attested',
          host: 'claude',
          sessionId: 'cli-dream',
        },
        provenance: {},
      });
      const createResult = cli('dream', 'candidates', 'create', '--file', draft, '--json');
      assert.equal(createResult.status, 0, `create failed: ${createResult.stdout}${createResult.stderr}`);
      const created = json(createResult, 'create');
      assert.equal(created['status'], 'created');
      candidateId = created['candidate_id'] as string;
      assert.match(candidateId, /^sha256:[a-f0-9]{64}$/u);
      // The write verb never echoes the draft's prose back at the caller.
      assert.equal(JSON.stringify(created).includes('Lead with the prospect'), false);
    });

    await t.test('step 5: the CLI hands back the exact action a decision must carry', () => {
      const listed = json(
        cli('dream', 'candidates', 'list', '--candidate', candidateId, '--json'),
        'list --candidate',
      );
      const rows = listed['candidates'] as Record<string, unknown>[];
      assert.equal(rows.length, 1, 'the --candidate filter selects exactly one row');
      const actions = rows[0]!['decision_action'] as Record<string, Record<string, unknown>>;
      action = actions['promote']!;
      assert.match(action['target'] as string, /^dream-candidate:(?:[0-9a-f]{4}-){16}$/u);
      assert.equal((action['target'] as string).includes('sha256:'), false);
      assert.equal(action['effect'], 'dream-candidate-promote');
      assert.equal(action['scope'], 'agent:growth/sdr');
      assert.match(action['action_digest'] as string, /^sha256:[a-f0-9]{64}$/u);

      // The human-readable mode has to carry it too: a host reading the plain
      // output must not be told less than the JSON mode tells.
      const human = cli('dream', 'candidates', 'list', '--candidate', candidateId);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /decision action \(promote\): target=dream-candidate:/u);
      assert.match(human.stdout, /action_digest=sha256:/u);
    });

    await t.test('step 5b: recording the RAW candidate id is refused by the CLI', () => {
      const file = writePayload('bad-decision.json', {
        decisionId: 'hd-cli-raw-target',
        // The spelling the SKILL used to teach. It never reaches the lifecycle
        // broker at all -- the evidence contract's credential scan refuses it at
        // record time, which is why the SKILL now teaches reading the action.
        action: {
          target: candidateId,
          effect: 'dream-candidate-promote',
          scope: 'agent:growth/sdr',
          params: {},
        },
        actionSummary: 'approve the drafted lesson',
        requestedDecision: 'approval',
        answer: 'approved',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: {
          actorId: 'human',
          assurance: 'human-confirmed',
          decisionId: 'hd-cli-raw-target',
          actionDigest: action['action_digest'],
        },
        decidedAt: '2026-08-11T09:00:00.000Z',
        hostProvenance: { host: 'claude' },
      });
      const refused = cli('brain', 'record', 'decision', '--file', file, '--json');
      assert.notEqual(refused.status, 0, 'the raw candidate id must be refused');
      const failure = JSON.parse(refused.stdout) as { code: string; message: string };
      assert.equal(failure.code, 'BRAIN_EVIDENCE_INPUT_INVALID');
      assert.match(failure.message, /looks like a credential/u);
      assert.match(failure.message, /action\.target/u);
    });

    await t.test('step 5c-6: the decision records and the promotion materializes', () => {
      const file = writePayload('decision.json', {
        decisionId: 'hd-cli-promote',
        action: {
          target: action['target'],
          effect: action['effect'],
          scope: action['scope'],
          params: {},
        },
        actionSummary: 'approve the drafted lesson',
        requestedDecision: 'approval',
        answer: 'approved',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: {
          actorId: 'human',
          assurance: 'human-confirmed',
          decisionId: 'hd-cli-promote',
          actionDigest: action['action_digest'],
        },
        decidedAt: '2026-08-11T09:00:00.000Z',
        hostProvenance: { host: 'claude' },
      });
      const recorded = json(cli('brain', 'record', 'decision', '--file', file, '--json'), 'record decision');
      assert.equal(recorded['kind'], 'decision');
      assert.equal(recorded['status'], 'created');

      const promoted = json(
        cli('dream', 'candidates', 'promote', candidateId,
          '--decision', 'hd-cli-promote',
          '--action-digest', action['action_digest'] as string,
          '--json'),
        'promote',
      );
      assert.equal(promoted['ok'], true);
      assert.equal(promoted['status'], 'created');
      assert.equal(promoted['superseded'], false);

      // The lesson is a real file, with the recorded hash, registered on its agent.
      const lessonPath = join(root, 'functions/growth/agents/sdr/playbook/shorter-openers.md');
      assert.equal(existsSync(lessonPath), true, 'the promotion must produce a Git file');
      const content = readFileSync(lessonPath, 'utf8');
      assert.match(content, /^---\n/u);
      assert.match(content, /Keep the first message under 60 words\./u);
      assert.equal(promoted['path'], 'functions/growth/agents/sdr/playbook/shorter-openers.md');
      const agent = YAML.parse(
        readFileSync(join(root, 'functions/growth/agents/sdr/agent.yaml'), 'utf8'),
      ) as { lessons: string[] };
      assert.deepEqual(agent.lessons, ['shorter-openers']);

      // Re-running the SAME command converges rather than conflicting.
      const again = json(
        cli('dream', 'candidates', 'promote', candidateId,
          '--decision', 'hd-cli-promote',
          '--action-digest', action['action_digest'] as string,
          '--json'),
        'promote replay',
      );
      assert.equal(again['status'], 'existing');
      assert.equal(readFileSync(lessonPath, 'utf8'), content);
    });

    await t.test('brain doctor accounts for the materialized lesson', () => {
      const report = json(cli('brain', 'doctor', '--json'), 'brain doctor');
      const drift = report['lesson_drift'] as { ok: boolean; subjects: number };
      assert.equal(drift.ok, true, JSON.stringify(report['lesson_drift']));
      assert.equal(drift.subjects, 1);
      assert.equal(report['ok'], true, JSON.stringify(report['checks']));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await fresh.drop();
    await dropDerivedRole(roleName);
  }
});

// #359 acceptance 3, driven through the built binary as SEPARATE PROCESSES. The
// point is recovery across sessions: nothing in a process survives into the
// next, so every step here starts from the durable Brain alone. What the
// certification fixtures cannot express -- a recheck that is STILL due at the
// same watermark, because only promotion advances it -- is proven here.
test('a missed readiness check recovers, and the recheck never redrafts', options, async (t) => {
  const workspaceId = `cli-dream-recover-${randomBytes(6).toString('hex')}`;
  const fresh = await createFreshDb();
  const root = mkdtempSync(join(tmpdir(), 'roster-cli-dream-recover-'));
  const roleName = deriveWorkspaceRuntimeRoleName(workspaceId);
  const password = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ROSTER_BRAIN_ADMIN_URL: fresh.url,
    ROSTER_BRAIN_URL: runtimeUrl(fresh.url, roleName, password),
  };
  const cli = (...args: string[]): CliResult => {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
      timeout: 120_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  };
  const json = (result: CliResult, label: string): Record<string, unknown> => {
    assert.equal(result.status, 0, `${label} exited ${result.status}: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const writePayload = (name: string, value: unknown): string => {
    writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return name;
  };
  const listAt = (key: string): Record<string, unknown>[] =>
    json(cli('dream', 'candidates', 'list', '--readiness-key', key, '--json'), 'list --readiness-key')[
      'candidates'
    ] as Record<string, unknown>[];
  const draftAt = (
    name: string,
    status: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ): string => writePayload(name, {
    readiness_key: status['readiness_key'],
    scopeKey: (status['scope'] as { key: string }).key,
    lessonScopeKey: 'agent:growth/sdr',
    lessonId: 'shorter-openers',
    draftedByAgentId: 'dreamer',
    lessonPurpose: 'Open with one sentence about the prospect.',
    lessonBody: 'Lead with the prospect.\n\nKeep the first message under 60 words.',
    expectedEffect: 'Reply rate rises on cold outbound.',
    conflictingSurvey: 'none-found',
    counterexampleSurvey: 'none-found',
    policyVersion: (status['policy'] as { version: string }).version,
    policyFingerprint: (status['policy'] as { fingerprint: string }).fingerprint,
    watermarkOrdinal: (status['watermark'] as { ordinal: number }).ordinal,
    frontierOrdinal: (status['frontier'] as { ordinal: number }).ordinal,
    consumedCompletedRuns: (status['evidence'] as { completed_runs: number }).completed_runs,
    consumedFeedbackRecords: (status['evidence'] as { feedback_records: number }).feedback_records,
    supersedesCandidateId: null,
    privacyClass: 'internal',
    // The feedback record is the LAST observation recorded, so its ordinal IS
    // the frontier the snapshot binds -- any earlier one lies outside it.
    citations: [{
      role: 'supporting',
      evidenceKind: 'feedback',
      runId: null,
      feedbackId: 'cli-fb-0',
      observationOrdinal: (status['frontier'] as { ordinal: number }).ordinal,
    }],
    actor: {
      actorId: 'dreamer',
      assurance: 'host-attested',
      host: 'claude',
      sessionId: 'cli-dream-recover',
    },
    provenance: {},
    ...overrides,
  });

  let readinessKey = '';
  let firstCandidateId = '';
  let secondCandidateId = '';

  try {
    writeFileSync(join(root, 'roster.yaml'), [
      'schema_version: 2',
      `workspace_id: ${workspaceId}`,
      'brain:',
      `  secrets_path: /${workspaceId}`,
      '  storage:',
      `    bucket: ${workspaceId}-vault`,
      '    region: eu-central-1',
      'functions: {}',
      'hosts:',
      '  codex: enabled',
      'tool_uses: []',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
    scaffoldWorkspace(root, { kind: 'function', id: 'growth', purpose: 'Growth' });
    scaffoldWorkspace(root, { kind: 'agent', id: 'sdr', scope: 'function:growth', purpose: 'SDR' });
    assert.equal(cli('brain', 'init', '--json').status, 0);

    await t.test('process 1: evidence is recorded and the session ends without ever checking', () => {
      for (let index = 0; index < 6; index++) {
        const file = writePayload(`run-${index}.json`, {
          runId: `cli-run-${index}`,
          functionId: 'growth',
          agentId: 'sdr',
          planId: null,
          host: 'claude',
          hostVersion: '2.0.0',
          requestSummary: `seeded cli run ${index}`,
          requestHash: `sha256:${'a'.repeat(64)}`,
          startedAt: '2026-08-11T08:00:00.000Z',
          completedAt: '2026-08-11T08:04:00.000Z',
          outcome: 'succeeded',
          privacy: 'internal',
          trust: 'host-asserted',
          sources: [],
          tools: [],
          actor: {
            actorId: 'claude-session',
            assurance: 'host-attested',
            host: 'claude',
            sessionId: 'cli-dream-recover',
          },
          provenance: { fixture: 'cli-dream-recover' },
        });
        assert.equal(cli('brain', 'record', 'run', '--file', file, '--json').status, 0);
      }
      const feedback = writePayload('feedback-0.json', {
        feedbackId: 'cli-fb-0',
        runId: 'cli-run-0',
        signal: 'negative',
        summary: 'the opener buried the prospect',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: {
          actorId: 'claude-session',
          assurance: 'host-attested',
          host: 'claude',
          sessionId: 'cli-dream-recover',
        },
        provenance: { fixture: 'cli-dream-recover' },
      });
      assert.equal(cli('brain', 'record', 'feedback', '--file', feedback, '--json').status, 0);
      // No `dream status` call at all: this session simply stops here.
    });

    await t.test('process 2: the next session recovers the missed occasion and drafts once', () => {
      const status = json(cli('dream', 'status', '--json'), 'dream status');
      assert.equal(status['status'], 'due', 'the durable watermark recovers the skipped check');
      readinessKey = status['readiness_key'] as string;
      assert.match(readinessKey, /^sha256:[a-f0-9]{64}$/u);

      // Nothing drafted for this occasion yet: the branch that authorizes a new
      // candidate, and the branch a wrongly-widened filter would hide.
      assert.deepEqual(listAt(readinessKey), []);

      const created = json(
        cli('dream', 'candidates', 'create', '--file', draftAt('draft-a.json', status, {}), '--json'),
        'create a',
      );
      assert.equal(created['status'], 'created');
      firstCandidateId = created['candidate_id'] as string;

      const rows = listAt(readinessKey);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!['candidate_id'], firstCandidateId);
      assert.equal(rows[0]!['state'], 'open');
    });

    await t.test('process 3: the recheck is STILL due at the same key and presents, never redrafts', () => {
      const recheck = json(cli('dream', 'status', '--json'), 'dream status recheck');
      // Only promotion advances the watermark, so an unresolved occasion stays
      // due across sessions -- exactly the state the host must not re-draft in.
      assert.equal(recheck['status'], 'due');
      assert.equal(recheck['readiness_key'], readinessKey, 'the key is stable at one frontier');

      const rows = listAt(readinessKey);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!['state'], 'open', 'the present-do-not-draft branch');

      // A byte-identical replay is idempotent: the DB alone stops an exact retry.
      const replay = json(
        cli('dream', 'candidates', 'create', '--file', draftAt('draft-a.json', recheck, {}), '--json'),
        'create a replay',
      );
      assert.equal(replay['status'], 'existing');
      assert.equal(replay['candidate_id'], firstCandidateId);
    });

    await t.test('the DB alone permits a SECOND draft of the same lesson -- only the instruction does not', () => {
      const status = json(cli('dream', 'status', '--json'), 'dream status');
      const second = json(
        cli('dream', 'candidates', 'create', '--file', draftAt('draft-b.json', status, {
          lessonBody: 'Lead with the prospect.\n\nName one specific thing they shipped.',
        }), '--json'),
        'create b',
      );
      // Same normalized subject, different content digest: the identity unique is
      // (readiness_key, content_digest), so this is a NEW candidate and no
      // refusal fires. The duplicate-presentation guard is the instruction and
      // the warning, not a constraint -- which is why both are load-bearing.
      assert.equal(second['status'], 'created');
      secondCandidateId = second['candidate_id'] as string;
      assert.notEqual(secondCandidateId, firstCandidateId);
      const warnings = second['warnings'] as Array<{ code: string }>;
      assert.ok(
        warnings.some((warning) => warning.code === 'SAME_LESSON_FILE'),
        `expected SAME_LESSON_FILE, saw ${JSON.stringify(warnings)}`,
      );
      assert.equal(listAt(readinessKey).length, 2);
    });

    await t.test('rejection leaves the occasion due, and damps the same subject', () => {
      const rows = listAt(readinessKey);
      const target = rows.find((row) => row['candidate_id'] === secondCandidateId)!;
      const rejectAction = (target['decision_action'] as Record<string, Record<string, unknown>>)['reject']!;
      const file = writePayload('reject.json', {
        decisionId: 'hd-cli-reject',
        action: {
          target: rejectAction['target'],
          effect: rejectAction['effect'],
          scope: rejectAction['scope'],
          params: {},
        },
        actionSummary: 'decline the second draft',
        requestedDecision: 'approval',
        answer: 'rejected',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: {
          actorId: 'human',
          assurance: 'human-confirmed',
          decisionId: 'hd-cli-reject',
          actionDigest: rejectAction['action_digest'],
        },
        decidedAt: '2026-08-11T09:00:00.000Z',
        hostProvenance: { host: 'claude' },
      });
      assert.equal(json(cli('brain', 'record', 'decision', '--file', file, '--json'), 'record reject')['status'], 'created');
      const rejected = json(
        cli('dream', 'candidates', 'reject', secondCandidateId,
          '--decision', 'hd-cli-reject',
          '--action-digest', rejectAction['action_digest'] as string,
          '--json'),
        'reject',
      );
      assert.equal(rejected['ok'], true);

      // A rejection adds no evidence and never advances the watermark.
      const afterReject = json(cli('dream', 'status', '--json'), 'dream status after reject');
      assert.equal(afterReject['status'], 'due');
      assert.equal(afterReject['readiness_key'], readinessKey);
      // The exact-key list still sees the decided row: this is why the skill
      // reads the key with NO state filter.
      const states = listAt(readinessKey).map((row) => row['state']).sort();
      assert.deepEqual(states, ['open', 'rejected']);

      // And the same subject cannot simply be redrafted at the same frontier.
      const damped = cli('dream', 'candidates', 'create', '--file', draftAt('draft-c.json', afterReject, {
        lessonBody: 'Lead with the prospect.\n\nA third phrasing of the same idea.',
      }), '--json');
      assert.notEqual(damped.status, 0, `expected a damping refusal, got ${damped.stdout}`);
      assert.equal((JSON.parse(damped.stdout) as { code: string }).code, 'BRAIN_DREAM_DAMPED');
    });

    await t.test('promotion is what finally closes the occasion', () => {
      const target = listAt(readinessKey).find((row) => row['candidate_id'] === firstCandidateId)!;
      const promoteAction = (target['decision_action'] as Record<string, Record<string, unknown>>)['promote']!;
      const file = writePayload('promote.json', {
        decisionId: 'hd-cli-recover-promote',
        action: {
          target: promoteAction['target'],
          effect: promoteAction['effect'],
          scope: promoteAction['scope'],
          params: {},
        },
        actionSummary: 'approve the drafted lesson',
        requestedDecision: 'approval',
        answer: 'approved',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: {
          actorId: 'human',
          assurance: 'human-confirmed',
          decisionId: 'hd-cli-recover-promote',
          actionDigest: promoteAction['action_digest'],
        },
        decidedAt: '2026-08-11T09:05:00.000Z',
        hostProvenance: { host: 'claude' },
      });
      assert.equal(json(cli('brain', 'record', 'decision', '--file', file, '--json'), 'record promote')['status'], 'created');
      const promoted = json(
        cli('dream', 'candidates', 'promote', firstCandidateId,
          '--decision', 'hd-cli-recover-promote',
          '--action-digest', promoteAction['action_digest'] as string,
          '--json'),
        'promote',
      );
      assert.equal(promoted['ok'], true);

      const closed = json(cli('dream', 'status', '--json'), 'dream status after promote');
      assert.equal(closed['status'], 'not_due', 'the promoted occasion cannot re-prompt');
    });

    await t.test('new evidence opens a NEW occasion with a different key', () => {
      const file = writePayload('run-later.json', {
        runId: 'cli-run-later',
        functionId: 'growth',
        agentId: 'sdr',
        planId: null,
        host: 'claude',
        hostVersion: '2.0.0',
        requestSummary: 'a later run',
        requestHash: `sha256:${'b'.repeat(64)}`,
        startedAt: '2026-08-12T08:00:00.000Z',
        completedAt: '2026-08-12T08:04:00.000Z',
        outcome: 'succeeded',
        privacy: 'internal',
        trust: 'host-asserted',
        sources: [],
        tools: [],
        actor: {
          actorId: 'claude-session',
          assurance: 'host-attested',
          host: 'claude',
          sessionId: 'cli-dream-recover',
        },
        provenance: { fixture: 'cli-dream-recover' },
      });
      assert.equal(cli('brain', 'record', 'run', '--file', file, '--json').status, 0);
      const later = json(cli('dream', 'status', '--json'), 'dream status later');
      assert.notEqual(later['readiness_key'], readinessKey);
      // And the old occasion's rows are still reachable at their own key only.
      assert.deepEqual(listAt(later['readiness_key'] as string), []);
      assert.equal(listAt(readinessKey).length, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await fresh.drop();
    await dropDerivedRole(roleName);
  }
});
