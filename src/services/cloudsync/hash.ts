import type { SyncTimeSlicer } from './drawingActivity.ts';

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

function tryFastStrokePointJson(obj: Record<string, unknown>): string | null {
  if (typeof obj.x !== 'number' || typeof obj.y !== 'number') return null;
  for (const k in obj) {
    if (k !== 'x' && k !== 'y' && k !== 'pressure' && k !== 't') return null;
  }
  let out = '{';
  let first = true;
  if (obj.pressure !== undefined) { out += '"pressure":' + obj.pressure; first = false; }
  if (obj.t !== undefined) { if (!first) out += ','; out += '"t":' + obj.t; first = false; }
  if (!first) out += ',';
  return out + '"x":' + obj.x + ',"y":' + obj.y + '}';
}

type CanonicalFrame =
  | { kind: 'array'; obj: unknown[]; index: number; parts: string[] }
  | { kind: 'object'; obj: Record<string, unknown>; keys: string[]; index: number; parts: string[] };

/**
 * Cooperative time-sliced deterministic JSON canonicalizer.
 * Produces byte-for-byte identical output to `canonicalizeJson`, yielding at
 * slicer checkpoints every ~200 visited nodes so large stroke arrays never block a frame.
 */
export async function canonicalizeJsonAsync(value: unknown, slicer?: SyncTimeSlicer): Promise<string> {
  if (!slicer) return canonicalizeJson(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  const stack: CanonicalFrame[] = [];
  let visited = 0;

  const pushOrInline = (v: unknown): string | null => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      stack.push({ kind: 'array', obj: v, index: 0, parts: [] });
      return null;
    }
    const rec = v as Record<string, unknown>;
    const fast = tryFastStrokePointJson(rec);
    if (fast !== null) return fast;
    const keys = Object.keys(rec);
    if (keys.length === 0) return '{}';
    keys.sort();
    stack.push({ kind: 'object', obj: rec, keys, index: 0, parts: [] });
    return null;
  };

  const attachResult = (serialized: string): string | null => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.kind === 'array') {
        top.parts.push(serialized);
        if (top.index < top.obj.length) return null;
        stack.pop();
        serialized = '[' + top.parts.join(',') + ']';
      } else {
        const key = top.keys[top.index - 1];
        top.parts.push(`${JSON.stringify(key)}:${serialized}`);
        if (top.index < top.keys.length) return null;
        stack.pop();
        serialized = '{' + top.parts.join(',') + '}';
      }
    }
    return serialized;
  };

  const rootInline = pushOrInline(value);
  if (rootInline !== null) return rootInline;

  while (stack.length > 0) {
    if (++visited % 200 === 0 && slicer.shouldYield()) {
      await slicer.checkpoint();
    }
    const top = stack[stack.length - 1];
    if (top.kind === 'array') {
      if (top.index < top.obj.length) {
        const elem = top.obj[top.index++];
        const inline = pushOrInline(elem);
        if (inline !== null) {
          const done = attachResult(inline);
          if (done !== null) return done;
        }
      } else {
        stack.pop();
        const serialized = '[' + top.parts.join(',') + ']';
        const done = attachResult(serialized);
        if (done !== null) return done;
      }
    } else {
      let skippedAll = true;
      while (top.index < top.keys.length) {
        const k = top.keys[top.index++];
        const member = top.obj[k];
        if (member === undefined) continue;
        skippedAll = false;
        const inline = pushOrInline(member);
        if (inline !== null) {
          const done = attachResult(inline);
          if (done !== null) return done;
        }
        break;
      }
      if (skippedAll) {
        stack.pop();
        const serialized = '{' + top.parts.join(',') + '}';
        const done = attachResult(serialized);
        if (done !== null) return done;
      }
    }
  }
  return canonicalizeJson(value);
}

const sharedUtf8Encoder = new TextEncoder();

/**
 * Cooperative time-sliced UTF-8 encoder for large canonical JSON strings.
 * Yields between ~128K code-unit slices without splitting surrogate pairs.
 */
export async function encodeUtf8Async(str: string, slicer?: SyncTimeSlicer): Promise<Uint8Array> {
  const CHUNK_CHARS = 131_072;
  if (!slicer || str.length <= CHUNK_CHARS) {
    return sharedUtf8Encoder.encode(str);
  }
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let offset = 0;
  while (offset < str.length) {
    if (offset > 0 && slicer.shouldYield()) {
      await slicer.checkpoint();
    }
    let end = Math.min(str.length, offset + CHUNK_CHARS);
    if (end < str.length) {
      const code = str.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        end += 1;
      }
    }
    const encoded = sharedUtf8Encoder.encode(str.slice(offset, end));
    chunks.push(encoded);
    totalLength += encoded.byteLength;
    offset = end;
  }
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (i > 0 && slicer.shouldYield()) {
      await slicer.checkpoint();
    }
    result.set(chunks[i], pos);
    pos += chunks[i].byteLength;
  }
  return result;
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(value));
}
