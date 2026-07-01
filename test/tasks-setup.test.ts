// ROS-150 — proposeStatusMap heuristic + runTaskSetup orchestration.
// Board fetch is mocked (injected fetch); writes go to a real tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { proposeStatusMap, runTaskSetup } from '../src/lib/tasks/setup.ts';
import { parseTrackerConfig } from '../src/lib/tasks/tracker-schema.ts';
import { RosterError } from '../src/lib/errors.ts';
import type { StatusOption } from '../src/lib/tasks/adapters/types.ts';

const GROUPED: StatusOption[] = [
  { name: 'To do', category: 'To-do' },
  { name: 'In progress', category: 'In progress' },
  { name: 'Done', category: 'Complete' },
];

function board(over: Record<string, unknown> = {}): unknown {
  return {
    properties: {
      Name: { type: 'title' },
      Status: {
        type: 'status',
        status: {
          options: [
            { id: 'o1', name: 'To do' },
            { id: 'o2', name: 'In progress' },
            { id: 'o3', name: 'Done' },
          ],
          groups: [
            { id: 'g1', name: 'To-do', option_ids: ['o1'] },
            { id: 'g2', name: 'In progress', option_ids: ['o2'] },
            { id: 'g3', name: 'Complete', option_ids: ['o3'] },
          ],
        },
      },
      Assignee: { type: 'people' },
      'Task ID': { type: 'unique_id', unique_id: { prefix: 'TASK' } },
      ...over,
    },
  };
}

function fetchOf(payload: unknown) {
  return async (_url: string, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-setup-'));
  return fn(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

// ── proposeStatusMap ────────────────────────────────────────────────────────

test('proposeStatusMap maps required states from Notion groups', () => {
  const { map, unresolvedRequired } = proposeStatusMap(GROUPED);
  assert.deepEqual(map, { ready: 'To do', active: 'In progress', done: 'Done' });
  assert.deepEqual(unresolvedRequired, []);
});

test('proposeStatusMap falls back to name matches and never double-assigns a status', () => {
  const { map } = proposeStatusMap([
    { name: 'Backlog' },
    { name: 'Doing' },
    { name: 'Shipped' },
    { name: 'In review' },
  ]);
  assert.equal(map.active, 'Doing');
  assert.equal(map.done, 'Shipped');
  assert.equal(map.backlog, 'Backlog');
  assert.equal(map.review, 'In review');
  // 'Backlog' went to backlog, not ready — so ready stays unresolved here.
  assert.equal(map.ready, undefined);
  const values = Object.values(map);
  assert.equal(new Set(values).size, values.length, 'no status assigned to two canonical states');
});

test('proposeStatusMap does not grab a Backlog status for ready via a shared To-do group', () => {
  const { map } = proposeStatusMap([
    { name: 'Backlog', category: 'To-do' },
    { name: 'Ready', category: 'To-do' },
    { name: 'In progress', category: 'In progress' },
    { name: 'Done', category: 'Complete' },
  ]);
  assert.equal(map.ready, 'Ready');
  assert.equal(map.backlog, 'Backlog');
});

test('proposeStatusMap reports unresolved required states', () => {
  const { unresolvedRequired } = proposeStatusMap([{ name: 'Foo' }, { name: 'Bar' }]);
  assert.ok(unresolvedRequired.includes('ready'));
  assert.ok(unresolvedRequired.includes('active'));
  assert.ok(unresolvedRequired.includes('done'));
});

// ── runTaskSetup ────────────────────────────────────────────────────────────

test('runTaskSetup preview does not write and resolves all required states', async () => {
  await withCwd(async (cwd) => {
    const res = await runTaskSetup({ cwd, dataSourceId: 'collection://ds1', token: 't', write: false, fetchImpl: fetchOf(board()) });
    assert.equal(res.written, false);
    assert.equal(existsSync(join(cwd, 'roster', 'tracker.yaml')), false);
    assert.deepEqual(res.config.status_map, { ready: 'To do', active: 'In progress', done: 'Done' });
    assert.equal(res.config.data_source_id, 'ds1');
    assert.equal(res.warnings.length, 0);
  });
});

test('runTaskSetup --yes writes a valid tracker.yaml (idempotent re-parse)', async () => {
  await withCwd(async (cwd) => {
    const res = await runTaskSetup({ cwd, dataSourceId: 'collection://ds1', token: 't', write: true, fetchImpl: fetchOf(board()) });
    assert.equal(res.written, true);
    const path = join(cwd, 'roster', 'tracker.yaml');
    assert.ok(existsSync(path));
    const parsed = parseTrackerConfig(YAML.parse(readFileSync(path, 'utf8')));
    assert.equal(parsed.status_property, 'Status');
    assert.equal(parsed.assignee_property, 'Assignee');
    assert.equal(parsed.unique_id_property, 'Task ID');
    assert.equal(parsed.status_map.done, 'Done');
  });
});

test('runTaskSetup --yes refuses to write when a required state is unmapped', async () => {
  await withCwd(async (cwd) => {
    // Board whose statuses match none of active's patterns.
    const b = board({ Status: { type: 'status', status: { options: [{ id: 'o1', name: 'To do' }, { id: 'o3', name: 'Done' }], groups: [] } } });
    await assert.rejects(
      runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: true, fetchImpl: fetchOf(b) }),
      (e: unknown) => e instanceof RosterError && /required states unmapped/.test((e as RosterError).header),
    );
    assert.equal(existsSync(join(cwd, 'roster', 'tracker.yaml')), false);
  });
});

test('runTaskSetup --map override fills an unresolved required state and writes', async () => {
  await withCwd(async (cwd) => {
    const b = board({ Status: { type: 'status', status: { options: [{ id: 'o1', name: 'To do' }, { id: 'o2', name: 'Cooking' }, { id: 'o3', name: 'Done' }], groups: [] } } });
    const res = await runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: true, overrides: { active: 'Cooking' }, fetchImpl: fetchOf(b) });
    assert.equal(res.written, true);
    assert.equal(res.config.status_map.active, 'Cooking');
  });
});

test('runTaskSetup rejects an override naming a status not on the board', async () => {
  await withCwd(async (cwd) => {
    await assert.rejects(
      runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: true, overrides: { done: 'Nonexistent' }, fetchImpl: fetchOf(board()) }),
      (e: unknown) => e instanceof RosterError && /invalid/.test((e as RosterError).header),
    );
  });
});

test('runTaskSetup errors on multiple status properties without --status-property', async () => {
  await withCwd(async (cwd) => {
    const b = board({ Stage: { type: 'status', status: { options: [], groups: [] } } });
    await assert.rejects(
      runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: false, fetchImpl: fetchOf(b) }),
      (e: unknown) => e instanceof RosterError && /multiple status/.test((e as RosterError).header),
    );
  });
});

test('runTaskSetup rejects a --map that assigns one status to two states (--yes)', async () => {
  await withCwd(async (cwd) => {
    await assert.rejects(
      runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: true, overrides: { active: 'Done' }, fetchImpl: fetchOf(board()) }),
      (e: unknown) => e instanceof RosterError && /invalid/.test((e as RosterError).header),
    );
    assert.equal(existsSync(join(cwd, 'roster', 'tracker.yaml')), false);
  });
});

test('runTaskSetup preview rejects an invalid --map even when a required state is unmapped', async () => {
  await withCwd(async (cwd) => {
    const b = board({ Status: { type: 'status', status: { options: [{ id: 'o1', name: 'To do' }, { id: 'o3', name: 'Done' }], groups: [] } } });
    await assert.rejects(
      runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: false, overrides: { done: 'Nonexistent' }, fetchImpl: fetchOf(b) }),
      (e: unknown) => e instanceof RosterError && /invalid/.test((e as RosterError).header),
    );
  });
});

test('runTaskSetup warns when the board has no unique-id property', async () => {
  await withCwd(async (cwd) => {
    const b = board({ 'Task ID': undefined });
    const res = await runTaskSetup({ cwd, dataSourceId: 'ds1', token: 't', write: false, fetchImpl: fetchOf(b) });
    assert.ok(res.warnings.some((w) => /unique-id/.test(w)));
    assert.equal(res.config.unique_id_property, undefined);
  });
});
