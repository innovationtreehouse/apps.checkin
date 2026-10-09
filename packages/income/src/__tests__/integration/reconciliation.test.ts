import { it, expect, beforeEach, afterEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureIncome } from "../../runtime";
import { runReconcile, lockReconciliation, collectPayouts } from "../../lib/reconcile";
import { reconciliationService } from "../../services/reconciliationService";
import { seedIncomeDev } from "../../seed";
import type { MirrorBalanceTxn, MirrorPayout, MirrorSource, PayoutMirror, QbDeposit } from "../../contract";
import { clearAll, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

// Fake mirror: `payouts` holds every payout the store knows, in any status.
let payouts: MirrorPayout[];
let txns: Record<string, MirrorBalanceTxn[]>;
let deposits: QbDeposit[];

const NOW = new Date("2026-06-30T12:00:00Z");

const dep = (id: string, txnDate: string, totalCents: number): QbDeposit => ({
  id, txnDate, totalCents, depositToAccount: "Checking",
});

/** Add a paid payout whose transactions sum to its net unless `txnNet` says otherwise. */
function payout(gid: string, day: string, netCents: number, txnNet: number = netCents, source: MirrorSource = "api"): string {
  payouts.push({ payoutGid: gid, issuedAt: new Date(`${day}T00:00:00Z`), status: "paid", netCents, currency: "USD", source });
  txns[gid] = [{ txnGid: `${gid}/t`, type: "charge", orderGid: "O1", orderName: "#1001", amountCents: txnNet, feeCents: 0, netCents: txnNet, source }];
  return gid;
}

function setPayout(gid: string, patch: Partial<MirrorPayout>) {
  payouts = payouts.map((p) => (p.payoutGid === gid ? { ...p, ...patch } : p));
}

const mirror: PayoutMirror = {
  paidPayoutsSince: async (from) => payouts.filter((p) => p.status === "paid" && p.issuedAt >= from),
  payout: async (gid) => payouts.find((p) => p.payoutGid === gid) ?? null,
  transactions: async (gid) => txns[gid] ?? [],
  orderLines: async () => [],
  itemsSeen: async () => [],
};

function bind() {
  configureIncome({
    mirror,
    deposits: { depositsBetween: async (from, to) => deposits.filter((d) => d.txnDate >= from && d.txnDate <= to) },
  });
}

const rowFor = (payoutGid: string, orgId = ORG_A) =>
  db.payoutReconciliation.findUniqueOrThrow({ where: { orgId_payoutGid: { orgId, payoutGid } } });

beforeEach(async () => {
  await clearAll();
  payouts = [];
  txns = {};
  deposits = [];
  bind();
});

afterEach(() => configureIncome({}));

describeDb("runReconcile — automatic transitions", () => {
  it("is a no-op while the deposit source is unbound", async () => {
    configureIncome({ mirror });
    payout("P1", "2026-06-01", 97);
    expect(await runReconcile(ORG_A, NOW)).toEqual({ status: "unbound" });
    expect(await db.payoutReconciliation.count()).toBe(0);
  });

  it("is a no-op while the mirror is unbound", async () => {
    configureIncome({ deposits: { depositsBetween: async () => [] } });
    expect(await runReconcile(ORG_A, NOW)).toEqual({ status: "unbound" });
  });

  it("auto-matches the one unclaimed deposit of equal amount inside the window", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-03", 97), dep("D2", "2026-06-03", 98)];

    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ status: "ran", matched: 1 });
    expect(await rowFor("P1")).toMatchObject({
      status: "MATCHED", resolution: "AUTO", origin: "matched", depositId: "D1", depositTotalCents: 97,
    });
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.matched" } })).toBe(1);
  });

  it("is idempotent: a second run changes nothing", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    const audits = await db.incomeAuditLog.count();

    expect(await runReconcile(ORG_A, NOW)).toEqual({ status: "ran", matched: 0, opened: 0, drifted: 0 });
    expect(await db.incomeAuditLog.count()).toBe(audits);
  });

  it("waits in the outbox inside the window, then opens NO_DEPOSIT once it elapses", async () => {
    payout("P1", "2026-06-25", 97);
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "WAITING", kind: null });

    await runReconcile(ORG_A, new Date("2026-07-03T00:00:00Z"));
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("opens AMBIGUOUS_DEPOSIT when two deposits fit", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97), dep("D2", "2026-06-04", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null });
  });

  it("ignores deposits outside [issuedAt, issuedAt + window]", async () => {
    payout("P1", "2026-06-10", 97);
    deposits = [dep("early", "2026-06-09", 97), dep("late", "2026-06-18", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("opens TXN_SUM_MISMATCH when the transactions do not sum to the payout net", async () => {
    payout("P1", "2026-06-20", 500, 300);
    deposits = [dep("D1", "2026-06-21", 500)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "TXN_SUM_MISMATCH", depositId: null });
  });

  it("a payout with no transactions (unrecovered history) opens TXN_SUM_MISMATCH", async () => {
    payout("P1", "2026-06-20", 500);
    txns.P1 = [];
    deposits = [dep("D1", "2026-06-21", 500)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "TXN_SUM_MISMATCH" });
  });

  it("skips payouts that are not paid", async () => {
    payout("P1", "2026-06-01", 97);
    setPayout("P1", { status: "in_transit" });
    await runReconcile(ORG_A, NOW);
    expect(await db.payoutReconciliation.count()).toBe(0);
  });

  it("a late booking auto-matches an OPEN row", async () => {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    expect((await rowFor("P1")).status).toBe("OPEN");

    deposits = [dep("D1", "2026-06-05", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "MATCHED", kind: null, depositId: "D1" });
  });

  it("one deposit backs one payout: two equal payouts cannot share it", async () => {
    payout("P1", "2026-06-01", 97);
    payout("P2", "2026-06-02", 97);
    deposits = [dep("D1", "2026-06-03", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "MATCHED", depositId: "D1" });
    expect(await rowFor("P2")).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("the database refuses a second claim on the same deposit", async () => {
    const base = { orgId: ORG_A, payoutDate: "2026-06-01", payoutNetCents: 1, status: "MATCHED" };
    await db.payoutReconciliation.create({ data: { ...base, payoutGid: "P1", depositId: "D1" } });
    await expect(
      db.payoutReconciliation.create({ data: { ...base, payoutGid: "P2", depositId: "D1" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps orgs apart: rows land only under the org the run is for", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await db.payoutReconciliation.count({ where: { orgId: ORG_B } })).toBe(0);
  });

  it("returns busy while another holder has the advisory lock", async () => {
    payout("P1", "2026-06-01", 97);
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

describeDb("runReconcile — hand-loaded history", () => {
  it("payout facts carry each payout's source", async () => {
    payout("P1", "2026-06-01", 97);
    payout("P2", "2026-06-02", 50, 50, "hand_loaded");
    const facts = await collectPayouts(mirror);
    expect(facts.map((f) => [f.payoutGid, f.source])).toEqual([["P1", "api"], ["P2", "hand_loaded"]]);
  });

  it("matches a hand-loaded payout exactly like an API one", async () => {
    payout("P1", "2026-06-01", 97, 97, "hand_loaded");
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "MATCHED", depositId: "D1" });
  });

  it("a hand-loaded payout with no recovered transactions opens TXN_SUM_MISMATCH", async () => {
    payout("P1", "2026-06-01", 97, 97, "hand_loaded");
    txns.P1 = [];
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "TXN_SUM_MISMATCH" });
  });
});

describeDb("runReconcile — drift", () => {
  async function matched() {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect((await rowFor("P1")).status).toBe("MATCHED");
  }

  async function dismissed() {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    await reconciliationService.dismiss(ORG_A, (await rowFor("P1")).id, "booked as a transfer", { userId: 1 });
  }

  it("reopens as DRIFT when the matched deposit disappears", async () => {
    await matched();
    deposits = [];
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ drifted: 1 });
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });
  });

  it("reopens as DRIFT when the deposit amount changes", async () => {
    await matched();
    deposits = [dep("D1", "2026-06-02", 90)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT" });
  });

  it("reopens as DRIFT, reason deposit_missing, when the deposit's date moves outside every read window", async () => {
    await matched();
    deposits = [dep("D1", "2026-07-20", 97)];
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ drifted: 1 });
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });
    const log = await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.drift" } });
    expect(log.reason).toBe("deposit_missing");
  });

  it("reopens as DRIFT when the payout net changes", async () => {
    await matched();
    setPayout("P1", { netCents: 90 });
    txns.P1 = [{ ...txns.P1[0], netCents: 90 }];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT", payoutNetCents: 90 });
  });

  it("reopens a MATCHED row as DRIFT when the payout leaves paid", async () => {
    await matched();
    setPayout("P1", { status: "failed" });
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ drifted: 1 });
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });
    const log = await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.drift" } });
    expect(log.reason).toBe("payout_status:failed");
  });

  it("reopens a dismissed row as DRIFT when the payout leaves paid", async () => {
    await dismissed();
    setPayout("P1", { status: "canceled" });
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT" });
  });

  it("reopens a MATCHED row as DRIFT when the payout vanishes from the mirror", async () => {
    await matched();
    payouts = [];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });
  });

  it("a settled payout older than reconcileFrom is still checked for drift", async () => {
    await matched();
    configureIncome({
      mirror,
      deposits: { depositsBetween: async () => deposits },
      reconcileFrom: new Date("2026-06-15T00:00:00Z"),
    });
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ drifted: 0 });
    expect((await rowFor("P1")).status).toBe("MATCHED");
  });

  it("a DRIFT row is never silently re-matched, even when a fitting deposit returns", async () => {
    await matched();
    deposits = [];
    await runReconcile(ORG_A, NOW);
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT" });
  });
});

describeDb("reconciliationService — finance actions", () => {
  async function openRow() {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    return rowFor("P1");
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
    payout("P0", "2026-06-02", 50);
    deposits = [dep("D1", "2026-06-03", 50)];
    const row = await openRow();
    expect((await rowFor("P0")).depositId).toBe("D1");
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

describeDb("reconciliationService.resolve — retry and the pre-seated create states", () => {
  async function postFailed() {
    payout("P1", "2026-06-01", 97);
    return db.payoutReconciliation.create({
      data: { orgId: ORG_A, payoutGid: "P1", payoutDate: "2026-06-01", payoutNetCents: 97, status: "OPEN", kind: "POST_FAILED" },
    });
  }

  it("retry is refused for any row that is not POST_FAILED", async () => {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    const row = await rowFor("P1");
    expect(row.kind).toBe("NO_DEPOSIT");
    await expect(reconciliationService.resolve(ORG_A, row.id, { action: "retry" }, { userId: 1 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("retry on POST_FAILED reports the deposit write as unavailable and changes nothing", async () => {
    const row = await postFailed();
    await expect(reconciliationService.resolve(ORG_A, row.id, { action: "retry" }, { userId: 1 })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "POST_FAILED" });
  });

  it("a run keeps POST_FAILED instead of reclassifying it, but still records a deposit that turns up", async () => {
    await postFailed();
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "POST_FAILED" });

    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "MATCHED", origin: "matched", depositId: "D1" });
  });

  it("resolve dispatches match and dismiss", async () => {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    const row = await rowFor("P1");
    deposits = [dep("D7", "2026-06-02", 95)];
    expect(
      await reconciliationService.resolve(ORG_A, row.id, { action: "match", depositId: "D7" }, { userId: 1 }),
    ).toMatchObject({ status: "RESOLVED", resolution: "MANUAL", origin: "matched" });
  });

  it("a POSTED row is drift-checked like any settled row", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await db.payoutReconciliation.create({
      data: {
        orgId: ORG_A, payoutGid: "P1", payoutDate: "2026-06-01", payoutNetCents: 97, status: "POSTED",
        origin: "created", depositId: "D1", depositTxnDate: "2026-06-02", depositTotalCents: 97,
      },
    });
    await runReconcile(ORG_A, NOW);
    expect((await rowFor("P1")).status).toBe("POSTED");

    deposits = [];
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "DRIFT", origin: null, depositId: null });
  });

  it("a WAITING row is not drift-checked", async () => {
    payout("P1", "2026-06-01", 97);
    setPayout("P1", { status: "failed" });
    await db.payoutReconciliation.create({
      data: { orgId: ORG_A, payoutGid: "P1", payoutDate: "2026-06-01", payoutNetCents: 97, status: "WAITING" },
    });
    await runReconcile(ORG_A, NOW);
    expect((await rowFor("P1")).status).toBe("WAITING");
  });
});

describeDb("IncomeQbMatchExclusion — finance excludes a deposit from matching", () => {
  const exclude = (qbTxnId: string, reason = "owner draw, not a payout") =>
    reconciliationService.excludeDeposit(ORG_A, qbTxnId, reason, { userId: 42 });

  it("an excluded deposit is never auto-matched", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await exclude("D1");
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", depositId: null });
  });

  it("excluding one of two candidates leaves a clean match", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97), dep("D2", "2026-06-03", 97)];
    await exclude("D1");
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "MATCHED", depositId: "D2" });
  });

  it("an excluded deposit is not offered or accepted as a manual candidate", async () => {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    const row = await rowFor("P1");
    deposits = [dep("D1", "2026-06-02", 95)];
    await exclude("D1");
    expect(await reconciliationService.candidates(ORG_A, row.id)).toEqual([]);
    await expect(reconciliationService.matchToDeposit(ORG_A, row.id, "D1", { userId: 1 })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("exclusion is per org", async () => {
    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await reconciliationService.excludeDeposit(ORG_B, "D1", "other org", { userId: 1 });
    await runReconcile(ORG_A, NOW);
    expect(await rowFor("P1")).toMatchObject({ status: "MATCHED", depositId: "D1" });
  });

  it("records who excluded it and why, and audits it", async () => {
    const saved = await exclude("D9", "  transfer between accounts ");
    expect(saved).toMatchObject({ orgId: ORG_A, qbTxnId: "D9", reason: "transfer between accounts", excludedByUserId: 42 });
    expect(await db.incomeAuditLog.count({ where: { action: "deposit.excluded", entityId: String(saved.id) } })).toBe(1);
    expect(await reconciliationService.listExclusions(ORG_A)).toMatchObject([{ qbTxnId: "D9" }]);
    expect(await reconciliationService.listExclusions(ORG_B)).toEqual([]);
  });

  it("requires a reason, refuses a duplicate, and refuses a deposit a payout holds", async () => {
    await expect(exclude("D9", " ")).rejects.toMatchObject({ statusCode: 400 });
    await exclude("D9");
    await expect(exclude("D9")).rejects.toMatchObject({ statusCode: 409 });

    payout("P1", "2026-06-01", 97);
    deposits = [dep("D1", "2026-06-02", 97)];
    await runReconcile(ORG_A, NOW);
    await expect(exclude("D1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describeDb("matchToDeposit — claims and exclusions are read under the lock", () => {
  it("refuses a deposit excluded after QuickBooks was read but before the match commits", async () => {
    payout("P1", "2026-06-01", 97);
    await runReconcile(ORG_A, NOW);
    const row = await rowFor("P1");
    configureIncome({
      mirror,
      deposits: {
        depositsBetween: async () => {
          // A concurrent exclusion lands while the QuickBooks read is in flight.
          await new Promise((r) => setTimeout(r, 50));
          await db.incomeQbMatchExclusion.create({
            data: { orgId: ORG_A, qbTxnId: "D1", reason: "concurrent", excludedByUserId: 2 },
          });
          return [dep("D1", "2026-06-02", 97)];
        },
      },
    });
    await expect(reconciliationService.matchToDeposit(ORG_A, row.id, "D1", { userId: 1 })).rejects.toMatchObject({
      statusCode: 422,
    });
    expect((await rowFor("P1")).status).toBe("OPEN");
  });
});

describeDb("IncomeItemCategory", () => {
  it("maps a variant to one bucket per org, with no FK to the bucket table", async () => {
    const variantId = "gid://shopify/ProductVariant/1";
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId, budgetOwnerId: 999 } });
    await db.incomeItemCategory.create({ data: { orgId: ORG_B, variantId, budgetOwnerId: 2 } });
    await expect(
      db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId, budgetOwnerId: 2 } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describeDb("seedIncomeDev", () => {
  it("seeds one OPEN NO_DEPOSIT row, idempotently", async () => {
    await seedIncomeDev(ORG_A);
    await seedIncomeDev(ORG_A);
    const rows = await db.payoutReconciliation.findMany({ where: { orgId: ORG_A } });
    expect(rows).toMatchObject([{ status: "OPEN", kind: "NO_DEPOSIT" }]);
  });
});
