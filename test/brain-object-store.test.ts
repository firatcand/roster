import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Agent, type AgentOptions } from 'node:https';
import { Readable } from 'node:stream';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BrainObjectStoreError,
  ContentAddressedBrainObjectStore,
  brainObjectKey,
  brainObjectNamespaceFingerprint,
  createBrainObjectStore,
  type BrainObjectTransport,
  type TransportGetResult,
  type TransportHeadResult,
  type TransportObservation,
} from '../src/lib/brain/object-store.ts';
import {
  ExactOriginS3RequestHandler,
  S3NetworkPolicyError,
  createGuardedLookup,
  createS3NetworkBoundary,
  deriveS3Origin,
  type DnsLookupAll,
  type S3HttpHandler,
} from '../src/lib/brain/s3-network-policy.ts';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeHandler(onHandle: S3HttpHandler['handle']): S3HttpHandler {
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    handle: onHandle,
    destroy() {},
  };
}

function response(statusCode = 200): Awaited<ReturnType<S3HttpHandler['handle']>> {
  return {
    response: {
      statusCode,
      headers: {},
      body: Readable.from([]),
    },
  };
}

function request(origin: ReturnType<typeof deriveS3Origin>): Parameters<S3HttpHandler['handle']>[0] {
  return {
    protocol: 'https:',
    hostname: origin.hostname,
    path: '/object',
    query: {},
    method: 'HEAD',
    headers: { host: origin.authority },
  } as unknown as Parameters<S3HttpHandler['handle']>[0];
}

function conditionalError(): Error {
  return Object.assign(new Error('conditional conflict'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });
}

const STORE_CONFIG = {
  bucket: 'company-brain',
  region: 'eu-central-1',
  forcePathStyle: false,
} as const;

class FakeTransport implements BrainObjectTransport {
  readonly objects = new Map<string, Buffer>();
  putError: unknown;
  headOverride: TransportHeadResult | null | undefined;
  getOverride: TransportGetResult | null | undefined;
  getCalls = 0;
  closed = false;

  async putIfAbsent(input: {
    key: string;
    body: Buffer;
  }): Promise<TransportObservation> {
    if (this.putError !== undefined) throw this.putError;
    if (this.objects.has(input.key)) throw conditionalError();
    this.objects.set(input.key, Buffer.from(input.body));
    return { etag: '"opaque-etag-not-a-digest"', versionId: 'version-1' };
  }

  async head(input: { key: string }): Promise<TransportHeadResult | null> {
    if (this.headOverride !== undefined) return this.headOverride;
    const body = this.objects.get(input.key);
    return body === undefined
      ? null
      : { contentLength: body.byteLength, etag: '"opaque-etag-not-a-digest"', versionId: 'version-1' };
  }

  async get(input: { key: string }): Promise<TransportGetResult | null> {
    this.getCalls += 1;
    if (this.getOverride !== undefined) return this.getOverride;
    const body = this.objects.get(input.key);
    return body === undefined
      ? null
      : {
          body: Readable.from([body]),
          contentLength: body.byteLength,
          etag: '"opaque-etag-not-a-digest"',
          versionId: 'version-1',
        };
  }

  close(): void {
    this.closed = true;
  }
}

test('object keys are digest-derived and confined beneath the optional root', () => {
  const hash = 'ab'.repeat(32);
  assert.equal(brainObjectKey(undefined, hash), `objects/ab/${hash}`);
  assert.equal(brainObjectKey('company/raw', hash), `company/raw/objects/ab/${hash}`);
  for (const bad of ['', '../escape', 'root/', 'root\\escape']) {
    assert.throws(() => brainObjectKey(bad, hash), BrainObjectStoreError);
  }
  assert.throws(() => brainObjectKey(undefined, 'not-a-digest'), BrainObjectStoreError);
});

test('create-or-verify is create-only, converges races, and keeps ETag opaque', async () => {
  const bytes = Buffer.from('immutable source bytes');
  const sha256 = digest(bytes);
  const transport = new FakeTransport();
  const store = new ContentAddressedBrainObjectStore(transport, {
    ...STORE_CONFIG,
    rootPrefix: 'workspace',
  });

  const created = await store.createOrVerify({ sha256, bytes, contentType: 'text/plain' });
  assert.equal(created.outcome, 'stored');
  assert.equal(created.etag, '"opaque-etag-not-a-digest"');
  assert.notEqual(created.etag, sha256);

  transport.putError = conditionalError();
  const replay = await store.createOrVerify({ sha256, bytes, contentType: 'text/plain' });
  assert.equal(replay.outcome, 'exists');
  assert.equal(replay.versionId, 'version-1');
  assert.equal('delete' in store, false);
  assert.equal('del' in store, false);
  assert.equal('list' in store, false);

  store.close();
  assert.equal(transport.closed, true);
});

test('lost put response converges only after bounded HEAD and full digest verification', async () => {
  const bytes = Buffer.from('landed before timeout');
  const sha256 = digest(bytes);
  const transport = new FakeTransport();
  const key = brainObjectKey(undefined, sha256);
  transport.objects.set(key, bytes);
  transport.putError = Object.assign(new Error('socket closed'), { name: 'TimeoutError' });
  const store = new ContentAddressedBrainObjectStore(transport, STORE_CONFIG);

  const result = await store.createOrVerify({ sha256, bytes, contentType: 'application/octet-stream' });
  assert.equal(result.outcome, 'exists');
  assert.equal(transport.getCalls, 1);
});

test('inspect rejects size before GET and detects oversized and changed streams', async () => {
  const bytes = Buffer.from('expected');
  const sha256 = digest(bytes);
  const transport = new FakeTransport();
  const store = new ContentAddressedBrainObjectStore(transport, STORE_CONFIG);

  transport.headOverride = { contentLength: bytes.byteLength + 1 };
  assert.deepEqual(await store.inspect({ sha256, byteLength: bytes.byteLength }), {
    status: 'corrupt',
    key: brainObjectKey(undefined, sha256),
    reason: 'size',
  });
  assert.equal(transport.getCalls, 0);

  transport.headOverride = { contentLength: bytes.byteLength };
  const oversized = Readable.from([Buffer.concat([bytes, Buffer.from('!')])]);
  transport.getOverride = { body: oversized, contentLength: bytes.byteLength };
  assert.equal((await store.inspect({ sha256, byteLength: bytes.byteLength })).status, 'corrupt');
  assert.equal(oversized.destroyed, true);

  transport.getOverride = {
    body: Readable.from([Buffer.from('changed!')]),
    contentLength: bytes.byteLength,
  };
  const changed = await store.inspect({ sha256, byteLength: bytes.byteLength });
  assert.deepEqual(changed, {
    status: 'corrupt',
    key: brainObjectKey(undefined, sha256),
    reason: 'digest',
  });
});

test('a conflicting content-addressed object never gets overwritten', async () => {
  const bytes = Buffer.from('expected');
  const sha256 = digest(bytes);
  const transport = new FakeTransport();
  transport.putError = conditionalError();
  transport.headOverride = { contentLength: bytes.byteLength };
  transport.getOverride = {
    body: Readable.from([Buffer.from('changed!')]),
    contentLength: bytes.byteLength,
  };
  const store = new ContentAddressedBrainObjectStore(transport, STORE_CONFIG);
  await assert.rejects(
    store.createOrVerify({ sha256, bytes, contentType: 'text/plain' }),
    (error: unknown) => error instanceof BrainObjectStoreError && error.code === 'OBJECT_INTEGRITY_CONFLICT',
  );
});

test('object stores expose the canonical tracked namespace fingerprint', () => {
  const transport = new FakeTransport();
  const config = { ...STORE_CONFIG, rootPrefix: 'workspace' };
  const store = new ContentAddressedBrainObjectStore(transport, config);
  assert.equal(store.namespaceFingerprint, brainObjectNamespaceFingerprint(config));
  assert.match(store.namespaceFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(
    store.namespaceFingerprint,
    brainObjectNamespaceFingerprint({ ...config, rootPrefix: 'other-workspace' }),
  );
});

test('the production factory requires explicit environment credentials', () => {
  assert.throws(
    () => createBrainObjectStore({
      bucket: 'company-brain',
      region: 'eu-central-1',
      forcePathStyle: false,
    }, {}),
    (error: unknown) => error instanceof BrainObjectStoreError && error.code === 'S3_CREDENTIALS_MISSING',
  );
});

test('standard and explicit endpoint configurations derive one exact signed origin', () => {
  assert.deepEqual(deriveS3Origin({
    bucket: 'company-brain',
    region: 'eu-central-1',
    forcePathStyle: false,
  }), {
    protocol: 'https:',
    hostname: 'company-brain.s3.eu-central-1.amazonaws.com',
    port: 443,
    authority: 'company-brain.s3.eu-central-1.amazonaws.com',
  });
  assert.equal(deriveS3Origin({
    bucket: 'company.brain',
    region: 'cn-north-1',
    forcePathStyle: false,
  }).hostname, 's3.cn-north-1.amazonaws.com.cn');
  assert.deepEqual(deriveS3Origin({
    bucket: 'company-brain',
    region: 'auto',
    endpoint: 'https://objects.example.test:8443',
    forcePathStyle: false,
  }), {
    protocol: 'https:',
    hostname: 'company-brain.objects.example.test',
    port: 8443,
    authority: 'company-brain.objects.example.test:8443',
  });
  assert.equal(deriveS3Origin({
    bucket: 'company-brain',
    region: 'auto',
    endpoint: 'https://objects.example.test',
    forcePathStyle: true,
  }).hostname, 'objects.example.test');
  for (const endpoint of [
    'http://objects.example.test',
    'https://localhost',
    'https://127.0.0.1',
    'https://objects.example.test/path',
  ]) {
    assert.throws(() => deriveS3Origin({
      bucket: 'company-brain',
      region: 'auto',
      endpoint,
      forcePathStyle: true,
    }), S3NetworkPolicyError);
  }
});

test('the exact-origin wrapper rejects protocol, host, port, and signed Host drift', async () => {
  const origin = deriveS3Origin({
    bucket: 'company-brain',
    region: 'eu-central-1',
    forcePathStyle: false,
  });
  let delegated = 0;
  const delegate = fakeHandler(async () => {
    delegated += 1;
    return response();
  });
  const handler = new ExactOriginS3RequestHandler(origin, delegate);
  await handler.handle(request(origin));
  assert.equal(delegated, 1);

  const driftCases = [
    { ...request(origin), protocol: 'http:' },
    { ...request(origin), hostname: `other.${origin.hostname}` },
    { ...request(origin), port: 444 },
    { ...request(origin), headers: { host: `other.${origin.hostname}` } },
  ];
  for (const drifted of driftCases) {
    assert.throws(
      () => handler.handle(drifted as Parameters<S3HttpHandler['handle']>[0]),
      S3NetworkPolicyError,
    );
  }
  assert.equal(delegated, 1);
});

test('actual standard and custom S3 commands are accepted only at their SDK-derived exact origins', async () => {
  const configs = [
    { bucket: 'company-brain', region: 'eu-central-1', forcePathStyle: false },
    {
      bucket: 'company-brain',
      region: 'auto',
      endpoint: 'https://objects.example.test:8443',
      forcePathStyle: false,
    },
    {
      bucket: 'company-brain',
      region: 'auto',
      endpoint: 'https://objects.example.test',
      forcePathStyle: true,
    },
  ];
  for (const config of configs) {
    const origin = deriveS3Origin(config);
    const seen: string[] = [];
    const handler = new ExactOriginS3RequestHandler(origin, fakeHandler(async (signed) => {
      seen.push(`${signed.protocol}//${signed.hostname}:${signed.port ?? 443}`);
      return response();
    }));
    const client = new S3Client({
      ...config,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
      followRegionRedirects: false,
      requestHandler: handler,
    });
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: 'objects/aa/hash' }));
    assert.deepEqual(seen, [`https://${origin.hostname}:${origin.port}`]);
    client.destroy();
  }
});

function invokeLookup(
  guarded: ReturnType<typeof createGuardedLookup>,
  hostname: string,
): Promise<{ address: string | { address: string; family: number }[]; family?: number }> {
  return new Promise((resolve, reject) => {
    guarded(hostname, { all: true }, (error, address, family) => {
      if (error !== null) reject(error);
      else resolve({ address: address as string | { address: string; family: number }[], family });
    });
  });
}

test('guarded DNS rejects the whole mixed set and returns exactly one pinned answer', async () => {
  const safeAll: DnsLookupAll = (_hostname, options, callback) => {
    assert.equal(options.all, true);
    callback(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  };
  const pinned = await invokeLookup(createGuardedLookup('objects.example.test', {
    lookupAll: safeAll,
  }), 'objects.example.test');
  assert.deepEqual(pinned.address, [{ address: '93.184.216.34', family: 4 }]);

  const mixed: DnsLookupAll = (_hostname, _options, callback) => callback(null, [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await assert.rejects(
    invokeLookup(createGuardedLookup('objects.example.test', { lookupAll: mixed }), 'objects.example.test'),
    (error: unknown) => error instanceof S3NetworkPolicyError && error.reason === 'dns-address-denied',
  );
});

test('every guarded lookup re-resolves and a rebound unsafe answer fails closed', async () => {
  let calls = 0;
  const rebinding: DnsLookupAll = (_hostname, _options, callback) => {
    calls += 1;
    callback(null, calls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }]);
  };
  const guarded = createGuardedLookup('objects.example.test', { lookupAll: rebinding });
  await invokeLookup(guarded, 'objects.example.test');
  await assert.rejects(invokeLookup(guarded, 'objects.example.test'), S3NetworkPolicyError);
  assert.equal(calls, 2);
});

test('guarded DNS enforces answer and time bounds without leaking rejected addresses', async () => {
  const tooMany: DnsLookupAll = (_hostname, _options, callback) => callback(null,
    Array.from({ length: 3 }, (_, index) => ({ address: `93.184.216.${index + 1}`, family: 4 })));
  await assert.rejects(
    invokeLookup(createGuardedLookup('objects.example.test', {
      lookupAll: tooMany,
      maxAnswers: 2,
    }), 'objects.example.test'),
    (error: unknown) => {
      assert.ok(error instanceof S3NetworkPolicyError);
      assert.equal(error.reason, 'dns-answer-limit');
      assert.doesNotMatch(error.message, /93\.184/u);
      return true;
    },
  );
  const never: DnsLookupAll = () => {};
  await assert.rejects(
    invokeLookup(createGuardedLookup('objects.example.test', {
      lookupAll: never,
      timeoutMs: 5,
    }), 'objects.example.test'),
    (error: unknown) => error instanceof S3NetworkPolicyError && error.reason === 'dns-timeout',
  );
});

test('the production transport disables reuse and preserves TLS verification', () => {
  let captured: AgentOptions | undefined;
  let agent: Agent | undefined;
  const boundary = createS3NetworkBoundary({
    bucket: 'company-brain',
    region: 'eu-central-1',
    forcePathStyle: false,
  }, {
    agentFactory(options) {
      captured = options;
      agent = new Agent(options);
      return agent;
    },
    handlerFactory: () => fakeHandler(async () => response()),
  });
  assert.equal(captured?.keepAlive, false);
  assert.equal(captured?.maxCachedSessions, 0);
  assert.equal(captured?.autoSelectFamily, false);
  assert.equal(captured?.rejectUnauthorized, true);
  assert.equal(typeof captured?.lookup, 'function');
  assert.equal('DeleteObjectCommand' in boundary, false);
  agent?.destroy();
});
