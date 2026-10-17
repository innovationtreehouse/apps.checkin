// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, router, resetRtl } from "@/test-helpers/rtl";
import SystemStatusAuditLogPage from "../page";

beforeEach(() => resetRtl());

describe("SystemStatusAuditLogPage", () => {
    it("renders the audit log panel for a sysadmin", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({
            "/api/system-status/audit-log": { logs: [], total: 0, page: 1, pageSize: 25, tables: [], actors: [], systemActors: [] },
        });
        renderWithProviders(<SystemStatusAuditLogPage />);

        expect(await screen.findByText("No audit entries match these filters.")).toBeInTheDocument();
    });

    it("renders for a board member too — the board answers for what is logged here", async () => {
        setSession({ id: 2, isBoardMember: true });
        mockFetchJson({
            "/api/system-status/audit-log": { logs: [], total: 0, page: 1, pageSize: 25, tables: [], actors: [], systemActors: [] },
        });
        renderWithProviders(<SystemStatusAuditLogPage />);

        expect(await screen.findByText("No audit entries match these filters.")).toBeInTheDocument();
        expect(router.push).not.toHaveBeenCalled();
    });
});
