/**
 * Monetary-correctness edge cases for the disbursement payload.
 *
 * Exercises runAccountDetermination (via the actor) for amounts that the
 * happy-path tests don't touch: large values, high-precision decimals,
 * negative amounts (refunds / clawbacks), fees summed and netted into the
 * gift, a row with only fees, and the all-zero transaction.
 */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { sendDisbursementEvent } from "../../workflows/disbursement.actor";
import { makeFile, makeTransaction, makeAccountMapRule, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
let fileId: number;

type Item = { type: string; account: string; amountCents: number; transactionId: string };

async function processAndRead(disbursementId: string): Promise<Item[]> {
  await sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true });
  const [event] = await db.disbursementEvent.findMany({
    where: { orgId, disbursementId },
  });
  return event ? (JSON.parse(event.payload).items as Item[]) : [];
}

beforeEach(async () => {
  await db.disbursementEvent.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});
  fileId = (await makeFile(orgId)).id;
  await makeAccountMapRule(orgId); // Acme Corp / check / standard
});

describeDb("large amounts", () => {
  it("preserves a large donation amount without loss", async () => {
    const disbursementId = "money-large";
    // $1,000,000.50 and $250,000.25 in cents.
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, donationAmountCents: 100_000_050, matchAmountCents: 25_000_025 });

    const items = await processAndRead(disbursementId);
    expect(items.find((i) => i.type === "donation")!.amountCents).toBe(100_000_050);
    expect(items.find((i) => i.type === "match")!.amountCents).toBe(25_000_025);
  });
});

describeDb("two-decimal amounts", () => {
  it("keeps a $123.45 donation intact as 12345 cents", async () => {
    const disbursementId = "money-precise";
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, donationAmountCents: 12345 });

    const items = await processAndRead(disbursementId);
    expect(items.find((i) => i.type === "donation")!.amountCents).toBe(12345);
  });
});

describeDb("negative amounts (refund / clawback)", () => {
  it("emits negative donation and match line items rather than dropping them", async () => {
    const disbursementId = "money-negative";
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, donationAmountCents: -10000, matchAmountCents: -4000 });

    const items = await processAndRead(disbursementId);
    expect(items.find((i) => i.type === "donation")!.amountCents).toBe(-10000);
    expect(items.find((i) => i.type === "match")!.amountCents).toBe(-4000);
  });
});

describeDb("fees net into the gift (exact integer cents)", () => {
  it("sums the three fee components and nets them into the donation, with no fee item", async () => {
    const disbursementId = "money-fees-int";
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1, donationAmountCents: 10000,
      causeSupportFeeCents: 500, merchantFeeCents: 300, checkFeeCents: 200,
    });

    const items = await processAndRead(disbursementId);
    expect(items.map((i) => [i.type, i.amountCents])).toEqual([["donation", 9000]]);
  });

  it("nets sub-dollar fees exactly with no float artifacts (100 - (10 + 10 + 10) = 70)", async () => {
    const disbursementId = "money-fees-three-frac";
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1,
      causeSupportFeeCents: 10, merchantFeeCents: 10, checkFeeCents: 10,
    });

    const items = await processAndRead(disbursementId);
    expect(items.map((i) => [i.type, i.amountCents])).toEqual([["donation", 70]]);
  });

  it("splits a row's fee across its donation and match by amount", async () => {
    const disbursementId = "money-fees-split";
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1, donationAmountCents: 500, matchAmountCents: 9500, causeSupportFeeCents: 250,
    });

    const items = await processAndRead(disbursementId);
    expect(items.map((i) => [i.type, i.amountCents])).toEqual([["donation", 488], ["match", 9262]]);
  });

  it("holds a row with fees and no amount, and finishes nothing", async () => {
    const disbursementId = "money-fees-only";
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1, donationAmountCents: 0, matchAmountCents: 0, causeSupportFeeCents: 250,
    });

    expect(await processAndRead(disbursementId)).toEqual([]);
    const holds = await db.disbursementHold.findMany({ where: { orgId, disbursementId } });
    expect(holds.map((h) => h.reason)).toEqual(["FEES_ONLY"]);
  });
});

describeDb("all-zero transaction", () => {
  it("emits no line items when donation, match, and fees are all zero", async () => {
    const disbursementId = "money-zero";
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1,
      donationAmountCents: 0, matchAmountCents: 0, causeSupportFeeCents: 0, merchantFeeCents: 0, checkFeeCents: 0,
    });

    const items = await processAndRead(disbursementId);
    expect(items).toHaveLength(0);
  });
});
