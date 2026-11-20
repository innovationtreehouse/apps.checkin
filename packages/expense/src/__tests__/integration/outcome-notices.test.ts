/**
 * Outcome emails: the notice each final transition owes, the send right after commit, the daily
 * sweep of notices never tried, and a person's Retry of a stuck one, against the real database.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedAccountMapping, seedApproval, seedExpense, seedLineItem, seedSubmitterSeat, signAllLines, ORG } from "../helpers/seed";
import type { OutcomeMail } from "../../contract";
import { raiseException, rejectException, approveLine } from "../../services/approvalService";
import { advanceWorkflow, advanceWorkflowInTx } from "../../lib/workflow-engine";
import { oweOutcomeNotice, retryOutcomeNotice, SEND_FAILED_AGAIN, sweepOutcomeNotices } from "../../lib/outcome-notices";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { SYSTEM_ACTOR } from "../../lib/system-actor";

const LEADER = principal(2);
const FINANCE = principal(3, { isFinance: true });
const UPLOADER = 1;
const REIMBURSEE = 8;

const send = vi.fn<OutcomeMail["send"]>();
const notices = (expenseId: string) => db.expenseOutcomeNotice.findMany({ where: { expenseId } });
const sentTo = () => send.mock.calls.map(([n, to]) => [n.receiptId, n.outcome, to]);

beforeEach(() => {
  send.mockReset().mockResolvedValue(true);
  bindPorts({ outcomeMail: { send }, signoff: directory({ approvers: { 100: [2] } }) });
});

async function reimbursementInApproval() {
  const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: REIMBURSEE, submitterId: UPLOADER });
  await db.expense.update({ where: { id }, data: { receiptDate: "2026-10-02" } });
  const li = await seedLineItem(id, { gtin13: "0000000000017" });
  return { id, li, approvalId: await seedApproval(id, li, { ownerId: 100 }) };
}

async function inQbPending(opts: { needsReimbursement: boolean; backfill?: boolean }) {
  return seedExpense({
    state: "qb_pending",
    needsReimbursement: opts.needsReimbursement,
    backfill: opts.backfill ?? false,
    reimburseePersonId: opts.needsReimbursement ? REIMBURSEE : undefined,
    submitterId: UPLOADER,
  });
}

const complete = (expenseId: string) =>
  advanceWorkflow({ db, expenseId, currentState: "qb_pending", event: { type: "QB_COMPLETE" }, actor: SYSTEM_ACTOR, action: "qb_event_emitted" });

describeDb("outcome notices: written by the final transitions only", () => {
  it("an approver's exception owes nothing; FINANCE's rejection of it emails the uploader and the reimbursee once each", async () => {
    const { id, approvalId } = await reimbursementInApproval();

    await raiseException(LEADER, id, approvalId, "not ours");
    expect(await notices(id)).toEqual([]);
    expect(send).not.toHaveBeenCalled();

    await rejectException(FINANCE, id, approvalId, "refusing this charge");
    const [row] = await notices(id);
    expect(row).toMatchObject({ event: "expense_line_rejected", orgId: ORG, firstFailedAt: null });
    expect(row.doneAt).not.toBeNull();
    expect(row.uploaderSentAt).not.toBeNull();
    expect(row.reimburseeSentAt).not.toBeNull();
    expect(sentTo()).toEqual([[id, "expense_line_rejected", "uploader"], [id, "expense_line_rejected", "reimbursee"]]);
    expect(send.mock.calls[0][0]).toEqual({
      receiptId: id, outcome: "expense_line_rejected", uploaderPersonId: UPLOADER, reimburseePersonId: REIMBURSEE, retailer: "Acme", receiptDate: "2026-10-02",
    });
  });

  it("an approval that sends the expense on to QuickBooks owes nothing", async () => {
    const { id, li, approvalId } = await reimbursementInApproval();
    await seedSubmitterSeat(li, REIMBURSEE);
    await approveLine(LEADER, id, approvalId);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).not.toBe("rejected");
    expect(await notices(id)).toEqual([]);
  });

  it("a reimbursement sent to the books emails both; the uploader is emailed once when they are the person reimbursed", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    await complete(id);
    expect(sentTo()).toEqual([[id, "reimbursement_complete", "uploader"], [id, "reimbursement_complete", "reimbursee"]]);

    send.mockClear();
    const own = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: UPLOADER, submitterId: UPLOADER });
    await complete(own);
    expect(sentTo()).toEqual([[own, "reimbursement_complete", "uploader"]]);
  });

  it("a card charge sent to the books is recorded as owing nothing and emails no one", async () => {
    const id = await inQbPending({ needsReimbursement: false });
    await complete(id);
    const [row] = await notices(id);
    expect(row).toMatchObject({ event: "reimbursement_complete", uploaderSentAt: null, reimburseeSentAt: null });
    expect(row.doneAt).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
  });

  it("a backfill lands in qb_skipped and owes nothing", async () => {
    const id = await inQbPending({ needsReimbursement: true, backfill: true });
    await checkAndProcessExpense(ORG, id);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_skipped");
    expect(await notices(id)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("the QuickBooks drain's completion emails the reimbursement right after it commits", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    const li = await seedLineItem(id, { partNumber: "PN-1" });
    bindPorts({
      outcomeMail: { send },
      catalog: {
        listCategories: async () => [{ id: 1, name: "Hardware", letter: "H" }],
        listSubcategories: async () => [{ id: 10, name: "Cables", number: 1, categoryId: 1 }],
        lookupItems: async () => [{ index: li, gtin13: "0000000000017", conversionVersion: 1 }],
        getItem: async (gtin13: string) => ({ gtin13, categoryId: 1, subcategoryId: 10 }),
        getActiveItem: async () => null,
        getItemNames: async () => [],
      },
    });
    await seedAccountMapping({ qbAccount: "4000" });
    await signAllLines(id);

    await checkAndProcessExpense(ORG, id);

    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_complete");
    expect(sentTo()).toEqual([[id, "reimbursement_complete", "uploader"], [id, "reimbursement_complete", "reimbursee"]]);
  });

  it("a replayed notice writes no second row", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    await db.$transaction(async (tx) => {
      await oweOutcomeNotice(tx, id, "qb_complete");
      await oweOutcomeNotice(tx, id, "qb_complete");
    });
    await oweOutcomeNotice(db, id, "qb_complete");
    expect(await notices(id)).toHaveLength(1);
  });
});

describeDb("outcome notices: commit or roll back with the state change", () => {
  it("a transition that rolls back leaves no notice; one that commits leaves exactly one", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    const rolledBack = db.$transaction(async (tx) => {
      await advanceWorkflowInTx(tx, { expenseId: id, currentState: "qb_pending", event: { type: "QB_COMPLETE" }, actor: SYSTEM_ACTOR, action: "qb_event_emitted" });
      throw new Error("later write failed");
    });
    await expect(rolledBack).rejects.toThrow("later write failed");
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_pending");
    expect(await notices(id)).toEqual([]);

    await db.$transaction((tx) => advanceWorkflowInTx(tx, { expenseId: id, currentState: "qb_pending", event: { type: "QB_COMPLETE" }, actor: SYSTEM_ACTOR, action: "qb_event_emitted" }));
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_complete");
    expect(await notices(id)).toHaveLength(1);
  });
});

describeDb("outcome notices: the sweep", () => {
  it("leaves notices owed while the mail out is unbound, then sends them once bound", async () => {
    bindPorts({});
    const id = await inQbPending({ needsReimbursement: true });
    await complete(id);
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect((await notices(id))[0].doneAt).toBeNull();

    bindPorts({ outcomeMail: { send } });
    expect(await sweepOutcomeNotices()).toEqual({ sent: 2, failed: 0 });
    expect((await notices(id))[0].doneAt).not.toBeNull();
  });

  it("a failed copy leaves the notice stuck with its error; the sweep never retries it", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    send.mockImplementation(async (_n, to) => to === "uploader");
    await complete(id);
    const [row] = await notices(id);
    expect(row.uploaderSentAt).not.toBeNull();
    expect(row).toMatchObject({ reimburseeSentAt: null, claimedAt: null, doneAt: null, failureReason: "To the reimbursee: the mail out reported failure" });
    expect(row.firstFailedAt).not.toBeNull();

    send.mockClear();
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await stuckItems()).toEqual([{ id: String(row.id), step: "outcome email", href: `/expense/expenses/${id}`, failedAt: row.firstFailedAt }]);
  });

  it("a send that throws records its error text", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    send.mockRejectedValueOnce(new Error("provider down")).mockResolvedValue(true);
    await complete(id);
    expect((await notices(id))[0]).toMatchObject({ doneAt: null, failureReason: "To the uploader: provider down" });
  });
});

describeDb("outcome notices: a person's Retry", () => {
  it("sends only the copy still owed, keeps the first failure time, and finishes the notice", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    send.mockImplementation(async (_n, to) => to === "uploader");
    await complete(id);
    const [failed] = await notices(id);

    send.mockClear();
    await expect(retryOutcomeNotice(failed.id)).rejects.toMatchObject({ status: 409, message: SEND_FAILED_AGAIN });
    const [again] = await notices(id);
    expect(again.firstFailedAt).toEqual(failed.firstFailedAt);
    expect(again).toMatchObject({ doneAt: null, claimedAt: null });

    send.mockClear().mockResolvedValue(true);
    await retryStuckItem({ id: String(failed.id), step: "outcome email" }, SYSTEM_ACTOR);
    expect(sentTo()).toEqual([[id, "reimbursement_complete", "reimbursee"]]);
    const [done] = await notices(id);
    expect(done.doneAt).not.toBeNull();
    expect(await stuckItems()).toEqual([]);
  });

  it("answers 404 for a notice not stuck and 503 while the mail out is unbound", async () => {
    const id = await inQbPending({ needsReimbursement: true });
    await complete(id);
    const [sent] = await notices(id);
    await expect(retryOutcomeNotice(sent.id)).rejects.toMatchObject({ status: 404 });

    send.mockResolvedValue(false);
    const other = await inQbPending({ needsReimbursement: true });
    await complete(other);
    const [stuck] = await notices(other);
    bindPorts({});
    await expect(retryOutcomeNotice(stuck.id)).rejects.toMatchObject({ status: 503 });
  });
});
