// QB-2 write path: drains the ExpenseEvent outbox into QuickBooks, one entry per expense
// (a Bill to the reimbursee's Vendor, else a Purchase from the payment account), match before create.
import { findOrCreate, qbKey, takeoverLine, type FindOrCreateResult, type TxnWrite } from "@inventory/quickbooks";
import { db } from "../db";
import type { ExpensePosting } from "../contract";
import { getExpenseRuntime } from "../runtime";
import { MATCH_WINDOW_DAYS } from "../services/qbMatchService";
import { QbExpenseEventSchema } from "../workflows/expense-event-schema";
import { writeAudit } from "./audit";
import { logError, logWarn } from "./logger";
import { SYSTEM_ACTOR } from "./system-actor";

/** Expense match states the drain still posts. AMBIGUOUS and BEFORE_LINE wait for finance. */
export const POSTABLE_QB_STATES = ["UNMATCHED", "POST_FAILED"];

// ponytail: fixed per-run caps; move to ExpenseOrgSettings when finance needs to tune them.
export const MAX_CREATES_PER_RUN = 25;
export const MAX_CREATE_CENTS_PER_RUN = 2_500_000;

export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting";

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The configured takeover date, or the newest receipt date tied to a hand-booked QuickBooks
 * entry when that is later; app-created entries never move it.
 */
async function expenseTakeoverLine(orgId: string, takeoverDate: string): Promise<string> {
  const rows = await db.expense.findMany({
    where: {
      orgId,
      receiptDate: { not: null },
      OR: [{ qbMatchState: "MATCHED" }, { lineItems: { some: { qbMatchState: "MATCHED" } } }],
    },
    select: { receiptDate: true },
  });
  return takeoverLine([takeoverDate, ...rows.map((r) => r.receiptDate!)].map((date) => ({ date, qbOrigin: "hand" as const }))) ?? takeoverDate;
}

async function claimedAndExcluded(orgId: string, expenseId: string) {
  const [expenses, lines, excluded] = await Promise.all([
    db.expense.findMany({ where: { orgId, qbTxnId: { not: null }, id: { not: expenseId } }, select: { qbTxnId: true } }),
    db.expenseLineItem.findMany({ where: { qbTxnId: { not: null }, expense: { orgId } }, select: { qbTxnId: true } }),
    db.expenseQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
  ]);
  return {
    claimedIds: new Set([...expenses, ...lines].map((r) => r.qbTxnId!)),
    excludedIds: new Set(excluded.map((e) => e.qbTxnId)),
  };
}

type Built = { write: TxnWrite; lineAccounts: Map<number, string> } | { queue: string } | { error: string };

/** The entry to create for an outboxed expense; each line keeps its own account. */
async function buildWrite(orgId: string, payloadJson: string, posting: ExpensePosting): Promise<Built> {
  const event = QbExpenseEventSchema.parse(JSON.parse(payloadJson));
  if (!event.receiptDate) return { error: "the expense has no receipt date" };
  const lines = event.items.map((i) => ({
    lineItemId: i.lineItemId,
    amountCents: i.totalPriceCents + i.allocatedTaxCents + i.allocatedShippingCents - i.allocatedDiscountCents,
    accountId: i.account,
    description: i.description,
  }));
  const lineAccounts = new Map(lines.map((l) => [l.lineItemId, l.accountId]));
  const writeLines = lines.map(({ amountCents, accountId, description }) => ({ amountCents, accountId, description }));
  const memo = event.vendorName ?? undefined;

  if (event.needsReimbursement) {
    const vendor = await db.expenseReimburseeVendor.findFirst({ where: { orgId, reimburseePersonId: event.reimburseePersonId! } });
    if (!vendor) return { queue: "the reimbursee has no QuickBooks Vendor" };
    return { write: { entity: "Bill", fields: { txnDate: event.receiptDate, vendorId: vendor.qbVendorId, lines: writeLines, memo } }, lineAccounts };
  }
  return {
    write: {
      entity: "Purchase",
      fields: { txnDate: event.receiptDate, paymentType: posting.paymentType, accountId: posting.paymentAccountId, lines: writeLines, memo },
    },
    lineAccounts,
  };
}

/**
 * One expense's turn through the outbox. found by key or created → CREATED; found by amount →
 * MATCHED; ambiguous or an unmapped reimbursee → AMBIGUOUS; before the takeover line →
 * BEFORE_LINE; a failure (QuickBooks down, rejected) → POST_FAILED, retried by the drain. With no
 * takeover date configured nothing is posted. A row lock serializes the request path and the cron drain.
 */
export async function postExpenseToQb(orgId: string, expenseId: string): Promise<PostOutcome | "unbound" | "no_takeover_date"> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting) return "unbound";
  if (!posting.takeoverDate) {
    logWarn("qb_post_no_takeover_date", { expenseId, orgId });
    return "no_takeover_date";
  }
  const event = await db.expenseEvent.findFirst({ where: { orgId, expenseId } });
  if (!event) return "waiting";

  const line = await expenseTakeoverLine(orgId, posting.takeoverDate);
  const { claimedIds, excludedIds } = await claimedAndExcluded(orgId, expenseId);
  let built: Built;
  try {
    built = await buildWrite(orgId, event.payload, posting);
  } catch (e) {
    built = { error: e instanceof Error ? e.message : String(e) };
  }

  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE`;
      const current = await tx.expense.findFirstOrThrow({ where: { id: expenseId, orgId } });
      if (current.backfill || current.qbTxnId || !POSTABLE_QB_STATES.includes(current.qbMatchState)) return "waiting";

      const settle = async (outcome: PostOutcome, data: { qbMatchState: string; qbTxnId?: string; qbVendorId?: string }, notes?: string) => {
        if (current.qbMatchState === data.qbMatchState && !data.qbTxnId) return outcome;
        await tx.expense.update({ where: { id: expenseId }, data });
        await writeAudit(tx, SYSTEM_ACTOR, {
          expenseId,
          action: `qb_${data.qbMatchState.toLowerCase()}`,
          fieldChanged: "qbMatchState",
          valueBefore: current.qbMatchState,
          valueAfter: data.qbTxnId ? `${data.qbMatchState}:${data.qbTxnId}` : data.qbMatchState,
          notes: notes ?? null,
        });
        return outcome;
      };

      if ("error" in built) return settle("failed", { qbMatchState: "POST_FAILED" }, built.error);
      if ("queue" in built) return settle("queued", { qbMatchState: "AMBIGUOUS" }, built.queue);

      const { write, lineAccounts } = built;
      const date = write.fields.txnDate;
      const result: FindOrCreateResult = await findOrCreate(posting.client, {
        write,
        key: qbKey("expense", expenseId),
        window: { from: shiftDate(date, -MATCH_WINDOW_DAYS), to: shiftDate(date, MATCH_WINDOW_DAYS) },
        takeoverLine: line,
        claimedIds,
        excludedIds,
      });

      switch (result.kind) {
        case "created":
        case "found": {
          if (result.kind === "found" && result.via === "amount") {
            return settle("matched", { qbMatchState: "MATCHED", qbTxnId: result.id });
          }
          for (const [id, accountId] of lineAccounts) {
            await tx.expenseLineItem.update({ where: { id }, data: { qbAccountId: accountId } });
          }
          const qbVendorId = write.entity === "Bill" ? write.fields.vendorId : undefined;
          return settle("posted", { qbMatchState: "CREATED", qbTxnId: result.id, qbVendorId });
        }
        case "ambiguous":
          return settle("queued", { qbMatchState: "AMBIGUOUS" }, `candidates: ${result.ids.join(", ")}`);
        case "too-old":
          return settle("queued", { qbMatchState: "BEFORE_LINE" });
        case "failed":
          return settle("failed", { qbMatchState: "POST_FAILED" }, result.error);
        case "no-line":
          return "waiting";
      }
    },
    // findOrCreate makes up to two QuickBooks requests, each with a 30s timeout and one Retry-After wait.
    { timeout: 90_000 },
  );
}

export type DrainCounts = Record<PostOutcome, number> & { overCap: number; capped: "count" | "cents" | null };

/**
 * The catch-up drain: every outboxed expense not yet in QuickBooks, oldest receipt first. Stops
 * at the count and cents caps and logs the hit; an expense over the cents cap on its own is
 * skipped and logged. Returns counts only.
 */
export async function drainExpenseOutbox(): Promise<DrainCounts | "unbound" | "no_takeover_date"> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting) return "unbound";
  if (!posting.takeoverDate) {
    logWarn("qb_drain_no_takeover_date", {});
    return "no_takeover_date";
  }
  const outboxed = new Set((await db.expenseEvent.findMany({ select: { expenseId: true } })).map((e) => e.expenseId));
  const due = (
    await db.expense.findMany({
      where: { backfill: false, qbTxnId: null, qbMatchState: { in: POSTABLE_QB_STATES } },
      orderBy: [{ receiptDate: "asc" }, { submittedAt: "asc" }],
      select: { id: true, orgId: true, receiptTotalCents: true },
    })
  ).filter((e) => outboxed.has(e.id));

  const counts: DrainCounts = { posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, overCap: 0, capped: null };
  let postedCents = 0;
  for (const [i, e] of due.entries()) {
    if (e.receiptTotalCents > MAX_CREATE_CENTS_PER_RUN) {
      counts.overCap++;
      logWarn("qb_drain_over_cap", { expenseId: e.id, orgId: e.orgId });
      continue;
    }
    if (counts.posted >= MAX_CREATES_PER_RUN || postedCents + e.receiptTotalCents > MAX_CREATE_CENTS_PER_RUN) {
      counts.capped = counts.posted >= MAX_CREATES_PER_RUN ? "count" : "cents";
      logWarn("qb_drain_capped", { cap: counts.capped, remaining: due.length - i });
      break;
    }
    try {
      const outcome = await postExpenseToQb(e.orgId, e.id);
      if (outcome === "unbound" || outcome === "no_takeover_date") break;
      counts[outcome]++;
      if (outcome === "posted") postedCents += e.receiptTotalCents;
    } catch (err) {
      counts.failed++;
      logError("qb_drain_failed", { expenseId: e.id, orgId: e.orgId }, err);
    }
  }
  return counts;
}
