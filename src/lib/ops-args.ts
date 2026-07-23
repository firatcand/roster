export type ParsedOpsArgs =
  | {
      kind: 'ok';
      subcommand: 'setup';
      backend: 'local' | 'postgres-s3' | undefined;
      database: 'brain' | 'dedicated' | undefined;
      bucket: string | undefined;
      region: string | undefined;
      endpoint: string | undefined;
      forcePathStyle: boolean;
      name: string | undefined;
      newIdentity: boolean;
      json: boolean;
      yes: boolean;
      cwd: string | undefined;
    }
  | { kind: 'usage' }
  | { kind: 'err'; message: string };

export function parseOpsArgs(args: readonly string[]): ParsedOpsArgs {
  const [sub, ...rest] = args;
  if (sub !== 'setup') return { kind: 'usage' };

  let backend: 'local' | 'postgres-s3' | undefined;
  let database: 'brain' | 'dedicated' | undefined;
  let bucket: string | undefined;
  let region: string | undefined;
  let endpoint: string | undefined;
  let forcePathStyle = false;
  let name: string | undefined;
  let newIdentity = false;
  let json = false;
  let yes = false;
  let cwd: string | undefined;

  const value = (flag: string, i: number): string | { kind: 'err'; message: string } => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('-')) return { kind: 'err', message: `${flag} requires a value` };
    return v;
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--backend') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      if (v !== 'local' && v !== 'postgres-s3') {
        return { kind: 'err', message: `--backend must be 'local' or 'postgres-s3' (got '${v}')` };
      }
      backend = v;
      i++;
    } else if (arg === '--database') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      if (v !== 'brain' && v !== 'dedicated') {
        return { kind: 'err', message: `--database must be 'brain' or 'dedicated' (got '${v}')` };
      }
      database = v;
      i++;
    } else if (arg === '--bucket') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      bucket = v;
      i++;
    } else if (arg === '--region') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      region = v;
      i++;
    } else if (arg === '--endpoint') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      endpoint = v;
      i++;
    } else if (arg === '--force-path-style') {
      forcePathStyle = true;
    } else if (arg === '--name') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      name = v;
      i++;
    } else if (arg === '--new-identity') {
      newIdentity = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--cwd') {
      const v = value(arg, i);
      if (typeof v !== 'string') return v;
      cwd = v;
      i++;
    } else {
      return { kind: 'err', message: `unknown flag '${arg}' for 'ops setup'` };
    }
  }

  return {
    kind: 'ok',
    subcommand: 'setup',
    backend,
    database,
    bucket,
    region,
    endpoint,
    forcePathStyle,
    name,
    newIdentity,
    json,
    yes,
    cwd,
  };
}
