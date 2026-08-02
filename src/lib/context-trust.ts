export const CONTEXT_TRUST_CLASSES = [
  'authored-policy',
  'approved-lesson',
  'vendor-instruction',
  'brain-structured',
  'brain-extract-untrusted',
  'tool-output-untrusted',
  'host-asserted',
  'legacy-unverified',
  'diagnostic',
] as const;

export type ContextTrustClass = (typeof CONTEXT_TRUST_CLASSES)[number];
