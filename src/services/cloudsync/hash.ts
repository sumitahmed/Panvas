/**
 * Content hashing for the sync core. SHA-256 via WebCrypto in the browser /
 * Electron renderer, node:crypto in tests/Node. Canonical JSON input must be
 * produced by canonicalizeJson BEFORE hashing (stable key order) so hashes
 * are deterministic across platforms.
 */

export async function sha256Hex(input: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(input));
}

/** SHA-256 for the exact bytes stored in the content-addressed object. */
export async function sha256Bytes(input: Uint8Array): Promise<string> {
  const globalCrypto = typeof globalThis !== 'undefined'
    ? ((globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle ?? null)
    : null;
  if (globalCrypto) {
    const digest = await globalCrypto.digest('SHA-256', input as BufferSource);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

const canonicalJsonCache = new WeakMap<object, string>();

/** Deterministic JSON: recursively sorted object keys, no whitespace. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const cached = canonicalJsonCache.get(value);
  if (cached !== undefined) return cached;

  let result: string;
  if (Array.isArray(value)) {
    const len = value.length;
    if (len === 0) {
      result = '[]';
    } else {
      let out = '[';
      for (let i = 0; i < len; i++) {
        if (i > 0) out += ',';
        out += canonicalizeJson(value[i]);
      }
      result = out + ']';
    }
  } else {
    const obj = value as Record<string, unknown>;
    // Fast path for StrokePoint objects: { x, y, pressure?, t? }
    if (typeof obj.x === 'number' && typeof obj.y === 'number') {
      let onlyPointKeys = true;
      for (const k in obj) {
        if (k !== 'x' && k !== 'y' && k !== 'pressure' && k !== 't') {
          onlyPointKeys = false;
          break;
        }
      }
      if (onlyPointKeys) {
        let out = '{';
        let first = true;
        if (obj.pressure !== undefined) { out += '"pressure":' + obj.pressure; first = false; }
        if (obj.t !== undefined) { if (!first) out += ','; out += '"t":' + obj.t; first = false; }
        if (!first) out += ',';
        out += '"x":' + obj.x + ',"y":' + obj.y + '}';
        canonicalJsonCache.set(value, out);
        return out;
      }
    }

    const keys = Object.keys(obj);
    const numKeys = keys.length;
    if (numKeys === 0) {
      result = '{}';
    } else {
      keys.sort();
      let out = '{';
      let first = true;
      for (let i = 0; i < numKeys; i++) {
        const k = keys[i];
        const member = obj[k];
        if (member === undefined) continue;
        if (!first) out += ',';
        first = false;
        out += `${JSON.stringify(k)}:${canonicalizeJson(member)}`;
      }
      result = out + '}';
    }
  }

  canonicalJsonCache.set(value, result);
  return result;
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(value));
}
