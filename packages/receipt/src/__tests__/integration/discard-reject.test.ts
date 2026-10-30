import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

const OPEN_STATES = [
  "uploaded", "auto_upload", "ocr_failed", "duplicate_flagged",
  "validation_failed", "submitter_review", "financial_review", "flow_error",
] as const;

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink });
  actAs(ALICE);
});

/** ALICE's receipt, never pushed, moved straight to `state`. */
async function aliceReceiptIn(state: string): Promise<string> {
  actAs(ALICE);
  const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "25.00" }) });
  await db.receiptDetail.update({ where: { id: r.id }, data: { state } });
  return r.id;
}

describeDb("who discards and who rejects", () => {
  it.each(OPEN_STATES)("the uploader discards their own receipt from %s", async (state) => {
    const id = await aliceReceiptIn(state);
    await receiptService.discard(id, "submitter");
    expect(await stateOf(id)).toBe("discarded");
  });

  it("a finance user discards a receipt they uploaded themselves", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "25.00" }) });
    await receiptService.discard(r.id, "finance");
    expect(await stateOf(r.id)).toBe("discarded");
  });

  it("refuses finance discarding someone else's receipt, and audits the refusal", async () => {
    const id = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await expect(receiptService.discard(id, "finance")).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(id)).toBe("financial_review");
    const refused = await db.receiptAuditLog.findFirst({ where: { receiptId: id, action: "decision_refused" } });
    expect(refused).toMatchObject({ userId: FINANCE.id, valueAfter: "discard" });
  });

  it("does not find someone else's receipt for a submitter-access discard, as the Board's runs", async () => {
    const id = await aliceReceiptIn("submitter_review");
    actAs(BOB);
    await expect(receiptService.discard(id, "submitter")).rejects.toMatchObject({ status: 404 });
    expect(await stateOf(id)).toBe("submitter_review");
  });

  it.each(OPEN_STATES)("finance rejects a receipt from %s with its reason", async (state) => {
    const id = await aliceReceiptIn(state);
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, " not a club purchase ");
    expect(await stateOf(id)).toBe("rejected");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: id, action: "reject_financial" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: "not a club purchase" });
  });

  it("refuses a reject with no reason", async () => {
    const id = await aliceReceiptIn("submitter_review");
    actAs(FINANCE);
    await expect(receiptService.rejectFinancial(id, "")).rejects.toMatchObject({ status: 400 });
    expect(await stateOf(id)).toBe("submitter_review");
  });

  it.each(["receipt_finalized", "discarded", "rejected"])("refuses a reject from %s", async (state) => {
    const id = await aliceReceiptIn(state);
    actAs(FINANCE);
    await expect(receiptService.rejectFinancial(id, "late")).rejects.toMatchObject({ status: 400 });
    expect(await stateOf(id)).toBe(state);
  });
});
