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
  safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false },
  building: { reachable: true, lastSeenAt: null },
};

function mockRoutes(overrides: Record<string, unknown | (() => unknown)> = {}) {
  return mockFetchJson({
    "/api/attendance": attendanceData,
    ...overrides,
  });
}

// A roster column is the element wrapping its header label and its card grid.
function columnFor(label: string) {
  return screen.getByText(label).closest("div")!.parentElement!.parentElement!;
}

// A message as the kiosk wrapper sends it: from the parent window, on the page's own origin.
// At the top level of jsdom, window.parent is window itself.
function postFromWrapper(data: unknown) {
  fireEvent(window, new MessageEvent("message", { data, origin: window.location.origin, source: window.parent }));
}

// The admin (id 1, sysadmin + keyholder) is not checked in and leads a household.
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
  });

  it("offers no way to check anyone in or out: people badge at the kiosk", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    for (const name of ["Check Me In", "Sign out a user", "Out", "Check In"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByPlaceholderText(/check someone in/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Check In Household Members")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
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
        safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false },
        building: { reachable: true, lastSeenAt: null },
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
      "/api/attendance": {
        access: "full",
        attendance: [
          // No server-computed isYouth and no birth date — the client fallback decides.
          { id: 204, arrivedAt: "2026-07-01T14:15:00.000Z", participant: { id: 80, email: "dob@example.com", name: "No Dob", isKeyholder: false, isSysadmin: false, dateOfBirth: null, householdId: 11 } },
        ],
        counts: { keyholders: 0, volunteers: 0, youth: 1, total: 1 },
        safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: true },
        building: { reachable: true, lastSeenAt: null },
      },
    });
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 1");

    expect(within(columnFor("Students")).getByText("No Dob")).toBeInTheDocument();
    expect(within(columnFor("Volunteers/Adults")).queryByText("No Dob")).not.toBeInTheDocument();
  });

  it("never shows the facility open on no-keyholder visits: closed banner + per-visit mark", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/attendance": {
        access: "full",
        attendance: [
          { id: 205, arrivedAt: "2026-07-01T07:00:00.000Z", noKeyholder: true, participant: { id: 60, email: "val@example.com", name: "Val Volunteer", isKeyholder: false, isSysadmin: false, isYouth: false, householdId: 7 } },
        ],
        counts: { keyholders: 0, volunteers: 1, youth: 0, total: 1 },
        safety: { facilityOpen: false, isLastKeyholder: false, isTwoDeepViolation: false },
        building: { reachable: true, lastSeenAt: null },
      },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Facility closed — no keyholder present")).toBeInTheDocument();
    expect(within(columnFor("Volunteers/Adults")).getByText("Val Volunteer")).toBeInTheDocument();
    expect(screen.getByText("No keyholder")).toBeInTheDocument();
  });

  describe("when the kiosk proxy answers 204", () => {
    function mockResting(first: "roster" | "resting") {
      let calls = 0;
      global.fetch = jest.fn(async () => {
        calls += 1;
        const resting = first === "resting" || calls > 1;
        return {
          ok: true,
          status: resting ? 204 : 200,
          json: async () => (resting ? Promise.reject(new SyntaxError("no body")) : attendanceData),
        } as unknown as Response;
      }) as unknown as typeof fetch;
    }

    it("says the kiosk is resting, not unavailable, when it has no roster yet", async () => {
      setSearchParams("mode=kiosk");
      mockResting("resting");
      renderWithProviders(<KioskDisplay />);

      expect(await screen.findByText("Kiosk resting — zzz. Badge in to wake it.")).toBeInTheDocument();
      expect(screen.queryByText("Attendance is unavailable — the roster could not be loaded.")).not.toBeInTheDocument();
      expect(screen.queryByText("The facility is currently empty.")).not.toBeInTheDocument();
    });

    it("clears an earlier error so the resting message shows", async () => {
      setSearchParams("mode=kiosk");
      let calls = 0;
      global.fetch = jest.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
        }
        return {
          ok: true,
          status: 204,
          json: async () => Promise.reject(new SyntaxError("no body")),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      renderWithProviders(<KioskDisplay />);
      expect(await screen.findByText("Failed to load attendance")).toBeInTheDocument();

      postFromWrapper("refresh-attendance");

      expect(await screen.findByText("Kiosk resting — zzz. Badge in to wake it.")).toBeInTheDocument();
      expect(screen.queryByText("Failed to load attendance")).not.toBeInTheDocument();
    });

    it("keeps the last real roster instead of replacing it", async () => {
      setSearchParams("mode=kiosk");
      mockResting("roster");
      renderWithProviders(<KioskDisplay />);
      expect(await screen.findByText("People Present: 3")).toBeInTheDocument();

      postFromWrapper("refresh-attendance");
      await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

      expect(screen.getByText("People Present: 3")).toBeInTheDocument();
      expect(screen.queryByText("Kiosk resting — zzz. Badge in to wake it.")).not.toBeInTheDocument();
    });
  });

  describe("when the kiosk is unreachable", () => {
    const unreachable = {
      ...attendanceData,
      safety: { facilityOpen: false, isLastKeyholder: true, isTwoDeepViolation: true },
      building: { reachable: false, lastSeenAt: null },
    };

    it("says it can't confirm building state instead of stating occupancy, closed or two-deep", async () => {
      setAdminSession();
      mockRoutes({ "/api/attendance": unreachable });
      renderWithProviders(<KioskDisplay />);

      expect(await screen.findByText("Can't confirm building state")).toBeInTheDocument();
      expect(screen.getByText("Checked in (unconfirmed): 3")).toBeInTheDocument();
      expect(screen.queryByText("People Present: 3")).not.toBeInTheDocument();
      expect(screen.queryByText("Critical Warning")).not.toBeInTheDocument();
      expect(screen.queryByText("Facility closed — no keyholder present")).not.toBeInTheDocument();
      expect(screen.queryByText("Supervision status unknown")).not.toBeInTheDocument();
    });

    it("reads a payload without the link as unreachable", async () => {
      setAdminSession();
      const { building: _omit, ...withoutLink } = attendanceData;
      mockRoutes({ "/api/attendance": withoutLink });
      renderWithProviders(<KioskDisplay />);

      expect(await screen.findByText("Can't confirm building state")).toBeInTheDocument();
    });

    it("leaves the kiosk's own display as it is", async () => {
      setSearchParams("mode=kiosk");
      mockRoutes({ "/api/attendance": unreachable });
      renderWithProviders(<KioskDisplay />);

      expect(await screen.findByText("People Present: 3")).toBeInTheDocument();
      expect(screen.queryByText("Can't confirm building state")).not.toBeInTheDocument();
      expect(screen.getByText("Critical Warning")).toBeInTheDocument();
    });
  });

  it("reads safety without facilityOpen as unknown", async () => {
    setAdminSession();
    mockRoutes({ "/api/attendance": { ...attendanceData, safety: { isLastKeyholder: false, isTwoDeepViolation: false } } });
    renderWithProviders(<KioskDisplay />);
    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
    expect(screen.queryByText("Facility closed — no keyholder present")).not.toBeInTheDocument();
  });

  it("switches to kiosk mode automatically when the server flags a signed request", async () => {
    setAdminSession();
    mockFetchJson({
      "/api/attendance": {
        access: "full",
        attendance: [],
        counts: { keyholders: 0, volunteers: 0, students: 0, total: 0 },
        safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false },
        // Off the kiosk an unreachable link reads as unconfirmed, so "empty" proves kiosk mode.
        building: { reachable: false, lastSeenAt: null },
        signedRequest: true,
      },
    });
    renderWithProviders(<KioskDisplay />);

    await screen.findByText("The facility is currently empty.");
  });

  const emptySnapshot = {
    type: "refresh-attendance",
    attendance: [],
    counts: { keyholders: 0, volunteers: 0, students: 0, total: 0 },
    safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false },
    signedRequest: true,
  };

  it("applies a pushed attendance snapshot from the framing wrapper, without entering kiosk mode", async () => {
    setAdminSession();
    mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    postFromWrapper(emptySnapshot);

    // Off the kiosk a pushed roster carries no building link, so it reads as unconfirmed.
    expect(await screen.findByText("No open visits recorded.")).toBeInTheDocument();
  });

  it.each([
    ["another origin", { origin: "https://evil.example", source: window }],
    ["a window other than the parent", { origin: window.location.origin, source: null }],
  ])("ignores a pushed snapshot from %s", async (_label, from) => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");
    const callsBefore = fetchMock.mock.calls.length;

    fireEvent(window, new MessageEvent("message", { data: emptySnapshot, ...from }));
    fireEvent(window, new MessageEvent("message", { data: "refresh-attendance", ...from }));

    expect(screen.getByText("People Present: 3")).toBeInTheDocument();
    expect(screen.queryByText("The facility is currently empty.")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("re-fetches attendance on a string postMessage refresh signal", async () => {
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");
    const callsBefore = fetchMock.mock.calls.filter(([u]) => u === "/api/attendance").length;

    postFromWrapper("refresh-attendance");

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => u === "/api/attendance").length).toBeGreaterThan(callsBefore),
    );
  });

  // First /api/attendance call answers the roster; later ones fail like the proxy's bodiless 502.
  function rosterThenFailure() {
    let calls = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/attendance")) {
        calls += 1;
        if (calls === 1) return { ok: true, json: async () => attendanceData } as Response;
        return { ok: false, status: 502, json: async () => { throw new Error("no body"); } } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  }

  it("kiosk keeps the last roster, marked not up to date, when a refresh fails", async () => {
    setSearchParams("mode=kiosk");
    setSession({ id: 999 });
    rosterThenFailure();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("Karen");

    postFromWrapper("refresh-attendance");

    expect(await screen.findByText(/^Not up to date — as of /)).toBeInTheDocument();
    expect(screen.getByText("Karen")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load attendance")).not.toBeInTheDocument();
  });

  it("kiosk marks the proxy's own view (offline or overnight) with the roster's time", async () => {
    setSearchParams("mode=kiosk");
    setSession({ id: 999 });
    mockRoutes({ "/api/attendance": { ...attendanceData, kioskAsOf: "2026-07-01T14:30:00.000Z" } });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText(/^Not up to date — as of \S/)).toBeInTheDocument();
    expect(screen.getByText("Karen")).toBeInTheDocument();
  });

  it("kiosk marks a view built without any roster as not up to date, with no time", async () => {
    setSearchParams("mode=kiosk");
    setSession({ id: 999 });
    mockRoutes({ "/api/attendance": { ...attendanceData, kioskAsOf: null } });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Not up to date")).toBeInTheDocument();
  });

  it("kiosk shows no stale marker on a fresh server roster", async () => {
    setSearchParams("mode=kiosk");
    setSession({ id: 999 });
    mockRoutes();
    renderWithProviders(<KioskDisplay />);

    await screen.findByText("Karen");
    expect(screen.queryByText(/Not up to date/)).not.toBeInTheDocument();
  });

  it("off the kiosk a failed refresh still replaces the roster with the error", async () => {
    setAdminSession();
    rosterThenFailure();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("Karen Keyholder");

    postFromWrapper("refresh-attendance");

    expect(await screen.findByText("Failed to load attendance")).toBeInTheDocument();
    expect(screen.queryByText("Karen Keyholder")).not.toBeInTheDocument();
    expect(screen.queryByText(/Not up to date/)).not.toBeInTheDocument();
  });

  it("includes kiosk-signature headers on the load", async () => {
    setSearchParams("sig=abc&ts=123&nonce=xyz");
    setAdminSession();
    const fetchMock = mockRoutes();
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 3");

    await waitFor(() => {
      const signed = fetchMock.mock.calls.filter(([u, init]) => {
        const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
        return u === "/api/attendance" && headers?.["x-kiosk-signature"] === "abc";
      });
      expect(signed.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("opens the emergency-contact modal with multiple contacts, then a no-contact fallback", async () => {
    setAdminSession();
    mockFetchJson({
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
        safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false },
        building: { reachable: true, lastSeenAt: null },
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

  it("shows program badges and phone numbers, and falls back to the email prefix for nameless participants", async () => {
    setAdminSession();
    mockFetchJson({
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
        safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false },
        building: { reachable: true, lastSeenAt: null },
      },
    });
    renderWithProviders(<KioskDisplay />);
    await screen.findByText("People Present: 2");

    expect(screen.getByText("Robotics Club")).toBeInTheDocument();
    expect(screen.getByText("555-123-4567", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("val")).toBeInTheDocument();

  });

  it("does not treat a roster without safety flags as two-deep compliant (B6)", async () => {
    setAdminSession();
    const { safety: _omit, ...withoutSafety } = attendanceData;
    mockFetchJson({
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
      "/api/attendance": { ...attendanceData, safety: {} },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Supervision status unknown")).toBeInTheDocument();
  });

  it("treats a partial safety object (one flag missing) as unknown (B6)", async () => {
    setAdminSession();
    mockFetchJson({
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
      "/api/attendance": { ...attendanceData, safety: { facilityOpen: true, isLastKeyholder: true, isTwoDeepViolation: true } },
    });
    renderWithProviders(<KioskDisplay />);

    expect(await screen.findByText("Two-Deep Compliance is failing!", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Only one isKeyholder is currently in the building.")).not.toBeInTheDocument();
  });

});
