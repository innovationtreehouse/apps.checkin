/**
 * Sign-off hold, capital register, flags and QuickBooks match inputs against the real
 * database.
 */
import { describe, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG, seedSubmitterSeat } from "../helpers/seed";
import { setReimbursee, signLine, signoffStatus } from "../../services/signoffService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { checkApprovalAutoTransition } from "../../lib/financial-flow";
import { setDepreciationCycle, seedCapitalAssets, submitCapitalReview } from "../../services/capitalService";
import { checkOffFlag, listOpenFlags, raiseFlag } from "../../services/flagService";
import { financeQueueRows } from "../../services/financeQueueService";
import { approveLine } from "../../services/approvalService";
import { claimQbTxn, excludeQbTxn, matchExpenseToQb, qbCandidates, qbMatchInputs } from "../../services/qbMatchService";
import { inertQbReader, type QbTxn } from "../../contract";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

describeDb("sign-off seats", () => {
  async function heldLine(opts: { reimbursement?: boolean } = {}) {
    // submitter 1 · owner 2 · finance 3 and 4 · board 5 · 8 in the submitter's household
    bindPorts({
      signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 8]] }),
    });
    const reimbursement = opts.reimbursement ?? true;
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: reimbursement, reimburseePersonId: reimbursement ? 1 : undefined });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });
    return { id, li };
  }
  const events = (id: string) => db.expenseEvent.count({ where: { expenseId: id } });

  it("holds the expense out of the outbox until the last seat, then drains it", async () => {
    const { id, li } = await heldLine();

    await seedSubmitterSeat(li, 1);
    expect(await events(id)).toBe(0);
    expect((await signoffStatus(id))[0].missing).toEqual(["TREASURER"]);

    await signLine(principal(3, { isFinance: true }), li, "TREASURER");

    expect(await events(id)).toBe(1);
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("qb_complete");
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "signoff" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => [a.userId, a.valueAfter])).toEqual([[3, "TREASURER"]]);
  });

  it("refuses the line's approver and a household member of the submitter", async () => {
    const { li } = await heldLine();

    await expect(signLine(principal(2), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await expect(signLine(principal(8), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
  });

  it("one household holds one seat on an expense: the approver's spouse is refused the Treasurer seat, a Board member substitutes", async () => {
    // 3 holds FINANCE; 2, the bucket owner, is 3's spouse and approved line a
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], households: [[1], [2, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 1 });
    const a = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    const b = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, a, { ownerId: 100, status: "approved", decidedByUserId: 2 });
    await seedApproval(id, b, { ownerId: 100, status: "approved", decidedByUserId: 7 });

    await expect(signLine(FINANCE, a, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await expect(signLine(FINANCE, b, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await signLine(BOARD, a, "TREASURER");
  });

  it("the only FINANCE holder conflicted: a Board member signs as Treasurer, recorded in the audit log and raising no flag", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], households: [[1, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });

    await seedSubmitterSeat(li, 1);
    await expect(signLine(principal(3), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    expect(await events(id)).toBe(0);

    await signLine(principal(5), li, "TREASURER");
    expect(await events(id)).toBe(1);
    expect(await db.expenseFlag.count({ where: { expenseId: id } })).toBe(0);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "signoff", userId: 5, valueAfter: "TREASURER" } })).toBe(1);
  });

  it("a card charge needing two Board substitutions is held, and shows in the Board tab as held", async () => {
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3], board: [5, 6], households: [[1, 3]] }) });
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    // A Board member's approval of an org-level line uses the card charge's one substitution.
    await seedApproval(id, li, { ownerId: 7, status: "approved", decidedByUserId: 5 });

    await expect(signLine(principal(1), li, "SUBMITTER")).rejects.toMatchObject({ status: 403 });
    await expect(signLine(principal(6), li, "TREASURER")).rejects.toMatchObject({ status: 403 });

    expect(await events(id)).toBe(0);
    expect((await signoffStatus(id))[0].blocked).toEqual(["TREASURER"]);
    expect(await db.expenseFlag.count({ where: { expenseId: id } })).toBe(0);
    const board = await financeQueueRows(principal(6, { isBoard: true }), "board");
    expect(board.find((r) => r.expenseId === id)?.reasons.map((x) => x.code)).toContain("SIGNER_HELD");
  });

  it("an org-level line waits in owner approval for a Board member's approval, then needs every seat", async () => {
    // 6 holds both FINANCE and Board
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3, 6], board: [5, 6] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    const approvalId = await seedApproval(id, li, { ownerId: 7 });
    await checkApprovalAutoTransition(id, { userId: 3 });
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("owner_approval");

    // The submitter confirms first; the approval follows.
    await expect(approveLine(principal(5, { isBoard: true }), id, approvalId)).rejects.toMatchObject({ status: 403 });
    await seedSubmitterSeat(li, 1);
    await expect(approveLine(principal(2), id, approvalId)).rejects.toMatchObject({ status: 403 });
    await approveLine(principal(5, { isBoard: true }), id, approvalId);
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("qb_pending");

    await expect(signLine(principal(5), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    expect(await events(id)).toBe(0);

    await signLine(principal(6), li, "TREASURER");
    expect(await events(id)).toBe(1);
  });

  it("a FINANCE holder in the bucket owner's household does not sign as Treasurer; a Board member replaces them", async () => {
    // owner 2 · 3 holds FINANCE and is 2's spouse · treasurer 7 approves · board 5
    bindPorts({ signoff: directory({ approvers: { 100: [2, 7] }, owners: { 100: 2 }, finance: [3], board: [5], households: [[2, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 7 });

    await seedSubmitterSeat(li, 1);
    await expect(signLine(principal(3, { isFinance: true }), li, "TREASURER")).rejects.toMatchObject({ status: 403 });

    await signLine(principal(5, { isBoard: true }), li, "TREASURER");
    expect(await events(id)).toBe(1);
  });

  it("FINANCE names a non-member adult as reimbursee; the line then takes a Board seat after the Treasurer", async () => {
    // submitter 1 is a member; 12, named by FINANCE 3, is not · owner 2 approved · finance 3, 4 · board 5
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], nonMembers: [12] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });

    await setReimbursee(ORG, id, 12, FINANCE);
    expect((await signoffStatus(id))[0].missing).toEqual(["SUBMITTER", "TREASURER", "BOARD"]);
    await expect(signLine(BOARD, li, "BOARD")).rejects.toMatchObject({ status: 403 });
    await signLine(principal(4, { isFinance: true }), li, "TREASURER");
    await signLine(BOARD, li, "BOARD");
  });

  it("a non-member reimbursement adds a Board seat after the approval and the Treasurer; the rule follows the reimbursee and skips card charges", async () => {
    // submitter 11 is not a member; reimbursee 1 is; owner 2 · finance 3 · board 5
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], nonMembers: [11, 12] }) });
    const line = async (opts: { needsReimbursement: boolean; reimburseePersonId?: number }) => {
      const id = await seedExpense({ state: "owner_approval", submitterId: 11, ...opts });
      const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
      return { id, li, approvalId: await seedApproval(id, li, { ownerId: 100 }) };
    };
    const missing = async (id: string) => (await signoffStatus(id))[0].missing;

    const member = await line({ needsReimbursement: true, reimburseePersonId: 1 });
    const card = await line({ needsReimbursement: false });
    expect(await missing(member.id)).toEqual(["SUBMITTER", "TREASURER"]);
    expect(await missing(card.id)).toEqual(["TREASURER"]);

    const nonMember = await line({ needsReimbursement: true, reimburseePersonId: 12 });
    expect(await missing(nonMember.id)).toEqual(["SUBMITTER", "TREASURER", "BOARD"]);
    await expect(signLine(BOARD, nonMember.li, "BOARD")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not approved yet/) });
    await seedSubmitterSeat(nonMember.li, 12);
    await approveLine(principal(2), nonMember.id, nonMember.approvalId);
    await expect(signLine(BOARD, nonMember.li, "BOARD")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/after the Treasurer/) });
    await signLine(FINANCE, nonMember.li, "TREASURER");
    await signLine(BOARD, nonMember.li, "BOARD");
    expect(await missing(nonMember.id)).toEqual([]);
  });

  describe("the reimbursee (reimburseePersonId)", () => {
    // submitter 1 · reimbursee 9 · 10 in the reimbursee's household · owner 2 · finance 3 · board 5, 6
    async function reimburseeLine(seat: { approvers?: number[]; finance?: number[]; board?: number[] }, reimburseePersonId?: number) {
      bindPorts({
        signoff: directory({
          approvers: { 100: seat.approvers ?? [2] },
          finance: seat.finance ?? [3],
          board: seat.board ?? [5, 6],
          households: [[9, 10]],
        }),
      });
      const id = await seedExpense({ state: "qb_pending", needsReimbursement: reimburseePersonId !== undefined, reimburseePersonId });
      const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
      await seedApproval(id, li, { ownerId: 100, status: "approved" });
      return { id, li };
    }

    it("the reimbursee signs no seat from the sign-off route, not even the submitter seat", async () => {
      const { li } = await reimburseeLine({ approvers: [9], finance: [9], board: [9] }, 9);
      await expect(signLine(principal(9), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
      await expect(signLine(principal(9), li, "SUBMITTER")).rejects.toMatchObject({ status: 403, message: "Confirm the receipt to sign this seat" });
    });

    it("a member of the reimbursee's household cannot fill any seat", async () => {
      const { li } = await reimburseeLine({ approvers: [10], finance: [10], board: [10] }, 9);
      for (const seat of ["SUBMITTER", "TREASURER"] as const) {
        await expect(signLine(principal(10), li, seat)).rejects.toMatchObject({ status: 403 });
      }
    });

    it("a card charge has no reimbursee conflict and takes no submitter seat", async () => {
      const { id, li } = await reimburseeLine({ approvers: [9], finance: [3] });
      await db.lineItemOwnerApproval.updateMany({ where: { lineItemId: li }, data: { decidedByUserId: 9 } });
      await signLine(principal(3), li, "TREASURER");
      expect((await signoffStatus(id))[0].missing).toEqual([]);
    });

    // A reimbursement whose reimbursee is unknown: the expense id and its line.
    async function unknownReimbursee(opts: { backfill?: boolean; submitterId?: number } = {}) {
      bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 9, 10], board: [5, 6], households: [[9, 10], [1, 11]] }) });
      const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, backfill: opts.backfill, submitterId: opts.submitterId });
      const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
      await seedApproval(id, li, { ownerId: 100, status: "approved" });
      return { id, li };
    }
    const signAll = (id: string, li: number) =>
      db.expenseLineSignoff.createMany({
        data: [["SUBMITTER", 1], ["TREASURER", 3]].map(([seat, signerUserId]) => ({ expenseId: id, lineItemId: li, seat: seat as string, signerUserId: signerUserId as number })),
      });

    it("a reimbursement with no reimbursee is held from the outbox even with every seat signed", async () => {
      const { id, li } = await unknownReimbursee();
      await signAll(id, li);
      await checkAndProcessExpense(ORG, id);
      expect(await events(id)).toBe(0);
    });

    it("nobody signs while the reimbursee is unknown; once FINANCE sets it the line is signable and drains", async () => {
      const { id, li } = await unknownReimbursee();
      await expect(signLine(principal(9, { isFinance: true }), li, "TREASURER")).rejects.toMatchObject({ status: 409 });

      await setReimbursee(ORG, id, 1, FINANCE);

      expect(await financeQueueRows(FINANCE, "expenses")).toEqual([]);
      const audit = await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "reimbursee_set" } });
      expect(audit).toMatchObject({ userId: 3, fieldChanged: "reimburseePersonId", valueBefore: null, valueAfter: "1" });

      await seedSubmitterSeat(li, 1);
      await signLine(principal(9, { isFinance: true }), li, "TREASURER");
      expect(await events(id)).toBe(1);
    });

    it("setting the reimbursee voids the submitter's confirmation and every seat after it, audited, so they are signed again for the payee", async () => {
      const { id, li } = await unknownReimbursee();
      await signAll(id, li);
      await setReimbursee(ORG, id, 1, FINANCE);
      expect(await events(id)).toBe(0);
      expect((await signoffStatus(id))[0].missing).toEqual(["SUBMITTER", "TREASURER"]);
      const voided = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "signoff_voided" } });
      expect(voided.map((a) => [a.userId, a.valueBefore]).sort()).toEqual([[3, "SUBMITTER"], [3, "TREASURER"]]);
      expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "approval_cleared" } })).toBe(1);
      expect(await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "submitter_confirmation_voided" } })).toMatchObject({ userId: 3, fieldChanged: "reimbursee" });
    });

    it("only FINANCE sets the reimbursee, never to themself or their own household", async () => {
      const { id } = await unknownReimbursee({ submitterId: 9 });
      await expect(setReimbursee(ORG, id, 9, principal(2))).rejects.toMatchObject({ status: 403 });
      await expect(setReimbursee(ORG, id, 9, principal(9, { isFinance: true }))).rejects.toMatchObject({ status: 403 });
      await expect(setReimbursee(ORG, id, 9, principal(10, { isFinance: true }))).rejects.toMatchObject({ status: 403 });
      await expect(setReimbursee("org-other", id, 9, FINANCE)).rejects.toThrow(/not this org/);
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("the submitter and the submitter's household cannot name the reimbursee; an outside FINANCE holder can", async () => {
      const { id } = await unknownReimbursee();
      await expect(setReimbursee(ORG, id, 1, principal(1, { isFinance: true }))).rejects.toMatchObject({ status: 403 });
      await expect(setReimbursee(ORG, id, 1, principal(11, { isFinance: true }))).rejects.toMatchObject({ status: 403 });
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();

      await setReimbursee(ORG, id, 1, FINANCE);
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBe(1);
    });

    it("FINANCE names someone other than the uploader", async () => {
      const { id } = await unknownReimbursee();
      // 7 sits outside every conflicted household.
      await setReimbursee(ORG, id, 7, FINANCE);
      expect((await db.expense.findFirst({ where: { id } }))!).toMatchObject({ submitterId: 1, reimburseePersonId: 7 });
    });

    it("FINANCE cannot name a minor as reimbursee", async () => {
      const { id } = await unknownReimbursee();
      bindPorts({ signoff: directory({ finance: [3], minors: [7] }) });
      await expect(setReimbursee(ORG, id, 7, FINANCE)).rejects.toMatchObject({ status: 400, message: "Only an adult can be named as reimbursee" });
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("a FINANCE holder cannot name themself or anyone in their household as reimbursee", async () => {
      const { id } = await unknownReimbursee();
      // 9 and 10 hold FINANCE and share a household.
      await expect(setReimbursee(ORG, id, 9, principal(9, { isFinance: true }))).rejects.toMatchObject({ status: 403 });
      await expect(setReimbursee(ORG, id, 10, principal(9, { isFinance: true }))).rejects.toMatchObject({ status: 403 });
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("a merged-away person is not named; the record they were merged into is", async () => {
      const { id } = await unknownReimbursee();
      bindPorts({ signoff: directory({ finance: [3], merged: { 1: 12 } }) });
      await expect(setReimbursee(ORG, id, 1, FINANCE)).rejects.toMatchObject({ status: 404 });
      await setReimbursee(ORG, id, 12, FINANCE);
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBe(12);
    });

    it("FINANCE cannot name a reimbursee who is not a Person", async () => {
      const { id } = await unknownReimbursee();
      bindPorts({ signoff: directory({ finance: [3], unknownPeople: [42] }) });
      await expect(setReimbursee(ORG, id, 42, FINANCE)).rejects.toMatchObject({ status: 404 });
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("a reimbursee to name is a finance queue reason while the expense is open, and leaves it once closed", async () => {
      const { id } = await unknownReimbursee();
      expect((await financeQueueRows(FINANCE, "expenses")).map((r) => [r.expenseId, r.reasons.map((x) => x.code)])).toEqual([[id, ["REIMBURSEE_TO_NAME"]]]);
      await db.expense.update({ where: { id }, data: { state: "rejected" } });
      expect(await financeQueueRows(FINANCE, "expenses")).toEqual([]);
    });

    it("a card charge or a backfilled expense takes no reimbursee", async () => {
      const card = await seedExpense({ state: "qb_pending" });
      await expect(setReimbursee(ORG, card, 7, FINANCE)).rejects.toMatchObject({ status: 400 });
      const { id } = await unknownReimbursee({ backfill: true });
      await expect(setReimbursee(ORG, id, 7, FINANCE)).rejects.toMatchObject({ status: 400 });
    });
  });

  it("an unbound directory fills no seat", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    await expect(signLine(principal(3, { isFinance: true }), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("capital register", () => {
  it("capital review then depreciation mints one ITFA asset per unit, once", async () => {
    await db.capitalAsset.create({ data: { orgId: ORG, assetNumber: "ITFA07", description: "old", seeded: true } });
    const id = await seedExpense({ state: "capital_review" });
    const li = await seedLineItem(id, { quantity: 2, unitPriceCents: 90000, description: "Lathe" });

    await expect(submitCapitalReview(principal(2), id, { lineItems: [{ lineItemId: li, isCapital: true }] })).rejects.toMatchObject({ status: 403 });
    await submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true }] });
    await setDepreciationCycle(FINANCE, id, { items: [{ lineItemId: li, depreciationYears: 5, ownerId: 100 }] });

    const assets = await db.capitalAsset.findMany({ where: { sourceLineItemId: li }, orderBy: { assetNumber: "asc" } });
    expect(assets.map((a) => a.assetNumber)).toEqual(["ITFA08", "ITFA09"]);
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("qb_pending");
  });

  it("capital review and depreciation refuse an archived or unlisted bucket", async () => {
    const id = await seedExpense({ state: "capital_review" });
    const li = await seedLineItem(id);

    await expect(submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true, capitalOwnerId: 999 }] })).rejects.toMatchObject({ status: 400 });
    await submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true, capitalOwnerId: 100 }] });
    await expect(setDepreciationCycle(FINANCE, id, { items: [{ lineItemId: li, depreciationYears: 5, ownerId: 12345 }] })).rejects.toMatchObject({ status: 400 });
    expect(await db.capitalAsset.count({ where: { sourceLineItemId: li } })).toBe(0);
  });

  it("seeding is idempotent per asset number and canonicalizes it", async () => {
    const rows = [{ assetNumber: "itfa3", description: "Saw" }, { assetNumber: "BAD", description: "x" }];
    expect(await seedCapitalAssets(FINANCE, rows)).toMatchObject({ created: 1, skipped: 0, errors: 1 });
    expect(await seedCapitalAssets(FINANCE, rows)).toMatchObject({ created: 0, skipped: 1, errors: 1 });
    expect(await db.capitalAsset.findMany({ select: { assetNumber: true } })).toEqual([{ assetNumber: "ITFA03" }]);
  });
});

describeDb("flags", () => {
  it("a review is checked off by FINANCE, once, with an audit row; a retired kind is refused", async () => {
    const id = await seedExpense();
    await raiseFlag(id, "QB_DUPLICATE_TO_VOID", "needs voiding");
    await raiseFlag(id, "QB_DUPLICATE_TO_VOID");
    const [flag] = await listOpenFlags(FINANCE);
    expect(await listOpenFlags(BOARD)).toEqual([]);

    await expect(checkOffFlag(BOARD, flag.id)).rejects.toMatchObject({ status: 403 });
    await checkOffFlag(FINANCE, flag.id, "voided Bill 41 on 10/20");

    expect(await listOpenFlags(FINANCE)).toEqual([]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "flag_checked_off", userId: 3 } })).toBe(1);

    const old = await db.expenseFlag.create({ data: { orgId: ORG, expenseId: id, kind: "THRESHOLD_CROSSED", audience: "BOARD" } });
    expect(await listOpenFlags(BOARD)).toEqual([]);
    await expect(checkOffFlag(BOARD, old.id, "seen")).rejects.toMatchObject({ status: 409 });
  });
});

describeDb("QuickBooks match inputs", () => {
  it("skips claimed and excluded ids", async () => {
    const early = await seedExpense();
    const late = await seedExpense();
    await db.expense.update({ where: { id: early }, data: { receiptDate: "2026-03-01" } });
    await db.expense.update({ where: { id: late }, data: { receiptDate: "2026-04-01" } });
    const a = await seedLineItem(early);
    const b = await seedLineItem(late);
    await db.expenseLineItem.update({ where: { id: a }, data: { qbMatchState: "MATCHED", qbTxnId: "qb-1" } });
    await db.expenseLineItem.update({ where: { id: b }, data: { qbMatchState: "CREATED", qbTxnId: "qb-2" } });
    await db.expenseQbClaim.createMany({
      data: [
        { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "qb-1" },
        { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "qb-2" },
        { orgId: ORG, qbTxnEntity: "Bill", qbTxnId: "qb-3" },
      ],
    });

    await excludeQbTxn(FINANCE, "qb-9", "hand-booked, no receipt");
    await expect(excludeQbTxn(FINANCE, "qb-9", "again")).rejects.toMatchObject({ status: 409 });

    expect((await qbMatchInputs("Purchase")).skipIds.sort()).toEqual(["qb-1", "qb-2", "qb-9"]);
    expect((await qbMatchInputs("Bill")).skipIds.sort()).toEqual(["qb-3", "qb-9"]);
  });

  it("with nothing claimed or excluded there is nothing to skip", async () => {
    expect(await qbMatchInputs("Purchase")).toEqual({ skipIds: [] });
  });

  it("a QuickBooks entry is claimed by one line at most", async () => {
    const id = await seedExpense();
    const a = await seedLineItem(id);
    const b = await seedLineItem(id);
    await db.expenseLineItem.update({ where: { id: a }, data: { qbTxnId: "qb-1" } });
    await expect(db.expenseLineItem.update({ where: { id: b }, data: { qbTxnId: "qb-1" } })).rejects.toThrow();
  });

  it("two concurrent claims of one entry: exactly one wins", async () => {
    const claim = () => db.$transaction((tx) => claimQbTxn(tx, ORG, "Purchase", "qb-7"));
    expect((await Promise.all([claim(), claim()])).sort()).toEqual([false, true]);
    expect(await db.expenseQbClaim.count({ where: { orgId: ORG, qbTxnId: "qb-7" } })).toBe(1);
  });
});

describeDb("QuickBooks match", () => {
  type Entry = string | (Partial<QbTxn> & { id: string });
  const txn = (e: Entry): QbTxn => ({
    txnDate: "2026-05-02",
    totalCents: 100,
    accountRef: "card-1",
    vendorRef: "vendor-1",
    ...(typeof e === "string" ? { id: e } : e),
  });

  /**
   * An expense of one 100-cent line dated 2026-05-01: a card charge, or a reimbursement owed to person 1.
   * QuickBooks holds the given Purchases and Bills; the card account is card-1 and person 1's
   * vendor is vendor-1 unless `refs` is false. The reader ignores the window, so the service's
   * own date check is what is tested.
   */
  async function qbExpense(
    qb: { purchases?: Entry[]; bills?: Entry[] },
    opts: { signed?: boolean; reimbursement?: boolean; refs?: boolean } = {},
  ) {
    bindPorts({
      signoff: directory({ finance: [3], board: [5] }),
      quickbooks: {
        reader: {
          ...inertQbReader,
          purchasesBetween: async () => (qb.purchases ?? []).map(txn),
          billsBetween: async () => (qb.bills ?? []).map(txn),
          billPaymentsBetween: async () => [],
        },
        ...(opts.refs !== false && {
          refs: { paymentAccountId: async () => "card-1", vendorIdFor: async (id: number) => (id === 1 ? "vendor-1" : null) },
        }),
      },
    });
    const reimbursement = opts.reimbursement ?? false;
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: reimbursement, reimburseePersonId: reimbursement ? 1 : undefined });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-05-01" } });
    await seedLineItem(id);
    if (opts.signed ?? true) await signAllLines(id);
    return id;
  }
  const linked = (id: string) => db.expense.findUnique({ where: { id }, select: { qbTxnId: true, qbTxnEntity: true } });

  it("links a signed expense to one of its own candidates and records the entity type", async () => {
    const id = await qbExpense({ purchases: ["42"] });
    await matchExpenseToQb(FINANCE, id, "42");
    expect(await linked(id)).toEqual({ qbTxnId: "42", qbTxnEntity: "Purchase" });
  });

  it("stores the baseline from the candidate it matched", async () => {
    const id = await qbExpense({ purchases: ["42"] });
    await matchExpenseToQb(FINANCE, id, "42");
    const { qbMatchBaseline } = await db.expense.findUniqueOrThrow({ where: { id } });
    expect(JSON.parse(qbMatchBaseline ?? "null")).toEqual({ amountCents: 100, vendorId: null, txnDate: "2026-05-02" });
  });

  it("records the expense's claim, so the entry is never offered again", async () => {
    const id = await qbExpense({ purchases: ["42"] });
    await matchExpenseToQb(FINANCE, id, "42");
    expect(await db.expenseQbClaim.count({ where: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "42" } })).toBe(1);
    const other = await qbExpense({ purchases: ["42"] });
    expect(await qbCandidates(FINANCE, other)).toEqual([]);
  });

  it("never offers or links an entry another expense already holds", async () => {
    const holder = await seedExpense({ state: "qb_complete" });
    await db.expense.update({ where: { id: holder }, data: { qbMatchState: "CREATED", qbTxnId: "42", qbTxnEntity: "Purchase" } });
    await db.expenseQbClaim.create({ data: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "42" } });
    const id = await qbExpense({ purchases: ["42"] });
    expect(await qbCandidates(FINANCE, id)).toEqual([]);
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("a Bill claim with the same id does not block a Purchase", async () => {
    await db.expenseQbClaim.create({ data: { orgId: ORG, qbTxnEntity: "Bill", qbTxnId: "42" } });
    const id = await qbExpense({ purchases: ["42"] });
    await matchExpenseToQb(FINANCE, id, "42");
    expect(await linked(id)).toEqual({ qbTxnId: "42", qbTxnEntity: "Purchase" });
  });

  it("two concurrent expense matches on one entry: exactly one wins", async () => {
    const a = await qbExpense({ purchases: ["42"] });
    const b = await qbExpense({ purchases: ["42"] });
    const results = await Promise.allSettled([matchExpenseToQb(FINANCE, a, "42"), matchExpenseToQb(FINANCE, b, "42")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.expenseQbClaim.count({ where: { orgId: ORG, qbTxnId: "42" } })).toBe(1);
  });

  it("refuses an id that is not among the expense's candidates", async () => {
    const id = await qbExpense({ purchases: ["42"] });
    await expect(matchExpenseToQb(FINANCE, id, "999")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses an expense with a line missing a sign-off", async () => {
    const id = await qbExpense({ purchases: ["42"] }, { signed: false });
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses the same id under another entity type", async () => {
    const id = await qbExpense({ bills: ["42"] });
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses an entry whose amount is off by a cent", async () => {
    const id = await qbExpense({ purchases: [{ id: "42", totalCents: 101 }] });
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses an entry dated a day outside the match window", async () => {
    const id = await qbExpense({ purchases: [{ id: "42", txnDate: "2026-05-09" }, { id: "43", txnDate: "2026-04-23" }] });
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    await expect(matchExpenseToQb(FINANCE, id, "43")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("accepts an entry dated at the edge of the window", async () => {
    const id = await qbExpense({ purchases: [{ id: "42", txnDate: "2026-05-08" }] });
    await matchExpenseToQb(FINANCE, id, "42");
    expect(await linked(id)).toEqual({ qbTxnId: "42", qbTxnEntity: "Purchase" });
  });

  it("refuses a Purchase booked against another payment account", async () => {
    const id = await qbExpense({ purchases: [{ id: "42", accountRef: "card-2" }] });
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("links a reimbursement to a Bill for the reimbursee's vendor, never another vendor's", async () => {
    const id = await qbExpense({ bills: ["42", { id: "43", vendorRef: "vendor-2" }] }, { reimbursement: true });
    await expect(matchExpenseToQb(FINANCE, id, "43")).rejects.toMatchObject({ status: 409 });
    await matchExpenseToQb(FINANCE, id, "42");
    expect(await linked(id)).toEqual({ qbTxnId: "42", qbTxnEntity: "Bill" });
  });

  it("matches nothing while the host has not bound the QuickBooks refs", async () => {
    const id = await qbExpense({ purchases: ["42"] }, { refs: false });
    await expect(matchExpenseToQb(FINANCE, id, "42")).rejects.toMatchObject({ status: 409 });
    expect(await linked(id)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("matches an unprocessed expense on its tax, shipping and discount, with no line allocations yet", async () => {
    const id = await qbExpense({ purchases: [{ id: "42", totalCents: 150 }, { id: "43", totalCents: 160 }] }, { signed: false });
    await db.expense.update({ where: { id }, data: { state: "qb_on_hold", taxCents: 15, discountCents: 5 } });
    await seedLineItem(id, { totalPriceCents: 50 });
    await signAllLines(id);
    expect(await db.expenseLineItem.count({ where: { expenseId: id, allocatedTaxCents: { not: null } } })).toBe(0);
    expect((await qbCandidates(FINANCE, id)).map((t) => t.id)).toEqual(["43"]);
    await matchExpenseToQb(FINANCE, id, "43");
    expect(await linked(id)).toEqual({ qbTxnId: "43", qbTxnEntity: "Purchase" });
  });

  it("finance resolves an expense the poster left AMBIGUOUS", async () => {
    const id = await qbExpense({ purchases: ["42"] });
    await db.expense.update({ where: { id }, data: { qbMatchState: "AMBIGUOUS" } });
    await matchExpenseToQb(FINANCE, id, "42");
    expect(await db.expense.findUnique({ where: { id }, select: { qbMatchState: true, qbTxnId: true } })).toEqual({ qbMatchState: "MATCHED", qbTxnId: "42" });
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "qb_matched" } })).toBe(1);
  });

  it("refuses an expense already in QuickBooks, a backfill, or one held back as test data", async () => {
    const created = await qbExpense({ purchases: ["42"] });
    await db.expense.update({ where: { id: created }, data: { qbMatchState: "CREATED", qbTxnId: "7", qbTxnEntity: "Purchase" } });
    await expect(matchExpenseToQb(FINANCE, created, "42")).rejects.toMatchObject({ status: 409 });
    const backfill = await qbExpense({ purchases: ["42"] });
    await db.expense.update({ where: { id: backfill }, data: { backfill: true } });
    await expect(matchExpenseToQb(FINANCE, backfill, "42")).rejects.toMatchObject({ status: 409 });
    const testData = await qbExpense({ purchases: ["42"] });
    await db.expense.update({ where: { id: testData }, data: { qbMatchState: "NOT_TEST_DATA" } });
    await expect(matchExpenseToQb(FINANCE, testData, "42")).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an expense outside the org", async () => {
    await expect(qbCandidates(FINANCE, "no-such-expense")).rejects.toMatchObject({ status: 404 });
  });
});
