import { createHash, randomUUID } from "node:crypto";
import type { ReceiptFileStore } from "../contract";
import { fileStore } from "../runtime";
import { byDeadline } from "./deadline";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const receiptFileKey = (receiptId: string): string => `receipts/${receiptId}`;

/** The audit action retention writes when it deletes a receipt's file. */
export const RETENTION_FILE_DELETED = "file_deleted";

/** A mail item's id is assigned at insert, after its object is written, so its key is a fresh UUID. */
export const newMailItemFileKey = (): string => `mail-items/${randomUUID()}`;

/** A captured email's raw copy; the key says nothing about the message. */
export const newRawMailKey = (): string => `mail-raw/${randomUUID()}`;

/**
 * A held item's key when the backfill moves it. Derived from what makes the row unique, so a re-run
 * finds the object an interrupted run wrote; hashed, so the key says nothing about the file.
 */
export const backfilledMailItemFileKey = (gmailMessageId: string, attachmentHash: string): string => {
  const h = createHash("sha256").update(`${gmailMessageId}:${attachmentHash}`).digest("hex");
  return `mail-items/${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/**
 * A row's bytes from the store. Null for a row with no key or a key whose object is gone.
 * A store read still out at `deadline` (epoch ms) throws DeadlineError.
 */
export async function readStoredFile(fileKey: string | null, deadline = Infinity): Promise<Uint8Array | null> {
  if (!fileKey) {
    console.error("[receipt] a stored file was read from a row with no file key");
    return null;
  }
  return byDeadline(deadline, "the file store", () => fileStore().get(fileKey));
}

/**
 * Deletes objects no row serves any more. Never throws: the database has already committed, and
 * a leftover object is never served. A delete still out at `deadline` (epoch ms) is abandoned.
 */
export async function deleteStoredFiles(keys: (string | null)[], deadline = Infinity): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    try {
      await byDeadline(deadline, "the file store", () => fileStore().delete(key));
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
