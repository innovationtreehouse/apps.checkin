/**
 * Handler-side bucket filtering on the approver routes (#1272 §5). The registry admits any
 * bucket approver to these routes; the factories must then confine each caller to the buckets
 * they approve. One case per approver route: an admitted caller who approves no bucket of the
 * expense reads zero rows, and an expense in another bucket answers 404.
 */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { db } from "../../db";
import { expenses } from "../../routes";
import { SIGNOFF_BADGE_EXPENSE_CAP, expenseOpsCounts, signoffsAwaitingCount } from "../../services/badgeCounts";
import type { ExpenseRouteHandler } from "../../contract";

const OWN_BUCKET = 100;
const OTHER_BUCKET = 200;
const APPROVER = 2;
// Approves OTHER_BUCKET only: admitted by the expense-approver gate, but no approver of OWN_BUCKET.
const OUTSIDER = 5;

let expenseId: string;
let lineItemId: number;
let approvalId: number;

function as(personId: number) {
  bindPorts({
    auth: { getPrincipal: async () => principal(personId) },
    signoff: directory({ approvers: { [OWN_BUCKET]: [APPROVER], [OTHER_BUCKET]: [OUTSIDER] } }),
  });
}

function call(route: ExpenseRouteHandler, path: string, params: Record<string, string> = {}, body?: unknown) {
  const req = new Request(`http://test/api/expense${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  return route({ req, params });
}

const ids = () => ({ id: expenseId, approvalId: String(approvalId), lineItemId: String(lineItemId) });

describeDb("approver routes filter to the caller's buckets", () => {
  beforeEach(async () => {
    expenseId = await seedExpense({ state: "owner_approval", submitterId: 1 });
    lineItemId = await seedLineItem(expenseId);
    approvalId = await seedApproval(expenseId, lineItemId, { ownerId: OWN_BUCKET });
  });

  it("control: the bucket's approver reads the expense", async () => {
    as(APPROVER);
    expect(await call(expenses.list, "/expenses")).toMatchObject({ Expense: [{ id: expenseId }] });
  });

  it("GET expenses: zero rows", async () => {
    as(OUTSIDER);
    expect(await call(expenses.list, "/expenses")).toEqual({ Expense: [] });
  });

  it("GET expenses/count: zero", async () => {
    as(OUTSIDER);
    expect(await call(expenses.count, "/expenses/count")).toEqual({ ExpenseListCount: { total: 0 } });
  });

  it("GET queue: zero rows", async () => {
    as(OUTSIDER);
    expect(await call(expenses.queue, "/queue?view=owner_approval")).toEqual({ Expense: [] });
  });

  it("GET counts: every count zero", async () => {
    as(OUTSIDER);
    const { ExpenseCounts } = (await call(expenses.counts, "/counts")) as { ExpenseCounts: Record<string, number> };
    expect(Object.values(ExpenseCounts).every((n) => n === 0)).toBe(true);
  });

  it("GET expenses/[id]: 404", async () => {
    as(OUTSIDER);
    await expect(call(expenses.detail, `/expenses/${expenseId}`, ids())).rejects.toMatchObject({ status: 404 });
  });

  it("GET expenses/[id]/line-item-approvals: 404", async () => {
    as(OUTSIDER);
    await expect(call(expenses.lineItemApprovals, "/x", ids())).rejects.toMatchObject({ status: 404 });
  });

  it("GET expenses/[id]/signoffs: 404", async () => {
    as(OUTSIDER);
    await expect(call(expenses.signoffs, "/x", ids())).rejects.toMatchObject({ status: 404 });
  });

  it("POST …/approve: 404", async () => {
    as(OUTSIDER);
    await expect(call(expenses.approve, "/x", ids(), {})).rejects.toMatchObject({ status: 404 });
  });

  it("POST …/raise-exception: 404", async () => {
    as(OUTSIDER);
    await expect(call(expenses.raise, "/x", ids(), { notes: "not mine" })).rejects.toMatchObject({ status: 404 });
  });

  it("POST …/line-items/[lineItemId]/signoffs: the same 404 whatever the expense's state", async () => {
    as(OUTSIDER);
    const other = await seedExpense({ state: "owner_approval" });
    await expect(call(expenses.sign, "/x", { ...ids(), id: other }, { seat: "TREASURER" })).rejects.toMatchObject({ status: 404 });
    await expect(call(expenses.sign, "/x", ids(), { seat: "TREASURER" })).rejects.toMatchObject({ status: 404, message: "Line item not found" });
    const closed = await seedExpense({ state: "rejected" });
    const closedLine = await seedLineItem(closed);
    await seedApproval(closed, closedLine, { ownerId: OWN_BUCKET });
    await expect(call(expenses.sign, "/x", { id: closed, lineItemId: String(closedLine) }, { seat: "SUBMITTER" })).rejects.toMatchObject({ status: 404, message: "Line item not found" });
  });

  it("POST …/line-items/[lineItemId]/signoffs: no program-approver seat to sign", async () => {
    as(APPROVER);
    await expect(call(expenses.sign, "/x", ids(), { seat: "PROGRAM_APPROVER" })).rejects.toMatchObject({ status: 400 });
  });
});

describeDb("nav badge counts", () => {
  beforeEach(async () => {
    expenseId = await seedExpense({ state: "owner_approval", submitterId: 1 });
    lineItemId = await seedLineItem(expenseId);
    approvalId = await seedApproval(expenseId, lineItemId, { ownerId: OWN_BUCKET });
  });

  it("counts a line awaiting the bucket approver's approval, and nothing for an outsider", async () => {
    as(APPROVER);
    expect(await signoffsAwaitingCount(principal(APPROVER))).toBe(1);
    expect(await signoffsAwaitingCount(principal(OUTSIDER))).toBe(0);
  });

  it("skips expenses out of owner approval, lines already approved, and the caller's own, and examines a capped number of expenses", async () => {
    as(APPROVER);
    for (const opts of [{ state: "rejected" }, { state: "qb_pending" }, { state: "owner_approval", submitterId: APPROVER }]) {
      const id = await seedExpense({ submitterId: 1, ...opts });
      await seedApproval(id, await seedLineItem(id), { ownerId: OWN_BUCKET });
    }
    const approved = await seedExpense({ state: "owner_approval", submitterId: 1 });
    await seedApproval(approved, await seedLineItem(approved), { ownerId: OWN_BUCKET, status: "approved", decidedByUserId: 9 });
    expect(await signoffsAwaitingCount(principal(APPROVER))).toBe(1);

    for (let i = 0; i < SIGNOFF_BADGE_EXPENSE_CAP; i++) {
      const id = await seedExpense({ state: "owner_approval", submitterId: 1 });
      await seedApproval(id, await seedLineItem(id), { ownerId: OWN_BUCKET });
    }
    expect(await signoffsAwaitingCount(principal(APPROVER))).toBe(SIGNOFF_BADGE_EXPENSE_CAP);
  });

  it("counts a line finance moved into the caller's bucket", async () => {
    as(APPROVER);
    const id = await seedExpense({ state: "owner_approval", submitterId: 1 });
    await seedApproval(id, await seedLineItem(id), { ownerId: OWN_BUCKET, status: "finance_assigned" });
    expect(await signoffsAwaitingCount(principal(APPROVER))).toBe(2);
  });

  it("older expenses already past the caller's approval do not crowd out a newer one awaiting it", async () => {
    as(APPROVER);
    const old = new Date("2026-01-01");
    for (let i = 0; i <= SIGNOFF_BADGE_EXPENSE_CAP; i++) {
      const id = await seedExpense({ state: "qb_pending", submitterId: 1 });
      const line = await seedLineItem(id);
      await seedApproval(id, line, { ownerId: OWN_BUCKET, status: "approved", decidedByUserId: 9 });
      await db.expense.update({ where: { id }, data: { submittedAt: old } });
    }
    expect(await signoffsAwaitingCount(principal(APPROVER))).toBe(1);
  });

  it("counts held expenses plus open flags for FINANCE, and nothing for an approver", async () => {
    as(APPROVER);
    await db.expenseHold.create({ data: { orgId: ORG, expenseId, lineItemId, reason: "NO_MATCH", matchedRows: "[]" } });
    await db.expenseFlag.create({ data: { orgId: ORG, expenseId, kind: "TAX_ATTACHED", audience: "FINANCE" } });
    expect(await expenseOpsCounts(principal(3, { isFinance: true }))).toEqual({ holds: 1, openFlags: 1 });
    expect(await expenseOpsCounts(principal(APPROVER))).toEqual({ holds: 0, openFlags: 0 });
  });
});
