import {
  assembleWorkspaceContext,
  deriveContextVendorSkillSelection,
  type ContextEvidenceInput,
  type ContextRequest,
  type SeedBrainCandidate,
  type WorkspaceContext,
} from '../../src/lib/workspace-context.ts';
import { withContextReadCapability } from '../../src/lib/workspace-registry.ts';

export type SeededWorkspaceContextOptions = {
  root: string;
  request: ContextRequest;
  candidates: readonly SeedBrainCandidate[];
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function resolveSeededWorkspaceContext(
  options: SeededWorkspaceContextOptions,
): WorkspaceContext {
  const evidence = deepFreeze({
    status: 'seeded' as const,
    candidates: structuredClone(options.candidates),
  }) satisfies ContextEvidenceInput;
  return withContextReadCapability(options.root, (capability) => {
    const selection = deriveContextVendorSkillSelection(capability.source, options.request);
    const projection = capability.selectVendorSkillMap(selection);
    const result = assembleWorkspaceContext(
      capability.source,
      options.request,
      evidence,
      projection,
    );
    capability.verify(capability.source.snapshot.records.map((record) => record.path));
    return result;
  });
}
