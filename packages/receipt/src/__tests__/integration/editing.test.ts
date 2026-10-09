import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { orgSettingsService } from "../../services/orgSettingsService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { BOB, FINANCE, actAs, actions, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink });
});

/** A receipt whose total does not match its lines: validation_failed, so editable. */
const invalid = () => receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "25.00" }) });

describeDb("editing a receipt", () => {
  it("edits fields with one audit row per changed field, then resubmits to finalized", async () => {
    const r = await invalid();
    expect(r.state).toBe("validation_failed");
    await receiptService.edit(r.id, "submitter", { retailer: "Fixed Hardware", receiptTotal: 20 });
    const rows = await db.receiptAuditLog.findMany({ where: { receiptId: r.id, action: "field_edit" } });
    expect(rows.map((a) => [a.fieldChanged, a.valueAfter])).toEqual([
      ["retailer", "Fixed Hardware"],
      ["receiptTotalCents", "2000"],
    ]);
    await receiptService.resubmit(r.id, "submitter");
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("refuses edits outside validation_failed / submitter_review", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await expect(receiptService.edit(r.id, "submitter", { retailer: "x" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(receiptService.addLine(r.id, "submitter", { description: "x" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(receiptService.resubmit(r.id, "submitter")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("finance edits any receipt; another submitter cannot", async () => {
    const r = await invalid();
    actAs(BOB);
    await expect(receiptService.edit(r.id, "submitter", { retailer: "x" })).rejects.toMatchObject({ statusCode: 404 });
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { retailer: "By finance" });
    expect((await db.receiptDetail.findUniqueOrThrow({ where: { id: r.id } })).retailer).toBe("By finance");
  });

  it("adds, edits and deletes lines, keeping totals in cents", async () => {
    const r = await invalid();
    const added = await receiptService.addLine(r.id, "submitter", { description: "Washer", quantity: 1, unitPrice: 5 });
    expect(added).toMatchObject({ lineNumber: 2, unitPriceCents: 500, totalPriceCents: 500 });
    const edited = await receiptService.editLine(r.id, "submitter", added.id, { quantity: 1.5, unitPrice: 3.33 });
    expect(edited).toMatchObject({ quantity: 1.5, unitPriceCents: 333, totalPriceCents: 500 });
    await receiptService.deleteLine(r.id, "submitter", added.id);
    expect(await db.receiptLineItem.count({ where: { receiptId: r.id } })).toBe(1);
    expect(await actions(r.id)).toEqual(expect.arrayContaining(["line_added", "field_edit", "line_deleted"]));
  });

  it("a line of another receipt is not found", async () => {
    const a = await invalid();
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "26", retailer: "B" }) });
    const [bLine] = await db.receiptLineItem.findMany({ where: { receiptId: b.id } });
    await expect(receiptService.editLine(a.id, "submitter", bLine.id, { description: "x" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(receiptService.deleteLine(a.id, "submitter", bLine.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("discard is terminal", async () => {
    const r = await invalid();
    await receiptService.discard(r.id, "submitter");
    await expect(receiptService.discard(r.id, "submitter")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describeDb("org settings", () => {
  it("are created on first read with the source defaults, and update", async () => {
    actAs(FINANCE);
    expect(await orgSettingsService.get()).toMatchObject({ taxExempt: false, enforceReceiptAgeLimit: true, receiptAgeLimitDays: 90 });
    expect(await orgSettingsService.update({ receiptAgeLimitDays: 30 })).toMatchObject({ receiptAgeLimitDays: 30 });
    await expect(orgSettingsService.update({ bogus: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });
});
