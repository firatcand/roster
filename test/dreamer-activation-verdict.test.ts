import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveDreamerActivation,
  type DreamerActivationHostReport,
  type DreamerActivationInputs,
} from '../src/lib/doctor-dreamer-activation.ts';

const BRAINS = ['absent', 'partial', 'declared'] as const;
const INSTRUCTIONS = ['missing', 'drifted', 'current'] as const;
const ACTIVATIONS = ['supported', 'advisory', 'missing', 'drifted'] as const;
const FILES = ['present', 'absent'] as const;

function hostSets(): Array<DreamerActivationInputs['hosts']> {
  const singles: DreamerActivationHostReport[] = [];
  for (const activation of ACTIVATIONS) {
    for (const skill_files of FILES) singles.push({ activation, skill_files });
  }
  const sets: Array<DreamerActivationInputs['hosts']> = [{}];
  for (const claude of singles) {
    sets.push({ claude });
    for (const codex of singles) sets.push({ claude, codex });
  }
  return sets;
}

function everyInput(): DreamerActivationInputs[] {
  const inputs: DreamerActivationInputs[] = [];
  for (const brain of BRAINS) {
    for (const structural_ok of [true, false]) {
      for (const instructions of INSTRUCTIONS) {
        for (const hosts of hostSets()) inputs.push({ brain, structural_ok, instructions, hosts });
      }
    }
  }
  return inputs;
}

// The table is only useful if it is TOTAL and DETERMINISTIC: every workspace
// state reaches exactly one verdict, and reading the same state twice cannot
// change it. Enumerating the whole input space is what proves both.
test('every reachable input state maps to exactly one verdict, deterministically', () => {
  const inputs = everyInput();
  assert.equal(inputs.length, 3 * 2 * 3 * (1 + 8 + 64));
  const seen = new Set<string>();
  for (const input of inputs) {
    const report = deriveDreamerActivation(input);
    assert.deepEqual(report, deriveDreamerActivation(input));
    assert.equal(report.runtime_verified, false);
    seen.add(report.verdict);
  }
  assert.deepEqual([...seen].sort(), [
    'blocked',
    'drifted',
    'files-missing',
    'files-only',
    'inactive',
    'static-coherent',
  ]);
});

test('a blocking workspace state outranks the empty host set it also causes', () => {
  // A half-declared brain and a broken registry are the SAME parse failure, so
  // both arrive with no readable hosts. Answering `inactive` there would claim
  // the workspace enables no host, which is not what was observed.
  for (const structural_ok of [true, false]) {
    assert.equal(
      deriveDreamerActivation({ brain: 'partial', structural_ok, instructions: 'current', hosts: {} }).verdict,
      'blocked',
    );
  }
  assert.equal(
    deriveDreamerActivation({ brain: 'absent', structural_ok: false, instructions: 'current', hosts: {} }).verdict,
    'blocked',
  );
});

test('the empty host set is answered before any quantifier over hosts', () => {
  for (const instructions of INSTRUCTIONS) {
    assert.equal(
      deriveDreamerActivation({ brain: 'declared', structural_ok: true, instructions, hosts: {} }).verdict,
      'inactive',
    );
  }
});

test('missing outranks drift, and drift outranks a missing skill file', () => {
  const present = { activation: 'drifted', skill_files: 'present' } as const;
  assert.equal(
    deriveDreamerActivation({
      brain: 'absent',
      structural_ok: true,
      instructions: 'missing',
      hosts: { claude: present },
    }).verdict,
    'files-only',
  );
  assert.equal(
    deriveDreamerActivation({
      brain: 'absent',
      structural_ok: true,
      instructions: 'drifted',
      hosts: { claude: { activation: 'supported', skill_files: 'absent' } },
    }).verdict,
    'drifted',
  );
  assert.equal(
    deriveDreamerActivation({
      brain: 'absent',
      structural_ok: true,
      instructions: 'current',
      hosts: { claude: { activation: 'advisory', skill_files: 'absent' } },
    }).verdict,
    'files-missing',
  );
});

test('one broken host is enough, and one present skill file is enough', () => {
  // Activation is per host, so a second healthy host cannot vouch for a broken
  // one; the skill rule is the opposite -- either scope of either host proves
  // the files exist somewhere the loop can read them.
  assert.equal(
    deriveDreamerActivation({
      brain: 'declared',
      structural_ok: true,
      instructions: 'current',
      hosts: {
        claude: { activation: 'supported', skill_files: 'present' },
        codex: { activation: 'missing', skill_files: 'present' },
      },
    }).verdict,
    'files-only',
  );
  assert.equal(
    deriveDreamerActivation({
      brain: 'declared',
      structural_ok: true,
      instructions: 'missing',
      hosts: {
        claude: { activation: 'supported', skill_files: 'absent' },
        codex: { activation: 'supported', skill_files: 'present' },
      },
    }).verdict,
    'files-only',
  );
  assert.equal(
    deriveDreamerActivation({
      brain: 'declared',
      structural_ok: true,
      instructions: 'missing',
      hosts: {
        claude: { activation: 'supported', skill_files: 'absent' },
        codex: { activation: 'supported', skill_files: 'absent' },
      },
    }).verdict,
    'inactive',
  );
});

test('an absent Brain declaration is compatible with a coherent workspace', () => {
  // `roster dream status` answers `not_due` with BRAIN_NOT_CONFIGURED there --
  // an honest answer, not a broken one.
  assert.equal(
    deriveDreamerActivation({
      brain: 'absent',
      structural_ok: true,
      instructions: 'current',
      hosts: { claude: { activation: 'supported', skill_files: 'present' } },
    }).verdict,
    'static-coherent',
  );
});
