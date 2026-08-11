import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(PROJECT_ROOT, 'data/brain/schema');

// The migration ledger is an exact ordered PREFIX (migrate-core.ts): a gap makes
// every later migration unreachable and throws at load. Two branches that each
// claim the next free prefix produce that gap at merge, so the rename-at-merge
// rule needs a guard that fails loudly in CI rather than at a user's bootstrap.
test('brain migration prefixes are exactly 1..N with no gap and no duplicate', () => {
  const files = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.length > 0, 'no brain migrations found');
  const prefixes: number[] = [];
  for (const name of files) {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/u.exec(name);
    assert.notEqual(match, null, `migration '${name}' does not match NNN_snake_case.sql`);
    prefixes.push(Number(match![1]));
  }
  const sorted = [...prefixes].sort((a, b) => a - b);
  assert.deepEqual(
    sorted,
    Array.from({ length: files.length }, (_, index) => index + 1),
    `brain migration prefixes are not contiguous 1..${files.length}: ${files.join(', ')}`,
  );
  assert.equal(new Set(prefixes).size, prefixes.length, 'duplicate migration prefix');
});
