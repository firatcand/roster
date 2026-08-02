import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  HOST_LED_LEARNING_PASS_COUNT,
  HOST_LED_LEARNING_SMOKE_ENV,
  canonicalJson,
  isHostLedLearningCertificationEnabled,
  loadHostLedLearningAttestation,
  parseHostLedLearningAttestation,
  runHostLedLearningCertification,
  verifyHostLedLearningAttestationFreshness,
  type HostLedLearningAttestation,
} from './support/host-led-learning-certification.ts';

function rehash(value: HostLedLearningAttestation): HostLedLearningAttestation {
  const withoutHash = { ...value };
  delete (withoutHash as { attestation_sha256?: string }).attestation_sha256;
  return {
    ...value,
    attestation_sha256: createHash('sha256').update(canonicalJson(withoutHash)).digest('hex'),
  };
}

test('host-led learning attestation is closed, fresh, exact-host bound, and host equivalent', () => {
  const attestation = verifyHostLedLearningAttestationFreshness();
  assert.equal(parseHostLedLearningAttestation(attestation).attestation_sha256, attestation.attestation_sha256);
  for (const host of ['claude', 'codex'] as const) {
    assert.equal(attestation.outcomes[host].length, HOST_LED_LEARNING_PASS_COUNT);
    assert.deepEqual(attestation.outcomes[host].map((entry) => entry.pass), [1, 2, 3]);
    for (const outcome of attestation.outcomes[host]) {
      assert.deepEqual(outcome.semantic_result, attestation.normalized_result);
      assert.equal(outcome.semantic_result_sha256, attestation.normalized_result_sha256);
    }
  }
  assert.deepEqual(attestation.outcomes.claude.map((entry) => entry.semantic_result),
    attestation.outcomes.codex.map((entry) => entry.semantic_result));

  const missingOutcome = rehash({
    ...attestation,
    outcomes: { ...attestation.outcomes, claude: attestation.outcomes.claude.slice(0, 2) },
  });
  assert.throws(() => parseHostLedLearningAttestation(missingOutcome), /three|outcome/iu);
  const extraField = rehash({ ...attestation, unexpected: true } as HostLedLearningAttestation);
  assert.throws(() => parseHostLedLearningAttestation(extraField), /closed|field/iu);
});

test('host-led learning live certification is opt-in and performs all six exact-host passes', {
  skip: !isHostLedLearningCertificationEnabled(),
  timeout: 90 * 60_000,
}, async () => {
  assert.equal(process.env[HOST_LED_LEARNING_SMOKE_ENV], '1');
  const attestation = await runHostLedLearningCertification();
  assert.equal(attestation.outcomes.claude.length, HOST_LED_LEARNING_PASS_COUNT);
  assert.equal(attestation.outcomes.codex.length, HOST_LED_LEARNING_PASS_COUNT);
  assert.equal(loadHostLedLearningAttestation().attestation_sha256, attestation.attestation_sha256);
});
