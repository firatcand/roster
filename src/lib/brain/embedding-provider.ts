import type { BrainActivation } from './activation.ts';
import { loadConfig, type BrainConfig } from './config.ts';

const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export const MAX_EMBEDDING_DIMENSIONS = 4_096;

export type EmbeddingProvider = Readonly<{
  provider: string;
  model: string;
  dimensions: number;
  specVersion: number;
  embed: (texts: readonly string[]) => Promise<number[][]>;
}>;

export type EmbeddingAdapterResult =
  | Readonly<{ status: 'resolved'; provider: EmbeddingProvider }>
  | Readonly<{ status: 'credential-unavailable' }>
  | Readonly<{ status: 'invalid-configuration'; reason: string }>;

export type EmbeddingAdapter = (input: {
  model: string;
  env: NodeJS.ProcessEnv;
}) => EmbeddingAdapterResult;

export type EmbeddingAdapterRegistry = Readonly<Record<string, EmbeddingAdapter>>;

// Deliberately empty: #370 ships no named embedding provider. Later tickets
// inject their adapters here; an empty registry can never yield `resolved`.
export const EMBEDDING_ADAPTERS: EmbeddingAdapterRegistry = Object.freeze({});

export type EmbeddingResolution =
  | Readonly<{ status: 'resolved'; provider: EmbeddingProvider }>
  | Readonly<{ status: 'disabled' }>
  | Readonly<{ status: 'credential-unavailable' }>
  | Readonly<{ status: 'invalid-configuration'; reason: string }>;

export function isValidEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<EmbeddingProvider>;
  return typeof candidate.provider === 'string'
    && PROVIDER_NAME.test(candidate.provider)
    && Buffer.byteLength(candidate.provider, 'utf8') <= 128
    && typeof candidate.model === 'string'
    && candidate.model.length > 0
    && Buffer.byteLength(candidate.model, 'utf8') <= 255
    && !CONTROL.test(candidate.model)
    && Number.isSafeInteger(candidate.dimensions)
    && candidate.dimensions! >= 1
    && candidate.dimensions! <= MAX_EMBEDDING_DIMENSIONS
    && Number.isSafeInteger(candidate.specVersion)
    && candidate.specVersion! >= 1
    && typeof candidate.embed === 'function';
}

// Never throws: a broken adapter or malformed configuration is reported as a
// closed outcome so callers degrade to lexical and structured retrieval.
export function resolveEmbeddingProvider(
  config: BrainConfig,
  deps: { adapters?: EmbeddingAdapterRegistry; env?: NodeJS.ProcessEnv } = {},
): EmbeddingResolution {
  if (!config.embeddingsEnabled) return Object.freeze({ status: 'disabled' as const });
  const provider = config.embeddingsProvider;
  if (typeof provider !== 'string'
    || !PROVIDER_NAME.test(provider)
    || Buffer.byteLength(provider, 'utf8') > 128) {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'provider-name-invalid' });
  }
  const model = config.embeddingsModel;
  if (typeof model !== 'string'
    || model.length === 0
    || Buffer.byteLength(model, 'utf8') > 255
    || CONTROL.test(model)) {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'model-invalid' });
  }
  const adapters = deps.adapters ?? EMBEDDING_ADAPTERS;
  const adapter = Object.prototype.hasOwnProperty.call(adapters, provider) ? adapters[provider] : undefined;
  if (typeof adapter !== 'function') {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'unsupported-provider' });
  }
  let result: EmbeddingAdapterResult;
  try {
    result = adapter({ model, env: deps.env ?? process.env });
  } catch {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'adapter-failed' });
  }
  if (result === null || typeof result !== 'object') {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'adapter-contract-violation' });
  }
  if (result.status === 'credential-unavailable') {
    return Object.freeze({ status: 'credential-unavailable' as const });
  }
  if (result.status === 'invalid-configuration') {
    const reason = typeof result.reason === 'string' && result.reason.length > 0 && !CONTROL.test(result.reason)
      ? result.reason
      : 'adapter-contract-violation';
    return Object.freeze({ status: 'invalid-configuration' as const, reason });
  }
  if (result.status !== 'resolved' || !isValidEmbeddingProvider(result.provider)) {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'adapter-contract-violation' });
  }
  if (result.provider.provider !== provider || result.provider.model !== model) {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'adapter-identity-mismatch' });
  }
  return Object.freeze({ status: 'resolved' as const, provider: result.provider });
}

// Convenience seam for callers that already hold an activation: reads only the
// non-secret embeddings.* configuration and keeps the never-throws contract.
export async function loadBrainEmbeddingResolution(
  activation: BrainActivation,
  deps: { adapters?: EmbeddingAdapterRegistry; env?: NodeJS.ProcessEnv } = {},
): Promise<EmbeddingResolution> {
  let config: BrainConfig;
  const client = await activation.pool.connect().catch(() => null);
  if (client === null) {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'configuration-unreadable' });
  }
  try {
    config = await loadConfig(client);
  } catch {
    return Object.freeze({ status: 'invalid-configuration' as const, reason: 'configuration-unreadable' });
  } finally {
    client.release();
  }
  return resolveEmbeddingProvider(config, deps);
}
