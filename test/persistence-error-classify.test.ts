import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeliveryError,
  isDeliveryHalt,
  isDeliveryTransport,
} from '../src/lib/persistence/error-classify.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  NotConfiguredError,
  VersionSkewError,
  WorkspaceMismatchError,
} from '../src/lib/persistence/contracts.ts';

// #318 R3 finding 2: the shared classifier is a POSITIVE ALLOWLIST. Only KNOWN
// transport faults retry/degrade; only KNOWN config/auth/identity failures halt;
// EVERYTHING ELSE (PG 42703, arbitrary TypeError/Error) is 'unknown' and fails
// closed — halts the drain and fails resolution hard, never silently degrades.

test('classify: semantic persistence errors are halts', () => {
  assert.equal(classifyDeliveryError(new WorkspaceMismatchError('x')), 'halt');
  assert.equal(classifyDeliveryError(new VersionSkewError('x')), 'halt');
  assert.equal(classifyDeliveryError(new NotConfiguredError('x')), 'halt');
});

test('classify: PostgreSQL config/auth/permission SQLSTATEs are halts', () => {
  for (const code of ['42501', '28P01', '28000', '3D000', '42P01']) {
    assert.equal(classifyDeliveryError(Object.assign(new Error('pg'), { code })), 'halt', `SQLSTATE ${code} must halt`);
  }
});

test('classify: S3/MinIO access + config errors are halts (name, Code, or 403/404)', () => {
  for (const name of ['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']) {
    assert.equal(classifyDeliveryError(Object.assign(new Error('s3'), { name })), 'halt', `${name} must halt`);
    assert.equal(classifyDeliveryError({ Code: name }), 'halt', `XML Code ${name} must halt`);
  }
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 403 } }), 'halt');
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 404 } }), 'halt');
});

test('classify: genuine transport faults retry (network codes, PG 08xxx/57P01/57P03, throttling, 5xx)', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']) {
    assert.equal(classifyDeliveryError(Object.assign(new Error('net'), { code })), 'transport', `${code} retries`);
  }
  for (const code of ['08000', '08003', '08006', '08001', '08004', '57P01', '57P03']) {
    assert.equal(classifyDeliveryError(Object.assign(new Error('pg'), { code })), 'transport', `PG ${code} retries`);
  }
  for (const name of ['RequestTimeout', 'SlowDown', 'InternalError', 'ServiceUnavailable', 'ThrottlingException']) {
    assert.equal(classifyDeliveryError(Object.assign(new Error('s3'), { name })), 'transport', `${name} retries`);
  }
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 429 } }), 'transport');
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 500 } }), 'transport');
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 502 } }), 'transport');
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 503 } }), 'transport');
});

test('classify: UNKNOWN — programming/schema defects and arbitrary errors fail closed (NOT transport)', () => {
  // PG 42703 undefined_column: a schema/programming defect, not an outage.
  assert.equal(classifyDeliveryError(Object.assign(new Error('col'), { code: '42703' })), 'unknown');
  // Arbitrary runtime bugs.
  assert.equal(classifyDeliveryError(new TypeError('bad internal value')), 'unknown');
  assert.equal(classifyDeliveryError(new Error('generic failure')), 'unknown');
  // A definitively-unresolvable host is a config error, not a transient outage.
  assert.equal(classifyDeliveryError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' })), 'unknown');
  // An unrecognized 4xx (not 403/404) is not a known halt nor transport.
  assert.equal(classifyDeliveryError({ $metadata: { httpStatusCode: 400 } }), 'unknown');
});

test('classify: ConflictError and InvalidRecordError are UNKNOWN to the classifier (drain handles them first)', () => {
  // The drain handles these BEFORE consulting the classifier; the classifier
  // must not shadow them into a transport retry or a config halt.
  assert.equal(classifyDeliveryError(new ConflictError('id', 'x')), 'unknown');
  assert.equal(classifyDeliveryError(new InvalidRecordError('x')), 'unknown');
  // BackendUnavailable carries no code — unknown to the classifier.
  assert.equal(classifyDeliveryError(new BackendUnavailableError('x')), 'unknown');
});

test('classify: isDeliveryHalt / isDeliveryTransport mirror classifyDeliveryError', () => {
  assert.equal(isDeliveryHalt(new WorkspaceMismatchError('x')), true);
  assert.equal(isDeliveryHalt(Object.assign(new Error('pg'), { code: '42501' })), true);
  assert.equal(isDeliveryHalt(new Error('net')), false);
  assert.equal(isDeliveryTransport(Object.assign(new Error('net'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isDeliveryTransport(Object.assign(new Error('pg'), { code: '42703' })), false);
  assert.equal(isDeliveryTransport(new Error('generic')), false);
});
