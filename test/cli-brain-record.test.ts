import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { RUNTIME_ROLE } from '../src/lib/brain/roles.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture } from './support/brain-evidence-fixture.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const WORKSPACE_ID = 'evidence-cli-test';
const dbOptions = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const ACTOR = {
  actorId: 'codex-session',
  assurance: 'host-attested',
  host: 'codex',
  sessionId: 'evidence-cli',
};

function ok(args: string[]) {
  const parsed = parseBrainArgs(args);
  assert.equal(parsed.kind, 'ok', JSON.stringify(parsed));
  return parsed as Extract<ReturnType<typeof parseBrainArgs>, { kind: 'ok' }>;
}

function bad(args: string[]): string {
  const parsed = parseBrainArgs(args);
  assert.equal(parsed.kind, 'err', JSON.stringify(parsed));
  return (parsed as { kind: 'err'; message: string }).message;
}

test('brain record parses exactly one bounded payload source per evidence kind', () => {
  for (const kind of ['run', 'artifact', 'feedback', 'decision']) {
    const parsed = ok(['record', kind, '--payload', '{"a":1}']);
    assert.equal(parsed.subcommand, 'record');
    assert.deepEqual(
      { ...parsed },
      { kind: 'ok', subcommand: 'record', json: false, recordKind: kind, payload: '{"a":1}', file: undefined },
    );
  }
  const fromFile = ok(['record', 'run', '--file', 'evidence/run.json', '--json']);
  assert.deepEqual(
    { ...fromFile },
    { kind: 'ok', subcommand: 'record', json: true, recordKind: 'run', payload: undefined, file: 'evidence/run.json' },
  );

  assert.match(bad(['record']), /requires a kind: run \| artifact \| feedback \| decision/u);
  assert.match(bad(['record', 'lesson', '--payload', '{}']), /requires a kind/u);
  assert.match(bad(['record', 'run']), /exactly one of --payload or --file/u);
  assert.match(
    bad(['record', 'run', '--payload', '{}', '--file', 'evidence/run.json']),
    /exactly one of --payload or --file/u,
  );
  assert.match(bad(['record', 'run', '--payload']), /--payload requires a value/u);
  assert.match(bad(['record', 'run', '--file', '--json']), /--file requires a value/u);
  assert.match(bad(['record', 'run', '--payload', '{}', '--force']), /unknown flag/u);
  assert.match(bad(['record', 'run', '--payload', '{}', 'extra']), /unexpected positional argument/u);
  assert.match(bad(['recordd', 'run']), /unknown 'brain' subcommand/u);
});

function writeWorkspace(root: string): void {
  writeFileSync(
    join(root, 'roster.yaml'),
    [
      'schema_version: 2',
      `workspace_id: ${WORKSPACE_ID}`,
      'brain:',
      `  secrets_path: /${WORKSPACE_ID}`,
      '  storage:',
      `    bucket: ${WORKSPACE_ID}`,
      '    region: eu-central-1',
      'functions: {}',
      'hosts:',
      '  codex: enabled',
      'tool_uses: []',
      '',
    ].join('\n'),
    'utf8',
  );
}

function runBin(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env });
}

test('roster brain record appends evidence through the verified runtime pool', dbOptions, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID, RUNTIME_ROLE);
  const root = mkdtempSync(join(tmpdir(), 'roster-evidence-cli-'));
  try {
    writeWorkspace(root);
    mkdirSync(join(root, 'evidence'), { recursive: true });
    const env = { ...process.env, ROSTER_BRAIN_URL: fixture.runtimeUrl };

    const runPayload = {
      runId: 'run-cli-001',
      functionId: 'social-media',
      agentId: 'manager',
      planId: null,
      host: 'codex',
      hostVersion: '0.51.0',
      requestSummary: 'record a completed run from the CLI',
      requestHash: `sha256:${'a'.repeat(64)}`,
      startedAt: '2026-08-08T10:00:00.000Z',
      completedAt: '2026-08-08T10:01:00.000Z',
      outcome: 'succeeded',
      privacy: 'internal',
      trust: 'host-asserted',
      sources: [{ kind: 'external', locator: { provider: 'notion', page: 'brief' } }],
      tools: [{ toolUseId: 'social-publish' }],
      actor: ACTOR,
      provenance: { via: 'cli' },
    };
    writeFileSync(join(root, 'evidence', 'run.json'), JSON.stringify(runPayload), 'utf8');

    await t.test('records from --file and replays idempotently from --payload', () => {
      const created = runBin(['brain', 'record', 'run', '--file', 'evidence/run.json', '--json'], root, env);
      assert.equal(created.status, 0, created.stderr);
      const createdJson = JSON.parse(created.stdout) as Record<string, unknown>;
      assert.equal(createdJson.ok, true);
      assert.equal(createdJson.kind, 'run');
      assert.equal(createdJson.status, 'created');
      assert.equal(createdJson.id, 'run-cli-001');
      assert.match(String(createdJson.recordFingerprint), /^sha256:[a-f0-9]{64}$/u);

      const replay = runBin(
        ['brain', 'record', 'run', '--payload', JSON.stringify(runPayload), '--json'],
        root,
        env,
      );
      assert.equal(replay.status, 0, replay.stderr);
      const replayJson = JSON.parse(replay.stdout) as Record<string, unknown>;
      assert.equal(replayJson.status, 'existing');
      assert.equal(replayJson.recordFingerprint, createdJson.recordFingerprint);

      const conflicting = runBin(
        ['brain', 'record', 'run', '--payload', JSON.stringify({ ...runPayload, outcome: 'failed' }), '--json'],
        root,
        env,
      );
      assert.notEqual(conflicting.status, 0);
      const conflictJson = JSON.parse(conflicting.stdout) as Record<string, unknown>;
      assert.equal(conflictJson.ok, false);
      assert.equal(conflictJson.code, 'BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT');
      assert.match(String(conflictJson.message), /already recorded/u);
    });

    await t.test('never echoes the payload back to the terminal', () => {
      const feedback = {
        feedbackId: 'feedback-cli-001',
        runId: 'run-cli-001',
        signal: 'positive',
        summary: 'a confidential internal note nobody should see in a transcript',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        provenance: { via: 'cli' },
      };
      const result = runBin(['brain', 'record', 'feedback', '--payload', JSON.stringify(feedback)], root, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes('confidential internal note'), false);
      assert.match(result.stdout, /feedback evidence created: feedback-cli-001/u);
    });

    await t.test('confines --file to the workspace and bounds malformed payloads', () => {
      const outside = mkdtempSync(join(tmpdir(), 'roster-evidence-outside-'));
      try {
        writeFileSync(join(outside, 'run.json'), JSON.stringify(runPayload), 'utf8');
        symlinkSync(join(outside, 'run.json'), join(root, 'evidence', 'linked.json'));

        const viaSymlink = runBin(['brain', 'record', 'run', '--file', 'evidence/linked.json', '--json'], root, env);
        assert.notEqual(viaSymlink.status, 0);
        const viaTraversal = runBin(['brain', 'record', 'run', '--file', '../run.json', '--json'], root, env);
        assert.notEqual(viaTraversal.status, 0);
        const viaAbsolute = runBin(
          ['brain', 'record', 'run', '--file', join(outside, 'run.json'), '--json'],
          root,
          env,
        );
        assert.notEqual(viaAbsolute.status, 0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }

      writeFileSync(join(root, 'evidence', 'broken.json'), 'not json at all', 'utf8');
      const malformed = runBin(['brain', 'record', 'run', '--file', 'evidence/broken.json'], root, env);
      assert.notEqual(malformed.status, 0);
      assert.match(malformed.stderr, /not valid JSON/u);

      writeFileSync(join(root, 'evidence', 'array.json'), '[]', 'utf8');
      const array = runBin(['brain', 'record', 'run', '--file', 'evidence/array.json'], root, env);
      assert.notEqual(array.status, 0);
      assert.match(array.stderr, /must be a JSON object/u);

      const badVocabulary = runBin(
        ['brain', 'record', 'run', '--payload', JSON.stringify({ ...runPayload, outcome: 'in-progress' })],
        root,
        env,
      );
      assert.notEqual(badVocabulary.status, 0);
      assert.match(badVocabulary.stderr, /outcome/u);
    });

    await t.test('refuses a workspace with no tracked Brain configuration', () => {
      const bare = mkdtempSync(join(tmpdir(), 'roster-evidence-bare-'));
      try {
        writeFileSync(
          join(bare, 'roster.yaml'),
          [
            'schema_version: 2',
            'workspace_id: evidence-cli-bare',
            'functions: {}',
            'hosts:',
            '  codex: enabled',
            'tool_uses: []',
            '',
          ].join('\n'),
          'utf8',
        );
        const result = runBin(
          ['brain', 'record', 'run', '--payload', JSON.stringify(runPayload)],
          bare,
          env,
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Brain configuration/u);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});
