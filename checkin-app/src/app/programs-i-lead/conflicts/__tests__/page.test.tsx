// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import ConflictsPage from "../page";

beforeEach(() => resetRtl());

const conflicts = [
  {
    participantId: 1,
    eventId: 10,
    participantName: "Alice Kid",
    eventName: "Session 1",
    visits: [
      { id: 100, arrivedAt: "2026-02-01T18:00:00.000Z", departedAt: "2026-02-01T19:00:00.000Z", arrivedVia: "SCANNER", departedVia: "SCANNER", associatedEventId: 10 },
      { id: 101, arrivedAt: "2026-02-01T18:05:00.000Z", departedAt: null, arrivedVia: "WEB", departedVia: null, associatedEventId: null },
    ],
  },
];

describe("ConflictsPage", () => {
  it("shows the empty state when there are no conflicts", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/my-programs/conflicts": { conflicts: [] } });
    renderWithProviders(<ConflictsPage />);

    expect(await screen.findByText(/No attendance conflicts/)).toBeInTheDocument();
  });

  it("lists conflicting visits for a participant", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/my-programs/conflicts": { conflicts } });
    renderWithProviders(<ConflictsPage />);

    expect(await screen.findByText("Alice Kid")).toBeInTheDocument();
    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("#100")).toBeInTheDocument();
    expect(screen.getByText("#101")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("unassociated")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
  });
});
