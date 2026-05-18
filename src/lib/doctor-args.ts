export type ParsedDoctorArgs =
  | { kind: 'ok'; json: boolean; silent: boolean; fix: boolean }
  | { kind: 'err'; message: string };

export function parseDoctorArgs(args: readonly string[]): ParsedDoctorArgs {
  let json = false;
  let silent = false;
  let fix = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
    else if (arg === '--fix') fix = true;
  }
  return { kind: 'ok', json, silent, fix };
}
