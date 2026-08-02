export const AUTHORED_SECRET_DETECTOR_IDS = [
  'pem-private-key',
  'jwt',
  'bearer-credential',
  'authorization-credential',
  'openai-api-key',
  'anthropic-api-key',
  'aws-access-key-id',
  'github-token',
  'slack-token',
  'apify-api-token',
] as const;

export type AuthoredSecretDetectorId = (typeof AUTHORED_SECRET_DETECTOR_IDS)[number];

export type AuthoredSecretFinding = {
  detector_id: AuthoredSecretDetectorId;
  byte_offset: number;
  match_length: number;
};

type Candidate = {
  detectorId: AuthoredSecretDetectorId;
  index: number;
  value: string;
};

type Detector = {
  detectorId: AuthoredSecretDetectorId;
  pattern: RegExp;
  capture?: number;
  credentialShape?: boolean;
};

const DETECTORS: readonly Detector[] = [
  {
    detectorId: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    detectorId: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    detectorId: 'bearer-credential',
    pattern: /\bBearer[ \t]+["']?([A-Za-z0-9._~+/=-]{20,})["']?/gi,
    capture: 1,
    credentialShape: true,
  },
  {
    detectorId: 'authorization-credential',
    pattern: /\bauthorization[ \t]*[:=][ \t]*["']?(?:(?:Bearer|Basic|Token)[ \t]+)?([A-Za-z0-9._~+/=-]{20,})["']?/gi,
    capture: 1,
    credentialShape: true,
  },
  {
    detectorId: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    detectorId: 'openai-api-key',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    detectorId: 'aws-access-key-id',
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
  },
  {
    detectorId: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    detectorId: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    detectorId: 'apify-api-token',
    pattern: /\bapify_api_[A-Za-z0-9_-]{20,}\b/g,
  },
];

function hasCredentialShape(value: string): boolean {
  if (/^[a-z]+(?:-[a-z]+)+(?:\.)?$/.test(value)) return false;
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[._~+/=-]/.test(value),
  ].filter(Boolean).length;
  return classes >= 2;
}

function candidates(source: string, detector: Detector): Candidate[] {
  const results: Candidate[] = [];
  detector.pattern.lastIndex = 0;
  for (const match of source.matchAll(detector.pattern)) {
    const full = match[0];
    const value = detector.capture === undefined ? full : match[detector.capture];
    if (value === undefined || (detector.credentialShape && !hasCredentialShape(value))) continue;
    const relativeIndex = detector.capture === undefined ? 0 : full.indexOf(value);
    results.push({
      detectorId: detector.detectorId,
      index: match.index + relativeIndex,
      value,
    });
  }
  return results;
}

export function detectAuthoredSecretMaterial(source: string | Uint8Array): readonly AuthoredSecretFinding[] {
  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
  if (!text.includes('-----BEGIN ')
    && !text.includes('eyJ')
    && !/(?:bearer|authorization)/i.test(text)
    && !text.includes('sk-')
    && !text.includes('AKIA')
    && !text.includes('ghp_')
    && !text.includes('gho_')
    && !text.includes('ghu_')
    && !text.includes('ghs_')
    && !text.includes('ghr_')
    && !text.includes('xox')
    && !text.includes('apify_api_')) return [];
  const found = DETECTORS.flatMap((detector) => candidates(text, detector))
    .map((candidate) => ({
      detector_id: candidate.detectorId,
      byte_offset: Buffer.byteLength(text.slice(0, candidate.index), 'utf8'),
      match_length: Buffer.byteLength(candidate.value, 'utf8'),
    }))
    .sort((a, b) => a.byte_offset - b.byte_offset
      || a.match_length - b.match_length
      || a.detector_id.localeCompare(b.detector_id, 'en'));
  const unique: AuthoredSecretFinding[] = [];
  for (const finding of found) {
    const prior = unique.at(-1);
    if (prior?.detector_id === finding.detector_id
      && prior.byte_offset === finding.byte_offset
      && prior.match_length === finding.match_length) continue;
    unique.push(finding);
  }
  return unique;
}
