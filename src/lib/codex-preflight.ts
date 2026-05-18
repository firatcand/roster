import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubscriptionAttestation } from './schedule-schema.ts';

export type PreflightCheck =
  | 'auth_mode'
  | 'openai_api_key_in_auth'
  | 'env_codex_api_key'
  | 'env_openai_api_key'
  | 'env_anthropic_api_key'
  | 'config_model_providers'
  | 'config_active_model_provider'
  | 'codex_home';

export type PreflightFailure = {
  check: PreflightCheck;
  actual: string;
  expected: string;
  remedy: string;
};

export type PreflightResult =
  | { ok: true; attestation: SubscriptionAttestation }
  | { ok: false; failures: PreflightFailure[] };

export type PreflightOpts = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
};

type AuthJson = {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
};

type TomlScan = {
  modelProviders: string[];
  activeModelProvider: string | null;
  malformed: boolean;
};

function readAuthJson(codexHome: string): { ok: true; data: AuthJson } | { ok: false; reason: 'missing' | 'unreadable' | 'malformed'; message: string } {
  const authPath = join(codexHome, 'auth.json');
  if (!existsSync(authPath)) {
    return { ok: false, reason: 'missing', message: `${authPath} not found` };
  }
  let raw: string;
  try {
    raw = readFileSync(authPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, reason: 'unreadable', message: `${e.code ?? 'unknown'} reading ${authPath}` };
  }
  try {
    const parsed = JSON.parse(raw) as AuthJson;
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'malformed', message: `${authPath} is not valid JSON` };
  }
}

// Minimal TOML scanner targeted at the two patterns we care about:
//   [model_providers.<name>]   — provider table definitions
//   model_provider = "<name>"  — top-level active-provider selector
// Strings, multi-line values, and inline tables are not parsed; codex config.toml
// uses these two patterns in their canonical form.
function scanConfigToml(codexHome: string): TomlScan {
  const cfgPath = join(codexHome, 'config.toml');
  if (!existsSync(cfgPath)) {
    return { modelProviders: [], activeModelProvider: null, malformed: false };
  }
  let raw: string;
  try {
    raw = readFileSync(cfgPath, 'utf8');
  } catch {
    return { modelProviders: [], activeModelProvider: null, malformed: true };
  }

  const modelProviders: string[] = [];
  let activeModelProvider: string | null = null;
  let currentSection: string | null = null;

  const sectionRe = /^\[([^\]]+)\]\s*(?:#.*)?$/;
  // Permissive key-detector: catch any `model_provider = ...` line at the
  // start of file scope. We deliberately do NOT try to fully parse TOML's
  // string forms (basic strings, literal strings, multiline """..."""/'''...''',
  // unicode escapes). Instead we recognize the safe single-line forms
  // explicitly; anything else fails closed with the raw rest-of-line as the
  // "actual" value (codex review impl-pass: multiline string forms would
  // otherwise bypass the safe-value match entirely).
  const providerKeyRe = /^model_provider\s*=\s*(.*?)\s*$/;
  const safeValueRe = /^(?:"openai"|'openai')(?:\s*#.*)?$/;

  for (const rawLine of raw.split('\n')) {
    const stripped = rawLine.trim();
    if (stripped.length === 0) continue;
    if (stripped.startsWith('#')) continue;

    const sectionMatch = stripped.match(sectionRe);
    if (sectionMatch !== null) {
      const section = sectionMatch[1]!.trim();
      currentSection = section;
      if (section.startsWith('model_providers.')) {
        const name = section.slice('model_providers.'.length);
        if (name.length > 0) modelProviders.push(name);
      }
      continue;
    }

    if (currentSection === null) {
      const keyMatch = stripped.match(providerKeyRe);
      if (keyMatch !== null) {
        const rawValue = keyMatch[1] ?? '';
        if (rawValue.match(safeValueRe) !== null) {
          activeModelProvider = 'openai';
        } else {
          // Fail-closed: anything not exactly "openai"/'openai' is suspicious.
          // Multiline strings, custom providers, env-substituted refs — all
          // surface as the raw value for the failure remedy.
          activeModelProvider = rawValue.length > 0 ? rawValue : '<empty>';
        }
      }
    }
  }

  return { modelProviders, activeModelProvider, malformed: false };
}

export function runCodexPreflight(opts: PreflightOpts): PreflightResult {
  const { homeDir, env } = opts;
  const codexHome = join(homeDir, '.codex');
  const failures: PreflightFailure[] = [];

  // Checks 1 + 2: auth.json
  const auth = readAuthJson(codexHome);
  if (!auth.ok) {
    failures.push({
      check: 'auth_mode',
      actual: auth.reason,
      expected: `${codexHome}/auth.json with auth_mode='chatgpt'`,
      remedy: `Run \`codex login\` to authenticate via your ChatGPT subscription (${auth.message}).`,
    });
  } else {
    if (auth.data.auth_mode !== 'chatgpt') {
      failures.push({
        check: 'auth_mode',
        actual: String(auth.data.auth_mode),
        expected: "'chatgpt'",
        remedy: 'Re-run `codex login` and pick the ChatGPT subscription option (not API key).',
      });
    }
    const apiKeyInAuth = auth.data.OPENAI_API_KEY;
    if (apiKeyInAuth !== null && apiKeyInAuth !== undefined && apiKeyInAuth !== '') {
      failures.push({
        check: 'openai_api_key_in_auth',
        actual: 'set',
        expected: 'null or absent',
        remedy: 'Delete the OPENAI_API_KEY field from ~/.codex/auth.json or re-run `codex login` to restore subscription auth.',
      });
    }
  }

  // Checks 3-5: shell env API-key vars (any of these would silently switch billing)
  if (env['CODEX_API_KEY'] !== undefined && env['CODEX_API_KEY'] !== '') {
    failures.push({
      check: 'env_codex_api_key',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset CODEX_API_KEY in your shell profile (~/.zshrc, ~/.bashrc, etc.) and start a fresh shell.',
    });
  }
  if (env['OPENAI_API_KEY'] !== undefined && env['OPENAI_API_KEY'] !== '') {
    failures.push({
      check: 'env_openai_api_key',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset OPENAI_API_KEY in your shell profile and start a fresh shell.',
    });
  }
  if (env['ANTHROPIC_API_KEY'] !== undefined && env['ANTHROPIC_API_KEY'] !== '') {
    failures.push({
      check: 'env_anthropic_api_key',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset ANTHROPIC_API_KEY in your shell profile and start a fresh shell.',
    });
  }

  // Checks 6-7: config.toml
  const scan = scanConfigToml(codexHome);
  if (scan.malformed) {
    failures.push({
      check: 'config_model_providers',
      actual: 'unreadable',
      expected: 'absent or readable with no non-default providers',
      remedy: `Fix permissions on ${codexHome}/config.toml or remove it.`,
    });
  } else {
    if (scan.modelProviders.length > 0) {
      failures.push({
        check: 'config_model_providers',
        actual: `[model_providers.${scan.modelProviders.join(', model_providers.')}]`,
        expected: 'no [model_providers.*] table',
        remedy: `Remove non-default [model_providers.*] blocks from ${codexHome}/config.toml.`,
      });
    }
    if (scan.activeModelProvider !== null && scan.activeModelProvider !== 'openai') {
      failures.push({
        check: 'config_active_model_provider',
        actual: `model_provider = ${scan.activeModelProvider}`,
        expected: 'unset or model_provider = "openai" (single-line form only)',
        remedy: `Remove the top-level model_provider key from ${codexHome}/config.toml, or set it to the single-line form: model_provider = "openai".`,
      });
    }
  }

  // Check 8: CODEX_HOME env var
  const expectedCodexHome = codexHome;
  const actualCodexHome = env['CODEX_HOME'];
  if (actualCodexHome !== undefined && actualCodexHome !== '' && actualCodexHome !== expectedCodexHome) {
    failures.push({
      check: 'codex_home',
      actual: actualCodexHome,
      expected: `unset or ${expectedCodexHome}`,
      remedy: `Unset CODEX_HOME in your shell profile (or set it to ${expectedCodexHome}).`,
    });
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  return {
    ok: true,
    attestation: {
      auth_mode: 'chatgpt',
      env_policy: 'cleared',
      codex_home: codexHome,
    },
  };
}
