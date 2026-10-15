// QB-2 write path: drains the ExpenseEvent outbox into QuickBooks, one entry per expense
// (a Bill to the reimbursee's Vendor, else a Purchase from the payment account), match before create.
import { findOrCreate, qbKey, takeoverLine, type FindOrCreateResult, type TxnWrite } from "@inventory/quickbooks";
import { db, type Db } from "../db";
import type { ExpensePosting } from "../contract";
import type { Expense } from "../db/schema";
import { getExpenseRuntime } from "../runtime";
import { MATCH_WINDOW_DAYS, claimQbTxn, claimedQbTxnIds } from "../services/qbMatchService";
import { QbExpenseEventSchema } from "../workflows/expense-event-schema";
import { writeAudit } from "./audit";
import { logError, logWarn } from "./logger";
import { SYSTEM_ACTOR } from "./system-actor";
import { raiseFlag } from "../services/flagService";

/**
 * Expense match states the drain still tries; the test-data states are re-checked each run.
 * AMBIGUOUS and BEFORE_LINE wait for finance.
 */
export const POSTABLE_QB_STATES = ["UNMATCHED", "POST_FAILED", "NOT_TEST_DATA", "TEST_DATA_REFUSED"];

export const TEST_VENDOR_PREFIX = "TEST-";

/** Why an expense must not reach this QuickBooks company, or null when it may. */
function notSendable(posting: ExpensePosting, e: { isTestData: boolean; vendorName: string | null }) {
  if (posting.prod) {
    return e.isTestData ? { qbMatchState: "TEST_DATA_REFUSED", note: "not sent to QuickBooks: test data is never posted in prod" } : null;
  }
  return e.isTestData && (e.vendorName ?? "").startsWith(TEST_VENDOR_PREFIX)
    ? null
    : { qbMatchState: "NOT_TEST_DATA", note: "not sent to QuickBooks: not test data" };
}

// ponytail: fixed per-run caps; move to ExpenseOrgSettings when finance needs to tune them.
export const MAX_CREATES_PER_RUN = 25;
export const MAX_CREATE_CENTS_PER_RUN = 2_500_000;
export const MAX_CREATES_PER_DAY = 50;
/** Failed posts before the drain stops retrying and hands the expense to finance. */
export const MAX_POST_ATTEMPTS = 5;

export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting" | "not_sent" | "needs_finance";

/** QuickBooks entries created since UTC midnight, counted from the audit rows settle() writes. */
export async function qbCreatesToday(client: Db = db): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return client.expenseAuditLog.count({ where: { action: "qb_created", changedAt: { gte: midnight } } });
}

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

/** QuickBooks ids are unique per entity type only, so claims are read for the entity being posted. */
async function claimedAndExcluded(orgId: string, entity: "Purchase" | "Bill") {
  const [claimed, excluded] = await Promise.all([
    claimedQbTxnIds(orgId, entity),
    db.expenseQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
  ]);
  return {
    claimedIds: new Set(claimed),
    excludedIds: new Set(excluded.map((e) => e.qbTxnId)),
  };
}

/** Every failure is recorded; at the limit the drain stops retrying and finance is flagged. */
async function recordFailure(tx: Db, current: Expense, error: string): Promise<"failed" | "needs_finance"> {
  const attempts = current.qbPostAttempts + 1;
  const exhausted = attempts >= MAX_POST_ATTEMPTS;
  const qbMatchState = exhausted ? "NEEDS_FINANCE" : "POST_FAILED";
  await tx.expense.update({ where: { id: current.id }, data: { qbMatchState, qbPostAttempts: attempts } });
  await writeAudit(tx, SYSTEM_ACTOR, {
    expenseId: current.id,
    action: `qb_${qbMatchState.toLowerCase()}`,
    fieldChanged: "qbMatchState",
    valueBefore: current.qbMatchState,
    valueAfter: qbMatchState,
    notes: `attempt ${attempts} of ${MAX_POST_ATTEMPTS}: ${error}`,
  });
  if (!exhausted) return "failed";
  await raiseFlag(current.id, "QB_POST_FAILED", error.slice(0, 500), tx);
  return "needs_finance";
}

/** Locks the expense and runs `fn` on it when it is still waiting to be posted. */
function withPostable<T>(orgId: string, expenseId: string, fn: (tx: Db, current: Expense) => Promise<T>, timeout?: number) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE`;
    const current = await tx.expense.findFirstOrThrow({ where: { id: expenseId, orgId } });
    if (current.backfill || current.qbTxnId || !POSTABLE_QB_STATES.includes(current.qbMatchState)) return "waiting" as const;
    return fn(tx, current);
  }, timeout ? { timeout } : undefined);
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
 * BEFORE_LINE; a failure (QuickBooks down, rejected, or a thrown error) → POST_FAILED, retried by
 * the drain until MAX_POST_ATTEMPTS, then NEEDS_FINANCE with a flag (finance's retry re-arms it); an
 * expense the test-data gate stops → NOT_TEST_DATA / TEST_DATA_REFUSED, re-checked each run. With no
 * takeover date configured nothing is posted. At MAX_CREATES_PER_DAY the expense waits for the next
 * UTC day, nothing recorded. A row lock serializes the request path and the cron drain.
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

  try {
    return await attemptPost(orgId, expenseId, posting, posting.takeoverDate, event.payload);
  } catch (err) {
    // The attempt's own transaction rolled back, so the failure is recorded in a fresh one.
    logError("qb_post_threw", { expenseId, orgId }, err);
    const error = err instanceof Error ? err.message : String(err);
    return withPostable(orgId, expenseId, (tx, current) => recordFailure(tx, current, error));
  }
}

async function attemptPost(
  orgId: string,
  expenseId: string,
  posting: ExpensePosting,
  takeoverDate: string,
  payload: string,
): Promise<PostOutcome> {
  const line = await expenseTakeoverLine(orgId, takeoverDate);
  let built: Built;
  try {
    built = await buildWrite(orgId, payload, posting);
  } catch (e) {
    built = { error: e instanceof Error ? e.message : String(e) };
  }
  const { claimedIds, excludedIds } = "write" in built
    ? await claimedAndExcluded(orgId, built.write.entity === "Bill" ? "Bill" : "Purchase")
    : { claimedIds: new Set<string>(), excludedIds: new Set<string>() };

  return withPostable(
    orgId,
    expenseId,
    async (tx, current) => {
      const settle = async (
        outcome: PostOutcome,
        data: { qbMatchState: string; qbTxnId?: string; qbTxnEntity?: string; qbVendorId?: string },
        notes?: string,
      ) => {
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

      const fail = (error: string) => recordFailure(tx, current, error);

      const refused = notSendable(posting, current);
      if (refused) {
        if (posting.prod) logWarn("qb_post_test_data_refused", { expenseId, orgId });
        return settle("not_sent", { qbMatchState: refused.qbMatchState }, refused.note);
      }
      if ("error" in built) return fail(built.error);
      if ("queue" in built) return settle("queued", { qbMatchState: "AMBIGUOUS" }, built.queue);

      // ponytail: concurrent posts can each see the count under the ceiling, so a day may overshoot by the in-flight posts.
      if ((await qbCreatesToday(tx)) >= MAX_CREATES_PER_DAY) return "waiting";
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
          const byAmount = result.kind === "found" && result.via === "amount";
          if (!(await claimQbTxn(tx, orgId, write.entity, result.id))) {
            const note = `QuickBooks ${write.entity} ${result.id} is already claimed by another expense or line`;
            // An entry the app posted for this expense is now a duplicate in QuickBooks.
            if (!byAmount) await raiseFlag(expenseId, "QB_POST_FAILED", `${note}; the entry posted for this expense needs voiding`, tx);
            return settle("queued", { qbMatchState: "AMBIGUOUS" }, note);
          }
          if (byAmount) {
            return settle("matched", { qbMatchState: "MATCHED", qbTxnId: result.id, qbTxnEntity: write.entity });
          }
          for (const [id, accountId] of lineAccounts) {
            await tx.expenseLineItem.update({ where: { id }, data: { qbAccountId: accountId } });
          }
          const qbVendorId = write.entity === "Bill" ? write.fields.vendorId : undefined;
          return settle("posted", { qbMatchState: "CREATED", qbTxnId: result.id, qbTxnEntity: write.entity, qbVendorId });
        }
        case "ambiguous":
          return settle("queued", { qbMatchState: "AMBIGUOUS" }, `candidates: ${result.ids.join(", ")}`);
        case "too-old":
          return settle("queued", { qbMatchState: "BEFORE_LINE" });
        case "failed":
          return fail(result.error);
        case "no-line":
          return "waiting";
      }
    },
    // findOrCreate makes up to two QuickBooks requests, each with a 30s timeout and one Retry-After wait.
    90_000,
  );
}

export type DrainCounts = Record<PostOutcome, number> & { overCap: number; capped: "count" | "cents" | "day" | null };

/**
 * The catch-up drain: every outboxed expense not yet in QuickBooks, oldest receipt first. Stops
 * at the daily, count and cents caps and logs the hit (the alarm hook); the rest waits for the next run.
 * An expense over the cents cap on its own is posted alone, as the first post of a run, and
 * flagged for finance. Returns counts only.
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

  const counts: DrainCounts = { posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, not_sent: 0, needs_finance: 0, overCap: 0, capped: null };
  let postedCents = 0;
  const createdBefore = await qbCreatesToday();
  for (const [i, e] of due.entries()) {
    if (createdBefore + counts.posted >= MAX_CREATES_PER_DAY) {
      counts.capped = "day";
      logWarn("qb_daily_cap", { cap: MAX_CREATES_PER_DAY, remaining: due.length - i });
      break;
    }
    const alone = e.receiptTotalCents > MAX_CREATE_CENTS_PER_RUN && counts.posted === 0;
    if (!alone && (counts.posted >= MAX_CREATES_PER_RUN || postedCents + e.receiptTotalCents > MAX_CREATE_CENTS_PER_RUN)) {
      counts.capped = counts.posted >= MAX_CREATES_PER_RUN ? "count" : "cents";
      logWarn("qb_drain_capped", { cap: counts.capped, remaining: due.length - i });
      break;
    }
    try {
      const outcome = await postExpenseToQb(e.orgId, e.id);
      if (outcome === "unbound" || outcome === "no_takeover_date") break;
      counts[outcome]++;
      if (outcome === "posted") postedCents += e.receiptTotalCents;
      if (alone && outcome === "posted") {
        counts.overCap++;
        logWarn("qb_drain_over_cap", { expenseId: e.id, orgId: e.orgId });
        await raiseFlag(e.id, "QB_OVER_CAP", "posted alone: over the per-run cap");
        counts.capped = "cents";
        break;
      }
    } catch (err) {
      counts.failed++;
      logError("qb_drain_failed", { expenseId: e.id, orgId: e.orgId }, err);
    }
  }
  return counts;
}
