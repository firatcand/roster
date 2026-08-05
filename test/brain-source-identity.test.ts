import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_ASSURANCES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_LABELS,
  MAX_SOURCE_PROVENANCE_BYTES,
  SOURCE_KINDS,
  SOURCE_PRIVACY_CLASSES,
  SOURCE_TRUST_CLASSES,
  canonicalSourceJson,
  normalizeCanonicalHttpsUrl,
  normalizeSourceIngest,
  normalizeSourceLabels,
  normalizeSourceProvenance,
  type SourceIngestInput,
  type SourceJsonValue,
} from '../src/lib/brain/source-contracts.ts';
import {
  deriveIngestIntentId,
  deriveSourceObjectIdentity,
  prepareSourceIdentity,
} from '../src/lib/brain/source-identity.ts';
import { RosterError } from '../src/lib/errors.ts';

const WORKSPACE = 'my-roster';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;

function input(overrides: Partial<SourceIngestInput> = {}): SourceIngestInput {
  return {
    requestKey: 'request-1',
    source: { kind: 'inline-text', stableKey: 'launch-notes' },
    bytes: Buffer.from('hello source'),
    labels: [{ workspace: WORKSPACE }],
    privacy: 'internal',
    trust: 'host-asserted',
    actor: {
      actorId: 'codex',
      assurance: 'host-attested',
      host: 'codex',
      sessionId: 'session-1',
    },
    mediaType: 'text/plain',
    sourceTimestamp: '2026-08-05T20:00:00Z',
    provenance: { selected_by: 'codex', ordinal: 1 },
    ...overrides,
  };
}

function sourceError(run: () => unknown, field?: string): RosterError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RosterError);
  assert.equal(caught.code, 'BRAIN_SOURCE_INPUT_INVALID');
  if (field !== undefined) assert.equal(caught.details.field, field);
  return caught;
}

test('source contract exposes closed vocabularies', () => {
  assert.deepEqual([...SOURCE_KINDS], [
    'workspace-file',
    'fetched-media',
    'inline-text',
    'structured-record',
    'produced-artifact',
  ]);
  assert.deepEqual([...SOURCE_PRIVACY_CLASSES], ['public', 'internal', 'secret']);
  assert.deepEqual([...SOURCE_TRUST_CLASSES], [
    'brain-structured',
    'brain-extract-untrusted',
    'tool-output-untrusted',
    'host-asserted',
    'legacy-unverified',
  ]);
  assert.deepEqual([...ACTOR_ASSURANCES], [
    'system-derived',
    'caller-asserted',
    'host-attested',
    'human-confirmed',
  ]);
});

test('prepareSourceIdentity snapshots bytes and derives content-addressed identities', () => {
  const bytes = Buffer.from('hello source');
  const prepared = prepareSourceIdentity(WORKSPACE, input({ bytes }));
  const expected = 'sha256:73835e6be53ae9601ad01f242a47aa04ce4ace65f04b71e719aadb6a79ddc51a';
  assert.equal(prepared.object.contentHash, expected);
  assert.equal(prepared.object.objectId, expected);
  assert.equal(prepared.object.objectKey, `objects/73/${expected.slice(7)}`);
  assert.equal(prepared.object.sizeBytes, bytes.byteLength);
  for (const value of [
    prepared.logicalSourceId,
    prepared.sourceVersionId,
    prepared.intentId,
    prepared.requestFingerprint,
  ]) assert.match(value, /^sha256:[a-f0-9]{64}$/u);

  bytes.fill(0);
  assert.equal(prepared.bytes.toString('utf8'), 'hello source');
  prepared.normalized.bytes.fill(1);
  assert.equal(prepared.bytes.toString('utf8'), 'hello source');
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.normalized.source));
  assert.ok(Object.isFrozen(prepared.normalized.labels));
  assert.ok(Object.isFrozen(prepared.normalized.actor));
  assert.ok(Object.isFrozen(prepared.normalized.provenance));
  assert.equal(prepared.normalized.sourceTimestamp, '2026-08-05T20:00:00.000Z');
});

test('logical source identity is workspace-scoped, kind-separated, case-sensitive, and byte-independent', () => {
  const lower = prepareSourceIdentity(WORKSPACE, input());
  const changedBytes = prepareSourceIdentity(WORKSPACE, input({ bytes: Buffer.from('changed') }));
  const changedCase = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'inline-text', stableKey: 'Launch-notes' },
  }));
  const changedKind = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'produced-artifact', stableKey: 'launch-notes' },
  }));
  const changedWorkspace = prepareSourceIdentity('other-roster', input({
    labels: [{ workspace: 'other-roster' }],
  }));
  assert.equal(lower.logicalSourceId, changedBytes.logicalSourceId);
  assert.notEqual(lower.sourceVersionId, changedBytes.sourceVersionId);
  assert.notEqual(lower.object.objectId, changedBytes.object.objectId);
  assert.notEqual(lower.logicalSourceId, changedCase.logicalSourceId);
  assert.notEqual(lower.logicalSourceId, changedKind.logicalSourceId);
  assert.notEqual(lower.logicalSourceId, changedWorkspace.logicalSourceId);
});

test('workspace-file identity is checkout-independent and path-exact', () => {
  const a = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'workspace-file', workspacePath: 'examples/post.md' },
  }));
  const b = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'workspace-file', workspacePath: 'examples/post.md' },
  }));
  const other = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'workspace-file', workspacePath: 'examples/Post.md' },
  }));
  assert.equal(a.logicalSourceId, b.logicalSourceId);
  assert.notEqual(a.logicalSourceId, other.logicalSourceId);

  const invalid = [
    '',
    '/tmp/post.md',
    'C:/temp/post.md',
    'file://host/post.md',
    '~/post.md',
    '../post.md',
    './post.md',
    'examples//post.md',
    'examples\\post.md',
    'examples/post\u0000.md',
    'examples/post\n.md',
    'examples/con',
    'examples/.post.roster-1-2-abcdef123456',
    `examples/${'x'.repeat(256)}`,
  ];
  for (const workspacePath of invalid) {
    sourceError(() => normalizeSourceIngest(WORKSPACE, input({
      source: { kind: 'workspace-file', workspacePath },
    })), 'source.workspacePath');
  }
});

test('provider/upstream fetched identity excludes a changing locator but version identity preserves it', () => {
  const one = prepareSourceIdentity(WORKSPACE, input({
    source: {
      kind: 'fetched-media',
      provider: 'bright-data',
      upstreamId: 'post:123',
      canonicalUrl: 'https://EXAMPLE.com:443/posts/123#first',
    },
  }));
  const two = prepareSourceIdentity(WORKSPACE, input({
    source: {
      kind: 'fetched-media',
      provider: 'bright-data',
      upstreamId: 'post:123',
      canonicalUrl: 'https://example.com/new-location/123',
    },
  }));
  assert.equal(one.logicalSourceId, two.logicalSourceId);
  assert.notEqual(one.sourceVersionId, two.sourceVersionId);
  assert.notEqual(one.requestFingerprint, two.requestFingerprint);
  assert.equal(one.normalized.source.kind, 'fetched-media');
  assert.equal(one.normalized.source.canonicalUrl, 'https://example.com/posts/123');
});

test('canonical URL fallback normalizes only origin spelling and keeps path/query identity', () => {
  assert.equal(
    normalizeCanonicalHttpsUrl('HTTPS://EXAMPLE.COM.:443/a/%7e?q=%2f#ignored'),
    'https://example.com/a/%7e?q=%2f',
  );
  assert.equal(normalizeCanonicalHttpsUrl('https://example.com'), 'https://example.com/');
  const one = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'fetched-media', canonicalUrl: 'https://EXAMPLE.com:443/a/%7e?q=%2f#one' },
  }));
  const equivalent = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'fetched-media', canonicalUrl: 'https://example.com/a/%7e?q=%2f#two' },
  }));
  const differentQuery = prepareSourceIdentity(WORKSPACE, input({
    source: { kind: 'fetched-media', canonicalUrl: 'https://example.com/a/%7e?q=%2F' },
  }));
  assert.equal(one.logicalSourceId, equivalent.logicalSourceId);
  assert.notEqual(one.logicalSourceId, differentQuery.logicalSourceId);

  for (const value of [
    'http://example.com/x',
    'https://user:pass@example.com/x',
    'https://example.com\\x',
    'not-a-url',
  ]) sourceError(() => normalizeCanonicalHttpsUrl(value), 'source.canonicalUrl');
});

test('fetched media requires one unambiguous continuing identity channel', () => {
  for (const source of [
    { kind: 'fetched-media' as const },
    { kind: 'fetched-media' as const, provider: 'exa' },
    { kind: 'fetched-media' as const, upstreamId: 'record-1' },
    { kind: 'fetched-media' as const, provider: 'Exa', upstreamId: 'record-1' },
  ]) sourceError(() => normalizeSourceIngest(WORKSPACE, input({ source })), source.provider === 'Exa' ? 'source.provider' : 'source');
});

test('retrieval labels normalize as a sorted complete hierarchy set', () => {
  const labels = normalizeSourceLabels(WORKSPACE, [
    { workspace: WORKSPACE, function: 'gtm', agent: 'social', plan: 'discover' },
    { workspace: WORKSPACE },
    { workspace: WORKSPACE, function: 'gtm', agent: 'social', plan: 'discover' },
  ]);
  assert.deepEqual(labels, [
    { workspace: WORKSPACE, function: 'gtm', agent: 'social', plan: 'discover' },
    { workspace: WORKSPACE, function: null, agent: null, plan: null },
  ]);
  assert.ok(Object.isFrozen(labels));

  const rawLabels = [
    { workspace: WORKSPACE, function: 'gtm', agent: 'social', plan: 'discover' },
    { workspace: WORKSPACE },
  ];
  const ordered = prepareSourceIdentity(WORKSPACE, input({ labels: rawLabels }));
  const reversed = prepareSourceIdentity(WORKSPACE, input({ labels: [...rawLabels].reverse() }));
  assert.equal(ordered.sourceVersionId, reversed.sourceVersionId);
  assert.equal(ordered.requestFingerprint, reversed.requestFingerprint);

  sourceError(() => normalizeSourceLabels(WORKSPACE, []), 'labels');
  sourceError(() => normalizeSourceLabels(WORKSPACE, [{ workspace: WORKSPACE, agent: 'social' }]), 'labels');
  sourceError(() => normalizeSourceLabels(WORKSPACE, [{ workspace: WORKSPACE, function: 'gtm', plan: 'discover' }]), 'labels');
  sourceError(() => normalizeSourceLabels(WORKSPACE, [{ workspace: 'other-roster' }]), 'labels.workspace');
  sourceError(
    () => normalizeSourceLabels(WORKSPACE, Array.from({ length: MAX_SOURCE_LABELS + 1 }, () => ({ workspace: WORKSPACE }))),
    'labels',
  );
});

test('closed actor evidence and trust coupling reject unjustified promotion', () => {
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({
    actor: { actorId: 'codex', assurance: 'caller-asserted' },
  })), 'trust');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({
    trust: 'brain-structured',
    source: { kind: 'inline-text', stableKey: 'record' },
  })), 'trust');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({
    trust: 'legacy-unverified',
  })), 'trust');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({
    actor: { actorId: 'codex', assurance: 'host-attested', host: 'codex', sessionId: 's', extra: true } as never,
  })), 'actor');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({
    actor: { actorId: 'codex', assurance: 'human-confirmed', decisionId: 'd', actionDigest: 'bad' },
  })), 'actor.actionDigest');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({ privacy: 'private' as never })), 'privacy');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({ trust: 'authored-policy' as never })), 'trust');

  const structured = normalizeSourceIngest(WORKSPACE, input({
    trust: 'brain-structured',
    source: { kind: 'structured-record', stableKey: 'customer-1' },
    actor: {
      actorId: 'firat',
      assurance: 'human-confirmed',
      decisionId: 'decision-1',
      actionDigest: DIGEST_A,
    },
  }));
  assert.equal(structured.trust, 'brain-structured');
});

test('strict provenance canonicalization is injective and rejects non-JSON behavior', () => {
  assert.equal(
    canonicalSourceJson({ b: [1, { z: true, a: null }], a: 'x' }),
    '{"a":"x","b":[1,{"a":null,"z":true}]}',
  );
  assert.notEqual(
    canonicalSourceJson({ a: 'x\u0000b\u0000y' }),
    canonicalSourceJson({ a: 'x', b: 'y' }),
  );
  assert.notEqual(
    canonicalSourceJson({ a: 'x\nb\ny' }),
    canonicalSourceJson({ a: 'x', b: 'y' }),
  );
  const polluted = JSON.parse('{"__proto__":{"admin":true},"a":1}') as SourceJsonValue;
  assert.equal(canonicalSourceJson(normalizeSourceProvenance(polluted)), '{"__proto__":{"admin":true},"a":1}');
  assert.equal(({} as Record<string, unknown>).admin, undefined);

  const invalid: unknown[] = [
    { x: undefined },
    { x: Number.NaN },
    { x: Number.POSITIVE_INFINITY },
    { x: 1n },
    { x: new Date() },
    Object.assign(new Array(2), { 0: 'x' }),
  ];
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  invalid.push(cycle);
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, 'x', { enumerable: true, get: () => 'value' });
  invalid.push(accessor);
  const symbol = { x: 1 } as Record<PropertyKey, unknown>;
  symbol[Symbol('hidden')] = true;
  invalid.push(symbol);
  for (const provenance of invalid) sourceError(() => normalizeSourceProvenance(provenance), 'provenance');

  sourceError(
    () => normalizeSourceProvenance({ text: 'x'.repeat(MAX_SOURCE_PROVENANCE_BYTES + 1) }),
    'provenance',
  );
});

test('equivalent replay converges while changed requests conflict by fingerprint', () => {
  const first = prepareSourceIdentity(WORKSPACE, input());
  const reordered = prepareSourceIdentity(WORKSPACE, input({
    provenance: { ordinal: 1, selected_by: 'codex' },
  }));
  assert.equal(first.intentId, reordered.intentId);
  assert.equal(first.requestFingerprint, reordered.requestFingerprint);
  assert.equal(first.sourceVersionId, reordered.sourceVersionId);

  const newRequestKey = prepareSourceIdentity(WORKSPACE, input({ requestKey: 'request-2' }));
  assert.notEqual(first.intentId, newRequestKey.intentId);
  assert.equal(first.requestFingerprint, newRequestKey.requestFingerprint);
  assert.equal(first.sourceVersionId, newRequestKey.sourceVersionId);

  const changed = prepareSourceIdentity(WORKSPACE, input({ bytes: Buffer.from('different bytes') }));
  assert.equal(first.intentId, changed.intentId);
  assert.notEqual(first.requestFingerprint, changed.requestFingerprint);
  assert.notEqual(first.sourceVersionId, changed.sourceVersionId);
});

test('exact tombstone expectation changes only the request fingerprint', () => {
  const ordinary = prepareSourceIdentity(WORKSPACE, input());
  const resurrection = prepareSourceIdentity(WORKSPACE, input({ expectedTombstoneId: DIGEST_A }));
  assert.equal(ordinary.logicalSourceId, resurrection.logicalSourceId);
  assert.equal(ordinary.sourceVersionId, resurrection.sourceVersionId);
  assert.equal(ordinary.object.objectId, resurrection.object.objectId);
  assert.equal(ordinary.intentId, resurrection.intentId);
  assert.notEqual(ordinary.requestFingerprint, resurrection.requestFingerprint);
  assert.equal(resurrection.normalized.expectedTombstoneId, DIGEST_A);
  for (const expectedTombstoneId of [
    'a'.repeat(64),
    `sha256:${'A'.repeat(64)}`,
    'sha256:short',
    '',
  ]) {
    sourceError(() => normalizeSourceIngest(WORKSPACE, input({ expectedTombstoneId })), 'expectedTombstoneId');
  }
});

test('metadata changes version/request identity without changing content object or continuing source', () => {
  const first = prepareSourceIdentity(WORKSPACE, input());
  for (const changedInput of [
    input({ privacy: 'secret' }),
    input({ provenance: { selected_by: 'claude', ordinal: 1 } }),
    input({ labels: [{ workspace: WORKSPACE, function: 'gtm' }] }),
    input({ mediaType: 'text/markdown' }),
    input({ sourceTimestamp: '2026-08-05T21:00:00Z' }),
  ]) {
    const changed = prepareSourceIdentity(WORKSPACE, changedInput);
    assert.equal(first.logicalSourceId, changed.logicalSourceId);
    assert.equal(first.object.objectId, changed.object.objectId);
    assert.notEqual(first.sourceVersionId, changed.sourceVersionId);
    assert.notEqual(first.requestFingerprint, changed.requestFingerprint);
  }
});

test('source bounds reject oversized bytes and keys before copying or hashing', () => {
  const oversized = new Uint8Array(MAX_SOURCE_BYTES + 1);
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({ bytes: oversized })), 'bytes');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({ requestKey: `r${'x'.repeat(256)}` })), 'requestKey');
  sourceError(() => normalizeSourceIngest(WORKSPACE, input({
    source: { kind: 'inline-text', stableKey: `s${'x'.repeat(256)}` },
  })), 'source.stableKey');
});

test('direct object and intent helpers produce stable unambiguous values', () => {
  const one = deriveSourceObjectIdentity(Buffer.from('a:b\u0000c'));
  const two = deriveSourceObjectIdentity(Buffer.from('a\u0000b:c'));
  assert.notEqual(one.objectId, two.objectId);
  assert.equal(one.objectKey, `objects/${one.objectId.slice(7, 9)}/${one.objectId.slice(7)}`);
  assert.equal(
    deriveIngestIntentId(WORKSPACE, 'request:a/b'),
    deriveIngestIntentId(WORKSPACE, 'request:a/b'),
  );
  assert.notEqual(
    deriveIngestIntentId(WORKSPACE, 'request:a/b'),
    deriveIngestIntentId(WORKSPACE, 'request:a:b'),
  );
});
