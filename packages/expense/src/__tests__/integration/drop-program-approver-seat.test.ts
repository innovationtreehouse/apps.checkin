/** The data-only migration that removes the program-approver seat: its rows go, every other seat and the audit trail stay. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { seedApproval, seedExpense, seedLineItem } from "../helpers/seed";

const SQL = readFileSync(join(__dirname, "../../../prisma/migrations/20261024150000_drop_program_approver_seat/migration.sql"), "utf8");

/** Runs the migration's statements; the file's own BEGIN/COMMIT is left to `migrate deploy`. */
async function migrate() {
  const statements = SQL.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
  for (const statement of statements) await db.$executeRawUnsafe(statement);
}

describeDb("drop the program-approver seat", () => {
  it("deletes every PROGRAM_APPROVER sign-off and keeps the other seats and the audit rows", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });
    await db.expenseLineSignoff.createMany({
      data: [["SUBMITTER", 1], ["PROGRAM_APPROVER", 2], ["TREASURER", 3]].map(([seat, signerUserId]) => ({ expenseId: id, lineItemId: li, seat: seat as string, signerUserId: signerUserId as number })),
    });
    await db.expenseAuditLog.create({ data: { expenseId: id, lineItemId: li, userId: 2, changedAt: new Date(), action: "signoff", fieldChanged: "seat", valueAfter: "PROGRAM_APPROVER" } });

    await migrate();
    await migrate();

    const seats = await db.expenseLineSignoff.findMany({ where: { lineItemId: li }, orderBy: { id: "asc" } });
    expect(seats.map((s) => [s.seat, s.signerUserId])).toEqual([["SUBMITTER", 1], ["TREASURER", 3]]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, valueAfter: "PROGRAM_APPROVER" } })).toBe(1);
  });
});
