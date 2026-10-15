// QB-3 drift detection: re-reads each QuickBooks entry the app created and flags finance when it
// was edited or removed in QuickBooks after posting. Read-only: QuickBooks is never changed.
import { dollarsToCents, sumCents } from "@inventory/money";
import { appKeyOf, qbKey, type QboBill, type QboPurchase } from "@inventory/quickbooks";
import { db } from "../db";
import { getExpenseRuntime } from "../runtime";
import { MATCH_WINDOW_DAYS } from "../services/qbMatchService";
import { raiseFlag } from "../services/flagService";
import { QbExpenseEventSchema } from "../workflows/expense-event-schema";
import { logError } from "./logger";

/** QuickBooks reads per run: one windowed read per checked expense. */
export const MAX_DRIFT_CHECKS_PER_RUN = 25;

export type DriftField = "missing" | "amount" | "key" | "accounts" | "vendor";

/** What the app posted for one expense, as the drain wrote it. */
export interface PostedEntry {
  key: string;
  amountCents: number;
  /** Each line's account id. */
  accounts: string[];
  /** The Bill's Vendor; null on a Purchase, which posts no vendor. */
  vendorId: string | null;
}

const sorted = (ids: (string | undefined)[]) => ids.map((id) => id ?? "").sort();

/** The fields of a QuickBooks entry that no longer match what was posted; `missing` when it is gone. */
export function driftOf(posted: PostedEntry, entry: QboPurchase | QboBill | undefined): DriftField[] {
  if (!entry) return ["missing"];
  const drift: DriftField[] = [];
  if (dollarsToCents(entry.TotalAmt) !== posted.amountCents) drift.push("amount");
  if (appKeyOf(entry) !== posted.key) drift.push("key");
  const accounts = (entry.Line ?? [])
    .filter((l) => l.AccountBasedExpenseLineDetail)
    .map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value);
  if (sorted(accounts).join() !== sorted(posted.accounts).join()) drift.push("accounts");
  if (posted.vendorId !== null && entry.VendorRef?.value !== posted.vendorId) drift.push("vendor");
  return drift;
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

export type DriftCounts = { checked: number; drifted: number; failed: number };

/**
 * The cron's drift step over CREATED expenses (hand-booked MATCHED entries are finance's own).
 * Each expense's entry is read through the windowed reader around its receipt date, padded
 * with the match grace on both sides. Capped; returns counts only.
 */
export async function checkQbDrift(now = new Date()): Promise<DriftCounts | "unbound"> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting) return "unbound";
  const created = await db.expense.findMany({
    where: { qbMatchState: "CREATED", qbTxnId: { not: null }, receiptDate: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true },
  });

  const counts: DriftCounts = { checked: 0, drifted: 0, failed: 0 };
  for (const { id } of todaysSlice(created, MAX_DRIFT_CHECKS_PER_RUN, now)) {
    try {
      const expense = await db.expense.findUniqueOrThrow({ where: { id } });
      const event = await db.expenseEvent.findFirstOrThrow({ where: { expenseId: id } });
      const items = QbExpenseEventSchema.parse(JSON.parse(event.payload)).items;
      const posted: PostedEntry = {
        key: qbKey("expense", id),
        amountCents: sumCents(...items.map((i) => i.totalPriceCents + i.allocatedTaxCents + i.allocatedShippingCents - i.allocatedDiscountCents)),
        accounts: items.map((i) => i.account),
        vendorId: expense.qbTxnEntity === "Bill" ? expense.qbVendorId : null,
      };
      const from = shiftDate(expense.receiptDate!, -MATCH_WINDOW_DAYS);
      const to = shiftDate(expense.receiptDate!, MATCH_WINDOW_DAYS);
      const entries: (QboPurchase | QboBill)[] =
        expense.qbTxnEntity === "Bill" ? await posting.client.billsBetween(from, to) : await posting.client.purchasesBetween(from, to);
      counts.checked++;
      const drift = driftOf(posted, entries.find((e) => e.Id === expense.qbTxnId));
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
