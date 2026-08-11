import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The #353 hermetic privacy-lint rule engine, extracted behavior-preserving so
// the #371 context evaluation can reuse the exact rules over its own artifact
// directories. Every fixture-specific closure dependency of the original module
// — the digest/commit pointer exemptions, the schema vocabulary, and the
// synthetic workspace allowlist — is passed EXPLICITLY through
// `PrivacyLintTables`; nothing here reads a fixture-owned constant.
// `test/support/retrieval-gold.ts` keeps its public API and findings
// byte-identical by delegating to this engine with its original tables.

export type PrivacyLintFinding = Readonly<{ file: string; rule: string; detail: string }>;

export type PrivacyLintTables = Readonly<{
  // Validated digest-typed JSON positions. A value there is exempt ONLY after
  // its exact shape validates, so a credential parked in a digest field still
  // fails.
  digestPointers: readonly RegExp[];
  commitPointers: readonly RegExp[];
  // The scanned schemas' own field names: long mixed-class identifiers the
  // entropy rule would otherwise fire on.
  schemaVocabulary: ReadonlySet<string>;
  // The allowlist of synthetic workspace identities. It lives with the CALLER's
  // harness module, never in the fixture: an identity that leaked into a corpus
  // must not be able to bless itself by appearing in the corpus's own
  // declaration.
  workspaceAllowlist: readonly string[];
}>;

const DIGEST_SHAPE = /^(?:sha256:)?[0-9a-f]{64}$/u;
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/u;

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', 'example.com']);
const ALLOWED_HOST_SUFFIXES: readonly string[] = Object.freeze(['.example', '.invalid', '.test', '.example.com']);
// A CLOSED list, deliberately. The scanned artifacts legitimately contain file
// paths and SQL identifiers (`context-retrieval.ts`, `corpus.json`,
// `brain.edges`) that are syntactically indistinguishable from a bare hostname,
// so a general "dotted token ending in letters" rule would fire on dozens of
// them. The boundary is documented in the consuming READMEs and pinned by
// tests: a bare host on an unlisted TLD is OUT of the bare-host rule's
// contract, while the URL rule below catches any host under any scheme
// regardless of TLD.
const HOST_TLDS = [
  'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'tech', 'cloud', 'app', 'so',
  'me', 'us', 'uk', 'de', 'fr', 'jp', 'cn', 'ru', 'info', 'biz', 'xyz', 'site',
  'online', 'email', 'link', 'zone', 'space', 'live', 'host', 'network',
  'systems', 'services', 'works', 'agency', 'digital', 'solutions', 'eu', 'ca',
  'au', 'nl', 'se', 'ch', 'es', 'it', 'br', 'in', 'nz', 'sg', 'hk', 'kr', 'tw',
  'za', 'ie', 'fi', 'no', 'dk', 'pl', 'cz', 'pt', 'gr', 'il', 'tr',
].join('|');

const URL_RE = new RegExp('[a-z][a-z0-9+.-]*://[^\\s"\'<>)\\]]+', 'giu');
const BARE_HOST_RE = new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${HOST_TLDS})\\b`, 'giu');
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const USERINFO_RE = /\/\/[^\s/@"']+:[^\s/@"']*@/u;
const CONNECTION_STRING_RE = /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)(?:\+[a-z]+)?:\/\/[^\s"'<>]*@/iu;
const HOME_PATH_RES: readonly RegExp[] = Object.freeze([
  /\/Users\//u,
  /\/home\/[a-z0-9]/iu,
  /(?:^|[\s"'(=:;])[A-Za-z]:\\/u,
  /\\\\[A-Za-z0-9]/u,
]);
const CREDENTIAL_RES: readonly { rule: string; pattern: RegExp }[] = Object.freeze([
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/u },
  { rule: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/u },
  { rule: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { rule: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
]);
const DENYLIST_LITERALS: readonly string[] = Object.freeze([
  'my-roster',
  'neon.tech',
  'amazonaws.com',
]);
const WORKSPACE_SHAPED_RE = /\b[a-z0-9][a-z0-9-]*-workspace\b/giu;
const WORKSPACE_KEYS: ReadonlySet<string> = new Set(['workspace', 'workspaceId', 'workspace_id']);
const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/gu;
const DIGEST_TOKEN_RE = /\b(?:sha256:)?[0-9a-f]{64}\b|\b[0-9a-f]{40}\b/gu;

function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function hostAllowed(host: string): boolean {
  const bare = host.toLowerCase().replace(/:\d+$/u, '');
  if (ALLOWED_HOSTS.has(bare)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

export function scanPrivacyText(
  file: string,
  text: string,
  findings: PrivacyLintFinding[],
  tables: PrivacyLintTables,
): void {
  for (const literal of DENYLIST_LITERALS) {
    if (text.toLowerCase().includes(literal)) {
      findings.push({ file, rule: 'denylisted-literal', detail: literal });
    }
  }
  for (const pattern of HOME_PATH_RES) {
    const match = pattern.exec(text);
    if (match !== null) findings.push({ file, rule: 'absolute-home-path', detail: match[0] });
  }
  if (USERINFO_RE.test(text)) findings.push({ file, rule: 'userinfo-url', detail: 'url carries userinfo' });
  if (CONNECTION_STRING_RE.test(text)) {
    findings.push({ file, rule: 'connection-string', detail: 'connection string carries userinfo' });
  }
  for (const entry of CREDENTIAL_RES) {
    const match = entry.pattern.exec(text);
    if (match !== null) findings.push({ file, rule: entry.rule, detail: match[0].slice(0, 12) });
  }
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    let host: string;
    try {
      host = new URL(raw).host;
    } catch {
      continue;
    }
    if (!hostAllowed(host)) findings.push({ file, rule: 'non-synthetic-host', detail: host });
  }
  for (const match of text.matchAll(BARE_HOST_RE)) {
    if (!hostAllowed(match[0])) findings.push({ file, rule: 'non-synthetic-host', detail: match[0] });
  }
  for (const match of text.matchAll(EMAIL_RE)) {
    const domain = match[0].slice(match[0].indexOf('@') + 1);
    if (!hostAllowed(domain)) findings.push({ file, rule: 'non-synthetic-email', detail: match[0] });
  }
  for (const match of text.matchAll(WORKSPACE_SHAPED_RE)) {
    if (!tables.workspaceAllowlist.includes(match[0])) {
      findings.push({ file, rule: 'workspace-identity', detail: match[0] });
    }
  }
}

// `shapeExemptDigests` is TRUE only outside JSON, where there is no schema
// position to key an exemption on. Inside JSON the exemption is POINTER-scoped
// and already applied by the caller, so a digest-shaped token at an undeclared
// position must NOT be waved through here.
export function scanPrivacyEntropy(
  file: string,
  text: string,
  findings: PrivacyLintFinding[],
  shapeExemptDigests: boolean,
  tables: PrivacyLintTables,
): void {
  for (const match of text.matchAll(ENTROPY_TOKEN_RE)) {
    const token = match[0];
    if (tables.schemaVocabulary.has(token)) continue;
    if (shapeExemptDigests && DIGEST_SHAPE.test(token)) continue;
    const mixed = /[a-z]/u.test(token) && /[A-Z]/u.test(token) && /[0-9]/u.test(token);
    if (!mixed) continue;
    if (shannonEntropy(token) < 3.9) continue;
    findings.push({ file, rule: 'high-entropy-token', detail: `${token.slice(0, 8)}… (${token.length} chars)` });
  }
}

// A digest at an undeclared JSON position is the exact leak the pointer-scoped
// exemption exists to catch: a real workspace's object id or content hash copied
// into a body, a note or a query field.
function scanUnexpectedDigest(
  file: string,
  pointer: string,
  value: string,
  findings: PrivacyLintFinding[],
): void {
  for (const match of value.matchAll(DIGEST_TOKEN_RE)) {
    findings.push({
      file,
      rule: 'unexpected-digest',
      detail: `${match[0].slice(0, 12)}… at ${pointer === '' ? '/' : pointer}`,
    });
  }
}

function pointerSegment(key: string): string {
  return key.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

export function scanPrivacyJsonValue(
  file: string,
  pointer: string,
  key: string,
  value: unknown,
  findings: PrivacyLintFinding[],
  tables: PrivacyLintTables,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanPrivacyJsonValue(file, `${pointer}/${index}`, key, entry, findings, tables));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      scanPrivacyText(file, childKey, findings, tables);
      scanPrivacyJsonValue(file, `${pointer}/${pointerSegment(childKey)}`, childKey, child, findings, tables);
    }
    return;
  }
  if (typeof value !== 'string') return;
  const digestExempt = tables.digestPointers.some((pattern) => pattern.test(pointer)) && DIGEST_SHAPE.test(value);
  const commitExempt = tables.commitPointers.some((pattern) => pattern.test(pointer)) && COMMIT_SHAPE.test(value);
  if (digestExempt || commitExempt) return;
  scanPrivacyText(file, value, findings, tables);
  scanPrivacyEntropy(file, value, findings, false, tables);
  scanUnexpectedDigest(file, pointer, value, findings);
  if (WORKSPACE_KEYS.has(key) && !tables.workspaceAllowlist.includes(value)) {
    findings.push({ file, rule: 'workspace-identity', detail: `${key}=${value}` });
  }
}

function listFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

// The scan scope is exactly the caller-declared directories, and NOTHING else —
// never this module (whose denylist literals would match themselves) and never
// the wider test tree, which legitimately contains absolute home paths in
// unrelated fixtures.
export function lintPrivacyArtifacts(options: Readonly<{
  root: string;
  scanDirs: readonly string[];
  tables: PrivacyLintTables;
}>): PrivacyLintFinding[] {
  const findings: PrivacyLintFinding[] = [];
  for (const dir of options.scanDirs) {
    for (const path of listFiles(dir)) {
      const file = relative(options.root, path);
      const text = readFileSync(path, 'utf8');
      if (path.endsWith('.json')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          findings.push({ file, rule: 'unparseable-json', detail: String(error) });
          continue;
        }
        scanPrivacyJsonValue(file, '', '', parsed, findings, options.tables);
        continue;
      }
      scanPrivacyText(file, text, findings, options.tables);
      // Outside JSON there is no schema position to key an exemption on, so a
      // shape-valid digest token is exempted by SHAPE alone — documented in the
      // consuming READMEs as the one place the exemption is weaker than
      // pointer-scoped. Every other rule still applies to the whole file.
      scanPrivacyEntropy(file, text, findings, true, options.tables);
    }
  }
  return findings;
}
