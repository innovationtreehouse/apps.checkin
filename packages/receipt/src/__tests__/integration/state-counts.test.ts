/** The flow status page's receipt counts: raw org-wide totals per state. */
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptStateCounts } from "../../services/stateCounts";
import { describeDb } from "../helpers/db";
import { ALICE, TEST_ORG_ID, clearAll, configure } from "../helpers/setup";

const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000099";

async function makeReceipt(state: string, opts: { orgId?: string; pushed?: boolean } = {}): Promise<void> {
  const orgId = opts.orgId ?? TEST_ORG_ID;
  await db.receipt.create({
    data: {
      id: randomUUID(),
      orgId,
      uploadedByUserId: ALICE.id,
      fileBlob: Buffer.from("receipt"),
      fileHash: randomUUID(),
      mimeType: "text/plain",
      pushedAt: opts.pushed ? new Date() : null,
      details: { create: { orgId, state } },
    },
  });
}

const countOf = (states: { state: string; count: number }[], state: string) => states.find((s) => s.state === state)?.count;

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("receiptStateCounts", () => {
  it("is zero in every state for an org with no receipts", async () => {
    const { states, notDelivered } = await receiptStateCounts();
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s.count === 0)).toBe(true);
    expect(notDelivered).toBe(0);
  });

  it("counts this org's receipts per state, and finalized ones not yet delivered", async () => {
    await makeReceipt("financial_review");
    await makeReceipt("financial_review");
    await makeReceipt("receipt_finalized", { pushed: true });
    await makeReceipt("receipt_finalized");
    await makeReceipt("rejected");
    await makeReceipt("financial_review", { orgId: OTHER_ORG_ID });
    await makeReceipt("receipt_finalized", { orgId: OTHER_ORG_ID });

    const { states, notDelivered } = await receiptStateCounts();
    expect(countOf(states, "financial_review")).toBe(2);
    expect(countOf(states, "receipt_finalized")).toBe(2);
    expect(countOf(states, "rejected")).toBe(1);
    expect(countOf(states, "uploaded")).toBe(0);
    expect(notDelivered).toBe(1);
  });
});
