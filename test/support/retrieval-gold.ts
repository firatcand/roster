import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_RETRIEVAL_FILTER_REASONS,
  type ContextRetrievalFilterReason,
} from '../../src/lib/workspace-context.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPOSITORY_ROOT = join(HERE, '..', '..');
export const RETRIEVAL_GOLD_DIR = join(REPOSITORY_ROOT, 'test', 'fixtures', 'retrieval-gold');
export const RETRIEVAL_EVAL_DOCS_DIR = join(REPOSITORY_ROOT, 'docs', 'evals', 'retrieval-quality');

// The lint's allowlist of synthetic workspace identities lives HERE, not in the
// fixture: an identity that leaked into the corpus must not be able to bless
// itself by appearing in the corpus's own declaration. `validateGoldSet` asserts
// the fixture's declared set is a subset of this constant.
export const SYNTHETIC_WORKSPACE_IDS: readonly string[] = Object.freeze(['retrieval-gold-workspace']);

export const RETRIEVAL_GOLD_WORKSPACE_ID = 'retrieval-gold-workspace';

export const GOLD_QUERY_FAMILIES = [
  'baseline',
  'exclusion',
  'precedence',
  'alias-variant',
  'multi-record',
  'ordering',
  'paraphrase-ordering',
] as const;

export type GoldQueryFamily = (typeof GOLD_QUERY_FAMILIES)[number];

// Only these families gate. Alias, multi-record and ordering are MEASURED:
// gating them would convert an optional capability into a launch requirement.
export const GATE_FAMILIES: readonly GoldQueryFamily[] = Object.freeze([
  'baseline',
  'exclusion',
  'precedence',
]);

export const GOLD_MISS_CLASSES = [
  'abbreviation',
  'hyphenation',
  'casing',
  'misspelling',
  'synonym',
  'linked-record',
] as const;

export type GoldMissClass = (typeof GOLD_MISS_CLASSES)[number];

export type GoldLabel = Readonly<{
  workspace: string;
  function?: string;
  agent?: string;
  plan?: string;
}>;

export type GoldStructuredRecord = Readonly<{
  kind: 'entity' | 'fact' | 'event' | 'edge';
  identity: string;
  body: Readonly<Record<string, unknown>>;
}>;

export type GoldRevision = Readonly<{
  fixtureVersionKey: string;
  kind: 'text' | 'structured';
  body?: string;
  record?: GoldStructuredRecord;
  rawSha256: string;
  expectedChunkContentSha256s: readonly string[];
  labels: readonly GoldLabel[];
  privacy: 'public' | 'internal' | 'secret';
  trust: 'brain-extract-untrusted' | 'legacy-unverified';
  // The extractor-inactive construction: a COMPLETE extraction at a version the
  // registry does not activate, inserted beside the real one. The compiled
  // registry stays untouched, so activation is unaffected and the accounting
  // classifies this chunk as `extractor-inactive`.
  inactiveExtraction?: Readonly<{ extractorVersion: number; content: string }>;
}>;

export type GoldSource = Readonly<{
  sourceStableKey: string;
  revisions: readonly GoldRevision[];
  finalDisposition: 'current' | 'tombstoned';
}>;

export type GoldAliasEntry = Readonly<{
  entityKind: string;
  canonicalSlug: string;
  canonicalTitle: string;
  aliases: readonly string[];
}>;

export type GoldCorpus = Readonly<{
  schemaVersion: number;
  identities: Readonly<{ workspaceIds: readonly string[] }>;
  target: Readonly<{ functionId: string; agentId: string; planId: string }>;
  planClosureQualifiedIds: readonly string[];
  sources: readonly GoldSource[];
  aliases: readonly GoldAliasEntry[];
  selectorEntities: Readonly<Record<string, readonly string[]>>;
}>;

export type GoldSelector = Readonly<{
  selector: string;
  descriptions: readonly string[];
  required: boolean;
}>;

export type GoldRelevantItem = Readonly<{
  fixtureVersionKey: string;
  expectSelectorClaim: true;
  expectedSelectors: readonly string[];
  expectedArms: readonly ('lexical' | 'structured')[];
  expectLabelScopeEligible: true;
  expectedLabelKeys?: readonly string[];
  expectedScope?: Readonly<Record<string, string>>;
  expectPolicyEligible: true;
  grade?: 1 | 2;
}>;

export type GoldMissItem = Readonly<{
  fixtureVersionKey: string;
  expectSelectorClaim: false;
  expectLabelScopeEligible: true;
  expectedLabelKeys: readonly string[];
  expectedScope: Readonly<Record<string, string>>;
  expectPolicyEligible: true;
  missClass: GoldMissClass;
}>;

export type GoldExcludedItem = Readonly<{
  fixtureVersionKey: string;
  expectPolicyEligible: false;
  reason: ContextRetrievalFilterReason;
}>;

export type GoldQuery = Readonly<{
  id: string;
  family: GoldQueryFamily;
  selectors: readonly GoldSelector[];
  query: string;
  stepHint?: string;
  relevant: readonly GoldRelevantItem[];
  membershipMisses?: readonly GoldMissItem[];
  excluded?: readonly GoldExcludedItem[];
  includeLegacyUnverified?: boolean;
  notes: string;
}>;

export type GoldSet = Readonly<{
  corpus: GoldCorpus;
  queries: readonly GoldQuery[];
  files: Readonly<Record<string, string>>;
  sha256: string;
}>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// Stable-key canonical JSON so a re-serialisation with different key order can
// never change the fixture digest the manifest records.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function goldRawBody(revision: GoldRevision): string {
  if (revision.kind === 'structured') {
    const record = revision.record!;
    return JSON.stringify({
      envelope: 'roster.brain.record.v1',
      kind: record.kind,
      identity: record.identity,
      body: record.body,
    });
  }
  return revision.body!;
}

export function goldMediaType(revision: GoldRevision): string {
  return revision.kind === 'structured' ? 'application/json' : 'text/markdown';
}

export function loadGoldSet(dir: string = RETRIEVAL_GOLD_DIR): GoldSet {
  const corpus = readJson(join(dir, 'corpus.json')) as GoldCorpus;
  const queryDocument = readJson(join(dir, 'queries.json')) as { schemaVersion: number; queries: GoldQuery[] };
  const files: Record<string, string> = {};
  for (const name of ['corpus.json', 'queries.json']) {
    files[name] = `sha256:${digest(canonicalJson(readJson(join(dir, name))))}`;
  }
  const sha256 = `sha256:${digest(canonicalJson({ corpus, queries: queryDocument.queries }))}`;
  return Object.freeze({ corpus, queries: queryDocument.queries, files: Object.freeze(files), sha256 });
}

export function goldRevisions(gold: GoldSet): Map<string, { source: GoldSource; revision: GoldRevision }> {
  const map = new Map<string, { source: GoldSource; revision: GoldRevision }>();
  for (const source of gold.corpus.sources) {
    for (const revision of source.revisions) map.set(revision.fixtureVersionKey, { source, revision });
  }
  return map;
}

export function validateGoldSet(gold: GoldSet): string[] {
  const problems: string[] = [];
  const revisions = goldRevisions(gold);
  const seenSourceKeys = new Set<string>();

  if (gold.corpus.schemaVersion !== 1) problems.push('corpus schemaVersion must be 1');
  for (const workspaceId of gold.corpus.identities.workspaceIds) {
    if (!SYNTHETIC_WORKSPACE_IDS.includes(workspaceId)) {
      problems.push(`declared workspace identity '${workspaceId}' is outside the synthetic allowlist`);
    }
  }

  for (const source of gold.corpus.sources) {
    if (seenSourceKeys.has(source.sourceStableKey)) {
      problems.push(`duplicate sourceStableKey '${source.sourceStableKey}'`);
    }
    seenSourceKeys.add(source.sourceStableKey);
    if (source.revisions.length === 0) {
      problems.push(`source '${source.sourceStableKey}' has no revisions`);
    }
    for (const revision of source.revisions) {
      const raw = goldRawBody(revision);
      const actual = digest(Buffer.from(raw, 'utf8'));
      if (actual !== revision.rawSha256) {
        problems.push(`revision '${revision.fixtureVersionKey}' rawSha256 is ${revision.rawSha256}, expected ${actual}`);
      }
      if (revision.kind === 'structured' && revision.record === undefined) {
        problems.push(`revision '${revision.fixtureVersionKey}' is structured but carries no record`);
      }
      if (revision.kind === 'text' && revision.body === undefined) {
        problems.push(`revision '${revision.fixtureVersionKey}' is text but carries no body`);
      }
      if (revision.labels.length === 0) {
        problems.push(`revision '${revision.fixtureVersionKey}' carries no retrieval label`);
      }
      for (const label of revision.labels) {
        if (!SYNTHETIC_WORKSPACE_IDS.includes(label.workspace)) {
          problems.push(`revision '${revision.fixtureVersionKey}' labels a non-synthetic workspace`);
        }
      }
    }
  }

  const aliasKeys = new Set(gold.corpus.aliases.map((entry) => `${entry.entityKind}/${entry.canonicalSlug}`));
  for (const [selector, entities] of Object.entries(gold.corpus.selectorEntities)) {
    for (const entity of entities) {
      if (!aliasKeys.has(entity)) {
        problems.push(`selectorEntities['${selector}'] names unknown entity '${entity}'`);
      }
    }
  }

  const seenQueryIds = new Set<string>();
  for (const query of gold.queries) {
    if (seenQueryIds.has(query.id)) problems.push(`duplicate query id '${query.id}'`);
    seenQueryIds.add(query.id);
    if (!GOLD_QUERY_FAMILIES.includes(query.family)) {
      problems.push(`query '${query.id}' declares unknown family '${query.family}'`);
    }
    if (query.selectors.length === 0) problems.push(`query '${query.id}' declares no selector`);
    const selectorIds = new Set(query.selectors.map((entry) => entry.selector));
    for (const selector of query.selectors) {
      if (selector.descriptions.length === 0) {
        problems.push(`query '${query.id}' selector '${selector.selector}' declares no description`);
      }
    }
    for (const item of query.relevant) {
      if (!revisions.has(item.fixtureVersionKey)) {
        problems.push(`query '${query.id}' names unknown relevant revision '${item.fixtureVersionKey}'`);
      }
      if (item.expectSelectorClaim !== true || item.expectLabelScopeEligible !== true
        || item.expectPolicyEligible !== true) {
        problems.push(`query '${query.id}' relevant item '${item.fixtureVersionKey}' is not fully eligible`);
      }
      if (item.expectedSelectors.length === 0) {
        problems.push(`query '${query.id}' relevant item '${item.fixtureVersionKey}' expects no selector`);
      }
      for (const selector of item.expectedSelectors) {
        if (!selectorIds.has(selector)) {
          problems.push(`query '${query.id}' item '${item.fixtureVersionKey}' expects unrequested selector '${selector}'`);
        }
      }
    }
    for (const item of query.membershipMisses ?? []) {
      if (!revisions.has(item.fixtureVersionKey)) {
        problems.push(`query '${query.id}' names unknown miss revision '${item.fixtureVersionKey}'`);
      }
      if (item.expectSelectorClaim !== false) {
        problems.push(`query '${query.id}' miss item '${item.fixtureVersionKey}' must expect no selector claim`);
      }
      if (item.expectLabelScopeEligible !== true || item.expectPolicyEligible !== true) {
        problems.push(`query '${query.id}' miss item '${item.fixtureVersionKey}' must be label/scope and policy eligible`);
      }
      if (!GOLD_MISS_CLASSES.includes(item.missClass)) {
        problems.push(`query '${query.id}' miss item declares unknown missClass '${item.missClass}'`);
      }
      if (item.expectedLabelKeys.length === 0) {
        problems.push(`query '${query.id}' miss item '${item.fixtureVersionKey}' declares no label keys`);
      }
      if (item.expectedScope === undefined
        || !SYNTHETIC_WORKSPACE_IDS.includes(item.expectedScope.workspace ?? '')) {
        problems.push(`query '${query.id}' miss item '${item.fixtureVersionKey}' declares no synthetic scope`);
      }
    }
    for (const item of query.excluded ?? []) {
      if (!revisions.has(item.fixtureVersionKey)) {
        problems.push(`query '${query.id}' names unknown excluded revision '${item.fixtureVersionKey}'`);
      }
      if (item.expectPolicyEligible !== false) {
        problems.push(`query '${query.id}' excluded item '${item.fixtureVersionKey}' must be policy-ineligible`);
      }
      if (!CONTEXT_RETRIEVAL_FILTER_REASONS.includes(item.reason)) {
        problems.push(`query '${query.id}' excluded item declares unknown reason '${item.reason}'`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Hermetic privacy lint
// ---------------------------------------------------------------------------

export type PrivacyLintFinding = Readonly<{ file: string; rule: string; detail: string }>;

const DIGEST_SHAPE = /^(?:sha256:)?[0-9a-f]{64}$/u;
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/u;

// Validated digest-typed JSON positions. A value here is exempt ONLY after its
// exact shape validates, so a credential parked in a digest field still fails.
const DIGEST_POINTERS: readonly RegExp[] = Object.freeze([
  /^\/sources\/\d+\/revisions\/\d+\/rawSha256$/u,
  /^\/sources\/\d+\/revisions\/\d+\/expectedChunkContentSha256s\/\d+$/u,
  /^\/fixture\/sha256$/u,
  /^\/fixture\/files\/[^/]+$/u,
  /^\/harness\/[^/]+$/u,
]);

const COMMIT_POINTERS: readonly RegExp[] = Object.freeze([/^\/git\/commit$/u]);

// The two schemas' own field names. They are long mixed-class identifiers, so
// without this list the entropy rule would fire on the schema documentation.
const SCHEMA_VOCABULARY: ReadonlySet<string> = new Set([
  'expectedChunkContentSha256s',
  'expectedLabelScopeEligible',
  'expectLabelScopeEligible',
  'planClosureQualifiedIds',
  'expectedSelectors',
  'expectSelectorClaim',
  'expectPolicyEligible',
  'membershipMisses',
  'fixtureVersionKey',
  'selectorEntities',
  'sourceStableKey',
  'finalDisposition',
  'inactiveExtraction',
  'includeLegacyUnverified',
  'per_selector_arm_limit',
  'total_candidate_limit',
  'required_selectors_with_matches',
  'retrieval_quality_manifest',
]);

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', 'example.com']);
const ALLOWED_HOST_SUFFIXES: readonly string[] = Object.freeze(['.example', '.invalid', '.test', '.example.com']);
// A CLOSED list, deliberately. The scanned artifacts legitimately contain file
// paths and SQL identifiers (`context-retrieval.ts`, `corpus.json`,
// `brain.edges`) that are syntactically indistinguishable from a bare hostname,
// so a general "dotted token ending in letters" rule would fire on dozens of
// them. The boundary is documented in both READMEs and pinned by a test: a bare
// host on an unlisted TLD is OUT of the bare-host rule's contract, while the URL
// rule below catches any host under any scheme regardless of TLD.
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

function scanText(file: string, text: string, findings: PrivacyLintFinding[]): void {
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
    if (!SYNTHETIC_WORKSPACE_IDS.includes(match[0])) {
      findings.push({ file, rule: 'workspace-identity', detail: match[0] });
    }
  }
}

// `shapeExemptDigests` is TRUE only outside JSON, where there is no schema
// position to key an exemption on. Inside JSON the exemption is POINTER-scoped
// and already applied by the caller, so a digest-shaped token at an undeclared
// position must NOT be waved through here.
function scanEntropy(
  file: string,
  text: string,
  findings: PrivacyLintFinding[],
  shapeExemptDigests: boolean,
): void {
  for (const match of text.matchAll(ENTROPY_TOKEN_RE)) {
    const token = match[0];
    if (SCHEMA_VOCABULARY.has(token)) continue;
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

function scanJsonValue(
  file: string,
  pointer: string,
  key: string,
  value: unknown,
  findings: PrivacyLintFinding[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanJsonValue(file, `${pointer}/${index}`, key, entry, findings));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      scanText(file, childKey, findings);
      scanJsonValue(file, `${pointer}/${pointerSegment(childKey)}`, childKey, child, findings);
    }
    return;
  }
  if (typeof value !== 'string') return;
  const digestExempt = DIGEST_POINTERS.some((pattern) => pattern.test(pointer)) && DIGEST_SHAPE.test(value);
  const commitExempt = COMMIT_POINTERS.some((pattern) => pattern.test(pointer)) && COMMIT_SHAPE.test(value);
  if (digestExempt || commitExempt) return;
  scanText(file, value, findings);
  scanEntropy(file, value, findings, false);
  scanUnexpectedDigest(file, pointer, value, findings);
  if (WORKSPACE_KEYS.has(key) && !SYNTHETIC_WORKSPACE_IDS.includes(value)) {
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

// The scan scope is the fixture directory plus the generated evaluation
// artifacts, and NOTHING else — never this module (whose denylist literals would
// match themselves) and never the wider test tree, which legitimately contains
// absolute home paths in unrelated fixtures.
export function privacyLintScope(root: string = REPOSITORY_ROOT): readonly string[] {
  return Object.freeze([
    join(root, 'test', 'fixtures', 'retrieval-gold'),
    join(root, 'docs', 'evals', 'retrieval-quality'),
  ]);
}

export function lintRetrievalGoldArtifacts(root: string = REPOSITORY_ROOT): PrivacyLintFinding[] {
  const findings: PrivacyLintFinding[] = [];
  for (const dir of privacyLintScope(root)) {
    for (const path of listFiles(dir)) {
      const file = relative(root, path);
      const text = readFileSync(path, 'utf8');
      if (path.endsWith('.json')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          findings.push({ file, rule: 'unparseable-json', detail: String(error) });
          continue;
        }
        scanJsonValue(file, '', '', parsed, findings);
        continue;
      }
      scanText(file, text, findings);
      // Outside JSON there is no schema position to key an exemption on, so a
      // shape-valid digest token is exempted by SHAPE alone — documented in both
      // READMEs as the one place the exemption is weaker than pointer-scoped.
      // Every other rule still applies to the whole file.
      scanEntropy(file, text, findings, true);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Metrics — every ranking metric operates on the delivered list COLLAPSED to
// source versions by first occurrence (§5 unit rule).
// ---------------------------------------------------------------------------

export type RankedCandidate = Readonly<{ sourceVersionId: string }>;

export function collapseToVersions(delivered: readonly RankedCandidate[]): string[] {
  const seen = new Set<string>();
  const collapsed: string[] = [];
  for (const candidate of delivered) {
    if (seen.has(candidate.sourceVersionId)) continue;
    seen.add(candidate.sourceVersionId);
    collapsed.push(candidate.sourceVersionId);
  }
  return collapsed;
}

export function recallAt(collapsed: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const head = collapsed.slice(0, k);
  let hits = 0;
  for (const versionId of head) if (relevant.has(versionId)) hits += 1;
  return hits / relevant.size;
}

// Precision@k is 0 at empty delivery: no relevant version was delivered, and a
// 0/0 denominator would otherwise read as perfect precision.
export function precisionAt(collapsed: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (collapsed.length === 0) return 0;
  const head = collapsed.slice(0, k);
  let hits = 0;
  for (const versionId of head) if (relevant.has(versionId)) hits += 1;
  return hits / Math.min(k, collapsed.length);
}

export function reciprocalRank(collapsed: readonly string[], relevant: ReadonlySet<string>): number {
  for (const [index, versionId] of collapsed.entries()) {
    if (relevant.has(versionId)) return 1 / (index + 1);
  }
  return 0;
}

export function ndcgAt(
  collapsed: readonly string[],
  grades: ReadonlyMap<string, number>,
  k: number,
): number {
  let dcg = 0;
  for (const [index, versionId] of collapsed.slice(0, k).entries()) {
    dcg += (grades.get(versionId) ?? 0) / Math.log2(index + 2);
  }
  const ideal = [...grades.values()].sort((left, right) => right - left).slice(0, k);
  let idcg = 0;
  for (const [index, grade] of ideal.entries()) idcg += grade / Math.log2(index + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// The exact gain a PERFECT reorderer of the DELIVERED set could achieve. Valid
// as a common ceiling for a rescorer only while `truncated = 0` — embedding
// scores fuse before the 64-candidate cap, so under truncation a rescorer could
// pull a relevant pre-cap candidate into delivery and exceed this bound.
export function oracleHeadroomAt(
  collapsed: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  let deliveredRelevant = 0;
  for (const versionId of collapsed) if (relevant.has(versionId)) deliveredRelevant += 1;
  const capacity = Math.min(deliveredRelevant, k) / relevant.size;
  return capacity - recallAt(collapsed, relevant, k);
}

export function macroAverage(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function roundMetric(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
