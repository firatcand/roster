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
