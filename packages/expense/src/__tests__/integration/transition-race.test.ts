/** Workflow transitions compare the state they overwrite; a re-raised flag reopens. */
import { backendPid, waitersBehind } from "@checkin/pg-test-harness";
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { principal, seedExpense, seedLineItem } from "../helpers/seed";
import { submitCapitalReview } from "../../services/capitalService";
import { checkOffFlag, listOpenFlags, raiseFlag } from "../../services/flagService";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

describeDb("workflow transitions", () => {
  it("a capital-review submit whose state moved under it gets a 409 and writes nothing", async () => {
    const id = await seedExpense({ state: "capital_review" });
    const li = await seedLineItem(id);

    // A concurrent transition holds the moved row uncommitted while the submit reads capital_review.
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let moved!: (pid: number) => void;
    const rowHeld = new Promise<number>((r) => (moved = r));
    const rival = db.$transaction(async (tx) => {
      await tx.expense.update({ where: { id }, data: { state: "qb_pending" } });
      moved(await backendPid(tx));
      await gate;
    }, { timeout: 20_000 });
    const holderPid = await rowHeld;

    const submit = submitCapitalReview(FINANCE, id, { lineItems: [{ lineItemId: li, isCapital: true }] });
    const outcome = submit.then(() => "committed", (err: unknown) => err);
    await waitersBehind(db, holderPid);
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
    await raiseFlag(id, "QB_POST_HELD", "first hold");
    const [flag] = await listOpenFlags(FINANCE);
    await checkOffFlag(FINANCE, flag.id, "seen", flag);
    expect(await listOpenFlags(FINANCE)).toEqual([]);

    await raiseFlag(id, "QB_POST_HELD", "second hold");
    await raiseFlag(id, "QB_POST_HELD", "ignored while open");

    const open = await listOpenFlags(FINANCE);
    expect(open.map((f) => [f.id, f.detail, f.checkedOffAt, f.notes])).toEqual([[flag.id, "second hold", null, null]]);
    expect(await listOpenFlags(BOARD)).toEqual([]);
  });
});
