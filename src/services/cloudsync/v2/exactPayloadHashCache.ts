import { sha256Bytes } from '../hash.ts';
import type { SyncTimeSlicer } from '../drawingActivity.ts';

function rangeBytesEqual(a: Uint8Array, b: Uint8Array, start: number, end: number): boolean {
  let i = start;
  // Compare aligned 4-byte words when both views share alignment.
  if ((a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0 && (i & 3) === 0) {
    const wordEnd = i + (((end - i) >> 2) << 2);
    if (wordEnd > i) {
      const wordsA = new Uint32Array(a.buffer, a.byteOffset + i, (wordEnd - i) >> 2);
      const wordsB = new Uint32Array(b.buffer, b.byteOffset + i, (wordEnd - i) >> 2);
      for (let w = 0; w < wordsA.length; w += 1) {
        if (wordsA[w] !== wordsB[w]) return false;
      }
      i = wordEnd;
    }
  }
  for (; i < end; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Memory-only hashes are reusable only after an exact comparison with an
 * owned copy of the previously hashed bytes. Metadata timestamps are not proof. */
export class ExactPayloadHashCache {
  private entries = new Map<string, { bytes: Uint8Array; hash: string }>();
  private size = 0;
  private readonly maxBytes: number;
  constructor(maxBytes = 64 * 1024 * 1024) { this.maxBytes = maxBytes; }

  async hash(key: string, bytes: Uint8Array, slicer?: SyncTimeSlicer): Promise<string> {
    const previous = this.entries.get(key);
    let equal = Boolean(previous && previous.bytes.byteLength === bytes.byteLength);
    if (equal && previous) {
      const SLICE = 262_144;
      if (bytes.length <= SLICE || !slicer) {
        equal = rangeBytesEqual(previous.bytes, bytes, 0, bytes.length);
      } else {
        for (let offset = 0; offset < bytes.length; offset += SLICE) {
          if (offset > 0 && slicer.shouldYield()) await slicer.checkpoint();
          const end = Math.min(bytes.length, offset + SLICE);
          if (!rangeBytesEqual(previous.bytes, bytes, offset, end)) {
            equal = false;
            break;
          }
        }
      }
    }
    if (equal && previous) {
      this.entries.delete(key); this.entries.set(key, previous);
      return previous.hash;
    }
    const owned = bytes.slice();
    if (slicer?.shouldYield()) await slicer.checkpoint();
    const hash = await sha256Bytes(owned);
    if (previous) { this.entries.delete(key); this.size -= previous.bytes.byteLength; }
    if (owned.byteLength <= this.maxBytes) {
      while (this.size + owned.byteLength > this.maxBytes) {
        const oldest = this.entries.keys().next().value!;
        this.size -= this.entries.get(oldest)!.bytes.byteLength;
        this.entries.delete(oldest);
      }
      this.entries.set(key, { bytes: owned, hash }); this.size += owned.byteLength;
    }
    return hash;
  }
}
