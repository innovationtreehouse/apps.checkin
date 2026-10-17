// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import SystemStatusHealthPage from "../page";

beforeEach(() => resetRtl());

describe("SystemStatusHealthPage", () => {
    it("renders the quick-stats and system health cards", async () => {
        mockFetchJson({
            "/api/system-status/kiosk-version": { version: "unknown-in-test" },
            "/api/system-status/health": { days: [] },
            "/api/system-status/kiosk-heartbeat": { heartbeat: [] },
        });
        renderWithProviders(<SystemStatusHealthPage />);

        expect(screen.getByText("Quick Stats")).toBeInTheDocument();
        expect(screen.getByText("System Health")).toBeInTheDocument();
        expect(await screen.findByText("Badge Scan Response Times (Last 30 Days)")).toBeInTheDocument();
    });
});
