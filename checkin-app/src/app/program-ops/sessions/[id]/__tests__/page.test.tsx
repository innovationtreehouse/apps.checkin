/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, setSearchParams, router, resetRtl } from "@/test-helpers/rtl";
import EventAdminPage from "../page";

// jsdom lacks scrollIntoView, which Mantine's Select/Combobox calls on open.
beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

// `use(params)` suspends on any promise it hasn't already tracked, even one that
// resolved microtasks ago — pre-mark it "fulfilled" (React's own thenable-caching
// shape) so `use` returns synchronously and the page doesn't need a Suspense
// boundary/act(async) dance in every test.
function paramsFor(id: string): Promise<{ id: string }> {
    const p = Promise.resolve({ id }) as Promise<{ id: string }> & { status?: string; value?: unknown };
    p.status = "fulfilled";
    p.value = { id };
    return p;
}

function renderPage(params: Promise<{ id: string }>) {
    return renderWithProviders(<EventAdminPage params={params} />);
}

function baseEvent(overrides: Record<string, unknown> = {}) {
    return {
        id: 5,
        name: "Robotics Session",
        startAt: "2020-01-01T18:00:00.000Z",
        endAt: "2020-01-01T20:00:00.000Z",
        attendanceConfirmedAt: null,
        attendanceConfirmedBy: null,
        recurringGroupId: null,
        program: {
            id: 10,
            name: "Robotics",
            leadMentorId: 1,
            volunteers: [
                { personId: 2, person: { id: 2, name: "Val Volunteer", email: "val@example.com" }, isCore: true },
            ],
            participants: [
                { personId: 3, person: { id: 3, name: "Pat Participant", email: "pat@example.com" } },
            ],
        },
        visits: [{ id: 1, personId: 3, arrivedAt: "2020-01-01T18:05:00.000Z", departedAt: null }],
        rsvps: [{ personId: 3, status: "ATTENDING" }],
        ...overrides,
    };
}

const params = paramsFor("5");

/**
 * mockFetchJson answers every matched route ok:true, and GET/PATCH to
 * `/api/events/5` share a URL, so an "action fails after a successful load"
 * test needs a method-aware stub instead: GET returns `event`, PATCH runs
 * `onPatch` (so each test controls success/failure/throw per click).
 */
function fetchEventThenPatchWith(event: unknown, onPatch: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const fn = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            return onPatch(JSON.parse(init.body as string));
        }
        return { ok: true, json: async () => event } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

describe("EventAdminPage", () => {
    it("redirects unauthenticated users without fetching", async () => {
        setSession(null, "unauthenticated");
        const fetchSpy = mockFetchJson({});
        renderPage(params);
        await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("shows a not-found card when the event fetch fails", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({});
        renderPage(params);
        expect(await screen.findByText("Failed to load event.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
        expect(router.back).toHaveBeenCalled();
    });

    it("past event: renders roster/RSVPs, confirms attendance, and saves a manual edit", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);

        expect(await screen.findByText("Robotics Session")).toBeInTheDocument();
        expect(screen.getAllByText("Pat Participant").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Val Volunteer").length).toBeGreaterThan(0);
        expect(screen.getByText("Attending")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Confirm Attendance" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Attendance confirmed successfully!" })));

        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[0]);
        expect(await screen.findByText(/Manual Edit:/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        // Success closes the modal (no page-level message); the refreshed roster shows the change.
        await waitFor(() => expect(screen.queryByText(/Manual Edit:/)).not.toBeInTheDocument());
    });

    it("future event: edit mode saves a time change and cancels the event", async () => {
        setSession({ id: 1, isSysadmin: true });
        const future = baseEvent({
            startAt: "2999-01-01T18:00:00.000Z",
            endAt: "2999-01-01T20:00:00.000Z",
            recurringGroupId: "series-1",
        });
        mockFetchJson({ "/api/events/5": future });
        renderPage(params);

        await screen.findByText("Robotics Session");
        fireEvent.click(screen.getByRole("button", { name: "Edit Date / Time" }));
        expect(screen.getByLabelText(/Apply to Series/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Save Time Changes" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Event time updated successfully!" })));

        fireEvent.click(screen.getByRole("button", { name: "Edit Date / Time" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel Event(s)" }));

        const confirmModal = await screen.findByRole("dialog", { name: "Cancel Event" });
        fireEvent.click(within(confirmModal).getByRole("button", { name: "Cancel Event(s)" }));
        await waitFor(() => expect(router.push).toHaveBeenCalledWith("/program-ops/programs/10"));
    });

    it("fromProgramsILead: back button and confirm-attendance both return to Programs I Lead", async () => {
        setSession({ id: 1, isSysadmin: true });
        setSearchParams("from=programs-i-lead");
        mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);

        expect(await screen.findByRole("button", { name: "← Back to Programs I Lead" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "← Back to Programs I Lead" }));
        expect(router.push).toHaveBeenCalledWith("/programs-i-lead");

        fireEvent.click(screen.getByRole("button", { name: "Confirm Attendance" }));
        await waitFor(() => expect(router.push).toHaveBeenCalledWith("/programs-i-lead"));
        // The fromProgramsILead branch returns before setMessage/fetchEvent run.
        expect(screen.queryByText("Attendance confirmed successfully!")).not.toBeInTheDocument();
    });

    it("already-confirmed attendance shows Re-confirm and falls back to 'Unknown', then re-confirms", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({
            "/api/events/5": baseEvent({ attendanceConfirmedAt: "2020-01-02T00:00:00.000Z", attendanceConfirmedBy: null }),
        });
        renderPage(params);

        expect(await screen.findByText(/by Unknown/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Re-confirm" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Attendance confirmed successfully!" })));
    });

    it("confirm attendance: shows the server error, then a network-error message", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);
        await screen.findByText("Robotics Session");

        fetchEventThenPatchWith(baseEvent(), () => ({ ok: false, json: async () => ({ error: "Not ready to confirm." }) } as Response));
        fireEvent.click(screen.getByRole("button", { name: "Confirm Attendance" }));
        expect(await screen.findByText("Not ready to confirm.")).toBeInTheDocument();

        fetchEventThenPatchWith(baseEvent(), () => { throw new Error("boom"); });
        fireEvent.click(screen.getByRole("button", { name: "Confirm Attendance" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
    });

    it("edit time: shows the server error, then a network-error message", async () => {
        setSession({ id: 1, isSysadmin: true });
        const future = baseEvent({ startAt: "2999-01-01T18:00:00.000Z", endAt: "2999-01-01T20:00:00.000Z" });
        mockFetchJson({ "/api/events/5": future });
        renderPage(params);
        await screen.findByText("Robotics Session");
        fireEvent.click(screen.getByRole("button", { name: "Edit Date / Time" }));

        fetchEventThenPatchWith(future, () => ({ ok: false, json: async () => ({ error: "Time window closed." }) } as Response));
        fireEvent.click(screen.getByRole("button", { name: "Save Time Changes" }));
        expect(await screen.findByText("Time window closed.")).toBeInTheDocument();

        fetchEventThenPatchWith(future, () => { throw new Error("boom"); });
        fireEvent.click(screen.getByRole("button", { name: "Save Time Changes" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
    });

    it("manual edit: a checked-in member (open visit) defaults to Present with time fields; Absent is disabled with a hint", async () => {
        setSession({ id: 1, isSysadmin: true });
        // baseEvent's Pat has an open visit (departedAt null) — the server rejects marking Absent.
        mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);
        await screen.findByText("Robotics Session");

        // Roster sorts Core Volunteer (Val, no visit) before Participant (Pat, has a visit) —
        // index [1] is Pat, whose existing visit drives the "Present" default branch.
        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[1]);
        expect(await screen.findByText(/Manual Edit: Pat Participant/)).toBeInTheDocument();
        // getByLabelText also matches the Select's aria-labelledby listbox div, and
        // Present/Absent share the same value+label, so scope to the textbox role.
        const statusInput = screen.getByRole("textbox", { name: "Status" });
        expect(statusInput).toHaveValue("Present");
        expect(screen.getByLabelText("Arrived Time")).toBeInTheDocument();
        expect(screen.getByLabelText("Departed Time")).toBeInTheDocument();
        expect(screen.getByText(/Still checked in: they badge out at the kiosk/)).toBeInTheDocument();

        // The Absent option is present but disabled; clicking it does not switch status.
        fireEvent.click(statusInput);
        const absentOption = screen.getByText("Absent", { selector: '[role="option"] span' }).closest('[role="option"]');
        expect(absentOption).toHaveAttribute("data-combobox-disabled", "true");
        fireEvent.click(absentOption!);
        expect(statusInput).toHaveValue("Present");
        expect(screen.getByLabelText("Arrived Time")).toBeInTheDocument();
    });

    it("manual edit: a departed member (closed visit) can toggle to Absent, which hides time fields and saves null times", async () => {
        setSession({ id: 1, isSysadmin: true });
        // Closed visit (departedAt set) — not currently checked in, so Absent is allowed.
        const event = baseEvent({ visits: [{ id: 1, personId: 3, arrivedAt: "2020-01-01T18:05:00.000Z", departedAt: "2020-01-01T19:00:00.000Z" }] });
        const fetchMock = mockFetchJson({ "/api/events/5": event });
        renderPage(params);
        await screen.findByText("Robotics Session");

        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[1]);
        expect(await screen.findByText(/Manual Edit: Pat Participant/)).toBeInTheDocument();
        const statusInput = screen.getByRole("textbox", { name: "Status" });
        expect(statusInput).toHaveValue("Present");
        expect(screen.queryByText("Check them out first to mark Absent.")).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Arrived Time"), { target: { value: "2020-01-01T18:10" } });
        fireEvent.change(screen.getByLabelText("Departed Time"), { target: { value: "2020-01-01T19:10" } });

        fireEvent.click(statusInput);
        fireEvent.click(screen.getByText("Absent", { selector: '[role="option"] span' }));
        expect(screen.queryByLabelText("Arrived Time")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/events/5", expect.objectContaining({ method: "PATCH" })));
        const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH");
        const body = JSON.parse((call?.[1] as RequestInit).body as string);
        expect(body).toMatchObject({ action: "manualEditAttendance", status: "Absent", arrivedAt: null, departedAt: null });
    });

    it("manual edit modal: Cancel button and the (X) close button both dismiss without saving", async () => {
        setSession({ id: 1, isSysadmin: true });
        const fetchMock = mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);
        await screen.findByText("Robotics Session");

        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[0]);
        await screen.findByText(/Manual Edit:/);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByText(/Manual Edit:/)).not.toBeInTheDocument());

        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[0]);
        await screen.findByText(/Manual Edit:/);
        // Mantine's Modal close (X) button has no accessible name; select by its class.
        fireEvent.click(document.querySelector(".mantine-Modal-close") as Element);
        await waitFor(() => expect(screen.queryByText(/Manual Edit:/)).not.toBeInTheDocument());

        expect(fetchMock).not.toHaveBeenCalledWith("/api/events/5", expect.objectContaining({ method: "PATCH" }));
    });

    it("manual edit: shows the server error, then a network-error message", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);
        await screen.findByText("Robotics Session");
        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[0]);
        await screen.findByText(/Manual Edit:/);

        fetchEventThenPatchWith(baseEvent(), () => ({ ok: false, json: async () => ({ error: "Locked." }) } as Response));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Locked.")).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole("button", { name: "Manual Edit" })[0]);
        fetchEventThenPatchWith(baseEvent(), () => { throw new Error("boom"); });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
    });

    it("cancel event: declining the confirm() dialog skips the request; accepting shows the server error", async () => {
        setSession({ id: 1, isSysadmin: true });
        const future = baseEvent({ startAt: "2999-01-01T18:00:00.000Z", endAt: "2999-01-01T20:00:00.000Z" });
        const fetchMock = mockFetchJson({ "/api/events/5": future });
        renderPage(params);
        await screen.findByText("Robotics Session");
        // The "Cancel Event" button opens the same edit form as "Edit Date / Time"
        // (separate onClick instance) — used here so both handlers get exercised.
        fireEvent.click(screen.getByRole("button", { name: "Cancel Event" }));

        fireEvent.click(screen.getByRole("button", { name: "Cancel Event(s)" }));
        let modal = await screen.findByRole("dialog", { name: "Cancel Event" });
        fireEvent.click(within(modal).getByRole("button", { name: "Nevermind" }));
        expect(fetchMock).not.toHaveBeenCalledWith("/api/events/5", expect.objectContaining({ method: "PATCH" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cancel Event" })).not.toBeInTheDocument());

        fetchEventThenPatchWith(future, () => ({ ok: false, json: async () => ({ error: "Cannot cancel now." }) } as Response));
        fireEvent.click(screen.getByRole("button", { name: "Cancel Event(s)" }));
        modal = await screen.findByRole("dialog", { name: "Cancel Event" });
        fireEvent.click(within(modal).getByRole("button", { name: "Cancel Event(s)" }));
        expect(await screen.findByText("Cannot cancel now.")).toBeInTheDocument();
    });

    it("cancel event: network error, then a program-less event falls back to the programs list on success", async () => {
        setSession({ id: 1, isSysadmin: true });
        const future = baseEvent({ startAt: "2999-01-01T18:00:00.000Z", endAt: "2999-01-01T20:00:00.000Z", program: undefined });
        mockFetchJson({ "/api/events/5": future });
        renderPage(params);
        await screen.findByText("Robotics Session");
        fireEvent.click(screen.getByRole("button", { name: "Edit Date / Time" }));

        fetchEventThenPatchWith(future, () => { throw new Error("boom"); });
        fireEvent.click(screen.getByRole("button", { name: "Cancel Event(s)" }));
        let modal = await screen.findByRole("dialog", { name: "Cancel Event" });
        fireEvent.click(within(modal).getByRole("button", { name: "Cancel Event(s)" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cancel Event" })).not.toBeInTheDocument());

        fetchEventThenPatchWith(future, () => ({ ok: true, json: async () => ({}) } as Response));
        fireEvent.click(screen.getByRole("button", { name: "Cancel Event(s)" }));
        modal = await screen.findByRole("dialog", { name: "Cancel Event" });
        fireEvent.click(within(modal).getByRole("button", { name: "Cancel Event(s)" }));
        await waitFor(() => expect(router.push).toHaveBeenCalledWith("/program-ops/programs"));
    });

    it("past event, no permission: shows the read-only past-event alert", async () => {
        setSession({ id: 99 });
        mockFetchJson({ "/api/events/5": baseEvent() });
        renderPage(params);

        expect(await screen.findByText(/This is a past event\. You do not have permission/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Confirm Attendance" })).not.toBeInTheDocument();
    });

    it("future event, core-volunteer only: shows the read-only future-event alert without edit controls", async () => {
        setSession({ id: 2 }); // Val Volunteer: isCore true, not admin/lead
        const future = baseEvent({ startAt: "2999-01-01T18:00:00.000Z", endAt: "2999-01-01T20:00:00.000Z" });
        mockFetchJson({ "/api/events/5": future });
        renderPage(params);

        expect(await screen.findByText(/scheduled future event/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Edit Date / Time" })).not.toBeInTheDocument();
    });

    it("future event: lead mentor alone (no admin/board) can manage event info, edit the time fields, toggle apply-to-series, and back out", async () => {
        setSession({ id: 1, isSysadmin: false, isBoardMember: false }); // matches baseEvent's leadMentorId
        const future = baseEvent({
            startAt: "2999-01-01T18:00:00.000Z", endAt: "2999-01-01T20:00:00.000Z", recurringGroupId: "series-1",
        });
        mockFetchJson({ "/api/events/5": future });
        renderPage(params);

        fireEvent.click(await screen.findByRole("button", { name: "Edit Date / Time" }));
        fireEvent.change(screen.getByLabelText("Start Time"), { target: { value: "2999-01-01T17:00" } });
        fireEvent.change(screen.getByLabelText("End Time"), { target: { value: "2999-01-01T21:00" } });
        fireEvent.click(screen.getByLabelText(/Apply to Series/));

        fireEvent.click(screen.getByRole("button", { name: "Nevermind" }));
        expect(screen.queryByLabelText("Start Time")).not.toBeInTheDocument();
    });

    it("renders RSVP badge variants and a departed visit's Left: time", async () => {
        setSession({ id: 1, isSysadmin: true });
        const event = baseEvent({
            program: {
                id: 10, name: "Robotics", leadMentorId: 1,
                volunteers: [
                    { personId: 2, person: { id: 2, name: "Val Volunteer", email: "val@example.com" }, isCore: true },
                ],
                participants: [
                    { personId: 3, person: { id: 3, name: "Pat Participant", email: "pat@example.com" } },
                    { personId: 4, person: { id: 4, name: "Sam Sub", email: "sam@example.com" } },
                    { personId: 6, person: { id: 6, name: "Robin Roster", email: "robin@example.com" } },
                ],
            },
            visits: [{ id: 1, personId: 2, arrivedAt: "2020-01-01T18:05:00.000Z", departedAt: "2020-01-01T19:00:00.000Z" }],
            rsvps: [
                { personId: 2, status: "ATTENDING" },
                { personId: 3, status: "MAYBE" },
                { personId: 4, status: "NOT_ATTENDING" },
            ],
        });
        mockFetchJson({ "/api/events/5": event });
        renderPage(params);

        expect(await screen.findByText("Maybe")).toBeInTheDocument();
        expect(screen.getByText("Not attending")).toBeInTheDocument();
        expect(screen.getByText("No response")).toBeInTheDocument(); // Robin Roster has no rsvp entry
        expect(screen.getByText(/Left:/)).toBeInTheDocument();
    });

    it("program with no roster shows 'No roster found for this program' in both tables", async () => {
        // Past event + canManageAttendance renders renderRosterGrid() too, alongside
        // the always-rendered renderRsvpList() — both hit the empty-roster branch.
        setSession({ id: 1, isSysadmin: true });
        const past = baseEvent({
            program: { id: 10, name: "Robotics", leadMentorId: 1, volunteers: [], participants: [] },
            visits: [],
            rsvps: [],
        });
        mockFetchJson({ "/api/events/5": past });
        renderPage(params);

        expect(await screen.findAllByText("No roster found for this program.")).toHaveLength(2);
    });
});
