import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Fail-closed subscription preflight for spawning `claude -p` as a second-opinion <!-- roster-audit-ok: claude-p-flag -->
// reviewer (ROS-155, Codex 2nd-pass finding 1). Env-scrub alone is NOT a
// guarantee: an apiKeyHelper in settings.json or Bedrock/Vertex mode would
// still route the child through API billing. Mirror of runCodexPreflight:
// refuse rather than risk a surprise bill.

type ClaudePreflightCheck =
  | 'env_anthropic_api_key'
  | 'env_anthropic_auth_token'
  | 'env_bedrock_vertex'
  | 'api_key_helper'
  | 'subscription_credential';

export type ClaudePreflightFailure = {
  check: ClaudePreflightCheck;
  actual: string;
  expected: string;
  remedy: string;
};

export type ClaudePreflightResult =
  | { ok: true }
  | { ok: false; failures: ClaudePreflightFailure[] };

export type ClaudePreflightOpts = {
  homeDir: string;
  // The directory the reviewer child will be spawned in. Claude Code resolves
  // project settings from the enclosing project ROOT, not just the cwd, so an
  // apiKeyHelper in any ancestor's .claude/settings(.local).json applies to
  // the child and must refuse (Codex impl-pass round-3 finding 1).
  cwd: string;
  env: NodeJS.ProcessEnv;
  // Seam: on macOS the OAuth credential lives in the Keychain, not a file.
  // Callers that have independently verified a Keychain credential can assert
  // it here; tests use it to simulate the darwin layout.
  assumeKeychainCredential?: boolean;
  // Seam: enterprise managed-settings locations (platform-specific in prod).
  managedSettingsPaths?: string[];
};

// Enterprise managed settings can also configure apiKeyHelper. Check the
// documented locations for both platforms — a missing file is fine, an
// existing one is inspected, an unreadable one fails closed.
const DEFAULT_MANAGED_SETTINGS_PATHS = [
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/etc/claude-code/managed-settings.json',
];

// Claude Code boolean env semantics: '', '0', 'false' mean disabled.
function envFlagSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function envSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

// Returns 'present' | 'absent' | 'unverifiable' for an apiKeyHelper in one
// settings file. Malformed/unreadable files are 'unverifiable' → fail closed.
function apiKeyHelperIn(settingsPath: string): 'present' | 'absent' | 'unverifiable' {
  if (!existsSync(settingsPath)) return 'absent';
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const helper = parsed['apiKeyHelper'];
    return helper !== undefined && helper !== null && helper !== '' ? 'present' : 'absent';
  } catch {
    return 'unverifiable';
  }
}

function hasOauthAccount(homeDir: string): boolean {
  const statePath = join(homeDir, '.claude.json');
  if (!existsSync(statePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const oauth = parsed['oauthAccount'];
    return oauth !== undefined && oauth !== null;
  } catch {
    return false;
  }
}

export function runClaudePreflight(opts: ClaudePreflightOpts): ClaudePreflightResult {
  const { homeDir, cwd, env } = opts;
  const failures: ClaudePreflightFailure[] = [];

  if (envSet(env['ANTHROPIC_API_KEY'])) {
    failures.push({
      check: 'env_anthropic_api_key',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset ANTHROPIC_API_KEY in your shell profile and start a fresh shell — with it set, `claude -p` bills the API, not your subscription.', // <!-- roster-audit-ok: claude-p-flag -->
    });
  }
  if (envSet(env['ANTHROPIC_AUTH_TOKEN'])) {
    failures.push({
      check: 'env_anthropic_auth_token',
      actual: 'exported',
      expected: 'unset',
      remedy: 'Unset ANTHROPIC_AUTH_TOKEN in your shell profile and start a fresh shell.',
    });
  }

  // Any CLAUDE_CODE_USE_* switch routes claude through a third-party provider
  // (Bedrock, Vertex, Foundry, and whatever ships next) billed to a cloud
  // account, not the subscription. Refuse the whole family rather than
  // chasing individual names (Codex impl-pass round-4 finding 1).
  const providerFlags = Object.keys(env)
    .filter((k) => k.startsWith('CLAUDE_CODE_USE_'))
    .filter((k) => envFlagSet(env[k]))
    .sort();
  if (providerFlags.length > 0) {
    failures.push({
      check: 'env_bedrock_vertex',
      actual: `${providerFlags.join(', ')} set`,
      expected: 'no CLAUDE_CODE_USE_* provider switch set',
      remedy: 'Provider mode (Bedrock/Vertex/Foundry/…) bills a cloud account, not your subscription. Unset the flag for this shell or use --host codex|gemini.',
    });
  }

  // apiKeyHelper can hide at user scope, at ANY ancestor's project scope
  // (Claude Code resolves settings from the enclosing project root, so walk
  // the whole ancestry rather than guessing which dir is the root), or in
  // enterprise managed settings.
  const settingsPaths = [join(homeDir, '.claude', 'settings.json')];
  let dir = cwd;
  for (;;) {
    settingsPaths.push(join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  settingsPaths.push(...(opts.managedSettingsPaths ?? DEFAULT_MANAGED_SETTINGS_PATHS));
  for (const p of settingsPaths) {
    const state = apiKeyHelperIn(p);
    if (state === 'absent') continue;
    failures.push({
      check: 'api_key_helper',
      actual: state === 'present' ? `apiKeyHelper in ${p}` : `${p} unreadable/malformed (cannot verify)`,
      expected: 'no apiKeyHelper in any applicable settings file',
      remedy:
        state === 'present'
          ? `Remove apiKeyHelper from ${p} — it routes the spawned reviewer through API billing.`
          : `Fix or remove ${p} so the preflight can verify no apiKeyHelper is configured.`,
    });
  }

  const hasCredential =
    opts.assumeKeychainCredential === true ||
    hasOauthAccount(homeDir) ||
    existsSync(join(homeDir, '.claude', '.credentials.json'));
  if (!hasCredential) {
    failures.push({
      check: 'subscription_credential',
      actual: 'no OAuth credential found',
      expected: `oauthAccount in ${join(homeDir, '.claude.json')} (or ${join(homeDir, '.claude', '.credentials.json')})`,
      remedy: 'Open `claude` and run /login with your Pro/Max subscription, then retry.',
    });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true };
}
