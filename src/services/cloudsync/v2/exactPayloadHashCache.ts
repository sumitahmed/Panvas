import { sha256Bytes } from '../hash.ts';

/** Memory-only hashes are reusable only after an exact comparison with an
 * owned copy of the previously hashed bytes. Metadata timestamps are not proof. */
export class ExactPayloadHashCache {
  private entries = new Map<string, { bytes: Uint8Array; hash: string }>();
  private size = 0;
  private readonly maxBytes: number;
  constructor(maxBytes = 64 * 1024 * 1024) { this.maxBytes = maxBytes; }

  async hash(key: string, bytes: Uint8Array): Promise<string> {
    const previous = this.entries.get(key);
    let equal = Boolean(previous && previous.bytes.byteLength === bytes.byteLength);
    if (equal) for (let index = 0; index < bytes.length; index++) {
      if (previous!.bytes[index] !== bytes[index]) { equal = false; break; }
    }
    if (equal && previous) {
      this.entries.delete(key); this.entries.set(key, previous);
      return previous.hash;
    }
    const owned = bytes.slice();
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
