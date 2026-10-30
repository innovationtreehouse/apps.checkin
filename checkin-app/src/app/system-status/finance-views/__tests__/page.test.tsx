// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { screen, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
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

    it("raises a red chip that stays up when the log fails to load", async () => {
        setSession({ id: 2, isBoardMember: true });
        const show = jest.spyOn(notifications, "show");
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ error: "Internal Server Error" }),
        });
        renderWithProviders(<FinanceViewsPage />);

        await waitFor(() =>
            expect(show).toHaveBeenCalledWith(
                expect.objectContaining({
                    color: "red",
                    title: "Couldn't load the finance view log",
                    message: "Internal Server Error",
                    autoClose: false,
                }),
            ),
        );
    });
});
