import { beforeEach, describe, expect, it } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import {
  ALICE,
  BOB,
  FINANCE,
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
    // Bob is an adult; MINOR is not. Membership is never asked: a non-member adult is named like any adult.
    const people = new Map([
      [BOB.id, { id: BOB.id, name: "Bob Baker", isAdult: true }],
      [MINOR.id, { id: MINOR.id, name: "Kit Kid", isAdult: false }],
    ]);
    const reimbursees = {
      search: async () => [],
      byId: async (id: number) => people.get(id) ?? null,
      hasAccount: async () => true,
      addNonMemberAdult: async (name: string) => {
        added.push(name);
        return { id: 555, name };
      },
    };
    let added: string[] = [];
    beforeEach(() => {
      added = [];
      configure({ receiptSink: ports.receiptSink, reimbursees });
    });

    it("stores their Person id and name, records the uploader as who named them, and pushes them to expense", async () => {
      const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: BOB.id });
      expect(r).toMatchObject({ uploadedByUserId: ALICE.id, reimburseePersonId: BOB.id, reimbursementFor: "Bob Baker" });
      expect(await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "reimbursee_named" } })).toMatchObject({
        userId: ALICE.id,
        valueAfter: String(BOB.id),
      });

      actAs(BOB);
      await receiptService.confirmAsReimbursee(r.id);
      const payload = CompletedReceiptSchema.parse(ports.calls.pushes.at(-1));
      expect(payload).toMatchObject({ submitterId: ALICE.id, needsReimbursement: true, reimburseePersonId: BOB.id, reimbursementFor: "Bob Baker" });
      expect(payload.submitterConfirmation).toMatchObject({ confirmedByPersonId: BOB.id });
    });

    it("refuses a reimbursee who is not a live person, and stores nothing", async () => {
      await expect(
        receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: 4242 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await db.receipt.count()).toBe(0);
    });

    it("refuses a minor as reimbursee, by name, and stores nothing", async () => {
      await expect(
        receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId: MINOR.id }),
      ).rejects.toMatchObject({ status: 400, message: "Kit Kid cannot be reimbursed: only an adult can be" });
      expect(await db.receipt.count()).toBe(0);
    });

    it("refuses a reimbursee without a reimbursement", async () => {
      await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails(), reimburseePersonId: BOB.id })).rejects.toMatchObject({ status: 400 });
    });

    it("finance, operations or the board adds a non-member by name, who becomes the reimbursee", async () => {
      actAs({ ...ALICE, addsPeople: true });
      const r = await receiptService.upload(textFile(), "text/plain", {
        details: manualDetails(),
        needsReimbursement: true,
        newReimbursee: { name: " Dana Field ", isAdult: true },
      });
      expect(added).toEqual(["Dana Field"]);
      expect(r).toMatchObject({ uploadedByUserId: ALICE.id, reimburseePersonId: 555, reimbursementFor: "Dana Field" });
      expect(await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "reimbursee_named" } })).toMatchObject({ valueAfter: "555" });
    });

    it("refuses to add a non-member for an uploader without finance, operations or the board, and adds nobody", async () => {
      await expect(
        receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, newReimbursee: { name: "Dana Field", isAdult: true } }),
      ).rejects.toMatchObject({ status: 403 });
      expect(added).toEqual([]);
      expect(await db.receipt.count()).toBe(0);
    });

    it("refuses a new person not declared an adult, or alongside a picked person", async () => {
      actAs({ ...ALICE, addsPeople: true });
      const upload = (extra: Record<string, unknown>) =>
        receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, ...extra });
      await expect(upload({ newReimbursee: { name: "Dana Field" } })).rejects.toMatchObject({ status: 400 });
      await expect(upload({ newReimbursee: { name: "Dana Field", isAdult: true }, reimburseePersonId: BOB.id })).rejects.toMatchObject({ status: 400 });
      expect(added).toEqual([]);
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

describeDb("typing the details of a receipt OCR could not read", () => {
  const unread = () => receiptService.upload(textFile(), "text/plain", {});
  const type = async (id: string, access: "submitter" | "finance", total = 5) => {
    await receiptService.edit(id, access, { retailer: "Typed Hardware", receiptDate: new Date().toISOString().slice(0, 10), receiptTotal: total });
    await receiptService.addLine(id, access, { description: "Bolt", quantity: 1, unitPrice: 5 });
  };

  it("moves on through the pipeline, with the OCR failure note gone and each edit audited", async () => {
    const r = await unread();
    await type(r.id, "submitter");
    const after = await receiptService.resubmit(r.id, "submitter");
    expect(after.state).toBe("submitter_review");
    expect(after.validationNotes).toBeNull();
    expect(await actions(r.id)).toEqual(expect.arrayContaining(["field_edit", "line_added", "resubmitted"]));
    // The date was blank, so entering it goes to finance review once the uploader confirms.
    expect((await receiptService.submitterConfirm(r.id)).state).toBe("financial_review");
  });

  it("holds lines that do not add up, as a manual upload does", async () => {
    const r = await unread();
    await type(r.id, "submitter", 9);
    expect((await receiptService.resubmit(r.id, "submitter")).state).toBe("validation_failed");
  });

  it("flags a typed receipt matching another one as a duplicate", async () => {
    const date = new Date().toISOString().slice(0, 10);
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Typed Hardware", receiptDate: date }) });
    const r = await unread();
    await receiptService.edit(r.id, "submitter", { retailer: "Typed Hardware", receiptDate: date, receiptTotal: 20 });
    await receiptService.addLine(r.id, "submitter", { description: "Bolt", quantity: 1, unitPrice: 20 });
    expect((await receiptService.resubmit(r.id, "submitter")).state).toBe("duplicate_flagged");
  });

  it("sends blank details back to the uploader by name", async () => {
    const r = await unread();
    const after = await receiptService.resubmit(r.id, "submitter");
    expect(after.state).toBe("submitter_review");
    expect(after.validationNotes).toBe("This receipt is missing its retailer, date and total. Fill them in, then confirm.");
  });

  it("lets finance type the details, and the uploader still confirms", async () => {
    const r = await unread();
    actAs(FINANCE);
    await type(r.id, "finance");
    expect((await receiptService.resubmit(r.id, "finance")).state).toBe("submitter_review");
  });

  it("tells finance nothing about typed details a reading replaced, and keeps their audit rows", async () => {
    const r = await unread();
    await receiptService.edit(r.id, "submitter", { receiptDate: "2020-01-01", tax: 3 });
    configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
    await receiptService.retryOcr(r.id, "submitter");
    expect((await receiptService.submitterConfirm(r.id)).state).toBe("receipt_finalized");
    const kept = await db.receiptAuditLog.findMany({ where: { receiptId: r.id, action: "field_edit" } });
    expect(kept.map((e) => e.fieldChanged).sort()).toEqual(["receiptDate", "taxCents"]);
  });

  it("still reports a correction made after the reading, and only that one", async () => {
    const r = await unread();
    await receiptService.edit(r.id, "submitter", { receiptDate: "2020-01-01" });
    configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
    await receiptService.retryOcr(r.id, "submitter");
    await receiptService.edit(r.id, "submitter", { tax: 1, receiptTotal: 6 });
    expect((await receiptService.submitterConfirm(r.id)).state).toBe("financial_review");
    const log = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, valueAfter: { startsWith: "financial_review" } } });
    expect(log?.valueAfter).toContain("the submitter changed the tax from $0.00 to $1.00");
    expect(log?.valueAfter).not.toContain("the date");
  });

  it("keeps typed details and their corrections when the reading fails again", async () => {
    const r = await unread();
    await receiptService.edit(r.id, "submitter", { receiptDate: "2020-01-01" });
    const again = await receiptService.retryOcr(r.id, "submitter");
    expect(again).toMatchObject({ state: "ocr_failed", receiptDate: "2020-01-01" });
    await receiptService.edit(r.id, "submitter", { retailer: "Typed Hardware", receiptTotal: 5 });
    await receiptService.addLine(r.id, "submitter", { description: "Bolt", quantity: 1, unitPrice: 5 });
    await receiptService.resubmit(r.id, "submitter");
    expect((await receiptService.submitterConfirm(r.id)).state).toBe("financial_review");
  });

  it("does not let another submitter type the details", async () => {
    const r = await unread();
    actAs(BOB);
    await expect(receiptService.edit(r.id, "submitter", { retailer: "x" })).rejects.toMatchObject({ status: 404 });
  });
});
