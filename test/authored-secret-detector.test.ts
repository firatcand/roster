import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectAuthoredSecretMaterial,
  hasCredentialShape,
  type AuthoredSecretDetectorId,
} from '../src/lib/authored-secret-detector.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import { parseWorkspaceToolUseDefinition } from '../src/lib/workspace-tool-use.ts';

const CANARIES: ReadonlyArray<{ detector: AuthoredSecretDetectorId; value: string }> = [
  { detector: 'pem-private-key', value: '-----BEGIN PRIVATE KEY-----' },
  { detector: 'jwt', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePart123456' },
  { detector: 'bearer-credential', value: 'Bearer AbCdEfGhIjKlMnOpQrSt1234' },
  { detector: 'authorization-credential', value: 'authorization: AbCdEfGhIjKlMnOpQrSt1234' },
  { detector: 'openai-api-key', value: 'sk-AbCdEfGhIjKlMnOpQrSt123456' },
  { detector: 'anthropic-api-key', value: 'sk-ant-AbCdEfGhIjKlMnOpQrSt123456' },
  { detector: 'aws-access-key-id', value: 'AKIAABCDEFGHIJKLMNOP' },
  { detector: 'github-token', value: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456' },
  { detector: 'slack-token', value: 'xoxb-AbCdEfGhIjKlMnOpQrStUvWxYz123456' },
  { detector: 'apify-api-token', value: 'apify_api_AbCdEfGhIjKlMnOpQrStUvWxYz123456' },
];

test('high-confidence detector finds dedicated canaries without returning matched values or hashes', () => {
  for (const canary of CANARIES) {
    const source = `prefix ${canary.value} suffix`;
    const findings = detectAuthoredSecretMaterial(source);
    assert.ok(findings.some((finding) => finding.detector_id === canary.detector), canary.detector);
    const serialized = JSON.stringify(findings);
    assert.ok(!serialized.includes(canary.value));
    assert.deepEqual(Object.keys(findings[0]!).sort(), ['byte_offset', 'detector_id', 'match_length']);
  }
});

test('detector scans comments, keys, scalars, and nested block strings', () => {
  const canary = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const placements = [
    `# ${canary}\nschema_version: 2`,
    `${canary}: forbidden`,
    `rule: ${canary}`,
    `rules:\n  - |\n    never paste ${canary}\n`,
  ];
  for (const source of placements) {
    assert.ok(detectAuthoredSecretMaterial(source).some((finding) => finding.detector_id === 'github-token'));
  }
});

test('generic examples and prohibition prose do not hard-fail', () => {
  const prose = [
    'api_key=replace-with-secret',
    'postgresql://user:password@example.invalid/database',
    'https://user:password@example.invalid/path',
    'Bearer token',
    '# authorization:',
    'authorization: this-is-an-all-lowercase-example',
    'Bearer this-is-an-all-lowercase-example.',
  ].join('\n');
  assert.deepEqual(detectAuthoredSecretMaterial(prose), []);
});

test('generic credential-shape filtering preserves its closed mixed-class rule', () => {
  assert.equal(hasCredentialShape('this-is-an-all-lowercase-example'), false);
  assert.equal(hasCredentialShape('alllowercasecredentialvalue'), false);
  assert.equal(hasCredentialShape('AbCdEfGhIjKlMnOpQrSt'), true);
  assert.equal(hasCredentialShape('12345678901234567890='), true);
});

test('tool-use rejection exposes only sanitized detector metadata', () => {
  const canary = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const content = `schema_version: 2
id: research-opportunities
scope: {}
purpose: Find public opportunities.
skill_ref: exa:search
rules:
  - never paste ${canary}
`;
  assert.throws(
    () => parseWorkspaceToolUseDefinition(content, 'tools/research-opportunities.yaml'),
    (error: unknown) => {
      if (!isWorkspaceFailure(error)) return false;
      assert.equal(error.code, 'SECRET_MATERIAL_FORBIDDEN');
      const serialized = JSON.stringify({
        header: error.header,
        remedy: error.remedy,
        details: error.details,
      });
      assert.ok(!serialized.includes(canary));
      assert.equal(error.details.detector_id, 'github-token');
      assert.equal(typeof error.details.byte_offset, 'number');
      assert.equal(typeof error.details.match_length, 'number');
      assert.equal(error.details.match_length, Buffer.byteLength(canary));
      return true;
    },
  );
});

test('byte offsets are UTF-8 byte positions', () => {
  const canary = 'AKIAABCDEFGHIJKLMNOP';
  const source = `é🙂 ${canary}`;
  const finding = detectAuthoredSecretMaterial(source).find((entry) => entry.detector_id === 'aws-access-key-id');
  assert.equal(finding?.byte_offset, Buffer.byteLength('é🙂 '));
  assert.equal(finding?.match_length, Buffer.byteLength(canary));
});
