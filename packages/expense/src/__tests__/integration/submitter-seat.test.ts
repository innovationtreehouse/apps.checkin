/**
 * The reimbursement submitter's seat (#2432): recorded at intake from their confirmation of the
 * receipt, absent on a card charge, and given again through the receipt once finance clears it.
 */
import { it, expect } from "vitest";
import { fixture } from "@checkin/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { db } from "../../db";
import { receiveCompletedReceipt } from "../../services/intakeService";
import { signLine, signoffStatus } from "../../services/signoffService";
import { approveLine } from "../../services/approvalService";
import { auditConfirmationVoided, submitterConfirmations } from "../../services/submitterSeatService";

type Receipt = { receiptId: string; orgId: string; submitterId: number; needsReimbursement: boolean; lineItems: unknown[] };

const base = fixture<Receipt>("S2-expense-receipt/all-recognized-gtin");
const CONFIRMED_AT = "2026-06-01T11:00:00.000Z";
const confirmation = (personId: number) => ({ confirmedByPersonId: personId, confirmedAt: CONFIRMED_AT });
const reimbursement = (over: Record<string, unknown> = {}) => ({
  ...base,
  receiptId: `R-seat-${Math.random().toString(36).slice(2)}`,
  needsReimbursement: true,
  reimburseePersonId: base.submitterId,
  submitterConfirmation: confirmation(base.submitterId),
  ...over,
});
const submitterSeats = (expenseId: string) =>
  db.expenseLineSignoff.findMany({ where: { expenseId, seat: "SUBMITTER" }, orderBy: { lineItemId: "asc" } });

describeDb("the submitter seat at intake", () => {
  it("a confirmed reimbursement records the seat on every line, signed by the submitter and citing the confirmation", async () => {
    const r = reimbursement();
    await receiveCompletedReceipt(r);
    const seats = await submitterSeats(r.receiptId);
    expect(seats).toHaveLength(r.lineItems.length);
    expect(seats.every((s) => s.signerUserId === r.submitterId)).toBe(true);
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: r.receiptId, action: "signoff", valueAfter: "SUBMITTER" } });
    expect(audit).toHaveLength(r.lineItems.length);
    expect(audit[0]).toMatchObject({ userId: r.submitterId, notes: `confirmed the receipt as read at ${CONFIRMED_AT}` });
  });

  it("a reimbursement for someone else records the seat signed by the person reimbursed", async () => {
    const r = reimbursement({ reimburseePersonId: 12, submitterConfirmation: confirmation(12) });
    await receiveCompletedReceipt(r);
    expect((await submitterSeats(r.receiptId)).map((s) => s.signerUserId)).toEqual(r.lineItems.map(() => 12));
  });

  it("a Board member's confirmation on behalf of a reimbursee with no account signs the seat, naming both", async () => {
    const r = reimbursement({ reimburseePersonId: 12, submitterConfirmation: { ...confirmation(12), onBehalfByPersonId: 5, onBehalfReason: "no email address" } });
    await receiveCompletedReceipt(r);
    expect((await submitterSeats(r.receiptId)).map((s) => s.signerUserId)).toEqual(r.lineItems.map(() => 5));
    const audit = await db.expenseAuditLog.findFirst({ where: { expenseId: r.receiptId, action: "signoff", valueAfter: "SUBMITTER" } });
    expect(audit).toMatchObject({ userId: 5, notes: `confirmed the receipt as read on behalf of 12 at ${CONFIRMED_AT}: no email address` });
  });

  it("a reimbursement without the person reimbursed's confirmation records no seat", async () => {
    const unconfirmed = reimbursement({ submitterConfirmation: undefined });
    const byOther = reimbursement({ submitterConfirmation: confirmation(base.submitterId + 1) });
    await receiveCompletedReceipt(unconfirmed);
    await receiveCompletedReceipt(byOther);
    expect(await submitterSeats(unconfirmed.receiptId)).toEqual([]);
    expect(await submitterSeats(byOther.receiptId)).toEqual([]);
  });

  it("a card charge records no seat even when its uploader confirmed the receipt, and takes none", async () => {
    const card = reimbursement({ needsReimbursement: false, reimburseePersonId: undefined });
    await receiveCompletedReceipt(card);
    expect(await submitterSeats(card.receiptId)).toEqual([]);
    for (const line of await signoffStatus(card.receiptId)) expect(line.missing).not.toContain("SUBMITTER");
  });

  it("a backfill records no seat", async () => {
    const backfill = reimbursement({ backfill: true });
    await receiveCompletedReceipt(backfill);
    expect(await submitterSeats(backfill.receiptId)).toEqual([]);
  });
});

describeDb("the sign-off route", () => {
  it("refuses the submitter seat to everyone: it is signed only by confirming the receipt", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100 });
    for (const who of [principal(1), principal(2), principal(3, { isFinance: true }), principal(5, { isBoard: true })]) {
      await expect(signLine(who, li, "SUBMITTER")).rejects.toMatchObject({ status: 403, message: "Confirm the receipt to sign this seat" });
    }
    expect(await submitterSeats(id)).toEqual([]);
  });
});

describeDb("confirming again through the receipt", () => {
  async function openReimbursement() {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const lines = [await seedLineItem(id), await seedLineItem(id)];
    const approvals = [];
    for (const li of lines) approvals.push(await seedApproval(id, li, { ownerId: 100 }));
    return { id, lines, approvals };
  }

  it("a reimbursement's line is approved only after the submitter's confirmation", async () => {
    const { id, approvals } = await openReimbursement();
    await expect(approveLine(principal(2), id, approvals[0])).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not confirmed this reimbursement yet/) });
    expect((await db.lineItemOwnerApproval.findUniqueOrThrow({ where: { id: approvals[0] } })).status).toBe("pending");
    await submitterConfirmations.confirm(id, 1, { id: 1, name: "person-1" }, null);
    await approveLine(principal(2), id, approvals[0]);
    expect((await db.lineItemOwnerApproval.findUniqueOrThrow({ where: { id: approvals[0] } })).status).toBe("approved");
  });

  it("lists the reimbursements missing their seat, with the reimbursee and the fields of the latest void", async () => {
    const { id } = await openReimbursement();
    expect(await submitterConfirmations.awaiting()).toEqual([{ receiptId: id, reimburseePersonId: 1, changedFields: [] }]);
    await db.$transaction((tx) => auditConfirmationVoided(tx, { userId: 3, username: "finance" }, id, ["reimbursee"]));
    expect(await submitterConfirmations.awaiting()).toEqual([{ receiptId: id, reimburseePersonId: 1, changedFields: ["reimbursee"] }]);
  });

  it("the confirmation signs the seat on every line, and then nothing waits", async () => {
    const { id, lines } = await openReimbursement();
    expect(await submitterConfirmations.confirm(id, 1, { id: 1, name: "person-1" }, null)).toBe(true);
    expect((await submitterSeats(id)).map((s) => [s.lineItemId, s.signerUserId])).toEqual(lines.map((li) => [li, 1]));
    expect(await submitterConfirmations.awaiting()).toEqual([]);
    expect(await submitterConfirmations.confirm(id, 1, { id: 1, name: "person-1" }, null)).toBe(false);
  });

  it("a Board member confirms on the reimbursee's behalf, unless party to the expense", async () => {
    const { id, lines } = await openReimbursement();
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5, 6], households: [[1, 6]] }) });
    expect(await submitterConfirmations.confirm(id, 2, { id: 5, name: "person-5" }, "no account")).toBe(false);
    expect(await submitterConfirmations.confirm(id, 1, { id: 6, name: "person-6" }, "no account")).toBe(false);
    expect(await submitterConfirmations.confirm(id, 1, { id: 5, name: "person-5" }, "no account")).toBe(true);
    expect((await submitterSeats(id)).map((s) => [s.lineItemId, s.signerUserId])).toEqual(lines.map((li) => [li, 5]));
    const audit = await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "signoff", valueAfter: "SUBMITTER" } });
    expect(audit?.notes).toMatch(/on behalf of 1 at .*: no account$/);
  });

  it("only an open reimbursement, for its reimbursee", async () => {
    const { id } = await openReimbursement();
    expect(await submitterConfirmations.confirm(id, 1, { id: 2, name: "person-2" }, "no account")).toBe(false);
    const card = await seedExpense({ state: "owner_approval" });
    await seedLineItem(card);
    expect(await submitterConfirmations.confirm(card, 1, { id: 1, name: "person-1" }, null)).toBe(false);
    const closed = await seedExpense({ state: "qb_complete", needsReimbursement: true, reimburseePersonId: 1 });
    await seedLineItem(closed);
    expect(await submitterConfirmations.confirm(closed, 1, { id: 1, name: "person-1" }, null)).toBe(false);
    expect(await submitterSeats(id)).toEqual([]);
  });
});
