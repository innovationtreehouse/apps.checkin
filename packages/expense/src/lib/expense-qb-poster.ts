// QB-2 write path: drains the ExpenseEvent outbox into QuickBooks, one entry per expense
// (a Bill to the reimbursee's Vendor, else a Purchase from the payment account), match before create.
import { findOrCreate, qbKey, qboDate, type FindOrCreateResult, type TxnWrite } from "@checkin/quickbooks";
import { db, type Db } from "../db";
import type { ExpensePosting, OutboundBag } from "../contract";
import type { Expense } from "../db/schema";
import { getExpenseRuntime } from "../runtime";
import { MATCH_WINDOW_DAYS, claimQbTxn, claimedQbTxnIds } from "../services/qbMatchService";
import { writeAudit } from "./audit";
import { matchBaseline } from "./expense-qb-drift";
import { composeWrite, lineCents, type Built } from "../qb-write";
import { logError, logWarn } from "./logger";
import { reimburseeUnknown } from "./signoff";
import { unsignedLines } from "./signoff-facts";
import { SYSTEM_ACTOR } from "./system-actor";
import { raiseFlag } from "../services/flagService";

/**
 * Expense match states the drain still tries; the test-data states are re-checked each run.
 * AMBIGUOUS and BEFORE_LINE wait for finance.
 */
export const POSTABLE_QB_STATES = ["UNMATCHED", "POST_FAILED", "NOT_TEST_DATA", "TEST_DATA_REFUSED"];

/** Claimed by a post whose QuickBooks call is in flight; qbClaimedAt says since when. */
export const POSTING = "POSTING";

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

export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting" | "not_sent" | "needs_finance" | "no_class";

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
  return rows.reduce((line, r) => {
    qboDate(r.receiptDate!);
    return r.receiptDate! > line ? r.receiptDate! : line;
  }, takeoverDate);
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
  await tx.expense.update({ where: { id: current.id }, data: { qbMatchState, qbPostAttempts: attempts, qbClaimedAt: null } });
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

function lockedExpense(tx: Db, orgId: string, expenseId: string) {
  return tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE`.then(() =>
    tx.expense.findFirstOrThrow({ where: { id: expenseId, orgId } }),
  );
}

/** A claim older than this belongs to a post that died between claim and settle; it may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;

function isPostable(e: Expense, now = Date.now()): boolean {
  if (e.backfill || e.qbTxnId) return false;
  if (e.qbMatchState === POSTING) return !!e.qbClaimedAt && now - e.qbClaimedAt.getTime() > STALE_CLAIM_MS;
  return POSTABLE_QB_STATES.includes(e.qbMatchState);
}

/** Locks the expense and runs `fn` on it when it is still waiting to be posted. */
function withPostable<T>(orgId: string, expenseId: string, fn: (tx: Db, current: Expense) => Promise<T>) {
  return db.$transaction(async (tx) => {
    const current = await lockedExpense(tx, orgId, expenseId);
    return isPostable(current) ? fn(tx, current) : ("waiting" as const);
  });
}

/** A claim this post holds: the row as it was before the claim, and when the claim was taken. */
type Claim = { before: Expense; at: Date };

/** Locks the expense and runs `fn` only while `claim` is still the one on the row. */
function withClaim<T>(orgId: string, expenseId: string, claim: Claim, fn: (tx: Db) => Promise<T>) {
  return db.$transaction(async (tx) => {
    const current = await lockedExpense(tx, orgId, expenseId);
    if (current.qbMatchState !== POSTING || current.qbClaimedAt?.getTime() !== claim.at.getTime()) {
      logWarn("qb_post_claim_lost", { expenseId, orgId });
      return "waiting" as const;
    }
    return fn(tx);
  });
}


/** What each outboxed expense posts: the sum of its lines, not the receipt total. */
async function postedCentsByExpense(expenseIds: string[]): Promise<Map<string, number>> {
  const lines = await db.expenseLineItem.findMany({
    where: { expenseId: { in: expenseIds } },
    select: { expenseId: true, totalPriceCents: true, allocatedTaxCents: true, allocatedShippingCents: true, allocatedDiscountCents: true },
  });
  const cents = new Map<string, number>();
  for (const l of lines) cents.set(l.expenseId, (cents.get(l.expenseId) ?? 0) + lineCents(l));
  return cents;
}

/** The rows an expense's entry is built from, keyed by model name for the outbound gateway. */
async function writeRows(client: Db, orgId: string, expense: Expense): Promise<OutboundBag> {
  const items = await client.expenseLineItem.findMany({ where: { expenseId: expense.id }, orderBy: { id: "asc" } });
  const approvals = await client.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id }, select: { lineItemId: true, ownerId: true } });
  const bucketIds = new Set(approvals.map((a) => a.ownerId));
  const buckets = (await getExpenseRuntime().budgetOwners.list()).filter((b) => bucketIds.has(b.id));
  const vendor =
    expense.needsReimbursement && expense.reimburseePersonId !== null
      ? await client.expenseReimburseeVendor.findFirst({ where: { orgId, reimburseePersonId: expense.reimburseePersonId } })
      : null;
  return {
    Expense: expense,
    ExpenseLineItem: items,
    LineItemOwnerApproval: approvals,
    BudgetOwner: buckets,
    ExpenseReimburseeVendor: vendor ? [vendor] : [],
  };
}

/** The entry to create for an outboxed expense, built only from what quickbooks.create's tiers let leave. */
async function buildWrite(client: Db, orgId: string, expense: Expense, posting: ExpensePosting): Promise<Built> {
  const rows = await writeRows(client, orgId, expense);
  return getExpenseRuntime().outbound("quickbooks.create", rows, async (stripped) => composeWrite(stripped, posting));
}

type SettleData = { qbMatchState: string; qbTxnId?: string; qbTxnEntity?: string; qbVendorId?: string; qbMatchBaseline?: string | null };

async function settle(tx: Db, before: Expense, outcome: PostOutcome, data: SettleData, notes?: string): Promise<PostOutcome> {
  await tx.expense.update({ where: { id: before.id }, data: { ...data, qbClaimedAt: null } });
  if (before.qbMatchState === data.qbMatchState && !data.qbTxnId) return outcome;
  await writeAudit(tx, SYSTEM_ACTOR, {
    expenseId: before.id,
    action: `qb_${data.qbMatchState.toLowerCase()}`,
    fieldChanged: "qbMatchState",
    valueBefore: before.qbMatchState,
    valueAfter: data.qbTxnId ? `${data.qbMatchState}:${data.qbTxnId}` : data.qbMatchState,
    notes: notes ?? null,
  });
  return outcome;
}

export type PostOptions = {
  /** The drain's run-alone slot: the one post allowed past the per-expense ceiling. */
  allowOverCap?: boolean;
};

/**
 * One expense's turn through the outbox. found by key or created → CREATED; found by amount →
 * MATCHED; ambiguous or an unmapped reimbursee → AMBIGUOUS; on or before the takeover line, or
 * covered by the QuickBooks books closing date (read before the create, or refused as fault 6210) →
 * BEFORE_LINE; a failure (QuickBooks down, rejected, or a thrown error) → POST_FAILED, retried by
 * the drain until MAX_POST_ATTEMPTS, then NEEDS_FINANCE with a flag (finance's retry re-arms it); an
 * expense the test-data gate stops → NOT_TEST_DATA / TEST_DATA_REFUSED, re-checked each run. A line
 * whose bucket has no QuickBooks Class → no_class, state unchanged, flagged QB_NO_CLASS, re-checked each
 * run. An
 * expense whose lines sum past MAX_CREATE_CENTS_PER_RUN is left for the drain's run-alone slot and
 * flagged QB_OVER_CAP. At MAX_CREATES_PER_DAY the expense waits for the next UTC day, nothing
 * recorded. With no takeover date configured nothing is posted.
 *
 * Claim, call, settle: the lines, sign-off seats and line approvals are re-read under the row lock
 * (a hold waits, and on a closed expense raises QB_POST_HELD) and the row is
 * claimed (POSTING); the QuickBooks call runs outside any transaction; the outcome is settled in a
 * new one only if the claim is still ours.
 */
export async function postExpenseToQb(
  orgId: string,
  expenseId: string,
  opts: PostOptions = {},
): Promise<PostOutcome | "unbound" | "no_takeover_date"> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting) return "unbound";
  if (!posting.takeoverDate) {
    logWarn("qb_post_no_takeover_date", { expenseId, orgId });
    return "no_takeover_date";
  }

  let claim: Claim | null = null;
  try {
    const claimed = await claimForPost(orgId, expenseId, posting, opts);
    if (typeof claimed === "string") return claimed;
    claim = claimed.claim;
    return await callAndSettle(orgId, expenseId, posting, posting.takeoverDate, claimed);
  } catch (err) {
    // The failing transaction rolled back, so the failure is recorded in a fresh one.
    logError("qb_post_threw", { expenseId, orgId }, err);
    const error = err instanceof Error ? err.message : String(err);
    const held = claim;
    return held
      ? withClaim(orgId, expenseId, held, (tx) => recordFailure(tx, held.before, error))
      : withPostable(orgId, expenseId, (tx, current) => recordFailure(tx, current, error));
  }
}

type Claimed = { claim: Claim; write: TxnWrite; lineAccounts: Map<number, string> };

/** Line approvals that let an expense post. */
const POSTABLE_APPROVALS = ["approved", "finance_assigned"];

/** Why an expense may not post: an unknown reimbursee, an unfilled seat or Board authorization, or a line not approved. */
async function postingHold(tx: Db, e: Expense): Promise<string | null> {
  if (reimburseeUnknown(e)) return "the reimbursee is unknown";
  const holds = new Set([...(await unsignedLines(tx, e)).values()].flat());
  const board = holds.delete("BOARD_AUTHORIZATION");
  const reasons = [...(holds.size > 0 ? ["a line is missing a sign-off seat"] : []), ...(board ? ["the Board authorization is missing"] : [])];
  if (reasons.length > 0) return reasons.join(", and ");
  const unapproved = await tx.lineItemOwnerApproval.count({ where: { expenseId: e.id, status: { notIn: POSTABLE_APPROVALS } } });
  return unapproved > 0 ? "a line is not approved: it is pending, under exception, or rejected" : null;
}

/**
 * Raises QB_POST_HELD with the hold's reason. A check-off covers that reason only: the same reason
 * stays checked off on later drains, and a new one reopens the flag with it.
 */
async function flagHeld(tx: Db, expenseId: string, detail: string): Promise<void> {
  const flag = await tx.expenseFlag.findFirst({ where: { expenseId, kind: "QB_POST_HELD" } });
  if (!flag) return raiseFlag(expenseId, "QB_POST_HELD", detail, tx);
  if (flag.detail === detail) return;
  await tx.expenseFlag.update({
    where: { id: flag.id },
    data: { detail, raisedAt: new Date(), checkedOffAt: null, checkedOffByUserId: null, checkedOffByUsername: null, notes: null },
  });
}

async function claimForPost(orgId: string, expenseId: string, posting: ExpensePosting, opts: PostOptions): Promise<PostOutcome | Claimed> {
  return withPostable(orgId, expenseId, async (tx, locked): Promise<PostOutcome | Claimed> => {
    // A stale claim is a post that died mid-call; it settles as a retry of a failed post.
    const current = locked.qbMatchState === POSTING ? { ...locked, qbMatchState: "POST_FAILED" } : locked;
    if (!(await tx.expenseEvent.findFirst({ where: { orgId, expenseId }, select: { id: true } }))) return "waiting";
    const held = await postingHold(tx, current);
    if (held) {
      logWarn("qb_post_held", { expenseId, orgId });
      // A closed expense takes no further sign-off or decision, so only finance can clear its hold.
      if (current.state === "qb_complete") await flagHeld(tx, expenseId, `closed but not posted: ${held}`);
      return "waiting";
    }

    const refused = notSendable(posting, current);
    if (refused) {
      if (posting.prod) logWarn("qb_post_test_data_refused", { expenseId, orgId });
      return settle(tx, current, "not_sent", { qbMatchState: refused.qbMatchState }, refused.note);
    }

    let built: Built;
    try {
      built = await buildWrite(tx, orgId, current, posting);
    } catch (e) {
      built = { error: e instanceof Error ? e.message : String(e) };
    }
    if ("error" in built) return recordFailure(tx, current, built.error);
    if ("queue" in built) return settle(tx, current, "queued", { qbMatchState: "AMBIGUOUS" }, built.queue);
    // State stays postable, so the next drain posts it once the bucket has a Class.
    if ("noClass" in built) {
      await raiseFlag(expenseId, "QB_NO_CLASS", built.noClass, tx);
      return "no_class";
    }

    const cents = built.write.fields.lines.reduce((s, l) => s + l.amountCents, 0);
    if (cents > MAX_CREATE_CENTS_PER_RUN && !opts.allowOverCap) {
      logWarn("qb_post_over_cap", { expenseId, orgId });
      await raiseFlag(expenseId, "QB_OVER_CAP", "queued for the drain: over the per-expense cap", tx);
      return "queued";
    }
    // ponytail: concurrent posts can each see the count under the ceiling, so a day may overshoot by the in-flight posts.
    if ((await qbCreatesToday(tx)) >= MAX_CREATES_PER_DAY) return "waiting";

    const at = new Date();
    await tx.expense.update({ where: { id: expenseId }, data: { qbMatchState: POSTING, qbClaimedAt: at } });
    return { claim: { before: current, at }, write: built.write, lineAccounts: built.lineAccounts };
  });
}

/**
 * The QuickBooks call holds no transaction or row lock. A crash after QuickBooks accepts and before
 * settle is safe: the entry carries the expense's key (sent as requestid and kept in its
 * PrivateNote), so the post that takes over the stale claim finds it by key instead of creating
 * a second one.
 */
async function callAndSettle(orgId: string, expenseId: string, posting: ExpensePosting, takeoverDate: string, claimed: Claimed): Promise<PostOutcome> {
  const { claim, write, lineAccounts } = claimed;
  const { before } = claim;
  const line = await expenseTakeoverLine(orgId, takeoverDate);
  const { claimedIds, excludedIds } = await claimedAndExcluded(orgId, write.entity === "Bill" ? "Bill" : "Purchase");
  const date = write.fields.txnDate;
  const result: FindOrCreateResult = await findOrCreate(posting.client, {
    write,
    key: qbKey("expense", expenseId),
    window: { from: shiftDate(date, -MATCH_WINDOW_DAYS), to: shiftDate(date, MATCH_WINDOW_DAYS) },
    closedThrough: line,
    mayCreate: true,
    claimedIds,
    excludedIds,
  });

  const qbMatchBaseline = result.kind === "found" && result.via === "amount" ? await matchBaseline(write.entity, result.id, date) : null;

  return withClaim(orgId, expenseId, claim, async (tx) => {
    switch (result.kind) {
      case "created":
      case "found": {
        const byAmount = result.kind === "found" && result.via === "amount";
        if (!(await claimQbTxn(tx, orgId, write.entity, result.id))) {
          const note = `QuickBooks ${write.entity} ${result.id} is already claimed by another expense or line`;
          // An entry the app posted for this expense is now a duplicate in QuickBooks.
          if (!byAmount) await raiseFlag(expenseId, "QB_POST_FAILED", `${note}; the entry posted for this expense needs voiding`, tx);
          return settle(tx, before, "queued", { qbMatchState: "AMBIGUOUS" }, note);
        }
        if (byAmount) {
          return settle(tx, before, "matched", { qbMatchState: "MATCHED", qbTxnId: result.id, qbTxnEntity: write.entity, qbMatchBaseline });
        }
        for (const [id, accountId] of lineAccounts) {
          await tx.expenseLineItem.update({ where: { id }, data: { qbAccountId: accountId } });
        }
        const qbVendorId = write.entity === "Bill" ? write.fields.vendorId : undefined;
        return settle(tx, before, "posted", { qbMatchState: "CREATED", qbTxnId: result.id, qbTxnEntity: write.entity, qbVendorId });
      }
      case "ambiguous":
        return settle(tx, before, "queued", { qbMatchState: "AMBIGUOUS" }, `candidates: ${result.ids.join(", ")}`);
      case "closed":
        return settle(tx, before, "queued", { qbMatchState: "BEFORE_LINE" });
      case "failed":
        return recordFailure(tx, before, result.error);
      case "needs-finance":
        return settle(tx, before, "waiting", { qbMatchState: before.qbMatchState });
    }
  });
}

export type DrainCounts = Record<PostOutcome, number> & { overCap: number; capped: "count" | "cents" | "day" | null; stoppedAfterFailures: boolean };

/** Consecutive failed posts after which a drain run stops: QuickBooks is likely down. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * The catch-up drain: every outboxed expense not yet in QuickBooks, oldest receipt first, plus any
 * claim gone stale. Stops at the daily, count and cents caps (measured on the posted line sum) and logs
 * the hit (the alarm hook); the rest waits for the next run. An expense over the cents cap on its
 * own is posted alone, as the first post of a run, and flagged for finance. Stops after
 * MAX_CONSECUTIVE_FAILURES failures in a row. Returns counts only.
 */
export async function drainExpenseOutbox(): Promise<DrainCounts | "unbound" | "no_takeover_date"> {
  const posting = getExpenseRuntime().quickbooks.posting;
  if (!posting) return "unbound";
  if (!posting.takeoverDate) {
    logWarn("qb_drain_no_takeover_date", {});
    return "no_takeover_date";
  }
  const outboxed = new Set((await db.expenseEvent.findMany({ select: { expenseId: true } })).map((e) => e.expenseId));
  const now = Date.now();
  const due = (
    await db.expense.findMany({
      where: { backfill: false, qbTxnId: null, qbMatchState: { in: [...POSTABLE_QB_STATES, POSTING] } },
      orderBy: [{ receiptDate: "asc" }, { submittedAt: "asc" }],
    })
  ).filter((e) => outboxed.has(e.id) && isPostable(e, now));
  const centsOf = await postedCentsByExpense(due.map((e) => e.id));

  const counts: DrainCounts = {
    posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, not_sent: 0, needs_finance: 0, no_class: 0,
    overCap: 0, capped: null, stoppedAfterFailures: false,
  };
  let postedCents = 0;
  let failuresInARow = 0;
  const createdBefore = await qbCreatesToday();
  for (const [i, e] of due.entries()) {
    if (createdBefore + counts.posted >= MAX_CREATES_PER_DAY) {
      counts.capped = "day";
      logWarn("qb_daily_cap", { cap: MAX_CREATES_PER_DAY, remaining: due.length - i });
      break;
    }
    const cents = centsOf.get(e.id) ?? 0;
    const alone = cents > MAX_CREATE_CENTS_PER_RUN && counts.posted === 0;
    if (!alone && (counts.posted >= MAX_CREATES_PER_RUN || postedCents + cents > MAX_CREATE_CENTS_PER_RUN)) {
      counts.capped = counts.posted >= MAX_CREATES_PER_RUN ? "count" : "cents";
      logWarn("qb_drain_capped", { cap: counts.capped, remaining: due.length - i });
      break;
    }
    let outcome: PostOutcome;
    try {
      const result = await postExpenseToQb(e.orgId, e.id, { allowOverCap: alone });
      if (result === "unbound" || result === "no_takeover_date") break;
      outcome = result;
    } catch (err) {
      outcome = "failed";
      logError("qb_drain_failed", { expenseId: e.id, orgId: e.orgId }, err);
    }
    counts[outcome]++;
    // No QuickBooks call was made for a missing Class, so it says nothing about QuickBooks being down.
    if (outcome !== "no_class") failuresInARow = outcome === "failed" || outcome === "needs_finance" ? failuresInARow + 1 : 0;
    if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      counts.stoppedAfterFailures = true;
      logWarn("qb_drain_failure_streak", { failures: failuresInARow, remaining: due.length - i - 1 });
      break;
    }
    if (outcome === "posted") postedCents += cents;
    if (alone && outcome === "posted") {
      counts.overCap++;
      logWarn("qb_drain_over_cap", { expenseId: e.id, orgId: e.orgId });
      await raiseFlag(e.id, "QB_OVER_CAP", "posted alone: over the per-run cap");
      counts.capped = "cents";
      break;
    }
  }
  return counts;
}
