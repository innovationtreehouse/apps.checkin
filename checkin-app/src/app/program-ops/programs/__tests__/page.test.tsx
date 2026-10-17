// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl, router } from "@/test-helpers/rtl";
import AdminProgramsIndex from "../page";

beforeEach(() => resetRtl());

const programs = [
  {
    id: 1, name: "Robotics Club", phase: "RUNNING", enrollmentStatus: "OPEN", orgMemberOnly: false,
    startAt: "2026-01-10T00:00:00.000Z", endAt: "2026-05-10T00:00:00.000Z",
    _count: { participants: 4, events: 2 },
  },
  {
    id: 2, name: "Pottery (finished)", phase: "FINISHED", enrollmentStatus: "CLOSED", orgMemberOnly: true,
    startAt: null, endAt: null,
    _count: { participants: 1, events: 0 },
  },
];

describe("AdminProgramsIndex", () => {
  it("loads and lists programs", async () => {
    mockFetchJson({ "/api/programs": programs });
    renderWithProviders(<AdminProgramsIndex />);

    expect(await screen.findByText("Robotics Club")).toBeInTheDocument();
    expect(screen.getByText("Pottery (finished)")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Treehouse Members Only")).toBeInTheDocument();
  });

  it("hides finished programs when Only show active is checked", async () => {
    mockFetchJson({ "/api/programs": programs });
    renderWithProviders(<AdminProgramsIndex />);
    await screen.findByText("Robotics Club");

    fireEvent.click(screen.getByLabelText("Only show active"));
    expect(screen.queryByText("Pottery (finished)")).not.toBeInTheDocument();
    expect(screen.getByText("Robotics Club")).toBeInTheDocument();
  });

  // [maxParticipants, enrolled, rendered]
  const capacityCases: [number | null, number, string][] = [
    [null, 3, "3"],   // uncapped: no slash
    [0, 3, "3/0"],    // a 0 cap is a real cap, not "uncapped"
    [6, 3, "3/6"],
    [6, 6, "6/6"],
    [6, 7, "7/6"],    // over capacity renders as-is, unclamped
  ];

  it.each(capacityCases)("shows capacity in Participants: max %p with %i enrolled renders %s", async (maxParticipants, participants, expected) => {
    mockFetchJson({
      "/api/programs": [{ ...programs[0], maxParticipants, _count: { participants, events: 2 } }],
    });
    renderWithProviders(<AdminProgramsIndex />);
    await screen.findByText("Robotics Club");
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("navigates to the create-program page", async () => {
    mockFetchJson({ "/api/programs": programs });
    renderWithProviders(<AdminProgramsIndex />);
    await screen.findByText("Robotics Club");

    fireEvent.click(screen.getByRole("button", { name: "+ New Program" }));
    expect(router.push).toHaveBeenCalledWith("/program-ops/new");
  });
});
