/** An account rule's save refuses an account QuickBooks lists under a type a gift can't book to. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bulkDonationRuntime, configureBulkDonation } from "../../runtime";
import { createAccountMap, updateAccountMap } from "../../routes/rules";
import { accountMapService } from "../../services/accountMapService";

vi.mock("../../services/accountMapService", () => ({
  accountMapService: { createAccountMap: vi.fn(async () => ({ id: 1 })), updateAccountMap: vi.fn(async () => ({ id: 1 })), findAccountMap: vi.fn(async () => null) },
}));

const ACCOUNTS = [
  { id: "8003", name: "Donations:Benevity", accountType: "Income", active: true },
  { id: "8001", name: "Checking", accountType: "Bank", active: true },
];

const configure = (quickBooksAccounts?: () => Promise<typeof ACCOUNTS>) =>
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) },
    org: async () => ({ id: "00000000-0000-0000-0000-000000000001", name: "Test Org" }),
    quickBooksAccounts,
  });

const rule = (accounts: { donationAccountId?: string | null; matchAccountId?: string | null }) =>
  new Request("http://test/account-map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyName: "Acme", corporatePeerCampaign: "*", ...accounts }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  configure(async () => ACCOUNTS);
});
afterEach(() => bulkDonationRuntime.reset());

describe("account rule save", () => {
  it("saves a rule whose accounts are Income", async () => {
    await createAccountMap({ req: rule({ donationAccountId: "8003", matchAccountId: "8003" }), params: {} });
    expect(accountMapService.createAccountMap).toHaveBeenCalled();
  });

  it("refuses a donation account of another type, naming it", async () => {
    await expect(createAccountMap({ req: rule({ donationAccountId: "8001" }), params: {} })).rejects.toMatchObject({
      status: 400,
      message: "A rule's donation account takes an Income or Other Income account; Checking is Bank",
    });
    expect(accountMapService.createAccountMap).not.toHaveBeenCalled();
  });

  it("refuses a match account on update", async () => {
    await expect(updateAccountMap({ req: rule({ matchAccountId: "8001" }), params: { id: "1" } })).rejects.toMatchObject({ status: 400 });
    expect(accountMapService.updateAccountMap).not.toHaveBeenCalled();
  });

  it("saves a rule whose accounts are unchanged without reading QuickBooks", async () => {
    vi.mocked(accountMapService.findAccountMap).mockResolvedValueOnce({ donationAccountId: "8001", matchAccountId: "8003" } as never);
    const read = vi.fn(async () => ACCOUNTS);
    configure(read);
    await updateAccountMap({ req: rule({ donationAccountId: "8001", matchAccountId: "8003" }), params: { id: "1" } });
    expect(read).not.toHaveBeenCalled();
    expect(accountMapService.updateAccountMap).toHaveBeenCalled();
  });

  it("checks only the account that changed", async () => {
    vi.mocked(accountMapService.findAccountMap).mockResolvedValueOnce({ donationAccountId: "8003", matchAccountId: "8003" } as never);
    await expect(updateAccountMap({ req: rule({ donationAccountId: "8003", matchAccountId: "8001" }), params: { id: "1" } })).rejects.toMatchObject({
      status: 400,
      message: "A rule's match account takes an Income or Other Income account; Checking is Bank",
    });
  });

  it("saves a rule without accounts without reading QuickBooks", async () => {
    const read = vi.fn(async () => ACCOUNTS);
    configure(read);
    await createAccountMap({ req: rule({}), params: {} });
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 503 while QuickBooks isn't bound", async () => {
    configure();
    await expect(createAccountMap({ req: rule({ donationAccountId: "8003" }), params: {} })).rejects.toMatchObject({ status: 503 });
  });
});
