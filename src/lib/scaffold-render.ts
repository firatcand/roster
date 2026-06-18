import { readFileSync } from 'node:fs';

// A scaffold source file ending in `.template` (optionally before a real
// extension, e.g. `project.yaml.template`) is rendered with {{VAR}} substitution
// and written under its stripped name. Everything else is copied verbatim.
export const TEMPLATE_SUFFIX_RE = /\.template(\.[^.]+)?$/;

export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export function isTemplateName(name: string): boolean {
  return TEMPLATE_SUFFIX_RE.test(name);
}

export function destNameFor(name: string): string {
  return name.replace(TEMPLATE_SUFFIX_RE, '$1');
}

// The exact bytes roster writes to disk for a scaffold source file: substituted
// for *.template, raw otherwise. init and upgrade share this so the manifest
// hash (taken over the rendered output) is consistent across both.
export function renderScaffoldFile(srcPath: string, name: string, vars: Record<string, string>): string {
  const raw = readFileSync(srcPath, 'utf8');
  return isTemplateName(name) ? substitute(raw, vars) : raw;
}
