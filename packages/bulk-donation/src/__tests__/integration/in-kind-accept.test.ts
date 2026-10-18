/**
 * The in-kind accept step: a finance holder outside the uploader's or recorder's household
 * accepts, refuses or returns each gift; the Board decides only when every finance holder is
 * conflicted. Accepting sets the bucket (and, without a receipt, the value); the warnings only warn.
 */
import { it, expect, beforeEach } from "vitest";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import { ingestInKind, recordInKindDonor, recordInKindWithoutReceipt } from "../../inKind";
import { inKindAcceptService, InKindDecisionInputSchema, type InKindDecisionInput } from "../../services/inKindAcceptService";
import type { InKindDirectory, OwnerInfo } from "../../contract";
import { TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const R1 = "22222222-2222-4222-8222-222222222222";
const UPLOADER = 7;
const FINANCE = 10;
const FINANCE_IN_UPLOADER_HOUSEHOLD = 11;
const BOARD = 20;
const RECORDER = 30;
const DRILL = "0011111111116";

const BUCKETS: OwnerInfo[] = [
  { id: 1, name: "Robotics", archivedAt: null, quickBooksClassId: "C1" },
  { id: 2, name: "Shop", archivedAt: null, quickBooksClassId: "C2" },
  { id: 3, name: "No class", archivedAt: null, quickBooksClassId: null },
  { id: 4, name: "Archived", archivedAt: new Date("2026-01-01T00:00:00Z"), quickBooksClassId: "C4" },
];

let buckets: OwnerInfo[];
let finance: number[];
let largeValueCents: number;
let householdCalls = 0;
let surnameCalls = 0;
const HOUSEHOLDS: Record<number, number[]> = { [UPLOADER]: [UPLOADER, FINANCE_IN_UPLOADER_HOUSEHOLD], [RECORDER]: [RECORDER] };

function configure(principalId = RECORDER) {
  const inKind: InKindDirectory = {
    financeHolders: async () => finance,
    boardMembers: async () => [BOARD],
    householdsOf: async (ids) => {
      householdCalls++;
      return new Map(ids.map((id) => [id, HOUSEHOLDS[id] ?? [id]]));
    },
    householdsSharingSurname: async (checks) => {
      surnameCalls++;
      return checks.map(({ personId, lastName }) => personId === FINANCE && lastName === "Doe");
    },
    bucketsApprovedBy: async (personId) => (personId === 40 ? [1] : []),
    largeValueCents: async () => largeValueCents,
  };
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: principalId, name: "tester" }) },
    org: async () => ({ id: orgId, name: "Test Org" }),
    owners: { list: async () => buckets },
    catalog: { search: async () => [], getItem: async (g) => ({ gtin13: g, name: "Drill" }) },
    inventory: { apply: async () => undefined },
    inKind,
  });
}

function receipt(totalCents = 2500): CompletedReceipt {
  return {
    receiptId: R1,
    orgId,
    submitterId: UPLOADER,
    vendorName: "Hardware Co",
    receiptNumber: null,
    orderNumber: null,
    currency: "USD",
    taxCents: 0,
    shippingCents: 0,
    discountCents: 0,
    receiptTotalCents: totalCents,
    receiptDate: "2026-09-01",
    needsReimbursement: false,
    reimbursementFor: null,
    submittedAt: "2026-09-01T12:00:00.000Z",
    backfill: false,
    isInKind: true,
    lineItems: [
      { receiptLineItemId: 1, lineNumber: 1, description: "Drill", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: totalCents, totalPriceCents: totalCents, isDelayed: false },
    ],
  };
}

async function receiptGift(totalCents = 2500): Promise<number> {
  await ingestInKind(receipt(totalCents));
  await recordInKindDonor(orgId, R1, { firstName: "Jane", lastName: "Doe", companyName: null });
  return (await db.inKindDonation.findUniqueOrThrow({ where: { orgId_receiptId: { orgId, receiptId: R1 } } })).id;
}

async function manualGift(): Promise<{ id: number; lineIds: number[] }> {
  configure(RECORDER);
  const { id } = await recordInKindWithoutReceipt({
    donor: { firstName: "Sam", lastName: "Giver", companyName: null },
    donationDate: "2026-10-02",
    lines: [
      { gtin13: DRILL, quantity: 1, suggestedValueCents: 4000 },
      { gtin13: DRILL, quantity: 2, description: "Spare batteries" },
    ],
  });
  const lines = await db.manualInKindDonationLine.findMany({ where: { donationId: id }, orderBy: { id: "asc" } });
  return { id, lineIds: lines.map((l) => l.id) };
}

const ACCEPT: InKindDecisionInput = { outcome: "accept", bucketId: 1, confirmOutsideDonorHousehold: true };
const by = (actorUserId: number) => ({ actorUserId, actorUsername: `u${actorUserId}` });
const queueFor = (callerId: number) => inKindAcceptService.listQueue(orgId, callerId);

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.inKindDonation.deleteMany({});
  await db.manualInKindDonation.deleteMany({});
  await db.inKindBooking.deleteMany({});
  buckets = BUCKETS;
  finance = [FINANCE, FINANCE_IN_UPLOADER_HOUSEHOLD];
  largeValueCents = 50_000;
  configure();
});

describeDb("who may decide", () => {
  it("an independent finance holder accepts a receipt gift at the receipt's values", async () => {
    const id = await receiptGift();
    const view = await inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE));
    expect(view).toMatchObject({ id, source: "receipt", giftId: id, outcome: "ACCEPTED", decidedByUserId: FINANCE, budgetOwnerId: 1, totalValueCents: 2500 });
    const [item] = await queueFor(FINANCE);
    expect(item).toMatchObject({ state: "booking", waitingOn: ["booking"], budgetOwnerName: "Robotics", bucketHeld: false, outcome: "ACCEPTED" });
    const row = await db.inKindDonation.findUniqueOrThrow({ where: { id } });
    expect(row.donorHouseholdAttestedAt).not.toBeNull();
    const [event] = await db.workflowEvent.findMany({ where: { orgId, eventType: "IN_KIND_DECIDED" } });
    expect(event).toMatchObject({ entityId: R1, actorUserId: FINANCE });
    expect(event.payload).not.toMatch(/Jane|Doe/);
  });

  it("refuses a finance holder in the uploader's household, and the uploader", async () => {
    const id = await receiptGift();
    finance = [FINANCE, FINANCE_IN_UPLOADER_HOUSEHOLD, UPLOADER];
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE_IN_UPLOADER_HOUSEHOLD))).rejects.toMatchObject({ status: 403 });
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(UPLOADER))).rejects.toMatchObject({ status: 403 });
    expect((await queueFor(FINANCE_IN_UPLOADER_HOUSEHOLD))[0]).toMatchObject({ callerConflicted: true, allFinanceConflicted: false });
  });

  it("refuses the recorder of a gift without a receipt", async () => {
    const { id, lineIds } = await manualGift();
    finance = [FINANCE, RECORDER];
    const lineValues = lineIds.map((lineId) => ({ lineId, valueCents: 100 }));
    await expect(inKindAcceptService.decide("manual", id, { ...ACCEPT, lineValues }, by(RECORDER))).rejects.toMatchObject({ status: 403 });
  });

  it("the Board decides only when every finance holder is conflicted", async () => {
    const id = await receiptGift();
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(BOARD))).rejects.toMatchObject({ status: 403 });
    finance = [FINANCE_IN_UPLOADER_HOUSEHOLD];
    expect((await queueFor(BOARD))[0]).toMatchObject({ allFinanceConflicted: true, callerConflicted: false });
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(BOARD))).resolves.toMatchObject({ decidedByUserId: BOARD });
  });

  it("refuses someone who is neither finance nor Board", async () => {
    const id = await receiptGift();
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(99))).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("accepting", () => {
  it("assigns only a bucket with a QuickBooks Class that is not archived", async () => {
    const id = await receiptGift();
    for (const bucketId of [3, 4, 404]) {
      await expect(inKindAcceptService.decide("receipt", id, { ...ACCEPT, bucketId }, by(FINANCE))).rejects.toMatchObject({ status: 400 });
    }
    await expect(inKindAcceptService.decide("receipt", id, { outcome: "accept", confirmOutsideDonorHousehold: true }, by(FINANCE))).rejects.toMatchObject({ status: 400 });
  });

  it("keeps a receipt gift's values: line values are refused", async () => {
    const id = await receiptGift();
    const [line] = await db.inKindDonationLine.findMany({ where: { donationId: id } });
    await expect(inKindAcceptService.decide("receipt", id, { ...ACCEPT, lineValues: [{ lineId: line.id, valueCents: 1 }] }, by(FINANCE))).rejects.toMatchObject({ status: 400 });
  });

  it("finance sets every line's value on a gift without a receipt; ops' value stays a suggestion", async () => {
    const { id, lineIds } = await manualGift();
    expect((await queueFor(FINANCE))[0]).toMatchObject({ source: "manual", state: "decision", totalValueCents: null });
    await expect(inKindAcceptService.decide("manual", id, { ...ACCEPT, lineValues: [{ lineId: lineIds[0], valueCents: 3000 }] }, by(FINANCE))).rejects.toMatchObject({ status: 400 });

    const view = await inKindAcceptService.decide("manual", id, { ...ACCEPT, lineValues: [{ lineId: lineIds[0], valueCents: 3000 }, { lineId: lineIds[1], valueCents: 500 }] }, by(FINANCE));
    expect(view).toMatchObject({ outcome: "ACCEPTED", totalValueCents: 3500 });
    const lines = await db.manualInKindDonationLine.findMany({ where: { donationId: id }, orderBy: { id: "asc" } });
    expect(lines.map((l) => [l.valueCents, l.suggestedValueCents])).toEqual([[3000, 4000], [500, null]]);
  });

  it("refusing or returning records the outcome, sets no bucket, and leaves the queue", async () => {
    const id = await receiptGift();
    await expect(inKindAcceptService.decide("receipt", id, { outcome: "refuse", bucketId: 1, confirmOutsideDonorHousehold: true }, by(FINANCE))).rejects.toMatchObject({ status: 400 });
    const view = await inKindAcceptService.decide("receipt", id, { outcome: "return", confirmOutsideDonorHousehold: true }, by(FINANCE));
    expect(view).toMatchObject({ outcome: "RETURNED", budgetOwnerId: null });
    expect(await queueFor(FINANCE)).toEqual([]);
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE))).rejects.toMatchObject({ status: 409 });
  });

  it("a gift with no donor, or a withdrawn one, cannot be decided", async () => {
    await ingestInKind(receipt());
    const id = (await db.inKindDonation.findFirstOrThrow({ where: { orgId } })).id;
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE))).rejects.toMatchObject({ status: 409 });
    await expect(inKindAcceptService.decide("receipt", 999_999, ACCEPT, by(FINANCE))).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("the bucket after acceptance", () => {
  it("re-accepting changes the bucket while nothing has booked, with an audit row of both buckets", async () => {
    const id = await receiptGift();
    await inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE));
    await expect(inKindAcceptService.decide("receipt", id, { ...ACCEPT, bucketId: 2 }, by(FINANCE))).resolves.toMatchObject({ budgetOwnerId: 2 });
    const [event] = await db.workflowEvent.findMany({ where: { orgId, eventType: "IN_KIND_BUCKET_CHANGED" } });
    expect(JSON.parse(event.payload ?? "{}")).toEqual({ from: 1, to: 2 });
    await expect(inKindAcceptService.decide("receipt", id, { outcome: "refuse", confirmOutsideDonorHousehold: true }, by(FINANCE))).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a bucket change once any booking side exists", async () => {
    const id = await receiptGift();
    await inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE));
    await db.inKindBooking.create({ data: { orgId, source: "receipt", giftId: id, side: "revenue", matchState: "MATCHED", qbTxnId: "D-1" } });
    await expect(inKindAcceptService.decide("receipt", id, { ...ACCEPT, bucketId: 2 }, by(FINANCE))).rejects.toMatchObject({ status: 409 });
    expect((await queueFor(FINANCE))[0]).toMatchObject({ revenueBooking: "MATCHED", expenseBooking: null, state: "booking" });
  });

  it("a bucket archived or losing its Class later holds the gift", async () => {
    const id = await receiptGift();
    await inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE));
    buckets = BUCKETS.map((b) => (b.id === 1 ? { ...b, quickBooksClassId: null } : b));
    expect((await queueFor(FINANCE))[0]).toMatchObject({ state: "bucket", bucketHeld: true });
  });

  it("leaves the queue once both sides are booked", async () => {
    const id = await receiptGift();
    await inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE));
    await db.inKindBooking.createMany({
      data: [
        { orgId, source: "receipt", giftId: id, side: "revenue", matchState: "MATCHED", qbTxnId: "D-1" },
        { orgId, source: "receipt", giftId: id, side: "expense", matchState: "CREATED", qbTxnId: "P-1" },
      ],
    });
    expect(await queueFor(FINANCE)).toEqual([]);
  });
});

describeDb("warnings", () => {
  it("warns on a surname match, a large value and a replaced donor, and never blocks", async () => {
    largeValueCents = 2500;
    const id = await receiptGift(2500);
    await recordInKindDonor(orgId, R1, { firstName: "Janet", lastName: "Doe", companyName: null });
    const [item] = await queueFor(FINANCE);
    expect(item).toMatchObject({ warnDonorSurnameMatch: true, warnDonorIsRecorder: false, warnLargeValue: true, warnDonorReplaced: true });
    expect(item).not.toHaveProperty("donorLastName");
    await expect(inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE))).resolves.toMatchObject({ outcome: "ACCEPTED" });
    const [event] = await db.workflowEvent.findMany({ where: { orgId, eventType: "IN_KIND_DECIDED" } });
    expect(JSON.parse(event.payload ?? "{}")).toMatchObject({ warnDonorSurnameMatch: true, warnLargeValue: true, warnDonorReplaced: true });
  });

  it("reads ops' suggestion for the large-value warning before a gift without a receipt is valued", async () => {
    largeValueCents = 4000;
    await manualGift();
    expect((await queueFor(FINANCE))[0]).toMatchObject({ warnLargeValue: true });
  });
});

describeDb("listQueue lookups", () => {
  it("reads households and surnames once for the whole queue, not once per gift", async () => {
    await receiptGift();
    await manualGift();
    await manualGift();
    configure();
    householdCalls = 0;
    surnameCalls = 0;
    expect(await queueFor(FINANCE)).toHaveLength(3);
    expect([householdCalls, surnameCalls]).toEqual([1, 1]);
  });
});

describeDb("accepting: the total cap", () => {
  it("refuses line values whose total is over $1,000,000", () => {
    const lineValues = [1, 2].map((lineId) => ({ lineId, valueCents: 60_000_000 }));
    expect(InKindDecisionInputSchema.safeParse({ ...ACCEPT, lineValues }).success).toBe(false);
    expect(InKindDecisionInputSchema.safeParse({ ...ACCEPT, lineValues: lineValues.slice(0, 1) }).success).toBe(true);
  });
});

describeDb("listByBucket", () => {
  it("shows an approver the accepted gifts in their buckets, with no donor", async () => {
    const id = await receiptGift();
    await inKindAcceptService.decide("receipt", id, ACCEPT, by(FINANCE));
    const { id: manualId, lineIds } = await manualGift();
    await inKindAcceptService.decide("manual", manualId, { ...ACCEPT, bucketId: 2, lineValues: lineIds.map((lineId) => ({ lineId, valueCents: 100 })) }, by(FINANCE));

    const mine = await inKindAcceptService.listByBucket(orgId, 40, false);
    expect(mine).toEqual([
      { id, source: "receipt", budgetOwnerId: 1, donationDate: "2026-09-01", totalValueCents: 2500, lines: [expect.objectContaining({ description: "Drill", valueCents: 2500 })] },
    ]);
    expect(JSON.stringify(mine)).not.toMatch(/Jane|Doe|Sam|Giver/);
    expect(await inKindAcceptService.listByBucket(orgId, 41, false)).toEqual([]);
    expect((await inKindAcceptService.listByBucket(orgId, FINANCE, true)).map((g) => g.source).sort()).toEqual(["manual", "receipt"]);
  });
});
