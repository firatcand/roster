import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const FIXTURE_ROOT = join(process.cwd(), 'test/fixtures/host-led-learning');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), 'utf8')) as unknown;
}

test('accepted search result has no array, lexical, or Brain-suffix shortcut', () => {
  const corpus = readJson('common/fake-search-results.json') as {
    results: Array<{ result_id: string }>;
  };
  const oracle = readJson('../host-led-learning-oracle/expected-semantic-result.json') as Record<
    string,
    { turns: Record<string, { selected_results?: Array<{ result_id: string }> }> }
  >;
  const brain = readJson('common/brain-evidence.json') as {
    candidates: Array<{ candidate_id: string }>;
  };
  // Every scenario's shortlist-bearing turn must select the same result: the
  // recovery path changes when the work is recorded, never what was chosen.
  const shortlists = [
    oracle['standard']!.turns['discover']!.selected_results,
    oracle['recovery']!.turns['record-only']!.selected_results,
  ];
  for (const shortlist of shortlists) assert.deepEqual(shortlist?.map((entry) => entry.result_id), ['result-c77f']);
  const selectedIds = shortlists[0]!.map((entry) => entry.result_id);

  const selectedId = selectedIds[0]!;
  const corpusIds = corpus.results.map((entry) => entry.result_id);
  const arrayIndex = corpusIds.indexOf(selectedId);
  assert.ok(arrayIndex > 0 && arrayIndex < corpusIds.length - 1);

  const lexicalIds = [...corpusIds].sort();
  const lexicalIndex = lexicalIds.indexOf(selectedId);
  assert.ok(lexicalIndex > 0 && lexicalIndex < lexicalIds.length - 1);

  const selectedSuffix = selectedId.replace(/^result-/u, '');
  const brainSuffixes = brain.candidates.map((entry) => (
    entry.candidate_id.replace(/^brain-record-/u, '')
  ));
  assert.equal(brainSuffixes.includes(selectedSuffix), false);
});
