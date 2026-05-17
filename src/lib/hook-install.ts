import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROSTER_ROOT } from './paths.ts';

export type HookHost = 'claude' | 'codex';

export type HookInstallResult = {
  host: HookHost;
  hostHome: string;
  configFile: string;
  hookScript: string;
  status: 'installed' | 'already-present' | 'skipped-host-absent';
  reason?: string;
};

const BANNER_FILENAME = 'roster-banner.sh';
const SESSION_START_MATCHER = '*';

type HookCommandEntry = {
  type: 'command';
  command: string;
};

type MatcherGroup = {
  matcher?: string;
  hooks: HookCommandEntry[];
};

type HooksConfig = {
  SessionStart?: MatcherGroup[];
  [key: string]: MatcherGroup[] | undefined;
};

type ClaudeSettings = {
  hooks?: HooksConfig;
  [key: string]: unknown;
};

type CodexHooksJson = {
  hooks?: HooksConfig;
};

function claudeHome(): string {
  return process.env['ROSTER_CLAUDE_HOME'] ?? join(homedir(), '.claude');
}

function codexHome(): string {
  return process.env['ROSTER_CODEX_HOME'] ?? join(homedir(), '.codex');
}

export function hostHomeFor(host: HookHost): string {
  return host === 'claude' ? claudeHome() : codexHome();
}

function configFileFor(host: HookHost): string {
  return host === 'claude'
    ? join(claudeHome(), 'settings.json')
    : join(codexHome(), 'hooks.json');
}

function hookScriptPathFor(host: HookHost): string {
  return join(hostHomeFor(host), 'hooks', BANNER_FILENAME);
}

function readJsonObject<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return {} as T;
  return JSON.parse(raw) as T;
}

function isRosterBannerCommand(command: string): boolean {
  return command.endsWith(BANNER_FILENAME) || command.endsWith(BANNER_FILENAME.replace('.sh', ''));
}

function sessionStartHasRosterBanner(groups: MatcherGroup[] | undefined): boolean {
  if (!groups) return false;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (hook.type === 'command' && typeof hook.command === 'string' && isRosterBannerCommand(hook.command)) {
        return true;
      }
    }
  }
  return false;
}

function buildBannerEntry(scriptAbsPath: string): MatcherGroup {
  return {
    matcher: SESSION_START_MATCHER,
    hooks: [{ type: 'command', command: `bash ${scriptAbsPath}` }],
  };
}

function copyBannerScript(host: HookHost): string {
  const src = join(ROSTER_ROOT, 'templates', 'hooks', 'banner.sh');
  const dst = hookScriptPathFor(host);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  return dst;
}

function mergeHookIntoConfig<T extends ClaudeSettings | CodexHooksJson>(
  config: T,
  scriptAbsPath: string,
): { config: T; alreadyPresent: boolean } {
  const hooks: HooksConfig = config.hooks ?? {};
  const existing = hooks.SessionStart ?? [];
  if (sessionStartHasRosterBanner(existing)) {
    return { config, alreadyPresent: true };
  }
  const updated: HooksConfig = { ...hooks, SessionStart: [...existing, buildBannerEntry(scriptAbsPath)] };
  const merged = { ...config, hooks: updated } as T;
  return { config: merged, alreadyPresent: false };
}

function writeJsonPretty(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function installHook(host: HookHost): HookInstallResult {
  const hostHome = hostHomeFor(host);
  const configFile = configFileFor(host);

  if (!existsSync(hostHome)) {
    return {
      host,
      hostHome,
      configFile,
      hookScript: hookScriptPathFor(host),
      status: 'skipped-host-absent',
      reason: `${hostHome} does not exist (${host === 'claude' ? 'Claude Code' : 'Codex CLI'} not installed)`,
    };
  }

  const hookScript = copyBannerScript(host);

  if (host === 'claude') {
    const config = readJsonObject<ClaudeSettings>(configFile);
    const { config: merged, alreadyPresent } = mergeHookIntoConfig(config, hookScript);
    if (!alreadyPresent) writeJsonPretty(configFile, merged);
    return {
      host,
      hostHome,
      configFile,
      hookScript,
      status: alreadyPresent ? 'already-present' : 'installed',
    };
  }

  const config = readJsonObject<CodexHooksJson>(configFile);
  const { config: merged, alreadyPresent } = mergeHookIntoConfig(config, hookScript);
  if (!alreadyPresent) writeJsonPretty(configFile, merged);
  return {
    host,
    hostHome,
    configFile,
    hookScript,
    status: alreadyPresent ? 'already-present' : 'installed',
  };
}
