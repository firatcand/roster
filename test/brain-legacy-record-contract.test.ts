import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  LEGACY_RECORD_DOMAIN,
  legacyRecordStableKey,
  type LegacyRecordKey,
} from '../src/lib/brain/source-identity.ts';
import {
  MAX_SOURCE_STABLE_KEY_BYTES,
  normalizeSourceIngest,
} from '../src/lib/brain/source-contracts.ts';

// #352 §10 — the durable retrieval-side contract for v2 structured records.
// #383's semantic writes must produce it and #384's backfill must satisfy it.

const IDENTITY_GRAMMAR = /^legacy\.(entity|fact|event|edge)\.v1:[0-9a-f]{64}$/;
const DECIMAL_BIGINT = /^(0|[1-9][0-9]*)$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const HOSTILE_TEXT = [
  'plain',
  'with/slash',
  'with:colon',
  'with#hash',
  'with"quote',
  'with\\backslash',
  'with space',
  'with\nnewline',
  'with\u0000nul',
  'with🚀emoji',
  'with\ud800lone-surrogate',
  'x'.repeat(100 * 1024),
];

function keysFor(text: string): readonly LegacyRecordKey[] {
  return [
    { kind: 'entity', entityKind: text, slug: text },
    { kind: 'fact', entityKind: text, slug: text, key: text },
    { kind: 'event', id: '9223372036854775807' },
    { kind: 'edge', fromKind: text, fromSlug: text, rel: text, toKind: text, toSlug: text },
  ];
}

test('every legacy record identity is total, conformant, and bounded at 81 bytes', () => {
  for (const text of HOSTILE_TEXT) {
    for (const record of keysFor(text)) {
      const identity = legacyRecordStableKey(record);
      assert.match(identity, IDENTITY_GRAMMAR);
      assert.equal(Buffer.byteLength(identity, 'utf8'), `legacy.${record.kind}.v1:`.length + 64);
      assert.equal(Buffer.byteLength(identity, 'utf8') <= 81, true);
      assert.equal(Buffer.byteLength(identity, 'utf8') <= MAX_SOURCE_STABLE_KEY_BYTES, true);
      // Conformance is what makes ingest unable to refuse a legacy record on key
      // shape: the normalizer applies the STABLE_KEY class.
      const normalized = normalizeSourceIngest('legacy-contract-workspace', {
        requestKey: identity,
        source: { kind: 'structured-record', stableKey: identity },
        bytes: Buffer.from('{}', 'utf8'),
        labels: [{ workspace: 'legacy-contract-workspace' }],
        mediaType: 'application/json',
        privacy: 'internal',
        trust: 'legacy-unverified',
        actor: { actorId: 'roster', assurance: 'system-derived', component: 'roster' },
        provenance: {},
      });
      assert.equal(normalized.source.kind === 'structured-record'
        ? normalized.source.stableKey
        : null, identity);
    }
  }
});

test('legacy record identity is injective across delimiters, kinds, and tuple positions', () => {
  const left = legacyRecordStableKey({ kind: 'entity', entityKind: 'a/b', slug: 'c' });
  const right = legacyRecordStableKey({ kind: 'entity', entityKind: 'a', slug: 'b/c' });
  assert.notEqual(left, right);

  const factLeft = legacyRecordStableKey({ kind: 'fact', entityKind: 'org', slug: 'acme#hq', key: 'x' });
  const factRight = legacyRecordStableKey({ kind: 'fact', entityKind: 'org', slug: 'acme', key: '#hq:x' });
  assert.notEqual(factLeft, factRight);

  // Cross-kind separation with equal text.
  const entity = legacyRecordStableKey({ kind: 'entity', entityKind: 'x', slug: 'y' });
  const event = legacyRecordStableKey({ kind: 'event', id: '1' });
  const edge = legacyRecordStableKey({
    kind: 'edge', fromKind: 'x', fromSlug: 'y', rel: 'x', toKind: 'y', toSlug: 'x',
  });
  assert.equal(new Set([entity, event, edge]).size, 3);

  // Edge tuple positions are distinguishable.
  assert.notEqual(
    legacyRecordStableKey({
      kind: 'edge', fromKind: 'a', fromSlug: 'b', rel: 'c', toKind: 'd', toSlug: 'e',
    }),
    legacyRecordStableKey({
      kind: 'edge', fromKind: 'a', fromSlug: 'b', rel: 'c', toKind: 'e', toSlug: 'd',
    }),
  );
});

test('legacy record identity is deterministic across processes', () => {
  const record: LegacyRecordKey = { kind: 'fact', entityKind: 'org', slug: 'acme', key: 'hq' };
  const expected = legacyRecordStableKey(record);
  const script = [
    "import { legacyRecordStableKey } from './src/lib/brain/source-identity.ts';",
    `process.stdout.write(legacyRecordStableKey(${JSON.stringify(record)}));`,
  ].join('\n');
  const observed = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-'],
    { input: script, encoding: 'utf8', cwd: process.cwd() },
  );
  assert.equal(observed, expected);
  assert.equal(LEGACY_RECORD_DOMAIN, 'roster.brain.legacy-record.v1');
});

// The per-kind envelope #383 writes and #384 backfills. The shape is asserted
// here so both tickets have an executable contract to code against.
type LegacyRecordEnvelope = {
  envelope: 'roster.brain.record.v1';
  kind: LegacyRecordKey['kind'];
  identity: string;
  body: Record<string, unknown>;
  legacy?: { table: string; id: string; recorded_at: string };
};

function entityEnvelope(): LegacyRecordEnvelope {
  const identity = legacyRecordStableKey({ kind: 'entity', entityKind: 'org', slug: 'acme' });
  return {
    envelope: 'roster.brain.record.v1',
    kind: 'entity',
    identity,
    body: { kind: 'org', slug: 'acme', title: 'Acme', body: 'A synthetic organization.' },
    legacy: { table: 'entities', id: '12345', recorded_at: '2024-01-31T09:15:00.000Z' },
  };
}

function factEnvelope(): LegacyRecordEnvelope {
  return {
    envelope: 'roster.brain.record.v1',
    kind: 'fact',
    identity: legacyRecordStableKey({ kind: 'fact', entityKind: 'org', slug: 'acme', key: 'hq' }),
    body: {
      subject: legacyRecordStableKey({ kind: 'entity', entityKind: 'org', slug: 'acme' }),
      subject_kind: 'org',
      subject_slug: 'acme',
      key: 'hq',
      value: 'Berlin',
      asserted: { source: null, confidence: null, actor: null },
    },
    legacy: { table: 'facts', id: '67890', recorded_at: '2024-02-01T00:00:00.000Z' },
  };
}

function eventEnvelope(): LegacyRecordEnvelope {
  return {
    envelope: 'roster.brain.record.v1',
    kind: 'event',
    identity: legacyRecordStableKey({ kind: 'event', id: '9223372036854775807' }),
    body: {
      subject: null,
      subject_kind: null,
      subject_slug: null,
      kind: 'observed',
      payload: {},
      event_key: '9223372036854775807',
      asserted: { actor: null },
    },
    legacy: { table: 'events', id: '9223372036854775807', recorded_at: '2024-02-02T12:00:00.000Z' },
  };
}

function edgeEnvelope(): LegacyRecordEnvelope {
  return {
    envelope: 'roster.brain.record.v1',
    kind: 'edge',
    identity: legacyRecordStableKey({
      kind: 'edge', fromKind: 'org', fromSlug: 'acme', rel: 'employs', toKind: 'person', toSlug: 'ada',
    }),
    body: {
      from: legacyRecordStableKey({ kind: 'entity', entityKind: 'org', slug: 'acme' }),
      from_kind: 'org',
      from_slug: 'acme',
      to: legacyRecordStableKey({ kind: 'entity', entityKind: 'person', slug: 'ada' }),
      to_kind: 'person',
      to_slug: 'ada',
      rel: 'employs',
      props: {},
      asserted: { actor: null },
    },
    legacy: { table: 'edges', id: '3', recorded_at: '2024-02-03T23:59:59.999Z' },
  };
}

test('each v2 structured-record envelope pins its exact per-kind body members', () => {
  const envelopes = [entityEnvelope(), factEnvelope(), eventEnvelope(), edgeEnvelope()];
  const expected: Record<string, readonly string[]> = {
    entity: ['kind', 'slug', 'title', 'body'],
    fact: ['subject', 'subject_kind', 'subject_slug', 'key', 'value', 'asserted'],
    event: ['subject', 'subject_kind', 'subject_slug', 'kind', 'payload', 'event_key', 'asserted'],
    edge: ['from', 'from_kind', 'from_slug', 'to', 'to_kind', 'to_slug', 'rel', 'props', 'asserted'],
  };
  for (const envelope of envelopes) {
    assert.equal(envelope.envelope, 'roster.brain.record.v1');
    assert.match(envelope.identity, IDENTITY_GRAMMAR);
    assert.equal(envelope.identity.startsWith(`legacy.${envelope.kind}.v1:`), true);
    assert.deepEqual(Object.keys(envelope.body).sort(), [...expected[envelope.kind]!].sort());
    // `asserted` is present on fact/event/edge and absent from entity, because
    // 003_attribution.sql alters exactly those three tables.
    assert.equal(Object.hasOwn(envelope.body, 'asserted'), envelope.kind !== 'entity');
    // Entity references are identity strings, never bigint ids.
    for (const field of ['subject', 'from', 'to']) {
      const reference = envelope.body[field];
      if (reference === undefined || reference === null) continue;
      assert.equal(typeof reference, 'string');
      assert.match(reference as string, /^legacy\.entity\.v1:[0-9a-f]{64}$/);
    }
    const legacy = envelope.legacy!;
    assert.match(legacy.id, DECIMAL_BIGINT);
    assert.match(legacy.recorded_at, RFC3339_UTC);
    // A string id round-trips past 2^53 without precision loss.
    assert.equal(BigInt(legacy.id).toString(), legacy.id);
  }
  assert.equal(eventEnvelope().legacy!.id, '9223372036854775807');
});
