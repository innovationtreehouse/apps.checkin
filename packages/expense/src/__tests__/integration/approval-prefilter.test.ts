/**
 * The approval prefilter over random expenses: it keeps exactly the expenses with a line
 * approvalRefusal lets the caller approve, and the badge read through it finds exactly what reading
 * every open candidate with lineActions finds.
 */
import { expect, it } from "vitest";
import { db } from "../../db";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, ORG, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { APPROVABLE_STATUSES, approvableByCallerWhere, approvalRefusal } from "../../lib/signoff";
import { signoffFactsForExpenses } from "../../lib/signoff-facts";
import { allExpensesAwaitingMyApproval, approvalPoll, expenseActionCounts, signoffsAwaitingCount } from "../../services/badgeCounts";
import { callerLines } from "../../services/signoffService";
import type { ExpensePrincipal } from "../../contract";

// Households {1,2,12} {3,4,10} {6,7} {8,9}; 5 and 11 alone; 12 merged away into 1. Buckets 100, 200, 300 and org-level 7.
const DIRECTORY = {
  approvers: { 100: [2, 3], 200: [4, 6], 300: [8] },
  owners: { 100: 2, 200: 4, 300: 11 },
  orgLevel: [7],
  finance: [3, 9],
  board: [5, 6],
  households: [[1, 2, 12], [3, 4, 10], [6, 7], [8, 9]],
  merged: { 12: 1 },
};
const PEOPLE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const CALLERS: ExpensePrincipal[] = PEOPLE.filter((id) => id !== 12).map((id) => principal(id, { isFinance: DIRECTORY.finance.includes(id), isBoard: DIRECTORY.board.includes(id) }));

const dir = directory(DIRECTORY);

/** A small seeded PRNG (mulberry32), so a failing run reseeds the same expenses. */
function random(seed: number) {
  let t = seed;
  const next = () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  return { chance: (p: number) => next() < p, pick, person: () => pick(PEOPLE) };
}

async function seedRandomExpenses(seed: number, count: number): Promise<void> {
  const r = random(seed);
  for (let i = 0; i < count; i++) {
    const needsReimbursement = r.chance(0.5);
    const id = await seedExpense({
      state: r.chance(0.85) ? "owner_approval" : r.pick(["assign_ownership", "qb_pending"]),
      backfill: r.chance(0.05),
      submitterId: r.person(),
      needsReimbursement,
      ...(needsReimbursement && r.chance(0.85) ? { reimburseePersonId: r.person() } : {}),
      submittedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
    });
    if (r.chance(0.15)) await db.expense.update({ where: { id }, data: { boardAuthorization: "test", boardAuthorizedByUserId: r.person() } });
    const lines = r.pick([1, 1, 2, 3]);
    for (let l = 0; l < lines; l++) {
      const lineItemId = await seedLineItem(id);
      const status = r.pick(["pending", "pending", "pending", "finance_assigned", "approved", "exception_raised"]);
      await seedApproval(id, lineItemId, {
        ownerId: r.chance(0.05) ? null : r.pick([100, 200, 300, 7]),
        status,
        ...(status === "approved" && r.chance(0.8) ? { decidedByUserId: r.person() } : {}),
      });
      const signers = new Set<number>();
      for (const [seat, p] of [["SUBMITTER", needsReimbursement ? 0.6 : 0], ["TREASURER", 0.2], ["BOARD", 0.1]] as const) {
        const signer = r.person();
        if (!r.chance(p) || signers.has(signer)) continue;
        signers.add(signer);
        await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId, seat, signerUserId: signer } });
      }
    }
  }
}

/** The expenses with a line approvalRefusal lets the caller approve, read without the prefilter. */
async function approvableByRule(p: ExpensePrincipal): Promise<Set<string>> {
  const expenses = await db.expense.findMany({ where: { orgId: ORG, state: "owner_approval", backfill: false } });
  const facts = await signoffFactsForExpenses(db, expenses, { readOnly: true });
  const out = new Set<string>();
  for (const e of expenses) {
    const { byLine, filled, approvals } = facts.get(e.id)!;
    for (const [lineId, f] of byLine) {
      if (APPROVABLE_STATUSES.has(approvals.get(lineId)?.status ?? "") && approvalRefusal(f, filled.get(lineId) ?? [], p.id) === null) out.add(e.id);
    }
  }
  return out;
}

/** The ids of the expenses the prefilter keeps for the caller. */
async function prefiltered(p: ExpensePrincipal): Promise<string[]> {
  const where = approvableByCallerWhere(p.id, await dir.householdIds(p.id), await dir.bucketsApprovedBy(p.id), p.isBoard);
  return (await db.expense.findMany({ where: { orgId: ORG, ...where }, select: { id: true } })).map((e) => e.id).sort();
}

/** What the badge read finds when it reads every open expense in owner approval with lineActions. */
async function awaitingByEveryCandidate(p: ExpensePrincipal) {
  const expenses = await db.expense.findMany({
    where: { orgId: ORG, state: "owner_approval", backfill: false },
    orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
  });
  const out = [];
  for (const e of expenses) {
    const lineItemIds = (await callerLines(p, e, true)).filter((l) => l.actions.some((a) => a.act === "approve" && a.primary)).map((l) => l.lineItemId);
    if (lineItemIds.length > 0) out.push({ expenseId: e.id, lineItemIds });
  }
  return out;
}


describeDb("the approval prefilter", () => {
  for (const seed of [1, 2, 3]) {
    it(`keeps exactly the expenses with a line the caller may approve (seed ${seed})`, async () => {
      bindPorts({ signoff: dir });
      await seedRandomExpenses(seed, 60);
      for (const p of CALLERS) {
        const kept = await prefiltered(p);
        // Dropping an allowed expense loses work; keeping a refused one means a clause is missing.
        expect(kept, `caller ${p.id}`).toEqual([...(await approvableByRule(p))].sort());
      }
    });

    it(`finds what lineActions finds over every candidate (seed ${seed})`, async () => {
      bindPorts({ signoff: dir });
      await seedRandomExpenses(seed, 60);
      for (const p of CALLERS) {
        expect(await allExpensesAwaitingMyApproval(p), `caller ${p.id}`).toEqual(await awaitingByEveryCandidate(p));
      }
    });
  }
});

describeDb("the approval prefilter and a merged-away party", () => {
  it("leaves out an expense whose merged-away submitter shares the caller's household", async () => {
    bindPorts({ signoff: dir });
    const id = await seedExpense({ state: "owner_approval", submitterId: 12 });
    await seedApproval(id, await seedLineItem(id), { ownerId: 100 });
    const approver = CALLERS[1];
    const { byLine, filled } = (await signoffFactsForExpenses(db, [await db.expense.findUniqueOrThrow({ where: { id } })])).get(id)!;
    const [[lineId, facts]] = [...byLine];
    expect(approvalRefusal(facts, filled.get(lineId) ?? [], approver.id)).not.toBeNull();
    expect(await prefiltered(approver)).toEqual([]);
  });
});

describeDb("one approval read per nav poll", () => {
  it("reads once and gives the approver pill and the owner-approval count the same expenses", async () => {
    bindPorts({ signoff: dir });
    await seedRandomExpenses(1, 20);
    const p = CALLERS[1];
    const poll = approvalPoll(p);
    const [lines, counts, expenses] = await Promise.all([signoffsAwaitingCount(p, poll), expenseActionCounts(p, poll), poll()]);
    expect(await poll()).toBe(expenses);
    expect(lines).toBe(expenses.reduce((n, e) => n + e.lineItemIds.length, 0));
    expect(counts.owner_approval).toBe(expenses.length);
  });
});
