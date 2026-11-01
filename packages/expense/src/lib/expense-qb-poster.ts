// QB-2 write path: drains the ExpenseEvent outbox into QuickBooks, one entry per expense
// (a Bill to the reimbursee's Vendor, else a Purchase from the payment account), match before create.
import { ServiceError } from "@checkin/component-kit";
import { sumCents } from "@checkin/money";
import {
  MAX_CONSECUTIVE_FAILURES, MAX_POST_ATTEMPTS, STALE_CLAIM_MS, SWEEP_DAYS, TEST_PREFIX, findOrCreate, qbGate, qbKey, readCloseDate, runDrain, shiftDate,
  type CloseRead, type FindOrCreateResult, type PostGate, type QboPurchase, type TxnWrite,
} from "@checkin/quickbooks";
import { db, type Db } from "../db";
import type { ExpensePosting, OutboundBag } from "../contract";
import type { Expense } from "../db/schema";
import { getExpenseRuntime, getOrgId } from "../runtime";
import {
  appKeysOf, claimQbTxn, claimedQbTxnIds, lookupOwnEntry, type OwnEntry, type QbMatchEntity,
} from "../services/qbMatchService";
import { writeAudit } from "./audit";
import type { Actor } from "./workflow-engine";
import { matchedBaseline } from "./expense-qb-drift";
import { composeWrite, type Built } from "../qb-write";
import { logError, logWarn } from "./logger";
import { reimburseeUnknown } from "./signoff";
import { unsignedLines } from "./signoff-facts";
import { SYSTEM_ACTOR } from "./system-actor";
import type { ExpenseSettings } from "../contract";
import { readExpenseSettings } from "../services/settingsService";
import { checkOffHeldOnPost, raiseFlag, raiseStray } from "../services/flagService";
import { NEEDS_VOIDING } from "./flags";

/**
 * Expense match states the drain still tries; the test-data states are re-checked each run.
 * AMBIGUOUS and UNBOOKED wait for finance. UNBOOKED is an expense not in QuickBooks that the drain
 * may not create: dated in closed books, or submitted before posting switched on. Finance books it
 * or matches it.
 */
export const POSTABLE_QB_STATES = ["UNMATCHED", "POST_FAILED", "NOT_TEST_DATA", "TEST_DATA_REFUSED"];

/** Claimed by a post whose QuickBooks call is in flight; qbClaimedAt says since when. */
export const POSTING = "POSTING";

/** Why an expense must not reach this QuickBooks company, or null when it may. */
function notSendable(posting: ExpensePosting, e: { isTestData: boolean; vendorName: string | null }) {
  if (posting.prod) {
    return e.isTestData ? { qbMatchState: "TEST_DATA_REFUSED", note: "not sent to QuickBooks: test data is never posted in prod" } : null;
  }
  return e.isTestData && (e.vendorName ?? "").startsWith(TEST_PREFIX)
    ? null
    : { qbMatchState: "NOT_TEST_DATA", note: "not sent to QuickBooks: not test data" };
}

export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting" | "not_sent" | "needs_finance" | "no_class";

/** When the lane's posting switched on, or null while it is off. */
export async function qbPostingOnAt(orgId: string, client: Db = db): Promise<Date | null> {
  return (await client.expenseOrgSettings.findUnique({ where: { orgId }, select: { qbPostingOnAt: true } }))?.qbPostingOnAt ?? null;
}

/** Switches the lane's posting on: the stamp is written only while unset, in one statement, so it never moves. */
export async function switchQbPostingOn(orgId: string, now = new Date()): Promise<Date> {
  await db.expenseOrgSettings.createMany({ data: [{ orgId }], skipDuplicates: true });
  await db.$transaction(async (tx) => {
    const { count } = await tx.expenseOrgSettings.updateMany({ where: { orgId, qbPostingOnAt: null }, data: { qbPostingOnAt: now } });
    if (count === 0) return;
    await tx.expenseOrgSettingsChange.create({
      data: {
        orgId,
        actorUserId: SYSTEM_ACTOR.userId,
        actorUsername: SYSTEM_ACTOR.username,
        before: JSON.stringify({ qbPostingOnAt: null }),
        after: JSON.stringify({ qbPostingOnAt: now.toISOString() }),
      },
    });
  });
  const at = await qbPostingOnAt(orgId);
  if (!at) throw new Error("the expense posting stamp did not save");
  return at;
}

/** How one post runs: `book` is finance's "book it"; `close` and `settings` are what the run already read. */
export type PostOptions = { book?: boolean; close?: CloseRead; settings?: ExpenseSettings };

/** QuickBooks entries created since UTC midnight, counted from the audit rows settle() writes. */
export async function qbCreatesToday(client: Db = db): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return client.expenseAuditLog.count({ where: { action: "qb_created", changedAt: { gte: midnight } } });
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

/** Every failure is recorded; at the limit the drain stops retrying and the expense waits on finance (NEEDS_FINANCE). */
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
  return exhausted ? "needs_finance" : "failed";
}

function lockedExpense(tx: Db, orgId: string, expenseId: string) {
  return tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE`.then(() =>
    tx.expense.findFirstOrThrow({ where: { id: expenseId, orgId } }),
  );
}

/** Whether a post may take the expense; finance's "book it" also takes an UNBOOKED one. */
function isPostable(e: Expense, now = Date.now(), book = false): boolean {
  if (e.backfill || e.qbTxnId) return false;
  if (e.qbMatchState === POSTING) return !!e.qbClaimedAt && now - e.qbClaimedAt.getTime() > STALE_CLAIM_MS;
  return POSTABLE_QB_STATES.includes(e.qbMatchState) || (book && e.qbMatchState === "UNBOOKED");
}

/** Locks the expense and runs `fn` on it when it is still waiting to be posted. */
function withPostable<T>(orgId: string, expenseId: string, fn: (tx: Db, current: Expense) => Promise<T>, book = false) {
  return db.$transaction(async (tx) => {
    const current = await lockedExpense(tx, orgId, expenseId);
    return isPostable(current, Date.now(), book) ? fn(tx, current) : ("waiting" as const);
  });
}

/** A claim this post holds: the row as it was before the claim, and when the claim was taken. */
type Claim = { before: Expense; at: Date };

/**
 * Locks the expense and runs `fn` only while `claim` is still the one on the row. A post that lost
 * its claim after creating an entry raises QB_DUPLICATE_TO_VOID with the entry's id, unless the
 * expense now holds that entry.
 */
function withClaim<T>(orgId: string, expenseId: string, claim: Claim, fn: (tx: Db) => Promise<T>, created?: { entity: string; id: string }) {
  return db.$transaction(async (tx) => {
    const current = await lockedExpense(tx, orgId, expenseId);
    if (current.qbMatchState !== POSTING || current.qbClaimedAt?.getTime() !== claim.at.getTime()) {
      logWarn("qb_post_claim_lost", { expenseId, orgId });
      if (created && current.qbTxnId !== created.id) {
        await raiseStray(tx, expenseId, `${created.entity}:${created.id}`, `QuickBooks ${created.entity} ${created.id} was created by a post that lost its claim; it ${NEEDS_VOIDING} or linking`);
      }
      return "waiting" as const;
    }
    return fn(tx);
  });
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
  if (data.qbTxnId) await checkOffHeldOnPost(tx, before.id);
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

/**
 * One expense's turn through the outbox. An expense attempted before first looks for its own entry
 * created since then: its own → CREATED; held by another record, unsure, or the read failed →
 * NEEDS_FINANCE with the reason; none → on to findOrCreate. Found by key or created → CREATED;
 * found by amount → MATCHED, its baseline taken from the read that matched it; ambiguous or an
 * unmapped reimbursee → AMBIGUOUS; dated in closed books (by the closing date read for the run,
 * re-read before the create, or refused as fault 6210), or not allowed to create → UNBOOKED for
 * finance; a failure (QuickBooks down, rejected, or a thrown error) → POST_FAILED, retried by the
 * drain until MAX_POST_ATTEMPTS, then NEEDS_FINANCE (finance's retry re-arms it); an expense the
 * test-data gate stops → NOT_TEST_DATA / TEST_DATA_REFUSED, re-checked each run. A line whose bucket
 * has no QuickBooks Class → no_class, state unchanged, re-checked each run. At the daily create limit the
 * expense waits for the next UTC day, nothing recorded. With the closing date unread nothing is
 * created, and a miss leaves the expense as it is.
 *
 * Claim, call, settle: the lines, sign-off seats and line approvals are re-read under the row lock
 * (a hold waits, and on a closed expense raises QB_POST_HELD) and the row is claimed (POSTING),
 * stamping the first create attempt when the gate lets this post create; the QuickBooks calls run
 * outside any transaction; the outcome is settled in a new one only if the claim is still ours.
 */
export async function postExpenseToQb(orgId: string, expenseId: string, opts: PostOptions = {}): Promise<PostOutcome | "unbound"> {
  const posting = await getExpenseRuntime().quickbooks.posting();
  if (!posting) return "unbound";
  const book = opts.book ?? false;

  let claim: Claim | null = null;
  try {
    const [close, onAt, settings] = await Promise.all([opts.close ?? readCloseDate(posting.client), qbPostingOnAt(orgId), opts.settings ?? readExpenseSettings(db, orgId)]);
    const claimed = await claimForPost(orgId, expenseId, posting, { close, onAt, book, settings });
    if (typeof claimed === "string") return claimed;
    claim = claimed.claim;
    return await callAndSettle(orgId, expenseId, posting, claimed, close, settings.qbMatchWindowDays);
  } catch (err) {
    // The failing transaction rolled back, so the failure is recorded in a fresh one.
    logError("qb_post_threw", { expenseId, orgId }, err);
    const error = err instanceof Error ? err.message : String(err);
    const held = claim;
    return held
      ? withClaim(orgId, expenseId, held, (tx) => recordFailure(tx, held.before, error))
      : withPostable(orgId, expenseId, (tx, current) => recordFailure(tx, current, error), book);
  }
}

type Claimed = {
  claim: Claim;
  write: TxnWrite;
  lineAccounts: Map<number, string>;
  gate: PostGate;
  /** The first create attempt as it stood before this claim; null when none may have landed. */
  attemptedAt: Date | null;
  /** Submitted after posting switched on. */
  afterSwitchOn: boolean;
};

type ClaimInputs = { close: CloseRead; onAt: Date | null; book: boolean; settings: ExpenseSettings };

/**
 * Why an expense may not post: an unknown reimbursee, an unfilled seat or Board approval, or a
 * line not approved. The approval is the program approver's sign-off.
 */
async function postingHold(tx: Db, e: Expense): Promise<string | null> {
  if (reimburseeUnknown(e)) return "the reimbursee is unknown";
  const holds = new Set([...(await unsignedLines(tx, e)).values()].flat());
  const approval = holds.delete("BOARD_APPROVAL");
  const reasons = [...(holds.size > 0 ? ["a line is missing a sign-off seat"] : []), ...(approval ? ["the Board's approval of a purchase at or over the Board-review total is not recorded"] : [])];
  if (reasons.length > 0) return reasons.join(", and ");
  const unapproved = await tx.lineItemOwnerApproval.count({ where: { expenseId: e.id, status: { not: "approved" } } });
  return unapproved > 0 ? "a line is not approved: it is pending, under exception, waiting for its new bucket's approver, or rejected" : null;
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

async function claimForPost(orgId: string, expenseId: string, posting: ExpensePosting, inputs: ClaimInputs): Promise<PostOutcome | Claimed> {
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
    if ("noClass" in built) return "no_class";

    // ponytail: concurrent posts can each see the count under the ceiling, so a day may overshoot by the in-flight posts.
    if ((await qbCreatesToday(tx)) >= inputs.settings.qbMaxCreatesPerDay) return "waiting";

    const date = built.write.fields.txnDate;
    const gate = qbGate(date, inputs.close, inputs.onAt, current.submittedAt, inputs.book);
    const at = new Date();
    // Only a post that may create marks the attempt: one that can only match leaves nothing to find later.
    const mayLand = gate.mayCreate && date > gate.closedThrough;
    await tx.expense.update({
      where: { id: expenseId },
      data: { qbMatchState: POSTING, qbClaimedAt: at, qbCreateAttemptedAt: current.qbCreateAttemptedAt ?? (mayLand ? at : null) },
    });
    return {
      claim: { before: current, at },
      write: built.write,
      lineAccounts: built.lineAccounts,
      gate,
      attemptedAt: current.qbCreateAttemptedAt,
      afterSwitchOn: inputs.onAt !== null && current.submittedAt > inputs.onAt,
    };
  }, inputs.book);
}

/** A post's QuickBooks result: findOrCreate's, or the key lookup's when it settles the expense first. */
type PostResult = FindOrCreateResult | { kind: "lookup"; own: Exclude<OwnEntry, { kind: "none" }> };

/**
 * The QuickBooks calls hold no transaction or row lock. A crash after QuickBooks accepts and before
 * settle is safe: the claim stamped the attempt, so the post that takes over the stale claim looks
 * up the entry created since then by the expense's key (kept in its PrivateNote) instead of
 * creating a second one.
 */
async function callAndSettle(orgId: string, expenseId: string, posting: ExpensePosting, claimed: Claimed, close: CloseRead, windowDays: number): Promise<PostOutcome> {
  const { claim, write, lineAccounts, gate, attemptedAt, afterSwitchOn } = claimed;
  const { before } = claim;
  const entity: QbMatchEntity = write.entity === "Bill" ? "Bill" : "Purchase";
  const date = write.fields.txnDate;
  const own: OwnEntry = attemptedAt ? await lookupOwnEntry(posting.client, orgId, expenseId, entity, attemptedAt) : { kind: "none" };
  let result: PostResult;
  if (own.kind !== "none") {
    result = { kind: "lookup", own };
  } else {
    const { claimedIds, excludedIds } = await claimedAndExcluded(orgId, entity);
    result = await findOrCreate(posting.client, {
      write,
      key: qbKey("expense", expenseId),
      window: { from: shiftDate(date, -windowDays), to: shiftDate(date, windowDays) },
      closedThrough: gate.closedThrough,
      mayCreate: gate.mayCreate,
      claimedIds,
      excludedIds,
    });
  }
  const qbVendorId = write.entity === "Bill" ? write.fields.vendorId : undefined;

  /** Links the entry the app created for this expense: CREATED, with each line's posted account. */
  const linkCreated = async (tx: Db, id: string, notes?: string): Promise<PostOutcome> => {
    if (!(await claimQbTxn(tx, orgId, entity, id))) {
      const note = `QuickBooks ${entity} ${id} is already claimed by another expense or line`;
      // An entry the app posted for this expense is now a duplicate in QuickBooks.
      await raiseStray(tx, expenseId, `${entity}:${id}`, `${note}; the entry posted for this expense ${NEEDS_VOIDING}`);
      return settle(tx, before, "queued", { qbMatchState: "AMBIGUOUS" }, note);
    }
    for (const [lineId, accountId] of lineAccounts) {
      await tx.expenseLineItem.update({ where: { id: lineId }, data: { qbAccountId: accountId } });
    }
    return settle(tx, before, "posted", { qbMatchState: "CREATED", qbTxnId: id, qbTxnEntity: entity, qbVendorId }, notes);
  };

  return withClaim(
    orgId,
    expenseId,
    claim,
    async (tx) => {
      switch (result.kind) {
        case "lookup":
          if (result.own.kind === "own") return linkCreated(tx, result.own.entry.Id, "the app had already booked this expense");
          return settle(tx, before, "needs_finance", { qbMatchState: "NEEDS_FINANCE" }, result.own.note);
        case "created":
          return linkCreated(tx, result.id);
        case "found": {
          if (result.via === "key") return linkCreated(tx, result.id);
          if (!(await claimQbTxn(tx, orgId, entity, result.id))) {
            return settle(tx, before, "queued", { qbMatchState: "AMBIGUOUS" }, `QuickBooks ${entity} ${result.id} is already claimed by another expense or line`);
          }
          const amountCents = sumCents(...write.fields.lines.map((l) => l.amountCents));
          const qbMatchBaseline = matchedBaseline({ amountCents, txnDate: result.txnDate, vendorId: qbVendorId ?? null });
          return settle(tx, before, "matched", { qbMatchState: "MATCHED", qbTxnId: result.id, qbTxnEntity: entity, qbMatchBaseline });
        }
        case "ambiguous":
          return settle(tx, before, "queued", { qbMatchState: "AMBIGUOUS" }, `candidates: ${result.ids.join(", ")}`);
        case "closed":
          // Submitted after switch-on yet dated in closed books: finance is told on the expense too.
          if (afterSwitchOn) await flagHeld(tx, expenseId, `submitted after QuickBooks posting switched on, but dated ${date}, in closed books`);
          return settle(tx, before, "queued", { qbMatchState: "UNBOOKED" }, `dated ${date}, on or before the books closing date`);
        case "needs-finance":
          if (!close.ok) return settle(tx, before, "waiting", { qbMatchState: before.qbMatchState });
          return settle(tx, before, "queued", { qbMatchState: "UNBOOKED" });
        case "failed":
          return recordFailure(tx, before, result.error);
      }
    },
    result.kind === "created" ? { entity, id: result.id } : undefined,
  );
}

/**
 * Finance's "book it" on an UNBOOKED expense: one post now with creating allowed, outside the
 * per-run cap but inside the daily one. It still looks for the app's own entry, matches first,
 * needs every sign-off, and stops at the books closing date, read now. Anything short of a booked
 * entry answers an error naming where the expense now waits.
 */
export async function bookExpenseToQb(orgId: string, expenseId: string, actor: Actor): Promise<void> {
  const posting = await getExpenseRuntime().quickbooks.posting();
  if (!posting) throw new ServiceError(503, "QuickBooks is not connected");
  const close = await readCloseDate(posting.client);
  if (!close.ok) throw new ServiceError(503, "The QuickBooks books closing date could not be read");
  if (close.date === null && (await qbPostingOnAt(orgId)) === null) {
    throw new ServiceError(409, "QuickBooks has no books closing date set and expense posting is not switched on; set the closing date in QuickBooks first");
  }
  await writeAudit(db, actor, { expenseId, action: "qb_book_requested", notes: `books closed through ${close.date ?? "no date"}` });
  const outcome = await postExpenseToQb(orgId, expenseId, { book: true, close });
  if (outcome === "unbound") throw new ServiceError(503, "QuickBooks is not connected");
  const saved = await db.expense.findFirstOrThrow({ where: { id: expenseId, orgId }, select: { qbMatchState: true } });
  switch (saved.qbMatchState) {
    case "CREATED":
    case "MATCHED":
      return;
    case "UNBOOKED":
      throw new ServiceError(
        409,
        outcome === "waiting"
          ? "Not booked yet: a sign-off is missing, the daily limit is reached, or a post is in flight; try again later"
          : "The expense is dated in closed books; it can only be matched",
      );
    case "POST_FAILED":
      throw new ServiceError(503, "QuickBooks failed while booking; the expense waits as POST_FAILED and the drain retries it");
    default:
      throw new ServiceError(409, `Not booked: the expense now waits as ${saved.qbMatchState}`);
  }
}

export type SweepCounts = { entries: number; flagged: number; full: boolean } | { failed: true };

export type DrainCounts = Record<PostOutcome, number> & {
  capped: "count" | "day" | null;
  stoppedAfterFailures: boolean;
  closeDateRead: boolean;
  sweep: SweepCounts;
};

/**
 * The daily orphan sweep. Reads every Purchase and Bill created since the oldest create attempt in
 * the last SWEEP_DAYS and finds the expense each app key belongs to. An app entry
 * its expense does not hold raises QB_DUPLICATE_TO_VOID, once per entry; a capped read alerts finance
 * once per run, and a key with no attempted expense is logged. QuickBooks is only read. An
 * expense mid-post is skipped; the next sweep sees it.
 */
export async function sweepExpenseQbStrays(orgId: string, posting: ExpensePosting, now = new Date()): Promise<SweepCounts> {
  const oldest = await db.expense.findFirst({
    where: { orgId, qbCreateAttemptedAt: { gte: new Date(now.getTime() - SWEEP_DAYS * 86_400_000) } },
    orderBy: { qbCreateAttemptedAt: "asc" },
    select: { qbCreateAttemptedAt: true },
  });
  if (!oldest?.qbCreateAttemptedAt) return { entries: 0, flagged: 0, full: false };
  const since = oldest.qbCreateAttemptedAt;
  const reads: { entity: QbMatchEntity; entries: QboPurchase[]; full: boolean }[] = [];
  try {
    for (const entity of ["Purchase", "Bill"] as const) reads.push({ entity, ...(await posting.client.createdSince(entity, since)) });
  } catch (err) {
    logError("qb_sweep_read_failed", { orgId }, err);
    return { failed: true };
  }
  if (reads.some((r) => r.full)) {
    try {
      await posting.sweepIncomplete({ orgId, since });
    } catch (err) {
      logError("qb_sweep_alert_failed", { orgId }, err);
    }
  }
  const attempted = await db.expense.findMany({ where: { orgId, qbCreateAttemptedAt: { not: null } }, select: { id: true } });
  const byKey = new Map(attempted.map((e) => [qbKey("expense", e.id), e.id]));
  let entries = 0;
  let flagged = 0;
  for (const { entity, entries: read, full } of reads) {
    entries += read.length;
    if (full) logWarn("qb_sweep_full_page", { orgId, entity, since: since.toISOString() });
    for (const entry of read) {
      for (const key of appKeysOf(entry)) {
        if (!key.startsWith("expense:")) continue;
        const expenseId = byKey.get(key);
        if (expenseId === undefined) {
          logWarn("qb_sweep_unknown_key", { orgId, entity, qbTxnId: entry.Id });
          continue;
        }
        const detail = `QuickBooks ${entity} ${entry.Id} carries this expense's key but is not linked to it; void it or link it`;
        const raised = await db.$transaction(async (tx) => {
          const current = await lockedExpense(tx, orgId, expenseId);
          if (current.qbMatchState === POSTING) return false;
          if (current.qbTxnEntity === entity && current.qbTxnId === entry.Id) return false;
          return raiseStray(tx, expenseId, `${entity}:${entry.Id}`, detail);
        });
        if (raised) flagged++;
      }
    }
  }
  return { entries, flagged, full: reads.some((r) => r.full) };
}

/**
 * The catch-up drain. It switches the lane's posting on (once, for good) and reads the books
 * closing date once for the run. Then every outboxed expense not yet in QuickBooks, oldest receipt
 * first, plus any claim gone stale, and last the orphan sweep. Stops at the daily and per-run count
 * caps and logs the hit (the alarm hook); the rest waits for the next run. Stops after
 * MAX_CONSECUTIVE_FAILURES failures in a row. Returns counts only.
 */
export async function drainExpenseOutbox(now = new Date()): Promise<DrainCounts | "unbound"> {
  const posting = await getExpenseRuntime().quickbooks.posting();
  if (!posting) return "unbound";
  const orgId = await getOrgId();
  await switchQbPostingOn(orgId, now);
  const settings = await readExpenseSettings(db, orgId);
  const close = await readCloseDate(posting.client);
  if (!close.ok) logWarn("qb_drain_close_date_unread", { orgId, error: close.error.slice(0, 200) });
  const outboxed = new Set((await db.expenseEvent.findMany({ select: { expenseId: true } })).map((e) => e.expenseId));
  const due = (
    await db.expense.findMany({
      where: { backfill: false, qbTxnId: null, qbMatchState: { in: [...POSTABLE_QB_STATES, POSTING] } },
      orderBy: [{ receiptDate: "asc" }, { submittedAt: "asc" }],
    })
  ).filter((e) => outboxed.has(e.id) && isPostable(e, now.getTime()));

  const counts: DrainCounts = {
    posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, not_sent: 0, needs_finance: 0, no_class: 0,
    capped: null, stoppedAfterFailures: false, closeDateRead: close.ok, sweep: { entries: 0, flagged: 0, full: false },
  };
  const stop = await runDrain<Expense, PostOutcome>(due, {
    counts,
    maxCreatesPerRun: settings.qbMaxCreatesPerRun,
    maxCreatesPerDay: settings.qbMaxCreatesPerDay,
    createdToday: await qbCreatesToday(),
    failures: ["failed", "needs_finance"],
    // No QuickBooks call was made for a missing Class, so it says nothing about QuickBooks being down.
    noCall: ["no_class"],
    post: async (e) => {
      try {
        const result = await postExpenseToQb(e.orgId, e.id, { close, settings });
        return result === "unbound" ? null : result;
      } catch (err) {
        logError("qb_drain_failed", { expenseId: e.id, orgId: e.orgId }, err);
        return "failed";
      }
    },
  });
  if (stop?.by === "day") {
    counts.capped = "day";
    logWarn("qb_daily_cap", { cap: settings.qbMaxCreatesPerDay, remaining: stop.remaining });
  } else if (stop?.by === "count") {
    counts.capped = "count";
    logWarn("qb_drain_capped", { cap: settings.qbMaxCreatesPerRun, remaining: stop.remaining });
  } else if (stop?.by === "failures") {
    counts.stoppedAfterFailures = true;
    logWarn("qb_drain_failure_streak", { failures: MAX_CONSECUTIVE_FAILURES, remaining: stop.remaining });
  }
  // After the posts, so an expense this run linked to its own entry is not reported as a stray.
  counts.sweep = await sweepExpenseQbStrays(orgId, posting, now);
  return counts;
}
