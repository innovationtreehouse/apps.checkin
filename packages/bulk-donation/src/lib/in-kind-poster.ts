// The in-kind drain (docs/rules/revenue.md, Donations): each accepted gift books as one QuickBooks JournalEntry,
// unless finance already booked it by hand as a Deposit into and a Purchase out of the in-kind
// clearing account, which the drain matches instead. Claim, call, settle, as the other lanes.
import { kindOf, type FailureKind } from "@checkin/component-kit";
import { dollarsToCents } from "@checkin/money";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_POST_ATTEMPTS,
  MAX_SAME_CODE_REFUSALS,
  STALE_CLAIM_MS,
  SWEEP_DAYS,
  appKeyOf,
  findOrCreateInKindJournal,
  liveRoleAccountIds,
  qbGate,
  qbKey,
  readCloseDate,
  runDrain,
  shiftDate,
  type BooksMapRole,
  type CloseRead,
  type FindOrCreateResult,
  type InKindJournalLine,
  type QboAccount,
  type QboDeposit,
  type QboJournalEntry,
  type QboPurchase,
  type QuickBooksClient,
} from "@checkin/quickbooks";
import { db, isUniqueConstraintError, type DbOrTx } from "../db";
import { getInKindAccounts, getInKindCapital, getInKindQbPosting } from "../runtime";
import type { InKindQbPosting, InKindStopKind } from "../contract";
import { recordEvent } from "../repositories/audit";
import { readDonationSettings, type DonationSettings } from "../services/settingsService";
import type { AuditContext } from "../workflows/disbursement.actor";
import { inKindReadiness, type GiftToBook, type ReadinessContext } from "../services/inKindAcceptService";
import { checkInKindQbDrift, type InKindDriftCounts } from "./in-kind-drift";
import { QB_MATCH_STATE } from "./qb-match";
import { lineAccounts } from "./in-kind-accounts";

/** Every books-map role the lane needs before it runs; clearing is only for matching finance's hand bookings. Each line's debit account comes from its part. */
export const IN_KIND_ROLES = ["INKIND_INCOME", "INKIND_CLEARING"] as const satisfies readonly BooksMapRole[];
/** The accounts other lanes match and book through; the clearing account may be none of them. */
const LANE_ACCOUNT_ROLES: readonly BooksMapRole[] = ["SHOPIFY_BANK", "BENEVITY_BANK", "EXPENSE_PAYMENT"];
const KEY_LANE = "in-kind";
const SYSTEM = { actorUserId: null, actorUsername: "system:qb-drain", correlationId: null };

type Accounts = Partial<Record<BooksMapRole, string>>;

/** Fails closed: every in-kind role set, and the clearing account no other lane's account in the books map. */
export function inKindAccountsReady(accounts: Accounts): boolean {
  const clearing = accounts.INKIND_CLEARING;
  return IN_KIND_ROLES.every((r) => !!accounts[r]) && LANE_ACCOUNT_ROLES.every((r) => accounts[r] !== clearing);
}

export function inKindKey(orgId: string, source: string, giftId: number): string {
  return qbKey(KEY_LANE, `${orgId}:${source}:${giftId}`);
}

export async function inKindPostingOnAt(orgId: string): Promise<Date | null> {
  return (await db.donationOrgSettings.findUnique({ where: { orgId } }))?.inKindQbPostingOnAt ?? null;
}

/** Switches the lane on: the stamp is written only while unset, so it never moves. */
async function switchInKindPostingOn(orgId: string, now: Date): Promise<Date> {
  await db.donationOrgSettings.createMany({ data: [{ orgId }], skipDuplicates: true });
  const { count } = await db.donationOrgSettings.updateMany({ where: { orgId, inKindQbPostingOnAt: null }, data: { inKindQbPostingOnAt: now } });
  if (count > 0) {
    await recordEvent(db, { orgId, entityType: "donation_org_settings", entityId: orgId, eventType: "IN_KIND_QB_SWITCHED_ON", ...SYSTEM, payload: { at: now.toISOString() } });
  }
  const at = await inKindPostingOnAt(orgId);
  if (!at) throw new Error("the in-kind posting stamp did not save");
  return at;
}

const windowOf = (date: string, days: number) => ({ from: shiftDate(date, -days), to: shiftDate(date, days) });

/** One QuickBooks entry a settle claims for the gift. */
export interface Entry {
  side: "journal" | "revenue" | "expense";
  entity: "JournalEntry" | "Deposit" | "Purchase";
  id: string;
  /** The entry's date as booked, the baseline the drift check compares. */
  txnDate: string;
}

/** What a post settles to. */
export interface Settlement {
  state: string;
  note: string | null;
  entries: Entry[];
  booked?: { totalCents: number; txnDate: string };
  /** This post's own call created the entry; a key match or lookup settles CREATED without it. */
  createdNow?: boolean;
  /** The post failed at MAX_POST_ATTEMPTS, so the gift went to finance. */
  exhausted?: boolean;
  /** The kind of the QuickBooks or app failure behind this settlement, saved on the posting. */
  failure?: FailureKind;
  /** QuickBooks' fault codes on a refused create. */
  codes?: readonly string[];
  /** Held for finance without calling QuickBooks, so it says nothing about whether QuickBooks is up. */
  noCall?: boolean;
}

/** Everything one run reads once. */
export interface Run {
  orgId: string;
  /** Finance's "book it": the gift may be created before switch-on, and from any state finance resolves. */
  book: boolean;
  client: QuickBooksClient;
  accounts: Accounts;
  classes: ReadonlyMap<number, string>;
  close: CloseRead;
  /** Null only for finance's "book it" before the lane is switched on. */
  onAt: Date | null;
  /** Who the settle is audited as: the drain, or the finance holder who asked to book. */
  actor: AuditContext;
  ctx: ReadinessContext;
  /** Every gift still to book, so a hand booking two gifts could own goes to finance. */
  open: GiftToBook[];
  settings: DonationSettings;
  /** QuickBooks' chart of accounts, read at most once per run. */
  qbAccounts: () => Promise<QboAccount[]>;
  /** QuickBooks answered an earlier gift this run, so a system failure now is about the gift. */
  qbAnswered?: boolean;
}

/** The run's one read of QuickBooks' chart of accounts, on first use. */
export function chartOfAccounts(client: QuickBooksClient): () => Promise<QboAccount[]> {
  let read: Promise<QboAccount[]> | undefined;
  return () => (read ??= client.accounts());
}

/**
 * `failed` is a system or bug failure, which counts toward the stop; `connection` ends the run;
 * `settings` waits outside the stop count; `held` went to finance without a QuickBooks call.
 */
export type InKindPostOutcome = "posted" | "matched" | "unbooked" | "needs_finance" | "held" | "exhausted" | "failed" | "connection" | "settings" | "waiting";

/** The states the drain posts again on its own: a failed post, and a gift whose lines now may have their accounts. */
const POSTABLE: readonly string[] = [QB_MATCH_STATE.POST_FAILED, QB_MATCH_STATE.NEEDS_ACCOUNT];
/** The states finance resolves: book it, skip it, or match it by id. */
export const IN_KIND_HELD_STATES: readonly string[] = [QB_MATCH_STATE.UNBOOKED, QB_MATCH_STATE.NEEDS_FINANCE, QB_MATCH_STATE.NEEDS_ACCOUNT, QB_MATCH_STATE.POST_FAILED];

export async function lockPosting(tx: DbOrTx, orgId: string, source: string, giftId: number) {
  await tx.$queryRaw`SELECT id FROM in_kind_postings WHERE org_id = ${orgId} AND source = ${source} AND gift_id = ${giftId} FOR UPDATE`;
  return tx.inKindPosting.findUnique({ where: { orgId_source_giftId: { orgId, source, giftId } } });
}

/**
 * Locks the gift, checks it still waits on nothing but booking, and claims it. The first create
 * attempt is stamped only when the gate lets this post create. Returns the gift with the attempt
 * stamp as it stood before this claim, or why there is nothing to post.
 */
async function claim(run: Run, source: GiftToBook["source"], id: number, now: Date) {
  return db.$transaction(async (tx) => {
    const gift = await inKindReadiness.lockReadyGift(tx, run.orgId, source, id, run.ctx);
    if (!gift || !gift.txnDate) return "not_ready" as const;
    const posting = await lockPosting(tx, run.orgId, source, id);
    const stale = posting?.matchState === QB_MATCH_STATE.POSTING && (posting.claimedAt?.getTime() ?? 0) < now.getTime() - STALE_CLAIM_MS;
    const postable = run.book ? IN_KIND_HELD_STATES : POSTABLE;
    if (posting && !postable.includes(posting.matchState) && !stale) return "busy" as const;
    const gate = qbGate(gift.txnDate, run.close, run.onAt, gift.createdAt, run.book);
    const attempt = gate.mayCreate && gift.txnDate > gate.closedThrough ? now : null;
    const data = { matchState: QB_MATCH_STATE.POSTING, claimedAt: now, qbCreateAttemptedAt: posting?.qbCreateAttemptedAt ?? attempt };
    await tx.inKindPosting.upsert({ where: { orgId_source_giftId: { orgId: run.orgId, source, giftId: id } }, create: { orgId: run.orgId, source, giftId: id, ...data }, update: data });
    return { gift, txnDate: gift.txnDate, gate, attemptedBefore: posting?.qbCreateAttemptedAt ?? null };
  });
}

/** Entries other gifts already hold, per entity. */
async function heldIds(orgId: string, entity: Entry["entity"]): Promise<Set<string>> {
  const rows = await db.inKindBooking.findMany({ where: { orgId, qbEntity: entity, qbTxnId: { not: null } }, select: { qbTxnId: true } });
  return new Set(rows.flatMap((r) => (r.qbTxnId ? [r.qbTxnId] : [])));
}

/**
 * The app's own JournalEntry for an attempted gift, found by key among those created since the
 * attempt. A voided entry keeps its memo at a zero total, and a gift with no value is never
 * booked, so a $0 entry is never a gift's own.
 */
export async function lookupOwnJournal(run: Pick<Run, "orgId" | "client">, gift: Pick<GiftToBook, "source" | "id">, since: Date): Promise<Settlement | null> {
  let read: { entries: QboJournalEntry[]; full: boolean };
  try {
    read = await run.client.createdSince("JournalEntry", since);
  } catch (err) {
    const failure = readKind(kindOf(err));
    // Nothing is created while the read fails, so an outage or a lost connection can wait for the next run's read.
    if (failure === "system" || failure === "connection") {
      return { state: QB_MATCH_STATE.POST_FAILED, note: `The QuickBooks read for this gift's earlier entry failed; the next run reads again (${message(err).slice(0, 200)})`, entries: [], failure };
    }
    return { ...needsFinance(`The app may already have booked this gift: the QuickBooks read failed (${message(err).slice(0, 200)})`), failure };
  }
  if (read.full) return needsFinance("The app may already have booked this gift: the read of JournalEntries created since its first attempt filled a page");
  const key = inKindKey(run.orgId, gift.source, gift.id);
  const keyed = read.entries.filter((j) => j.TotalAmt !== 0 && appKeyOf(j)?.split(" ").includes(key));
  if (keyed.length === 0) return null;
  if (keyed.length > 1 || appKeyOf(keyed[0]) !== key) return needsFinance(`The app may already have booked this gift: JournalEntries ${keyed.map((j) => j.Id).join(", ")} carry its key`);
  const own = keyed[0];
  if ((await heldIds(run.orgId, "JournalEntry")).has(own.Id)) return needsFinance(`The app's QuickBooks JournalEntry ${own.Id} is held by another gift`);
  return { state: QB_MATCH_STATE.CREATED, note: null, entries: [{ side: "journal", entity: "JournalEntry", id: own.Id, txnDate: own.TxnDate }], booked: { totalCents: dollarsToCents(own.TotalAmt), txnDate: own.TxnDate } };
}

const needsFinance = (note: string): Settlement => ({ state: QB_MATCH_STATE.NEEDS_FINANCE, note, entries: [] });
const heldNoCall = (note: string): Settlement => ({ ...needsFinance(note), noCall: true });
/** Only a refused create is about the gift; a read every gift shares, refused, is the app's fault. */
const readKind = (failure: FailureKind): FailureKind => (failure === "data" ? "bug" : failure);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Deposits held by another gift. No other lane can hold one in the clearing account: income
 * holds only deposits in its bank roles, which inKindAccountsReady keeps apart from clearing.
 */
export function claimedDepositIds(orgId: string): Promise<Set<string>> {
  return heldIds(orgId, "Deposit");
}

/**
 * Finance's hand booking: a Deposit into the clearing account and a Purchase out of it, each for
 * the gift's total, inside its window, held by no other gift or lane and carrying no app key. Both
 * found once, and no other open gift could own them, is a match; anything else is finance's to decide.
 */
async function matchClearingPair(run: Run, gift: GiftToBook, txnDate: string): Promise<Settlement | null> {
  const clearing = run.accounts.INKIND_CLEARING;
  const w = windowOf(txnDate, run.settings.qbMatchWindowDays);
  const [deposits, purchases, heldDeposits, heldPurchases] = await Promise.all([
    run.client.depositsBetween(w.from, w.to),
    run.client.purchasesBetween(w.from, w.to),
    claimedDepositIds(run.orgId),
    heldIds(run.orgId, "Purchase"),
  ]);
  const fits = (e: QboDeposit | QboPurchase, account: string | undefined, held: Set<string>) =>
    account === clearing && dollarsToCents(e.TotalAmt) === gift.totalCents && appKeyOf(e) === undefined && !held.has(e.Id);
  const d = deposits.filter((e) => fits(e, e.DepositToAccountRef?.value, heldDeposits));
  const p = purchases.filter((e) => fits(e, e.AccountRef?.value, heldPurchases));
  if (d.length === 0 && p.length === 0) return null;
  const ids = [...d.map((e) => `Deposit ${e.Id}`), ...p.map((e) => `Purchase ${e.Id}`)].join(", ");
  if (d.length !== 1 || p.length !== 1) return needsFinance(`Finance's clearing-account bookings ${ids} may be this gift's; match them or skip`);
  const rivals = run.open.filter((o) => (o.source !== gift.source || o.id !== gift.id) && o.totalCents === gift.totalCents && o.txnDate && [d[0].TxnDate, p[0].TxnDate].every((t) => inWindow(t, o.txnDate as string, run.settings.qbMatchWindowDays)));
  if (rivals.length > 0) return needsFinance(`Finance's clearing-account bookings ${ids} could belong to this gift or another of the same value; match them to one`);
  return {
    state: QB_MATCH_STATE.MATCHED,
    note: null,
    entries: [
      { side: "revenue", entity: "Deposit", id: d[0].Id, txnDate: d[0].TxnDate },
      { side: "expense", entity: "Purchase", id: p[0].Id, txnDate: p[0].TxnDate },
    ],
    booked: { totalCents: gift.totalCents, txnDate: d[0].TxnDate },
  };
}

function inWindow(date: string, around: string, days: number): boolean {
  const w = windowOf(around, days);
  return date >= w.from && date <= w.to;
}

/**
 * The gift's one journal entry: its total credited to in-kind income, each line debited to finance's
 * hand-set account or its part's expense account rule, an asset line through a rule marked capital.
 * Any line without a usable account holds the gift as NEEDS_ACCOUNT, which each run tries again.
 */
async function journalLines(run: Run, gift: GiftToBook): Promise<InKindJournalLine[] | Settlement> {
  const classId = run.classes.get(gift.budgetOwnerId);
  if (!classId) return heldNoCall("The gift's bucket has no QuickBooks Class in the books map");
  const income = run.accounts.INKIND_INCOME;
  if (!income) return heldNoCall("The books map has no in-kind income account");
  const lines = gift.lines.filter((l) => l.valueCents > 0);
  const assets = new Set(await getInKindCapital().assetLineIds(run.orgId, { giftSource: gift.source, giftId: gift.id }));
  const parts = lines.flatMap((l) => (l.quickBooksAccountId || !l.gtin13 ? [] : [{ lineId: l.id, gtin13: l.gtin13, isCapital: assets.has(l.id) }]));
  const [ruled, qb] = await Promise.all([getInKindAccounts().resolve(run.orgId, parts), run.qbAccounts()]);
  const accounts = lineAccounts(lines, assets, new Map(ruled.map(({ lineId, ...r }) => [lineId, r])), qb, liveRoleAccountIds(run.accounts));
  if (typeof accounts === "string") return { state: QB_MATCH_STATE.NEEDS_ACCOUNT, note: accounts, entries: [] };
  const debits = lines.flatMap((l): InKindJournalLine[] => {
    const accountId = accounts.get(l.id);
    return accountId ? [{ postingType: "Debit", accountId, amountCents: l.valueCents, classId, description: l.description.slice(0, 4000) }] : [];
  });
  return [{ postingType: "Credit", accountId: income, amountCents: gift.totalCents, classId, description: "In-kind contribution" }, ...debits];
}

/** A failed post by its kind: QuickBooks refusing the gift holds it for finance at once; any other kind is tried again. */
function failedPost(failure: FailureKind, error: string, codes?: readonly string[]): Settlement {
  if (failure === "data") return { ...needsFinance(`QuickBooks refused this gift: ${error}`.slice(0, 500)), failure, codes };
  return { state: QB_MATCH_STATE.POST_FAILED, note: error.slice(0, 500), entries: [], failure };
}

function fromJournal(r: FindOrCreateResult, gift: GiftToBook, txnDate: string): Settlement {
  switch (r.kind) {
    case "found":
    case "created": {
      const booked = r.kind === "found" ? r.txnDate : txnDate;
      return { state: QB_MATCH_STATE.CREATED, note: null, entries: [{ side: "journal", entity: "JournalEntry", id: r.id, txnDate: booked }], booked: { totalCents: gift.totalCents, txnDate: booked }, createdNow: r.kind === "created" };
    }
    case "ambiguous":
      return needsFinance(`The app may already have booked this gift: JournalEntries ${r.ids.join(", ")} carry its key`);
    case "closed":
      return { state: QB_MATCH_STATE.UNBOOKED, note: "Dated in closed books: the app will not book it; finance skips it", entries: [] };
    case "needs-finance":
      return { state: QB_MATCH_STATE.UNBOOKED, note: null, entries: [] };
    case "failed":
      return failedPost(r.onCreate ? r.failure : readKind(r.failure), r.error, r.codes);
  }
}

/** The QuickBooks half of a post, outside any transaction: look first by key, then finance's hand booking, then the gate. */
async function call(run: Run, gift: GiftToBook, txnDate: string, gate: { closedThrough: string; mayCreate: boolean }, attemptedBefore: Date | null): Promise<Settlement> {
  try {
    if (gift.totalCents <= 0) return heldNoCall("This gift has no value to book; skip it");
    // A receipt's free line is real; a gift without one was valued line by line by finance.
    if (gift.source === "manual" && gift.lines.some((l) => l.valueCents <= 0)) {
      return heldNoCall("A line of this gift has no value; the app will not book it, so finance books it by hand or skips it");
    }
    if (attemptedBefore) {
      const own = await lookupOwnJournal(run, gift, attemptedBefore);
      if (own) return own;
    }
    const pair = await matchClearingPair(run, gift, txnDate);
    if (pair) return pair;
    const lines = await journalLines(run, gift);
    if (!Array.isArray(lines)) return lines;
    const result = await findOrCreateInKindJournal(run.client, {
      txnDate,
      lines,
      memo: `In-kind gift ${gift.source} ${gift.id}`,
      key: inKindKey(run.orgId, gift.source, gift.id),
      window: windowOf(txnDate, run.settings.qbMatchWindowDays),
      claimedIds: await heldIds(run.orgId, "JournalEntry"),
      closedThrough: gate.closedThrough,
      mayCreate: gate.mayCreate,
      accounts: run.accounts,
    });
    if (result.kind === "needs-finance" && !run.close.ok) {
      return { state: QB_MATCH_STATE.POST_FAILED, note: "The books closing date could not be read; the next run tries again", entries: [], failure: "system" };
    }
    const s = fromJournal(result, gift, txnDate);
    // QuickBooks answered this post's reads, so a system failure on the create is about the gift.
    return s.failure === "system" ? { ...s, failure: "bug" } : s;
  } catch (err) {
    return failedPost(readKind(kindOf(err)), message(err));
  }
}

/**
 * Counts a failed post on the gift, and hands the gift to finance at the limit. Only a bug is the
 * gift's own, or a system failure once QuickBooks answered an earlier gift this run or an earlier
 * read in this post, which is then charged as a bug; QuickBooks refusing the gift holds it after this one try. A run that could not
 * read the closing date creates nothing, so its failures do not count. Nor does finance's "book it":
 * the limit stops the drain retrying alone, and finance may always ask again.
 */
async function countFailure(tx: DbOrTx, run: Run, postingId: number, attemptsBefore: number, s: Settlement): Promise<Settlement> {
  if (!run.close.ok || run.book) return s;
  if (s.failure === "data") {
    await tx.inKindPosting.update({ where: { id: postingId }, data: { qbPostAttempts: attemptsBefore + 1 } });
    return s;
  }
  if (s.state !== QB_MATCH_STATE.POST_FAILED) return s;
  const failure = s.failure ?? "bug";
  if (failure === "system" && run.qbAnswered) s = { ...s, failure: "bug" };
  else if (failure !== "bug") return s;
  const attempts = attemptsBefore + 1;
  await tx.inKindPosting.update({ where: { id: postingId }, data: { qbPostAttempts: attempts } });
  if (attempts < MAX_POST_ATTEMPTS) return s;
  return { ...s, state: QB_MATCH_STATE.NEEDS_FINANCE, exhausted: true, note: `The app stopped trying after ${attempts} failed attempts: ${s.note}` };
}

/** Saves the outcome only while the claim is still this post's, and returns what it saved; a lost claim after a create the gift does not hold leaves finance a note. */
async function settle(run: Run, gift: GiftToBook, claimedAt: Date, s: Settlement): Promise<Settlement | null> {
  return db.$transaction(async (tx) => {
    const posting = await lockPosting(tx, run.orgId, gift.source, gift.id);
    if (posting?.matchState !== QB_MATCH_STATE.POSTING || posting.claimedAt?.getTime() !== claimedAt.getTime()) {
      const created = s.createdNow ? s.entries.find((e) => e.entity === "JournalEntry") : undefined;
      if (created && posting) {
        const held = await tx.inKindBooking.findFirst({ where: { orgId: run.orgId, source: gift.source, giftId: gift.id, qbEntity: created.entity, qbTxnId: created.id } });
        if (!held) await tx.inKindPosting.update({ where: { id: posting.id }, data: { qbNote: `QuickBooks JournalEntry ${created.id} was created by a post that lost its claim; void it or link it` } });
      }
      return null;
    }
    const counted = await countFailure(tx, run, posting.id, posting.qbPostAttempts, s);
    await writeSettlement(tx, run.orgId, gift, posting.id, counted, run.actor, { from: QB_MATCH_STATE.POSTING });
    return counted;
  });
}

/** Claims the settlement's entries for the gift (the unique index refuses one another gift holds), saves its state and audits it. */
export async function writeSettlement(
  tx: DbOrTx,
  orgId: string,
  gift: Pick<GiftToBook, "source" | "id" | "entityType" | "entityId">,
  postingId: number,
  s: Settlement,
  actor: AuditContext,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const e of s.entries) {
    await tx.inKindBooking.create({ data: { orgId, source: gift.source, giftId: gift.id, side: e.side, matchState: s.state, qbEntity: e.entity, qbTxnId: e.id, bookedTxnDate: e.txnDate } });
  }
  await tx.inKindPosting.update({
    where: { id: postingId },
    data: { matchState: s.state, claimedAt: null, qbNote: s.note, qbFailureKind: s.failure ?? null, bookedTotalCents: s.booked?.totalCents ?? null, bookedTxnDate: s.booked?.txnDate ?? null },
  });
  await recordEvent(tx, {
    orgId,
    entityType: gift.entityType,
    entityId: gift.entityId,
    eventType: "IN_KIND_QB_SETTLED",
    ...actor,
    payload: { ...payload, to: s.state, entries: s.entries, note: s.note, ...(s.failure ? { failure: s.failure } : {}) },
  });
}

/**
 * One gift: claim, call, settle. Another gift holding an entry this post found sends it to finance,
 * never to a second claim. `not_ready` and `busy` (another post holds it) are the drain's "waiting".
 */
export async function postGift(run: Run, source: GiftToBook["source"], id: number, now = new Date()): Promise<InKindPostOutcome | "not_ready" | "busy"> {
  const posted = await postGiftSettled(run, source, id, now);
  return typeof posted === "string" ? posted : posted.outcome;
}

/** postGift, with the kind of the failure it saved, if any, and the fault codes of a refused create. */
async function postGiftSettled(run: Run, source: GiftToBook["source"], id: number, now: Date): Promise<{ outcome: InKindPostOutcome; failure?: FailureKind; codes?: readonly string[] } | "not_ready" | "busy"> {
  const claimed = await claim(run, source, id, now);
  if (typeof claimed === "string") return claimed;
  const s = await call(run, claimed.gift, claimed.txnDate, claimed.gate, claimed.attemptedBefore);
  let saved: Settlement | null;
  try {
    saved = await settle(run, claimed.gift, now, s);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const ids = s.entries.map((e) => `${e.entity} ${e.id}`).join(", ");
    const voidIt = s.state === QB_MATCH_STATE.CREATED ? "; the app's entry needs voiding" : "";
    saved = await settle(run, claimed.gift, now, needsFinance(`QuickBooks ${ids} is already held by another gift${voidIt}`));
  }
  if (!saved) return { outcome: "waiting" };
  const outcome = outcomeOf(saved);
  if (ANSWERED.includes(outcome) && (saved.failure === undefined || saved.failure === "data")) run.qbAnswered = true;
  return { outcome, failure: saved.failure, codes: saved.failure === "data" ? saved.codes : undefined };
}

/** Outcomes reached only after QuickBooks answered, unless a failure says otherwise. */
const ANSWERED: readonly InKindPostOutcome[] = ["posted", "matched", "unbooked", "needs_finance"];

function outcomeOf(saved: Settlement): InKindPostOutcome {
  if (saved.exhausted) return "exhausted";
  if (saved.noCall) return "held";
  // A bug sent to finance, such as a broken read for the gift's own entry, still counts toward the stop.
  if (saved.failure === "bug") return "failed";
  switch (saved.state) {
    case QB_MATCH_STATE.CREATED:
      return "posted";
    case QB_MATCH_STATE.MATCHED:
      return "matched";
    case QB_MATCH_STATE.UNBOOKED:
      return "unbooked";
    case QB_MATCH_STATE.POST_FAILED:
      return saved.failure === "connection" || saved.failure === "settings" ? saved.failure : "failed";
    default:
      return "needs_finance";
  }
}

/** The audit event of finance clearing a gift's note; its `answeredEntries` name the stray entries it answered. */
export const IN_KIND_NOTE_CLEARED = "IN_KIND_QB_NOTE_CLEARED";
/** How a cleared note's audit names a stray app entry it answered. */
export const answeredEntryRef = (entryId: string) => `JournalEntry:${entryId}`;

/** Every stray app JournalEntry a note names: one the sweep found unlinked, or one a post created after losing its claim. */
export function strayEntriesOf(note: string | null): string[] {
  return [...(note ?? "").matchAll(/QuickBooks JournalEntry (\S+) (?:carries this gift's key|was created by a post that lost its claim)/g)].map((m) => m[1]);
}

/** Whether finance already answered this stray entry by clearing a note that named it. */
async function answeredStray(orgId: string, entryId: string): Promise<boolean> {
  const answer = await db.workflowEvent.findFirst({
    where: { orgId, eventType: IN_KIND_NOTE_CLEARED, actorUserId: { not: null }, payload: { contains: JSON.stringify(answeredEntryRef(entryId)) } },
    select: { id: true },
  });
  return answer !== null;
}

export type InKindSweepCounts = { entries: number; flagged: number; full: boolean } | { failed: true };

/**
 * The daily orphan sweep: every JournalEntry created since the oldest attempt in the last
 * SWEEP_DAYS days. An entry carrying a gift's key that the gift does not hold gets a
 * note for finance to void or link it, unless finance already answered it; a capped read alerts
 * finance. QuickBooks is only read.
 */
export async function sweepInKindQbStrays(
  orgId: string,
  client: QuickBooksClient,
  sweepIncomplete: InKindQbPosting["sweepIncomplete"],
  now = new Date(),
): Promise<InKindSweepCounts> {
  const oldest = await db.inKindPosting.findFirst({
    where: { orgId, qbCreateAttemptedAt: { gte: new Date(now.getTime() - SWEEP_DAYS * 86_400_000) } },
    orderBy: { qbCreateAttemptedAt: "asc" },
    select: { qbCreateAttemptedAt: true },
  });
  if (!oldest?.qbCreateAttemptedAt) return { entries: 0, flagged: 0, full: false };
  let read: { entries: QboJournalEntry[]; full: boolean };
  try {
    read = await client.createdSince("JournalEntry", oldest.qbCreateAttemptedAt);
  } catch (err) {
    console.warn("[bulk-donation] in-kind orphan sweep read failed", err);
    return { failed: true };
  }
  if (read.full) {
    try {
      await sweepIncomplete({ orgId, since: oldest.qbCreateAttemptedAt });
    } catch (err) {
      console.warn("[bulk-donation] in-kind orphan sweep read a full page, and the finance alert failed", err);
    }
  }
  const attempted = await db.inKindPosting.findMany({ where: { orgId, qbCreateAttemptedAt: { not: null } }, select: { source: true, giftId: true } });
  const byKey = new Map(attempted.map((p) => [inKindKey(orgId, p.source, p.giftId), p]));
  let flagged = 0;
  for (const entry of read.entries) {
    // A voided entry keeps its memo at a zero total.
    if (entry.TotalAmt === 0) continue;
    for (const key of appKeyOf(entry)?.split(" ") ?? []) {
      if (!key.startsWith(`${KEY_LANE}:`)) continue;
      const gift = byKey.get(key);
      if (!gift) {
        console.warn(`[bulk-donation] QuickBooks JournalEntry ${entry.Id} carries an in-kind key no attempted gift has`);
        continue;
      }
      if (await answeredStray(orgId, entry.Id)) continue;
      const noted = await db.$transaction(async (tx) => {
        const posting = await lockPosting(tx, orgId, gift.source, gift.giftId);
        if (!posting || posting.matchState === QB_MATCH_STATE.POSTING) return false;
        const held = await tx.inKindBooking.findFirst({ where: { orgId, source: gift.source, giftId: gift.giftId, qbEntity: "JournalEntry", qbTxnId: entry.Id } });
        if (held) return false;
        const qbNote = `QuickBooks JournalEntry ${entry.Id} carries this gift's key but is not linked to it; void it or link it`;
        if (posting.qbNote === qbNote) return false;
        await tx.inKindPosting.update({ where: { id: posting.id }, data: { qbNote } });
        return true;
      });
      if (noted) flagged++;
    }
  }
  return { entries: read.entries.length, flagged, full: read.full };
}

/**
 * One fault code refused MAX_SAME_CODE_REFUSALS creates in a run, so it reads as a QuickBooks
 * setting rather than these gifts' data: each one QuickBooks refused goes back to POST_FAILED,
 * keeping the try its refusal charged, and the next run tries it again. One at MAX_POST_ATTEMPTS
 * stays with finance. Answers how many went back.
 */
async function unrefuseGifts(orgId: string, gifts: readonly GiftToBook[], code: string): Promise<number> {
  let returned = 0;
  for (const gift of gifts) {
    await db.$transaction(async (tx) => {
      const posting = await lockPosting(tx, orgId, gift.source, gift.id);
      if (posting?.matchState !== QB_MATCH_STATE.NEEDS_FINANCE || posting.qbFailureKind !== "data" || posting.qbPostAttempts >= MAX_POST_ATTEMPTS) return;
      const note = `QuickBooks refused ${MAX_SAME_CODE_REFUSALS} gifts with code ${code} in one run; likely a books-map setting. Attempt ${posting.qbPostAttempts} of ${MAX_POST_ATTEMPTS}; the next run tries again`;
      await writeSettlement(tx, orgId, gift, posting.id, { state: QB_MATCH_STATE.POST_FAILED, note, entries: [], failure: "settings" }, SYSTEM, { from: QB_MATCH_STATE.NEEDS_FINANCE, code });
      returned++;
    });
  }
  return returned;
}

export interface InKindDrainCounts {
  posted: number;
  matched: number;
  unbooked: number;
  needs_finance: number;
  held: number;
  exhausted: number;
  failed: number;
  connection: number;
  settings: number;
  waiting: number;
  capped: boolean;
  /** The run stopped on its failure streak, a lost connection or a repeated refusal code; `stopKind` says which. */
  stoppedAfterFailures: boolean;
  stopKind: InKindStopKind | null;
  /** The run stopped when QuickBooks refused MAX_SAME_CODE_REFUSALS gifts with one fault code; `returned` of those gifts wait to try again. */
  refusalStop: { code: string; returned: number } | null;
  closeDateRead: boolean;
  sweep: InKindSweepCounts;
  drift: InKindDriftCounts;
}

/** The books map lacks an in-kind role; `waiting` counts gifts that would otherwise post. */
export interface InKindUnconfigured {
  unconfigured: true;
  waiting: number;
}

/**
 * The in-kind drain, run from the daily cron. It runs only with QuickBooks bound and every in-kind
 * role in the books map, then switches the lane on (once, for good) and reads the books closing
 * date once for the run. Each gift waiting on nothing but booking posts, oldest first, until the
 * per-run create limit, the failure streak or a third refusal with one fault code, either of which
 * alerts finance; the orphan sweep and the drift
 * check run last.
 */
export async function runInKindQbPosting(orgId: string, now = new Date()): Promise<InKindDrainCounts | "unbound" | InKindUnconfigured> {
  const posting = getInKindQbPosting();
  const client = await posting?.client();
  if (!posting || !client) return "unbound";
  const [accounts, classes] = await Promise.all([posting.booksMap.accounts(), posting.booksMap.classes()]);
  if (!inKindAccountsReady(accounts)) {
    const { ready } = await inKindReadiness.giftsToBook(orgId, await inKindReadiness.readReadiness(orgId));
    return { unconfigured: true, waiting: ready.length };
  }
  const onAt = await switchInKindPostingOn(orgId, now);
  const close = await readCloseDate(client);
  if (!close.ok) console.warn(`[bulk-donation] books closing date read failed; this in-kind run creates nothing: ${close.error}`);
  const ctx = await inKindReadiness.readReadiness(orgId);
  const { ready, open } = await inKindReadiness.giftsToBook(orgId, ctx);
  const settings = await readDonationSettings(db, orgId);
  const run: Run = { orgId, book: false, actor: SYSTEM, client, accounts, classes, close, onAt, ctx, open, settings, qbAccounts: chartOfAccounts(client) };

  const counts: InKindDrainCounts = {
    posted: 0, matched: 0, unbooked: 0, needs_finance: 0, held: 0, exhausted: 0, failed: 0, connection: 0, settings: 0, waiting: 0,
    capped: false, stoppedAfterFailures: false, stopKind: null, refusalStop: null, closeDateRead: close.ok, sweep: { entries: 0, flagged: 0, full: false }, drift: { checked: 0, drifted: 0 },
  };
  /** The kinds of the failures in the current streak, so a stop can name its cause. */
  let streak: FailureKind[] = [];
  const stop = await runDrain<GiftToBook, InKindPostOutcome>([...ready].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()), {
    counts,
    maxCreatesPerRun: settings.qbMaxCreatesPerRun,
    // A gift's last failure is still a failure: an outage that exhausts gifts must not clear the streak.
    failures: ["failed", "exhausted"],
    noCall: ["held", "settings"],
    stopNow: ["connection"],
    post: async (gift) => {
      let outcome: InKindPostOutcome;
      let failure: FailureKind | undefined;
      let codes: readonly string[] | undefined;
      try {
        const result = await postGiftSettled(run, gift.source, gift.id, new Date());
        ({ outcome, failure, codes } = typeof result === "string" ? { outcome: "waiting" as const, failure: undefined, codes: undefined } : result);
      } catch (err) {
        // The entry may already be in QuickBooks, so the gift keeps its claim: a post taking over the stale claim looks for the entry by key first.
        console.warn(`[bulk-donation] in-kind post failed for ${gift.source} gift ${gift.id}`, err);
        outcome = "failed";
        failure = kindOf(err);
      }
      if (outcome === "failed" || outcome === "exhausted") streak.push(failure ?? "bug");
      else if (outcome !== "held" && outcome !== "settings") streak = [];
      return codes?.length ? { outcome, refusedCode: codes.join(", ") } : outcome;
    },
    unrefuse: (gifts, code) => unrefuseGifts(orgId, gifts, code),
  });
  counts.capped = stop?.by === "count";
  const stopKind: InKindStopKind | null =
    stop?.by === "stopNow" ? "connection" : stop?.by === "refusals" ? "settings" : stop?.by === "failures" ? (streak.every((k) => k === "system") ? "system" : "bug") : null;
  counts.stoppedAfterFailures = stopKind !== null;
  counts.stopKind = stopKind;
  if (stop?.by === "refusals") counts.refusalStop = { code: stop.code, returned: stop.returned };
  if (stop && stopKind) {
    const failures = stopKind === "connection" ? 1 : stopKind === "settings" ? MAX_SAME_CODE_REFUSALS : MAX_CONSECUTIVE_FAILURES;
    try {
      await posting.drainStopped({ orgId, failures, remaining: stop.remaining, cause: stopKind, ...(stop.by === "refusals" ? { code: stop.code } : {}) });
    } catch (err) {
      console.warn("[bulk-donation] in-kind drain stopped on its failure streak, and the finance alert failed", err);
    }
  }
  // After the posts, so a gift this run linked to its own entry is not reported as a stray.
  counts.sweep = await sweepInKindQbStrays(orgId, client, posting.sweepIncomplete, now);
  counts.drift = await checkInKindQbDrift(orgId, client, now);
  return counts;
}
