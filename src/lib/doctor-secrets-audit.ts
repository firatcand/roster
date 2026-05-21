import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import { parseEnvFile, parseEnvKeys } from './dotenv-parse.ts';
import { isWindows } from './platform.ts';

// =====================================================================
// .env file permissions (check 11)
// =====================================================================

export type EnvPermissionsResult =
  | { status: 'absent' }
  | { status: 'ok'; path: string; mode: string }
  | { status: 'fail'; path: string; mode: string; expected: '0600'; autoFixable: true }
  | { status: 'skip-platform'; reason: 'win32-mode-bits-not-portable' };

function formatMode(mode: number): string {
  const masked = (mode & 0o777).toString(8);
  return '0' + masked.padStart(3, '0');
}

export function auditEnvPermissions(cwd: string): EnvPermissionsResult {
  if (isWindows()) {
    return { status: 'skip-platform', reason: 'win32-mode-bits-not-portable' };
  }
  const envPath = join(cwd, '.env');
  let st: Stats;
  try {
    st = statSync(envPath);
  } catch {
    return { status: 'absent' };
  }
  if (!st.isFile()) {
    return { status: 'absent' };
  }
  const mode = formatMode(st.mode);
  if ((st.mode & 0o777) === 0o600) {
    return { status: 'ok', path: envPath, mode };
  }
  return { status: 'fail', path: envPath, mode, expected: '0600', autoFixable: true };
}

// =====================================================================
// .env key references in workspace YAML configs (check 12)
// =====================================================================

export type EnvKeyReferenceItem = {
  key: string;
  references: { file: string; line: number }[];
};

export type EnvKeyReferenceResult = {
  status: 'ok' | 'fail';
  envKeys: string[];
  missing: EnvKeyReferenceItem[];
};

// Match ${KEY} or $KEY (where KEY is a valid env-var identifier).
// We deliberately exclude the bare-word form when adjacent to other word
// characters to avoid false positives on identifiers like `$1` or numeric refs.
const VAR_REF_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function extractVarRefs(content: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(VAR_REF_RE)) {
      const key = m[1] ?? m[2] ?? '';
      if (key.length === 0) continue;
      const list = out.get(key);
      if (list) {
        list.push(i + 1);
      } else {
        out.set(key, [i + 1]);
      }
    }
  }
  return out;
}

// Top-level dirs we explicitly skip: roster registry, conventional scaffold
// buckets, and any dotdir. Anything else under cwd is treated as a function/
// dir per the ADR's workspace layout.
const SKIP_TOP = new Set([
  'roster',
  'node_modules',
  'plans',
  'spec',
  'docs',
  'bin',
  'lib',
  'skills',
  'agents',
  'templates',
  'test',
  'src',
]);

function collectConfigYamls(cwd: string): string[] {
  const out: string[] = [];
  let topEntries: string[];
  try {
    topEntries = readdirSync(cwd);
  } catch {
    return [];
  }

  for (const top of topEntries) {
    if (top.startsWith('.')) continue;
    if (SKIP_TOP.has(top)) continue;
    const fnDir = join(cwd, top);
    let st: Stats;
    try {
      st = statSync(fnDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let agents: string[];
    try {
      agents = readdirSync(fnDir);
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (agent.startsWith('.')) continue;
      // ADR layout: <function>/<agent>/projects/<project>/config/<file>.yaml
      const projectsDir = join(fnDir, agent, 'projects');
      let projects: string[];
      try {
        projects = readdirSync(projectsDir);
      } catch {
        continue;
      }
      for (const project of projects) {
        if (project.startsWith('.')) continue;
        const configDir = join(projectsDir, project, 'config');
        let configFiles: string[];
        try {
          configFiles = readdirSync(configDir);
        } catch {
          continue;
        }
        for (const f of configFiles) {
          if (f.endsWith('.yaml') || f.endsWith('.yml')) {
            out.push(join(configDir, f));
          }
        }
      }
    }
  }
  return out;
}

const SHELL_VARS = new Set([
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'ROSTER_ROOT',
]);

export function auditEnvKeyReferences(cwd: string): EnvKeyReferenceResult {
  const envPath = join(cwd, '.env');
  // Mirror resolveAgentEnv (env-merge.ts) semantics: K= in workspace .env is
  // "explicitly unset" — it must NOT satisfy a ${K} reference, or doctor will
  // pass while runtime dispatch fails with a missing-key error.
  let envKeys: string[] = [];
  try {
    const raw = readFileSync(envPath, 'utf8');
    envKeys = Array.from(parseEnvFile(raw).entries())
      .filter(([, v]) => v.length > 0)
      .map(([k]) => k);
  } catch {
    // No .env — anything referenced is missing. If no configs reference
    // anything, status stays ok by virtue of an empty key set.
  }
  const envKeySet = new Set(envKeys);

  const yamls = collectConfigYamls(cwd);
  const missing = new Map<string, { file: string; line: number }[]>();

  for (const yaml of yamls) {
    let content: string;
    try {
      content = readFileSync(yaml, 'utf8');
    } catch {
      continue;
    }
    const refs = extractVarRefs(content);
    for (const [key, lines] of refs) {
      if (envKeySet.has(key)) continue;
      if (SHELL_VARS.has(key)) continue;
      const rel = relative(cwd, yaml);
      const list = missing.get(key);
      const entries = lines.map((line) => ({ file: rel, line }));
      if (list) {
        list.push(...entries);
      } else {
        missing.set(key, entries);
      }
    }
  }

  const items: EnvKeyReferenceItem[] = Array.from(missing.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, references]) => ({ key, references }));

  return {
    status: items.length === 0 ? 'ok' : 'fail',
    envKeys,
    missing: items,
  };
}

// =====================================================================
// Secret-literal scan of installed templates (check 13)
// =====================================================================

export type TemplateSecretLiteralItem = {
  file: string;
  line: number;
  patternId: string;
  snippet: string;
};

export type TemplateSecretLiteralResult = {
  status: 'ok' | 'fail';
  hits: TemplateSecretLiteralItem[];
};

const SECRET_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  // OpenAI-style API key. Real keys are ≥40 chars; ≥20 keeps us conservative
  // against shorter test fixtures while still excluding random `sk-foo` strings.
  { id: 'openai-sk', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'apify', re: /\bapify_api_[A-Za-z0-9]{20,}\b/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub PAT / OAuth / user / refresh / server tokens.
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  // Anthropic API key shape (sk-ant- prefix).
  { id: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
];

function walkFiles(root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
}

function redactSecret(value: string): string {
  if (value.length <= 6) return '***';
  const prefix = value.slice(0, Math.min(6, value.length - 4));
  return prefix + '*'.repeat(Math.max(4, value.length - prefix.length));
}

export function auditTemplateSecretLiterals(rosterRoot: string): TemplateSecretLiteralResult {
  const templatesDir = join(rosterRoot, 'templates');
  const files: string[] = [];
  walkFiles(templatesDir, files);

  const hits: TemplateSecretLiteralItem[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const pat of SECRET_PATTERNS) {
        const m = line.match(pat.re);
        if (m) {
          hits.push({
            file: relative(rosterRoot, file),
            line: i + 1,
            patternId: pat.id,
            // Redact the actual secret in the report — keep the prefix only,
            // mask the rest. doctor's job is to flag the leak, not echo it.
            snippet: line.replace(m[0], redactSecret(m[0])).slice(0, 200),
          });
        }
      }
    }
  }

  return {
    status: hits.length === 0 ? 'ok' : 'fail',
    hits,
  };
}

// =====================================================================
// Prompt-leak audit (check 14) — warn, do not fail
// =====================================================================

export type PromptLeakItem = {
  schedule: string;
  reference: string; // the literal $KEY form
  source: 'spec-doc';
  file: string;
  line: number;
};

export type PromptLeakResult = {
  status: 'ok' | 'warn';
  items: PromptLeakItem[];
};

export function auditPromptLeak(
  cwd: string,
  schedules: ReadonlyArray<{ name: string; tool: 'claude' | 'codex' }>,
): PromptLeakResult {
  const envPath = join(cwd, '.env');
  let envKeys: string[] = [];
  try {
    envKeys = parseEnvKeys(readFileSync(envPath, 'utf8'));
  } catch {
    return { status: 'ok', items: [] };
  }
  const envSet = new Set(envKeys);
  const items: PromptLeakItem[] = [];

  for (const entry of schedules) {
    const specPath = join(cwd, '.roster', 'schedule-specs', `${entry.name}.${entry.tool}.fields.md`);
    let content: string;
    try {
      content = readFileSync(specPath, 'utf8');
    } catch {
      continue;
    }
    const refs = extractVarRefs(content);
    for (const [key, lines] of refs) {
      if (!envSet.has(key)) continue;
      for (const line of lines) {
        items.push({
          schedule: entry.name,
          reference: '$' + key,
          source: 'spec-doc',
          file: relative(cwd, specPath),
          line,
        });
      }
    }
  }

  return {
    status: items.length === 0 ? 'ok' : 'warn',
    items,
  };
}

// =====================================================================
// Aggregate
// =====================================================================

export type SecretsAuditResult = {
  ok: boolean;
  envPermissions: EnvPermissionsResult;
  envKeyReferences: EnvKeyReferenceResult;
  templateSecretLiterals: TemplateSecretLiteralResult;
  promptLeak: PromptLeakResult;
};

export type SecretsAuditOpts = {
  cwd: string;
  rosterRoot: string;
  schedules: ReadonlyArray<{ name: string; tool: 'claude' | 'codex' }>;
};

export function runSecretsAudit(opts: SecretsAuditOpts): SecretsAuditResult {
  const envPermissions = auditEnvPermissions(opts.cwd);
  const envKeyReferences = auditEnvKeyReferences(opts.cwd);
  const templateSecretLiterals = auditTemplateSecretLiterals(opts.rosterRoot);
  const promptLeak = auditPromptLeak(opts.cwd, opts.schedules);

  // Prompt-leak warnings do NOT flip ok (per acceptance: "warns; doesn't fail").
  // skip-platform on env permissions is treated as ok (Windows mode bits are
  // not POSIX; we can't meaningfully check 0600 there).
  const envOk =
    envPermissions.status === 'ok' ||
    envPermissions.status === 'absent' ||
    envPermissions.status === 'skip-platform';
  const ok =
    envOk &&
    envKeyReferences.status === 'ok' &&
    templateSecretLiterals.status === 'ok';

  return {
    ok,
    envPermissions,
    envKeyReferences,
    templateSecretLiterals,
    promptLeak,
  };
}
