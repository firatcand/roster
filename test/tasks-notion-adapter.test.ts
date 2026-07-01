// ROS-149 — NotionAdapter unit tests. Fully mocked HTTP transport (injected
// fetch) so they run in CI with no token and no network. Assert the exact
// Notion request shapes we build and that we decode Notion responses correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotionAdapter, NotionError, NOTION_VERSION, normalizeDataSourceId } from '../src/lib/tasks/adapters/notion.ts';

interface Canned {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Recorded {
  url: string;
  method: string;
  body?: any;
  headers?: Record<string, string>;
}

function harness(...responses: Canned[]) {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`no queued response for ${url}`);
    const payload = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(payload, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  const sleepImpl = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetchImpl, sleepImpl, calls, sleeps };
}

function makeAdapter(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  return new NotionAdapter({
    token: 't',
    dataSourceId: 'collection://ds1',
    statusProp: 'Status',
    assigneeProp: 'Assignee',
    uniqueIdProp: 'Task ID',
    fetchImpl: h.fetchImpl,
    sleepImpl: h.sleepImpl,
    ...over,
  });
}

const PAGE = {
  id: 'p1',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Do' }, { plain_text: ' it' }] },
    Status: { type: 'status', status: { name: 'Ready' } },
    Assignee: { type: 'people', people: [{ id: 'u1' }, { id: 'u2' }] },
    'Task ID': { type: 'unique_id', unique_id: { prefix: 'TASK', number: 12 } },
  },
};

// ── construction / helpers ──────────────────────────────────────────────────

test('normalizeDataSourceId strips collection:// and trims', () => {
  assert.equal(normalizeDataSourceId('collection://39156ca8'), '39156ca8');
  assert.equal(normalizeDataSourceId('  39156ca8  '), '39156ca8');
});

test('constructor throws a clear error when no token is available', () => {
  const prev = process.env['NOTION_TOKEN'];
  delete process.env['NOTION_TOKEN'];
  try {
    assert.throws(() => new NotionAdapter({ dataSourceId: 'x', statusProp: 'S', assigneeProp: 'A' }), /NOTION_TOKEN is not set/);
  } finally {
    if (prev !== undefined) process.env['NOTION_TOKEN'] = prev;
  }
});

test('request sends Bearer auth + Notion-Version header', async () => {
  const h = harness({ body: { type: 'person', id: 'u1' } });
  await makeAdapter(h).self();
  assert.equal(h.calls[0]!.headers!['Authorization'], 'Bearer t');
  assert.equal(h.calls[0]!.headers!['Notion-Version'], NOTION_VERSION);
});

// ── self() ──────────────────────────────────────────────────────────────────

test('self() returns a person token directly', async () => {
  const h = harness({ body: { type: 'person', id: 'u1', name: 'Alice', person: { email: 'a@x.com' } } });
  assert.deepEqual(await makeAdapter(h).self(), { id: 'u1', name: 'Alice', email: 'a@x.com' });
  assert.equal(h.calls[0]!.url, 'https://api.notion.com/v1/users/me');
});

test('self() extracts the human owner from a bot token', async () => {
  const h = harness({
    body: { type: 'bot', id: 'b1', bot: { owner: { type: 'user', user: { id: 'u9', name: 'Bob', person: { email: 'b@x.com' } } } } },
  });
  assert.deepEqual(await makeAdapter(h).self(), { id: 'u9', name: 'Bob', email: 'b@x.com' });
});

test('self() throws when a bot token has no user owner', async () => {
  const h = harness({ body: { type: 'bot', id: 'b2', bot: { owner: { type: 'workspace' } } } });
  await assert.rejects(makeAdapter(h).self(), /workspace-level bot with no user owner/);
});

// ── listReady() ─────────────────────────────────────────────────────────────

test('listReady builds the status-OR + assignee(contains|empty) filter and decodes summaries', async () => {
  const h = harness({ body: { results: [PAGE], has_more: false } });
  const rows = await makeAdapter(h).listReady({ readyStatuses: ['Ready', 'To do'], assigneeId: 'u1' });

  const call = h.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.notion.com/v1/data_sources/ds1/query');
  assert.deepEqual(call.body.filter, {
    and: [
      { or: [
        { property: 'Status', status: { equals: 'Ready' } },
        { property: 'Status', status: { equals: 'To do' } },
      ] },
      { or: [
        { property: 'Assignee', people: { contains: 'u1' } },
        { property: 'Assignee', people: { is_empty: true } },
      ] },
    ],
  });
  assert.deepEqual(rows, [{ id: 'p1', handle: 'TASK-12', title: 'Do it', status: 'Ready', assigneeIds: ['u1', 'u2'] }]);
});

test('listReady omits the assignee clause when no assigneeId is given', async () => {
  const h = harness({ body: { results: [], has_more: false } });
  await makeAdapter(h).listReady({ readyStatuses: ['Ready'] });
  assert.deepEqual(h.calls[0]!.body.filter, { and: [{ or: [{ property: 'Status', status: { equals: 'Ready' } }] }] });
});

test('listReady adds a select-based project clause when configured', async () => {
  const h = harness({ body: { results: [], has_more: false } });
  await makeAdapter(h, { projectProp: 'Project' }).listReady({ readyStatuses: ['Ready'], projectValues: ['Alpha', 'Beta'] });
  const clauses = h.calls[0]!.body.filter.and;
  assert.deepEqual(clauses[clauses.length - 1], {
    or: [
      { property: 'Project', select: { equals: 'Alpha' } },
      { property: 'Project', select: { equals: 'Beta' } },
    ],
  });
});

test('listReady paginates via start_cursor until has_more is false', async () => {
  const h = harness(
    { body: { results: [PAGE], has_more: true, next_cursor: 'c2' } },
    { body: { results: [{ ...PAGE, id: 'p2' }], has_more: false } },
  );
  const rows = await makeAdapter(h).listReady({ readyStatuses: ['Ready'] });
  assert.equal(rows.length, 2);
  assert.equal(h.calls[1]!.body.start_cursor, 'c2');
});

test('listReady stops (no infinite loop) when has_more is true but next_cursor is missing', async () => {
  const h = harness({ body: { results: [PAGE], has_more: true, next_cursor: null } });
  const rows = await makeAdapter(h).listReady({ readyStatuses: ['Ready'] });
  assert.equal(rows.length, 1);
  assert.equal(h.calls.length, 1);
});

test('listReady throws (and makes no request) when readyStatuses is empty', async () => {
  const h = harness();
  await assert.rejects(makeAdapter(h).listReady({ readyStatuses: [] }), /at least one ready status/);
  assert.equal(h.calls.length, 0);
});

test('listReady throws (and makes no request) when projectValues is given without a projectProp', async () => {
  const h = harness();
  await assert.rejects(
    makeAdapter(h).listReady({ readyStatuses: ['Ready'], projectValues: ['Alpha'] }),
    /no projectProp is configured/,
  );
  assert.equal(h.calls.length, 0);
});

// ── getTask() ───────────────────────────────────────────────────────────────

test('getTask resolves a TASK-<n> handle via a unique_id equals filter', async () => {
  const h = harness({ body: { results: [PAGE], has_more: false } });
  const task = await makeAdapter(h).getTask('TASK-12');
  assert.deepEqual(h.calls[0]!.body.filter, { property: 'Task ID', unique_id: { equals: 12 } });
  assert.equal(task.id, 'p1');
  assert.equal(task.handle, 'TASK-12');
  assert.ok(task.props);
});

test('getTask throws 404 when a handle matches nothing', async () => {
  const h = harness({ body: { results: [], has_more: false } });
  await assert.rejects(makeAdapter(h).getTask('TASK-99'), (e: unknown) => e instanceof NotionError && (e as NotionError).status === 404);
});

test('getTask throws 409 when a handle is ambiguous', async () => {
  const h = harness({ body: { results: [PAGE, { ...PAGE, id: 'p2' }], has_more: false } });
  await assert.rejects(makeAdapter(h).getTask('TASK-12'), (e: unknown) => e instanceof NotionError && (e as NotionError).status === 409);
});

test('getTask treats a non-unique-id handle as a page id (GET /v1/pages)', async () => {
  const h = harness({ body: PAGE });
  const task = await makeAdapter(h).getTask('abc123def');
  assert.equal(h.calls[0]!.url, 'https://api.notion.com/v1/pages/abc123def');
  assert.equal(h.calls[0]!.method, 'GET');
  assert.equal(task.id, 'p1');
});

// ── writes ──────────────────────────────────────────────────────────────────

test('setStatus PATCHes the page status property by name', async () => {
  const h = harness({ body: PAGE });
  await makeAdapter(h).setStatus('p1', 'In progress');
  assert.equal(h.calls[0]!.method, 'PATCH');
  assert.equal(h.calls[0]!.url, 'https://api.notion.com/v1/pages/p1');
  assert.deepEqual(h.calls[0]!.body, { properties: { Status: { status: { name: 'In progress' } } } });
});

test('setAssignee PATCHes the people property with the user id', async () => {
  const h = harness({ body: PAGE });
  await makeAdapter(h).setAssignee('p1', 'u7');
  assert.deepEqual(h.calls[0]!.body, { properties: { Assignee: { people: [{ id: 'u7' }] } } });
});

test('setAssignees replaces the full people array; [] clears it', async () => {
  const h = harness({ body: PAGE }, { body: PAGE });
  const a = makeAdapter(h);
  await a.setAssignees('p1', ['a', 'b']);
  assert.deepEqual(h.calls[0]!.body, { properties: { Assignee: { people: [{ id: 'a' }, { id: 'b' }] } } });
  await a.setAssignees('p1', []);
  assert.deepEqual(h.calls[1]!.body, { properties: { Assignee: { people: [] } } });
});

// ── introspectStatuses() ────────────────────────────────────────────────────

test('introspectStatuses maps options to their group category and detects unique_id', async () => {
  const h = harness({
    body: {
      properties: {
        Status: {
          type: 'status',
          status: {
            options: [{ id: 'o1', name: 'Ready' }, { id: 'o2', name: 'Doing' }, { id: 'o3', name: 'Done' }],
            groups: [
              { id: 'g1', name: 'To-do', option_ids: ['o1'] },
              { id: 'g2', name: 'In progress', option_ids: ['o2'] },
              { id: 'g3', name: 'Complete', option_ids: ['o3'] },
            ],
          },
        },
        'Task ID': { type: 'unique_id', unique_id: { prefix: 'TASK' } },
      },
    },
  });
  const schema = await makeAdapter(h).introspectStatuses();
  assert.equal(h.calls[0]!.url, 'https://api.notion.com/v1/data_sources/ds1');
  assert.deepEqual(schema.statuses, [
    { name: 'Ready', category: 'To-do' },
    { name: 'Doing', category: 'In progress' },
    { name: 'Done', category: 'Complete' },
  ]);
  assert.equal(schema.hasUniqueId, true);
  assert.equal(schema.uniqueIdPrefix, 'TASK');
});

test('introspectStatuses reports hasUniqueId=false when the board has no unique_id column', async () => {
  const h = harness({
    body: { properties: { Status: { type: 'status', status: { options: [], groups: [] } } } },
  });
  const schema = await makeAdapter(h).introspectStatuses();
  assert.equal(schema.hasUniqueId, false);
  assert.equal(schema.uniqueIdPrefix, undefined);
});

test('introspectStatuses throws when the configured status prop is not a status type', async () => {
  const h = harness({ body: { properties: { Status: { type: 'select', select: {} } } } });
  await assert.rejects(makeAdapter(h).introspectStatuses(), /not a Notion status property/);
});

// ── retry / errors ──────────────────────────────────────────────────────────

test('request retries on 429 honoring Retry-After, then succeeds', async () => {
  const h = harness(
    { status: 429, headers: { 'retry-after': '0' } },
    { body: { type: 'person', id: 'u1' } },
  );
  const id = (await makeAdapter(h).self()).id;
  assert.equal(id, 'u1');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [0]);
});

test('request throws NotionError 429 after retries are exhausted', async () => {
  const h = harness(
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 429, headers: { 'retry-after': '0' } },
  );
  await assert.rejects(
    makeAdapter(h, { maxRetries: 1 }).self(),
    (e: unknown) => e instanceof NotionError && (e as NotionError).status === 429,
  );
});

test('request maps 401 to a helpful auth message', async () => {
  const h = harness({ status: 401, body: { message: 'unauthorized' } });
  await assert.rejects(makeAdapter(h).self(), /Notion auth failed \(401\)/);
});

test('request surfaces a malformed/invalid Notion response as a Zod parse error', async () => {
  const h = harness({ body: { unexpected: true } });
  await assert.rejects(makeAdapter(h).self());
});

// ── describeBoard() + unconfigured guards (ROS-150) ──────────────────────────

const BOARD = {
  properties: {
    Name: { type: 'title' },
    Status: {
      type: 'status',
      status: {
        options: [{ id: 'o1', name: 'To do' }, { id: 'o2', name: 'Done' }],
        groups: [{ id: 'g1', name: 'To-do', option_ids: ['o1'] }, { id: 'g2', name: 'Complete', option_ids: ['o2'] }],
      },
    },
    Owner: { type: 'people' },
    'Task ID': { type: 'unique_id', unique_id: { prefix: 'TASK' } },
  },
};

test('describeBoard classifies status, people, and unique_id properties', async () => {
  const h = harness({ body: BOARD });
  const board = await makeAdapter(h).describeBoard();
  assert.equal(h.calls[0]!.url, 'https://api.notion.com/v1/data_sources/ds1');
  assert.deepEqual(board.statusProperties.map((s) => s.name), ['Status']);
  assert.deepEqual(board.statusProperties[0]!.options, [
    { name: 'To do', category: 'To-do' },
    { name: 'Done', category: 'Complete' },
  ]);
  assert.deepEqual(board.assigneeProperties, ['Owner']);
  assert.deepEqual(board.uniqueId, { property: 'Task ID', prefix: 'TASK' });
});

test('describeBoard works on an adapter with no status/assignee configured', async () => {
  const h = harness({ body: BOARD });
  const adapter = new NotionAdapter({ token: 't', dataSourceId: 'collection://ds1', fetchImpl: h.fetchImpl });
  const board = await adapter.describeBoard();
  assert.equal(board.statusProperties.length, 1);
});

test('unconfigured adapter throws a clear error on configured-only operations', async () => {
  const h = harness();
  const adapter = new NotionAdapter({ token: 't', dataSourceId: 'ds1', fetchImpl: h.fetchImpl });
  await assert.rejects(adapter.listReady({ readyStatuses: ['To do'] }), /no status property configured/);
  await assert.rejects(adapter.getTask('TASK-1'), /no status property configured/);
  await assert.rejects(adapter.setStatus('p1', 'Done'), /no status property configured/);
  await assert.rejects(adapter.setAssignee('p1', 'u1'), /no assignee property configured/);
  assert.equal(h.calls.length, 0);
});
