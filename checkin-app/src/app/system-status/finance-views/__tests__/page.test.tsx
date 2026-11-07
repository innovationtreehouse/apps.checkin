// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, router, resetRtl } from "@/test-helpers/rtl";
import { visibleLinks } from "@/lib/nav/gates";
import { SYSTEM_STATUS } from "@/lib/nav/sections/systemStatus";
import FinanceViewsPage from "../page";

const HREF = "/system-status/finance-views";

const logRow = {
    id: 1,
    viewedAt: "2026-10-27T14:05:00.000Z",
    actorId: 12,
    role: "isFinance",
    endpoint: "GET /api/receipts",
    params: {},
    recordIds: ["r_1"],
    rowCount: 1,
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

    it("reads each view as a sentence for the Board, with the record linked", async () => {
        setSession({ id: 2, isBoardMember: true });
        mockFetchJson({
            "/api/system-status/finance-views": { FinanceViewLog: [logRow], Person: [{ id: 12, name: "Pat Lee" }] },
        });
        renderWithProviders(<FinanceViewsPage />);

        expect(await screen.findByText(/^Pat Lee \(Finance\) viewed 1 receipt on the receipts list/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "r_1" })).toHaveAttribute("href", "/receipts/r_1");
        expect(router.push).not.toHaveBeenCalled();
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
