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
import { expenseOpsCounts, signoffsAwaitingCount } from "../../services/badgeCounts";
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

  it("POST …/line-items/[lineItemId]/signoffs: 404 under another expense, refused on the line", async () => {
    as(OUTSIDER);
    const other = await seedExpense({ state: "owner_approval" });
    await expect(call(expenses.sign, "/x", { ...ids(), id: other }, { seat: "PROGRAM_APPROVER" })).rejects.toMatchObject({ status: 404 });
    await expect(call(expenses.sign, "/x", ids(), { seat: "PROGRAM_APPROVER" })).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("nav badge counts", () => {
  beforeEach(async () => {
    expenseId = await seedExpense({ state: "owner_approval", submitterId: 1 });
    lineItemId = await seedLineItem(expenseId);
    approvalId = await seedApproval(expenseId, lineItemId, { ownerId: OWN_BUCKET });
  });

  it("counts a line awaiting the bucket approver's sign-off, and nothing for an outsider", async () => {
    as(APPROVER);
    expect(await signoffsAwaitingCount(principal(APPROVER))).toBe(1);
    expect(await signoffsAwaitingCount(principal(OUTSIDER))).toBe(0);
  });

  it("counts held expenses plus open flags for FINANCE, and nothing for an approver", async () => {
    as(APPROVER);
    await db.expenseHold.create({ data: { orgId: ORG, expenseId, lineItemId, reason: "NO_MATCH", matchedRows: "[]" } });
    await db.expenseFlag.create({ data: { orgId: ORG, expenseId, kind: "TAX_ATTACHED", audience: "FINANCE" } });
    expect(await expenseOpsCounts(principal(3, { isFinance: true }))).toEqual({ holds: 1, openFlags: 1 });
    expect(await expenseOpsCounts(principal(APPROVER))).toEqual({ holds: 0, openFlags: 0 });
  });
});
