import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  decodeLegacyS3Cursor,
  encodeLegacyS3Cursor,
  inventoryLegacyBrain,
  legacyInventoryToken,
  legacyRelationIdentity,
  quoteLegacyInventoryIdentifier,
  LEGACY_S3_CURSOR_FORMAT,
  LEGACY_INVENTORY_TOKEN_CONTEXT,
  type LegacyInventoryFinding,
  type LegacyInventoryInput,
  type LegacyInventoryLimits,
  type LegacyInventoryPgPort,
  type LegacyInventoryResult,
  type LegacyObjectHeadVersion,
  type LegacyObjectHistoryObservation,
  type LegacyObjectHistoryPage,
  type LegacyObjectHistoryReader,
} from '../src/lib/brain/legacy-inventory.ts';
import {
  createLegacyObjectHistoryReader,
  LegacyInventoryS3Error,
  type LegacyS3HistoryTransport,
  type RawLegacyHeadResult,
  type RawLegacyListVersionsResult,
} from '../src/lib/brain/legacy-inventory-s3.ts';
import { brainObjectNamespaceFingerprint } from '../src/lib/brain/object-store.ts';
import { RosterError } from '../src/lib/errors.ts';

type FixtureColumn = {
  name: string;
  type: string;
  base: string;
  type_schema?: string;
  not_null?: boolean;
  generated?: string;
  identity?: string;
  has_default?: boolean;
};

type FixtureAcl = { grantor: string; grantee: string | null; privilege: string; grantable: boolean };

type FixtureRelation = {
  schema: string;
  name: string;
  kind: string;
  owner: string;
  columns: FixtureColumn[];
  primary_key?: string[];
  acl?: FixtureAcl[];
  defaults?: { column: string; expression: string }[];
  constraints?: { name: string; kind: string; definition: string }[];
  indexes?: { name: string; definition: string }[];
  view_definition?: string;
  rows?: Record<string, string | null>[];
};

type Fixture = {
  expected: { workspace_id: string; fingerprint_format_version: number; namespace_fingerprint: string };
  identity_rows: Record<string, string>[];
  s3: { bucket: string; prefix: string };
  database: { owner: string; acl: FixtureAcl[] };
  schemas: { name: string; owner: string; acl: FixtureAcl[] }[];
  memberships: { role: string; member: string }[];
  default_acls: {
    owner: string;
    schema: string | null;
    object_type: string;
    grantor: string;
    grantee: string | null;
    privilege: string;
    grantable: boolean;
  }[];
  runtime_roles: string[];
  relations: FixtureRelation[];
  history: {
    kind: 'version' | 'delete-marker';
    key: string;
    version_id: string | null;
    is_latest: boolean;
    etag: string | null;
    size_bytes: string | null;
  }[];
  heads: { key: string; version_id: string; etag: string; size_bytes: string }[];
  canaries: string[];
  variants: {
    mismatched_identity_rows: Record<string, string>[];
    no_primary_key_relation: FixtureRelation;
    unsafe_primary_key_relation: FixtureRelation;
  };
};

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/brain-legacy-inventory/sanitized-v1.json', import.meta.url), 'utf8'),
) as Fixture;

const SQL_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(rand() * (index + 1));
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

function unescapeIdentifier(raw: string): string {
  return raw.replaceAll('""', '"');
}

function assertReadOnlyStatement(text: string): void {
  assert.ok(
    text === SQL_BEGIN || text === 'ROLLBACK' || text.startsWith('SELECT'),
    `statement must be read-only: ${text.slice(0, 60)}`,
  );
  assert.doesNotMatch(
    text,
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|CREATE|COPY|LOCK|VACUUM)\b/iu,
    `statement must not contain a write verb: ${text.slice(0, 60)}`,
  );
}

type DbScenario = {
  relations: FixtureRelation[];
  identityRows: Record<string, string>[] | null;
  seed: number;
  poolMode?: boolean;
  failOnSql?: string;
  failCode?: string;
  failMessage?: string;
};

class FakeLegacySession {
  readonly statements: string[] = [];
  released = false;
  private readonly db: FakeLegacyDb;

  constructor(db: FakeLegacyDb) {
    this.db = db;
  }

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(text);
    return this.db.dispatch(text, values);
  }

  release(): void {
    this.released = true;
  }
}

class FakeLegacyDb implements LegacyInventoryPgPort {
  readonly statements: string[] = [];
  readonly sessions: FakeLegacySession[] = [];
  private readonly scenario: DbScenario;
  private readonly rand: () => number;
  private pidCounter = 0;

  constructor(scenario: DbScenario) {
    this.scenario = scenario;
    this.rand = mulberry32(scenario.seed);
  }

  async connect(): Promise<FakeLegacySession> {
    const session = new FakeLegacySession(this);
    this.sessions.push(session);
    return session;
  }

  private backendPid(): string {
    return this.scenario.poolMode === true ? String(4000 + this.pidCounter++) : '4242';
  }

  private shuffle<T>(rows: readonly T[]): { rows: T[] } {
    return { rows: shuffled(rows, this.rand) };
  }

  private relation(schema: string, name: string): FixtureRelation {
    const found = this.scenario.relations.find((entry) => entry.schema === schema && entry.name === name);
    assert.ok(found, `fake: unknown relation ${schema}.${name}`);
    return found;
  }

  private probePresent(qualified: string): boolean {
    if (qualified === 'brain_meta.workspace_identity') return this.scenario.identityRows !== null;
    return this.scenario.relations.some((entry) => `${entry.schema}.${entry.name}` === qualified);
  }

  async dispatch(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(text);
    if (this.scenario.failOnSql !== undefined && text.includes(this.scenario.failOnSql)) {
      throw Object.assign(new Error(`fixture failure ${this.scenario.failMessage ?? ''}`), {
        code: this.scenario.failCode,
      });
    }
    assertReadOnlyStatement(text);
    if (text === SQL_BEGIN || text === 'ROLLBACK') return { rows: [] };
    if (text.includes('set_config(')) return { rows: [{ backend_pid: this.backendPid() }] };
    if (text.includes('pg_backend_pid')) return { rows: [{ backend_pid: this.backendPid() }] };
    const probe = text.match(/to_regclass\('([^']+)'\)/u);
    if (probe !== null) return { rows: [{ present: this.probePresent(probe[1]!) }] };
    if (text.includes('FROM brain_meta.workspace_identity')) {
      return this.shuffle(this.scenario.identityRows ?? []);
    }
    if (text.includes('pg_catalog.count(*)::text AS row_count')) {
      const target = text.match(/FROM "((?:[^"]|"")+)"\."((?:[^"]|"")+)"$/u);
      assert.ok(target, 'fake: count query must name a quoted relation');
      const relation = this.relation(unescapeIdentifier(target[1]!), unescapeIdentifier(target[2]!));
      return { rows: [{ row_count: String((relation.rows ?? []).length) }] };
    }
    if (text.includes('FROM brain_meta.schema_migrations')) {
      const relation = this.relation('brain_meta', 'schema_migrations');
      return this.shuffle((relation.rows ?? []).map((row) => ({ filename: row.filename, sha256: row.sha256 })));
    }
    if (text.includes('FROM brain_meta.runtime_roles')) {
      const relation = this.relation('brain_meta', 'runtime_roles');
      return this.shuffle((relation.rows ?? []).map((row) => ({ rolname: row.rolname })));
    }
    if (text.includes('aclexplode(c.relacl)')) {
      const rows = this.scenario.relations.flatMap((relation) =>
        (relation.acl ?? []).map((entry) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          grantor_name: entry.grantor,
          grantee_name: entry.grantee,
          privilege_type: entry.privilege,
          is_grantable: entry.grantable,
        })));
      return this.shuffle(rows);
    }
    if (text.includes('pg_get_viewdef')) {
      const rows = this.scenario.relations
        .filter((relation) => relation.view_definition !== undefined)
        .map((relation) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          raw_definition: relation.view_definition ?? null,
        }));
      return this.shuffle(rows);
    }
    if (text.includes('FROM pg_catalog.pg_class c')) {
      const rows = this.scenario.relations.map((relation) => ({
        schema_name: relation.schema,
        relation_name: relation.name,
        relation_kind: relation.kind,
        owner_name: relation.owner,
      }));
      return this.shuffle(rows);
    }
    if (text.includes('FROM pg_catalog.pg_attribute a')) {
      const rows = this.scenario.relations.flatMap((relation) =>
        relation.columns.map((column, index) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          ordinal: String(index + 1),
          column_name: column.name,
          type_name: column.type,
          type_schema: column.type_schema ?? 'pg_catalog',
          type_base_name: column.base,
          not_null: column.not_null === true,
          generated_kind: column.generated ?? '',
          identity_kind: column.identity ?? '',
          has_default: column.has_default === true,
        })));
      return this.shuffle(rows);
    }
    if (text.includes('i.indisprimary')) {
      const rows = this.scenario.relations.flatMap((relation) =>
        (relation.primary_key ?? []).map((column, index) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          column_name: column,
          key_position: String(index + 1),
        })));
      return this.shuffle(rows);
    }
    if (text.includes('pg_catalog.pg_attrdef')) {
      const rows = this.scenario.relations.flatMap((relation) =>
        (relation.defaults ?? []).map((entry) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          column_name: entry.column,
          raw_expression: entry.expression,
        })));
      return this.shuffle(rows);
    }
    if (text.includes('pg_catalog.pg_constraint')) {
      const rows = this.scenario.relations.flatMap((relation) =>
        (relation.constraints ?? []).map((entry) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          constraint_name: entry.name,
          constraint_kind: entry.kind,
          raw_definition: entry.definition,
        })));
      return this.shuffle(rows);
    }
    if (text.includes('pg_get_indexdef')) {
      const rows = this.scenario.relations.flatMap((relation) =>
        (relation.indexes ?? []).map((entry) => ({
          schema_name: relation.schema,
          relation_name: relation.name,
          index_name: entry.name,
          raw_definition: entry.definition,
        })));
      return this.shuffle(rows);
    }
    if (text.includes('FROM pg_catalog.pg_database')) {
      const acl = FIXTURE.database.acl;
      const rows: Record<string, unknown>[] = acl.length === 0
        ? [{ owner_name: FIXTURE.database.owner, grantor_name: null, grantee_name: null, privilege_type: null, is_grantable: null }]
        : acl.map((entry) => ({
            owner_name: FIXTURE.database.owner,
            grantor_name: entry.grantor,
            grantee_name: entry.grantee,
            privilege_type: entry.privilege,
            is_grantable: entry.grantable,
          }));
      return this.shuffle(rows);
    }
    if (text.includes('FROM pg_catalog.pg_namespace ns')) {
      const rows = FIXTURE.schemas.flatMap((schema): Record<string, unknown>[] =>
        schema.acl.length === 0
          ? [{ schema_name: schema.name, owner_name: schema.owner, grantor_name: null, grantee_name: null, privilege_type: null, is_grantable: null }]
          : schema.acl.map((entry) => ({
              schema_name: schema.name,
              owner_name: schema.owner,
              grantor_name: entry.grantor,
              grantee_name: entry.grantee,
              privilege_type: entry.privilege,
              is_grantable: entry.grantable,
            })));
      return this.shuffle(rows);
    }
    if (text.includes('pg_auth_members')) {
      const scoped = new Set((values?.[0] as string[]) ?? []);
      const rows = FIXTURE.memberships
        .filter((entry) => scoped.has(entry.role) || scoped.has(entry.member))
        .map((entry) => ({ role_name: entry.role, member_name: entry.member }));
      return this.shuffle(rows);
    }
    if (text.includes('pg_default_acl')) {
      const rows = FIXTURE.default_acls.map((entry) => ({
        owner_name: entry.owner,
        schema_name: entry.schema,
        object_type: entry.object_type,
        grantor_name: entry.grantor,
        grantee_name: entry.grantee,
        privilege_type: entry.privilege,
        is_grantable: entry.grantable,
      }));
      return this.shuffle(rows);
    }
    const rowQuery = text.match(/^SELECT (.+) FROM "((?:[^"]|"")+)"\."((?:[^"]|"")+)" LIMIT \$1$/su);
    if (rowQuery !== null) {
      const relation = this.relation(unescapeIdentifier(rowQuery[2]!), unescapeIdentifier(rowQuery[3]!));
      const known = new Set(relation.columns.map((column) => column.name));
      const requested: { column: string; alias: string }[] = [];
      for (const item of rowQuery[1]!.matchAll(/"((?:[^"]|"")+)"::text AS "((?:[^"]|"")+)"/gu)) {
        const column = unescapeIdentifier(item[1]!);
        assert.ok(known.has(column), `fake: query requested unknown column ${column}`);
        requested.push({ column, alias: unescapeIdentifier(item[2]!) });
      }
      assert.ok(requested.length > 0, 'fake: row query selected no columns');
      const limit = Number(values?.[0]);
      assert.ok(Number.isSafeInteger(limit) && limit > 0, 'fake: row query must carry a positive LIMIT');
      const rows = shuffled(relation.rows ?? [], this.rand).slice(0, limit).map((row) => {
        const out: Record<string, unknown> = {};
        for (const entry of requested) out[entry.alias] = row[entry.column] ?? null;
        return out;
      });
      return { rows };
    }
    throw new Error(`fake: unhandled statement ${text.slice(0, 80)}`);
  }
}

type CursorMode = 'malformed' | 'wrong-namespace' | 'wrong-prefix' | 'repeat' | 'regress';

type FakeHead = {
  key: string;
  version_id: string;
  etag: string | null;
  size_bytes: string;
  respond_version_id?: string | null;
};

class FakeHistoryReader implements LegacyObjectHistoryReader {
  readonly bucket: string;
  readonly prefix: string;
  readonly namespaceFingerprint: string;
  readonly listCalls: (string | null)[] = [];
  readonly headCalls: { key: string; versionId: string }[] = [];
  private readonly pages: LegacyObjectHistoryObservation[][];
  private readonly cursors: (string | null)[];
  private readonly cursorIndex = new Map<string, number>();
  private readonly heads: Map<string, LegacyObjectHeadVersion>;
  private readonly failAtListCall: number | undefined;
  private readonly failWith: Error | undefined;

  constructor(opts: {
    bucket: string;
    prefix: string;
    entries: readonly LegacyObjectHistoryObservation[];
    heads: readonly FakeHead[];
    pageSize: number;
    rand: () => number;
    namespaceFingerprint?: string;
    cursorMode?: CursorMode;
    failAtListCall?: number;
    failWith?: Error;
  }) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.namespaceFingerprint = opts.namespaceFingerprint ?? FIXTURE.expected.namespace_fingerprint;
    this.failAtListCall = opts.failAtListCall;
    this.failWith = opts.failWith;
    this.heads = new Map(opts.heads.map((head) => [
      `${head.key}\u0000${head.version_id}`,
      {
        etag: head.etag,
        sizeBytes: head.size_bytes,
        versionId: head.respond_version_id === undefined ? head.version_id : head.respond_version_id,
      },
    ]));
    const sortedEntries = [...opts.entries].sort((a, b) => {
      const key = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      if (key !== 0) return key;
      const av = a.versionId ?? '';
      const bv = b.versionId ?? '';
      if (av !== bv) return av < bv ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
    this.pages = [];
    for (let index = 0; index < sortedEntries.length; index += opts.pageSize) {
      this.pages.push(sortedEntries.slice(index, index + opts.pageSize));
    }
    if (this.pages.length === 0) this.pages.push([]);
    const namespace = this.namespaceFingerprint;
    this.cursors = this.pages.map((page, index) => {
      if (index === this.pages.length - 1) return null;
      const last = page[page.length - 1]!;
      return encodeLegacyS3Cursor({
        namespaceFingerprint: namespace,
        keyMarker: last.key,
        versionMarker: last.versionId ?? '',
      });
    });
    if (opts.cursorMode === 'malformed') this.cursors[0] = 'not-a-cursor';
    if (opts.cursorMode === 'wrong-namespace') {
      this.cursors[0] = encodeLegacyS3Cursor({
        namespaceFingerprint: `sha256:${'b'.repeat(64)}`,
        keyMarker: 'brain/a',
        versionMarker: '',
      });
    }
    if (opts.cursorMode === 'wrong-prefix') {
      this.cursors[0] = encodeLegacyS3Cursor({
        namespaceFingerprint: namespace,
        keyMarker: 'outside/key',
        versionMarker: '',
      });
    }
    if (opts.cursorMode === 'repeat' && this.cursors.length > 2) this.cursors[1] = this.cursors[0];
    if (opts.cursorMode === 'regress' && this.cursors.length > 2) {
      this.cursors[1] = encodeLegacyS3Cursor({ namespaceFingerprint: namespace, keyMarker: 'brain/a', versionMarker: 'x' });
    }
    for (const [index, cursor] of this.cursors.entries()) {
      if (cursor !== null && !this.cursorIndex.has(cursor)) this.cursorIndex.set(cursor, index + 1);
    }
    this.pages = this.pages.map((page) => shuffled(page, opts.rand));
  }

  async listHistory(cursor: string | null): Promise<LegacyObjectHistoryPage> {
    this.listCalls.push(cursor);
    if (this.failAtListCall === this.listCalls.length) throw this.failWith ?? new Error('fake list outage');
    const index = cursor === null ? 0 : this.cursorIndex.get(cursor);
    assert.ok(index !== undefined, 'fake: unknown cursor presented');
    const page = this.pages[index];
    assert.ok(page !== undefined, 'fake: cursor advanced past the final page');
    return { entries: page, cursor: this.cursors[index] ?? null };
  }

  async headVersion(input: { key: string; versionId: string }): Promise<LegacyObjectHeadVersion | null> {
    this.headCalls.push(input);
    return this.heads.get(`${input.key}\u0000${input.versionId}`) ?? null;
  }
}

const DEFAULT_LIMITS: LegacyInventoryLimits = {
  maxRelations: 100,
  maxStableIdRows: 500,
  maxObjectHistoryPages: 50,
  maxObjectHistoryItems: 500,
  maxFindings: 100,
  maxTransactionMs: 60_000,
};

type ScenarioOptions = {
  seed?: number;
  pageSize?: number;
  limits?: Partial<LegacyInventoryLimits>;
  policy?: 'refuse' | 'permit-unverified';
  identityRows?: Record<string, string>[] | null;
  extraRelations?: FixtureRelation[];
  patchRelations?: (relations: FixtureRelation[]) => void;
  heads?: FakeHead[];
  readerFingerprint?: string;
  poolMode?: boolean;
  cursorMode?: CursorMode;
  failAtListCall?: number;
  failWith?: Error;
  failOnSql?: string;
  failCode?: string;
  failMessage?: string;
  clock?: () => number;
};

function fixtureHistory(): LegacyObjectHistoryObservation[] {
  return FIXTURE.history.map((entry) => ({
    kind: entry.kind,
    key: entry.key,
    versionId: entry.version_id,
    isLatest: entry.is_latest,
    etag: entry.etag,
    sizeBytes: entry.size_bytes,
  }));
}

function buildScenario(opts: ScenarioOptions = {}): {
  db: FakeLegacyDb;
  reader: FakeHistoryReader;
  input: LegacyInventoryInput;
} {
  const seed = opts.seed ?? 1;
  const relations = structuredClone(FIXTURE.relations).concat(structuredClone(opts.extraRelations ?? []));
  opts.patchRelations?.(relations);
  const db = new FakeLegacyDb({
    relations,
    identityRows: opts.identityRows === undefined ? structuredClone(FIXTURE.identity_rows) : opts.identityRows,
    seed,
    ...(opts.poolMode === undefined ? {} : { poolMode: opts.poolMode }),
    ...(opts.failOnSql === undefined ? {} : { failOnSql: opts.failOnSql }),
    ...(opts.failCode === undefined ? {} : { failCode: opts.failCode }),
    ...(opts.failMessage === undefined ? {} : { failMessage: opts.failMessage }),
  });
  const reader = new FakeHistoryReader({
    bucket: FIXTURE.s3.bucket,
    prefix: FIXTURE.s3.prefix,
    entries: fixtureHistory(),
    heads: opts.heads ?? FIXTURE.heads,
    pageSize: opts.pageSize ?? 4,
    rand: mulberry32(seed + 1000),
    ...(opts.readerFingerprint === undefined ? {} : { namespaceFingerprint: opts.readerFingerprint }),
    ...(opts.cursorMode === undefined ? {} : { cursorMode: opts.cursorMode }),
    ...(opts.failAtListCall === undefined ? {} : { failAtListCall: opts.failAtListCall }),
    ...(opts.failWith === undefined ? {} : { failWith: opts.failWith }),
  });
  const input: LegacyInventoryInput = {
    pg: db,
    objectHistory: reader,
    expected: {
      workspaceId: FIXTURE.expected.workspace_id,
      fingerprintFormatVersion: FIXTURE.expected.fingerprint_format_version,
      namespaceFingerprint: FIXTURE.expected.namespace_fingerprint,
    },
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    absentIdentityPolicy: opts.policy ?? 'refuse',
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  };
  return { db, reader, input };
}

function expectComplete(result: LegacyInventoryResult): Extract<LegacyInventoryResult, { outcome: 'complete' }> {
  assert.equal(result.outcome, 'complete', `expected a complete inventory, got ${JSON.stringify(result).slice(0, 400)}`);
  return result as Extract<LegacyInventoryResult, { outcome: 'complete' }>;
}

function expectIncomplete(result: LegacyInventoryResult): Extract<LegacyInventoryResult, { outcome: 'incomplete' }> {
  assert.equal(result.outcome, 'incomplete');
  const incomplete = result as Extract<LegacyInventoryResult, { outcome: 'incomplete' }>;
  assert.ok(!('digest' in incomplete), 'incomplete result must not carry a digest');
  assert.ok(!('manifestBytes' in incomplete), 'incomplete result must not carry manifest bytes');
  return incomplete;
}

function sortFindings(findings: LegacyInventoryFinding[]): LegacyInventoryFinding[] {
  const key = (entry: LegacyInventoryFinding): string =>
    JSON.stringify([entry.code, entry.resource_kind, entry.resource_ref, entry.detail_ref]);
  return [...findings].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function hasCode(result: LegacyInventoryResult, code: string): boolean {
  assert.equal(result.outcome, 'incomplete');
  return (result as Extract<LegacyInventoryResult, { outcome: 'incomplete' }>).findings.some((entry) => entry.code === code);
}

function tokenPath(value: string): string {
  return legacyInventoryToken('path', value);
}

function tokenKey(value: string): string {
  return legacyInventoryToken('s3-key', value);
}

const HASH_CD = 'sha256:cd00000000000000000000000000000000000000000000000000000000000000';
const HASH_A9 = 'sha256:a900000000000000000000000000000000000000000000000000000000000000';
const KEY_EE = 'brain/objects/ee/ee00000000000000000000000000000000000000000000000000000000000000';

function expectedBaseFindings(): LegacyInventoryFinding[] {
  return sortFindings([
    { code: 'absolute-locator', resource_kind: 'row', resource_ref: 'brain.documents/2', detail_ref: tokenPath('/Users/canary-user/exports/report.md') },
    { code: 'ambiguous-ownership', resource_kind: 'object', resource_ref: tokenKey('brain/media/gone-old.txt'), detail_ref: 'unowned' },
    { code: 'ambiguous-ownership', resource_kind: 'object-version', resource_ref: tokenKey('brain/media/post-1.png'), detail_ref: 'multiple-claims' },
    { code: 'ambiguous-ownership', resource_kind: 'row', resource_ref: 'brain.files/6', detail_ref: 'outside-namespace' },
    { code: 'ambiguous-version-match', resource_kind: 'row', resource_ref: 'brain.files/4', detail_ref: tokenKey('brain/media/dup.bin') },
    { code: 'etag-drift', resource_kind: 'object-version', resource_ref: `brain.source_objects/${HASH_CD}`, detail_ref: 'head-vs-history' },
    { code: 'foreign-locator', resource_kind: 'row', resource_ref: 'brain.entity_aliases/1', detail_ref: tokenPath('file:///canary/foreign') },
    { code: 'foreign-locator', resource_kind: 'row', resource_ref: 'brain.files/6', detail_ref: tokenPath('s3://other-bucket/elsewhere/thing.bin') },
    { code: 'malformed-locator', resource_kind: 'row', resource_ref: 'brain.facts/2', detail_ref: tokenPath('bad\u0007locator') },
    { code: 'migration-metadata-malformed', resource_kind: 'migration', resource_ref: 'brain_meta.schema_migrations', detail_ref: 'malformed-entries' },
    { code: 'missing-bytes', resource_kind: 'row', resource_ref: 'brain.files/3', detail_ref: tokenKey('brain/media/gone.bin') },
    { code: 'mutable-key-history', resource_kind: 'object', resource_ref: tokenKey(KEY_EE), detail_ref: 'mutable-content-key' },
    { code: 'partial-cutover', resource_kind: 'relation', resource_ref: 'brain.logical_sources', detail_ref: 'non-empty' },
    { code: 'partial-cutover', resource_kind: 'relation', resource_ref: 'brain.source_objects', detail_ref: 'non-empty' },
    { code: 'reused-hash', resource_kind: 'object', resource_ref: 'c0ffeeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', detail_ref: 'multiple-keys' },
    { code: 'temporary-locator', resource_kind: 'row', resource_ref: 'brain.mounts/1', detail_ref: tokenPath('/private/tmp/canary-tmp/file.md') },
    { code: 'userinfo-locator', resource_kind: 'row', resource_ref: 'brain.facts/1', detail_ref: tokenPath('https://user:CANARY_PASSWORD_9@example.com/profile') },
    { code: 'version-drift', resource_kind: 'object-version', resource_ref: `brain.source_objects/${HASH_A9}`, detail_ref: 'not-listed' },
  ]);
}

function assertNoCanaries(payloads: string[], context: string): void {
  for (const canary of FIXTURE.canaries) {
    for (const payload of payloads) {
      assert.ok(!payload.includes(canary), `${context}: canary '${canary}' leaked`);
    }
  }
}

test('legacy inventory token, identifier quoting, and cursor helpers are exact', () => {
  const manual = createHash('sha256')
    .update(`${LEGACY_INVENTORY_TOKEN_CONTEXT}s3-key`, 'utf8')
    .update(Buffer.from([0]))
    .update('brain/media/post-1.png', 'utf8')
    .digest('hex');
  assert.equal(legacyInventoryToken('s3-key', 'brain/media/post-1.png'), `sha256:${manual}`);
  assert.notEqual(legacyInventoryToken('path', 'value'), legacyInventoryToken('stable-id', 'value'));

  assert.equal(quoteLegacyInventoryIdentifier('simple'), '"simple"');
  assert.equal(quoteLegacyInventoryIdentifier('We"ird name'), '"We""ird name"');
  assert.throws(() => quoteLegacyInventoryIdentifier(''), (error: unknown) =>
    error instanceof RosterError && error.code === 'LEGACY_INVENTORY_IDENTIFIER_INVALID');
  assert.throws(() => quoteLegacyInventoryIdentifier('nul\u0000name'), (error: unknown) =>
    error instanceof RosterError && error.code === 'LEGACY_INVENTORY_IDENTIFIER_INVALID');

  const namespace = FIXTURE.expected.namespace_fingerprint;
  const cursor = encodeLegacyS3Cursor({ namespaceFingerprint: namespace, keyMarker: 'brain/a', versionMarker: 'v1' });
  assert.ok(cursor.startsWith(`${LEGACY_S3_CURSOR_FORMAT}.`));
  assert.deepEqual(decodeLegacyS3Cursor(cursor), {
    namespaceFingerprint: namespace,
    keyMarker: 'brain/a',
    versionMarker: 'v1',
  });
  assert.equal(decodeLegacyS3Cursor('garbage'), null);
  assert.equal(decodeLegacyS3Cursor(`wrong-format.${cursor.split('.')[1]}`), null);
  assert.equal(
    decodeLegacyS3Cursor(`${LEGACY_S3_CURSOR_FORMAT}.${Buffer.from('{"format":"x"}', 'utf8').toString('base64url')}`),
    null,
  );
});

test('acceptance: complete inventory covers every acceptance field and discovers custom relations', async () => {
  const { db, input } = buildScenario();
  const result = expectComplete(await inventoryLegacyBrain(input));
  const manifest = result.manifest as Record<string, any>;

  assert.equal(manifest.manifest_format_version, 1);
  assert.equal(manifest.inventory_algorithm, 'roster-legacy-inventory-v1');
  assert.equal(manifest.token_scheme, 'sha256-domain-v1');

  assert.equal(manifest.identity.ownership, 'verified');
  assert.equal(manifest.identity.observed.status, 'verified');
  assert.equal(manifest.identity.observed.workspace_id, 'fixture-workspace');
  assert.equal(manifest.identity.expected.namespace_fingerprint, FIXTURE.expected.namespace_fingerprint);
  assert.ok(!('database_authority_id' in manifest.identity.observed), 'random database authority id must stay out of digest bytes');

  assert.equal(manifest.postgres.migrations.status, 'present');
  assert.deepEqual(
    manifest.postgres.migrations.entries.map((entry: { filename: string }) => entry.filename),
    ['001_init.sql', '004_documents_mount.sql'],
  );
  assert.equal(manifest.postgres.migrations.malformed_count, 1);
  assert.match(manifest.postgres.migrations.set_hash, /^sha256:[a-f0-9]{64}$/);

  const relations = manifest.postgres.relations as Record<string, any>[];
  assert.equal(relations.length, 19);
  for (const relation of relations) {
    assert.match(relation.definition_hash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(relation.definition.columns.length > 0);
  }
  assert.match(manifest.postgres.definition_set_hash, /^sha256:[a-f0-9]{64}$/);

  const byName = new Map(relations.filter((entry) => entry.name !== null).map((entry) => [`${entry.schema}.${entry.name}`, entry]));
  assert.equal(byName.get('brain.entities')!.classification, 'product-legacy');
  assert.equal(byName.get('brain.entities')!.row_count, '3');
  assert.equal(byName.get('brain.entities')!.rows.length, 3);
  assert.equal(byName.get('brain.entities')!.rows[0].id, '1');
  assert.equal(byName.get('brain.entities')!.rows[0].canonical_id, '1');
  assert.equal(byName.get('brain.entities')!.rows[2].id, '9007199254740993');
  assert.equal(byName.get('brain.entities')!.rows[2].canonical_id, '9007199254740993');
  assert.equal(byName.get('brain.entities')!.rows[0].kind, legacyInventoryToken('stable-id', 'competitor'));
  assert.equal(byName.get('brain.source_objects')!.classification, 'product-lifecycle');
  assert.equal(byName.get('brain.current_facts')!.classification, 'product-meta');
  assert.equal(byName.get('brain.current_facts')!.relation_kind, 'view');
  assert.equal(byName.get('brain_meta.workspace_identity')!.classification, 'product-meta');

  const custom = relations.filter((entry) => entry.classification === 'adopter-custom');
  assert.equal(custom.length, 4);
  const customTables = custom.filter((entry) => entry.relation_kind === 'table');
  assert.equal(customTables.length, 3);
  for (const entry of customTables) {
    assert.equal(entry.name, null);
    assert.match(entry.name_token, /^sha256:[a-f0-9]{64}$/);
    assert.ok(entry.stable_ids !== null);
    assert.match(entry.stable_ids.digest, /^sha256:[a-f0-9]{64}$/);
  }
  const zebra = custom.find((entry) =>
    entry.name_token === legacyInventoryToken('relation-name', legacyRelationIdentity('brain', 'ZebraQuoted "Canary" Table')));
  assert.ok(zebra, 'quoted custom relation must be discovered');
  assert.equal(zebra!.stable_ids.count, 2);
  assert.deepEqual(zebra!.stable_ids.ids, [
    [legacyInventoryToken('stable-id', '0f0e0d0c-1111-4222-8333-444455556666')],
    [legacyInventoryToken('stable-id', '1a1b1c1d-2222-4333-8444-555566667777')],
  ]);
  const notes = custom.find((entry) =>
    entry.name_token === legacyInventoryToken('relation-name', legacyRelationIdentity('brain', 'custom_notes')));
  assert.ok(notes, 'composite text-keyed custom relation must be discovered');
  assert.equal(notes!.stable_ids.count, 2);
  for (const tuple of notes!.stable_ids.ids as [string, string][]) {
    assert.match(tuple[0], /^sha256:[a-f0-9]{64}$/);
    assert.match(tuple[1], /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(notes!.stable_ids.ids[0][0], legacyInventoryToken('stable-id', 'canary-text-pk-value'));
  const metrics = custom.find((entry) =>
    entry.name_token === legacyInventoryToken('relation-name', legacyRelationIdentity('analytics', 'custom_metrics')));
  assert.ok(metrics, 'custom-schema relation must be discovered');
  assert.equal(metrics!.schema, null);
  assert.equal(metrics!.schema_token, legacyInventoryToken('schema-name', 'analytics'));
  assert.deepEqual(metrics!.stable_ids.ids, [[legacyInventoryToken('stable-id', '424242424242')]]);

  const files = byName.get('brain.files')!;
  const fileRows = files.rows as Record<string, any>[];
  assert.equal(fileRows.length, 7);
  assert.deepEqual(fileRows[0].correlation, { status: 'matched', version_id: 'v-file-1' });
  assert.deepEqual(fileRows[2].correlation, { status: 'missing' });
  assert.deepEqual(fileRows[3].correlation, { status: 'ambiguous', match_count: 2 });
  assert.deepEqual(fileRows[5].correlation, { status: 'outside-namespace' });
  assert.equal(fileRows[6].correlation, undefined);
  assert.equal(fileRows[0].etag, '"etagA"');
  assert.equal(fileRows[0].size_bytes, '2048');
  assert.equal(fileRows[0].content_hash, 'c0ffeeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  const sourceObjects = byName.get('brain.source_objects')!.rows as Record<string, any>[];
  const byObjectId = new Map(sourceObjects.map((row) => [row.object_id, row]));
  assert.deepEqual(byObjectId.get('sha256:ab00000000000000000000000000000000000000000000000000000000000000')!.correlation, { status: 'matched', version_id: 'v-lc-1' });
  assert.deepEqual(byObjectId.get(HASH_CD)!.correlation, { status: 'drift', version_id: 'v-lc-2' });
  assert.deepEqual(byObjectId.get(HASH_A9)!.correlation, { status: 'drift', version_id: 'v-lc-3' });
  assert.deepEqual(byObjectId.get('sha256:ff00000000000000000000000000000000000000000000000000000000000000')!.correlation, { status: 'matched', version_id: 'null' });

  assert.equal(manifest.postgres.runtime_roles.status, 'present');
  assert.deepEqual(manifest.postgres.runtime_roles.role_tokens, [legacyInventoryToken('role-name', 'roster_brain_rw')]);
  assert.equal(manifest.postgres.database.owner_token, legacyInventoryToken('role-name', 'fixture_admin'));
  assert.equal(manifest.postgres.database.acl.length, 1);
  assert.equal(manifest.postgres.schemas.length, 4);
  const publicSchema = (manifest.postgres.schemas as Record<string, any>[]).find((entry) => entry.schema === 'public');
  assert.deepEqual(publicSchema!.acl[0].grantee, 'PUBLIC');
  assert.equal(manifest.postgres.role_memberships.length, 1);
  assert.equal(manifest.postgres.default_acls.length, 1);

  assert.equal(manifest.s3.namespace.fingerprint, FIXTURE.expected.namespace_fingerprint);
  const history = manifest.s3.history as Record<string, any>[];
  assert.equal(history.length, 11);
  assert.equal(history.filter((entry) => entry.kind === 'version').length, 10);
  assert.equal(history.filter((entry) => entry.kind === 'delete-marker').length, 1);
  const nullVersion = history.find((entry) => entry.version_id === 'null');
  assert.ok(nullVersion, "literal S3 version id 'null' must stay a distinct string");
  for (const entry of history) {
    assert.match(entry.key_token, /^sha256:[a-f0-9]{64}$/);
  }

  assert.equal(result.digest, `sha256:${createHash('sha256').update(result.manifestBytes).digest('hex')}`);
  assert.ok(result.manifestBytes.toString('utf8').endsWith('\n'));
  assert.deepEqual([...result.report.findings], expectedBaseFindings());
  assert.equal(result.report.manifest_digest, result.digest);
  assert.deepEqual(result.report.totals, {
    relations: 19,
    product_legacy_rows: 19,
    lifecycle_rows: 5,
    custom_tables: 3,
    custom_stable_ids: 5,
    object_versions: 10,
    delete_markers: 1,
    migrations: 2,
    findings: 18,
  });

  assert.ok(db.statements.length > 0);
  assert.equal(db.statements[0], SQL_BEGIN);
  assert.equal(db.statements[db.statements.length - 1], 'ROLLBACK');
});

test('determinism: byte-identical manifest and digest across insertion, response, and page-size reorderings', async () => {
  const first = expectComplete(await inventoryLegacyBrain(buildScenario({ seed: 7, pageSize: 3 }).input));
  const second = expectComplete(await inventoryLegacyBrain(buildScenario({ seed: 99, pageSize: 1000 }).input));
  const third = expectComplete(await inventoryLegacyBrain(buildScenario({ seed: 1234, pageSize: 1 }).input));
  assert.ok(first.manifestBytes.equals(second.manifestBytes));
  assert.ok(first.manifestBytes.equals(third.manifestBytes));
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, third.digest);
  assert.deepEqual(first.report, second.report);
});

test('pagination: no omission or duplication across pages, and a failed run restarts from page one', async () => {
  const baseline = expectComplete(await inventoryLegacyBrain(buildScenario({ seed: 5, pageSize: 1000 }).input));
  const paged = buildScenario({ seed: 5, pageSize: 2 });
  const pagedResult = expectComplete(await inventoryLegacyBrain(paged.input));
  assert.ok(paged.reader.listCalls.length >= 6, 'small pages must require many list calls');
  assert.ok(baseline.manifestBytes.equals(pagedResult.manifestBytes));

  const failing = buildScenario({ seed: 5, pageSize: 2, failAtListCall: 2 });
  const failed = expectIncomplete(await inventoryLegacyBrain(failing.input));
  assert.ok(hasCode(failed, 'provider-error'));

  const retry = buildScenario({ seed: 5, pageSize: 2 });
  const retried = expectComplete(await inventoryLegacyBrain(retry.input));
  assert.equal(retry.reader.listCalls[0], null, 'a retry must restart from page one with no durable checkpoint');
  assert.ok(retried.manifestBytes.equals(baseline.manifestBytes));
  assert.equal(retried.digest, baseline.digest);
});

test('identity gate: mismatch stops before any company-table read or S3 access', async () => {
  const mismatch = buildScenario({ identityRows: structuredClone(FIXTURE.variants.mismatched_identity_rows) });
  const result = expectIncomplete(await inventoryLegacyBrain(mismatch.input));
  assert.deepEqual(result.findings[0], {
    code: 'identity-mismatch',
    resource_kind: 'database',
    resource_ref: 'workspace-identity',
    detail_ref: 'workspace-id',
  });
  assert.equal(mismatch.reader.listCalls.length, 0, 'S3 must never be touched after an identity mismatch');
  assert.equal(mismatch.reader.headCalls.length, 0);
  for (const statement of mismatch.db.statements) {
    assert.ok(!statement.includes('FROM "brain"'), `company-table read leaked before the identity gate: ${statement.slice(0, 60)}`);
    assert.ok(!/FROM brain\./u.test(statement), `company-table read leaked before the identity gate: ${statement.slice(0, 60)}`);
  }
  assert.equal(mismatch.db.statements.length, 6);
  assert.equal(mismatch.db.statements[5], 'ROLLBACK');
});

test('identity gate: absent identity honors the selected policy', async () => {
  const refused = buildScenario({ identityRows: null, policy: 'refuse' });
  const refusal = expectIncomplete(await inventoryLegacyBrain(refused.input));
  assert.deepEqual(refusal.findings[0], {
    code: 'identity-unverified-refused',
    resource_kind: 'database',
    resource_ref: 'workspace-identity',
    detail_ref: 'absent',
  });
  assert.equal(refused.reader.listCalls.length, 0);

  const permittedIdentityAbsent = buildScenario({ identityRows: null, policy: 'permit-unverified' });
  const permitted = expectComplete(await inventoryLegacyBrain(permittedIdentityAbsent.input));
  const manifest = permitted.manifest as Record<string, any>;
  assert.equal(manifest.identity.ownership, 'unverified');
  assert.deepEqual(manifest.identity.observed, { status: 'unverified' });
  assert.equal(manifest.identity.absent_identity_policy, 'permit-unverified');
  assert.equal(permitted.report.ownership, 'unverified');

  const verified = expectComplete(await inventoryLegacyBrain(buildScenario().input));
  assert.notEqual(verified.digest, permitted.digest, 'unverified ownership must change digest-bearing bytes');
});

test('findings: missing, ambiguous, drift, and ownership findings are deterministic', async () => {
  const first = expectComplete(await inventoryLegacyBrain(buildScenario({ seed: 21 }).input));
  const second = expectComplete(await inventoryLegacyBrain(buildScenario({ seed: 42 }).input));
  assert.deepEqual([...first.report.findings], expectedBaseFindings());
  assert.deepEqual(first.report.findings, second.report.findings);
  const sorted = sortFindings([...first.report.findings]);
  assert.deepEqual([...first.report.findings], sorted, 'findings must already be sorted by (code, resource_kind, resource_ref, detail_ref)');
});

test('incomplete without digest: limits, bad cursors, unsafe catalog shape, and missing stable keys', async () => {
  const relationLimit = expectIncomplete(await inventoryLegacyBrain(buildScenario({ limits: { maxRelations: 2 } }).input));
  assert.ok(hasCode(relationLimit, 'relation-limit'));

  const rowLimit = expectIncomplete(await inventoryLegacyBrain(buildScenario({ limits: { maxStableIdRows: 3 } }).input));
  assert.ok(hasCode(rowLimit, 'row-limit'));

  const itemLimit = expectIncomplete(await inventoryLegacyBrain(buildScenario({ limits: { maxObjectHistoryItems: 2 } }).input));
  assert.ok(hasCode(itemLimit, 'object-history-limit'));

  const pageLimit = expectIncomplete(
    await inventoryLegacyBrain(buildScenario({ pageSize: 4, limits: { maxObjectHistoryPages: 2 } }).input),
  );
  assert.ok(hasCode(pageLimit, 'object-history-limit'));

  const findingLimit = expectIncomplete(await inventoryLegacyBrain(buildScenario({ limits: { maxFindings: 3 } }).input));
  assert.equal(findingLimit.findings.length, 3);
  assert.deepEqual([...findingLimit.findings], sortFindings([...findingLimit.findings]));

  for (const cursorMode of ['malformed', 'wrong-namespace', 'wrong-prefix', 'repeat', 'regress'] as const) {
    const scenario = buildScenario({ pageSize: 4, cursorMode });
    const result = expectIncomplete(await inventoryLegacyBrain(scenario.input));
    assert.ok(hasCode(result, 'cursor-invalid'), `cursor mode ${cursorMode}`);
  }

  const noPk = expectIncomplete(
    await inventoryLegacyBrain(
      buildScenario({ extraRelations: [structuredClone(FIXTURE.variants.no_primary_key_relation)] }).input,
    ),
  );
  const noPkFinding = noPk.findings.find((entry) => entry.code === 'missing-stable-key');
  assert.ok(noPkFinding, 'missing-stable-key finding expected');
  assert.equal(noPkFinding!.resource_ref, legacyInventoryToken('relation-name', legacyRelationIdentity('brain', 'scratch_notes')));

  const unsafePk = expectIncomplete(
    await inventoryLegacyBrain(
      buildScenario({ extraRelations: [structuredClone(FIXTURE.variants.unsafe_primary_key_relation)] }).input,
    ),
  );
  assert.ok(hasCode(unsafePk, 'catalog-shape-unsafe'));

  let clockCalls = 0;
  const timedOut = buildScenario({
    clock: () => (clockCalls++ === 0 ? 0 : 10_000_000),
    limits: { maxTransactionMs: 1_000 },
  });
  const timeLimit = expectIncomplete(await inventoryLegacyBrain(timedOut.input));
  assert.ok(hasCode(timeLimit, 'time-limit'));
  assert.equal(timedOut.db.statements.length, 0, 'the time guard must stop before issuing statements');

  const sqlError = buildScenario({
    failOnSql: 'FROM "brain"."edges"',
    failCode: '42501',
    failMessage: 'CANARY_PASSWORD_9 /Users/canary-user secret',
  });
  const failed = expectIncomplete(await inventoryLegacyBrain(sqlError.input));
  assert.deepEqual(failed.findings.find((entry) => entry.code === 'sql-error'), {
    code: 'sql-error',
    resource_kind: 'database',
    resource_ref: 'database',
    detail_ref: 'sqlstate-42501',
  });
  assertNoCanaries([JSON.stringify(failed.findings)], 'wrapped SQL error');
});

test('redaction: zero canary leakage in manifest, report, findings, and errors under the tokenize policy', async () => {
  const complete = expectComplete(await inventoryLegacyBrain(buildScenario().input));
  assertNoCanaries(
    [complete.manifestBytes.toString('utf8'), JSON.stringify(complete.report), JSON.stringify(complete.manifest)],
    'complete inventory',
  );

  const incompleteScenarios: LegacyInventoryResult[] = [
    await inventoryLegacyBrain(buildScenario({ identityRows: structuredClone(FIXTURE.variants.mismatched_identity_rows) }).input),
    await inventoryLegacyBrain(buildScenario({ limits: { maxStableIdRows: 3 } }).input),
    await inventoryLegacyBrain(
      buildScenario({ extraRelations: [structuredClone(FIXTURE.variants.no_primary_key_relation)] }).input,
    ),
  ];
  for (const result of incompleteScenarios) {
    assert.equal(result.outcome, 'incomplete');
    assertNoCanaries([JSON.stringify(result)], 'incomplete inventory');
  }

  const badInput = buildScenario();
  badInput.input.limits = { ...DEFAULT_LIMITS, maxRelations: 0 };
  try {
    await inventoryLegacyBrain(badInput.input);
    assert.fail('zero limits must be rejected');
  } catch (error) {
    assert.ok(error instanceof RosterError);
    assert.equal(error.code, 'LEGACY_INVENTORY_INPUT_INVALID');
    assertNoCanaries([error.message, JSON.stringify(error.details)], 'input validation error');
  }
  assert.equal(badInput.db.statements.length, 0, 'input validation must run before any port call');
  assert.equal(badInput.reader.listCalls.length, 0);
});

test('no mutation: every statement is read-only and S3 sees only history listing and head reads', async () => {
  const scenario = buildScenario();
  expectComplete(await inventoryLegacyBrain(scenario.input));
  for (const statement of scenario.db.statements) {
    assertReadOnlyStatement(statement);
  }
  assert.equal(scenario.db.statements.filter((statement) => statement === SQL_BEGIN).length, 1);
  assert.equal(scenario.db.statements.filter((statement) => statement === 'ROLLBACK').length, 1);
  const headKeys = new Set(scenario.reader.headCalls.map((call) => `${call.key}|${call.versionId}`));
  assert.deepEqual(
    [...headKeys].sort(),
    [
      'brain/objects/a9/a900000000000000000000000000000000000000000000000000000000000000|v-lc-3',
      'brain/objects/ab/ab00000000000000000000000000000000000000000000000000000000000000|v-lc-1',
      'brain/objects/cd/cd00000000000000000000000000000000000000000000000000000000000000|v-lc-2',
      'brain/objects/ee/ee00000000000000000000000000000000000000000000000000000000000000|v-mut-1',
    ],
  );
  for (const call of scenario.reader.listCalls) {
    assert.ok(call === null || typeof call === 'string');
  }
});

class FakeTransport implements LegacyS3HistoryTransport {
  readonly ops: string[] = [];
  readonly listInputs: {
    bucket: string;
    prefix: string | null;
    maxKeys: number;
    keyMarker: string | null;
    versionIdMarker: string | null;
  }[] = [];
  private readonly listResults: RawLegacyListVersionsResult[];
  private readonly headResults: Map<string, RawLegacyHeadResult | null>;

  constructor(listResults: RawLegacyListVersionsResult[], headResults: Map<string, RawLegacyHeadResult | null> = new Map()) {
    this.listResults = listResults;
    this.headResults = headResults;
  }

  async listVersions(input: {
    bucket: string;
    prefix: string | null;
    maxKeys: number;
    keyMarker: string | null;
    versionIdMarker: string | null;
  }): Promise<RawLegacyListVersionsResult> {
    this.ops.push('list');
    this.listInputs.push(input);
    const next = this.listResults.shift();
    assert.ok(next !== undefined, 'fake transport: unexpected extra list call');
    return next;
  }

  async headObject(input: { bucket: string; key: string; versionId: string }): Promise<RawLegacyHeadResult | null> {
    this.ops.push('head');
    return this.headResults.get(`${input.key}|${input.versionId}`) ?? null;
  }

  destroy(): void {
    this.ops.push('destroy');
  }
}

const ADAPTER_CONFIG = {
  bucket: 'fixture-legacy-bucket',
  region: 'eu-central-1',
  forcePathStyle: false,
  prefix: 'brain',
  pageSize: 2,
};

test('s3 adapter: pages, tags, and cursors are hardened and read-only', async () => {
  const transport = new FakeTransport(
    [
      {
        Versions: [{ Key: 'brain/a.bin', VersionId: 'null', IsLatest: true, ETag: '"e1"', Size: 3 }],
        DeleteMarkers: [{ Key: 'brain/a.bin', VersionId: 'dm-1', IsLatest: false }],
        IsTruncated: true,
        NextKeyMarker: 'brain/a.bin',
        NextVersionIdMarker: 'dm-1',
      },
      {
        Versions: [{ Key: 'brain/b.bin', IsLatest: true, ETag: '"e2"', Size: 4 }],
        IsTruncated: false,
      },
    ],
    new Map([
      ['brain/a.bin|dm-1', { ETag: '"e1"', ContentLength: 3, VersionId: 'dm-1' }],
      ['brain/missing.bin|v-x', null],
    ]),
  );
  const { reader, close } = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport });
  assert.equal(reader.bucket, 'fixture-legacy-bucket');
  assert.equal(reader.prefix, 'brain');

  const first = await reader.listHistory(null);
  assert.equal(first.entries.length, 2);
  const version = first.entries.find((entry) => entry.kind === 'version')!;
  assert.equal(version.versionId, 'null', "the literal version id 'null' must stay a distinct string");
  assert.equal(version.sizeBytes, '3');
  const marker = first.entries.find((entry) => entry.kind === 'delete-marker')!;
  assert.equal(marker.etag, null);
  assert.equal(marker.sizeBytes, null);
  assert.ok(first.cursor !== null);
  const canonicalFingerprint = brainObjectNamespaceFingerprint({
    bucket: 'fixture-legacy-bucket',
    region: 'eu-central-1',
    forcePathStyle: false,
    rootPrefix: 'brain',
  });
  assert.equal(reader.namespaceFingerprint, canonicalFingerprint);
  const decoded = decodeLegacyS3Cursor(first.cursor!);
  assert.deepEqual(decoded, {
    namespaceFingerprint: canonicalFingerprint,
    keyMarker: 'brain/a.bin',
    versionMarker: 'dm-1',
  });

  const second = await reader.listHistory(first.cursor);
  assert.equal(second.cursor, null);
  assert.equal(second.entries[0]!.versionId, null, 'an absent provider version id must stay null');
  assert.equal(transport.listInputs[0]!.prefix, 'brain/');
  assert.equal(transport.listInputs[1]!.keyMarker, 'brain/a.bin');
  assert.equal(transport.listInputs[1]!.versionIdMarker, 'dm-1');

  const head = await reader.headVersion({ key: 'brain/a.bin', versionId: 'dm-1' });
  assert.deepEqual(head, { etag: '"e1"', sizeBytes: '3', versionId: 'dm-1' });
  assert.equal(await reader.headVersion({ key: 'brain/missing.bin', versionId: 'v-x' }), null);

  close();
  assert.deepEqual([...new Set(transport.ops)].sort(), ['destroy', 'head', 'list']);
});

test('s3 adapter: provider integrity violations and unsafe configuration fail closed', async () => {
  const escaped = new FakeTransport([
    { Versions: [{ Key: 'outside/x.bin', VersionId: 'v1', IsLatest: true, ETag: '"e"', Size: 1 }], IsTruncated: false },
  ]);
  const escapedReader = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: escaped }).reader;
  await assert.rejects(escapedReader.listHistory(null), (error: unknown) =>
    error instanceof LegacyInventoryS3Error && error.reason === 'prefix-escape');

  const truncated = new FakeTransport([
    { Versions: [{ Key: 'brain/x.bin', VersionId: 'v1', IsLatest: true, ETag: '"e"', Size: 1 }], IsTruncated: true },
  ]);
  const truncatedReader = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: truncated }).reader;
  await assert.rejects(truncatedReader.listHistory(null), (error: unknown) =>
    error instanceof LegacyInventoryS3Error && error.reason === 'truncated-without-key-marker');

  const delimited = new FakeTransport([{ CommonPrefixes: [{}], IsTruncated: false }]);
  const delimitedReader = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: delimited }).reader;
  await assert.rejects(delimitedReader.listHistory(null), (error: unknown) =>
    error instanceof LegacyInventoryS3Error && error.reason === 'unexpected-common-prefixes');

  const sizeless = new FakeTransport([
    { Versions: [{ Key: 'brain/x.bin', VersionId: 'v1', IsLatest: true, ETag: '"e"' }], IsTruncated: false },
  ]);
  const sizelessReader = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: sizeless }).reader;
  await assert.rejects(sizelessReader.listHistory(null), (error: unknown) =>
    error instanceof LegacyInventoryS3Error && error.reason === 'missing-size');

  const wrongNamespace = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: new FakeTransport([]) }).reader;
  await assert.rejects(
    wrongNamespace.listHistory(encodeLegacyS3Cursor({
      namespaceFingerprint: `sha256:${'c'.repeat(64)}`,
      keyMarker: 'brain/a',
      versionMarker: '',
    })),
    (error: unknown) => error instanceof LegacyInventoryS3Error && error.reason === 'cursor-namespace-mismatch',
  );

  assert.throws(
    () => createLegacyObjectHistoryReader({ ...ADAPTER_CONFIG, region: '' }, {}, { transport: new FakeTransport([]) }),
    (error: unknown) => error instanceof LegacyInventoryS3Error && error.reason === 'missing-region',
  );
  assert.throws(
    () => createLegacyObjectHistoryReader({ ...ADAPTER_CONFIG, region: 'auto' }, {}, { transport: new FakeTransport([]) }),
    (error: unknown) => (error as { name?: string }).name === 'S3NetworkPolicyError',
  );
  assert.throws(
    () => createLegacyObjectHistoryReader({ ...ADAPTER_CONFIG, prefix: '/bad/' }, {}, { transport: new FakeTransport([]) }),
    (error: unknown) => error instanceof RosterError && error.code === 'LEGACY_INVENTORY_INPUT_INVALID',
  );

  const noTruncationFlag = new FakeTransport([
    { Versions: [{ Key: 'brain/x.bin', VersionId: 'v1', IsLatest: true, ETag: '"e"', Size: 1 }] },
  ]);
  const noTruncationReader = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: noTruncationFlag }).reader;
  await assert.rejects(noTruncationReader.listHistory(null), (error: unknown) =>
    error instanceof LegacyInventoryS3Error && error.reason === 'malformed-page');

  const escapedMarker = new FakeTransport([
    {
      Versions: [{ Key: 'brain/x.bin', VersionId: 'v1', IsLatest: true, ETag: '"e"', Size: 1 }],
      IsTruncated: true,
      NextKeyMarker: 'outside/x.bin',
    },
  ]);
  const escapedMarkerReader = createLegacyObjectHistoryReader(ADAPTER_CONFIG, {}, { transport: escapedMarker }).reader;
  await assert.rejects(escapedMarkerReader.listHistory(null), (error: unknown) =>
    error instanceof LegacyInventoryS3Error && error.reason === 'prefix-escape');
});

test('cursor decoding rejects oversized or control-character markers', () => {
  const namespace = FIXTURE.expected.namespace_fingerprint;
  assert.ok(decodeLegacyS3Cursor(encodeLegacyS3Cursor({
    namespaceFingerprint: namespace,
    keyMarker: 'brain/a',
    versionMarker: '',
  })) !== null);
  assert.equal(decodeLegacyS3Cursor(encodeLegacyS3Cursor({
    namespaceFingerprint: namespace,
    keyMarker: '',
    versionMarker: '',
  })), null);
  assert.equal(decodeLegacyS3Cursor(encodeLegacyS3Cursor({
    namespaceFingerprint: namespace,
    keyMarker: 'a'.repeat(1_025),
    versionMarker: '',
  })), null);
  assert.equal(decodeLegacyS3Cursor(encodeLegacyS3Cursor({
    namespaceFingerprint: namespace,
    keyMarker: 'brain/a\u0007b',
    versionMarker: '',
  })), null);
  assert.equal(decodeLegacyS3Cursor(encodeLegacyS3Cursor({
    namespaceFingerprint: namespace,
    keyMarker: 'brain/a',
    versionMarker: 'v'.repeat(1_025),
  })), null);
});

test('connection affinity defense-in-depth: a session whose backend pid drifts is aborted with a rollback', async () => {
  const pooled = buildScenario({ poolMode: true });
  const result = expectIncomplete(await inventoryLegacyBrain(pooled.input));
  assert.ok(hasCode(result, 'connection-affinity'));
  assert.equal(pooled.reader.listCalls.length, 0, 'S3 must never be touched after an affinity failure');
  assert.equal(pooled.db.statements[pooled.db.statements.length - 1], 'ROLLBACK');
  for (const statement of pooled.db.statements) {
    assert.ok(!statement.includes('FROM "brain"'), 'no company-table read on a non-affine session');
  }
});

test('namespace binding: a reader whose canonical fingerprint differs from the expected one is refused first', async () => {
  const mismatch = buildScenario({ readerFingerprint: `sha256:${'d'.repeat(64)}` });
  const result = expectIncomplete(await inventoryLegacyBrain(mismatch.input));
  assert.deepEqual(result.findings[0], {
    code: 'identity-mismatch',
    resource_kind: 'database',
    resource_ref: 'object-namespace',
    detail_ref: 'namespace-fingerprint',
  });
  assert.equal(mismatch.db.statements.length, 0, 'no database statement before the namespace gate');
  assert.equal(mismatch.reader.listCalls.length, 0, 'no S3 listing before the namespace gate');
  assert.equal(mismatch.reader.headCalls.length, 0);
});

test('redaction: spoofed timestamps and object ids are tokenized, never emitted raw', async () => {
  const spoofed = buildScenario({
    patchRelations: (relations) => {
      const entities = relations.find((entry) => entry.schema === 'brain' && entry.name === 'entities')!;
      entities.rows![0]!.recorded_at = 'CANARY_TS_INJECTION 12:00';
      const objects = relations.find((entry) => entry.schema === 'brain' && entry.name === 'source_objects')!;
      objects.rows!.push({
        object_id: 'CANARY_OBJECT_ID sneaky',
        sha256: 'CANARY_OBJECT_ID sneaky',
        object_key: 'objects/dd/dd00000000000000000000000000000000000000000000000000000000000000',
        size_bytes: '999',
        etag: '"etagZZ"',
        s3_version_id: null,
        created_at: '2025-06-07 09:30:00+00',
      });
    },
  });
  const result = expectComplete(await inventoryLegacyBrain(spoofed.input));
  const rendered = result.manifestBytes.toString('utf8');
  assert.ok(!rendered.includes('CANARY_TS_INJECTION'), 'spoofed timestamp must be tokenized');
  assert.ok(!rendered.includes('CANARY_OBJECT_ID'), 'spoofed object id must be tokenized');
  assert.ok(!JSON.stringify(result.report).includes('CANARY_OBJECT_ID'), 'findings must reference the tokenized row id');
  const manifest = result.manifest as Record<string, any>;
  const relations = manifest.postgres.relations as Record<string, any>[];
  const entities = relations.find((entry) => entry.name === 'entities')!;
  assert.equal(entities.rows[0].recorded_at, legacyInventoryToken('stable-id', 'CANARY_TS_INJECTION 12:00'));
  const spoofedRef = `brain.source_objects/${legacyInventoryToken('stable-id', 'CANARY_OBJECT_ID sneaky')}`;
  assert.ok(
    result.report.findings.some((entry) => entry.code === 'missing-bytes' && entry.resource_ref === spoofedRef),
    'the spoofed row surfaces through its tokenized reference',
  );
});

test('redaction: provider error names and reasons map to the closed detail allowlist', async () => {
  const scenario = buildScenario({
    failAtListCall: 1,
    failWith: Object.assign(new Error('CANARY_PASSWORD_9 leak attempt'), {
      reason: 'CANARY_REASON_INJECTION',
      name: 'CANARY_NAME_INJECTION',
    }),
  });
  const result = expectIncomplete(await inventoryLegacyBrain(scenario.input));
  const failure = result.findings.find((entry) => entry.code === 'provider-error');
  assert.ok(failure, 'provider failure must surface as a finding');
  assert.equal(failure!.detail_ref, 'provider-error');
  assertNoCanaries([JSON.stringify(result)], 'provider error wrapping');

  const hostileName = buildScenario({
    failAtListCall: 1,
    failWith: Object.assign(new Error('CANARY_PASSWORD_9 via name'), { name: 'CANARY_NAME_ONLY_INJECTION' }),
  });
  const hostileNameResult = expectIncomplete(await inventoryLegacyBrain(hostileName.input));
  const nameFailure = hostileNameResult.findings.find((entry) => entry.code === 'provider-error');
  assert.ok(nameFailure, 'a hostile Error.name must still surface as a wrapped finding');
  assert.equal(nameFailure!.detail_ref, 'provider-error', 'a non-allowlisted Error.name must never pass through');
  assertNoCanaries([JSON.stringify(hostileNameResult)], 'hostile Error.name wrapping');
});

test('session structure: the inventory acquires exactly one session and releases it on every path', async () => {
  const scenario = buildScenario();
  expectComplete(await inventoryLegacyBrain(scenario.input));
  assert.equal(scenario.db.sessions.length, 1, 'connect() must be called exactly once');
  const session = scenario.db.sessions[0]!;
  assert.equal(session.statements.length, scenario.db.statements.length, 'every statement must land on the one acquired session');
  assert.equal(session.statements[0], SQL_BEGIN);
  assert.equal(session.statements[session.statements.length - 1], 'ROLLBACK');
  assert.equal(session.released, true);

  const mismatch = buildScenario({ identityRows: structuredClone(FIXTURE.variants.mismatched_identity_rows) });
  expectIncomplete(await inventoryLegacyBrain(mismatch.input));
  assert.equal(mismatch.db.sessions.length, 1);
  const failedSession = mismatch.db.sessions[0]!;
  assert.equal(failedSession.released, true, 'release() must run on failure paths');
  assert.equal(failedSession.statements[failedSession.statements.length - 1], 'ROLLBACK');

  let clockCalls = 0;
  const timedOut = buildScenario({
    clock: () => (clockCalls++ === 0 ? 0 : 10_000_000),
    limits: { maxTransactionMs: 1_000 },
  });
  expectIncomplete(await inventoryLegacyBrain(timedOut.input));
  assert.equal(timedOut.db.sessions.length, 1);
  assert.equal(timedOut.db.sessions[0]!.released, true, 'release() must run even when no statement was issued');
  assert.equal(timedOut.db.sessions[0]!.statements.length, 0);

  const badInput = buildScenario();
  badInput.input.limits = { ...DEFAULT_LIMITS, maxRelations: 0 };
  await assert.rejects(inventoryLegacyBrain(badInput.input), (error: unknown) =>
    error instanceof RosterError && error.code === 'LEGACY_INVENTORY_INPUT_INVALID');
  assert.equal(badInput.db.sessions.length, 0, 'invalid input must be rejected before connect()');
});

test('a clock expiring immediately after BEGIN resolves still rolls back before release', async () => {
  let clockCalls = 0;
  const scenario = buildScenario({
    clock: () => (clockCalls++ < 3 ? 0 : 10_000_000),
    limits: { maxTransactionMs: 1_000 },
  });
  const result = expectIncomplete(await inventoryLegacyBrain(scenario.input));
  assert.ok(hasCode(result, 'time-limit'));
  assert.equal(scenario.db.sessions.length, 1);
  const session = scenario.db.sessions[0]!;
  assert.deepEqual(session.statements, [SQL_BEGIN, 'ROLLBACK'], 'BEGIN must be rolled back before the session is released');
  assert.equal(session.released, true);
});

test('head correlation requires version identity and a comparable ETag', async () => {
  const wrongVersion = buildScenario({
    heads: FIXTURE.heads.map((head) =>
      head.version_id === 'v-lc-1' ? { ...head, respond_version_id: 'v-other' } : { ...head }),
  });
  const wrongVersionResult = expectComplete(await inventoryLegacyBrain(wrongVersion.input));
  const identityDrift = wrongVersionResult.report.findings.find(
    (entry) => entry.code === 'version-drift' && entry.detail_ref === 'head-version-identity',
  );
  assert.ok(identityDrift, 'a HEAD answering with a different version id is drift, never a match');
  const manifest = wrongVersionResult.manifest as Record<string, any>;
  const objects = (manifest.postgres.relations as Record<string, any>[]).find((entry) => entry.name === 'source_objects')!;
  const abRow = (objects.rows as Record<string, any>[]).find(
    (row) => row.object_id === 'sha256:ab00000000000000000000000000000000000000000000000000000000000000',
  )!;
  assert.equal(abRow.correlation.status, 'drift');

  const missingEtag = buildScenario({
    heads: FIXTURE.heads.map((head) =>
      head.version_id === 'v-lc-1' ? { ...head, etag: null } : { ...head }),
  });
  const missingEtagResult = expectComplete(await inventoryLegacyBrain(missingEtag.input));
  const etagDrift = missingEtagResult.report.findings.find(
    (entry) => entry.code === 'etag-drift' && entry.detail_ref === 'head-etag-missing',
  );
  assert.ok(etagDrift, 'a HEAD without an ETag while the database has one is drift, not a match');
});
