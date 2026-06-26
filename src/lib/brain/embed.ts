import { createHash } from 'node:crypto';
import { EMBED_MODEL, type BrainConfig } from './config.ts';

export const EMBED_DIMS = 1536;

export type Embedder = {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
};

// pgvector literal: [1,2,3]. Validated to exactly EMBED_DIMS finite numbers so a
// bad/short vector never reaches the fixed-width vector(1536) column.
export function toVectorLiteral(vec: number[]): string {
  if (vec.length !== EMBED_DIMS || vec.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`embedding must be exactly ${EMBED_DIMS} finite numbers (got ${vec.length})`);
  }
  return `[${vec.join(',')}]`;
}

// Per-request input cap. A single mount can produce many chunks; batching keeps
// each request well under provider input/token limits.
const OPENAI_BATCH = 96;

export class OpenAIEmbedder implements Embedder {
  readonly model: string;
  readonly dims = EMBED_DIMS;
  #apiKey: string;

  constructor(apiKey: string, model: string = EMBED_MODEL) {
    this.#apiKey = apiKey;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += OPENAI_BATCH) {
      out.push(...(await this.#embedBatch(texts.slice(start, start + OPENAI_BATCH))));
    }
    return out;
  }

  async #embedBatch(batch: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({ model: this.model, input: batch }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings request failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    if (!Array.isArray(json.data) || json.data.length !== batch.length) {
      throw new Error('OpenAI embeddings response shape mismatch');
    }
    return json.data.map((d) => {
      const v = d.embedding;
      if (!Array.isArray(v) || v.length !== EMBED_DIMS || v.some((x) => !Number.isFinite(x))) {
        throw new Error(`OpenAI returned a non-${EMBED_DIMS}-dim or non-finite embedding`);
      }
      return v;
    });
  }
}

// Deterministic, network-free embedder for tests: hashes text into a stable
// 1536-dim unit-ish vector. Same text -> same vector; different text -> different.
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embed';
  readonly dims = EMBED_DIMS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const out = new Array<number>(EMBED_DIMS);
      let seed = createHash('sha256').update(t).digest();
      for (let i = 0; i < EMBED_DIMS; i++) {
        if (i % 32 === 0) seed = createHash('sha256').update(seed).digest();
        out[i] = (seed[i % 32]! - 128) / 128;
      }
      return out;
    });
  }
}

// Resolve the active embedder from config + environment. Returns null (vector
// arm disabled, keyword+graph only) when embeddings are off, the provider isn't
// supported, or no API key is present — never throws, never silently bills.
export function resolveEmbedder(cfg: BrainConfig, env: NodeJS.ProcessEnv = process.env): Embedder | null {
  if (!cfg.embeddingsEnabled) return null;
  if (cfg.embeddingsProvider !== 'openai') return null;
  const key = env.OPENAI_API_KEY;
  if (typeof key !== 'string' || key.length === 0) return null;
  return new OpenAIEmbedder(key, cfg.embeddingsModel);
}
