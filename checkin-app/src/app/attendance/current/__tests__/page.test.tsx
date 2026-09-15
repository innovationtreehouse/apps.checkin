// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import fs from "fs";
import path from "path";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setSearchParams, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import KioskDisplay from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

const attendanceData = {
  access: "full",
  attendance: [
    { id: 201, arrivedAt: "2026-07-01T14:00:00.000Z", participant: { id: 50, email: "karen@example.com", name: "Karen Keyholder", isKeyholder: true, isSysadmin: false, dateOfBirth: "1985-01-01", householdId: 6 } },
    { id: 202, arrivedAt: "2026-07-01T14:05:00.000Z", participant: { id: 60, email: "val@example.com", name: "Val Volunteer", isKeyholder: false, isSysadmin: false, dateOfBirth: "1990-01-01", householdId: 7 } },
    { id: 203, arrivedAt: "2026-07-01T14:10:00.000Z", participant: { id: 70, email: "stu@example.com", name: "Stu Student", isKeyholder: false, isSysadmin: false, dateOfBirth: "2012-01-01", householdId: 8 } },
  ],
  counts: { keyholders: 1, volunteers: 1, youth: 1, total: 3 },
  safety: { isLastKeyholder: false, isTwoDeepViolation: false },
};

const householdData = {
  household: {
    householdMembers: [{ id: 90, name: "Jamie Kid", email: "jamie@example.com" }],
  },
};

function mockRoutes(overrides: Record<string, unknown | (() => unknown)> = {}) {
  return mockFetchJson({
    "/api/household": householdData,
    "/api/roles": { people: [{ id: 555, name: "Wendy West", email: "wendy@example.com", isKeyholder: false, isSysadmin: false }] },
    "/api/attendance": attendanceData,
    ...overrides,
  });
}

// A roster column is the element wrapping its header label and its card grid.
function columnFor(label: string) {
  return screen.getByText(label).closest("div")!.parentElement!.parentElement!;
}

// The admin (id 1, sysadmin + keyholder) is not checked in and has a household,
// so both the self check-in button and the household check-in row render.
function setAdminSession() {
  setSession({ id: 1, isSysadmin: true, isKeyholder: true, householdId: 5, householdLead: true });
}

describe("attendance/current page", () => {
  it("loads and renders the attendance columns", async () => {
    setAdminSession();
    mockRoutes();
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("People Present: 3")).toBeInTheDocument();
    expect(screen.getByText("Karen Keyholder")).toBeInTheDocument();
    expect(screen.getByText("Val Volunteer")).toBeInTheDocument();
    expect(screen.getByText("Stu Student")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check Me In" })).toBeInTheDocument();
  });

  it("checks the current admin in", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Check Me In" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/attendance",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId: 1 }),
        }),
      ),
    );
  });

  it("checks in a household member from the household row", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    expect(await screen.findByText("Check In Household Members")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Jamie Kid" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/attendance",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId: 90 }),
        }),
      ),
    );
  });

  it("searches and manually checks in a match", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.change(screen.getByPlaceholderText("Manually check someone in (Search by name, email, or ID)..."), {
      target: { value: "Wendy" },
    });

    expect(await screen.findByText("Wendy West")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check In" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/attendance",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId: 555 }),
        }),
      ),
    );
  });

  it("force-checks-out a user via the sign-out modal", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Sign out a user" }));
    const modal = await screen.findByRole("dialog", { name: "Sign Out A User" });
    expect(within(modal).getByText("Val Volunteer")).toBeInTheDocument();
    // Rows are sorted alphabetically: Karen, Stu, Val -> Val is the 3rd "Sign Out" button.
    const signOutButtons = within(modal).getAllByRole("button", { name: "Sign Out" });
    fireEvent.click(signOutButtons[2]);

    const confirmModal = await screen.findByRole("dialog", { name: "Force Checkout" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: "Force Checkout" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/attendance",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ visitId: 202 }) }),
      ),
    );
  });

  it("kiosk idle-stop keys on mode=kiosk or signedRequest, not URL sig params", () => {
    const src = fs.readFileSync(path.join(__dirname, "../page.tsx"), "utf8");
    expect(src).toContain('searchParams.get("mode") === "kiosk" || isSignedKiosk');
    expect(src).toContain("idleStopMs: isKioskDisplay ? undefined : POLL_IDLE_STOP_MS");
  });

  it("kiosk mode hides admin controls and shows privacy-safe first names", async () => {
    setSearchParams("mode=kiosk");
    // No admin flags — also exercises the session `|| false` / `|| null` fallbacks.
    setSession({ id: 999 });
    mockRoutes();
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Karen")).toBeInTheDocument();
    expect(screen.queryByText("Karen Keyholder")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Me In" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out a user" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Manually check someone in (Search by name, email, or ID)...")).not.toBeInTheDocument();
    expect(screen.queryByText("Household Check-ins")).not.toBeInTheDocument();
  });

  it("kiosk mode shows the ⚠ need-review corner count when parked scans await a human", async () => {
    setSearchParams("mode=kiosk");
    setSession({ id: 999 });
    mockRoutes({
      "/api/attendance": { ...attendanceData, counts: { ...attendanceData.counts, needReview: 4 } },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("⚠ 4 need review")).toBeInTheDocument();
    // A number only — nothing clickable that invites a login at the door.
    expect(screen.queryByRole("link", { name: /need review/ })).not.toBeInTheDocument();
  });

  it("hides the need-review count off-kiosk and when the queue is empty", async () => {
    setSearchParams("mode=kiosk");
    setSession({ id: 999 });
    mockRoutes({
      "/api/attendance": { ...attendanceData, counts: { ...attendanceData.counts, needReview: 0 } },
    });
    const { unmount } = renderWithProviders(<KioskDisplay />);
    expect(await screen.findByText("People Present: 3")).toBeInTheDocument();
    expect(screen.queryByText(/need review/)).not.toBeInTheDocument();
    unmount();
    resetRtl();

    // Same non-zero count, but not a kiosk display — the badge stays off.
    setAdminSession();
    mockRoutes({
      "/api/attendance": { ...attendanceData, counts: { ...attendanceData.counts, needReview: 4 } },
    });
    renderWithProviders(<KioskDisplay />);
    expect(await screen.findByText("People Present: 3")).toBeInTheDocument();
    expect(screen.queryByText(/need review/)).not.toBeInTheDocument();
  });

  it("limited access shows the household roster and hides admin controls", async () => {
    setSession({ id: 42, householdId: 8 });
    mockFetchJson({
      "/api/attendance": {
        access: "limited",
        counts: { keyholders: 0, volunteers: 0, students: 1, total: 1 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: false },
        self: null,
        household: [
          { id: 301, arrivedAt: "2026-07-01T14:00:00.000Z", participant: { id: 8801, email: "kid@example.com", name: "Kid Eight", isKeyholder: false, isSysadmin: false, dateOfBirth: "2015-01-01", householdId: 8 } },
        ],
      },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("People Present: 1")).toBeInTheDocument();
    expect(screen.getByText("Kid Eight")).toBeInTheDocument();
    expect(screen.getByText("Individual names are only visible to administrators", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Your household members are shown above.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check Me In" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Manually check someone in (Search by name, email, or ID)...")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out a user" })).not.toBeInTheDocument();
  });

  it("limited access shows the checked-in banner when self is already present", async () => {
    setSession({ id: 42, householdId: 8 });
    mockFetchJson({
      "/api/attendance": {
        access: "limited",
        counts: { keyholders: 0, volunteers: 1, students: 0, total: 1 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: false },
        self: { id: 401, arrivedAt: "2026-07-01T14:00:00.000Z", participant: { id: 42, email: "self@example.com", name: "Self Member", isKeyholder: false, isSysadmin: false, householdId: 8 } },
        household: [],
      },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("You are currently checked in!")).toBeInTheDocument();
  });

  it("shows a server error message when loading attendance fails", async () => {
    setAdminSession();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/attendance")) return { ok: false, json: async () => ({ error: "Server exploded" }) } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Server exploded")).toBeInTheDocument();
  });

  it("shows a friendly access-denied message for an Unauthorized error", async () => {
    setAdminSession();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/attendance")) return { ok: false, json: async () => ({ error: "Unauthorized" }) } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Access Denied: Please sign in to view attendance.")).toBeInTheDocument();
  });

  it("shows a network-error message when the attendance request throws", async () => {
    setAdminSession();
    global.fetch = jest.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error", autoClose: false }),
      ),
    );
    expect(await screen.findByText("Network error occurred.")).toBeInTheDocument();
  });

  it("reports an unknown supervision state instead of an empty facility when the initial load throws", async () => {
    setAdminSession();
    global.fetch = jest.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
    expect(screen.queryByText("The facility is currently empty.")).not.toBeInTheDocument();
    expect(screen.queryByText("People Present: 0")).not.toBeInTheDocument();
    expect(screen.getByText("People Present: —")).toBeInTheDocument();
  });

  it("reports an unknown supervision state when the initial load returns a server error", async () => {
    setAdminSession();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/attendance")) return { ok: false, json: async () => ({ error: "Server exploded" }) } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
    expect(screen.queryByText("The facility is currently empty.")).not.toBeInTheDocument();
    expect(screen.getByText("People Present: —")).toBeInTheDocument();
  });

  it("reports an unknown supervision state when the response payload is unrecognized", async () => {
    setAdminSession();
    mockFetchJson({ "/api/attendance": { access: "something-else" } });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
    expect(screen.getByText("Attendance is unavailable — the roster could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("The facility is currently empty.")).not.toBeInTheDocument();
  });

  it("counts a visitor with no recorded birth date as youth, not as a supervising adult", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": {
        access: "full",
        attendance: [
          // No server-computed isYouth and no birth date — the client fallback decides.
          { id: 204, arrivedAt: "2026-07-01T14:15:00.000Z", participant: { id: 80, email: "dob@example.com", name: "No Dob", isKeyholder: false, isSysadmin: false, dateOfBirth: null, householdId: 11 } },
        ],
        counts: { keyholders: 0, volunteers: 0, youth: 1, total: 1 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: true },
      },
    });
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 1");

    expect(within(columnFor("Students")).getByText("No Dob")).toBeInTheDocument();
    expect(within(columnFor("Volunteers/Adults")).queryByText("No Dob")).not.toBeInTheDocument();
  });

  it("switches to kiosk mode automatically when the server flags a signed request", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/attendance": {
        access: "full",
        attendance: [],
        counts: { keyholders: 0, volunteers: 0, students: 0, total: 0 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: false },
        signedRequest: true,
      },
    });
    renderWithProviders(<KioskDisplay />);

    await screen.findByText("The facility is currently empty.");
    expect(screen.queryByRole("button", { name: "Check Me In" })).not.toBeInTheDocument();
  });

  it("applies a pushed attendance snapshot from a postMessage event", async () => {
    setAdminSession();
    mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent(window, new MessageEvent("message", {
      data: {
        type: "refresh-attendance",
        attendance: [],
        counts: { keyholders: 0, volunteers: 0, students: 0, total: 0 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: false },
        signedRequest: true,
      },
    }));

    expect(await screen.findByText("The facility is currently empty.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Me In" })).not.toBeInTheDocument();
  });

  it("re-fetches attendance on a string postMessage refresh signal", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");
    const callsBefore = fetchMock.mock.calls.filter(([u]) => u === "/api/attendance").length;

    fireEvent(window, new MessageEvent("message", { data: "refresh-attendance" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => u === "/api/attendance").length).toBeGreaterThan(callsBefore),
    );
  });

  it("includes kiosk-signature headers on both the initial load and a post-action refresh", async () => {
    setSearchParams("sig=abc&ts=123&nonce=xyz");
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Check Me In" }));

    await waitFor(() => {
      const signed = fetchMock.mock.calls.filter(([u, init]) => {
        const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
        return u === "/api/attendance" && headers?.["x-kiosk-signature"] === "abc";
      });
      expect(signed.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("ignores single-character search queries (debounced)", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.change(screen.getByPlaceholderText("Manually check someone in (Search by name, email, or ID)..."), { target: { value: "W" } });
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(screen.queryByText("Wendy West")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/roles")).toBe(false);
  });

  it("matches search results by email and labels a nameless match Unnamed", async () => {
    setAdminSession();
    mockRoutes({
      "/api/roles": {
        people: [
          { id: 777, name: null, email: "noname@example.com", isKeyholder: false, isSysadmin: false },
          // Matches neither name nor email — exercises the filtered-out (no match) path.
          { id: 778, name: "Other Person", email: "other@example.com", isKeyholder: false, isSysadmin: false },
        ],
      },
    });
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.change(screen.getByPlaceholderText("Manually check someone in (Search by name, email, or ID)..."), { target: { value: "noname" } });

    expect(await screen.findByText("Unnamed")).toBeInTheDocument();
    expect(screen.getByText("noname@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Other Person")).not.toBeInTheDocument();
  });

  it("silently ignores a failed search request", async () => {
    setAdminSession();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/roles")) throw new Error("down");
      if (url.includes("/api/household")) return { ok: true, json: async () => householdData } as Response;
      if (url.includes("/api/attendance")) return { ok: true, json: async () => attendanceData } as Response;
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.change(screen.getByPlaceholderText("Manually check someone in (Search by name, email, or ID)..."), { target: { value: "wendy" } });
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(screen.queryByText("Wendy West")).not.toBeInTheDocument();
  });

  it("keeps the user checked in when force-checkout is cancelled", async () => {
    window.confirm = jest.fn(() => false);
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Sign out a user" }));
    const modal = await screen.findByRole("dialog");
    fireEvent.click(within(modal).getAllByRole("button", { name: "Sign Out" })[0]);

    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("alerts on a server failure and then a network error during force-checkout", async () => {
    window.confirm = jest.fn(() => true);
    window.alert = jest.fn();
    setAdminSession();
    let failMode: "server" | "network" = "server";
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        if (failMode === "network") throw new Error("down");
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (url.includes("/api/household")) return { ok: true, json: async () => householdData } as Response;
      return { ok: true, json: async () => attendanceData } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Sign out a user" }));
    const modal = await screen.findByRole("dialog");
    fireEvent.click(within(modal).getAllByRole("button", { name: "Sign Out" })[0]);
    const confirmModal = await screen.findByRole("dialog", { name: "Force Checkout" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: "Force Checkout" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Failed to force checkout.", autoClose: false }),
      ),
    );

    failMode = "network";
    fireEvent.click(within(modal).getAllByRole("button", { name: "Sign Out" })[0]);
    const confirmModal2 = await screen.findByRole("dialog", { name: "Force Checkout" });
    fireEvent.click(within(confirmModal2).getByRole("button", { name: "Force Checkout" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error.", autoClose: false }),
      ),
    );
  });

  it("alerts on a server failure and then a network error during manual check-in", async () => {
    window.alert = jest.fn();
    setAdminSession();
    let failMode: "server" | "network" = "server";
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        if (failMode === "network") throw new Error("down");
        return { ok: false, json: async () => ({ error: "Already checked in" }) } as Response;
      }
      if (url.includes("/api/household")) return { ok: true, json: async () => householdData } as Response;
      return { ok: true, json: async () => attendanceData } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Check Me In" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Already checked in", autoClose: false }),
      ),
    );

    failMode = "network";
    fireEvent.click(screen.getByRole("button", { name: "Check Me In" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error.", autoClose: false }),
      ),
    );
  });

  it("opens the emergency-contact modal with multiple contacts, then a no-contact fallback", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": {
        access: "full",
        attendance: [
          {
            id: 201, arrivedAt: "2026-07-01T14:00:00.000Z",
            participant: {
              id: 50, email: "karen@example.com", name: "Karen Keyholder", isKeyholder: true, isSysadmin: false,
              dateOfBirth: "1985-01-01", householdId: 6, phone: "5551234567",
              household: { emergencyContacts: [
                { id: 1, name: "Con A", phone: "5559990001", relationship: "Parent" },
                { id: 2, name: "Con B", phone: "5559990002", relationship: null },
              ] },
            },
          },
          {
            id: 202, arrivedAt: "2026-07-01T14:05:00.000Z",
            participant: { id: 60, email: "val@example.com", name: "Val Volunteer", isKeyholder: false, isSysadmin: false, dateOfBirth: "1990-01-01", householdId: 7, household: null },
          },
          {
            id: 203, arrivedAt: "2026-07-01T14:10:00.000Z",
            // Nameless — exercises the participant-name email-prefix fallback in the
            // modal header — with exactly one contact, exercising the singular
            // "Emergency Contact" (no trailing "s") label.
            participant: {
              id: 70, email: "nona@example.com", name: null, isKeyholder: false, isSysadmin: false, dateOfBirth: "1990-01-01", householdId: 9,
              household: { emergencyContacts: [{ id: 3, name: "Con C", phone: "5559990003", relationship: null }] },
            },
          },
        ],
        counts: { keyholders: 1, volunteers: 2, students: 0, total: 3 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: false },
      },
    });
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByText("Karen Keyholder"));
    let modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("Emergency Contacts")).toBeInTheDocument();
    expect(within(modal).getByText("Con A")).toBeInTheDocument();
    expect(within(modal).getByText("(Parent)", { exact: false })).toBeInTheDocument();
    expect(within(modal).getByText("Con B")).toBeInTheDocument();
    expect(within(modal).getByText("User Phone:", { exact: false })).toBeInTheDocument();
    expect(within(modal).getByText("555-123-4567", { exact: false })).toBeInTheDocument();

    // Close via Mantine's own built-in (X) close button, not our footer button —
    // a distinct handler (onClose prop) from the footer "Close" button's onClick.
    fireEvent.click(modal.querySelector(".mantine-Modal-close")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByText("Val Volunteer"));
    modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("No Emergency Contact on File")).toBeInTheDocument();
    expect(within(modal).queryByText("User Phone:", { exact: false })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("nona"));
    modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("nona")).toBeInTheDocument();
    expect(within(modal).getByText("Emergency Contact", { exact: true })).toBeInTheDocument();
    expect(within(modal).getByText("Con C")).toBeInTheDocument();

    fireEvent.click(within(modal).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes the sign-out modal via Mantine's own close button", async () => {
    setAdminSession();
    mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    fireEvent.click(screen.getByRole("button", { name: "Sign out a user" }));
    const modal = await screen.findByRole("dialog");
    fireEvent.click(modal.querySelector(".mantine-Modal-close")!);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows program badges and phone numbers, and falls back to the email prefix for nameless participants", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": {
        access: "full",
        attendance: [
          {
            id: 201, arrivedAt: "2026-07-01T14:00:00.000Z", event: { program: { id: 9, name: "Robotics Club" } },
            participant: { id: 50, email: "karen@example.com", name: "Karen Keyholder", isKeyholder: true, isSysadmin: false, dateOfBirth: "1985-01-01", householdId: 6, phone: "5551234567" },
          },
          {
            id: 202, arrivedAt: "2026-07-01T14:05:00.000Z",
            participant: { id: 60, email: "val@example.com", name: null, isKeyholder: false, isSysadmin: false, dateOfBirth: "1990-01-01", householdId: 7 },
          },
        ],
        counts: { keyholders: 1, volunteers: 1, students: 0, total: 2 },
        safety: { isLastKeyholder: false, isTwoDeepViolation: false },
      },
    });
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 2");

    expect(screen.getByText("Robotics Club")).toBeInTheDocument();
    expect(screen.getByText("555-123-4567", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("val")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out a user" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("val")).toBeInTheDocument();

    fireEvent.change(within(modal).getByPlaceholderText("Search checked-in users..."), { target: { value: "val@example" } });
    expect(within(modal).getByText("val")).toBeInTheDocument();
    expect(within(modal).queryByText("Karen Keyholder")).not.toBeInTheDocument();
  });

  it("shows the checked-in banner for self and force-checks-out self with the self wording", async () => {
    window.confirm = jest.fn(() => true);
    window.alert = jest.fn();
    setAdminSession();
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return { ok: false, json: async () => ({}) } as Response;
      if (url.includes("/api/household")) return { ok: true, json: async () => householdData } as Response;
      if (url.includes("/api/attendance")) {
        return {
          ok: true,
          json: async () => ({
            access: "full",
            attendance: [
              { id: 999, arrivedAt: "2026-07-01T14:00:00.000Z", participant: { id: 1, email: "admin@example.com", name: "Admin Self", isKeyholder: true, isSysadmin: true, dateOfBirth: "1980-01-01", householdId: 5 } },
            ],
            counts: { keyholders: 1, volunteers: 0, students: 0, total: 1 },
            safety: { isLastKeyholder: false, isTwoDeepViolation: false },
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("You are currently checked in!")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Me In" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Out" }));
    // isSelf → no window.confirm prompt, and the "check out" (not "force checkout") wording.
    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Failed to check out.", autoClose: false }),
      ),
    );
  });

  it("does not treat a roster without safety flags as two-deep compliant (B6)", async () => {
    setAdminSession();
    const { safety: _omit, ...withoutSafety } = attendanceData;
    void _omit;
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": withoutSafety,
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
    expect(screen.queryByText("Two-Deep Compliance is failing!", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText("Only one isKeyholder is currently in the building.")).not.toBeInTheDocument();
  });

  it("treats a malformed safety object as unknown, not compliant (B6)", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": { ...attendanceData, safety: {} },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
  });

  it("treats a partial safety object (one flag missing) as unknown (B6)", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": { ...attendanceData, safety: { isTwoDeepViolation: true } },
    });
    renderWithProviders(<KioskDisplay />);

    // Even a true violation flag cannot render as a verdict when the pair is
    // incomplete — coverage of the other flag is silently un-checkable.
    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
    expect(screen.queryByText("Two-Deep Compliance is failing!", { exact: false })).not.toBeInTheDocument();
  });

  it("shows a critical two-deep-violation banner over the last-keyholder warning", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/household": householdData,
      "/api/attendance": { ...attendanceData, safety: { isLastKeyholder: true, isTwoDeepViolation: true } },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Two-Deep Compliance is failing!", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Only one isKeyholder is currently in the building.")).not.toBeInTheDocument();
  });

  it("shows the household fetch failure and error branches without crashing", async () => {
    setAdminSession();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/household")) throw new Error("down");
      if (url.includes("/api/attendance")) return { ok: true, json: async () => attendanceData } as Response;
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("People Present: 3")).toBeInTheDocument();
    // Household fetch failed silently — no household check-in row to show.
    expect(screen.queryByText("Check In Household Members")).not.toBeInTheDocument();
  });
});
