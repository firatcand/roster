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
  | 'gc.retention'
  | 'files.bucket'
  | 'files.region'
  | 'files.endpoint'
  | 'files.prefix'
  | 'files.force_path_style';

export const EMBED_MODEL = 'text-embedding-3-small';

export type BrainConfig = {
  embeddingsEnabled: boolean;
  embeddingsProvider: string;
  embeddingsModel: string;
  rrfK: number;
  graphHops: number;
  // S3 file store (ROS-158). All non-secret — the bucket/region/endpoint/prefix
  // are safe to persist; the AWS credentials are ALWAYS read from the
  // environment, never stored here. filesBucket === null ⇒ the feature is off.
  filesBucket: string | null;
  filesRegion: string | null;
  filesEndpoint: string | null;
  filesPrefix: string;
  filesForcePathStyle: boolean;
};

export const DEFAULT_CONFIG: BrainConfig = {
  embeddingsEnabled: false,
  embeddingsProvider: 'openai',
  embeddingsModel: EMBED_MODEL,
  rrfK: 60,
  graphHops: 1,
  filesBucket: null,
  filesRegion: null,
  filesEndpoint: null,
  filesPrefix: '',
  filesForcePathStyle: false,
};

const KEYS: ReadonlySet<string> = new Set<ConfigKey>([
  'embeddings.enabled',
  'embeddings.provider',
  'embeddings.model',
  'search.rrf_k',
  'search.graph_hops',
  'gc.retention',
  'files.bucket',
  'files.region',
  'files.endpoint',
  'files.prefix',
  'files.force_path_style',
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
    case 'files.bucket': {
      // S3 bucket naming: 3-63 chars, lowercase alnum + dot/hyphen, no leading
      // or trailing separator. (Deliberately not enforcing the stricter IP-form
      // and adjacent-dot rules — invalid names surface as a clear S3 error.)
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw)) {
        throw new Error(`files.bucket must be a valid S3 bucket name (3-63 lowercase chars)`);
      }
      return raw;
    }
    case 'files.region': {
      if (!/^[a-z0-9-]+$/.test(raw)) throw new Error(`files.region must be a region token (e.g. us-east-1, auto)`);
      return raw;
    }
    case 'files.endpoint': {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new Error(`files.endpoint must be an http(s) URL`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`files.endpoint must be an http(s) URL`);
      }
      // The brain config is non-secret; credentials are env-only. Reject a URL
      // that smuggles user:pass@host so nothing secret can be persisted here.
      if (u.username || u.password) {
        throw new Error(`files.endpoint must not contain credentials (user:pass@) — S3 credentials are env-only`);
      }
      return raw;
    }
    case 'files.prefix': {
      if (raw.startsWith('/')) throw new Error(`files.prefix must not start with '/'`);
      if (raw.includes('..')) throw new Error(`files.prefix must not contain '..'`);
      if (/\s/.test(raw)) throw new Error(`files.prefix must not contain whitespace`);
      if (raw === '') return '';
      return raw.endsWith('/') ? raw : raw + '/';
    }
    case 'files.force_path_style': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`files.force_path_style must be true|false`);
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
      case 'files.bucket':
        cfg.filesBucket = String(row.value);
        break;
      case 'files.region':
        cfg.filesRegion = String(row.value);
        break;
      case 'files.endpoint':
        cfg.filesEndpoint = String(row.value);
        break;
      case 'files.prefix':
        cfg.filesPrefix = String(row.value);
        break;
      case 'files.force_path_style':
        cfg.filesForcePathStyle = row.value === true;
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
