/**
 * @jest-environment node
 */
/**
 * The check after each refresh of the QuickBooks lists copy: one alert per bucket and problem,
 * recorded in the audit log, cleared when the problem goes, and alerted again if it comes back.
 * The System Status row reads the audit log and the copy's status, never QuickBooks.
 */
type Row = { id: number; tableName: string; actorSystem: string | null; affectedEntityId: number; newData: unknown };
const log: Row[] = [];
const buckets: { id: number; name: string; archivedAt: Date | null; quickBooksClassId: string | null }[] = [];
const auditLog = {
    findMany: jest.fn(async ({ where }: { where: { tableName: string; actorSystem: string } }) =>
        log.filter((r) => r.tableName === where.tableName && r.actorSystem === where.actorSystem).sort((a, b) => a.id - b.id),
    ),
    createMany: jest.fn(async ({ data }: { data: Omit<Row, "id">[] }) => {
        for (const d of data) log.push({ ...d, id: log.length + 1 });
        return { count: data.length };
    }),
};
const executeRaw = jest.fn();
const tx = { auditLog, $executeRaw: executeRaw };
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        get auditLog() {
            return auditLog;
        },
        budgetOwner: { findMany: jest.fn(async () => buckets) },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));
const emailAlert = jest.fn(async () => true);
jest.mock("@/lib/emailRecipients", () => ({ emailAlert: (...args: unknown[]) => emailAlert(...(args as [])) }));
const quickBooksListsStatus = jest.fn();
jest.mock("@/lib/finance/quickBooksLists", () => ({ quickBooksListsStatus: () => quickBooksListsStatus() }));
// The libraries' root entries pull in their generated Prisma clients, which the jest env does not build.
const expenseUses = jest.fn();
jest.mock("@checkin/expense", () => ({ unfinishedBucketUses: (id: number) => expenseUses(id) }));
const donationUses = jest.fn();
jest.mock("@checkin/bulk-donation", () => ({ unfinishedBucketUses: (id: number) => donationUses(id) }));
const incomeUses = jest.fn();
jest.mock("@checkin/income", () => ({ unfinishedBucketUses: (id: number) => incomeUses(id) }));
const tryBuildQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ tryBuildQuickBooks, getQuickBooks: tryBuildQuickBooks }));

import { bucketClassesCheck, checkBucketClasses } from "../bucketClassCheck";

const ROBOTICS = { id: 1, name: "Robotics", archivedAt: null, quickBooksClassId: "9" };
const active = [{ id: "9", name: "Programs:Robotics", active: true }];
const inactive = [{ id: "9", name: "Programs:Robotics", active: false }];

beforeEach(() => {
    jest.clearAllMocks();
    log.length = 0;
    buckets.length = 0;
    buckets.push({ ...ROBOTICS });
    for (const read of [expenseUses, donationUses, incomeUses]) read.mockResolvedValue([]);
    quickBooksListsStatus.mockResolvedValue([{ list: "account" }, { list: "class" }]);
});
afterEach(() => expect(tryBuildQuickBooks).not.toHaveBeenCalled());

const sentFor = () => emailAlert.mock.calls.map((c) => (c as unknown as [string, { bucketName: string; issue: string }]));

describe("checkBucketClasses", () => {
    it("records and emails a newly inactive Class once, and a second run sends nothing", async () => {
        await checkBucketClasses(inactive);
        expect(sentFor()).toEqual([
            ["finance.bucketClassUnusable", expect.objectContaining({ bucketName: "Robotics", issue: expect.stringContaining("Programs:Robotics is inactive in QuickBooks") })],
        ]);
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ tableName: "BudgetOwner", affectedEntityId: 1, newData: expect.objectContaining({ check: "BUCKET_UNUSABLE", problem: "class" }) });
        expect(executeRaw).toHaveBeenCalled();

        await checkBucketClasses(inactive);
        expect(emailAlert).toHaveBeenCalledTimes(1);
        expect(log).toHaveLength(1);
    });

    it("reports a Class missing from the copy", async () => {
        await checkBucketClasses([]);
        expect(sentFor()[0][1].issue).toContain("is not in the app's copy of QuickBooks' lists");
    });

    it("records the clear on reactivation, and alerts again when it goes inactive again", async () => {
        await checkBucketClasses(inactive);
        await checkBucketClasses(active);
        expect(log.map((r) => (r.newData as { check: string }).check)).toEqual(["BUCKET_UNUSABLE", "BUCKET_USABLE"]);
        expect(emailAlert).toHaveBeenCalledTimes(1);
        await checkBucketClasses(inactive);
        expect(emailAlert).toHaveBeenCalledTimes(2);
    });

    it("leaves a live bucket with an active Class, or no Class, alone", async () => {
        buckets.push({ id: 2, name: "Unset", archivedAt: null, quickBooksClassId: null });
        await checkBucketClasses(active);
        expect(log).toEqual([]);
        expect(emailAlert).not.toHaveBeenCalled();
    });

    it("reports an archived bucket with unfinished work, and not one without", async () => {
        buckets.length = 0;
        buckets.push({ ...ROBOTICS, archivedAt: new Date() }, { id: 2, name: "Old", archivedAt: new Date(), quickBooksClassId: "8" });
        incomeUses.mockImplementation(async (id: number) => (id === 1 ? [{ what: "store items", count: 4, where: "Income › Items" }] : []));
        await checkBucketClasses(inactive);
        expect(sentFor()).toEqual([
            ["finance.bucketClassUnusable", expect.objectContaining({ bucketName: "Robotics", issue: expect.stringContaining("store items: 4 (Income › Items)") })],
        ]);
        expect(log[0]).toMatchObject({ affectedEntityId: 1, newData: expect.objectContaining({ problem: "archived-work" }) });
    });

    it("keeps an open archived-work finding while a library can't be read", async () => {
        buckets.length = 0;
        buckets.push({ ...ROBOTICS, archivedAt: new Date() });
        incomeUses.mockResolvedValue([{ what: "store items", count: 4, where: "Income › Items" }]);
        await checkBucketClasses(active);
        incomeUses.mockRejectedValue(new Error("db down"));
        const logged = jest.spyOn(console, "error").mockImplementation(() => {});
        await checkBucketClasses(active);
        expect(log).toHaveLength(1);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("archived buckets not checked"));
        logged.mockRestore();
    });
});

describe("Budget buckets: QuickBooks Classes", () => {
    it("is green when nothing is open", async () => {
        expect(await bucketClassesCheck()).toMatchObject({ id: "budget-bucket-classes", label: "Budget buckets: QuickBooks Classes", ok: true, detail: "Every live bucket's Class is active." });
    });

    it("is red with one line per open finding", async () => {
        buckets.push({ id: 2, name: "Woodshop", archivedAt: null, quickBooksClassId: "7" });
        await checkBucketClasses(inactive);
        const row = await bucketClassesCheck();
        expect(row.ok).toBe(false);
        expect(row.detail).toContain("Robotics's QuickBooks Class Programs:Robotics is inactive");
        expect(row.detail).toContain("Woodshop's QuickBooks Class");
    });

    it("reads Not checked before the first refresh", async () => {
        quickBooksListsStatus.mockResolvedValue([]);
        expect(await bucketClassesCheck()).toMatchObject({ ok: true, detail: "Not checked: the QuickBooks lists have not been copied yet." });
    });
});
