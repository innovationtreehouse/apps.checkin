/**
 * The expense list's per-view action counts: each counts only what the viewer can act on, leaves
 * out expenses the server would refuse a conflicted viewer, and gives Board-only viewers nothing
 * for FINANCE-only steps.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { db } from "../../db";
import { expenseActionCounts } from "../../services/badgeCounts";
import { financeQueueCounts } from "../../services/financeQueueService";
import type { ExpensePrincipal } from "../../contract";
import type { Seat } from "../../lib/signoff";

// submitter 1 · approvers 2 and 9 (bucket 100), 6 (bucket 200) · finance 3 and 8 · board 5 · 8 and 9 in the submitter's household
const FINANCE = principal(3, { isFinance: true });
const CONFLICTED_FINANCE = principal(8, { isFinance: true });
const BOARD = principal(5, { isBoard: true });
const APPROVER = principal(2);
const CONFLICTED_APPROVER = principal(9);
const OTHER_APPROVER = principal(6);

const NONE = {
  assign_ownership: 0,
  owner_approval: 0,
  owner_exception: 0,
  capital_review: 0,
  set_depreciation_cycle: 0,
  qb_pending: 0,
};

const counts = (p: ExpensePrincipal) => expenseActionCounts(p);

async function seedLine(state: string, approval: { ownerId?: number | null; status?: string } = {}, opts: Parameters<typeof seedExpense>[0] = {}) {
  const id = await seedExpense({ state, submitterId: 1, ...opts });
  const li = await seedLineItem(id);
  await seedApproval(id, li, approval);
  return { id, li };
}

async function sign(expenseId: string, lineItemId: number, seats: Partial<Record<Seat, number>>) {
  for (const [seat, signerUserId] of Object.entries(seats)) {
    await db.expenseLineSignoff.create({ data: { expenseId, lineItemId, seat, signerUserId } });
  }
}

describeDb("expense action counts", () => {
  beforeEach(() => {
    bindPorts({
      signoff: directory({ approvers: { 100: [2, 9], 200: [6] }, finance: [3, 8], board: [5], households: [[1, 8, 9]] }),
    });
  });

  it("counts nothing when no queue has work", async () => {
    expect(await counts(FINANCE)).toEqual(NONE);
  });

  it("leaves out a view whose count fails and still counts the others", async () => {
    await seedLine("capital_review", { ownerId: 100, status: "approved" });
    const failing = directory({ finance: [3], board: [5] });
    bindPorts({ signoff: { ...failing, bucketsApprovedBy: async () => { throw new Error("directory down"); } } });
    expect(await counts(FINANCE)).toEqual({ assign_ownership: 0, owner_exception: 0, capital_review: 1, set_depreciation_cycle: 0, qb_pending: 0 });
  });

  describe("assign ownership", () => {
    beforeEach(() => seedLine("assign_ownership", { ownerId: null }));

    it("counts an unassigned line's expense for FINANCE", async () => {
      expect(await counts(FINANCE)).toEqual({ ...NONE, assign_ownership: 1 });
    });

    it("leaves it out for a conflicted FINANCE holder, the Board and an approver", async () => {
      expect(await counts(CONFLICTED_FINANCE)).toEqual(NONE);
      expect(await counts(BOARD)).toEqual(NONE);
      expect(await counts(APPROVER)).toEqual(NONE);
    });
  });

  describe("owner approval", () => {
    beforeEach(async () => {
      await seedLine("owner_approval", { ownerId: 100 });
      await seedLine("owner_approval", { ownerId: 100 });
      await seedLine("owner_approval", { ownerId: 200 });
      await seedLine("owner_approval", { ownerId: 100, status: "approved" });
      await seedLine("assign_ownership", { ownerId: 100 });
    });

    it("counts expenses with a pending line in the viewer's own buckets", async () => {
      expect(await counts(APPROVER)).toEqual({ ...NONE, owner_approval: 2 });
      expect(await counts(OTHER_APPROVER)).toEqual({ ...NONE, owner_approval: 1 });
    });

    it("counts an expense whose line finance moved into the viewer's bucket", async () => {
      await seedLine("owner_approval", { ownerId: 200, status: "finance_assigned" });
      expect(await counts(OTHER_APPROVER)).toEqual({ ...NONE, owner_approval: 2 });
    });

    it("counts an expense with several pending lines once, as the list shows it", async () => {
      const { id } = await seedLine("owner_approval", { ownerId: 200 });
      await seedApproval(id, await seedLineItem(id), { ownerId: 200 });
      expect(await counts(OTHER_APPROVER)).toEqual({ ...NONE, owner_approval: 2 });
    });

    it("leaves out lines the approver is conflicted on", async () => {
      expect(await counts(CONFLICTED_APPROVER)).toEqual(NONE);
    });

    it("gives FINANCE and the Board no count for buckets they do not approve", async () => {
      expect(await counts(FINANCE)).toEqual(NONE);
      expect(await counts(BOARD)).toEqual(NONE);
    });
  });

  describe("exceptions", () => {
    beforeEach(() => seedLine("owner_approval", { ownerId: 100, status: "exception_raised" }));

    it("counts an expense with a raised exception for FINANCE", async () => {
      expect(await counts(FINANCE)).toEqual({ ...NONE, owner_exception: 1 });
    });

    it("leaves it out for a conflicted FINANCE holder, the Board and the bucket's approver", async () => {
      expect(await counts(CONFLICTED_FINANCE)).toEqual(NONE);
      expect(await counts(BOARD)).toEqual(NONE);
      expect(await counts(APPROVER)).toEqual(NONE);
    });
  });

  describe("capital review and depreciation", () => {
    beforeEach(async () => {
      await seedLine("capital_review", { ownerId: 100, status: "approved" });
      await seedLine("set_depreciation_cycle", { ownerId: 100, status: "approved" });
    });

    it("counts each for every FINANCE holder, conflicted or not: classifying is bookkeeping", async () => {
      const both = { ...NONE, capital_review: 1, set_depreciation_cycle: 1 };
      expect(await counts(FINANCE)).toEqual(both);
      expect(await counts(CONFLICTED_FINANCE)).toEqual(both);
    });

    it("gives the Board and an approver no count", async () => {
      expect(await counts(BOARD)).toEqual(NONE);
      expect(await counts(APPROVER)).toEqual(NONE);
    });
  });

  describe("QB pending", () => {
    it("counts a reimbursement with no reimbursee for FINANCE only, and not when it is conflicted", async () => {
      await seedLine("qb_pending", { ownerId: 100, status: "approved" }, { needsReimbursement: true });
      expect(await counts(FINANCE)).toEqual({ ...NONE, qb_pending: 1 });
      expect(await counts(CONFLICTED_FINANCE)).toEqual(NONE);
      expect(await counts(BOARD)).toEqual(NONE);
    });

    it("leaves an open Treasurer seat to the finance queue's To sign count", async () => {
      const { id, li } = await seedLine("qb_pending", { ownerId: 100, status: "approved" });
      await sign(id, li, { SUBMITTER: 1 });
      expect(await counts(FINANCE)).toEqual(NONE);
      expect((await financeQueueCounts(FINANCE)).toSign).toMatchObject({ actionable: 1 });
      expect((await financeQueueCounts(CONFLICTED_FINANCE)).toSign).toMatchObject({ actionable: 0 });
      expect((await financeQueueCounts(BOARD)).toSign).toMatchObject({ actionable: 0 });
    });

    it("freezes no Everyday check while counting", async () => {
      const { id, li } = await seedLine("qb_pending", { ownerId: 100, status: "approved" });
      await sign(id, li, { SUBMITTER: 1 });
      await counts(FINANCE);
      await counts(BOARD);
      expect((await db.expense.findUniqueOrThrow({ where: { id } })).everydayWithinLimits).toBeNull();
    });

    it("leaves out a fully signed expense and one where only the submitter seat is open", async () => {
      const signed = await seedLine("qb_pending", { ownerId: 100, status: "approved" });
      await sign(signed.id, signed.li, { SUBMITTER: 1, TREASURER: 3 });
      const submitterOpen = await seedLine("qb_pending", { ownerId: 100, status: "approved" });
      await sign(submitterOpen.id, submitterOpen.li, { TREASURER: 3 });
      expect(await counts(FINANCE)).toEqual(NONE);
    });

    it("leaves a Board seat on an org-level card charge to the finance queue's Board count, once the Treasurer has signed", async () => {
      bindPorts({ signoff: directory({ orgLevel: [7], finance: [3], board: [5], households: [[1, 8, 9]] }) });
      const { id, li } = await seedLine("qb_pending", { ownerId: 7, status: "approved" }, { receiptTotalCents: 100_000 });
      // The Board signs after the Treasurer, so the seat is not the Board's to give yet.
      expect((await financeQueueCounts(BOARD)).board.byReason.BOARD_SIGNATURE ?? 0).toBe(0);

      await sign(id, li, { TREASURER: 3 });
      expect(await counts(BOARD)).toEqual(NONE);
      expect((await financeQueueCounts(BOARD)).board.byReason.BOARD_SIGNATURE).toBeGreaterThan(0);
    });

    it("gives a FINANCE holder who approves the bucket no count once another Treasurer has signed", async () => {
      bindPorts({ signoff: directory({ approvers: { 100: [3] }, finance: [3, 4], board: [5] }) });
      const { id, li } = await seedLine("qb_pending", { ownerId: 100, status: "approved" });
      await sign(id, li, { SUBMITTER: 1, TREASURER: 4 });
      expect(await counts(FINANCE)).toEqual(NONE);
    });

    it("gives an approver who holds no role no QB pending count", async () => {
      const { id, li } = await seedLine("qb_pending", { ownerId: 100, status: "approved" });
      await sign(id, li, { SUBMITTER: 1 });
      expect(await counts(APPROVER)).toEqual(NONE);
    });
  });
});
