import {
  NotConfiguredError,
  VersionSkewError,
  WorkspaceMismatchError,
} from './contracts.ts';

// Shared delivery-error classifier (#318 R3 finding 2). Three outcomes:
//   - 'transport' — a KNOWN retryable/degradable outage (network reset, S3/HTTP
//     throttling or 5xx, a PG connection-class failure). Retries with backoff;
//     degrades resolution to a durable queue.
//   - 'halt' — a KNOWN permanent config/auth/identity failure (bad grant, denied
//     bucket, wrong workspace). No amount of retrying fixes it: it stops the
//     drain (no attempt consumed, no poison) and fails resolution hard. Fixable
//     by an operator (grant/credential/URL) — the remedy is actionable.
//   - 'unknown' — anything NOT positively recognized above: PG 42703 and other
//     programming/schema defects, arbitrary TypeError/Error. Treated FAIL-CLOSED
//     — it halts the drain (never retried into poison) AND is surfaced as a
//     doctor-visible error; resolution fails hard rather than silently degrading
//     writes toward a target a code/schema bug will never let them reach.
//
// The set is a POSITIVE ALLOWLIST: only conditions we can affirmatively identify
// as transport retry; only conditions we can affirmatively identify as config
// halt. The default is 'unknown' — an unrecognized error is never assumed to be
// a benign network blip.

export type DeliveryErrorClass = 'halt' | 'transport' | 'unknown';

// PostgreSQL SQLSTATEs that are permanent config/auth/schema failures:
//   42501 insufficient_privilege, 28P01/28000 auth, 3D000 invalid_catalog_name,
//   42P01 undefined_table.
const PG_HALT_SQLSTATES = new Set(['42501', '28P01', '28000', '3D000', '42P01']);

// PostgreSQL SQLSTATEs that are genuine transport/connection outages: class 08
// (connection exception) is matched by prefix; 57P01 admin_shutdown and 57P03
// cannot_connect_now are the server-restart/recovery signals.
const PG_TRANSPORT_SQLSTATES = new Set(['57P01', '57P03']);

// Node/libuv socket + DNS error codes that are genuine transient transport
// faults. (ENOTFOUND — a definitively unresolvable host — is NOT here: that is a
// config error, so it falls through to 'unknown' and fails closed. EAI_AGAIN is
// the transient "try again" DNS signal and IS retryable.)
const NET_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

// S3/MinIO error codes (surfaced on error.name for the v3 SDK, error.Code for
// XML) that are permanent access/config failures, never transient outages.
const S3_HALT_NAMES = new Set(['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']);

// S3/HTTP transient server faults + throttling (name or XML Code): retry.
const S3_TRANSPORT_NAMES = new Set([
  'RequestTimeout',
  'RequestTimeoutException',
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'ThrottlingException',
  'Throttling',
  'RequestThrottled',
  'RequestThrottledException',
  'TooManyRequests',
]);

export function classifyDeliveryError(err: unknown): DeliveryErrorClass {
  // Semantic persistence errors are always identity/config halts.
  if (
    err instanceof WorkspaceMismatchError ||
    err instanceof VersionSkewError ||
    err instanceof NotConfiguredError
  ) {
    return 'halt';
  }
  const e = err as {
    code?: unknown;
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const s3name = typeof e.name === 'string' ? e.name : typeof e.Code === 'string' ? e.Code : undefined;
  const http = typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : undefined;

  // ---- KNOWN transport (positive allowlist — retry / degrade) ----
  if (code !== undefined) {
    if (NET_TRANSPORT_CODES.has(code)) return 'transport';
    // PG connection-exception class 08xxx, plus admin_shutdown / cannot_connect_now.
    if (/^08[0-9A-Za-z]{3}$/.test(code) || PG_TRANSPORT_SQLSTATES.has(code)) return 'transport';
  }
  if (s3name !== undefined && S3_TRANSPORT_NAMES.has(s3name)) return 'transport';
  // Retryable HTTP: 429 (throttle) + any 5xx server fault.
  if (http !== undefined && (http === 429 || (http >= 500 && http <= 599))) return 'transport';

  // ---- KNOWN halt (positive allowlist — fail hard, operator-fixable) ----
  if (code !== undefined && PG_HALT_SQLSTATES.has(code)) return 'halt';
  if (s3name !== undefined && S3_HALT_NAMES.has(s3name)) return 'halt';
  // 403/404 from the object store is access/config (AccessDenied / NoSuchBucket
  // / NoSuchKey on a key that must exist), never a transport outage.
  if (http !== undefined && (http === 403 || http === 404)) return 'halt';

  // ---- everything else: UNKNOWN (programming/schema defect — fail closed) ----
  return 'unknown';
}

export function isDeliveryHalt(err: unknown): boolean {
  return classifyDeliveryError(err) === 'halt';
}

// Only a KNOWN transport fault is retryable/degradable; both 'halt' and the
// fail-closed 'unknown' stop the drain and fail resolution hard.
export function isDeliveryTransport(err: unknown): boolean {
  return classifyDeliveryError(err) === 'transport';
}

// The single degrade-vs-fail-closed decision EVERY persistence read/count
// boundary funnels through (#318 R4). A caught error may soften a result to a
// degraded (overlay-only, partial) view ONLY when it is a classified transport
// outage; a typed semantic PersistenceError (WorkspaceMismatch / VersionSkew /
// Conflict / InvalidRecord), a config/auth 'halt', or an unrecognized 'unknown'
// programming/schema defect all fail closed. Grep this name to prove no
// allowPartial boundary skips classification — an unrecognized error is never
// assumed to be a benign outage worth degrading toward.
export function mayDegradeToPartial(err: unknown): boolean {
  return classifyDeliveryError(err) === 'transport';
}
