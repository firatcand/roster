// ROS-150 — tracker.yaml schema validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTrackerConfig,
  crossCheckStatusMap,
  TrackerConfigError,
  TRACKER_YAML_VERSION,
} from '../src/lib/tasks/tracker-schema.ts';

const valid = {
  version: TRACKER_YAML_VERSION,
  tracker: 'notion',
  data_source_id: 'abc123',
  status_property: 'Status',
  assignee_property: 'Assignee',
  unique_id_property: 'Task ID',
  status_map: { ready: 'To do', active: 'In progress', done: 'Done' },
};

test('parseTrackerConfig accepts a valid config', () => {
  const cfg = parseTrackerConfig(valid);
  assert.equal(cfg.tracker, 'notion');
  assert.equal(cfg.status_map.ready, 'To do');
});

test('parseTrackerConfig rejects a missing required status (done)', () => {
  const bad = { ...valid, status_map: { ready: 'To do', active: 'In progress' } };
  assert.throws(() => parseTrackerConfig(bad), (e: unknown) => e instanceof TrackerConfigError && (e as TrackerConfigError).issues.some((i) => i.path.includes('done')));
});

test('parseTrackerConfig rejects unknown status_map keys (strict)', () => {
  const bad = { ...valid, status_map: { ...valid.status_map, bogus: 'X' } };
  assert.throws(() => parseTrackerConfig(bad), TrackerConfigError);
});

test('parseTrackerConfig rejects unknown top-level keys (strict)', () => {
  const bad = { ...valid, surprise: true };
  assert.throws(() => parseTrackerConfig(bad), TrackerConfigError);
});

test('parseTrackerConfig rejects a wrong version', () => {
  assert.throws(() => parseTrackerConfig({ ...valid, version: 99 }), TrackerConfigError);
});

test('parseTrackerConfig rejects a project_filter without a project_property', () => {
  assert.throws(
    () => parseTrackerConfig({ ...valid, project_filter: ['Alpha'] }),
    (e: unknown) => e instanceof TrackerConfigError && (e as TrackerConfigError).issues.some((i) => /project_filter/.test(i.path) || /requires project_property/.test(i.message)),
  );
});

test('parseTrackerConfig accepts a project_filter paired with a project_property', () => {
  const cfg = parseTrackerConfig({ ...valid, project_property: 'Project', project_filter: ['Alpha'] });
  assert.deepEqual(cfg.project_filter, ['Alpha']);
  assert.equal(cfg.project_property, 'Project');
});

test('parseTrackerConfig round-trips unique_id_prefix', () => {
  const cfg = parseTrackerConfig({ ...valid, unique_id_prefix: 'TASK' });
  assert.equal(cfg.unique_id_prefix, 'TASK');
});

test('crossCheckStatusMap passes when every mapped name is a distinct board option', () => {
  const cfg = parseTrackerConfig(valid);
  assert.doesNotThrow(() => crossCheckStatusMap(cfg.status_map, ['To do', 'In progress', 'Done', 'Blocked']));
});

test('crossCheckStatusMap flags a mapped name that is not a board option', () => {
  const cfg = parseTrackerConfig({ ...valid, status_map: { ready: 'To do', active: 'Doing', done: 'Done' } });
  assert.throws(
    () => crossCheckStatusMap(cfg.status_map, ['To do', 'In progress', 'Done']),
    (e: unknown) => e instanceof TrackerConfigError && (e as TrackerConfigError).issues.some((i) => i.message.includes('Doing')),
  );
});

test('crossCheckStatusMap flags one board status mapped to two canonical states', () => {
  const cfg = parseTrackerConfig({ ...valid, status_map: { ready: 'To do', active: 'To do', done: 'Done' } });
  assert.throws(
    () => crossCheckStatusMap(cfg.status_map, ['To do', 'In progress', 'Done']),
    (e: unknown) => e instanceof TrackerConfigError && (e as TrackerConfigError).issues.some((i) => /multiple canonical states/.test(i.message)),
  );
});
