export function shellEscape(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
