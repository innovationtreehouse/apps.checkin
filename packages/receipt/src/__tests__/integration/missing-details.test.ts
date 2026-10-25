import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  actAs(ALICE);
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
});

describeDb("a receipt missing its retailer, date or total", () => {
  it("goes from an OCR reading to its submitter, naming what is missing, with a missing total kept blank", async () => {
    configure({ receiptSink: ports.receiptSink, ocr: okOcr({ retailer: "", receiptTotal: null }) });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    expect(r.receiptTotalCents).toBeNull();
    expect(r.validationNotes).toBe("This receipt is missing its retailer and total. Fill them in, then confirm.");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "pipeline_transition" } });
    expect(row?.valueAfter).toBe("submitter_review (missing retailer, total)");
  });

  it("goes to its submitter when OCR reads a date that is not a real date", async () => {
    configure({ receiptSink: ports.receiptSink, ocr: okOcr({ receiptDate: "April" }) });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    expect(r.validationNotes).toBe("This receipt is missing its date. Fill it in, then confirm.");
  });

  it("cannot be confirmed until the submitter fills the details in, then moves on", async () => {
    configure({ receiptSink: ports.receiptSink, ocr: okOcr({ retailer: "", receiptTotal: null }) });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await expect(receiptService.submitterConfirm(r.id)).rejects.toMatchObject({
      status: 400,
      message: "Fill in the retailer and total before confirming this receipt",
    });
    expect(await stateOf(r.id)).toBe("submitter_review");

    await receiptService.edit(r.id, "submitter", { retailer: "OCR Hardware", receiptTotal: 5 });
    const after = await receiptService.submitterConfirm(r.id);
    expect(after.state).toBe("receipt_finalized");
    expect(after.validationNotes).toBeNull();
  });

  it("goes to its submitter on a restart from flow_error rather than staying stuck", async () => {
    // Totals off, so the receipt is never finalized or sent downstream, which would lock it.
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "1" }) });
    expect(r.state).toBe("validation_failed");
    await db.receiptDetail.update({ where: { id: r.id }, data: { state: "flow_error", receiptDate: "" } });
    actAs(FINANCE);
    await receiptService.restartFlow(r.id);
    expect(await stateOf(r.id)).toBe("submitter_review");
    actAs(ALICE);
    expect((await receiptService.get(r.id, "submitter")).validationNotes).toBe("This receipt is missing its date. Fill it in, then confirm.");
  });

  it("refuses typed details with a blank retailer, on upload and on edit", async () => {
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "   " }) })).rejects.toMatchObject({
      status: 400,
      message: "details.retailer: The retailer is required",
    });
    configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await expect(receiptService.edit(r.id, "submitter", { receiptDate: " " })).rejects.toMatchObject({ status: 400 });
  });
});
