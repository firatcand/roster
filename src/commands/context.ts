import { EXIT_ERROR, EXIT_OK } from '../lib/errors.ts';
import {
  resolveWorkspaceContextWithRetrieval,
  sanitizeContextFailure,
  type ContextRetriever,
} from '../lib/workspace-context.ts';
import { jsonFailureEnvelope } from '../lib/workspace-diagnostics.ts';
import { retrieveBrainContextEvidence } from '../lib/brain/context-retrieval.ts';

export type ContextCommandOptions = {
  root: string;
  target: string;
  query: string;
  stepHint: string | null;
  budgetTokens: number;
  explain: boolean;
  includeLegacyUnverified: boolean;
};

export async function executeContext(
  options: ContextCommandOptions,
  retrieve: ContextRetriever = retrieveBrainContextEvidence,
): Promise<number> {
  try {
    const result = await resolveWorkspaceContextWithRetrieval(options, retrieve);
    const serialized = JSON.stringify(result);
    console.log(serialized);
    return EXIT_OK;
  } catch (error) {
    const failure = sanitizeContextFailure(error);
    console.log(JSON.stringify(jsonFailureEnvelope(failure)));
    return EXIT_ERROR;
  }
}
