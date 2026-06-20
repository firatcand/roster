// FORGE-202 (Tripwire I1): deterministic, model-free injection scanner.
//
// `scanText(text, source, opts?)` runs a fixed battery of high-precision rules
// over a single text field and returns a TripwireReport. The engine is PURE
// (no IO, no model call, no new runtime dep) and DETECTION-ONLY — it never
// mutates, never blocks, and (at the verb layer) never emits events.
//
// Trust boundary: this scans UNTRUSTED input only. It is NOT wired into the
// renderer (no externally-authorable text reaches the worker prompt today — see
// spec/THREAT-MODEL.md / the FORGE-201 gate). Wiring lands with the first
// untrusted→prompt adapter (FORGE-203/204).

import { ALL_RULES, type TripwireRuleId } from './rules.ts';

export type TripwireSeverity = 'clean' | 'suspicious' | 'hostile';

export type TripwireSource =
  | 'task_description'
  | 'acceptance_criteria'
  | 'answered_questions'
  | 'prior_attempts'
  | 'conventions'
  | 'search_result'
  | 'browser_page';

export const TRIPWIRE_SOURCES: readonly TripwireSource[] = [
  'task_description',
  'acceptance_criteria',
  'answered_questions',
  'prior_attempts',
  'conventions',
  'search_result',
  'browser_page',
];

/**
 * A single detection. `span` indexes the SCANNED text in **UTF-16 code units**
 * (JS native `string` indexing — `text.slice(start, end)` reproduces the match).
 * For findings produced from DECODED payloads (base64/hex), the span points at
 * the *encoded* candidate in the original text, not into the decoded buffer.
 */
export interface TripwireFinding {
  readonly rule: TripwireRuleId;
  readonly severity: TripwireSeverity;
  readonly span: { readonly start: number; readonly end: number };
  /** Length-capped AND secret-masked excerpt — never contains a raw secret. */
  readonly excerpt: string;
}

export interface TripwireReport {
  readonly source: TripwireSource;
  readonly severity: TripwireSeverity;
  readonly findings: readonly TripwireFinding[];
  /** True when the input exceeded the byte cap and was truncated before scanning. */
  readonly truncated: boolean;
}

export interface ScanOptions {
  /**
   * Recursion depth for encoded-payload decoding. The encoded_payload rule
   * recursively scans decoded base64/hex with `depth - 1`; at depth 0 it stops
   * decoding (zero-width/bidi/data-uri checks still run). Default 2.
   */
  readonly maxDepth?: number;
}

// Hard byte cap applied BEFORE any regex runs. Bounds worst-case scan cost and
// guarantees the engine never spins on a multi-MiB adversarial blob. Matches the
// 1 MiB per-file read cap used elsewhere in the orchestrate read band.
export const TRIPWIRE_MAX_BYTES = 1 * 1024 * 1024;

// Excerpt display cap (UTF-16 code units). Long matches are truncated with an
// ellipsis so a finding never carries an unbounded slice into the JSON output.
const EXCERPT_MAX = 120;

const SEVERITY_RANK: Record<TripwireSeverity, number> = {
  clean: 0,
  suspicious: 1,
  hostile: 2,
};

function maxSeverity(a: TripwireSeverity, b: TripwireSeverity): TripwireSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// Truncate to a UTF-16 code-unit budget without splitting a surrogate pair.
function truncateUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  // Avoid cutting between a high and low surrogate.
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

// Mask secret-looking substrings inside an excerpt so scanning secret-bearing
// text never prints the raw value (Codex C6). Conservative: collapses long runs
// of token-shaped characters and known secret prefixes to a fixed redaction
// marker. Runs on the (already length-capped) excerpt.
const SECRET_PATTERNS: readonly RegExp[] = [
  // Common secret/token prefixes followed by a body (GitHub, OpenAI, Slack, AWS, Bearer).
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|pk|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  // key/secret/token/password = <value> assignments.
  /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{6,}["']?/gi,
  // Long opaque token-ish runs (>= 20 chars of base64/hex alphabet).
  /[A-Za-z0-9_\-+/]{20,}={0,2}/g,
];

// A secret TERM immediately followed by a value token — covers WHITESPACE-
// delimited secrets ("password hunter2", "token abc123SECRET", ".env DATA") that
// the `term [:=] value` assignment pattern misses. The term + separator are kept
// for legibility; the value token is masked. Excerpts only ever exist on
// FINDINGS, so over-masking legitimate prose here is harmless (fail-closed).
// Each term branch self-anchors: the dotted forms (`.env`, `process.env`) must
// NOT use a leading `\b` (a `.` is a non-word char, so `\b` never matches before
// it — that bug let `.env hunter2` leak); the plain word terms keep `\b…\b`.
const SECRET_TERM_VALUE_RE =
  /((?:process\.env(?:\.[A-Za-z0-9_]+)?)|(?:\.env(?:\.[a-z0-9]+)?)|\b(?:secrets?|tokens?|api[_ -]?keys?|credentials?|passwords?|passwd)\b)([\s:=]+)["']?[^\s"',;]{3,}/gi;

export function redactExcerpt(raw: string): string {
  const capped = truncateUtf16(raw, EXCERPT_MAX);
  let masked = capped.replace(
    SECRET_TERM_VALUE_RE,
    (_m, term: string, sep: string) => `${term}${sep}[REDACTED]`,
  );
  for (const re of SECRET_PATTERNS) {
    masked = masked.replace(re, (m) => {
      // Preserve a known prefix (up to the first separator) so the finding is
      // still legible, but mask the secret body.
      const sepIdx = m.search(/[\s:=]/);
      if (sepIdx > 0 && sepIdx < 16) {
        return `${m.slice(0, sepIdx + 1)} [REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return masked;
}

// Byte-cap input WITHOUT throwing. Returns the (possibly truncated) string and a
// flag. Truncation is on a UTF-16 boundary via Buffer slicing then re-decode;
// `Buffer.from(str).toString('utf8', 0, n)` may end on a partial code point, so
// we trim trailing replacement chars defensively. Correctness here only needs to
// bound cost — a few dropped trailing bytes on a 1 MiB adversarial blob is fine.
function byteCap(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= TRIPWIRE_MAX_BYTES) return { text, truncated: false };
  let capped = buf.toString('utf8', 0, TRIPWIRE_MAX_BYTES);
  // Drop a trailing U+FFFD produced by a mid-codepoint cut.
  if (capped.endsWith('�')) capped = capped.slice(0, -1);
  return { text: capped, truncated: true };
}

export const DEFAULT_MAX_DEPTH = 2;

/**
 * Scan a single text field. Pure, never throws on odd/oversized input.
 */
export function scanText(
  text: string,
  source: TripwireSource,
  opts?: ScanOptions,
): TripwireReport {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const { text: capped, truncated } = byteCap(text);

  const findings: TripwireFinding[] = [];
  for (const rule of ALL_RULES) {
    for (const f of rule(capped, maxDepth)) findings.push(f);
  }

  // Stable order: by span start, then by rule id.
  findings.sort((a, b) => a.span.start - b.span.start || a.rule.localeCompare(b.rule));

  let severity: TripwireSeverity = 'clean';
  for (const f of findings) severity = maxSeverity(severity, f.severity);

  return { source, severity, findings, truncated };
}

// Rules whose match span captures FREE-FORM context (a secret value may sit
// anywhere inside it — before/after a term, whitespace- or punctuation-delimited)
// get a FIXED, input-free structural excerpt instead of a raw slice. Pattern-
// masking such a slice can never be complete, so we never echo it; the `span`
// still locates the match for the operator (who can inspect the trusted, local
// source directly).
//   - secret_egress: span straddles secret-term + sink + target + arbitrary text.
//   - tool_coercion: patterns capture an `[^\n]{0,80}` free tail after the directive.
//   - role_confusion: the role-label pattern captures the rest of the line.
//   - encoded_payload: the span is attacker-controlled blob / `data:` URI content
//     (a short payload sits below the opaque-run mask), so it must not be echoed.
// ONLY instruction_override keeps a length-capped, secret-masked slice: it matches
// FIXED anchored injection phrases with NO free capture, so its span cannot
// contain an embedded secret and the phrase itself is a useful diagnostic.
const STRUCTURAL_EXCERPTS: Partial<Record<TripwireRuleId, string>> = {
  secret_egress: '[secret_egress: secret term near an exfil sink + external target — content redacted]',
  tool_coercion: '[tool_coercion: agent directed to run/execute a tool or command — surrounding text redacted]',
  role_confusion: '[role_confusion: forged delimiter/host block or injected role label — surrounding text redacted]',
  encoded_payload: '[encoded_payload: encoded/obfuscated content (base64/hex/data-uri/invisible) — content redacted]',
};

// Build a finding. Free-capture rules get a structural descriptor; the rest get a
// length-capped + secret-masked slice. Centralised so the excerpt/secret-leak
// guarantee lives in one place.
export function mkFinding(
  rule: TripwireRuleId,
  severity: TripwireSeverity,
  text: string,
  start: number,
  end: number,
): TripwireFinding {
  return {
    rule,
    severity,
    span: { start, end },
    excerpt: STRUCTURAL_EXCERPTS[rule] ?? redactExcerpt(text.slice(start, end)),
  };
}

// Re-export the rule id type so callers import a single module.
export type { TripwireRuleId } from './rules.ts';
