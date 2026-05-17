export type ReviewArgs =
  | { kind: 'ok'; fn?: string; json: boolean; silent: boolean }
  | { kind: 'err'; message: string };

export function parseReviewArgs(args: readonly string[]): ReviewArgs {
  let json = false;
  let silent = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg.startsWith('-')) {
      return { kind: 'err', message: `unknown flag for review: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    return { kind: 'err', message: `review accepts at most one function name (got ${positional.length})` };
  }

  const fn = positional[0];
  if (fn !== undefined && !/^[a-z][a-z0-9-]*$/.test(fn)) {
    return { kind: 'err', message: `invalid function name '${fn}' (must match [a-z][a-z0-9-]*)` };
  }

  return fn !== undefined
    ? { kind: 'ok', fn, json, silent }
    : { kind: 'ok', json, silent };
}
