import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScaffoldArgs } from '../src/lib/scaffold-args.ts';
import { parseDiscoverArgs } from '../src/lib/discover-args.ts';
import { parseValidateArgs } from '../src/lib/validate-args.ts';

test('scaffold parser enforces kind-specific scope and normalizes aliases', () => {
  assert.deepEqual(parseScaffoldArgs(['function', 'gtm', '--purpose', 'Go to market', '--json']), {
    kind: 'ok', recordKind: 'function', id: 'gtm', purpose: 'Go to market', json: true,
  });
  assert.deepEqual(parseScaffoldArgs(['agent', 'social', '--function', 'gtm']), {
    kind: 'ok', recordKind: 'agent', id: 'social', scope: 'function:gtm', purpose: '', json: false,
  });
  assert.equal(parseScaffoldArgs(['plan', 'discover', '--scope', 'function:gtm']).kind, 'err');
  assert.equal(parseScaffoldArgs(['function', 'GTm']).kind, 'err');
  for (const scope of [
    'workspace',
    'function:gtm',
    'agent:gtm/social',
    'plan:gtm/social#discover',
  ]) {
    assert.equal(parseScaffoldArgs(['tool-use', 'search', '--scope', scope]).kind, 'ok', scope);
  }
  assert.equal(parseScaffoldArgs(['tool-use', 'search']).kind, 'err');
  assert.equal(parseScaffoldArgs(['tool-use', 'search', '--scope', 'workspace:gtm']).kind, 'err');
  assert.equal(parseScaffoldArgs(['agent', 'social', '--function', 'tools']).kind, 'err');
});

test('discover and validate parsers remain command-local and bounded', () => {
  assert.deepEqual(parseDiscoverArgs(['social', '--kind', 'agent', '--scope', 'function:gtm', '--exact', '--json']), {
    kind: 'ok', query: 'social', recordKind: 'agent', scope: 'function:gtm', exact: true, full: false, json: true,
  });
  assert.equal(parseDiscoverArgs(['--exact']).kind, 'err');
  assert.equal(parseDiscoverArgs(['one', 'two']).kind, 'err');
  assert.deepEqual(parseDiscoverArgs(['--scope', 'workspace']), {
    kind: 'ok', scope: 'workspace', exact: false, full: false, json: false,
  });
  assert.equal(parseDiscoverArgs(['--scope', 'workspace:gtm']).kind, 'err');
  assert.deepEqual(parseValidateArgs(['gtm/social', '--json']), { kind: 'ok', target: 'gtm/social', json: true });
  assert.equal(parseValidateArgs(['one', 'two']).kind, 'err');
});
