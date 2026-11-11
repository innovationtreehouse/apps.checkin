/** A disbursement held by a fees-only row posts once finance releases the row, without that row's fee. */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { sendDisbursementEvent } from "../../workflows/disbursement.actor";
import { disbursementService } from "../../services/disbursementService";
import { configureTestRuntime, makeAccountMapRule, makeFile, makeTransaction, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const audit = { actorUserId: 7, actorUsername: "Finance", correlationId: "release-test" };
let fileId: number;

beforeEach(async () => {
  configureTestRuntime();
  await db.workflowEvent.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});
  fileId = (await makeFile(orgId)).id;
  await makeAccountMapRule(orgId);
});

describeDb("fees-only release", () => {
  it("posts the held batch without the released row's fee and records who released it", async () => {
    const disbursementId = "release-fees-only";
    const feeRow = await makeTransaction(orgId, fileId, { disbursementId, donationAmountCents: 0, causeSupportFeeCents: 250 });
    const gift = await makeTransaction(orgId, fileId, { disbursementId, donationAmountCents: 1000, merchantFeeCents: 30 });
    await sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true });
    const [hold] = await db.disbursementHold.findMany({ where: { orgId, disbursementId, status: "PENDING" } });
    expect(hold.reason).toBe("FEES_ONLY");

    await disbursementService.releaseFeesOnlyHold(orgId, disbursementId, hold.id, audit);

    const [event] = await db.disbursementEvent.findMany({ where: { orgId, disbursementId } });
    expect(JSON.parse(event.payload).items).toEqual([
      expect.objectContaining({ type: "donation", amountCents: 970, transactionId: gift.transactionId }),
    ]);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: feeRow.id } });
    expect(row).toMatchObject({ causeSupportFeeCents: 250, feeReleasedByUserId: 7, feeReleasedByName: "Finance" });
    expect(row.feeReleasedAt).toBeInstanceOf(Date);
    expect(await db.disbursementHold.findUniqueOrThrow({ where: { id: hold.id } })).toMatchObject({ status: "RELEASED" });
    const released = await db.workflowEvent.findMany({ where: { orgId, disbursementId, eventType: "HOLD_RELEASED" } });
    expect(released).toEqual([expect.objectContaining({ actorUserId: 7, actorUsername: "Finance" })]);
  });

  it("refuses a second release of the same hold", async () => {
    const disbursementId = "release-twice";
    await makeTransaction(orgId, fileId, { disbursementId, donationAmountCents: 0, checkFeeCents: 100 });
    await makeTransaction(orgId, fileId, { disbursementId, donationAmountCents: 500 });
    await sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true });
    const [hold] = await db.disbursementHold.findMany({ where: { orgId, disbursementId } });

    await disbursementService.releaseFeesOnlyHold(orgId, disbursementId, hold.id, audit);
    await expect(disbursementService.releaseFeesOnlyHold(orgId, disbursementId, hold.id, audit)).rejects.toMatchObject({ status: 409 });
  });
});
