import { beforeEach, expect, it } from "vitest";
import { CompletedReceiptSchema } from "@inventory/receipt-types";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import {
  ALICE,
  MINOR,
  actAs,
  actions,
  clearAll,
  configure,
  manualDetails,
  okOcr,
  recordingPorts,
  stateOf,
  textFile,
} from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
});

describeDb("manual upload", () => {
  it("finalizes, pushes S1 once and stamps pushedAt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(r.state).toBe("receipt_finalized");
    expect(r.pushedAt).not.toBeNull();
    expect(ports.calls.pushes).toHaveLength(1);
    const payload = CompletedReceiptSchema.parse(ports.calls.pushes[0]);
    expect(payload).toMatchObject({ receiptId: r.id, submitterId: ALICE.id, receiptTotalCents: 2000, isInKind: false, backfill: false });
  });

  it("records a failed push instead of dropping it: pushedAt stays null, audited", async () => {
    ports.fail.push = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(r.state).toBe("receipt_finalized");
    expect(r.pushedAt).toBeNull();
    expect(await actions(r.id)).toContain("push_failed");
  });

  it("with no sink bound, the inert port leaves the receipt unpushed", async () => {
    configure();
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(r.state).toBe("receipt_finalized");
    expect(r.pushedAt).toBeNull();
  });

  it("'I paid for this myself' makes the uploader the reimbursee, from the principal", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    expect(r.state).toBe("submitter_review");
    expect(r.reimburseePersonId).toBe(ALICE.id);
    expect(r.reimbursementFor).toBe(ALICE.name);
  });

  it("rejects a caller-supplied reimbursee", async () => {
    await expect(
      receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: 5 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses reimbursement for a non-adult uploader", async () => {
    actAs(MINOR);
    await expect(
      receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.receipt.count()).toBe(0);
  });

  it("an id-less session is unauthenticated", async () => {
    actAs({ ...ALICE, id: undefined as unknown as number });
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails() })).rejects.toMatchObject({
      statusCode: 401,
    });
    actAs(null);
    await expect(receiptService.listMine()).rejects.toMatchObject({ statusCode: 401 });
  });
});

describeDb("upload limits", () => {
  it("rejects more than 200 lines", async () => {
    const lineItems = Array.from({ length: 201 }, () => ({ description: "x", quantity: 1, unitPrice: 0 }));
    await expect(
      receiptService.upload(textFile(), "text/plain", { details: manualDetails({ lineItems, receiptTotal: "0" }) }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a file whose bytes do not match its declared type", async () => {
    await expect(receiptService.upload(textFile(), "application/pdf", { details: manualDetails() })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects text holding a NUL byte", async () => {
    await expect(
      receiptService.upload(Buffer.from("a\u0000b"), "text/plain", { details: manualDetails() }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describeDb("auto upload (OCR at intake)", () => {
  it("reads the file in the request, then finalizes once the uploader confirms", async () => {
    configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.retailer).toBe("OCR Hardware");
    expect(r.state).toBe("submitter_review");
    await receiptService.submitterConfirm(r.id);
    expect(await actions(r.id)).toEqual(expect.arrayContaining(["uploaded", "ocr_complete", "finalized", "pushed"]));
  });

  it("lands in ocr_failed with the reason when OCR is not configured", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("ocr_failed");
    expect(r.validationNotes).toMatch(/not configured/);
  });

  it("OCR output never sets reimbursement, reimbursee or vendor", async () => {
    configure({ receiptSink: ports.receiptSink, ocr: okOcr({ needsReimbursement: true, reimbursementFor: "Mallory" }) });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.needsReimbursement).toBe(false);
    expect(r.reimbursementFor).toBeNull();
    expect(r.reimburseePersonId).toBeNull();
  });

  it("retry after a failure reads again and stops for the uploader to confirm", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {});
    configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
    await receiptService.retryOcr(r.id, "submitter");
    expect(await stateOf(r.id)).toBe("submitter_review");
  });
});
