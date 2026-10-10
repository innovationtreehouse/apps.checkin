import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { orgSettingsService } from "../../services/orgSettingsService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, ocr: okOcr() });
});

describeDb("finance decisions on one's own receipt", () => {
  it("refuses clearing the duplicate flag on one's own receipt", async () => {
    actAs(FINANCE);
    const file = textFile();
    await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const dup = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect(dup.state).toBe("duplicate_flagged");
    await expect(receiptService.clearDuplicate(dup.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await stateOf(dup.id)).toBe("duplicate_flagged");
  });

  it("refuses restarting the flow of one's own receipt", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await db.receiptDetail.update({ where: { id: r.id }, data: { state: "flow_error" } });
    await expect(receiptService.restartFlow(r.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await stateOf(r.id)).toBe("flow_error");
  });

  it("still lets finance restart someone else's receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await db.receiptDetail.update({ where: { id: r.id }, data: { state: "flow_error" } });
    actAs(FINANCE);
    await receiptService.restartFlow(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
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

describeDb("the tax field", () => {
  it("a submitter cannot change it; finance can", async () => {
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    await expect(receiptService.edit(r.id, "submitter", { tax: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await receiptService.edit(r.id, "submitter", { tax: 0, retailer: "Fixed" });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { tax: 1 });
    expect((await db.receiptDetail.findUnique({ where: { id: r.id } }))?.taxCents).toBe(100);
  });
});
