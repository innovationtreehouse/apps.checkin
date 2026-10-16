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
    await expect(receiptService.clearDuplicate(dup.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await stateOf(dup.id)).toBe("duplicate_flagged");
  });

  it("refuses restarting the flow of one's own receipt", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await stuckBeforeDelivery(r.id);
    await expect(receiptService.restartFlow(r.id)).rejects.toMatchObject({ statusCode: 403 });
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
    await expect(receiptService.restartFlow(id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already sent to receiving/) });
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
      await expect(attempt()).rejects.toMatchObject({ statusCode: 409 });
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
  it("a submitter cannot change the tax; finance can", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    await expect(receiptService.edit(r.id, "submitter", { tax: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await receiptService.edit(r.id, "submitter", { tax: 0, retailer: "Fixed" });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { tax: 1 });
    expect((await db.receiptDetail.findUnique({ where: { id: r.id } }))?.taxCents).toBe(100);
  });

  it("a submitter cannot change the date; finance can", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await expect(receiptService.edit(r.id, "submitter", { receiptDate: "2020-01-01" })).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "decision_refused" } })).toMatchObject({
      userId: ALICE.id,
      valueAfter: "edit receiptDate",
    });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { receiptDate: "2020-01-01" });
    expect((await db.receiptDetail.findUnique({ where: { id: r.id } }))?.receiptDate).toBe("2020-01-01");
  });

  it("finance on its own receipt edits as its submitter: tax and date are refused, other fields save", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await expect(receiptService.edit(r.id, "finance", { tax: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.edit(r.id, "finance", { receiptDate: "2020-01-01" })).rejects.toMatchObject({ statusCode: 403 });
    await receiptService.edit(r.id, "finance", { retailer: "Typo fixed" });
    const line = await db.receiptLineItem.findFirstOrThrow({ where: { receiptId: r.id } });
    await receiptService.editLine(r.id, "finance", line.id, { description: "Washer" });
    expect(await db.receiptDetail.findUnique({ where: { id: r.id } })).toMatchObject({ retailer: "Typo fixed", taxCents: 0 });
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
    await expect(receiptService.approveFinancial(r.id, "family")).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.rejectFinancial(r.id, "family")).rejects.toMatchObject({ statusCode: 403 });
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
    await expect(receiptService.clearDuplicate(dup.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await refusals(dup.id)).toEqual([[HOUSEMATE.id, "clear duplicate"]]);
    actAs(FINANCE);
    await receiptService.clearDuplicate(dup.id);
    expect(await stateOf(dup.id)).not.toBe("duplicate_flagged");
  });

  it("refuses restarting the flow; an independent finance user restarts it", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await stuckBeforeDelivery(r.id);
    actAs(HOUSEMATE);
    await expect(receiptService.restartFlow(r.id)).rejects.toMatchObject({ statusCode: 403 });
    actAs(FINANCE);
    await receiptService.restartFlow(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("refuses every finance edit, line change and discard; an independent finance user makes them", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    const line = await db.receiptLineItem.findFirstOrThrow({ where: { receiptId: r.id } });
    actAs(HOUSEMATE);
    await expect(receiptService.edit(r.id, "finance", { tax: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.edit(r.id, "finance", { retailer: "x" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.addLine(r.id, "finance", { description: "Nut", quantity: 1, unitPrice: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.editLine(r.id, "finance", line.id, { unitPrice: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.deleteLine(r.id, "finance", line.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(receiptService.discard(r.id, "finance")).rejects.toMatchObject({ statusCode: 403 });
    expect((await refusals(r.id)).map(([, action]) => action)).toEqual(["edit", "edit", "add line", "edit line", "delete line", "discard"]);
    expect(await stateOf(r.id)).toBe("submitter_review");

    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { tax: 1, receiptDate: "2020-01-01" });
    await receiptService.editLine(r.id, "finance", line.id, { description: "Washer" });
    await receiptService.discard(r.id, "finance");
    expect(await stateOf(r.id)).toBe("discarded");
  });
});
