// The in-kind drain (design #2182): each accepted gift books as one QuickBooks JournalEntry,
// unless finance already booked it by hand as a Deposit into and a Purchase out of the in-kind
// clearing account, which the drain matches instead. Claim, call, settle, as the other lanes.
import { dollarsToCents } from "@checkin/money";
import {
  appKeyOf,
  findOrCreateInKindJournal,
  qbKey,
  type BooksMapRole,
  type FindOrCreateResult,
  type InKindJournalLine,
  type QboDeposit,
  type QboJournalEntry,
  type QboPurchase,
  type QuickBooksClient,
} from "@checkin/quickbooks";
import { db, isUniqueConstraintError, type DbOrTx } from "../db";
import { getInKindCapital, getInKindQbPosting } from "../runtime";
import type { InKindQbPosting } from "../contract";
import { recordEvent } from "../repositories/audit";
import { inKindReadiness, type GiftToBook, type ReadinessContext } from "../services/inKindAcceptService";
import { QB_MATCH_STATE } from "./qb-match";
import { MAX_CONSECUTIVE_FAILURES, MAX_CREATES_PER_RUN, MATCH_WINDOW_DAYS, STALE_CLAIM_MS, SWEEP_DAYS, qbGate, readCloseDate, type CloseRead } from "./qb-poster";

/** Every books-map role the lane needs before it runs; clearing is only for matching finance's hand bookings. */
export const IN_KIND_ROLES = ["INKIND_INCOME", "INKIND_EXPENSE", "FIXED_ASSETS", "INKIND_CLEARING"] as const satisfies readonly BooksMapRole[];
/** The accounts other lanes match and book through; the clearing account may be none of them. */
const LANE_ACCOUNT_ROLES: readonly BooksMapRole[] = ["SHOPIFY_BANK", "BENEVITY_BANK", "EXPENSE_PAYMENT"];
const KEY_LANE = "in-kind";
const SYSTEM = { actorUserId: null, actorUsername: "system:qb-drain", correlationId: null };

type Accounts = Partial<Record<BooksMapRole, string>>;

/** Fails closed: every in-kind role set, and the clearing account no other lane's account. */
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

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const windowOf = (date: string) => ({ from: shiftDate(date, -MATCH_WINDOW_DAYS), to: shiftDate(date, MATCH_WINDOW_DAYS) });

/** One QuickBooks entry a settle claims for the gift. */
interface Entry {
  side: "journal" | "revenue" | "expense";
  entity: "JournalEntry" | "Deposit" | "Purchase";
  id: string;
}

/** What a post settles to. */
interface Settlement {
  state: string;
  note: string | null;
  entries: Entry[];
  booked?: { totalCents: number; txnDate: string };
}

/** Everything one run reads once. */
interface Run {
  orgId: string;
  client: QuickBooksClient;
  accounts: Accounts;
  classes: ReadonlyMap<number, string>;
  close: CloseRead;
  onAt: Date;
  ctx: ReadinessContext;
  /** Every gift still to book, so a hand booking two gifts could own goes to finance. */
  open: GiftToBook[];
}

export type InKindPostOutcome = "posted" | "matched" | "unbooked" | "needs_finance" | "failed" | "waiting";

const POSTABLE: readonly string[] = [QB_MATCH_STATE.POST_FAILED];

async function lockPosting(tx: DbOrTx, orgId: string, source: string, giftId: number) {
  await tx.$queryRaw`SELECT id FROM in_kind_postings WHERE org_id = ${orgId} AND source = ${source} AND gift_id = ${giftId} FOR UPDATE`;
  return tx.inKindPosting.findUnique({ where: { orgId_source_giftId: { orgId, source, giftId } } });
}

/**
 * Locks the gift, checks it still waits on nothing but booking, and claims it. The first create
 * attempt is stamped only when the gate lets this post create. Returns the gift with the attempt
 * stamp as it stood before this claim, or null when there is nothing to post.
 */
async function claim(run: Run, source: GiftToBook["source"], id: number, now: Date) {
  return db.$transaction(async (tx) => {
    const gift = await inKindReadiness.lockReadyGift(tx, run.orgId, source, id, run.ctx);
    if (!gift || !gift.txnDate) return null;
    const posting = await lockPosting(tx, run.orgId, source, id);
    const stale = posting?.matchState === QB_MATCH_STATE.POSTING && (posting.claimedAt?.getTime() ?? 0) < now.getTime() - STALE_CLAIM_MS;
    if (posting && !POSTABLE.includes(posting.matchState) && !stale) return null;
    const gate = qbGate(gift.txnDate, run.close, run.onAt, gift.createdAt, false);
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

/** The app's own JournalEntry for an attempted gift, found by key among those created since the attempt. */
async function lookupOwnJournal(run: Run, gift: GiftToBook, since: Date): Promise<Settlement | null> {
  let read: { entries: QboJournalEntry[]; full: boolean };
  try {
    read = await run.client.createdSince("JournalEntry", since);
  } catch (err) {
    return needsFinance(`The app may already have booked this gift: the QuickBooks read failed (${message(err).slice(0, 200)})`);
  }
  if (read.full) return needsFinance("The app may already have booked this gift: the read of JournalEntries created since its first attempt filled a page");
  const key = inKindKey(run.orgId, gift.source, gift.id);
  const keyed = read.entries.filter((j) => appKeyOf(j)?.split(" ").includes(key));
  if (keyed.length === 0) return null;
  if (keyed.length > 1 || appKeyOf(keyed[0]) !== key) return needsFinance(`The app may already have booked this gift: JournalEntries ${keyed.map((j) => j.Id).join(", ")} carry its key`);
  const own = keyed[0];
  if ((await heldIds(run.orgId, "JournalEntry")).has(own.Id)) return needsFinance(`The app's QuickBooks JournalEntry ${own.Id} is held by another gift`);
  return { state: QB_MATCH_STATE.CREATED, note: null, entries: [{ side: "journal", entity: "JournalEntry", id: own.Id }], booked: { totalCents: dollarsToCents(own.TotalAmt), txnDate: own.TxnDate } };
}

const needsFinance = (note: string): Settlement => ({ state: QB_MATCH_STATE.NEEDS_FINANCE, note, entries: [] });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Finance's hand booking: a Deposit into the clearing account and a Purchase out of it, each for
 * the gift's total, inside its window, held by no other gift and carrying no app key. Both found
 * once, and no other open gift could own them, is a match; anything else is finance's to decide.
 */
async function matchClearingPair(run: Run, gift: GiftToBook, txnDate: string): Promise<Settlement | null> {
  const clearing = run.accounts.INKIND_CLEARING;
  const w = windowOf(txnDate);
  const [deposits, purchases, heldDeposits, heldPurchases] = await Promise.all([
    run.client.depositsBetween(w.from, w.to),
    run.client.purchasesBetween(w.from, w.to),
    heldIds(run.orgId, "Deposit"),
    heldIds(run.orgId, "Purchase"),
  ]);
  const fits = (e: QboDeposit | QboPurchase, account: string | undefined, held: Set<string>) =>
    account === clearing && dollarsToCents(e.TotalAmt) === gift.totalCents && appKeyOf(e) === undefined && !held.has(e.Id);
  const d = deposits.filter((e) => fits(e, e.DepositToAccountRef?.value, heldDeposits));
  const p = purchases.filter((e) => fits(e, e.AccountRef?.value, heldPurchases));
  if (d.length === 0 && p.length === 0) return null;
  const ids = [...d.map((e) => `Deposit ${e.Id}`), ...p.map((e) => `Purchase ${e.Id}`)].join(", ");
  if (d.length !== 1 || p.length !== 1) return needsFinance(`Finance's clearing-account bookings ${ids} may be this gift's; match them or skip`);
  const rivals = run.open.filter((o) => (o.source !== gift.source || o.id !== gift.id) && o.totalCents === gift.totalCents && o.txnDate && [d[0].TxnDate, p[0].TxnDate].every((t) => inWindow(t, o.txnDate as string)));
  if (rivals.length > 0) return needsFinance(`Finance's clearing-account bookings ${ids} could belong to this gift or another of the same value; match them to one`);
  return {
    state: QB_MATCH_STATE.MATCHED,
    note: null,
    entries: [
      { side: "revenue", entity: "Deposit", id: d[0].Id },
      { side: "expense", entity: "Purchase", id: p[0].Id },
    ],
    booked: { totalCents: gift.totalCents, txnDate: d[0].TxnDate },
  };
}

function inWindow(date: string, around: string): boolean {
  const w = windowOf(around);
  return date >= w.from && date <= w.to;
}

/** The gift's one journal entry: its total credited to in-kind income, each line debited to in-kind expense or, once an asset, fixed assets. */
async function journalLines(run: Run, gift: GiftToBook): Promise<InKindJournalLine[] | string> {
  const classId = run.classes.get(gift.budgetOwnerId);
  if (!classId) return "The gift's bucket has no QuickBooks Class in the books map";
  const assets = new Set(await getInKindCapital().assetLineIds(run.orgId, { giftSource: gift.source, giftId: gift.id }));
  const debits = gift.lines
    .filter((l) => l.valueCents > 0)
    .map((l): InKindJournalLine => ({ postingType: "Debit", role: assets.has(l.id) ? "FIXED_ASSETS" : "INKIND_EXPENSE", amountCents: l.valueCents, classId, description: l.description.slice(0, 4000) }));
  return [{ postingType: "Credit", role: "INKIND_INCOME", amountCents: gift.totalCents, classId, description: "In-kind contribution" }, ...debits];
}

function fromJournal(r: FindOrCreateResult, gift: GiftToBook, txnDate: string): Settlement {
  switch (r.kind) {
    case "found":
    case "created":
      return { state: QB_MATCH_STATE.CREATED, note: null, entries: [{ side: "journal", entity: "JournalEntry", id: r.id }], booked: { totalCents: gift.totalCents, txnDate: r.kind === "found" ? r.txnDate : txnDate } };
    case "ambiguous":
      return needsFinance(`The app may already have booked this gift: JournalEntries ${r.ids.join(", ")} carry its key`);
    case "closed":
      return { state: QB_MATCH_STATE.UNBOOKED, note: "Dated in closed books: the app will not book it; finance skips it", entries: [] };
    case "needs-finance":
      return { state: QB_MATCH_STATE.UNBOOKED, note: null, entries: [] };
    case "failed":
      return { state: QB_MATCH_STATE.POST_FAILED, note: r.error.slice(0, 500), entries: [] };
  }
}

/** The QuickBooks half of a post, outside any transaction: look first by key, then finance's hand booking, then the gate. */
async function call(run: Run, gift: GiftToBook, txnDate: string, gate: { closedThrough: string; mayCreate: boolean }, attemptedBefore: Date | null): Promise<Settlement> {
  try {
    if (gift.totalCents <= 0) return needsFinance("This gift has no value to book; skip it");
    if (attemptedBefore) {
      const own = await lookupOwnJournal(run, gift, attemptedBefore);
      if (own) return own;
    }
    const pair = await matchClearingPair(run, gift, txnDate);
    if (pair) return pair;
    const lines = await journalLines(run, gift);
    if (typeof lines === "string") return needsFinance(lines);
    const result = await findOrCreateInKindJournal(run.client, {
      txnDate,
      lines,
      memo: `In-kind gift ${gift.source} ${gift.id}`,
      key: inKindKey(run.orgId, gift.source, gift.id),
      window: windowOf(txnDate),
      claimedIds: await heldIds(run.orgId, "JournalEntry"),
      closedThrough: gate.closedThrough,
      mayCreate: gate.mayCreate,
      accounts: run.accounts,
    });
    if (result.kind === "needs-finance" && !run.close.ok) {
      return { state: QB_MATCH_STATE.POST_FAILED, note: "The books closing date could not be read; the next run tries again", entries: [] };
    }
    return fromJournal(result, gift, txnDate);
  } catch (err) {
    return { state: QB_MATCH_STATE.POST_FAILED, note: message(err).slice(0, 500), entries: [] };
  }
}

/** Saves the outcome only while the claim is still this post's; a lost claim after a create leaves finance a note. */
async function settle(run: Run, gift: GiftToBook, claimedAt: Date, s: Settlement): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const posting = await lockPosting(tx, run.orgId, gift.source, gift.id);
    const created = s.entries.find((e) => e.entity === "JournalEntry" && s.state === QB_MATCH_STATE.CREATED);
    if (posting?.matchState !== QB_MATCH_STATE.POSTING || posting.claimedAt?.getTime() !== claimedAt.getTime()) {
      if (created && posting) {
        await tx.inKindPosting.update({ where: { id: posting.id }, data: { qbNote: `QuickBooks JournalEntry ${created.id} was created by a post that lost its claim; void it or link it` } });
      }
      return false;
    }
    for (const e of s.entries) {
      await tx.inKindBooking.create({ data: { orgId: run.orgId, source: gift.source, giftId: gift.id, side: e.side, matchState: s.state, qbEntity: e.entity, qbTxnId: e.id } });
    }
    await tx.inKindPosting.update({
      where: { id: posting.id },
      data: { matchState: s.state, claimedAt: null, qbNote: s.note, bookedTotalCents: s.booked?.totalCents ?? null, bookedTxnDate: s.booked?.txnDate ?? null },
    });
    await recordEvent(tx, {
      orgId: run.orgId,
      entityType: gift.entityType,
      entityId: gift.entityId,
      eventType: "IN_KIND_QB_SETTLED",
      ...SYSTEM,
      payload: { to: s.state, entries: s.entries, note: s.note },
    });
    return true;
  });
}

/** One gift: claim, call, settle. Another gift holding an entry this post found sends it to finance, never to a second claim. */
async function postGift(run: Run, source: GiftToBook["source"], id: number, now = new Date()): Promise<InKindPostOutcome> {
  const claimed = await claim(run, source, id, now);
  if (!claimed) return "waiting";
  let s = await call(run, claimed.gift, claimed.txnDate, claimed.gate, claimed.attemptedBefore);
  try {
    if (!(await settle(run, claimed.gift, now, s))) return "waiting";
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const ids = s.entries.map((e) => `${e.entity} ${e.id}`).join(", ");
    const voidIt = s.state === QB_MATCH_STATE.CREATED ? "; the app's entry needs voiding" : "";
    s = needsFinance(`QuickBooks ${ids} is already held by another gift${voidIt}`);
    if (!(await settle(run, claimed.gift, now, s))) return "waiting";
  }
  switch (s.state) {
    case QB_MATCH_STATE.CREATED:
      return "posted";
    case QB_MATCH_STATE.MATCHED:
      return "matched";
    case QB_MATCH_STATE.UNBOOKED:
      return "unbooked";
    case QB_MATCH_STATE.POST_FAILED:
      return "failed";
    default:
      return "needs_finance";
  }
}

export type InKindSweepCounts = { entries: number; flagged: number; full: boolean } | { failed: true };

/**
 * The daily orphan sweep: every JournalEntry created since the oldest attempt in the last
 * SWEEP_DAYS days, one page. An entry carrying a gift's key that the gift does not hold gets a
 * note for finance to void or link it; a full page alerts finance. QuickBooks is only read.
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
    for (const key of appKeyOf(entry)?.split(" ") ?? []) {
      if (!key.startsWith(`${KEY_LANE}:`)) continue;
      const gift = byKey.get(key);
      if (!gift) {
        console.warn(`[bulk-donation] QuickBooks JournalEntry ${entry.Id} carries an in-kind key no attempted gift has`);
        continue;
      }
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

export interface InKindDrainCounts {
  posted: number;
  matched: number;
  unbooked: number;
  needs_finance: number;
  failed: number;
  waiting: number;
  capped: boolean;
  stoppedAfterFailures: boolean;
  closeDateRead: boolean;
  sweep: InKindSweepCounts;
}

/**
 * The in-kind drain, run from the daily cron. It runs only with QuickBooks bound and every in-kind
 * role in the books map, then switches the lane on (once, for good) and reads the books closing
 * date once for the run. Each gift waiting on nothing but booking posts, oldest first, until the
 * per-run create cap or MAX_CONSECUTIVE_FAILURES failures in a row; the orphan sweep runs last.
 */
export async function runInKindQbPosting(orgId: string, now = new Date()): Promise<InKindDrainCounts | "unbound" | "unconfigured"> {
  const posting = getInKindQbPosting();
  const client = await posting?.client();
  if (!posting || !client) return "unbound";
  const [accounts, classes] = await Promise.all([posting.booksMap.accounts(), posting.booksMap.classes()]);
  if (!inKindAccountsReady(accounts)) return "unconfigured";
  const onAt = await switchInKindPostingOn(orgId, now);
  const close = await readCloseDate(client);
  if (!close.ok) console.warn(`[bulk-donation] books closing date read failed; this in-kind run creates nothing: ${close.error}`);
  const ctx = await inKindReadiness.readReadiness(orgId);
  const { ready, open } = await inKindReadiness.giftsToBook(orgId, ctx);
  const run: Run = { orgId, client, accounts, classes, close, onAt, ctx, open };

  const counts: InKindDrainCounts = {
    posted: 0, matched: 0, unbooked: 0, needs_finance: 0, failed: 0, waiting: 0,
    capped: false, stoppedAfterFailures: false, closeDateRead: close.ok, sweep: { entries: 0, flagged: 0, full: false },
  };
  let failuresInARow = 0;
  for (const gift of [...ready].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (counts.posted >= MAX_CREATES_PER_RUN) {
      counts.capped = true;
      break;
    }
    const outcome = await postGift(run, gift.source, gift.id, new Date());
    counts[outcome]++;
    failuresInARow = outcome === "failed" ? failuresInARow + 1 : 0;
    if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      counts.stoppedAfterFailures = true;
      break;
    }
  }
  // After the posts, so a gift this run linked to its own entry is not reported as a stray.
  counts.sweep = await sweepInKindQbStrays(orgId, client, posting.sweepIncomplete, now);
  return counts;
}
