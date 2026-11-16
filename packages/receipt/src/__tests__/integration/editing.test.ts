import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { orgSettingsService } from "../../services/orgSettingsService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { BOB, FINANCE, actAs, actions, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

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

  it("sends a receipt with no lines back to validation_failed even when its total balances", async () => {
    const r = await invalid();
    for (const line of await db.receiptLineItem.findMany({ where: { receiptId: r.id } })) {
      await receiptService.deleteLine(r.id, "submitter", line.id);
    }
    await receiptService.edit(r.id, "submitter", { receiptTotal: 0 });
    await receiptService.resubmit(r.id, "submitter");
    const detail = await db.receiptDetail.findUniqueOrThrow({ where: { id: r.id } });
    expect(detail.state).toBe("validation_failed");
    expect(detail.validationNotes).toContain("no line items");
  });

  it("refuses edits outside validation_failed / submitter_review", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    // Not yet delivered, so the state rule answers rather than the received-receipt lock.
    await db.receipt.update({ where: { id: r.id }, data: { pushedAt: null } });
    await expect(receiptService.edit(r.id, "submitter", { retailer: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(receiptService.addLine(r.id, "submitter", { description: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(receiptService.resubmit(r.id, "submitter")).rejects.toMatchObject({ status: 400 });
  });

  it("finance edits any receipt; another submitter cannot", async () => {
    const r = await invalid();
    actAs(BOB);
    await expect(receiptService.edit(r.id, "submitter", { retailer: "x" })).rejects.toMatchObject({ status: 404 });
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

  describe("a line whose printed total is not quantity × unit price", () => {
    // Printed as 3 × $3.33 = $10.00 on a $10.00 receipt.
    const printedLine = async () => {
      const r = await invalid();
      const [line] = await db.receiptLineItem.findMany({ where: { receiptId: r.id } });
      await db.receiptLineItem.update({ where: { id: line.id }, data: { quantity: 3, unitPriceCents: 333, totalPriceCents: 1000 } });
      await db.receiptDetail.update({ where: { id: r.id }, data: { shippingCents: 0, taxCents: 0, discountCents: 0, receiptTotalCents: 1000 } });
      return { r, line };
    };
    const totalEdits = (id: string) => db.receiptAuditLog.findMany({ where: { receiptId: id, action: "field_edit", fieldChanged: "totalPrice" } });
    const linesBalance = async (id: string) => {
      const d = await db.receiptDetail.findUniqueOrThrow({ where: { id } });
      const lines = await db.receiptLineItem.findMany({ where: { receiptId: id } });
      const sum = lines.reduce((a, l) => a + l.totalPriceCents, 0);
      return sum + (d.shippingCents ?? 0) + (d.taxCents ?? 0) - (d.discountCents ?? 0) === d.receiptTotalCents;
    };

    it("keeps its printed total when only the description changes", async () => {
      const { r, line } = await printedLine();
      const edited = await receiptService.editLine(r.id, "submitter", line.id, { description: "Hinge, brass" });
      expect(edited).toMatchObject({ description: "Hinge, brass", totalPriceCents: 1000 });
      expect(await totalEdits(r.id)).toEqual([]);
      expect(await linesBalance(r.id)).toBe(true);
    });

    it("keeps its printed total when saved unchanged", async () => {
      const { r, line } = await printedLine();
      const edited = await receiptService.editLine(r.id, "submitter", line.id, { quantity: 3, unitPrice: 3.33, description: line.description });
      expect(edited.totalPriceCents).toBe(1000);
      expect(await totalEdits(r.id)).toEqual([]);
      expect(await linesBalance(r.id)).toBe(true);
    });

    it("takes quantity × unit price when the quantity changes, and records the total's change", async () => {
      const { r, line } = await printedLine();
      const edited = await receiptService.editLine(r.id, "submitter", line.id, { quantity: 4 });
      expect(edited).toMatchObject({ quantity: 4, unitPriceCents: 333, totalPriceCents: 1332 });
      expect((await totalEdits(r.id)).map((a) => [a.valueBefore, a.valueAfter, a.lineItemId])).toEqual([["10", "13.32", line.id]]);
    });
  });

  describe("printed and calculated line totals", () => {
    // 3 × $3.33 printed as $10.00 is 3 × $3.333…, with the unit price rounded on the receipt.
    const hinges = (quantity: number, unitPrice: number, totalPrice?: number) => ({ description: "Hinge", quantity, unitPrice, totalPrice, isDelayed: false });
    const scan = async (receiptTotal: number, lineItems: ReturnType<typeof hinges>[]) => {
      configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr({ receiptTotal, lineItems }) });
      return receiptService.upload(textFile(), "text/plain", {});
    };
    const totalEdits = (id: string) =>
      db.receiptAuditLog.findMany({ where: { receiptId: id, action: "field_edit", fieldChanged: "totalPrice" }, orderBy: { id: "asc" } });
    const storedTotals = async (id: string) =>
      (await db.receiptLineItem.findMany({ where: { receiptId: id }, orderBy: { lineNumber: "asc" } })).map((l) => l.totalPriceCents);

    it("stores a printed line total as printed, with nothing to spread", async () => {
      const r = await scan(10, [hinges(3, 3.33, 10)]);
      expect(r.state).toBe("submitter_review");
      expect(await storedTotals(r.id)).toEqual([1000]);
      expect(await totalEdits(r.id)).toEqual([]);
    });

    it("keeps a printed line total no rounding explains, and sends the receipt to Totals off naming the line", async () => {
      // Printed 3 × $3.30 = $10.00: 3 × $3.30 is $9.90, so a figure was misread or misprinted.
      const r = await scan(10, [hinges(3, 3.3, 10)]);
      expect(r.state).toBe("validation_failed");
      expect(await storedTotals(r.id)).toEqual([1000]);
      expect(await totalEdits(r.id)).toEqual([]);
      const detail = await db.receiptDetail.findUniqueOrThrow({ where: { id: r.id } });
      expect(detail.validationNotes).toBe("A line's total does not add up. Line 1: total $10.00 is not 3 × $3.30 ($9.90).");
    });

    it("calculates a line total the receipt does not print, and sends a receipt it leaves a cent off to Totals off", async () => {
      // The receipt prints 3 @ $3.33 with no line total, and a $10.00 total.
      const r = await scan(10, [hinges(3, 3.33)]);
      expect(r.state).toBe("validation_failed");
      expect(await storedTotals(r.id)).toEqual([999]);
      expect(await totalEdits(r.id)).toEqual([]);
      const detail = await db.receiptDetail.findUniqueOrThrow({ where: { id: r.id } });
      expect(detail.validationNotes).toBe("Line items total does not match the receipt total.");
    });

    it("passes once a person types the line's total, recorded as their edit", async () => {
      const r = await scan(10, [hinges(3, 3.33)]);
      const [line] = await db.receiptLineItem.findMany({ where: { receiptId: r.id } });
      const edited = await receiptService.editLine(r.id, "submitter", line.id, { totalPrice: 10 });
      expect(edited).toMatchObject({ quantity: 3, unitPriceCents: 333, totalPriceCents: 1000 });
      expect((await totalEdits(r.id)).map((a) => [a.valueBefore, a.valueAfter, a.userId])).toEqual([["9.99", "10", expect.any(Number)]]);
      await receiptService.resubmit(r.id, "submitter");
      expect(await stateOf(r.id)).not.toBe("validation_failed");
      expect(await storedTotals(r.id)).toEqual([1000]);
    });

    it("stores a typed total on an added line as typed", async () => {
      const r = await invalid();
      const added = await receiptService.addLine(r.id, "submitter", { description: "Hinge", quantity: 3, unitPrice: 3.33, totalPrice: 10 });
      expect(added).toMatchObject({ unitPriceCents: 333, totalPriceCents: 1000 });
    });
  });

  it("a line of another receipt is not found", async () => {
    const a = await invalid();
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "26", retailer: "B" }) });
    const [bLine] = await db.receiptLineItem.findMany({ where: { receiptId: b.id } });
    await expect(receiptService.editLine(a.id, "submitter", bLine.id, { description: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(receiptService.deleteLine(a.id, "submitter", bLine.id)).rejects.toMatchObject({ status: 404 });
  });

  it("discard is terminal", async () => {
    const r = await invalid();
    await receiptService.discard(r.id, "submitter");
    await expect(receiptService.discard(r.id, "submitter")).rejects.toMatchObject({ status: 400 });
  });
});

describeDb("org settings", () => {
  it("are created on first read with the source defaults, and update", async () => {
    actAs(FINANCE);
    expect(await orgSettingsService.get()).toMatchObject({ taxExempt: false, enforceReceiptAgeLimit: true, receiptAgeLimitDays: 90 });
    expect(await orgSettingsService.update({ receiptAgeLimitDays: 30 })).toMatchObject({ receiptAgeLimitDays: 30 });
    await expect(orgSettingsService.update({ bogus: 1 })).rejects.toMatchObject({ status: 400 });
  });
});
