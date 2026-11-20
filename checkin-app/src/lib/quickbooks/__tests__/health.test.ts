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
jest.mock("@/lib/quickbooks/picksHealth", () => ({ quickBooksPicksCheck: async () => ({ id: "quickbooks-pick-types", label: "QuickBooks picks: account types", ok: true, detail: "" }) }));
jest.mock("@/lib/finance/bucketClassCheck", () => ({ bucketClassesCheck: async () => ({ id: "budget-bucket-classes", label: "Budget buckets: QuickBooks Classes", ok: true, detail: "" }) }));
const getOrg = jest.fn();
jest.mock("@/lib/components/host", () => ({ getOrg }));
const quickBooksListsStatus = jest.fn();
jest.mock("@/lib/finance/quickBooksLists", () => ({ quickBooksListsStatus }));
// The libraries' root entries pull in their generated Prisma clients, which the jest env does not build.
const postingOnAt = jest.fn();
jest.mock("@checkin/income", () => ({ postingOnAt }));
const inKindOnAt = jest.fn();
jest.mock("@checkin/bulk-donation", () => ({ inKindPostingOnAt: inKindOnAt }));
const expenseOnAt = jest.fn();
jest.mock("@checkin/expense", () => ({ qbPostingOnAt: expenseOnAt }));
const postingSlotStatus = jest.fn();
jest.mock("@/lib/finance/quickBooksPosting", () => ({ postingSlotStatus }));
jest.mock("@/lib/appSettings", () => ({ resolveDisplayTimezone: async () => "UTC" }));

const FREE_SLOT = { heldBy: null, until: null, queued: [], pausedUntil: null, lastRuns: {}, waiting: [], warnings: [], requestsToday: 0 };

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
    quickBooksListsStatus.mockResolvedValue([]);
    postingSlotStatus.mockResolvedValue(FREE_SLOT);
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

describe("QuickBooks lists row", () => {
    const HOUR = 60 * 60 * 1000;
    const copied = (...hoursAgo: number[]) =>
        quickBooksListsStatus.mockResolvedValue(hoursAgo.map((h, i) => ({ list: ["account", "class"][i], refreshedAt: new Date(Date.now() - h * HOUR), entries: 3 })));
    beforeEach(() => tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" }));

    it("is green with the older list's refresh time", async () => {
        copied(1, 30);
        const at = new Date(Date.now() - 30 * HOUR).toISOString().slice(0, 16).replace("T", " ");
        expect((await rows())["quickbooks-lists"]).toEqual({ id: "quickbooks-lists", label: "QuickBooks lists", ok: true, detail: `Refreshed ${at} UTC.` });
    });

    it("turns red after two days without a refresh", async () => {
        copied(1, 49);
        expect((await rows())["quickbooks-lists"]).toMatchObject({ ok: false, detail: expect.stringContaining("more than two days ago. Press Update now on the Books map.") });
    });

    it("is red before the first copy", async () => {
        expect((await rows())["quickbooks-lists"]).toMatchObject({ ok: false, detail: "Not copied yet. The daily posting run copies them, or press Update now on the Books map." });
    });

    it("is red when the copy can't be read", async () => {
        quickBooksListsStatus.mockRejectedValue(new Error("db down"));
        expect((await rows())["quickbooks-lists"]).toMatchObject({ ok: false, detail: "Could not read it: db down." });
    });

    it("reads the copy, never QuickBooks, so it answers while QuickBooks is off", async () => {
        copied(1, 1);
        expect((await rows())["quickbooks-lists"].ok).toBe(true);
        expect(accounts).not.toHaveBeenCalled();
    });

    it("is green and unread where QuickBooks is off by design", async () => {
        process.env.CHECKIN_ENV = "local";
        expect((await rows())["quickbooks-lists"]).toMatchObject({ ok: true });
        expect(quickBooksListsStatus).not.toHaveBeenCalled();
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

describe("QuickBooks posting slot rows", () => {
    it("shows a free slot, an empty queue, no pause and today's request count, all green", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        postingSlotStatus.mockResolvedValue({ ...FREE_SLOT, requestsToday: 412 });
        const r = await rows();
        expect(r["quickbooks-posting-slot"]).toMatchObject({ ok: true, detail: "Free." });
        expect(r["quickbooks-posting-queue"]).toMatchObject({ ok: true, detail: "Empty." });
        expect(r["quickbooks-posting-pause"]).toMatchObject({ ok: true, detail: "None in force." });
        expect(r["quickbooks-posting-requests"]).toMatchObject({ ok: true, detail: expect.stringMatching(/^412 today/) });
    });

    it("names the holder, who asked for each waiting lane, and a pause in force", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        postingSlotStatus.mockResolvedValue({
            ...FREE_SLOT,
            heldBy: "expense",
            until: new Date("2026-11-18T14:05:00Z"),
            queued: ["income", "in-kind"],
            waiting: [
                { lane: "income", requestedById: 7, requestedAt: new Date("2026-11-18T14:01:00Z") },
                { lane: "in-kind", requestedById: null, requestedAt: new Date("2026-11-18T14:02:00Z") },
            ],
            pausedUntil: new Date("2026-11-18T14:04:00Z"),
        });
        const r = await rows();
        expect(r["quickbooks-posting-slot"].detail).toMatch(/^Held by the expenses run until .*2:05/);
        expect(r["quickbooks-posting-queue"]).toMatchObject({ ok: true, detail: expect.stringMatching(/^Waiting: income \(asked by person 7, .*\); gifts of goods \(asked by the daily run, /) });
        expect(r["quickbooks-posting-pause"].detail).toMatch(/^QuickBooks asked us to slow down; requests resume at .*2:04/);
    });

    it("turns the queue red when it is stranded, pointing at Catch up", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        postingSlotStatus.mockResolvedValue({ ...FREE_SLOT, queued: ["income"], waiting: [{ lane: "income", requestedById: null, requestedAt: new Date("2026-11-18T14:01:00Z") }] });
        const r = await rows();
        expect(r["quickbooks-posting-queue"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Stranded: .*Catch up/) });
    });

    it("shows each lane's last run, red while it carries a warning", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        postingSlotStatus.mockResolvedValue({
            ...FREE_SLOT,
            lastRuns: {
                expense: { endedAt: "2026-11-18T13:58:00.000Z", ended: "done", created: 100, matched: 2, capped: "count", yieldsInRow: 0 },
                income: { endedAt: "2026-11-18T13:00:00.000Z", ended: "yielded", created: 0, matched: 0, capped: null, yieldsInRow: 3 },
            },
            warnings: [{ lane: "income", cause: "throttled", text: "QuickBooks throttled the income run 3 runs in a row." }],
        });
        const r = await rows();
        expect(r["quickbooks-posting-run-expense"]).toMatchObject({ ok: true, detail: expect.stringMatching(/finished; created 100, matched 2; stopped by the per-run limit\.$/) });
        expect(r["quickbooks-posting-run-income"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^QuickBooks throttled the income run 3 runs in a row\. Ended /) });
        expect(r["quickbooks-posting-run-in-kind"]).toBeUndefined();
    });

    it("is red when the slot can't be read", async () => {
        tryBuildQuickBooks.mockReturnValue({ ok: false, reason: "x" });
        postingSlotStatus.mockRejectedValue(new Error("db down"));
        const r = await rows();
        expect(r["quickbooks-posting-slot"]).toMatchObject({ ok: false, detail: "Could not read it: db down." });
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
