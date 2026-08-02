function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = canonicalValue(source[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const plain = JSON.stringify(value);
  if (plain === undefined) {
    throw new TypeError('The value cannot be represented as canonical JSON.');
  }
  return JSON.stringify(canonicalValue(JSON.parse(plain)));
}
