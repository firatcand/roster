import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';

// Agent identity: a single kebab segment for top-level infra agents
// (`dreamer`, `chief-of-staff`) OR `<function>/<agent>` for depth-2 agents
// (`gtm/sdr`). ROS-169: top-level agents must load so doctor can audit them.
const AGENT_RE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

// Literal absolute filesystem prefixes that must not appear in workspace-rooted
// refs. Workspace-rooted refs use `/` as a logical root that the loader resolves
// against workspaceRoot — these prefixes would escape that envelope.
const FORBIDDEN_FS_PREFIXES = ['/Users/', '/home/', '/etc/', '/var/', '/tmp/', '/opt/'] as const;

const workspaceRootedPath = z.string().refine(
  (p) => p.startsWith('/') && !FORBIDDEN_FS_PREFIXES.some((pfx) => p.startsWith(pfx)),
  {
    message:
      "must be a workspace-root-relative path starting with '/' " +
      '(rejected: literal absolute fs paths /Users/ /home/ /etc/ /var/ /tmp/ /opt/)',
  },
);

const toolBindingSchema = z
  .object({
    env_var: z.string().regex(ENV_VAR_RE, { message: 'env_var: must be SCREAMING_SNAKE_CASE' }),
    required: z.boolean(),
  })
  .strict();

export const agentConfigSchema = z
  .object({
    agent: z
      .string()
      .regex(AGENT_RE, { message: "agent: must match '<function>/<agent>' with kebab-case segments" }),
    plans_dir: z.string().min(1),
    guideline_refs: z.record(z.string().min(1), workspaceRootedPath).nullish(),
    tools: z.record(z.string().min(1), toolBindingSchema).nullish(),
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export type AgentConfigErrorKind =
  | 'invalid-agent-path'
  | 'missing-file'
  | 'yaml-parse'
  | 'schema'
  | 'agent-field-mismatch'
  | 'ref-not-found'
  | 'ref-shape-mismatch'
  | 'ref-escapes-workspace';

export type AgentConfigError = {
  kind: AgentConfigErrorKind;
  message: string;
  path?: string;
  ref?: string;
};

export type LoadAgentConfigResult =
  | { ok: true; config: AgentConfig; refsChecked: number }
  | { ok: false; errors: AgentConfigError[] };

function isInsideRoot(root: string, p: string): boolean {
  const rel = relative(root, p);
  // Anchor on the separator: a real escape is '..' or starts with '..' + sep.
  // A bare startsWith('..') would false-reject an in-root dir named e.g. '..foo'.
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

export function loadAgentConfig(workspaceRoot: string, agentPath: string): LoadAgentConfigResult {
  if (!AGENT_RE.test(agentPath)) {
    return {
      ok: false,
      errors: [
        {
          kind: 'invalid-agent-path',
          message: `agentPath '${agentPath}' must match '<agent>' or '<function>/<agent>' with kebab-case segments`,
        },
      ],
    };
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          kind: 'missing-file',
          message: `workspaceRoot '${workspaceRoot}' not accessible: ${(err as Error).message}`,
          path: workspaceRoot,
        },
      ],
    };
  }

  const configPath = join(realRoot, agentPath, 'config.yaml');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        errors: [{ kind: 'missing-file', message: `config.yaml not found at ${configPath}`, path: configPath }],
      };
    }
    return {
      ok: false,
      errors: [{ kind: 'missing-file', message: `failed to read ${configPath}: ${e.message}`, path: configPath }],
    };
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [
        { kind: 'yaml-parse', message: `YAML parse error in ${configPath}: ${(err as Error).message}`, path: configPath },
      ],
    };
  }

  const parsed = agentConfigSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        kind: 'schema' as const,
        message: issue.message,
        path: issue.path.length > 0 ? issue.path.join('.') : undefined,
      })),
    };
  }

  const config = parsed.data;
  const errors: AgentConfigError[] = [];

  if (config.agent !== agentPath) {
    errors.push({
      kind: 'agent-field-mismatch',
      message: `agent field '${config.agent}' does not match agentPath argument '${agentPath}'`,
      path: 'agent',
    });
  }

  const refs = config.guideline_refs ?? {};

  for (const [key, ref] of Object.entries(refs)) {
    const wantsDirectory = ref.endsWith('/');
    const stripped = ref.replace(/^\/+/, '');
    const absolute = resolve(realRoot, stripped);

    if (!isInsideRoot(realRoot, absolute)) {
      errors.push({
        kind: 'ref-escapes-workspace',
        message: `guideline_refs.${key}: '${ref}' escapes outside workspace root after resolution`,
        path: `guideline_refs.${key}`,
        ref,
      });
      continue;
    }

    let realAbsolute: string;
    try {
      realAbsolute = realpathSync(absolute);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        errors.push({
          kind: 'ref-not-found',
          message: `guideline_refs.${key}: '${ref}' resolves to ${absolute} which does not exist`,
          path: `guideline_refs.${key}`,
          ref,
        });
      } else {
        errors.push({
          kind: 'ref-not-found',
          message: `guideline_refs.${key}: realpath ${absolute} failed: ${e.message}`,
          path: `guideline_refs.${key}`,
          ref,
        });
      }
      continue;
    }

    if (!isInsideRoot(realRoot, realAbsolute)) {
      errors.push({
        kind: 'ref-escapes-workspace',
        message: `guideline_refs.${key}: '${ref}' resolves via symlink to ${realAbsolute} outside workspace root`,
        path: `guideline_refs.${key}`,
        ref,
      });
      continue;
    }

    let stat;
    try {
      stat = statSync(realAbsolute);
    } catch (err) {
      errors.push({
        kind: 'ref-not-found',
        message: `guideline_refs.${key}: stat ${realAbsolute} failed: ${(err as Error).message}`,
        path: `guideline_refs.${key}`,
        ref,
      });
      continue;
    }

    if (wantsDirectory && !stat.isDirectory()) {
      errors.push({
        kind: 'ref-shape-mismatch',
        message: `guideline_refs.${key}: '${ref}' ends with '/' but ${realAbsolute} is not a directory`,
        path: `guideline_refs.${key}`,
        ref,
      });
    } else if (!wantsDirectory && !stat.isFile()) {
      errors.push({
        kind: 'ref-shape-mismatch',
        message: `guideline_refs.${key}: '${ref}' has no trailing '/' but ${realAbsolute} is not a regular file (add '/' if you meant a directory)`,
        path: `guideline_refs.${key}`,
        ref,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, config, refsChecked: Object.keys(refs).length };
}
