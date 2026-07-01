// ROS-150 — `roster task` dispatch + arg validation. Only exercises paths that
// throw BEFORE any Notion network call (no token / no adapter construction).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTask } from '../src/commands/task.ts';
import { RosterError } from '../src/lib/errors.ts';

test('runTask: unknown / missing subcommand throws', async () => {
  await assert.rejects(runTask(['bogus']), (e: unknown) => e instanceof RosterError && /unknown task subcommand/.test((e as RosterError).header));
  await assert.rejects(runTask([]), (e: unknown) => e instanceof RosterError && /unknown task subcommand/.test((e as RosterError).header));
});

test('runTask setup: missing --data-source throws a usage error', async () => {
  await assert.rejects(runTask(['setup']), (e: unknown) => e instanceof RosterError && /--data-source is required/.test((e as RosterError).header));
});

test('runTask setup: bad --map is rejected before any network call', async () => {
  await assert.rejects(
    runTask(['setup', '--data-source', 'ds1', '--map', 'bogus=Foo']),
    (e: unknown) => e instanceof RosterError && /not a canonical state/.test((e as RosterError).header),
  );
  await assert.rejects(
    runTask(['setup', '--data-source', 'ds1', '--map', 'noequals']),
    (e: unknown) => e instanceof RosterError && /bad --map segment/.test((e as RosterError).header),
  );
  await assert.rejects(
    runTask(['setup', '--data-source', 'ds1', '--map', 'ready=']),
    (e: unknown) => e instanceof RosterError && /empty status name/.test((e as RosterError).header),
  );
});
