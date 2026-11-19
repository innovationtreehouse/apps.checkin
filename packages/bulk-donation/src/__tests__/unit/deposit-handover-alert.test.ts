/** The hand-over job's finance alert: an alert not sent keeps the job's counts; any other error fails the job. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomeDeposits } from "../../contract";

const recordEvent = vi.hoisted(() => vi.fn());
const deposits = vi.hoisted(() => ({ current: undefined as IncomeDeposits | undefined }));
const payload = JSON.stringify({ version: 1, orgId: "org-1", disbursementId: "TEST-1", disbursementDate: null, disbursementFrom: "Benevity", items: [] });

vi.mock("../../db", () => ({
  db: {
    disbursementEvent: { findMany: async () => [{ orgId: "org-1", disbursementId: "TEST-1", payload }] },
    workflowEvent: { findMany: async () => [] },
  },
}));
vi.mock("../../repositories/audit", () => ({ recordEvent }));
vi.mock("../../runtime", () => ({ getIncomeDeposits: () => deposits.current }));

import { runDonationDepositHandOver } from "../../lib/deposit-handover";

function income(handOverFailing: IncomeDeposits["handOverFailing"]): IncomeDeposits {
  return { prod: false, expectDeposit: async () => "recorded", depositStatus: async () => ({}), handOverFailing };
}

describe("runDonationDepositHandOver's finance alert", () => {
  beforeEach(() => recordEvent.mockReset());

  it("returns its counts and leaves the failure unraised when the alert is not sent", async () => {
    deposits.current = income(async () => false);
    await expect(runDonationDepositHandOver("org-1")).resolves.toEqual({ acknowledged: 0, sent: 0, failed: 1 });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("throws an unexpected alert error, so the step is marked crashed", async () => {
    deposits.current = income(async () => {
      throw new Error("Cannot find module '@/lib/emailRecipients'");
    });
    await expect(runDonationDepositHandOver("org-1")).rejects.toThrow("Cannot find module");
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
