/** Card-charge Everyday hold and Board authorization against the real database. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { recordBoardAuthorization, signoffStatus } from "../../services/signoffService";
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
  // purchaser 1 · owner 2 · finance 3 and 4 · board 5 · 8 in the purchaser's household
  async function signedCard(opts: { receiptTotalCents?: number; unitPriceCents?: number } = {}) {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 8]] }) });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: opts.receiptTotalCents ?? 100 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000", unitPriceCents: opts.unitPriceCents ?? 100 });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    await signAllLines(id);
    await db.expense.update({ where: { id }, data: { boardAuthorization: null } });
    return id;
  }
  const holds = async (id: string) => [...(await unsignedLines(db, (await db.expense.findUnique({ where: { id } }))!)).values()].flat();
  const events = (id: string) => db.expenseEvent.count({ where: { expenseId: id } });

  it("an Everyday card charge with every seat signed is not held", async () => {
    expect(await holds(await signedCard())).toEqual([]);
  });

  it("a non-Everyday card charge is held until the Treasurer records the Board authorization, then drains", async () => {
    const id = await signedCard({ receiptTotalCents: 50_000 });
    await checkAndProcessExpense(ORG, id);
    expect(await holds(id)).toEqual(["BOARD_AUTHORIZATION"]);
    expect((await signoffStatus(id))[0].missing).toEqual(["BOARD_AUTHORIZATION"]);
    expect(await events(id)).toBe(0);

    await expect(recordBoardAuthorization(FINANCE, id, "  ")).rejects.toMatchObject({ status: 400 });
    await recordBoardAuthorization(FINANCE, id, "Board minutes 2026-10-01, item 4");

    expect(await events(id)).toBe(1);
    const row = (await db.expense.findUnique({ where: { id } }))!;
    expect([row.boardAuthorization, row.boardAuthorizedByUserId]).toEqual(["Board minutes 2026-10-01, item 4", 3]);
  });

  it("a seat void racing the outbox commit holds the charge until the seat is signed again", async () => {
    const id = await signedCard();
    expect(await holds(id)).toEqual([]);

    // The void holds the expense lock uncommitted while the drain reads no hold.
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let voided!: () => void;
    const held = new Promise<void>((r) => (voided = r));
    const voiding = db.$transaction(async (tx) => {
      await lockExpense(tx, id);
      await tx.expenseLineSignoff.deleteMany({ where: { expenseId: id, seat: "TREASURER" } });
      voided();
      await gate;
    }, { timeout: 20_000 });
    await held;

    const drain = checkAndProcessExpense(ORG, id);
    await someoneBlocked();
    commit();
    await voiding;
    await drain;

    expect(await events(id)).toBe(0);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_pending");
    expect(await holds(id)).toEqual(["TREASURER"]);
    const [line] = await db.expenseLineItem.findMany({ where: { expenseId: id }, select: { id: true } });
    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: line.id, seat: "TREASURER", signerUserId: 9002 } });
    await checkAndProcessExpense(ORG, id);
    expect(await events(id)).toBe(1);
  });

  it("an item over the item limit holds it", async () => {
    expect(await holds(await signedCard({ receiptTotalCents: 25_001, unitPriceCents: 25_001 }))).toEqual(["BOARD_AUTHORIZATION"]);
  });

  it("raising the limits leaves a held charge held and applies to new charges", async () => {
    const held = await signedCard({ receiptTotalCents: 60_000 });
    expect(await holds(held)).toEqual(["BOARD_AUTHORIZATION"]);
    const row = (await db.expense.findUnique({ where: { id: held } }))!;
    expect([row.everydayWithinLimits, row.everydayTotalLimitCents, row.everydayItemLimitCents]).toEqual([false, 50_000, 25_000]);

    await updateExpenseSettings(ORG, { everydayTotalLimitCents: 100_000 }, BOARD);
    expect(await holds(held)).toEqual(["BOARD_AUTHORIZATION"]);
    expect((await signoffStatus(held))[0].missing).toEqual(["BOARD_AUTHORIZATION"]);

    const fresh = await signedCard({ receiptTotalCents: 60_000 });
    expect(await holds(fresh)).toEqual([]);
  });

  it("a conflicted Treasurer cannot record the authorization; another FINANCE holder does", async () => {
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

  it("a reimbursement takes no Board authorization", async () => {
    bindPorts({ signoff: directory({ finance: [3] }) });
    const id = await seedExpense({ needsReimbursement: true, reimburseePersonId: 1 });
    await expect(recordBoardAuthorization(FINANCE, id, "x")).rejects.toMatchObject({ status: 400 });
  });
});
