function ipv4Parts(host: string): [number, number, number, number] | null {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts as [number, number, number, number];
}

export function isNonGlobalIpv4(host: string): boolean {
  const parts = ipv4Parts(host);
  if (parts === null) return false;
  const [first, second, third] = parts;
  return first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || first >= 224
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113);
}

export function isNonGlobalIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!normalized.includes(':')) return false;
  const mappedIpv4 = normalized.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mappedIpv4 !== undefined) return true;
  const mappedHextets = normalized.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mappedHextets !== null) return true;
  const hextets = normalized.split(':');
  const first = Number.parseInt(hextets[0] ?? '', 16);
  const second = Number.parseInt(hextets[1] ?? '', 16);
  const third = Number.parseInt(hextets[2] ?? '', 16);
  return !Number.isInteger(first)
    || first < 0x2000
    || first > 0x3fff
    || (first === 0x2001 && second === 0)
    || (first === 0x2001 && second === 2 && third === 0)
    || (first === 0x2001 && second >= 0x10 && second <= 0x2f)
    || (first === 0x2001 && second === 0xdb8)
    || first === 0x2002
    || (first === 0x3fff && second >= 0 && second <= 0x0fff);
}

export function isNonGlobalIpLiteral(host: string): boolean {
  return isNonGlobalIpv4(host) || isNonGlobalIpv6(host);
}
