// ROS-149 — NotionAdapter LIVE integration test. Double-gated: it is skipped
// unless BOTH ROSTER_NOTION_LIVE=1 and NOTION_TOKEN are set, so `pnpm test`
// (which globs this file) never touches the network or mutates a board in CI or
// on an ordinary local run. Any write is read-first then restored in a finally.
//
//   ROSTER_NOTION_LIVE=1 NOTION_TOKEN=<PAT> \
//     [NOTION_TASKS_DS=collection://...] [NOTION_STATUS_PROP=Status] \
//     [NOTION_ASSIGNEE_PROP=Assignee] [NOTION_UNIQUE_ID_PROP='Task ID'] \
//     [NOTION_LIVE_TASK=<page-id|HANDLE>] \
//     node --test --experimental-strip-types test/tasks-notion-live.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotionAdapter } from '../src/lib/tasks/adapters/notion.ts';

const LIVE = process.env['ROSTER_NOTION_LIVE'] === '1' && !!process.env['NOTION_TOKEN'];
const skip = !LIVE;

const DS = process.env['NOTION_TASKS_DS'] ?? 'collection://39156ca8-1f44-8379-af0f-8771bc20e4f4';
const statusProp = process.env['NOTION_STATUS_PROP'] ?? 'Status';
const assigneeProp = process.env['NOTION_ASSIGNEE_PROP'] ?? 'Assignee';
const uniqueIdProp = process.env['NOTION_UNIQUE_ID_PROP'];

function adapter() {
  return new NotionAdapter({ dataSourceId: DS, statusProp, assigneeProp, uniqueIdProp });
}

test('live: self() resolves the token owner', { skip }, async () => {
  const me = await adapter().self();
  assert.ok(me.id, 'self() returns a user id');
});

test('live: introspectStatuses returns board status options', { skip }, async () => {
  const schema = await adapter().introspectStatuses();
  assert.ok(schema.statuses.length > 0, 'board exposes status options');
});

test('live: listReady reads without error', { skip }, async () => {
  const a = adapter();
  const me = await a.self();
  const schema = await a.introspectStatuses();
  const ready = schema.statuses.map((s) => s.name);
  const rows = await a.listReady({ readyStatuses: ready, assigneeId: me.id });
  assert.ok(Array.isArray(rows), 'listReady returns an array');
});

// Mutating round-trip only runs when an explicit throwaway task is named.
test('live: setStatus round-trips and restores', { skip: skip || !process.env['NOTION_LIVE_TASK'] }, async () => {
  const a = adapter();
  const handle = process.env['NOTION_LIVE_TASK']!;
  const before = await a.getTask(handle);
  const schema = await a.introspectStatuses();
  const other = schema.statuses.find((s) => s.name !== before.status);
  assert.ok(other, 'need at least two status options to round-trip');
  try {
    await a.setStatus(before.id, other!.name);
    const mid = await a.getTask(handle);
    assert.equal(mid.status, other!.name);
  } finally {
    await a.setStatus(before.id, before.status);
  }
});

test('live: setAssignee round-trips and restores', { skip: skip || !process.env['NOTION_LIVE_TASK'] }, async () => {
  const a = adapter();
  const handle = process.env['NOTION_LIVE_TASK']!;
  const me = await a.self();
  const before = await a.getTask(handle);
  try {
    await a.setAssignee(before.id, me.id);
    const mid = await a.getTask(handle);
    assert.ok(mid.assigneeIds.includes(me.id));
  } finally {
    // Exact restore of the full prior set — including [] (unassigned) and any
    // co-assignees that a single setAssignee would have dropped.
    await a.setAssignees(before.id, before.assigneeIds);
  }
});
