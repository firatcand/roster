// .env parser. Single source of truth shared by:
//   - resolveAgentEnv (env-merge.ts)        — needs key + value
//   - auditEnvKeyReferences (doctor)        — needs keys only
//
// dotenv-compatible value semantics, minus interpolation and minus
// backtick / multi-line quoting (not needed by current consumers).

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/;

export function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();

  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.replace(/^\s+/, '');
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const candidate = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).replace(/^\s+/, '')
      : trimmed;

    const m = candidate.match(KEY_RE);
    if (m === null) continue;

    const key = m[1]!;
    const valueStr = candidate.slice(m[0].length);
    const parsed = parseValue(valueStr);
    if (parsed === null) continue;

    out.set(key, parsed);
  }

  return out;
}

export function parseEnvKeys(content: string): string[] {
  return Array.from(parseEnvFile(content).keys());
}

function parseValue(src: string): string | null {
  if (src.length === 0) return '';
  const first = src.charAt(0);
  if (first === '"') return parseDoubleQuoted(src);
  if (first === "'") return parseSingleQuoted(src);
  return parseUnquoted(src);
}

function parseDoubleQuoted(src: string): string | null {
  let i = 1;
  let out = '';
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '\\' && i + 1 < src.length) {
      const next = src.charAt(i + 1);
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        default:
          out += '\\' + next;
          break;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      const after = src.slice(i + 1).replace(/^\s+/, '');
      if (after.length === 0 || after.startsWith('#')) return out;
      return null;
    }
    out += c;
    i++;
  }
  return null;
}

function parseSingleQuoted(src: string): string | null {
  const close = src.indexOf("'", 1);
  if (close === -1) return null;
  const after = src.slice(close + 1).replace(/^\s+/, '');
  if (after.length === 0 || after.startsWith('#')) return src.slice(1, close);
  return null;
}

function parseUnquoted(src: string): string {
  let end = src.length;
  for (let i = 0; i < src.length; i++) {
    if (src.charAt(i) === '#' && i > 0 && /\s/.test(src.charAt(i - 1))) {
      end = i;
      break;
    }
  }
  return src.slice(0, end).replace(/\s+$/, '');
}
