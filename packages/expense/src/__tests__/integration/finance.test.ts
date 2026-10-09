/**
 * Sign-off hold, capital register, flags and QuickBooks match inputs against the real
 * database.
 */
import { describe, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { setReimbursee, signLine, signoffStatus } from "../../services/signoffService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { checkApprovalAutoTransition } from "../../lib/financial-flow";
import { setDepreciationCycle, seedCapitalAssets, submitCapitalReview } from "../../services/capitalService";
import { checkOffFlag, listOpenFlags, raiseFlag } from "../../services/flagService";
import { excludeQbTxn, qbMatchInputs } from "../../services/qbMatchService";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

describeDb("sign-off seats", () => {
  async function heldLine(opts: { reimbursement?: boolean } = {}) {
    // submitter 1 · leader 2 · finance 3 and 4 · board 5 · 8 in the submitter's household
    bindPorts({
      signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 8]] }),
    });
    const reimbursement = opts.reimbursement ?? true;
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: reimbursement, reimburseePersonId: reimbursement ? 1 : undefined });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    return { id, li };
  }
  const events = (id: string) => db.expenseEvent.count({ where: { expenseId: id } });

  it("holds the expense out of the outbox until the last seat, then drains it", async () => {
    const { id, li } = await heldLine();

    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    expect(await events(id)).toBe(0);
    expect((await signoffStatus(id))[0].missing).toEqual(["TREASURER"]);

    await signLine(principal(3, { isFinance: true }), li, "TREASURER");

    expect(await events(id)).toBe(1);
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("qb_complete");
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "signoff" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => [a.userId, a.valueAfter])).toEqual([[1, "SUBMITTER"], [2, "PROGRAM_APPROVER"], [3, "TREASURER"]]);
  });

  it("refuses a second seat for the same person and a household member of the submitter", async () => {
    const { li } = await heldLine();
    await signLine(principal(2), li, "PROGRAM_APPROVER");

    await expect(signLine(principal(2), li, "TREASURER")).rejects.toMatchObject({ statusCode: 403 });
    await expect(signLine(principal(8), li, "TREASURER")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("the only FINANCE holder conflicted: a Board member signs as Treasurer and a COI flag goes to the board", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], households: [[1, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });

    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    await expect(signLine(principal(3), li, "TREASURER")).rejects.toMatchObject({ statusCode: 403 });
    expect(await events(id)).toBe(0);

    await signLine(principal(5), li, "TREASURER");
    expect(await events(id)).toBe(1);
    expect(await db.expenseFlag.findMany({ where: { expenseId: id } })).toMatchObject([{ kind: "COI", audience: "BOARD" }]);
  });

  it("a card charge needing two Board substitutions is held and flagged to the board", async () => {
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3], board: [5, 6], households: [[1, 3]] }) });
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 7, status: "approved" });

    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(5), li, "PROGRAM_APPROVER");
    await expect(signLine(principal(6), li, "TREASURER")).rejects.toMatchObject({ statusCode: 403 });

    expect(await events(id)).toBe(0);
    expect((await signoffStatus(id))[0].blocked).toEqual(["TREASURER"]);
    expect(await db.expenseFlag.findMany({ where: { expenseId: id } })).toMatchObject([{ kind: "COI", audience: "BOARD" }]);
  });

  it("an org-level line skips owner approval but still needs every seat, a Board member in the program seat", async () => {
    // 6 holds both FINANCE and Board
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3, 6], board: [5, 6] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 7, status: "approved" });
    await checkApprovalAutoTransition(id, { userId: 3 });
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("qb_pending");

    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(6), li, "TREASURER");
    await expect(signLine(principal(6), li, "PROGRAM_APPROVER")).rejects.toMatchObject({ statusCode: 403 });
    await expect(signLine(principal(2), li, "PROGRAM_APPROVER")).rejects.toMatchObject({ statusCode: 403 });
    expect(await events(id)).toBe(0);

    await signLine(principal(5), li, "PROGRAM_APPROVER");
    expect(await events(id)).toBe(1);
  });

  describe("the reimbursee (reimburseePersonId)", () => {
    // submitter 1 · reimbursee 9 · 10 in the reimbursee's household · leader 2 · finance 3 · board 5, 6
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

    it("the reimbursee cannot fill any seat", async () => {
      const { li } = await reimburseeLine({ approvers: [9], finance: [9], board: [9] }, 9);
      for (const seat of ["SUBMITTER", "PROGRAM_APPROVER", "TREASURER"] as const) {
        await expect(signLine(principal(9), li, seat)).rejects.toMatchObject({ statusCode: 403 });
      }
    });

    it("a member of the reimbursee's household cannot fill any seat", async () => {
      const { li } = await reimburseeLine({ approvers: [10], finance: [10], board: [10] }, 9);
      for (const seat of ["SUBMITTER", "PROGRAM_APPROVER", "TREASURER"] as const) {
        await expect(signLine(principal(10), li, seat)).rejects.toMatchObject({ statusCode: 403 });
      }
    });

    it("a line without reimburseePersonId has no reimbursee conflict", async () => {
      const { id, li } = await reimburseeLine({ approvers: [9], finance: [10] });
      await signLine(principal(9), li, "PROGRAM_APPROVER");
      await signLine(principal(10), li, "TREASURER");
      expect((await signoffStatus(id))[0].missing).toEqual(["SUBMITTER"]);
    });

    // A reimbursement whose reimbursee is unknown: the expense id and its line, with REIMBURSEE_UNKNOWN raised.
    async function unknownReimbursee(opts: { backfill?: boolean } = {}) {
      bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 9, 10], board: [5, 6], households: [[9, 10]] }) });
      const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, backfill: opts.backfill });
      const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
      await seedApproval(id, li, { ownerId: 100, status: "approved" });
      await raiseFlag(id, "REIMBURSEE_UNKNOWN");
      return { id, li };
    }
    const signAll = (id: string, li: number) =>
      db.expenseLineSignoff.createMany({
        data: [["SUBMITTER", 1], ["PROGRAM_APPROVER", 2], ["TREASURER", 3]].map(([seat, signerUserId]) => ({ expenseId: id, lineItemId: li, seat: seat as string, signerUserId: signerUserId as number })),
      });

    it("a reimbursement with no reimbursee is held from the outbox even with every seat signed", async () => {
      const { id, li } = await unknownReimbursee();
      await signAll(id, li);
      await checkAndProcessExpense(ORG, id);
      expect(await events(id)).toBe(0);
    });

    it("nobody signs while the reimbursee is unknown; once FINANCE sets it the line is signable and drains", async () => {
      const { id, li } = await unknownReimbursee();
      await expect(signLine(principal(1), li, "SUBMITTER")).rejects.toMatchObject({ statusCode: 409 });

      await setReimbursee(ORG, id, 1, FINANCE);

      const flag = await db.expenseFlag.findFirst({ where: { expenseId: id, kind: "REIMBURSEE_UNKNOWN" } });
      expect(flag!.checkedOffAt).not.toBeNull();
      const audit = await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "reimbursee_set" } });
      expect(audit).toMatchObject({ userId: 3, fieldChanged: "reimburseePersonId", valueBefore: null, valueAfter: "1" });

      await signLine(principal(1), li, "SUBMITTER");
      await signLine(principal(2), li, "PROGRAM_APPROVER");
      await signLine(FINANCE, li, "TREASURER");
      expect(await events(id)).toBe(1);
    });

    it("setting the reimbursee drains an expense whose seats were already filled", async () => {
      const { id, li } = await unknownReimbursee();
      await signAll(id, li);
      await setReimbursee(ORG, id, 7, FINANCE);
      expect(await events(id)).toBe(1);
    });

    it("only FINANCE sets the reimbursee, never to themself or their own household", async () => {
      const { id } = await unknownReimbursee();
      await expect(setReimbursee(ORG, id, 7, principal(2))).rejects.toMatchObject({ statusCode: 403 });
      await expect(setReimbursee(ORG, id, 9, principal(9, { isFinance: true }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(setReimbursee(ORG, id, 9, principal(10, { isFinance: true }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(setReimbursee("org-other", id, 7, FINANCE)).rejects.toThrow(/not this org/);
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("a sign-off by someone the new reimbursee conflicts is voided and must be re-signed", async () => {
      const { id, li } = await reimburseeLine({ approvers: [10] }, 7);
      await signLine(principal(1), li, "SUBMITTER");
      await signLine(principal(10), li, "PROGRAM_APPROVER");

      await setReimbursee(ORG, id, 9, FINANCE);

      const status = (await signoffStatus(id))[0];
      expect(status.filled).toEqual([{ seat: "SUBMITTER", signerUserId: 1 }]);
      expect(status.missing).toEqual(["PROGRAM_APPROVER", "TREASURER"]);
      const voided = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "signoff_voided" } });
      expect(voided.map((a) => [a.userId, a.lineItemId, a.valueBefore])).toEqual([[3, li, "PROGRAM_APPROVER"]]);
      await expect(signLine(principal(10), li, "PROGRAM_APPROVER")).rejects.toMatchObject({ statusCode: 403 });
      await signLine(principal(5), li, "PROGRAM_APPROVER");
    });

    it("FINANCE cannot name a reimbursee who is not a Person", async () => {
      const { id } = await unknownReimbursee();
      bindPorts({ signoff: directory({ finance: [3], unknownPeople: [42] }) });
      await expect(setReimbursee(ORG, id, 42, FINANCE)).rejects.toMatchObject({ statusCode: 404 });
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("REIMBURSEE_UNKNOWN cannot be checked off while the hold applies; it can once the expense is closed", async () => {
      const { id } = await unknownReimbursee();
      const [flag] = await listOpenFlags(FINANCE);
      await expect(checkOffFlag(FINANCE, flag.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await listOpenFlags(FINANCE)).map((f) => f.kind)).toEqual(["REIMBURSEE_UNKNOWN"]);

      await db.expense.update({ where: { id }, data: { state: "rejected" } });
      await checkOffFlag(FINANCE, flag.id);
      expect(await listOpenFlags(FINANCE)).toEqual([]);
    });

    it("a card charge or a backfilled expense takes no reimbursee", async () => {
      const card = await seedExpense({ state: "qb_pending" });
      await expect(setReimbursee(ORG, card, 7, FINANCE)).rejects.toMatchObject({ statusCode: 400 });
      const { id } = await unknownReimbursee({ backfill: true });
      await expect(setReimbursee(ORG, id, 7, FINANCE)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it("an unbound directory fills no seat", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    await expect(signLine(principal(3, { isFinance: true }), li, "TREASURER")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describeDb("capital register", () => {
  it("capital review then depreciation mints one ITFA asset per unit, once", async () => {
    await db.capitalAsset.create({ data: { orgId: ORG, assetNumber: "ITFA07", description: "old", seeded: true } });
    const id = await seedExpense({ state: "capital_review" });
    const li = await seedLineItem(id, { quantity: 2, unitPriceCents: 90000, description: "Lathe" });

    await expect(submitCapitalReview(principal(2), id, { lineItems: [{ lineItemId: li, isCapital: true }] })).rejects.toMatchObject({ statusCode: 403 });
    await submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true }] });
    await setDepreciationCycle(FINANCE, id, { items: [{ lineItemId: li, depreciationYears: 5, ownerId: 100 }] });

    const assets = await db.capitalAsset.findMany({ where: { sourceLineItemId: li }, orderBy: { assetNumber: "asc" } });
    expect(assets.map((a) => a.assetNumber)).toEqual(["ITFA08", "ITFA09"]);
    expect((await db.expense.findFirst({ where: { id } }))!.state).toBe("qb_pending");
  });

  it("seeding is idempotent per asset number and canonicalizes it", async () => {
    const rows = [{ assetNumber: "itfa3", description: "Saw" }, { assetNumber: "BAD", description: "x" }];
    expect(await seedCapitalAssets(FINANCE, rows)).toMatchObject({ created: 1, skipped: 0, errors: 1 });
    expect(await seedCapitalAssets(FINANCE, rows)).toMatchObject({ created: 0, skipped: 1, errors: 1 });
    expect(await db.capitalAsset.findMany({ select: { assetNumber: true } })).toEqual([{ assetNumber: "ITFA03" }]);
  });
});

describeDb("flags", () => {
  it("a board flag is checked off by the board only, once, with an audit row", async () => {
    const id = await seedExpense();
    await raiseFlag(id, "THRESHOLD_CROSSED", "over $2k");
    await raiseFlag(id, "THRESHOLD_CROSSED");
    const [flag] = await listOpenFlags(BOARD);
    expect(await listOpenFlags(FINANCE)).toEqual([]);

    await expect(checkOffFlag(FINANCE, flag.id)).rejects.toMatchObject({ statusCode: 403 });
    await checkOffFlag(BOARD, flag.id, "seen");

    expect(await listOpenFlags(BOARD)).toEqual([]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "flag_checked_off", userId: 5 } })).toBe(1);
  });
});

describeDb("QuickBooks match inputs", () => {
  it("skips claimed and excluded ids; the takeover line is the newest hand-booked match", async () => {
    const early = await seedExpense();
    const late = await seedExpense();
    await db.expense.update({ where: { id: early }, data: { receiptDate: "2026-03-01" } });
    await db.expense.update({ where: { id: late }, data: { receiptDate: "2026-04-01" } });
    const a = await seedLineItem(early);
    const b = await seedLineItem(late);
    await db.expenseLineItem.update({ where: { id: a }, data: { qbMatchState: "MATCHED", qbTxnId: "qb-1" } });
    await db.expenseLineItem.update({ where: { id: b }, data: { qbMatchState: "CREATED", qbTxnId: "qb-2" } });
    expect((await qbMatchInputs()).takeoverDate).toBe("2026-03-01");

    await excludeQbTxn(FINANCE, "qb-9", "hand-booked, no receipt");
    await expect(excludeQbTxn(FINANCE, "qb-9", "again")).rejects.toMatchObject({ statusCode: 409 });

    expect((await qbMatchInputs()).skipIds.sort()).toEqual(["qb-1", "qb-2", "qb-9"]);
  });

  it("with no hand-booked match there is no takeover line", async () => {
    expect(await qbMatchInputs()).toEqual({ skipIds: [], takeoverDate: null });
  });

  it("a QuickBooks entry is claimed by one line at most", async () => {
    const id = await seedExpense();
    const a = await seedLineItem(id);
    const b = await seedLineItem(id);
    await db.expenseLineItem.update({ where: { id: a }, data: { qbTxnId: "qb-1" } });
    await expect(db.expenseLineItem.update({ where: { id: b }, data: { qbTxnId: "qb-1" } })).rejects.toThrow();
  });
});
