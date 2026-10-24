import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { orgSettingsService } from "../../services/orgSettingsService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import type { ReceiptPrincipal } from "../../contract";
import { ALICE, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, ocr: okOcr() });
});

/** A receipt that hit a flow error before workflow-mapping received it: the restart case. */
async function stuckBeforeDelivery(id: string) {
  await db.receiptDetail.update({ where: { id }, data: { state: "flow_error" } });
  await db.receipt.update({ where: { id }, data: { pushedAt: null } });
}

describeDb("finance decisions on one's own receipt", () => {
  it("refuses clearing the duplicate flag on one's own receipt", async () => {
    actAs(FINANCE);
    const file = textFile();
    await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const dup = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect(dup.state).toBe("duplicate_flagged");
    await expect(receiptService.clearDuplicate(dup.id)).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(dup.id)).toBe("duplicate_flagged");
  });

  it("refuses restarting the flow of one's own receipt", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await stuckBeforeDelivery(r.id);
    await expect(receiptService.restartFlow(r.id)).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(r.id)).toBe("flow_error");
  });

  it("still lets finance restart someone else's receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await stuckBeforeDelivery(r.id);
    actAs(FINANCE);
    await receiptService.restartFlow(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });
});

describeDb("a receipt already sent to receiving", () => {
  async function pushedThenReopened(state: string) {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(ports.calls.pushes).toHaveLength(1);
    await db.receiptDetail.update({ where: { id: r.id }, data: { state } });
    return r.id;
  }

  it("refuses a restart, so no changed copy is re-sent", async () => {
    const id = await pushedThenReopened("flow_error");
    actAs(FINANCE);
    await expect(receiptService.restartFlow(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already sent to receiving/) });
    expect(await stateOf(id)).toBe("flow_error");
    expect(ports.calls.pushes).toHaveLength(1);
  });

  it("refuses edits to the receipt and its lines", async () => {
    const id = await pushedThenReopened("validation_failed");
    const [line] = await db.receiptLineItem.findMany({ where: { receiptId: id } });
    for (const attempt of [
      () => receiptService.edit(id, "submitter", { retailer: "Changed" }),
      () => receiptService.addLine(id, "submitter", { description: "Extra", quantity: 1, unitPrice: 1 }),
      () => receiptService.editLine(id, "submitter", line.id, { description: "Changed" }),
      () => receiptService.deleteLine(id, "submitter", line.id),
      () => receiptService.resubmit(id, "submitter"),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ status: 409 });
    }
    expect((await db.receiptDetail.findUniqueOrThrow({ where: { id } })).retailer).not.toBe("Changed");
    expect(ports.calls.pushes).toHaveLength(1);
  });

  it("still lets finance re-send it, which the receiver answers as a replay", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    expect(await receiptService.push(r.id)).toEqual({ pushed: true });
    expect(ports.calls.pushes.map((p) => p.receiptId)).toEqual([r.id, r.id]);
  });
});

describeDb("settings changes", () => {
  it("records who changed each setting, with the value before and after", async () => {
    actAs(FINANCE);
    await orgSettingsService.update({ taxExempt: true, receiptAgeLimitDays: 30 });
    await orgSettingsService.update({ taxExempt: true });
    const rows = await db.receiptAuditLog.findMany({ where: { receiptId: null }, orderBy: { id: "asc" } });
    expect(rows).toEqual([
      expect.objectContaining({ action: "settings_updated", userId: FINANCE.id, fieldChanged: "taxExempt", valueBefore: "false", valueAfter: "true" }),
      expect.objectContaining({ action: "settings_updated", userId: FINANCE.id, fieldChanged: "receiptAgeLimitDays", valueBefore: "90", valueAfter: "30" }),
    ]);
    expect(await orgSettingsService.get()).toMatchObject({ orgId: TEST_ORG_ID, taxExempt: true, receiptAgeLimitDays: 30 });
  });

  it("concurrent first reads of an org's settings all get the one default row", async () => {
    actAs(FINANCE);
    const all = await Promise.all(Array.from({ length: 8 }, () => orgSettingsService.get()));
    expect(all.every((s) => s.orgId === TEST_ORG_ID && s.receiptAgeLimitDays === 90)).toBe(true);
    expect(await db.receiptOrgSettings.count()).toBe(1);
  });
});

describeDb("OCR output is a proposal", () => {
  it("an auto upload stops for its uploader to confirm before it finalizes", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    expect(ports.calls.pushes).toHaveLength(0);
    await receiptService.submitterConfirm(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
    expect(ports.calls.pushes).toHaveLength(1);
  });

  it("a manual upload still finalizes without the stop", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(r.state).toBe("receipt_finalized");
  });
});

describeDb("the tax and date fields", () => {
  const audited = async (id: string, field: string) =>
    db.receiptAuditLog.findFirst({ where: { receiptId: id, action: "field_edit", fieldChanged: field } });

  it("a submitter can correct the tax, audited before and after; finance can too", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    await receiptService.edit(r.id, "submitter", { tax: 1 });
    expect(await audited(r.id, "taxCents")).toMatchObject({ userId: ALICE.id, valueBefore: "0", valueAfter: "100" });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { tax: 2 });
    expect((await db.receiptDetail.findUnique({ where: { id: r.id } }))?.taxCents).toBe(200);
  });

  it("a submitter can correct the date, audited before and after; finance can too", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await receiptService.edit(r.id, "submitter", { receiptDate: "2020-01-01" });
    expect(await audited(r.id, "receiptDate")).toMatchObject({ userId: ALICE.id, valueBefore: r.receiptDate, valueAfter: "2020-01-01" });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { receiptDate: "2020-01-02" });
    expect((await db.receiptDetail.findUnique({ where: { id: r.id } }))?.receiptDate).toBe("2020-01-02");
  });

  it("a submitter's correction of a misread tax sends the receipt to financial_review", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ tax: "1.00" }) });
    expect(r.state).toBe("validation_failed");
    await receiptService.edit(r.id, "submitter", { tax: 0 });
    await receiptService.resubmit(r.id, "submitter");
    expect(await stateOf(r.id)).toBe("financial_review");
    expect(ports.calls.pushes).toHaveLength(0);
    actAs(FINANCE);
    expect((await receiptService.get(r.id, "finance")).financialReviewReasons).toEqual(["submitter_correction"]);
    await receiptService.approveFinancial(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("zeroing the tax on a tax-exempt org keeps the tax reason", async () => {
    actAs(FINANCE);
    await orgSettingsService.update({ taxExempt: true });
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ tax: "5.00" }) });
    expect(r.state).toBe("validation_failed");
    await receiptService.edit(r.id, "submitter", { tax: 0 });
    await receiptService.resubmit(r.id, "submitter");
    expect(await stateOf(r.id)).toBe("financial_review");
    actAs(FINANCE);
    expect((await receiptService.get(r.id, "finance")).financialReviewReasons).toEqual(["tax", "submitter_correction"]);
    await receiptService.approveFinancial(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("a finance correction alone does not send the receipt to financial_review", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ tax: "1.00" }) });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { tax: 0 });
    await receiptService.resubmit(r.id, "finance");
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("finance on its own receipt edits as its submitter: a tax or date correction goes to another finance user", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await receiptService.edit(r.id, "finance", { receiptDate: "2020-01-01", retailer: "Typo fixed" });
    await receiptService.submitterConfirm(r.id);
    expect(await stateOf(r.id)).toBe("financial_review");
    await expect(receiptService.approveFinancial(r.id)).rejects.toMatchObject({ status: 403 });
  });
});

const HOUSEMATE: ReceiptPrincipal = { ...FINANCE, id: 950, name: "housemate" };

describeDb("finance decisions on a receipt one's household is party to", () => {
  beforeEach(() => {
    configure({
      receiptSink: ports.receiptSink,
      donorSink: ports.donorSink,
      ocr: okOcr(),
      households: { householdOf: async (ids) => (ids.includes(ALICE.id) ? [ALICE.id, HOUSEMATE.id] : []) },
    });
  });

  const refusals = async (id: string) =>
    (await db.receiptAuditLog.findMany({ where: { receiptId: id, action: "decision_refused" }, orderBy: { id: "asc" } })).map((a) => [
      a.userId,
      a.valueAfter,
    ]);

  it("refuses approve and reject; an independent finance user approves", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    expect(r.state).toBe("financial_review");
    actAs(HOUSEMATE);
    await expect(receiptService.approveFinancial(r.id)).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.rejectFinancial(r.id, "family")).rejects.toMatchObject({ status: 403 });
    expect(await refusals(r.id)).toEqual([[HOUSEMATE.id, "approve"], [HOUSEMATE.id, "reject"]]);
    actAs(FINANCE);
    await receiptService.approveFinancial(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("refuses clearing the duplicate flag; an independent finance user clears it", async () => {
    const file = textFile();
    await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const dup = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    actAs(HOUSEMATE);
    await expect(receiptService.clearDuplicate(dup.id)).rejects.toMatchObject({ status: 403 });
    expect(await refusals(dup.id)).toEqual([[HOUSEMATE.id, "clear duplicate"]]);
    actAs(FINANCE);
    await receiptService.clearDuplicate(dup.id);
    expect(await stateOf(dup.id)).not.toBe("duplicate_flagged");
  });

  it("refuses restarting the flow; an independent finance user restarts it", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await stuckBeforeDelivery(r.id);
    actAs(HOUSEMATE);
    await expect(receiptService.restartFlow(r.id)).rejects.toMatchObject({ status: 403 });
    actAs(FINANCE);
    await receiptService.restartFlow(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("refuses every finance edit, line change and discard; an independent finance user makes them", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    const line = await db.receiptLineItem.findFirstOrThrow({ where: { receiptId: r.id } });
    actAs(HOUSEMATE);
    await expect(receiptService.edit(r.id, "finance", { tax: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.edit(r.id, "finance", { retailer: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.addLine(r.id, "finance", { description: "Nut", quantity: 1, unitPrice: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.editLine(r.id, "finance", line.id, { unitPrice: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.deleteLine(r.id, "finance", line.id)).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.discard(r.id, "finance")).rejects.toMatchObject({ status: 403 });
    expect((await refusals(r.id)).map(([, action]) => action)).toEqual(["edit", "edit", "add line", "edit line", "delete line", "discard"]);
    expect(await stateOf(r.id)).toBe("submitter_review");

    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { tax: 1, receiptDate: "2020-01-01" });
    await receiptService.editLine(r.id, "finance", line.id, { description: "Washer" });
    await receiptService.discard(r.id, "finance");
    expect(await stateOf(r.id)).toBe("discarded");
  });
});
