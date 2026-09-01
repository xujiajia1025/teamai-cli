import { createHash } from 'node:crypto';

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function normalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(record).sort(compareUtf8)) {
      const child = record[key];
      if (child === undefined) throw new TypeError('Canonical JSON does not support undefined');
      result[key] = normalize(child);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export const canonicalStringify = canonicalJson;

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export const canonicalHash = canonicalSha256;
