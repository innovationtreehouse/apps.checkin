/**
 * Donation hands every completed disbursement's deposit to income (QB_ENTRY_OWNERSHIP): the call
 * after the completion commit with its re-send job, and no call of its own to QuickBooks.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import type { DepositHandOverFailure, DonationDepositStatus, DonationExpectedDeposit, IncomeDeposits } from "../../contract";
import { makeAccountMapRule, makeFile, makeTransaction, TEST_ORG_ID, TEST_OWNERS } from "../helpers/factories";
import { sendDisbursementEvent } from "../../workflows/disbursement.actor";
import { handOverDeposit, runDonationDepositHandOver } from "../../lib/deposit-handover";

const orgId = TEST_ORG_ID;

class FakeIncome implements IncomeDeposits {
  prod = false;
  expected = new Map<string, DonationExpectedDeposit>();
  statuses = new Map<string, DonationDepositStatus>();
  calls: string[] = [];
  expectFails = false;
  raised: DepositHandOverFailure[][] = [];

  async expectDeposit(_orgId: string, id: string, expected: DonationExpectedDeposit) {
    this.calls.push(`expect:${id}`);
    if (this.expectFails) throw new Error("income is down");
    this.expected.set(id, expected);
    this.statuses.set(id, { state: "waiting" });
    return "recorded";
  }
  async handOverFailing(failures: DepositHandOverFailure[]) {
    this.raised.push(failures);
  }
  async depositStatus(_orgId: string, ids: string[]) {
    this.calls.push("status");
    return Object.fromEntries(ids.flatMap((id) => (this.statuses.has(id) ? [[id, this.statuses.get(id)!] as const] : [])));
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

/** A completed disbursement: its gifts and its event. */
async function completed(disbursementId: string, overrides: { date?: string | null; feeCents?: number } = {}) {
  const { date = "2026-09-10", feeCents = 50 } = overrides;
  const file = await makeFile(orgId);
  const tx = await makeTransaction(orgId, file.id, { disbursementId, disbursementDate: "2026-09-10", ownerId: 1 });
  const items = [
    { type: "donation", account: "4000-Donations", amountCents: 1000, transactionId: tx.transactionId },
    { type: "fees", account: "6000-Fees", amountCents: feeCents, transactionId: tx.transactionId },
  ];
  const payload = { version: 1, orgId, disbursementId, disbursementDate: date, disbursementFrom: "Benevity", items };
  return db.disbursementEvent.create({ data: { orgId, disbursementId, payload: JSON.stringify(payload) } });
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
  await makeAccountMapRule(orgId);
  income = new FakeIncome();
  // Donation never reaches QuickBooks: any HTTP call fails the test.
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
  it("hands a disbursement to income once its completion has committed, with lines by kind and bucket", async () => {
    await complete("TEST-C1");

    expect(income.calls).toEqual(["expect:TEST-C1"]);
    expect(income.expected.get("TEST-C1")).toEqual({
      txnDate: "2026-09-10",
      netCents: 1000,
      bankRole: "BENEVITY_BANK",
      lines: [{ role: "BENEVITY_DONATIONS", budgetOwnerId: 1, amountCents: 1000, description: "Benevity donations" }],
      memo: "Benevity disbursement TEST-C1",
    });
  });

  it("a failed call leaves the disbursement completed, and the re-send job hands it over; a repeat sends nothing", async () => {
    income.expectFails = true;
    await complete("TEST-C1");
    expect(income.expected.size).toBe(0);

    income.expectFails = false;
    expect(await runDonationDepositHandOver(orgId)).toEqual({ acknowledged: 0, sent: 1, failed: 0 });
    expect(income.expected.has("TEST-C1")).toBe(true);
    expect(await runDonationDepositHandOver(orgId)).toEqual({ acknowledged: 1, sent: 0, failed: 0 });
  });

  it("a disbursement that never completed is never handed over", async () => {
    await handOverDeposit(orgId, "TEST-NONE");
    expect(income.calls).toEqual([]);
  });

  it("outside prod only TEST- disbursements go over; prod never sends one", async () => {
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

  it("raises a stored batch with no date to finance once, however many runs fail it", async () => {
    await completed("TEST-NODATE", { date: null });

    expect(await runDonationDepositHandOver(orgId)).toEqual({ acknowledged: 0, sent: 0, failed: 1 });
    expect(await runDonationDepositHandOver(orgId)).toEqual({ acknowledged: 0, sent: 0, failed: 1 });

    expect(income.raised).toEqual([[{ disbursementId: "TEST-NODATE", reason: "it has no disbursement date" }]]);
    expect(income.expected.size).toBe(0);
  });

  it.each([
    ["zero", 1000],
    ["less", 1500],
  ])("raises a batch netting to %s, and hands over nothing", async (_net, feeCents) => {
    await completed("TEST-NET", { feeCents });

    await runDonationDepositHandOver(orgId);

    expect(income.raised).toEqual([[{ disbursementId: "TEST-NET", reason: "it nets to zero or less, so no deposit is due" }]]);
    expect(income.expected.size).toBe(0);
  });

  it("raises income refusing a batch in plain words, and sends the batch once income recovers", async () => {
    await completed("TEST-DOWN");
    income.expectFails = true;

    await runDonationDepositHandOver(orgId);
    expect(income.raised).toEqual([[{ disbursementId: "TEST-DOWN", reason: "income did not take it, and the daily job keeps trying" }]]);

    income.expectFails = false;
    expect(await runDonationDepositHandOver(orgId)).toEqual({ acknowledged: 0, sent: 1, failed: 0 });
    expect(income.raised).toHaveLength(1);
  });

  it("raises again next run when the alert itself fails", async () => {
    await completed("TEST-ALERT", { date: null });
    const handOverFailing = vi.spyOn(income, "handOverFailing").mockRejectedValueOnce(new Error("mail is down"));

    await expect(runDonationDepositHandOver(orgId)).rejects.toThrow("mail is down");
    await runDonationDepositHandOver(orgId);

    expect(handOverFailing).toHaveBeenCalledTimes(2);
    expect(income.raised).toHaveLength(1);
  });
});
