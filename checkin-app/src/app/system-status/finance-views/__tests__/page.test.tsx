// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock({ followUrl: true }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setSearchParams, router, resetRtl } from "@/test-helpers/rtl";
import { visibleLinks } from "@/lib/nav/gates";
import { SYSTEM_STATUS } from "@/lib/nav/sections/systemStatus";
import FinanceViewsPage from "../page";

const HREF = "/system-status/finance-views";

const logRow = {
    id: 1,
    viewedAt: "2026-11-06T14:05:00.000Z",
    actorId: 12,
    role: "isFinance",
    endpoint: null,
    recordIds: ["Expense:e_123", "Receipt:r_9"],
    pagePath: "/expense/expenses/e_123",
    calls: [{ endpoint: "GET /api/expense/expenses/[id]", path: "/api/expense/expenses/e_123", query: {}, role: "isFinance" }],
    records: [
        { ref: "Expense:e_123", fields: ["reimburseePersonId", "receiptTotalCents", "submitterId"] },
        { ref: "Receipt:r_9", fields: ["receiptTotalCents"] },
    ],
};

beforeEach(() => resetRtl());

describe("the Finance Views tab", () => {
    it("shows to the Board", () => {
        const hrefs = visibleLinks(SYSTEM_STATUS, { isBoardMember: true }, null).map((l) => l.href);
        expect(hrefs).toContain(HREF);
    });

    it("hides from a sysadmin", () => {
        const hrefs = visibleLinks(SYSTEM_STATUS, { isSysadmin: true }, null).map((l) => l.href);
        expect(hrefs).not.toContain(HREF);
        expect(hrefs).toContain("/system-status/audit-log");
    });
});

describe("FinanceViewsPage", () => {
    it("sends a sysadmin who opens it directly back to System status", async () => {
        setSession({ id: 1, isSysadmin: true });
        const fetchSpy = mockFetchJson({});
        renderWithProviders(<FinanceViewsPage />);

        expect(router.push).toHaveBeenCalledWith("/system-status");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reads each view as viewer, records with their fields, page and time, each record linked", async () => {
        setSession({ id: 2, isBoardMember: true });
        mockFetchJson({
            "/api/system-status/finance-views": { FinanceViewLog: [logRow], Person: [{ id: 12, name: "Pat Lee" }] },
        });
        renderWithProviders(<FinanceViewsPage />);

        const entry = await screen.findByText(/^Pat Lee \(Finance\) viewed/);
        expect(entry).toHaveTextContent(
            /^Pat Lee \(Finance\) viewed Expense:e_123 \(reimburseePersonId, receiptTotalCents, submitterId\), Receipt:r_9 \(receiptTotalCents\) on \/expense\/expenses\/e_123, 6 Nov 2026 \d\d:\d\d$/,
        );
        expect(screen.getByRole("link", { name: "Expense:e_123" })).toHaveAttribute("href", "/expense/expenses/e_123");
        expect(screen.getByRole("link", { name: "Receipt:r_9" })).toHaveAttribute("href", "/receipts/r_9");
        expect(router.push).not.toHaveBeenCalled();
    });

    it("shows a record with no page as plain text, and an untagged row's API path", async () => {
        setSession({ id: 2, isBoardMember: true });
        const untagged = {
            ...logRow,
            pagePath: null,
            recordIds: ["QuickBooks.Transaction:4412"],
            calls: [{ endpoint: "GET /api/expense/finance-queue", path: "/api/expense/finance-queue", query: { tab: "holds" }, role: "isFinance" }],
            records: [{ ref: "QuickBooks.Transaction:4412", fields: ["amountCents"] }],
        };
        mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: [untagged], Person: [] } });
        renderWithProviders(<FinanceViewsPage />);

        const entry = await screen.findByText(/^Person #12 \(Finance\) viewed/);
        expect(entry).toHaveTextContent(/viewed QuickBooks.Transaction:4412 \(amountCents\) via GET \/api\/expense\/finance-queue\?tab=holds,/);
        expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("says so when nothing matches", async () => {
        setSession({ id: 2, isBoardMember: true });
        mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: [], Person: [] } });
        renderWithProviders(<FinanceViewsPage />);

        expect(await screen.findByText("No finance views match these filters.")).toBeInTheDocument();
    });

    it("offers an older page when the route returns a 51st row", async () => {
        setSession({ id: 2, isBoardMember: true });
        const rows = Array.from({ length: 51 }, (_, i) => ({ ...logRow, id: i + 1 }));
        mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: rows, Person: [] } });
        renderWithProviders(<FinanceViewsPage />);

        expect(await screen.findByRole("button", { name: "Older" })).toBeEnabled();
        expect(screen.getAllByRole("row")).toHaveLength(50);
    });

    it("moves to the rows after the last one shown, keeping the place in the URL", async () => {
        setSession({ id: 2, isBoardMember: true });
        const rows = Array.from({ length: 51 }, (_, i) => ({ ...logRow, id: 100 - i }));
        const fetchSpy = mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: rows, Person: [] } });
        renderWithProviders(<FinanceViewsPage />);

        fireEvent.click(await screen.findByRole("button", { name: "Older" }));

        const marker = `${Date.parse(logRow.viewedAt)}_51`;
        expect(router.push).toHaveBeenCalledWith(`/?before=${marker}`, { scroll: false });
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining(`before=${marker}`), expect.anything()));
    });

    it("reads its place from the URL and offers the newest page", async () => {
        setSession({ id: 2, isBoardMember: true });
        setSearchParams("before=1762437900000_7");
        const fetchSpy = mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: [logRow], Person: [] } });
        renderWithProviders(<FinanceViewsPage />);

        const newest = await screen.findByRole("button", { name: "Newest" });
        expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("before=1762437900000_7"), expect.anything());
        expect(screen.getByRole("button", { name: "Older" })).toBeDisabled();
        fireEvent.click(newest);
        expect(router.push).toHaveBeenCalledWith("/", { scroll: false });
    });

    it("dims the old rows and holds the pager while the next page loads", async () => {
        setSession({ id: 2, isBoardMember: true });
        const rows = Array.from({ length: 51 }, (_, i) => ({ ...logRow, id: i + 1 }));
        mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: rows, Person: [] } });
        renderWithProviders(<FinanceViewsPage />);
        const older = await screen.findByRole("button", { name: "Older" });
        expect(screen.getByRole("table").closest('[aria-busy="false"]')).not.toBeNull();

        global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
        fireEvent.click(older);

        await waitFor(() => expect(screen.getByRole("table").closest('[aria-busy="true"]')).not.toBeNull());
        expect(screen.getByRole("button", { name: "Older" })).toBeDisabled();
    });

    it("shows the failure, not an empty log, when the log fails to load", async () => {
        setSession({ id: 2, isBoardMember: true });
        mockFetchJson({});
        renderWithProviders(<FinanceViewsPage />);

        expect(await screen.findByText("Couldn't load the finance view log")).toBeInTheDocument();
        expect(screen.queryByText("No finance views match these filters.")).not.toBeInTheDocument();
    });

    it("hides the empty answer while a changed filter loads", async () => {
        setSession({ id: 2, isBoardMember: true });
        mockFetchJson({ "/api/system-status/finance-views": { FinanceViewLog: [], Person: [] } });
        renderWithProviders(<FinanceViewsPage />);
        await screen.findByText("No finance views match these filters.");

        global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
        fireEvent.change(screen.getByLabelText("Record id"), { target: { value: "r_1" } });

        await waitFor(() => expect(screen.queryByText("No finance views match these filters.")).not.toBeInTheDocument());
    });
});
