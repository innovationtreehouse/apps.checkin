import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { orgSettingsService } from "../../services/orgSettingsService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

const taxed = () => manualDetails({ tax: "1.00", receiptTotal: "21.00" });

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink, donorSink: recordingPorts().donorSink });
  actAs(FINANCE);
  await orgSettingsService.update({ taxExempt: true });
  actAs(ALICE);
});

describeDb("financial review", () => {
  it("tax on a tax-exempt org goes to financial_review with reason 'tax'", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    expect(r.state).toBe("financial_review");
    actAs(FINANCE);
    expect((await receiptService.get(r.id, "finance")).financialReviewReasons).toEqual(["tax"]);
  });

  it("approving a tax exception requires a note, stored on the audit row", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    actAs(FINANCE);
    await expect(receiptService.approveFinancial(r.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(receiptService.approveFinancial(r.id, "   ")).rejects.toMatchObject({ statusCode: 400 });
    await receiptService.approveFinancial(r.id, "Vendor would not honor the exemption certificate");
    expect(await stateOf(r.id)).toBe("receipt_finalized");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "financial_approved" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: "Vendor would not honor the exemption certificate" });
  });

  it("a non-tax exception (future date) approves without a note", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    expect(r.state).toBe("financial_review");
    actAs(FINANCE);
    await receiptService.approveFinancial(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("refuses a finance user deciding their own receipt", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    await expect(receiptService.approveFinancial(r.id, "mine")).rejects.toMatchObject({ statusCode: 409 });
    await expect(receiptService.rejectFinancial(r.id, "mine")).rejects.toMatchObject({ statusCode: 409 });
    expect(await stateOf(r.id)).toBe("financial_review");
  });

  it("reject records the reason", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    actAs(FINANCE);
    await receiptService.rejectFinancial(r.id, "personal purchase");
    expect(await stateOf(r.id)).toBe("rejected");
  });

  it("the tax check does not apply to an in-kind receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed(), isInKind: true, donor: { self: true } });
    expect(r.state).toBe("receipt_finalized");
  });

  it("the age limit still applies to an in-kind receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {
      details: manualDetails({ receiptDate: "2020-01-01" }),
      isInKind: true,
      donor: { self: true },
    });
    expect(r.state).toBe("financial_review");
  });
});
