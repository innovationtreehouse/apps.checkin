/**
 * @jest-environment node
 */
import { KindedError } from "@checkin/component-kit";
import type { ConfigCheck } from "@/lib/configHealth";

const tryBuildQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ tryBuildQuickBooks }));
const incomePostingMissing = jest.fn();
const benevityPostingMissing = jest.fn();
jest.mock("@/lib/income/configure", () => ({ incomePostingMissing, benevityPostingMissing }));
const inKindPostingMissing = jest.fn();
jest.mock("@/lib/bulkDonation/configure", () => ({ inKindPostingMissing }));
const expensePostingMissing = jest.fn();
jest.mock("@/lib/expense/configure", () => ({ expensePostingMissing }));
const misTypedRoleAccounts = jest.fn();
jest.mock("@/lib/finance/booksMap", () => ({ misTypedRoleAccounts }));
const getOrg = jest.fn();
jest.mock("@/lib/components/host", () => ({ getOrg }));
// The libraries' root entries pull in their generated Prisma clients, which the jest env does not build.
const postingOnAt = jest.fn();
jest.mock("@checkin/income", () => ({ postingOnAt }));
const inKindOnAt = jest.fn();
jest.mock("@checkin/bulk-donation", () => ({ inKindPostingOnAt: inKindOnAt }));
const expenseOnAt = jest.fn();
jest.mock("@checkin/expense", () => ({ qbPostingOnAt: expenseOnAt }));

let clock = 0;
async function rows(): Promise<Record<string, ConfigCheck>> {
    clock += 120_000; // past the cache
    const { getQuickBooksHealth } = await import("../health");
    return Object.fromEntries((await getQuickBooksHealth(clock)).map((c) => [c.id, c]));
}

const accounts = jest.fn();
const connected = (bookCloseDate: jest.Mock, current: jest.Mock = jest.fn().mockResolvedValue("tok")) => ({
    ok: true,
    env: "sandbox",
    tokens: { current },
    client: { bookCloseDate, accounts },
});

const ENV = { ...process.env };
beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHECKIN_ENV = "dev";
    incomePostingMissing.mockResolvedValue([]);
    benevityPostingMissing.mockResolvedValue([]);
    inKindPostingMissing.mockResolvedValue([]);
    expensePostingMissing.mockResolvedValue([]);
    getOrg.mockResolvedValue({ id: "org-1" });
    postingOnAt.mockResolvedValue({ shopify: null, benevity: null });
    inKindOnAt.mockResolvedValue(null);
    expenseOnAt.mockResolvedValue(null);
    accounts.mockResolvedValue([]);
    misTypedRoleAccounts.mockResolvedValue([]);
});
afterEach(() => {
    process.env = { ...ENV };
    jest.useRealTimers();
});

describe("QuickBooks connection row", () => {
    it("is ok off prod and dev, by design, and reads nothing", async () => {
        process.env.CHECKIN_ENV = "stg";
        const r = await rows();
        expect(r["quickbooks-connection"]).toMatchObject({ ok: true, detail: expect.stringMatching(/by design/) });
        expect(r["quickbooks-close-date"]).toMatchObject({ ok: true, detail: "Not read while QuickBooks is off." });
        expect(tryBuildQuickBooks).not.toHaveBeenCalled();
    });

    it("names the guard's reason when the build is refused", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "QBO realm is not the allowlisted sandbox realm" });
        const r = await rows();
        expect(r["quickbooks-connection"]).toMatchObject({ ok: false, detail: "Off: QBO realm is not the allowlisted sandbox realm." });
        expect(r["quickbooks-close-date"]).toMatchObject({ ok: false, detail: "Not read while QuickBooks is off." });
    });

    it("says the refresher failed when no token comes back", async () => {
        const bookCloseDate = jest.fn();
        tryBuildQuickBooks.mockReturnValue(connected(bookCloseDate, jest.fn().mockRejectedValue(new Error("QBO token refresher fn failed"))));
        const r = await rows();
        expect(r["quickbooks-connection"]).toMatchObject({ ok: false, detail: expect.stringMatching(/token refresher failed/) });
        expect(bookCloseDate).not.toHaveBeenCalled();
    });

    it("says QuickBooks needs reconnecting by finance when the refresher answers reconsent-required", async () => {
        const reconnect = new KindedError("connection", "QuickBooks needs reconnecting: its login was revoked. Finance reconnects it by re-running the QuickBooks consent.");
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn(), jest.fn().mockRejectedValue(reconnect)));
        const r = await rows();
        expect(r["quickbooks-connection"]).toMatchObject({ ok: false, detail: expect.stringMatching(/needs reconnecting.*Finance reconnects/) });
        expect(r["quickbooks-connection"].detail).not.toMatch(/token refresher failed/);
    });

    it("says what finance must check when the refresher points at the wrong company", async () => {
        const wrong = new KindedError("settings", "QuickBooks settings are wrong: the token refresher holds a different QuickBooks company than this instance's QBO_REALM_ID. Finance checks which company the consent was run for.");
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn(), jest.fn().mockRejectedValue(wrong)));
        const r = await rows();
        expect(r["quickbooks-connection"]).toMatchObject({ ok: false, detail: wrong.message });
    });

    it("times out a refresher that never answers", async () => {
        jest.useFakeTimers();
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn(), jest.fn(() => new Promise(() => {}))));
        const pending = rows();
        await jest.advanceTimersByTimeAsync(5_000);
        expect((await pending)["quickbooks-connection"]).toMatchObject({ ok: false, detail: expect.stringMatching(/within 5 seconds/) });
    });

    it("names the company when connected, and never the realm or token", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockResolvedValue(null)));
        const r = await rows();
        expect(r["quickbooks-connection"]).toEqual({
            id: "quickbooks-connection",
            label: "QuickBooks connection",
            ok: true,
            detail: "Connected to the sandbox company.",
        });
        expect(JSON.stringify(r)).not.toMatch(/tok/);
    });
});

describe("QuickBooks books closing date row", () => {
    it("shows the date", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockResolvedValue("2026-06-30")));
        expect((await rows())["quickbooks-close-date"]).toMatchObject({ ok: true, detail: "Books closed through 2026-06-30." });
    });

    it("says none set", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockResolvedValue(null)));
        expect((await rows())["quickbooks-close-date"]).toMatchObject({ ok: true, detail: "None set." });
    });

    it("is red when the read fails", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockRejectedValue(new Error("QBO 500"))));
        expect((await rows())["quickbooks-close-date"]).toMatchObject({ ok: false, detail: "Could not read it: QBO 500." });
    });
});

describe("books map account types row", () => {
    it("is ok when every stored account is of a type its role accepts", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockResolvedValue(null)));
        const live = [{ Id: "8001", AccountType: "Bank" }];
        accounts.mockResolvedValue(live);
        expect((await rows())["quickbooks-account-types"]).toEqual({
            id: "quickbooks-account-types",
            label: "QuickBooks books map: account types",
            ok: true,
            detail: "Every account picked is of a type its role accepts.",
        });
        expect(misTypedRoleAccounts).toHaveBeenCalledWith(live);
    });

    it("names each role whose stored account is of the wrong type, for finance to re-pick", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockResolvedValue(null)));
        misTypedRoleAccounts.mockResolvedValue(["Shopify: fees (Sales is Income; takes Expense or Other Expense)"]);
        expect((await rows())["quickbooks-account-types"]).toMatchObject({
            ok: false,
            detail: "Re-pick on the books map: Shopify: fees (Sales is Income; takes Expense or Other Expense).",
        });
    });

    it("is red when the account list can't be read", async () => {
        tryBuildQuickBooks.mockReturnValue(connected(jest.fn().mockResolvedValue(null)));
        accounts.mockRejectedValue(new Error("QBO 500"));
        expect((await rows())["quickbooks-account-types"]).toMatchObject({ ok: false, detail: "Could not read it: QBO 500." });
    });

    it("follows the connection row while QuickBooks is off", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        expect((await rows())["quickbooks-account-types"]).toMatchObject({ ok: false, detail: "Not read while QuickBooks is off." });
        process.env.CHECKIN_ENV = "stg";
        expect((await rows())["quickbooks-account-types"]).toMatchObject({ ok: true, detail: "Not read while QuickBooks is off." });
    });
});

describe("posting lane rows", () => {
    beforeEach(() => tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" }));

    it("is bound with the switch-on date when stamped", async () => {
        postingOnAt.mockResolvedValue({ shopify: new Date("2026-09-01T12:00:00Z"), benevity: new Date("2026-08-15T12:00:00Z") });
        const r = await rows();
        expect(r["quickbooks-lane-income"]).toMatchObject({ ok: true, detail: "Bound. Posting switched on 2026-09-01." });
        expect(r["quickbooks-lane-donations"].detail).toContain("Posting switched on 2026-08-15.");
    });

    it("names each missing piece when unbound", async () => {
        benevityPostingMissing.mockResolvedValue(["QuickBooks company (QBO_REALM_ID)", "no account picked for: Benevity disbursements: bank account"]);
        expect((await rows())["quickbooks-lane-donations"]).toMatchObject({
            ok: false,
            detail: "Unbound; missing: QuickBooks company (QBO_REALM_ID), no account picked for: Benevity disbursements: bank account.",
        });
    });

    it("has a gift-of-goods row with its own switch-on date", async () => {
        inKindPostingMissing.mockResolvedValue(["no account picked for: Gifts of goods: in-kind income"]);
        inKindOnAt.mockResolvedValue(new Date("2026-10-20T08:00:00Z"));
        expect((await rows())["quickbooks-lane-in-kind"]).toEqual({
            id: "quickbooks-lane-in-kind",
            label: "QuickBooks posting: gifts of goods",
            ok: false,
            detail: "Unbound; missing: no account picked for: Gifts of goods: in-kind income. Posting switched on 2026-10-20.",
        });
    });

    it("waits on a lane whose binding check reads QuickBooks", async () => {
        expensePostingMissing.mockResolvedValue(["no account picked for: Organisation card"]);
        expect((await rows())["quickbooks-lane-expenses"]).toMatchObject({ ok: false, detail: "Unbound; missing: no account picked for: Organisation card." });
    });

    it("still answers when the switch-on read fails", async () => {
        expensePostingMissing.mockRejectedValue(new Error("QBO 503"));
        expenseOnAt.mockRejectedValue(new Error("db down"));
        expect((await rows())["quickbooks-lane-expenses"]).toMatchObject({
            ok: false,
            detail: "Unbound; missing: a readable binding (QBO 503). Switch-on date unreadable (db down).",
        });
    });
});

describe("cache", () => {
    it("reuses the answer for a minute", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        const { getQuickBooksHealth } = await import("../health");
        const t = clock + 1_000_000;
        await getQuickBooksHealth(t);
        await getQuickBooksHealth(t + 59_000);
        expect(tryBuildQuickBooks).toHaveBeenCalledTimes(1);
        await getQuickBooksHealth(t + 60_000);
        expect(tryBuildQuickBooks).toHaveBeenCalledTimes(2);
    });
});
