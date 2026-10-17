// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import PublicProgramsDirectory from "../page";

beforeEach(() => resetRtl());

const programs = [
  {
    id: 1, name: "Robotics Club", startAt: "2026-01-10T00:00:00.000Z", endAt: "2026-05-10T00:00:00.000Z",
    orgMemberOnly: false, phase: "RUNNING", enrollmentStatus: "OPEN", leadMentorId: 1,
    maxParticipants: null, _count: { participants: 4, volunteers: 1, events: 2 },
  },
];

describe("PublicProgramsDirectory", () => {
  it("lists public programs for an anonymous visitor", async () => {
    mockFetchJson({ "/api/programs?active=true": programs });
    renderWithProviders(<PublicProgramsDirectory />);

    expect(await screen.findByText("Robotics Club")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View details and enroll" })).toHaveAttribute("href", "/programs/1");
    // Anonymous visitors get no manage/admin controls.
    expect(screen.queryByRole("checkbox", { name: "Show active only" })).not.toBeInTheDocument();
  });

  it("shows admin controls and a Manage link for an authorized admin", async () => {
    setSession({ id: 1, isSysadmin: true });
    // Unchecking "active only" re-fetches with no query string.
    mockFetchJson({ "/api/programs?active=true": programs, "/api/programs": programs });
    renderWithProviders(<PublicProgramsDirectory />);

    expect(await screen.findByText("Robotics Club")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/program-ops/programs/1");

    fireEvent.click(screen.getByLabelText("Show active only"));
    await waitFor(() => expect(screen.getByLabelText("Show active only")).not.toBeChecked());
  });

  it("shows an empty state with no active programs", async () => {
    mockFetchJson({ "/api/programs?active=true": [] });
    renderWithProviders(<PublicProgramsDirectory />);
    expect(await screen.findByText(/No active programs currently available/)).toBeInTheDocument();
  });
});

describe("slow-load wait message", () => {
  it("shows the generic getting-ready message only after the load runs long", () => {
    jest.useFakeTimers();
    // A fetch that never settles = the waking case from the user's perspective.
    (global.fetch as jest.Mock) = jest.fn(() => new Promise(() => {}));
    renderWithProviders(<PublicProgramsDirectory />);
    expect(screen.queryByText(/Getting the system ready/i)).not.toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(4500); });
    expect(screen.getByText(/Getting the system ready/i)).toBeInTheDocument();
    jest.useRealTimers();
  });
});

describe("capacity in the Enrolled stat", () => {
  // [maxParticipants, enrolled, rendered]
  const cases: [number | null, number, string][] = [
    [null, 3, "3"],   // uncapped: no slash
    [0, 3, "3/0"],    // a 0 cap is a real cap, not "uncapped"
    [6, 3, "3/6"],
    [6, 6, "6/6"],
    [6, 7, "7/6"],    // over capacity renders as-is, unclamped
  ];

  it.each(cases)("maxParticipants %p with %i enrolled renders %s", async (maxParticipants, participants, expected) => {
    mockFetchJson({
      "/api/programs?active=true": [
        { ...programs[0], maxParticipants, _count: { participants, volunteers: 1, events: 2 } },
      ],
    });
    renderWithProviders(<PublicProgramsDirectory />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

describe("counts omitted (system waking)", () => {
  it("renders program cards without the enrollment figures block when _count is absent", async () => {
    setSession(null);
    mockFetchJson({
      "/api/programs?": [
        { id: 1, name: "Robotics", description: "Bots", phase: "ACTIVE", enrollmentStatus: "OPEN", startAt: "2026-08-01T00:00:00Z", endAt: null, maxParticipants: 6 },
      ],
    });
    renderWithProviders(<PublicProgramsDirectory />);
    expect(await screen.findByText("Robotics")).toBeInTheDocument();
    expect(screen.queryByText("Enrolled")).not.toBeInTheDocument();
    expect(screen.queryByText("Volunteers")).not.toBeInTheDocument();
  });
});
