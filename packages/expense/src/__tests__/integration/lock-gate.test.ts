/** The race tests' lock gate counts only the backends queued behind the lock's holder. */
import { backendPid, waitersBehind } from "@checkin/pg-test-harness";
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { seedExpense } from "../helpers/seed";
import { lockExpense } from "../../lib/signoff-facts";

/** Takes the expense's lock in a transaction and keeps it until `release` is called. */
async function hold(id: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: (pid: number) => void;
  const held = new Promise<number>((r) => (locked = r));
  const done = db.$transaction(async (tx) => {
    await lockExpense(tx, id);
    locked(await backendPid(tx));
    await gate;
  }, { timeout: 20_000 });
  return { pid: await held, release, done };
}

const queueOn = (id: string) => db.$transaction((tx) => lockExpense(tx, id), { timeout: 20_000 });

describeDb("the lock gate", () => {
  it("ignores a backend waiting on a lock the holder does not hold", async () => {
    const [mine, other] = [await seedExpense(), await seedExpense()];
    const holder = await hold(mine);
    const stranger = await hold(other);
    const strayWaiter = queueOn(other);
    await waitersBehind(db, stranger.pid);

    await expect(waitersBehind(db, holder.pid)).rejects.toThrow(/fewer than 1/);

    stranger.release();
    holder.release();
    await Promise.all([stranger.done, holder.done, strayWaiter]);
  }, 15_000);

  it("counts a backend queued behind another waiter", async () => {
    const id = await seedExpense();
    const holder = await hold(id);
    const waiters = [queueOn(id), queueOn(id)];

    await waitersBehind(db, holder.pid, 2);

    holder.release();
    await Promise.all([holder.done, ...waiters]);
  });
});
