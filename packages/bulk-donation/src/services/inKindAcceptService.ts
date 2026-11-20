// The in-kind accept step: every gift, with or without a receipt, is accepted,
// refused or returned by a finance holder who is outside the uploader's or recorder's household,
// or by a Board member when every finance holder is conflicted. The screen's warnings never block.
import { z } from "zod";
import { db, type DbOrTx } from "../db";
import { getInKindCapital, getInKindDirectory, getInventoryApply, getOrgId, getOwnerDirectory } from "../runtime";
import { recordEvent } from "../repositories/audit";
import { inventorySourceKey } from "../contract";
import type { AuditContext } from "../workflows/disbursement.actor";
import { QB_MATCH_STATE } from "../lib/qb-match";
import { MAX_IN_KIND_LINES, MAX_IN_KIND_LINE_VALUE_CENTS, MAX_IN_KIND_TOTAL_CENTS } from "./manualInKindService";
import { ServiceError } from "@checkin/component-kit";
import { formatGtinDisplay } from "@checkin/gtin";
import { freeLines, spreadToTotal } from "../lib/in-kind-value";

export type InKindSource = "receipt" | "manual";
export type InKindOutcome = "ACCEPTED" | "REFUSED" | "RETURNED";

export const InKindDecisionInputSchema = z.object({
  outcome: z.enum(["accept", "refuse", "return"]),
  bucketId: z.number().int().positive().optional(),
  lineValues: z
    .array(z.object({ lineId: z.number().int().positive(), valueCents: z.number().int().positive().max(MAX_IN_KIND_LINE_VALUE_CENTS) }))
    .max(MAX_IN_KIND_LINES)
    .refine((values) => values.reduce((sum, v) => sum + v.valueCents, 0) <= MAX_IN_KIND_TOTAL_CENTS, { message: "The gift's total is over the limit" })
    .optional(),
  /** The decider's attestation that they are outside the donor's household; the app cannot check it. */
  confirmOutsideDonorHousehold: z.literal(true),
  /** The decider's attestation that the goods exist and arrived, not only the receipt; a first accept requires it. */
  confirmGoodsReceived: z.literal(true).optional(),
});
export type InKindDecisionInput = z.infer<typeof InKindDecisionInputSchema>;

const OUTCOME: Record<InKindDecisionInput["outcome"], InKindOutcome> = { accept: "ACCEPTED", refuse: "REFUSED", return: "RETURNED" };
const BOOKED_STATES: readonly string[] = [QB_MATCH_STATE.MATCHED, QB_MATCH_STATE.CREATED];

/**
 * What a gift waits on, most urgent first. `replay` is an anomaly finance settles; `capital` means a
 * line waits on finance's capital review; `register` means a capital line waits on the drain for its
 * asset numbers; `booking` means ready, waiting on the QuickBooks drain.
 */
export type WaitingOn = "replay" | "donor" | "uploader" | "value" | "decision" | "bucket" | "capital" | "register" | "booking";

interface GiftLine {
  id: number;
  gtin13: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  suggestedValueCents: number | null;
  /** The value finance set on a receipt line priced at $0; null on every other line. */
  financeValueCents: number | null;
  /** The account finance set by hand on a held line; it wins over every account rule. */
  quickBooksAccountId: string | null;
  isCapital: boolean | null;
  depreciationYears: number | null;
  capitalBucketId: number | null;
  registeredAt: Date | null;
}

/** A line as the screens show it: a free receipt line shows the value finance set. */
const lineView = ({ financeValueCents, ...l }: GiftLine) => ({ ...l, valueCents: financeValueCents ?? l.valueCents });

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
  replayConflictAt: Date | null;
  uploadedByUserId: number | null;
  recordedByUserId: number | null;
  decisionOutcome: string | null;
  decidedByUserId: number | null;
  decidedAt: Date | null;
  budgetOwnerId: number | null;
  bucketAssignedAt: Date | null;
  capitalReviewNeeded: boolean | null;
  lines: GiftLine[];
}

const DECISION_SELECT = {
  decisionOutcome: true,
  decidedByUserId: true,
  decidedAt: true,
  budgetOwnerId: true,
  bucketAssignedAt: true,
  capitalReviewNeeded: true,
} as const;

const CAPITAL_LINE_SELECT = { isCapital: true, depreciationYears: true, capitalBucketId: true, registeredAt: true } as const;

const RECEIPT_SELECT = {
  id: true,
  receiptId: true,
  receiptTotalCents: true,
  receiptDate: true,
  moneyReceivedAt: true,
  donorRecordedAt: true,
  donorLastName: true,
  donorReplacedAt: true,
  replayConflictAt: true,
  uploadedByUserId: true,
  ...DECISION_SELECT,
  lines: { select: { id: true, gtin13: true, description: true, quantity: true, valueCents: true, financeValueCents: true, quickBooksAccountId: true, ...CAPITAL_LINE_SELECT }, orderBy: { lineNumber: "asc" } },
} as const;

const MANUAL_SELECT = {
  id: true,
  donationDate: true,
  recordedAt: true,
  donorLastName: true,
  recordedByUserId: true,
  ...DECISION_SELECT,
  lines: { select: { id: true, gtin13: true, description: true, quantity: true, valueCents: true, suggestedValueCents: true, quickBooksAccountId: true, ...CAPITAL_LINE_SELECT }, orderBy: { id: "asc" } },
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
    replayConflictAt: null,
    uploadedByUserId: null,
    lines: m.lines.map((l) => ({ ...l, financeValueCents: null })),
  };
}

export async function loadGift(handle: DbOrTx, orgId: string, source: InKindSource, id: number): Promise<Gift | null> {
  const [row] = source === "receipt" ? (await findReceipts(handle, { orgId, id })).map(fromReceipt) : (await findManuals(handle, { orgId, id })).map(fromManual);
  return row ?? null;
}

/**
 * Each line's booked value. A receipt's total spreads over its lines by the receipt's prices, so
 * its tax, shipping and discount land on the priced lines; a line that comes to $0 then adds the
 * value finance set. The lines sum to `totalValueCents`.
 */
function bookedLineCents(g: Gift): number[] {
  const values = g.lines.map((l) => l.valueCents ?? 0);
  if (g.source !== "receipt" || g.receiptTotalCents === null) return values;
  return spreadToTotal(values, g.receiptTotalCents).map((cents, i) => cents + (g.lines[i].financeValueCents ?? 0));
}

const lineName = (g: Gift, l: GiftLine) => `Line ${g.lines.indexOf(l) + 1} (${l.description ?? (l.gtin13 ? formatGtinDisplay(l.gtin13) : "donated item")})`;

/** Each line as it books, with its description for the books and the register. */
export function bookedLines(g: Gift): { line: GiftLine; description: string; costCents: number }[] {
  const costs = bookedLineCents(g);
  return g.lines.map((line, i) => ({
    line,
    description: line.description ?? (line.gtin13 ? formatGtinDisplay(line.gtin13) : "Donated item"),
    costCents: costs[i],
  }));
}

/**
 * What an accepted gift's capital decision waits on, read from its own lines: finance's two steps,
 * then the drain's registration. A gift line's `isCapital` is null until designated.
 */
export function capitalWaitsOn(g: Pick<Gift, "decisionOutcome" | "capitalReviewNeeded" | "lines">): "capital" | "register" | null {
  if (g.decisionOutcome !== "ACCEPTED" || g.capitalReviewNeeded !== true) return null;
  if (g.lines.some((l) => l.isCapital === null || (l.isCapital && l.depreciationYears === null))) return "capital";
  if (g.lines.some((l) => l.isCapital && l.registeredAt === null)) return "register";
  return null;
}

/** A receipt gift books at the receipt's total plus the values finance set on its free lines; one without a receipt at the values finance set. */
function totalValueCents(g: Gift): number | null {
  if (g.source === "receipt") return g.receiptTotalCents === null ? null : g.lines.reduce((sum, l) => sum + (l.financeValueCents ?? 0), g.receiptTotalCents);
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

interface Posting {
  matchState: string;
  qbNote: string | null;
  qbFirstFailedAt: Date | null;
  qbLastError: string | null;
}

/** Each gift's way to QuickBooks: its match state, finance's note, and when its post first failed and why it last failed. */
async function readPostings(handle: DbOrTx, orgId: string, where: { source?: InKindSource; giftId?: number } = {}): Promise<Map<string, Posting>> {
  const rows = await handle.inKindPosting.findMany({ where: { orgId, ...where }, select: { source: true, giftId: true, matchState: true, qbNote: true, qbFirstFailedAt: true, qbLastError: true } });
  return new Map(rows.map(({ source, giftId, ...posting }) => [bookingKey(source, giftId), posting]));
}

const sideState = (sides: { side: string; matchState: string }[], side: "revenue" | "expense" | "journal") => sides.find((s) => s.side === side)?.matchState ?? null;
/** A side's booking: the hand entry finance booked for it, or the app's one journal entry, which books both. */
const bookedSide = (sides: { side: string; matchState: string }[], side: "revenue" | "expense") => sideState(sides, side) ?? sideState(sides, "journal");

/** What the gift waits on, most urgent first; empty once both sides are booked, finance skipped it, or it will never book. */
function waitingOn(g: Gift, buckets: Map<number, Bucket>, sides: { side: string; matchState: string }[], posting: Posting | undefined): WaitingOn[] {
  const out: WaitingOn[] = [];
  if (g.replayConflictAt) out.push("replay");
  if (g.decisionOutcome === "REFUSED" || g.decisionOutcome === "RETURNED") return out;
  if (!g.donorRecordedAt) out.push("donor");
  if (g.source === "receipt" && g.uploadedByUserId === null) out.push("uploader");
  if (g.source === "receipt" && g.receiptTotalCents === null) out.push("value");
  if (!g.decisionOutcome) out.push("decision");
  else if (g.budgetOwnerId === null || buckets.get(g.budgetOwnerId)?.held !== false) out.push("bucket");
  const capital = capitalWaitsOn(g);
  if (capital) out.push(capital);
  if (!isBooked(sides, posting)) out.push("booking");
  return out;
}

/** Both sides are in QuickBooks, or finance skipped the gift. */
const isBooked = (sides: { side: string; matchState: string }[], posting: Posting | undefined) =>
  (["revenue", "expense"] as const).every((side) => BOOKED_STATES.includes(bookedSide(sides, side) ?? "")) || posting?.matchState === QB_MATCH_STATE.DISMISSED;

/** How many gifts of goods in bucket `bucketId` are not yet booked, refused or returned. */
export async function unbookedGiftsIn(bucketId: number): Promise<number> {
  const orgId = await getOrgId();
  const where = { orgId, budgetOwnerId: bucketId, OR: [{ decisionOutcome: null }, { decisionOutcome: { notIn: ["REFUSED", "RETURNED"] } }] };
  const select = { id: true } as const;
  const [receipts, manuals, bookings, postings] = await Promise.all([
    db.inKindDonation.findMany({ where, select }),
    db.manualInKindDonation.findMany({ where, select }),
    readBookings(db, orgId),
    readPostings(db, orgId),
  ]);
  const keys = [...receipts.map((g) => bookingKey("receipt", g.id)), ...manuals.map((g) => bookingKey("manual", g.id))];
  return keys.filter((key) => !isBooked(bookings.get(key) ?? [], postings.get(key))).length;
}

/**
 * The finance queue: every gift with something left to do or a QuickBooks note for finance, from
 * either source, with what the accept screen shows. It carries no donor field. A receipt gift whose
 * money has not arrived is still being uploaded and is left out.
 */
async function listQueue(orgId: string, callerId: number) {
  const [receipts, manuals, buckets, bookings, postings] = await Promise.all([
    findReceipts(db, { orgId }),
    findManuals(db, { orgId }),
    readBuckets(),
    readBookings(db, orgId),
    readPostings(db, orgId),
  ]);
  const waiting = [...receipts.filter((r) => r.moneyReceivedAt !== null).map(fromReceipt), ...manuals.map(fromManual)]
    .map((g) => {
      const sides = bookings.get(bookingKey(g.source, g.id)) ?? [];
      const posting = postings.get(bookingKey(g.source, g.id));
      return { g, sides, posting, waits: waitingOn(g, buckets, sides, posting) };
    })
    // A gift with nothing left to wait on stays while it carries a note, such as the sweep's stray entry.
    .filter((w) => w.waits.length > 0 || !!w.posting?.qbNote);
  // ponytail: every waiting gift in one list; page it when the queue outgrows one screen.
  const lk = await readLookups(waiting.map((w) => w.g), callerId);
  return waiting
    .map((w) => queueRow(w, buckets, callerId, lk))
    .sort((a, b) => (a.moneyReceivedAt?.getTime() ?? 0) - (b.moneyReceivedAt?.getTime() ?? 0));
}

/** One gift's queue row, as the queue and finance's QuickBooks actions reply with it. */
function queueRow(
  { g, sides, posting, waits }: { g: Gift; sides: { side: string; matchState: string }[]; posting: Posting | undefined; waits: WaitingOn[] },
  buckets: Map<number, Bucket>,
  callerId: number,
  lk: Lookups,
) {
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
    state: waits[0] ?? null,
    waitingOn: waits,
    revenueBooking: bookedSide(sides, "revenue"),
    expenseBooking: bookedSide(sides, "expense"),
    qbState: posting?.matchState ?? null,
    qbNote: posting?.qbNote ?? null,
    ...warn,
    callerConflicted: conflict.callerConflicted,
    allFinanceConflicted: conflict.allFinanceConflicted,
    lines: g.lines.map(lineView),
  };
}

/** One gift's queue row, whether or not it still waits on anything (a skipped or booked gift has left the queue). */
async function queueItem(orgId: string, callerId: number, source: InKindSource, id: number) {
  const g = await loadGift(db, orgId, source, id);
  if (!g) throw new ServiceError(404, "In-kind gift not found");
  const [buckets, bookings, postings, lk] = await Promise.all([
    readBuckets(),
    readBookings(db, orgId, { source, giftId: id }),
    readPostings(db, orgId, { source, giftId: id }),
    readLookups([g], callerId),
  ]);
  const sides = bookings.get(bookingKey(source, id)) ?? [];
  const posting = postings.get(bookingKey(source, id));
  const waits = waitingOn(g, buckets, sides, posting);
  return queueRow({ g, sides, posting, waits }, buckets, callerId, lk);
}

export async function lockGift(tx: DbOrTx, source: InKindSource, id: number): Promise<void> {
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
  capitalReviewNeeded?: boolean;
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
      const posting = await tx.inKindPosting.findUnique({ where: { orgId_source_giftId: { orgId, source, giftId: id } }, select: { matchState: true, qbCreateAttemptedAt: true } });
      // An attempted create may have landed in QuickBooks carrying the old bucket's Class.
      if (sides.length > 0 || posting?.matchState === QB_MATCH_STATE.POSTING || posting?.qbCreateAttemptedAt) {
        throw new ServiceError(409, "This gift has started booking; its bucket can no longer change");
      }
      // The current bucket is kept as is, held or not.
      const to = gift.budgetOwnerId !== null && input.bucketId === gift.budgetOwnerId ? gift.budgetOwnerId : await assignableBucket(input.bucketId);
      const unchanged = to === gift.budgetOwnerId;
      if (!unchanged) {
        await writeBucket(tx, source, id, { budgetOwnerId: to, bucketAssignedByUserId: callerId, bucketAssignedAt: now });
        await recordEvent(tx, { orgId, ...entity(gift), eventType: "IN_KIND_BUCKET_CHANGED", ...audit, payload: { from: gift.budgetOwnerId, to } });
      }
      const result = unchanged ? gift : { ...gift, budgetOwnerId: to, bucketAssignedAt: now };
      return decisionView(result);
    }

    const outcome = OUTCOME[input.outcome];
    const decided: DecisionData = { decisionOutcome: outcome, decidedByUserId: callerId, decidedAt: now, donorHouseholdAttestedAt: now };
    let lines = gift.lines;
    if (outcome === "ACCEPTED") {
      if (!input.confirmGoodsReceived) throw new ServiceError(400, "Accepting a gift confirms the goods exist and arrived");
      Object.assign(decided, { budgetOwnerId: await assignableBucket(input.bucketId), bucketAssignedByUserId: callerId, bucketAssignedAt: now });
      if (source === "receipt") {
        if (gift.receiptTotalCents === null) throw new ServiceError(409, "This gift has no value yet; resolve the receipt total first");
        const values = new Map((input.lineValues ?? []).map((v) => [v.lineId, v.valueCents]));
        const isFree = freeLines(gift.lines.map((l) => l.valueCents ?? 0), gift.receiptTotalCents);
        const free = gift.lines.filter((_, i) => isFree[i]);
        if ([...values.keys()].some((lineId) => !free.some((l) => l.id === lineId))) {
          throw new ServiceError(400, "A gift with a receipt keeps the receipt's values; only a line that comes to $0 on it takes a value");
        }
        const unvalued = free.find((l) => !values.has(l.id));
        if (unvalued) throw new ServiceError(400, `${lineName(gift, unvalued)} comes to $0 on the receipt; set its value to accept the gift`);
        lines = gift.lines.map((l) => ({ ...l, financeValueCents: values.get(l.id) ?? null }));
        for (const [lineId, financeValueCents] of values) await tx.inKindDonationLine.update({ where: { id: lineId }, data: { financeValueCents } });
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

    if (outcome === "ACCEPTED") {
      const accepted = { ...gift, lines };
      decided.capitalReviewNeeded = await getInKindCapital().reviewNeeded(orgId, {
        totalCents: totalValueCents(accepted) ?? 0,
        lines: bookedLines(accepted).map((l) => ({ costCents: l.costCents, quantity: l.line.quantity })),
      });
    }
    if ((await writeDecision(tx, source, id, decided)) === 0) throw new ServiceError(409, "This gift is already decided");
    const result: Gift = {
      ...gift,
      decisionOutcome: outcome,
      decidedByUserId: callerId,
      decidedAt: now,
      budgetOwnerId: decided.budgetOwnerId ?? null,
      bucketAssignedAt: decided.bucketAssignedAt ?? null,
      capitalReviewNeeded: decided.capitalReviewNeeded ?? null,
      lines,
    };
    const warn = warnings(result, callerId, lk);
    await recordEvent(tx, {
      orgId,
      ...entity(gift),
      eventType: "IN_KIND_DECIDED",
      ...audit,
      payload: {
        outcome,
        budgetOwnerId: result.budgetOwnerId,
        totalValueCents: totalValueCents(result),
        ...(outcome === "ACCEPTED" ? { goodsConfirmed: true, capitalReviewNeeded: result.capitalReviewNeeded } : {}),
        ...(input.lineValues ? { lineValues: input.lineValues } : {}),
        ...warn,
      },
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
    db.inKindDonation.findMany({ where, select: RECEIPT_SELECT, orderBy: { id: "asc" } }),
    db.manualInKindDonation.findMany({ where, select: MANUAL_SELECT, orderBy: { id: "asc" } }),
  ]);
  return [...receipts.map(fromReceipt), ...manuals.map(fromManual)].map((g) => ({
    id: g.id,
    source: g.source,
    budgetOwnerId: g.budgetOwnerId,
    donationDate: g.donationDate ?? g.receiptDate,
    totalValueCents: totalValueCents(g),
    lines: g.lines.map(lineView).map(({ id, gtin13, description, quantity, valueCents }) => ({ id, gtin13, description, quantity, valueCents })),
  }));
}

const DONOR_SELECT = { donorFirstName: true, donorLastName: true, donorCompanyName: true } as const;

/**
 * What the gift's page shows beyond the queue row: the donor, and for a gift without a receipt its
 * recorder and inventory load, with why the load failed while it has not loaded.
 */
async function readPageExtras(orgId: string, source: InKindSource, id: number) {
  if (source === "receipt") {
    const donor = await db.inKindDonation.findFirstOrThrow({ where: { id, orgId }, select: DONOR_SELECT });
    return { ...donor, recordedAt: null, recordedByUsername: null, inventoryLoadedAt: null, inventoryLoadFailureReason: null };
  }
  const row = await db.manualInKindDonation.findFirstOrThrow({
    where: { id, orgId },
    select: { ...DONOR_SELECT, recordedAt: true, recordedByUsername: true, inventoryLoadedAt: true },
  });
  const inventoryLoadFailureReason = row.inventoryLoadedAt ? null : await readLoadFailure(id);
  return { ...row, inventoryLoadFailureReason };
}

/** The page loads without the reason when inventory cannot answer, and keeps its "Load again". */
async function readLoadFailure(id: number): Promise<string | null> {
  try {
    return await getInventoryApply().failureReason(inventorySourceKey(id));
  } catch (err) {
    console.warn(`[bulk-donation] reading in-kind donation ${id}'s inventory load failure failed`, err);
    return null;
  }
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
 * One gift for its own page: header, donor, lines, state, history and where it went. A gift without a receipt loads its goods under its own inventory source key;
 * a receipt gift's goods are received through its receipt, so it has none.
 */
async function getGift(orgId: string, source: InKindSource, id: number) {
  const gift = await loadGift(db, orgId, source, id);
  if (!gift) throw new ServiceError(404, "In-kind gift not found");
  const entityType = source === "receipt" ? "in_kind" : "manual_in_kind";
  const entityId = source === "receipt" && gift.receiptId ? gift.receiptId : String(id);
  const [extras, buckets, bookings, postings, events] = await Promise.all([
    readPageExtras(orgId, source, id),
    readBuckets(),
    readBookings(db, orgId, { source, giftId: id }),
    readPostings(db, orgId, { source, giftId: id }),
    readHistory(orgId, entityType, entityId),
  ]);
  const sides = bookings.get(bookingKey(source, id)) ?? [];
  const posting = postings.get(bookingKey(source, id));
  const waits = waitingOn(gift, buckets, sides, posting);
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
    replayConflictAt: gift.replayConflictAt,
    outcome: gift.decisionOutcome,
    decidedAt: gift.decidedAt,
    budgetOwnerId: gift.budgetOwnerId,
    budgetOwnerName: bucket?.name ?? null,
    bucketHeld: gift.budgetOwnerId !== null && bucket?.held !== false,
    bucketAssignedAt: gift.bucketAssignedAt,
    totalValueCents: totalValueCents(gift),
    capitalReviewNeeded: gift.capitalReviewNeeded,
    state: waits[0] ?? null,
    waitingOn: waits,
    revenueBooking: bookedSide(sides, "revenue"),
    expenseBooking: bookedSide(sides, "expense"),
    qbFirstFailedAt: posting?.qbFirstFailedAt ?? null,
    qbLastError: posting?.qbLastError ?? null,
    inventorySourceKey: source === "manual" ? inventorySourceKey(id) : null,
    inventoryLoadedAt: extras.inventoryLoadedAt,
    inventoryLoadFailureReason: extras.inventoryLoadFailureReason,
    lines: gift.lines.map(lineView),
    events,
  };
}

/** An accepted gift as its journal entry books it: one line per gift line, a receipt's tax and shipping spread across them. */
export interface GiftToBook {
  source: InKindSource;
  id: number;
  /** The gift's audit entity: a receipt gift's receipt id, or a gift without one's own id. */
  entityType: "in_kind" | "manual_in_kind";
  entityId: string;
  txnDate: string | null;
  /** When the app first held the gift, compared with the lane's switch-on. */
  createdAt: Date;
  totalCents: number;
  budgetOwnerId: number;
  /** `isCapital` is finance's decision on the line: a capital line debits a fixed-asset account. */
  lines: { id: number; description: string; valueCents: number; gtin13: string | null; quickBooksAccountId: string | null; isCapital: boolean }[];
}

function toBook(g: Gift): GiftToBook | null {
  const total = totalValueCents(g);
  if (g.budgetOwnerId === null || total === null || g.moneyReceivedAt === null) return null;
  return {
    source: g.source,
    id: g.id,
    entityType: g.source === "receipt" ? "in_kind" : "manual_in_kind",
    entityId: g.source === "receipt" && g.receiptId ? g.receiptId : String(g.id),
    txnDate: g.receiptDate ?? g.donationDate,
    createdAt: g.moneyReceivedAt,
    totalCents: total,
    budgetOwnerId: g.budgetOwnerId,
    lines: bookedLines(g).map(({ line, description, costCents }) => ({
      id: line.id,
      description,
      valueCents: costCents,
      gtin13: line.gtin13,
      quickBooksAccountId: line.quickBooksAccountId,
      isCapital: line.isCapital === true,
    })),
  };
}

/** What readiness reads outside the drain's transactions: the buckets live in checkin's database. */
export interface ReadinessContext {
  buckets: Map<number, Bucket>;
}

async function readReadiness(): Promise<ReadinessContext> {
  return { buckets: await readBuckets() };
}

/**
 * Every gift still to book. `ready` waits on nothing but booking, so a gift whose capital line has
 * no asset numbers yet is never among them; `open` adds those waiting on anything else first.
 */
async function giftsToBook(orgId: string, ctx: ReadinessContext): Promise<{ ready: GiftToBook[]; open: GiftToBook[] }> {
  const [receipts, manuals, bookings, postings] = await Promise.all([findReceipts(db, { orgId }), findManuals(db, { orgId }), readBookings(db, orgId), readPostings(db, orgId)]);
  const ready: GiftToBook[] = [];
  const open: GiftToBook[] = [];
  for (const g of [...receipts.filter((r) => r.moneyReceivedAt !== null).map(fromReceipt), ...manuals.map(fromManual)]) {
    const key = bookingKey(g.source, g.id);
    const waits = waitingOn(g, ctx.buckets, bookings.get(key) ?? [], postings.get(key));
    const gift = waits.includes("booking") ? toBook(g) : null;
    if (!gift) continue;
    open.push(gift);
    // A drifted gift stays open, so it can rival a hand booking, but only finance moves it.
    if (waits.length === 1 && postings.get(key)?.matchState !== QB_MATCH_STATE.DRIFT) ready.push(gift);
  }
  return { ready, open };
}

/** Locks the gift and returns it only while it waits on nothing but booking, its capital lines re-read under the lock. */
async function lockReadyGift(tx: DbOrTx, orgId: string, source: InKindSource, id: number, ctx: ReadinessContext): Promise<GiftToBook | null> {
  await lockGift(tx, source, id);
  const gift = await loadGift(tx, orgId, source, id);
  if (!gift) return null;
  const sides = (await readBookings(tx, orgId, { source, giftId: id })).get(bookingKey(source, id)) ?? [];
  const posting = (await readPostings(tx, orgId, { source, giftId: id })).get(bookingKey(source, id));
  const waits = waitingOn(gift, ctx.buckets, sides, posting);
  return waits.length === 1 && waits[0] === "booking" ? toBook(gift) : null;
}

export const inKindAcceptService = { listQueue, queueItem, decide, listByBucket, getGift };

/** What the in-kind drain reads; not part of any route. */
export const inKindReadiness = { readReadiness, giftsToBook, lockReadyGift };
