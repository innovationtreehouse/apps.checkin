// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import ProgramDetailsPage from "../page";

// `mockFetchJson` always answers a matched URL with 200; several branches below
// need a specific HTTP method and/or a non-2xx status (404/500/network error) on
// the SAME url other requests hit successfully, which its url-only routing can't
// express. This routes by url substring + method, letting `result` vary per rule
// (or be a function for a stateful sequence of responses).
type RouteResult = { ok?: boolean; status?: number; body?: unknown; throws?: boolean };
function routedFetch(rules: { url: string; method?: string; result: RouteResult | (() => RouteResult) }[]) {
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    const rule = rules.find((r) => url.includes(r.url) && (!r.method || r.method === method));
    const res = rule ? (typeof rule.result === "function" ? rule.result() : rule.result) : { ok: false, status: 404, body: {} };
    if (res.throws) throw new Error("network error");
    const body = res.body ?? {};
    return {
      ok: res.ok !== false,
      status: res.status ?? (res.ok !== false ? 200 : 500),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// React's `use()` suspends on a bare Promise until its microtask settles, which
// needs an async act() the RTL render() doesn't provide. Pre-tagging the promise
// as already-fulfilled (the same fields React's `use()` checks) makes `use()`
// return the value synchronously, so a plain render() works.
function resolvedParams(value: { id: string }): Promise<{ id: string }> {
  const p = Promise.resolve(value) as Promise<{ id: string }> & { status?: string; value?: unknown };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

beforeEach(() => resetRtl());

const programData = {
  id: 1,
  name: "Robotics Club",
  startAt: "2026-01-10T00:00:00.000Z",
  endAt: "2026-05-10T00:00:00.000Z",
  leadMentorId: 5,
  phase: "RUNNING",
  enrollmentStatus: "OPEN",
  minAge: 10,
  maxAge: 18,
  maxParticipants: 20,
  orgMemberOnly: false,
  participants: [
    {
      personId: 101, status: "ACTIVE", pendingSince: null,
      person: { name: "Alice Kid", email: "alice@example.com", phone: "5125551234" },
    },
    {
      personId: 102, status: "PENDING", pendingSince: "2026-01-06T00:00:00.000Z",
      person: { name: "Charlie Kid", email: "charlie@example.com" },
    },
  ],
  volunteers: [
    { personId: 201, isCore: true, person: { name: "Vera Volunteer", email: "vera@example.com" } },
  ],
  events: [
    { id: 301, name: "Session 1", startAt: "2026-02-01T18:00:00.000Z", endAt: "2026-02-01T20:00:00.000Z", attendanceConfirmedAt: null },
  ],
  leadMentor: { name: "Mandy Mentor", email: "mandy@example.com" },
  orgMemberPriceCents: null,
  nonOrgMemberPriceCents: null,
  shopifyProductId: null,
};

function renderPage() {
  return renderWithProviders(<ProgramDetailsPage params={resolvedParams({ id: "1" })} />);
}

describe("ProgramDetailsPage", () => {
  it("loads and renders the general tab for an authorized admin", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": programData });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Robotics Club", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("2 / 20")).toBeInTheDocument();
    expect(screen.getByText("Mandy Mentor (mandy@example.com)")).toBeInTheDocument();
  });

  it("renders a zero max participants as a real cap, not as uncapped", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": { ...programData, maxParticipants: 0 } });
    renderPage();

    expect(await screen.findByText("2 / 0")).toBeInTheDocument();
  });

  it("switches to the roster tab and shows volunteers/participants", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": programData });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByText(/Vera Volunteer/)).toBeInTheDocument();
    expect(screen.getByText(/Alice Kid/)).toBeInTheDocument();
    expect(screen.getByText(/Charlie Kid/)).toBeInTheDocument();
  });

  it("searches and adds a volunteer", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/programs/1/eligible-participants": { members: [{ id: 555, name: "Wendy West", ageWarning: null }] },
      "/api/programs/1/volunteers": {},
      "/api/programs/1": programData,
    });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));

    const volunteerSearch = (await screen.findAllByPlaceholderText("Start typing to search..."))[0];
    fireEvent.change(volunteerSearch, { target: { value: "Wendy" } });

    expect(await screen.findByText("Wendy West")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Wendy West"));

    const addButtons = screen.getAllByRole("button", { name: "Add" });
    fireEvent.click(addButtons[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/volunteers",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ participantId: 555 }) }),
      ),
    );
  });

  it("shows scheduled events on the events tab", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": programData });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    // Event ended in the past with no attendanceConfirmedAt -> needs confirmation.
    expect(screen.getByRole("link", { name: "Confirm Attendance" })).toBeInTheDocument();
  });

  it("shows a not-found message and navigates back", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({}); // no route matches -> 404
    renderPage();

    expect(await screen.findByText("Program not found.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.push).toHaveBeenCalledWith("/program-ops/programs");
  });

  it("shows a generic failure message on a non-404 load error", async () => {
    setSession({ id: 1, isSysadmin: true });
    routedFetch([{ url: "/api/programs/1", method: "GET", result: { ok: false, status: 500 } }]);
    renderPage();

    expect(await screen.findByText("Failed to load program.")).toBeInTheDocument();
  });

  it("shows a network error message when loading throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    routedFetch([{ url: "/api/programs/1", method: "GET", result: { throws: true } }]);
    renderPage();

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error.", autoClose: false }),
      ),
    );
  });

  it("shows a forbidden message for a user without authorization", async () => {
    setSession({ id: 42, isSysadmin: false, isBoardMember: false });
    mockFetchJson({ "/api/programs/1": programData }); // leadMentorId is 5, not 42
    renderPage();

    expect(await screen.findByText("Forbidden: Not authorized to manage this program.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.push).toHaveBeenCalledWith("/program-ops/programs");
  });

  it("edits general-tab fields and saves settings successfully", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = routedFetch([
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
      { url: "/api/programs/1", method: "PATCH", result: { ok: true, body: {} } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("Minimum Age (Optional)"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Maximum Age (Optional)"), { target: { value: "16" } });
    fireEvent.change(screen.getByLabelText("Max Participants (Optional)"), { target: { value: "30" } });
    fireEvent.click(screen.getByLabelText("Treehouse Members-Only Program"));

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/programs/1", expect.objectContaining({ method: "PATCH" })),
    );
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Saved." })),
    );
  });

  it("shows the server error message when saving general settings fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    routedFetch([
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
      { url: "/api/programs/1", method: "PATCH", result: { ok: false, status: 400, body: { error: "Invalid dates." } } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(await screen.findByText("Invalid dates.")).toBeInTheDocument();
  });

  it("shows a network error message when saving general settings throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    routedFetch([
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
      { url: "/api/programs/1", method: "PATCH", result: { throws: true } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error.", autoClose: false }),
      ),
    );
  });

  it("switches to editing the program leader, selects a new one, then cancels back", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/programs/1/eligible-participants": {},
      "/api/people/search": { people: [{ id: 9, name: "Andy Adult", email: "andy@example.com" }] },
      "/api/programs/1": programData,
    });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    expect(screen.getByText("Mandy Mentor (mandy@example.com)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeDisabled();

    const mentorSearchInput = screen.getByPlaceholderText("Search Adult Members...");
    fireEvent.change(mentorSearchInput, { target: { value: "Andy" } });
    fireEvent.click(await screen.findByText("Andy Adult"));
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Mandy Mentor (mandy@example.com)")).toBeInTheDocument();
  });

  it("shows read-only mentor text and the no-mentor state for a non-admin lead", async () => {
    const soloProgram = { ...programData, leadMentorId: 8, leadMentor: null };
    setSession({ id: 8, isSysadmin: false, isBoardMember: false });
    mockFetchJson({ "/api/programs/1": soloProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    expect(screen.getByText("No Program Leader Assigned")).toBeInTheDocument();
    expect(screen.getByText("*Only Administrators/Board Members can change the Program Leader.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByText(/Program Leads cannot manually enroll participants/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enroll" })).not.toBeInTheDocument();
  });

  it("shows disabled price inputs and warns when no max participants is set for a priced program", async () => {
    const paidProgram = { ...programData, orgMemberPriceCents: 1500, nonOrgMemberPriceCents: 750, maxParticipants: null };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": paidProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    expect(screen.getByLabelText("Treehouse Member Price ($)")).toBeDisabled();
    expect(screen.getByLabelText("Treehouse Member Price ($)")).toHaveValue("15");
    expect(screen.getByLabelText("Non-Member Price ($)")).toHaveValue("7.5");
    expect(screen.getByText(/No max participants set/)).toBeInTheDocument();
  });

  it("toggles a volunteer's core status", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/programs/1/volunteers": {}, "/api/programs/1": programData });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));

    const coreCheckbox = await screen.findByLabelText("Core Volunteer");
    fireEvent.click(coreCheckbox);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/volunteers",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ participantId: 201, isCore: false }) }),
      ),
    );
  });

  it("removes a volunteer only when the confirm dialog is accepted", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/programs/1/volunteers": {}, "/api/programs/1": programData });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Vera Volunteer/);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const declineModal = await screen.findByRole("dialog", { name: "Remove Volunteer" });
    fireEvent.click(within(declineModal).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/programs/1/volunteers",
      expect.objectContaining({ method: "DELETE" }),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const confirmModal = await screen.findByRole("dialog", { name: "Remove Volunteer" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/volunteers",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ participantId: 201 }) }),
      ),
    );
  });

  it("keeps the volunteer selection when the add request fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = routedFetch([
      { url: "/api/programs/1/eligible-participants", method: "GET", result: { ok: true, body: { members: [{ id: 555, name: "Wendy West", ageWarning: null }] } } },
      { url: "/api/programs/1/volunteers", method: "POST", result: { ok: false, status: 400, body: {} } },
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));

    const volunteerSearch = (await screen.findAllByPlaceholderText("Start typing to search..."))[0];
    fireEvent.change(volunteerSearch, { target: { value: "Wendy" } });
    fireEvent.click(await screen.findByText("Wendy West"));
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/programs/1/volunteers", expect.objectContaining({ method: "POST" })),
    );
    expect(screen.getByDisplayValue("Wendy West")).toBeInTheDocument();
  });

  it("shows empty states when there are no volunteers, participants, or events", async () => {
    const emptyProgram = { ...programData, participants: [], volunteers: [], events: [] };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": emptyProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByText("No volunteers assigned.")).toBeInTheDocument();
    expect(screen.getByText("No active participants yet.")).toBeInTheDocument();
    expect(screen.getByText("No pending participants.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(await screen.findByText("No events scheduled.")).toBeInTheDocument();
  });

  it("enrolls a participant after the sysadmin confirms, shows the server's age warning, and shows a server error otherwise", async () => {
    setSession({ id: 1, isSysadmin: true });
    const eligible = {
      members: [
        { id: 777, name: "Gerry Grownup", ageWarning: null },
        { id: 778, name: "Kiki Kid", ageWarning: "Too young" },
      ],
    };
    let attempt = 0;
    const fetchMock = routedFetch([
      { url: "/api/programs/1/eligible-participants", method: "GET", result: { ok: true, body: eligible } },
      {
        url: "/api/programs/1/participants", method: "POST",
        result: () => (attempt++ === 0 ? { ok: false, status: 400, body: { error: "Program is full." } } : { ok: true, body: {} }),
      },
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));

    const participantSearch = (await screen.findAllByPlaceholderText("Start typing to search..."))[1];
    fireEvent.change(participantSearch, { target: { value: "e" } });
    await screen.findByText("Kiki Kid");
    expect(screen.getAllByText(/Too young/)).toHaveLength(1);
    fireEvent.click(screen.getByText("Gerry Grownup"));

    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    const declineModal = await screen.findByRole("dialog", { name: "Add Participant Manually" });
    fireEvent.click(within(declineModal).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/programs/1/participants", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    const failModal = await screen.findByRole("dialog", { name: "Add Participant Manually" });
    fireEvent.click(within(failModal).getByRole("button", { name: "Add Participant" }));
    expect(await screen.findByText("Program is full.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    const retryModal = await screen.findByRole("dialog", { name: "Add Participant Manually" });
    fireEvent.click(within(retryModal).getByRole("button", { name: "Add Participant" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/participants",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ participantId: 777, override: true }) }),
      ),
    );
  });

  it("renders the parents above the emergency contacts, skipping a participant who leads their own household", async () => {
    const withParents = {
      ...programData,
      participants: [
        {
          personId: 501, status: "ACTIVE", pendingSince: null,
          person: {
            name: "Kid With Parents", email: "kid@example.com", phone: "5125559999",
            household: {
              householdMembers: [
                { id: 601, name: "Sam Smith", email: "sam@example.com", phone: "5125551111" },
                { id: 602, name: "Jamie Smith", email: null, phone: "5125552222" },
              ],
              emergencyContacts: [{ id: 1, name: "Aunt Ada", phone: "5125553333", relationship: "Aunt" }],
            },
          },
        },
        {
          personId: 603, status: "ACTIVE", pendingSince: null,
          person: {
            name: "Adult Lead", email: "adult@example.com", phone: "5125558888",
            household: {
              householdMembers: [{ id: 603, name: "Adult Lead", email: "adult@example.com", phone: "5125558888" }],
              emergencyContacts: [],
            },
          },
        },
      ],
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": withParents });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));

    const labels = await screen.findAllByText("Parent/Guardian:");
    expect(screen.getByText(/Sam Smith - 512-555-1111, sam@example.com; Jamie Smith - 512-555-2222/)).toBeInTheDocument();

    // The point of the issue: parents come first, emergency contacts after.
    // Both cards render a singular "Emergency Contact:"; [0] is this card's.
    const contacts = screen.getAllByText("Emergency Contact:")[0];
    expect(labels[0].compareDocumentPosition(contacts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // An adult who leads their own household is not listed as their own parent:
    // the second card's line reads N/A, not the adult's own name.
    expect(labels[1].parentElement).toHaveTextContent("Parent/Guardian: N/A");
    expect(screen.queryByText(/Adult Lead - /)).not.toBeInTheDocument();
  });

  it("renders participant phone/household/pending-since edge cases and removes on confirm", async () => {
    const detailedProgram = {
      ...programData,
      participants: [
        {
          personId: 401, status: "ACTIVE", joinedAt: null, pendingSince: null,
          person: { name: "No Phone Kid", email: "nophone@example.com", phone: null, household: { emergencyContacts: [] } },
        },
        {
          personId: 402, status: "ACTIVE", joinedAt: "2026-01-02T00:00:00.000Z", pendingSince: null,
          person: {
            name: "Two Contacts Kid", email: "two@example.com", phone: "5125550000",
            household: { emergencyContacts: [
              { id: 1, name: "Mom", phone: "5125551111", relationship: "Mother" },
              { id: 2, name: "Dad", phone: "5125552222", relationship: "Father" },
            ] },
          },
        },
        {
          personId: 403, status: "PENDING", joinedAt: null, pendingSince: null,
          person: { name: "Unknown Pending", email: "pend@example.com", phone: null },
        },
      ],
    };
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/programs/1": detailedProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));

    expect(await screen.findByText("Emergency Contact:")).toBeInTheDocument(); // singular, N/A
    expect(screen.getByText("Emergency Contacts:")).toBeInTheDocument(); // plural
    expect(screen.getByText(/Mom - 512-555-1111; Dad - 512-555-2222/)).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument(); // pendingSince null

    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    // Volunteers card renders first (1 volunteer), then active participants (401, 402), then pending (403).
    fireEvent.click(removeButtons[1]);
    const modal1 = await screen.findByRole("dialog", { name: "Remove Participant" });
    fireEvent.click(within(modal1).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/participants",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ participantId: 401 }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Participant" })).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[3]);
    const modal2 = await screen.findByRole("dialog", { name: "Remove Participant" });
    fireEvent.click(within(modal2).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/participants",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ participantId: 403 }) }),
      ),
    );
  });

  const pricedProgram = { ...programData, orgMemberPriceCents: 1000, nonOrgMemberPriceCents: 1500, shopifyVariantId: "v1" };

  it("disables removing a paid place for a sysadmin who is not on the Board", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": pricedProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Charlie Kid/);

    // Volunteer (201), paid active participant (101), then the pending one (102).
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    expect(removeButtons[1]).toBeDisabled();
    expect(removeButtons[1]).toHaveAttribute("title", "Only the Board removes a paid place");
    expect(removeButtons[2]).toBeEnabled();
  });

  it("asks a Board member for a written reason before removing a paid place", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({ "/api/programs/1": pricedProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Charlie Kid/);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    const modal = await screen.findByRole("dialog", { name: "Remove Participant" });
    const confirm = within(modal).getByRole("button", { name: "Remove" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(modal).getByRole("textbox", { name: /Reason/ }), { target: { value: " Family moved away " } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/participants",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ participantId: 101, reason: "Family moved away" }) }),
      ),
    );
  });

  it("surfaces the server error when removing a pending participant is rejected", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = routedFetch([
      {
        url: "/api/programs/1/participants", method: "DELETE",
        result: { ok: false, status: 403, body: { error: "Forbidden: Not authorized to remove this participant" } },
      },
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Charlie Kid/);

    // Volunteer (201), active participant (101), then the pending one (102).
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[2]);
    const modal = await screen.findByRole("dialog", { name: "Remove Participant" });
    fireEvent.click(within(modal).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs/1/participants",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ participantId: 102 }) }),
      ),
    );
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Forbidden: Not authorized to remove this participant" }),
      ),
    );
    // The row is still there — the failed removal must not look like it worked.
    expect(screen.getByText(/Charlie Kid/)).toBeInTheDocument();
  });

  it("surfaces a network error when the remove request throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    routedFetch([
      { url: "/api/programs/1/participants", method: "DELETE", result: { throws: true } },
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Charlie Kid/);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[2]);
    const modal = await screen.findByRole("dialog", { name: "Remove Participant" });
    fireEvent.click(within(modal).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error — please try again." }),
      ),
    );
  });

  it("surfaces the server error when removing a volunteer is rejected", async () => {
    setSession({ id: 1, isSysadmin: true });
    routedFetch([
      { url: "/api/programs/1/volunteers", method: "DELETE", result: { ok: false, status: 500, body: {} } },
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Vera Volunteer/);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const modal = await screen.findByRole("dialog", { name: "Remove Volunteer" });
    fireEvent.click(within(modal).getByRole("button", { name: "Remove" }));

    // No `error` in the body -> the status-code fallback.
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Request failed (500)." }),
      ),
    );
  });

  it("surfaces a DELETE notice/warning as a notification, but stays quiet on a bare success", async () => {
    setSession({ id: 1, isSysadmin: true });
    const responses = [
      { notice: "Seat freed. Add +1 in Shopify." },
      { warning: "Shopify inventory release failed." },
      { success: true },
    ];
    let call = 0;
    routedFetch([
      { url: "/api/programs/1", method: "GET", result: { ok: true, body: programData } },
      { url: "/api/programs/1/participants", method: "DELETE", result: () => ({ ok: true, body: responses[call++] }) },
    ]);
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText(/Alice Kid/);

    // 1st remove -> notice (blue)
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove Participant" })).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "blue", message: "Seat freed. Add +1 in Shopify." })),
    );

    // 2nd remove -> warning (yellow)
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove Participant" })).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "yellow", message: "Shopify inventory release failed." })),
    );

    // 3rd remove -> bare success, no further notification
    const before = (notifications.show as jest.Mock).mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove Participant" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Participant" })).not.toBeInTheDocument());
    expect((notifications.show as jest.Mock).mock.calls.length).toBe(before);
  });

  it("shows past-confirmed and future events distinctly, and can schedule a new session", async () => {
    const eventsProgram = {
      ...programData,
      events: [
        { id: 301, name: "Old Confirmed", startAt: "2026-01-01T18:00:00.000Z", endAt: "2026-01-01T20:00:00.000Z", attendanceConfirmedAt: "2026-01-02T00:00:00.000Z" },
        { id: 302, name: "Future Session", startAt: "2027-01-01T18:00:00.000Z", endAt: "2027-01-01T20:00:00.000Z", attendanceConfirmedAt: null },
      ],
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": eventsProgram });
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));

    expect(await screen.findByRole("link", { name: "Attendance →" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit Event →" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Schedule Session(s)" }));
    expect(router.push).toHaveBeenCalledWith("/program-ops/sessions/new?programId=1");
  });

  it("runs the QR download and external-link actions, and the header back button navigates", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs/1": programData });
    window.open = jest.fn();
    renderPage();
    await screen.findByRole("heading", { name: "Robotics Club", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: /Download QR Code/ }));
    fireEvent.click(screen.getByRole("button", { name: /Public Details Page/ }));
    expect(window.open).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "← Back to Programs" }));
    expect(router.push).toHaveBeenCalledWith("/program-ops/programs");
  });
});
