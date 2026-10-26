/**
 * Donation hands every completed disbursement's deposit to income (QB_ENTRY_OWNERSHIP PR 2):
 * the call after the completion commit with its re-send job, the one-off move of donation's
 * holdings that waits for in-flight posts, the switch-off, and the screens' status reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import type { DonationDepositStatus, DonationExpectedDeposit, DonationHoldingsMove, IncomeDeposits } from "../../contract";
import { makeAccountMapRule, makeFile, makeTransaction, TEST_ORG_ID, TEST_OWNERS } from "../helpers/factories";
import { sendDisbursementEvent } from "../../workflows/disbursement.actor";
import { HANDOVER_STOPPED, handOverDeposit, runDonationDepositHandOver, withIncomeStatus } from "../../lib/deposit-handover";
import { QB_EVENT, STALE_CLAIM_MS } from "../../lib/qb-poster";
import { disbursements } from "../../routes";

const orgId = TEST_ORG_ID;

class FakeIncome implements IncomeDeposits {
  prod = false;
  expected = new Map<string, DonationExpectedDeposit>();
  statuses = new Map<string, DonationDepositStatus>();
  calls: string[] = [];
  expectFails = false;
  adoptError: string | null = null;
  moves: DonationHoldingsMove[] = [];
  alerts: string[] = [];

  async expectDeposit(_orgId: string, id: string, expected: DonationExpectedDeposit) {
    this.calls.push(`expect:${id}`);
    if (this.expectFails) throw new Error("income is down");
    this.expected.set(id, expected);
    this.statuses.set(id, { state: "waiting" });
    return "recorded";
  }
  async depositStatus(_orgId: string, ids: string[]) {
    this.calls.push("status");
    return Object.fromEntries(ids.flatMap((id) => (this.statuses.has(id) ? [[id, this.statuses.get(id)!] as const] : [])));
  }
  async adoptHoldings(_orgId: string, move: DonationHoldingsMove) {
    this.calls.push("adopt");
    if (this.adoptError) throw new Error(this.adoptError);
    this.moves.push(move);
  }
  async moveStopped({ cause }: { orgId: string; cause: string }) {
    this.alerts.push(cause);
  }
}

let income: FakeIncome;

function bind() {
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "testfinance" }) },
    org: async () => ({ id: orgId, name: "Test Org" }),
    owners: { list: async () => TEST_OWNERS },
    deposits: income,
  });
}

const handedOver = () => db.donationOrgSettings.create({ data: { orgId, depositsHandedOverAt: new Date(Date.now() - 60_000) } });
const marker = async () => (await db.donationOrgSettings.findUnique({ where: { orgId } }))?.depositsHandedOverAt ?? null;

/** A completed disbursement as donation's drain left it: its gifts and its event. */
async function completed(disbursementId: string, data: Record<string, unknown> = {}, date: string | null = "2026-09-10") {
  const file = await makeFile(orgId);
  const tx = await makeTransaction(orgId, file.id, { disbursementId, disbursementDate: date ?? "2026-09-10", ownerId: 1 });
  const items = [
    { type: "donation", account: "4000-Donations", amountCents: 1000, transactionId: tx.transactionId },
    { type: "fees", account: "6000-Fees", amountCents: 50, transactionId: tx.transactionId },
  ];
  const payload = { version: 1, orgId, disbursementId, disbursementDate: date, disbursementFrom: "Benevity", items };
  return db.disbursementEvent.create({ data: { orgId, disbursementId, payload: JSON.stringify(payload), ...data } });
}

/** Complete a disbursement through the workflow, as an upload or owner assignment does. */
async function complete(disbursementId: string) {
  const file = await makeFile(orgId);
  await makeTransaction(orgId, file.id, { disbursementId, disbursementDate: "2026-09-10", ownerId: 1, donationAmountCents: 1000 });
  await sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true });
  expect(await db.disbursementEvent.count({ where: { orgId, disbursementId } })).toBe(1);
}

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});
  await db.donationQbMatchExclusion.deleteMany({});
  await db.donationOrgSettings.deleteMany({});
  await makeAccountMapRule(orgId);
  income = new FakeIncome();
  // Donation never reaches QuickBooks any more: any HTTP call fails the test.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("donation called out");
  }));
  bind();
});

afterEach(() => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describeDb("hand-over after the completion commit, with its re-send job", () => {
  it("hands a disbursement to income once its completion has committed, with lines by kind, account and bucket", async () => {
    await handedOver();
    await complete("TEST-C1");

    expect(income.calls).toEqual(["expect:TEST-C1"]);
    expect(income.expected.get("TEST-C1")).toEqual({
      txnDate: "2026-09-10",
      netCents: 1000,
      bankRole: "BENEVITY_BANK",
      lines: [{ role: "BENEVITY_DONATIONS", budgetOwnerId: 1, amountCents: 1000, description: "Benevity donations", accountName: "4000-Donations" }],
      memo: "Benevity disbursement TEST-C1",
    });
  });

  it("a failed call leaves the disbursement completed, and the re-send job hands it over; a repeat sends nothing", async () => {
    await handedOver();
    income.expectFails = true;
    await complete("TEST-C1");
    expect(income.expected.size).toBe(0);

    income.expectFails = false;
    expect(await runDonationDepositHandOver(orgId)).toEqual({ move: "done", acknowledged: 0, sent: 1, failed: 0 });
    expect(income.expected.has("TEST-C1")).toBe(true);
    expect(await runDonationDepositHandOver(orgId)).toEqual({ move: "done", acknowledged: 1, sent: 0, failed: 0 });
  });

  it("a disbursement that never completed is never handed over", async () => {
    await handedOver();
    await handOverDeposit(orgId, "TEST-NONE");
    expect(income.calls).toEqual([]);
  });

  it("outside prod only TEST- disbursements go over; prod never sends one", async () => {
    await handedOver();
    await completed("REAL-1");
    await completed("TEST-1");
    await runDonationDepositHandOver(orgId);
    expect([...income.expected.keys()]).toEqual(["TEST-1"]);

    income = new FakeIncome();
    income.prod = true;
    bind();
    await runDonationDepositHandOver(orgId);
    expect([...income.expected.keys()]).toEqual(["REAL-1"]);
  });
});

describeDb("the move of donation's holdings", () => {
  it("makes no port call before the move: a completion waits for the re-send job", async () => {
    await complete("TEST-C1");
    expect(income.calls).toEqual([]);
  });

  it("waits while a donation post may be in flight, and moves once every claim is past the stale time", async () => {
    const e = await completed("TEST-A", { qbMatchState: "POSTING", qbCreateAttemptedAt: new Date() });
    const claim = await db.workflowEvent.create({
      data: { orgId, entityType: "disbursement", entityId: "TEST-A", disbursementId: "TEST-A", eventType: QB_EVENT.CLAIMED, occurredAt: new Date() },
    });

    expect(await runDonationDepositHandOver(orgId)).toMatchObject({ move: "in_flight" });
    expect(income.calls).toEqual([]);
    expect(await marker()).toBeNull();

    await db.workflowEvent.update({ where: { id: claim.id }, data: { occurredAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) } });
    expect(await runDonationDepositHandOver(orgId)).toMatchObject({ move: "moved" });
    expect(income.calls).toEqual(["adopt", "status", "expect:TEST-A"]);
    expect(income.moves[0].holdings).toEqual([
      expect.objectContaining({ sourceKey: "TEST-A", state: "waiting", createAttemptedAt: e.qbCreateAttemptedAt, createdAt: e.createdAt }),
    ]);
    expect(await marker()).not.toBeNull();
  });

  it("copies each disbursement's QuickBooks state, donation's exclusions and its posting stamp", async () => {
    const on = new Date("2026-09-01T00:00:00Z");
    await db.donationOrgSettings.create({ data: { orgId, qbPostingOnAt: on } });
    await completed("TEST-M", { qbMatchState: "MATCHED", qbTxnId: "501", qbDepositTotalCents: 950, qbDepositTxnDate: "2026-09-11" });
    await completed("TEST-C", { qbMatchState: "CREATED", qbTxnId: "502", qbDepositTotalCents: 950, qbDepositTxnDate: "2026-09-10", qbNote: "check it" });
    await completed("TEST-D", { qbMatchState: "DRIFT", qbDriftedTxnId: "503", qbDriftCause: "deposit_changed" });
    await completed("TEST-X", { qbMatchState: "DISMISSED" });
    await db.workflowEvent.create({
      data: { orgId, entityType: "disbursement", entityId: "TEST-X", eventType: QB_EVENT.STATE, actorUserId: 7, payload: JSON.stringify({ to: "DISMISSED", reason: "booked by journal entry" }) },
    });
    await completed("TEST-U", { qbMatchState: "BEFORE_LINE" });
    await completed("TEST-N", { qbMatchState: "NEEDS_FINANCE" });
    await completed("TEST-T", { qbMatchState: "NOT_TEST_DATA" });
    await db.donationQbMatchExclusion.create({ data: { orgId, qbTxnId: "777", reason: "payroll", excludedByUserId: 3 } });

    await runDonationDepositHandOver(orgId);

    const [move] = income.moves;
    const by = Object.fromEntries(move.holdings.map((h) => [h.sourceKey, h]));
    expect(by["TEST-M"]).toMatchObject({ state: "matched", depositId: "501", depositTotalCents: 950, depositTxnDate: "2026-09-11", netCents: 950 });
    expect(by["TEST-C"]).toMatchObject({ state: "created", depositId: "502", note: "check it" });
    expect(by["TEST-D"]).toMatchObject({ state: "drifted", depositId: "503", driftCause: "deposit_changed" });
    expect(by["TEST-X"]).toMatchObject({ state: "dismissed", dismissal: { reason: "booked by journal entry", byUserId: 7 } });
    expect(by["TEST-U"]).toMatchObject({ state: "unbooked" });
    expect(by["TEST-N"]).toMatchObject({ state: "needs_finance" });
    expect(by["TEST-T"]).toBeUndefined();
    expect(by["TEST-M"].expected).toMatchObject({ txnDate: "2026-09-10", netCents: 950, bankRole: "BENEVITY_BANK" });
    expect(by["TEST-M"].expected!.lines).toEqual([
      expect.objectContaining({ role: "BENEVITY_DONATIONS", amountCents: 1000, accountName: "4000-Donations", budgetOwnerId: 1 }),
      expect.objectContaining({ role: "BENEVITY_FEES", amountCents: -50, accountName: "6000-Fees", budgetOwnerId: 1 }),
    ]);
    expect(move.exclusions).toEqual([expect.objectContaining({ qbTxnId: "777", reason: "payroll", excludedByUserId: 3 })]);
    expect(move.postingOnAt).toEqual(on);
  });

  it("a stop writes no marker, alerts finance once per cause, and retries daily", async () => {
    await completed("TEST-A", { qbMatchState: "MATCHED", qbTxnId: "501" });
    income.adoptError = "deposit 501 held by disbursement TEST-A is already held by payout 9";

    expect(await runDonationDepositHandOver(orgId)).toMatchObject({ move: "stopped" });
    expect(await runDonationDepositHandOver(orgId)).toMatchObject({ move: "stopped" });
    expect(income.alerts).toEqual([income.adoptError]);
    expect(await marker()).toBeNull();
    expect(await db.workflowEvent.count({ where: { orgId, eventType: HANDOVER_STOPPED } })).toBe(1);

    income.adoptError = "deposit 501 held by disbursement TEST-A is already held by payout 10";
    await runDonationDepositHandOver(orgId);
    expect(income.alerts).toHaveLength(2);

    income.adoptError = null;
    expect(await runDonationDepositHandOver(orgId)).toMatchObject({ move: "moved" });
    expect(await marker()).not.toBeNull();
  });

  it("stops on an unsettled disbursement it cannot build, naming it, without calling income", async () => {
    await completed("TEST-A", { qbMatchState: "UNMATCHED" }, null);

    expect(await runDonationDepositHandOver(orgId)).toMatchObject({ move: "stopped" });
    expect(income.calls).toEqual([]);
    expect(income.alerts).toEqual([expect.stringContaining("disbursement TEST-A cannot be handed to income: the disbursement has no date")]);
  });
});

describeDb("the screens read income's status", () => {
  const list = async () =>
    (await disbursements.listEvents({ req: new Request("http://test/api/donations/disbursement-events"), params: {} })).DisbursementEvent as {
      disbursementId: string; qbMatchState: string; qbTxnId: string | null;
    }[];

  it("shows donation's own state before the move and income's after", async () => {
    await completed("TEST-A", { qbMatchState: "AMBIGUOUS" });
    await completed("TEST-B", { qbMatchState: "UNMATCHED" });
    income.statuses.set("TEST-A", { state: "booked", depositId: "9001", txnDate: "2026-09-10", totalCents: 950 });

    expect((await list()).map((r) => [r.disbursementId, r.qbMatchState])).toEqual([["TEST-B", "UNMATCHED"], ["TEST-A", "AMBIGUOUS"]]);
    await handedOver();
    expect((await list()).map((r) => [r.disbursementId, r.qbMatchState, r.qbTxnId])).toEqual([
      ["TEST-B", "UNMATCHED", null],
      ["TEST-A", "CREATED", "9001"],
    ]);
  });
});

describe("withIncomeStatus", () => {
  const row = { disbursementId: "D", qbMatchState: "AMBIGUOUS", qbTxnId: "1", qbNote: "old", qbDepositTotalCents: 1, qbDepositTxnDate: "2026-01-01" };
  it("maps each status onto donation's own fields", () => {
    expect(withIncomeStatus(row, undefined)).toMatchObject({ qbMatchState: "UNMATCHED", qbTxnId: null, qbNote: null });
    expect(withIncomeStatus(row, { state: "waiting" })).toMatchObject({ qbMatchState: "WAITING", qbTxnId: null });
    expect(withIncomeStatus(row, { state: "matched", depositId: "5", txnDate: "2026-09-11", totalCents: 900 })).toMatchObject({
      qbMatchState: "MATCHED", qbTxnId: "5", qbDepositTotalCents: 900, qbDepositTxnDate: "2026-09-11",
    });
    expect(withIncomeStatus(row, { state: "with_finance", kind: "NO_DEPOSIT", note: "n" })).toMatchObject({ qbMatchState: "NEEDS_FINANCE", qbNote: "n" });
    expect(withIncomeStatus(row, { state: "drifted", note: "d" })).toMatchObject({ qbMatchState: "DRIFT", qbNote: "d" });
    expect(withIncomeStatus(row, { state: "dismissed", reason: "r" })).toMatchObject({ qbMatchState: "DISMISSED", qbNote: "r" });
  });
});
