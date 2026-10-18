/**
 * Per-line approval services against the real database: bucket approvers, the finance
 * override, FINANCE assignment (incl. permanent and org-level), the reject path, racing
 * decisions, and decisions refused to the submitter's and reimbursee's households.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { signLine } from "../../services/signoffService";
import { approveLine, assignOwner, financeAssign, raiseException, rejectException } from "../../services/approvalService";

const LEADER = principal(2);
const FINANCE = principal(3, { isFinance: true });
const STRANGER = principal(9);

async function lineInApproval(ownerId: number | null = 100, status = "pending") {
  const id = await seedExpense({ state: ownerId === null ? "assign_ownership" : "owner_approval" });
  const li = await seedLineItem(id, { gtin13: "0000000000017" });
  return { id, li, approvalId: await seedApproval(id, li, { ownerId, status }) };
}
const approval = (id: number) => db.lineItemOwnerApproval.findFirst({ where: { id } });
const state = async (id: string) => (await db.expense.findFirst({ where: { id } }))!.state;

describeDb("approveLine", () => {
  it("an approver of the line's bucket approves; attribution comes from the principal", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();

    await approveLine(LEADER, id, approvalId);

    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 2 });
    expect(await state(id)).toBe("qb_pending");
  });

  it("a caller who approves no bucket is refused", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(STRANGER, id, approvalId)).rejects.toMatchObject({ status: 403 });
  });

  it("FINANCE overrides only with a comment, under a distinct audit action", async () => {
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(FINANCE, id, approvalId)).rejects.toMatchObject({ status: 400 });

    await approveLine(FINANCE, id, approvalId, "leader away");

    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "line_item_approved_finance_override" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 3, notes: "leader away" });
  });
});

describeDb("exceptions", () => {
  it("an approver raises an exception; FINANCE rejecting it refuses the whole expense", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();

    await raiseException(LEADER, id, approvalId, "not ours");
    await expect(rejectException(LEADER, id, approvalId, "no")).rejects.toMatchObject({ status: 403 });
    await rejectException(FINANCE, id, approvalId, "refusing this charge");

    expect(await approval(approvalId)).toMatchObject({ status: "rejected" });
    expect(await state(id)).toBe("rejected");
  });

  it("FINANCE assigning an exception proceeds", async () => {
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, id, approvalId, 101);
    expect(await approval(approvalId)).toMatchObject({ status: "finance_assigned", ownerId: 101 });
    expect(await state(id)).toBe("qb_pending");
  });
});

describeDb("assignOwner", () => {
  it("permanent assignment maps the part and assigns sibling lines in other expenses", async () => {
    const a = await lineInApproval(null);
    const b = await lineInApproval(null);

    await assignOwner(FINANCE, a.id, a.approvalId, 100, true);

    expect(await approval(b.approvalId)).toMatchObject({ ownerId: 100, status: "pending" });
    expect((await db.partOwnerMap.findFirst({ where: { orgId: ORG, gtin13: "0000000000017" } }))?.ownerId).toBe(100);
    expect(await state(a.id)).toBe("owner_approval");
    expect(await state(b.id)).toBe("owner_approval");
  });

  it("assigning an org-level bucket is the approval", async () => {
    bindPorts({ signoff: directory({ orgLevel: [7] }) });
    const { id, approvalId } = await lineInApproval(null);

    await assignOwner(FINANCE, id, approvalId, 7);

    expect(await approval(approvalId)).toMatchObject({ ownerId: 7, status: "approved", decidedByUserId: 3 });
    expect(await state(id)).toBe("qb_pending");
  });

  it("only FINANCE assigns", async () => {
    const { id, approvalId } = await lineInApproval(null);
    await expect(assignOwner(LEADER, id, approvalId, 100)).rejects.toMatchObject({ status: 403 });
  });
});

/** Resolves once `n` backends in this database are waiting on a row lock. */
async function blocked(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ c }] = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (c >= BigInt(n)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fewer than ${n} backends blocked on a lock`);
}

/** Holds `lock` until both racers have read and are waiting to write, then lets them go. */
async function race<A, B>(lock: string, a: () => Promise<A>, b: () => Promise<B>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const locked = new Promise<void>((r) => (held = r));
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(lock);
    held();
    await gate;
  }, { timeout: 20_000 });
  await locked;
  const settled = Promise.allSettled([a(), b()]);
  await blocked(2);
  release();
  await holder;
  return settled;
}

const rejection = (...results: PromiseSettledResult<unknown>[]): unknown =>
  results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;

describeDb("racing decisions", () => {
  it("of an approve and an exception on one pending line, exactly one lands; the other gets 409", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();

    const [approve, raise] = await race(
      `SELECT id FROM line_item_owner_approvals WHERE id = ${approvalId} FOR UPDATE`,
      () => approveLine(LEADER, id, approvalId),
      () => raiseException(LEADER, id, approvalId, "not ours"),
    );

    expect([approve.status, raise.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejection(approve, raise)).toMatchObject({ status: 409 });
    expect((await approval(approvalId))!.status).toBe(approve.status === "fulfilled" ? "approved" : "exception_raised");
    const decided = await db.expenseAuditLog.count({ where: { expenseId: id, action: { in: ["line_item_approved", "exception_raised"] } } });
    expect(decided).toBe(1);
  });

  it("of two bucket assignments read against the same owner, one lands and the seats match its bucket", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3, 6] }) });
    const { id, li, approvalId } = await lineInApproval(100);
    await db.expense.update({ where: { id }, data: { state: "assign_ownership" } });
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");

    const [same, moved] = await race(
      `SELECT id FROM expenses WHERE id = '${id}' FOR UPDATE`,
      () => assignOwner(FINANCE, id, approvalId, 100),
      () => assignOwner(principal(6, { isFinance: true }), id, approvalId, 101),
    );

    expect([same.status, moved.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejection(same, moved)).toMatchObject({ status: 409 });
    const owner = (await approval(approvalId))!.ownerId;
    expect(owner).toBe(same.status === "fulfilled" ? 100 : 101);
    const seats = (await db.expenseLineSignoff.findMany({ where: { lineItemId: li } })).map((s) => s.seat).sort();
    expect(seats).toEqual(owner === 100 ? ["PROGRAM_APPROVER", "SUBMITTER"] : ["SUBMITTER"]);
  });
});

describeDb("the submitter's and reimbursee's households decide none of their lines", () => {
  const SUBMITTER_FINANCE = principal(1, { isFinance: true });
  const HOUSEMATE_FINANCE = principal(6, { isFinance: true });
  const REIMBURSEE_FINANCE = principal(8, { isFinance: true });
  const untouched = async (approvalId: number, status: string) =>
    expect(await approval(approvalId)).toMatchObject({ status, decidedByUserId: null });

  it("raising an exception, even as the bucket's approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [6] }, households: [[1, 6]] }) });
    const { id, approvalId } = await lineInApproval();
    await expect(raiseException(SUBMITTER_FINANCE, id, approvalId, "x")).rejects.toMatchObject({ status: 403 });
    await expect(raiseException(principal(6), id, approvalId, "x")).rejects.toMatchObject({ status: 403 });
    await untouched(approvalId, "pending");
  });

  it("rejecting an exception", async () => {
    bindPorts({ signoff: directory({ households: [[1, 6]] }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await expect(rejectException(HOUSEMATE_FINANCE, id, approvalId, "no")).rejects.toMatchObject({ status: 403 });
    await untouched(approvalId, "exception_raised");
  });

  it("approving with a finance override", async () => {
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(SUBMITTER_FINANCE, id, approvalId, "mine")).rejects.toMatchObject({ status: 403 });
    await untouched(approvalId, "pending");
  });

  it("assigning an exception's bucket", async () => {
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await expect(financeAssign(SUBMITTER_FINANCE, id, approvalId, 101)).rejects.toMatchObject({ status: 403 });
    await untouched(approvalId, "exception_raised");
  });

  it("assigning a line's bucket, as a housemate or the reimbursee", async () => {
    bindPorts({ signoff: directory({ households: [[1, 6]] }) });
    const { id, approvalId } = await lineInApproval(null);
    await expect(assignOwner(HOUSEMATE_FINANCE, id, approvalId, 100)).rejects.toMatchObject({ status: 403 });

    const paid = await seedExpense({ state: "assign_ownership", needsReimbursement: true, reimburseePersonId: 8 });
    const paidApproval = await seedApproval(paid, await seedLineItem(paid), { ownerId: null });
    await expect(assignOwner(REIMBURSEE_FINANCE, paid, paidApproval, 100)).rejects.toMatchObject({ status: 403 });

    expect((await approval(approvalId))!.ownerId).toBeNull();
    expect((await approval(paidApproval))!.ownerId).toBeNull();
  });

  it("a permanent mapping leaves a sibling line on a conflicted expense unassigned", async () => {
    bindPorts({ signoff: directory({ households: [[1, 6]] }) });
    const target = await seedExpense({ state: "assign_ownership", submitterId: 4 });
    const targetApproval = await seedApproval(target, await seedLineItem(target, { gtin13: "0000000000017" }), { ownerId: null });
    const household = await lineInApproval(null);
    const stranger = await seedExpense({ state: "assign_ownership", submitterId: 4 });
    const strangerApproval = await seedApproval(stranger, await seedLineItem(stranger, { gtin13: "0000000000017" }), { ownerId: null });

    await assignOwner(HOUSEMATE_FINANCE, target, targetApproval, 100, true);

    expect((await approval(household.approvalId))!.ownerId).toBeNull();
    expect((await approval(strangerApproval))!.ownerId).toBe(100);
  });
});
