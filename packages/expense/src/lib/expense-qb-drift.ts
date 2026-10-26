// QB-3 drift detection: re-reads each QuickBooks entry the app created or matched and flags finance
// when it was edited or removed in QuickBooks afterwards. Read-only: QuickBooks is never changed.
import { dollarsToCents, sumCents } from "@checkin/money";
import { appKeyOf, qbKey, type QboBill, type QboPurchase } from "@checkin/quickbooks";
import type { ExpensePosting } from "../contract";
import { db } from "../db";
import { getExpenseRuntime } from "../runtime";
import { MATCH_WINDOW_DAYS } from "../services/qbMatchService";
import { raiseFlag } from "../services/flagService";
import { lineCents } from "../qb-write";
import { logError } from "./logger";

/** QuickBooks reads per run: one windowed read per checked expense. */
export const MAX_DRIFT_CHECKS_PER_RUN = 25;

export type DriftField = "missing" | "amount" | "date" | "key" | "accounts" | "vendor";

/** What the app expects of one expense's entry: as the drain posted it, or as it was when matched. */
export interface PostedEntry {
  /** The entry's app key; undefined on a hand-booked entry, which carries none. */
  key: string | undefined;
  amountCents: number;
  /** Each line's account id; undefined on a matched entry, whose accounts are finance's. */
  accounts?: string[];
  /** The Bill's Vendor; null when the entry has none to check. */
  vendorId: string | null;
  /** The entry's date; undefined on a baseline stored before dates were compared. */
  txnDate?: string;
}

const sorted = (ids: (string | undefined)[]) => ids.map((id) => id ?? "").sort();

const lineAccounts = (entry: QboPurchase | QboBill) =>
  (entry.Line ?? []).filter((l) => l.AccountBasedExpenseLineDetail).map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value);

/** The fields of a QuickBooks entry that no longer match what was posted; `missing` when it is gone. */
export function driftOf(posted: PostedEntry, entry: QboPurchase | QboBill | undefined): DriftField[] {
  if (!entry) return ["missing"];
  const drift: DriftField[] = [];
  if (dollarsToCents(entry.TotalAmt) !== posted.amountCents) drift.push("amount");
  if (posted.txnDate !== undefined && entry.TxnDate !== posted.txnDate) drift.push("date");
  if (appKeyOf(entry) !== posted.key) drift.push("key");
  if (posted.accounts && sorted(lineAccounts(entry)).join() !== sorted(posted.accounts).join()) drift.push("accounts");
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
    txnDate: entry.TxnDate,
  };
}

/**
 * The baseline to store on a match, as JSON, from the read that matched the entry, so an edit
 * after that read is drift. A hand entry carries no key.
 */
export function matchedBaseline(entry: { amountCents: number; txnDate: string; vendorId: string | null }): string {
  const baseline: PostedEntry = { key: undefined, amountCents: entry.amountCents, vendorId: entry.vendorId, txnDate: entry.txnDate };
  return JSON.stringify(baseline);
}

/** What QuickBooks shows for each drifted field, as JSON; equal JSON means the same drift. */
export function observedOf(entry: QboPurchase | QboBill | undefined, drift: DriftField[]): string {
  if (!entry) return JSON.stringify({ missing: true });
  const shown: Record<DriftField, unknown> = {
    missing: false,
    amount: dollarsToCents(entry.TotalAmt),
    date: entry.TxnDate,
    key: appKeyOf(entry) ?? null,
    accounts: sorted(lineAccounts(entry)),
    vendor: entry.VendorRef?.value ?? null,
  };
  return JSON.stringify(Object.fromEntries(drift.map((field) => [field, shown[field]])));
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
 * Raises QB_DRIFT with the drifted field names, storing what QuickBooks showed for them; an open
 * flag keeps the latest values. Drift finance checked off stays checked off only while
 * QuickBooks still shows the values last stored.
 */
async function flagDrift(expenseId: string, drift: DriftField[], entry: QboPurchase | QboBill | undefined): Promise<void> {
  const detail = drift.join(", ");
  const observed = observedOf(entry, drift);
  const existing = await db.expenseFlag.findFirst({ where: { expenseId, kind: "QB_DRIFT" } });
  if (existing?.observed === observed) return;
  if (existing && !existing.checkedOffAt) {
    await db.expenseFlag.update({ where: { id: existing.id }, data: { detail, observed } });
    return;
  }
  await raiseFlag(expenseId, "QB_DRIFT", detail, db, observed);
}

/** The entry `qbTxnId` through the windowed reader around `receiptDate`; undefined when it is gone. */
async function readEntry(posting: ExpensePosting, entity: string | null, qbTxnId: string, receiptDate: string): Promise<QboPurchase | QboBill | undefined> {
  const from = shiftDate(receiptDate, -MATCH_WINDOW_DAYS);
  const to = shiftDate(receiptDate, MATCH_WINDOW_DAYS);
  const entries: (QboPurchase | QboBill)[] = entity === "Bill" ? await posting.client.billsBetween(from, to) : await posting.client.purchasesBetween(from, to);
  return entries.find((e) => e.Id === qbTxnId);
}

export type DriftCounts = { checked: number; drifted: number; failed: number };

/** What the drain posted for a CREATED expense: its lines' amounts and the account each was posted to. */
async function postedEntry(id: string, vendorId: string | null, txnDate: string): Promise<PostedEntry> {
  const lines = await db.expenseLineItem.findMany({ where: { expenseId: id } });
  return {
    key: qbKey("expense", id),
    amountCents: sumCents(...lines.map(lineCents)),
    // Lines the app never recorded an account for (an entry finance linked as the app's own) are not compared.
    accounts: lines.every((l) => l.qbAccountId) ? lines.map((l) => l.qbAccountId ?? "") : undefined,
    vendorId,
    txnDate,
  };
}

/**
 * The cron's drift step over CREATED and MATCHED expenses. A created entry is compared with what
 * the drain posted, its date included, a matched one with its baseline; a matched entry with no
 * baseline stores one on this read and raises nothing. Each entry is read through the windowed reader around the
 * receipt date, padded with the match grace on both sides. Capped; returns counts only.
 */
export async function checkQbDrift(now = new Date()): Promise<DriftCounts | "unbound"> {
  const posting = await getExpenseRuntime().quickbooks.posting();
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
          ? await postedEntry(id, expense.qbTxnEntity === "Bill" ? expense.qbVendorId : null, expense.receiptDate!)
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
      await flagDrift(id, drift, entry);
    } catch (err) {
      counts.failed++;
      logError("qb_drift_check_failed", { expenseId: id }, err);
    }
  }
  return counts;
}
