import {
  assembleWorkspaceContext,
  compareUnicodeCodePoints,
  deriveContextSelectorCatalog,
  deriveContextVendorSkillSelection,
  CONTEXT_RETRIEVAL_FILTER_REASONS,
  CONTEXT_RETRIEVAL_MODES,
  type ContextEvidenceInput,
  type ContextRequest,
  type ContextRetrievalReport,
  type ContextSelectorCatalogEntry,
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

// M for a seeded fixture: exactly the required selectors carried by the seeded
// candidates. That is the smallest M that satisfies V2 and V3, so an honest
// fixture never trips the coverage-containment check.
export function seededRetrievalReport(
  candidates: readonly SeedBrainCandidate[],
  selectors: readonly ContextSelectorCatalogEntry[],
  overrides: Partial<ContextRetrievalReport> = {},
): ContextRetrievalReport {
  const required = new Set(selectors.filter((entry) => entry.required).map((entry) => entry.selector));
  const matched = new Set<string>();
  for (const candidate of candidates) {
    for (const selector of candidate.selectors ?? []) {
      if (required.has(selector)) matched.add(selector);
    }
  }
  return {
    modes: Object.fromEntries(CONTEXT_RETRIEVAL_MODES
      .map((mode) => [mode, { status: mode === 'embedding' ? 'disabled' : 'used' }])) as ContextRetrievalReport['modes'],
    graph: { status: 'unavailable', reasons: ['no-cited-edge-relation', 'unmeasured'] },
    filtered: Object.fromEntries(CONTEXT_RETRIEVAL_FILTER_REASONS
      .map((reason) => [reason, 0])) as ContextRetrievalReport['filtered'],
    considered: candidates.length,
    returned: candidates.length,
    truncated: 0,
    required_selectors_with_matches: [...matched].sort(compareUnicodeCodePoints),
    unavailable_reason: null,
    ...overrides,
  };
}

export function resolveSeededWorkspaceContext(
  options: SeededWorkspaceContextOptions,
): WorkspaceContext {
  return withContextReadCapability(options.root, (capability) => {
    const selection = deriveContextVendorSkillSelection(capability.source, options.request);
    const catalog = deriveContextSelectorCatalog(capability.source, options.request);
    const evidence = deepFreeze({
      status: 'seeded' as const,
      candidates: structuredClone(options.candidates) as SeedBrainCandidate[],
      report: seededRetrievalReport(options.candidates, catalog),
    }) satisfies ContextEvidenceInput;
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
