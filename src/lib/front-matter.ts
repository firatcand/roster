import { parse as parseYaml } from 'yaml';

export type FrontMatterResult = {
  frontMatter: Record<string, unknown>;
  body: string;
};

const DELIM = '---';

export function parseFrontMatter(content: string): FrontMatterResult {
  const stripped = content.replace(/^﻿/, '');
  if (!stripped.startsWith(DELIM)) {
    return { frontMatter: {}, body: stripped };
  }

  const lines = stripped.split('\n');
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontMatter: {}, body: stripped };
  }

  const yamlBlock = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n');

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch {
    return { frontMatter: {}, body };
  }

  const frontMatter =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return { frontMatter, body };
}
