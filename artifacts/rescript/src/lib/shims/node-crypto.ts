/**
 * Browser shim for `node:crypto`, aliased in vite.config.ts.
 *
 * @chatoctopus/timeline's adapter-core uses `createHash("md5")` only to derive
 * short, deterministic resource ids from target URLs ("r" + hex.slice(0, 12)).
 * The ids just need to be stable and collision-resistant for a handful of
 * media references, so a deterministic FNV-1a-based hex digest is sufficient —
 * no cryptographic strength required.
 */

function fnv1a(data: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

class Hash {
  private data = "";

  update(chunk: string | Uint8Array): this {
    this.data +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return this;
  }

  digest(_encoding?: string): string {
    // Four seeded FNV-1a passes -> 32 hex chars (md5-length output).
    const parts: string[] = [];
    for (const seed of [0x811c9dc5, 0x01234567, 0x89abcdef, 0xdeadbeef]) {
      parts.push(fnv1a(this.data, seed).toString(16).padStart(8, "0"));
    }
    return parts.join("");
  }
}

export function createHash(_algorithm: string): Hash {
  return new Hash();
}

export default { createHash };
