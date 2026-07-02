import type pg from 'pg';
import { parseRetention } from './gc.ts';

// Strict allowlist of brain settings stored in brain_meta.config. NOTHING secret
// is ever stored here (the embedding API key is read from the environment). An
// unknown key is rejected so a caller can't smuggle credentials into the DB.
export type ConfigKey =
  | 'embeddings.enabled'
  | 'embeddings.provider'
  | 'embeddings.model'
  | 'search.rrf_k'
  | 'search.graph_hops'
  | 'gc.retention';

export const EMBED_MODEL = 'text-embedding-3-small';

export type BrainConfig = {
  embeddingsEnabled: boolean;
  embeddingsProvider: string;
  embeddingsModel: string;
  rrfK: number;
  graphHops: number;
};

export const DEFAULT_CONFIG: BrainConfig = {
  embeddingsEnabled: false,
  embeddingsProvider: 'openai',
  embeddingsModel: EMBED_MODEL,
  rrfK: 60,
  graphHops: 1,
};

const KEYS: ReadonlySet<string> = new Set<ConfigKey>([
  'embeddings.enabled',
  'embeddings.provider',
  'embeddings.model',
  'search.rrf_k',
  'search.graph_hops',
  'gc.retention',
]);

export function isConfigKey(k: string): k is ConfigKey {
  return KEYS.has(k);
}

// Coerce + validate a CLI string for a key. Throws on an invalid value. Only
// `openai` / `text-embedding-3-small` are accepted while OpenAI is the sole
// adapter (other providers/models are gated until their adapters exist).
export function parseConfigValue(key: ConfigKey, raw: string): unknown {
  switch (key) {
    case 'embeddings.enabled': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`embeddings.enabled must be true|false`);
    }
    case 'embeddings.provider': {
      if (raw !== 'openai') throw new Error(`embeddings.provider must be 'openai' (only adapter available)`);
      return raw;
    }
    case 'embeddings.model': {
      if (raw !== EMBED_MODEL) throw new Error(`embeddings.model must be '${EMBED_MODEL}' (only model available)`);
      return raw;
    }
    case 'search.rrf_k': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`search.rrf_k must be a positive integer`);
      return n;
    }
    case 'search.graph_hops': {
      const n = Number(raw);
      if (n !== 0 && n !== 1) throw new Error(`search.graph_hops must be 0 or 1`);
      return n;
    }
    case 'gc.retention': {
      parseRetention(raw);
      return raw;
    }
  }
}

export async function loadConfig(client: pg.PoolClient | pg.Client): Promise<BrainConfig> {
  const cfg: BrainConfig = { ...DEFAULT_CONFIG };
  const r = await client.query<{ key: string; value: unknown }>(`SELECT key, value FROM brain_meta.config`);
  for (const row of r.rows) {
    switch (row.key) {
      case 'embeddings.enabled':
        cfg.embeddingsEnabled = row.value === true;
        break;
      case 'embeddings.provider':
        cfg.embeddingsProvider = String(row.value);
        break;
      case 'embeddings.model':
        cfg.embeddingsModel = String(row.value);
        break;
      case 'search.rrf_k':
        cfg.rrfK = Number(row.value);
        break;
      case 'search.graph_hops':
        cfg.graphHops = Number(row.value);
        break;
    }
  }
  return cfg;
}

export async function getConfigRows(
  client: pg.PoolClient | pg.Client,
): Promise<{ key: string; value: unknown }[]> {
  const r = await client.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM brain_meta.config ORDER BY key`,
  );
  return r.rows;
}

export async function setConfig(
  client: pg.PoolClient | pg.Client,
  key: string,
  raw: string,
): Promise<{ key: ConfigKey; value: unknown }> {
  if (!isConfigKey(key)) {
    throw new Error(`unknown config key '${key}'`);
  }
  const value = parseConfigValue(key, raw);
  await client.query(
    `INSERT INTO brain_meta.config (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  return { key, value };
}
