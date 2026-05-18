export type CrontabLine = {
  raw: string;
  lineNumber: number;
  cron: string;
  command: string;
  wrapperPath: string | null;
};

const CRON_FIELD_COUNT = 5;
const ALIASES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually', '@reboot']);

function looksLikeCron(token: string): boolean {
  return ALIASES.has(token) || /^[*0-9,\-/]+$/.test(token);
}

export function parseCrontab(content: string): CrontabLine[] {
  const lines = content.split('\n');
  const out: CrontabLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;

    const tokens = trimmed.split(/\s+/);
    let cron: string;
    let commandTokens: string[];

    if (tokens[0]!.startsWith('@')) {
      if (!ALIASES.has(tokens[0]!)) continue;
      cron = tokens[0]!;
      commandTokens = tokens.slice(1);
    } else {
      if (tokens.length < CRON_FIELD_COUNT + 1) continue;
      const cronTokens = tokens.slice(0, CRON_FIELD_COUNT);
      if (!cronTokens.every(looksLikeCron)) continue;
      cron = cronTokens.join(' ');
      commandTokens = tokens.slice(CRON_FIELD_COUNT);
    }
    if (commandTokens.length === 0) continue;

    const command = commandTokens.join(' ');
    const wrapperPath = extractWrapperPath(command);

    out.push({ raw, lineNumber, cron, command, wrapperPath });
  }

  return out;
}

function extractWrapperPath(command: string): string | null {
  const match = command.match(/(\/[\w\-./]+\.sh)/);
  return match ? match[1]! : null;
}
