/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import HouseholdCheckins from "../page";
import { fireEvent } from "@testing-library/react";

beforeEach(() => resetRtl());

describe("HouseholdCheckins", () => {
    pinTimezone();

    it("labels the ±7-day window on the filter date's own calendar days", async () => {
        setSession({ id: 1 });
        mockFetchJson({ "/api/household/visits": { visits: [] } });
        const { container } = renderWithProviders(<HouseholdCheckins />);

        fireEvent.change(await screen.findByLabelText("Lookup Date"), { target: { value: "2026-06-15" } });

        // 2026-06-15 ± 7d, UTC-pinned. Rendered in a wall-clock zone west of UTC
        // both labels slip to the 7th/21st.
        expect(container.textContent).toContain("6/8/2026");
        expect(container.textContent).toContain("6/22/2026");
        expect(container.textContent).not.toContain("6/7/2026");
        expect(container.textContent).not.toContain("6/21/2026");
    });


    it("defaults the lookup date to the org's day, not the UTC day, in the evening", async () => {
        // 8 PM in Chicago on the 15th is already the 16th in UTC.
        jest.useFakeTimers({ advanceTimers: true, now: new Date("2026-06-16T01:00:00.000Z") });
        try {
            setSession({ id: 1 });
            mockFetchJson({ "/api/household/visits": { visits: [] } });
            renderWithProviders(<HouseholdCheckins />);

            expect(await screen.findByLabelText("Lookup Date")).toHaveValue("2026-06-15");
        } finally {
            jest.useRealTimers();
        }
    });

    it("shows a loader while the session resolves", () => {
        setSession(null, "loading");
        renderWithProviders(<HouseholdCheckins />);
        expect(screen.queryByText("Household Check-ins")).not.toBeInTheDocument();
    });

    it("lists past visits for the household", async () => {
        setSession({ id: 1 });
        mockFetchJson({
            "/api/household/visits": {
                visits: [
                    { id: 1, person: { name: "Kid One" }, event: { name: "Open Shop" }, arrivedAt: "2026-06-01T10:00:00.000Z", departedAt: "2026-06-01T11:00:00.000Z" },
                ],
            },
        });
        renderWithProviders(<HouseholdCheckins />);

        expect(await screen.findByText("Kid One")).toBeInTheDocument();
        expect(screen.getByText("Open Shop")).toBeInTheDocument();
    });
});
