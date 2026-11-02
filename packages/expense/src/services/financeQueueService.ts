// The finance queue's expense tabs: every reason is read from the record's own state when
// the queue is read, so doing the thing a reason asks for is what takes it out of the queue. The
// reasons are the expense page's (reasonService), so the queue and the page always agree.
import { DEFAULT_CURRENCY } from "@checkin/receipt-types";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import type { Expense } from "../generated/prisma/client";
import { getOrgId } from "../runtime";
import { FLAG_KINDS, taxNeedsFinance } from "../lib/flags";
import { POSTABLE_QB_STATES } from "../lib/expense-qb-poster";
import type { QueueReason } from "../lib/reasons";
import { reasonText } from "../lib/reasonWords";
import { CLOSED_STATES } from "../lib/signoff";
import { readExpenseSettings } from "./settingsService";
import { signaturesWaiting } from "./signoffService";
import { expenseReasons } from "./reasonService";
import {
  FINANCE_QUEUE_REASONS,
  FINANCE_QUEUE_TABS,
  TAB_OF_QUEUE,
  type FinanceQueueCounts,
  type FinanceQueueReason,
  type FinanceQueueRow,
  type FinanceQueueTabKey,
} from "../financeQueue";

type RowExpense = Pick<Expense, "id" | "vendorName" | "receiptDate" | "submittedAt" | "receiptTotalCents" | "currency">;

/** One reason on one record, with whether this viewer can act on it and how many units it counts. */
interface Item {
  tab: FinanceQueueTabKey;
  expense: RowExpense | null;
  /** A failed intake has no expense: its row carries the payload's facts instead. */
  intake?: { receiptId: string; vendorName: string | null; date: string | null; amountCents: number; currency: string };
  reason: FinanceQueueReason;
  waitingSince: Date;
  actionable: boolean;
  /** Lines or signatures for the signature reasons; 1 otherwise. */
  units: number;
}

const ROW_FIELDS = { id: true, vendorName: true, receiptDate: true, submittedAt: true, receiptTotalCents: true, currency: true } as const;

/**
 * Details that come from `personal` columns (a QuickBooks error, a review's stored text) stay on
 * the expense page: a queue row is classified `internal`.
 */
const ROW_DETAIL_CODES = new Set(["QB_DRIFT", "QB_NO_CLASS"]);

/** Runs `fn`, naming the step and the record in the error it throws, so the route's log says which failed. */
async function withContext<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`finance queue: ${step} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The intake payload's display facts; a payload that no longer parses shows none. */
function payloadFacts(payloadJson: string) {
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      vendorName: typeof p.vendorName === "string" ? p.vendorName : null,
      date: typeof p.receiptDate === "string" ? p.receiptDate : null,
      amountCents: typeof p.receiptTotalCents === "number" ? p.receiptTotalCents : 0,
      currency: typeof p.currency === "string" ? p.currency : DEFAULT_CURRENCY,
    };
  } catch {
    return { vendorName: null, date: null, amountCents: 0, currency: DEFAULT_CURRENCY };
  }
}

/** The ids of expenses any expense-page reason may hold for, so each is read once. */
async function candidateIds(orgId: string): Promise<string[]> {
  const open = { orgId, state: { notIn: [...CLOSED_STATES] } };
  const { boardReviewTotalCents } = await readExpenseSettings(db, orgId);
  const outboxed = (await db.expenseEvent.findMany({ where: { orgId }, select: { expenseId: true } })).map((e) => e.expenseId);
  const id = { id: true } as const;
  const [steps, taxed, flagged, qb, board, unclassed] = await Promise.all([
    db.expense.findMany({
      where: {
        ...open,
        OR: [
          { state: { in: ["assign_ownership", "owner_approval", "capital_review", "set_depreciation_cycle", "qb_pending"] } },
          { approvals: { some: { status: { in: ["unknown", "exception_raised"] } } } },
          { needsReimbursement: true, backfill: false, reimburseePersonId: null },
          { holds: { some: { status: "PENDING" } } },
        ],
      },
      select: id,
    }),
    db.expense.findMany({
      where: { ...open, taxCents: { gt: 0 } },
      select: { id: true, taxCents: true, receiptReview: { select: { taxReviewRequired: true, reasons: true, approvedTaxCents: true } } },
    }),
    db.expenseFlag.findMany({ where: { orgId, checkedOffAt: null, kind: { in: [...FLAG_KINDS] } }, select: { expenseId: true } }),
    db.expense.findMany({ where: { orgId, qbMatchState: { in: ["NEEDS_FINANCE", "AMBIGUOUS", "UNBOOKED"] } }, select: id }),
    db.expense.findMany({ where: { ...open, backfill: false, receiptTotalCents: { gte: boardReviewTotalCents } }, select: id }),
    db.expense.findMany({ where: { orgId, backfill: false, qbTxnId: null, qbMatchState: { in: POSTABLE_QB_STATES }, id: { in: outboxed } }, select: id }),
  ]);
  return [
    ...new Set([
      ...steps.map((e) => e.id),
      ...taxed.filter((e) => taxNeedsFinance(e.taxCents, e.receiptReview)).map((e) => e.id),
      ...flagged.map((f) => f.expenseId),
      ...[...qb, ...board, ...unclassed].map((e) => e.id),
    ]),
  ];
}

function queueReason(r: QueueReason, currency: string): FinanceQueueReason {
  return { code: r.code, text: reasonText(ROW_DETAIL_CODES.has(r.code) ? r : { ...r, detail: null }, currency) };
}

/**
 * Every item waiting on finance or the Board, for this viewer. FINANCE and the Board read every
 * item; an item is actionable only when the viewer may take its action, never on a record the
 * viewer is conflicted on. Signatures come from signaturesWaiting.
 */
export async function financeQueueItems(principal: ExpensePrincipal): Promise<Item[]> {
  if (!principal.isFinance && !principal.isBoard) return [];
  const orgId = await getOrgId();
  const items: Item[] = [];

  const ids = await withContext("finding the expenses that may wait on finance", () => candidateIds(orgId));
  const rows = new Map((await db.expense.findMany({ where: { id: { in: ids } }, select: ROW_FIELDS })).map((e) => [e.id, e]));
  const holdsSince = new Map(
    (await db.expenseHold.groupBy({ by: ["expenseId"], where: { expenseId: { in: ids }, status: "PENDING" }, _min: { createdAt: true } })).map((h) => [h.expenseId, h._min.createdAt]),
  );
  const reviewsSince = new Map(
    (await db.expenseFlag.findMany({ where: { expenseId: { in: ids }, checkedOffAt: null, kind: { in: [...FLAG_KINDS] } }, select: { expenseId: true, kind: true, raisedAt: true } })).map((f) => [
      `${f.expenseId}:${f.kind}`,
      f.raisedAt,
    ]),
  );
  for (const id of ids) {
    const expense = rows.get(id)!;
    for (const r of await withContext(`reading the queue reasons of expense ${id}`, () => expenseReasons(principal, id, { readOnly: true }))) {
      const since = r.code === "ACCOUNT_HOLD" ? holdsSince.get(id) : reviewsSince.get(`${id}:${r.code}`);
      items.push({ tab: TAB_OF_QUEUE[r.tab], expense, reason: queueReason(r, expense.currency), waitingSince: since ?? expense.submittedAt, actionable: r.actionable, units: 1 });
    }
  }

  const payloads = await db.receivedExpensePayload.findMany({ where: { orgId, status: "failed" }, select: { receiptId: true, payloadJson: true, receivedAt: true } });
  for (const p of payloads) {
    items.push({
      tab: "expenses",
      expense: null,
      intake: { receiptId: p.receiptId, ...payloadFacts(p.payloadJson) },
      reason: { code: "INTAKE_FAILED", text: FINANCE_QUEUE_REASONS.INTAKE_FAILED, href: "/inventory/receiving?queue=failed" },
      waitingSince: p.receivedAt,
      actionable: principal.isFinance,
      units: 1,
    });
  }

  // Treasurer signatures for To sign, and Board signatures, from the line-actions function.
  for (const { expense: e, toSign, board } of await withContext("reading the signatures waiting on you", () => signaturesWaiting(principal))) {
    const row = { id: e.id, vendorName: e.vendorName, receiptDate: e.receiptDate, submittedAt: e.submittedAt, receiptTotalCents: e.receiptTotalCents, currency: e.currency };
    const sign = (tab: FinanceQueueTabKey, code: "TREASURER_SIGNATURE" | "BOARD_SIGNATURE", text: string, units: number) =>
      items.push({ tab, expense: row, reason: { code, text }, waitingSince: e.submittedAt, actionable: true, units });
    if (toSign.length > 0) sign("toSign", "TREASURER_SIGNATURE", `${plural(toSign.length, "line", "lines")} to sign as Treasurer`, toSign.length);
    if (board.length > 0) sign("board", "BOARD_SIGNATURE", `${plural(board.length, "Board signature", "Board signatures")} to give`, board.length);
  }
  return items;
}

const reasonOrder = (code: string) => Object.keys(FINANCE_QUEUE_REASONS).indexOf(code);

/** One row per record and tab, its reasons in that tab, sorted by reason and then oldest first. */
function rowsOf(items: Item[], tab: FinanceQueueTabKey): FinanceQueueRow[] {
  const rows = new Map<string, { row: Omit<FinanceQueueRow, "waitingSince">; since: Date }>();
  for (const it of items.filter((i) => i.tab === tab)) {
    const key = it.expense ? `e:${it.expense.id}` : `r:${it.intake!.receiptId}`;
    const seen = rows.get(key);
    if (seen) {
      seen.row.reasons.push(it.reason);
      if (it.waitingSince < seen.since) seen.since = it.waitingSince;
      continue;
    }
    const e = it.expense;
    const row = e
      ? { expenseId: e.id, vendorName: e.vendorName, date: e.receiptDate ?? e.submittedAt.toISOString().slice(0, 10), amountCents: e.receiptTotalCents, currency: e.currency }
      : { expenseId: null, vendorName: it.intake!.vendorName, date: it.intake!.date, amountCents: it.intake!.amountCents, currency: it.intake!.currency };
    rows.set(key, { row: { ...row, reasons: [it.reason] }, since: it.waitingSince });
  }
  const sorted = [...rows.values()].map(({ row, since }) => ({ row: { ...row, reasons: [...row.reasons].sort((a, b) => reasonOrder(a.code) - reasonOrder(b.code)) }, since }));
  sorted.sort((a, b) => reasonOrder(a.row.reasons[0].code) - reasonOrder(b.row.reasons[0].code) || a.since.getTime() - b.since.getTime());
  return sorted.map(({ row, since }) => ({ ...row, waitingSince: since.toISOString() }));
}

/** Per tab: the units this viewer can act on, every unit, and the actionable units per reason. */
function countsOf(items: Item[]): FinanceQueueCounts {
  const out = Object.fromEntries(FINANCE_QUEUE_TABS.map((t) => [t.key, { actionable: 0, total: 0, byReason: {} }])) as FinanceQueueCounts;
  for (const it of items) {
    const c = out[it.tab];
    c.total += it.units;
    if (!it.actionable) continue;
    c.actionable += it.units;
    c.byReason[it.reason.code] = (c.byReason[it.reason.code] ?? 0) + it.units;
  }
  return out;
}

export async function financeQueueRows(principal: ExpensePrincipal, tab: FinanceQueueTabKey): Promise<FinanceQueueRow[]> {
  return rowsOf(await financeQueueItems(principal), tab);
}

export async function financeQueueCounts(principal: ExpensePrincipal): Promise<FinanceQueueCounts> {
  return countsOf(await financeQueueItems(principal));
}

/** The Finance review pill's expense side: every tab's actionable units. */
export async function financeQueueActionable(principal: ExpensePrincipal): Promise<number> {
  return Object.values(await financeQueueCounts(principal)).reduce((sum, c) => sum + c.actionable, 0);
}
