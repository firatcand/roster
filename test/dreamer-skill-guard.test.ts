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
  const commands = [...SKILL.matchAll(/^roster ([a-z]+(?: [a-z-]+)*)((?: [^\n#]*)?)$/gmu)]
    .map((match) => `${match[1]!}${match[2] ?? ''}`.trim())
    .filter((command) => !command.includes('->') && !command.includes('|'));
  assert.ok(commands.length >= 6, `expected taught commands, saw ${commands.length}`);
  let dreamCommands = 0;
  for (const command of commands) {
    const tokens = command
      .split(/\s+/u)
      .map((token) => token.replace(/^<|>$/gu, ''))
      .filter((token) => token.length > 0);
    const [head, ...rest] = tokens;
    if (head === 'dream') {
      dreamCommands++;
      const substituted = rest.map((token) => (token.startsWith('<') || token.includes('<')
        ? 'placeholder'
        : token));
      // Placeholders stand in for ids the host fills; the GRAMMAR must parse.
      const filled = substituted.map((token) => (token.startsWith('-') ? token : token
        .replace(/^candidate-id$/u, 'sha256:aaaa')
        .replace(/^decision-id$/u, 'hd-1')
        .replace(/^sha256:\.\.\.$/u, `sha256:${'a'.repeat(64)}`)));
      const parsed = parseDreamArgs(filled);
      assert.equal(parsed.kind, 'ok', `${command} -> ${JSON.stringify(parsed)}`);
      continue;
    }
    if (head === 'brain') {
      // The brain verbs are taught with elided flags; only the verb spelling is
      // pinned here, since a full record-decision payload is not a grammar fact.
      const parsed = parseBrainArgs([rest[0]!]);
      assert.notEqual(parsed.kind, undefined, command);
      continue;
    }
    assert.fail(`the skill teaches an unknown roster subcommand: ${command}`);
  }
  assert.ok(dreamCommands >= 5, `expected every dream verb to be taught, saw ${dreamCommands}`);
});

test('the skill teaches the REAL decision target, read from the CLI', () => {
  // The old text taught `target: <candidate-id>`, which the evidence contract
  // refuses outright — a host following it could never record an acceptable
  // decision. The e2e suite proves the taught workflow is accepted; this pins
  // that the text itself no longer teaches the unusable spelling.
  assert.match(SKILL, /roster dream candidates list --candidate <candidate-id> --json/u);
  assert.match(SKILL, /decision_action/u);
  assert.match(SKILL, /"target": "dream-candidate:/u);
  assert.match(SKILL, /Copy that verb's `target`, `effect`, and `scope` VERBATIM/u);
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
