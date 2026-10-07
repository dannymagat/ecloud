/**
 * Deterministic serialisation for `policy_translations.input_snapshot` (POLICY_ENGINE.md §2.9):
 * keys sorted, bigint as decimal string, Date as ISO string, `undefined` dropped. The SHA-256 of
 * the canonical form is the `policy_version` hash exposed on resolution results.
 */
import { createHash } from 'node:crypto';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = toJsonValue(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as JsonValue;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
