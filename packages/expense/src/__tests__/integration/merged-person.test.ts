/**
 * After merging A into B the rows still store A. B counts as A on every conflict and seat check,
 * B reaches A's expense, an unrelated caller gains nothing, and a party naming nobody blocks everyone.
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { OutcomeMail } from "../../contract";
import { db } from "../../db";
import { expenses } from "../../routes";
import { oweOutcomeNotice, sendOutcomeNotices } from "../../lib/outcome-notices";
import { isConflicted } from "../../lib/signoff-facts";
import { approveLine } from "../../services/approvalService";
import { approveTax } from "../../services/taxApprovalService";
import { linkReimburseeVendor, reimburseeVendorFor, reimburseeVendorId } from "../../services/reimburseeVendorService";
import { signLine, signoffStatus } from "../../services/signoffService";
import { submitterConfirmations } from "../../services/submitterSeatService";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, ORG, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";

const A = 1;
const B = 2;
const HOUSEMATE = 3;
const UNRELATED = 4;
const APPROVER = 6;
const FINANCE = 7;
const BOARD = 8;
const GONE = 99;
const BUCKET = 100;

const people = directory({
  merged: { [A]: B },
  unknownPeople: [GONE],
  households: [[B, HOUSEMATE]],
  approvers: { [BUCKET]: [B, HOUSEMATE, APPROVER] },
  finance: [B, HOUSEMATE, FINANCE],
  board: [B, BOARD],
});

let lineItemId: number;
let approvalId: number;

async function seed(over: { submitterId?: number; reimburseePersonId?: number; needsReimbursement?: boolean; state?: string } = {}): Promise<string> {
  const expenseId = await seedExpense({ state: "owner_approval", submitterId: A, ...over });
  lineItemId = await seedLineItem(expenseId);
  approvalId = await seedApproval(expenseId, lineItemId, { ownerId: BUCKET, status: "pending" });
  return expenseId;
}

function sign(expenseId: string, caller: number) {
  const req = new Request("http://test", { method: "POST", body: JSON.stringify({ seat: "TREASURER" }) });
  return expenses.sign({ req, params: { id: expenseId, lineItemId: String(lineItemId) }, principal: principal(caller) });
}

const signIsHidden = async (expenseId: string, caller: number) =>
  sign(expenseId, caller).then(
    () => false,
    (err: { status?: number }) => err.status === 404,
  );

beforeEach(() => bindPorts({ signoff: people, outcomeMail: { send: async () => true }, quickbooks: { vendors: { open: async () => ({ search: async () => [], byId: async (id: string) => ({ id, displayName: "V" }), findOrCreate: async () => { throw new Error("unused"); } }) } } }));

describeDb("after merging A into B", () => {
  it("B and B's household are conflicted on A's expense; an unrelated caller is not", async () => {
    const stored = { submitterId: A, reimburseePersonId: null };
    expect(await isConflicted(stored, B)).toBe(true);
    expect(await isConflicted(stored, HOUSEMATE)).toBe(true);
    expect(await isConflicted(stored, UNRELATED)).toBe(false);
    expect(await isConflicted({ submitterId: UNRELATED, reimburseePersonId: A }, B)).toBe(true);
  });

  it("B cannot approve or sign A's expense, nor can B's housemate", async () => {
    const id = await seed();
    for (const caller of [B, HOUSEMATE]) {
      await expect(approveLine(principal(caller), id, approvalId)).rejects.toMatchObject({ status: 403 });
    }
    await db.lineItemOwnerApproval.update({ where: { id: approvalId }, data: { status: "approved", decidedByUserId: APPROVER } });
    for (const caller of [B, HOUSEMATE]) {
      await expect(signLine(principal(caller, { isFinance: true }), lineItemId, "TREASURER")).rejects.toMatchObject({ status: 403 });
    }
    await expect(signLine(principal(FINANCE, { isFinance: true }), lineItemId, "TREASURER")).resolves.toBeUndefined();
  });

  it("B cannot approve the tax on A's expense", async () => {
    const id = await seed();
    await db.expense.update({ where: { id }, data: { taxCents: 1240 } });
    await expect(approveTax(principal(B, { isFinance: true }), id, null)).rejects.toMatchObject({ status: 403 });
  });

  it("B reaches A's line on the sign route; an unrelated caller gets the same 404 as for no line", async () => {
    const id = await seed();
    expect(await signIsHidden(id, B)).toBe(false);
    expect(await signIsHidden(id, UNRELATED)).toBe(true);
  });

  it("a seat A signed counts as B's, so B signs no other step", async () => {
    const id = await seed({ submitterId: UNRELATED, state: "qb_pending" });
    await db.lineItemOwnerApproval.update({ where: { id: approvalId }, data: { status: "approved", decidedByUserId: A } });
    await expect(signLine(principal(B, { isFinance: true }), lineItemId, "TREASURER")).rejects.toThrow("whoever approved the line");
    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId, seat: "TREASURER", signerUserId: A, signerUsername: "a" } });
    expect((await signoffStatus(id))[0].filled).toEqual([{ seat: "TREASURER", signerUserId: B }]);
  });

  it("B confirms the reimbursement A was owed, by the id the expense stores, as themself", async () => {
    const id = await seed({ submitterId: UNRELATED, reimburseePersonId: A, needsReimbursement: true });
    expect((await submitterConfirmations.awaiting()).map((a) => a.reimburseePersonId)).toEqual([A]);
    expect(await submitterConfirmations.confirmable([id], UNRELATED)).toEqual([]);
    await expect(submitterConfirmations.confirm(id, A, { id: B, name: "b" }, null)).resolves.toBe(true);
    const audit = await db.expenseAuditLog.findFirstOrThrow({ where: { expenseId: id, action: "signoff" } });
    expect(audit.notes).not.toContain("on behalf");
  });

  it("the API names B, while the stored row still names A", async () => {
    const id = await seed({ reimburseePersonId: A, needsReimbursement: true });
    const { Expense } = await expenses.detail({ req: new Request("http://test"), params: { id }, principal: principal(FINANCE, { isFinance: true }) });
    expect(Expense).toMatchObject({ submitterId: B, reimburseePersonId: B });
    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ submitterId: A, reimburseePersonId: A });
  });

  it("a Vendor linked to A is B's, and B gets no second one", async () => {
    const id = await seed({ submitterId: UNRELATED, reimburseePersonId: A, needsReimbursement: true });
    await db.expenseReimburseeVendor.create({ data: { orgId: ORG, reimburseePersonId: A, qbVendorId: "55" } });
    expect(await reimburseeVendorId(B)).toBe("55");
    expect(await reimburseeVendorFor(ORG, id)).toMatchObject({ link: { qbVendorId: "55" }, reimbursee: { personId: B } });
    await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "56" }, principal(FINANCE, { isFinance: true }))).rejects.toMatchObject({ status: 409 });
  });

  it("when A and B each had a Vendor, B's own wins", async () => {
    await db.expenseReimburseeVendor.createMany({ data: [{ orgId: ORG, reimburseePersonId: A, qbVendorId: "55" }, { orgId: ORG, reimburseePersonId: B, qbVendorId: "66" }] });
    expect(await reimburseeVendorId(A)).toBe("66");
  });

  it("a new link goes on B and re-arms the expense parked under A", async () => {
    const id = await seed({ submitterId: UNRELATED, reimburseePersonId: A, needsReimbursement: true });
    await db.expense.update({ where: { id }, data: { qbMatchState: "AMBIGUOUS" } });
    const row = await linkReimburseeVendor(ORG, id, { qbVendorId: "57" }, principal(FINANCE, { isFinance: true }));
    expect(row.reimburseePersonId).toBe(B);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).qbMatchState).toBe("UNMATCHED");
  });
});

describeDb("a merged uploader and reimbursee", () => {
  it("get one outcome email, to the survivor", async () => {
    const send = vi.fn<OutcomeMail["send"]>().mockResolvedValue(true);
    bindPorts({ signoff: people, outcomeMail: { send } });
    const id = await seed({ reimburseePersonId: B, needsReimbursement: true, state: "qb_complete" });
    await db.$transaction((tx) => oweOutcomeNotice(tx, id, "qb_complete"));
    await sendOutcomeNotices([id]);
    expect(send.mock.calls.map(([notice, to]) => [notice.uploaderPersonId, to])).toEqual([[B, "uploader"]]);
  });
});

describeDb("a party naming nobody live", () => {
  it("is a conflict for everyone", async () => {
    expect(await isConflicted({ submitterId: GONE, reimburseePersonId: null }, UNRELATED)).toBe(true);
    expect(await isConflicted({ submitterId: UNRELATED, reimburseePersonId: GONE }, FINANCE)).toBe(true);
  });

  it("nobody approves or signs, the Board included, and the seats show as held", async () => {
    const id = await seed({ submitterId: GONE });
    await expect(approveLine(principal(APPROVER), id, approvalId)).rejects.toMatchObject({ status: 403 });
    await expect(approveLine(principal(BOARD, { isBoard: true }), id, approvalId, "stand in")).rejects.toMatchObject({ status: 403 });
    await db.lineItemOwnerApproval.update({ where: { id: approvalId }, data: { status: "approved", decidedByUserId: APPROVER } });
    await expect(signLine(principal(FINANCE, { isFinance: true }), lineItemId, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await expect(signLine(principal(BOARD, { isBoard: true }), lineItemId, "TREASURER")).rejects.toMatchObject({ status: 403 });
    expect((await signoffStatus(id))[0].blocked).toContain("TREASURER");
  });

  it("a live reimbursee cannot confirm when the submitter names nobody", async () => {
    const id = await seed({ submitterId: GONE, reimburseePersonId: UNRELATED, needsReimbursement: true });
    await expect(submitterConfirmations.confirm(id, UNRELATED, { id: UNRELATED, name: "u" }, null)).rejects.toMatchObject({ status: 403 });
  });

  it("a party that names nobody keeps its stored id on the API", async () => {
    const id = await seed({ submitterId: GONE });
    const { Expense } = await expenses.detail({ req: new Request("http://test"), params: { id }, principal: principal(FINANCE, { isFinance: true }) });
    expect(Expense).toMatchObject({ submitterId: GONE });
  });
});
