import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  // Fail-closed subscription gate. Refusal means "do not spawn".
  preflight(opts: AdapterPreflightOpts): AdapterPreflightResult;
};

export function scrubEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of keys) delete out[k];
  return out;
}

function envSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
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
    scrubEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
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
    // Piped stdin is the prompt in headless mode; no argv needed.
    buildArgv: () => [],
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
