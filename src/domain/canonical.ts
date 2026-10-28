import { InvalidInputError } from './errors';

// C13: one walk, before the hash, shared by ingestion and any later re-hash. A byte cap does
// not replace a depth cap ([[[...]]] is tiny but blows the recursive sort), nor a node cap
// (thousands of keys). Keys are rejected, never escaped or "sanitized" (silent corruption is
// worse than a 4xx). We hash the parsed object, not the raw string.
const MAX_DEPTH = 32;
const MAX_NODES = 2000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deterministic, stable serialization used to derive the eventId. Recursively sorts object
 * keys, normalizes strings to NFC, and enforces C13 in the same pass. Throws InvalidInputError
 * on anything hostile or unrepresentable.
 */
export function canonicalJSON(value: unknown): string {
  let nodes = 0;

  const walk = (v: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) {
      throw new InvalidInputError('input nesting exceeds the maximum depth');
    }
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new InvalidInputError('input has too many nodes');
    }

    if (v === null) {
      return 'null';
    }
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) {
        throw new InvalidInputError('input contains a non-finite number');
      }
      return String(v);
    }
    if (t === 'boolean') {
      return v ? 'true' : 'false';
    }
    if (t === 'string') {
      return JSON.stringify((v as string).normalize('NFC'));
    }
    if (t !== 'object') {
      // bigint, function, symbol, undefined - not representable in the stored JSON
      throw new InvalidInputError(`input contains an unsupported ${t} value`);
    }

    if (Array.isArray(v)) {
      return `[${v.map((item) => walk(item, depth + 1)).join(',')}]`;
    }

    const obj = v as Record<string, unknown>;
    // Normalize keys to NFC BEFORE sorting, so two canonically-equal objects (e.g. the same key
    // in NFC vs NFD) serialize to the same key order. Reject keys that collide after NFC: the
    // representation would otherwise be ambiguous.
    const entries: Array<{ key: string; value: unknown }> = [];
    const seen = new Set<string>();
    for (const rawKey of Object.keys(obj)) {
      if (FORBIDDEN_KEYS.has(rawKey)) {
        throw new InvalidInputError(`input contains a forbidden key: ${rawKey}`);
      }
      if (rawKey.startsWith('$') || rawKey.includes('.')) {
        throw new InvalidInputError(`input contains an invalid key: ${rawKey}`);
      }
      const key = rawKey.normalize('NFC');
      if (seen.has(key)) {
        throw new InvalidInputError(`input has keys that collide after NFC: ${key}`);
      }
      seen.add(key);
      entries.push({ key, value: obj[rawKey] });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const parts = entries.map((e) => `${JSON.stringify(e.key)}:${walk(e.value, depth + 1)}`);
    return `{${parts.join(',')}}`;
  };

  return walk(value, 0);
}
