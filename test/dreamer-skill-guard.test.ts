import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDreamArgs } from '../src/lib/dream-args.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(join(PROJECT_ROOT, 'skills/dreamer/SKILL.md'), 'utf8');

// The v1 skill taught cron, Slack HITL, and a pending/ queue -- three surfaces
// v2 deliberately does not have. A skill that still teaches them sends the host
// looking for machinery that will never exist.
test('the skill teaches no scheduler, no Slack approval, and no pending queue', () => {
  for (const forbidden of [/\bcron\b/iu, /\bnightly\b/iu, /\bslack\b/iu, /pending\//u, /\/schedule\b/u]) {
    assert.equal(forbidden.test(SKILL), false, String(forbidden));
  }
  assert.match(SKILL, /Nothing here is timed, queued, polled, or run in the background/u);
});

test('every roster command the skill teaches parses through its own argv parser', () => {
  // THE HOLE THIS CLOSES: the previous pin dropped any line containing '|' --
  // which silently excluded `roster brain record decision --json ...` because of
  // its trailing "approved | rejected" comment -- and then parsed brain commands
  // by their VERB ALONE, never through the full grammar. Both are fixed here: a
  // trailing comment is stripped rather than disqualifying the line, and every
  // command is parsed in full by the parser that actually gates it.
  const taught = [...SKILL.matchAll(/^roster (.+)$/gmu)]
    .map((match) => match[1]!.replace(/\s+#.*$/u, '').trim())
    // The loop diagram uses '->' to describe what a verb DOES; those lines are
    // prose, not commands, and are the only exclusion.
    .filter((command) => !command.includes('->'));
  assert.ok(taught.length >= 8, `expected taught commands, saw ${taught.length}`);

  let dreamCommands = 0;
  let brainCommands = 0;
  for (const command of taught) {
    // Placeholders stand in for values the host fills; the GRAMMAR must parse.
    const tokens = command.split(/\s+/u).filter((token) => token.length > 0).map((token) => {
      if (token === '...') return '--json';
      if (token.startsWith('<') && token.endsWith('>')) {
        return token === '<sha256:...>' ? `sha256:${'a'.repeat(64)}` : 'placeholder';
      }
      return token;
    });
    const [head, ...rest] = tokens;
    if (head === 'dream') {
      dreamCommands++;
      const parsed = parseDreamArgs(rest);
      assert.equal(parsed.kind, 'ok', `${command} -> ${JSON.stringify(parsed)}`);
      continue;
    }
    if (head === 'brain') {
      brainCommands++;
      const parsed = parseBrainArgs(rest);
      // The FULL grammar, not the verb spelling: this is exactly the check that
      // would have caught `record decision --json` missing --payload/--file.
      assert.equal(parsed.kind, 'ok', `${command} -> ${JSON.stringify(parsed)}`);
      continue;
    }
    assert.fail(`the skill teaches an unknown roster subcommand: ${command}`);
  }
  assert.ok(dreamCommands >= 6, `expected every dream verb to be taught, saw ${dreamCommands}`);
  // #359: an unfiltered list cannot answer "has THIS occasion already been
  // drafted?", so the skill must teach the exact-key read before it drafts.
  assert.ok(
    taught.includes('dream candidates list --readiness-key <sha256:...> --json'),
    'the skill must teach the exact-key candidate read',
  );
  assert.ok(brainCommands >= 1, `expected the record-decision command to be taught, saw ${brainCommands}`);

  // And the pin is proven able to fail: the exact incomplete spelling the skill
  // used to carry must NOT parse.
  assert.equal(parseBrainArgs(['record', 'decision', '--json']).kind, 'err');
});

test('the skill teaches the REAL decision target, read from the CLI', () => {
  // The old text taught `target: <candidate-id>`, which the evidence contract
  // refuses outright — a host following it could never record an acceptable
  // decision. The e2e suite proves the taught workflow is accepted; this pins
  // that the text itself no longer teaches the unusable spelling.
  assert.match(SKILL, /roster dream candidates list --candidate <candidate-id> --json/u);
  assert.match(SKILL, /decision_action/u);
  assert.match(SKILL, /"target": "dream-candidate:/u);
  assert.match(SKILL, /copying `target`,\s+`effect`, `scope`, and `params` VERBATIM into `action`/u);
  assert.match(SKILL, /"action_digest": "sha256/u);
  assert.match(SKILL, /pass the value from the same\s+`decision_action` block as `--action-digest`/u);
  assert.match(SKILL, /The target is NOT the raw candidate id/u);
  assert.equal(
    /`target: <candidate-id>`/u.test(SKILL),
    false,
    'the skill must not teach the raw candidate id as the decision target',
  );
});

test('the skill states the self-evidence, privacy, and no-pasting rules', () => {
  assert.match(SKILL, /Never cite your own runs, and never cite `dreamer` runs/u);
  assert.match(SKILL, /no policy edit can relax it/u);
  assert.match(SKILL, /`secret`-class evidence can never\s+support a lesson/u);
  assert.match(SKILL, /Never paste evidence text into the candidate's prose — cite it/u);
  assert.match(SKILL, /Citations\s+are pointers; Roster renders them/u);
});

test('the skill states the convergence, superseded, unverified, and phase-busy contracts', () => {
  assert.match(SKILL, /Every verb converges on re-run/u);
  assert.match(SKILL, /decision was superseded/u);
  assert.match(SKILL, /act on the current state instead of retrying/u);
  assert.match(SKILL, /UNVERIFIED/u);
  assert.match(SKILL, /re-run the same verb \(it converges\), then run `roster brain doctor`/u);
  assert.match(SKILL, /dream phase busy/u);
  assert.match(SKILL, /\.roster\/state\/locks\/dream-phase/u);
});

test('the skill states that Roster and the skill both lack approval authority', () => {
  assert.match(SKILL, /You never decide/u);
  assert.match(SKILL, /you are the runtime, and the human is the\s+authority/u);
  assert.match(SKILL, /verifies that a durable\s+human decision exists and is bound by action digest/u);
});
