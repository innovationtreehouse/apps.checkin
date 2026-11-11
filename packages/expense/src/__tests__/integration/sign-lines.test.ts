/**
 * Sign all as Treasurer against the real database: every listed line is signed under one expense
 * lock, through the same refusals as a single signature, or none is; and the To sign and Board
 * lists hold only the lines whose earlier steps are done.
 */
import { beforeEach, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { ServiceError } from "@checkin/component-kit";
import { signLine, signLines, signaturesWaiting } from "../../services/signoffService";

// submitter 1 · approver 2 (bucket 100) · FINANCE 3 and 4 · Board 5 · 8 in the submitter's household
const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

async function expenseWith(approvals: Array<{ status: string; decidedByUserId?: number }>, opts: Parameters<typeof seedExpense>[0] = {}) {
  const id = await seedExpense({ state: "qb_pending", submitterId: 1, ...opts });
  const lines: number[] = [];
  for (const [i, a] of approvals.entries()) {
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    // The seed numbers every line 1; a refusal names its line by number.
    await db.expenseLineItem.update({ where: { id: li }, data: { lineNumber: i + 1 } });
    await seedApproval(id, li, { ownerId: 100, ...a });
    lines.push(li);
  }
  return { id, lines };
}

const treasurerSeats = (id: string) => db.expenseLineSignoff.count({ where: { expenseId: id, seat: "TREASURER" } });

describeDb("Sign all as Treasurer", () => {
  beforeEach(() => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 8]] }) });
  });

  it("signs every listed line, audited one row per line", async () => {
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }, { status: "approved", decidedByUserId: 2 }]);
    await signLines(FINANCE, id, lines);
    const seats = await db.expenseLineSignoff.findMany({ where: { expenseId: id }, orderBy: { lineItemId: "asc" } });
    expect(seats.map((s) => [s.lineItemId, s.seat, s.signerUserId])).toEqual(lines.map((li) => [li, "TREASURER", 3]));
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "signoff", valueAfter: "TREASURER" } })).toBe(2);
  });

  it("signs nothing when one line is refused, and the refusal names the line", async () => {
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }, { status: "pending" }]);
    await expect(signLines(FINANCE, id, lines)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Line 2: the line is not approved yet/) });
    expect(await treasurerSeats(id)).toBe(0);
  });

  it("refuses an approver of the expense exactly as a single signature does", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [3] }, finance: [3, 4], board: [5], households: [[1, 8]] }) });
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 4 }, { status: "approved", decidedByUserId: 3 }]);
    // Sign all refuses line 1 with whatever a single signature on it is refused for.
    const single = await signLine(FINANCE, lines[0], "TREASURER").then(
      () => null,
      (err: unknown) => (err instanceof ServiceError ? err : null),
    );
    expect(single?.status).toBe(403);
    await expect(signLines(FINANCE, id, lines)).rejects.toMatchObject({ status: 403, message: `Line 1: ${single?.message}` });
    expect(await treasurerSeats(id)).toBe(0);
  });

  it("refuses a conflicted FINANCE holder", async () => {
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }]);
    await expect(signLines(principal(8, { isFinance: true }), id, lines)).rejects.toMatchObject({ status: 403 });
    expect(await treasurerSeats(id)).toBe(0);
  });

  it("refuses a line already signed, a line of another expense, and an empty list", async () => {
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }]);
    const other = await expenseWith([{ status: "approved", decidedByUserId: 2 }]);
    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: lines[0], seat: "TREASURER", signerUserId: 4 } });
    await expect(signLines(FINANCE, id, lines)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Line 1: seat TREASURER is already filled/) });
    await expect(signLines(FINANCE, id, other.lines)).rejects.toMatchObject({ status: 404 });
    await expect(signLines(FINANCE, id, [])).rejects.toMatchObject({ status: 400 });
    expect(await treasurerSeats(other.id)).toBe(0);
  });

  it("refuses while the reimbursee is unknown", async () => {
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }], { needsReimbursement: true });
    await expect(signLines(FINANCE, id, lines)).rejects.toMatchObject({ status: 409 });
  });
});

describeDb("the To sign and Board lists", () => {
  beforeEach(() => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, orgLevel: [7], finance: [3, 4], board: [5], households: [[1, 8]] }) });
  });

  it("lists a Treasurer signature only once the line is approved", async () => {
    const { id, lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }, { status: "pending" }], { state: "owner_approval" });
    expect((await signaturesWaiting(FINANCE)).map((w) => [w.expense.id, w.toSign, w.board])).toEqual([[id, [lines[0]], []]]);
  });

  it("lists a Board signature only once the Treasurer has signed", async () => {
    // A non-Everyday org-level card charge takes the Board seat; Board member 6 approved it.
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3, 4], board: [5, 6], households: [[1, 8]] }) });
    const id = await seedExpense({ state: "qb_pending", submitterId: 1, receiptTotalCents: 60_000 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 7, status: "approved", decidedByUserId: 6 });
    expect(await signaturesWaiting(BOARD)).toEqual([]);
    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: li, seat: "TREASURER", signerUserId: 3 } });
    expect((await signaturesWaiting(BOARD)).map((w) => [w.toSign, w.board])).toEqual([[[], [li]]]);
  });

  it("puts a Board member's Treasurer stand-in in the Board list when no FINANCE holder can sign", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [8], board: [5], households: [[1, 8]] }) });
    const { lines } = await expenseWith([{ status: "approved", decidedByUserId: 2 }]);
    expect((await signaturesWaiting(BOARD)).map((w) => [w.toSign, w.board])).toEqual([[[], lines]]);
  });

  it("gives a viewer with neither role nothing", async () => {
    await expenseWith([{ status: "approved", decidedByUserId: 2 }]);
    expect(await signaturesWaiting(principal(2))).toEqual([]);
  });
});
