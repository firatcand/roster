import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createBrainPool } from '../../src/lib/brain/connect.ts';
import { buildRuntimeUrl } from '../../src/lib/brain/roles.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
  type VerifiedBrainPool,
} from '../../src/lib/brain/workspace-authority.ts';
import type {
  BrainObjectCreateResult,
  BrainObjectInspection,
  BrainObjectStore,
} from '../../src/lib/brain/object-store.ts';
import type { WorkspaceBrainConfig } from '../../src/lib/workspace-record.ts';
import {
  normalizeCompletedRun,
  normalizeFeedback,
  type CompletedRunInput,
  type FeedbackInput,
} from '../../src/lib/brain/evidence-contracts.ts';
import { recordCompletedRun, recordFeedback } from '../../src/lib/brain/evidence-store.ts';
import { createFreshDb } from '../brain-helpers.ts';

export function brainConfig(workspaceId: string): WorkspaceBrainConfig {
  return {
    secrets_path: `/${workspaceId}`,
    storage: {
      bucket: workspaceId,
      region: 'eu-central-1',
      force_path_style: false,
    },
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectKey(sha256: string): string {
  return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

export class MemoryObjectStore implements BrainObjectStore {
  readonly namespaceFingerprint: string;
  readonly objects = new Map<string, Buffer>();
  readonly createCalls: string[] = [];

  constructor(namespaceFingerprint: string) {
    this.namespaceFingerprint = namespaceFingerprint;
  }

  async createOrVerify(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<BrainObjectCreateResult> {
    this.createCalls.push(input.sha256);
    assert.equal(input.sha256, digest(input.bytes));
    const bytes = Buffer.from(input.bytes);
    const existing = this.objects.get(input.sha256);
    if (existing !== undefined) assert.deepEqual(existing, bytes);
    else this.objects.set(input.sha256, bytes);
    return {
      outcome: existing === undefined ? 'stored' : 'exists',
      key: objectKey(input.sha256),
      sha256: input.sha256,
      byteLength: bytes.byteLength,
      etag: null,
      versionId: null,
    };
  }

  async inspect(input: { sha256: string; byteLength: number }): Promise<BrainObjectInspection> {
    const bytes = this.objects.get(input.sha256);
    if (bytes === undefined) return { status: 'missing', key: objectKey(input.sha256) };
    if (bytes.byteLength !== input.byteLength) {
      return { status: 'corrupt', key: objectKey(input.sha256), reason: 'size' };
    }
    return {
      status: 'verified',
      key: objectKey(input.sha256),
      sha256: input.sha256,
      byteLength: bytes.byteLength,
      etag: null,
      versionId: null,
    };
  }

  close(): void {}
}

export type EvidenceFixture = {
  workspaceId: string;
  adminUrl: string;
  runtimeUrl: string;
  runtimeRole: string;
  databaseAuthorityId: string;
  admin: VerifiedBrainPool;
  runtime: VerifiedBrainPool;
  store: MemoryObjectStore;
  close: () => Promise<void>;
};

async function dropRole(roleName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName)) throw new Error('unsafe derived role fixture');
  const pool = createBrainPool('admin');
  try {
    await pool.query(`REVOKE "${roleName}" FROM CURRENT_USER`);
    await pool.query(`DROP ROLE IF EXISTS "${roleName}"`);
  } finally {
    await pool.end();
  }
}

export async function createEvidenceFixture(
  workspaceId: string,
  roleBase?: string,
): Promise<EvidenceFixture> {
  const fresh = await createFreshDb();
  const authority = deriveBrainWorkspaceAuthority(workspaceId, brainConfig(workspaceId));
  const password = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
  const bootstrapPool = createBrainPool('admin', fresh.url);
  let runtimeRole: string | undefined;
  try {
    const bootstrap = await bootstrapBrainWorkspaceAuthority(bootstrapPool, authority, {
      runtimeRole: roleBase ?? fresh.role,
      runtimePassword: password,
    });
    runtimeRole = bootstrap.role.roleName;
    await bootstrapPool.end();
    const runtimeUrl = buildRuntimeUrl(fresh.url, password, bootstrap.role.roleName);
    const admin = createVerifiedBrainPool({
      connectionString: fresh.url,
      authority,
      databaseAuthorityId: bootstrap.databaseAuthorityId,
    });
    const runtime = createVerifiedBrainPool({
      connectionString: runtimeUrl,
      authority,
      databaseAuthorityId: bootstrap.databaseAuthorityId,
    });
    return {
      workspaceId,
      adminUrl: fresh.url,
      runtimeUrl,
      runtimeRole: bootstrap.role.roleName,
      databaseAuthorityId: bootstrap.databaseAuthorityId,
      admin,
      runtime,
      store: new MemoryObjectStore(authority.namespaceFingerprint),
      close: async () => {
        await admin.end().catch(() => {});
        await runtime.end().catch(() => {});
        await fresh.drop();
        await dropRole(bootstrap.role.roleName);
      },
    };
  } catch (error) {
    await bootstrapPool.end().catch(() => {});
    await fresh.drop().catch(() => {});
    if (runtimeRole !== undefined) await dropRole(runtimeRole).catch(() => {});
    throw error;
  }
}

// #357: additive seeding helpers shared by the Dreamer suites. They exist so a
// readiness test can express "five succeeded runs for gtm/manager" in one line
// without forking #356's canonical record shape.
export const SEED_ACTOR = Object.freeze({
  actorId: 'codex-session',
  assurance: 'host-attested',
  host: 'codex',
  sessionId: 'dream-seed',
} as const);

export function seedRunInput(
  runId: string,
  overrides: Partial<CompletedRunInput> = {},
): CompletedRunInput {
  return {
    runId,
    functionId: 'social-media',
    agentId: 'manager',
    planId: 'discovery',
    host: 'codex',
    hostVersion: '0.51.0',
    requestSummary: `seeded run ${runId}`,
    requestHash: `sha256:${'a'.repeat(64)}`,
    startedAt: '2026-08-08T10:00:00.000Z',
    completedAt: '2026-08-08T10:04:30.000Z',
    outcome: 'succeeded',
    privacy: 'internal',
    trust: 'host-asserted',
    sources: [],
    tools: [],
    actor: SEED_ACTOR,
    provenance: { fixture: 'brain-dream' },
    ...overrides,
  } as CompletedRunInput;
}

export function seedFeedbackInput(
  feedbackId: string,
  runId: string,
  overrides: Partial<FeedbackInput> = {},
): FeedbackInput {
  return {
    feedbackId,
    runId,
    signal: 'positive',
    summary: `seeded feedback ${feedbackId}`,
    privacy: 'internal',
    trust: 'host-asserted',
    actor: SEED_ACTOR,
    provenance: { fixture: 'brain-dream' },
    ...overrides,
  } as FeedbackInput;
}

export function seedRunCanonical(runId: string, overrides: Partial<CompletedRunInput> = {}): string {
  return normalizeCompletedRun(seedRunInput(runId, overrides)).canonical;
}

export function seedFeedbackCanonical(
  feedbackId: string,
  runId: string,
  overrides: Partial<FeedbackInput> = {},
): string {
  return normalizeFeedback(seedFeedbackInput(feedbackId, runId, overrides)).canonical;
}

export async function seedRuns(
  pool: VerifiedBrainPool,
  runIds: readonly string[],
  overrides: Partial<CompletedRunInput> = {},
): Promise<void> {
  for (const runId of runIds) {
    await recordCompletedRun(pool, seedRunInput(runId, overrides));
  }
}

export async function seedFeedback(
  pool: VerifiedBrainPool,
  entries: readonly { feedbackId: string; runId: string; overrides?: Partial<FeedbackInput> }[],
): Promise<void> {
  for (const entry of entries) {
    await recordFeedback(pool, seedFeedbackInput(entry.feedbackId, entry.runId, entry.overrides ?? {}));
  }
}
