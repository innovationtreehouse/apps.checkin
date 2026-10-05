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

    it("checks in a privileged, signed-in user", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false } },
            "/api/membership": { membershipStatus: "ACTIVE" },
            "/api/scan": { type: "checkin" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();

        fireEvent.click(await screen.findByRole("button", { name: /check in/i }));

        expect(await screen.findByText("Successfully checked in!")).toBeInTheDocument();
    });
});
