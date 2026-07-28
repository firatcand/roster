import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeRun, type BlobResolver } from '../src/lib/persistence/run-compose.ts';
import type { ArtifactDeclaration, ArtifactRecord, RunEventEnvelope } from '../src/lib/persistence/contracts.ts';
import type { RunEventKind, RunEventSource } from '../src/lib/persistence/run-events.ts';

// #323 section B: composeRun folds the raw event stream + declarations into a
// view that HONORS the trust taxonomy. A lifecycle fact promotes only from a
// trusted ('cli' | 'host-attested') source; a crafted agent-source event can
// never masquerade as host/lifecycle truth; duration is DERIVED at read; an
// unresolved artifact blob renders pending and converges.

let seq = 0;
function ev(overrides: Partial<RunEventEnvelope> & { kind: RunEventKind; runId: string }): RunEventEnvelope {
  seq += 1;
  return {
    id: `id-${seq}`,
    workspaceId: 'ws',
    dedupeKey: overrides.dedupeKey ?? overrides.kind,
    data: null,
    agent: null,
    skill: null,
    trigger: null,
    parentRunId: null,
    originTaskId: null,
    correlationId: null,
    source: 'cli' as RunEventSource,
    pid: null,
    startedAt: null,
    endedAt: null,
    sanitizedReport: null,
    createdAt: 1_700_000_000_000 + seq,
    seq,
    queued: false,
    ...overrides,
  };
}

const noBlobs: BlobResolver = () => null;

test('compose: lifecycle + duration promoted from a trusted cli source', async () => {
  const events = [
    ev({ runId: 'r', kind: 'run-start', source: 'cli', startedAt: 1000 }),
    ev({ runId: 'r', kind: 'run-end', source: 'cli', endedAt: 1250 }),
  ];
  const c = await composeRun('r', events, [], noBlobs);
  assert.equal(c.lifecycle.status, 'completed');
  assert.equal(c.lifecycle.startedAt, 1000);
  assert.equal(c.lifecycle.endedAt, 1250);
  assert.equal(c.durationDerived, 250, 'duration is derived from ended_at − started_at');
});

test('compose: an error from a trusted source makes the run errored (error wins over end)', async () => {
  const events = [
    ev({ runId: 'r', kind: 'run-start', source: 'cli', startedAt: 1000 }),
    ev({ runId: 'r', kind: 'error', source: 'cli', correlationId: 'e1', dedupeKey: 'e1' }),
    ev({ runId: 'r', kind: 'run-end', source: 'cli', endedAt: 1100 }),
  ];
  const c = await composeRun('r', events, [], noBlobs);
  assert.equal(c.lifecycle.status, 'errored');
  assert.equal(c.errors.length, 1);
});

test('compose: a CRAFTED agent-source run-start/run-end is NOT promoted to lifecycle', async () => {
  const events = [
    // an attacker-authored subagent tries to claim host lifecycle
    ev({ runId: 'r', kind: 'run-start', source: 'agent', startedAt: 1 }),
    ev({ runId: 'r', kind: 'run-end', source: 'agent', endedAt: 9999 }),
  ];
  const c = await composeRun('r', events, [], noBlobs);
  assert.equal(c.lifecycle.status, 'unknown', 'agent prose can never set the lifecycle fact');
  assert.equal(c.lifecycle.startedAt, null);
  assert.equal(c.lifecycle.endedAt, null);
  assert.equal(c.durationDerived, null, 'no trusted timestamps → no derived duration');
});

test('compose: an unverified (legacy) source is not trusted for lifecycle either', async () => {
  const c = await composeRun('r', [ev({ runId: 'r', kind: 'run-start', source: 'unverified', startedAt: 5 })], [], noBlobs);
  assert.equal(c.lifecycle.status, 'unknown');
});

test('compose: report prose is always unverified (even if it claims a cli source)', async () => {
  const events = [ev({ runId: 'r', kind: 'report', source: 'cli', data: 'I successfully published the post', sanitizedReport: 'I successfully published the post' })];
  const c = await composeRun('r', events, [], noBlobs);
  assert.ok(c.report);
  assert.equal(c.report.verified, false, 'report prose is never promoted to a verified fact');
  assert.equal(c.report.data, 'I successfully published the post');
  assert.equal(c.report.sanitizedText, 'I successfully published the post');
});

test('compose: external success promotes ONLY from a host-attested correlated tool result', async () => {
  // a cli-source result claiming success is NOT promoted (that is #322's job)
  const cliCall = [
    ev({ runId: 'r', kind: 'tool-call', source: 'cli', correlationId: 'c1', dedupeKey: 'c1', data: { tool: 'publish' } }),
    ev({ runId: 'r', kind: 'tool-result', source: 'cli', correlationId: 'c1', dedupeKey: 'c1', data: { ok: true } }),
  ];
  const c1 = await composeRun('r', cliCall, [], noBlobs);
  assert.equal(c1.toolCalls.length, 1);
  assert.equal(c1.toolCalls[0]!.externalSuccessPromoted, false, 'a cli tool-result is declared, not verified');

  // a host-attested result WITH a correlated call IS promoted
  const attested = [
    ev({ runId: 'r', kind: 'tool-call', source: 'host-attested', correlationId: 'c2', dedupeKey: 'c2', data: { tool: 'publish' } }),
    ev({ runId: 'r', kind: 'tool-result', source: 'host-attested', correlationId: 'c2', dedupeKey: 'c2', data: { ok: true } }),
  ];
  const c2 = await composeRun('r', attested, [], noBlobs);
  assert.equal(c2.toolCalls[0]!.externalSuccessPromoted, true);

  // Finding 3: a CORRELATED host-attested result that is a FAILURE ({ok:false})
  // is NOT promoted — composition must check a structured success RESULT, not
  // just correlation+source. Fails-before: externalSuccessPromoted was true.
  const attestedFailure = [
    ev({ runId: 'r', kind: 'tool-call', source: 'host-attested', correlationId: 'cf', dedupeKey: 'cf', data: { tool: 'publish' } }),
    ev({ runId: 'r', kind: 'tool-result', source: 'host-attested', correlationId: 'cf', dedupeKey: 'cf', data: { ok: false, error: 'permission denied' } }),
  ];
  const cf = await composeRun('r', attestedFailure, [], noBlobs);
  assert.equal(cf.toolCalls[0]!.externalSuccessPromoted, false, 'a host-attested FAILURE is never promoted as success');

  // An unknown/unstructured host-attested result shape defaults to NOT promoted.
  const attestedUnknown = [
    ev({ runId: 'r', kind: 'tool-call', source: 'host-attested', correlationId: 'cu', dedupeKey: 'cu', data: {} }),
    ev({ runId: 'r', kind: 'tool-result', source: 'host-attested', correlationId: 'cu', dedupeKey: 'cu', data: 'done' }),
  ];
  const cu = await composeRun('r', attestedUnknown, [], noBlobs);
  assert.equal(cu.toolCalls[0]!.externalSuccessPromoted, false, 'an unstructured result shape is not promoted');

  // an agent-authored tool-result is never promoted
  const forged = [
    ev({ runId: 'r', kind: 'tool-call', source: 'agent', correlationId: 'c3', dedupeKey: 'c3', data: {} }),
    ev({ runId: 'r', kind: 'tool-result', source: 'agent', correlationId: 'c3', dedupeKey: 'c3', data: { ok: true } }),
  ];
  const c3 = await composeRun('r', forged, [], noBlobs);
  assert.equal(c3.toolCalls[0]!.externalSuccessPromoted, false);
});

test('compose (finding 9): external success promotes ONLY on explicit ok:true with no error signal', async () => {
  const attest = (data: unknown): RunEventEnvelope[] => [
    ev({ runId: 'r', kind: 'tool-call', source: 'host-attested', correlationId: 'c', dedupeKey: 'c', data: { tool: 'publish' } }),
    ev({ runId: 'r', kind: 'tool-result', source: 'host-attested', correlationId: 'c', dedupeKey: 'c', data }),
  ];
  const promoted = async (data: unknown): Promise<boolean> =>
    (await composeRun('r', attest(data), [], noBlobs)).toolCalls[0]!.externalSuccessPromoted;

  // {success:true,status:'failed'} — a positive `success` masking a failure status.
  assert.equal(await promoted({ success: true, status: 'failed' }), false, '{success:true,status:failed} must NOT promote');
  // {success:true} alone — `success` is not the accepted contract; only ok:true is.
  assert.equal(await promoted({ success: true }), false, '{success:true} alone must NOT promote (only ok:true)');
  // {ok:true,errors:['denied']} — the plural errors array (only singular error was inspected before).
  assert.equal(await promoted({ ok: true, errors: ['denied'] }), false, '{ok:true,errors:[...]} must NOT promote');
  // {ok:true,status:'error'} — a failure status alongside ok:true.
  assert.equal(await promoted({ ok: true, status: 'error' }), false, '{ok:true,status:error} must NOT promote');
  // {ok:true,error:'x'} — singular error alongside ok:true.
  assert.equal(await promoted({ ok: true, error: 'x' }), false, '{ok:true,error:x} must NOT promote');
  // {ok:true} — the clean, explicit positive.
  assert.equal(await promoted({ ok: true }), true, '{ok:true} promotes');
  // {ok:true,errors:[]} — an empty errors array is not a failure signal.
  assert.equal(await promoted({ ok: true, errors: [] }), true, '{ok:true,errors:[]} promotes (empty)');
});

function internalDecl(digest: string): ArtifactDeclaration {
  return {
    id: `decl-${digest}`,
    workspaceId: 'ws',
    runId: 'r',
    declaringAgent: 'sdr',
    role: 'produced',
    kind: 'internal',
    digest,
    provider: null,
    externalId: null,
    externalUrl: null,
    artifactType: 'report',
    mediaType: 'text/markdown',
    provenance: {},
    verified: true,
    versionState: 'verified',
    sanitizedText: null,
    createdAt: 1,
    seq: 1,
    queued: false,
  };
}

test('compose: an unresolved internal artifact renders pending, then converges once the blob commits', async () => {
  const digest = 'a'.repeat(64);
  const decls = [internalDecl(digest)];

  // blob not yet committed → pending
  const pending = await composeRun('r', [], decls, () => null);
  assert.equal(pending.artifacts.length, 1);
  assert.equal(pending.artifacts[0]!.state, 'pending');
  assert.equal(pending.artifacts[0]!.blob, null);

  // blob converges → resolved
  const blob: ArtifactRecord = {
    digest,
    size: 42,
    meta: { filename: 'r.md', contentType: 'text/markdown', runId: 'r' },
    workspaceId: 'ws',
    createdAt: 1,
    seq: 2,
    queued: false,
    objectVersionId: 'v1',
  };
  const resolved = await composeRun('r', [], decls, (d) => (d === digest ? blob : null));
  assert.equal(resolved.artifacts[0]!.state, 'resolved');
  assert.deepEqual(resolved.artifacts[0]!.blob, blob);
  assert.equal(resolved.artifacts[0]!.verified, true);
});

test('compose: an external declaration renders as external with its (unverified) flag', async () => {
  const decl: ArtifactDeclaration = {
    id: 'decl-ext',
    workspaceId: 'ws',
    runId: 'r',
    declaringAgent: 'sdr',
    role: 'produced',
    kind: 'external',
    digest: null,
    provider: 'notion',
    externalId: 'page-123',
    externalUrl: 'https://notion.so/page-123',
    artifactType: 'doc',
    mediaType: null,
    provenance: {},
    verified: false,
    versionState: null,
    sanitizedText: null,
    createdAt: 1,
    seq: 1,
    queued: false,
  };
  const c = await composeRun('r', [], [decl], noBlobs);
  assert.equal(c.artifacts[0]!.state, 'external');
  assert.equal(c.artifacts[0]!.blob, null);
  assert.equal(c.artifacts[0]!.verified, false);
});

test('compose: approvals / retries / errors are surfaced as their own lists', async () => {
  const events = [
    ev({ runId: 'r', kind: 'approval-ref', correlationId: 'a1', dedupeKey: 'a1' }),
    ev({ runId: 'r', kind: 'retry', correlationId: 't1', dedupeKey: 't1' }),
    ev({ runId: 'r', kind: 'error', correlationId: 'e1', dedupeKey: 'e1', source: 'agent' }),
  ];
  const c = await composeRun('r', events, [], noBlobs);
  assert.equal(c.approvals.length, 1);
  assert.equal(c.retries.length, 1);
  assert.equal(c.errors.length, 1);
  // an agent-source error is still LISTED, but does not flip lifecycle to errored
  assert.equal(c.lifecycle.status, 'unknown');
});
