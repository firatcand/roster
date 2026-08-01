export type ParsedValidateArgs =
  | { kind: 'ok'; target?: string; json: boolean }
  | { kind: 'err'; message: string };

export function parseValidateArgs(args: readonly string[]): ParsedValidateArgs {
  let target: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) return { kind: 'err', message: `unknown flag '${arg}' for 'validate'` };
    else if (target === undefined) target = arg;
    else return { kind: 'err', message: `'validate' accepts at most one target` };
  }
  return { kind: 'ok', ...(target === undefined ? {} : { target }), json };
}
