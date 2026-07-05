import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fail-closed subscription preflight for spawning `claude -p` as a second-opinion
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
  // The directory the reviewer child will be spawned in. Project-level
  // .claude/settings(.local).json there applies to the child, so an
  // apiKeyHelper hiding in the spawn cwd must also refuse.
  cwd: string;
  env: NodeJS.ProcessEnv;
  // Seam: on macOS the OAuth credential lives in the Keychain, not a file.
  // Callers that have independently verified a Keychain credential can assert
  // it here; tests use it to simulate the darwin layout.
  assumeKeychainCredential?: boolean;
};

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

  const bedrock = envFlagSet(env['CLAUDE_CODE_USE_BEDROCK']);
  const vertex = envFlagSet(env['CLAUDE_CODE_USE_VERTEX']);
  if (bedrock || vertex) {
    failures.push({
      check: 'env_bedrock_vertex',
      actual: bedrock ? 'CLAUDE_CODE_USE_BEDROCK set' : 'CLAUDE_CODE_USE_VERTEX set',
      expected: 'both unset',
      remedy: 'Bedrock/Vertex mode bills a cloud account, not your subscription. Unset the flag for this shell or use --host codex|gemini.',
    });
  }

  // apiKeyHelper can hide at user scope or in the spawn cwd's project scope.
  const settingsPaths = [
    join(homeDir, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
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
