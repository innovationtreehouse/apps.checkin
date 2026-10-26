// Finance's QuickBooks actions on an in-kind gift the drain handed over (QB_CLOSED_BOOKS §4 and §6):
// book it, skip it with a reason, or match it by id to entries finance booked by hand. Skip and
// match look first for the app's own entry when a create may have landed.
import { ServiceError } from "@checkin/component-kit";
import { dollarsToCents } from "@checkin/money";
import { appKeyOf } from "@checkin/quickbooks";
import { z } from "zod";
import { db, isUniqueConstraintError } from "../db";
import { recordEvent } from "../repositories/audit";
import { getInKindQbPosting } from "../runtime";
import { inKindAcceptService, inKindReadiness, type GiftToBook, type InKindSource } from "../services/inKindAcceptService";
import type { AuditContext } from "../workflows/disbursement.actor";
import {
  IN_KIND_HELD_STATES, IN_KIND_ROLES, claimedDepositIds, inKindAccountsReady, inKindKey, inKindPostingOnAt, lockPosting, lookupOwnJournal, postGift,
  writeSettlement, type Run, type Settlement,
} from "./in-kind-poster";
import { QB_MATCH_STATE } from "./qb-match";
import { readCloseDate } from "./qb-poster";

const qbId = z.string().trim().min(1).max(64);

export const InKindQbResolveInputSchema = z.union([
  z.object({ action: z.literal("book") }).strict(),
  z.object({ action: z.literal("skip"), reason: z.string().trim().min(1, "A reason is required to skip").max(500) }).strict(),
  z.object({ action: z.literal("match"), journalEntryId: qbId }).strict(),
  z.object({ action: z.literal("match"), depositId: qbId, purchaseId: qbId }).strict(),
]);
export type InKindQbResolveInput = z.infer<typeof InKindQbResolveInputSchema>;

type Actor = AuditContext & { actorUserId: number };
type GiftRef = Pick<GiftToBook, "source" | "id" | "entityType" | "entityId">;

async function giftRef(orgId: string, source: InKindSource, id: number): Promise<GiftRef> {
  if (source === "manual") {
    if (!(await db.manualInKindDonation.findFirst({ where: { orgId, id }, select: { id: true } }))) throw new ServiceError(404, "In-kind gift not found");
    return { source, id, entityType: "manual_in_kind", entityId: String(id) };
  }
  const row = await db.inKindDonation.findFirst({ where: { orgId, id }, select: { receiptId: true } });
  if (!row) throw new ServiceError(404, "In-kind gift not found");
  return { source, id, entityType: "in_kind", entityId: row.receiptId ?? String(id) };
}

/** The gift's posting, refused unless the drain handed it to finance. */
async function heldPosting(orgId: string, source: InKindSource, id: number) {
  const posting = await db.inKindPosting.findUnique({ where: { orgId_source_giftId: { orgId, source, giftId: id } } });
  if (!posting || !IN_KIND_HELD_STATES.includes(posting.matchState)) {
    throw new ServiceError(409, "Only a gift the QuickBooks drain handed to finance can be booked, skipped or matched");
  }
  return posting;
}

/** Everything a book or match reads: refused while QuickBooks is off or the books map lacks an in-kind account. */
async function openRun(orgId: string, actor: Actor): Promise<Run> {
  const binding = getInKindQbPosting();
  const client = await binding?.client();
  if (!binding || !client) throw new ServiceError(503, "QuickBooks is not connected");
  const [accounts, classes] = await Promise.all([binding.booksMap.accounts(), binding.booksMap.classes()]);
  if (!inKindAccountsReady(accounts, binding.laneBankAccountIds)) throw new ServiceError(409, "The books map does not name every in-kind account yet");
  const [close, onAt, ctx] = await Promise.all([readCloseDate(client), inKindPostingOnAt(orgId), inKindReadiness.readReadiness(orgId)]);
  const { open } = await inKindReadiness.giftsToBook(orgId, ctx);
  return { orgId, book: true, actor, client, accounts, classes, close, onAt, ctx, open };
}

/** The gift as its booking would carry it, refused unless booking is all it waits on. */
async function readyGift(run: Run, source: InKindSource, id: number): Promise<GiftToBook> {
  const gift = await db.$transaction((tx) => inKindReadiness.lockReadyGift(tx, run.orgId, source, id, run.ctx));
  if (!gift) throw new ServiceError(409, "This gift waits on more than booking; it can be booked or matched once nothing else is outstanding");
  return gift;
}

/** Saves a settlement finance made, while the gift is still finance's; another gift holding an entry is refused. */
async function settleByFinance(orgId: string, gift: GiftRef, s: Settlement, actor: Actor, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      const posting = await lockPosting(tx, orgId, gift.source, gift.id);
      if (!posting || !IN_KIND_HELD_STATES.includes(posting.matchState)) throw new ServiceError(409, "Already resolved");
      await writeSettlement(tx, orgId, gift, posting.id, s, actor, { from: posting.matchState, manual: true, ...payload });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, `QuickBooks ${s.entries.map((e) => `${e.entity} ${e.id}`).join(", ")} is already held by another gift`);
    throw err;
  }
}

/**
 * Before finance skips or matches a gift whose create may have landed, look for the app's own
 * JournalEntry. Found: the gift is linked to it as CREATED in place of the action. Unsure: refused.
 */
async function linkOwnFirst(orgId: string, gift: GiftRef, attemptedAt: Date | null, actor: Actor): Promise<boolean> {
  if (!attemptedAt) return false;
  const client = await getInKindQbPosting()?.client();
  if (!client) throw new ServiceError(503, "QuickBooks is not connected");
  const own = await lookupOwnJournal({ orgId, client }, gift, attemptedAt);
  if (!own) return false;
  if (own.state !== QB_MATCH_STATE.CREATED) throw new ServiceError(409, own.note ?? "The app may already have booked this gift");
  await settleByFinance(orgId, gift, own, actor, { note: "the app had already booked this gift" });
  return true;
}

/** Finance's pick, checked: a JournalEntry on in-kind accounts only, or a clearing-account pair, each for the gift's value. */
async function readMatch(run: Run, gift: GiftToBook, input: Extract<InKindQbResolveInput, { action: "match" }>): Promise<Settlement> {
  const key = inKindKey(run.orgId, gift.source, gift.id);
  if ("journalEntryId" in input) {
    const [je] = await run.client.journalEntriesByIds([input.journalEntryId]);
    if (!je) throw new ServiceError(422, `QuickBooks has no JournalEntry ${input.journalEntryId}`);
    if (dollarsToCents(je.TotalAmt) !== gift.totalCents) throw new ServiceError(422, `JournalEntry ${je.Id} is not for the gift's value`);
    const inKindAccounts = new Set(IN_KIND_ROLES.map((r) => run.accounts[r]));
    const lines = je.Line ?? [];
    if (lines.length === 0 || lines.some((l) => !inKindAccounts.has(l.JournalEntryLineDetail?.AccountRef?.value))) {
      throw new ServiceError(422, `JournalEntry ${je.Id} books to an account outside the in-kind accounts`);
    }
    const appKey = appKeyOf(je);
    if (appKey !== undefined && appKey !== key) throw new ServiceError(409, `JournalEntry ${je.Id} was created for another record`);
    return {
      state: appKey === key ? QB_MATCH_STATE.CREATED : QB_MATCH_STATE.MATCHED,
      note: null,
      entries: [{ side: "journal", entity: "JournalEntry", id: je.Id }],
      booked: { totalCents: gift.totalCents, txnDate: je.TxnDate },
    };
  }
  const clearing = run.accounts.INKIND_CLEARING;
  const [[deposit], [purchase], claimed] = await Promise.all([
    run.client.depositsByIds([input.depositId]),
    run.client.purchasesByIds([input.purchaseId]),
    claimedDepositIds(run.orgId),
  ]);
  if (!deposit) throw new ServiceError(422, `QuickBooks has no Deposit ${input.depositId}`);
  if (!purchase) throw new ServiceError(422, `QuickBooks has no Purchase ${input.purchaseId}`);
  if (deposit.DepositToAccountRef?.value !== clearing || purchase.AccountRef?.value !== clearing) {
    throw new ServiceError(422, "The Deposit must go into, and the Purchase come out of, the in-kind clearing account");
  }
  if (dollarsToCents(deposit.TotalAmt) !== gift.totalCents || dollarsToCents(purchase.TotalAmt) !== gift.totalCents) throw new ServiceError(422, "The Deposit and the Purchase must each be for the gift's value");
  if (appKeyOf(deposit) !== undefined || appKeyOf(purchase) !== undefined) throw new ServiceError(409, "That entry was created by the app for another record");
  if (claimed.has(deposit.Id)) throw new ServiceError(409, `Deposit ${deposit.Id} is already held by another record`);
  return {
    state: QB_MATCH_STATE.MATCHED,
    note: null,
    entries: [
      { side: "revenue", entity: "Deposit", id: deposit.Id },
      { side: "expense", entity: "Purchase", id: purchase.Id },
    ],
    booked: { totalCents: gift.totalCents, txnDate: deposit.TxnDate },
  };
}

async function match(orgId: string, source: InKindSource, id: number, input: Extract<InKindQbResolveInput, { action: "match" }>, actor: Actor): Promise<void> {
  const ref = await giftRef(orgId, source, id);
  const posting = await heldPosting(orgId, source, id);
  const run = await openRun(orgId, actor);
  const gift = await readyGift(run, source, id);
  if (await linkOwnFirst(orgId, ref, posting.qbCreateAttemptedAt, actor)) return;
  await settleByFinance(orgId, ref, await readMatch(run, gift, input), actor, {});
}

async function skip(orgId: string, source: InKindSource, id: number, reason: string, actor: Actor): Promise<void> {
  const why = reason.trim();
  if (!why) throw new ServiceError(400, "A reason is required to skip");
  const ref = await giftRef(orgId, source, id);
  const posting = await heldPosting(orgId, source, id);
  if (await linkOwnFirst(orgId, ref, posting.qbCreateAttemptedAt, actor)) return;
  await settleByFinance(orgId, ref, { state: QB_MATCH_STATE.DISMISSED, note: null, entries: [] }, actor, { reason: why });
}

/**
 * Finance's "book it": one post now with creating allowed before switch-on. It still looks for
 * the app's own entry and finance's clearing pair first, and stops at the books closing date, read
 * now. Anything short of a booked gift answers an error naming where it now waits.
 */
async function book(orgId: string, source: InKindSource, id: number, actor: Actor): Promise<void> {
  const ref = await giftRef(orgId, source, id);
  await heldPosting(orgId, source, id);
  const run = await openRun(orgId, actor);
  if (!run.close.ok) throw new ServiceError(503, "The QuickBooks books closing date could not be read");
  if (run.close.date === null && run.onAt === null) {
    throw new ServiceError(409, "QuickBooks has no books closing date set and in-kind posting is not switched on; set the closing date in QuickBooks first");
  }
  await readyGift(run, source, id);
  await recordEvent(db, { orgId, entityType: ref.entityType, entityId: ref.entityId, eventType: "IN_KIND_QB_BOOK_REQUESTED", ...actor, payload: { closedThrough: run.close.date } });
  const outcome = await postGift(run, source, id);
  if (outcome === "not_ready") throw new ServiceError(409, "This gift waits on more than booking");
  if (outcome === "busy") throw new ServiceError(409, "The gift is being posted; try again shortly");
  const saved = await db.inKindPosting.findUniqueOrThrow({ where: { orgId_source_giftId: { orgId, source, giftId: id } } });
  switch (saved.matchState) {
    case QB_MATCH_STATE.CREATED:
    case QB_MATCH_STATE.MATCHED:
      return;
    case QB_MATCH_STATE.UNBOOKED:
      throw new ServiceError(409, "The gift is dated in closed books; it can only be skipped");
    case QB_MATCH_STATE.POST_FAILED:
      throw new ServiceError(503, "QuickBooks failed while booking; the gift can be booked again");
    default:
      throw new ServiceError(409, `Not booked: the gift now waits as ${saved.matchState}${saved.qbNote ? ` (${saved.qbNote})` : ""}`);
  }
}

/** Book, skip or match one gift, then reply with its queue row. */
export async function resolveInKindQb(orgId: string, source: InKindSource, id: number, input: InKindQbResolveInput, actor: Actor) {
  switch (input.action) {
    case "book":
      await book(orgId, source, id, actor);
      break;
    case "skip":
      await skip(orgId, source, id, input.reason, actor);
      break;
    case "match":
      await match(orgId, source, id, input, actor);
      break;
  }
  return inKindAcceptService.queueItem(orgId, actor.actorUserId, source, id);
}
