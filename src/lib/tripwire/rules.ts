// FORGE-202 (Tripwire I1): the five deterministic detection rules.
//
// Each rule is `(text, maxDepth) => TripwireFinding[]` returning UTF-16 spans.
// CALIBRATED FOR HIGH PRECISION on owner-authored spec prose (Codex C4): rules
// fire on exact injection phrasing and sink-paired secret mentions, NOT on bare
// words ("ignore", "execute", ".env", "system prompt") that appear legitimately
// throughout real specs. The clean-corpus test is the false-positive guard.
//
// All regexes are linear / non-backtracking (no nested unbounded quantifiers),
// so a 1 MiB adversarial input cannot trigger catastrophic backtracking.

import { mkFinding, scanText, type TripwireFinding, type TripwireSeverity } from './scan.ts';

export type TripwireRuleId =
  | 'instruction_override'
  | 'tool_coercion'
  | 'secret_egress'
  | 'encoded_payload'
  | 'role_confusion';

export type TripwireRule = (text: string, maxDepth: number) => TripwireFinding[];

const SEVERITY_RANK: Record<TripwireSeverity, number> = {
  clean: 0,
  suspicious: 1,
  hostile: 2,
};

export function maxSeverity(a: TripwireSeverity, b: TripwireSeverity): TripwireSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// Collect every non-overlapping match of a global regex as a finding.
function scanRegex(
  text: string,
  re: RegExp,
  rule: TripwireRuleId,
  severity: TripwireSeverity,
): TripwireFinding[] {
  const out: TripwireFinding[] = [];
  // Defensive: always use a fresh lastIndex.
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(mkFinding(rule, severity, text, m.index, m.index + m[0].length));
    // Guard against zero-width matches looping forever.
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

// ── Rule 1: instruction_override ─────────────────────────────────────────────
// EXACT injection phrasing only. Bare "ignore" / "system prompt" never fire.
const INSTRUCTION_OVERRIDE_RES: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|preceding|earlier)\s+(?:instructions?|directions?|prompts?|messages?)\b/gi,
  /\bdisregard\s+(?:the\s+|all\s+)?(?:above|previous|prior|preceding|earlier)\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/gi,
  /\bforget\s+(?:everything|the\s+above|all\s+(?:previous|prior)\s+instructions?)\b/gi,
];

const instructionOverride: TripwireRule = (text) => {
  const out: TripwireFinding[] = [];
  for (const re of INSTRUCTION_OVERRIDE_RES) {
    out.push(...scanRegex(text, re, 'instruction_override', 'hostile'));
  }
  return out;
};

// ── Rule 2: tool_coercion ────────────────────────────────────────────────────
// `suspicious` when the text DIRECTS the agent at a tool/command; `hostile` when
// paired with a dangerous/exfil action. Bare "run"/"execute"/"use" never fire.
//
// Suspicious: "you must run …", "use the X tool to …", "you should execute …".
const TOOL_DIRECTION_RE =
  /\byou\s+(?:must|should|need\s+to|have\s+to)\s+(?:run|execute|invoke|call)\b[^\n]{0,80}/gi;
const USE_TOOL_RE =
  /\buse\s+the\s+[A-Za-z0-9_-]{1,40}\s+tool\s+to\b[^\n]{0,80}/gi;

// Hostile: a coercion paired with an obviously dangerous shell action.
const DANGEROUS_ACTION_RE =
  /\b(?:run|execute|invoke|call|pipe\s+to)\b[^\n]{0,40}\b(?:rm\s+-rf|curl\s|wget\s|chmod\s|sudo\s|sh\s+-c|bash\s+-c|eval\b|base64\s+-d|nc\s|netcat\b|\|\s*sh\b|\|\s*bash\b)/gi;

const toolCoercion: TripwireRule = (text) => {
  const out: TripwireFinding[] = [];
  out.push(...scanRegex(text, DANGEROUS_ACTION_RE, 'tool_coercion', 'hostile'));
  out.push(...scanRegex(text, TOOL_DIRECTION_RE, 'tool_coercion', 'suspicious'));
  out.push(...scanRegex(text, USE_TOOL_RE, 'tool_coercion', 'suspicious'));
  return out;
};

// ── Rule 3: secret_egress ────────────────────────────────────────────────────
// HOSTILE only when a secret term co-occurs (within a short window) with a
// read/exfil SINK aimed at an external target. A secret term ALONE never fires —
// specs mention `.env`, "token", "credential" legitimately.
const SECRET_TERM = String.raw`(?:\.env(?:\.[a-z]+)?\b|\bsecrets?\b|\btokens?\b|\bapi[_ -]?keys?\b|\bcredentials?\b|\bpasswords?\b|process\.env)`;
// Exfil sinks only — verbs that move data OUTWARD. Inbound verbs (fetch/read)
// are deliberately excluded: "fetch the token FROM github.com" is a normal
// inbound read, not exfiltration, and listing them cried wolf on legit prose.
const SINK_VERB = String.raw`(?:send|post|upload|exfiltrate|leak|transmit|curl|wget|print|echo|cat)`;
// A URL scheme must be followed by an actual host (not bare `https://`), and a
// bare host needs a dotted TLD — keeps the finding's diagnostic value and avoids
// matching a lone scheme prefix.
const EXTERNAL_TARGET = String.raw`(?:https?:\/\/[\w.-]+|to\s+[\w.-]+\.[a-z]{2,}\b|[\w.-]+\.[a-z]{2,}\/|\battacker\b|\bwebhook\b|@[\w.-]+\.[a-z]{2,})`;

// secret … sink … target  (sink and target within ~80 chars of the secret)
const SECRET_EGRESS_RE = new RegExp(
  `${SECRET_TERM}[^\\n]{0,80}?${SINK_VERB}[^\\n]{0,40}?${EXTERNAL_TARGET}`,
  'gi',
);
// sink … target … secret  (verb-first phrasing: "curl attacker.com with the .env")
const SECRET_EGRESS_RE2 = new RegExp(
  `${SINK_VERB}[^\\n]{0,40}?${EXTERNAL_TARGET}[^\\n]{0,80}?${SECRET_TERM}`,
  'gi',
);
// sink … secret … target  (the MOST natural exfil phrasing:
// "send the api_key sk-… to https://evil.example.com"). Without this ordering
// the canonical "<sink> the <secret> to <url>" sentence slips through entirely.
const SECRET_EGRESS_RE3 = new RegExp(
  `${SINK_VERB}[^\\n]{0,40}?${SECRET_TERM}[^\\n]{0,80}?${EXTERNAL_TARGET}`,
  'gi',
);

const secretEgress: TripwireRule = (text) => {
  const out: TripwireFinding[] = [];
  out.push(...scanRegex(text, SECRET_EGRESS_RE, 'secret_egress', 'hostile'));
  out.push(...scanRegex(text, SECRET_EGRESS_RE2, 'secret_egress', 'hostile'));
  out.push(...scanRegex(text, SECRET_EGRESS_RE3, 'secret_egress', 'hostile'));
  return out;
};

// ── Rule 4: encoded_payload ──────────────────────────────────────────────────
// Bounded strict-decode of base64/hex candidates → recursively scanText the
// decoded text → propagate severity. Entropy ONLY marks an unexplained opaque
// blob `suspicious` (never hostile). Invisible-Unicode + bidi controls are a
// SEPARATE high-confidence hostile finding. `data:` URIs → suspicious.

// Invisible / bidi controls — no legitimate reason in spec text. Built from
// explicit \u code points (not literal glyphs) so the source stays auditable.
// Zero-width: U+200B–U+200D, U+FEFF (BOM/zero-width no-break space).
const ZERO_WIDTH_RE = new RegExp('[\\u200B-\\u200D\\uFEFF]', 'g');
// Bidi controls: U+202A–U+202E (embeddings/overrides), U+2066–U+2069 (isolates).
const BIDI_RE = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'g');
const DATA_URI_RE = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;[a-z0-9-]*base64,[A-Za-z0-9+/=]{8,}/gi;

// Candidate encoded blobs. LINEAR / non-backtracking: a single greedy
// character-class run with NO nested quantifier and NO trailing `\b` (a `\b`
// after a long homogeneous run forces catastrophic backtracking). We capture the
// MAXIMAL run and bound/normalize it in code (slice to DECODE_MAX, enforce
// even-length for hex) rather than in the pattern.
const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/]{24,}={0,2}/g;
const HEX_CANDIDATE_RE = /[0-9a-fA-F]{32,}/g;
// Hard cap on how many chars of a candidate we will attempt to decode. A longer
// run is truncated to this length before decode — bounds cost on adversarial
// homogeneous blobs while still covering realistic encoded payloads.
const DECODE_MAX = 4096;

const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Shannon entropy over the candidate's byte distribution (bits/char).
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Decode a strict base64 candidate to UTF-8, only when it round-trips and yields
// mostly-printable text. Returns undefined for binary/garbage (no false decode).
function tryDecodeBase64(s: string): string | undefined {
  if (!STRICT_BASE64_RE.test(s)) return undefined;
  if (s.length % 4 !== 0) return undefined;
  let buf: Buffer;
  try {
    buf = Buffer.from(s, 'base64');
  } catch {
    return undefined;
  }
  if (buf.byteLength === 0) return undefined;
  // Reject if it does not round-trip (Node is lenient; a true base64 string does).
  if (buf.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, '')) return undefined;
  const decoded = buf.toString('utf8');
  if (!isMostlyPrintable(decoded)) return undefined;
  return decoded;
}

function tryDecodeHex(s: string): string | undefined {
  if (s.length % 2 !== 0) return undefined;
  let buf: Buffer;
  try {
    buf = Buffer.from(s, 'hex');
  } catch {
    return undefined;
  }
  if (buf.byteLength === 0) return undefined;
  const decoded = buf.toString('utf8');
  if (!isMostlyPrintable(decoded)) return undefined;
  return decoded;
}

function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    // Printable ASCII + common whitespace + Latin-1+ range.
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable += 1;
  }
  return printable / s.length >= 0.85;
}

const encodedPayload: TripwireRule = (text, maxDepth) => {
  const out: TripwireFinding[] = [];

  // Invisible / bidi — always hostile, depth-independent.
  out.push(...scanRegex(text, ZERO_WIDTH_RE, 'encoded_payload', 'hostile'));
  out.push(...scanRegex(text, BIDI_RE, 'encoded_payload', 'hostile'));
  // data: base64 URIs — suspicious carrier.
  out.push(...scanRegex(text, DATA_URI_RE, 'encoded_payload', 'suspicious'));

  if (maxDepth <= 0) return out;

  // base64 / hex candidates → strict decode → recursive scan.
  //
  // IMPORTANT: collect ALL matches up front (matchAll) BEFORE decoding/recursing.
  // The recursive scanText() below re-enters this same rule and resets the SHARED
  // module-level regex lastIndex; interleaving `exec` with that recursion would
  // clobber the outer iterator and loop forever. matchAll snapshots the matches
  // first, so recursion can never corrupt the outer scan.
  const candidates: Array<{ matched: string; start: number; isBase64: boolean }> = [];
  for (const m of text.matchAll(BASE64_CANDIDATE_RE)) {
    candidates.push({ matched: m[0], start: m.index!, isBase64: true });
  }
  for (const m of text.matchAll(HEX_CANDIDATE_RE)) {
    candidates.push({ matched: m[0], start: m.index!, isBase64: false });
  }

  for (const { matched, start, isBase64 } of candidates) {
    const end = start + matched.length;

    // Bound decode/entropy cost: only ever inspect the first DECODE_MAX chars of
    // a candidate. A multi-MiB homogeneous run is thus O(DECODE_MAX), not O(n).
    const candidate = matched.length > DECODE_MAX ? matched.slice(0, DECODE_MAX) : matched;

    const decoded = isBase64 ? tryDecodeBase64(candidate) : tryDecodeHex(candidate);

    if (decoded !== undefined) {
      // Recursively scan the decoded text with reduced depth. If it reveals an
      // injection, propagate the severity to a finding on the ENCODED span.
      const inner = scanText(decoded, 'search_result', { maxDepth: maxDepth - 1 });
      if (inner.severity !== 'clean') {
        out.push(mkFinding('encoded_payload', inner.severity, text, start, end));
      }
      continue;
    }

    // Could not decode to printable text → entropy heuristic. High entropy marks
    // an UNEXPLAINED opaque blob as `suspicious` only (never hostile); normal
    // IDs/hashes/tracker tokens fall below the threshold or are short.
    if (candidate.length >= 40 && entropy(candidate) >= 4.5) {
      out.push(mkFinding('encoded_payload', 'suspicious', text, start, end));
    }
  }

  return out;
};

// ── Rule 5: role_confusion ───────────────────────────────────────────────────
// HOSTILE (high confidence) for FORGED Forge delimiters and forged host blocks —
// no legitimate untrusted text contains these. `System:`/`Assistant:` at line
// start → `suspicious` ONLY when paired with instruction content on the line.
const FORGED_FORGE_MARKER_RE = /⟦\s*(?:\/\s*)?FORGE-UNTRUSTED\b[^⟧\n]*⟧|⟦\s*\/[^⟧\n]*⟧/gu;
const FORGED_HOST_BLOCK_RE = /<!--\s*host\s*:[^>]*-->/gi;
// Line-start role label optionally followed by instruction-shaped content.
const ROLE_LABEL_RE = /^[ \t]*(?:System|Assistant|Developer)\s*:[ \t]*(.*)$/gim;
const INSTRUCTION_CONTENT_RE =
  /\b(?:ignore|disregard|override|you\s+(?:are|must|should)|new\s+instructions?|forget|do\s+not|reveal|print|send|execute|run)\b/i;

const roleConfusion: TripwireRule = (text) => {
  const out: TripwireFinding[] = [];
  out.push(...scanRegex(text, FORGED_FORGE_MARKER_RE, 'role_confusion', 'hostile'));
  out.push(...scanRegex(text, FORGED_HOST_BLOCK_RE, 'role_confusion', 'hostile'));

  ROLE_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROLE_LABEL_RE.exec(text)) !== null) {
    const rest = m[1] ?? '';
    if (m.index === ROLE_LABEL_RE.lastIndex) ROLE_LABEL_RE.lastIndex += 1;
    if (INSTRUCTION_CONTENT_RE.test(rest)) {
      out.push(
        mkFinding('role_confusion', 'suspicious', text, m.index, m.index + m[0].length),
      );
    }
  }
  return out;
};

export const ALL_RULES: readonly TripwireRule[] = [
  instructionOverride,
  toolCoercion,
  secretEgress,
  encodedPayload,
  roleConfusion,
];
