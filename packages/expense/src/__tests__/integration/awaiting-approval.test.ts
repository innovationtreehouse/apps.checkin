/**
 * The approver pill, its "Waiting on you" view and the owner-approval view count all come from
 * one rule (#2501 §8): per caller, the pill's lines are exactly the lines of the view's
 * expenses, and the owner-approval count is the number of those expenses.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { expenses } from "../../routes";
import { SIGNOFF_BADGE_CANDIDATE_CAP, SIGNOFF_BADGE_EXPENSE_CAP, expenseActionCounts, expensesAwaitingMyApproval, signoffsAwaitingCount } from "../../services/badgeCounts";
import type { ExpensePrincipal, ExpenseRouteHandler } from "../../contract";

// submitter 1 · approvers 2 and 9 (bucket 100), 6 (bucket 200) · org-level bucket 7 · finance 3 and 8 · board 5 · 8 and 9 in the submitter's household
const DIRECTORY = { approvers: { 100: [2, 9], 200: [6] }, orgLevel: [7], finance: [3, 8], board: [5], households: [[1, 8, 9]] };
const APPROVER = principal(2);
const CONFLICTED_APPROVER = principal(9);
const OTHER_APPROVER = principal(6);
const FINANCE = principal(3, { isFinance: true });
const CONFLICTED_FINANCE = principal(8, { isFinance: true });
const BOARD = principal(5, { isBoard: true });
const ROLES: [string, ExpensePrincipal][] = [
  ["a bucket approver", APPROVER],
  ["a conflicted bucket approver", CONFLICTED_APPROVER],
  ["another bucket's approver", OTHER_APPROVER],
  ["FINANCE", FINANCE],
  ["a conflicted FINANCE holder", CONFLICTED_FINANCE],
  ["a Board member", BOARD],
];

let caller: ExpensePrincipal;

function as(p: ExpensePrincipal) {
  caller = p;
  bindPorts({ signoff: directory(DIRECTORY) });
}

function call(route: ExpenseRouteHandler, path: string) {
  return route({ req: new Request(`http://test/api/expense${path}`), params: {}, principal: caller });
}

async function viewIds(p: ExpensePrincipal): Promise<string[]> {
  as(p);
  const { Expense } = (await call(expenses.list, "/expenses?view=awaiting_me")) as { Expense: { id: string }[] };
  return Expense.map((e) => e.id).sort();
}

/** The view's expense ids, or null when the caller can't act in it and the route refuses it. */
async function viewIdsOrHidden(p: ExpensePrincipal): Promise<string[] | null> {
  try {
    return await viewIds(p);
  } catch (err) {
    if ((err as { status?: number }).status === 403) return null;
    throw err;
  }
}

async function seedLines(opts: Parameters<typeof seedExpense>[0], approvals: { ownerId: number | null; status?: string }[]): Promise<string> {
  const id = await seedExpense({ state: "owner_approval", submitterId: 1, ...opts });
  for (const a of approvals) await seedApproval(id, await seedLineItem(id), a);
  return id;
}

describeDb("lines waiting on the caller's approval", () => {
  let both: string;
  let mixed: string;
  let moved: string;
  let orgLevel: string;
  let approversOwn: string;

  beforeEach(async () => {
    bindPorts({ signoff: directory(DIRECTORY) });
    both = await seedLines({}, [{ ownerId: 100 }, { ownerId: 200 }]);
    mixed = await seedLines({}, [{ ownerId: 100 }, { ownerId: 100 }, { ownerId: 100, status: "approved" }]);
    approversOwn = await seedLines({ submitterId: 2 }, [{ ownerId: 100 }]);
    await seedLines({ state: "assign_ownership" }, [{ ownerId: 100 }]);
    await seedLines({ state: "qb_pending" }, [{ ownerId: 100, status: "approved" }]);
    await seedLines({}, [{ ownerId: 100, status: "exception_raised" }]);
    await seedLines({ backfill: true }, [{ ownerId: 100 }]);
    moved = await seedLines({}, [{ ownerId: 100, status: "finance_assigned" }]);
    orgLevel = await seedLines({}, [{ ownerId: 7 }]);
  });

  describe.each(ROLES)("for %s", (_name, p) => {
    it("the pill counts exactly the lines of the view's expenses, and nothing when the view is hidden", async () => {
      as(p);
      const awaiting = await expensesAwaitingMyApproval(p);
      expect(await viewIdsOrHidden(p) ?? []).toEqual(awaiting.map((e) => e.expenseId).sort());
      expect(await signoffsAwaitingCount(p)).toBe(awaiting.reduce((n, e) => n + e.lineItemIds.length, 0));
    });

    it("the owner-approval count is the number of the view's expenses", async () => {
      as(p);
      expect((await expenseActionCounts(p)).owner_approval).toBe((await viewIdsOrHidden(p) ?? []).length);
    });
  });

  it("counts a bucket approver's pending and finance-assigned lines, leaving out their own receipt and other states", async () => {
    as(APPROVER);
    expect(await viewIds(APPROVER)).toEqual([both, mixed, moved].sort());
    expect(await signoffsAwaitingCount(APPROVER)).toBe(4);
    expect((await expenseActionCounts(APPROVER)).owner_approval).toBe(3);
  });

  it("counts for a Board member only the lines no bucket approver can approve", async () => {
    as(BOARD);
    expect(await viewIds(BOARD)).toEqual([orgLevel]);
    expect(await signoffsAwaitingCount(BOARD)).toBe(1);
    expect((await expenseActionCounts(BOARD)).owner_approval).toBe(1);
  });

  it("counts for a Board member a line whose only approver is conflicted", async () => {
    const ownReceipt = await seedLines({ submitterId: 6 }, [{ ownerId: 200 }]);
    as(BOARD);
    expect(await viewIds(BOARD)).toEqual([orgLevel, ownReceipt].sort());
    expect(await signoffsAwaitingCount(BOARD)).toBe(2);
    expect(await viewIds(OTHER_APPROVER)).toEqual([both]);
  });

  it("counts only the lines in the approver's own bucket", async () => {
    as(OTHER_APPROVER);
    expect(await viewIds(OTHER_APPROVER)).toEqual([both]);
    expect(await signoffsAwaitingCount(OTHER_APPROVER)).toBe(1);
  });

  it("counts nothing an approver is conflicted on, and still counts their bucket's other expenses", async () => {
    as(CONFLICTED_APPROVER);
    expect(await viewIds(CONFLICTED_APPROVER)).toEqual([approversOwn]);
    expect(await signoffsAwaitingCount(CONFLICTED_APPROVER)).toBe(1);
  });

  it("does not let newer expenses with nothing for the caller crowd older work out of the cap", async () => {
    for (let i = 0; i < SIGNOFF_BADGE_EXPENSE_CAP; i++) await seedLines({}, [{ ownerId: 100 }]);
    await seedLines({ needsReimbursement: true }, [{ ownerId: 100 }]);
    as(CONFLICTED_APPROVER);
    expect(await viewIds(CONFLICTED_APPROVER)).toEqual([approversOwn]);
    expect(await signoffsAwaitingCount(CONFLICTED_APPROVER)).toBe(1);
    expect((await expenseActionCounts(CONFLICTED_APPROVER)).owner_approval).toBe(1);
  });

  it("caps at the newest expenses that have work for the caller", async () => {
    for (let i = 0; i < SIGNOFF_BADGE_EXPENSE_CAP; i++) await seedLines({}, [{ ownerId: 200 }]);
    as(OTHER_APPROVER);
    expect(await viewIds(OTHER_APPROVER)).not.toContain(both);
    expect(await signoffsAwaitingCount(OTHER_APPROVER)).toBe(SIGNOFF_BADGE_EXPENSE_CAP);
  });

  it("reads at most the candidate cap, so older work past it is left out and nothing is overcounted", async () => {
    for (let i = 0; i < SIGNOFF_BADGE_CANDIDATE_CAP; i++) await seedLines({}, [{ ownerId: 100 }]);
    as(BOARD);
    expect(await viewIds(BOARD)).toEqual([]);
    expect(await signoffsAwaitingCount(BOARD)).toBe(0);
    expect((await expenseActionCounts(BOARD)).owner_approval).toBe(0);
  });

  it("finds a Board member's work as the last candidate inside the cap", async () => {
    for (let i = 0; i < SIGNOFF_BADGE_CANDIDATE_CAP - 1; i++) await seedLines({}, [{ ownerId: 100 }]);
    as(BOARD);
    expect(await viewIds(BOARD)).toEqual([orgLevel]);
    expect(await signoffsAwaitingCount(BOARD)).toBe(1);
  });

  it("counts nothing for FINANCE outside its own buckets, and hides the view from it", async () => {
    as(FINANCE);
    expect(await viewIdsOrHidden(FINANCE)).toBeNull();
    expect(await signoffsAwaitingCount(FINANCE)).toBe(0);
    expect((await expenseActionCounts(FINANCE)).owner_approval).toBe(0);
  });
});
