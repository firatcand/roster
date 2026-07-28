import { sha256Hex } from './contracts.ts';

// Shared write-time sanitizer for the safe index projections (#323 section F +
// Rev4-R3-3). The run + artifact ledger never exposes raw prose to a future
// semantic-index job (#325); instead the stores run sanitizeForIndex(text) at
// WRITE time and persist ONLY its output in run_events.sanitized_report /
// artifact_declarations.sanitized_text. The SQL views then expose those
// internally-produced columns — no TS-in-SQL, no caller-controlled "sanitized"
// flag as a boundary. Reused by #319 for feedback/lesson/approval-packet text.
//
// Contract:
//   - null  ⇒ the text is binary-ish (NUL bytes / heavy control-char density);
//             REFUSE to index it at all (never a partial/lossy projection).
//   - string ⇒ every recognized secret shape redacted to REDACTED, then capped
//             at MAX_INDEX_TEXT bytes (a truncation marker replaces the tail).
//
// Redaction is deterministic and order-independent at the match level: each
// pattern replaces its whole match, and the patterns are applied in a fixed
// order (widest structural shapes first — PEM/JWT — so a narrower token pattern
// cannot bite a fragment of a larger secret and leak the rest).

export const REDACTED = '[REDACTED]';
// MAX_INDEX_TEXT is a BYTE budget (UTF-8), not a UTF-16 code-unit count
// (finding: the contract promised 16384 BYTES but string.length/slice measured
// code units, so 16384 CJK chars occupied ~49 KiB). truncateToBytes below caps
// on a UTF-8 byte boundary; the SQL trigger mirrors it with octet_length.
export const MAX_INDEX_TEXT = 16_384;
export const TRUNCATION_MARKER = '…[truncated]';

// The "value" half of an assignment. Quoted forms are matched explicitly so the
// closing quote is not swallowed as part of the value; both quoted forms allow
// BACKSLASH-ESCAPED quotes inside (finding: password="correct horse \"battery\"
// staple" leaked its tail because "[^"\n]*" stopped at the first escaped quote).
const VALUE = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\S+)`;

// Sensitive key names (assignment LHS). Case-insensitive; matches env vars
// (API_KEY), config keys (password:), and dotted/prefixed variants.
const SENSITIVE_KEY = String.raw`[A-Za-z0-9_.\-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_.\-]?key|access[_.\-]?key|private[_.\-]?key|client[_.\-]?secret|auth[_.\-]?token|credentials?|session[_.\-]?token|refresh[_.\-]?token)[A-Za-z0-9_.\-]*`;

type Rule = { name: string; re: RegExp; replace: (m: string, ...g: string[]) => string };

// Order matters: structural blocks first, then prefixed tokens, then contextual
// assignments, then the broad high-entropy shapes.
const RULES: Rule[] = [
  // PEM / private-key blocks (multiline).
  {
    name: 'pem',
    re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
    replace: () => REDACTED,
  },
  // JWT (three base64url segments).
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replace: () => REDACTED,
  },
  // Authorization / Proxy-Authorization header (value redacted, header kept).
  {
    name: 'authorization-header',
    re: /\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|\S.*?)(?=$|[\r\n])/gi,
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
  // Bearer token following the scheme word.
  {
    name: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
    replace: () => `Bearer ${REDACTED}`,
  },
  // GitHub personal/OAuth/app/refresh tokens.
  {
    name: 'github',
    re: /\bgh[posur]_[A-Za-z0-9]{20,}\b/g,
    replace: () => REDACTED,
  },
  // Slack tokens.
  {
    name: 'slack',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => REDACTED,
  },
  // OpenAI-style secret keys (sk-, sk-proj-, rk-).
  {
    name: 'sk-token',
    re: /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replace: () => REDACTED,
  },
  // AWS access key id.
  {
    name: 'aws-access-key-id',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  // URL userinfo (user:pass@host) — redact the credentials, keep the shape.
  {
    name: 'url-userinfo',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replace: (_m, scheme: string) => `${scheme}${REDACTED}@`,
  },
  // Sensitive assignment (key kept, value redacted). Runs AFTER the prefixed
  // tokens so a `token=ghp_...` still shows the key name. The key may be QUOTED
  // ("password") or unquoted (password) so a JSON credential assignment
  // `"password":"correct horse battery staple"` — where the `"` between the key
  // and the `:` broke the old `\b(key)[:=]` match — is redacted too (finding).
  // The whole key+quotes+separator span is preserved; only the value is redacted.
  {
    name: 'sensitive-assignment',
    re: new RegExp(String.raw`("?\b${SENSITIVE_KEY}\b"?\s*[:=]\s*)${VALUE}`, 'gi'),
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  // `export KEY=value` / `KEY=value` where the value itself is a long
  // high-entropy base64/base64url blob (encoded secrets).
  {
    name: 'entropy-assignment',
    re: /\b([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([A-Za-z0-9+/_-]{32,}={0,2})\b/g,
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
  // Long hex blob (>=32) — hex-encoded keys/digests/secrets.
  {
    name: 'hex',
    re: /\b[0-9a-fA-F]{32,}\b/g,
    replace: () => REDACTED,
  },
];

function isBinaryish(text: string): boolean {
  if (text.includes('\u0000')) return true;
  if (text.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue; // tab / lf / cr
    if (c < 0x20 || c === 0x7f) suspicious += 1;
  }
  return suspicious / text.length > 0.15;
}

// Cap a string at MAX_INDEX_TEXT UTF-8 BYTES on a codepoint boundary (finding:
// the cap counted UTF-16 code units, so a multibyte string blew past the byte
// budget). Reserves room for the marker in BYTES, then backs the cut off any
// trailing continuation byte (0b10xxxxxx) so a multibyte sequence is never split.
export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(Math.max(maxBytes - markerBytes, 0), buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.toString('utf8', 0, end) + TRUNCATION_MARKER;
}

export function sanitizeForIndex(text: string): string | null {
  if (typeof text !== 'string') return null;
  if (isBinaryish(text)) return null;
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, rule.replace as never);
  return truncateToBytes(out, MAX_INDEX_TEXT);
}

// ---------- projection identifier safety (mirror of SQL safe_ident) ----------

// The secret SHAPES that must not surface verbatim in the safe projections even
// when charset-valid (finding: projections leak valid-character secrets). Kept
// byte-for-byte in sync with roster_ops.looks_secret in 002_run_ledger.sql — the
// synthesized-declaration id derived here MUST equal the one the PG backfill
// derives (deterministic cross-store parity).
const SECRET_SHAPES: RegExp[] = [
  /gh[posur]_[A-Za-z0-9]{20,}/,
  /(AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(^|[^A-Za-z0-9])(sk|rk)-[A-Za-z0-9_-]{16,}/,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
  /[0-9a-fA-F]{32,}/,
];

const PROJECTION_CHARSET = /^[A-Za-z0-9._:-]{1,128}$/;

export function looksSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

// The exact SQL sentinel: 'legacy-' || left(sha256hex(utf8(value)), 12).
function projectionSentinel(value: string): string {
  return 'legacy-' + sha256Hex(Buffer.from(value, 'utf8')).slice(0, 12);
}

// Mirror of roster_ops.safe_ident: a charset-invalid OR secret-shaped identifier
// normalizes to the deterministic sentinel; anything safe passes through. Used by
// the local declaration synthesis so its id equals the PG backfill's.
export function safeProjectionIdent(value: string): string {
  if (PROJECTION_CHARSET.test(value) && !looksSecret(value)) return value;
  return projectionSentinel(value);
}
