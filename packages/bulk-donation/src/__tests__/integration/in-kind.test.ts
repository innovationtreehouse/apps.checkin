/**
 * In-kind donations with a receipt: the money side (X9) and the donor (X13) join on
 * receiptId in either order; money first waits as "donor needed", then waits to be accepted;
 * the money side is written once; a withdrawal after money is an anomaly finance settles.
 */
import { it, expect, beforeEach } from "vitest";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { giftOutcomes, ingestInKind, recordInKindDonor, withdrawInKind } from "../../inKind";
import { inKindService } from "../../services/inKindService";
import { inKindAcceptService } from "../../services/inKindAcceptService";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const R1 = "11111111-1111-4111-8111-111111111111";
const DONOR = { firstName: "Jane", lastName: "Doe", companyName: "Acme" };

function receipt(receiptId: string, totalCents = 2500): CompletedReceipt {
  return {
    receiptId,
    orgId,
    submitterId: 7,
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

const row = () => db.inKindDonation.findUnique({ where: { orgId_receiptId: { orgId, receiptId: R1 } } });
const queue = () => inKindAcceptService.listQueue(orgId, 1);
const AUDIT = { actorUserId: 1, actorUsername: "testfinance" };

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.inKindDonation.deleteMany({});
  await db.inKindSyncMark.deleteMany({});
  await db.manualInKindDonation.deleteMany({});
  await db.inKindBooking.deleteMany({});
  configureTestRuntime();
});

describeDb("in-kind join on receiptId", () => {
  it.each(["", "usd"])("takes the money side of a receipt with a currency of %j", async (currency) => {
    await ingestInKind({ ...receipt(R1), currency });
    expect(await row()).toMatchObject({ receiptTotalCents: 2500 });
  });

  it("refuses the money side of a receipt with a currency of \"$\"", async () => {
    await expect(ingestInKind({ ...receipt(R1), currency: "$" })).rejects.toThrow();
  });

  it("money first waits as donor needed, then waits to be accepted once the donor arrives", async () => {
    await ingestInKind(receipt(R1));
    expect((await queue()).map((q) => [q.receiptId, q.state])).toEqual([[R1, "donor"]]);

    await recordInKindDonor(orgId, R1, DONOR, 0);
    expect((await queue()).map((q) => [q.receiptId, q.state])).toEqual([[R1, "decision"]]);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane", donorCompanyName: "Acme" });
  });

  it("donor first shows nothing until the money arrives, then waits to be accepted", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 0);
    expect(await queue()).toEqual([]);
    await ingestInKind(receipt(R1));
    expect((await queue()).map((q) => q.state)).toEqual(["decision"]);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorLastName: "Doe" });
  });

  it("is idempotent: a replayed money side keeps its first arrival; a later donor replaces", async () => {
    await ingestInKind(receipt(R1));
    const first = (await row())!.moneyReceivedAt;
    await ingestInKind(receipt(R1));
    expect((await row())!).toMatchObject({ moneyReceivedAt: first, replayConflictAt: null });

    await recordInKindDonor(orgId, R1, DONOR, 0);
    await recordInKindDonor(orgId, R1, DONOR, 0);
    expect((await row())!.donorReplacedAt).toBeNull();
    await recordInKindDonor(orgId, R1, { firstName: "John", lastName: "Roe", companyName: null }, 0);
    expect(await row()).toMatchObject({ donorFirstName: "John", donorLastName: "Roe", donorCompanyName: null, donorReplacedAt: expect.any(Date) });
    expect(await db.inKindDonation.count()).toBe(1);
    expect((await queue())[0]).toMatchObject({ warnDonorReplaced: true });
  });

  it("stores the receipt's lines and uploader on the first arrival", async () => {
    await ingestInKind(receipt(R1));
    const stored = await db.inKindDonation.findUniqueOrThrow({ where: { orgId_receiptId: { orgId, receiptId: R1 } }, include: { lines: true } });
    expect(stored.uploadedByUserId).toBe(7);
    expect(stored.lines.map(({ receiptLineItemId, description, quantity, valueCents }) => ({ receiptLineItemId, description, quantity, valueCents }))).toEqual([
      { receiptLineItemId: 1, description: "Drill", quantity: 1, valueCents: 2500 },
    ]);
  });

  it("a replay that differs never changes the value: the first write stands and the gift is raised for finance", async () => {
    await ingestInKind(receipt(R1, 2500));
    await ingestInKind(receipt(R1, 9900));
    const stored = await db.inKindDonation.findUniqueOrThrow({ where: { orgId_receiptId: { orgId, receiptId: R1 } }, include: { lines: true } });
    expect(stored).toMatchObject({ receiptTotalCents: 2500, replayConflictAt: expect.any(Date) });
    expect(stored.lines.map((l) => l.valueCents)).toEqual([2500]);
    expect((await queue()).map((q) => q.state)).toEqual(["replay"]);
    const events = await db.workflowEvent.findMany({ where: { orgId, eventType: "IN_KIND_REPLAY_CONFLICT" } });
    expect(events).toHaveLength(1);
  });

  it("concurrent halves for one receipt land on one row", async () => {
    await Promise.all([ingestInKind(receipt(R1)), recordInKindDonor(orgId, R1, DONOR, 0)]);
    expect(await db.inKindDonation.count()).toBe(1);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane" });
  });
});

describeDb("withdrawInKind", () => {
  it("is a no-op for an unknown receipt", async () => {
    await withdrawInKind(orgId, R1, 0);
    expect(await db.inKindDonation.count()).toBe(0);
  });

  it("deletes a waiting donor", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 0);
    await withdrawInKind(orgId, R1, 0);
    await withdrawInKind(orgId, R1, 0);
    expect(await row()).toBeNull();
  });

  it("deletes the row with its money side not yet arrived, and records the withdrawal", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 0);
    await withdrawInKind(orgId, R1, 1);
    expect(await row()).toBeNull();
    expect(await db.workflowEvent.count({ where: { orgId, eventType: "IN_KIND_WITHDRAWN" } })).toBe(1);
  });

  it("after money, changes nothing", async () => {
    await ingestInKind(receipt(R1));
    await recordInKindDonor(orgId, R1, DONOR, 0);
    await withdrawInKind(orgId, R1, 0);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane" });
    expect((await queue()).map((q) => q.state)).toEqual(["decision"]);
  });
});

describeDb("settling a receipt gift's replay conflict", () => {
  const giftId = async () => (await row())!.id;

  it("keeps the first values and returns the gift to the queue", async () => {
    await ingestInKind(receipt(R1, 2500));
    await recordInKindDonor(orgId, R1, DONOR, 0);
    await ingestInKind(receipt(R1, 9900));
    await expect(inKindService.settle(orgId, await giftId(), "replay", AUDIT)).resolves.toMatchObject({ kind: "replay", settledAt: expect.any(Date) });
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, replayConflictAt: null });
    expect((await queue()).map((q) => q.state)).toEqual(["decision"]);
  });

  it("refuses to settle what is not open, or another org's gift", async () => {
    await ingestInKind(receipt(R1));
    await expect(inKindService.settle(orgId, await giftId(), "replay", AUDIT)).rejects.toMatchObject({ status: 409 });
    await expect(inKindService.settle("other-org", await giftId(), "replay", AUDIT)).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("in-kind audit", () => {
  it("records each step with no donor field in any payload", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 0);
    await withdrawInKind(orgId, R1, 1);
    await recordInKindDonor(orgId, R1, DONOR, 2);
    await ingestInKind(receipt(R1));
    const events = await db.workflowEvent.findMany({ where: { orgId, entityType: "in_kind" }, orderBy: { id: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["IN_KIND_DONOR_RECORDED", "IN_KIND_WITHDRAWN", "IN_KIND_DONOR_RECORDED", "IN_KIND_MONEY_RECEIVED"]);
    expect(JSON.stringify(events)).not.toMatch(/Jane|Doe|Acme/);
  });
});

describeDb("stale donor sends (in-kind findings K2–K4)", () => {
  const OLD_DONOR = { firstName: "Old", lastName: "Donor", companyName: null };

  it("an older donor call landing after a newer one changes nothing", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 1);
    await recordInKindDonor(orgId, R1, OLD_DONOR, 0);
    expect(await row()).toMatchObject({ donorFirstName: "Jane", donorReplacedAt: null });
  });

  it("an older donor call after a withdrawal with no money does not bring the row back", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 0);
    await withdrawInKind(orgId, R1, 1);
    await recordInKindDonor(orgId, R1, DONOR, 0);
    expect(await row()).toBeNull();
  });

  it("an older withdrawal landing after the money leaves the gift waiting on a decision", async () => {
    await recordInKindDonor(orgId, R1, DONOR, 3);
    await ingestInKind(receipt(R1));
    await withdrawInKind(orgId, R1, 2);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane" });
    expect((await queue()).map((q) => q.state)).toEqual(["decision"]);
  });
});

describeDb("gift outcomes for the receipt port", () => {
  const R2 = "22222222-2222-4222-8222-222222222222";
  const R3 = "33333333-3333-4333-8333-333333333333";

  it("reads finance's decision on each asked receipt's gift, and leaves out a receipt with no gift", async () => {
    await ingestInKind(receipt(R1));
    await ingestInKind(receipt(R2));
    await db.inKindDonation.update({ where: { orgId_receiptId: { orgId, receiptId: R2 } }, data: { decisionOutcome: "REFUSED" } });

    expect(await giftOutcomes([R1, R2, R3])).toEqual(new Map([[R1, "awaiting_decision"], [R2, "refused"]]));
    expect(await giftOutcomes([])).toEqual(new Map());
  });
});
