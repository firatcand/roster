import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigValue,
  isConfigKey,
  DEFAULT_CONFIG,
  setConfig,
  loadConfig,
} from '../src/lib/brain/config.ts';
import { filesConfig } from '../src/lib/brain/s3.ts';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { HAS_DB, createFreshDb } from './brain-helpers.ts';

const dbOpts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

// ---------- config key allowlist ----------

test('config: files.* keys are on the allowlist', () => {
  for (const k of [
    'files.bucket',
    'files.region',
    'files.endpoint',
    'files.prefix',
    'files.force_path_style',
  ]) {
    assert.equal(isConfigKey(k), true, `${k} is a known key`);
  }
  assert.equal(isConfigKey('files.secret'), false, 'unknown files.* key rejected');
});

// ---------- parseConfigValue: files.* validation ----------

test('config: files.bucket accepts valid S3 names, rejects malformed', () => {
  assert.equal(parseConfigValue('files.bucket', 'my-brain-files'), 'my-brain-files');
  assert.equal(parseConfigValue('files.bucket', 'acme.brain.files'), 'acme.brain.files');
  assert.throws(() => parseConfigValue('files.bucket', 'A'), /bucket/i, 'too short / uppercase');
  assert.throws(() => parseConfigValue('files.bucket', 'has_underscore'), /bucket/i);
  assert.throws(() => parseConfigValue('files.bucket', '-leadingdash'), /bucket/i);
});

test('config: files.region accepts a region token, rejects junk', () => {
  assert.equal(parseConfigValue('files.region', 'us-east-1'), 'us-east-1');
  assert.equal(parseConfigValue('files.region', 'auto'), 'auto');
  assert.throws(() => parseConfigValue('files.region', 'US East'), /region/i);
});

test('config: files.endpoint must be an http(s) URL', () => {
  assert.equal(
    parseConfigValue('files.endpoint', 'https://abc123.r2.cloudflarestorage.com'),
    'https://abc123.r2.cloudflarestorage.com',
  );
  assert.equal(parseConfigValue('files.endpoint', 'http://localhost:9000'), 'http://localhost:9000');
  assert.throws(() => parseConfigValue('files.endpoint', 'not a url'), /endpoint/i);
  assert.throws(() => parseConfigValue('files.endpoint', 'ftp://host/x'), /endpoint/i);
});

test('config: files.endpoint rejects embedded credentials (env-only secrets)', () => {
  assert.throws(
    () => parseConfigValue('files.endpoint', 'https://key:secret@s3.example.com'),
    /credential/i,
    'user:pass@ endpoint is refused so no secret can be persisted',
  );
});

test('config: files.prefix normalizes trailing slash and rejects unsafe values', () => {
  assert.equal(parseConfigValue('files.prefix', 'brain'), 'brain/');
  assert.equal(parseConfigValue('files.prefix', 'brain/'), 'brain/');
  assert.equal(parseConfigValue('files.prefix', ''), '');
  assert.throws(() => parseConfigValue('files.prefix', '/leading'), /prefix/i);
  assert.throws(() => parseConfigValue('files.prefix', 'a/../b'), /prefix/i);
});

test('config: files.force_path_style is boolean', () => {
  assert.equal(parseConfigValue('files.force_path_style', 'true'), true);
  assert.equal(parseConfigValue('files.force_path_style', 'false'), false);
  assert.throws(() => parseConfigValue('files.force_path_style', 'yes'), /force_path_style/i);
});

test('config: DEFAULT_CONFIG has the files feature off', () => {
  assert.equal(DEFAULT_CONFIG.filesBucket, null);
  assert.equal(DEFAULT_CONFIG.filesPrefix, '');
  assert.equal(DEFAULT_CONFIG.filesForcePathStyle, false);
});

// ---------- filesConfig: env-gated resolution (resolveEmbedder precedent) ----------

const CREDS = { AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK' };

test('filesConfig: null when no bucket configured', () => {
  assert.equal(filesConfig({ ...DEFAULT_CONFIG }, CREDS as NodeJS.ProcessEnv), null);
});

test('filesConfig: null when bucket set but credentials missing', () => {
  const cfg = { ...DEFAULT_CONFIG, filesBucket: 'b' };
  assert.equal(filesConfig(cfg, {} as NodeJS.ProcessEnv), null);
  assert.equal(filesConfig(cfg, { AWS_ACCESS_KEY_ID: 'AK' } as NodeJS.ProcessEnv), null);
});

test('filesConfig: resolves when bucket + creds present; region falls back to env', () => {
  const cfg = { ...DEFAULT_CONFIG, filesBucket: 'b', filesPrefix: 'brain/' };
  const fc = filesConfig(cfg, { ...CREDS, AWS_REGION: 'eu-west-2' } as NodeJS.ProcessEnv);
  assert.ok(fc);
  assert.equal(fc!.bucket, 'b');
  assert.equal(fc!.region, 'eu-west-2', 'region falls back to AWS_REGION');
  assert.equal(fc!.prefix, 'brain/');
  assert.equal(fc!.forcePathStyle, false);
});

test('filesConfig: explicit files.region beats AWS_REGION; endpoint + path-style pass through', () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    filesBucket: 'b',
    filesRegion: 'auto',
    filesEndpoint: 'https://x.r2.cloudflarestorage.com',
    filesForcePathStyle: true,
  };
  const fc = filesConfig(cfg, { ...CREDS, AWS_REGION: 'us-east-1' } as NodeJS.ProcessEnv);
  assert.ok(fc);
  assert.equal(fc!.region, 'auto');
  assert.equal(fc!.endpoint, 'https://x.r2.cloudflarestorage.com');
  assert.equal(fc!.forcePathStyle, true);
});

// ---------- DB round-trip: files.* persist and reload into BrainConfig ----------

test('config: files.* set → loadConfig round-trips into BrainConfig', dbOpts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    await withBrainClient(pool, async (c) => {
      await setConfig(c, 'files.bucket', 'my-brain-files');
      await setConfig(c, 'files.region', 'auto');
      await setConfig(c, 'files.endpoint', 'https://acct.r2.cloudflarestorage.com');
      await setConfig(c, 'files.prefix', 'team');
      await setConfig(c, 'files.force_path_style', 'true');
    });
    const cfg = await withBrainClient(pool, (c) => loadConfig(c));
    assert.equal(cfg.filesBucket, 'my-brain-files');
    assert.equal(cfg.filesRegion, 'auto');
    assert.equal(cfg.filesEndpoint, 'https://acct.r2.cloudflarestorage.com');
    assert.equal(cfg.filesPrefix, 'team/', 'prefix normalized with trailing slash');
    assert.equal(cfg.filesForcePathStyle, true);

    // And a resolved FilesConfig with creds present.
    const fc = filesConfig(cfg, {
      AWS_ACCESS_KEY_ID: 'AK',
      AWS_SECRET_ACCESS_KEY: 'SK',
    } as NodeJS.ProcessEnv);
    assert.ok(fc);
    assert.equal(fc!.bucket, 'my-brain-files');
    assert.equal(fc!.prefix, 'team/');
  } finally {
    await pool.end();
    await fresh.drop();
  }
});
