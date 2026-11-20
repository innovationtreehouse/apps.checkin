/** System Status's picks row: the donation account map and gift-of-goods line accounts checked against the app's QuickBooks list. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bulkDonationRuntime, configureBulkDonation } from "../../runtime";
import { misTypedQuickBooksPicks } from "../../services/quickBooksPicks";
import { db } from "../../db";

vi.mock("../../db", () => ({
  db: {
    accountMap: { findMany: vi.fn(async () => []) },
    inKindDonationLine: { findMany: vi.fn(async () => []) },
    manualInKindDonationLine: { findMany: vi.fn(async () => []) },
    inKindPosting: { findMany: vi.fn(async () => []) },
  },
}));

const ORG = "00000000-0000-0000-0000-000000000001";
const ACCOUNTS = [
  { id: "400", name: "Donations", accountType: "Income", active: true },
  { id: "600", name: "Supplies", accountType: "Expense", active: true },
  { id: "150", name: "Equipment", accountType: "Fixed Asset", active: true },
];
const LATHE = 7;

beforeEach(() => {
  vi.clearAllMocks();
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) },
    org: async () => ({ id: ORG, name: "Test Org" }),
  });
});
afterEach(() => bulkDonationRuntime.reset());

const map = (donationAccountId: string | null, matchAccountId: string | null) => ({ companyName: "Acme", corporatePeerCampaign: "Match", donationAccountId, matchAccountId });

describe("bulk-donation misTypedQuickBooksPicks", () => {
  it("passes picks of an accepted type", async () => {
    vi.mocked(db.accountMap.findMany).mockResolvedValueOnce([map("400", null)] as never);
    vi.mocked(db.inKindDonationLine.findMany).mockResolvedValueOnce([{ id: 1, donationId: 3, quickBooksAccountId: "600" }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([]);
  });

  it("flags a missing pick and a pick of the wrong type, naming where to re-pick", async () => {
    vi.mocked(db.accountMap.findMany).mockResolvedValueOnce([map("999", "600")] as never);
    vi.mocked(db.manualInKindDonationLine.findMany).mockResolvedValueOnce([{ id: 2, donationId: 4, quickBooksAccountId: "400" }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([
      "Donation account map, Acme / Match, donation account: QuickBooks' list in the app doesn't have an account with id 999",
      "Donation account map, Acme / Match, match account: A rule's match account takes an Income or Other Income account; QuickBooks' list in the app shows Supplies as Expense",
      "Gifts of goods, manual gift 4, line 2: A donated item takes an Expense, Other Expense, or Cost of Goods Sold account; QuickBooks' list in the app shows Donations as Income",
    ]);
  });

  it("checks a line finance made capital against Fixed Asset", async () => {
    vi.mocked(db.inKindDonationLine.findMany).mockResolvedValueOnce([{ id: LATHE, donationId: 3, quickBooksAccountId: "600", isCapital: true }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([
      "Gifts of goods, receipt gift 3, line 7: Donated equipment takes a Fixed Asset account; QuickBooks' list in the app shows Supplies as Expense",
    ]);
  });

  it("skips a line on a gift already booked", async () => {
    vi.mocked(db.inKindPosting.findMany).mockResolvedValueOnce([{ source: "receipt", giftId: 3 }] as never);
    vi.mocked(db.inKindDonationLine.findMany).mockResolvedValueOnce([{ id: 1, donationId: 3, quickBooksAccountId: "400" }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([]);
    expect(db.inKindPosting.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG, matchState: { in: ["MATCHED", "CREATED", "POSTING", "DISMISSED"] } },
      select: { source: true, giftId: true },
    });
  });
});
