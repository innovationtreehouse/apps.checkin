/** Workflow transitions compare the state they overwrite; a re-raised flag reopens. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { principal, seedExpense, seedLineItem } from "../helpers/seed";
import { submitCapitalReview } from "../../services/capitalService";
import { checkOffFlag, listOpenFlags, raiseFlag } from "../../services/flagService";

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

describeDb("workflow transitions", () => {
  it("a capital-review submit whose state moved under it gets a 409 and writes nothing", async () => {
    const id = await seedExpense({ state: "capital_review" });
    const li = await seedLineItem(id);

    // A concurrent transition holds the moved row uncommitted while the submit reads capital_review.
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let moved!: () => void;
    const rowHeld = new Promise<void>((r) => (moved = r));
    const rival = db.$transaction(async (tx) => {
      await tx.expense.update({ where: { id }, data: { state: "qb_pending" } });
      moved();
      await gate;
    }, { timeout: 20_000 });
    await rowHeld;

    const submit = submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true }] });
    const outcome = submit.then(() => "committed", (err: unknown) => err);
    await someoneBlocked();
    commit();
    await rival;

    expect(await outcome).toMatchObject({ status: 409 });
    expect((await db.expenseLineItem.findUniqueOrThrow({ where: { id: li } })).isCapital).toBe(false);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "capital_review_submitted" } })).toBe(0);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_pending");
  });
});

describeDb("flags", () => {
  it("raising a checked-off flag reopens it; raising an open one leaves it as is", async () => {
    const id = await seedExpense();
    await raiseFlag(id, "COI", "first substitution");
    const [flag] = await listOpenFlags(BOARD);
    await checkOffFlag(BOARD, flag.id, "seen");
    expect(await listOpenFlags(BOARD)).toEqual([]);

    await raiseFlag(id, "COI", "second substitution");
    await raiseFlag(id, "COI", "ignored while open");

    const open = await listOpenFlags(BOARD);
    expect(open.map((f) => [f.id, f.detail, f.checkedOffAt, f.notes])).toEqual([[flag.id, "second substitution", null, null]]);
    expect(await listOpenFlags(FINANCE)).toEqual([]);
  });
});
