// Platform shim. Tests override via ROSTER_PLATFORM so we can exercise the
// Codex Windows runtime-injection workaround branch on any host. Same
// override pattern as ROSTER_CLAUDE_HOME / ROSTER_CODEX_HOME / ROSTER_GEMINI_HOME
// in tools.ts.
export type RosterPlatform = NodeJS.Platform;

export function getPlatform(): RosterPlatform {
  const override = process.env['ROSTER_PLATFORM'];
  if (override) return override as RosterPlatform;
  return process.platform;
}

export function isWindows(): boolean {
  return getPlatform() === 'win32';
}
