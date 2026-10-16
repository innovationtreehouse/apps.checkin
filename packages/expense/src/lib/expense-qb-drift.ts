// QB-3 drift detection: re-reads each QuickBooks entry the app created or matched and flags finance
// when it was edited or removed in QuickBooks afterwards. Read-only: QuickBooks is never changed.
import { dollarsToCents, sumCents } from "@inventory/money";
import { appKeyOf, qbKey, type QboBill, type QboPurchase } from "@inventory/quickbooks";
import type { ExpensePosting } from "../contract";
import { db } from "../db";
import { getExpenseRuntime } from "../runtime";
import { MATCH_WINDOW_DAYS } from "../services/qbMatchService";
import { raiseFlag } from "../services/flagService";
import { QbExpenseEventSchema } from "../workflows/expense-event-schema";
import { logError } from "./logger";

/** QuickBooks reads per run: one windowed read per checked expense. */
export const MAX_DRIFT_CHECKS_PER_RUN = 25;

export type DriftField = "missing" | "amount" | "key" | "accounts" | "vendor";

/** What the app expects of one expense's entry: as the drain posted it, or as it was when matched. */
export interface PostedEntry {
  /** The entry's app key; undefined on a hand-booked entry, which carries none. */
  key: string | undefined;
  amountCents: number;
  /** Each line's account id. */
  accounts: string[];
  /** The Bill's Vendor; null when the entry has none to check. */
  vendorId: string | null;
}

const sorted = (ids: (string | undefined)[]) => ids.map((id) => id ?? "").sort();

const lineAccounts = (entry: QboPurchase | QboBill) =>
  (entry.Line ?? []).filter((l) => l.AccountBasedExpenseLineDetail).map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value);

/** The fields of a QuickBooks entry that no longer match what was posted; `missing` when it is gone. */
export function driftOf(posted: PostedEntry, entry: QboPurchase | QboBill | undefined): DriftField[] {
  if (!entry) return ["missing"];
  const drift: DriftField[] = [];
  if (dollarsToCents(entry.TotalAmt) !== posted.amountCents) drift.push("amount");
  if (appKeyOf(entry) !== posted.key) drift.push("key");
  if (sorted(lineAccounts(entry)).join() !== sorted(posted.accounts).join()) drift.push("accounts");
  if (posted.vendorId !== null && entry.VendorRef?.value !== posted.vendorId) drift.push("vendor");
  return drift;
}

/** A matched entry's baseline: the entry as QuickBooks holds it now. */
export function baselineOf(entry: QboPurchase | QboBill): PostedEntry {
  return {
    key: appKeyOf(entry),
    amountCents: dollarsToCents(entry.TotalAmt),
    accounts: sorted(lineAccounts(entry)),
    vendorId: entry.VendorRef?.value ?? null,
  };
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The slice of `ids` to check today. The start moves by the cap each UTC day, so every entry
 * is checked within ceil(n / cap) days without storing a cursor.
 */
export function todaysSlice<T>(ids: T[], cap: number, now = new Date()): T[] {
  if (ids.length <= cap) return ids;
  const start = (Math.floor(now.getTime() / 86_400_000) * cap) % ids.length;
  return [...ids, ...ids].slice(start, start + cap);
}

/**
 * Raises QB_DRIFT with the drifted field names. Drift finance already checked off with the
 * same fields stays checked off; different drift reopens the flag.
 */
async function flagDrift(expenseId: string, drift: DriftField[]): Promise<void> {
  const detail = drift.join(", ");
  const existing = await db.expenseFlag.findFirst({ where: { expenseId, kind: "QB_DRIFT" } });
  if (existing?.checkedOffAt && existing.detail === detail) return;
  await raiseFlag(expenseId, "QB_DRIFT", detail);
}

/** The entry `qbTxnId` through the windowed reader around `receiptDate`; undefined when it is gone. */
async function readEntry(posting: ExpensePosting, entity: string | null, qbTxnId: string, receiptDate: string): Promise<QboPurchase | QboBill | undefined> {
  const from = shiftDate(receiptDate, -MATCH_WINDOW_DAYS);
  const to = shiftDate(receiptDate, MATCH_WINDOW_DAYS);
  const entries: (QboPurchase | QboBill)[] = entity === "Bill" ? await posting.client.billsBetween(from, to) : await posting.client.purchasesBetween(from, to);
  return entries.find((e) => e.Id === qbTxnId);
}

/**
 * The baseline to store on a match, as JSON. Null when QuickBooks is unbound or the read fails;
 * the drift check then takes it on its first read.
 */
export async function matchBaseline(entity: string, qbTxnId: string, receiptDate: string | null): Promise<string | null> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting || !receiptDate) return null;
  try {
    const entry = await readEntry(posting, entity, qbTxnId, receiptDate);
    return entry ? JSON.stringify(baselineOf(entry)) : null;
  } catch (err) {
    logError("qb_match_baseline_failed", { qbTxnId }, err);
    return null;
  }
}

export type DriftCounts = { checked: number; drifted: number; failed: number };

/** What the drain posted for a CREATED expense, read from its outbox event. */
async function postedEntry(id: string, vendorId: string | null): Promise<PostedEntry> {
  const event = await db.expenseEvent.findFirstOrThrow({ where: { expenseId: id } });
  const items = QbExpenseEventSchema.parse(JSON.parse(event.payload)).items;
  return {
    key: qbKey("expense", id),
    amountCents: sumCents(...items.map((i) => i.totalPriceCents + i.allocatedTaxCents + i.allocatedShippingCents - i.allocatedDiscountCents)),
    accounts: items.map((i) => i.account),
    vendorId,
  };
}

/**
 * The cron's drift step over CREATED and MATCHED expenses. A created entry is compared with what
 * the drain posted, a matched one with its baseline; a matched entry with no baseline stores one
 * on this read and raises nothing. Each entry is read through the windowed reader around the
 * receipt date, padded with the match grace on both sides. Capped; returns counts only.
 */
export async function checkQbDrift(now = new Date()): Promise<DriftCounts | "unbound"> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting) return "unbound";
  const inQb = await db.expense.findMany({
    where: { qbMatchState: { in: ["CREATED", "MATCHED"] }, qbTxnId: { not: null }, receiptDate: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true },
  });

  const counts: DriftCounts = { checked: 0, drifted: 0, failed: 0 };
  for (const { id } of todaysSlice(inQb, MAX_DRIFT_CHECKS_PER_RUN, now)) {
    try {
      const expense = await db.expense.findUniqueOrThrow({ where: { id } });
      const expected =
        expense.qbMatchState === "CREATED"
          ? await postedEntry(id, expense.qbTxnEntity === "Bill" ? expense.qbVendorId : null)
          : expense.qbMatchBaseline
            ? (JSON.parse(expense.qbMatchBaseline) as PostedEntry)
            : null;
      const entry = await readEntry(posting, expense.qbTxnEntity, expense.qbTxnId!, expense.receiptDate!);
      counts.checked++;
      if (!expected && entry) {
        await db.expense.update({ where: { id }, data: { qbMatchBaseline: JSON.stringify(baselineOf(entry)) } });
        continue;
      }
      const drift: DriftField[] = expected ? driftOf(expected, entry) : ["missing"];
      if (drift.length === 0) continue;
      counts.drifted++;
      await flagDrift(id, drift);
    } catch (err) {
      counts.failed++;
      logError("qb_drift_check_failed", { expenseId: id }, err);
    }
  }
  return counts;
}
