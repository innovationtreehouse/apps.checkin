// The finance queue's expense tabs (#2481): every reason is read from the record's own state when
// the queue is read, so doing the thing a reason asks for is what takes it out of the queue.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import type { Expense } from "../generated/prisma/client";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import { FLAG_KINDS, taxNeedsFinance } from "../lib/flags";
import { POSTABLE_QB_STATES } from "../lib/expense-qb-poster";
import { CLOSED_STATES, availableSigners, blockedSeats, missingSeats, reimburseeUnknown, signoffRefusal, type Seat } from "../lib/signoff";
import { filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
import { readExpenseSettings } from "./settingsService";
import { SIGNOFF_BADGE_EXPENSE_CAP, conflictCheck } from "./badgeCounts";
import {
  FINANCE_QUEUE_TABS,
  FINANCE_QUEUE_REASONS,
  type FinanceQueueCounts,
  type FinanceQueueReason,
  type FinanceQueueReasonCode,
  type FinanceQueueRow,
  type FinanceQueueTabKey,
} from "../financeQueue";

/** One reason on one record, with whether this viewer can act on it and how many units it counts. */
interface Item {
  tab: FinanceQueueTabKey;
  expense: Pick<Expense, "id" | "vendorName" | "receiptDate" | "submittedAt" | "receiptTotalCents" | "currency"> | null;
  /** A failed intake has no expense: its row carries the payload's facts instead. */
  intake?: { receiptId: string; vendorName: string | null; date: string | null; amountCents: number; currency: string };
  reason: FinanceQueueReason;
  waitingSince: Date;
  actionable: boolean;
  /** Lines or signatures for the To sign and Board-signature reasons; 1 otherwise. */
  units: number;
}

const EXPENSE_FIELDS = { id: true, vendorName: true, receiptDate: true, submittedAt: true, receiptTotalCents: true, currency: true, submitterId: true, reimburseePersonId: true } as const;

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The intake payload's display facts; a payload that no longer parses shows none. */
function payloadFacts(payloadJson: string) {
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      vendorName: typeof p.vendorName === "string" ? p.vendorName : null,
      date: typeof p.receiptDate === "string" ? p.receiptDate : null,
      amountCents: typeof p.receiptTotalCents === "number" ? p.receiptTotalCents : 0,
      currency: typeof p.currency === "string" ? p.currency : "USD",
    };
  } catch {
    return { vendorName: null, date: null, amountCents: 0, currency: "USD" };
  }
}

/** The drifted field names a QB_DRIFT review stored: the keys of what QuickBooks showed. */
function driftFields(observed: string | null): string[] {
  try {
    return observed ? Object.keys(JSON.parse(observed) as object) : [];
  } catch {
    return [];
  }
}

const reason = (code: FinanceQueueReasonCode, text?: string, href?: string): FinanceQueueReason => ({
  code,
  text: text ?? FINANCE_QUEUE_REASONS[code].label,
  ...(href ? { href } : {}),
});

/**
 * Every item waiting on finance or the Board, for this viewer. FINANCE and the Board read every
 * item; an item is actionable only when the viewer may take its action, and never on a record the
 * viewer is conflicted on. Signature reasons read at most SIGNOFF_BADGE_EXPENSE_CAP QB-pending
 * expenses, newest first, as the sign-off badges do.
 */
export async function financeQueueItems(principal: ExpensePrincipal): Promise<Item[]> {
  if (!principal.isFinance && !principal.isBoard) return [];
  const me = callerId(principal);
  const orgId = await getOrgId();
  const finance = principal.isFinance;
  const conflicted = conflictCheck(me);
  const open = { orgId, state: { notIn: [...CLOSED_STATES] } };
  const settings = await readExpenseSettings(db, orgId);

  const [assign, unknown, exceptions, capital, depreciation, reimbursee, taxed, payloads, held, reviews, needsFinance, ambiguous, outboxed, boardApproval, qbPending] =
    await Promise.all([
      db.expense.findMany({ where: { orgId, state: "assign_ownership", approvals: { some: { ownerId: null } } }, select: EXPENSE_FIELDS }),
      db.expense.findMany({ where: { orgId, approvals: { some: { status: "unknown" } } }, select: EXPENSE_FIELDS }),
      db.expense.findMany({ where: { orgId, approvals: { some: { status: "exception_raised" } } }, select: EXPENSE_FIELDS }),
      db.expense.findMany({ where: { orgId, state: "capital_review" }, select: EXPENSE_FIELDS }),
      db.expense.findMany({ where: { orgId, state: "set_depreciation_cycle" }, select: EXPENSE_FIELDS }),
      db.expense.findMany({ where: { ...open, needsReimbursement: true, backfill: false, reimburseePersonId: null }, select: EXPENSE_FIELDS }),
      db.expense.findMany({
        where: { ...open, taxCents: { gt: 0 } },
        select: { ...EXPENSE_FIELDS, taxCents: true, receiptReview: { select: { taxReviewRequired: true, reasons: true, approvedTaxCents: true } } },
      }),
      db.receivedExpensePayload.findMany({ where: { orgId, status: "failed" }, select: { receiptId: true, payloadJson: true, receivedAt: true } }),
      db.expense.findMany({
        where: { orgId, holds: { some: { status: "PENDING" } } },
        select: { ...EXPENSE_FIELDS, holds: { where: { status: "PENDING" }, select: { lineItemId: true, createdAt: true } } },
      }),
      db.expenseFlag.findMany({
        where: { orgId, checkedOffAt: null, kind: { in: [...FLAG_KINDS] } },
        select: { kind: true, observed: true, raisedAt: true, expense: { select: EXPENSE_FIELDS } },
      }),
      db.expense.findMany({ where: { orgId, qbMatchState: "NEEDS_FINANCE" }, select: { ...EXPENSE_FIELDS, qbPostAttempts: true } }),
      db.expense.findMany({ where: { orgId, qbMatchState: "AMBIGUOUS" }, select: { ...EXPENSE_FIELDS, needsReimbursement: true } }),
      db.expense.findMany({
        where: { orgId, backfill: false, qbTxnId: null, qbMatchState: { in: POSTABLE_QB_STATES }, id: { in: (await db.expenseEvent.findMany({ where: { orgId }, select: { expenseId: true } })).map((e) => e.expenseId) } },
        select: { ...EXPENSE_FIELDS, approvals: { select: { ownerId: true } } },
      }),
      db.expense.findMany({
        where: { ...open, backfill: false, receiptTotalCents: { gte: settings.boardReviewTotalCents }, OR: [{ boardAuthorization: null }, { boardAuthorization: "" }] },
        select: { ...EXPENSE_FIELDS, needsReimbursement: true, backfill: true, boardAuthorization: true },
      }),
      db.expense.findMany({ where: { orgId, state: "qb_pending", backfill: false }, orderBy: { submittedAt: "desc" }, take: SIGNOFF_BADGE_EXPENSE_CAP }),
    ]);

  const items: Item[] = [];
  const add = async (
    tab: FinanceQueueTabKey,
    e: Item["expense"] & { submitterId: number; reimburseePersonId: number | null },
    r: FinanceQueueReason,
    opts: { since?: Date; may?: boolean; units?: number } = {},
  ) => {
    const may = opts.may ?? finance;
    items.push({ tab, expense: e, reason: r, waitingSince: opts.since ?? e.submittedAt, actionable: may && !(await conflicted(e)), units: opts.units ?? 1 });
  };

  // Expenses tab.
  for (const e of assign) await add("expenses", e, reason("bucket_to_assign"));
  for (const e of unknown) await add("expenses", e, reason("bucket_unknown"));
  for (const e of exceptions) await add("expenses", e, reason("owner_exception"));
  for (const e of capital) await add("expenses", e, reason("capital_review"));
  for (const e of depreciation) await add("expenses", e, reason("depreciation_cycle"));
  for (const e of reimbursee) await add("expenses", e, reason("reimbursee_to_name"));
  for (const e of taxed) {
    if (taxNeedsFinance(e.taxCents, e.receiptReview)) await add("expenses", e, reason("tax_not_reviewed", `Tax ${dollars(e.taxCents)} not reviewed on the receipt`));
  }
  for (const p of payloads) {
    items.push({
      tab: "expenses",
      expense: null,
      intake: { receiptId: p.receiptId, ...payloadFacts(p.payloadJson) },
      reason: reason("intake_failed", undefined, "/inventory/receiving?queue=failed"),
      waitingSince: p.receivedAt,
      actionable: finance,
      units: 1,
    });
  }

  // Account holds tab: one row per held expense.
  for (const e of held) {
    const lines = new Set(e.holds.map((h) => h.lineItemId)).size;
    const since = new Date(Math.min(...e.holds.map((h) => h.createdAt.getTime())));
    await add("accountHolds", e, reason("account_hold", `${plural(lines, "line has", "lines have")} no account rule`), { since });
  }

  // QuickBooks tab.
  for (const e of needsFinance) await add("quickbooks", e, reason("qb_post_failed", `Posting failed ${plural(e.qbPostAttempts, "time", "times")}`));
  for (const f of reviews) {
    const text =
      f.kind === "QB_DRIFT"
        ? `Changed in QuickBooks after posting${driftFields(f.observed).length ? `: ${driftFields(f.observed).join(", ")}` : ""}`
        : undefined;
    const code: FinanceQueueReasonCode = f.kind === "QB_DRIFT" ? "qb_drift" : f.kind === "QB_POST_HELD" ? "qb_post_held" : "qb_duplicate_to_void";
    await add("quickbooks", f.expense, reason(code, text), { since: f.raisedAt });
  }
  if (outboxed.length > 0) {
    const buckets = new Map((await getExpenseRuntime().budgetOwners.list()).map((b) => [b.id, b]));
    for (const e of outboxed) {
      const missing = e.approvals.find((a) => a.ownerId === null || !buckets.get(a.ownerId)?.quickBooksClassId);
      if (!missing) continue;
      const name = missing.ownerId === null ? undefined : buckets.get(missing.ownerId)?.name;
      await add("quickbooks", e, reason("qb_no_class", name ? `Budget bucket ${name} has no QuickBooks class` : "A line has no budget bucket, so it has no QuickBooks class"));
    }
  }
  if (ambiguous.length > 0) {
    const vendors = new Set(
      (await db.expenseReimburseeVendor.findMany({ where: { orgId }, select: { reimburseePersonId: true } })).map((v) => v.reimburseePersonId),
    );
    for (const e of ambiguous) {
      const noVendor = e.needsReimbursement && e.reimburseePersonId !== null && !vendors.has(e.reimburseePersonId);
      await add("quickbooks", e, reason("qb_ambiguous", noVendor ? "The reimbursee has no QuickBooks vendor yet; link one" : "Several QuickBooks entries match; pick one"));
    }
  }

  // Board tab: recording the Board's approval is finance's; a Board member gets no count for it.
  for (const e of boardApproval) {
    if (e.boardAuthorization?.trim()) continue;
    await add("board", e, reason("board_approval_not_recorded", `Board approval of a ${dollars(e.receiptTotalCents)} purchase not recorded`), {
      may: finance && !reimburseeUnknown(e),
    });
  }

  // To sign and Board signatures, from the QB-pending expenses' open seats.
  for (const e of qbPending) {
    if (reimburseeUnknown(e)) continue;
    const [facts, filled] = await Promise.all([signoffFactsByLine(db, e, { readOnly: true }), filledSeatsByLine(db, e.id)]);
    let treasurer = 0;
    let board = 0;
    let isHeld = false;
    for (const [lineId, f] of facts) {
      const seats = filled.get(lineId) ?? [];
      if (blockedSeats(f, seats).length > 0) isHeld = true;
      for (const seat of missingSeats(f, seats)) {
        if (seat === "SUBMITTER" || signoffRefusal(f, seats, seat, me) !== null) continue;
        if (seat === "TREASURER" && f.finance.includes(me)) treasurer++;
        else if (boardSignature(f, seats, seat, me)) board++;
      }
    }
    if (treasurer > 0) await add("toSign", e, reason("treasurer_signature", `${plural(treasurer, "line", "lines")} to sign as Treasurer`), { may: true, units: treasurer });
    if (board > 0) await add("board", e, reason("board_signature", `${plural(board, "Board signature", "Board signatures")} to give`), { may: true, units: board });
    if (isHeld) await add("board", e, reason("board_held"), { may: false });
  }
  return items;
}

/**
 * A seat this viewer signs as a Board member: the Board seat, or a Treasurer or program-approver
 * seat nobody eligible can fill. A bucket approver's own program-approver seat is theirs, not the Board's.
 */
function boardSignature(f: Parameters<typeof availableSigners>[0], seats: Parameters<typeof availableSigners>[1], seat: Exclude<Seat, "SUBMITTER">, me: number): boolean {
  if (!f.board.includes(me)) return false;
  return seat === "BOARD" || availableSigners(f, seats, seat).length === 0;
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
  const out = Object.fromEntries(FINANCE_QUEUE_TABS.map((t) => [t.key, { actionable: 0, total: 0, byReason: {} as Record<string, number> }])) as FinanceQueueCounts;
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

/** The one number on the Finance review pill from the expense side: every tab's actionable units. */
export async function financeQueueActionable(principal: ExpensePrincipal): Promise<number> {
  return Object.values(await financeQueueCounts(principal)).reduce((sum, c) => sum + c.actionable, 0);
}
