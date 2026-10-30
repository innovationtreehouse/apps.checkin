import { createHash, randomUUID } from "node:crypto";
import type { ReceiptFileStore } from "../contract";
import { fileStore } from "../runtime";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const receiptFileKey = (receiptId: string): string => `receipts/${receiptId}`;

/** A mail item's id is assigned at insert, after its object is written, so its key is a fresh UUID. */
export const newMailItemFileKey = (): string => `mail-items/${randomUUID()}`;

/**
 * A row's bytes: from the store when it has a key, else from its own column. Null when neither
 * holds them, including a key whose object is gone.
 */
export async function readStoredFile(row: { fileKey: string | null; fileBlob: Uint8Array | null }): Promise<Uint8Array | null> {
  return row.fileKey ? fileStore().get(row.fileKey) : row.fileBlob;
}

/**
 * Deletes objects no row serves any more. Never throws: the database has already committed, and
 * a leftover object is never served.
 */
export async function deleteStoredFiles(keys: (string | null)[]): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    try {
      await fileStore().delete(key);
    } catch (err) {
      console.error("[receipt] could not delete a stored file:", err);
    }
  }
}

/** In-memory store for tests. Refuses what S3 refuses: a second write to a key, and a body not matching its hash. */
export function createMemoryFileStore(): ReceiptFileStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, bytes, sha256) {
      if (objects.has(key)) throw new Error(`object already exists: ${key}`);
      if (sha256Hex(bytes) !== sha256) throw new Error(`checksum mismatch: ${key}`);
      objects.set(key, new Uint8Array(bytes));
    },
    get: async (key) => objects.get(key) ?? null,
    async delete(key) {
      objects.delete(key);
    },
  };
}
