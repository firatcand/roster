import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROSTER_ROOT } from './paths.ts';

export type HookHost = 'claude' | 'codex';

/** Which hook a result describes. */
export type HookKind = 'session-start' | 'tripwire';

export type HookInstallStatus =
  | 'installed'
  | 'already-present'
  | 'skipped-host-absent'
  | 'skipped-malformed-config';

export type HookInstallResult = {
  host: HookHost;
  kind: HookKind;
  hostHome: string;
  configFile: string;
  hookScript: string;
  status: HookInstallStatus;
  reason?: string;
};

const BANNER_FILENAME = 'roster-banner.sh';
const TRIPWIRE_FILENAME = 'roster-tripwire-hook.mjs';
const TRIPWIRE_ARTIFACT = join('bin', 'tripwire-hook.js');
const SESSION_START_MATCHER = '*';
const TRIPWIRE_MATCHER = '^(?:WebFetch|WebSearch|mcp__.*)$';

type HookCommandEntry = {
  type: 'command';
  command: string;
  // We WRITE shell-form (command only). `args` is read-only here: it lets
  // detection/cleanup recognize + drop entries written by any prior shape
  // (e.g. a dev's exec-form `{command:'node', args:[path]}`), so reinstall never
  // leaves a stale/broken roster hook behind.
  args?: string[];
};

// Single-quote a path for a POSIX shell command string (escaping embedded
// single quotes as '\''). Claude Code's command hooks take a shell command
// STRING (the official docs/plugins use the string form, not an `args` array —
// an `args` field may be silently ignored, which would run bare `node` and
// disable the scan), and the existing banner already uses shell form. Quoting
// keeps home paths with spaces/metacharacters safe.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

type MatcherGroup = {
  matcher?: string;
  hooks: HookCommandEntry[];
};

type HooksConfig = {
  SessionStart?: MatcherGroup[];
  PostToolUse?: MatcherGroup[];
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

function hostHomeFor(host: HookHost): string {
  return host === 'claude' ? claudeHome() : codexHome();
}

function configFileFor(host: HookHost): string {
  return host === 'claude'
    ? join(claudeHome(), 'settings.json')
    : join(codexHome(), 'hooks.json');
}

function bannerScriptPathFor(host: HookHost): string {
  return join(hostHomeFor(host), 'hooks', BANNER_FILENAME);
}

function tripwireScriptPathFor(host: HookHost): string {
  return join(hostHomeFor(host), 'hooks', TRIPWIRE_FILENAME);
}

/** Read a JSON object, distinguishing "absent/empty" (→ {}) from "malformed" (→ null). */
function readJsonObjectGuarded<T extends object>(path: string): { value: T } | { malformed: true } {
  if (!existsSync(path)) return { value: {} as T };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { malformed: true };
  }
  if (raw.trim() === '') return { value: {} as T };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { malformed: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true };
  }
  return { value: parsed as T };
}

function isRosterBannerCommand(command: string): boolean {
  return command.endsWith(BANNER_FILENAME) || command.endsWith(BANNER_FILENAME.replace('.sh', ''));
}

function isRosterTripwireCommand(entry: HookCommandEntry): boolean {
  if (entry.type !== 'command') return false;
  // Detect our filename in EITHER the shell-form command string OR a legacy
  // exec-form `args` array, so stale-repair drops entries of any prior shape.
  const haystack = [entry.command, ...(entry.args ?? [])];
  return haystack.some((s) => typeof s === 'string' && s.includes(TRIPWIRE_FILENAME));
}

function groupHasMatch(
  groups: MatcherGroup[] | undefined,
  pred: (hook: HookCommandEntry) => boolean,
): boolean {
  if (!groups) return false;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (pred(hook)) return true;
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

function buildTripwireCommand(scriptAbsPath: string): string {
  return `node ${shellQuote(scriptAbsPath)}`;
}

function buildTripwireEntry(scriptAbsPath: string): MatcherGroup {
  // SHELL-form command string (Claude Code's documented form) with the path
  // single-quoted; the anchored matcher prevents accidental substring matches.
  return {
    matcher: TRIPWIRE_MATCHER,
    hooks: [{ type: 'command', command: buildTripwireCommand(scriptAbsPath) }],
  };
}

function copyBannerScript(host: HookHost): string {
  const src = join(ROSTER_ROOT, 'templates', 'hooks', 'banner.sh');
  const dst = bannerScriptPathFor(host);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  return dst;
}

function copyTripwireScript(host: HookHost): string {
  const src = join(ROSTER_ROOT, TRIPWIRE_ARTIFACT);
  const dst = tripwireScriptPathFor(host);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  return dst;
}

// Atomic write: temp file in the same dir + rename, so a crash never leaves a
// half-written config.
function writeJsonPrettyAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.roster-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  // NB2: preserve an existing file's mode — the temp file is created with the
  // process umask, which could otherwise loosen a restrictive settings.json.
  try {
    chmodSync(tmp, statSync(path).mode & 0o777);
  } catch {
    // No existing file (or stat failed) → keep the default mode.
  }
  renameSync(tmp, path);
}

type MergeOutcome<T> = { config: T; alreadyPresent: boolean } | { malformedEvent: true };

function mergeBannerIntoConfig<T extends ClaudeSettings | CodexHooksJson>(
  config: T,
  scriptAbsPath: string,
): MergeOutcome<T> {
  if (
    config.hooks !== undefined &&
    (config.hooks === null || typeof config.hooks !== 'object' || Array.isArray(config.hooks))
  ) {
    return { malformedEvent: true };
  }
  const hooks: HooksConfig = config.hooks ?? {};
  const existing = hooks.SessionStart;
  if (existing !== undefined && !Array.isArray(existing)) {
    return { malformedEvent: true };
  }
  if (groupHasMatch(existing, (h) => h.type === 'command' && typeof h.command === 'string' && isRosterBannerCommand(h.command))) {
    return { config, alreadyPresent: true };
  }
  const updated: HooksConfig = {
    ...hooks,
    SessionStart: [...(existing ?? []), buildBannerEntry(scriptAbsPath)],
  };
  return { config: { ...config, hooks: updated } as T, alreadyPresent: false };
}

function mergeTripwireIntoConfig<T extends ClaudeSettings>(
  config: T,
  scriptAbsPath: string,
): MergeOutcome<T> {
  // B3: a present-but-malformed `hooks` (string/array/null) must be left
  // untouched, not spread/clobbered.
  if (
    config.hooks !== undefined &&
    (config.hooks === null || typeof config.hooks !== 'object' || Array.isArray(config.hooks))
  ) {
    return { malformedEvent: true };
  }
  const hooks: HooksConfig = config.hooks ?? {};
  const existing = hooks.PostToolUse;
  if (existing !== undefined && !Array.isArray(existing)) {
    return { malformedEvent: true };
  }
  const groups = existing ?? [];
  const targetCmd = buildTripwireCommand(scriptAbsPath);

  // B2: classify existing roster-tripwire hooks. An entry pointing at the EXACT
  // current path is correct; one ending in our filename at a DIFFERENT (stale)
  // path — e.g. settings copied from another home — must be REPLACED, not
  // treated as already-present (which would leave Claude pointed at a missing
  // script and silently disable the scan).
  let hadExact = false;
  let hadStale = false;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (isRosterTripwireCommand(h)) {
        if (h.command === targetCmd) hadExact = true;
        else hadStale = true;
      }
    }
  }
  if (hadExact && !hadStale) {
    return { config, alreadyPresent: true };
  }

  // Drop ALL roster-tripwire hooks (stale + any exact dup), prune emptied
  // groups, append the fresh entry. Non-roster entries are preserved verbatim.
  const cleaned: MatcherGroup[] = [];
  for (const g of groups) {
    const keptHooks = (g.hooks ?? []).filter((h) => !isRosterTripwireCommand(h));
    if (keptHooks.length > 0) cleaned.push({ ...g, hooks: keptHooks });
  }
  cleaned.push(buildTripwireEntry(scriptAbsPath));
  const updated: HooksConfig = { ...hooks, PostToolUse: cleaned };
  return { config: { ...config, hooks: updated } as T, alreadyPresent: false };
}

function malformedConfigReason(configFile: string): string {
  return `${configFile} is not valid JSON — left untouched to avoid clobbering it`;
}

/**
 * Install the SessionStart banner hook for a host, plus (claude only) the
 * PostToolUse Tripwire scan hook. Each hook reports its own result so the CLI
 * can summarize them independently.
 */
export function installHook(host: HookHost): HookInstallResult[] {
  const hostHome = hostHomeFor(host);
  const configFile = configFileFor(host);

  if (!existsSync(hostHome)) {
    const reason = `${hostHome} does not exist (${host === 'claude' ? 'Claude Code' : 'Codex CLI'} not installed)`;
    const absent = (kind: HookKind, hookScript: string): HookInstallResult => ({
      host,
      kind,
      hostHome,
      configFile,
      hookScript,
      status: 'skipped-host-absent',
      reason,
    });
    const out = [absent('session-start', bannerScriptPathFor(host))];
    if (host === 'claude') out.push(absent('tripwire', tripwireScriptPathFor(host)));
    return out;
  }

  const results: HookInstallResult[] = [];

  // ── SessionStart banner (both hosts) ──────────────────────────────────────
  const bannerScript = copyBannerScript(host);
  const settingsRead = readJsonObjectGuarded<ClaudeSettings>(configFile);
  if ('malformed' in settingsRead) {
    results.push({
      host,
      kind: 'session-start',
      hostHome,
      configFile,
      hookScript: bannerScript,
      status: 'skipped-malformed-config',
      reason: malformedConfigReason(configFile),
    });
    // A malformed config blocks both hooks (they share the file). Report the
    // tripwire skip too (claude only) and bail.
    if (host === 'claude') {
      results.push({
        host,
        kind: 'tripwire',
        hostHome,
        configFile,
        hookScript: tripwireScriptPathFor(host),
        status: 'skipped-malformed-config',
        reason: malformedConfigReason(configFile),
      });
    }
    return results;
  }

  let config: ClaudeSettings = settingsRead.value;
  const bannerMerge = mergeBannerIntoConfig(config, bannerScript);
  if ('malformedEvent' in bannerMerge) {
    results.push({
      host,
      kind: 'session-start',
      hostHome,
      configFile,
      hookScript: bannerScript,
      status: 'skipped-malformed-config',
      reason: `${configFile} has a non-array SessionStart — left untouched`,
    });
  } else {
    config = bannerMerge.config;
    results.push({
      host,
      kind: 'session-start',
      hostHome,
      configFile,
      hookScript: bannerScript,
      status: bannerMerge.alreadyPresent ? 'already-present' : 'installed',
    });
  }

  // ── PostToolUse Tripwire (claude only) ────────────────────────────────────
  if (host === 'claude') {
    const tripwireScript = copyTripwireScript(host);
    const tripwireMerge = mergeTripwireIntoConfig(config, tripwireScript);
    if ('malformedEvent' in tripwireMerge) {
      results.push({
        host,
        kind: 'tripwire',
        hostHome,
        configFile,
        hookScript: tripwireScript,
        status: 'skipped-malformed-config',
        reason: `${configFile} has a non-array PostToolUse — left untouched`,
      });
    } else {
      config = tripwireMerge.config;
      results.push({
        host,
        kind: 'tripwire',
        hostHome,
        configFile,
        hookScript: tripwireScript,
        status: tripwireMerge.alreadyPresent ? 'already-present' : 'installed',
      });
    }
  }

  // Both hooks share one file. If EITHER merge hit a malformed event, we write
  // NOTHING (skip-not-clobber for the whole file) — and downgrade any sibling
  // that reported `installed` to skipped, so the report matches the
  // file-left-untouched reality (reporting `installed` without writing would
  // lie). `already-present` stays accurate (it was present, unchanged).
  const anyMalformed = results.some((r) => r.status === 'skipped-malformed-config');
  if (anyMalformed) {
    for (const r of results) {
      if (r.status === 'installed') {
        r.status = 'skipped-malformed-config';
        r.reason = `${configFile} has a malformed hooks entry — left untouched`;
      }
    }
    return results;
  }

  // One atomic write of the merged config if anything changed.
  const changed = results.some((r) => r.status === 'installed');
  if (changed) writeJsonPrettyAtomic(configFile, config);

  return results;
}
