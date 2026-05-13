export type ParsedDoctorArgs =
  | { kind: 'ok'; json: boolean; silent: boolean }
  | { kind: 'err'; message: string };

export function parseDoctorArgs(args: readonly string[]): ParsedDoctorArgs {
  let json = false;
  let silent = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--silent') silent = true;
  }
  return { kind: 'ok', json, silent };
}
