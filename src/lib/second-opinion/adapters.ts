import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolKey } from '../tools.ts';
import { runCodexPreflight } from '../codex-preflight.ts';
import { runClaudePreflight } from './claude-preflight.ts';

// One second-opinion adapter per reviewer host. The review brief ALWAYS
// travels via the child's stdin (written then closed) — never argv (visible
// in `ps` to any local user; Codex 2nd-pass finding 4) and never a temp file
// (headless children may lack file-read tool permission).

export type PreflightIssue = {
  check: string;
  actual: string;
  expected: string;
  remedy: string;
};

export type AdapterPreflightResult = { ok: true } | { ok: false; failures: PreflightIssue[] };

export type AdapterPreflightOpts = {
  homeDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type HostAdapter = {
  key: ToolKey;
  binaryName: string;
  buildArgv(): string[];
  // Defense-in-depth: stripped from the child env AFTER the preflight passes.
  scrubEnvKeys: readonly string[];
  // Prefix families stripped wholesale (e.g. every CLAUDE_CODE_USE_* switch).
  scrubEnvPrefixes?: readonly string[];
  // Fail-closed subscription gate. Refusal means "do not spawn".
  preflight(opts: AdapterPreflightOpts): AdapterPreflightResult;
};

export function scrubEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  prefixes: readonly string[] = [],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of keys) delete out[k];
  for (const k of Object.keys(out)) {
    if (prefixes.some((p) => k.startsWith(p))) delete out[k];
  }
  return out;
}

function envSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

const GEMINI_BILLING_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

// Gemini CLI auto-loads the FIRST dotenv it finds — <dir>/.gemini/.env then
// <dir>/.env, walking up from cwd, falling back to the same pair under $HOME.
// Env-scrub cannot help: the CHILD re-reads that file from disk after spawn
// (Codex impl-pass round-2 finding 1). Replicate the search and refuse if the
// file gemini would load carries a billing key.
export function findGeminiDotenv(cwd: string, homeDir: string): string | null {
  let dir = cwd;
  for (;;) {
    for (const candidate of [join(dir, '.gemini', '.env'), join(dir, '.env')]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of [join(homeDir, '.gemini', '.env'), join(homeDir, '.env')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Minimal dotenv scan: KEY=VALUE lines (optional `export `), comments skipped.
// Returns the billing keys assigned a non-empty value, or null when the file
// cannot be read (caller fails closed).
function billingKeysInDotenv(path: string): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m === null) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    if ((GEMINI_BILLING_KEYS as readonly string[]).includes(key) && value.length > 0 && value !== '""' && value !== "''") {
      found.push(key);
    }
  }
  return found;
}

// Gemini persists the chosen auth method in settings.json — flat v1
// (`selectedAuthType`) or nested v2 (`security.auth.selectedType`). A user who
// once selected Vertex/API-key auth keeps billing that way regardless of env,
// so the preflight must gate on the persisted selection too (Codex impl-pass
// round-5 finding 1). 'present-but-not-oauth' and 'unverifiable' both refuse;
// oauth-personal or no explicit selection (with OAuth creds required
// separately) pass.
const GEMINI_OAUTH_AUTH_TYPES = new Set(['oauth-personal']);

function geminiSelectedAuthProblem(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return `${settingsPath} unreadable/malformed (cannot verify auth selection)`;
  }
  const nested = ((parsed['security'] as Record<string, unknown> | undefined)?.['auth'] as
    | Record<string, unknown>
    | undefined)?.['selectedType'];
  const selected = nested ?? parsed['selectedAuthType'];
  if (selected === undefined || selected === null) return null;
  if (typeof selected === 'string' && GEMINI_OAUTH_AUTH_TYPES.has(selected)) return null;
  return `${settingsPath} selects auth '${String(selected)}'`;
}

function geminiPreflight(opts: AdapterPreflightOpts): AdapterPreflightResult {
  const failures: PreflightIssue[] = [];
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const) {
    if (envSet(opts.env[key])) {
      failures.push({
        check: `env_${key.toLowerCase()}`,
        actual: 'exported',
        expected: 'unset',
        remedy: `Unset ${key} in your shell profile — with it set, headless gemini bills the API, not your Google login.`,
      });
    }
  }
  if (envSet(opts.env['GOOGLE_GENAI_USE_VERTEXAI'])) {
    failures.push({
      check: 'env_google_genai_use_vertexai',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset GOOGLE_GENAI_USE_VERTEXAI — Vertex mode bills a cloud project, not your Google login.',
    });
  }
  // Vertex service-account path (Codex impl-pass finding 1): ADC credentials
  // can route gemini through cloud billing without any *_API_KEY set.
  if (envSet(opts.env['GOOGLE_APPLICATION_CREDENTIALS'])) {
    failures.push({
      check: 'env_google_application_credentials',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset GOOGLE_APPLICATION_CREDENTIALS — service-account credentials bill a cloud project, not your Google login.',
    });
  }
  const dotenv = findGeminiDotenv(opts.cwd, opts.homeDir);
  if (dotenv !== null) {
    const keys = billingKeysInDotenv(dotenv);
    if (keys === null) {
      failures.push({
        check: 'dotenv_unreadable',
        actual: `${dotenv} unreadable (cannot verify)`,
        expected: 'readable dotenv with no billing keys',
        remedy: `Fix permissions on ${dotenv} so the preflight can verify it carries no API/Vertex keys.`,
      });
    } else if (keys.length > 0) {
      failures.push({
        check: 'dotenv_billing_key',
        actual: `${keys.join(', ')} in ${dotenv}`,
        expected: 'no billing keys in the dotenv gemini auto-loads',
        remedy: `Remove ${keys.join('/')} from ${dotenv} (or run from a directory outside its reach) — gemini reloads that file after spawn, bypassing the env scrub.`,
      });
    }
  }
  // Persisted auth selection: system settings (env-pointed override plus the
  // documented platform defaults — Codex impl-pass round-7 finding 1), home
  // settings, and every .gemini/settings.json in the cwd ancestry (workspace
  // settings apply to the child).
  const settingsCandidates = [join(opts.homeDir, '.gemini', 'settings.json')];
  const systemOverride = opts.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
  if (envSet(systemOverride)) settingsCandidates.push(systemOverride!);
  settingsCandidates.push(
    '/Library/Application Support/GeminiCli/settings.json',
    '/etc/gemini-cli/settings.json',
  );
  let settingsDir = opts.cwd;
  for (;;) {
    settingsCandidates.push(join(settingsDir, '.gemini', 'settings.json'));
    const parent = dirname(settingsDir);
    if (parent === settingsDir) break;
    settingsDir = parent;
  }
  for (const candidate of settingsCandidates) {
    const problem = geminiSelectedAuthProblem(candidate);
    if (problem !== null) {
      failures.push({
        check: 'selected_auth_type',
        actual: problem,
        expected: "selectedAuthType 'oauth-personal' (or no explicit selection)",
        remedy: `Re-run \`gemini\` and pick "Login with Google", or fix ${candidate} — the persisted selection routes the child through non-subscription billing regardless of env.`,
      });
    }
  }
  const creds = join(opts.homeDir, '.gemini', 'oauth_creds.json');
  if (!existsSync(creds)) {
    failures.push({
      check: 'subscription_credential',
      actual: 'no OAuth credential found',
      expected: creds,
      remedy: 'Run `gemini` once and authenticate with your Google account, then retry.',
    });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true };
}

const ADAPTERS: Record<ToolKey, HostAdapter> = {
  claude: {
    key: 'claude',
    binaryName: 'claude',
    // Print mode; the brief arrives on stdin. Sole sanctioned occurrence —
    // guarded by runClaudePreflight above (ADR-0002).
    buildArgv: () => ['-p'], // <!-- roster-audit-ok: claude-p-flag -->
    scrubEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    scrubEnvPrefixes: ['CLAUDE_CODE_USE_'],
    preflight: (opts) => {
      const r = runClaudePreflight({ homeDir: opts.homeDir, cwd: opts.cwd, env: opts.env });
      if (r.ok) return { ok: true };
      return { ok: false, failures: r.failures.map((f) => ({ ...f, check: String(f.check) })) };
    },
  },
  codex: {
    key: 'codex',
    binaryName: 'codex',
    // `codex exec -` reads the prompt from stdin. --skip-git-repo-check:
    // second-opinion is workspace-optional; the reviewer may run anywhere.
    buildArgv: () => ['exec', '--skip-git-repo-check', '-'],
    scrubEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    preflight: (opts) => {
      const r = runCodexPreflight({ homeDir: opts.homeDir, env: opts.env });
      if (r.ok) return { ok: true };
      return { ok: false, failures: r.failures.map((f) => ({ ...f, check: String(f.check) })) };
    },
  },
  gemini: {
    key: 'gemini',
    binaryName: 'gemini',
    // -p forces non-interactive mode (bare gemini with piped stdin may still
    // open the TUI; Codex impl-pass round-3 finding 2). The -p value is a
    // static, non-sensitive pointer — the brief itself stays on stdin, which
    // gemini appends to the prompt.
    buildArgv: () => ['-p', 'Follow the review brief provided on stdin and end with the sentinel-framed JSON verdict it specifies.'],
    scrubEnvKeys: [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
    ],
    preflight: geminiPreflight,
  },
};

export function getAdapter(host: ToolKey): HostAdapter {
  return ADAPTERS[host];
}

// Mirror of resolveCodexBinaryPath's chain (override env var → command -v),
// generalized per host and non-throwing: null means "not installed", which
// run.ts maps to BINARY_NOT_FOUND.
export function resolveHostBinary(host: ToolKey, env: NodeJS.ProcessEnv): string | null {
  const overrideVar = `ROSTER_${host.toUpperCase()}_PATH`;
  const fromEnv = env[overrideVar];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const r = spawnSync('/bin/sh', ['-c', `command -v ${host}`], { encoding: 'utf8', env });
  if (r.status === 0) {
    const out = (r.stdout ?? '').trim();
    if (out.length > 0) return out;
  }
  return null;
}
