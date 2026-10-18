// The in-kind accept step (design #2182): every gift, with or without a receipt, is accepted,
// refused or returned by a finance holder who is outside the uploader's or recorder's household,
// or by a Board member when every finance holder is conflicted. The screen's warnings never block.
import { z } from "zod";
import { db, type DbOrTx } from "../db";
import { getInKindCapital, getInKindDirectory, getOrgId, getOwnerDirectory } from "../runtime";
import { recordDonorDataReads, recordEvent, type DonorReadContext } from "../repositories/audit";
import { inventorySourceKey } from "../contract";
import type { AuditContext } from "../workflows/disbursement.actor";
import { QB_MATCH_STATE } from "../lib/qb-match";
import { MAX_IN_KIND_LINES, MAX_IN_KIND_LINE_VALUE_CENTS, MAX_IN_KIND_TOTAL_CENTS } from "./manualInKindService";
import type { CapitalReviewLine } from "../contract";
import { ServiceError } from "@checkin/component-kit";

export type InKindSource = "receipt" | "manual";
export type InKindOutcome = "ACCEPTED" | "REFUSED" | "RETURNED";

export const InKindDecisionInputSchema = z.object({
  outcome: z.enum(["accept", "refuse", "return"]),
  bucketId: z.number().int().positive().optional(),
  lineValues: z
    .array(z.object({ lineId: z.number().int().positive(), valueCents: z.number().int().nonnegative().max(MAX_IN_KIND_LINE_VALUE_CENTS) }))
    .max(MAX_IN_KIND_LINES)
    .refine((values) => values.reduce((sum, v) => sum + v.valueCents, 0) <= MAX_IN_KIND_TOTAL_CENTS, { message: "The gift's total is over the limit" })
    .optional(),
  /** The decider's attestation that they are outside the donor's household; the app cannot check it. */
  confirmOutsideDonorHousehold: z.literal(true),
});
export type InKindDecisionInput = z.infer<typeof InKindDecisionInputSchema>;

const OUTCOME: Record<InKindDecisionInput["outcome"], InKindOutcome> = { accept: "ACCEPTED", refuse: "REFUSED", return: "RETURNED" };
const BOOKED_STATES: readonly string[] = [QB_MATCH_STATE.MATCHED, QB_MATCH_STATE.CREATED];

/**
 * What a gift waits on, most urgent first. `withdrawal` and `replay` are anomalies finance
 * settles; `capital` means a line waits on the expense library's capital review; `booking` means
 * ready, waiting on the QuickBooks drain.
 */
export type WaitingOn = "withdrawal" | "replay" | "donor" | "uploader" | "value" | "decision" | "bucket" | "capital" | "booking";

interface GiftLine {
  id: number;
  gtin13: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  suggestedValueCents: number | null;
}

/** Both in-kind tables in one shape. `donorLastName` feeds the warnings and never leaves this file. */
interface Gift {
  source: InKindSource;
  id: number;
  receiptId: string | null;
  receiptTotalCents: number | null;
  receiptDate: string | null;
  donationDate: string | null;
  moneyReceivedAt: Date | null;
  donorRecordedAt: Date | null;
  donorLastName: string | null;
  donorReplacedAt: Date | null;
  withdrawnAfterMoneyAt: Date | null;
  withdrawalSettledAt: Date | null;
  replayConflictAt: Date | null;
  uploadedByUserId: number | null;
  recordedByUserId: number | null;
  decisionOutcome: string | null;
  decidedByUserId: number | null;
  decidedAt: Date | null;
  budgetOwnerId: number | null;
  bucketAssignedAt: Date | null;
  lines: GiftLine[];
}

const DECISION_SELECT = {
  decisionOutcome: true,
  decidedByUserId: true,
  decidedAt: true,
  budgetOwnerId: true,
  bucketAssignedAt: true,
} as const;

const RECEIPT_SELECT = {
  id: true,
  receiptId: true,
  receiptTotalCents: true,
  receiptDate: true,
  moneyReceivedAt: true,
  donorRecordedAt: true,
  donorLastName: true,
  donorReplacedAt: true,
  withdrawnAfterMoneyAt: true,
  withdrawalSettledAt: true,
  replayConflictAt: true,
  uploadedByUserId: true,
  ...DECISION_SELECT,
  lines: { select: { id: true, gtin13: true, description: true, quantity: true, valueCents: true }, orderBy: { lineNumber: "asc" } },
} as const;

const MANUAL_SELECT = {
  id: true,
  donationDate: true,
  recordedAt: true,
  donorLastName: true,
  recordedByUserId: true,
  ...DECISION_SELECT,
  lines: { select: { id: true, gtin13: true, description: true, quantity: true, valueCents: true, suggestedValueCents: true }, orderBy: { id: "asc" } },
} as const;

type ReceiptRow = Awaited<ReturnType<typeof findReceipts>>[number];
type ManualRow = Awaited<ReturnType<typeof findManuals>>[number];

function findReceipts(handle: DbOrTx, where: { orgId: string; id?: number }) {
  return handle.inKindDonation.findMany({ where, select: RECEIPT_SELECT, orderBy: { id: "asc" } });
}

function findManuals(handle: DbOrTx, where: { orgId: string; id?: number }) {
  return handle.manualInKindDonation.findMany({ where, select: MANUAL_SELECT, orderBy: { id: "asc" } });
}

function fromReceipt(r: ReceiptRow): Gift {
  return {
    ...r,
    source: "receipt",
    donationDate: null,
    recordedByUserId: null,
    lines: r.lines.map((l) => ({ ...l, suggestedValueCents: null })),
  };
}

function fromManual(m: ManualRow): Gift {
  return {
    ...m,
    source: "manual",
    receiptId: null,
    receiptTotalCents: null,
    receiptDate: null,
    moneyReceivedAt: m.recordedAt,
    donorRecordedAt: m.recordedAt,
    donorReplacedAt: null,
    withdrawnAfterMoneyAt: null,
    withdrawalSettledAt: null,
    replayConflictAt: null,
    uploadedByUserId: null,
  };
}

async function loadGift(handle: DbOrTx, orgId: string, source: InKindSource, id: number): Promise<Gift | null> {
  const [row] = source === "receipt" ? (await findReceipts(handle, { orgId, id })).map(fromReceipt) : (await findManuals(handle, { orgId, id })).map(fromManual);
  return row ?? null;
}

/**
 * Spreads the difference between `totalCents` and the values (a receipt's tax, shipping or
 * discount) across them by value, largest remainder first, so they sum to the total exactly.
 * All-zero values share it equally.
 */
export function spreadToTotal(values: number[], totalCents: number): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  const weights = sum > 0 ? values : values.map(() => 1);
  const weightSum = sum > 0 ? sum : values.length;
  const extra = totalCents - sum;
  const exact = weights.map((w) => (extra * w) / weightSum);
  const shares = exact.map(Math.floor);
  let left = extra - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, rem: e - shares[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i]++;
    left--;
  }
  return values.map((v, i) => v + shares[i]);
}

/** An accepted gift's lines as capital review takes them: a receipt's lines carry its tax and shipping. */
function capitalReviewLines(g: Gift, budgetOwnerId: number): CapitalReviewLine[] {
  const values = g.lines.map((l) => l.valueCents ?? 0);
  const costs = g.source === "receipt" && g.receiptTotalCents !== null ? spreadToTotal(values, g.receiptTotalCents) : values;
  return g.lines.map((l, i) => ({
    giftSource: g.source,
    giftId: g.id,
    giftLineId: l.id,
    description: l.description ?? l.gtin13 ?? "Donated item",
    quantity: l.quantity,
    costCents: costs[i],
    acquisitionDate: g.receiptDate ?? g.donationDate,
    budgetOwnerId,
  }));
}

/** A receipt gift books at the receipt's total; one without a receipt at the values finance set. */
function totalValueCents(g: Gift): number | null {
  if (g.source === "receipt") return g.receiptTotalCents;
  return g.lines.every((l) => l.valueCents !== null) ? g.lines.reduce((sum, l) => sum + (l.valueCents ?? 0), 0) : null;
}

/** The value the large-value warning reads: the booked value, or ops' suggestion before acceptance. */
function warningValueCents(g: Gift): number {
  return totalValueCents(g) ?? g.lines.reduce((sum, l) => sum + (l.valueCents ?? l.suggestedValueCents ?? 0), 0);
}

/** The uploader of a receipt gift or the recorder of one without; nobody in their household decides it. */
const partyOf = (g: Gift): number | null => g.uploadedByUserId ?? g.recordedByUserId;

interface SurnameCheck {
  personId: number;
  lastName: string;
}

/** Everything the conflict rule and the warnings read, fetched once for any number of gifts. */
interface Lookups {
  finance: number[];
  board: number[];
  households: Map<number, number[]>;
  surnames: Map<string, boolean>;
  largeValueCents: number;
}

const surnameKey = (c: SurnameCheck) => `${c.personId}:${c.lastName}`;

/** The caller's household, and the uploader's or recorder's, each against the donor's surname. */
function surnameChecks(g: Gift, callerId: number): SurnameCheck[] {
  const lastName = g.donorLastName;
  if (!lastName) return [];
  const party = partyOf(g);
  return [{ personId: callerId, lastName }, ...(party === null ? [] : [{ personId: party, lastName }])];
}

async function readLookups(gifts: Gift[], callerId: number): Promise<Lookups> {
  const dir = getInKindDirectory();
  const parties = [...new Set(gifts.map(partyOf).filter((p): p is number => p !== null))];
  const checks = [...new Map(gifts.flatMap((g) => surnameChecks(g, callerId)).map((c) => [surnameKey(c), c])).values()];
  const [finance, board, households, matches, largeValueCents] = await Promise.all([
    dir.financeHolders(),
    dir.boardMembers(),
    parties.length === 0 ? new Map<number, number[]>() : dir.householdsOf(parties),
    checks.length === 0 ? [] : dir.householdsSharingSurname(checks),
    dir.largeValueCents(),
  ]);
  return { finance, board, households, surnames: new Map(checks.map((c, i) => [surnameKey(c), matches[i] === true])), largeValueCents };
}

function conflictFacts(g: Gift, callerId: number, lk: Lookups) {
  const party = partyOf(g);
  const conflicted = new Set(party === null ? [] : [party, ...(lk.households.get(party) ?? [])]);
  const callerConflicted = conflicted.has(callerId);
  const allFinanceConflicted = lk.finance.every((id) => conflicted.has(id));
  const mayDecide = !callerConflicted && (lk.finance.includes(callerId) || (allFinanceConflicted && lk.board.includes(callerId)));
  return { callerConflicted, allFinanceConflicted, mayDecide };
}

function warnings(g: Gift, callerId: number, lk: Lookups) {
  const [caller, party] = [callerId, partyOf(g)];
  const matches = (personId: number | null) => !!g.donorLastName && personId !== null && lk.surnames.get(surnameKey({ personId, lastName: g.donorLastName })) === true;
  return {
    warnDonorSurnameMatch: matches(caller),
    warnDonorIsRecorder: matches(party),
    warnLargeValue: warningValueCents(g) >= lk.largeValueCents,
    warnDonorReplaced: g.donorReplacedAt !== null,
  };
}

interface Bucket {
  id: number;
  name: string;
  held: boolean;
}

async function readBuckets(): Promise<Map<number, Bucket>> {
  const owners = await getOwnerDirectory().list();
  return new Map(owners.map((o) => [o.id, { id: o.id, name: o.name, held: o.archivedAt !== null || !o.quickBooksClassId }]));
}

type Bookings = Map<string, { side: string; matchState: string }[]>;
const bookingKey = (source: string, giftId: number) => `${source}:${giftId}`;

async function readBookings(handle: DbOrTx, orgId: string, where: { source?: InKindSource; giftId?: number } = {}): Promise<Bookings> {
  const rows = await handle.inKindBooking.findMany({ where: { orgId, ...where }, select: { source: true, giftId: true, side: true, matchState: true } });
  const out: Bookings = new Map();
  for (const r of rows) out.set(bookingKey(r.source, r.giftId), [...(out.get(bookingKey(r.source, r.giftId)) ?? []), r]);
  return out;
}

const sideState = (sides: { side: string; matchState: string }[], side: "revenue" | "expense") => sides.find((s) => s.side === side)?.matchState ?? null;

/** What the gift waits on, most urgent first; empty once both sides are booked or it will never book. */
function waitingOn(g: Gift, buckets: Map<number, Bucket>, sides: { side: string; matchState: string }[], inCapitalReview: Set<string>): WaitingOn[] {
  if (g.withdrawalSettledAt) return [];
  const out: WaitingOn[] = [];
  if (g.withdrawnAfterMoneyAt) out.push("withdrawal");
  if (g.replayConflictAt) out.push("replay");
  if (g.decisionOutcome === "REFUSED" || g.decisionOutcome === "RETURNED" || g.withdrawnAfterMoneyAt) return out;
  if (!g.donorRecordedAt) out.push("donor");
  if (g.source === "receipt" && g.uploadedByUserId === null) out.push("uploader");
  if (g.source === "receipt" && g.receiptTotalCents === null) out.push("value");
  if (!g.decisionOutcome) out.push("decision");
  else if (g.budgetOwnerId === null || buckets.get(g.budgetOwnerId)?.held !== false) out.push("bucket");
  if (inCapitalReview.has(bookingKey(g.source, g.id))) out.push("capital");
  const booked = ["revenue", "expense"].every((side) => BOOKED_STATES.includes(sideState(sides, side as "revenue" | "expense") ?? ""));
  if (!booked) out.push("booking");
  return out;
}

/**
 * The finance queue: every gift with something left to do, from either source, with what the
 * accept screen shows. It carries no donor field. A receipt gift whose money has not arrived is
 * still being uploaded and is left out.
 */
async function listQueue(orgId: string, callerId: number) {
  const [receipts, manuals, buckets, bookings, awaiting] = await Promise.all([
    findReceipts(db, { orgId }),
    findManuals(db, { orgId }),
    readBuckets(),
    readBookings(db, orgId),
    getInKindCapital().awaitingReview(orgId),
  ]);
  const inCapitalReview = new Set(awaiting.map((a) => bookingKey(a.giftSource, a.giftId)));
  const waiting = [...receipts.filter((r) => r.moneyReceivedAt !== null).map(fromReceipt), ...manuals.map(fromManual)]
    .map((g) => {
      const sides = bookings.get(bookingKey(g.source, g.id)) ?? [];
      return { g, sides, waits: waitingOn(g, buckets, sides, inCapitalReview) };
    })
    .filter((w) => w.waits.length > 0);
  // ponytail: every waiting gift in one list; paging arrives with the drain (step 4).
  const lk = await readLookups(waiting.map((w) => w.g), callerId);
  return waiting
    .map(({ g, sides, waits }) => {
      const conflict = conflictFacts(g, callerId, lk);
      const warn = warnings(g, callerId, lk);
      const bucket = g.budgetOwnerId === null ? undefined : buckets.get(g.budgetOwnerId);
      return {
        id: g.id,
        source: g.source,
        receiptId: g.receiptId,
        receiptTotalCents: g.receiptTotalCents,
        receiptDate: g.receiptDate,
        donationDate: g.donationDate,
        moneyReceivedAt: g.moneyReceivedAt,
        donorRecordedAt: g.donorRecordedAt,
        withdrawnAfterMoneyAt: g.withdrawnAfterMoneyAt,
        withdrawalSettledAt: g.withdrawalSettledAt,
        replayConflictAt: g.replayConflictAt,
        donorReplacedAt: g.donorReplacedAt,
        uploadedByUserId: g.uploadedByUserId,
        recordedByUserId: g.recordedByUserId,
        budgetOwnerId: g.budgetOwnerId,
        budgetOwnerName: bucket?.name ?? null,
        bucketAssignedAt: g.bucketAssignedAt,
        bucketHeld: g.budgetOwnerId !== null && bucket?.held !== false,
        totalValueCents: totalValueCents(g),
        outcome: g.decisionOutcome,
        decidedAt: g.decidedAt,
        state: waits[0],
        waitingOn: waits,
        revenueBooking: sideState(sides, "revenue"),
        expenseBooking: sideState(sides, "expense"),
        ...warn,
        callerConflicted: conflict.callerConflicted,
        allFinanceConflicted: conflict.allFinanceConflicted,
        lines: g.lines,
      };
    })
    .sort((a, b) => (a.moneyReceivedAt?.getTime() ?? 0) - (b.moneyReceivedAt?.getTime() ?? 0));
}

async function lockGift(tx: DbOrTx, source: InKindSource, id: number): Promise<void> {
  if (source === "receipt") await tx.$queryRaw`SELECT id FROM in_kind_donations WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM manual_in_kind_donations WHERE id = ${id} FOR UPDATE`;
}

async function assignableBucket(bucketId: number | undefined): Promise<number> {
  if (bucketId === undefined) throw new ServiceError(400, "Accepting a gift assigns its budget bucket");
  const bucket = (await readBuckets()).get(bucketId);
  if (!bucket) throw new ServiceError(400, "Unknown budget bucket");
  if (bucket.held) throw new ServiceError(400, "That bucket is archived or has no QuickBooks Class");
  return bucketId;
}

/** Why a gift cannot be decided yet, or null when it can. */
function notDecidable(g: Gift): string | null {
  if (g.withdrawnAfterMoneyAt) return "This gift was withdrawn; settle the withdrawal instead";
  if (g.replayConflictAt) return "This gift's receipt was resent with different values; settle that first";
  if (!g.donorRecordedAt) return "This gift has no donor yet";
  if (g.source === "receipt" && g.uploadedByUserId === null) return "This gift's uploader is not recorded yet";
  return null;
}

function decisionView(g: Gift) {
  return {
    id: g.id,
    source: g.source,
    giftId: g.id,
    outcome: g.decisionOutcome,
    decidedByUserId: g.decidedByUserId,
    decidedAt: g.decidedAt,
    budgetOwnerId: g.budgetOwnerId,
    totalValueCents: totalValueCents(g),
  };
}

interface DecisionData {
  decisionOutcome: InKindOutcome;
  decidedByUserId: number;
  decidedAt: Date;
  donorHouseholdAttestedAt: Date;
  budgetOwnerId?: number;
  bucketAssignedByUserId?: number;
  bucketAssignedAt?: Date;
}

async function writeDecision(tx: DbOrTx, source: InKindSource, id: number, data: DecisionData): Promise<number> {
  const where = { id, decisionOutcome: null };
  return (source === "receipt" ? await tx.inKindDonation.updateMany({ where, data }) : await tx.manualInKindDonation.updateMany({ where, data })).count;
}

async function writeBucket(tx: DbOrTx, source: InKindSource, id: number, data: { budgetOwnerId: number; bucketAssignedByUserId: number; bucketAssignedAt: Date }) {
  if (source === "receipt") await tx.inKindDonation.update({ where: { id }, data });
  else await tx.manualInKindDonation.update({ where: { id }, data });
}

/**
 * Accept, refuse or return a gift. Re-accepting an accepted gift changes only its bucket, and
 * only while neither booking side exists.
 */
async function decide(source: InKindSource, id: number, input: InKindDecisionInput, audit: AuditContext & { actorUserId: number }) {
  const orgId = await getOrgId();
  const callerId = audit.actorUserId;
  const entity = (g: Gift) => (source === "receipt" ? { entityType: "in_kind" as const, entityId: g.receiptId } : { entityType: "manual_in_kind" as const, entityId: g.id });

  return db.$transaction(async (tx) => {
    await lockGift(tx, source, id);
    const gift = await loadGift(tx, orgId, source, id);
    if (!gift) throw new ServiceError(404, "In-kind gift not found");
    const blocked = notDecidable(gift);
    if (blocked) throw new ServiceError(409, blocked);

    const lk = await readLookups([gift], callerId);
    const conflict = conflictFacts(gift, callerId, lk);
    if (!conflict.mayDecide) {
      throw new ServiceError(
        403,
        conflict.callerConflicted
          ? "You or your household uploaded or recorded this gift, so someone else decides it"
          : "Only a finance holder decides this gift; a Board member decides only when every finance holder is conflicted",
      );
    }

    const now = new Date();
    if (gift.decisionOutcome) {
      if (gift.decisionOutcome !== "ACCEPTED" || input.outcome !== "accept" || input.lineValues) throw new ServiceError(409, "This gift is already decided");
      const sides = (await readBookings(tx, orgId, { source, giftId: id })).get(bookingKey(source, id)) ?? [];
      if (sides.length > 0) throw new ServiceError(409, "This gift has started booking; its bucket can no longer change");
      const to = await assignableBucket(input.bucketId);
      await writeBucket(tx, source, id, { budgetOwnerId: to, bucketAssignedByUserId: callerId, bucketAssignedAt: now });
      await recordEvent(tx, { orgId, ...entity(gift), eventType: "IN_KIND_BUCKET_CHANGED", ...audit, payload: { from: gift.budgetOwnerId, to } });
      return decisionView({ ...gift, budgetOwnerId: to, bucketAssignedAt: now });
    }

    const outcome = OUTCOME[input.outcome];
    const decided: DecisionData = { decisionOutcome: outcome, decidedByUserId: callerId, decidedAt: now, donorHouseholdAttestedAt: now };
    let lines = gift.lines;
    if (outcome === "ACCEPTED") {
      Object.assign(decided, { budgetOwnerId: await assignableBucket(input.bucketId), bucketAssignedByUserId: callerId, bucketAssignedAt: now });
      if (source === "receipt") {
        if (input.lineValues) throw new ServiceError(400, "A gift with a receipt keeps the receipt's values");
        if (gift.receiptTotalCents === null) throw new ServiceError(409, "This gift has no value yet; resolve the receipt total first");
      } else {
        const values = new Map((input.lineValues ?? []).map((v) => [v.lineId, v.valueCents]));
        if (values.size !== gift.lines.length || gift.lines.some((l) => !values.has(l.id))) {
          throw new ServiceError(400, "Accepting a gift without a receipt sets the value of every line");
        }
        for (const [lineId, valueCents] of values) await tx.manualInKindDonationLine.update({ where: { id: lineId }, data: { valueCents } });
        lines = gift.lines.map((l) => ({ ...l, valueCents: values.get(l.id) ?? null }));
      }
    } else if (input.bucketId !== undefined || input.lineValues) {
      throw new ServiceError(400, "Refusing or returning a gift sets no bucket or value");
    }

    if ((await writeDecision(tx, source, id, decided)) === 0) throw new ServiceError(409, "This gift is already decided");
    // Inside the transaction: a failed send rolls the accept back, and a resend after a failed commit does nothing.
    if (decided.budgetOwnerId !== undefined) await getInKindCapital().submit(orgId, capitalReviewLines({ ...gift, lines }, decided.budgetOwnerId));
    const result: Gift = {
      ...gift,
      decisionOutcome: outcome,
      decidedByUserId: callerId,
      decidedAt: now,
      budgetOwnerId: decided.budgetOwnerId ?? null,
      bucketAssignedAt: decided.bucketAssignedAt ?? null,
      lines,
    };
    const warn = warnings(result, callerId, lk);
    await recordEvent(tx, {
      orgId,
      ...entity(gift),
      eventType: "IN_KIND_DECIDED",
      ...audit,
      payload: { outcome, budgetOwnerId: result.budgetOwnerId, totalValueCents: totalValueCents(result), ...warn },
    });
    return decisionView(result);
  });
}

/**
 * Accepted gifts in the caller's buckets, or in every bucket when `seeAll` (finance and the
 * board). Approvers see what was given, its value and date, never the donor.
 */
async function listByBucket(orgId: string, callerId: number, seeAll: boolean) {
  const buckets = seeAll ? null : await getInKindDirectory().bucketsApprovedBy(callerId);
  if (buckets?.length === 0) return [];
  const where = { orgId, decisionOutcome: "ACCEPTED", ...(buckets ? { budgetOwnerId: { in: buckets } } : {}) };
  const [receipts, manuals] = await Promise.all([
    db.inKindDonation.findMany({ where: { ...where, withdrawnAfterMoneyAt: null }, select: RECEIPT_SELECT, orderBy: { id: "asc" } }),
    db.manualInKindDonation.findMany({ where, select: MANUAL_SELECT, orderBy: { id: "asc" } }),
  ]);
  return [...receipts.map(fromReceipt), ...manuals.map(fromManual)].map((g) => ({
    id: g.id,
    source: g.source,
    budgetOwnerId: g.budgetOwnerId,
    donationDate: g.donationDate ?? g.receiptDate,
    totalValueCents: totalValueCents(g),
    lines: g.lines.map(({ id, gtin13, description, quantity, valueCents }) => ({ id, gtin13, description, quantity, valueCents })),
  }));
}

const DONOR_SELECT = { donorFirstName: true, donorLastName: true, donorCompanyName: true } as const;

/** What the gift's page shows beyond the queue row: the donor, and for a gift without a receipt its recorder and inventory load. */
async function readPageExtras(orgId: string, source: InKindSource, id: number) {
  if (source === "receipt") {
    const donor = await db.inKindDonation.findFirstOrThrow({ where: { id, orgId }, select: DONOR_SELECT });
    return { ...donor, recordedAt: null, recordedByUsername: null, inventoryLoadedAt: null };
  }
  return db.manualInKindDonation.findFirstOrThrow({
    where: { id, orgId },
    select: { ...DONOR_SELECT, recordedAt: true, recordedByUsername: true, inventoryLoadedAt: true },
  });
}

/** The gift's history, oldest first; donor-read audit rows are left out. */
function readHistory(orgId: string, entityType: "in_kind" | "manual_in_kind", entityId: string) {
  return db.workflowEvent.findMany({
    where: { orgId, entityType, entityId, eventType: { not: "DONOR_DATA_READ" } },
    select: { id: true, eventType: true, actorUsername: true, occurredAt: true, payload: true },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
}

/**
 * One gift for its own page: header, donor, lines, state, history and where it went. The donor
 * read is audited. A gift without a receipt loads its goods under its own inventory source key;
 * a receipt gift's goods are received through its receipt, so it has none.
 */
async function getGift(orgId: string, source: InKindSource, id: number, reader: DonorReadContext) {
  const gift = await loadGift(db, orgId, source, id);
  if (!gift) throw new ServiceError(404, "In-kind gift not found");
  const entityType = source === "receipt" ? "in_kind" : "manual_in_kind";
  const entityId = source === "receipt" && gift.receiptId ? gift.receiptId : String(id);
  const [extras, buckets, bookings, events, awaiting] = await Promise.all([
    readPageExtras(orgId, source, id),
    readBuckets(),
    readBookings(db, orgId, { source, giftId: id }),
    readHistory(orgId, entityType, entityId),
    getInKindCapital().awaitingReview(orgId),
  ]);
  await recordDonorDataReads(db, orgId, entityType, reader, [entityId]);
  const sides = bookings.get(bookingKey(source, id)) ?? [];
  const waits = waitingOn(gift, buckets, sides, new Set(awaiting.map((w) => bookingKey(w.giftSource, w.giftId))));
  const bucket = gift.budgetOwnerId === null ? undefined : buckets.get(gift.budgetOwnerId);
  return {
    id,
    source,
    receiptId: gift.receiptId,
    receiptTotalCents: gift.receiptTotalCents,
    receiptDate: gift.receiptDate,
    donationDate: gift.donationDate,
    moneyReceivedAt: source === "receipt" ? gift.moneyReceivedAt : null,
    recordedAt: extras.recordedAt,
    recordedByUsername: extras.recordedByUsername,
    donorFirstName: extras.donorFirstName,
    donorLastName: extras.donorLastName,
    donorCompanyName: extras.donorCompanyName,
    donorRecordedAt: gift.donorRecordedAt,
    donorReplacedAt: gift.donorReplacedAt,
    withdrawnAfterMoneyAt: gift.withdrawnAfterMoneyAt,
    withdrawalSettledAt: gift.withdrawalSettledAt,
    replayConflictAt: gift.replayConflictAt,
    outcome: gift.decisionOutcome,
    decidedAt: gift.decidedAt,
    budgetOwnerId: gift.budgetOwnerId,
    budgetOwnerName: bucket?.name ?? null,
    bucketHeld: gift.budgetOwnerId !== null && bucket?.held !== false,
    bucketAssignedAt: gift.bucketAssignedAt,
    totalValueCents: totalValueCents(gift),
    state: waits[0] ?? null,
    waitingOn: waits,
    revenueBooking: sideState(sides, "revenue"),
    expenseBooking: sideState(sides, "expense"),
    inventorySourceKey: source === "manual" ? inventorySourceKey(id) : null,
    inventoryLoadedAt: extras.inventoryLoadedAt,
    lines: gift.lines,
    events,
  };
}

export const inKindAcceptService = { listQueue, decide, listByBucket, getGift };
