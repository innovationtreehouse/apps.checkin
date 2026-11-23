/** Finance's hand-set account on a held gift-of-goods line takes Fixed Asset for a capital line, else an expense type. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bulkDonationRuntime, configureBulkDonation } from "../../runtime";
import { resolveInKindQb } from "../../lib/in-kind-resolve";
import { db } from "../../db";

const line = vi.hoisted(() => ({ isCapital: false as boolean | null }));
vi.mock("../../db", () => ({
  db: {
    $transaction: vi.fn(async () => {}),
    inKindDonation: { findFirst: vi.fn(async () => ({ receiptId: "r1" })) },
    inKindDonationLine: { findFirst: vi.fn(async () => ({ isCapital: line.isCapital })) },
  },
  isUniqueConstraintError: () => false,
}));
vi.mock("../../services/inKindAcceptService", () => ({ inKindAcceptService: { queueItem: vi.fn(async () => ({})) }, inKindReadiness: vi.fn() }));

const ORG = "00000000-0000-0000-0000-000000000001";
const ACCOUNTS = [
  { id: "600", name: "Supplies", accountType: "Expense", active: true },
  { id: "150", name: "Equipment", accountType: "Fixed Asset", active: true },
];
const LATHE = 7;
const ACTOR = { actorUserId: 1, actorUsername: "finance", correlationId: null };

function configure(assets: number[], quickBooksAccounts?: () => Promise<typeof ACCOUNTS>) {
  line.isCapital = assets.includes(LATHE);
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) },
    org: async () => ({ id: ORG, name: "Test Org" }),
    quickBooksAccounts,
  });
}
const setAccount = (quickBooksAccountId: string) => resolveInKindQb(ORG, "receipt", 1, { action: "set-account", lineId: LATHE, quickBooksAccountId }, ACTOR);

beforeEach(() => vi.clearAllMocks());
afterEach(() => bulkDonationRuntime.reset());

describe("in-kind set-account", () => {
  it("sets an Expense account on a donated item, and a Fixed Asset account on donated equipment", async () => {
    configure([], async () => ACCOUNTS);
    await setAccount("600");
    configure([LATHE], async () => ACCOUNTS);
    await setAccount("150");
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("refuses a Fixed Asset account on a donated item", async () => {
    configure([], async () => ACCOUNTS);
    await expect(setAccount("150")).rejects.toMatchObject({ status: 400, code: "quickbooks-list-stale", message: "A donated item takes an Expense, Other Expense, or Cost of Goods Sold account; QuickBooks' list in the app shows Equipment as Fixed Asset. If you changed it in QuickBooks, press Update now, then save again." });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an expense account on donated equipment", async () => {
    configure([LATHE], async () => ACCOUNTS);
    await expect(setAccount("600")).rejects.toMatchObject({ status: 400, code: "quickbooks-list-stale", message: "Donated equipment takes a Fixed Asset account; QuickBooks' list in the app shows Supplies as Expense. If you changed it in QuickBooks, press Update now, then save again." });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 503 while QuickBooks isn't bound", async () => {
    configure([]);
    await expect(setAccount("600")).rejects.toMatchObject({ status: 503 });
  });
});
