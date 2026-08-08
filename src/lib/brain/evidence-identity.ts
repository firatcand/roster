import { createHash } from 'node:crypto';
import { canonicalSourceJson, type SourceJsonValue } from './source-contracts.ts';

export const EVIDENCE_FINGERPRINT_DOMAINS = {
  'completed-run': 'roster.brain.evidence.completed-run.v1',
  'run-artifact': 'roster.brain.evidence.run-artifact.v1',
  feedback: 'roster.brain.evidence.feedback.v1',
  'human-decision': 'roster.brain.evidence.human-decision.v1',
  promotion: 'roster.brain.evidence.promotion.v1',
} as const;

export type EvidenceFingerprintDomainKey = keyof typeof EVIDENCE_FINGERPRINT_DOMAINS;

export const EVIDENCE_ACTION_DOMAIN = 'roster.brain.evidence.action.v1';
export const EVIDENCE_SUMMARY_DOMAIN = 'roster.brain.evidence.summary.v1';
export const EVIDENCE_PROMOTION_IDENTITY_DOMAIN = 'roster.brain.evidence.promotion-identity.v1';
export const EVIDENCE_PROMOTION_CONTENT_DOMAIN = 'roster.brain.evidence.promotion-content.v1';

export const EVIDENCE_LOCK_DOMAINS = {
  run: 'roster.brain.evidence.lock.run.v1',
  artifact: 'roster.brain.evidence.lock.artifact.v1',
  feedback: 'roster.brain.evidence.lock.feedback.v1',
  decision: 'roster.brain.evidence.lock.decision.v1',
  promotion: 'roster.brain.evidence.lock.promotion.v1',
} as const;

export type EvidenceLockDomainKey = keyof typeof EVIDENCE_LOCK_DOMAINS;

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function evidenceCanonicalText(record: SourceJsonValue): string {
  return canonicalSourceJson(record);
}

export function evidenceDigest(domain: string, value: SourceJsonValue): string {
  return sha256(canonicalSourceJson({ domain, value }));
}

// The stored `record_canonical` bytes are the fingerprint preimage, so a
// fingerprint is always recomputable from a durable row and is never stored.
export function evidenceRecordFingerprint(
  kind: EvidenceFingerprintDomainKey,
  canonicalText: string,
): string {
  return evidenceDigest(EVIDENCE_FINGERPRINT_DOMAINS[kind], canonicalText);
}

export function evidenceActionDigest(action: SourceJsonValue): string {
  return evidenceDigest(EVIDENCE_ACTION_DOMAIN, action);
}

export function evidenceSummaryHash(summary: string): string {
  return evidenceDigest(EVIDENCE_SUMMARY_DOMAIN, summary);
}

// Length-prefixed framing: `domain` followed by `:<char-length>:<component>` per
// component. PostgreSQL `text` cannot hold NUL, so the framing carries its own
// unambiguous boundaries instead of a delimiter. `length()` in PostgreSQL counts
// characters, so the TS side counts code points (not UTF-16 units) to match it
// byte-for-byte; every lock component is additionally ASCII by contract.
export function evidenceLockFrame(domain: string, components: readonly string[]): string {
  let frame = domain;
  for (const component of components) {
    frame += `:${[...component].length}:${component}`;
  }
  return frame;
}

export type PromotionIdentity = Readonly<{
  evidenceKind: 'completed-run' | 'run-artifact' | 'feedback' | 'human-decision';
  runId: string | null;
  artifactId: string | null;
  feedbackId: string | null;
  decisionId: string | null;
  promotedSourceVersionId: string;
}>;

function promotionIdentityValue(identity: PromotionIdentity): SourceJsonValue {
  return {
    evidence_kind: identity.evidenceKind,
    run_id: identity.runId,
    artifact_id: identity.artifactId,
    feedback_id: identity.feedbackId,
    decision_id: identity.decisionId,
    promoted_source_version_id: identity.promotedSourceVersionId,
  };
}

// Derived from the STABLE identity only — never the full request — so a
// conflicting re-promotion of the same identity lands on the existing row and
// fails the canonical-text comparison instead of minting a second lineage row.
export function derivePromotionId(identity: PromotionIdentity): string {
  return evidenceDigest(EVIDENCE_PROMOTION_IDENTITY_DOMAIN, promotionIdentityValue(identity));
}

export type PromotionSubjectIdentity = Omit<PromotionIdentity, 'promotedSourceVersionId'>;

// The logical source key deliberately EXCLUDES the promoted version: every
// promotion of one evidence item is another version of the same logical source.
export function derivePromotionSourceKey(identity: PromotionSubjectIdentity): string {
  const digest = evidenceDigest(EVIDENCE_PROMOTION_CONTENT_DOMAIN, {
    evidence_kind: identity.evidenceKind,
    run_id: identity.runId,
    artifact_id: identity.artifactId,
    feedback_id: identity.feedbackId,
    decision_id: identity.decisionId,
  });
  return `evidence-promotion:${digest.slice('sha256:'.length)}`;
}

export function promotionLockComponents(identity: PromotionIdentity): readonly string[] {
  return [
    identity.evidenceKind,
    identity.runId ?? '',
    identity.artifactId ?? '',
    identity.feedbackId ?? '',
    identity.decisionId ?? '',
    identity.promotedSourceVersionId,
  ];
}

export function promotionContentValue(
  identity: PromotionSubjectIdentity,
  record: SourceJsonValue,
): SourceJsonValue {
  return {
    domain: EVIDENCE_PROMOTION_CONTENT_DOMAIN,
    evidence_kind: identity.evidenceKind,
    identity: {
      run_id: identity.runId,
      artifact_id: identity.artifactId,
      feedback_id: identity.feedbackId,
      decision_id: identity.decisionId,
    },
    record,
  };
}
