/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, fireEvent, waitFor } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import ParticipantEventsDashboard from "../page";

beforeEach(() => resetRtl());

describe("ParticipantEventsDashboard", () => {
    it("groups event rows by event and RSVPs", async () => {
        setSession({ id: 1, householdLead: true });
        const fetchMock = mockFetchJson({
            "/api/events/mine": [
                { id: 10, name: "Robotics Meet", description: null, startAt: "2026-07-10T18:00:00.000Z", endAt: "2026-07-10T20:00:00.000Z", program: { name: "Robotics Club" }, participant: { id: 100, name: "Kid One" }, rsvp: null },
            ],
        });
        renderWithProviders(<ParticipantEventsDashboard />);

        expect(await screen.findByText("Robotics Meet")).toBeInTheDocument();
        expect(screen.getByText("Kid One")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Yes" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/events/10/rsvp", expect.objectContaining({ method: "PATCH" })));
    });

    it("keeps the cards mounted with LoadError above them when a reload fails", async () => {
        setSession({ id: 1, householdLead: true });
        const event = { id: 10, name: "Robotics Meet", description: null, startAt: "2026-07-10T18:00:00.000Z", endAt: "2026-07-10T20:00:00.000Z", program: { name: "Robotics Club" }, participant: { id: 100, name: "Kid One" }, rsvp: null };
        let failReads = false;
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const isRead = String(input).includes("/api/events/mine");
            const failed = isRead && failReads;
            return { ok: !failed, status: failed ? 403 : 200, text: async () => JSON.stringify(failed ? { error: "Forbidden" } : isRead ? [event] : {}), json: async () => ({}) } as Response;
        }) as unknown as typeof fetch;
        renderWithProviders(<ParticipantEventsDashboard />);

        expect(await screen.findByText("Robotics Meet")).toBeInTheDocument();
        failReads = true;
        fireEvent.click(screen.getByRole("button", { name: "Yes" }));

        expect(await screen.findByText("Couldn't load your events")).toBeInTheDocument();
        expect(screen.getByText("Robotics Meet")).toBeInTheDocument();
    });

    it("reverts the optimistic RSVP and shows an error toast on a non-OK response", async () => {
        setSession({ id: 1, householdLead: true });
        const event = { id: 10, name: "Robotics Meet", description: null, startAt: "2026-07-10T18:00:00.000Z", endAt: "2026-07-10T20:00:00.000Z", program: { name: "Robotics Club" }, participant: { id: 100, name: "Kid One" }, rsvp: null };
        // Stateful fetch: /mine always 200 with rsvp:null; the PATCH 403s so the
        // optimistic ATTENDING must not stick.
        const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/events/10/rsvp")) {
                return { ok: false, status: 403, json: async () => ({ error: "Not allowed." }) } as Response;
            }
            return { ok: true, status: 200, text: async () => JSON.stringify([event]) } as Response;
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        const showSpy = jest.spyOn(notifications, "show");

        renderWithProviders(<ParticipantEventsDashboard />);
        expect(await screen.findByText("Robotics Meet")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Yes" }));

        // Error surfaced with the server message...
        await waitFor(() => expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Not allowed.", autoClose: false })));
        // ...the card reverted, and /mine was re-read (initial load + refresh = 2 calls).
        await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/events/mine"))).toHaveLength(2));
        expect(screen.getByRole("button", { name: "Yes" })).toHaveAttribute("data-variant", "default");
    });

    it("shows an empty state with no upcoming events", async () => {
        setSession({ id: 1 });
        mockFetchJson({ "/api/events/mine": [] });
        renderWithProviders(<ParticipantEventsDashboard />);
        expect(await screen.findByText("No Upcoming Events")).toBeInTheDocument();
    });

    it("tags events where the member volunteers", async () => {
        setSession({ id: 1 });
        mockFetchJson({
            "/api/events/mine": [
                { id: 10, name: "Robotics Meet", description: null, startAt: "2026-07-10T18:00:00.000Z", endAt: "2026-07-10T20:00:00.000Z", program: { name: "Robotics Club" }, participant: { id: 100, name: "Kid One" }, rsvp: null, isVolunteer: true },
                { id: 11, name: "Chess Night", description: null, startAt: "2026-07-11T18:00:00.000Z", endAt: "2026-07-11T20:00:00.000Z", program: { name: "Chess Club" }, participant: { id: 100, name: "Kid One" }, rsvp: null, isVolunteer: false },
            ],
        });
        renderWithProviders(<ParticipantEventsDashboard />);

        expect(await screen.findByText("Robotics Meet")).toBeInTheDocument();
        // One badge, on the volunteered event only.
        expect(screen.getAllByText("Volunteer")).toHaveLength(1);
    });

    it("shows the failure, not an empty state, when the load fails", async () => {
        setSession({ id: 1 });
        mockFetchJson({});
        renderWithProviders(<ParticipantEventsDashboard />);

        expect(await screen.findByText("Couldn't load your events")).toBeInTheDocument();
        expect(screen.queryByText("No Upcoming Events")).not.toBeInTheDocument();
    });
});
