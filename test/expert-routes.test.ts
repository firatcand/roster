import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SKILL_EXCEPTIONS,
  KNOWN_FOUNDER_SKILLS,
  parseExpertRoutes,
} from '../src/lib/founder-skills/expert-routes.ts';
import { isSafeSkillName } from '../src/lib/founder-skills/manifest-schema.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_FUNCTIONS = ['gtm', 'product', 'design', 'ops'] as const;

function templateRoutes(fn: string): string[] {
  return parseExpertRoutes(
    readFileSync(join(repoRoot, 'templates', 'scaffold', fn, 'EXPERT.md'), 'utf8'),
  );
}

const covered = new Set([...KNOWN_FOUNDER_SKILLS, ...BUILTIN_SKILL_EXCEPTIONS]);

for (const fn of TEMPLATE_FUNCTIONS) {
  test(`${fn}/EXPERT.md routes resolve to known skills`, () => {
    const routes = templateRoutes(fn);
    assert.ok(routes.length >= 1, `${fn}: parser returned no routes — parser regression`);
    for (const route of routes) {
      assert.ok(isSafeSkillName(route), `${fn}: bogus route '${route}' leaked from the parser`);
      assert.ok(
        covered.has(route),
        `${fn}: route '${route}' not in KNOWN_FOUNDER_SKILLS ∪ BUILTIN_SKILL_EXCEPTIONS — stale or renamed?`,
      );
    }
  });
}

test('templates route to exactly the checked-in catalog plus built-in exceptions', () => {
  const routed = new Set(TEMPLATE_FUNCTIONS.flatMap((fn) => templateRoutes(fn)));
  assert.deepEqual([...routed].sort(), [...covered].sort());
});

test('design template resolves the † footnote route to frontend-design', () => {
  assert.ok(templateRoutes('design').includes('frontend-design'));
});

test('catalog is kebab-safe and duplicate-free; exceptions stay out of it', () => {
  assert.equal(new Set(KNOWN_FOUNDER_SKILLS).size, KNOWN_FOUNDER_SKILLS.length);
  for (const s of KNOWN_FOUNDER_SKILLS) {
    assert.ok(isSafeSkillName(s), `unsafe catalog entry '${s}'`);
  }
  for (const e of BUILTIN_SKILL_EXCEPTIONS) {
    assert.ok(isSafeSkillName(e), `unsafe exception '${e}'`);
    assert.ok(!KNOWN_FOUNDER_SKILLS.includes(e), `exception '${e}' must not be in the catalog`);
  }
});

test('parser ignores tables outside ## Skills plus header and separator rows', () => {
  const md = [
    '# Some Expert',
    '',
    '| Task | Skill |',
    '|---|---|',
    '| before the section | not-counted |',
    '',
    '## Practitioner panel',
    '',
    '| Practitioner | Lens | Apply when |',
    '|---|---|---|',
    '| Some Person | A long lens | Whenever |',
    '',
    '## Skills',
    '',
    'Prose between heading and table is ignored.',
    '',
    '| Task | Skill |',
    '|---|---|',
    '| copy | `copywriter-skill` |',
    '| build UI | frontend-design † |',
    '| duplicate row | copywriter-skill |',
    '',
    '## Output rules',
    '',
    '| Task | Skill |',
    '|---|---|',
    '| after the section | not-counted-either |',
  ].join('\n');
  assert.deepEqual(parseExpertRoutes(md), ['copywriter-skill', 'frontend-design']);
});

test('no ## Skills section yields an empty parse', () => {
  assert.deepEqual(parseExpertRoutes('# Title\n\n| A | B |\n|---|---|\n| x | y |\n'), []);
});

test('empty or malformed rows in the Skills section yield no bogus routes', () => {
  const md = [
    '## Skills',
    '| Task | Skill |',
    '| :--- | :--- |',
    '| no second column',
    '|  |  |',
    '| ok | seo |',
    'not | a table row',
  ].join('\n');
  assert.deepEqual(parseExpertRoutes(md), ['seo']);
});

test(
  'catalog matches live founder-skills repo',
  {
    skip:
      process.env['ROSTER_NETWORK_SMOKE'] !== '1' &&
      'set ROSTER_NETWORK_SMOKE=1 to run the live GitHub catalog check',
  },
  async () => {
    const res = await fetch(
      'https://api.github.com/repos/firatcand/founder-skills/git/trees/main?recursive=1',
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'roster-expert-routes-test',
        },
      },
    );
    assert.ok(res.ok, `GitHub tree fetch failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as {
      truncated: boolean;
      tree: Array<{ path: string; type: string }>;
    };
    assert.equal(body.truncated, false, 'tree listing truncated — cannot trust coverage');
    const live = new Set<string>();
    for (const entry of body.tree) {
      const m = /^([^/]+)\/SKILL\.md$/.exec(entry.path);
      if (m && entry.type === 'blob') live.add(m[1]!);
    }
    assert.ok(live.size > 0, 'live repo listed no skills — check the path derivation');
    const missing = KNOWN_FOUNDER_SKILLS.filter((s) => !live.has(s));
    assert.deepEqual(
      missing,
      [],
      `catalog entries removed upstream: ${missing.join(', ')} — update EXPERT.md routes + KNOWN_FOUNDER_SKILLS together`,
    );
  },
);
