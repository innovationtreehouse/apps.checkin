/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import MyProgramsDashboard from "../page";

beforeEach(() => resetRtl());

describe("MyProgramsDashboard", () => {
    it("lists the household's program enrollments", async () => {
        setSession({ id: 1, householdLead: true });
        mockFetchJson({
            "/api/programs/mine": [
                { programId: 5, personId: 100, status: "ACTIVE", isPaymentPlanRequested: false, person: { id: 100, name: "Kid One" }, program: { id: 5, name: "Robotics Club", startAt: "2026-06-01T00:00:00.000Z", endAt: null } },
            ],
        });
        renderWithProviders(<MyProgramsDashboard />);

        expect(await screen.findByText("Robotics Club")).toBeInTheDocument();
        expect(screen.getByText("Kid One")).toBeInTheDocument();
        // ACTIVE (paid) shows no payment pill.
        expect(screen.queryByText("Not paid yet")).not.toBeInTheDocument();
        expect(screen.queryByText("Pay now")).not.toBeInTheDocument();
        expect(screen.queryByText("Awaiting finance approval")).not.toBeInTheDocument();
    });

    it("flags unpaid enrollments green and finance-pending ones gray", async () => {
        setSession({ id: 1, householdLead: true });
        mockFetchJson({
            "/api/programs/mine": [
                { programId: 5, personId: 100, status: "PENDING", isPaymentPlanRequested: false, person: { id: 100, name: "Kid One" }, program: { id: 5, name: "Robotics Club", startAt: null, endAt: null } },
                { programId: 6, personId: 101, status: "PENDING", isPaymentPlanRequested: true, person: { id: 101, name: "Kid Two" }, program: { id: 6, name: "Art Class", startAt: null, endAt: null } },
            ],
        });
        renderWithProviders(<MyProgramsDashboard />);

        expect(await screen.findByText("Not paid yet")).toBeInTheDocument();
        expect(screen.getByText("Awaiting finance approval")).toBeInTheDocument();
        // Only the household-pays row offers checkout, and it goes to the program page.
        const payNow = screen.getAllByText("Pay now");
        expect(payNow).toHaveLength(1);
        expect(payNow[0].closest("a")).toHaveAttribute("href", "/programs/5");
    });

    it("shows no payment state when the API sends none (youth, non-lead member)", async () => {
        setSession({ id: 100, ageBand: "youth" });
        mockFetchJson({
            "/api/programs/mine": [
                { programId: 5, personId: 100, person: { id: 100, name: "Kid One" }, program: { id: 5, name: "Robotics Club", startAt: null, endAt: null } },
            ],
        });
        renderWithProviders(<MyProgramsDashboard />);

        expect(await screen.findByText("Robotics Club")).toBeInTheDocument();
        expect(screen.queryByText("Not paid yet")).not.toBeInTheDocument();
        expect(screen.queryByText("Pay now")).not.toBeInTheDocument();
        expect(screen.queryByText(/confirmation|finance/i)).not.toBeInTheDocument();
    });

    it("shows an empty state with no enrollments", async () => {
        setSession({ id: 1 });
        mockFetchJson({ "/api/programs/mine": [] });
        renderWithProviders(<MyProgramsDashboard />);
        expect(await screen.findByText("You are not enrolled in any programs yet.")).toBeInTheDocument();
    });

    it("shows the failure, not an empty list, when the load fails", async () => {
        setSession({ id: 1 });
        mockFetchJson({});
        renderWithProviders(<MyProgramsDashboard />);
        expect(await screen.findByText("Couldn't load your programs")).toBeInTheDocument();
        expect(screen.queryByText("You are not enrolled in any programs yet.")).not.toBeInTheDocument();
    });
});
