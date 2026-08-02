import {
  MAX_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_QUERY_BYTES,
  MAX_CONTEXT_STEP_BYTES,
  MIN_CONTEXT_BUDGET_TOKENS,
} from './workspace-context.ts';
import {
  isRecordId,
  parseAgentQualifiedId,
  parsePlanQualifiedId,
} from './workspace-layout.ts';
import type { JsonValue } from './errors.ts';
import { isWorkspaceFailure } from './workspace-diagnostics.ts';

export {
  MAX_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_QUERY_BYTES,
  MAX_CONTEXT_STEP_BYTES,
  MIN_CONTEXT_BUDGET_TOKENS,
};

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 12_000;

export type ParsedContextArgs =
  | {
      kind: 'ok';
      target: string;
      query: string;
      stepHint: string | null;
      budgetTokens: number;
      explain: boolean;
      json: true;
    }
  | {
      kind: 'err';
      message: string;
      details: Readonly<Record<string, JsonValue>>;
    };

function parseError(
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ParsedContextArgs {
  return { kind: 'err', message, details };
}

function normalizedTarget(value: string): string | null {
  try {
    if (value.includes('#')) {
      const parsed = parsePlanQualifiedId(value);
      if (
        !isRecordId(parsed.functionId)
        || !isRecordId(parsed.agentId)
        || !isRecordId(parsed.planId)
      ) {
        return null;
      }
      return `${parsed.functionId}/${parsed.agentId}#${parsed.planId}`;
    }
    const parsed = parseAgentQualifiedId(value);
    if (!isRecordId(parsed.functionId) || !isRecordId(parsed.agentId)) return null;
    return `${parsed.functionId}/${parsed.agentId}`;
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'IDENTITY_INVALID') return null;
    throw error;
  }
}

function firstControlByteOffset(value: string): number | null {
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    if ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return Buffer.byteLength(value.slice(0, index), 'utf8');
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  return null;
}

function validateText(
  flag: '--query' | '--step',
  value: string,
  limit: number,
): ParsedContextArgs | null {
  if (value.length === 0) return parseError(`${flag} requires a non-empty value`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > limit) {
    return parseError(`${flag} exceeds its UTF-8 byte limit`, {
      field: flag.slice(2),
      observed_bytes: bytes,
      limit_bytes: limit,
    });
  }
  const byteOffset = firstControlByteOffset(value);
  if (byteOffset !== null) {
    return parseError(`${flag} must not contain control characters`, {
      field: flag.slice(2),
      byte_offset: byteOffset,
    });
  }
  return null;
}

function parseBudget(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseContextArgs(args: readonly string[]): ParsedContextArgs {
  let targetValue: string | undefined;
  let query: string | undefined;
  let stepHint: string | null = null;
  let budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS;
  let explain = false;
  let json = false;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--explain' || arg === '--json') {
      if (seen.has(arg)) return parseError(`${arg} may be provided only once`);
      seen.add(arg);
      if (arg === '--explain') explain = true;
      else json = true;
      continue;
    }
    if (arg === '--query' || arg === '--step' || arg === '--budget') {
      if (seen.has(arg)) return parseError(`${arg} may be provided only once`);
      seen.add(arg);
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return parseError(`${arg} requires a value`);
      }
      index++;
      if (arg === '--query') query = value;
      else if (arg === '--step') stepHint = value;
      else {
        const parsedBudget = parseBudget(value);
        if (parsedBudget === null) {
          return parseError('--budget requires a canonical base-10 safe integer');
        }
        if (
          parsedBudget < MIN_CONTEXT_BUDGET_TOKENS
          || parsedBudget > MAX_CONTEXT_BUDGET_TOKENS
        ) {
          return parseError('--budget is outside the accepted token range', {
            minimum_tokens: MIN_CONTEXT_BUDGET_TOKENS,
            maximum_tokens: MAX_CONTEXT_BUDGET_TOKENS,
          });
        }
        budgetTokens = parsedBudget;
      }
      continue;
    }
    if (arg.startsWith('-')) return parseError("unknown argument for 'context'");
    if (targetValue !== undefined) {
      return parseError("'context' accepts exactly one target");
    }
    targetValue = arg;
  }

  if (targetValue === undefined) return parseError("'context' requires one target");
  const target = normalizedTarget(targetValue);
  if (target === null) {
    return parseError('context target must be an exact lowercase function/agent identity with an optional #plan');
  }
  if (query === undefined) return parseError("'context' requires --query");
  const queryError = validateText('--query', query, MAX_CONTEXT_QUERY_BYTES);
  if (queryError !== null) return queryError;
  if (stepHint !== null) {
    const stepError = validateText('--step', stepHint, MAX_CONTEXT_STEP_BYTES);
    if (stepError !== null) return stepError;
  }
  if (!json) return parseError("'context' requires --json");

  return {
    kind: 'ok',
    target,
    query,
    stepHint,
    budgetTokens,
    explain,
    json: true,
  };
}
