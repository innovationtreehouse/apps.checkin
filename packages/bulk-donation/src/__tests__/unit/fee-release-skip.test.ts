/** A fees-only row finance released drops out of account determination; the rest of the batch books. */
import { describe, it, expect } from "vitest";
import { runAccountDetermination } from "../../lib/disbursement-processor";
import type { DbOrTx } from "../../db";

const rule = {
  id: 1, orgId: "org-1", companyName: "Acme Corp", corporatePeerCampaign: "*", donationMethod: "check", donationType: "standard",
  donationAccount: "4000-Donations", matchAccount: "4001-Match", donationAccountId: "60", matchAccountId: "61",
};
const row = (over: Record<string, unknown>) => ({
  id: 1, transactionId: "t1", disbursementDate: "2025-01-15", disbursementFrom: "Benevity", companyName: "Acme Corp",
  corporatePeerCampaign: null, donationMethod: "check", donationType: "standard", donationAmountCents: 0, matchAmountCents: 0,
  causeSupportFeeCents: 0, merchantFeeCents: 0, checkFeeCents: 0, feeReleasedAt: null, ...over,
});
const handle = (txs: unknown[]) =>
  ({ transaction: { findMany: async () => txs }, accountMap: { findMany: async () => [rule] } }) as unknown as DbOrTx;

describe("released fees-only row", () => {
  it("still holds an unreleased fees-only row", async () => {
    const result = await runAccountDetermination(handle([row({ causeSupportFeeCents: 250 })]), "org-1", "d1");
    expect(result.type).toBe("ACCOUNT_UNRESOLVED");
  });

  it("skips a released row and books the rest without its fee", async () => {
    const result = await runAccountDetermination(
      handle([
        row({ id: 1, transactionId: "fee", causeSupportFeeCents: 250, feeReleasedAt: new Date() }),
        row({ id: 2, transactionId: "gift", donationAmountCents: 1000 }),
      ]),
      "org-1",
      "d1",
    );
    expect(result.type).toBe("PROCESS_SUCCEEDED");
    if (result.type !== "PROCESS_SUCCEEDED") return;
    expect(result.payload.items).toEqual([
      { type: "donation", account: "4000-Donations", accountId: "60", amountCents: 1000, transactionId: "gift" },
    ]);
  });
});
