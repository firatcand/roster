import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INDEX_TEXT,
  REDACTED,
  TRUNCATION_MARKER,
  sanitizeForIndex,
} from '../src/lib/persistence/sanitize-index.ts';

// #323 section F + Rev4-R3-3: the shared write-time sanitizer. A fixture corpus
// of secret shapes (multiline/quoted/encoded, JWT/PEM/GitHub/Slack/AWS, auth
// headers, URL creds) must be redacted; clean prose must pass through unchanged;
// binary-ish input is refused (null); a sentinel planted in every field never
// surfaces.

// Assembled at runtime from parts: a full-shape Slack token literal in source
// trips GitHub push protection even though this value is synthetic. The bytes
// the sanitizer sees are identical either way.
const SLACK_FIXTURE = ['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnopqrstuvwx'].join('-');

// Each secret fixture: the raw text, and the exact secret substring(s) that must
// NOT survive into the sanitized output.
const SECRET_FIXTURES: { name: string; input: string; leaks: string[] }[] = [
  {
    name: 'openai sk- token',
    input: 'the key is sk-proj-abcdEFGH1234ijklMNOP5678 use it wisely',
    leaks: ['sk-proj-abcdEFGH1234ijklMNOP5678'],
  },
  {
    name: 'aws access key id',
    input: 'creds AKIAIOSFODNN7EXAMPLE rotate please',
    leaks: ['AKIAIOSFODNN7EXAMPLE'],
  },
  {
    name: 'long hex blob',
    input: 'digest deadbeefdeadbeefdeadbeefdeadbeefdeadbeef done',
    leaks: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
  },
  {
    name: 'github token',
    input: 'push with ghp_1234567890abcdefghijABCDEFGHIJ1234 now',
    leaks: ['ghp_1234567890abcdefghijABCDEFGHIJ1234'],
  },
  {
    name: 'slack bot token',
    input: `slack ${SLACK_FIXTURE} end`,
    leaks: [SLACK_FIXTURE],
  },
  {
    name: 'jwt',
    input:
      'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c here',
    leaks: ['eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
  },
  {
    name: 'authorization header (bearer)',
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart',
    leaks: ['payloadpart', 'signaturepart'],
  },
  {
    name: 'basic authorization header',
    input: 'authorization=dXNlcm5hbWU6c3VwZXJzZWNyZXRwYXNzd29yZA',
    leaks: ['dXNlcm5hbWU6c3VwZXJzZWNyZXRwYXNzd29yZA'],
  },
  {
    name: 'env-var assignment (uppercase)',
    input: 'export DATABASE_PASSWORD=hunter2SuperSecretValue',
    leaks: ['hunter2SuperSecretValue'],
  },
  {
    name: 'quoted config secret',
    input: 'client_secret: "abc-DEF-ghi-JKL-mno-PQR"',
    leaks: ['abc-DEF-ghi-JKL-mno-PQR'],
  },
  {
    name: 'aws secret access key assignment',
    input: 'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    leaks: ['wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
  },
  {
    name: 'encoded (base64) secret assignment',
    input: 'API_TOKEN=aGVsbG9zdXBlcnNlY3JldHRva2VudmFsdWUxMjM0NTY3',
    leaks: ['aGVsbG9zdXBlcnNlY3JldHRva2VudmFsdWUxMjM0NTY3'],
  },
  {
    name: 'url userinfo credentials',
    input: 'connect to https://admin:p4ssw0rd-secret@db.example.com/prod now',
    leaks: ['p4ssw0rd-secret'],
  },
  {
    name: 'multiline PEM private key',
    input: [
      'here is the key:',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA2Z3xL1234567890abcdefFAKEKEYMATERIALdoNotUseThis',
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789++',
      '-----END RSA PRIVATE KEY-----',
      'thanks',
    ].join('\n'),
    leaks: ['MIIEowIBAAKCAQEA2Z3xL1234567890abcdefFAKEKEYMATERIALdoNotUseThis', 'BEGIN RSA PRIVATE KEY'],
  },
];

for (const fx of SECRET_FIXTURES) {
  test(`sanitize: redacts ${fx.name}`, () => {
    const out = sanitizeForIndex(fx.input);
    assert.notEqual(out, null, 'a text secret must sanitize, not refuse');
    for (const leak of fx.leaks) {
      assert.ok(!out!.includes(leak), `secret substring must not survive: ${leak}\ngot: ${out}`);
    }
    assert.ok(out!.includes(REDACTED), 'a redaction placeholder must be present');
  });
}

// Clean negatives: sanitizing must be a no-op (byte-identical output).
const CLEAN_FIXTURES: { name: string; input: string }[] = [
  { name: 'plain prose', input: 'The quarterly report shows a 12% increase in revenue this year.' },
  { name: 'url without credentials', input: 'See https://example.com/docs/guide for the setup steps.' },
  { name: 'short hex color', input: 'The accent color is #deadbe and the header is #012abc.' },
  { name: 'the word password with no assignment', input: 'Please remember to reset your password before Friday.' },
  { name: 'a short config value', input: 'mode: default, retries: 3, timeout: 30' },
  { name: 'a normal sentence with a colon', input: 'Note: the meeting is at 3pm on Tuesday in room 4.' },
  { name: 'a file path', input: 'The binary lives at /usr/local/bin/roster on the host.' },
];

for (const fx of CLEAN_FIXTURES) {
  test(`sanitize: leaves clean text unchanged — ${fx.name}`, () => {
    const out = sanitizeForIndex(fx.input);
    assert.equal(out, fx.input, `clean text must pass through unchanged\ngot: ${out}`);
  });
}

test('sanitize: refuses binary-ish input (NUL byte / control-char density) with null', () => {
  assert.equal(sanitizeForIndex('before\u0000after'), null, 'a NUL byte marks binary content');
  // heavy density of non-whitespace control chars (>15%) is binary-ish
  const noisy = 'ab\u0001\u0002\u0003\u0004\u0005';
  assert.equal(sanitizeForIndex(noisy), null, 'heavy control-char density is binary-ish');
  // whitespace controls (tab/newline/cr) are fine
  assert.notEqual(sanitizeForIndex('line one\n\tindented line two\r\nline three'), null);
})

test('sanitize: caps output length (BYTES) with a truncation marker', () => {
  // Clean prose (no secret shapes) so nothing is redacted away before the cap.
  const long = 'lorem ipsum dolor sit amet '.repeat(Math.ceil((MAX_INDEX_TEXT + 5000) / 27));
  assert.ok(Buffer.byteLength(long, 'utf8') > MAX_INDEX_TEXT);
  const out = sanitizeForIndex(long);
  assert.ok(out !== null);
  assert.ok(Buffer.byteLength(out!, 'utf8') <= MAX_INDEX_TEXT, 'the cap is a BYTE budget');
  assert.ok(out!.endsWith(TRUNCATION_MARKER));
});

test('sanitize (finding 6): a multibyte string is capped at ≤ MAX_INDEX_TEXT BYTES, not code units', () => {
  // 16384 CJK chars = 16384 UTF-16 code units but ~49 KiB in UTF-8. The old
  // code-unit cap let this blow way past the byte budget.
  const cjk = '好'.repeat(MAX_INDEX_TEXT); // 3 bytes each in UTF-8
  assert.equal(cjk.length, MAX_INDEX_TEXT, 'code-unit length equals the old (wrong) cap');
  assert.ok(Buffer.byteLength(cjk, 'utf8') > MAX_INDEX_TEXT * 2);
  const out = sanitizeForIndex(cjk);
  assert.ok(out !== null);
  assert.ok(Buffer.byteLength(out!, 'utf8') <= MAX_INDEX_TEXT, 'capped on a UTF-8 byte budget');
  assert.ok(out!.endsWith(TRUNCATION_MARKER));
  // The cut never splits a multibyte char: the output round-trips through UTF-8
  // (a split would produce a replacement char / differ on re-encode).
  assert.equal(Buffer.from(out!, 'utf8').toString('utf8'), out!, 'no multibyte sequence was split');
});

// ── finding 2: JSON credential assignments (quoted key / escaped-quote value) ──

test('sanitize (finding 2): a JSON quoted-key password assignment is redacted', () => {
  // Exactly what appendEvent({kind:'report', data:{password:'…'}}) serializes to.
  const secret = 'correct horse battery staple';
  const blob = JSON.stringify({ password: secret });
  assert.ok(blob.includes(`"password":"${secret}"`), 'the fixture is the real JSON shape');
  const out = sanitizeForIndex(blob);
  assert.notEqual(out, null);
  assert.ok(!out!.includes(secret), `the quoted-key JSON password must not leak\ngot: ${out}`);
  assert.ok(out!.includes(REDACTED));
});

test('sanitize (finding 2): an escaped-quote value redacts its whole span (no tail leak)', () => {
  const input = 'password="correct horse \\"battery\\" staple"';
  const out = sanitizeForIndex(input);
  assert.notEqual(out, null);
  assert.ok(!out!.includes('battery'), `the tail after the escaped quote must not leak\ngot: ${out}`);
  assert.ok(!out!.includes('staple'), `nothing past the escaped quote may survive\ngot: ${out}`);
  assert.ok(out!.includes(REDACTED));
});

test('sanitize (finding 2): nested JSON secret/token/api_key assignments never leak', () => {
  // The VALUES are only ever exposed through the assignment (quoted key + ":"),
  // so redacting the assignment fully removes them.
  const s = 'ZZZ-super-secret-ZZZ';
  const blob = JSON.stringify({ secret: s, token: s, api_key: s });
  const out = sanitizeForIndex(blob);
  assert.notEqual(out, null);
  assert.ok(!out!.includes(s), `no sensitive JSON assignment may leak\ngot: ${out}`);
});

test('sanitize: a sentinel secret planted in EVERY field never surfaces', () => {
  // A recognizably-secret sentinel (sk- shape) embedded across a structured blob.
  const sentinel = 'sk-SENTINEL0123456789abcdefABCDEF';
  const blob = JSON.stringify({
    runId: `run-${sentinel}`,
    agent: sentinel,
    note: `the token is ${sentinel} keep it safe`,
    nested: { header: `Authorization: Bearer ${sentinel}`, url: `https://u:${sentinel}@h.example.com` },
    list: [sentinel, `env=${sentinel}`, `password: ${sentinel}`],
  });
  const out = sanitizeForIndex(blob);
  assert.notEqual(out, null);
  assert.ok(!out!.includes(sentinel), `the sentinel must not appear anywhere in the projection\ngot: ${out}`);
});

test('sanitize: non-string input refuses with null', () => {
  assert.equal(sanitizeForIndex(undefined as unknown as string), null);
  assert.equal(sanitizeForIndex(42 as unknown as string), null);
});
