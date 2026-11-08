// Finance's QuickBooks actions on an in-kind gift the drain handed over (docs/rules/revenue.md, Donations):
// book it, skip it with a reason, or match it by id to entries finance booked by hand. Skip and
// match look first for the app's own entry when a create may have landed. Clear answers a note.
// Set-account names a held line's account by hand, which the next book uses over every rule.
import { ServiceError } from "@checkin/component-kit";
import { dollarsToCents } from "@checkin/money";
import { LINE_ACCOUNT_TYPES, accountTypeRefusal, appKeyOf, liveRoleAccountIds, readCloseDate } from "@checkin/quickbooks";
import { z } from "zod";
import { db, isUniqueConstraintError } from "../db";
import { readDonationSettings } from "../services/settingsService";
import { recordEvent } from "../repositories/audit";
import { getInKindCapital, getInKindQbPosting, getQuickBooksAccounts } from "../runtime";
import { inKindAcceptService, inKindReadiness, type GiftToBook, type InKindSource } from "../services/inKindAcceptService";
import type { AuditContext } from "../workflows/disbursement.actor";
import {
  IN_KIND_HELD_STATES, IN_KIND_NOTE_CLEARED, answeredEntryRef, claimedDepositIds, inKindAccountsReady, inKindKey, inKindPostingOnAt,
  chartOfAccounts, lockPosting, lookupOwnJournal, postGift, strayEntriesOf, writeSettlement, type Run, type Settlement,
} from "./in-kind-poster";
import { QB_MATCH_STATE } from "./qb-match";

const qbId = z.string().trim().min(1).max(64);
/** The states finance may match or skip; a drifted gift is never booked. */
const RESOLVABLE_STATES: readonly string[] = [...IN_KIND_HELD_STATES, QB_MATCH_STATE.DRIFT];

export const InKindQbResolveInputSchema = z.union([
  z.object({ action: z.literal("book") }).strict(),
  z.object({ action: z.literal("skip"), reason: z.string().trim().min(1, "A reason is required to skip").max(500) }).strict(),
  z.object({ action: z.literal("match"), journalEntryId: qbId }).strict(),
  z.object({ action: z.literal("match"), depositId: qbId, purchaseId: qbId }).strict(),
  z.object({ action: z.literal("clear"), reason: z.string().trim().min(1, "A reason is required to clear a note").max(500) }).strict(),
  z.object({ action: z.literal("set-account"), lineId: z.number().int().positive(), quickBooksAccountId: z.string().trim().regex(/^\d{1,64}$/, "A QuickBooks account id is digits") }).strict(),
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

type HeldPosting = Awaited<ReturnType<typeof heldPosting>>;

/** The gift's posting, refused unless the drain handed it to finance. */
async function heldPosting(orgId: string, source: InKindSource, id: number, states = RESOLVABLE_STATES) {
  const posting = await db.inKindPosting.findUnique({ where: { orgId_source_giftId: { orgId, source, giftId: id } } });
  if (!posting || !states.includes(posting.matchState)) {
    throw new ServiceError(409, "Only a gift the QuickBooks drain handed to finance can be booked, skipped or matched");
  }
  return posting;
}

/** Everything a book, match or retry reads: refused while QuickBooks is off or the books map lacks an in-kind account. */
export async function openRun(orgId: string, actor: AuditContext, mode: "book" | "retry" = "book"): Promise<Run> {
  const binding = getInKindQbPosting();
  const client = await binding?.client();
  if (!binding || !client) throw new ServiceError(503, "QuickBooks is not connected");
  const [accounts, classes] = await Promise.all([binding.booksMap.accounts(), binding.booksMap.classes()]);
  if (!inKindAccountsReady(accounts)) throw new ServiceError(409, "The books map does not name every in-kind account yet");
  const [close, onAt, ctx] = await Promise.all([readCloseDate(client), inKindPostingOnAt(orgId), inKindReadiness.readReadiness(orgId)]);
  const { open } = await inKindReadiness.giftsToBook(orgId, ctx);
  return { orgId, book: mode === "book", retry: mode === "retry", actor, client, accounts, classes, close, onAt, ctx, open, settings: await readDonationSettings(db, orgId), qbAccounts: chartOfAccounts(client) };
}

/** The gift as its booking would carry it, refused unless booking is all it waits on. */
async function readyGift(run: Run, source: InKindSource, id: number): Promise<GiftToBook> {
  const gift = await db.$transaction((tx) => inKindReadiness.lockReadyGift(tx, run.orgId, source, id, run.ctx));
  if (!gift) throw new ServiceError(409, "This gift waits on more than booking; it can be booked or matched once nothing else is outstanding");
  return gift;
}

/**
 * Saves a settlement finance made, while the gift is still finance's and its posting is unchanged
 * since `read`: every claim moves `updatedAt`, so a create attempted meanwhile, first or retry, is
 * refused (it may have landed). Another gift holding an entry is refused too.
 */
async function settleByFinance(orgId: string, gift: GiftRef, read: HeldPosting, s: Settlement, actor: Actor, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      const posting = await lockPosting(tx, orgId, gift.source, gift.id);
      if (!posting || !RESOLVABLE_STATES.includes(posting.matchState)) throw new ServiceError(409, "Already resolved");
      if (posting.updatedAt.getTime() !== read.updatedAt.getTime()) throw new ServiceError(409, "The app may have tried to book this gift meanwhile; reload and try again");
      // A drifted gift's new entries replace the ones it held; a skip keeps them on record.
      if (posting.matchState === QB_MATCH_STATE.DRIFT && s.entries.length > 0) {
        await tx.inKindBooking.deleteMany({ where: { orgId, source: gift.source, giftId: gift.id } });
      }
      await writeSettlement(tx, orgId, gift, posting, s, actor, { from: posting.matchState, manual: true, ...payload });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, `QuickBooks ${s.entries.map((e) => `${e.entity} ${e.id}`).join(", ")} is already held by another gift`);
    throw err;
  }
}

/**
 * Before finance skips or matches a gift whose create may have landed, look for the app's own
 * JournalEntry. Found: the gift is linked to it as CREATED in place of the action. Unsure: refused.
 * A drifted gift already settled its create, so finance's pick stands.
 */
async function linkOwnFirst(orgId: string, gift: GiftRef, read: HeldPosting, actor: Actor): Promise<boolean> {
  if (!read.qbCreateAttemptedAt || read.matchState === QB_MATCH_STATE.DRIFT) return false;
  const client = await getInKindQbPosting()?.client();
  if (!client) throw new ServiceError(503, "QuickBooks is not connected");
  const own = await lookupOwnJournal({ orgId, client }, gift, read.qbCreateAttemptedAt);
  if (!own) return false;
  if (own.failure) throw new ServiceError(503, "The QuickBooks check for the app's own entry failed; try again shortly");
  if (own.state !== QB_MATCH_STATE.CREATED) throw new ServiceError(409, own.note ?? "The app may already have booked this gift");
  await settleByFinance(orgId, gift, read, own, actor, { note: "the app had already booked this gift" });
  return true;
}

/** Finance's pick, checked: a JournalEntry crediting in-kind income and debiting no books-map role's account, or a clearing-account pair, each for the gift's value. */
async function readMatch(run: Run, gift: GiftToBook, input: Extract<InKindQbResolveInput, { action: "match" }>): Promise<Settlement> {
  const key = inKindKey(run.orgId, gift.source, gift.id);
  if ("journalEntryId" in input) {
    const [je] = await run.client.journalEntriesByIds([input.journalEntryId]);
    if (!je) throw new ServiceError(422, `QuickBooks has no JournalEntry ${input.journalEntryId}`);
    if (dollarsToCents(je.TotalAmt) !== gift.totalCents) throw new ServiceError(422, `JournalEntry ${je.Id} is not for the gift's value`);
    const roleAccounts = liveRoleAccountIds(run.accounts);
    const fits = (l: NonNullable<typeof je.Line>[number]) => {
      const detail = l.JournalEntryLineDetail;
      const account = detail?.AccountRef?.value;
      if (detail?.PostingType === "Credit") return account === run.accounts.INKIND_INCOME;
      return detail?.PostingType === "Debit" && !!account && !roleAccounts.has(account);
    };
    const lines = je.Line ?? [];
    if (!lines.some((l) => l.JournalEntryLineDetail?.PostingType === "Credit") || !lines.every(fits)) {
      throw new ServiceError(422, `JournalEntry ${je.Id} must credit only in-kind income and debit no books-map account`);
    }
    const appKey = appKeyOf(je);
    if (appKey !== undefined && appKey !== key) throw new ServiceError(409, `JournalEntry ${je.Id} was created for another record`);
    return {
      state: appKey === key ? QB_MATCH_STATE.CREATED : QB_MATCH_STATE.MATCHED,
      note: null,
      entries: [{ side: "journal", entity: "JournalEntry", id: je.Id, txnDate: je.TxnDate }],
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
  const own = await db.inKindBooking.findFirst({ where: { orgId: run.orgId, source: gift.source, giftId: gift.id, qbEntity: "Deposit", qbTxnId: deposit.Id }, select: { id: true } });
  if (claimed.has(deposit.Id) && !own) throw new ServiceError(409, `Deposit ${deposit.Id} is already held by another record`);
  return {
    state: QB_MATCH_STATE.MATCHED,
    note: null,
    entries: [
      { side: "revenue", entity: "Deposit", id: deposit.Id, txnDate: deposit.TxnDate },
      { side: "expense", entity: "Purchase", id: purchase.Id, txnDate: purchase.TxnDate },
    ],
    booked: { totalCents: gift.totalCents, txnDate: deposit.TxnDate },
  };
}

async function match(orgId: string, source: InKindSource, id: number, input: Extract<InKindQbResolveInput, { action: "match" }>, actor: Actor): Promise<void> {
  const ref = await giftRef(orgId, source, id);
  const posting = await heldPosting(orgId, source, id);
  const run = await openRun(orgId, actor);
  const gift = await readyGift(run, source, id);
  if (await linkOwnFirst(orgId, ref, posting, actor)) return;
  await settleByFinance(orgId, ref, posting, await readMatch(run, gift, input), actor, {});
}

async function skip(orgId: string, source: InKindSource, id: number, reason: string, actor: Actor): Promise<void> {
  const why = reason.trim();
  if (!why) throw new ServiceError(400, "A reason is required to skip");
  const ref = await giftRef(orgId, source, id);
  const posting = await heldPosting(orgId, source, id);
  if (await linkOwnFirst(orgId, ref, posting, actor)) return;
  await settleByFinance(orgId, ref, posting, { state: QB_MATCH_STATE.DISMISSED, note: null, entries: [] }, actor, { reason: why });
}

/**
 * Finance's "book it": one post now with creating allowed before switch-on. It still looks for
 * the app's own entry and finance's clearing pair first, and stops at the books closing date, read
 * now. Anything short of a booked gift answers an error naming where it now waits.
 */
async function book(orgId: string, source: InKindSource, id: number, actor: Actor): Promise<void> {
  const ref = await giftRef(orgId, source, id);
  await heldPosting(orgId, source, id, IN_KIND_HELD_STATES);
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
  if (outcome === "failed") throw new ServiceError(503, "QuickBooks failed while booking; the gift can be booked again");
  const saved = await db.inKindPosting.findUniqueOrThrow({ where: { orgId_source_giftId: { orgId, source, giftId: id } } });
  switch (saved.matchState) {
    case QB_MATCH_STATE.CREATED:
    case QB_MATCH_STATE.MATCHED:
      return;
    case QB_MATCH_STATE.UNBOOKED:
      throw new ServiceError(409, "The gift is dated in closed books; it can only be skipped");
    default:
      throw new ServiceError(409, `Not booked: the gift now waits as ${saved.matchState}${saved.qbNote ? ` (${saved.qbNote})` : ""}`);
  }
}

/**
 * Answers a gift's note without another action, for example after voiding a stray entry in
 * QuickBooks. The stray entries it named are recorded as answered, so the sweep never notes them again.
 */
async function clearNote(orgId: string, source: InKindSource, id: number, reason: string, actor: Actor): Promise<void> {
  const why = reason.trim();
  if (!why) throw new ServiceError(400, "A reason is required to clear a note");
  const ref = await giftRef(orgId, source, id);
  await db.$transaction(async (tx) => {
    const posting = await lockPosting(tx, orgId, source, id);
    if (!posting?.qbNote) throw new ServiceError(409, "The gift has no note");
    if (posting.matchState === QB_MATCH_STATE.POSTING) throw new ServiceError(409, "The gift is being posted; try again shortly");
    await tx.inKindPosting.update({ where: { id: posting.id }, data: { qbNote: null } });
    await recordEvent(tx, {
      orgId,
      entityType: ref.entityType,
      entityId: ref.entityId,
      eventType: IN_KIND_NOTE_CLEARED,
      ...actor,
      payload: { qbNote: posting.qbNote, reason: why, answeredEntries: strayEntriesOf(posting.qbNote).map(answeredEntryRef) },
    });
  });
}

/** Refuses (400) an account of a type the line can't book to: Fixed Asset for donated equipment, else an expense type. */
async function refuseWrongType(orgId: string, source: InKindSource, id: number, lineId: number, quickBooksAccountId: string): Promise<void> {
  const capital = (await getInKindCapital().assetLineIds(orgId, { giftSource: source, giftId: id })).includes(lineId);
  const allowed = capital ? LINE_ACCOUNT_TYPES.donatedCapital : LINE_ACCOUNT_TYPES.donatedGoods;
  const refusal = accountTypeRefusal(await getQuickBooksAccounts()(), quickBooksAccountId, allowed, capital ? "Donated equipment" : "A donated item");
  if (refusal) throw new ServiceError(400, refusal);
}

/** Finance names a held line's account; finance's next "book it" uses it over every rule. */
async function setLineAccount(orgId: string, source: InKindSource, id: number, lineId: number, quickBooksAccountId: string, actor: Actor): Promise<void> {
  const ref = await giftRef(orgId, source, id);
  await refuseWrongType(orgId, source, id, lineId, quickBooksAccountId);
  await db.$transaction(async (tx) => {
    const posting = await lockPosting(tx, orgId, source, id);
    if (!posting || !IN_KIND_HELD_STATES.includes(posting.matchState)) throw new ServiceError(409, "Only a gift the QuickBooks drain handed to finance can have a line's account set");
    const where = { id: lineId, donationId: id };
    const line = source === "receipt"
      ? await tx.inKindDonationLine.findFirst({ where, select: { quickBooksAccountId: true } })
      : await tx.manualInKindDonationLine.findFirst({ where, select: { quickBooksAccountId: true } });
    if (!line) throw new ServiceError(404, "This gift has no such line");
    const data = { quickBooksAccountId };
    if (source === "receipt") await tx.inKindDonationLine.updateMany({ where, data });
    else await tx.manualInKindDonationLine.updateMany({ where, data });
    await recordEvent(tx, {
      orgId,
      entityType: ref.entityType,
      entityId: ref.entityId,
      eventType: "IN_KIND_LINE_ACCOUNT_SET",
      ...actor,
      payload: { lineId, from: line.quickBooksAccountId, to: quickBooksAccountId },
    });
  });
}

/** Book, skip, match, clear the note of, or set a line's account on one gift, then reply with its queue row. */
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
    case "clear":
      await clearNote(orgId, source, id, input.reason, actor);
      break;
    case "set-account":
      await setLineAccount(orgId, source, id, input.lineId, input.quickBooksAccountId, actor);
      break;
  }
  return inKindAcceptService.queueItem(orgId, actor.actorUserId, source, id);
}
