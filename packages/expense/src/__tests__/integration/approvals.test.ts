/**
 * Per-line approval services against the real database: bucket approvers, the Board stand-in
 * and its reason, the seat refusals the approval takes, FINANCE assignment (incl. permanent and
 * org-level), the reject path, racing decisions, what the submitter's and reimbursee's
 * households may and may not do on their lines, and Approve All.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, ORG, seedSubmitterSeat } from "../helpers/seed";
import { setReimbursee, signLine, signoffStatus } from "../../services/signoffService";
import { approveLine, approveLines, assignOwner, financeAssign, raiseException, rejectException, resolveUnknown } from "../../services/approvalService";

const LEADER = principal(2);
const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });
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

  it("FINANCE has no approve act outside its own buckets, with or without a comment", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3] }) });
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(FINANCE, id, approvalId)).rejects.toMatchObject({ status: 403 });
    await expect(approveLine(FINANCE, id, approvalId, "leader away")).rejects.toMatchObject({ status: 403 });
    expect(await approval(approvalId)).toMatchObject({ status: "pending" });
  });

  it("a FINANCE holder who approves the bucket approves as its approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [3] }, finance: [3] }) });
    const { id, approvalId } = await lineInApproval();
    await approveLine(FINANCE, id, approvalId);
    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 3, notes: null });
  });
});

describeDb("the reimbursee is known before the approval", () => {
  it("nobody approves a reimbursement line while its reimbursee is unknown; once FINANCE names them, the approver does", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { ownerId: 100 });

    await expect(approveLine(LEADER, id, approvalId)).rejects.toMatchObject({ status: 409 });
    await expect(approveLine(BOARD, id, approvalId, "leader away")).rejects.toMatchObject({ status: 409 });
    expect(await approval(approvalId)).toMatchObject({ status: "pending" });

    await setReimbursee(ORG, id, { personId: 1 }, FINANCE);
    await expect(approveLine(LEADER, id, approvalId)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not confirmed/) });
    await seedSubmitterSeat(li, 1);
    await approveLine(LEADER, id, approvalId);
    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 2 });
  });
});

describeDb("a Board stand-in", () => {
  it("approves a line whose approver could act, only with a reason, which is stored and audited", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, board: [5] }) });
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(BOARD, id, approvalId)).rejects.toMatchObject({ status: 400 });
    await expect(approveLine(BOARD, id, approvalId, "   ")).rejects.toMatchObject({ status: 400 });
    expect(await approval(approvalId)).toMatchObject({ status: "pending" });

    await approveLine(BOARD, id, approvalId, " leader silent for three weeks ");

    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 5, notes: "leader silent for three weeks" });
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "line_item_approved_board_stand_in" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 5, notes: "leader silent for three weeks" });
    expect(await state(id)).toBe("qb_pending");
  });

  it("a Board member who approves the bucket gives no reason", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [5] }, board: [5] }) });
    const { id, approvalId } = await lineInApproval();
    await approveLine(BOARD, id, approvalId);
    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 5, notes: null });
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "line_item_approved" } })).toBe(1);
  });

  it("is refused when conflicted", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, board: [5], households: [[1, 5]] }) });
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(BOARD, id, approvalId, "reason")).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("the approval takes the seat's refusals", () => {
  async function twoLines() {
    const id = await seedExpense({ state: "owner_approval" });
    const [a, b] = [await seedLineItem(id), await seedLineItem(id)];
    return { id, a, b, approvalA: await seedApproval(id, a, { ownerId: 100 }), approvalB: await seedApproval(id, b, { ownerId: 100 }) };
  }

  it("an approver whose household already holds a seat on the expense is refused", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], households: [[2, 3]] }) });
    const { id, a, approvalB } = await twoLines();
    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: a, seat: "TREASURER", signerUserId: 3 } });
    await expect(approveLine(LEADER, id, approvalB)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/household already signs off/) });
  });

  it("an approver whose household approved another line is refused", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2, 4] }, households: [[2, 4]] }) });
    const { id, approvalA, approvalB } = await twoLines();
    await approveLine(principal(4), id, approvalA);
    await expect(approveLine(LEADER, id, approvalB)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/household already signs off/) });
    await approveLine(principal(4), id, approvalB);
  });

  it("an approver who signed the line's Treasurer seat is refused", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [3] }, finance: [3] }) });
    const { id, a, approvalA } = await twoLines();
    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: a, seat: "TREASURER", signerUserId: 3 } });
    await expect(approveLine(FINANCE, id, approvalA)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/another seat/) });
  });
});

/** An expense in owner approval with one pending line per bucket, numbered from 1. */
async function linesInApproval(ownerIds: number[]) {
  const id = await seedExpense({ state: "owner_approval" });
  const approvalIds: number[] = [];
  for (const [i, ownerId] of ownerIds.entries()) {
    const li = await seedLineItem(id);
    await db.expenseLineItem.update({ where: { id: li }, data: { lineNumber: i + 1 } });
    approvalIds.push(await seedApproval(id, li, { ownerId }));
  }
  return { id, approvalIds };
}
const statuses = async (ids: number[]) =>
  (await db.lineItemOwnerApproval.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } })).map((a) => a.status);

describeDb("approveLines (Approve All)", () => {
  it("approves every listed line the caller approves, and the expense moves on", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [2] } }) });
    const { id, approvalIds } = await linesInApproval([100, 101]);

    await approveLines(LEADER, id, approvalIds);

    expect(await statuses(approvalIds)).toEqual(["approved", "approved"]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "line_item_approved", userId: 2 } })).toBe(2);
    expect(await state(id)).toBe("qb_pending");
  });

  it("a retry of a batch that committed succeeds and writes nothing", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [2], 102: [2] } }) });
    const { id, approvalIds } = await linesInApproval([100, 101, 102]);
    const batch = approvalIds.slice(0, 2);

    await approveLines(LEADER, id, batch);
    await approveLines(LEADER, id, batch);

    expect(await statuses(approvalIds)).toEqual(["approved", "approved", "pending"]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "line_item_approved" } })).toBe(2);
  });

  it("a retry succeeds after the batch moved the expense on", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [2] } }) });
    const { id, approvalIds } = await linesInApproval([100, 101]);

    await approveLines(LEADER, id, approvalIds);
    await approveLines(LEADER, id, approvalIds);

    expect(await state(id)).toBe("qb_pending");
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "line_item_approved" } })).toBe(2);
  });

  it("a line someone else approved still refuses the batch", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2, 9], 101: [2] } }) });
    const { id, approvalIds } = await linesInApproval([100, 101]);
    await db.lineItemOwnerApproval.update({ where: { id: approvalIds[0] }, data: { status: "approved", decidedByUserId: 9 } });

    await expect(approveLines(LEADER, id, approvalIds)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^Line 1: Item is not in pending status/) });
    expect(await statuses(approvalIds)).toEqual(["approved", "pending"]);
  });

  it("approves none when one line is refused, and the error names that line", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [7] } }) });
    const { id, approvalIds } = await linesInApproval([100, 101]);

    await expect(approveLines(LEADER, id, approvalIds)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Line 2: /) });

    expect(await statuses(approvalIds)).toEqual(["pending", "pending"]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "line_item_approved" } })).toBe(0);
    expect(await state(id)).toBe("owner_approval");
  });

  it("approves none when the caller may approve none of the lines", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [2] } }) });
    const { id, approvalIds } = await linesInApproval([100, 101]);

    await expect(approveLines(STRANGER, id, approvalIds)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Line 1: /) });

    expect(await statuses(approvalIds)).toEqual(["pending", "pending"]);
  });

  it("refuses a Board stand-in line a bucket approver could approve", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [5], 101: [2] }, board: [5] }) });
    const { id, approvalIds } = await linesInApproval([100, 101]);

    await expect(approveLines(BOARD, id, approvalIds)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Line 2: A bucket approver can approve/) });

    expect(await statuses(approvalIds)).toEqual(["pending", "pending"]);
  });

  it("approves org-level lines, where the Board is the only one who can act, as a stand-in", async () => {
    bindPorts({ signoff: directory({ orgLevel: [300], board: [5] }) });
    const { id, approvalIds } = await linesInApproval([300, 300]);

    await approveLines(BOARD, id, approvalIds);

    expect(await statuses(approvalIds)).toEqual(["approved", "approved"]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "line_item_approved_board_stand_in", userId: 5 } })).toBe(2);
  });

  it("approves none while a reimbursement line waits for its submitter's signature", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true });
    const [a, b] = [await seedLineItem(id), await seedLineItem(id)];
    await db.expenseLineItem.update({ where: { id: b }, data: { lineNumber: 2 } });
    const approvalIds = [await seedApproval(id, a, { ownerId: 100 }), await seedApproval(id, b, { ownerId: 100 })];
    await setReimbursee(ORG, id, { personId: 1 }, FINANCE);
    await seedSubmitterSeat(a, 1);

    await expect(approveLines(LEADER, id, approvalIds)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Line 2: .*not confirmed/) });
    expect(await statuses(approvalIds)).toEqual(["pending", "pending"]);

    await seedSubmitterSeat(b, 1);
    await approveLines(LEADER, id, approvalIds);
    expect(await statuses(approvalIds)).toEqual(["approved", "approved"]);
  });

  it("refuses an empty list and an approval from another expense", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalIds } = await linesInApproval([100]);
    const other = await linesInApproval([100]);

    await expect(approveLines(LEADER, id, [])).rejects.toMatchObject({ status: 400 });
    await expect(approveLines(LEADER, id, [...approvalIds, ...other.approvalIds])).rejects.toMatchObject({ status: 404 });
    expect(await statuses([...approvalIds, ...other.approvalIds])).toEqual(["pending", "pending"]);
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

  it("a line FINANCE moves to another bucket waits for that bucket's approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] } }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, id, approvalId, 101);
    expect(await approval(approvalId)).toMatchObject({ status: "finance_assigned", ownerId: 101 });
    expect(await state(id)).toBe("owner_approval");

    await expect(approveLine(LEADER, id, approvalId)).rejects.toMatchObject({ status: 403 });
    await approveLine(principal(4), id, approvalId);
    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 4 });
    expect(await state(id)).toBe("qb_pending");
  });
});

describeDb("the exception loop and a final bucket", () => {
  const NEW_APPROVER = principal(4);

  it("the new bucket's approver may raise another exception; finance moves the line again and its approver approves", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] } }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, id, approvalId, 101);

    await raiseException(NEW_APPROVER, id, approvalId, "not ours either");
    expect(await approval(approvalId)).toMatchObject({ status: "exception_raised", ownerId: 101 });
    await financeAssign(FINANCE, id, approvalId, 100);
    await approveLine(LEADER, id, approvalId);
    expect(await state(id)).toBe("qb_pending");
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "exception_raised" } })).toBe(1);
  });

  it("making the bucket final takes a note, kept on the approval and audited", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] } }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await expect(financeAssign(FINANCE, id, approvalId, 101, true)).rejects.toMatchObject({ status: 400 });
    await expect(financeAssign(FINANCE, id, approvalId, 101, true, "  ")).rejects.toMatchObject({ status: 400 });
    expect(await approval(approvalId)).toMatchObject({ status: "exception_raised", bucketFinal: false });

    await financeAssign(FINANCE, id, approvalId, 101, true, " Grant 12 pays for robotics kits ");

    expect(await approval(approvalId)).toMatchObject({ status: "finance_assigned", ownerId: 101, bucketFinal: true, notes: "Grant 12 pays for robotics kits" });
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "bucket_made_final" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 3, valueAfter: "101", notes: "Grant 12 pays for robotics kits" });
  });

  it("no exception is raised on a final line; its approver approves it, or a Board member stands in", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, board: [5] }) });
    const first = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, first.id, first.approvalId, 101, true, "budget line 4");
    await expect(raiseException(NEW_APPROVER, first.id, first.approvalId, "still not ours")).rejects.toMatchObject({ status: 409 });
    await expect(raiseException(FINANCE, first.id, first.approvalId, "x")).rejects.toMatchObject({ status: 409 });
    expect(await approval(first.approvalId)).toMatchObject({ status: "finance_assigned" });
    await approveLine(NEW_APPROVER, first.id, first.approvalId);
    expect(await approval(first.approvalId)).toMatchObject({ status: "approved", decidedByUserId: 4 });

    const second = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, second.id, second.approvalId, 101, true, "budget line 4");
    await approveLine(BOARD, second.id, second.approvalId, "approver away");
    expect(await approval(second.approvalId)).toMatchObject({ status: "approved", decidedByUserId: 5 });
  });

  it("a final assignment is not an approval: the expense waits for the bucket's approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] } }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, id, approvalId, 101, true, "budget line 4");
    expect(await state(id)).toBe("owner_approval");
    await expect(approveLine(FINANCE, id, approvalId)).rejects.toMatchObject({ status: 403 });
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

  it("a permanent assignment neither maps a non-inventory line's GTIN nor assigns non-inventory siblings", async () => {
    const part = await lineInApproval(null);
    const pizzaId = await seedExpense({ state: "assign_ownership" });
    const pizza = await seedLineItem(pizzaId, { gtin13: "0000000000017", nonInventory: true });
    const pizzaApproval = await seedApproval(pizzaId, pizza, { ownerId: null, status: "pending" });

    await assignOwner(FINANCE, part.id, part.approvalId, 100, true);
    expect(await approval(pizzaApproval)).toMatchObject({ ownerId: null });

    await db.partOwnerMap.deleteMany({ where: { orgId: ORG } });
    await assignOwner(FINANCE, pizzaId, pizzaApproval, 100, true);
    expect(await db.partOwnerMap.count({ where: { orgId: ORG } })).toBe(0);
    expect(await approval(pizzaApproval)).toMatchObject({ ownerId: 100 });
  });

  it("a line assigned an org-level bucket waits for a Board member's approval", async () => {
    bindPorts({ signoff: directory({ orgLevel: [7], board: [5] }) });
    const { id, approvalId } = await lineInApproval(null);

    await assignOwner(FINANCE, id, approvalId, 7);

    expect(await approval(approvalId)).toMatchObject({ ownerId: 7, status: "pending" });
    expect(await state(id)).toBe("owner_approval");
    await approveLine(BOARD, id, approvalId);
    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 5 });
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

  it("a stale assignment never undoes a racing bucket move, and the submitter seat stays", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3, 6] }) });
    const { id, li, approvalId } = await lineInApproval(100);
    await db.expense.update({ where: { id }, data: { state: "assign_ownership", needsReimbursement: true, reimburseePersonId: 1 } });
    await seedSubmitterSeat(li, 1);

    const [same, moved] = await race(
      `SELECT id FROM expenses WHERE id = '${id}' FOR UPDATE`,
      () => assignOwner(FINANCE, id, approvalId, 100),
      () => assignOwner(principal(6, { isFinance: true }), id, approvalId, 101),
    );

    // The no-op assignment changes nothing, so the move lands after it; landing after the move, it is refused.
    expect(moved.status).toBe("fulfilled");
    if (same.status === "rejected") expect(same.reason).toMatchObject({ status: 409 });
    expect((await approval(approvalId))!.ownerId).toBe(101);
    expect((await db.expenseLineSignoff.findMany({ where: { lineItemId: li } })).map((s) => s.seat)).toEqual(["SUBMITTER"]);
  });
});

describeDb("the submitter's and reimbursee's households approve, raise and reject on none of their lines", () => {
  const SUBMITTER_FINANCE = principal(1, { isFinance: true });
  const HOUSEMATE_FINANCE = principal(6, { isFinance: true });
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

  it("approving, as the bucket's approver or a Board member", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [6] }, board: [1], households: [[1, 6]] }) });
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(principal(1, { isBoard: true }), id, approvalId, "mine")).rejects.toMatchObject({ status: 403 });
    await expect(approveLine(principal(6), id, approvalId)).rejects.toMatchObject({ status: 403 });
    await untouched(approvalId, "pending");
  });
});

describeDb("a conflicted FINANCE holder chooses a line's bucket; an independent person still checks it", () => {
  const SUBMITTER_FINANCE = principal(1, { isFinance: true });
  const HOUSEMATE_FINANCE = principal(6, { isFinance: true });
  const REIMBURSEE_FINANCE = principal(8, { isFinance: true });
  const missing = async (id: string) => (await signoffStatus(id))[0].missing;

  it("assigning a line's bucket, as a housemate or the reimbursee, leaves it pending for its approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, households: [[1, 6]] }) });
    const { id, approvalId } = await lineInApproval(null);
    await assignOwner(HOUSEMATE_FINANCE, id, approvalId, 100);

    const paid = await seedExpense({ state: "assign_ownership", needsReimbursement: true, reimburseePersonId: 8 });
    const paidApproval = await seedApproval(paid, await seedLineItem(paid), { ownerId: null });
    await assignOwner(REIMBURSEE_FINANCE, paid, paidApproval, 100);

    expect(await approval(approvalId)).toMatchObject({ ownerId: 100, status: "pending" });
    expect(await approval(paidApproval)).toMatchObject({ ownerId: 100, status: "pending" });
    expect(await state(id)).toBe("owner_approval");
    await expect(approveLine(HOUSEMATE_FINANCE, id, approvalId)).rejects.toMatchObject({ status: 403 });
    await approveLine(LEADER, id, approvalId);
    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 2 });
  });

  it("resolving an unknown line's bucket leaves it pending for its approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval(null, "unknown");
    await resolveUnknown(SUBMITTER_FINANCE, id, approvalId, 100);
    expect(await approval(approvalId)).toMatchObject({ ownerId: 100, status: "pending", decidedByUserId: 1 });
    expect(await state(id)).toBe("owner_approval");
    await expect(approveLine(SUBMITTER_FINANCE, id, approvalId)).rejects.toMatchObject({ status: 403 });
    await approveLine(LEADER, id, approvalId);
    expect((await approval(approvalId))!.status).toBe("approved");
  });

  it("a permanent mapping assigns a sibling line on an expense the caller is conflicted on", async () => {
    bindPorts({ signoff: directory({ households: [[1, 6]] }) });
    const target = await seedExpense({ state: "assign_ownership", submitterId: 4 });
    const targetApproval = await seedApproval(target, await seedLineItem(target, { gtin13: "0000000000017" }), { ownerId: null });
    const household = await lineInApproval(null);

    await assignOwner(HOUSEMATE_FINANCE, target, targetApproval, 100, true);

    expect(await approval(household.approvalId)).toMatchObject({ ownerId: 100, status: "pending" });
  });

  it("settling an exception without making it final takes no Board seat", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [1, 3], board: [5] }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(SUBMITTER_FINANCE, id, approvalId, 101);
    expect(await approval(approvalId)).toMatchObject({ status: "finance_assigned", ownerId: 101, bucketFinal: false });

    await approveLine(principal(4), id, approvalId);
    expect(await missing(id)).toEqual(["TREASURER"]);
  });

  it("a final assignment by a conflicted holder takes a Board seat, which a conflicted Board member cannot fill", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [1, 3], board: [5, 6], households: [[1, 6]] }) });
    const { id, li, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(SUBMITTER_FINANCE, id, approvalId, 101, true, "grant 12 pays for it");

    await approveLine(principal(4), id, approvalId);
    await signLine(FINANCE, li, "TREASURER");
    expect(await missing(id)).toEqual(["BOARD"]);
    expect(await state(id)).toBe("qb_pending");

    await expect(signLine(principal(6, { isBoard: true }), li, "BOARD")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/submitter, the reimbursee/) });
    await signLine(BOARD, li, "BOARD");
    expect(await missing(id)).toEqual([]);
  });

  it("a final assignment by a holder without a conflict takes no Board seat", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3, 7], board: [5] }) });
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, id, approvalId, 101, true, "grant 12 pays for it");

    await approveLine(principal(4), id, approvalId);
    expect(await missing(id)).toEqual(["TREASURER"]);
  });
});
