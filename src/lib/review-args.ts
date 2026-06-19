export type ReviewArgs =
  | {
      kind: 'ok';
      fn?: string;
      json: boolean;
      silent: boolean;
      cwd?: string;
      approve?: string;
      reject?: string;
    }
  | { kind: 'err'; message: string };

export function parseReviewArgs(args: readonly string[]): ReviewArgs {
  let json = false;
  let silent = false;
  let cwd: string | undefined;
  let approve: string | undefined;
  let reject: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg === '--cwd') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--cwd requires a value' };
      cwd = v;
      i++;
    } else if (arg === '--approve') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--approve requires an id or path' };
      approve = v;
      i++;
    } else if (arg === '--reject') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { kind: 'err', message: '--reject requires an id or path' };
      reject = v;
      i++;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for review: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (approve !== undefined && reject !== undefined) {
    return { kind: 'err', message: '--approve and --reject are mutually exclusive' };
  }

  if (positional.length > 1) {
    return { kind: 'err', message: `review accepts at most one function name (got ${positional.length})` };
  }

  const fn = positional[0];
  if (fn !== undefined && !/^[a-z][a-z0-9-]*$/.test(fn)) {
    return { kind: 'err', message: `invalid function name '${fn}' (must match [a-z][a-z0-9-]*)` };
  }

  return { kind: 'ok', ...(fn !== undefined ? { fn } : {}), json, silent, ...(cwd !== undefined ? { cwd } : {}), ...(approve !== undefined ? { approve } : {}), ...(reject !== undefined ? { reject } : {}) };
}
