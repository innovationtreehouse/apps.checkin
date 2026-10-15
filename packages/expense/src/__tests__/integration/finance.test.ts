/**
 * Sign-off hold, capital register, flags and QuickBooks match inputs against the real
 * database.
 */
import { describe, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { setReimbursee, signLine, signoffStatus } from "../../services/signoffService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { checkApprovalAutoTransition } from "../../lib/financial-flow";
import { setDepreciationCycle, seedCapitalAssets, submitCapitalReview } from "../../services/capitalService";
import { checkOffFlag, listOpenFlags, raiseFlag } from "../../services/flagService";
import { expenseOpsCounts } from "../../services/badgeCounts";
import { financeAssign, raiseException } from "../../services/approvalService";
import { excludeQbTxn, matchLineToQb, qbMatchInputs } from "../../services/qbMatchService";
import { inertQbReader, type QbTxn } from "../../contract";

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

  it("one household holds one seat on an expense: a FINANCE holder's spouse is refused, a Board member substitutes", async () => {
    // 3 holds FINANCE; 2, the program leader, is 3's spouse
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], households: [[1], [2, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 1 });
    const a = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    const b = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, a, { ownerId: 100, status: "approved" });
    await seedApproval(id, b, { ownerId: 100, status: "approved" });

    await signLine(FINANCE, a, "TREASURER");
    await expect(signLine(principal(2), a, "PROGRAM_APPROVER")).rejects.toMatchObject({ statusCode: 403 });
    await expect(signLine(principal(2), b, "PROGRAM_APPROVER")).rejects.toMatchObject({ statusCode: 403 });
    await signLine(BOARD, a, "PROGRAM_APPROVER");
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

  it("the Board signer behind a COI flag, and their household, cannot check it off, even once the seat is voided", async () => {
    // 9 shares a household with Board signer 5; 6 is an independent Board member
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3], board: [5, 6, 9], households: [[1, 3], [5, 9]] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    const approvalId = await seedApproval(id, li, { ownerId: 100 });
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    await signLine(principal(5, { isBoard: true }), li, "TREASURER");
    const flag = (await db.expenseFlag.findFirst({ where: { expenseId: id, kind: "COI" } }))!;

    // Moving the line to another bucket voids the Treasurer seat; the flag stays open.
    await raiseException(principal(2), id, approvalId, "not ours");
    await financeAssign(principal(4, { isFinance: true }), id, approvalId, 101);
    expect(await db.expenseLineSignoff.count({ where: { lineItemId: li, signerUserId: 5 } })).toBe(0);

    await expect(checkOffFlag(principal(5, { isBoard: true }), flag.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(checkOffFlag(principal(9, { isBoard: true }), flag.id)).rejects.toMatchObject({ statusCode: 403 });
    await checkOffFlag(principal(6, { isBoard: true }), flag.id);
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
      const { id, li } = await reimburseeLine({ approvers: [9], finance: [3] });
      await signLine(principal(9), li, "PROGRAM_APPROVER");
      await signLine(principal(3), li, "TREASURER");
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
      await signLine(principal(9, { isFinance: true }), li, "TREASURER");
      expect(await events(id)).toBe(1);
    });

    it("setting the reimbursee voids seats signed before it, so they are signed again for the payee", async () => {
      const { id, li } = await unknownReimbursee();
      await signAll(id, li);
      await setReimbursee(ORG, id, 7, FINANCE);
      expect(await events(id)).toBe(0);
      expect((await signoffStatus(id))[0].missing).toEqual(["PROGRAM_APPROVER", "TREASURER"]);
    });

    it("only FINANCE sets the reimbursee, never to themself or their own household", async () => {
      const { id } = await unknownReimbursee();
      await expect(setReimbursee(ORG, id, 7, principal(2))).rejects.toMatchObject({ statusCode: 403 });
      await expect(setReimbursee(ORG, id, 9, principal(9, { isFinance: true }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(setReimbursee(ORG, id, 9, principal(10, { isFinance: true }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(setReimbursee("org-other", id, 7, FINANCE)).rejects.toThrow(/not this org/);
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("FINANCE cannot name a reimbursee who is not a Person", async () => {
      const { id } = await unknownReimbursee();
      bindPorts({ signoff: directory({ finance: [3], unknownPeople: [42] }) });
      await expect(setReimbursee(ORG, id, 42, FINANCE)).rejects.toMatchObject({ statusCode: 404 });
      expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBeNull();
    });

    it("REIMBURSEE_UNKNOWN cannot be checked off while the hold applies; it leaves the queue once the expense is closed", async () => {
      const { id } = await unknownReimbursee();
      const [flag] = await listOpenFlags(FINANCE);
      await expect(checkOffFlag(FINANCE, flag.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await listOpenFlags(FINANCE)).map((f) => f.kind)).toEqual(["REIMBURSEE_UNKNOWN"]);

      await db.expense.update({ where: { id }, data: { state: "rejected" } });
      expect(await listOpenFlags(FINANCE)).toEqual([]);
      expect(await expenseOpsCounts(FINANCE)).toMatchObject({ openFlags: 0 });
      await checkOffFlag(FINANCE, flag.id);
    });

    it("a control flag on a closed expense stays in the queue", async () => {
      const { id } = await unknownReimbursee();
      await raiseFlag(id, "TAX_ATTACHED");
      await db.expense.update({ where: { id }, data: { state: "rejected" } });
      expect((await listOpenFlags(FINANCE)).map((f) => f.kind)).toEqual(["TAX_ATTACHED"]);
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

  it("capital review and depreciation refuse an archived or unlisted bucket", async () => {
    const id = await seedExpense({ state: "capital_review" });
    const li = await seedLineItem(id);

    await expect(submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true, capitalOwnerId: 999 }] })).rejects.toMatchObject({ statusCode: 400 });
    await submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true, capitalOwnerId: 100 }] });
    await expect(setDepreciationCycle(FINANCE, id, { items: [{ lineItemId: li, depreciationYears: 5, ownerId: 12345 }] })).rejects.toMatchObject({ statusCode: 400 });
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
   * A line of 100 cents dated 2026-05-01: a card charge, or a reimbursement owed to person 1.
   * QuickBooks holds the given Purchases and Bills; the card account is card-1 and person 1's
   * vendor is vendor-1 unless `refs` is false. The reader ignores the window, so the service's
   * own date check is what is tested.
   */
  async function qbLine(
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
    const li = await seedLineItem(id);
    if (opts.signed ?? true) await signAllLines(id);
    return li;
  }
  const linked = (li: number) => db.expenseLineItem.findUnique({ where: { id: li }, select: { qbTxnId: true, qbTxnEntity: true } });

  it("links a signed line to one of its own candidates and records the entity type", async () => {
    const li = await qbLine({ purchases: ["42"] });
    await matchLineToQb(FINANCE, li, "42");
    expect(await linked(li)).toEqual({ qbTxnId: "42", qbTxnEntity: "Purchase" });
  });

  it("refuses an id that is not among the line's candidates", async () => {
    const li = await qbLine({ purchases: ["42"] });
    await expect(matchLineToQb(FINANCE, li, "999")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses a line that is missing a sign-off", async () => {
    const li = await qbLine({ purchases: ["42"] }, { signed: false });
    await expect(matchLineToQb(FINANCE, li, "42")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses the same id under another entity type", async () => {
    const li = await qbLine({ bills: ["42"] });
    await expect(matchLineToQb(FINANCE, li, "42")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses an entry whose amount is off by a cent", async () => {
    const li = await qbLine({ purchases: [{ id: "42", totalCents: 101 }] });
    await expect(matchLineToQb(FINANCE, li, "42")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("refuses an entry dated a day outside the match window", async () => {
    const li = await qbLine({ purchases: [{ id: "42", txnDate: "2026-05-09" }, { id: "43", txnDate: "2026-04-23" }] });
    await expect(matchLineToQb(FINANCE, li, "42")).rejects.toMatchObject({ statusCode: 409 });
    await expect(matchLineToQb(FINANCE, li, "43")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("accepts an entry dated at the edge of the window", async () => {
    const li = await qbLine({ purchases: [{ id: "42", txnDate: "2026-05-08" }] });
    await matchLineToQb(FINANCE, li, "42");
    expect(await linked(li)).toEqual({ qbTxnId: "42", qbTxnEntity: "Purchase" });
  });

  it("refuses a Purchase booked against another payment account", async () => {
    const li = await qbLine({ purchases: [{ id: "42", accountRef: "card-2" }] });
    await expect(matchLineToQb(FINANCE, li, "42")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });

  it("links a reimbursement to a Bill for the reimbursee's vendor, never another vendor's", async () => {
    const li = await qbLine({ bills: ["42", { id: "43", vendorRef: "vendor-2" }] }, { reimbursement: true });
    await expect(matchLineToQb(FINANCE, li, "43")).rejects.toMatchObject({ statusCode: 409 });
    await matchLineToQb(FINANCE, li, "42");
    expect(await linked(li)).toEqual({ qbTxnId: "42", qbTxnEntity: "Bill" });
  });

  it("matches nothing while the host has not bound the QuickBooks refs", async () => {
    const li = await qbLine({ purchases: ["42"] }, { refs: false });
    await expect(matchLineToQb(FINANCE, li, "42")).rejects.toMatchObject({ statusCode: 409 });
    expect(await linked(li)).toEqual({ qbTxnId: null, qbTxnEntity: null });
  });
});
