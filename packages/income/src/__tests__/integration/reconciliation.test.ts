import { it, expect, beforeEach, afterEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureIncome } from "../../runtime";
import { importPayouts } from "../../lib/import";
import { runReconcile, lockReconciliation } from "../../lib/reconcile";
import { reconciliationService } from "../../services/reconciliationService";
import type { MirrorBalanceTxn, MirrorPayout, QbDeposit } from "../../contract";
import { clearAll, seedPayout, makePayoutRow, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

let deposits: QbDeposit[];
let mirrorPayouts: MirrorPayout[];
let mirrorTxns: Record<string, MirrorBalanceTxn[]>;

const NOW = new Date("2026-06-30T12:00:00Z");
const dep = (id: string, txnDate: string, totalCents: number): QbDeposit => ({
  id, txnDate, totalCents, depositToAccount: "Checking",
});
const txn = (netCents: number): MirrorBalanceTxn => ({
  txnGid: `t${netCents}`, type: "charge", orderName: "#1", amountCents: netCents, feeCents: 0, netCents,
});

function bind(extra: Parameters<typeof configureIncome>[0] = {}) {
  configureIncome({
    deposits: { depositsSince: async (from) => deposits.filter((d) => d.txnDate >= from.toISOString().slice(0, 10)) },
    ...extra,
  });
}

const rowFor = (key: string) =>
  db.payoutReconciliation.findUniqueOrThrow({ where: { orgId_key: { orgId: ORG_A, key } } });

beforeEach(async () => {
  await clearAll();
  deposits = [];
  mirrorPayouts = [];
  mirrorTxns = {};
  bind();
});

afterEach(() => configureIncome({}));

describeDb("runReconcile — automatic transitions", () => {
  it("is a no-op while no deposit source is bound", async () => {
    configureIncome({});
    await seedPayout(ORG_A);
    expect(await runReconcile(ORG_A, NOW)).toEqual({ status: "unbound" });
    expect(await db.payoutReconciliation.count()).toBe(0);
  });

  it("auto-matches the one unclaimed deposit of equal amount inside the window", async () => {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    deposits = [dep("D1", "2026-06-03", 97), dep("D2", "2026-06-03", 98)];

    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ status: "ran", matched: 1 });
    const row = await rowFor(`csv:${id}`);
    expect(row).toMatchObject({ status: "MATCHED", resolution: "AUTO", depositId: "D1", depositTotalCents: 97 });
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.matched" } })).toBe(1);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    const audits = await db.incomeAuditLog.count();

    expect(await runReconcile(ORG_A, NOW)).toEqual({ status: "ran", matched: 0, opened: 0, drifted: 0 });
    expect(await db.incomeAuditLog.count()).toBe(audits);
  });

  it("waits inside the window, then opens NO_DEPOSIT once it elapses", async () => {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-25", totalCents: 97 });
    await runReconcile(ORG_A, NOW);
    expect(await db.payoutReconciliation.count()).toBe(0);

    await runReconcile(ORG_A, new Date("2026-07-03T00:00:00Z"));
    expect(await rowFor(`csv:${id}`)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("opens AMBIGUOUS_DEPOSIT when two deposits fit", async () => {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    deposits = [dep("D1", "2026-06-02", 97), dep("D2", "2026-06-04", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(`csv:${id}`)).toMatchObject({ status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null });
  });

  it("ignores deposits outside [payoutDate, payoutDate + window]", async () => {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-10", totalCents: 97 });
    deposits = [dep("early", "2026-06-09", 97), dep("late", "2026-06-18", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(`csv:${id}`)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("skips payouts that are not paid", async () => {
    await seedPayout(ORG_A, { status: "in_transit" });
    await runReconcile(ORG_A, NOW);
    expect(await db.payoutReconciliation.count()).toBe(0);
  });

  it("a late booking auto-matches an OPEN row", async () => {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    await runReconcile(ORG_A, NOW);
    expect((await rowFor(`csv:${id}`)).status).toBe("OPEN");

    deposits = [dep("D1", "2026-06-05", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(`csv:${id}`)).toMatchObject({ status: "MATCHED", kind: null, depositId: "D1" });
  });

  it("one deposit backs one payout: two equal payouts cannot share it", async () => {
    const a = await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    const b = await seedPayout(ORG_A, { payoutDate: "2026-06-02", totalCents: 97 });
    deposits = [dep("D1", "2026-06-03", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(`csv:${a}`)).toMatchObject({ status: "MATCHED", depositId: "D1" });
    expect(await rowFor(`csv:${b}`)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("the database refuses a second claim on the same deposit", async () => {
    const base = { orgId: ORG_A, source: "csv", payoutDate: "2026-06-01", payoutNetCents: 1, status: "MATCHED" };
    await db.payoutReconciliation.create({ data: { ...base, key: "csv:1", depositId: "D1" } });
    await expect(
      db.payoutReconciliation.create({ data: { ...base, key: "csv:2", depositId: "D1" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps orgs apart", async () => {
    await seedPayout(ORG_B, { payoutDate: "2026-06-01", totalCents: 97 });
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await db.payoutReconciliation.count()).toBe(0);
  });

  it("returns busy while another holder has the advisory lock", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    deposits = [dep("D1", "2026-06-02", 97)];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const ready = new Promise<void>((r) => (acquired = r));
    const holder = db.$transaction(async (tx) => {
      await lockReconciliation(tx, ORG_A, true);
      acquired();
      await held;
    });
    await ready;

    expect(await runReconcile(ORG_A, NOW)).toEqual({ status: "busy" });
    release();
    await holder;
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ status: "ran", matched: 1 });
  });
});

describeDb("runReconcile — drift", () => {
  async function matched() {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    return `csv:${id}`;
  }

  it("reopens as DRIFT when the matched deposit disappears", async () => {
    const key = await matched();
    deposits = [];
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ drifted: 1 });
    expect(await rowFor(key)).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });
  });

  it("reopens as DRIFT when the deposit amount changes", async () => {
    const key = await matched();
    deposits = [dep("D1", "2026-06-02", 90)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(key)).toMatchObject({ status: "OPEN", kind: "DRIFT" });
  });

  it("a DRIFT row is never silently re-matched, even when a fitting deposit returns", async () => {
    const key = await matched();
    deposits = [];
    await runReconcile(ORG_A, NOW);
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(key)).toMatchObject({ status: "OPEN", kind: "DRIFT" });
  });

  it("reopens a manually resolved row when the mirror payout's net changes", async () => {
    mirrorPayouts = [{ payoutGid: "gid://P/1", issuedAt: new Date("2026-06-20T00:00:00Z"), netCents: 500, currency: "USD" }];
    mirrorTxns = { "gid://P/1": [txn(500)] };
    bind({
      mirrorFrom: new Date("2026-06-15T00:00:00Z"),
      mirror: {
        paidPayoutsSince: async () => mirrorPayouts,
        payout: async (gid) => mirrorPayouts.find((p) => p.payoutGid === gid) ?? null,
        transactions: async (gid) => mirrorTxns[gid] ?? [],
      },
    });
    deposits = [dep("D9", "2026-06-21", 500)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("gid:gid://P/1")).toMatchObject({ status: "MATCHED", source: "mirror" });

    mirrorPayouts[0] = { ...mirrorPayouts[0], netCents: 450 };
    mirrorTxns["gid://P/1"] = [txn(450)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("gid:gid://P/1")).toMatchObject({ status: "OPEN", kind: "DRIFT", payoutNetCents: 450 });
  });
});

describeDb("runReconcile — mirror payouts", () => {
  function bindMirror() {
    bind({
      mirrorFrom: new Date("2026-06-15T00:00:00Z"),
      mirror: {
        paidPayoutsSince: async () => mirrorPayouts,
        payout: async () => null,
        transactions: async (gid) => mirrorTxns[gid] ?? [],
      },
    });
  }

  it("opens TXN_SUM_MISMATCH when the balance transactions do not sum to the payout net", async () => {
    mirrorPayouts = [{ payoutGid: "G1", issuedAt: new Date("2026-06-20T00:00:00Z"), netCents: 500, currency: "USD" }];
    mirrorTxns = { G1: [txn(300)] };
    bindMirror();
    deposits = [dep("D1", "2026-06-21", 500)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("gid:G1")).toMatchObject({ status: "OPEN", kind: "TXN_SUM_MISMATCH", depositId: null });
  });

  it("reconciles CSV payouts only before mirrorFrom", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-06-16", totalCents: 97 });
    bindMirror();
    deposits = [dep("D1", "2026-06-17", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await db.payoutReconciliation.count()).toBe(0);
  });
});

describeDb("reconciliationService — finance actions", () => {
  async function openRow() {
    const id = await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 97 });
    await runReconcile(ORG_A, NOW);
    return rowFor(`csv:${id}`);
  }

  it("candidates lists unclaimed deposits within ±window", async () => {
    const row = await openRow();
    deposits = [dep("in", "2026-05-28", 10), dep("out", "2026-06-20", 10)];
    expect((await reconciliationService.candidates(ORG_A, row.id)).map((d) => d.id)).toEqual(["in"]);
  });

  it("manual match resolves the row and audits the actor", async () => {
    const row = await openRow();
    deposits = [dep("D7", "2026-06-02", 95)];
    const user = newUserId();
    const saved = await reconciliationService.matchToDeposit(ORG_A, row.id, "D7", { userId: user, username: "fin" });
    expect(saved).toMatchObject({ status: "RESOLVED", resolution: "MANUAL", depositId: "D7", resolvedByUserId: user });
    const log = await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.matched_manually" } });
    expect(log.actorUserId).toBe(user);
  });

  it("manual match refuses a deposit another payout holds", async () => {
    const other = await seedPayout(ORG_A, { payoutDate: "2026-06-02", totalCents: 50 });
    deposits = [dep("D1", "2026-06-03", 50)];
    await runReconcile(ORG_A, NOW);
    expect((await rowFor(`csv:${other}`)).depositId).toBe("D1");
    const row = await openRow();
    await expect(reconciliationService.matchToDeposit(ORG_A, row.id, "D1", { userId: 1 })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("dismiss requires a reason, then resolves", async () => {
    const row = await openRow();
    await expect(reconciliationService.dismiss(ORG_A, row.id, "  ", { userId: 1 })).rejects.toMatchObject({
      statusCode: 400,
    });
    const saved = await reconciliationService.dismiss(ORG_A, row.id, "booked as a transfer", { userId: 1 });
    expect(saved).toMatchObject({ status: "RESOLVED", resolution: "DISMISSED", reason: "booked as a transfer" });
  });

  it("resolving a settled row is a 409; another org's row is a 404", async () => {
    const row = await openRow();
    await reconciliationService.dismiss(ORG_A, row.id, "x", { userId: 1 });
    await expect(reconciliationService.dismiss(ORG_A, row.id, "y", { userId: 1 })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(reconciliationService.dismiss(ORG_B, row.id, "y", { userId: 1 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describeDb("importPayouts — mirror overlap rule", () => {
  it("rejects CSV rows dated on or after mirrorFrom and stores nothing for them", async () => {
    bind({ mirrorFrom: new Date("2026-06-15T00:00:00Z") });
    const summary = await importPayouts(ORG_A, [
      makePayoutRow({ payoutDate: "2026-06-14", totalCents: 1 }),
      makePayoutRow({ payoutDate: "2026-06-15", totalCents: 2 }),
    ]);
    expect(summary).toMatchObject({ inserted: 1, rejected: 1 });
    expect(summary.rows[1]).toMatchObject({ result: "rejected", reason: "mirror_period" });
    expect(await db.payout.count({ where: { orgId: ORG_A } })).toBe(1);
  });
});
