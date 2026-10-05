import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { importPayouts } from "../../lib/import";
import { clearAll, makePayoutRow, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

beforeEach(async () => {
  await clearAll();
});

describeDb("importPayouts — inserts", () => {
  it("inserts a new payout and records inserted count", async () => {
    const summary = await importPayouts(ORG_A, [makePayoutRow()]);
    expect(summary.inserted).toBe(1);
    expect(summary.duplicate).toBe(0);
    expect(summary.conflict).toBe(0);
    expect(summary.rows[0].result).toBe("inserted");

    const rows = await db.payout.findMany({ where: { orgId: ORG_A } });
    expect(rows.length).toBe(1);
    expect(rows[0].totalCents).toBe(97);
  });

  it("inserts multiple distinct payouts", async () => {
    const summary = await importPayouts(ORG_A, [
      makePayoutRow({ payoutDate: "2026-05-01", totalCents: 97 }),
      makePayoutRow({ payoutDate: "2026-05-02", totalCents: 50 }),
    ]);
    expect(summary.inserted).toBe(2);
  });
});

describeDb("importPayouts — duplicates", () => {
  it("re-importing the identical row is a duplicate, not a second insert", async () => {
    const row = makePayoutRow();
    await importPayouts(ORG_A, [row]);
    const summary = await importPayouts(ORG_A, [row]);
    expect(summary.inserted).toBe(0);
    expect(summary.duplicate).toBe(1);
    expect(summary.rows[0].result).toBe("duplicate");

    const rows = await db.payout.findMany({ where: { orgId: ORG_A } });
    expect(rows.length).toBe(1); // still only one
  });

  it("importing the same file twice is idempotent", async () => {
    const rows = [makePayoutRow({ payoutDate: "2026-05-01", totalCents: 97 }), makePayoutRow({ payoutDate: "2026-05-02", totalCents: 50 })];
    await importPayouts(ORG_A, rows);
    const second = await importPayouts(ORG_A, rows);
    expect(second.inserted).toBe(0);
    expect(second.duplicate).toBe(2);
  });
});

describeDb("importPayouts — conflicts", () => {
  it("same (date,total) with a different payload raises a pending conflict", async () => {
    await importPayouts(ORG_A, [makePayoutRow({ feesCents: -3, bankReference: "REF-1" })]);
    // Same date+total, different fees/bankRef → conflict
    const summary = await importPayouts(ORG_A, [makePayoutRow({ feesCents: -9, bankReference: "REF-2" })]);
    expect(summary.inserted).toBe(0);
    expect(summary.conflict).toBe(1);
    expect(summary.rows[0].result).toBe("conflict");

    const conflicts = await db.payoutConflict.findMany({ where: { orgId: ORG_A } });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].status).toBe("pending");

    // The original payout remains untouched
    const rows = await db.payout.findMany({ where: { orgId: ORG_A } });
    expect(rows.length).toBe(1);
  });

  it("does not duplicate-insert into payouts on conflict (unique index protected)", async () => {
    await importPayouts(ORG_A, [makePayoutRow({ bankReference: "REF-1" })]);
    await importPayouts(ORG_A, [makePayoutRow({ bankReference: "REF-2" })]);
    const rows = await db.payout.findMany({ where: { orgId: ORG_A } });
    expect(rows.length).toBe(1);
  });
});

describeDb("importPayouts — org isolation", () => {
  it("identical rows in different orgs both insert", async () => {
    const row = makePayoutRow();
    await importPayouts(ORG_A, [row]);
    const summary = await importPayouts(ORG_B, [row]);
    expect(summary.inserted).toBe(1);
    expect(summary.duplicate).toBe(0);

    expect((await db.payout.findMany({ where: { orgId: ORG_A } })).length).toBe(1);
    expect((await db.payout.findMany({ where: { orgId: ORG_B } })).length).toBe(1);
  });
});

describeDb("importPayouts — empty + metadata", () => {
  it("handles an empty row list", async () => {
    const summary = await importPayouts(ORG_A, []);
    expect(summary).toEqual({ inserted: 0, duplicate: 0, conflict: 0, rejected: 0, rows: [] });
  });

  it("records an import-file row when metadata is supplied", async () => {
    const buffer = Buffer.from("col\nval");
    await importPayouts(ORG_A, [makePayoutRow()], { userId: newUserId(), filename: "payouts.csv", buffer });
    const files = await db.payoutImportFile.findMany({ where: { orgId: ORG_A } });
    expect(files.length).toBe(1);
    expect(files[0].originalFilename).toBe("payouts.csv");
    expect(files[0].insertedCount).toBe(1);
    expect(files[0].fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not record an import-file row without metadata", async () => {
    await importPayouts(ORG_A, [makePayoutRow()]);
    const files = await db.payoutImport.findMany();
    expect(files.length).toBe(1); // import blob exists
    const fileRows = await db.payoutImportFile.findMany();
    expect(fileRows.length).toBe(0);
  });
});
