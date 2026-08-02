import { EXIT_ERROR, EXIT_OK } from '../lib/errors.ts';
import {
  resolveWorkspaceContext,
  sanitizeContextFailure,
} from '../lib/workspace-context.ts';
import { jsonFailureEnvelope } from '../lib/workspace-diagnostics.ts';

export type ContextCommandOptions = {
  root: string;
  target: string;
  query: string;
  stepHint: string | null;
  budgetTokens: number;
  explain: boolean;
};

export function executeContext(options: ContextCommandOptions): number {
  try {
    const result = resolveWorkspaceContext(options);
    const serialized = JSON.stringify(result);
    console.log(serialized);
    return EXIT_OK;
  } catch (error) {
    const failure = sanitizeContextFailure(error);
    console.log(JSON.stringify(jsonFailureEnvelope(failure)));
    return EXIT_ERROR;
  }
}
