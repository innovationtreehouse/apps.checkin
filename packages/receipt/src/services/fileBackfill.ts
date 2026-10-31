import type { ReceiptFileStore } from "../contract";
import { db } from "../db";
import { backfilledMailItemFileKey, receiptFileKey, sha256Hex } from "../lib/fileStorage";

const PAGE_SIZE = 50;

export interface FileBackfillReport {
  copied: number;
  /** Rows whose object an earlier, interrupted run had already written. */
  alreadyStored: number;
  /** Rows that lost their bytes or gained a key while being copied. */
  gone: number;
  mismatches: string[];
  failures: string[];
}

export interface FileVerifyReport {
  matched: number;
  noKey: string[];
  missing: string[];
  mismatches: string[];
  failures: string[];
}

interface RowWithBytes {
  label: string;
  fileBlob: Uint8Array;
  fileKey: string | null;
  storedHash: string;
  /** The key this row's object goes under, the same on every run. */
  targetKey: string;
  /** Records the object on the row unless the row changed meanwhile; returns the rows updated. */
  setKey(fileSize: number): Promise<number>;
}

// Each page reads ids only and each row its own bytes, so one file at a time is in memory.
async function* receiptRows(unkeyedOnly: boolean): AsyncGenerator<RowWithBytes> {
  let after: string | undefined;
  for (;;) {
    const page = await db.receipt.findMany({
      where: { fileBlob: { not: null }, ...(unkeyedOnly && { fileKey: null }), ...(after !== undefined && { id: { gt: after } }) },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    if (page.length === 0) return;
    for (const { id } of page) {
      const row = await db.receipt.findUnique({ where: { id }, select: { fileBlob: true, fileKey: true, fileHash: true } });
      if (!row?.fileBlob) continue;
      yield {
        label: `receipt ${id}`,
        fileBlob: row.fileBlob,
        fileKey: row.fileKey,
        storedHash: row.fileHash,
        targetKey: receiptFileKey(id),
        setKey: async (fileSize) =>
          (await db.receipt.updateMany({ where: { id, fileKey: null, fileBlob: { not: null } }, data: { fileKey: receiptFileKey(id), fileSize } })).count,
      };
    }
    after = page[page.length - 1].id;
  }
}

async function* mailItemRows(unkeyedOnly: boolean): AsyncGenerator<RowWithBytes> {
  let after = 0;
  for (;;) {
    const page = await db.receiptMailItem.findMany({
      where: { fileBlob: { not: null }, ...(unkeyedOnly && { fileKey: null }), id: { gt: after } },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    if (page.length === 0) return;
    for (const { id } of page) {
      const row = await db.receiptMailItem.findUnique({ where: { id }, select: { fileBlob: true, fileKey: true, attachmentHash: true, gmailMessageId: true } });
      if (!row?.fileBlob) continue;
      const targetKey = backfilledMailItemFileKey(row.gmailMessageId, row.attachmentHash);
      yield {
        label: `mail item ${id}`,
        fileBlob: row.fileBlob,
        fileKey: row.fileKey,
        storedHash: row.attachmentHash,
        targetKey,
        setKey: async (fileSize) =>
          (await db.receiptMailItem.updateMany({ where: { id, fileKey: null, fileBlob: { not: null } }, data: { fileKey: targetKey, fileSize } })).count,
      };
    }
    after = page[page.length - 1].id;
  }
}

async function* rowsWithBytes(unkeyedOnly: boolean): AsyncGenerator<RowWithBytes> {
  yield* receiptRows(unkeyedOnly);
  yield* mailItemRows(unkeyedOnly);
}

const failure = (label: string, e: unknown): string => `${label}: ${e instanceof Error ? e.name : "unknown error"}`;

/**
 * Copies every row's bytes to the store and records its key; file_blob is never written. Safe to
 * re-run and to stop at any point. A mismatch or failure is reported and leaves its row without a
 * key, so a later run or `--verify` still sees it.
 */
export async function backfillFiles(store: ReceiptFileStore): Promise<FileBackfillReport> {
  const report: FileBackfillReport = { copied: 0, alreadyStored: 0, gone: 0, mismatches: [], failures: [] };
  for await (const row of rowsWithBytes(true)) {
    if (row.fileKey) continue;
    try {
      const hash = sha256Hex(row.fileBlob);
      const existing = await store.get(row.targetKey);
      if (hash !== row.storedHash || (existing && sha256Hex(existing) !== hash)) {
        report.mismatches.push(row.label);
        continue;
      }
      if (!existing) await store.put(row.targetKey, row.fileBlob, hash);
      // ponytail: a row assigned or discarded mid-copy leaves its object unreferenced and never served, as a crash orphan does (design §2).
      if ((await row.setKey(row.fileBlob.length)) === 0) report.gone++;
      else if (existing) report.alreadyStored++;
      else report.copied++;
    } catch (e) {
      report.failures.push(failure(row.label, e));
    }
  }
  return report;
}

/** Compares every stored object with its row's bytes and stored hash. Reads only; repairs nothing. */
export async function verifyFiles(store: ReceiptFileStore): Promise<FileVerifyReport> {
  const report: FileVerifyReport = { matched: 0, noKey: [], missing: [], mismatches: [], failures: [] };
  for await (const row of rowsWithBytes(false)) {
    if (!row.fileKey) {
      report.noKey.push(row.label);
      continue;
    }
    try {
      const object = await store.get(row.fileKey);
      if (!object) report.missing.push(row.label);
      else if (sha256Hex(object) === sha256Hex(row.fileBlob) && sha256Hex(object) === row.storedHash) report.matched++;
      else report.mismatches.push(row.label);
    } catch (e) {
      report.failures.push(failure(row.label, e));
    }
  }
  return report;
}
