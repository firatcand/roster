import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_LED_LEARNING_PASS_COUNT,
  HOST_LED_LEARNING_SMOKE_ENV,
  isHostLedLearningCertificationEnabled,
  loadHostLedLearningAttestation,
  runHostLedLearningCertification,
  verifyHostLedLearningAttestationFreshness,
} from './support/host-led-learning-certification.ts';

const LIVE_CERTIFICATION_ENABLED = isHostLedLearningCertificationEnabled();

test('host-led learning live certification is opt-in and performs all six exact-host passes', {
  skip: !LIVE_CERTIFICATION_ENABLED,
  timeout: 90 * 60_000,
}, async () => {
  assert.equal(process.env[HOST_LED_LEARNING_SMOKE_ENV], '1');
  const attestation = await runHostLedLearningCertification();
  assert.equal(attestation.outcomes.claude.length, HOST_LED_LEARNING_PASS_COUNT);
  assert.equal(attestation.outcomes.codex.length, HOST_LED_LEARNING_PASS_COUNT);
  assert.equal(loadHostLedLearningAttestation().attestation_sha256, attestation.attestation_sha256);
  assert.equal(verifyHostLedLearningAttestationFreshness().attestation_sha256, attestation.attestation_sha256);
});
