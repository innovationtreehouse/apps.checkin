// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { screen, fireEvent } from "@testing-library/react";
import { signIn } from "next-auth/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import Home from "../page";

beforeEach(() => resetRtl());

describe("Home", () => {
    it("offers Google sign-in when signed out", () => {
        renderWithProviders(<Home />);

        fireEvent.click(screen.getByRole("button", { name: /sign in to dashboard/i }));

        expect(signIn).toHaveBeenCalledWith("google");
    });

    it("offers no check-in or check-out: people badge at the kiosk", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();

        expect(screen.queryByRole("button", { name: /check (in|out)/i })).not.toBeInTheDocument();
    });

    const violating = { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: true };

    it("warns of a two-deep violation while the kiosk is reachable", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();
    });

    it("says it can't confirm instead of stating a violation when the kiosk is unreachable", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: false, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText("Can't confirm building state")).toBeInTheDocument();
        expect(screen.queryByText(/Two-Deep Compliance is failing/)).not.toBeInTheDocument();
    });
});
