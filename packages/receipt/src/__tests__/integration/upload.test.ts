import { beforeEach, describe, expect, it } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import {
  ALICE,
  BOB,
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

  it("a reimbursement with no reimbursee named makes the uploader the reimbursee, from the principal", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    expect(r.state).toBe("submitter_review");
    expect(r.reimburseePersonId).toBe(ALICE.id);
    expect(r.reimbursementFor).toBe(ALICE.name);
    expect(await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "reimbursee_named" } })).toMatchObject({
      userId: ALICE.id,
      valueAfter: String(ALICE.id),
    });
  });

  describe("naming someone else as reimbursee", () => {
    const reimbursees = {
      search: async () => [],
      byId: async (id: number) => (id === BOB.id ? { id: BOB.id, name: "Bob Baker" } : null),
    };
    beforeEach(() => configure({ receiptSink: ports.receiptSink, reimbursees }));

    it("stores their Person id and name, records the uploader as who named them, and pushes them to expense", async () => {
      const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: BOB.id });
      expect(r).toMatchObject({ uploadedByUserId: ALICE.id, reimburseePersonId: BOB.id, reimbursementFor: "Bob Baker" });
      expect(await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "reimbursee_named" } })).toMatchObject({
        userId: ALICE.id,
        valueAfter: String(BOB.id),
      });

      await receiptService.submitterConfirm(r.id);
      const payload = CompletedReceiptSchema.parse(ports.calls.pushes.at(-1));
      expect(payload).toMatchObject({ submitterId: ALICE.id, needsReimbursement: true, reimburseePersonId: BOB.id, reimbursementFor: "Bob Baker" });
    });

    it("refuses a reimbursee who is not a live person, and stores nothing", async () => {
      await expect(
        receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: 4242 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await db.receipt.count()).toBe(0);
    });

    it("refuses a reimbursee without a reimbursement", async () => {
      await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails(), reimburseePersonId: BOB.id })).rejects.toMatchObject({ status: 400 });
    });

    it("searches by at least two characters", async () => {
      const searched: string[] = [];
      configure({ reimbursees: { ...reimbursees, search: async (q) => (searched.push(q), [{ id: BOB.id, name: "Bob Baker" }]) } });
      expect(await receiptService.reimburseeOptions(" b ")).toEqual([]);
      expect(await receiptService.reimburseeOptions(" bo ")).toEqual([{ id: BOB.id, name: "Bob Baker" }]);
      expect(searched).toEqual(["bo"]);
    });
  });

  it("stores the typed currency, discount, part #, manufacturer and backordered flag", async () => {
    const details = manualDetails({
      currency: "CAD",
      receiptTotal: "18.00",
      discount: "2.00",
      lineItems: [{ description: "Bolt", partNumber: "B-100", manufacturer: "Fastenal", quantity: 2, unitPrice: 10, isDelayed: true }],
    });
    const r = await receiptService.upload(textFile(), "text/plain", { details });
    expect(r.state).toBe("receipt_finalized");
    const detail = await db.receiptDetail.findUnique({ where: { id: r.id } });
    expect(detail).toMatchObject({ currency: "CAD", discountCents: 200, receiptTotalCents: 1800 });
    const lines = await db.receiptLineItem.findMany({ where: { receiptId: r.id } });
    expect(lines).toEqual([expect.objectContaining({ partNumber: "B-100", manufacturer: "Fastenal", isDelayed: true })]);
  });

  it("rejects a caller-supplied reimbursee", async () => {
    await expect(
      receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: 5 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses reimbursement for a non-adult uploader", async () => {
    actAs(MINOR);
    await expect(
      receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.receipt.count()).toBe(0);
  });

  it("an id-less session is unauthenticated", async () => {
    actAs({ ...ALICE, id: undefined as unknown as number });
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails() })).rejects.toMatchObject({
      status: 401,
    });
    actAs(null);
    await expect(receiptService.listMine()).rejects.toMatchObject({ status: 401 });
  });
});

describeDb("upload limits", () => {
  it("rejects more than 200 lines", async () => {
    const lineItems = Array.from({ length: 201 }, () => ({ description: "x", quantity: 1, unitPrice: 0 }));
    await expect(
      receiptService.upload(textFile(), "text/plain", { details: manualDetails({ lineItems, receiptTotal: "0" }) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a file whose bytes do not match its declared type", async () => {
    await expect(receiptService.upload(textFile(), "application/pdf", { details: manualDetails() })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects text holding a NUL byte", async () => {
    await expect(
      receiptService.upload(Buffer.from("a\u0000b"), "text/plain", { details: manualDetails() }),
    ).rejects.toMatchObject({ status: 400 });
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
