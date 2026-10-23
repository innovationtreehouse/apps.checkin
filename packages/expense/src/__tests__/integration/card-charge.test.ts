/** Card-charge Board seat and Board authorization against the real database. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { markNotEveryday, recordBoardAuthorization, signLine, signoffStatus } from "../../services/signoffService";
import { lockExpense, unsignedLines } from "../../lib/signoff-facts";
import { updateExpenseSettings } from "../../services/settingsService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

/** Resolves once some backend in this database is waiting on a row lock. */
async function someoneBlocked(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no backend blocked on a lock");
}

describeDb("card charges", () => {
  // purchaser 1 · leader 2 · finance 3 and 4 · board 5 · 8 in the purchaser's household ·
  // bucket 100 org-level, bucket 200 a program's
  async function signedCard(opts: { receiptTotalCents?: number; unitPriceCents?: number; bucket?: number } = {}) {
    bindPorts({ signoff: directory({ approvers: { 200: [2] }, orgLevel: [100], finance: [3, 4], board: [5], households: [[1, 8]] }) });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: opts.receiptTotalCents ?? 100 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000", unitPriceCents: opts.unitPriceCents ?? 100 });
    await seedApproval(id, li, { ownerId: opts.bucket ?? 100, status: "approved" });
    await signAllLines(id);
    await db.expense.update({ where: { id }, data: { boardAuthorization: null } });
    return id;
  }
  const holds = async (id: string) => [...(await unsignedLines(db, (await db.expense.findUnique({ where: { id } }))!)).values()].flat();
  const events = (id: string) => db.expenseEvent.count({ where: { expenseId: id } });

  it("an Everyday card charge with every seat signed is not held", async () => {
    expect(await holds(await signedCard())).toEqual([]);
  });

  it("a non-Everyday org-level line takes the Board seat until a Board authorization is recorded, then drains", async () => {
    const id = await signedCard({ receiptTotalCents: 50_000 });
    await checkAndProcessExpense(ORG, id);
    expect(await holds(id)).toEqual(["BOARD"]);
    expect((await signoffStatus(id))[0].missing).toEqual(["BOARD"]);
    expect(await events(id)).toBe(0);

    await expect(recordBoardAuthorization(FINANCE, id, "  ")).rejects.toMatchObject({ status: 400 });
    await recordBoardAuthorization(FINANCE, id, "Board minutes 2026-10-01, item 4");

    expect(await events(id)).toBe(1);
    const row = (await db.expense.findUnique({ where: { id } }))!;
    expect([row.boardAuthorization, row.boardAuthorizedByUserId]).toEqual(["Board minutes 2026-10-01, item 4", 3]);
  });

  it("a not-Everyday mark racing the outbox commit holds the charge open for the Board seat", async () => {
    const id = await signedCard();
    expect(await holds(id)).toEqual([]);

    // The mark holds the expense lock uncommitted while the drain reads no hold.
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let marked!: () => void;
    const held = new Promise<void>((r) => (marked = r));
    const mark = db.$transaction(async (tx) => {
      await lockExpense(tx, id);
      await tx.expense.update({ where: { id }, data: { financeNotEveryday: true } });
      marked();
      await gate;
    }, { timeout: 20_000 });
    await held;

    const drain = checkAndProcessExpense(ORG, id);
    await someoneBlocked();
    commit();
    await mark;
    await drain;

    expect(await events(id)).toBe(0);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_pending");
    expect(await holds(id)).toEqual(["BOARD"]);
    await recordBoardAuthorization(FINANCE, id, "Board minutes 2026-10-01, item 5");
    expect(await events(id)).toBe(1);
  });

  it("a non-Everyday line in a program bucket has written authorization: no Board seat", async () => {
    expect(await holds(await signedCard({ receiptTotalCents: 60_000, bucket: 200 }))).toEqual([]);
  });

  it("a Board member without a conflict signing the Board seat clears it, then drains", async () => {
    const id = await signedCard({ receiptTotalCents: 60_000 });
    const [line] = await db.expenseLineItem.findMany({ where: { expenseId: id } });
    await expect(signLine(principal(8, { isBoard: true }), line.id, "BOARD")).rejects.toMatchObject({ status: 403 });
    await signLine(BOARD, line.id, "BOARD");
    expect(await holds(id)).toEqual([]);
    expect(await events(id)).toBe(1);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).boardAuthorization).toBeNull();
  });

  it("an item over the item limit takes the Board seat", async () => {
    expect(await holds(await signedCard({ receiptTotalCents: 25_001, unitPriceCents: 25_001 }))).toEqual(["BOARD"]);
  });

  it("raising the limits leaves a held charge held and applies to new charges", async () => {
    const held = await signedCard({ receiptTotalCents: 60_000 });
    expect(await holds(held)).toEqual(["BOARD"]);
    const row = (await db.expense.findUnique({ where: { id: held } }))!;
    expect([row.everydayWithinLimits, row.everydayTotalLimitCents, row.everydayItemLimitCents]).toEqual([false, 50_000, 25_000]);

    await updateExpenseSettings(ORG, { everydayTotalLimitCents: 100_000 }, BOARD);
    expect(await holds(held)).toEqual(["BOARD"]);
    expect((await signoffStatus(held))[0].missing).toEqual(["BOARD"]);

    const fresh = await signedCard({ receiptTotalCents: 60_000 });
    expect(await holds(fresh)).toEqual([]);

    const marked = await signedCard({ receiptTotalCents: 60_000 });
    await markNotEveryday(FINANCE, marked, "finance_override");
    expect(await holds(marked)).toEqual(["BOARD"]);
  });

  it("FINANCE marks it single-source or not Everyday, one-way; nobody else can", async () => {
    const id = await signedCard();
    await expect(markNotEveryday(BOARD, id, "single_source")).rejects.toMatchObject({ status: 403 });
    await markNotEveryday(FINANCE, id, "single_source");
    expect(await holds(id)).toEqual(["BOARD"]);

    const other = await signedCard();
    await markNotEveryday(FINANCE, other, "finance_override");
    expect(await holds(other)).toEqual(["BOARD"]);
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: other, action: "not_everyday_marked" } });
    expect(audit.map((a) => [a.userId, a.fieldChanged])).toEqual([[3, "financeNotEveryday"]]);
  });

  it("a FINANCE holder conflicted on the charge cannot record the authorization; another one does", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 60_000 });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await expect(recordBoardAuthorization(FINANCE, id, "Board vote")).rejects.toMatchObject({ status: 403 });
    await recordBoardAuthorization(principal(4, { isFinance: true }), id, "Board vote");
    await expect(recordBoardAuthorization(principal(4, { isFinance: true }), id, "again")).rejects.toMatchObject({ status: 409 });
  });

  it("a Board member records it only when every FINANCE holder is conflicted, and that raises a COI flag", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], households: [[1, 3]] }) });
    const id = await seedExpense({ receiptTotalCents: 60_000 });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await recordBoardAuthorization(principal(5, { isBoard: true }), id, "Board vote");
    const flags = await db.expenseFlag.findMany({ where: { expenseId: id } });
    expect(flags.map((f) => [f.kind, f.audience])).toEqual([["COI", "BOARD"]]);
  });

  it("a FINANCE holder recording it raises no flag", async () => {
    const id = await signedCard({ receiptTotalCents: 60_000 });
    await recordBoardAuthorization(FINANCE, id, "Board vote");
    expect(await db.expenseFlag.count({ where: { expenseId: id, kind: "COI" } })).toBe(0);
  });

  it("a reimbursement under $2,000 takes no Board authorization", async () => {
    bindPorts({ signoff: directory({ finance: [3] }) });
    const id = await seedExpense({ needsReimbursement: true, reimburseePersonId: 1 });
    await expect(recordBoardAuthorization(FINANCE, id, "x")).rejects.toMatchObject({ status: 400 });
  });

  it("a $2,000 card charge in a program bucket takes no Board seat but is held until the Board's approval is recorded", async () => {
    const id = await signedCard({ receiptTotalCents: 200_000, unitPriceCents: 200_000, bucket: 200 });
    await checkAndProcessExpense(ORG, id);
    expect(await holds(id)).toEqual(["BOARD_APPROVAL"]);
    expect(await events(id)).toBe(0);
    await recordBoardAuthorization(FINANCE, id, "FY27 program budget, line 12");
    expect(await holds(id)).toEqual([]);
    expect(await events(id)).toBe(1);
  });

  it("a $2,000 org-level card charge: one recorded approval clears both the Board seat and the hold", async () => {
    const id = await signedCard({ receiptTotalCents: 200_000, unitPriceCents: 200_000 });
    expect(await holds(id)).toEqual(["BOARD", "BOARD_APPROVAL"]);
    const [line] = await db.expenseLineItem.findMany({ where: { expenseId: id } });
    await signLine(BOARD, line.id, "BOARD");
    expect(await holds(id)).toEqual(["BOARD_APPROVAL"]);
    await recordBoardAuthorization(FINANCE, id, "Board minutes 2026-10-01, item 6");
    expect(await holds(id)).toEqual([]);
  });

  it("a $2,000 reimbursement is held until the Board's approval is recorded", async () => {
    bindPorts({ signoff: directory({ approvers: { 200: [2] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 1, receiptTotalCents: 200_000 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000", unitPriceCents: 200_000 });
    await seedApproval(id, li, { ownerId: 200, status: "approved" });
    await signAllLines(id);
    await db.expense.update({ where: { id }, data: { boardAuthorization: null } });
    expect(await holds(id)).toEqual(["BOARD_APPROVAL"]);
    await expect(recordBoardAuthorization(principal(1, { isFinance: true }), id, "x")).rejects.toMatchObject({ status: 403 });
    await recordBoardAuthorization(FINANCE, id, "FY27 program budget, line 4");
    expect(await holds(id)).toEqual([]);
    expect(await events(id)).toBe(1);
  });

  it("a $2,000 reimbursement with no reimbursee yet cannot record the approval", async () => {
    bindPorts({ signoff: directory({ finance: [3] }) });
    const id = await seedExpense({ needsReimbursement: true, receiptTotalCents: 200_000 });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await expect(recordBoardAuthorization(FINANCE, id, "x")).rejects.toMatchObject({ status: 409 });
  });
});
