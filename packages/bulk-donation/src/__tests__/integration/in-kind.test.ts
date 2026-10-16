/**
 * In-kind donations with a receipt (FR5): the money side (X9) and the donor (X13) join on
 * receiptId in either order; money first waits as "donor needed" and clears when the donor
 * arrives; a withdrawal after money is an anomaly, never a delete.
 */
import { it, expect, beforeEach } from "vitest";
import type { CompletedReceipt } from "@inventory/receipt-types";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { ingestInKind, recordInKindDonor, recordReceiptDonorReads, withdrawInKind } from "../../inKind";
import { inKindService } from "../../services/inKindService";
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
const queue = () => inKindService.listQueue(orgId);

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.inKindDonation.deleteMany({});
  configureTestRuntime();
});

describeDb("in-kind join on receiptId", () => {
  it("money first waits as donor needed, then clears when the donor arrives", async () => {
    await ingestInKind(receipt(R1));
    expect((await queue()).map((q) => q.receiptId)).toEqual([R1]);

    await recordInKindDonor(orgId, R1, DONOR);
    expect(await queue()).toEqual([]);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane", donorCompanyName: "Acme" });
  });

  it("donor first shows nothing until the money arrives, then is ready", async () => {
    await recordInKindDonor(orgId, R1, DONOR);
    expect(await queue()).toEqual([]);
    await ingestInKind(receipt(R1));
    expect(await queue()).toEqual([]);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorLastName: "Doe" });
  });

  it("is idempotent: a replayed money side keeps its first arrival; a later donor replaces", async () => {
    await ingestInKind(receipt(R1));
    const first = (await row())!.moneyReceivedAt;
    await ingestInKind(receipt(R1));
    expect((await row())!.moneyReceivedAt).toEqual(first);

    await recordInKindDonor(orgId, R1, DONOR);
    await recordInKindDonor(orgId, R1, { firstName: "John", lastName: "Roe", companyName: null });
    expect(await row()).toMatchObject({ donorFirstName: "John", donorLastName: "Roe", donorCompanyName: null });
    expect(await db.inKindDonation.count()).toBe(1);
  });

  it("concurrent halves for one receipt land on one row", async () => {
    await Promise.all([ingestInKind(receipt(R1)), recordInKindDonor(orgId, R1, DONOR)]);
    expect(await db.inKindDonation.count()).toBe(1);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane" });
  });
});

describeDb("withdrawInKind", () => {
  it("is a no-op for an unknown receipt", async () => {
    await withdrawInKind(orgId, R1);
    expect(await db.inKindDonation.count()).toBe(0);
  });

  it("deletes a waiting donor", async () => {
    await recordInKindDonor(orgId, R1, DONOR);
    await withdrawInKind(orgId, R1);
    await withdrawInKind(orgId, R1);
    expect(await row()).toBeNull();
  });

  it("after money, deletes nothing and raises an anomaly", async () => {
    await ingestInKind(receipt(R1));
    await recordInKindDonor(orgId, R1, DONOR);
    await withdrawInKind(orgId, R1);
    expect(await row()).toMatchObject({ receiptTotalCents: 2500, donorFirstName: "Jane" });
    expect((await queue()).map((q) => q.withdrawnAfterMoneyAt)).toEqual([expect.any(Date)]);
  });
});

describeDb("in-kind audit", () => {
  it("records each step with no donor field in any payload", async () => {
    await recordInKindDonor(orgId, R1, DONOR);
    await ingestInKind(receipt(R1));
    await withdrawInKind(orgId, R1);
    const events = await db.workflowEvent.findMany({ where: { orgId, entityType: "in_kind" }, orderBy: { id: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["IN_KIND_DONOR_RECORDED", "IN_KIND_MONEY_RECEIVED", "IN_KIND_WITHDRAWN_AFTER_MONEY"]);
    expect(JSON.stringify(events)).not.toMatch(/Jane|Doe|Acme/);
  });
});

describeDb("receipt donor reads", () => {
  const R2 = "22222222-2222-4222-8222-222222222222";
  const R3 = "33333333-3333-4333-8333-333333333333";
  const reader = { actorUserId: 7, actorUsername: "finance", route: "GET /api/receipts" };
  const reads = () => db.workflowEvent.findMany({ where: { orgId, eventType: "DONOR_DATA_READ" }, orderBy: { id: "asc" } });

  it("writes one row per receipt shown, naming the reader and route", async () => {
    await recordReceiptDonorReads(reader, [R1, R2, R3]);
    const events = await reads();
    expect(events.map((e) => e.entityId)).toEqual([R1, R2, R3]);
    for (const e of events) {
      expect(e).toMatchObject({ entityType: "in_kind", actorUserId: 7, actorUsername: "finance" });
      expect(JSON.parse(e.payload ?? "{}")).toEqual({ route: "GET /api/receipts" });
    }
  });

  it("writes nothing for an empty read", async () => {
    await recordReceiptDonorReads(reader, []);
    expect(await reads()).toEqual([]);
  });
});
